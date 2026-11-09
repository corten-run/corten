// What checking a feed's patch costs next to the JSON.parse it follows
// (docs/design.md#choice-script-boundaries):
// crates/corten/js/feed.js's patchOf against JSON.parse alone, and JSON.parse against itself for
// the timing's own noise, on patches of 1, 10 and 100 changes of a nine-field row (one in five a
// remove). Each takes turns in 15 rounds of 100 ms; prints each one's median nanoseconds a patch
// and the medians' differences over JSON.parse, in Chromium and in Node.
// node feed-check-cost.mjs [feed.js]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, "..", "..", "package.json"))("@playwright/test");
const feed = process.argv[2] ?? join(here, "..", "..", "crates", "corten", "js", "feed.js");

/** The timing, run where patchOf is: the same function in Chromium and in Node. @param {(data: string) => unknown} patchOf */
function measure(patchOf) {
  const row = (/** @type {number} */ i) => ({ id: `s${i}`, symbol: `SYM${i}`, name: `Company ${i} Holdings`, price_cents: 12345 + i, change_bp: -37, volume: 1234567, updated_at: "2026-11-08T13:00:00Z", sector: "tech", open: true });
  const patch = (/** @type {number} */ n) => JSON.stringify({ seq: 42, changes: Array.from({ length: n }, (_, i) => (i % 5 === 4 ? { op: "remove", id: `s${i}` } : { op: "upsert", id: `s${i}`, value: row(i) })) });
  let sink = 0;
  const time = (/** @type {(d: string) => unknown} */ fn, /** @type {string} */ data) => {
    for (let i = 0; i < 500; i++) sink += fn(data) ? 1 : 0;
    let n = 0;
    const t0 = performance.now();
    let t;
    do {
      for (let i = 0; i < 100; i++) sink += fn(data) ? 1 : 0;
      n += 100;
      t = performance.now();
    } while (t - t0 < 100);
    return ((t - t0) * 1e6) / n;
  };
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const n of [1, 10, 100]) {
    const data = patch(n);
    /** @type {Record<string, number[]>} */
    const runs = { parse: [], again: [], check: [] };
    for (let r = 0; r < 15; r++) {
      runs.parse.push(time((d) => JSON.parse(d), data));
      runs.check.push(time(patchOf, data));
      runs.again.push(time((d) => JSON.parse(d), data));
    }
    const med = (/** @type {number[]} */ xs) => [...xs].sort((a, b) => a - b)[7] ?? NaN;
    const [p, c, a] = [med(runs.parse), med(runs.check), med(runs.again)];
    const over = (/** @type {number} */ x) => `${(((x - p) / p) * 100).toFixed(1)}%`;
    out[n] = { bytes: data.length, parseNs: Math.round(p), checkNs: Math.round(c), checkOverParse: over(c), parseOverParse: over(a) };
  }
  return sink > 0 ? out : null;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const inChromium = await page.evaluate(async ([src, fn]) => {
  const { patchOf } = await import(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  return (0, eval)(`(${fn})`)(patchOf);
}, [readFileSync(feed, "utf8"), measure.toString()]);
await browser.close();
const { patchOf } = await import(pathToFileURL(feed).href);
console.log(JSON.stringify({ chromium: inChromium, node: measure(patchOf) }, null, 1));
