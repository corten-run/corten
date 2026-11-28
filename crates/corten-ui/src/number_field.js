// @ts-check
// NumberField (number_field.rs). The input is a native number input, whose stepUp and stepDown
// already keep min, max and step; this adds the buttons, press and hold, Page Up and Page Down,
// Home and End, and decimal padding. A step sends `input` and `change` like typing does, and
// the input's own on:input (`sync`) then disables a button at its bound, as a form reset does.

import { keep } from "corten";

/** Milliseconds a button is held before it repeats, and between repeats. */
const HOLD = 400;
const REPEAT = 60;

/** The field's press and hold, and the button each pointer is pressing, by pointer id. */
const held = () => keep(() => ({ timer: 0, pressed: /** @type {Map<number, HTMLButtonElement>} */ (new Map()) }));

/**
 * When the field joins the page: the buttons match the value, after a form reset too (which
 * sends no `input`), and a hold ends wherever the pointer is released.
 * @param {HTMLButtonElement} decrease @param {HTMLInputElement} input @param {HTMLButtonElement} increase
 * @param {AbortSignal} signal
 */
export function connect(decrease, input, increase, signal) {
  sync(decrease, input, increase);
  // `reset` comes before the form puts its values back.
  const form = input.form;
  if (form) {
    const add = form.addEventListener;
    (typeof add === "function" ? add : EventTarget.prototype.addEventListener).call(form, "reset", () => setTimeout(() => sync(decrease, input, increase)), { signal });
  }
  const s = held();
  /** @param {Event} event */
  const release = (event) => {
    clearTimeout(s.timer);
    if (!(event instanceof PointerEvent)) return s.pressed.clear(); // the window lost focus
    // Released on the button it pressed, a click follows, the press's own (`click` takes it);
    // released anywhere else, cancelled, or on a button now disabled (at a bound), none does.
    const button = s.pressed.get(event.pointerId);
    if (event.type !== "pointerup" || !button || button.disabled || !button.contains(/** @type {Node} */ (event.target))) {
      s.pressed.delete(event.pointerId);
    }
  };
  for (const type of ["pointerup", "pointercancel", "blur"]) addEventListener(type, release, { signal });
  signal.addEventListener("abort", () => clearTimeout(s.timer));
}

/**
 * Steps by `by` while the button is held.
 * @param {PointerEvent} event @param {HTMLButtonElement} button @param {HTMLInputElement} input @param {number} by
 */
export function press(event, button, input, by) {
  if (event.button !== 0 || button.disabled) return;
  // Keeps focus where it was (usually the input) and selects no text.
  event.preventDefault();
  const s = held();
  s.pressed.set(event.pointerId, button);
  /** @param {number} delay */
  const tick = (delay) => {
    if (step(input, by)) s.timer = setTimeout(() => tick(REPEAT), delay);
  };
  clearTimeout(s.timer);
  tick(HOLD);
}

/**
 * Enter or Space on a button, or an assistive technology's click; the click that ends a pointer's
 * press has stepped already, on the press. A key's click has `detail` 0, so it always steps.
 * @param {MouseEvent} event @param {HTMLButtonElement} button @param {HTMLInputElement} input @param {number} by
 */
export function click(event, button, input, by) {
  const { pressed } = held();
  const pointer = event.detail > 0 ? [...pressed].find(([, pressing]) => pressing === button)?.[0] : undefined;
  if (pointer === undefined) step(input, by);
  else pressed.delete(pointer);
}

/** @param {KeyboardEvent} event @param {HTMLInputElement} input */
export function key(event, input) {
  // With no step there is none to add ten of (`stepUp` throws), and Home and End move the caret,
  // as in a text field, rather than go to an endpoint. The arrow keys stay the browser's:
  // they can land on a hinted end, even if the handler refuses it.
  if (input.step === "any") return;
  if (event.key === "PageUp" || event.key === "PageDown") step(input, event.key === "PageUp" ? 10 : -10);
  else if (event.key === "Home" && input.min !== "") set(input, input.min);
  else if (event.key === "End" && input.max !== "") set(input, input.max);
  else return;
  event.preventDefault();
}

/**
 * Disables each button at its bound, and both when there is no step to add.
 * @param {HTMLButtonElement} decrease @param {HTMLInputElement} input @param {HTMLButtonElement} increase
 */
export function sync(decrease, input, increase) {
  const value = input.valueAsNumber;
  const known = !Number.isNaN(value);
  const off = input.disabled || input.step === "any";
  decrease.disabled = off || (known && input.min !== "" && value <= Number(input.min));
  increase.disabled = off || (known && input.max !== "" && value >= Number(input.max));
}

/**
 * Adds `by` steps; false when the value did not change (at a bound, or disabled).
 * @param {HTMLInputElement} input @param {number} by
 */
function step(input, by) {
  if (input.disabled || input.readOnly) return false;
  const before = input.value;
  try {
    if (by > 0) input.stepUp(by);
    else input.stepDown(-by);
  } catch {
    return false; // step="any" has no step
  }
  return commit(input, before);
}

/** @param {HTMLInputElement} input @param {string} value */
function set(input, value) {
  if (input.disabled || input.readOnly) return;
  const before = input.value;
  input.value = value;
  commit(input, before);
}

/** @param {string} bound */
function decimals(bound) {
  return /\.(\d+)$/.exec(bound)?.[1]?.length ?? 0;
}

/**
 * Pads to the minimum and step's scale without rounding away any of the native value.
 * @param {HTMLInputElement} input @param {string} before
 */
function commit(input, before) {
  const value = input.value;
  const places = Math.max(decimals(input.min), decimals(input.step));
  if (value && places > 0 && places <= 100 && !/[eE]/.test(value)) {
    const missing = places - decimals(value);
    if (missing > 0) {
      const number = input.valueAsNumber;
      const valid = input.validity.valid;
      input.value = value + (value.includes(".") ? "" : ".") + "0".repeat(missing);
      // Keep the native spelling if padding changes how the browser reads it.
      if (!Object.is(input.valueAsNumber, number) || input.validity.valid !== valid) input.value = value;
    }
  }
  if (input.value === before) return false;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}
