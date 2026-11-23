import { base, check, besideText, spacedLikeButton } from "./helpers.mjs";

export async function tabs(page) {
  // TabGroup
  const tab = (name) => page.getByRole("tab", { name });
  await page.evaluate(() => (/** @type {any} */ (window).__tabs = document.querySelector("[data-scope=ui-tab-group]")));
  await tab("Offers").click();
  check("a click selects the tab and shows its panel", (await tab("Offers").getAttribute("aria-selected")) === "true" && (await page.getByRole("tabpanel").textContent()) === "Two offers, the best at $10.00.");
  check("the address follows the tab", page.url().endsWith("/?tab=offers"), page.url());
  check("a handler's history.replaceState is not a navigation", await page.evaluate(() => (/** @type {any} */ (window).__tabs === document.querySelector("[data-scope=ui-tab-group]"))));
  await page.keyboard.press("ArrowRight");
  check("Arrow Right moves and selects", (await page.evaluate(() => document.activeElement?.textContent)) === "Sales" && (await tab("Sales").getAttribute("aria-selected")) === "true");
  await page.keyboard.press("ArrowRight");
  check("the arrow keys wrap", (await tab("Listings").getAttribute("aria-selected")) === "true" && page.url() === `${base}/`);
  check("only the selected tab is in the tab order", (await page.$$eval('[role="tab"]', (t) => t.map((x) => /** @type {HTMLElement} */ (x).tabIndex).join())) === "0,-1,-1");
  await page.keyboard.press("End");
  check("End selects the last", (await tab("Sales").getAttribute("aria-selected")) === "true");
  const selected = async (/** @type {string} */ name) => (await tab(name).getAttribute("aria-selected")) === "true" && (await tab(name).evaluate((t) => t === document.activeElement));
  await page.keyboard.press("Home");
  check("Home selects the first", (await selected("Listings")) && page.url() === `${base}/`, page.url());
  await page.keyboard.press("ArrowLeft");
  check("Arrow Left from the first tab wraps to the last", await selected("Sales"));
  await page.keyboard.press("ArrowLeft");
  check("Arrow Left moves back and selects", (await selected("Offers")) && page.url().endsWith("/?tab=offers"), page.url());
  // Home from the last tab is where Arrow Right's wrap goes too, and End from the first where
  // Arrow Left's does: from the middle tab each differs from that arrow.
  await page.keyboard.press("Home");
  check("Home selects the first from the middle tab too", await selected("Listings"));
  await tab("Offers").click();
  // Leaves the last tab selected, where the checks after these start.
  await page.keyboard.press("End");
  check("End selects the last from the middle tab too", await selected("Sales"));
  // An Icon beside a tab's text, as beside a button's (#793).
  const tabIcon = await tab("Listings").evaluate(besideText);
  check("Tabs: an icon beside a tab's text is the kit's gap apart and on its middle", spacedLikeButton(tabIcon), JSON.stringify(tabIcon));

  // ChoiceGroup and ShownFor: one choice, parts in two cards.
  const period = (name) => page.getByRole("radio", { name });
  // The parts' sentences (the month's table of sales, a part too, is checked at a phone's width).
  const showing = () =>
    page.$$eval('[data-on^="connect:ui.choice.part"]', (parts) => parts.filter((p) => !(/** @type {HTMLElement} */ (p).hidden) && !p.querySelector("table")).map((p) => p.textContent).join("|"));
  check("the server draws the default choice and only its parts", (await period("Month").getAttribute("aria-checked")) === "true" && (await showing()) === "Average $11.95 this month.|Sold 14 this month.", await showing());
  check("only the chosen option is in the tab order", (await page.$$eval('[role="radio"]', (r) => r.map((x) => /** @type {HTMLElement} */ (x).tabIndex).join())) === "-1,0,-1");
  return { tab, period, showing };
}
