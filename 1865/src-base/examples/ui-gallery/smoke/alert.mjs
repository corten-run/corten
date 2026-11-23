import { check } from "./helpers.mjs";

export async function alert(orders) {
  // Alert's role follows its variant: a warning is an alert, read at once.
  const alertRole = await orders.locator("strong", { hasText: "past its ship-by date" }).evaluate((s) => s.parentElement?.getAttribute("role"));
  check("Alert: a warning is role=alert", alertRole === "alert", String(alertRole));
  // A list in an alert is spaced and colored as its paragraph is: no margin of its own (the alert's
  // grid gap apart), indented 1.25rem, and a list in one of its items as much again. In the outline
  // alert the paragraph's color is not the alert's own (the tone), so a list that took the alert's
  // color instead of the paragraph's shows.
  const list = (/** @type {import("@playwright/test").Locator} */ alert) =>
    alert.evaluate((alert) => {
      const [p, ul] = [alert.querySelector(":scope > p"), alert.querySelector(":scope > ul")];
      const inner = alert.querySelector(":scope > ul li > ul");
      if (!p || !ul) return null;
      const [ps, us, as] = [getComputedStyle(p), getComputedStyle(ul), getComputedStyle(alert)];
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return {
        margin: us.marginTop + " " + us.marginBottom,
        gap: ul.getBoundingClientRect().top - p.getBoundingClientRect().bottom,
        rowGap: parseFloat(as.rowGap),
        indent: parseFloat(us.paddingInlineStart) / rem,
        inner: inner ? parseFloat(getComputedStyle(inner).paddingInlineStart) / rem : null,
        asParagraph: us.color === ps.color,
        notAlert: us.color !== as.color,
      };
    });
  const spaced = (/** @type {any} */ l) => !!l && l.margin === "0px 0px" && Math.abs(l.gap - l.rowGap) < 1 && Math.abs(l.indent - 1.25) < 0.01 && l.asParagraph;
  const soft = await list(orders.locator("strong", { hasText: "past its ship-by date" }).locator(".."));
  check("Alert: a list has no margin of its own, sits the grid's gap under the paragraph, is indented 1.25rem and colored as the paragraph", spaced(soft), JSON.stringify(soft));
  const outline = await list(orders.locator("p", { hasText: "Orders paid before 3 pm" }).locator(".."));
  check(
    "Alert: in an outline alert a list is the paragraph's color, not the alert's, and a list in an item is indented 1.25rem again",
    spaced(outline) && !!outline && outline.notAlert && outline.inner !== null && Math.abs(outline.inner - 1.25) < 0.01,
    JSON.stringify(outline),
  );
  // The tones the kit's looks take, as each engine computes them: a soft alert is its tone mixed
  // 12% into the card, an outline one the card's, a solid one its tone's fill and text, and a
  // toned button is filled with its tone.
  const tones = await orders.locator("strong", { hasText: "past its ship-by date" }).evaluate((s) => {
    const soft = /** @type {Element} */ (s.parentElement);
    const style = getComputedStyle(soft);
    const hex = (/** @type {string} */ name) => {
      const value = style.getPropertyValue(name).trim();
      return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    };
    // `rgb(246, 234, 225)`, or `color(srgb 0.96 0.92 0.88)` for a color-mix.
    const rgb = (/** @type {Element} */ el) => {
      const text = getComputedStyle(el).backgroundColor;
      const n = (text.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return text.startsWith("color(") ? n.map((c) => c * 255) : n;
    };
    const near = (/** @type {number[]} */ got, /** @type {number[]} */ want) =>
      got.length === 3 && got.every((g, i) => Math.abs(g - want[i]) <= 1.5);
    const [warning, card] = [hex("--warning"), hex("--card")];
    const outline = /** @type {Element} */ (
      [...document.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Orders paid before"))?.parentElement
    );
    const button = (/** @type {string} */ name) =>
      /** @type {Element} */ ([...soft.querySelectorAll("button")].find((b) => b.textContent?.trim() === name));
    const solid = /** @type {Element} */ (
      [...document.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Every return this month"))?.parentElement
    );
    const text = getComputedStyle(solid).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    return {
      soft: near(rgb(soft), warning.map((t, i) => t * 0.12 + card[i] * 0.88)),
      outline: near(rgb(outline), card),
      solid: near(rgb(solid), hex("--success")) && near(text, hex("--success-foreground")),
      buttons: [
        ["Mark shipped", "--success"],
        ["Buy postage (test mode)", "--warning"],
        ["Message the buyer", "--info"],
      ].map(([name, token]) => near(rgb(button(name)), hex(token))),
    };
  });
  check(
    "Alert and Button tones: a soft warning is its tone mixed 12% into the card, an outline alert the card's, a solid one its tone's fill and text, a toned button its tone",
    tones.soft && tones.outline && tones.solid && tones.buttons.every(Boolean),
    JSON.stringify(tones),
  );
}
