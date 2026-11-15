// Declarative shadow DOM as a way to place a slow part streamed later without a script, the
// evidence for design Choice 7 (docs/design.md#choice-whole-pages). Two layouts, in Chromium,
// Firefox and WebKit:
//
// - "page": the whole page in the shadow root, a named slot where the part goes. Whether the
//   slot's fallback shows and the late element replaces it with JavaScript off, and whether the
//   document reaches the page around it (an id, a #fragment link, a document stylesheet, a label).
// - "slots": a layout in the shadow root with a default slot and a named one, the page as the
//   host's own children. Whether the same holds for the page then, and where the late part may go:
//   only as a child of the host, which stays open until it arrives, and a part nested in the page
//   (a grid cell) is not placed.
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
/** @type {Record<string, { head: string, close: string, end: string, nestedLate?: boolean }>} */
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
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const layout = layouts[url.searchParams.get("layout") ?? "page"] ?? layouts.page;
  const nested = url.searchParams.has("nested");
  res.writeHead(200, { "content-type": "text/html" });
  // The late part, a child of the host or inside the page's cell (`nested`).
  const tail = nested ? LATE + layout.close + layout.end : layout.close + LATE + layout.end;
  const head = `<!doctype html><title>probe</title>${CSS}${layout.head}`;
  if (url.pathname === "/stream") {
    res.write(head + "<!--" + "x".repeat(4096) + "-->");
    setTimeout(() => res.end(tail), 2000);
  } else res.end(head + tail);
});
await new Promise((ok) => server.listen(0, () => ok(undefined)));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

for (const type of [chromium, firefox, webkit]) {
  const browser = await type.launch();
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
      console.log(
        type.name(),
        browser.version(),
        name + (nested ? " (late part inside the page's cell)" : ""),
        JSON.stringify({ jsOff: { before, after }, idsFound, documentCss: color, fragmentScrollY, labelFor }),
      );
      await off.context().close();
      await on.context().close();
    }
  }
  await browser.close();
}
server.close();
