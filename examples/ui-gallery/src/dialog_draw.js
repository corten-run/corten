// @ts-check

/**
 * Records a delegated close, including whether it reached an attached dialog.
 * @param {Event} event
 * @param {HTMLDialogElement} dialog
 * @param {boolean} discardOuter
 */
export function closed(event, dialog, discardOuter) {
  const output = dialog.closest("main")?.querySelector("output");
  if (output) output.value += `${dialog.id}:${event.isTrusted ? "native" : "patch"}:${event.bubbles ? "bubbles" : "target"}${dialog.returnValue ? `:${dialog.returnValue}` : ""};`;
  if (discardOuter) dialog.parentElement?.remove();
}

/** @param {HTMLDialogElement} dialog */
export function nativeClose(dialog) {
  dialog.close("new");
}

/** @param {HTMLFormElement} form */
export function focused(form) {
  const output = form.closest("main")?.querySelector("output");
  if (output) output.dataset.focusRef = `${output.dataset.focusRef ?? ""}${form.dataset.stage};`;
}

/** @param {HTMLElement} target @param {string} id */
export function insertDialog(target, id) {
  const dialog = document.createElement("dialog");
  dialog.id = id;
  dialog.addEventListener("close", (event) => closed(event, dialog, false));
  target.append(dialog);
}
