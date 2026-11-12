// @ts-check
// Quoted (smoke.rs): what the browser test reads back to check a handler is given its arguments as
// the server had them, an apostrophe, quotes, `&` and `<` in them.

/**
 * Writes the text and the JSON value it was given into the element, as JSON.
 * @param {HTMLOutputElement} out
 * @param {string} text
 * @param {unknown} value
 */
export function show(out, text, value) {
  out.textContent = JSON.stringify([text, value]);
}
