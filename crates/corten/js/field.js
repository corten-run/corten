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
 * belongs to (`form=` included), or none when its `form=` names no form, as a submit has it; for
 * a form-associated custom element, also a listed element, the same owner, which its `form=` gives
 * as for any control (the first element of its tree with that id, if a form), though only its own
 * script can read it; else the one around it. A `<label>` or `<legend>` is not a control: its
 * `form` is the labelled control's or the fieldset's, which `form=` may put in another form, so it
 * takes the one around it, as a `<ul>` does. Only a form's own members can be shadowed by a
 * control's name (`form`, `closest`), and a form is taken first.
 * @param {Element} el @returns {HTMLFormElement | null}
 */
export function formOf(el) {
  if (el instanceof HTMLFormElement) return el;
  if (el.matches(LISTED)) return /** @type {HTMLInputElement} */ (el).form ?? (el.hasAttribute("form") ? null : el.closest("form"));
  const id = el.getAttribute("form");
  if (id === null || !Reflect.get(el.constructor, "formAssociated")) return el.closest("form");
  const owner = /** @type {Document} */ (el.getRootNode()).getElementById?.(id);
  return owner instanceof HTMLFormElement ? owner : null;
}

/**
 * The controls named `name` in the form of `el` (`formOf`), in the form's order, or null when it
 * is in no form.
 * @param {Element} el @param {string} name @returns {Element[] | null}
 */
export function controls(el, name) {
  const form = formOf(el);
  if (!form) return null;
  // The form's own `elements` (a control named "elements" would be found in its place), by the
  // browser's index of its names, which a walk over every control would cost a form of hundreds
  // a millisecond a run. It also matches an id, which is not a posted name.
  const elements = /** @type {HTMLFormControlsCollection} */ (Reflect.get(HTMLFormElement.prototype, "elements", form));
  const hit = HTMLFormControlsCollection.prototype.namedItem.call(elements, name);
  return (hit instanceof Element ? [hit] : [...(hit ?? [])]).filter((c) => Element.prototype.getAttribute.call(c, "name") === name);
}

/**
 * What each kind of field argument gives its handler, the parameter type the compiler matched the
 * call to: a form's controls are HTML elements, so the tag is the interface.
 * @typedef {{ i: HTMLInputElement, s: HTMLSelectElement, t: HTMLTextAreaElement, "*": HTMLInputElement[] }} Given
 */

/**
 * What a field argument gives its handler: the one `<input>` (`i`), `<select>` (`s`) or
 * `<textarea>` (`t`) of its name in the form of `el`, or every `<input>` of it (`*`; none is an
 * empty list). Anything else is null: a mistake the compiler could not see, since the markup that
 * draws the control may be another component's.
 * @template {keyof Given} K
 * @param {Element} el @param {{ control: K, name: string }} arg @returns {Given[K] | null}
 */
export function field(el, { control, name }) {
  const found = controls(el, name);
  const one = control !== "*";
  if (!found?.every((c) => c.localName === TAGS[control]) || (one && found.length !== 1)) return null;
  return /** @type {Given[K]} */ (/** @type {unknown} */ (one ? found[0] : found));
}

/**
 * Why handler `call` is not given field argument `arg` of `el`: what it takes, and what the form
 * has instead (none, more than one, or another kind) or that `el` is in no form. The runtime
 * throws it when the handler runs, and `corten dev` reports it when the page draws the call.
 * @param {Element} el @param {{ control: keyof Given, name: string }} arg
 * @param {{ module: string, name: string }} call
 */
export function why(el, arg, call) {
  const found = controls(el, arg.name);
  const has = found ? `its form has ${found.map((c) => c.localName).join(", ") || "none"}` : "it is in no form";
  return `${call.module}.${call.name} takes field ${arg.name} as ${arg.control === "*" ? "every" : "one"} <${TAGS[arg.control]}>, and ${has}`;
}

/**
 * What the runtime gives handler `call` for field argument `arg` of the element with it: the
 * control (`field`), or an error saying why not (`why`).
 * @template {keyof Given} K
 * @param {Element} el @param {{ control: K, name: string }} arg
 * @param {{ module: string, name: string }} call @returns {Given[K]}
 */
export function given(el, arg, call) {
  const found = field(el, arg);
  if (!found) throw new Error(`corten: ${why(el, arg, call)}`);
  return found;
}
