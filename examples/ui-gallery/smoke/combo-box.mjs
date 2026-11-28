import { base, engine, skip, check } from "./helpers.mjs";

export async function comboBox(page, qty) {
  // ComboBox
  const color = page.getByLabel("Condition");
  check("the label names the text input once the script runs", (await color.getAttribute("role")) === "combobox");
  check("the select is hidden", await page.locator("[data-scope=ui-combo-box] select").isHidden());
  await color.fill("light");
  const popup = page.locator("[data-scope=ui-combo-box] [popover]");
  check("typing opens the list", (await popup.evaluate((p) => p.matches(":popover-open"))) && (await color.getAttribute("aria-expanded")) === "true");
  const matched = await page.locator('[data-scope=ui-combo-box] [role="status"]').evaluate((p) => [p.hidden, getComputedStyle(p).display].join(" "));
  check("a part the component hides stays hidden under its design system's display (components.css)", matched === "true none", matched);
  const shown = await page.locator('[data-scope=ui-combo-box] [role="option"]:visible').allTextContents();
  check("the list filters by what was typed", shown.join() === "Lightly Played", shown.join());
  check("the first match is highlighted", (await color.getAttribute("aria-activedescendant")) !== null);
  await page.keyboard.press("Enter");
  check("Enter picks it", (await color.inputValue()) === "Lightly Played" && (await page.locator("[data-scope=ui-combo-box] select").inputValue()) === "lp");
  check("picking closes the list", (await color.getAttribute("aria-expanded")) === "false" && !(await popup.evaluate((p) => p.matches(":popover-open"))));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const active = await color.getAttribute("aria-activedescendant");
  check("Arrow Down opens at the value and moves", active !== null && (await page.locator(`#${active}`).textContent()) === "Moderately Played");
  const highlighted = async () => {
    const id = await color.getAttribute("aria-activedescendant");
    return id === null ? null : page.locator(`#${id}`).textContent();
  };
  await page.keyboard.press("ArrowUp");
  check("Arrow Up moves back", (await highlighted()) === "Lightly Played", String(await highlighted()));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  check("Arrow Up from the first option wraps to the last", (await highlighted()) === "Damaged", String(await highlighted()));
  await page.keyboard.press("ArrowDown");
  check("Arrow Down from the last option wraps to the first", (await highlighted()) === "Near Mint", String(await highlighted()));
  await page.keyboard.press("Escape");
  check("Escape closes and keeps the value", (await color.inputValue()) === "Lightly Played" && (await color.getAttribute("aria-expanded")) === "false");
  const visible = () => page.locator('[data-scope=ui-combo-box] [role="option"]:visible').allTextContents();
  await color.fill("mp");
  const graded = await visible();
  check("a choice's terms find it (a grade the label does not show)", graded.join() === "Moderately Played", graded.join());
  await color.fill("d");
  const ranked = await visible();
  check("matches are ranked: a label or term that starts with the text first", ranked.join() === "Damaged,Lightly Played,Moderately Played,Heavily Played", ranked.join());
  const best = await color.getAttribute("aria-activedescendant");
  check("the best match is highlighted", best !== null && (await page.locator(`#${best}`).textContent()) === "Damaged");
  const marked = await page.locator("[data-scope=ui-combo-box] [data-highlighted]").count();
  check("only it is highlighted after the list was reordered", marked === 1, String(marked));
  // Its highlight is a background, which forced colors does not paint, so it has an outline that
  // is transparent otherwise and painted then: which option Enter picks still shows.
  const optionCheck = "the highlighted option's outline is transparent, and painted under forced colors";
  if (engine !== "webkit") {
    const highlight = () =>
      page.locator("[data-scope=ui-combo-box] [data-highlighted]").evaluate((el) => {
        const s = getComputedStyle(el);
        return `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`;
      });
    const plainOutline = await highlight();
    await page.emulateMedia({ forcedColors: "active" });
    const forcedOutline = await highlight();
    await page.emulateMedia({ forcedColors: "none" });
    check(
      optionCheck,
      plainOutline === "solid 2px rgba(0, 0, 0, 0)" && forcedOutline.startsWith("solid 2px ") && !forcedOutline.endsWith("rgba(0, 0, 0, 0)"),
      `${plainOutline} | ${forcedOutline}`,
    );
  } else skip(optionCheck, "Playwright's WebKit does not emulate forced colors");
  await color.fill("");
  const all = await visible();
  check("an emptied query lists the options in their own order again", all.join() === "Near Mint,Lightly Played,Moderately Played,Heavily Played,Damaged", all.join());
  await page.keyboard.press("Escape");
  await color.fill("zzz");
  check("no match shows the status", await page.locator('[data-scope=ui-combo-box] [role="status"]').isVisible());
  await page.keyboard.press("Tab");
  check("leaving restores the value's text", (await color.inputValue()) === "Lightly Played");
  await color.click();
  await page.locator('[data-scope=ui-combo-box] [role="option"]', { hasText: "Heavily Played" }).click();
  check("a click picks", (await page.locator("[data-scope=ui-combo-box] select").inputValue()) === "hp" && (await color.inputValue()) === "Heavily Played");
  // Open, then measure: CSS anchor positioning puts the list under the input, at least as wide.
  // In the window's middle, so there is room under it (with none, the list goes above, as it should).
  await color.evaluate((input) => input.scrollIntoView({ block: "center" }));
  await color.press("ArrowDown");
  const listBox = await page.evaluate(() => {
    const input = document.querySelector('[data-scope=ui-combo-box] [role="combobox"]')?.getBoundingClientRect();
    const list = document.querySelector("[data-scope=ui-combo-box] [popover]")?.getBoundingClientRect();
    return input && list && { gap: list.top - input.bottom, left: list.left - input.left, wider: list.width >= input.width - 1 };
  });
  check("the popup is anchored under the input (CSS anchor positioning)", !!listBox && listBox.gap >= 0 && listBox.gap <= 8 && Math.abs(listBox.left) <= 1 && listBox.wider, JSON.stringify(listBox));
  await color.press("Escape");
  await color.fill("");
  await page.keyboard.press("Tab");
  check("emptying the field clears the value", (await page.locator("[data-scope=ui-combo-box] select").inputValue()) === "");
  await color.press("ArrowUp");
  check("Arrow Up on a closed field with no value opens at the last option", (await color.getAttribute("aria-expanded")) === "true" && (await highlighted()) === "Damaged", String(await highlighted()));
  await color.press("Escape");
  await page.getByRole("button", { name: "List for sale" }).click();
  const message = await color.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage);
  check("a required, empty combobox stops the form on the input", message !== "", message);
  await color.fill("near mint");
  await page.keyboard.press("Tab");
  check("typing a label exactly picks it", (await page.locator("[data-scope=ui-combo-box] select").inputValue()) === "nm");
  // A combobox with no options (a list the app has nothing in yet): Arrow Down opens it on none,
  // and Enter closes it without an error.
  {
    const bare = await page.context().newPage();
    try {
      /** @type {string[]} */
      const bareErrors = [];
      bare.on("pageerror", (e) => bareErrors.push(e.message));
      await bare.route(
        (url) => url.href === `${base}/`,
        async (route) => {
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          let body = await res.text();
          // Every option but the select's empty first one.
          const select = body.indexOf("<select", body.indexOf("ui-combo-box"));
          const first = body.indexOf("</option>", select) + "</option>".length;
          body = body.slice(0, first) + body.slice(body.indexOf("</select>", first));
          await route.fulfill({ status: res.status(), headers, body });
        },
      );
      await bare.goto(`${base}/`);
      const none = bare.getByLabel("Condition");
      await bare.waitForFunction(() => document.querySelector('[data-scope=ui-combo-box] [role="combobox"]:not([hidden])') !== null);
      const options = await bare.locator('[data-scope=ui-combo-box] [role="option"]').count();
      await none.focus();
      await bare.keyboard.press("ArrowDown");
      const opened = await none.getAttribute("aria-expanded");
      await bare.keyboard.press("Enter");
      const closed = await none.getAttribute("aria-expanded");
      check(
        "with no options, Arrow Down opens the list and Enter closes it, without an error",
        options === 0 && opened === "true" && closed === "false" && bareErrors.length === 0,
        JSON.stringify({ options, opened, closed, bareErrors }),
      );
    } finally {
      await bare.close();
    }
  }

  await qty.fill("3");
  await page.getByRole("button", { name: "List for sale" }).click();
  await page.waitForFunction(() => document.querySelector("#result")?.textContent?.startsWith("Listed"));
  check("the form sends the components' values", (await page.textContent("#result")) === "Listed 3 Near Mint Ashen Drake at $12.50 each, 0.7 oz to ship.", await page.textContent("#result"));
}
