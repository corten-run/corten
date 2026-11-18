// @ts-check
// corten_ui::dialog. The platform opens a dialog as a modal only from a script (`showModal`) or a
// click (`command="show-modal"`): a dialog the server draws `open` (a refused form, a result to
// read) is open but not modal. `modal` makes it modal when it joins the page. `failed` says in a
// dialog that a submit inside it got no answer, where the page's toaster cannot be seen.

/** @import { CortenError } from "corten" */

/** @typedef {{ signal: AbortSignal }} ModalLife */

let opened = 0;
/** @type {{ order: number, finish: () => void }[]} */
const removed = [];

/** @param {number} order @param {() => void} finish */
function afterRemoval(order, finish) {
  // Signals abort in lifetime order, not top-layer order. Finish after the removal sweep,
  // newest modal first, so the outermost opener gets focus last.
  if (!removed.length) queueMicrotask(() => {
    for (const close of removed.splice(0).sort((a, b) => b.order - a.order)) close.finish();
  });
  removed.push({ order, finish });
}

/**
 * A dialog drawn `open` becomes modal: in the top layer over a backdrop, the page behind it inert,
 * Escape closes it, and focus goes to the first field the server marked invalid in it (else where
 * the browser puts it). A dialog drawn closed, or already modal, is left as it is.
 * On removal while still open, restore opener focus where possible and send one non-bubbling
 * `close` to a closed replacement with the same id. A replacement drawn open starts its own life.
 * @param {HTMLDialogElement} dialog
 * @param {ModalLife} options
 */
export function modal(dialog, options) {
  if (!dialog.open || dialog.matches(":modal")) return;
  const doc = dialog.ownerDocument;
  const opener = doc.activeElement;
  const openerId = opener?.id;
  const order = ++opened;
  // Without `open` rather than close(): no `close` event for a dialog the user saw stay open.
  dialog.removeAttribute("open");
  dialog.showModal();
  const signal = options?.signal;
  if (signal && !signal.aborted && dialog.matches(":modal")) {
    let sameSession = true;
    dialog.addEventListener("beforetoggle", (event) => {
      if (event.isTrusted) sameSession = false;
    }, { signal });
    signal.addEventListener("abort", () => {
      // Removing a modal takes it out of the top layer but leaves its open attribute. A
      // native close (even if the dialog then reopens) or removal of open is not ours to report.
      if (!sameSession || dialog.isConnected || !dialog.open) return;
      const next = dialog.id ? doc.getElementById(dialog.id) : null;
      if (next instanceof HTMLDialogElement && next.open) return;
      afterRemoval(order, () => {
        if (dialog.isConnected || (next instanceof HTMLDialogElement && next.open)) return;
        const back = opener?.isConnected ? opener : openerId ? doc.getElementById(openerId) : null;
        if (back instanceof HTMLElement && back.localName === opener?.localName) back.focus({ preventScroll: true });
        // Focusing, or a nested dialog's close handler, can change the tree. Never retarget
        // the event to some other element that has since taken this id.
        if (next instanceof HTMLDialogElement && next.isConnected && !next.open) {
          next.returnValue = dialog.returnValue;
          next.dispatchEvent(new Event("close"));
        }
      });
    }, { once: true });
  }
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
 * bubbles. A dialog drawn closed and opened later gets the same. The modal's removal and
 * replacement use the same focus and `close` behavior as `modal`.
 * @param {HTMLDialogElement} dialog
 * @param {HTMLAnchorElement} close
 * @param {AbortSignal} signal
 */
export function modalClosedBy(dialog, close, signal) {
  modal(dialog, { signal });
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
 * it (`on:corten:error={dialog::failed(event, target, said)}`), with `said` the dialog's own text
 * for it, drawn `hidden` inside a live region (`role="alert"`) that stays rendered, so showing it
 * adds text to a region that is already there, the pattern a screen reader announces (not tried
 * with one). The toaster then says nothing
 * (`preventDefault()`). The next submit in the dialog or its closing hides it again, so a second
 * failure is said again. A dialog closed by the time the failure comes (Escape while the submit
 * was on its way) shows nothing, and the toaster says it.
 * @param {CortenError} event the `corten:error`
 * @param {HTMLDialogElement} dialog
 * @param {HTMLElement} said
 */
export function failed(event, dialog, said) {
  if (!dialog.open) return;
  event.preventDefault();
  said.hidden = false;
  const done = new AbortController();
  const hide = () => {
    said.hidden = true;
    done.abort();
  };
  dialog.addEventListener("submit", hide, { signal: done.signal });
  dialog.addEventListener("close", hide, { signal: done.signal });
}

/**
 * To `close`'s address without a new history entry: back, when the entry before is it, else in
 * place of this one.
 * @param {HTMLAnchorElement} close
 */
function leave(close) {
  const href = close.href;
  const navigation = /** @type {Navigation | undefined} */ (window.navigation);
  if (!navigation) return location.replace(href);
  const at = navigation.currentEntry?.index ?? -1;
  if (at > 0 && navigation.entries()[at - 1]?.url === href) navigation.back();
  else navigation.navigate(href, { history: "replace" });
}
