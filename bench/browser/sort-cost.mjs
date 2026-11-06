// What a sort click costs in each engine (#960): corten-ui's rows::sort in place, against fetching
// the table sorted from a server and swapping it in, as a sort header without a handler does (a
// lower bound for that path: the server writes strings, and the swap is a template parse and
// replaceChildren, without the runtime's own work), and that swap with its answer fetched before
// the click (as the runtime's prefetch on hover would have it). Six columns, sizes 50 to 2,000
// rows, with no added latency and with 40 ms (Chromium only); median of 10 clicks on a text column
// and of 10 on a number column, each from the click to the frame after it. Two rounds, the modes
// in alternating order. Prints a line per case and writes results/sort-cost-<engine>.json.
// node sort-cost.mjs [engine, default chromium] [rows.js]
import http from "node:http";
import fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "..", "package.json"));
const playwright = require("@playwright/test");
const engine = process.argv[2] || "chromium";
const ROWS_JS = process.argv[3] || join(here, "..", "..", "crates", "corten-ui", "src", "rows.js");
const SIZES = [50, 200, 500, 1000, 2000];
const RUNS = 21;
const words = ["Ada", "Grace", "Linus", "Margaret", "Ken", "Barbara", "Dennis", "Frances", "Alan", "Radia", "Edsger", "Hedy"];
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({
  name: words[(i * 7) % words.length] + " " + words[(i * 5 + 3) % words.length] + " " + i,
  set: "Set " + ((i * 13) % 40),
  cond: ["NM", "LP", "MP", "HP"][i % 4],
  to: ["US", "CA", "GB", "DE", "JP"][(i * 3) % 5],
  day: 20260000 + ((i * 37) % 365),
  cents: (i * 7919) % 100000,
}));
// One collator for the server's sorts, as a real server would hold one: a new one per comparison
// (localeCompare with options) would charge the swap for the bench's own cost.
const collator = new Intl.Collator("en", { numeric: true });
const cache = new Map();
const data = (n) => cache.get(n) ?? (cache.set(n, rowsOf(n)), cache.get(n));
const cols = [["name", "Buyer"], ["set", "Set"], ["cond", "Condition"], ["to", "Ships to"], ["day", "Sold"], ["cents", "Price"]];
function table(n, by, dir) {
  let rows = data(n).slice();
  if (by) rows.sort((a, b) => (typeof a[by] === "number" ? a[by] - b[by] : collator.compare(a[by], b[by])) * dir);
  const head = cols.map(([k, label]) => {
    const up = "/t?n=" + n + "&by=" + k + "&dir=1", down = "/t?n=" + n + "&by=" + k + "&dir=-1";
    const sort = by === k ? (dir === 1 ? ' aria-sort="ascending"' : ' aria-sort="descending"') : "";
    return '<th scope="col"' + sort + '><a href="' + (by === k && dir === 1 ? down : up) + '" data-ascending="' + up + '" data-descending="' + down + '">' + label + "</a></th>";
  }).join("");
  const body = rows.map((r) => "<tr><td>" + r.name + "</td><td>" + r.set + "</td><td>" + r.cond + "</td><td>" + r.to + '</td><td data-sort="' + r.day + '">' + String(r.day).slice(4) + '</td><td data-sort="' + r.cents + '">$' + (r.cents / 100).toFixed(2) + "</td></tr>").join("");
  return '<table id="t"><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table>";
}
const page = (n, mode) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>sort</title><style>table{border-collapse:collapse;font:14px system-ui}td,th{padding:4px 8px;border-bottom:1px solid #ddd}</style></head><body><main>' + table(n, null, 1) +
  '</main><script type="module">import { sort } from "/rows.js";' +
  (mode === "place"
    ? 'document.addEventListener("click", (e) => { const a = e.target.closest("thead a"); if (a) sort(e, a); });'
    : // The answer, fetched at the click or before it (`window.__ahead`, as a prefetch on hover).
      'document.addEventListener("click", async (e) => { const a = e.target.closest("thead a"); if (!a) return; e.preventDefault(); const html = await (window.__ahead?.get(a.href) ?? fetch(a.href).then((r) => r.text())); const t = document.createElement("template"); t.innerHTML = html; document.querySelector("main").replaceChildren(t.content); history.replaceState(null, "", a.href); window.__done?.(); });') +
  "window.__ready = true;</script></body></html>";
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const n = Number(u.searchParams.get("n") ?? 50);
  if (u.pathname === "/rows.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(fs.readFileSync(ROWS_JS)); }
  if (u.pathname === "/t") { res.writeHead(200, { "content-type": "text/html" }); return res.end(table(n, u.searchParams.get("by"), Number(u.searchParams.get("dir")))); }
  res.writeHead(200, { "content-type": "text/html" }); res.end(page(n, u.searchParams.get("mode")));
});
await new Promise((r) => server.listen(0, r));
const base = "http://127.0.0.1:" + server.address().port;
const browser = await playwright[engine].launch();
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const MODES = ["place", "swap", "ahead"];
/** Each case's clicks, by case key, over both rounds. @type {Map<string, {text: number[], number: number[]}>} */
const clicks = new Map();
const latencies = engine === "chromium" ? [0, 40] : [0];
for (const round of [0, 1]) {
  for (const latency of latencies) {
    for (const n of SIZES) {
      for (const mode of round ? MODES.slice().reverse() : MODES) {
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        // Latency is added through Chromium's DevTools protocol, which the other engines lack.
        if (latency) { const cdp = await ctx.newCDPSession(p); await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 }); }
        await p.goto(base + "/?n=" + n + "&mode=" + (mode === "place" ? "place" : "swap"));
        await p.waitForFunction(() => window.__ready);
        const key = latency + "/" + n + "/" + mode;
        const got = clicks.get(key) ?? { text: [], number: [] };
        // Text columns (buyer, set) and number ones (sold, price), alternating; the first click of each kind is dropped.
        for (let i = 0; i < 22; i++) {
          const col = [0, 4, 1, 5][i % 4];
          const ms = await p.evaluate(async ([col, mode]) => {
            const a = document.querySelectorAll("thead a")[col];
            if (mode === "ahead") window.__ahead = new Map([[a.href, fetch(a.href).then((r) => r.text())]]);
            if (mode === "ahead") await window.__ahead.get(a.href);
            const done = mode === "place" ? null : new Promise((r) => (window.__done = r));
            const t0 = performance.now();
            a.click();
            if (done) await done;
            await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
            return performance.now() - t0;
          }, [col, mode]);
          if (i >= 2) (col === 0 || col === 1 ? got.text : got.number).push(ms);
        }
        clicks.set(key, got);
        await ctx.close();
      }
    }
  }
}
const results = [];
for (const latency of latencies) {
  for (const n of SIZES) {
    const row = { engine, latency, rows: n };
    for (const mode of MODES) {
      const got = clicks.get(latency + "/" + n + "/" + mode);
      row[mode] = { text: median(got.text), number: median(got.number) };
    }
    results.push(row);
    const f = (m) => row[m].text.toFixed(1) + "/" + row[m].number.toFixed(1);
    console.log(engine + " latency " + latency + "ms rows " + n + " (text/number ms): in place " + f("place") + ", swap " + f("swap") + ", swap fetched ahead " + f("ahead"));
  }
}
fs.mkdirSync(join(here, "results"), { recursive: true });
fs.writeFileSync(join(here, "results", "sort-cost-" + engine + ".json"), JSON.stringify(results, null, 2) + "\n");
await browser.close();
server.close();
