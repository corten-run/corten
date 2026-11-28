import { engine, skip, check, besideText, spacedLikeButton, tabType, chosenUnderPointer, tabTypeIsTheThemes } from "./helpers.mjs";

export async function segmentedLinks(orders) {
  // SegmentedLinks: the order of the orders as navigation, the current link raised on the track.
  const links = await orders.evaluate(() => {
    const nav = document.querySelector("nav[class*='segmented__links']");
    const a = [...(nav?.querySelectorAll("a") ?? [])];
    return {
      current: a.filter((x) => x.getAttribute("aria-current") === "page").map((x) => x.textContent).join(),
      fills: a.map((x) => getComputedStyle(x).backgroundColor),
      track: nav ? getComputedStyle(nav).backgroundColor : "missing",
      // As wide as its links, also as a grid item, where inline-flex computes to flex.
      fits: nav && nav.parentElement ? nav.getBoundingClientRect().width < nav.parentElement.getBoundingClientRect().width - 1 : false,
    };
  });
  const clear = "rgba(0, 0, 0, 0)";
  check(
    "SegmentedLinks: the current link is raised on the track, the others are not",
    links.current === "Newest" && links.fits && links.fills[0] !== clear && links.fills[0] !== links.track && links.fills.slice(1).every((c) => c === clear),
    JSON.stringify(links),
  );
  const linksType = await orders.evaluate(tabType, [
    ["nav[class*='segmented__links'] > a[aria-current='page']", "nav[class*='segmented__links'] > a:not([aria-current])"],
    ["[class*='segmented__track'] > label:has(> input:checked)", "[class*='segmented__track'] > label:not(:has(> input:checked))"],
  ]);
  check("SegmentedLinks and SegmentedRadios: each choice's weight and the chosen one's color are the theme's", tabTypeIsTheThemes(linksType), JSON.stringify(linksType));
  // Under the pointer the checked SegmentedRadio and the current SegmentedLinks link keep the
  // theme's chosen color: the radio's hover rule, which weighs more than its checked one, leaves a
  // checked choice alone, and the link's chosen rule comes after its hover rule.
  const hoveredChoices = await chosenUnderPointer(orders, ["[class*='segmented__track'] > label:has(> input:checked)", "nav[class*='segmented__links'] > a[aria-current='page']"]);
  check(
    "SegmentedRadios and SegmentedLinks: the chosen choice keeps the theme's chosen color under the pointer",
    hoveredChoices.length === 2 && hoveredChoices.every((c) => c.hovered && c.color === c.primary),
    JSON.stringify(hoveredChoices),
  );
}

