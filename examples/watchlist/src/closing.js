// @ts-check
// Closing (smoke.rs): dialogs the server draws open and then closed, for the browser test to see
// that a patch closes them as the browser does: each one's delegated handlers hear its `toggle`
// and `close`, with its `returnValue`, the innermost first, and a handler may change the dialog as
// it starts to close.

/**
 * Makes a dialog drawn open modal, as `corten_ui::dialog::modal` does.
 * @param {HTMLDialogElement} dialog
 */
export function modal(dialog) {
  if (!dialog.open || dialog.matches(":modal")) return;
  dialog.removeAttribute("open");
  dialog.showModal();
}

/**
 * Takes the dialog's field and `<details>` out as it starts to close, while the patch that closes
 * it is replacing it.
 * @param {ToggleEvent} event
 * @param {HTMLDialogElement} dialog
 */
export function touch(event, dialog) {
  if (event.newState !== "closed") return;
  for (const el of Array.from(dialog.querySelectorAll("input, details"))) el.remove();
}

/**
 * Writes what the dialog heard into the log: its id, the event (with a toggle's new state, or the
 * dialog's `returnValue` when it has one), whether the dialog was on the page, and where focus was.
 * @param {Event} event
 * @param {HTMLDialogElement} dialog
 * @param {HTMLOutputElement} log
 */
export function heard(event, dialog, log) {
  const state = event instanceof ToggleEvent ? `:${event.newState}` : dialog.returnValue ? `:${dialog.returnValue}` : "";
  const focused = document.activeElement?.textContent?.trim() || document.activeElement?.localName;
  log.value += `${dialog.id} ${event.type}${state} ${dialog.isConnected ? "on" : "off"} ${focused}\n`;
}
