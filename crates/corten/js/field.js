// @ts-check
// A form field a handler is given (`js::fill(f.weight)`, `~i"weight"` in `data-on`): found by its
// name in the form of the element with the handler, when the handler runs. Bundled into
// dist/corten.js, and served as written to `corten dev`'s checks (dev.js), so both find a field the
// same way.

/** The tag of each kind's controls: an input, select or textarea, or every input of the name. */
export const TAGS = { i: "input", s: "select", t: "textarea", "*": "input" };

/**
 * The form of `el`: the form itself; the one the browser says it belongs to (a control's,
 * `form=` included); none when its `form=` names no form, as a submit has it; else the one around
 * it. Only a form's own members can be shadowed by a control's name (`form`, `closest`), and a
 * form is taken first.
 * @param {Element} el @returns {HTMLFormElement | null}
 */
export function formOf(el) {
  if (el instanceof HTMLFormElement) return el;
  const owner = "form" in el ? /** @type {HTMLFormElement | null} */ (el.form) : null;
  return owner ?? (el.hasAttribute("form") ? null : el.closest("form"));
}

/**
 * The controls named `name` in the form of `el` (`formOf`), in the form's order, or null when it
 * is in no form.
 * @param {Element} el @param {string} name @returns {Element[] | null}
 */
export function controls(el, name) {
  const form = formOf(el);
  // The form's own `elements`: a control named "elements" would be found in its place.
  return form && [.../** @type {HTMLFormControlsCollection} */ (Reflect.get(HTMLFormElement.prototype, "elements", form))].filter((c) => Element.prototype.getAttribute.call(c, "name") === name);
}

/**
 * What a field argument gives its handler: the one `<input>` (`i`), `<select>` (`s`) or
 * `<textarea>` (`t`) of its name in the form of `el`, or every `<input>` of it (`*`; none is an
 * empty list). A form's controls are HTML elements, so the tag is the interface the handler takes.
 * Anything else is null: a mistake the compiler could not see, since the markup that draws the
 * control may be another component's.
 * @param {Element} el @param {{ control: "i" | "s" | "t" | "*", name: string }} arg
 * @returns {Element | Element[] | null}
 */
export function field(el, { control, name }) {
  const found = controls(el, name);
  const one = control !== "*";
  return found?.every((c) => c.localName === TAGS[control]) && (!one || found.length === 1) ? (one ? /** @type {Element} */ (found[0]) : found) : null;
}
