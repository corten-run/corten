// @ts-check
/** @param {HTMLButtonElement} save */
export function enable(save) {
  save.disabled = false;
}

/** @param {MouseEvent} event @param {HTMLDialogElement} dialog @param {string} name */
export function confirm(event, dialog, name) {
  event.preventDefault();
  dialog.dataset.name = name;
  dialog.showModal();
}

/** @param {KeyboardEvent} event @param {HTMLLIElement} line */
export function shortcut(event, line) {
  if (event.key === "Delete") line.remove();
}

/** @import { CortenError, CortenNotice } from "corten" */

/** @param {CortenError} event @param {HTMLFormElement} form */
export function failed(event, form) {
  form.dataset.failed = String(event.detail.status);
}

/** @param {CortenNotice} event */
export function said(event) {
  document.title = event.detail.message;
}

/** @param {CustomEvent<{ status: number }>} event */
export function sent(event) {
  document.title = String(event.detail.status);
}

/** @param {ProgressEvent} event @param {HTMLProgressElement} bar */
export function progressed(event, bar) {
  if (event.lengthComputable) bar.value = event.loaded / event.total;
  else bar.removeAttribute("value");
}

/** @param {HTMLElement} line */
export function remove(line) {
  line.remove();
}
