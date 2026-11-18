/** @param {HTMLOutputElement} ready */
export function ready(ready) {
  ready.value = document.compatMode;
}

/** @param {HTMLParagraphElement} part @param {HTMLOutputElement} out */
export function show_part(part, out) {
  out.value = part.textContent ?? "";
}
