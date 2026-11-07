// @ts-check

/** A JSON shape no Rust type is checked against: a call from markup is refused when the crate compiles. @param {HTMLElement} el @param {{ count: number }} value */
export function show(el, value) {
  el.textContent = value.count.toFixed();
}

/** Any JSON value, which the script checks itself. @param {HTMLElement} el @param {unknown} value */
export function raw(el, value) {
  el.textContent = typeof value === "number" ? value.toFixed() : "";
}
