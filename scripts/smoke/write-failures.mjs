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
 * (started by a link, a script's navigation, the whole page read a write's redirect sends, or Back
 * to `to`, the page loaded before `/`) is on
 * its way, held at the route; the write fails once the read has drawn (`after`) or while it is
 * still held (`before`), and is heard once, on the form in its place or on the document.
 * `abandoned` first starts a navigation to `/alerts` whose section stylesheet never loads, which
 * the read of `to` abandons before the press. `differs` draws the form in its place with another
 * `action` or `method`, or without `data-patch`; `pressed` presses the form in its place (its
 * write held) before the first fails.
 * `own` answers the first write with its own whole page while the read is on its way, and presses
 * the form that page drew; that second write is the one that fails. `outside` presses a form outside
 * `<main>` instead: one added to the body, which the read does not draw over, so its failure is heard
 * on it while the read is still held; one added to the layout's header while the read is the whole
 * page; or one in the layout's element that is the page's (the sector nav), drawn again without its
 * `page` mark as a patch may draw it. The last two are held until the read has drawn.
 * @typedef {{ name: string, to: string, start: "link" | "script" | "write" | "back", fails: "after" | "before", at: "successor" | "document" | "sent", abandoned?: boolean, differs?: "action" | "method" | "patch", pressed?: boolean, own?: boolean, outside?: "body" | "header" | "part" }} Case
 */

