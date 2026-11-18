// Closes dialogs while the old page is still in place and hands off their queued events.

const { contains } = Node.prototype;
const { getAttribute, querySelector, querySelectorAll } = Element.prototype;

/** @typedef {[Element | null, string, Element | DocumentFragment | null]} Target */

/** @param {Iterable<Target>} targets */
export function independent(targets) {
  /** @type {Target[]} */
  const earlier = [];
  for (const step of targets) {
    const [target, id] = step;
    // A remove before a redraw of its parent is unambiguous. Other dependencies would
    // let a fragment move a dialog or opener the close plan still needs.
    if (earlier.some(([old, , added]) => contains.call(/** @type {Element} */ (old), target) || (added && (
      (target && contains.call(target, old)) || (id && (added instanceof Element
        ? getAttribute.call(added, "id") === id || querySelector.call(added, `#${CSS.escape(id)}`)
        : added.getElementById(id)))
    )))) {
      console.error("corten: overlapping dialog patch");
      return false;
    }
    if (target) earlier.push(step);
  }
  return true;
}

/**
 * Observe the whole batch before the first close: a handler can close another planned dialog.
 * If a close handler changes the tree or starts a new session, leave those changes in place
 * without drawing. Once drawing, targets are resolved anew, but the sessions must still hold.
 * @param {Map<HTMLDialogElement, boolean>} shut whether each close has a counterpart
 * @param {(valid?: () => boolean) => boolean | void} draw @param {Pick<AbortSignal, "aborted">} [signal]
 */
export function closeDrawn(shut, draw, signal) {
  const todo = [...shut.keys()];
  const tree = new MutationObserver(() => {});
  const sessions = new MutationObserver(() => {});
  tree.observe(document, { subtree: true, childList: true, attributeFilter: ["id", "role", "aria-live"] });
  for (const dialog of todo) sessions.observe(dialog, { attributeFilter: ["open"] });
  const closed = new Set();
  let current = true;
  const valid = () => current && (current = !sessions.takeRecords().some((r) => r.target.getRootNode() === document));
  try {
    while (todo.length) {
      const focused = document.activeElement;
      let at = todo.length - 1;
      for (let i = at; i >= 0; i--) if (contains.call(todo[i], focused)) { at = i; break; }
      // Finish at a leaf, even if focus was in an ancestor or outside this group of dialogs.
      for (const [i, other] of todo.entries()) if (contains.call(todo[at], other)) at = i;
      const [dialog] = /** @type {[HTMLDialogElement]} */ (todo.splice(at, 1));
      if (!dialog.open) continue;
      dialog.close();
      const records = sessions.takeRecords();
      // Exactly one removal per session, including another dialog closed by this one's handler.
      for (const { target } of records) {
        const didClose = /** @type {HTMLDialogElement} */ (target);
        if (didClose.open || closed.has(didClose)) return false;
        closed.add(didClose);
      }
      if (dialog.open || tree.takeRecords().length || signal?.aborted) return false;
      for (const { target } of records) {
        const didClose = /** @type {HTMLDialogElement} */ (target);
        if (shut.get(didClose)) followClose(didClose);
      }
    }
    tree.disconnect();
    return draw(valid) !== false;
  } finally {
    tree.disconnect();
    sessions.disconnect();
  }
}

/** Queued native closes follow replacements, not ids. @type {WeakMap<HTMLDialogElement, (to: Element, root: boolean) => void>} */
export const pending = new WeakMap();

/** @param {HTMLDialogElement} dialog */
function followClose(dialog) {
  let on = dialog;
  // An actual change to `open` on this closed node, even if already undone, ends the session.
  // beforetoggle alone would also see canceled opening attempts, and misses attribute opens.
  const watch = new MutationObserver(stop);
  function stop() {
    watch.disconnect();
    if (pending.get(on) === move) pending.delete(on);
  }
  function track() {
    pending.set(on, move);
    watch.observe(on, { attributeFilter: ["open"] });
  }
  /** @param {Element} to @param {boolean} root */
  function move(to, root) {
    if (!(to instanceof HTMLDialogElement) || to.open || (!root && !getAttribute.call(on, "id"))) return;
    const opened = watch.takeRecords().length;
    stop();
    if (opened) return;
    to.returnValue = on.returnValue;
    on = to;
    track();
  }
  track();
  dialog.addEventListener("close", () => {
    const forward = pending.get(on) === move && !watch.takeRecords().length;
    stop();
    if (forward && on !== dialog && on.getRootNode() === document) on.dispatchEvent(new Event("close"));
  }, { once: true });
}
