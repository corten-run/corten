import { browserBug } from "../../../scripts/browser-bugs.mjs";
import { base, check } from "./helpers.mjs";

export async function openGallery(browser) {
  // A console error the browser logs for its own bug (scripts/browser-bugs.mjs) is not the page's.
  const bug = browserBug(browser);
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && !bug(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  /** @type {string[]} */
  const failed = [];
  /** @param {import("@playwright/test").Request} r */
  const lost = (r) => failed.push(`${new URL(r.url()).pathname} ${r.failure()?.errorText}`);
  /** @param {import("@playwright/test").Response} r */
  const refused = (r) => r.status() >= 400 && failed.push(`${new URL(r.url()).pathname} ${r.status()}`);
  page.on("requestfailed", lost);
  page.on("response", refused);
  await page.goto(`${base}/`);
  // The combo box's input shows once its script connects (#252): on a timeout, say what had
  // loaded and what failed rather than throwing without the engine.
  const connected = await page
    .waitForFunction(() => document.querySelector('[data-scope=ui-combo-box] [role="combobox"]:not([hidden])') !== null)
    .then(() => true)
    .catch(() => false);
  if (!connected) {
    // The page may have crashed or gone: say so rather than lose the rest of the report.
    const state = await page
      .evaluate(() => ({
        readyState: document.readyState,
        scripts: performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/scripts/") || n.includes("corten")).map((n) => new URL(n).pathname),
      }))
      .catch((e) => ({ readyState: `unavailable: ${e instanceof Error ? e.message : e}`, scripts: [] }));
    check("the first page's combo box connects", false, JSON.stringify({ ...state, failed, errors }));
    return;
  }
  // Only the first load's: the gallery's refused forms answer 422 later, as they should.
  page.off("requestfailed", lost);
  page.off("response", refused);
  const loaded = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/scripts/")).length);
  check("the eighteen scripts load and connect", loaded === 18, `${loaded} script(s)`);
  return { page, bug, errors };
}

export async function noConsoleErrors(errors) {
  // The refused renames are 422s and the refused publishes 409s, which Chromium and WebKit log;
  // nothing else may be. WebKit also
  // reports a request to the gallery's own origin that did not finish (the hover prefetch of
  // /?sale=last, or a load the next navigation dropped) as a fetch that "cannot load
  // http://localhost:18482/?sale=last due to access control checks"; Playwright splits that page
  // error at its first colon, so the text here starts "/localhost:18482/?sale=last" (#301). A
  // request to its own origin is never refused by CORS, so only another origin's still counts.
  const ownOrigin = `/${new URL(base).host}/`;
  const unexpected = errors.filter((e) => {
    const refused = /(\S+) due to access control checks/.exec(e)?.[1];
    return !/status of (422|409)/.test(e) && !refused?.startsWith(ownOrigin);
  });
  check("no console errors", unexpected.length === 0, unexpected.join(" | "));
}

export async function openOrders(browser, bug) {
  // The orders page: the kit's other components, each as plain HTML that works before any script.
  const orders = await (await browser.newContext()).newPage();
  const ordersErrors = [];
  orders.on("console", (m) => m.type() === "error" && !bug(m.text()) && ordersErrors.push(m.text()));
  orders.on("pageerror", (e) => ordersErrors.push(e.message));
  await orders.goto(`${base}/orders`);
  return { orders, ordersErrors };
}
