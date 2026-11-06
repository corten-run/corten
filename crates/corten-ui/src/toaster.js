// @ts-check
// Toaster (toaster.rs). A patch replaces the message (#ui-toast) inside the toaster's live region,
// which stays rendered so the new message is announced. This shows the close button while there
// is a message and hides the message after `seconds` (0: until closed), waiting while the pointer
// is over the toaster, focus is in it or the page is hidden. A redirect's notice a page did not
// draw, which the runtime announces (`corten:notice`), replaces the message the same way, and so
// does the toaster's `failed` message when a submit got no answer (`corten:error`) that no
// handler took (`preventDefault()`); that one is marked `data-failed` and stays until closed, the
// next submit or another page, since the user has to act on it. A failed `Toast` the server drew
// carries the same mark and stays the same way.

/** @import { CortenNotice } from "corten" */

/** The message element: what the last patch put in the live region. @param {HTMLDivElement} status */
const message = (status) => /** @type {HTMLElement | null} */ (status.firstElementChild);

/**
 * @param {HTMLElement} root @param {HTMLDivElement} status @param {HTMLButtonElement} close
 * @param {HTMLTemplateElement} failed what to say when a submit got no answer
 * @param {number} seconds @param {AbortSignal} signal
 */
export function connect(root, status, close, failed, seconds, signal) {
  /** Why the timer waits: "pointer", "focus", "page". @type {Set<string>} */
  const waiting = new Set();
  let left = 0;
  let since = 0;
  let timer = 0;
  /** Whether `m` says a failure, which stays until closed. @param {Element | null} m */
  const failure = (m) => !!m && m.hasAttribute("data-failed");
  let stays = false;
  const stop = () => {
    if (timer) left -= performance.now() - since;
    clearTimeout(timer);
    timer = 0;
  };
  const run = () => {
    if (timer || seconds <= 0 || stays || close.hidden || waiting.size) return;
    since = performance.now();
    timer = setTimeout(() => {
      timer = 0;
      dismiss(status, close);
    }, Math.max(left, 0));
  };
  /** @param {string} why */
  const wait = (why) => {
    stop();
    waiting.add(why);
  };
  /** @param {string} why */
  const go = (why) => {
    waiting.delete(why);
    run();
  };
  // A new message (or none): the close button follows it, and the full time starts again.
  const show = () => {
    stop();
    const m = message(status);
    close.hidden = !m || m.hidden || !m.textContent?.trim();
    stays = failure(m);
    left = seconds * 1000;
    run();
  };
  const observer = new MutationObserver(show);
  observer.observe(status, { childList: true });
  root.addEventListener("pointerenter", () => wait("pointer"), { signal });
  root.addEventListener("pointerleave", () => go("pointer"), { signal });
  root.addEventListener("focusin", () => wait("focus"), { signal });
  root.addEventListener("focusout", (event) => root.contains(/** @type {Node | null} */ (event.relatedTarget)) || go("focus"), { signal });
  document.addEventListener("visibilitychange", () => (document.hidden ? wait("page") : go("page")), { signal });
  if (document.hidden) waiting.add("page");
  signal.addEventListener("abort", () => {
    observer.disconnect();
    stop();
  });
  /**
   * Puts `what` in place of the message, as a patch would, marked `data-failed` when it says a
   * submit failed, so a stylesheet can draw it as a failure.
   * @param {Node} what @param {boolean} marked
   */
  const say = (what, marked) => {
    const m = message(status);
    if (!m) return;
    const next = /** @type {HTMLElement} */ (m.cloneNode(false));
    next.hidden = false;
    next.toggleAttribute("data-failed", marked);
    next.replaceChildren(what);
    m.replaceWith(next);
  };
  // A redirect's notice the runtime brought: a navigation's page, whose layout did not run.
  document.addEventListener(
    "corten:notice",
    (event) => say(document.createTextNode(/** @type {CortenNotice} */ (event).detail.message), false),
    { signal },
  );
  // A submit that got no answer the runtime could draw, which no handler took: read once every
  // listener has run, so one a page added on `document` after this one still counts.
  document.addEventListener(
    "corten:error",
    (event) =>
      queueMicrotask(() => {
        if (event.defaultPrevented || !failed.content.textContent?.trim()) return;
        say(failed.content.cloneNode(true), true);
      }),
    { signal },
  );
  // The failure is about the submit that failed: the next submit, or another page, takes it away.
  const over = () => {
    const m = message(status);
    if (failure(m)) dismiss(status, close);
  };
  // A dialog's own form (method="dialog") closes the dialog and sends nothing.
  document.addEventListener(
    "submit",
    (event) => {
      const submit = /** @type {SubmitEvent} */ (event);
      const method = submit.submitter?.getAttribute("formmethod") ?? /** @type {HTMLFormElement} */ (event.target).getAttribute("method");
      if (method?.trim().toLowerCase() !== "dialog") over();
    },
    { capture: true, signal },
  );
  // Another page: not the page changing its own address (a tab's replaceState, a link to a place
  // on it), a download, or the page reading itself again.
  /** @type {any} */ (globalThis).navigation?.addEventListener(
    "navigate",
    (/** @type {any} */ event) => {
      const page = (/** @type {string} */ url) => url.split("#")[0];
      const own = event.hashChange || event.downloadRequest !== null || (event.destination.sameDocument && event.navigationType !== "traverse");
      if (!own && page(event.destination.url) !== page(location.href)) over();
    },
    { signal },
  );
  // The page came with a message: an answer without the runtime, or a first load.
  show();
}

/** Hides the message and the button. @param {HTMLDivElement} status @param {HTMLButtonElement} close */
export function dismiss(status, close) {
  const m = message(status);
  if (m) m.hidden = true;
  close.hidden = true;
}