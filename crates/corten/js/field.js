// @ts-check
// A form field a handler is given (`js::fill(f.weight)`, `~i"weight"` in `data-on`): found by its
// name in the form of the element with the handler, when the handler runs. Bundled into
// dist/corten.js, and served as written to `corten dev`'s checks (dev.js), so both find a field the
// same way.

/** The tag of each kind's controls: an input, select or textarea, or every input of the name. */
export const TAGS = { i: "input", s: "select", t: "textarea", "*": "input" };

/**
 * The controls named `name` in the form of `el` (the form itself, the one `el` belongs to,
 * `form=` included, or the one around it), in the form's order, or null when it is in no form.
 * @param {Element} el @param {string} name @returns {Element[] | null}
 */
export function controls(el, name) {
  const form = (el instanceof HTMLFormElement ? el : /** @type {{ form?: HTMLFormElement | null }} */ (el).form) ?? el.closest("form");
  // The form's own `elements`: a control named "elements" would be found in its place.
  return form && [.../** @type {HTMLFormControlsCollection} */ (Reflect.get(HTMLFormElement.prototype, "elements", form))].filter((c) => c.getAttribute("name") === name);
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
