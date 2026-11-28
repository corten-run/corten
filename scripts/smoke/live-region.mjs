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
      if (!region?.isConnected) return false;
      for (let element = region; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (element.matches('[hidden], [inert], [aria-hidden="true" i]') ||
          style.display === "none" || style.visibility !== "visible") return false;
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
    const text = message.textContent;
    const replacement = () => {
      const next = document.getElementById(id);
      return ready && !message.isConnected && next?.parentElement === region && exposed() &&
        region?.getAttribute("role") === role && region?.getAttribute("aria-live") === ariaLive ? next : null;
    };
    return { text, replacement };
  }, id);

  /** @param {number} [timeout] For a spontaneous update, wait for a replacement with different text. */
  async function after(timeout) {
    try {
      if (timeout === undefined) return await before.evaluate(({ replacement }) => replacement()?.textContent ?? null);
      const changed = await page.waitForFunction(({ replacement, text }) => {
        const next = replacement();
        return next && next.textContent !== text && { text: next.textContent };
      }, before, { timeout });
      try {
        return (await changed.jsonValue()).text;
      } finally {
        await changed.dispose();
      }
    } catch (error) {
      if (error?.name === "TimeoutError") return null;
      throw error;
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
