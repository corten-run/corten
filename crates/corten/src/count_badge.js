// @ts-check

/** A JSON shape no Rust type is checked against: a call from markup is refused when the crate compiles. @param {HTMLElement} el @param {{ count: number }} value */
export function show(el, value) {
  el.textContent = value.count.toFixed();
}

/** @typedef {{ count: number }} Count */

/** The same shape through a typedef of plain values: refused too. @param {HTMLElement} el @param {Count} value */
export function counted(el, value) {
  el.textContent = value.count.toFixed();
}

/** @typedef {{ out: HTMLOutputElement, ids: number[] }} Badge */

/** A group with a field no call is checked against: a call that passes the group is refused. @param {Badge} badge */
export function tally(badge) {
  badge.out.value = String(badge.ids.length);
}

/** Any JSON value, which the script checks itself. @param {HTMLElement} el @param {unknown} value */
export function raw(el, value) {
  el.textContent = typeof value === "number" ? value.toFixed() : "";
}
