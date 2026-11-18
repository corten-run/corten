// CSSOM oracle for the component scoper and startup scanner's shared Rust fixture.
import { deepStrictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const cases = JSON.parse(readFileSync(new URL("../crates/corten-macros/src/css-scan-cases.json", import.meta.url), "utf8"));

export async function checkCssScanner(browser) {
  const page = await browser.newPage();
  const engine = browser.browserType().name();
  try {
    const readings = await page.evaluate((cases) => {
      function read(css, scoped = false) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        const name = (s) => scoped ? s.replace(/(^--|\.)x__/g, "$1") : s;
        function rule(r) {
          const type = r.constructor.name.replace(/^CSS|Rule$/g, "");
          const head = r.selectorText ?? r.name ?? r.nameList?.join(",") ?? null;
          const declarations = Array.from(r.style ?? [], (key) => name(key) + (r.style.getPropertyPriority(key) ? "!" : ""));
          const result = [head ? type + ":" + name(head) : type, declarations, Array.from(r.cssRules ?? [], rule)];
          if (type === "Scope") {
            result.push(r.start && name(r.start), r.end && name(r.end));
          } else if (type === "Property") {
            result.push([r.syntax, r.inherits, r.initialValue]);
          } else if (type === "Supports" && r.conditionText.startsWith("selector(")) {
            result.push(CSS.supports(r.conditionText));
          }
          if (r.style?.getPropertyValue("background-image")?.startsWith("url(")) {
            result.push(r.style.getPropertyValue("background-image"));
          }
          return result;
        }
        return Array.from(sheet.cssRules, rule);
      }
      return cases.map(({ css, scoped }) => [read(css), scoped === undefined ? null : read(scoped, true)]);
    }, cases);
    for (let i = 0; i < cases.length; i++) {
      const { name, browser: expected, browserScoped } = cases[i];
      const [raw, scoped] = readings[i];
      const reading = (value) => Array.isArray(value) ? value : value[engine] ?? value.default;
      deepStrictEqual(raw, reading(expected), `${engine}: source: ${name}`);
      if (scoped !== null) deepStrictEqual(scoped, reading(browserScoped ?? expected), `${engine}: scoped: ${name}`);
    }
    return cases.length;
  } finally {
    await page.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const engines = { chromium, firefox, webkit };
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(engines)) {
    const browser = await engines[name].launch();
    try {
      console.log(`${name} ${browser.version()}: ${await checkCssScanner(browser)} CSS cases passed`);
    } finally {
      await browser.close();
    }
  }
}
