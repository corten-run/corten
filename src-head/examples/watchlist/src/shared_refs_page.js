/** @param {HTMLParagraphElement} part @param {HTMLOutputElement} out */
export function show_part(part, out) {
  out.value = part.textContent ?? "";
}
