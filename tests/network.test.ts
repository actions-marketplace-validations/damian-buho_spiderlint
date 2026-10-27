// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, layered, proxyOf } from "../src/config/index.ts";
import { validateSubtree } from "../src/config/schema.ts";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { Deadline, openNetwork, pace, patient, reserveMiss, settleMiss } from "../src/crawl/network.ts";
import { audit } from "../src/index.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";
import { serveHttpProxy, serveSocksProxy } from "./fixtures/proxies.ts";

const EXCLUDE = ["/tmp/**"];
const NETWORK = { rate: 0, proxy: "", allowPrivate: true, resolver: "system", resolve: [], seeds: [], timeout: 60 };

// Whether a reservation on `host` at clock `at` is still waiting once every pending microtask ran; a waiting one is aborted.
async function isHeld(host: string, at: number): Promise<boolean> {
    const controller = new AbortController();
    let isDone = false;
    const reserved = (async () => {
        try {
            await reserveMiss(host, controller.signal, undefined, () => at);
            isDone = true;
        } catch {
            isDone = false;
        }
    })();
    await tick();
    controller.abort();
    await reserved;
    return !isDone;
}

describe("probe miss budget", () => {
    it("lets a burst of `misses` through at once and holds the next", async () => {
        const network = await openNetwork({ ...NETWORK, misses: 6 });
        for (let miss = 0; miss < 6; miss += 1) assert.equal(await isHeld("example.com", 0), false, `miss ${miss + 1} of 6`);
        assert.equal(await isHeld("example.com", 0), true);
        await network.close();
    });

    it("leaks one miss per 60/misses seconds", async () => {
        const network = await openNetwork({ ...NETWORK, misses: 1 });
        assert.equal(await isHeld("example.com", 0), false);
        assert.equal(await isHeld("example.com", 59_999), true);
        assert.equal(await isHeld("example.com", 60_000), false);
        await network.close();
    });

    it("returns the miss of every answer outside 400–499", async () => {
        for (const [status, isReturned] of [
            [399, true],
            [400, false],
            [499, false],
            [500, true],
        ] as const) {
            const network = await openNetwork({ ...NETWORK, misses: 1 });
            assert.equal(await isHeld("example.com", 0), false);
            settleMiss("example.com", status, () => 0);
            assert.equal(await isHeld("example.com", 0), !isReturned, `status ${status}`);
            await network.close();
        }
    });

    it("shares one budget across the hosts of a registrable domain", async () => {
        const network = await openNetwork({ ...NETWORK, misses: 1 });
        assert.equal(await isHeld("a.example.com", 0), false);
        assert.equal(await isHeld("b.example.com", 0), true);
        assert.equal(await isHeld("example.org", 0), false);
        await network.close();
    });

    it("never holds a probe when misses is 0 or the network is closed", async () => {
        const network = await openNetwork({ ...NETWORK, misses: 0 });
        for (let miss = 0; miss < 100; miss += 1) assert.equal(await isHeld("example.com", 0), false);
        await network.close();
        const closing = await openNetwork({ ...NETWORK, misses: 1 });
        await closing.close();
        for (let miss = 0; miss < 3; miss += 1) assert.equal(await isHeld("example.com", 0), false);
    });

    it("never holds a probe to this machine", async () => {
        const network = await openNetwork({ ...NETWORK, misses: 1 });
        for (const host of ["127.0.0.1", "127.255.255.255", "[::1]", "localhost", "app.localhost"]) {
            for (let miss = 0; miss < 3; miss += 1) assert.equal(await isHeld(host, 0), false, host);
        }
        assert.equal(await isHeld("128.0.0.1", 0), false);
        assert.equal(await isHeld("128.0.0.1", 0), true);
        await network.close();
    });

    it("refuses a negative misses", () => {
        assert.throws(() => validateSubtree({ misses: -1 }), ConfigError);
        assert.doesNotThrow(() => validateSubtree({ misses: 0 }));
    });

    it("stops a deadline’s countdown while a probe waits and restarts it after", async () => {
        const deadline = new Deadline(20);
        deadline.pause();
        await sleep(200);
        assert.equal(deadline.signal.aborted, false, "a paused deadline never fires");
        deadline.resume();
        for (let poll = 0; poll < 600 && !deadline.signal.aborted; poll += 1) await sleep(50);
        assert.equal(deadline.signal.aborted, true, "a resumed deadline fires within 30 s");
    });
});

describe("network", () => {
    let site: Fixture;

    before(async () => {
        site = await serveFixture();
    });

    after(async () => {
        await site.close();
    });

    it("accepts http, https and socks proxies and refuses any other scheme", () => {
        assert.equal(proxyOf("--proxy", "socks5h://127.0.0.1:9050"), "socks5h://127.0.0.1:9050");
        assert.equal(proxyOf("--proxy", ""), "");
        assert.throws(() => proxyOf("--proxy", "ftp://127.0.0.1:21"), ConfigError);
        assert.throws(() => validateSubtree({ rate: -1 }), ConfigError);
    });

    it("spaces requests to the configured rate", async () => {
        const network = await openNetwork({ rate: 600, misses: 0, proxy: "", allowPrivate: true, resolver: "system", resolve: [], seeds: [], timeout: 60 });
        const started = performance.now();
        for (let request = 0; request < 4; request += 1) await pace();
        await network.close();
        assert.ok(performance.now() - started >= 290, "four requests at 600/min take three 100 ms gaps");
    });

    it("stops pacing once the network closes", async () => {
        const network = await openNetwork({ rate: 1, misses: 0, proxy: "", allowPrivate: true, resolver: "system", resolve: [], seeds: [], timeout: 60 });
        await network.close();
        const started = performance.now();
        await pace();
        await pace();
        assert.ok(performance.now() - started < 50);
    });

    it("stretches network waits by the run timeout until the network closes", async () => {
        const network = await openNetwork({ rate: 0, misses: 0, proxy: "", allowPrivate: true, resolver: "system", resolve: [], seeds: [], timeout: 240 });
        assert.equal(patient(10_000), 40_000);
        await network.close();
        assert.equal(patient(10_000), 10_000);
    });

    it("gives each overlay profile its local proxy, which --proxy still replaces", () => {
        assert.equal(layered([{ profile: "tor" }]).proxy, "socks5h://127.0.0.1:9050");
        assert.equal(layered([{ profile: "i2p" }]).proxy, "http://127.0.0.1:4444");
        assert.equal(layered([{ profile: "i2p", proxy: "http://10.0.0.2:4444" }]).proxy, "http://10.0.0.2:4444");
    });

    it("refuses a proxy where the address guard must hold", async () => {
        await assert.rejects(openNetwork({ rate: 0, misses: 0, proxy: "http://127.0.0.1:1", allowPrivate: false, resolver: "system", resolve: [], seeds: [], timeout: 60 }), ConfigError);
    });

    for (const [kind, serve] of [
        ["http", serveHttpProxy],
        ["socks5h", serveSocksProxy],
    ] as const) {
        it(`sends pages, resources and robots.txt through the ${kind} proxy`, async () => {
            const proxy = await serve();
            try {
                const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, proxy: proxy.url, rules: ["seo", "resources"], concurrency: 2, cacheMode: "off" });
                assert.ok(report.pages.length > 3);
                assert.ok(proxy.seen.length >= report.pages.length, `${proxy.seen.length} requests proxied for ${report.pages.length} pages`);
                assert.ok(report.pages.every((page) => page.http.remote === undefined));
            } finally {
                await proxy.close();
            }
        });
    }
});
