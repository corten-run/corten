// @ts-check
// corten_ui::dialog. The platform opens a dialog as a modal only from a script (`showModal`) or a
// click (`command="show-modal"`): a dialog the server draws `open` (a refused form, a result to
// read) is open but not modal. `modal` makes it modal when it joins the page. `failed` says in a
// dialog that a submit inside it got no answer, where the page's toaster cannot be seen.

/**
 * A dialog drawn `open` becomes modal: in the top layer over a backdrop, the page behind it inert,
 * Escape closes it, and focus goes to the first field the server marked invalid in it (else where
 * the browser puts it). A dialog drawn closed, or already modal, is left as it is.
 * @param {HTMLDialogElement} dialog
 */
export function modal(dialog) {
  if (!dialog.open || dialog.matches(":modal")) return;
  // Without `open` rather than close(): no `close` event for a dialog the user saw stay open.
  dialog.removeAttribute("open");
  dialog.showModal();
  const invalid = dialog.querySelector('[aria-invalid="true"]');
  if (invalid instanceof HTMLElement) invalid.focus();
}

/**
 * `modal`, for a dialog the address opens (`?selected=it_1`) and a link closes: a close request
 * (Escape, Android's Back, a click outside a `closedby="any"` dialog, `requestClose()`) goes to
 * the close link's address without adding to the history (it does not click the link), so the
 * address, a reload and a redraw agree with what the user closed and Back cannot loop through it.
 * Where the entry before is that address, it goes back to it; otherwise, and in a browser without
 * the Navigation API, the link's address replaces the dialog's. It is a script's navigation, so
 * attributes on the link (`data-reload`, `data-keep-place`, an `on:click`) do not apply. Only
 * a `cancel` of this dialog: a file input's picker dismissed inside it fires one too, which
 * bubbles. A dialog drawn closed and opened later gets the same.
 * @param {HTMLDialogElement} dialog
 * @param {HTMLAnchorElement} close
 * @param {AbortSignal} signal
 */
export function modalClosedBy(dialog, close, signal) {
  modal(dialog);
  let followed = false;
  dialog.addEventListener(
    "cancel",
    (event) => {
      if (event.target !== dialog) return;
      // Followed once; a second close request before the page arrives (a slow or failed
      // navigation) closes the dialog as it would.
      if (followed) return;
      followed = true;
      // Open until the page without it replaces it, where the browser allows: Chromium does not
      // let a page keep a dialog open on Escape without a click since the last time (or since
      // the page loaded). The address changes either way.
      event.preventDefault();
      leave(close);
    },
    { signal },
  );
  // A browser that loads whole pages keeps this one as it was left in its back/forward cache;
  // restored there, closing it leaves again.
  addEventListener("pageshow", (event) => event.persisted && (followed = false), { signal });
}

/**
 * Says in a dialog that a `data-patch` submit inside it got no answer (`corten:error`), in place
 * of the page's `Toaster`, which a modal dialog covers and makes inert: the dialog's handler for
 * it (`on:corten:error={dialog::failed(event, said)}`), with `said` the element in the dialog that
 * holds the dialog's own text for it, drawn `hidden` with `role="alert"`. It is shown, so a screen
 * reader says it, and the toaster says nothing (`preventDefault()`). The next submit in the dialog
 * or its closing hides it again, so a second failure is said again.
 * @param {Event} event the `corten:error`
 * @param {HTMLElement} said
 */
export function failed(event, said) {
  event.preventDefault();
  said.hidden = false;
  const dialog = said.closest("dialog");
  if (!dialog) return;
  // One function per element, so a second failure adds no second listener.
  let hide = hiders.get(said);
  if (!hide) hiders.set(said, (hide = () => (said.hidden = true)));
  dialog.addEventListener("submit", hide, { once: true });
  dialog.addEventListener("close", hide, { once: true });
}

/** What hides each dialog's failed text. @type {WeakMap<HTMLElement, () => void>} */
const hiders = new WeakMap();

/**
 * To `close`'s address without a new history entry: back, when the entry before is it, else in
 * place of this one.
 * @param {HTMLAnchorElement} close
 */
function leave(close) {
  const href = close.href;
  const navigation = /** @type {any} */ (window).navigation;
  if (!navigation) return location.replace(href);
  const at = navigation.currentEntry?.index ?? -1;
  if (at > 0 && navigation.entries()[at - 1]?.url === href) navigation.back();
  else navigation.navigate(href, { history: "replace" });
}
