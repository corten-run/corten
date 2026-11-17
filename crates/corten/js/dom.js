// @ts-check
// Form controls override built-in members by name or id. Capture getters once, not on each
// step of a walk, and call them with the node as receiver, never through the form itself.
/**
 * @template T
 * @template {keyof T} K
 * @param {T} prototype @param {K} key
 * @returns {(node: T) => T[K]}
 */
export function getter(prototype, key) {
  const get = /** @type {() => T[K]} */ (Object.getOwnPropertyDescriptor(prototype, key)?.get);
  return (node) => get.call(node);
}

