// @ts-check
/** @param {KeyboardEvent} event @param {HTMLDetailsElement} details */
export function close(event, details) {
  if (event.key === "Escape") details.open = false;
}
