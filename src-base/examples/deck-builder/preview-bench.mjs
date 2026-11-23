// Same connected nested branches, with view() versus app-owned adoption and cloning. This is
// operation time, not interaction latency: a frame between switches lets normal lifecycle run.
// Usage: node examples/deck-builder/preview-bench.mjs <base url> [baseline URL]
import { chromium } from "@playwright/test";
import { gzipSync } from "node:zlib";
import { steady } from "../../scripts/steady.mjs";

const base = process.argv[2];
if (!base) throw new Error("A base URL is required");
const browser = steady(await chromium.launch({ headless: true }));
try {
  const page = await browser.newPage();
  await page.goto(base);
  await page.evaluate(async () => { const { ready } = await import("corten"); await ready; });
  await page.getByText("Deck list", { exact: true }).click();
  await page.getByRole("region", { name: "Plan A", exact: true }).scrollIntoViewIfNeeded();
  const rounds = [];
  for (let round = 0; round < 6; round++) {
    const modes = round % 2 ? ["view", "app"] : ["app", "view"];
    for (const mode of modes) {
      const ms = await page.evaluate(async (mode) => {
        const { DeckEditor, DeckSummary, view } = await import("corten/views");
        const root = document.querySelector('[aria-label="Plan A"]');
        const [editor, summary] = root.querySelectorAll("template");
        const host = root.querySelector('[id^="preview-editor-"], [id^="preview-summary-"]').parentElement;
        const app = (host, View, template) => {
          const proto = template.content.firstElementChild;
          let el = host.firstElementChild;
          if (el?.id !== proto.id || el.tagName !== proto.tagName) {
            el = proto.cloneNode(true);
            host.replaceChildren(el);
          }
          return new View(el);
        };
        const mount = mode === "view" ? view : app;
        let elapsed = 0;
        for (let i = 0; i < 60; i++) {
          const start = performance.now();
          if (i % 2) mount(host, DeckSummary, summary).saved_total = i;
          else mount(host, DeckEditor, editor).total = i;
          elapsed += performance.now() - start;
          await new Promise(requestAnimationFrame);
        }
        return elapsed / 60;
      }, mode);
      rounds.push({ mode, ms });
    }
  }
  const stats = (mode) => {
    const values = rounds.filter((r) => r.mode === mode).map((r) => r.ms).sort((a, b) => a - b);
    return { median: (values[2] + values[3]) / 2, min: values[0], max: values.at(-1), unit: "ms per switch", rounds: 6, switchesPerRound: 60 };
  };
  console.log(JSON.stringify({ connectedTrees: { app: stats("app"), view: stats("view") }, note: "App baseline omits general ID/script/CSP validation; no speed benefit is claimed." }, null, 2));
  const urls = [process.argv[3], base].filter(Boolean);
  const measurements = new Map(urls.map((url) => [url, []]));
  for (let round = 0; round < 6; round++) for (const url of round % 2 ? [...urls].reverse() : urls) {
    // CSP nonces vary between responses; normalize them before comparing compressed bytes.
    const html = (await (await fetch(url)).text()).replace(/nonce="[^"]+"/g, 'nonce="NORMALIZED"');
    measurements.get(url).push({ raw: Buffer.byteLength(html), gzip: gzipSync(html).length });
  }
  for (const [url, documents] of measurements) {
    const assetUrls = new Set();
    const assetsPage = await browser.newPage();
    assetsPage.on("request", (r) => ["script", "stylesheet"].includes(r.resourceType()) && assetUrls.add(r.url()));
    await assetsPage.goto(url);
    await assetsPage.evaluate(async () => { const { ready } = await import("corten"); await ready; });
    const assets = { js: { raw: 0, gzip: 0, files: 0 }, css: { raw: 0, gzip: 0, files: 0 } };
    for (const assetUrl of assetUrls) {
      const kind = /\.css(?:\?|$)/.test(assetUrl) ? "css" : "js";
      const body = Buffer.from(await (await fetch(assetUrl)).arrayBuffer());
      assets[kind].raw += body.length;
      assets[kind].gzip += gzipSync(body).length;
      assets[kind].files++;
    }
    const sizes = (key) => {
      const values = documents.map((d) => d[key]).sort((a, b) => a - b);
      return { median: (values[2] + values[3]) / 2, min: values[0], max: values.at(-1) };
    };
    console.log(JSON.stringify({ url, document: { raw: sizes("raw"), gzip: sizes("gzip"), samples: 6 }, assets }));
    await assetsPage.close();
  }
} finally { await browser.close(); }
