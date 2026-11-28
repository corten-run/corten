import { base, check, tabType, chosenUnderPointer, tabTypeIsTheThemes, choiceTargets, choiceTargetsFit } from "./helpers.mjs";

export async function choiceGroup(page, period, showing, tab) {
  // The kit's looks for corten-ui's ChoiceGroup, NumberField and CheckboxGroup (#610): a segmented
  // choice with the chosen one raised, the number field's parts at the controls' height in a row,
  // and the group's fieldset without the browser's border.
  const kitLooks = await page.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const style = (/** @type {string} */ sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    const radiogroup = document.querySelector('[role="radiogroup"]');
    // Its box's parent: the Segmented around it takes none (display: contents).
    let parent = radiogroup?.parentElement;
    while (parent && getComputedStyle(parent).display === "contents") parent = parent.parentElement;
    const fits = radiogroup && parent ? radiogroup.getBoundingClientRect().width < parent.getBoundingClientRect().width : false;
    const [group, chosen, other] = [style('[role="radiogroup"]'), style('[role="radio"][aria-checked="true"]'), style('[role="radio"][aria-checked="false"]')];
    // The drawn boxes, so a border outside a content-box height counts, with the gallery's own
    // border-box reset undone for the measure: the kit's rule has to box them by itself.
    const reset = new CSSStyleSheet();
    reset.replaceSync("*, *::before, *::after { box-sizing: content-box }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, reset];
    const rect = (/** @type {string} */ s) => document.querySelector(s)?.getBoundingClientRect();
    const [input, button] = [rect("[class*='stepper__stepper'] input"), rect("[class*='stepper__stepper'] button")];
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== reset);
    const fieldset = style("[class*='checkboxes__checkboxes'] > fieldset");
    return {
      group: group && `${fits} ${group.backgroundColor !== "rgba(0, 0, 0, 0)"}`,
      chosen: chosen?.backgroundColor,
      other: other?.backgroundColor,
      stepper: input && button && [input.height, button.height, button.width].map((h) => Math.round((h / rem) * 100) / 100).join(" "),
      fieldset: fieldset && `${fieldset.display} ${fieldset.borderTopStyle}`,
    };
  });
  check(
    "Segmented, Stepper and Checkboxes: corten-ui's ChoiceGroup, NumberField and CheckboxGroup drawn by the kit",
    kitLooks.group === "true true" && kitLooks.chosen !== kitLooks.other && kitLooks.other === "rgba(0, 0, 0, 0)" && kitLooks.stepper === "2.25 2.25 2.25" && kitLooks.fieldset === "grid none",
    JSON.stringify(kitLooks),
  );
  // Checkboxes and RadioGroup space their choices and their legend from two theme tokens
  // (choice-list-gap, choice-list-legend-gap; .25rem and .75rem), so a theme that sets them moves both groups.
  const choiceSpacing = await page.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const measure = () =>
      ["[class*='checkboxes__checkboxes'] > fieldset", "fieldset[class*='radio-group__group']"].map((sel) => {
        const set = /** @type {HTMLElement} */ (document.querySelector(sel));
        const legend = /** @type {HTMLElement} */ (set.querySelector(":scope > legend"));
        return [getComputedStyle(set).rowGap, getComputedStyle(legend).marginBottom].map((v) => parseFloat(v) / rem).join(" ");
      });
    const kit = measure();
    const theme = new CSSStyleSheet();
    theme.replaceSync(":root { --choice-list-gap: .5rem; --choice-list-legend-gap: .25rem; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, theme];
    const themed = measure();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== theme);
    return { kit, themed };
  });
  check(
    "Checkboxes and RadioGroup: the gap between choices and under the legend are the theme's choice-list-gap and choice-list-legend-gap",
    choiceSpacing.kit.every((s) => s === "0.25 0.75") && choiceSpacing.themed.every((s) => s === "0.5 0.25"),
    JSON.stringify(choiceSpacing),
  );
  const boxTargets = await page.evaluate(choiceTargets, "label[class*='checkbox__checkbox'], label[class*='radio-group__radio']");
  check(
    "Checkbox and Radio: the label, the whole target, is --control-height on one line (the kit's, a 44 px theme's, a dense theme's one line), its box on the first line's middle when it wraps, and an app's own min-height on it adds nothing",
    boxTargets.kit.length === 5 && choiceTargetsFit(boxTargets),
    JSON.stringify(boxTargets),
  );
  const tabsType = await page.evaluate(tabType, [
    ["[class*='tabs__tabs'] [role=\"tab\"][aria-selected=\"true\"]", "[class*='tabs__tabs'] [role=\"tab\"][aria-selected=\"false\"]"],
    ["[class*='segmented__segmented'] [role=\"radio\"][aria-checked=\"true\"]", "[class*='segmented__segmented'] [role=\"radio\"][aria-checked=\"false\"]"],
  ]);
  check("Tabs and Segmented: each choice's weight and the chosen one's color are the theme's tab-font-weight and tab-selected-color", tabTypeIsTheThemes(tabsType), JSON.stringify(tabsType));
  // The selected tab and the checked Segmented choice keep it under the pointer too: their chosen
  // rules come after their hover rules at the same weight.
  const hoveredTabs = await chosenUnderPointer(page, [
    "[class*='tabs__tabs'] [role=\"tab\"][aria-selected=\"true\"]",
    "[class*='segmented__segmented'] [role=\"radio\"][aria-checked=\"true\"]",
  ]);
  check(
    "Tabs and Segmented: the chosen choice keeps the theme's chosen color under the pointer",
    hoveredTabs.length === 2 && hoveredTabs.every((c) => c.hovered && c.color === c.primary),
    JSON.stringify(hoveredTabs),
  );
  await period("Week").click();
  check("a click chooses in place, and every part of the group follows", (await period("Week").getAttribute("aria-checked")) === "true" && (await showing()) === "Average $12.10 this week.|Sold 3 this week.", await showing());
  check("the address follows the choice", new URL(page.url()).searchParams.get("period") === "week", page.url());
  await page.keyboard.press("ArrowRight");
  check("Arrow Right moves and chooses", (await page.evaluate(() => document.activeElement?.textContent)) === "Month" && (await showing()) === "Average $11.95 this month.|Sold 14 this month." && !new URL(page.url()).searchParams.has("period"), page.url());
  await page.keyboard.press("ArrowUp");
  check("Arrow Up moves back", (await period("Week").getAttribute("aria-checked")) === "true");
  // Every other key the group takes. With three options a step the wrong way lands on another
  // option, and Home and End are each pressed from both other options, so no one arrow passes both.
  const chosen = async (/** @type {string} */ name) => (await period(name).getAttribute("aria-checked")) === "true" && (await period(name).evaluate((r) => r === document.activeElement));
  await page.keyboard.press("ArrowDown");
  check("Arrow Down moves on, as Arrow Right does", await chosen("Month"));
  await page.keyboard.press("End");
  check("End chooses the last option, and every part follows", (await chosen("Year")) && (await showing()) === "Average $11.40 this year.|Sold 96 this year." && new URL(page.url()).searchParams.get("period") === "year", `${await showing()} ${page.url()}`);
  await page.keyboard.press("ArrowDown");
  check("a step on from the last option wraps to the first", await chosen("Week"));
  await page.keyboard.press("ArrowLeft");
  check("and a step back from the first wraps to the last", await chosen("Year"));
  await page.keyboard.press("ArrowLeft");
  check("Arrow Left moves back, as Arrow Up does", await chosen("Month"));
  await page.keyboard.press("Home");
  check("Home chooses the first", await chosen("Week"));
  await page.keyboard.press("End");
  check("End chooses the last from the first too", await chosen("Year"));
  await page.keyboard.press("Home");
  check("and Home the first from the last", await chosen("Week"));
  await period("Month").focus();
  await page.keyboard.press("Space");
  check("Space chooses the focused option, and every part follows", (await chosen("Month")) && (await showing()) === "Average $11.95 this month.|Sold 14 this month.", await showing());
  await page.goto(`${base}/?tab=sales`);
  await period("Week").click();
  check("choosing keeps another control's key in the address", new URL(page.url()).search === "?tab=sales&period=week", page.url());
  await tab("Offers").click();
  check("and a tab keeps the choice", new URL(page.url()).search === "?tab=offers&period=week", page.url());
  await page.goto(`${base}/?period=week`);
  check("the address draws the choice on a load", (await period("Week").getAttribute("aria-checked")) === "true" && (await showing()) === "Average $12.10 this week.|Sold 3 this week.", await showing());
  await page.goto(`${base}/`);
}