/**
 * A write whose answer never comes, while a read of the page draws over the form that sent it:
 * the page the read drew still says the write failed, once, where it hears it (#2068). The form a
 * read drew in its place hears it when the read drew the same page, marked `data-patch`, with the
 * same `action` and `method`, and it has sent nothing since; the document does otherwise, a page
 * with a form of the same id included. A failure that comes while the read is still on its way is
 * said once the read has drawn, so the draw does not take it away; one that comes after a
 * navigation was abandoned for the read is said at once, while what the abandoned one waited for is still held. A failure said once the read has
 * drawn comes after the navigation's own scroll, so a handler that scrolls keeps its place. A form
 * outside `<main>`, which the read does not draw over, hears its failure while the read is held;
 * one the read may draw over (in the layout while the whole page is read, or in the layout's element
 * that is the page's, marked or not) hears it once the read has drawn. A
 * write's own page drawn while a read of another address is on its way is still the page pressed,
 * whatever the address shows: a form pressed there is not one the read's page succeeds. Each case
 * holds the read and the write at the route until the case has made the press and the read has
 * drawn (or the write has failed), never for a fixed time, presses in the page, and runs under one
 * deadline.
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
      differs: "action",
    },
    {
      name: "a write that fails after a navigation drew the same page with its form sending by another method says so on the document, not on that form",
      to: "/",
      start: "link",
      fails: "after",
      at: "document",
      differs: "method",
    },
    {
      name: "a write that fails after a navigation drew the same page with its form not marked data-patch says so on the document, not on that form",
      to: "/",
      start: "link",
      fails: "after",
      at: "document",
      differs: "patch",
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
    {
      // WebKit changes the address when a navigation starts (any browser does for back and
      // forward): the write's own page, drawn while the read of another address is on its way, is
      // still the page that was pressed.
      name: "a write that fails, sent from a write's own page drawn while a navigation to another address with a form of the same id was on its way, says so on the document, not on that form",
      to: "/?again=1",
      start: "script",
      fails: "after",
      at: "document",
      own: true,
    },
    {
      // Back and forward change the address as they start in every browser.
      name: "a write that fails, sent from a write's own page drawn while Back to another address with a form of the same id was on its way, says so on the document, not on that form",
      to: "/?again=1",
      start: "back",
      fails: "after",
      at: "document",
      own: true,
    },
    {
      name: "a write that fails from a form outside <main> while a navigation is on its way says so at once, on that form",
      to: "/alerts",
      start: "link",
      fails: "before",
      at: "sent",
      outside: "body",
    },
    {
      name: "a write that fails from a form in the layout while the whole page read is on its way says so on that form after the draw",
      to: "/",
      start: "write",
      fails: "before",
      at: "sent",
      outside: "header",
    },
    {
      name: "a write that fails from a form in the layout's page part a patch drew without its mark, while a navigation is on its way, says so after the draw",
      to: "/alerts",
      start: "link",
      fails: "before",
      at: "document",
      outside: "part",
    },
  ];
  for (const { name, to, start, fails, at, abandoned, differs, pressed, own, outside } of cases) {
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
        await run.step(() => p.goto(`${base}${start === "back" ? to : "/"}`, { waitUntil: "load" }));
        if (!(await run.step(() => p.evaluate(() => "navigation" in window)))) {
          skip(name, "without the Navigation API a navigation is a full load");
          continue;
        }
        if (start === "back") {
          // `to`, then `/` drawn over it, so Back reads `to` again.
          stage = "the page before drawn";
          await run.step(() =>
            p.evaluate(async () => {
              const w = /** @type {any} */ (window);
              await w.navigation.navigate("/").finished;
              while (document.querySelector("main[aria-busy]")) await new Promise((resolve) => setTimeout(resolve, 20));
            }),
          );
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
              if (!differs) return route.continue().catch(() => {});
              // The same page, its form sending to another address, by another method, or not
              // marked `data-patch`. Were the markup not found, the form would be drawn as it was
              // and hear the failure, failing the case.
              const answer = await route.fetch({ headers: plainly(route) });
              const form = 'id="watch-form" method="post" action="/watch" data-patch';
              const changed = { action: 'id="watch-form" method="post" action="/watch?elsewhere" data-patch', method: 'id="watch-form" method="get" action="/watch" data-patch', patch: 'id="watch-form" method="post" action="/watch"' };
              const body = (await answer.text()).replace(form, changed[differs]);
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
        // answered with Corten's redirect to the page itself, or (`own`) with the write's own page,
        // the page itself read whole; the next post fails once let go. A post from the form in its
        // place is held until the case ends.
        const first = whole || !!own;
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
            if (own && posts === 1) {
              const answer = await context.request.get(`${base}/`, { headers: { corten: "page", "accept-encoding": "identity" } });
              const headers = Object.fromEntries(Object.entries(answer.headers()).filter(([key]) => !["content-length", "content-encoding"].includes(key)));
              return route.fulfill({ status: answer.status(), headers, body: await answer.text() }).catch(() => {});
            }
            if (posts > (first ? 2 : 1)) {
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
          p.evaluate((outside) => {
            const state = /** @type {any} */ (window);
            if (outside) {
              // A form outside `<main>`, sending to the same place: in the body, in the layout's
              // header, or in the layout's element that is the page's, which is then drawn again
              // without its `page` mark, as a patch with other markup draws it.
              const form = document.createElement("form");
              form.id = "outside-form";
              form.method = "post";
              form.action = "/watch";
              form.setAttribute("data-patch", "");
              form.append(document.createElement("button"));
              if (outside === "body") document.body.append(form);
              else if (outside === "header") /** @type {HTMLElement} */ (document.querySelector("body > header")).append(form);
              else {
                const part = /** @type {HTMLElement} */ (document.querySelector("nav[data-corten-page]"));
                part.append(form);
                const fresh = /** @type {HTMLElement} */ (part.cloneNode(true));
                fresh.removeAttribute("data-corten-page");
                part.replaceWith(fresh);
              }
            }
            state.__sent = document.getElementById(outside ? "outside-form" : "watch-form");
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
              // A handler that scrolls the page keeps its scroll: the navigation's own scroll (to
              // the top, after its draw) came first. Made tall enough to scroll through the CSSOM,
              // which the CSP allows.
              document.documentElement.style.minHeight = "10000px";
              scrollTo(0, 2000);
              state.__scrolled = scrollY;
            };
            state.__sent.addEventListener("corten:error", note);
            addEventListener("corten:error", note);
          }, outside ?? null),
        );
        /** @param {string} id */
        const pressOn = (id) => p.evaluate((id) => /** @type {HTMLButtonElement} */ (document.querySelector(`#${id} button`)).click(), id);
        // The press that meets the read; a whole read's own first press is on the watch form.
        const press = () => pressOn(outside ? "outside-form" : "watch-form");
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
          if (whole) await run.step(() => pressOn("watch-form"));
          else if (start === "link") await run.step(() => follow(to));
          else if (start === "back") await run.step(() => p.evaluate(() => void (/** @type {any} */ (window)).navigation.back().finished.catch(() => {})));
          else await run.step(() => p.evaluate((to) => void (/** @type {any} */ (window)).navigation.navigate(to).finished.catch(() => {}), to));
          stage = "the read asked for";
          await run.step(() => readHeld);
          // The press meets the read still on its way, on the form it will draw over.
          await run.step(press);
          if (own) {
            // The write's own page is drawn, the read still on its way; the user presses the form it drew.
            stage = "the write's own page drawn";
            await run.step(() =>
              p.waitForFunction(
                () => {
                  const w = /** @type {any} */ (window);
                  const form = document.getElementById("watch-form");
                  return !!form && form !== w.__sent && !w.__sent.hasAttribute("aria-busy") && !form.hasAttribute("aria-busy") && !!w.navigation.transition;
                },
                null,
                { timeout: 10_000, polling: 50 },
              ),
            );
            await run.step(press);
          }
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
          if (outside === "body") {
            // Heard with the read still held: nothing the read draws can take it away.
            stage = "the failure heard while the read is held";
            await run.step(() => p.waitForFunction(() => (/** @type {any} */ (window)).__events.size > 0, null, { timeout: 5_000, polling: 50 }));
          } else if (outside) {
            // Not heard with the read held: a failure said at once is said as the submit ends, before
            // its form is no longer busy.
            stage = "the failure held while the read is held";
            const early = await run.step(() => p.evaluate(() => (/** @type {any} */ (window)).__events.size));
            if (early) throw new Error(`heard ${early} with the read held`);
          }
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
            const w = /** @type {any} */ (window);
            return {
              heard: [...w.__events.values()],
              note: note ? !(/** @type {HTMLElement} */ (note).hidden) : null,
              scrolled: w.__scrolled > 0 && scrollY === w.__scrolled,
            };
          }),
        );
      } catch (error) {
        seen = { ...seen, stopped: run.over || String(error), stage };
      }
      const heard = /** @type {string[] | undefined} */ (seen.heard) ?? [];
      const wanted = at === "successor" ? "form in its place, status 0" : at === "sent" ? "sent form, connected=true, status 0" : "document, status 0";
      // The page `/alerts` draws has no watch form; the others draw one, whose note stays hidden
      // unless it heard the failure.
      const note = at === "successor" ? true : to === "/alerts" ? null : false;
      check(name, !seen.stopped && heard.length === 1 && heard[0] === wanted && seen.note === note && (outside === "body" || seen.scrolled === true), JSON.stringify(seen));
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
  await readAgainAfterReplace(browser);
}

