import { base, check } from "./helpers.mjs";

export async function formReset(us, page, qty, qtyButtons, shipsValid, browser) {
  // A reset puts the boxes back as drawn ("United States" checked), and the group is checked again.
  // Only the group's boxes: the reset also empties the condition, which is drawn with no choice.
  await us.uncheck();
  await page.getByRole("checkbox", { name: "Canada" }).uncheck();
  const unchecked = await us.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage);
  // The reset also puts the quantity back to its minimum and empties the condition, sending no
  // `input`: the number field's decrease is disabled again and no option is marked as the value.
  const resetWidgets = async () => ({
    qty: await qty.inputValue(),
    fewer: await qtyButtons.nth(0).isDisabled(),
    condition: await page.locator("[data-scope=ui-combo-box] select").inputValue(),
    marked: await page.locator('[data-scope=ui-combo-box] [role="option"][aria-selected="true"]').allTextContents(),
  });
  const beforeReset = await resetWidgets();
  await page.evaluate(() => /** @type {HTMLFormElement} */ (document.querySelector('form[method=post][action="/"]')).reset());
  await page.waitForTimeout(100);
  check("a form reset checks the group again", unchecked === "Choose where you ship." && (await us.isChecked()) && (await us.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage)) === "" && (await shipsValid()), unchecked);
  const afterReset = await resetWidgets();
  check(
    "NumberField: a form reset that puts the minimum back disables decrease again",
    beforeReset.qty === "2" && !beforeReset.fewer && afterReset.qty === "1" && afterReset.fewer,
    JSON.stringify({ beforeReset, afterReset }),
  );
  check(
    "ComboBox: a form reset that empties the select leaves no option marked as the value",
    beforeReset.condition === "nm" && beforeReset.marked.join() === "Near Mint" && afterReset.condition === "" && afterReset.marked.length === 0,
    JSON.stringify({ beforeReset, afterReset }),
  );
  {
    const shadow = await browser.newPage();
    try {
      // Put the controls in the server-drawn form before its widgets connect.
      await shadow.route(`${base}/`, async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          /<form\b(?=[^>]*\bmethod="post")(?=[^>]*\baction="\/")[^>]*>/,
          '$&<input type="hidden" name="addEventListener"><input type="hidden" name="elements">',
        );
        await route.fulfill({ response, body });
      });
      const errors = [];
      shadow.on("pageerror", (error) => errors.push(error.message));
      await shadow.goto(`${base}/`);
      const combo = shadow.locator('[data-scope=ui-combo-box] [role="combobox"]');
      const connected = await combo.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
      if (connected) {
        await combo.fill("Near Mint");
        await combo.press("Enter");
      }
      const states = await shadow.evaluate(async () => {
        const form = document.querySelector('form[method="post"][action="/"]');
        const named = ["addEventListener", "elements"].every((name) => form[name] instanceof HTMLInputElement);
        const floor = form.querySelector("#floor");
        const offer = form.querySelector('input[name="pricing"]:not([checked])');
        const us = form.querySelector('input[type="checkbox"][checked]');
        const qty = form.querySelector("#qty");
        const fewer = qty.closest("[data-scope=ui-number-field]").querySelector("button");
        const select = form.querySelector("[data-scope=ui-combo-box] select");
        const marked = () => select.parentElement.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? "";
        const conditional = () => [floor.matches(":disabled"), floor.required];
        const initial = conditional();
        offer.click();
        us.click();
        qty.value = "2";
        qty.dispatchEvent(new Event("input", { bubbles: true }));
        const state = () => ({
          floor: conditional(), ship: [us.checked, us.validationMessage], qty: [qty.value, fewer.disabled],
          combo: [select.value, marked()],
        });
        const before = state();
        HTMLFormElement.prototype.reset.call(form);
        await new Promise((resolve) => setTimeout(resolve));
        return { initial, before, after: state(), named };
      });
      const { initial, before, after } = states;
      const detail = JSON.stringify({ ...states, errors });
      check("RequiredWhen: controls named elements and addEventListener do not break connect, change or reset",
        initial.join() === "true,false" && before.floor.join() === "false,true" && after.floor.join() === "true,false", detail);
      check("CheckboxGroup: a control named addEventListener does not break reset",
        before.ship.join() === "false,Choose where you ship." && after.ship.join() === "true,", detail);
      check("NumberField: a control named addEventListener does not break reset",
        before.qty.join() === "2,false" && after.qty.join() === "1,true", detail);
      check("ComboBox: a control named addEventListener does not break connect or reset",
        connected && before.combo.join() === "nm,Near Mint" && after.combo.join() === ",", detail);
      check("the form's named controls shadow its members without widget exceptions", states.named && errors.length === 0, detail);
    } finally {
      await shadow.context().close();
    }
  }
}