export async function segmentedRadios(orders) {
  // SegmentedRadios: native radios in a fieldset, the checked one's label raised from :has(:checked),
  // the arrow keys moving the choice and the focus ring with it, a disabled fieldset drawn disabled,
  // and under forced colors the checked one outlined. The form sends the choice (below).
  {
    const sizes = orders.getByRole("group", { name: "Label size" });
    const raised = () =>
      sizes.locator("label").evaluateAll((all) =>
        all.map((l) => `${l.textContent}:${getComputedStyle(l).backgroundColor !== "rgba(0, 0, 0, 0)"}`).join(),
      );
    const before = await raised();
    // An Icon after a choice's input, beside its label, as beside a button's text (#793).
    const radioIcon = await sizes.locator("label", { hasText: "Letter" }).evaluate(besideText);
    check("SegmentedRadios: an icon beside a choice's label is the kit's gap apart and on its middle", spacedLikeButton(radioIcon), JSON.stringify(radioIcon));
    // SegmentedWidth::Fill: the track is the fieldset's width and its choices equal parts of it,
    // also on a phone, where nothing reaches past the track (#1060).
    const filled = async () =>
      sizes.evaluate((fieldset) => {
        const track = /** @type {HTMLElement} */ (fieldset.querySelector("[class*='segmented__track']"));
        const parts = [...track.querySelectorAll("label")].map((l) => l.getBoundingClientRect());
        const box = track.getBoundingClientRect();
        return {
          track: Math.round(box.width),
          fieldset: Math.round(fieldset.getBoundingClientRect().width),
          parts: parts.map((p) => Math.round(p.width)),
          inside: parts.every((p) => p.left >= box.left - 0.5 && p.right <= box.right + 0.5),
        };
      });
    const wide = await filled();
    const phoneSize = orders.viewportSize();
    await orders.setViewportSize({ width: 320, height: 640 });
    const narrow = await filled();
    // A word wider than its part breaks inside it: the label's text stays in its choice and nothing
    // reaches past the track (the word is put in for the measure and taken out after).
    const long = await sizes.evaluate((fieldset) => {
      const text = /** @type {HTMLElement} */ (fieldset.querySelector("label:last-of-type > span"));
      const was = text.textContent;
      text.textContent = "InternationalizationPreferences";
      const [choice, words] = [/** @type {HTMLElement} */ (text.parentElement).getBoundingClientRect(), text.getBoundingClientRect()];
      const track = /** @type {HTMLElement} */ (fieldset.querySelector("[class*='segmented__track']"));
      const at = { inside: words.left >= choice.left - 0.5 && words.right <= choice.right + 0.5, sideways: track.scrollWidth > track.clientWidth + 1 };
      text.textContent = was;
      return at;
    });
    if (phoneSize) await orders.setViewportSize(phoneSize);
    const even = (/** @type {{ track: number, fieldset: number, parts: number[], inside: boolean }} */ f) =>
      Math.abs(f.track - f.fieldset) <= 1 && f.parts.every((w) => Math.abs(w - f.parts[0]) <= 1) && f.inside;
    check("SegmentedRadios: a filled control is its fieldset's width, its choices equal parts, on a phone too", even(wide) && even(narrow) && narrow.track < wide.track, JSON.stringify({ wide, narrow }));
    check("SegmentedRadios: a filled choice's long word breaks inside it, and nothing reaches past the track", long.inside && !long.sideways, JSON.stringify(long));
    await sizes.getByRole("radio", { name: "4 x 6 in" }).focus();
    await orders.keyboard.press("ArrowRight");
    const after = await raised();
    // The ring follows the browser's :focus-visible, which WebKit gives a radio the arrow keys reach
    // only once focus comes back by Tab: leave the group and come back to the checked one.
    await orders.keyboard.press("Tab");
    await orders.keyboard.press("Shift+Tab");
    const ring = await sizes.locator("label", { hasText: "Letter" }).evaluate((l) => `${getComputedStyle(l).outlineStyle} ${getComputedStyle(l).outlineWidth}`);
    check(
      "SegmentedRadios: the checked radio's label is raised, an arrow key moves the choice, and the focused one is ringed",
      before === "4 x 6 in:true,Letter:false" && after === "4 x 6 in:false,Letter:true" && (await sizes.getByRole("radio", { name: "Letter" }).isChecked()) && ring === "solid 2px",
      JSON.stringify({ before, after, ring }),
    );
    const disabled = await sizes.evaluate((f) => {
      const set = /** @type {HTMLFieldSetElement} */ (f);
      set.disabled = true;
      const drawn = [...set.querySelectorAll("label")].map((l) => getComputedStyle(l).opacity).join();
      set.disabled = false;
      return drawn;
    });
    check("SegmentedRadios: a disabled fieldset draws its choices disabled", disabled === "0.5,0.5", disabled);
    // Each input is hidden under its label and fills it, so a click anywhere on the label lands on
    // the input; one disabled input draws only its own choice disabled.
    const cover = await sizes.locator("label").evaluateAll((all) =>
      all.map((l) => {
        const input = /** @type {HTMLInputElement} */ (l.querySelector("input"));
        const [a, b] = [l.getBoundingClientRect(), input.getBoundingClientRect()];
        const edge = document.elementFromPoint(a.left + 2, a.top + a.height / 2);
        return getComputedStyle(input).opacity === "0" && a.width === b.width && a.height === b.height && edge === input;
      }),
    );
    const one = await sizes.evaluate((f) => {
      const input = /** @type {HTMLInputElement} */ (f.querySelector("input[value='letter']"));
      input.disabled = true;
      const drawn = [...f.querySelectorAll("label")].map((l) => getComputedStyle(l).opacity).join();
      input.disabled = false;
      return drawn;
    });
    check("SegmentedRadios: each input is hidden under its label and fills it; one disabled input dims only its choice", cover.every(Boolean) && one === "1,0.5", JSON.stringify({ cover, one }));
    // A hidden legend (Legend::Hidden) still names the group and takes no room over the track.
    const hiddenClass = await sizes.evaluate((f) => [...f.classList].find((c) => c.endsWith("__radios"))?.replace("__radios", "__hidden") ?? "");
    const legendShown = await sizes.evaluate((f) => /** @type {HTMLElement} */ (f.querySelector("div")).getBoundingClientRect().top - f.getBoundingClientRect().top);
    await sizes.evaluate((f, c) => f.querySelector("legend")?.classList.add(c), hiddenClass);
    const legendHidden = await sizes.evaluate((f) => /** @type {HTMLElement} */ (f.querySelector("div")).getBoundingClientRect().top - f.getBoundingClientRect().top);
    const stillNamed = await orders.getByRole("group", { name: "Label size" }).count();
    await sizes.evaluate((f, c) => f.querySelector("legend")?.classList.remove(c), hiddenClass);
    check("SegmentedRadios: a hidden legend still names the group and takes no room", legendShown > 10 && legendHidden < 1 && stillNamed === 1, JSON.stringify({ legendShown, legendHidden, stillNamed }));
    const forcedRadios = "SegmentedRadios: under forced colors the checked choice is outlined";
    if (engine !== "webkit") {
      await orders.locator("h1").click();
      await orders.emulateMedia({ forcedColors: "active" });
      const outlines = await sizes.locator("label").evaluateAll((all) => all.map((l) => getComputedStyle(l).outlineStyle).join());
      await orders.emulateMedia({ forcedColors: "none" });
      check(forcedRadios, outlines === "none,solid", outlines);
    } else skip(forcedRadios, "Playwright's WebKit does not emulate forced colors");
  }
}
