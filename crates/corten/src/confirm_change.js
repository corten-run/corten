/** @typedef {import("./type_tests/types/app").Change} Change */

/** @typedef {{ button: HTMLButtonElement, change: Change }} Confirmation */

/** @param {Confirmation} confirmation */
export function confirm(confirmation) {
  const { button, change } = confirmation;
  button.disabled = change.op === "remove";
}
