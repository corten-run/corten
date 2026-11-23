import { check } from "./helpers.mjs";

export async function card(orders) {
  // Card: an action on the heading's row at its end, the description under them; a panel is one
  // element with the card's padding on every side; a CardSize::Sm card is denser (#573, #605, #1132).
  const cards = await orders.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const box = (/** @type {Element | null | undefined} */ e) => e?.getBoundingClientRect();
    const action = document.querySelector("[class*='card__action']");
    const header = action?.parentElement;
    const [heading, note] = [header?.querySelector("h2"), header?.querySelector(":scope > p")];
    const mid = (/** @type {DOMRect | undefined} */ r) => (r ? r.top + r.height / 2 : NaN);
    const panel = document.querySelector("[class*='card__panel']");
    const compact = document.querySelector("[class~='card__card'][class~='card__sm']");
    const pad = (/** @type {Element | null} */ e) => (e ? [getComputedStyle(e).paddingTop, getComputedStyle(e).paddingLeft].map((p) => parseFloat(p) / rem) : []);
    return {
      row: Math.abs(mid(box(heading)) - mid(box(action))) <= 2,
      // The header's padding after it, to a pixel (Firefox lays out to fractions).
      end: Math.abs((box(header)?.right ?? 0) - (box(action)?.right ?? 0) - 1.5 * rem) <= 1,
      gap: (box(header)?.right ?? 0) - (box(action)?.right ?? 0),
      note: (box(note)?.top ?? 0) >= (box(action)?.bottom ?? Infinity) - 1,
      // The surface (background and border) and padding are the panel's; its layout is the Stack's.
      panel: panel ? `${getComputedStyle(panel).display} ${pad(panel).join(" ")} ${getComputedStyle(panel).backgroundColor !== "rgba(0, 0, 0, 0)"} ${getComputedStyle(panel).borderTopStyle}` : "missing",
      compact: pad(compact)[0],
    };
  });
  check(
    "Card: an action at the end of the heading's row, the description under it; a panel and a compact card",
    cards.row && cards.end && cards.note && cards.panel === "flex 1.5 1.5 true solid" && cards.compact === 1,
    JSON.stringify(cards),
  );
  // A theme whose cards are tight keeps a small card smaller than a default one: its padding and
  // gap follow the theme's --card-padding, not a number of the kit's (#1151).
  const tight = await orders.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty("--card-padding", ".75rem");
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const small = document.querySelector("[class~='card__card'][class~='card__sm']");
    const roomy = document.querySelector("[class~='card__card']:not([class~='card__sm'])");
    const read = (/** @type {Element | null} */ e) => (e ? { pad: parseFloat(getComputedStyle(e).paddingTop) / rem, gap: parseFloat(getComputedStyle(e).rowGap) / rem } : null);
    const content = small?.querySelector("[class*='card__content']");
    const out = { small: read(small), roomy: read(roomy), contentGap: content ? parseFloat(getComputedStyle(content).rowGap) / rem : null };
    root.removeProperty("--card-padding");
    return out;
  });
  check(
    "Card: under a theme with tight cards (--card-padding .75rem), a CardSize::Sm card's padding is two thirds of it and its content's gap half of it, less than a default card's",
    tight.small?.pad === 0.5 && tight.small.gap === 0.5 && tight.contentGap === 0.375 && tight.roomy?.pad === 0.75,
    JSON.stringify(tight),
  );
}
