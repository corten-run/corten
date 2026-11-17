// Declarative shadow DOM, and Chromium's out-of-order streaming (Declarative Partial Updates), as
// ways to place a slow part streamed later without a script, the evidence for the design's choice
// of whole pages (docs/design.md#choice-whole-pages). Three layouts, in Chromium (with and without
// its experimental web platform features), Firefox and WebKit:
//
// - "page": the whole page in the shadow root, a named slot where the part goes. Whether the
//   slot's fallback shows and the late element replaces it with JavaScript off, and whether the
//   document reaches the page around it (an id, a #fragment link, a document stylesheet, a label).
// - "slots": a layout in the shadow root with a default slot and a named one, the page as the
//   host's own children. Whether the same holds for the page then, and where the late part may go:
//   only as a child of the host, which stays open until it arrives, and a part nested in the page
//   (a grid cell) is not placed.
// - "templateFor": no shadow root; the part's place is a `<?start name>` processing instruction
//   in a cell of the page, its fallback up to `<?end>`, and the late part a `<template for>` sent
//   after `</main>`. `pi` says whether the parser left a processing instruction in the page and
//   whether it applied the template (an engine without them parses the marker as a comment, the
//   fallback stays and the template is inert), and whether a script can stream markup into an
//   element as the parser does (`streamSetter`, the streaming setters an engine has).
//
// Run from a checkout after `npm ci` and `npx playwright install chromium firefox webkit`:
// node scripts/dsd-probe.mjs. It prints one line of results a layout and engine.
import http from "node:http";
import { chromium, firefox, webkit } from "playwright";

const CSS = "<style>#inner{color:rgb(255,0,0)}</style>";
const PAGE = '<p id=inner>inside</p><a id=jump href=#target>jump</a><div style=height:3000px></div><p id=target>target</p><label for=box>box</label><input id=box type=checkbox>';
const LATE = "<p slot=picks id=late>picks</p>";
// `head` is sent first; the late part follows, then `close` and `end`, or between them as a child
// of the host (`close` ends the page's cell).
/** @type {Record<string, { head: string, close: string, end: string, nestedLate?: boolean, late?: string }>} */
const layouts = {
  page: {
    head: `<div id=host><template shadowrootmode=open>${PAGE}<slot name=picks><span id=fallback>fallback</span></slot></template>`,
    close: "",
    end: "</div>",
  },
  slots: {
    head: `<div id=host><template shadowrootmode=open><header>layout</header><slot></slot><slot name=picks><span id=fallback>fallback</span></slot></template>${PAGE}<div id=cell>`,
    close: "</div>",
    end: "</div>",
    nestedLate: true,
  },
  templateFor: {
    head: `<main>${PAGE}<div id=cell><?start name="picks"><span id=fallback>fallback</span><?end></div>`,
    close: "</main>",
    end: "",
    late: '<template for="picks"><p id=late>picks</p></template>',
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const layout = layouts[url.searchParams.get("layout") ?? "page"] ?? layouts.page;
  const nested = url.searchParams.has("nested");
  res.writeHead(200, { "content-type": "text/html" });
  // The late part, a child of the host or inside the page's cell (`nested`).
  const late = layout.late ?? LATE;
  const tail = nested ? late + layout.close + layout.end : layout.close + late + layout.end;
  const head = `<!doctype html><title>probe</title>${CSS}${layout.head}`;
  if (url.pathname === "/stream") {
    res.write(head + "<!--" + "x".repeat(4096) + "-->");
    setTimeout(() => res.end(tail), 2000);
  } else res.end(head + tail);
});
await new Promise((ok) => server.listen(0, () => ok(undefined)));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

/** @type {[import("playwright").BrowserType, string[]][]} */
const runs = [
  [chromium, []],
  [chromium, ["--enable-experimental-web-platform-features"]],
  [firefox, []],
  [webkit, []],
];
for (const [type, args] of runs) {
  const browser = await type.launch({ args });
  for (const [name, layout] of Object.entries(layouts)) {
    for (const nested of layout.nestedLate ? [false, true] : [false]) {
      const query = `?layout=${name}${nested ? "&nested" : ""}`;
      const off = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
      await off.goto(`${base}/stream${query}`, { waitUntil: "commit" });
      await off.waitForTimeout(700);
      const before = { fallback: await off.locator("#fallback").isVisible(), late: await off.locator("#late").isVisible() };
      await off.waitForTimeout(2300);
      const after = { fallback: await off.locator("#fallback").isVisible(), late: await off.locator("#late").isVisible() };
      const on = await (await browser.newContext()).newPage();
      await on.goto(`${base}/${query}`);
      const idsFound = await on.evaluate(() => document.getElementById("inner") !== null && document.getElementById("target") !== null);
      const color = await on.evaluate(() => {
        const inner = document.getElementById("inner") ?? document.getElementById("host")?.shadowRoot?.getElementById("inner");
        return inner ? getComputedStyle(inner).color : null;
      });
      await on.click("#jump");
      await on.waitForTimeout(300);
      const fragmentScrollY = await on.evaluate(() => scrollY);
      await on.click("label");
      const labelFor = await on.evaluate(() => {
        const box = /** @type {HTMLInputElement | null | undefined} */ (document.getElementById("box") ?? document.getElementById("host")?.shadowRoot?.getElementById("box"));
        return box?.checked ?? null;
      });
      // As the document's parser built the page: a processing instruction left in it, or a
      // `<template for>` it applied (gone from the page, its part in the cell).
      // And whether a script can parse a stream into the page as the parser does, which a
      // navigation that swaps <main> in would need to place a part sent later.
      const pi =
        name === "templateFor"
          ? await on.evaluate(() => ({
              node: document.createTreeWalker(document, NodeFilter.SHOW_PROCESSING_INSTRUCTION).nextNode() !== null,
              applied: document.querySelector("template[for]") === null && document.querySelector("#cell #late") !== null,
              streamSetter: ["streamHTML", "streamHTMLUnsafe", "streamAppendHTMLUnsafe"].filter((name) => name in Element.prototype),
            }))
          : undefined;
      console.log(
        type.name(),
        browser.version(),
        args.join(" ") || "(no flags)",
        name + (nested ? " (late part inside the page's cell)" : ""),
        JSON.stringify({ jsOff: { before, after }, idsFound, documentCss: color, fragmentScrollY, labelFor, pi }),
      );
      await off.context().close();
      await on.context().close();
    }
  }
  await browser.close();
}
server.close();
