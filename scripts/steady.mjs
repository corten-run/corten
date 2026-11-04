// @ts-check
// Chromium aborts a navigation in flight with `net::ERR_NETWORK_CHANGED` when the machine's network
// interfaces change, which on a CI runner is Docker adding or removing a bridge while a smoke runs
// (#497). That says nothing about the app, so a smoke's `goto` and `reload` try once more on
// that error alone; any other failure, a second one included, still fails the smoke. Chromium
// answers the aborted navigation with its own error page (`chrome-error://chromewebdata/`), which
// would interrupt a retry made at once (#839), so the retry waits for that page first.

const CHANGED = "net::ERR_NETWORK_CHANGED";

/**
 * Returns `browser`, every page it opens from now on (`newPage`, or `newContext` then
 * `newPage`) retrying `goto` and `reload` once on `ERR_NETWORK_CHANGED`.
 * @template {import("@playwright/test").Browser} B
 * @param {B} browser
 * @returns {B}
 */
export function steady(browser) {
  const newContext = browser.newContext.bind(browser);
  // `browser.newPage` makes its context through `browser.newContext`, so this covers it too.
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => retrying(await newPage());
    return context;
  };
  return browser;
}

/**
 * `page`, its `goto` and `reload` trying once more on `error` (exported for the smoke's check,
 * which aborts a navigation with an error it can make).
 * @param {import("@playwright/test").Page} page
 * @param {string} [error]
 * @returns {import("@playwright/test").Page}
 */
export function retrying(page, error = CHANGED) {
  for (const name of /** @type {const} */ (["goto", "reload"])) {
    /** @type {(...args: any[]) => Promise<any>} */
    const call = page[name].bind(page);
    /** @type {any} */ (page)[name] = async (/** @type {any[]} */ ...args) => {
      try {
        return await call(...args);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes(error)) throw e;
        console.log(`retry ${name}: ${error} (#497)`);
        await settled(page);
        return call(...args);
      }
    };
  }
  return page;
}

/**
 * Once the navigation that failed has given way to Chromium's error page, if one comes: its own
 * navigation would interrupt the retry. Only Chromium reports `ERR_NETWORK_CHANGED`, so only
 * Chromium's pages wait here; the 5 seconds bound a page that shows no error page.
 * @param {import("@playwright/test").Page} page
 */
async function settled(page) {
  const error = (/** @type {string} */ url) => url.startsWith("chrome-error://");
  if (!error(page.url())) {
    await page
      .waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() && error(frame.url()), timeout: 5000 })
      .catch(() => {});
  }
  await page.waitForLoadState("load").catch(() => {});
}
