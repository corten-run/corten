// @ts-check
// Chromium aborts a navigation in flight with `net::ERR_NETWORK_CHANGED` when the machine's network
// interfaces change, which on a CI runner is Docker adding or removing a bridge while a smoke runs
// (#497). That says nothing about the app, so a smoke's `goto` and `reload` try once more on
// that error alone; any other failure, a second one included, still fails the smoke. Chromium
// answers the aborted navigation with its own error page (`chrome-error://chromewebdata/`), which
// would interrupt a retry made at once (#839), so the retry waits for that page first. A resource
// the page loads (an image, a stylesheet) can be aborted the same way, which Chromium logs as a
// console error the page did not cause; a smoke's console listeners are not told of that line
// (#904), and a check that needed the resource still fails on its own. What the runtime logs of
// its own for a loss it recovers from (a script module, a feed's snapshot) is still seen. A
// console error a browser logs for a bug of its own is `scripts/browser-bugs.mjs`'s, which each
// smoke asks; this one is the network's, as a navigation's is, so every page `steady` opens has it.

const CHANGED = "net::ERR_NETWORK_CHANGED";

/** What Chromium logs for a resource aborted by `ERR_NETWORK_CHANGED`. */
const ABORTED = `Failed to load resource: ${CHANGED}`;

/**
 * Returns `browser`, every page it opens from now on (`newPage`, or `newContext` then
 * `newPage`) retrying `goto` and `reload` once on `ERR_NETWORK_CHANGED`, and the console
 * listeners of every page in its contexts (a popup too) not told of a resource that error aborted
 * (`quiet`).
 * @template {import("@playwright/test").Browser} B
 * @param {B} browser
 * @returns {B}
 */
export function steady(browser) {
  const newContext = browser.newContext.bind(browser);
  // `browser.newPage` makes its context through `browser.newContext`, so this covers it too.
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    context.on("page", quiet);
    const newPage = context.newPage.bind(context);
    // Playwright emits "page" before `newPage` returns; `quiet` here is in case it does not.
    context.newPage = async () => quiet(retrying(await newPage()));
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
      // Watched from before the navigation, so an error page it gives way to is seen even when the
      // page already shows one from an earlier failure.
      const shown = errorPage(page);
      try {
        return await call(...args);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes(error)) throw e;
        console.log(`retry ${name}: ${error} (#497)`);
        await shown.settled();
        return call(...args);
      } finally {
        shown.stop();
      }
    };
  }
  return page;
}

/** The pages `quiet` has already filtered. */
const quieted = new WeakSet();

/**
 * `page`, the console error Chromium logs for a resource `ERR_NETWORK_CHANGED` aborted (that
 * exact text) never emitted, so no `console` listener nor `waitForEvent` is told of it; it is
 * logged instead. Playwright's context emits each event on the page, so filtering `emit` leaves
 * every way of listening as it was. Only the page's own: a context's or a worker's `console`
 * listeners and `page.consoleMessages()` still see the line.
 * @template {object} P
 * @param {P} page
 * @returns {P}
 */
export function quiet(page) {
  if (quieted.has(page)) return page;
  quieted.add(page);
  const target = /** @type {{ emit(event: string | symbol, ...args: any[]): boolean }} */ (/** @type {unknown} */ (page));
  const emit = target.emit.bind(page);
  target.emit = (event, ...args) => {
    const [message] = args;
    if (event === "console" && message.type() === "error" && message.text() === ABORTED) {
      console.log(`skip console error: ${ABORTED} (#904)`);
      return false;
    }
    return emit(event, ...args);
  };
  return page;
}

/**
 * Watches `page` for Chromium's error page. `settled` waits until the navigation that failed has
 * given way to it, if one comes (its own navigation would interrupt the retry), and it has loaded;
 * a page that shows none (another engine, another error) waits 5 seconds, and a load that does not
 * come (Firefox's error document fires none) 5 more. `stop` stops watching. An error page still
 * committing from an earlier navigation (a failed `goto` caught and followed at once) can be taken
 * for this one's, so a caller that goes on from a failure waits for its error page first.
 * @param {import("@playwright/test").Page} page
 */
function errorPage(page) {
  let shown = false;
  /** @type {() => void} */
  let done = () => {};
  const came = new Promise((resolve) => (done = () => resolve(undefined)));
  const watch = (/** @type {import("@playwright/test").Frame} */ frame) => {
    if (frame === page.mainFrame() && frame.url().startsWith("chrome-error://")) {
      shown = true;
      done();
    }
  };
  page.on("framenavigated", watch);
  return {
    async settled() {
      if (!shown) {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        await Promise.race([came, new Promise((resolve) => (timer = setTimeout(resolve, 5000)))]);
        clearTimeout(timer);
      }
      await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
    },
    stop: () => page.off("framenavigated", watch),
  };
}
