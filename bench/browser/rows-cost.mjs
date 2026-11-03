// What rows() (crates/corten/js/view.js) costs in Chromium, median of 15 for each size: removing
// every other row by key one at a time, replace() with the rows that stay, a push then a get by
// key (a quarter of the rows), and replace() of every row with new values.
// node rows-cost.mjs [view.js] [sizes, default 1000,4000]
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "..", "package.json"));
const { chromium } = require("@playwright/test");
const src = readFileSync((process.argv[2] || undefined) ?? join(here, "..", "..", "crates", "corten", "js", "view.js"), "utf8");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<ul id="l"></ul><template id="t"><li data-key=""><b></b></li></template>');
const out = await page.evaluate(async ([src, sizes]) => {
  const mod = await import(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  class Row {
    constructor(el) { this.el = el; }
    static fill(el, d) { el.setAttribute("data-key", String(d.id)); mod.text(el.firstElementChild, d.name); }
    static key(el) { return el.getAttribute("data-key") ?? ""; }
    static keyOf(d) { return String(d.id); }
  }
  const res = {};
  for (const n of sizes) {
    const items = Array.from({ length: n }, (_, i) => ({ id: i, name: "Row " + i }));
    const removed = items.filter((x) => x.id % 2 === 1).map((x) => String(x.id));
    const kept = items.filter((x) => x.id % 2 === 0);
    const one = [], all = [], push = [], refill = [];
    for (let r = 0; r < 15; r++) {
      const ul = document.createElement("ul");
      document.body.append(ul);
      let list = mod.rows(ul, Row, document.getElementById("t"));
      list.replace(items);
      let t = performance.now();
      for (const id of removed) list.remove(list.get(id));
      one.push(performance.now() - t);
      if (list.length !== kept.length || list.get("1") || !list.get("2")) throw new Error("wrong rows after remove");
      ul.remove();
      const ul2 = document.createElement("ul");
      document.body.append(ul2);
      list = mod.rows(ul2, Row, document.getElementById("t"));
      list.replace(items);
      t = performance.now();
      list.replace(kept);
      all.push(performance.now() - t);
      ul2.remove();
      // push one row then get it, n/4 times: each push used to drop the map.
      const ul3 = document.createElement("ul");
      document.body.append(ul3);
      list = mod.rows(ul3, Row, document.getElementById("t"));
      list.replace(items);
      t = performance.now();
      for (let i = 0; i < n / 4; i++) { list.push([{ id: n + i, name: "x" }]); if (!list.get(String(i))) throw new Error("get"); }
      push.push(performance.now() - t);
      ul3.remove();
      // replace every row with new values: each kept row is filled again (data-key written).
      const ul4 = document.createElement("ul");
      document.body.append(ul4);
      list = mod.rows(ul4, Row, document.getElementById("t"));
      list.replace(items);
      list.get("0");
      const changed = items.map((x) => ({ id: x.id, name: "New " + x.id }));
      t = performance.now();
      list.replace(changed);
      refill.push(performance.now() - t);
      ul4.remove();
    }
    const med = (a) => a.sort((x, y) => x - y)[7].toFixed(1);
    res[n] = { removeByKey: med(one), replaceKept: med(all), pushThenGet: med(push), refillAll: med(refill) };
  }
  return res;
}, [src, (process.argv[3] || "1000,4000").split(",").map(Number)]);
console.log(JSON.stringify(out));
await browser.close();
