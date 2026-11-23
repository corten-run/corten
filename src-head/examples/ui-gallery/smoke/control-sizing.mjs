import { base, engine, skip, check } from "./helpers.mjs";

export async function controlSizing(orders) {
  // Sizes are the theme's tokens: one value makes every control a 44 px touch target.
  const heights = await orders.evaluate(() => {
    // In rem, as the tokens are: the page's root font size is its own.
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const of = () => ["select", "button[class*='button__md']", "button[class*='button__sm']"].map((s) => (document.querySelector(s)?.getBoundingClientRect().height ?? 0) / rem);
    const before = of();
    document.documentElement.style.setProperty("--control-height", "2.75rem");
    const after = of();
    // A compact density sets it lower.
    document.documentElement.style.setProperty("--control-height", "1.75rem");
    const compact = of();
    document.documentElement.style.removeProperty("--control-height");
    return { before, after, compact };
  });
  check(
    "Sizes: --control-height sets the height of a select and a button of the default size, not a small one",
    heights.before[0] === 2.25 && heights.before[1] === 2.25 && heights.after[0] === 2.75 && heights.after[1] === 2.75 && heights.after[2] === heights.before[2],
    JSON.stringify(heights),
  );
  check("Sizes: a lower --control-height (a compact density) is a button's height too", heights.compact[0] === 1.75 && heights.compact[1] === 1.75, JSON.stringify(heights.compact));
  // A label wider than the room wraps and the button grows, so a 320 px page does not scroll
  // sideways (WCAG reflow); a one-line button, a <button> or an <a>, keeps the size's height.
  const wraps = await orders.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const md = /** @type {HTMLElement} */ (document.querySelector("button[class*='button__md']"));
    const box = document.createElement("div");
    // Set through the CSSOM, which the page's CSP allows where a style attribute is refused.
    Object.assign(box.style, { width: "240px", display: "flex", flexWrap: "wrap" });
    // As in the report: a form's button in a card's row.
    const form = document.createElement("form");
    const long = /** @type {HTMLElement} */ (md.cloneNode(false));
    long.textContent = "Reprice all inventory using saved curves";
    form.append(long);
    const link = document.createElement("a");
    link.className = md.className;
    link.href = "#";
    link.textContent = "Save";
    box.append(form, link);
    document.body.append(box);
    const [b, l, outer] = [long.getBoundingClientRect(), link.getBoundingClientRect(), box.getBoundingClientRect()];
    const one = parseFloat(getComputedStyle(md).minHeight) / rem;
    box.remove();
    return { width: Math.round(b.width), right: Math.round(b.right - outer.right), height: b.height / rem, link: l.height / rem, one };
  });
  check(
    "Button: a label wider than its box wraps and the button grows; one line keeps the size's height, <a> too",
    wraps.width <= 240 && wraps.right <= 0 && wraps.height > wraps.one && wraps.link === wraps.one,
    JSON.stringify(wraps),
  );
  // A row that shrinks to its content (a table's action cell) keeps each word whole: the label's
  // words go on lines of their own, never "Mark / shipp / ed".
  const words = await orders.evaluate(() => {
    const md = /** @type {HTMLElement} */ (document.querySelector("button[class*='button__md']"));
    const table = document.createElement("table");
    // As narrow as its content lets it be: each word on a line of its own.
    Object.assign(table.style, { width: "1px" });
    const cell = table.insertRow().insertCell();
    const button = /** @type {HTMLElement} */ (md.cloneNode(false));
    button.textContent = "Mark shipped";
    cell.append(button);
    document.body.append(table);
    // Each line's text, read from the label's character boxes.
    const text = /** @type {Text} */ (button.firstChild);
    const range = document.createRange();
    /** @type {[number, string][]} */
    const lines = [];
    for (let i = 0; i < text.length; i += 1) {
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const top = Math.round(range.getBoundingClientRect().top);
      const last = lines[lines.length - 1];
      if (last && Math.abs(last[0] - top) <= 2) last[1] += text.data[i];
      else lines.push([top, text.data[i]]);
    }
    table.remove();
    return lines.map(([, s]) => s.trim()).filter(Boolean);
  });
  check("Button: a row that shrinks to its content breaks a label between words, never inside one", JSON.stringify(words) === '["Mark","shipped"]', JSON.stringify(words));
  // A small button inside an InputGroup stays inside its border, at the 44 px touch-target size too.
  // On the gallery's home page, whose Lowest offer field is an InputGroup: a group of its classes
  // gets a Sm button (the page links button.css too).
  const groupPage = await orders.context().newPage();
  await groupPage.goto(`${base}/`);
  const grouped = await groupPage.getByLabel("Lowest offer (USD)").evaluate((floor) => {
    const sm = document.querySelector("button[class*='button__sm']");
    const kit = floor.parentElement;
    if (!sm || !kit) return { styled: false, found: { sm: !!sm, group: !!kit } };
    const group = document.createElement("span");
    group.className = kit.className;
    const button = /** @type {HTMLElement} */ (sm.cloneNode(false));
    button.textContent = "Go";
    group.append(document.createElement("input"), button);
    document.body.append(group);
    const root = document.documentElement.style;
    /** @param {string} size */
    const at = (size) => {
      for (const token of ["--control-height", "--control-height-sm"]) root.setProperty(token, size);
      const [g, b] = [group.getBoundingClientRect(), button.getBoundingClientRect()];
      return { group: g.height, top: b.top - g.top, bottom: g.bottom - b.bottom };
    };
    const shown = { styled: getComputedStyle(group).display === "inline-flex", normal: at("2.25rem"), touch: at("2.75rem") };
    for (const token of ["--control-height", "--control-height-sm"]) root.removeProperty(token);
    group.remove();
    return shown;
  });
  check(
    "InputGroup: a small button stays inside the group's border, at the touch-target size too",
    grouped.styled && !!grouped.normal && !!grouped.touch && [grouped.normal, grouped.touch].every((g) => g.top >= 1 && g.bottom >= 1),
    JSON.stringify(grouped),
  );
  await groupPage.close();
  // Under forced colors a box shadow is not painted, so a focused field shows its outline, which is
  // transparent otherwise.
  const forcedCheck = "Select and Textarea: a focused field's outline is transparent, and painted under forced colors";
  if (engine !== "webkit") {
    /** @param {string} label */
    const ring = async (label) => {
      const field = orders.getByLabel(label);
      await field.focus();
      await orders.keyboard.press("Shift");
      return field.evaluate((el) => {
        const s = getComputedStyle(el);
        return `${el.matches(":focus-visible")} ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`;
      });
    };
    const seen = [];
    let ok = true;
    for (const label of ["Ship from", "Note to buyers"]) {
      const plain = await ring(label);
      await orders.emulateMedia({ forcedColors: "active" });
      const forced = await ring(label);
      await orders.emulateMedia({ forcedColors: "none" });
      seen.push(plain, forced);
      ok &&= plain === "true solid 2px rgba(0, 0, 0, 0)" && forced.startsWith("true solid 2px ") && !forced.endsWith("rgba(0, 0, 0, 0)");
    }
    check(forcedCheck, ok, seen.join(" | "));
  } else skip(forcedCheck, "Playwright's WebKit does not emulate forced colors");
}
