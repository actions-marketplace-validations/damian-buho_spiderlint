// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { chromium, type Route } from "playwright";
import sharp from "sharp";
import { browserContext } from "../agent.ts";
import { refuseLiteral } from "../crawl/guard.ts";
import { openResolution } from "../crawl/resolve.ts";
import { log } from "../logger.ts";

// The file in its working directory a scan runner leaves its preview in.
export const PREVIEW_FILE = "preview.json";
const VIEWPORT = { width: 1280, height: 800 };
const THUMBNAIL_WIDTH = 480;
const QUALITY = 70;
const TIMEOUT_MS = 30_000;
const LOAD_MS = 15_000;
const BODY_MAX = 10 * 1024 * 1024;
const TITLE_MAX = 200;
// Request types a still picture of the first screen never needs.
const SKIPPED = new Set(["media", "websocket", "eventsource", "manifest", "ping"]);
// Request headers Node’s fetch sets itself or refuses.
const OWN_REQUEST = new Set(["host", "connection", "content-length", "accept-encoding", "keep-alive", "transfer-encoding"]);
// Response headers that no longer describe the body fetch decoded.
const STALE_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "set-cookie"]);

// A seed’s first screen as a WebP thumbnail, and the title it showed.
export interface Preview {
    image: Buffer;
    title: string;
}

// `response`’s body, refused once it passes `BODY_MAX`.
async function bodyOf(response: Response): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const stream = response.body ?? [];
    for await (const chunk of stream) {
        size += chunk.length;
        if (size > BODY_MAX) throw new RangeError(`body over ${BODY_MAX} bytes`);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// Answers one browser request from Node’s fetch, whose lookup the guard holds, so Chromium never reaches an address itself.
async function fulfil(route: Route, isPrivateAllowed: boolean, signal: AbortSignal): Promise<void> {
    const request = route.request();
    const url = request.url();
    if (SKIPPED.has(request.resourceType()) || !/^https?:/.test(url)) {
        log.trace({ url, type: request.resourceType() }, "preview request skipped");
        return route.abort("blockedbyclient");
    }
    try {
        refuseLiteral(url, isPrivateAllowed);
        const headers = Object.entries(request.headers()).filter(([name]) => !OWN_REQUEST.has(name));
        const posted = request.postDataBuffer();
        const response = await fetch(url, { method: request.method(), headers, ...(posted && { body: new Uint8Array(posted) }), redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(LOAD_MS)]) });
        const body = await bodyOf(response);
        log.trace({ url, status: response.status, bytes: body.length }, "preview request answered");
        await route.fulfill({ status: response.status, headers: Object.fromEntries([...response.headers].filter(([name]) => !STALE_RESPONSE.has(name))), body });
    } catch (error) {
        log.debug({ url, error: String(error) }, "preview request failed");
        try {
            await route.abort("failed");
        } catch (error_) {
            log.trace({ url, error: String(error_) }, "preview request already settled");
        }
    }
}

// The first screen of `url` in Chromium as a thumbnail until `signal` aborts; names resolve nowhere but in the guarded fetch.
export async function preview(url: string, isPrivateAllowed: boolean, signal: AbortSignal): Promise<Preview> {
    signal.throwIfAborted();
    const restore = await openResolution([], "system", [url], false, isPrivateAllowed);
    const controller = new AbortController();
    const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
    const stop = () => {
        log.warn({ url }, "preview out of time");
        void browser.close();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
        const probe = await browser.newPage();
        const real = (await probe.evaluate("navigator.userAgent")) as string;
        await probe.close();
        const context = await browser.newContext({ ...browserContext(real), viewport: VIEWPORT, serviceWorkers: "block" });
        context.setDefaultTimeout(TIMEOUT_MS);
        await context.route("**/*", async (route) => fulfil(route, isPrivateAllowed, AbortSignal.any([signal, controller.signal])));
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        try {
            await page.waitForLoadState("load", { timeout: LOAD_MS });
        } catch (error) {
            log.debug({ url, error: String(error) }, "preview taken before load");
        }
        const shot = await page.screenshot({ type: "png" });
        const shown = await page.title();
        const title = shown.trim().slice(0, TITLE_MAX);
        const image = await sharp(shot).resize({ width: THUMBNAIL_WIDTH }).webp({ quality: QUALITY }).toBuffer();
        log.info({ url, title, bytes: image.length }, "preview taken");
        return { image, title };
    } finally {
        signal.removeEventListener("abort", stop);
        controller.abort();
        await browser.close();
        restore();
    }
}
