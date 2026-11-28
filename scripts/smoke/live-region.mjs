/** Capture the message and its exposed live region before the action, then check the replacement.
 * @param {import("@playwright/test").Page} page
 * @param {string} id
 */
export async function liveRegion(page, id) {
  const before = await page.evaluateHandle((id) => {
    const message = document.getElementById(id);
    if (!message) throw new Error(`Missing live message: ${id}`);
    const region = message.parentElement;
    const exposed = () => {
      if (!region?.isConnected ||
        !region.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) return false;
      for (let element = region; element; element = element.parentElement) {
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
    const live = ariaLive !== "off" && (role === "status" || role === "alert" || role === "log" ||
      ariaLive === "polite" || ariaLive === "assertive");
    const ready = live && exposed();
    const stillLive = () => exposed() && region.getAttribute("role") === role && region.getAttribute("aria-live") === ariaLive;
    const text = message.textContent;
    let accepted = null;
    let changed = null;
    let notify = () => {};
    const exposureAttributes = ["aria-hidden", "aria-live", "class", "hidden", "inert", "open", "role", "style"];
    const record = (records) => {
      const next = document.getElementById(id);
      if (!next || message.isConnected || next.parentElement !== region) return;
      // Visibility is read at the mutation checkpoint. Don't use a later exposure change in the
      // same batch as evidence that the message was exposed when inserted.
      const index = records.findIndex(({ addedNodes }) => Array.from(addedNodes).includes(next));
      if (index < 0 || records.slice(index + 1).some(({ type }) => type === "attributes")) return;
      if (!stillLive()) return;
      accepted = next;
      if (changed === null && next.textContent !== text) {
        changed = next.textContent;
        notify();
      }
    };
    const observer = new MutationObserver(record);
    const flush = () => record(observer.takeRecords());
    const beforeToggle = (event) => {
      // A modal can close in the same task as a patch. Read pending mutations while it is still
      // modal, not after the close has made the rest of the document interactive again.
      if (event.target instanceof HTMLDialogElement) flush();
    };
    if (ready) {
      observer.observe(region, { childList: true, attributeFilter: exposureAttributes });
      for (let element = region.parentElement; element; element = element.parentElement) {
        observer.observe(element, { attributeFilter: exposureAttributes });
      }
      document.addEventListener("beforetoggle", beforeToggle, true);
    }
    const after = async (timeout) => {
      let timer;
      try {
        if (!ready) return null;
        flush();
        if (timeout === undefined) {
          return accepted && !message.isConnected && document.getElementById(id) === accepted &&
            accepted.parentElement === region && stillLive() ? accepted.textContent : null;
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
        observer.disconnect();
        document.removeEventListener("beforetoggle", beforeToggle, true);
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
