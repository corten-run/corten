import { base, check } from "./helpers.mjs";

export async function fields(orders) {
  // One width rule: in a Field the control fills the field's row, a select as an input does; a
  // ControlWidth holds there (the price, on the home page).
  const fills = await orders.getByLabel("Ship from", { exact: true }).evaluate((s) => [s.getBoundingClientRect().width, /** @type {Element} */ (s.parentElement).getBoundingClientRect().width].map(Math.round));
  check("Select: in a Field, fills the field's row", fills[0] === fills[1] && fills[0] > 200, JSON.stringify(fills));
  const home = await orders.context().newPage();
  await home.goto(`${base}/`);
  const priced = await home.getByLabel("Price (USD)", { exact: true }).evaluate((i) => {
    const root = getComputedStyle(document.documentElement);
    const want = parseFloat(root.getPropertyValue("--control-width-sm")) * parseFloat(root.fontSize);
    return {
      width: Math.round(i.getBoundingClientRect().width),
      want: Math.round(Math.min(want, /** @type {Element} */ (i.parentElement).getBoundingClientRect().width)),
      classes: [...i.classList].filter((c) => c.startsWith("control-width")),
    };
  });
  // The condition combobox (a corten-ui widget) fills its field's row too.
  const combo = await home.getByRole("combobox", { name: "Condition" }).evaluate((i) => [i.getBoundingClientRect().width, /** @type {Element} */ (i.closest("[class*=field__control]")).getBoundingClientRect().width].map(Math.round));
  // An input outside a field has its natural width and sits beside its button in a row that wraps
  // (a Cluster); the price's look classes, without its width, on an input in such a row.
  const beside = await home.getByLabel("Price (USD)", { exact: true }).evaluate((price) => {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; flex-wrap: wrap; gap: .5rem; width: 360px";
    const input = document.createElement("input");
    input.className = [...price.classList].filter((c) => !c.startsWith("control-width")).join(" ");
    const button = document.createElement("button");
    button.textContent = "Find";
    row.append(input, button);
    document.body.append(row);
    const out = { input: Math.round(input.getBoundingClientRect().width), sameRow: input.getBoundingClientRect().top === button.getBoundingClientRect().top };
    row.remove();
    return out;
  });
  // A Field in a column narrower than its control's natural width keeps the control inside it: a
  // copy of an input's field and a ComboBox's, without a ControlWidth, in a grid of 8rem columns (a
  // Stepper keeps its width and full-size buttons). In a box with room that sizes to its content
  // (absolutely placed), a field is still as wide as its control asks.
  const narrowFields = await home.evaluate(() => {
    const labels = ["Price (USD)", "Condition"];
    const fields = [...document.querySelectorAll("[class*=field__field]")].filter((f) => labels.includes(f.querySelector("label")?.textContent?.trim() ?? ""));
    /** @param {Element} field */
    const copyOf = (field) => {
      const copy = /** @type {Element} */ (field.cloneNode(true));
      for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
      for (const input of copy.querySelectorAll("input")) {
        input.classList.remove(...[...input.classList].filter((c) => c.startsWith("control-width")));
      }
      return copy;
    };
    /** @param {Element} copy */
    const past = (copy) =>
      Math.max(...[...copy.querySelectorAll("input, select, textarea, button")].map((el) => Math.round(el.getBoundingClientRect().right - copy.getBoundingClientRect().right)));
    const grid = document.createElement("div");
    grid.style.cssText = "display: grid; grid-template-columns: repeat(3, 8rem); gap: 1rem";
    grid.append(...fields.map(copyOf));
    document.body.append(grid);
    const narrow = [...grid.children].map(past);
    grid.remove();
    const price = copyOf(/** @type {Element} */ (fields.find((f) => f.querySelector("label")?.textContent?.trim() === "Price (USD)")));
    const box = document.createElement("div");
    box.style.cssText = "position: absolute; top: 0; left: 0";
    box.append(price);
    document.body.append(box);
    const own = Math.round(price.getBoundingClientRect().width);
    const input = /** @type {HTMLInputElement} */ (price.querySelector("input"));
    input.style.cssText = "position: absolute";
    const natural = Math.round(input.getBoundingClientRect().width);
    box.remove();
    // A Stepper keeps its width and its buttons their size, however narrow the column.
    const quantity = /** @type {Element} */ ([...document.querySelectorAll("[class*=field__field]")].find((f) => f.querySelector("label")?.textContent?.trim() === "Quantity"));
    /** @param {Element} field */
    const buttons = (field) => [...field.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().width));
    const onPage = buttons(quantity);
    const thin = document.createElement("div");
    thin.style.cssText = "display: grid; grid-template-columns: 8rem";
    const quantityCopy = copyOf(quantity);
    thin.append(quantityCopy);
    document.body.append(thin);
    const squeezed = buttons(quantityCopy);
    thin.remove();
    return { kinds: fields.length, narrow, own, natural, stepper: { onPage, squeezed } };
  });
  await home.close();
  check("Field: in a column narrower than its control's natural width, the control stays inside the field", narrowFields.kinds === 2 && narrowFields.narrow.every((px) => px <= 0), JSON.stringify(narrowFields));
  check("Field: in a box with room sized to its content, as wide as its control's natural width", narrowFields.own >= narrowFields.natural - 1, JSON.stringify(narrowFields));
  check(
    "Field: a Stepper in a column narrower than it keeps its buttons' size",
    narrowFields.stepper.onPage.length === 2 && narrowFields.stepper.onPage.every((w, i) => w > 20 && w === narrowFields.stepper.squeezed[i]),
    JSON.stringify(narrowFields.stepper),
  );
  check("ControlWidth: a field's row keeps the control's width", priced.width === priced.want, JSON.stringify(priced));
  check("ComboBox: in a Field, fills the field's row", combo[0] === combo[1] && combo[0] > 200, JSON.stringify(combo));
  check("Input: outside a Field, its natural width, beside its button", beside.sameRow && beside.input < 260, JSON.stringify(beside));
  // A textarea fills its field's row, and a ControlWidth on one holds there too (both stylesheets
  // weigh the same, so the width's two classes win wherever they come).
  const note = await orders.getByLabel("Note to buyers", { exact: true }).evaluate((area, sm) => {
    const row = /** @type {Element} */ (area.parentElement);
    const fills = Math.round(area.getBoundingClientRect().width) === Math.round(row.getBoundingClientRect().width);
    // The copy alone in the row, in the textarea's place.
    const copy = /** @type {HTMLTextAreaElement} */ (area.cloneNode());
    copy.removeAttribute("id");
    copy.removeAttribute("name");
    copy.classList.add(...sm);
    area.replaceWith(copy);
    const root = getComputedStyle(document.documentElement);
    const want = Math.round(parseFloat(root.getPropertyValue("--control-width-sm")) * parseFloat(root.fontSize));
    const limited = Math.round(copy.getBoundingClientRect().width);
    // Outside a field, the textarea fills its container.
    const box = document.createElement("div");
    box.style.width = "300px";
    const loose = /** @type {HTMLTextAreaElement} */ (area.cloneNode());
    loose.removeAttribute("id");
    loose.removeAttribute("name");
    box.append(loose);
    document.body.append(box);
    const outside = Math.round(loose.getBoundingClientRect().width);
    box.remove();
    copy.replaceWith(area);
    return { fills, limited, want, outside };
  }, priced.classes);
  check("Textarea: in a Field, fills the row; a ControlWidth on one holds; outside one, fills its container", note.fills && note.limited === note.want && note.outside === 300, JSON.stringify(note));
}
