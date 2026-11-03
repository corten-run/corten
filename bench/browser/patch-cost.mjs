// What a patch costs in Chromium, median of 9 for each size: a <tbody> of rows each with a
// <details> and a popover menu, each with a form holding a submit key, or plain, patched with new
// values after markup served by an earlier patch; an opened details and popover must stay open.
// node patch-cost.mjs [corten.js] [sizes, default 250,500,1000]
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "..", "package.json"));
const { chromium } = require("@playwright/test");
const { build } = require("esbuild");
const entry = (process.argv[2] || undefined) ?? join(here, "..", "..", "crates", "corten", "js", "corten.js");
const bundled = (await build({ entryPoints: [entry], bundle: true, format: "esm", write: false, target: "es2022" })).outputFiles[0].text;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body><table><tbody id="t"></tbody></table></body></html>');
const out = await page.evaluate(async ([src, sizes]) => {
  const mod = await import(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  const body = (n, rich, v) => {
    let s = '<tbody id="t">';
    for (let i = 0; i < n; i++) {
      s += `<tr id="r${i}"><td>Item ${i} v${v}</td><td>` + (rich === "forms"
        ? `<form method="post" action="/x" data-patch><input type="hidden" name="submit" data-submit value="k${i}"><button>Go</button></form>`
        : rich
        ? `<details><summary>More</summary><p>Detail ${i}</p></details><button popovertarget="m${i}">Menu</button><div popover id="m${i}"><a href="#">Edit</a></div>`
        : `<span><span>More</span><p>Detail ${i}</p></span><button>Menu</button><div><a href="#">Edit</a></div>`) + "</td></tr>";
    }
    return s + "</tbody>";
  };
  const res = {};
  for (const n of sizes) {
    res[n] = {};
    for (const rich of [false, true, "forms"]) {
      const times = [];
      for (let r = 0; r < 9; r++) {
        await mod.patch(body(n, rich, r * 2));
        const html = body(n, rich, r * 2 + 1);
        const t = performance.now();
        await mod.patch(html);
        times.push(performance.now() - t);
      }
      // One opened menu and details stay open through a patch.
      if (rich === true) {
        document.querySelector("#r3 details").open = true;
        document.getElementById("m5").showPopover();
        await mod.patch(body(n, rich, 99));
        if (!document.querySelector("#r3 details").open || !document.getElementById("m5").matches(":popover-open")) throw new Error("not kept open");
        document.getElementById("m5").hidePopover();
      }
      res[n][rich === "forms" ? "forms" : rich ? "rich" : "plain"] = times.sort((a, b) => a - b)[4].toFixed(1);
    }
  }
  return res;
}, [bundled, (process.argv[3] || "250,500,1000").split(",").map(Number)]);
console.log(JSON.stringify(out));
await browser.close();
