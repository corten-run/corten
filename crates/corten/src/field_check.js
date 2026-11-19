// @ts-check

/** @param {HTMLInputElement} weight */
export function input(weight) {
  weight.value = "1";
}

/** @param {HTMLInputElement[]} weights */
export function inputs(weights) {
  for (const weight of weights) weight.value = "1";
}

/** @param {HTMLSelectElement} weight */
export function select(weight) {
  weight.value = "air";
}

/** @param {string} text */
export function caption(text) {
  return text.length;
}
