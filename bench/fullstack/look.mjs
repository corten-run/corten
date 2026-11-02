// Every app's pages must look like Corten's: in Chromium, at a desktop and a phone width and in the
// light and dark color schemes, each element of the page's outline (outline.mjs's, less what the
// browser does not draw: display:none) must sit at the same place with the same size (so a margin,
// padding or gap that moves or resizes an element shows), and have the same colors,
// fonts, borders and display; the visible text must be the same too (Next.js renders its 404 only
// in the browser, so this is where its text is checked).
// Bundlers minify and reorder CSS, so its bytes are not compared; what it does to the page is.
// Usage: node look.mjs [apps=all] [reference=corten]  (apps running on their catalog ports)
import { chromium } from "@playwright/test";
import { steady } from "../../scripts/steady.mjs";
import { apps } from "./apps.mjs";

const names = Object.keys(apps).filter((n) => !process.argv[2] || process.argv[2].split(",").includes(n));
const reference = process.argv[3] ?? "corten";
const others = names.filter((n) => n !== reference);
const pages = ["/items/item_17", "/items/item_12345", "/", "/items/does-not-exist"];
const views = [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
];
const schemes = /** @type {const} */ (["light", "dark"]);
/** Computed styles compared, besides the box. */
const properties = ["display", "color", "background-color", "background-image", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-decoration-line", "text-align", "font-variant-numeric", "border-top-width", "border-top-style", "border-top-color", "border-bottom-width", "border-bottom-color", "border-top-left-radius", "box-shadow", "list-style-type", "opacity", "cursor"];

/** The outline's elements in the live page (outline.mjs's rules, and display:none left out too), each with its box and styles. */
const measure = (/** @type {string[]} */ properties) => {
  /** @type {{ what: string, box: number[], style: string, before: string }[]} */
  const out = [];
  /** @param {Element} el @param {number} depth */
  const walk = (el, depth) => {
    for (const child of el.children) {
      const name = child.localName;
      // Not drawn: a framework's own hidden parts (Phoenix's loading bar leaves a display:none canvas
      // when LiveView took over 300 ms to connect) are not the page.
      if (["script", "template", "style", "noscript"].includes(name) || child.hasAttribute("hidden") || getComputedStyle(child).display === "none") continue;
      if (name === "input" && /** @type {HTMLInputElement} */ (child).type === "hidden") continue;
      const classes = [...child.classList].filter((c) => !c.startsWith("phx-"));
      if ((name === "div" && !classes.length && !child.hasAttribute("role")) || name.includes("-")) { walk(child, depth); continue; }
      const r = child.getBoundingClientRect();
      const s = getComputedStyle(child);
      const b = getComputedStyle(child, "::before");
      out.push({
        what: "  ".repeat(depth) + name + classes.map((c) => "." + c).join(""),
        box: [r.x, r.y + scrollY, r.width, r.height].map((v) => Math.round(v * 10) / 10),
        style: properties.map((p) => p + ":" + s.getPropertyValue(p)).join("; "),
        before: b.content === "none" ? "" : ["content", "width", "height", "background-image", "margin-inline-end"].map((p) => p + ":" + b.getPropertyValue(p)).join("; "),
      });
      walk(child, depth + 1);
    }
  };
  walk(document.body, 0);
  return out;
};

const browser = steady(await chromium.launch({ headless: true }));
let failures = 0;
try {
  for (const view of views) {
    for (const scheme of schemes) {
      const context = await browser.newContext({ viewport: view.viewport, colorScheme: scheme, deviceScaleFactor: 1 });
      /** One page per measurement, so a failed load cannot leave the next one mid-navigation. */
      const load = async (/** @type {string} */ url) => {
        const page = await context.newPage();
        // A stylesheet or script whose request failed would show as a style or box difference; say what it was.
        /** @type {string[]} */
        const failed = [];
        page.on("requestfailed", (r) => { if (["stylesheet", "script"].includes(r.resourceType())) failed.push(`${r.url()} ${r.failure()?.errorText}`); });
        try {
          await page.goto(url, { waitUntil: "load", timeout: 60_000 });
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
          // Every stylesheet applied (a framework may add its links during hydration), and fonts.
          await page.waitForFunction(() => [...document.querySelectorAll("link[rel=stylesheet]")].every((l) => /** @type {HTMLLinkElement} */ (l).sheet), null, { timeout: 10_000 });
          await page.evaluate(() => document.fonts.ready);
          if (failed.length) throw new Error(`request failed: ${failed.join(", ")}`);
          const elements = await page.evaluate(measure, properties);
          // Whitespace aside: a flex row of spans has no spaces in innerText, a template's has. So a
          // missing space is caught by parity.mjs's text, and nowhere for Next.js's 404 (browser only).
          const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ""));
          return { elements, text };
        } finally {
          await page.close();
        }
      };
      // Once more when every failure was a reset connection (Docker Desktop's port proxy drops some
      // on a busy machine): the page or a file of it did not arrive, which says nothing about how it looks.
      const shot = async (/** @type {string} */ app, /** @type {string} */ path) => {
        const url = `http://localhost:${apps[app].port}${path}`;
        try {
          return await load(url);
        } catch (error) {
          const message = error instanceof Error ? error.message.split("\n")[0] : "";
          const errors = message.match(/net::ERR_[A-Z_]+/g) ?? [];
          if (!errors.length || errors.some((e) => e !== "net::ERR_CONNECTION_RESET")) throw error;
          console.log(JSON.stringify({ app, page: path, view: view.name, scheme, retry: message }));
          return load(url);
        }
      };
      for (const path of pages) {
        let want;
        try {
          want = await shot(reference, path);
        } catch (error) {
          failures += others.length;
          console.log(JSON.stringify({ app: reference, page: path, view: view.name, scheme, error: error instanceof Error ? error.message.split("\n")[0] : String(error) }));
          continue;
        }
        for (const app of others) {
          let got;
          try {
            got = await shot(app, path);
          } catch (error) {
            failures += 1;
            console.log(JSON.stringify({ app, page: path, view: view.name, scheme, error: error instanceof Error ? error.message.split("\n")[0] : String(error) }));
            continue;
          }
          const n = Math.max(want.elements.length, got.elements.length);
          /** @type {Record<string, unknown> | null} */
          let problem = null;
          if (want.text !== got.text) {
            let i = 0;
            while (i < want.text.length && want.text[i] === got.text[i]) i += 1;
            problem = { text: { expected: want.text.slice(Math.max(0, i - 30), i + 50), actual: got.text.slice(Math.max(0, i - 30), i + 50) } };
          }
          for (let i = 0; i < n && !problem; i += 1) {
            const [w, g] = [want.elements[i], got.elements[i]];
            if (!w || !g || w.what !== g.what) problem = { element: i + 1, expected: w?.what ?? "(nothing)", actual: g?.what ?? "(nothing)" };
            else if (w.box.some((v, k) => Math.abs(v - g.box[k]) > 1)) problem = { element: w.what.trim(), at: i + 1, expectedBox: w.box, actualBox: g.box };
            else if (w.style !== g.style || w.before !== g.before) {
              const ws = (w.style + "; " + w.before).split("; "), gs = (g.style + "; " + g.before).split("; ");
              problem = { element: w.what.trim(), at: i + 1, expected: ws.filter((p) => !gs.includes(p)), actual: gs.filter((p) => !ws.includes(p)) };
            }
          }
          if (problem) {
            failures += 1;
            console.log(JSON.stringify({ app, page: path, view: view.name, scheme, elements: [want.elements.length, got.elements.length], ...problem }));
          }
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ reference, compared: others, pages: pages.length, views: views.length * schemes.length, failures }));
process.exit(failures ? 1 : 0);
