// @ts-check
// Toaster (toaster.rs). A patch replaces the message (#ui-toast) inside the toaster's live region,
// which stays rendered so the new message is announced. This shows the close button while there
// is a message and hides the message after `seconds` (0: until closed), waiting while the pointer
// is over the toaster, focus is in it or the page is hidden. A redirect's notice a page did not
// draw, which the runtime announces (`corten:notice`), replaces the message the same way, and so
// does the toaster's `failed` message when a submit got no answer (`corten:error`) that no
// handler took (`preventDefault()`); that one stays until closed, since the user has to act on it.

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
  /** Messages that stay until closed: the failures this script put in. @type {WeakSet<Element>} */
  const failures = new WeakSet();
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
    stays = !!m && failures.has(m);
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
  /** Puts `what` in place of the message, as a patch would. @param {Node} what */
  const say = (what) => {
    const m = message(status);
    if (!m) return null;
    const next = /** @type {HTMLElement} */ (m.cloneNode(false));
    next.hidden = false;
    next.replaceChildren(what);
    m.replaceWith(next);
    return next;
  };
  // A redirect's notice the runtime brought: a navigation's page, whose layout did not run.
  document.addEventListener(
    "corten:notice",
    (event) => say(document.createTextNode(/** @type {CustomEvent<{ message: string }>} */ (event).detail.message)),
    { signal },
  );
  // A submit that got no answer the runtime could draw, which no handler on its way here took.
  document.addEventListener(
    "corten:error",
    (event) => {
      if (event.defaultPrevented) return;
      const next = say(failed.content.cloneNode(true));
      if (next) failures.add(next);
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