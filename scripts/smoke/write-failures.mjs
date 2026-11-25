import { base, skip, check, steps, cleanUp } from "./helpers.mjs";

/**
 * A write whose answer never comes, while a read of the page draws over the form that sent it:
 * the page the read drew still says the write failed, once, where it hears it (#2068). The form a
 * read drew in its place hears it when the read drew the same page; the document does when it
 * drew another, a page with a form of the same id included. A failure that comes while the read is
 * still on its way is said once the read has drawn, so the draw does not take it away. Each case
 * holds the read and the write at the route until the case has made the press and the read has
 * drawn (or the write has failed), never for a fixed time, presses in the page, and runs under one
 * deadline.
 * @param {import("@playwright/test").Browser} browser
 */
export async function writeFailures(browser) {
  /** @type {[string, string, "link" | "script" | "write", "after" | "before", "successor" | "document"][]} */
  const cases = [
    ["a write that fails after a navigation drew the same page over its form says so on the form in its place", "/", "link", "after", "successor"],
    ["a write that fails after a navigation drew another page over its form says so on the document", "/alerts", "link", "after", "document"],
    ["a write that fails after a whole page read drew over its form says so on the form in its place", "/", "write", "after", "successor"],
    ["a write that fails after a navigation drew another address with a form of the same id says so on the document, not on that form", "/?again=1", "script", "after", "document"],
    ["a write that fails while a navigation to the same page is on its way says so once, on the form in its place, after the draw", "/", "link", "before", "successor"],
  ];
  for (const [name, to, start, fails, at] of cases) {
    const whole = start === "write";
    /** @type {() => void} */
    let releaseRead = () => {};
    const readLetGo = new Promise((resolve) => (releaseRead = () => resolve(undefined)));
    /** @type {() => void} */
    let failPost = () => {};
    const postLetGo = new Promise((resolve) => (failPost = () => resolve(undefined)));
    const context = await browser.newContext();
    /** @type {import("@playwright/test").Page | undefined} */
    let page;
    // Both gates open and the context closes however the case ends, each even when another step of
    // the teardown fails.
    try {
      page = await context.newPage();
      const p = page;
      const run = steps(20_000, "the case did not finish within 20 s");
      /** @type {Record<string, unknown>} */
      let seen = {};
      try {
        await run.step(() => p.goto(`${base}/`, { waitUntil: "load" }));
        if (!(await run.step(() => p.evaluate(() => "navigation" in window)))) {
          skip(name, "without the Navigation API a navigation is a full load");
          continue;
        }
        /** @type {() => void} */
        let readHeard = () => {};
        const readHeld = new Promise((resolve) => (readHeard = () => resolve(undefined)));
        await run.step(() =>
          p.route(
            (url) => url.href === `${base}${to}`,
            async (route) => {
              if (route.request().headers().corten !== (whole ? "page" : "nav")) return route.continue().catch(() => {});
              readHeard();
              await readLetGo;
              await route.continue().catch(() => {});
            },
          ),
        );
        // The whole page read is the one a write's redirect sends the page on: the first post is
        // answered with Corten's redirect to the page itself; the next post fails once let go.
        let posts = 0;
        /** @type {() => void} */
        let postHeard = () => {};
        const postHeld = new Promise((resolve) => (postHeard = () => resolve(undefined)));
        await run.step(() =>
          p.route("**/watch", async (route) => {
            posts += 1;
            if (whole && posts === 1) return route.fulfill({ status: 200, headers: { "corten-location": "/" }, body: "" }).catch(() => {});
            postHeard();
            await postLetGo;
            await route.abort("failed").catch(() => {});
          }),
        );
        // Every corten:error, once each: heard on the form that sent it (connected or not) and on
        // the window, which hears one on the document or on a form in the page. Where each went: the
        // form that sent it, the form with its id in the page then (the one in its place), another
        // element, or the document. The form's `<select name="id">` shadows its `id`.
        await run.step(() =>
          p.evaluate(() => {
            const state = /** @type {any} */ (window);
            state.__sent = document.getElementById("watch-form");
            /** @type {Map<Event, string>} */
            const events = new Map();
            state.__events = events;
            /** @param {Event} event */
            const note = (event) => {
              if (events.has(event)) return;
              const target = event.target;
              const where =
                target === document
                  ? "document"
                  : target === state.__sent
                    ? `sent form, connected=${state.__sent.isConnected}`
                    : target === document.getElementById("watch-form")
                      ? "form in its place"
                      : "another element";
              events.set(event, `${where}, status ${/** @type {CustomEvent} */ (event).detail.status}`);
            };
            state.__sent.addEventListener("corten:error", note);
            addEventListener("corten:error", note);
          }),
        );
        const press = () => p.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector("#watch-form button")).click());
        if (whole) await run.step(press);
        else if (start === "link") await run.step(() => p.evaluate((to) => /** @type {HTMLAnchorElement} */ (document.querySelector(`header a[href="${to}"]`)).click(), to));
        else await run.step(() => p.evaluate((to) => void (/** @type {any} */ (window)).navigation.navigate(to).finished.catch(() => {}), to));
        await run.step(() => readHeld);
        // The press meets the read still on its way, on the form it will draw over.
        await run.step(press);
        await run.step(() => postHeld);
        /** Whether the read has drawn the page `to` over the form that sent the write. */
        const drawn = () =>
          run.step(() =>
            p.waitForFunction(
              (to) =>
                location.pathname + location.search === to &&
                document.getElementById("watch-form") !== (/** @type {any} */ (window)).__sent &&
                !document.querySelector("main[aria-busy]") &&
                !(/** @type {any} */ (window)).navigation.transition,
              to,
              { timeout: 10_000, polling: 50 },
            ),
          );
        if (fails === "after") {
          releaseRead();
          await drawn();
          failPost();
        } else {
          // The write fails first: its submit has ended (the form that sent it is no longer busy)
          // while the read is still held, and only then is the read let go to draw.
          failPost();
          await run.step(() => p.waitForFunction(() => !(/** @type {any} */ (window)).__sent.hasAttribute("aria-busy"), null, { timeout: 10_000, polling: 50 }));
          releaseRead();
          await drawn();
        }
        await run.step(() => p.waitForFunction(() => (/** @type {any} */ (window)).__events.size > 0, null, { timeout: 10_000, polling: 50 }));
        // Settled: no navigation on its way, and two tasks after it, past anything the runtime
        // puts in a task once a read ends.
        await run.step(() =>
          p.evaluate(async () => {
            const w = /** @type {any} */ (window);
            while (w.navigation.transition) await w.navigation.transition.finished.catch(() => {});
            for (let i = 0; i < 2; i += 1) await new Promise((resolve) => setTimeout(resolve));
          }),
        );
        // The form's own handler ran when the form in its place heard it: its note is shown by now.
        seen = await run.step(() =>
          p.evaluate(() => {
            const note = document.querySelector("#watch-form [role=alert]");
            return { heard: [.../** @type {any} */ (window).__events.values()], note: note ? !(/** @type {HTMLElement} */ (note).hidden) : null };
          }),
        );
      } catch (error) {
        seen = { ...seen, stopped: run.over || String(error) };
      }
      const heard = /** @type {string[] | undefined} */ (seen.heard) ?? [];
      const wanted = at === "successor" ? "form in its place, status 0" : "document, status 0";
      // The page `/alerts` draws has no watch form; the other address draws one, whose note stays hidden.
      const note = at === "successor" ? true : to === "/alerts" ? null : false;
      check(name, !seen.stopped && heard.length === 1 && heard[0] === wanted && seen.note === note, JSON.stringify(seen));
    } finally {
      await cleanUp(
        () => releaseRead(),
        () => failPost(),
        () => page?.unrouteAll({ behavior: "ignoreErrors" }),
        () => context.close(),
      );
    }
  }
}
