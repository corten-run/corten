// What a large handler argument costs the browser, in each of the three engines Corten's smoke tests
// run: parsing a page that carries it, and getting the value back, for 300 products in each of the
// three forms `json_argument_cost` (crates/corten/src/script/tests.rs) writes to target/data-on-cost/:
//   single.html  data-on as Corten writes it, single-quoted, the JSON's quotes as they are
//   double.html  the double-quoted attribute it replaced, every quote of the JSON `&quot;`
//   block.html   a <script type="application/json"> data block, which a handler would name by id
// The parse is `new DOMParser().parseFromString` of the page; getting the value back is, for the
// attributes, `getAttribute` and the runtime's own parser (crates/corten/js/on.js, which ends in
// `JSON.parse`), and for the block `getElementById` and `JSON.parse` of its text. Each is timed
// over `rounds` repetitions, `runs` times, the three forms alternated within a run after one run
// that is not counted; it prints the median and range per repetition, in microseconds, and checks
// that the three forms give the same value (docs/design.md#choice-data-on-single-quoted).
//   cargo test --release -p corten-run --all-features --lib -- --ignored json_argument_cost --nocapture
//   node bench/browser/data-on-cost.mjs [runs=8] [rounds=100]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const playwright = createRequire(join(root, "package.json"))("@playwright/test");
const [runs = 8, rounds = 100] = process.argv.slice(2).map(Number);
const forms = ["single", "double", "block"];
/** @type {Record<string, string>} */
const pages = Object.fromEntries(forms.map((form) => [form, readFileSync(join(root, "target", "data-on-cost", `${form}.html`), "utf8")]));
// on.js is a module with no imports; as a classic script its functions become the page's.
const parser = `${readFileSync(join(root, "crates", "corten", "js", "on.js"), "utf8").replaceAll("export function", "function")}\nwindow.parseOn = parseOn;`;

for (const engine of ["chromium", "firefox", "webkit"]) {
  const browser = await playwright[engine].launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent("<!DOCTYPE html><title>data-on cost</title>");
  await page.addScriptTag({ content: parser });
  const result = await page.evaluate(
    ({ pages, forms, runs, rounds }) => {
      const parseOn = /** @type {any} */ (window).parseOn;
      const documents = Object.fromEntries(
        forms.map((form) => [
          form,
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Listing</title></head><body>${pages[form]}</body></html>`,
        ]),
      );
      /** @type {Record<string, () => unknown>} */
      const reads = {};
      for (const form of forms) {
        const doc = new DOMParser().parseFromString(documents[form], "text/html");
        reads[form] =
          form === "block"
            ? () => JSON.parse(doc.getElementById("listing")?.textContent ?? "")
            : () => parseOn(doc.querySelector("span[data-on]")?.getAttribute("data-on") ?? "")[0].args[1].value;
      }
      const same = forms.every((form) => JSON.stringify(reads[form]()) === JSON.stringify(reads.single()));
      /** @type {Record<string, { parse: number[], value: number[] }>} */
      const times = Object.fromEntries(forms.map((form) => [form, { parse: [], value: [] }]));
      let sink;
      for (let run = 0; run <= runs; run += 1) {
        for (const form of forms) {
          const html = documents[form];
          const read = reads[form];
          let start = performance.now();
          for (let i = 0; i < rounds; i += 1) sink = new DOMParser().parseFromString(html, "text/html");
          const parse = ((performance.now() - start) * 1000) / rounds;
          start = performance.now();
          for (let i = 0; i < rounds; i += 1) sink = read();
          const value = ((performance.now() - start) * 1000) / rounds;
          if (run > 0) {
            times[form].parse.push(parse);
            times[form].value.push(value);
          }
        }
      }
      void sink;
      return { same, times };
    },
    { pages, forms, runs, rounds },
  );
  /** @param {number[]} xs */
  const stat = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return { median: sorted[sorted.length >> 1] ?? NaN, min: sorted[0] ?? NaN, max: sorted[sorted.length - 1] ?? NaN };
  };
  /** @param {{ median: number, min: number, max: number }} s */
  const shown = (s) => `${s.median.toFixed(0)} (${s.min.toFixed(0)} to ${s.max.toFixed(0)})`;
  console.log(`${engine} ${browser.version()}: ${runs} runs of ${rounds}, the same value from each form: ${result.same}`);
  for (const form of forms) {
    const parse = stat(result.times[form].parse);
    const value = stat(result.times[form].value);
    console.log(
      `  ${form.padEnd(6)} ${String(pages[form].length).padStart(6)} B  parse ${shown(parse)} us  value ${shown(value)} us  both ${(parse.median + value.median).toFixed(0)} us`,
    );
  }
  await browser.close();
}
