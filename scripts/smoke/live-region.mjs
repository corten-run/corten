/** Capture the message and its rendered live region before the action, then check the replacement.
 * @param {import("@playwright/test").Page} page
 * @param {string} id
 */
export async function liveRegion(page, id) {
  const before = await page.locator(`#${id}`).evaluateHandle((message) => {
    const region = message.parentElement;
    const rendered = () => {
      for (let element = region; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (element.hasAttribute("hidden") || style.display === "none" || style.visibility !== "visible") return false;
      }
      return region?.isConnected === true;
    };
    const role = region?.getAttribute("role");
    const ariaLive = region?.getAttribute("aria-live");
    const live = ariaLive !== "off" && (role === "status" || role === "alert" || role === "log" ||
      ariaLive === "polite" || ariaLive === "assertive");
    return { message, id: message.id, text: message.textContent, region, rendered, ready: live && rendered(), role, ariaLive };
  });
  return {
    text: await before.evaluate(({ text }) => text),
    /** @param {number} [timeout] When the update is spontaneous, wait for this message to be replaced. */
    async stayed(timeout) {
      try {
        if (timeout !== undefined) {
          const replaced = await page.waitForFunction(({ message, id }) =>
            !message.isConnected && document.getElementById(id) !== null, before, { timeout });
          await replaced.dispose();
        }
        return await before.evaluate(({ message, id, region, rendered, ready, role, ariaLive }) =>
          ready && !message.isConnected && document.getElementById(id)?.parentElement === region &&
          rendered() && region?.getAttribute("role") === role && region?.getAttribute("aria-live") === ariaLive);
      } catch (error) {
        if (error?.name === "TimeoutError") return false;
        throw error;
      } finally {
        await before.dispose();
      }
    },
  };
}
