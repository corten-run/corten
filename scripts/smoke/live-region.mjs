/** Check that a patch replaces a plain-text message inside its already exposed live region.
 * @param {import("@playwright/test").Page} page
 * @param {string} id
 */
export async function liveRegion(page, id) {
  const before = await page.evaluateHandle((id) => {
    const message = document.getElementById(id);
    if (!message) throw new Error(`Missing live message: ${id}`);
    const region = message.parentElement;
    const exposed = (node) => {
      if (!node?.isConnected ||
        !node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) return false;
      for (let element = node; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (element.matches('[hidden], [inert], [aria-hidden="true" i]') ||
          style.display === "none" || style.visibility !== "visible" || style.contentVisibility === "hidden") return false;
        const parent = element.parentElement;
        if (parent instanceof HTMLDetailsElement && !parent.open &&
          element !== parent.querySelector(":scope > summary")) return false;
      }
      // A modal makes the rest of the document inert without setting an attribute on it.
      // With stacked modals, document order cannot tell us which is on top; refuse to guess.
      const modals = document.querySelectorAll("dialog:modal");
      return modals.length === 0 || (modals.length === 1 && modals[0].contains(region));
    };
    const role = region?.getAttribute("role");
    const ariaLive = region?.getAttribute("aria-live");
    const live = ':is([role="status"],[role="alert"],[role="log"],[aria-live="polite"],[aria-live="assertive"]):not([aria-live="off"])';
    // These examples patch text (or clear it), not a subtree with its own accessibility semantics.
    const plainMessage = (node) => node.childElementCount === 0 && !node.matches("[role], [aria-live]");
    const ready = region?.matches(live) && exposed(region) && plainMessage(message);
    const stillLive = () => exposed(region) && region.getAttribute("role") === role && region.getAttribute("aria-live") === ariaLive;
    const text = message.textContent;
    let current = message;
    const validReplacement = () => current.parentElement === region && !message.isConnected &&
      document.getElementById(id) === current && stillLive() && plainMessage(current) && exposed(current);
    let accepted = false;
    let changed = null;
    let notify = () => {};
    const prototype = Element.prototype;
    const replaceWith = prototype.replaceWith;
    const watching = Symbol.for("corten.smoke.live-region");
    // The runtime calls Element.prototype.replaceWith for a whole-element patch. Observe only
    // the tracked child, before and after that call, not the DOM at a later mutation checkpoint.
    function observeReplacement(...nodes) {
      const [next] = nodes;
      if (this !== current || this.parentElement !== region ||
        nodes.length !== 1 || !(next instanceof Element) || next === this || next.id !== id) {
        return replaceWith.apply(this, nodes);
      }
      const wasLive = stillLive();
      replaceWith.call(this, next);
      if (next.parentElement !== region || this.parentElement === region) return;
      current = next;
      accepted = wasLive && validReplacement();
      if (accepted && changed === null && next.textContent !== text) {
        changed = next.textContent;
        notify();
      }
    }
    if (ready) {
      if (replaceWith[watching]) throw new Error("Finish the current live-region check before starting another");
      observeReplacement[watching] = true;
      prototype.replaceWith = observeReplacement;
    }
    const after = async (timeout) => {
      let timer;
      try {
        if (!ready) return null;
        if (timeout === undefined) {
          return accepted && validReplacement() ? current.textContent : null;
        }
        if (changed === null) {
          await new Promise((resolve) => {
            notify = () => resolve(undefined);
            timer = setTimeout(notify, timeout);
          });
        }
        return changed;
      } finally {
        clearTimeout(timer);
        if (prototype.replaceWith === observeReplacement) prototype.replaceWith = replaceWith;
      }
    };
    return { text, after };
  }, id);

  /** @param {number} [timeout] For a spontaneous update, wait for a replacement with different text. */
  async function after(timeout) {
    try {
      return await before.evaluate(({ after }, timeout) => after(timeout), timeout);
    } finally {
      await before.dispose();
    }
  }
  return {
    text: await before.evaluate(({ text }) => text),
    stayed: async () => (await after()) !== null,
    /** @param {number} timeout */
    changed: (timeout) => after(timeout),
  };
}
