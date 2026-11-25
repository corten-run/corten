import { base, skip, check, steps, cleanUp, within } from "./helpers.mjs";

/** A section stylesheet the abandoned navigation links, held until the case ends. */
const HELD_SHEET = "/smoke/write-failure-held.css";

/**
 * A routed request's headers, asking for its answer uncompressed: the test rewrites the answer, and
 * Playwright's fetch does not decode every encoding a browser asks for (Firefox's zstd).
 * @param {import("@playwright/test").Route} route
 */
const plainly = (route) => ({ ...route.request().headers(), "accept-encoding": "identity" });

/**
 * One case: the write is pressed on the watch form of `/` while a read of the page `to`
 * (started by a link, a script's navigation, or the whole page read a write's redirect sends) is on
 * its way, held at the route; the write fails once the read has drawn (`after`) or while it is
 * still held (`before`), and is heard once, on the form in its place or on the document.
 * `abandoned` first starts a navigation to `/alerts` whose section stylesheet never loads, which
 * the read of `to` abandons before the press. `action` draws the form in its place
 * with another `action`; `pressed` presses the form in its place (its write held) before the first fails.
 * @typedef {{ name: string, to: string, start: "link" | "script" | "write", fails: "after" | "before", at: "successor" | "document", abandoned?: boolean, action?: boolean, pressed?: boolean }} Case
 */

/**
 * A write whose answer never comes, while a read of the page draws over the form that sent it:
 * the page the read drew still says the write failed, once, where it hears it (#2068). The form a
 * read drew in its place hears it when the read drew the same page, with the same `action`, and it
 * has sent nothing since; the document does otherwise, a page with a form of the same id included.
 * A failure that comes while the read is still on its way is said once the read has drawn, so the
 * draw does not take it away; one that comes after a navigation was abandoned for the read is said
 * at once, while what the abandoned one waited for is still held. Each case holds the read and the
 * write at the route until the case has made the press and the read has drawn (or the write has
 * failed), never for a fixed time, presses in the page, and runs under one deadline.
 * @param {import("@playwright/test").Browser} browser
 */
