// @ts-check
// The longest call a tuple's impls reached (twelve arguments), for what_a_long_handler_call_costs:
// six refs, five strings and the signal.
/**
 * @param {HTMLElement} a @param {HTMLElement} b @param {HTMLElement} c
 * @param {HTMLButtonElement} d @param {HTMLInputElement} e @param {HTMLOutputElement} f
 * @param {string} g @param {string} h @param {string} i @param {string} j @param {string} k
 * @param {AbortSignal} signal
 */
export function wide(a, b, c, d, e, f, g, h, i, j, k, signal) {
  d.addEventListener("click", () => { f.value = [g, h, i, j, k].join(" "); }, { signal });
  for (const el of [a, b, c, e]) el.hidden = false;
}
