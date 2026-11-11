// @ts-check
// For the docs' sixteen-argument call: eight refs, seven strings and the signal.
/**
 * @param {HTMLCanvasElement} a @param {HTMLElement} b @param {HTMLElement} c
 * @param {HTMLButtonElement} d @param {HTMLInputElement} e @param {HTMLSelectElement} f
 * @param {HTMLOutputElement} g @param {HTMLButtonElement} h
 * @param {string} i @param {string} j @param {string} k @param {string} l
 * @param {string} m @param {string} n @param {string} o
 * @param {AbortSignal} signal
 */
export function start(a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, signal) {
  d.addEventListener("click", () => { g.value = [i, j, k, l, m, n, o].join(" "); }, { signal });
  for (const el of [a, b, c, e, f, h]) el.hidden = false;
}

// For the twenty-five-argument call: eight refs, sixteen strings and the signal, held as twelve
// and then two halves of six and seven.
/**
 * @param {HTMLCanvasElement} a @param {HTMLElement} b @param {HTMLElement} c
 * @param {HTMLButtonElement} d @param {HTMLInputElement} e @param {HTMLSelectElement} f
 * @param {HTMLOutputElement} g @param {HTMLButtonElement} h
 * @param {string} s1 @param {string} s2 @param {string} s3 @param {string} s4
 * @param {string} s5 @param {string} s6 @param {string} s7 @param {string} s8
 * @param {string} s9 @param {string} s10 @param {string} s11 @param {string} s12
 * @param {string} s13 @param {string} s14 @param {string} s15 @param {string} s16
 * @param {AbortSignal} signal
 */
export function long(a, b, c, d, e, f, g, h, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15, s16, signal) {
  d.addEventListener("click", () => { g.value = [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15, s16].join(" "); }, { signal });
  for (const el of [a, b, c, e, f, h]) el.hidden = false;
}
