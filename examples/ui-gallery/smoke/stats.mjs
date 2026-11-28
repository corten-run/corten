import { check } from "./helpers.mjs";

export async function stats(orders) {
  // Stats: a term and its descriptions, as many to a row as fit and two on a phone.
  const stats = await orders.evaluate(() => {
    const dl = document.querySelector("dl[class*='stats__stats']");
    const items = [...(dl?.children ?? [])];
    return {
      terms: items.map((i) => i.querySelector("dt")?.textContent).join(),
      rows: new Set(items.map((i) => Math.round(i.getBoundingClientRect().top))).size,
    };
  });
  check("Stats: labelled figures on one row", stats.terms === "Sales,Orders,To ship,Late" && stats.rows === 1, JSON.stringify(stats));
  // The figure's type is the theme's: the kit's values by default, the value in the page's face
  // and the label as written; a theme's tokens, its face and its case change them in one place.
  const statType = await orders.evaluate(() => {
    const dl = /** @type {HTMLElement} */ (document.querySelector("dl[class*='stats__stats']"));
    const read = () => {
      const label = getComputedStyle(/** @type {Element} */ (dl.querySelector("dt")));
      const value = getComputedStyle(/** @type {Element} */ (dl.querySelector("[class*='stats__value']")));
      const tracking = (/** @type {CSSStyleDeclaration} */ s) => Math.round(((parseFloat(s.letterSpacing) || 0) / parseFloat(s.fontSize)) * 1000) / 1000;
      return {
        label: [label.fontSize, label.fontWeight, label.textTransform, tracking(label)].join(" "),
        value: [value.fontSize, value.fontWeight, tracking(value)].join(" "),
        face: value.fontFamily,
      };
    };
    const kit = read();
    const page = getComputedStyle(dl).fontFamily;
    const themed = { "--stat-label-font-size": ".75rem", "--stat-label-font-weight": "600", "--stat-label-tracking": ".05", "--stat-label-text-transform": "uppercase",
      "--stat-value-font-size": "2rem", "--stat-value-font-weight": "700", "--stat-value-tracking": "0", "--stat-value-font-family": "Georgia, serif" };
    for (const [name, value] of Object.entries(themed)) dl.style.setProperty(name, value);
    const theme = read();
    for (const name of Object.keys(themed)) dl.style.removeProperty(name);
    // Compare against literal rem sizes resolved by the same engine: Firefox can round a
    // computed font size to a layout unit before returning it in pixels.
    const probe = document.createElement("span");
    document.body.append(probe);
    const sizes = [".875rem", "1.5rem", ".75rem", "2rem"].map((size) => {
      probe.style.fontSize = size;
      return getComputedStyle(probe).fontSize;
    });
    probe.remove();
    return { kit, page, theme, sizes };
  });
  const [kitLabel, kitValue, themeLabel, themeValue] = statType.sizes;
  check(
    "Stats: the figure's type is the theme's, the value in the page's face until a theme names one",
    statType.kit.label === `${kitLabel} 500 none 0` && statType.kit.value === `${kitValue} 600 -0.01` && statType.kit.face === statType.page &&
      statType.theme.label === `${themeLabel} 600 uppercase 0.05` && statType.theme.value === `${themeValue} 700 0` && /Georgia/.test(statType.theme.face),
    JSON.stringify(statType),
  );
  // Two to a row on a small phone and a large one, the figure in the phone's size (1.25rem).
  for (const width of [390, 430]) {
    await orders.setViewportSize({ width, height: 844 });
    // Measured once the page has the new width and two frames have passed, so nothing pending
    // moves a card while it is read. One WebKit run read the first card 42px above the second
    // (#939), which no settled layout gives; the cause is not known, so the failure says more.
    await orders.waitForFunction((w) => innerWidth === w, width, { timeout: 5000 }).catch(() => {});
    const phone = await orders.evaluate(async () => {
      // Two frames, or a few hundred ms if frames stall, so a hung page fails this check, not the run.
      await Promise.race([new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame))), new Promise((late) => setTimeout(late, 300))]);
      // The page's first list, the figures as cards; the one inside a card follows.
      const items = [...(document.querySelector("dl[class*='stats__stats']")?.children ?? [])];
      const value = items[0]?.querySelector("[class*='stats__value']");
      const boxes = items.map((i) => i.getBoundingClientRect());
      const rem = (/** @type {Element | null | undefined} */ e) =>
        e ? parseFloat(getComputedStyle(e).fontSize) / parseFloat(getComputedStyle(document.documentElement).fontSize) : 0;
      // A theme's phone size is its own token.
      const list = /** @type {HTMLElement | null} */ (value?.closest("dl") ?? null);
      list?.style.setProperty("--stat-value-font-size-narrow", "1.5rem");
      const themed = rem(value);
      list?.style.removeProperty("--stat-value-font-size-narrow");
      return {
        tops: boxes.map((r) => Math.round(r.top)),
        size: rem(value),
        themed,
        // For a failure: what the page was laid out at, and where each card was.
        at: { width: innerWidth, scrollY: Math.round(scrollY) },
        boxes: boxes.map((r) => [r.left, r.top, r.width, r.height].map(Math.round)),
      };
    });
    const [a, b, c, d] = phone.tops;
    check(`Stats: two to a row on a phone, in the phone's size (${width}px)`, phone.at.width === width && new Set(phone.tops).size === 2 && a === b && c === d && phone.size === 1.25 && phone.themed === 1.5, JSON.stringify(phone));
  }
  await orders.setViewportSize({ width: 390, height: 844 });
  await orders.waitForFunction(() => innerWidth === 390, null, { timeout: 5000 }).catch(() => {});
  // A long figure is never broken: on one line, inside its card, and the card inside the page.
  const long = await orders.evaluate(() => {
    const value = /** @type {HTMLElement} */ (document.querySelector("dl[class*='stats__stats'] [class*='stats__value']"));
    const was = value.textContent;
    value.textContent = "$1,234,567.89";
    const card = /** @type {HTMLElement} */ (value.parentElement);
    const line = parseFloat(getComputedStyle(value).lineHeight);
    const drawn = {
      lines: Math.round(value.getBoundingClientRect().height / line),
      inside: value.scrollWidth <= value.clientWidth + 1 && card.getBoundingClientRect().right <= document.documentElement.clientWidth,
    };
    value.textContent = was;
    return drawn;
  });
  check("Stats: a long figure stays on one line, inside its card, on a phone", long.lines === 1 && long.inside, JSON.stringify(long));
  await orders.setViewportSize({ width: 1280, height: 800 });
  // Once the layout has settled at the new width (an engine may read the old positions just after).
  await orders
    .waitForFunction(() => {
      const term = document.querySelector("dl[class*='stats__plain'] dt");
      const content = term?.closest("dl")?.parentElement;
      if (!term || !content) return true;
      return Math.abs(term.getBoundingClientRect().left - (content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft))) < 1;
    }, null, { timeout: 3000 })
    .catch(() => {});
  // StatsSurface::Plain: a summary inside a card is drawn on the card, its figures' text at the card's
  // content edge, with no surface of their own.
  const plainStats = await orders.evaluate(() => {
    const dl = document.querySelector("dl[class*='stats__plain']");
    const figure = /** @type {HTMLElement | null} */ (dl?.querySelector("[class*='stats__stat']") ?? null);
    const content = /** @type {HTMLElement | null} */ (dl?.parentElement ?? null);
    if (!figure || !content) return null;
    const style = getComputedStyle(figure);
    const term = /** @type {HTMLElement} */ (figure.querySelector("dt"));
    const inset = parseFloat(getComputedStyle(content).paddingLeft);
    return {
      terms: [...dl.querySelectorAll("dt")].map((t) => t.textContent).join(),
      surface: style.backgroundColor === "rgba(0, 0, 0, 0)" && style.borderTopWidth === "0px" && style.boxShadow === "none",
      edge: Math.abs(term.getBoundingClientRect().left - (content.getBoundingClientRect().left + inset)) < 1,
    };
  });
  check("Stats with no surface: figures inside a card have no surface and line up with its text", plainStats?.terms === "Open,Refunded" && plainStats.surface && plainStats.edge, JSON.stringify(plainStats));
}
