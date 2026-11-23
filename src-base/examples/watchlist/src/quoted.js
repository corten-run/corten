// @ts-check
// Quoted (smoke.rs): what the browser test reads back to check a handler is given its arguments,
// and the values elements give their refs, as the server had them, an apostrophe, quotes, `&`,
// `<` and `>` in them.

/**
 * Writes the text, the JSON value and each ref's values it was given into the element, as JSON.
 * @param {HTMLOutputElement} out
 * @param {string} text
 * @param {unknown} value
 * @param {Map<HTMLLIElement, string>} said each item with the text it gives its ref
 * @param {Map<HTMLLIElement, boolean>} held each item with the bool it gives its ref
 */
export function show(out, text, value, said, held) {
  out.textContent = JSON.stringify([text, value, Array.from(said.values()), Array.from(held.values())]);
}
