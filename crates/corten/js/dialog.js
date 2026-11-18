// Loaded when an answer draws a closed dialog. The runtime resolves the targets and the layout
// matches; this module closes those dialogs while the old page is still in place.

const { contains } = Node.prototype;
const { getAttribute, querySelector, querySelectorAll } = Element.prototype;

/**
 * A replaced root, or a dialog by id within it, has a counterpart. Anonymous children of a
 * replacement are removed, not closed.
 * @param {Element} root @param {Element} fresh @param {HTMLDialogElement[]} shut
 * @param {WeakMap<Element, boolean>} served
 */
export function collect(root, fresh, shut, served) {
  for (const dialog of [root, ...Array.from(querySelectorAll.call(root, "dialog[open][id]"))]) {
    if (!(dialog instanceof HTMLDialogElement) || !dialog.open || !served.get(dialog)) continue;
    const id = getAttribute.call(dialog, "id");
    const to = dialog === root ? fresh : id && querySelector.call(fresh, `#${CSS.escape(id)}`);
    if (to instanceof HTMLDialogElement && !to.open) shut.push(dialog);
  }
}

/** @param {WeakMap<Element, boolean>} served */
export function patchPlan(served) {
  /** @type {[Element, string, Element | DocumentFragment | null][]} */
  const plan = [];
  /** @type {HTMLDialogElement[]} */
  const shut = [];
  return {
    /** @param {Element | null} target @param {string} id @param {Element | DocumentFragment | null} insert */
    add(target, id, insert) {
      // A remove before a redraw of its parent is unambiguous. Otherwise a later fragment must
      // not depend on a node the plan itself moves out of or into the page.
      if (plan.some(([old, , added]) => contains.call(old, target) || (added && (
        (target && contains.call(target, old)) || (id && (added instanceof Element
          ? getAttribute.call(added, "id") === id || querySelector.call(added, `#${CSS.escape(id)}`)
          : added.getElementById(id)))
      )))) {
        console.error("corten: overlapping dialog patch");
        return false;
      }
      if (target) {
        if (insert instanceof Element) collect(target, insert, shut, served);
        plan.push([target, id, insert]);
      }
      return true;
    },
    /** @param {(...step: [Element, string, Element | DocumentFragment | null]) => void} draw @param {AbortSignal} [signal] */
    run(draw, signal) {
      if (!closeDrawn(shut.filter((dialog) => !plan.some(([old, , added]) => !added && contains.call(old, dialog))), signal)) return false;
      for (const step of plan) draw(...step);
      return true;
    },
  };
}

/**
 * Close before detaching any opener. If synchronous handlers change the tree or its ids, the
 * plan may no longer be valid: leave their changes and the completed closes, but don't draw.
 * @param {HTMLDialogElement[]} shut @param {AbortSignal} [signal]
 */
export function closeDrawn(shut, signal) {
  if (!shut.length) return true;
  const tree = new MutationObserver(() => {});
  tree.observe(document, { subtree: true, childList: true, attributeFilter: ["id"] });
  try {
    while (shut.length) {
      const focused = document.activeElement;
      let at = shut.length - 1;
      for (let i = at; i >= 0; i--) if (contains.call(shut[i], focused)) { at = i; break; }
      // Finish at a leaf, even if focus was in an ancestor or outside this group of dialogs.
      for (const [i, other] of shut.entries()) if (contains.call(shut[at], other)) at = i;
      const [dialog] = /** @type {[HTMLDialogElement]} */ (shut.splice(at, 1));
      if (!dialog.open) continue;
      dialog.close();
      followClose(dialog);
      if (tree.takeRecords().length || signal?.aborted) return false;
    }
    return true;
  } finally {
    tree.disconnect();
  }
}

/** Queued native closes follow replacements, not ids. @type {WeakMap<HTMLDialogElement, (to: HTMLDialogElement) => void>} */
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
  /** @param {HTMLDialogElement} to */
  function move(to) {
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
