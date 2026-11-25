import { base, skip, check } from "./helpers.mjs";

/**
 * A write whose answer never comes, after a read of the page drew over the form that sent it:
 * the page the read drew still says the write failed (#2068). Each case holds the read and the
 * write at the route until the case has made the press and the read has drawn, never for a fixed
 * time, and presses in the page.
 * @param {import("@playwright/test").Browser} browser
 */
export async function writeFailures(browser) {
  for (const [name, to, whole] of [
    ["a write that fails after a navigation drew the same page over its form says so on the form in its place", "/", false],
    ["a write that fails after a navigation drew another page over its form says so on the document", "/alerts", false],
    ["a write that fails after a whole page read drew over its form says so on the form in its place", "/", true],
  ] /** @type {const} */) {
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(`${base}/`, { waitUntil: "load" });
      if (!(await page.evaluate(() => "navigation" in window))) {
        skip(name, "without the Navigation API a navigation is a full load");
        continue;
      }
      /** @type {() => void} */
      let releaseRead = () => {};
      const readLetGo = new Promise((resolve) => (releaseRead = () => resolve(undefined)));
      /** @type {() => void} */
      let readHeard = () => {};
      const readHeld = new Promise((resolve) => (readHeard = () => resolve(undefined)));
      await page.route(`${base}${to}`, async (route) => {
        if (route.request().headers().corten !== (whole ? "page" : "nav")) return route.continue().catch(() => {});
        readHeard();
        await readLetGo;
        await route.continue().catch(() => {});
      });
      // The whole page read is the one a write's redirect sends the page on: the first post is
      // answered with Corten's redirect to the page itself; the next post fails once let go.
      let posts = 0;
      /** @type {() => void} */
      let failPost = () => {};
      const postLetGo = new Promise((resolve) => (failPost = () => resolve(undefined)));
      /** @type {() => void} */
      let postHeard = () => {};
      const postHeld = new Promise((resolve) => (postHeard = () => resolve(undefined)));
      await page.route("**/watch", async (route) => {
        posts += 1;
        if (whole && posts === 1) return route.fulfill({ status: 200, headers: { "corten-location": "/" }, body: "" }).catch(() => {});
        postHeard();
        await postLetGo;
        await route.abort("failed").catch(() => {});
      });
      // What heard the failure: the form that sent it (on the form itself, connected or not),
      // and the page (on the window). The form's `<select name="id">` shadows its `id`.
      await page.evaluate(() => {
        const state = /** @type {any} */ (window);
        state.__sent = document.getElementById("watch-form");
        state.__heard = [];
        state.__sent.addEventListener("corten:error", () => state.__heard.push(`sent form, connected=${state.__sent.isConnected}`));
        addEventListener("corten:error", (/** @type {Event} */ event) => {
          const at = /** @type {Element | Document} */ (event.target);
          state.__heard.push(`window, from ${at === document ? "document" : `${/** @type {Element} */ (at).localName}#${Element.prototype.getAttribute.call(at, "id")}`}, status ${/** @type {CustomEvent} */ (event).detail.status}`);
        });
      });
      const press = () => page.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector("#watch-form button")).click());
      let heldBoth = false;
      try {
        if (whole) await press();
        else await page.evaluate((to) => /** @type {HTMLAnchorElement} */ (document.querySelector(`header a[href="${to}"]`)).click(), to);
        const read = await Promise.race([readHeld.then(() => true), page.waitForTimeout(5000).then(() => false)]);
        // The press meets the read still on its way, on the form it will draw over.
        if (read) await press();
        heldBoth = read && (await Promise.race([postHeld.then(() => true), page.waitForTimeout(5000).then(() => false)]));
      } finally {
        releaseRead();
      }
      const drawn = await page
        .waitForFunction(
          (to) => location.pathname === to && document.getElementById("watch-form") !== (/** @type {any} */ (window)).__sent && !document.querySelector("main[aria-busy]"),
          to,
          { timeout: 5000 },
        )
        .then(() => true, () => false);
      failPost();
      const heard = await page
        .waitForFunction(() => (/** @type {any} */ (window)).__heard.length > 0, null, { timeout: 5000 })
        .then(() => true, () => false);
      // The window hears it after the document, where the form's own handler ran: its note is shown by now.
      const outcome = await page.evaluate(() => {
        const note = document.querySelector("#watch-form [role=alert]");
        return { heard: /** @type {any} */ (window).__heard, note: note ? !(/** @type {HTMLElement} */ (note).hidden) : null };
      });
      const onPage = outcome.heard.some((/** @type {string} */ h) => h.startsWith(to === "/" ? "window, from form#watch-form, status 0" : "window, from document, status 0"));
      check(name, heldBoth && drawn && heard && onPage && (to === "/" ? outcome.note === true : outcome.note === null), JSON.stringify({ heldBoth, drawn, heard, ...outcome }));
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.context().close();
    }
  }
}