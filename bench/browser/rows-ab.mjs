// Two builds of rows() (crates/corten/js/view.js) in one Chromium page, taking turns sample by
// sample, so load that drifts on a busy machine falls on both: a push then a get by key (a
// quarter of the rows, five times), replace() with new values for every row (20 times), with the
// rows in a shuffled order and back (10 times: the longest run kept, the rest moved), and with
// half the rows then all again (10 times). Prints each build's median and the median of the
// samples' ratios, second over first. node rows-ab.mjs <view.js> <view.js> [samples, default 41]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, "..", "..", "package.json"))("@playwright/test");
const [oldPath, newPath, reps = "41"] = process.argv.slice(2);
if (!oldPath || !newPath) throw new Error("node rows-ab.mjs <view.js> <view.js> [samples]");
const srcs = [readFileSync(oldPath, "utf8"), readFileSync(newPath, "utf8")];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<template id="t"><li data-key=""><b></b></li></template>');
const out = await page.evaluate(async ([srcs, reps]) => {
  const mods = await Promise.all(srcs.map((s) => import(URL.createObjectURL(new Blob([s], { type: "text/javascript" })))));
  const res = {};
  let seed = 11;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const n of [1000, 4000]) {
    const items = Array.from({ length: n }, (_, i) => ({ id: i, name: "Row " + i }));
    const kept = items.filter((x) => x.id % 2 === 0);
    const refill = items.map((x) => ({ id: x.id, name: "New " + x.id }));
    const shuffled = items.slice();
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const refillB = items.map((x) => ({ id: x.id, name: "Other " + x.id }));
    const t = { push: [[], []], kept: [[], []], refill: [[], []], shuffle: [[], []] };
    for (let r = 0; r < reps; r++) {
      for (const w of r % 2 ? [1, 0] : [0, 1]) {
        const mod = mods[w];
        class Row {
          constructor(el) { this.el = el; }
          static fill(el, d) { el.setAttribute("data-key", String(d.id)); mod.text(el.firstElementChild, d.name); }
          static key(el) { return el.getAttribute("data-key") ?? ""; }
          static keyOf(d) { return String(d.id); }
        }
        const tpl = document.getElementById("t");
        const ul = document.createElement("ul");
        document.body.append(ul);
        const list = mod.rows(ul, Row, tpl);
        let s = performance.now();
        for (let k = 0; k < 5; k++) { list.clear(); for (let i = 0; i < n / 4; i++) { list.push([items[i]]); list.get(String(i)); } }
        t.push[w].push(performance.now() - s);
        list.replace(items);
        s = performance.now();
        for (let k = 0; k < 20; k++) list.replace(k % 2 ? refill : refillB);
        t.refill[w].push(performance.now() - s);
        s = performance.now();
        for (let k = 0; k < 10; k++) list.replace(k % 2 ? items : shuffled);
        t.shuffle[w].push(performance.now() - s);
        s = performance.now();
        for (let k = 0; k < 10; k++) { list.replace(items); list.replace(kept); }
        t.kept[w].push(performance.now() - s);
        ul.remove();
      }
    }
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
    // Paired: each sample's new over the old one beside it, so load that drifts cancels.
    const ratio = (o, nn) => med(o.map((x, i) => nn[i] / x));
    res[n] = Object.fromEntries(Object.entries(t).map(([k, [o, nn]]) => [k, `old ${med(o).toFixed(1)} new ${med(nn).toFixed(1)} paired ${((ratio(o, nn) - 1) * 100).toFixed(1)}%`]));
  }
  return res;
}, [srcs, Number(reps)]);
console.log(JSON.stringify(out, null, 1));
await browser.close();