/**
 * A page that reads itself again, whose address a script changed (`history.replaceState`, as a sort
 * in place does): the read of it again is the same page, not a turn, so a write pressed while that
 * read is on its way and failing after it drew says so on the form drawn in its place. The page's
 * form is given an id, and the read the press meets is told by the script's query and held at the
 * route until the press; its answer carries a mark, so its draw is seen.
 * @param {import("@playwright/test").Browser} browser
 */
async function readAgainAfterReplace(browser) {
  const name = "a write that fails after the page's read of itself again, at the address a script put in, drew over its form says so on the form in its place";
  const path = "/smoke/written/again";
  /** @type {() => void} */
  let releaseRead = () => {};
  const readLetGo = new Promise((resolve) => (releaseRead = () => resolve(undefined)));
  /** @type {() => void} */
  let failPost = () => {};
  const postLetGo = new Promise((resolve) => (failPost = () => resolve(undefined)));
  const context = await within(10_000, "the case's browser context did not open within 10 s", browser.newContext());
  /** @type {import("@playwright/test").Page | undefined} */
  let page;
  try {
    const run = steps(20_000, "the case did not finish within 20 s");
    /** @type {Record<string, unknown>} */
    let seen = {};
    let stage = "setup";
    try {
      const p = await run.step(() => context.newPage());
      page = p;
      /** @type {() => void} */
      let readHeard = () => {};
      const readHeld = new Promise((resolve) => (readHeard = () => resolve(undefined)));
      /** @type {() => void} */
      let postHeard = () => {};
      const postHeld = new Promise((resolve) => (postHeard = () => resolve(undefined)));
      await run.step(() =>
        p.route(
          (url) => url.pathname === path,
          async (route) => {
            const request = route.request();
            if (request.method() === "POST") {
              postHeard();
              await postLetGo;
              return route.abort("failed").catch(() => {});
            }
            // The read the press meets: the first at the script's address, drawn with a mark.
            const held = !!request.headers().corten && new URL(request.url()).searchParams.has("sorted");
            if (held) {
              readHeard();
              await readLetGo;
            }
            const answer = await route.fetch({ headers: plainly(route) });
            let body = (await answer.text()).replace(`<form method="post" action="${path}"`, `<form id="again-form" method="post" action="${path}"`);
            if (held) body += '<p id="again-drawn">Read again.</p>';
            const headers = Object.fromEntries(Object.entries(answer.headers()).filter(([key]) => !["content-length", "content-encoding"].includes(key)));
            await route.fulfill({ status: answer.status(), headers, body }).catch(() => {});
          },
        ),
      );
      await run.step(() => p.goto(`${base}${path}`, { waitUntil: "load" }));
      if (!(await run.step(() => p.evaluate(() => "navigation" in window)))) {
        skip(name, "without the Navigation API a page reading itself again is a full load");
        return;
      }
      await run.step(() =>
        p.evaluate(() => {
          const state = /** @type {any} */ (window);
          state.__sent = document.getElementById("again-form");
          if (!state.__sent) throw new Error("the page's form has no id");
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
                  : target === document.getElementById("again-form")
                    ? "form in its place"
                    : "another element";
            events.set(event, `${where}, status ${/** @type {CustomEvent} */ (event).detail.status}`);
          };
          state.__sent.addEventListener("corten:error", note);
          addEventListener("corten:error", note);
          // A sort in place puts its query in the address.
          history.replaceState(history.state, "", `${location.pathname}?sorted=1`);
        }),
      );
      stage = "the read again asked for";
      await run.step(() => readHeld);
      await run.step(() => p.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector("#again-form button")).click()));
      stage = "the write sent";
      await run.step(() => postHeld);
      releaseRead();
      stage = "the read again drawn";
      await run.step(() =>
        p.waitForFunction(
          () => !!document.getElementById("again-drawn") && document.getElementById("again-form") !== (/** @type {any} */ (window)).__sent && !(/** @type {any} */ (window)).navigation.transition,
          null,
          { timeout: 10_000, polling: 50 },
        ),
      );
      failPost();
      stage = "the failure heard";
      await run.step(() => p.waitForFunction(() => (/** @type {any} */ (window)).__events.size > 0, null, { timeout: 5_000, polling: 50 }));
      // Two tasks more, past anything the runtime puts in a task.
      await run.step(() => p.evaluate(async () => { for (let i = 0; i < 2; i += 1) await new Promise((resolve) => setTimeout(resolve)); }));
      seen = await run.step(() => p.evaluate(() => ({ heard: [.../** @type {any} */ (window).__events.values()] })));
    } catch (error) {
      seen = { ...seen, stopped: run.over || String(error), stage };
    }
    const heard = /** @type {string[] | undefined} */ (seen.heard) ?? [];
    check(name, !seen.stopped && heard.length === 1 && heard[0] === "form in its place, status 0", JSON.stringify(seen));
  } finally {
    await cleanUp(
      () => releaseRead(),
      () => failPost(),
      () => page?.unrouteAll({ behavior: "ignoreErrors" }),
      () => within(10_000, "the case's browser context did not close within 10 s", context.close()),
    );
  }
}
