import { check } from "./helpers.mjs";

export async function numberField(page) {
  // NumberField
  const qty = page.locator("#qty");
  const qtyButtons = page.locator("[data-scope=ui-number-field]").first().locator("button");
  check("at the minimum, decrease is disabled", (await qtyButtons.nth(0).isDisabled()) && (await qty.inputValue()) === "1");
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.changes = 0;
    document.querySelector("#qty")?.addEventListener("change", () => (w.changes += 1));
  });
  await qtyButtons.nth(1).click();
  check("increase steps once per click", (await qty.inputValue()) === "2", await qty.inputValue());
  check("a step sends change", (await page.evaluate(() => /** @type {any} */ (window).changes)) === 1);
  check("decrease is enabled above the minimum", !(await qtyButtons.nth(0).isDisabled()));
  await qty.focus();
  await page.keyboard.press("ArrowUp");
  check("the arrow keys step (native)", (await qty.inputValue()) === "3");
  await page.keyboard.press("PageUp");
  check("Page Up adds ten steps, up to the maximum", (await qty.inputValue()) === "10" && (await qtyButtons.nth(1).isDisabled()));
  await page.keyboard.press("Home");
  check("Home goes to the minimum", (await qty.inputValue()) === "1");
  await page.keyboard.press("End");
  check("End goes to the maximum", (await qty.inputValue()) === "10" && (await qtyButtons.nth(1).isDisabled()), await qty.inputValue());
  await page.keyboard.press("PageDown");
  check("Page Down takes ten steps off, down to the minimum", (await qty.inputValue()) === "1" && (await qtyButtons.nth(0).isDisabled()), await qty.inputValue());
  const box = await qtyButtons.nth(1).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Held until it has repeated, however long a loaded machine takes to run the timers (#666): a
  // fixed wait counted the repeats the machine had time for.
  const repeated = await page.waitForFunction(() => Number(/** @type {HTMLInputElement} */ (document.getElementById("qty")).value) >= 4, null, { timeout: 10_000 }).then(() => true, () => false);
  await page.mouse.up();
  const held = Number(await qty.inputValue());
  check("press and hold repeats", repeated && held >= 4, String(held));
  await page.waitForTimeout(200);
  check("release stops the repeat", Number(await qty.inputValue()) === held);
  check("the button kept focus where it was", await page.evaluate(() => document.activeElement?.id === "qty"));
  await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).click();
  check("a step keeps the step's decimals", (await page.locator("#weight").inputValue()) === "0.6", await page.locator("#weight").inputValue());
  // Each field keeps its own state (keep()): while the quantity's button is held, the weight's
  // button still steps from the keyboard. Sharing one, the held pointer would make it skip.
  await qty.focus();
  await page.keyboard.press("Home");
  const before = Number(await qty.inputValue());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const holding = Number(await qty.inputValue());
  await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).press("Enter");
  const own = await page.locator("#weight").inputValue();
  await page.mouse.up();
  // The quantity stepped on the press, so its pointer was held while the weight stepped.
  check("each field keeps its own state", holding > before && own === "0.7", `quantity ${before} -> ${holding}, weight ${own}`);
  // A press released off its button makes no click, so nothing is left to skip the next key's. The
  // press and its release are sent in one task: from real input, a release more than 400 ms after
  // the press (a loaded machine) is a hold, which repeats, as it should (#666).
  await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).evaluate((button) => {
    const at = { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 9, isPrimary: true };
    button.dispatchEvent(new PointerEvent("pointerdown", at));
    document.body.dispatchEvent(new PointerEvent("pointerup", at));
  });
  await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).press("Enter");
  const after = await page.locator("#weight").inputValue();
  check("a press released elsewhere steps once, and the next key steps", after === "0.9", after);
  // A key's click right after a pointer's, in the same task (before any timer can run): the
  // pointer's stepped on its press, its click does not step again, and the key's does (#316).
  const sameTask = await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).evaluate((button) => {
    const input = /** @type {HTMLInputElement} */ (document.getElementById("weight"));
    const from = input.value;
    const at = { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 7, isPrimary: true };
    button.dispatchEvent(new PointerEvent("pointerdown", at));
    button.dispatchEvent(new PointerEvent("pointerup", at));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    button.click();
    return `${from} -> ${input.value}`;
  });
  check("a key's click right after a pointer's steps once more", sameTask === "0.9 -> 1.1", sameTask);
  const fewer = page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(0);
  for (const key of ["Enter", "Space", "Enter", "Space"]) await fewer.press(key);
  check("Enter and Space on decrease step down", (await page.locator("#weight").inputValue()) === "0.7", await page.locator("#weight").inputValue());
  const layout = await page.evaluate(() => {
    // The number field's root is a div; the wrapper that lays out its parts and the adornment holds it.
    const field = /** @type {Element} */ (document.querySelector("#weight")?.closest("[data-scope=ui-number-field]")?.parentElement);
    return Array.from(field.querySelectorAll("button, span, input"), (el) => [el.localName, Math.round(el.getBoundingClientRect().x)])
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((p) => p[0])
      .join(" ");
  });
  check("the design system orders an adornment between the parts", layout === "button span input button", layout);
  // A field with step="any" has no step for a button to add: both stay disabled
  // as the value changes, and Home leaves the value as typed rather than going to an end the field
  // may have to stay off (exclusive_min).
  const discount = page.locator("#discount");
  const discountButtons = page.locator("[data-scope=ui-number-field]").nth(2).locator("button");
  const discountHint = page.locator("#discount-hint");
  check("the discount has a visible, associated hint with the exclusive limits",
    (await discount.getAttribute("aria-describedby")) === "discount-hint" && await discountHint.isVisible() &&
    (await discountHint.textContent()) === "Enter a discount above 0 and below 100 percent, or none.");
  await discount.fill("37.5");
  await discount.press("Home");
  const stepless = [await discount.inputValue(), await discount.getAttribute("step"), await discountButtons.nth(0).isDisabled(), await discountButtons.nth(1).isDisabled()].join(" ");
  check("a number field with step any keeps both buttons disabled and Home leaves its value", stepless === "37.5 any true true", stepless);
  // The browser owns the arrow keys and may land on a hinted endpoint. It must not step past it.
  /** @param {string} from @param {string} key */
  const arrow = async (from, key) => {
    await discount.fill(from);
    await discount.press(key);
    return discount.evaluate((input) => ({ value: /** @type {HTMLInputElement} */ (input).value, valid: /** @type {HTMLInputElement} */ (input).validity.valid }));
  };
  const down = await arrow("0.5", "ArrowDown");
  check("step any: ArrowDown from 0.5 does not go below the minimum hint", down.valid && Number(down.value) >= 0 && Number(down.value) <= 0.5, JSON.stringify(down));
  const up = await arrow("99.5", "ArrowUp");
  check("step any: ArrowUp from 99.5 does not go above the maximum hint", up.valid && Number(up.value) >= 99.5 && Number(up.value) <= 100, JSON.stringify(up));
  // A number made in code is drawn with an exponent past 18 digits written out. Check that
  // the browser admits that prefill near either end.
  const drawnTiny = await discount.evaluate((input) => {
    const [min, max] = [input.getAttribute("min") ?? "", input.getAttribute("max") ?? ""];
    // The discount's own ends, and the mirror: below 0 (exclusive_max), from -1.
    return [["1e-20", min, max], ["-1e-20", "-1", "0"]].map(([value, min, max]) => {
      const i = document.createElement("input");
      Object.assign(i, { type: "number", step: "any", min, max });
      i.setAttribute("value", value);
      return i.validity.valid;
    }).join(" ");
  });
  check("step any: a tiny number drawn with an exponent is inside the drawn ends, above 0 and below it", drawnTiny === "true true", drawnTiny);
  // The Rust render tests pin these attributes. In particular the stepped writer must not mix
  // an exponent min and step with a fixed-notation prefilled value.
  const otherBounds = await page.evaluate(() => {
    const input = () => document.createElement("input");
    const [tiny, positive, negative] = [input(), input(), input()];
    const fixed = "0.00000000000000000001";
    Object.assign(tiny, { type: "number", min: fixed, step: fixed, max: "1" });
    tiny.setAttribute("value", fixed);
    Object.assign(positive, { type: "number", min: "-3.4028235e38", max: "3.4028235e38", step: "any", value: "1e39" });
    Object.assign(negative, { type: "number", min: "-3.4028235e38", max: "3.4028235e38", step: "any", value: "-1e39" });
    return [tiny.validity.valid, positive.validity.rangeOverflow, negative.validity.rangeUnderflow].join(" ");
  });
  check("the prefilled tiny stepped value is valid and finite f32 bounds block overflow in both directions",
    otherBounds === "true true true", otherBounds);
  await discount.fill("");
  await stepBase(page);
  return { qty, qtyButtons };
}

