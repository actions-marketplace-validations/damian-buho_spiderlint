// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { audit } from "../src/index.ts";
import type { Facts } from "../src/facts/types.ts";
import { loadPlugins } from "../src/plugins/index.ts";
import markdownlint, { type MarkdownMessage } from "../src/plugins/markdownlint.ts";

// One defect per rule of the `markdownlint` preset.
const DEFECTIVE = [
    "# Title",
    "",
    "(reversed)[https://example.test/]",
    "",
    "#Missing space",
    "",
    "##  Two spaces",
    "",
    "Text",
    "```js",
    "x",
    "```",
    "",
    "[ spaced ](https://example.test/)",
    "",
    "```",
    "plain",
    "```",
    "",
    "[empty]()",
    "",
    "![](image.png)",
    "",
    "[fragment](#nowhere)",
    "",
    "[label][undefined]",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 |",
    "",
    "[unused]: https://example.test/u",
    "",
].join("\n");

const CLEAN = "# Home\n\nThe [home page](/).\n";

// The preset’s rule IDs.
const PRESET = Object.keys(markdownlint.presets.markdownlint.rules ?? {}).toSorted((a, b) => a.localeCompare(b));

function stubPage(type: string, isTruncated = false): Facts {
    const http = { status: 200, redirects: [], headers: {}, timing: {}, cookies: [], size: { body: 1, decoded: 1, ...(isTruncated && { truncated: true as const }) }, "content-type": type };
    return { url: { href: "https://example.test/a.md", origin: "https://example.test", protocol: "https:", host: "example.test", pathname: "/a.md", search: "" }, group: "default", crawl: { depth: 0, "discovered-via": "seed", referrers: [] }, http };
}

const linter = markdownlint.extractors[0];

// The aliases markdownlint reports on DEFECTIVE under the extractor’s settings.
async function aliases(settings?: unknown): Promise<string[]> {
    const facts = (await linter?.extract(stubPage("text/markdown"), DEFECTIVE, undefined, undefined, settings)) as { messages: MarkdownMessage[] };
    return [...new Set(facts.messages.map((message) => message.rule))];
}

describe("markdownlint extractor", () => {
    it("reports each defect the preset judges, once per rule", async () => {
        const found = await aliases();
        assert.deepEqual(
            PRESET.filter((id) => !found.includes(id.replace("markdownlint/", ""))),
            [],
        );
    });

    it("lints with the configured rules and parameters", async () => {
        const all = await aliases();
        const without = await aliases({ config: { MD040: false } });
        assert.ok(all.includes("fenced-code-language") && !without.includes("fenced-code-language"));
        assert.deepEqual(await aliases({ config: { default: false, MD042: true } }), ["no-empty-links"]);
    });

    it("skips a page of another type, or one cut short", async () => {
        assert.equal(await linter?.extract(stubPage("text/html"), DEFECTIVE), undefined);
        assert.equal(await linter?.extract(stubPage("text/markdown", true), DEFECTIVE), undefined);
    });

    it("refuses a config markdownlint’s schema rejects", async () => {
        await assert.rejects(loadPlugins([], { markdownlint: { config: { MD013: { line_lengthx: 1 } } } }), /markdownlint/);
        await loadPlugins([], {});
    });
});

describe("markdownlint plugin", () => {
    let server: Server;
    let origin: string;

    before(async () => {
        const files: Record<string, [string, string]> = {
            "/": ["text/html; charset=utf-8", '<!DOCTYPE html><html lang="en"><head><title>Home</title><link rel="alternate" type="text/markdown" href="/index.md"></head><body><h1>Home</h1><a href="/bad.md">Notes</a></body></html>'],
            "/index.md": ["text/markdown; charset=utf-8", CLEAN],
            "/bad.md": ["text/x-markdown", DEFECTIVE],
        };
        server = createServer((request, response) => {
            const [type, body] = files[new URL(request.url ?? "/", "http://origin").pathname] ?? ["text/html", "<!DOCTYPE html><title>Not found</title>"];
            response.writeHead(type === "text/html" ? 404 : 200, { "content-type": type });
            response.end(body);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("lints a crawled twin clean and a linked Markdown page per rule", async () => {
        const report = await audit({ seeds: [`${origin}/`], rules: ["markdownlint"], fold: false, cacheMode: "off" });
        const twin = report.pages.find((page) => page.url.pathname === "/index.md");
        assert.deepEqual(twin?.markdownlint, { messages: [] });
        assert.deepEqual(
            report.findings.filter((finding) => !finding.url.endsWith("/bad.md")),
            [],
        );
        assert.deepEqual(
            [...new Set(report.findings.map((finding) => finding.rule))].toSorted((a, b) => a.localeCompare(b)),
            PRESET,
        );
        const reversed = report.findings.find((finding) => finding.rule === "markdownlint/no-reversed-links");
        assert.deepEqual([reversed?.severity, reversed?.locations], ["warning", ["3:1 (reversed)[https://example.test/]"]]);
    });
});
