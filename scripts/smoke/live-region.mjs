/** Capture the message and its region before the action, then check their identities after it.
 * @param {import("@playwright/test").Page} page
 * @param {string} id
 */
export async function liveRegion(page, id) {
  const before = await page.locator(`#${id}`).evaluateHandle((message) => {
    const region = message.parentElement;
    const rendered = region && getComputedStyle(region).display !== "none" && getComputedStyle(region).visibility === "visible";
    return { message, region, rendered };
  });
  return async () => {
    try {
      return await before.evaluate(({ message, region, rendered }) =>
        rendered && !message.isConnected && document.getElementById(message.id)?.parentElement === region &&
        (region?.getAttribute("role") === "status" || region?.getAttribute("aria-live") === "polite"));
    } finally {
      await before.dispose();
    }
  };
}