/** @param {import("@playwright/test").Page} page */
async function stepBase(page) {
  const cases = [
    { name: "a fractional minimum with a whole step", min: "0.5", step: "1", from: "0.5", to: "1.5" },
    { name: "a fractional value step base without a minimum", min: null, step: "0.25", from: "0.125", to: "0.375" },
    { name: "a step that pads an exact value", min: "0.25", step: "0.25", from: "0.75", to: "1.00" },
    { name: "a scale set by the minimum", min: "0.50", step: "1", from: "0.50", to: "1.50" },
    { name: "the last whole step below the maximum", min: "0", max: "2.4", step: "1", from: "0", key: "End", to: "2" },
    { name: "an aligned maximum", min: "0", max: "2", step: "1", from: "0", key: "End", to: "2" },
    { name: "a maximum just above a whole step", min: "0", max: "2.00000001", step: "1", from: "0", key: "End", to: "2" },
    { name: "a maximum just below a whole step", min: "0", max: "1.99999999", step: "1", from: "0", key: "End", to: "1" },
    { name: "the last fractional step below the maximum", min: "0.25", max: "0.9", step: "0.5", from: "0.25", key: "End", to: "0.75" },
    { name: "the last step below a negative maximum", min: "-2.3", max: "-0.1", step: "1", from: "-2.3", key: "End", to: "-0.3" },
    { name: "an exponent value in its native notation", min: "-5e-7", step: "0.00000001", from: "0", key: "Home", to: "-5e-7" },
    { name: "a value at a precision beyond toFixed", min: "0.5", step: `0.${"0".repeat(100)}1`, from: "1", key: "Home", to: "0.5" },
  ];
  for (const { name, min, max, step, from, to, key } of cases) {
    const state = await page.locator("#weight").evaluate(async (weight, { min, max, step, from, key }) => {
      // Let Corten connect a fresh copy inside a separate form. Leave the real gallery form,
      // its listeners, and the state other smoke areas use alone.
      const form = document.createElement("form");
      const field = /** @type {Element} */ (weight.closest("[data-scope=ui-number-field]")?.cloneNode(true));
      const input = /** @type {HTMLInputElement} */ (field.querySelector("input"));
      const increase = /** @type {HTMLButtonElement} */ (field.querySelectorAll("button")[1]);
      input.id = "step-base-smoke";
      for (const button of field.querySelectorAll("button")) button.setAttribute("aria-controls", input.id);
      if (min === null) input.removeAttribute("min");
      else input.min = min;
      if (max !== undefined) input.max = max;
      input.step = step;
      input.setAttribute("value", from);
      input.value = from;
      form.append(field);
      /** @type {FormDataEntryValue[]} */
      const submitted = [];
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        submitted.push(...new FormData(form).getAll(input.name));
      });
      let changes = 0;
      input.addEventListener("change", () => changes++);
      document.body.append(form);
      try {
        await new Promise((resolve) => setTimeout(resolve)); // let the runtime wire the clone
        if (key) input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        else increase.click();
        form.requestSubmit();
        return { value: input.value, valid: input.validity.valid, submitted, changes, atEnd: increase.disabled };
      } finally {
        form.remove();
      }
    }, { min, max, step, from, key });
    check(`NumberField keeps ${name} valid and submits it`, state.valid && state.changes === 1 &&
      state.value === to && state.submitted.length === 1 && state.submitted[0] === to &&
      (key !== "End" || state.atEnd), JSON.stringify(state));
  }
}
