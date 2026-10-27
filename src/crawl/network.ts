// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { setGlobalProxyFromEnv } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Server } from "proxy-chain";
import { getDomain } from "tldts";
import { ConfigError, defaults, type Config } from "../config/index.ts";
import { log } from "../logger.ts";
import { refuseLiteral } from "./guard.ts";
import { openResolution } from "./resolve.ts";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const SOCKS = new Set(["socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

// Milliseconds between two requests, when the next may start, and the run’s `timeout` over its default.
const pacing = { spacing: 0, next: 0, scale: 1 };

// 4xx answers per minute one registrable domain may draw from probes, and each domain’s bucket level as of `at`.
const misses = { perMinute: 0, domains: new Map<string, { level: number; at: number }>() };

// Whether the open run may reach loopback, private and link-local addresses.
const guard = { isPrivateAllowed: true };

// Throws for a private address literal while the open run refuses private addresses.
export function guardUrl(url: string | URL): void {
    refuseLiteral(url, guard.isPrivateAllowed);
}

// `fetch`, following redirects itself while the guard is on, so every hop’s address literal is checked as the first one was.
export async function guardedFetch(url: string, init: RequestInit): Promise<Response> {
    guardUrl(url);
    if (guard.isPrivateAllowed) return fetch(url, init);
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await fetch(current, { ...init, redirect: "manual" });
        const location = response.headers.get("location");
        if (location === null || !REDIRECTS.has(response.status)) return response;
        await response.body?.cancel();
        const next = new URL(location, current).href;
        log.debug({ from: current, to: next, status: response.status, hop }, "redirect followed");
        guardUrl(next);
        current = next;
    }
    throw new TypeError(`${url}: more than ${MAX_REDIRECTS} redirects`);
}

// `ms` stretched by the run’s `timeout`, so a slow network gets as long as a page does.
export function patient(ms: number): number {
    return ms * pacing.scale;
}

// Waits for the next slot under `rate`; unlimited returns at once.
export async function pace(): Promise<void> {
    if (pacing.spacing === 0) return;
    const now = Date.now();
    const slot = Math.max(now, pacing.next);
    pacing.next = slot + pacing.spacing;
    log.trace({ waitMs: slot - now, spacing: pacing.spacing }, "request paced");
    if (slot > now) await sleep(slot - now);
}

// An abort signal whose countdown stops while any probe under it waits for a miss budget.
export class Deadline {
    readonly #controller = new AbortController();
    #remaining: number;
    #ends = 0;
    #waiting = 0;
    #timer?: NodeJS.Timeout;
    readonly signal = this.#controller.signal;

    constructor(ms: number) {
        this.#remaining = ms;
        this.#start();
    }

    #start(): void {
        this.#ends = Date.now() + this.#remaining;
        this.#timer = setTimeout(() => this.#controller.abort(new DOMException("deadline passed", "TimeoutError")), this.#remaining).unref();
    }

    pause(): void {
        this.#waiting += 1;
        if (this.#waiting > 1) return;
        clearTimeout(this.#timer);
        this.#remaining = Math.max(0, this.#ends - Date.now());
        log.trace({ remainingMs: this.#remaining }, "deadline paused");
    }

    resume(): void {
        this.#waiting -= 1;
        if (this.#waiting > 0 || this.signal.aborted) return;
        log.trace({ remainingMs: this.#remaining }, "deadline resumed");
        this.#start();
    }
}

// Whether `host` is this machine, where no firewall stands between the probe and the site.
function isLoopback(host: string): boolean {
    const literal = host.replaceAll(/^\[|\]$/g, "");
    return literal === "localhost" || literal.endsWith(".localhost") || literal === "::1" || literal.startsWith("127.");
}

// The miss bucket of `host`’s registrable domain, leaked down to `now`.
function drained(host: string, now: number): { level: number; at: number } {
    const domain = getDomain(host, { allowPrivateDomains: true }) ?? host;
    const bucket = misses.domains.get(domain) ?? { level: 0, at: now };
    bucket.level = Math.max(0, bucket.level - ((now - bucket.at) * misses.perMinute) / 60_000);
    bucket.at = now;
    misses.domains.set(domain, bucket);
    return bucket;
}

// Waits until `host` may take one more miss under `misses`, pausing `deadline` meanwhile, and reserves it; unlimited or loopback returns at once.
export async function reserveMiss(host: string, signal: AbortSignal, deadline?: Deadline, now: () => number = Date.now): Promise<void> {
    if (misses.perMinute === 0 || isLoopback(host)) return;
    for (let bucket = drained(host, now()); bucket.level > misses.perMinute - 1; bucket = drained(host, now())) {
        const waitMs = Math.ceil(((bucket.level - misses.perMinute + 1) * 60_000) / misses.perMinute);
        log.debug({ host, level: bucket.level, perMinute: misses.perMinute, waitMs }, "probe waits for the domain’s miss budget");
        deadline?.pause();
        try {
            await sleep(waitMs, undefined, { signal });
        } finally {
            deadline?.resume();
        }
    }
    drained(host, now()).level += 1;
}

// Returns the miss `reserveMiss` took for `host` unless `status` is a 4xx.
export function settleMiss(host: string, status: number, now: () => number = Date.now): void {
    if (misses.perMinute === 0 || isLoopback(host) || (status >= 400 && status <= 499)) return;
    const bucket = drained(host, now());
    bucket.level = Math.max(0, bucket.level - 1);
    log.trace({ host, status, level: bucket.level }, "probe miss returned");
}

export interface Network {
    // The HTTP proxy Crawlee and Chromium are given: the configured one, or the local bridge to a SOCKS one.
    proxy?: string;
    close(): Promise<void>;
}

// Paces, and routes every HTTP client of one run through `config.proxy`, until `close`.
export async function openNetwork(config: Pick<Config, "proxy" | "rate" | "misses" | "timeout" | "allowPrivate" | "resolver" | "resolve" | "seeds">): Promise<Network> {
    pacing.spacing = config.rate > 0 ? 60_000 / config.rate : 0;
    pacing.next = 0;
    pacing.scale = config.timeout / defaults().timeout;
    misses.perMinute = config.misses;
    misses.domains.clear();
    log.debug({ rate: config.rate, misses: config.misses, spacing: pacing.spacing, scale: pacing.scale, isProxied: config.proxy !== "" }, "network opened");
    guard.isPrivateAllowed = config.allowPrivate;
    const unresolve = await openResolution(config.resolve, config.resolver, config.seeds, config.proxy !== "", config.allowPrivate);
    const reset = () => {
        pacing.spacing = 0;
        pacing.scale = 1;
        misses.perMinute = 0;
        guard.isPrivateAllowed = true;
        unresolve();
    };
    if (!config.proxy) return { close: async () => reset() };
    if (!config.allowPrivate) throw new ConfigError("proxy: the address guard cannot check what a proxy connects to");
    const upstream = new URL(config.proxy);
    const bridge = SOCKS.has(upstream.protocol) ? new Server({ host: "127.0.0.1", port: 0, prepareRequestFunction: () => ({ upstreamProxyUrl: config.proxy }) }) : undefined;
    await bridge?.listen();
    const proxy = bridge ? `http://127.0.0.1:${bridge.port}` : config.proxy;
    const restore = setGlobalProxyFromEnv({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy });
    log.debug({ proxy: `${upstream.protocol}//${upstream.host}`, isBridged: bridge !== undefined }, "requests go through the proxy");
    return {
        proxy,
        async close() {
            restore();
            reset();
            await bridge?.close(true);
        },
    };
}