export async function writeFailures(browser) {
  /** @type {Case[]} */
  const cases = [
    { name: "a write that fails after a navigation drew the same page over its form says so on the form in its place", to: "/", start: "link", fails: "after", at: "successor" },
    { name: "a write that fails after a navigation drew another page over its form says so on the document", to: "/alerts", start: "link", fails: "after", at: "document" },
    { name: "a write that fails after a whole page read drew over its form says so on the form in its place", to: "/", start: "write", fails: "after", at: "successor" },
    {
      name: "a write that fails after a navigation drew another address with a form of the same id says so on the document, not on that form",
      to: "/?again=1",
      start: "script",
      fails: "after",
      at: "document",
    },
    { name: "a write that fails while a navigation to the same page is on its way says so once, on the form in its place, after the draw", to: "/", start: "link", fails: "before", at: "successor" },
    { name: "a write that fails while a navigation to another page is on its way says so once, on the document, after the draw", to: "/alerts", start: "link", fails: "before", at: "document" },
    {
      name: "a write that fails after a navigation drew the same page with its form sending elsewhere says so on the document, not on that form",
      to: "/",
      start: "link",
      fails: "after",
      at: "document",
      action: true,
    },
    {
      name: "a write that fails after the user pressed the form a navigation drew in its place says so on the document, not on that form",
      to: "/",
      start: "link",
      fails: "after",
      at: "document",
      pressed: true,
    },
    {
      name: "a write that fails after a navigation abandoned while its stylesheet loads gave way to one that drew says so at once, on the form in its place",
      to: "/",
      start: "link",
      fails: "after",
      at: "successor",
      abandoned: true,
    },
  ];
  for (const { name, to, start, fails, at, abandoned, action, pressed } of cases) {
    const whole = start === "write";
    /** @type {() => void} */
    let releaseRead = () => {};
    const readLetGo = new Promise((resolve) => (releaseRead = () => resolve(undefined)));
    /** @type {() => void} */
    let failPost = () => {};
    const postLetGo = new Promise((resolve) => (failPost = () => resolve(undefined)));
    // What stays held until the case ends: the abandoned navigation's stylesheet, the write sent
    // from the form in its place.
    /** @type {() => void} */
    let endCase = () => {};
    const caseEnded = new Promise((resolve) => (endCase = () => resolve(undefined)));
    const context = await within(10_000, "the case's browser context did not open within 10 s", browser.newContext());
    /** @type {import("@playwright/test").Page | undefined} */
    let page;
    // Every gate opens and the context closes however the case ends, each even when another step of
    // the teardown fails.
    try {
      const run = steps(20_000, "the case did not finish within 20 s");
      /** @type {Record<string, unknown>} */
      let seen = {};
      // The last wait the case reached, said when it stops.
      let stage = "setup";
      try {
        const p = await run.step(() => context.newPage());
        page = p;
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
              if (!action) return route.continue().catch(() => {});
              // The same page, its form sending to another address.
              const answer = await route.fetch({ headers: plainly(route) });
              const body = (await answer.text()).replace('id="watch-form" method="post" action="/watch"', 'id="watch-form" method="post" action="/watch?elsewhere"');
              const headers = Object.fromEntries(Object.entries(answer.headers()).filter(([key]) => !["content-length", "content-encoding"].includes(key)));
              await route.fulfill({ status: answer.status(), headers, body }).catch(() => {});
            },
          ),
        );
        /** @type {() => void} */
        let sheetHeard = () => {};
        const sheetAsked = new Promise((resolve) => (sheetHeard = () => resolve(undefined)));
        if (abandoned) {
          // The navigation the read abandons: `/alerts` with a section stylesheet that never loads.
          await run.step(() =>
            p.route(
              (url) => url.href === `${base}/alerts`,
              async (route) => {
                if (route.request().headers().corten !== "nav") return route.continue().catch(() => {});
                const answer = await route.fetch({ headers: plainly(route) });
                const body = `<link rel="stylesheet" data-corten-style href="${HELD_SHEET}">${await answer.text()}`;
                const headers = Object.fromEntries(Object.entries(answer.headers()).filter(([key]) => !["content-length", "content-encoding"].includes(key)));
                await route.fulfill({ status: answer.status(), headers, body }).catch(() => {});
              },
            ),
          );
          await run.step(() =>
            p.route(`**${HELD_SHEET}`, async (route) => {
              sheetHeard();
              await caseEnded;
              await route.abort("failed").catch(() => {});
            }),
          );
        }
        // The whole page read is the one a write's redirect sends the page on: the first post is
        // answered with Corten's redirect to the page itself; the next post fails once let go. A
        // post from the form in its place is held until the case ends.
        let posts = 0;
        /** @type {() => void} */
        let postHeard = () => {};
        const postHeld = new Promise((resolve) => (postHeard = () => resolve(undefined)));
        /** @type {() => void} */
        let laterHeard = () => {};
        const laterHeld = new Promise((resolve) => (laterHeard = () => resolve(undefined)));
        await run.step(() =>
          p.route("**/watch", async (route) => {
            posts += 1;
            if (whole && posts === 1) return route.fulfill({ status: 200, headers: { "corten-location": "/" }, body: "" }).catch(() => {});
            if (posts > (whole ? 2 : 1)) {
              laterHeard();
              await caseEnded;
              return route.abort("failed").catch(() => {});
            }
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
        /** @param {string} to */
        const follow = (to) => p.evaluate((to) => /** @type {HTMLAnchorElement} */ (document.querySelector(`header a[href="${to}"]`)).click(), to);
        if (abandoned) {
          // The navigation to `/alerts` waits for its stylesheet; the read of `to` abandons it, and
          // the press meets that read on its way (a navigation started after the press would cut
          // the write off).
          await run.step(() => follow("/alerts"));
          stage = "the abandoned navigation's stylesheet asked for";
          await run.step(() => sheetAsked);
          await run.step(() => follow(to));
          stage = "the read asked for";
          await run.step(() => readHeld);
          await run.step(press);
          stage = "the write sent";
          await run.step(() => postHeld);
        } else {
          if (whole) await run.step(press);
          else if (start === "link") await run.step(() => follow(to));
          else await run.step(() => p.evaluate((to) => void (/** @type {any} */ (window)).navigation.navigate(to).finished.catch(() => {}), to));
          stage = "the read asked for";
          await run.step(() => readHeld);
          // The press meets the read still on its way, on the form it will draw over.
          await run.step(press);
          stage = "the write sent";
          await run.step(() => postHeld);
        }
        /** Whether the read has drawn the page `to` over the form that sent the write. */
        const drawn = () =>
          ((stage = "the read drawn"),
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
          ));
        if (fails === "after") {
          releaseRead();
          await drawn();
          if (pressed) {
            // The user sends the form drawn in its place before the first write fails.
            await run.step(press);
            stage = "the write from the form in its place sent";
            await run.step(() => laterHeld);
          }
          failPost();
        } else {
          // The write fails first: its submit has ended (the form that sent it is no longer busy)
          // while the read is still held, and only then is the read let go to draw.
          failPost();
          stage = "the write ended";
          await run.step(() => p.waitForFunction(() => !(/** @type {any} */ (window)).__sent.hasAttribute("aria-busy"), null, { timeout: 10_000, polling: 50 }));
          releaseRead();
          await drawn();
        }
        // Heard promptly: within 5 s of the failure, with the abandoned navigation's stylesheet
        // still held.
        stage = "the failure heard";
        await run.step(() => p.waitForFunction(() => (/** @type {any} */ (window)).__events.size > 0, null, { timeout: 5_000, polling: 50 }));
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
        seen = { ...seen, stopped: run.over || String(error), stage };
      }
      const heard = /** @type {string[] | undefined} */ (seen.heard) ?? [];
      const wanted = at === "successor" ? "form in its place, status 0" : "document, status 0";
      // The page `/alerts` draws has no watch form; the others draw one, whose note stays hidden
      // unless it heard the failure.
      const note = at === "successor" ? true : to === "/alerts" ? null : false;
      check(name, !seen.stopped && heard.length === 1 && heard[0] === wanted && seen.note === note, JSON.stringify(seen));
    } finally {
      await cleanUp(
        () => releaseRead(),
        () => failPost(),
        () => endCase(),
        () => page?.unrouteAll({ behavior: "ignoreErrors" }),
        () => within(10_000, "the case's browser context did not close within 10 s", context.close()),
      );
    }
  }
}
