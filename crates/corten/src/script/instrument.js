// @ts-check
// A handler with more arguments than a tuple's impls would reach: eight refs, seven strings and
// the signal.
/**
 * @param {HTMLCanvasElement} spectrum @param {HTMLElement} fallback @param {HTMLElement} controls
 * @param {HTMLButtonElement} play @param {HTMLInputElement} tempo @param {HTMLSelectElement} pattern
 * @param {HTMLOutputElement} status @param {HTMLButtonElement} pause
 * @param {string} playText @param {string} stopText @param {string} offText @param {string} onText
 * @param {string} unavailableText @param {string} pauseText @param {string} resumeText
 * @param {AbortSignal} signal
 */
export function instrument(
  spectrum, fallback, controls, play, tempo, pattern, status, pause,
  playText, stopText, offText, onText, unavailableText, pauseText, resumeText, signal,
) {
  const texts = [playText, stopText, offText, onText, unavailableText, pauseText, resumeText];
  play.addEventListener("click", () => { status.value = texts.join(" "); }, { signal });
  for (const el of [spectrum, fallback, controls, tempo, pattern, pause]) el.hidden = false;
}
