// @ts-check

/** @param {AbortSignal} signal */
export function ready(signal) {
  signal.addEventListener("abort", () => {});
}

/** @param {HTMLElement} toasts */
export function hold(toasts) {
  toasts.hidden = false;
}
