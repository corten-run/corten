// @ts-check
// A form field a handler is given (`js::fill(f.weight)`, `~i"weight"` in `data-on`): found by its
// name in the form of the element with the handler, when the handler runs. Built into
// dist/field.js, a module of its own that Corten serves with the app's scripts as `corten-field`
// and that only a page whose handlers take a field loads, as a format argument loads
// `corten-format`; served as written to `corten dev`'s checks (dev.js), so both find a field the
// same way.

/** The tag of each kind's controls: an input, select or textarea, or every input of the name. */
export const TAGS = { i: "input", s: "select", t: "textarea", "*": "input" };

/** The elements with a form owner, which `form=` can join to a form outside them. */
export const LISTED = "button,fieldset,input,object,output,select,textarea";

/**
 * The form of `el`: the form itself; for a control (`LISTED`), the one the browser says it
 * belongs to (`form=` included), or none when its `form=` names no form, as a submit has it; else
 * the one around it. A `<label>` or `<legend>` is not a control: its `form` is the labelled
 * control's or the fieldset's, which `form=` may put in another form, so it takes the one around
 * it, as a `<ul>` does. Only a form's own members can be shadowed by a control's name (`form`,
 * `closest`), and a form is taken first.
 * @param {Element} el @returns {HTMLFormElement | null}
 */
export function formOf(el) {
  if (el instanceof HTMLFormElement) return el;
  if (!el.matches(LISTED)) return el.closest("form");
  return /** @type {HTMLInputElement} */ (el).form ?? (el.hasAttribute("form") ? null : el.closest("form"));
}

/**
 * The controls named `name` in the form of `el` (`formOf`), in the form's order, or null when it
 * is in no form.
 * @param {Element} el @param {string} name @returns {Element[] | null}
 */
export function controls(el, name) {
  const form = formOf(el);
  if (!form) return null;
  const found = [];
  // The form's own `elements`: a control named "elements" would be found in its place.
  for (const c of /** @type {HTMLFormControlsCollection} */ (Reflect.get(HTMLFormElement.prototype, "elements", form))) {
    if (Element.prototype.getAttribute.call(c, "name") === name) found.push(c);
  }
  return found;
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

/**
 * What the runtime gives handler `call` for field argument `arg` of the element with it: the
 * control (`field`), or an error. Short: `corten dev` tells what the form has instead, when the
 * page draws the call.
 * @param {Element} el @param {{ control: "i" | "s" | "t" | "*", name: string }} arg
 * @param {{ module: string, name: string }} call
 */
export function given(el, arg, call) {
  const found = field(el, arg);
  if (!found) throw new Error(`corten: ${call.module}.${call.name} takes field ${arg.name}, and its form has no such control`);
  return found;
}
