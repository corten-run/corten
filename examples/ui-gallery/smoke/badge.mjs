import { base, check } from "./helpers.mjs";

export async function badge(orders, browser) {
  // Badge's tones: the paid order's text and its background meet WCAG AA (4.5:1), as drawn.
  const paid = await orders.locator("td > span", { hasText: /^Paid$/ }).first().evaluate((el) => {
    // `rgb(r, g, b)`, or `color(srgb r g b)` (0 to 1) for a color-mix in sRGB.
    const rgb = (/** @type {string} */ c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => (c.startsWith("color(srgb") ? Number(v) * 255 : Number(v)));
    const lum = (/** @type {number[]} */ c) => c.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const style = getComputedStyle(el);
    const [a, b] = [lum(rgb(style.color)), lum(rgb(style.backgroundColor))].sort((x, y) => y - x);
    return { ratio: (a + 0.05) / (b + 0.05), color: style.color, background: style.backgroundColor };
  });
  check("Badge: a soft success badge's text meets 4.5:1", paid.ratio >= 4.5, JSON.stringify(paid));
  // A badge is never wider than its box, on a phone: a key with no break in it (a hash) wraps inside
  // the badge, and one with hyphens (the report's) stays inside it, in a row that wraps (a
  // Cluster), a column (a Stack, where a badge keeps its own width) and a block, and the page does
  // not scroll sideways; a short label, and one led by a StatusDot or an Icon, keep one line with a
  // quarter rem after the mark. Measured by the text's own line boxes, which can run out of a
  // badge whose box is held, with the gallery's `box-sizing` reset off, as an app may not have one.
  {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(`${base}/orders`);
    const badges = await phone.evaluate(() => {
      const reset = new CSSStyleSheet();
      reset.replaceSync("*, *::before, *::after { box-sizing: content-box; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, reset];
      const kit = /** @type {HTMLElement} */ (document.querySelector("td > [class*='badge__badge']"));
      const dot = /** @type {HTMLElement} */ (document.querySelector("[class*='badge__badge'] > [class*='status-dot__dot']"));
      const icon = /** @type {SVGElement} */ (document.querySelector("svg[class*='icon__icon']"));
      /** The badge's text, without its mark. @param {Element} el */
      const text = (el) => {
        const rects = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .flatMap((n) => {
            const range = document.createRange();
            range.selectNodeContents(n);
            return Array.from(range.getClientRects()).filter((r) => r.width > 0);
          });
        const first = rects.reduce((a, r) => (r.top < a.top ? r : a), rects[0]);
        return { lines: new Set(rects.map((r) => Math.round(r.top))).size, left: first.left, right: Math.max(...rects.map((r) => r.right)) };
      };
      /** @param {Partial<CSSStyleDeclaration>} style */
      const row = (style) => {
        const box = document.createElement("div");
        // Set through the CSSOM, which the page's CSP allows where a style attribute is refused.
        Object.assign(box.style, style);
        const labels = ["Paid", "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "Unit: tcgdex:pokemon:single-card:source-observation-import"];
        const made = labels.map((label) => {
          const badge = /** @type {HTMLElement} */ (kit.cloneNode(false));
          badge.textContent = label;
          return badge;
        });
        const marked = [dot, icon].map((mark) => {
          const badge = /** @type {HTMLElement} */ (kit.cloneNode(false));
          badge.append(mark.cloneNode(true), "Open");
          return badge;
        });
        box.append(...made, ...marked);
        (document.querySelector("main") ?? document.body).prepend(box);
        const page = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const outer = box.getBoundingClientRect();
        const counted = [...made, ...marked].map((badge) => {
          const b = badge.getBoundingClientRect();
          const inner = b.right - parseFloat(getComputedStyle(badge).paddingRight) - parseFloat(getComputedStyle(badge).borderRightWidth);
          const t = text(badge);
          const mark = badge.firstElementChild?.getBoundingClientRect();
          return { width: Math.round(b.width), past: Math.round(b.right - outer.right), spill: Math.round(t.right - inner), lines: t.lines, after: mark ? Math.round(t.left - mark.right) : 4 };
        });
        box.remove();
        return { page, short: counted[0], hash: counted[1], hyphens: counted[2], dotted: counted[3], iconed: counted[4] };
      };
      const shown = { cluster: row({ display: "flex", flexWrap: "wrap", gap: ".5rem" }), stack: row({ display: "flex", flexDirection: "column", gap: ".5rem" }), block: row({ display: "block" }) };
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== reset);
      return shown;
    });
    await phone.context().close();
    check(
      "Badge: on a phone a long key (a hash, or with hyphens) stays inside its badge, in a Cluster, a Stack and a block, and the page does not scroll; a short label and one led by a dot or an icon keep one line, a quarter rem after the mark, and their own width in a Stack",
      [badges.cluster, badges.stack, badges.block].every(
        (r) =>
          r.page === 0 &&
          r.hash.lines >= 2 &&
          [r.hash, r.hyphens].every((b) => b.past <= 0 && b.spill <= 0) &&
          [r.short, r.dotted, r.iconed].every((b) => b.past <= 0 && b.spill <= 0 && b.lines === 1 && b.after === 4 && b.width < 120),
      ),
      JSON.stringify(badges),
    );
  }
}
