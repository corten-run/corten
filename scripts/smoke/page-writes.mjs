import { base, skip, check, pollFor, cleanUp, steps, within, opened, closeContext } from "./helpers.mjs";

export async function pageWrites(page, browser) {
  // After a write, the page it sends the browser to is fetched whole; when that page's handler
  // sends it on to a place, the server names the place (`corten-location`, for the runtime's
  // `corten: page`), so it keeps its `#id` rather than `fetch` following a 303 without it
  // (#1034). The stand-in answers as the server does: `corten-location` to the runtime's
  // fetches, a 303 to any other.
  const wholePlaceName = "a page fetched whole after a write that sends the browser to a place lands on the place";
  if (!(await page.evaluate(() => "navigation" in window))) skip(wholePlaceName, "without the Navigation API a write's page is a full load");
  else {
    const whole = await (await browser.newContext()).newPage();
    /** @type {string[]} */
    const asked = [];
    await whole.route(
      (url) => url.pathname === "/whole-write",
      (route) => route.fulfill({ status: 204, headers: { "corten-location": "/whole-next" } }),
    );
    await whole.route(
      (url) => url.pathname === "/whole-next",
      (route) => {
        const mode = route.request().headers().corten;
        asked.push(mode ?? "-");
        return mode
          ? route.fulfill({ status: 204, headers: { "corten-location": "/news#briefing" } })
          : route.fulfill({ status: 303, headers: { location: "/news#briefing" } });
      },
    );
    await whole.goto(`${base}/alerts`);
    await whole.evaluate(() =>
      document
        .querySelector("main")
        ?.insertAdjacentHTML("afterbegin", __html('<form id="whole-write" method="post" action="/whole-write" data-patch><button id="whole-go">Save</button></form>')),
    );
    await whole.click("#whole-go");
    await whole.waitForFunction(() => document.title === "News | Watchlist" && !document.querySelector("[aria-busy]"), null, { timeout: 5000 }).catch(() => {});
    const landed = await whole.evaluate(() => ({ path: location.pathname, hash: location.hash }));
    check(wholePlaceName, landed.path === "/news" && landed.hash === "#briefing" && asked.join() === "page", JSON.stringify({ landed, asked }));
    await whole.context().close();
  }
  // A write that answers with its own page (a form drawn again with what it refused) gets it whole,
  // as the page a write redirects to is, so what the write changed around <main> is drawn, in the
  // same document and at the same address (#1370). The stand-in plays a server whose layout shows
  // the write: every whole page it sends once the write is answered has the brand changed, and only
  // those (a navigation's <main> holds no brand), so the brand changes only if the runtime draws
  // the layout the write's own page brought, or reads the next page whole.
  /**
   * A moment a read is counted from: the length of `seen.asked` then (`at`) and the time
   * (`Date.now()`, as `seen.askedAt`). Times are `Date.now()` here and in the page alike, so a time
   * the page records at an event compares with one the stand-in recorded: the browser runs on the
   * machine that runs the checks.
   * @typedef {{ at: number, time: number }} Since
   */
  /** Now, as a `Since`. @param {{ asked: string[] }} seen @returns {Since} */
  const sinceNow = (seen) => ({ at: seen.asked.length, time: Date.now() });
  /**
   * A page of its own at /smoke/written, with the stand-in in front: `edit` changes each whole
   * page from the write's answer on (`written`), `before` each one until then, each given the count
   * of writes sent by then (`writes`), its own included. Each request's mode for a path is recorded
   * in `asked`, and the writes answered are counted in `answers`; a write's answer waits for what
   * `hold` gives for its number. While `fail` is set, a write is done but its answer is dropped, as a
   * network that fails after the server applied it. While `draws` is false, a write goes without
   * its `Prefer: corten-draws=whole`, as from a runtime from before it. A write's answer's headers are given to `edit`
   * too, to change, and while `status` is set it is the write's answer's status. The page opened is `path`; a write
   * is a post to `/smoke/written` or, from the page that reads itself again, to its own address.
   * `edit` and `seen.nav` (which changes a navigation's <main>) are given the request's place in
   * `asked` too, for a case to mark what an answer draws (`watchMarks`).
   * `askedAt` holds the time each request in `asked` reached the stand-in, by the same place.
   * `settled` holds, by each write's number, the length of `asked` and the time the moment the
   * stand-in fails that write or hands the page its answer (`Since`): no read the page asked after
   * it saw that answer, or that write fail, has a place before it, and a bound on that read counts
   * from that time, not from when a check saw the outcome.
   * Making the context and the page is bounded to 30 s, Playwright's own timeout, as their closing
   * is (`opened`, `closeContext`); setting its route and marking it are each bounded to 5 s (its
   * load has Playwright's own 30 s), and the page is closed (`closeContext`) if one of them fails.
   * @param {(body: string, writes: number, headers?: Record<string, string>, at?: number) => string} edit @param {(body: string) => string} [before]
   * @param {string} [path]
   */
  const writtenPage = async (edit, before = (body) => body, path = "/smoke/written") => {
    const context = await opened("the write case's context", browser.newContext());
    const seen = {
      written: false,
      fail: false,
      draws: true,
      status: 0,
      writes: 0,
      answers: 0,
      /** @type {string[]} */ asked: [],
      /** When each request in `asked` reached the stand-in (`Date.now()`). @type {number[]} */ askedAt: [],
      /** @type {Record<string, string>} */ answered: {},
      /** By write number, the length of `asked` and the time when the stand-in failed or answered it. @type {Record<number, Since>} */
      settled: {},
      /** Changes a navigation's <main>, given the request's place in `asked`. @type {(body: string, at: number) => string} */
      nav: (/** @type {string} */ body, /** @type {number} */ _at) => body,
      /** What a write's answer waits for, by the write's number. @type {(writes: number) => Promise<unknown> | undefined} */
      hold: (/** @type {number} */ _writes) => /** @type {Promise<unknown> | undefined} */ (undefined),
    };
    // Closed here if the page, its route or its load fails: no case has the page to close yet.
    try {
      const own = await within(30_000, "the write case's page was not made within 30 s", context.newPage());
      await within(
        5000,
        "the write case's route was not set within 5 s",
        own.route(
          (url) => url.origin === new URL(base).origin && !url.pathname.startsWith("/assets/"),
          async (route) => {
            const req = route.request();
            const mode = req.headers().corten;
            const write = req.method() === "POST" && ["/smoke/written", "/smoke/written/again"].includes(new URL(req.url()).pathname);
            if (!write && !(req.resourceType() === "document" || mode === "page" || mode === "nav")) return route.fallback();
            const at = seen.asked.length;
            seen.asked.push(`${req.method()} ${new URL(req.url()).pathname} ${mode ?? "-"}`);
            seen.askedAt.push(Date.now());
            // Counted as the write is sent, so the writes are numbered in the order the page sent them.
            if (write) seen.writes += 1;
            const writes = seen.writes;
            // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
            const sent = { ...req.headers(), "accept-encoding": "identity" };
            if (write && !seen.draws) delete sent.prefer;
            const res = await route.fetch({ headers: sent });
            const headers = res.headers();
            if (write) seen.answered = { ...headers };
            delete headers["content-encoding"];
            delete headers["content-length"];
            const text = await res.text();
            // A navigation's <main> has no layout to change: only `seen.nav` changes it.
            const body = mode === "nav" ? seen.nav(text, at) : write || seen.written ? edit(text, writes, write ? headers : undefined, at) : before(text);
            seen.written ||= write;
            if (write && seen.fail) {
              seen.settled[writes] = sinceNow(seen);
              return route.abort("failed");
            }
            if (write) await seen.hold(writes);
            if (write) seen.settled[writes] = sinceNow(seen);
            await route.fulfill({ status: write && seen.status ? seen.status : res.status(), headers, body }).catch(() => {});
            if (write) seen.answers += 1;
          },
        ),
      );
      await own.goto(`${base}${path}`);
      await within(
        5000,
        "the write case's page was not marked within 5 s",
        own.evaluate(() => ((/** @type {any} */ (window)).__marker = 1)),
      );
      return { own, seen };
    } catch (error) {
      await closeContext(context, "the write case's context").catch(() => {});
      throw error;
    }
  };
  const brand = (/** @type {string} */ body) => body.replace(">Watchlist</span>", ">Watchlist, written</span>");
  /** What the page shows of the layout. @param {import("@playwright/test").Page} own */
  const shownOf = (own) =>
    own.evaluate(() => ({
      brand: document.querySelector("header span")?.textContent,
      section: document.getElementById("sector-nav")?.textContent ?? null,
      same: (/** @type {any} */ (window)).__marker === 1,
      path: location.pathname,
      title: document.title,
    }));
  const writtenIn = (/** @type {import("@playwright/test").Page} */ own) =>
    own
      .waitForFunction(() => document.querySelector("main")?.textContent?.includes("Written by the form's own page.") && !document.querySelector("[aria-busy]"), null, {
        timeout: 5000,
      })
      .then(
        () => true,
        () => false,
      );
  /**
   * Finds the button at `selector` and presses it in one page task, and whether the write it sends
   * reaches the stand-in within 5 s counted from just before the page is asked to press. The press
   * task and the wait for its write share those 5 s: a press task that has not returned by then, or
   * returns after them, fails the press however soon its write came. A page that
   * reads itself again swaps <main> a second after it loads, and again whenever its answer changes:
   * a Playwright click can find the button, then land once it is gone, and a press that reaches no
   * button sends nothing (#2035).
   * @param {import("@playwright/test").Page} own @param {{ writes: number }} seen @param {string} selector
   */
  const pressWrite = async (own, seen, selector) => {
    const writes = seen.writes;
    const press = steps(5000, "the write was not sent within 5 s of the press");
    return press
      .step(() =>
        own.evaluate((selector) => {
          const button = /** @type {HTMLButtonElement | null} */ (document.querySelector(selector));
          button?.click();
          return !!button;
        }, selector),
      )
      .then((pressed) => pressed && press.poll(async () => seen.writes > writes))
      .then(
        (sent) => sent === true,
        () => false,
      );
  };
  /**
   * Notes, from now on, each mark a case's stand-in put in an answer (`data-smoke-at`, the answer's
   * place in `seen.asked`) the moment the page draws it, so a draw that the next one replaces is
   * seen too: the time of that draw (`Date.now()` in the page), and what the header said had failed
   * at that moment (its `data-failed`, or null). `drawnBy` reads them. Set up within 5 s.
   * @param {import("@playwright/test").Page} own
   */
  const watchMarks = (own) =>
    within(
      5000,
      "the page did not start noting its draws within 5 s",
      own.evaluate(() => {
        /** @type {Record<string, { time: number, failed: string | null }>} */
        const marks = Object.create(null);
        (/** @type {any} */ (window)).__marks = marks;
        const note = () => {
          const time = Date.now();
          for (const el of Array.from(document.querySelectorAll("[data-smoke-at]"))) {
            const at = /** @type {string} */ (el.getAttribute("data-smoke-at"));
            marks[at] ??= { time, failed: document.querySelector("header")?.getAttribute("data-failed") ?? null };
          }
        };
        note();
        new MutationObserver(note).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-smoke-at"] });
      }),
    );
  /**
   * The page's record of its draw of the answer to `seen.asked[at]` (`watchMarks`), if the page drew
   * it by `by` (a `Date.now()` time), else null. The draw's own time, recorded by the page as it drew,
   * decides: the check looks until `by`, then once more (that look bounded to 5 s), so a check that
   * looks late neither fails a draw made in time nor passes one made after `by`.
   * @param {import("@playwright/test").Page} own @param {number} at @param {number} by
   */
  const drawnBy = async (own, at, by) => {
    const look = () =>
      own.evaluate((at) => /** @type {{ time: number, failed: string | null } | undefined} */ ((/** @type {any} */ (window)).__marks[String(at)]), at);
    const drawn =
      (await pollFor(Math.max(0, by - Date.now()), look)) ?? (await within(5000, "the page did not say what it drew within 5 s", look()).catch(() => undefined));
    return drawn && drawn.time <= by ? drawn : null;
  };
  /**
   * The place in `seen.asked` of the first read of `/smoke/written/again` from `from` on (at or after
   * its place, `from.at`, and reaching the stand-in at or after its time, `from.time`), if it reached
   * the stand-in within 5 s of `from.time`, else null: a first read asked later fails however soon
   * the check looks, and the check waits for one only until then. Its place alone does not do: a
   * place taken before the page is asked to do something (let a held body go) lets in a read that
   * reached the stand-in while that task waited to run, before what the read must follow.
   * @param {{ asked: string[], askedAt: number[] }} seen @param {Since} from
   */
  const readAsked = async (seen, from) => {
    const by = from.time + 5000;
    const first = () => seen.asked.findIndex((a, i) => i >= from.at && seen.askedAt[i] >= from.time && a.startsWith("GET /smoke/written/again"));
    if (first() < 0) await pollFor(Math.max(0, by - Date.now()), async () => first() >= 0);
    const at = first();
    return at >= 0 && seen.askedAt[at] <= by ? at : null;
  };
  /**
   * Notes, from now on, whether the write's own <main> is drawn, the moment it is, with no element
   * busy and, given `brand`, the brand reading `brand` at that same moment: a page that reads itself
   * again draws the form's <main> over it a second later, which a sampled wait in a loaded browser
   * can miss (#2035), and a brand a later whole read draws is not the write's. Only the write's own
   * page has that <main>. With `inMain`, only an element in <main> must not be busy: a form outside
   * it whose own write is still out stays busy meanwhile. `writtenSeen` reads it. Set up within 5 s.
   * @param {import("@playwright/test").Page} own @param {string} [brand] @param {boolean} [inMain]
   */
  const watchWritten = (own, brand, inMain = false) =>
    within(
      5000,
      "the page did not start noting the write's <main> within 5 s",
      own.evaluate(
        ({ brand, inMain }) => {
          const w = /** @type {any} */ (window);
          w.__writtenSeen = false;
          const drawn = () =>
            !!document.querySelector("main")?.textContent?.includes("Written by the form's own page.") &&
            !document.querySelector(inMain ? "main[aria-busy], main [aria-busy]" : "[aria-busy]") &&
            (brand === null || document.querySelector("header span")?.textContent === brand);
          new MutationObserver((_, observer) => {
            if (!drawn()) return;
            w.__writtenSeen = true;
            observer.disconnect();
          }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-busy"] });
        },
        { brand: brand ?? null, inMain },
      ),
    );
  /**
   * Whether `watchWritten` saw the write's own page drawn, within 5 s of the call, which a case makes
   * the moment it sees the write sent. @param {import("@playwright/test").Page} own
   */
  const writtenSeen = async (own) => (await pollFor(5000, () => own.evaluate(() => /** @type {boolean} */ ((/** @type {any} */ (window)).__writtenSeen)))) === true;
  /**
   * Marks a navigation's <main> with its read's place in `seen.asked` (as `seen.nav`), for
   * `watchMarks` to note the moment it is drawn. @param {string} body @param {number} at
   */
  const markNav = (body, at) => body.replace(">Quoted arguments</a>", `>Quoted arguments</a><i data-smoke-at="${at}" hidden></i>`);
  /**
   * The page's first read of itself from `from` on, asked within 5 s of `from.time`
   * (`readAsked`), and whether its answer is drawn within 5 s of that read reaching the stand-in
   * (`drawnBy`) with the header already saying `failure` had failed at that draw: the read's own
   * mark (`markNav`), not a request or a pause, is what shows the poll drew, and a poll drawn before
   * the failure was shown is not a poll that kept it. `from` is taken at what the read follows (a
   * write's `settled` moment, or a held body's release, its time recorded by the page), not once
   * the check has seen that in the page, by when the read may already have been asked and its time
   * run; without one (the write never answered) there is no such read.
   * @param {import("@playwright/test").Page} own @param {{ asked: string[], askedAt: number[] }} seen @param {Since | undefined} from @param {string} failure
   */
  const nextPollDrawn = async (own, seen, from, failure) => {
    if (from === undefined) return { again: null, drewAgain: false, drawn: null };
    const at = await readAsked(seen, from);
    const drawn = at === null ? null : await drawnBy(own, at, seen.askedAt[at] + 5000);
    return { again: at === null ? null : seen.asked[at], drewAgain: !!drawn && drawn.failed === failure, drawn };
  };
  {
    const { own, seen } = await writtenPage(brand);
    const first = await shownOf(own);
    await own.click("main form button");
    const drawn = await writtenIn(own);
    const shown = await shownOf(own);
    check(
      "a write's own page is whole, and what the write changed around <main> is drawn in the same document",
      first.brand === "Watchlist" &&
        drawn &&
        seen.asked.at(-1) === "POST /smoke/written action" &&
        !("corten-page" in seen.answered) &&
        "corten-shell" in seen.answered &&
        shown.brand === "Watchlist, written" &&
        shown.same &&
        shown.path === "/smoke/written" &&
        shown.title === "Written | Watchlist",
      JSON.stringify({ first: first.brand, drawn, asked: seen.asked, page: seen.answered["corten-page"] ?? null, shown }),
    );
    await own.context().close();
  }
  // Left while the write's own page is on its way (its modules still loading), by a link to a page
  // in the same area and layout, which a navigation swaps in: the write is done, so that page is
  // read whole and shows what the write changed, as after a write that redirects.
  const leftName = "a navigation that leaves a write's own page on its way reads the next page whole, with what the write changed";
  if (!(await page.evaluate(() => "navigation" in window))) skip(leftName, "without the Navigation API a link is a full load");
  else {
    const { own, seen } = await writtenPage(brand);
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {() => void} */
    let asked = () => {};
    const waiting = new Promise((resolve) => (asked = () => resolve(true)));
    // Held only while the write's page waits for it: the page the user goes to may need it too.
    await own.route("**/scripts/quoted.js", async (route) => {
      asked();
      await held;
      await route.fallback().catch(() => {});
    });
    await own.click("main form button");
    const stalled = await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
    await own.click('main a[href="/smoke/quoted"]');
    release();
    const arrived = await own
      .waitForFunction(() => location.pathname === "/smoke/quoted" && !document.querySelector("main form") && !document.querySelector("[aria-busy]"), null, {
        timeout: 5000,
      })
      .then(
        () => true,
        () => false,
      );
    const shown = await shownOf(own);
    check(
      leftName,
      stalled && arrived && shown.brand === "Watchlist, written" && shown.same && seen.asked.includes("GET /smoke/quoted page"),
      JSON.stringify({ stalled, arrived, asked: seen.asked, shown }),
    );
    await own.context().close();
  }
  // Two writes from two forms, both done on the server, whose own pages are on their way. The
  // second's page comes first and waits for a module; then the first's comes and draws (made before
  // the second write was done, its count is 1), and the user leaves by a link. The first page's
  // layout does not draw what the second write changed, so the next page is still read whole and
  // shows the count the server has, 2.
  const bothName = "a write's own page drawn first leaves another write's change to the layout for the next page to draw";
  if (!(await page.evaluate(() => "navigation" in window))) skip(bothName, "without the Navigation API a link is a full load");
  else {
    // The first write's page draws no component, so it needs no module; the second's does.
    const counted = (/** @type {string} */ body, /** @type {number} */ writes) => {
      const counts = body.replace(">Watchlist</span>", `>Count ${writes}</span>`);
      return writes === 1 ? counts.replaceAll("data-on='connect:quoted", "data-held='connect:quoted") : counts;
    };
    const { own, seen } = await writtenPage(counted);
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {() => void} */
    let answerFirst = () => {};
    const first = new Promise((resolve) => (answerFirst = () => resolve(undefined)));
    seen.hold = (writes) => (writes === 1 ? first : undefined);
    /** @type {() => void} */
    let asked = () => {};
    const waiting = new Promise((resolve) => (asked = () => resolve(true)));
    await own.route("**/scripts/quoted.js", async (route) => {
      asked();
      await held;
      await route.fallback().catch(() => {});
    });
    await own.evaluate(() =>
      document.body.insertAdjacentHTML("beforeend", __html('<form id="second-write" method="post" action="/smoke/written" data-patch><button id="second-go">Write</button></form>')),
    );
    await own.click("main form button");
    await own.click("#second-go");
    // The second write's page has come and waits for the module; then the first's comes and draws.
    const stalled = await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
    answerFirst();
    const drewFirst = await own
      .waitForFunction(() => document.querySelector("header span")?.textContent === "Count 1" && !!document.querySelector("main p"), null, { timeout: 5000 })
      .then(
        () => true,
        () => false,
      );
    await own.click('main a[href="/smoke/quoted"]');
    release();
    const arrived = await own
      .waitForFunction(() => location.pathname === "/smoke/quoted" && !document.querySelector("main form") && !document.querySelector("main[aria-busy]"), null, {
        timeout: 5000,
      })
      .then(
        () => true,
        () => false,
      );
    const shown = await shownOf(own);
    check(
      bothName,
      stalled && drewFirst && seen.answers === 2 && arrived && shown.brand === "Count 2" && seen.asked.includes("GET /smoke/quoted page"),
      JSON.stringify({ stalled, drewFirst, answers: seen.answers, arrived, asked: seen.asked, shown }),
    );
    await own.context().close();
  }
  // The other order: two writes from two forms. The first is done on the server but its answer
  // is held; the second's page, made after both writes (count 2), draws. Then the first's comes
  // and draws, made before the second write (count 1): its layout is older than the one it
  // replaced, so the second write is undrawn again and the next page is read whole, with the count
  // the server has.
  const laterName = "a write's own page drawn after a later write's leaves that write's change to the layout for the next page to draw";
  if (!(await page.evaluate(() => "navigation" in window))) skip(laterName, "without the Navigation API a link is a full load");
  else {
    const counted = (/** @type {string} */ body, /** @type {number} */ writes) => body.replace(">Watchlist</span>", `>Count ${writes}</span>`);
    const { own, seen } = await writtenPage(counted);
    /** @type {() => void} */
    let answerFirst = () => {};
    const first = new Promise((resolve) => (answerFirst = () => resolve(undefined)));
    /** @type {() => void} */
    let reached = () => {};
    const done = new Promise((resolve) => (reached = () => resolve(true)));
    seen.hold = (writes) => (writes === 1 ? (reached(), first) : undefined);
    await own.evaluate(() =>
      document.body.insertAdjacentHTML("beforeend", __html('<form id="second-write" method="post" action="/smoke/written" data-patch><button id="second-go">Write</button></form>')),
    );
    const brandIs = (/** @type {string} */ text) =>
      own
        .waitForFunction((text) => document.querySelector("header span")?.textContent === text, text, { timeout: 5000 })
        .then(
          () => true,
          () => false,
        );
    await own.click("main form button");
    const written = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
    await own.click("#second-go");
    const drewSecond = await brandIs("Count 2");
    answerFirst();
    const drewFirst = await brandIs("Count 1");
    await own.click('main a[href="/smoke/quoted"]');
    const arrived = await own
      .waitForFunction(() => location.pathname === "/smoke/quoted" && !document.querySelector("main form") && !document.querySelector("main[aria-busy]"), null, {
        timeout: 5000,
      })
      .then(
        () => true,
        () => false,
      );
    const shown = await shownOf(own);
    check(
      laterName,
      written && drewSecond && drewFirst && arrived && shown.brand === "Count 2" && seen.asked.includes("GET /smoke/quoted page"),
      JSON.stringify({ written, drewSecond, drewFirst, answers: seen.answers, arrived, asked: seen.asked, shown }),
    );
    await own.context().close();
  }
  // A write the server has done, whose answer has not come when the user follows a link: the
  // navigation cuts it off, and since the write may have been applied, the next page is read whole
  // and shows what it changed.
  const cutOffName = "a navigation that cuts off a write before its answer reads the next page whole, with what the write changed";
  if (!(await page.evaluate(() => "navigation" in window))) skip(cutOffName, "without the Navigation API a link is a full load");
  else {
    const { own, seen } = await writtenPage(brand);
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {() => void} */
    let reached = () => {};
    const done = new Promise((resolve) => (reached = () => resolve(true)));
    seen.hold = () => (reached(), held);
    await own.click("main form button");
    // The server has done the write; its answer is held.
    const written = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
    await own.click('main a[href="/smoke/quoted"]');
    const arrived = await own
      .waitForFunction(() => location.pathname === "/smoke/quoted" && !document.querySelector("main form") && !document.querySelector("main[aria-busy]"), null, {
        timeout: 5000,
      })
      .then(
        () => true,
        () => false,
      );
    const shown = await shownOf(own);
    release();
    check(
      cutOffName,
      written && arrived && shown.brand === "Watchlist, written" && shown.same && seen.asked.includes("GET /smoke/quoted page"),
      JSON.stringify({ written, arrived, asked: seen.asked, shown }),
    );
    await own.context().close();
  }
  /**
   * Follows the link to /smoke/quoted, found and pressed in one page task, and whether that page
   * came in within 5 s counted from just before the press: the press task and the wait share those
   * 5 s (`pressWrite`). A page that reads itself again swaps <main> every second, so a Playwright
   * click can find the link, then land once it is gone, and the page never leaves (#2035).
   * @param {import("@playwright/test").Page} own
   */
  const toQuoted = async (own) => {
    const press = steps(5000, "/smoke/quoted did not come in within 5 s of the press");
    return press
      .step(() =>
        own.evaluate(() => {
          const link = /** @type {HTMLAnchorElement | null} */ (document.querySelector('main a[href="/smoke/quoted"]'));
          link?.click();
          return !!link;
        }),
      )
      .then(
        (pressed) =>
          pressed &&
          press.poll(() => own.evaluate(() => location.pathname === "/smoke/quoted" && !document.querySelector("main form") && !document.querySelector("main[aria-busy]"))),
      )
      .then(
        (came) => came === true,
        () => false,
      );
  };
  // A write the server applied whose answer the network lost: the page shows the failure in its
  // layout (as a toaster there does), for the user to send again. The page reading itself again
  // (`ReadAgain`) reads <main> alone and keeps the failure shown, where a whole page, whose header
  // the write changed, would draw it away; the next navigation reads the whole page, which shows
  // what the write changed.
  for (const legacy of [false, true]) {
    const failedName = legacy
      ? "a legacy write left undrawn does not make a poll replace the layout after a write failed"
      : "a write that failed in view leaves its change to the layout for the next page, and the page reading itself again keeps the failure shown";
    if (!(await page.evaluate(() => "navigation" in window))) {
      skip(failedName, "without the Navigation API a link is a full load");
      continue;
    }
    const { own, seen } = await writtenPage(brand, undefined, "/smoke/written/again");
    try {
      seen.fail = true;
      seen.nav = markNav;
      await watchMarks(own);
      // The page says the write failed in its header, as a toaster in the layout shows it.
      await within(
        5000,
        "the page's failure listener was not set within 5 s",
        own.evaluate(() => addEventListener("corten:error", () => document.querySelector("header")?.setAttribute("data-failed", ""))),
      );
      // The write the page's next read of itself follows: the failed one, or the legacy one after it.
      let follows = seen.writes + 1;
      const sent = await pressWrite(own, seen, "main form button");
      const failed =
        sent &&
        (await own
          .waitForFunction(() => !!document.querySelector("header[data-failed]") && !document.querySelector("[aria-busy]"), null, { timeout: 5000 })
          .then(
            () => true,
            () => false,
          ));
      let legacySent = true;
      let legacyDrew = true;
      if (legacy) {
        seen.fail = false;
        seen.draws = false;
        // Sent within 5 s from just before the press, then its <main> drawn within 5 s of the
        // check seeing it sent.
        await watchWritten(own);
        follows = seen.writes + 1;
        legacySent = await pressWrite(own, seen, "main form button");
        legacyDrew = legacySent && (await writtenSeen(own)) && "corten-page" in seen.answered;
      }
      // The page's first read of itself after the stand-in failed or answered that write, drawn
      // with the failure already shown (`nextPollDrawn`), and the failure still shown 500 ms after
      // that draw.
      const { again, drewAgain, drawn } = await nextPollDrawn(own, seen, seen.settled[follows], "");
      if (drewAgain) await own.waitForTimeout(500);
      const kept = drewAgain && (await own.evaluate(() => !!document.querySelector("header[data-failed]") && location.pathname === "/smoke/written/again"));
      const arrived = await toQuoted(own);
      const shown = await shownOf(own);
      check(
        failedName,
        failed && legacyDrew && again === "GET /smoke/written/again nav" && drewAgain && kept && arrived && shown.brand === "Watchlist, written" && shown.same && seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ sent, failed, legacySent, legacyDrew, again, drawn, drewAgain, kept, arrived, asked: seen.asked, shown }),
      );
    } finally {
      await closeContext(own.context(), "the failed write case's context");
    }
  }
  /** Whether the brand comes to read `text`. @param {import("@playwright/test").Page} own @param {string} text */
  const brandBecomes = (own, text) =>
    own
      .waitForFunction((text) => document.querySelector("header span")?.textContent === text, text, { timeout: 5000 })
      .then(
        () => true,
        () => false,
      );
  // A write that answers a patch for an element of the layout, beside a write whose own page is
  // whole, from two forms. The stand-in gives the brand an id, so a patch can draw it: the server's
  // count of writes is drawn by each whole page, and by the second write's patch.
  /** @param {number} patchOf the write that answers the patch */
  const patchedAndWhole = (patchOf) => {
    const withCount = (/** @type {string} */ body, /** @type {string} */ text) =>
      body.replace(/<span([^>]*)>Watchlist<\/span>/, `<span id="smoke-count"$1>${text}</span>`);
    return {
      before: (/** @type {string} */ body) => withCount(body, "Watchlist"),
      edit: (/** @type {string} */ body, /** @type {number} */ writes, /** @type {Record<string, string> | undefined} */ headers) => {
        if (!headers || writes !== patchOf) return withCount(body, `Count ${writes}`);
        delete headers["corten-shell"];
        headers["corten-patch"] = "";
        return `<span id="smoke-count">Count ${writes}</span>`;
      },
    };
  };
  const secondForm = (/** @type {import("@playwright/test").Page} */ own) =>
    own.evaluate(() =>
      document.body.insertAdjacentHTML("beforeend", __html('<form id="second-write" method="post" action="/smoke/written" data-patch><button id="second-go">Write</button></form>')),
    );
  // The first write's page is held while the second write's patch draws the count the server has
  // (2); then the first's page comes, made before the second write (its count is 1), and draws its
  // layout over the patch. The patch is in the record, so the next page is read whole and shows 2.
  const overName = "a write's own page drawn over a later write's patch to the layout leaves that write's change for the next page to draw";
  if (!(await page.evaluate(() => "navigation" in window))) skip(overName, "without the Navigation API a link is a full load");
  else {
    const { before, edit } = patchedAndWhole(2);
    const { own, seen } = await writtenPage(edit, before);
    /** @type {() => void} */
    let answerFirst = () => {};
    const first = new Promise((resolve) => (answerFirst = () => resolve(undefined)));
    seen.hold = (writes) => (writes === 1 ? first : undefined);
    await secondForm(own);
    await own.click("main form button");
    await own.click("#second-go");
    const patched = await brandBecomes(own, "Count 2");
    answerFirst();
    const drewOver = await brandBecomes(own, "Count 1");
    const arrived = await toQuoted(own);
    const shown = await shownOf(own);
    check(
      overName,
      patched && drewOver && arrived && shown.brand === "Count 2" && shown.same && seen.asked.includes("GET /smoke/quoted page"),
      JSON.stringify({ patched, drewOver, answers: seen.answers, arrived, asked: seen.asked, shown }),
    );
    await own.context().close();
  }
  // The other order: the first write's own page draws (count 1), then the second write's patch,
  // made after it, draws the count the server has (2). Nothing is older than what is drawn, so the
  // next page reads <main> alone and the count stays 2.
  const underName = "a write's patch to the layout drawn after another write's own page is current, and the next page reads <main> alone";
  if (!(await page.evaluate(() => "navigation" in window))) skip(underName, "without the Navigation API a link is a full load");
  else {
    const { before, edit } = patchedAndWhole(2);
    const { own, seen } = await writtenPage(edit, before);
    /** @type {() => void} */
    let answerSecond = () => {};
    const second = new Promise((resolve) => (answerSecond = () => resolve(undefined)));
    seen.hold = (writes) => (writes === 2 ? second : undefined);
    await secondForm(own);
    await own.click("main form button");
    await own.click("#second-go");
    const drewFirst = await brandBecomes(own, "Count 1");
    answerSecond();
    const patched = await brandBecomes(own, "Count 2");
    const arrived = await toQuoted(own);
    const shown = await shownOf(own);
    check(
      underName,
      drewFirst && patched && arrived && shown.brand === "Count 2" && shown.same && seen.asked.includes("GET /smoke/quoted nav"),
      JSON.stringify({ drewFirst, patched, answers: seen.answers, arrived, asked: seen.asked, shown }),
    );
    await own.context().close();
  }
  /**
   * When the page noted a held body cut (or given) and the failure shown for it (`__bodyAt`,
   * `__failedAt`, by its clock), and by when they had to come (`by`): 5 s from the body's release,
   * by the time the page recorded as it let go (`__releasedAt`), or, while it has not let go, 5 s
   * from the call. The check looks until `by` and once more after it (each look bounded to 5 s), and
   * the recorded times decide, so a check that looks late neither passes an outcome that came after
   * `by` nor fails one that came before it.
   * @param {import("@playwright/test").Page} own
   */
  const bodyOutcome = async (own) => {
    const start = Date.now();
    const look = () =>
      own.evaluate(() => {
        const state = /** @type {any} */ (window);
        return {
          releasedAt: /** @type {number | null} */ (state.__releasedAt ?? null),
          bodyAt: /** @type {number | null} */ (state.__bodyAt ?? null),
          failedAt: /** @type {number | null} */ (state.__failedAt ?? null),
        };
      });
    for (;;) {
      // A look started after `by` sees all the page recorded by then.
      const lookedAt = Date.now();
      const now = await within(5000, "the page did not say what became of the body within 5 s", look()).catch(() => null);
      if (now === null) return { releasedAt: null, bodyAt: null, failedAt: null, by: null };
      const by = (now.releasedAt ?? start) + 5000;
      if (now.failedAt !== null || lookedAt > by) return { ...now, by };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  // A write's body fails after its headers, optionally after another form's whole page has
  // already drawn over its ledger entry. Keep the first form in an unchanged layout element so
  // its error still bubbles. A poll leaves that failure in view; a link reads the layout anew.
  for (const [cutBodyName, overlap, status, complete] of [
    ["a write whose own page is cut off after its headers is a failure in view: the page reading itself again keeps it shown, and the next page is read whole", false, 200, false],
    ["a body failure remains visible to polls after a second write's whole page has drawn", true, 200, false],
    ["a cut 503 body keeps the failure visible to polls after a second write's whole page has drawn", true, 503, false],
    ["a completed 503 body keeps the failure visible to polls after a second write's whole page has drawn", true, 503, true],
  ] /** @type {const} */) {
    if (!(await page.evaluate(() => "navigation" in window))) {
      skip(cutBodyName, "without the Navigation API a link is a full load");
      continue;
    }
    const outside = (/** @type {string} */ body) =>
      overlap ? body.replace("</header>", '</header><aside><form id="held-write" method="post" action="/smoke/written/again" data-patch><button>Write first</button></form></aside>') : body;
    const { own, seen } = await writtenPage(
      (body, writes, headers) => {
        if (headers && writes === 1 && status === 503) {
          delete headers["corten-shell"];
          delete headers["corten-page"];
          return "Unavailable";
        }
        return outside(brand(body)).replace(">Watchlist, written</span>", overlap && !headers ? ">Poll brand</span>" : ">Watchlist, written</span>");
      },
      outside,
      "/smoke/written/again",
    );
    try {
      seen.status = status;
      seen.nav = markNav;
      await watchMarks(own);
      await within(
        5000,
        "the page's failure and body notes were not set within 5 s",
        own.evaluate(
          ({ overlap, status, complete }) => {
            const state = /** @type {any} */ (window);
            // The form that sends the first write (the first submitted from here on), noted as it is
            // submitted, before any handler of the page's.
            addEventListener("submit", (event) => (state.__heldForm ??= event.target), { capture: true });
            // Each failure the page says, with what had become of the held body at that moment and
            // whether it was said on the form that sent the held write, so the check takes a failure as
            // the body's only if it came after the body was cut (or given), on that form.
            /** @type {{ status: number, body: string | null, onHeldForm: boolean, target: string, time: number }[]} */
            const errors = [];
            state.__errors = errors;
            addEventListener("corten:error", (event) => {
              const failed = String((/** @type {CustomEvent} */ (event)).detail.status);
              const target = event.target;
              errors.push({
                status: Number(failed),
                body: state.__bodyAfterHeaders ?? null,
                onHeldForm: target instanceof HTMLFormElement && target === state.__heldForm,
                target: target instanceof Element ? `${target.localName}${target.id ? `#${target.id}` : ""}` : target === window ? "window" : String(target),
                time: Date.now(),
              });
              document.querySelector("header")?.setAttribute("data-failed", failed);
            });
            // The moment the expected failure is shown for the body, by the page's clock: the body cut
            // (or given), the page's first failure the expected one, said after that on the form that
            // sent the held write, the header saying it and nothing busy. The check compares that
            // moment with the body's release, however late it looks.
            const expected = complete ? 503 : 0;
            const note = complete ? "completed" : "cut";
            new MutationObserver((_, observer) => {
              const first = errors[0];
              const shown =
                state.__bodyAfterHeaders === note &&
                first?.status === expected &&
                first.body === note &&
                first.onHeldForm &&
                document.querySelector("header")?.getAttribute("data-failed") === String(expected) &&
                !document.querySelector("[aria-busy]");
              if (!shown) return;
              state.__failedAt = Date.now();
              observer.disconnect();
            }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy", "data-failed"] });
            const fetch_ = window.fetch;
            let cut = false;
            window.fetch = async function (input, init) {
              const res = await fetch_.call(this, input, init);
              if (!cut && init?.method === "POST") {
                cut = true;
                /** @template T @param {() => Promise<T>} body */
                const held = (body) => new Promise((resolve, reject) => {
                  // Noted here alone: the write's headers came and its body was asked for, then cut (or,
                  // complete, given in full), so a write that failed before its headers is not taken for
                  // it. Letting go does not wait for the body: a body that never comes leaves no note.
                  const release = () => {
                    // When it was let go, by the page's clock: the page's next read is counted from it.
                    state.__releasedAt = Date.now();
                    if (!complete) {
                      state.__bodyAfterHeaders = "cut";
                      state.__bodyAt = Date.now();
                      reject(new TypeError("network error"));
                      return;
                    }
                    body().then((value) => {
                      state.__bodyAfterHeaders = "completed";
                      state.__bodyAt = Date.now();
                      resolve(value);
                    }, reject);
                  };
                  if (overlap) state.__releaseBody = release;
                  else release();
                });
                if (status === 503) {
                  const body = res.arrayBuffer.bind(res);
                  res.arrayBuffer = () => held(body);
                } else {
                  const body = res.text.bind(res);
                  res.text = () => held(body);
                }
              }
              return res;
            };
          },
          { overlap, status, complete },
        ),
      );
      // The write whose body is cut (or given): the page's next read of itself follows its answer, or,
      // with a second write, the body's release, before which it cannot fail.
      const first = seen.writes + 1;
      let sent = await pressWrite(own, seen, overlap ? "#held-write button" : "main form button");
      // With a second write, the first's body is asked for within 5 s of its press being seen sent.
      let bodyAsked = !overlap;
      let drewOver = true;
      let released = !overlap;
      /** @type {Since | undefined} */
      let releasedAt;
      if (overlap && sent) {
        bodyAsked = await own.waitForFunction(() => typeof (/** @type {any} */ (window)).__releaseBody === "function", null, { timeout: 5000 }).then(
          () => true,
          () => false,
        );
        drewOver = false;
        if (bodyAsked) {
          seen.status = 0;
          // The second write's own page drawn before the first's body is let go: its <main> and the
          // brand it brought at the same moment, nothing in <main> busy (the first form, outside it,
          // waits for its body).
          await watchWritten(own, "Watchlist, written", true);
          sent = await pressWrite(own, seen, "main form button");
          drewOver = sent && (await writtenSeen(own));
          // Let go in a page task that does not wait for the body, bounded: whether the body came
          // and the failure it brings are what the bounded wait below checks. The page's next read
          // is counted from the release itself: its place among the reads is taken before the page
          // is asked to let go, and its time is the one the page recorded as it let go, and a read
          // counts only if it reached the stand-in at or after that time too (`readAsked`), so a
          // read made while the body was still held, or while the task that lets it go waited to
          // run, is a read before the failure (`nextPollDrawn`).
          if (drewOver) {
            const at = seen.asked.length;
            const time = await within(
              5000,
              "the body was not let go within 5 s",
              own.evaluate(() => {
                const state = /** @type {any} */ (window);
                state.__releaseBody();
                return /** @type {number} */ (state.__releasedAt);
              }),
            ).catch(() => undefined);
            released = typeof time === "number";
            if (released) releasedAt = { at, time: /** @type {number} */ (time) };
          }
        }
      }
      // The body cut (or given in full) and the failure shown for it, both within 5 s of the body's
      // release, by the times the page recorded for the three (`bodyOutcome`): the page's first
      // failure must be the expected one, said once the body was cut (or given), not before, and on
      // the form that sent the held write.
      const outcome = await bodyOutcome(own);
      const failed =
        outcome.by !== null && outcome.bodyAt !== null && outcome.bodyAt <= outcome.by && outcome.failedAt !== null && outcome.failedAt <= outcome.by;
      const { afterHeaders, errors } = await own.evaluate(() => ({
        afterHeaders: /** @type {string | undefined} */ ((/** @type {any} */ (window)).__bodyAfterHeaders) ?? null,
        errors: /** @type {unknown[]} */ ((/** @type {any} */ (window)).__errors),
      }));
      const { again, drewAgain, drawn } = await nextPollDrawn(own, seen, overlap ? releasedAt : seen.settled[first], String(complete ? 503 : 0));
      if (drewAgain) await own.waitForTimeout(500);
      const kept = drewAgain && (await own.evaluate(() => !!document.querySelector("header[data-failed]")));
      const arrived = await toQuoted(own);
      const shown = await shownOf(own);
      check(
        cutBodyName,
        sent && bodyAsked && drewOver && released && failed && afterHeaders === (complete ? "completed" : "cut") && seen.answers === (overlap ? 2 : 1) &&
          again === "GET /smoke/written/again nav" && drewAgain && kept && arrived && shown.brand === (overlap ? "Poll brand" : "Watchlist, written") &&
          seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ sent, bodyAsked, drewOver, released, failed, outcome, afterHeaders, errors, answers: seen.answers, again, drawn, drewAgain, kept, arrived, asked: seen.asked, shown }),
      );
    } finally {
      await closeContext(own.context(), "the cut body case's context");
    }
  }
  // A write whose own page reads itself again (ReadAgain) draws, so the page reads itself whole
  // from then on; then a second write is applied and its answer lost, and the page shows the
  // failure in its layout. Reading itself again, the page reads <main> alone, which keeps the
  // failure shown, where a whole page (whose count the second write changed) would draw it away.
  const againName = "after a write's own page that reads itself again, a write that failed in view stays shown while the page reads itself again";
  if (!(await page.evaluate(() => "navigation" in window))) skip(againName, "without the Navigation API a link is a full load");
  else {
    // Each whole page after the write is marked with its read's place in `seen.asked` (`watchMarks`),
    // so the check tells the whole read's draw from the write's, which shows the same count.
    const counted = (
      /** @type {string} */ body,
      /** @type {number} */ writes,
      /** @type {Record<string, string> | undefined} */ headers,
      /** @type {number | undefined} */ at,
    ) => body.replace(/<span([^>]*)>Watchlist<\/span>/, `<span$1${headers ? "" : ` data-smoke-at="${at}"`}>Count ${writes}</span>`);
    const { own, seen } = await writtenPage(counted, undefined, "/smoke/written/again");
    try {
      seen.nav = markNav;
      await within(
        5000,
        "the page's failure listener was not set within 5 s",
        own.evaluate(() => addEventListener("corten:error", () => document.querySelector("header")?.setAttribute("data-failed", ""))),
      );
      await watchWritten(own, "Count 1");
      await watchMarks(own);
      const firstWrite = seen.writes + 1;
      const sentFirst = await pressWrite(own, seen, "main form button");
      const drew = sentFirst && (await writtenSeen(own));
      // Read whole while it reads itself again: the page's first read of itself after the stand-in
      // answered the write is asked within 5 s of that answer, and its answer drawn within 5 s of
      // that read (`drawnBy`), before the second write is clicked.
      const firstSettled = seen.settled[firstWrite];
      const wholeAt = firstSettled === undefined ? null : await readAsked(seen, firstSettled);
      const wholeBefore = wholeAt === null ? null : seen.asked[wholeAt];
      const wholeDrawn = wholeAt !== null && (await drawnBy(own, wholeAt, seen.askedAt[wholeAt] + 5000)) !== null;
      seen.fail = true;
      // Clicked as before, not pressed in one page task (`pressWrite`): that press can come between
      // a whole read's answer and its draw, which replaces the form while the write is out, and the
      // runtime then says the write failed on the form it replaced, where the page does not hear it
      // (#2068). This check does not cover that order: its click comes once the read before it is
      // drawn. The click must land within 5 s of being asked for, and its write reach the stand-in
      // within 5 s of the click returning.
      let sentSecond = false;
      let failed = false;
      /** @type {number | undefined} */
      let secondWrite;
      if (wholeDrawn) {
        const writesBefore = seen.writes;
        secondWrite = writesBefore + 1;
        const clicked = await own.click("main form button", { timeout: 5000 }).then(
          () => true,
          () => false,
        );
        sentSecond = clicked && (await pollFor(5000, async () => seen.writes > writesBefore)) === true;
        failed =
          sentSecond &&
          (await own
            .waitForFunction(() => !!document.querySelector("header[data-failed]") && !document.querySelector("[aria-busy]"), null, { timeout: 5000 })
            .then(
              () => true,
              () => false,
            ));
      }
      // The page's first read of itself after the stand-in failed the second write, drawn with the
      // failure already shown.
      const { again, drewAgain, drawn } = await nextPollDrawn(own, seen, secondWrite === undefined ? undefined : seen.settled[secondWrite], "");
      if (drewAgain) await own.waitForTimeout(500);
      const kept = drewAgain && (await own.evaluate(() => !!document.querySelector("header[data-failed]") && document.querySelector("header span")?.textContent === "Count 1"));
      const arrived = await toQuoted(own);
      const shown = await shownOf(own);
      check(
        againName,
        drew &&
          wholeBefore === "GET /smoke/written/again page" &&
          wholeDrawn &&
          failed &&
          again === "GET /smoke/written/again nav" &&
          drewAgain &&
          kept &&
          arrived &&
          shown.brand === "Count 2" &&
          seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ sentFirst, drew, wholeBefore, wholeDrawn, sentSecond, failed, again, drawn, drewAgain, kept, arrived, asked: seen.asked, shown }),
      );
    } finally {
      await closeContext(own.context(), "the read-again failure case's context");
    }
  }
  const waitingPollName = "a whole poll waiting for its stylesheet does not replace the layout after a write fails";
  if (!(await page.evaluate(() => "navigation" in window))) skip(waitingPollName, "without the Navigation API the poll reloads");
  else {
    const { own, seen } = await writtenPage(
      (body, _writes, headers) =>
        headers ? brand(body) : body.replace(">Watchlist</span>", ">Late poll</span>").replace("</head>", '<link rel="stylesheet" data-corten-style href="/assets/smoke-held-poll.css"></head>'),
      undefined,
      "/smoke/written/again",
    );
    // Each navigation's <main> is marked with its read's place in `seen.asked` (`watchMarks`), so the
    // check sees the partial answer after the held poll drawn, not only its headers.
    seen.nav = markNav;
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    // The check's evidence, each part bounded from its own start; a part not seen in time leaves the
    // ones after it unmade, and the hold, routes and page go however it ends.
    const got = {
      sent: false,
      drew: false,
      waiting: false,
      sentFailing: false,
      failed: false,
      retry: /** @type {string | undefined} */ (undefined),
      drawnNext: /** @type {{ time: number, failed: string | null } | null} */ (null),
      drewNext: false,
      kept: false,
    };
    try {
      await within(
        5000,
        "the held stylesheet's route was not set within 5 s",
        own.route("**/assets/smoke-held-poll.css", async (route) => {
          await held;
          await route.fulfill({ contentType: "text/css", body: "" }).catch(() => {});
        }),
      );
      await within(
        5000,
        "the page's failure listener was not set within 5 s",
        own.evaluate(() => addEventListener("corten:error", () => document.querySelector("header")?.setAttribute("data-failed", ""))),
      );
      await watchWritten(own, "Watchlist, written");
      await watchMarks(own);
      // The whole poll that reads the page a second after the write's page is drawn asks for the
      // stylesheet, within 5 s from just before the press.
      const asset = own.waitForRequest("**/assets/smoke-held-poll.css", { timeout: 5000 }).then(() => true, () => false);
      got.sent = await pressWrite(own, seen, "main form button");
      got.drew = got.sent && (await writtenSeen(own));
      got.waiting = await asset;
      if (got.drew && got.waiting) {
        seen.fail = true;
        got.sentFailing = await pressWrite(own, seen, "main form button");
        got.failed =
          got.sentFailing &&
          (await own
            .waitForFunction(() => !!document.querySelector("header[data-failed]") && !document.querySelector("[aria-busy]"), null, { timeout: 5000 })
            .then(() => true, () => false));
      }
      if (got.failed) {
        // Once the held poll is out of the way, the next read asks for a partial response, and its
        // answer is drawn with the failure shown, both within 5 s of the hold's release (the draw's
        // time recorded by the page). A whole draw of the held answer would have replaced the
        // header and lost its failure mark.
        const from = sinceNow(seen);
        release();
        const nextAt = await readAsked(seen, from);
        got.retry = nextAt === null ? undefined : seen.asked[nextAt].split(" ")[2];
        got.drawnNext = nextAt === null ? null : await drawnBy(own, nextAt, from.time + 5000);
        got.drewNext = got.drawnNext?.failed === "";
        got.kept = await own.evaluate(() => !!document.querySelector("header[data-failed]") && document.querySelector("header span")?.textContent === "Watchlist, written");
      }
    } finally {
      release();
      await cleanUp(
        () => within(5000, "the stylesheet case's routes were not removed within 5 s", own.unrouteAll({ behavior: "ignoreErrors" })),
        () => closeContext(own.context(), "the stylesheet case's context"),
      );
    }
    check(
      waitingPollName,
      got.sent && got.drew && got.waiting && got.sentFailing && got.failed && got.retry === "nav" && got.drewNext && got.kept,
      JSON.stringify({ ...got, asked: seen.asked }),
    );
  }
  // A write's own page that refuses it (422), with a field marked invalid below the fold: drawn in
  // the same document at the same address, with no history entry added, focus on that field (in
  // view), and what the user typed into a control of the layout kept, though the layout around it is
  // drawn anew (the brand changed). Its caret is not asserted: the runtime keeps a selection only for
  // the focused control, and focus is on the refused field.
  {
    const find = (/** @type {string} */ body) => body.replace(/(<header\b[^>]*>)/, '$1<input id="smoke-find" name="find" aria-label="Find">');
    const refusal = (/** @type {string} */ body, /** @type {number} */ _writes, /** @type {Record<string, string> | undefined} */ headers) =>
      find(brand(headers ? body.replace("<button>Write</button>", `${"<br>".repeat(200)}<input name="price" aria-invalid="true" value="1.2"><button>Write</button>`) : body));
    const { own, seen } = await writtenPage(refusal, find);
    seen.status = 422;
    const entries = await own.evaluate(() => history.length);
    await own.fill("#smoke-find", "abcdef");
    await own.click("main form button");
    const drawn = await own
      .waitForFunction(() => document.activeElement?.getAttribute("name") === "price", null, { timeout: 5000 })
      .then(
        () => true,
        () => false,
      );
    const shown = await shownOf(own);
    const state = await own.evaluate(() => {
      const findIn = /** @type {HTMLInputElement | null} */ (document.getElementById("smoke-find"));
      const field = document.activeElement?.getBoundingClientRect();
      return {
        entries: history.length,
        find: findIn?.value,
        // Shown, not whole: WebKit scrolls a focused field just far enough to show part of it.
        inView: !!field && field.bottom > 0 && field.top < innerHeight,
        scrolled: scrollY > 0,
      };
    });
    check(
      "a write's own page that refuses it keeps the document, address and history, focuses the field it marked, in view, and keeps what the user typed in the layout",
      drawn &&
        shown.brand === "Watchlist, written" &&
        shown.same &&
        shown.path === "/smoke/written" &&
        state.entries === entries &&
        state.find === "abcdef" &&
        state.inView &&
        state.scrolled,
      JSON.stringify({ drawn, shown, entries, state }),
    );
    await own.context().close();
  }
  // A write's own page whose frame differs from the page's draws <main> alone, and the layout's
  // elements that are the page's (the sector links, `page` in `html!`) with it, as a navigation
  // does: the write's page has other sector links than the form's. This guards the fallback when the
  // layout cannot be drawn (main, whose answer for the write was <main> and those parts, passes it
  // too), not the drawing of the layout itself.
  for (const shadow of ["closest", "parentElement"]) {
    const section = (/** @type {string} */ name) => (/** @type {string} */ body) =>
      body.replace(/<nav(\b[^>]*\bid="sector-nav"[^>]*)>(.*?)<\/nav>/s, (_nav, attrs, children) => {
        const content = `<a href="/news">${name} section</a>${children}`;
        return shadow === "closest"
          ? `<form><input name="closest" type="hidden"><nav${attrs}>${content}</nav></form>`
          : `<form${attrs}><input name="parentElement" type="hidden">${content}</form>`;
      });
    const { own } = await writtenPage((body) => section("New")(body).replace("<body ", '<body data-smoke-frame="other" '), section("Old"));
    const first = await shownOf(own);
    await own.click("main form button");
    const drawn = await writtenIn(own);
    const shown = await shownOf(own);
    check(
      `a write's own page in another frame draws <main> and its layout parts with a form control named ${shadow}`,
      first.section === "Old section" && drawn && shown.section === "New section" && shown.same && shown.path === "/smoke/written",
      JSON.stringify({ first: first.section, drawn, shown }),
    );
    await own.context().close();
  }
  // A write sent without its `Prefer: corten-draws=whole`, as a runtime from before it sends one (a tab open across
  // the deploy that brought it): the server answers <main> alone, as it did then, which that
  // runtime draws, where a whole page would be an answer it does not draw (it would say the write
  // failed). This runtime, given <main> alone for a write (a server from before), draws it and reads
  // the next page whole, which shows what the write changed.
  const oldName = "a write that does not say it draws the whole page gets <main> alone, and the next page is read whole";
  if (!(await page.evaluate(() => "navigation" in window))) skip(oldName, "without the Navigation API a link is a full load");
  else {
    const { own, seen } = await writtenPage(brand);
    seen.draws = false;
    await own.evaluate(() => addEventListener("corten:error", () => ((/** @type {any} */ (window)).__failed = true)));
    await own.click("main form button");
    const drawn = await writtenIn(own);
    const between = await shownOf(own);
    await own.click('main a[href="/smoke/quoted"]');
    const arrived = await own
      .waitForFunction(() => location.pathname === "/smoke/quoted" && !document.querySelector("main form") && !document.querySelector("main[aria-busy]"), null, {
        timeout: 5000,
      })
      .then(
        () => true,
        () => false,
      );
    const failed = await own.evaluate(() => !!(/** @type {any} */ (window)).__failed);
    const shown = await shownOf(own);
    check(
      oldName,
      drawn &&
        "corten-page" in seen.answered &&
        between.brand === "Watchlist" &&
        !failed &&
        arrived &&
        shown.brand === "Watchlist, written" &&
        shown.same &&
        seen.asked.includes("GET /smoke/quoted page"),
      JSON.stringify({ drawn, page: seen.answered["corten-page"] ?? null, between: between.brand, failed, arrived, asked: seen.asked, shown }),
    );
    await own.context().close();
  }
  // A real mixed deployment has different runtime bytes and therefore a different shell key.
  // Keep the shell guard: reload the current URL, without drawing or resending the refusal.
  {
    const { own, seen } = await writtenPage((body, _writes, headers) => {
      if (!headers) return body;
      headers["corten-shell"] = "old-deploy";
      return body.replace("Written by the form's own page.", "An old server refused this write.");
    });
    seen.draws = false;
    seen.status = 422;
    const reloaded = own.waitForEvent("framenavigated", { predicate: (frame) => frame === own.mainFrame(), timeout: 5000 }).then(() => true, () => false);
    await own.locator("main form button").evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
    const loaded = await reloaded;
    const shown = await shownOf(own);
    const refused = await own.locator("main").textContent();
    check(
      "a legacy action answer with a different shell key reloads without drawing or resending the refusal",
      loaded && "corten-page" in seen.answered && !shown.same && shown.path === "/smoke/written" && seen.writes === 1 &&
        seen.asked.filter((ask) => ask === "GET /smoke/written -").length === 2 && !refused?.includes("refused this write"),
      JSON.stringify({ loaded, shown, writes: seen.writes, asked: seen.asked, refused }),
    );
    await own.context().close();
  }
  // A write that answers a patch (here one for an element of the layout) is done once its answer
  // comes, but drawn only once the scripts the patch names load. Left by a link in that window,
  // the navigation cuts it off: the next page is read whole, with what the write changed.
  const patchName = "a navigation that leaves a write's patch before it is drawn reads the next page whole";
  if (!(await page.evaluate(() => "navigation" in window))) skip(patchName, "without the Navigation API a link is a full load");
  else {
    const patched = (/** @type {string} */ body, /** @type {number} */ _writes, /** @type {Record<string, string> | undefined} */ headers) => {
      if (!headers) return brand(body);
      delete headers["corten-shell"];
      headers["corten-patch"] = "";
      return '<nav id="sector-nav" data-on="connect:quoted.show()">Patched section</nav>';
    };
    const { own, seen } = await writtenPage(patched);
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {() => void} */
    let asked = () => {};
    const waiting = new Promise((resolve) => (asked = () => resolve(true)));
    // The held script is let go, its route removed and the page closed however the case ends, each
    // bounded, as setting the route is.
    try {
      await within(
        5000,
        "the held script's route was not set within 5 s",
        own.route("**/scripts/quoted.js", async (route) => {
          asked();
          await held;
          await route.fallback().catch(() => {});
        }),
      );
      await own.click("main form button");
      const stalled = await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
      await own.click('main a[href="/smoke/quoted"]');
      release();
      const arrived = await own
        .waitForFunction(() => location.pathname === "/smoke/quoted" && !document.querySelector("main form") && !document.querySelector("main[aria-busy]"), null, {
          timeout: 5000,
        })
        .then(
          () => true,
          () => false,
        );
      const shown = await shownOf(own);
      check(
        patchName,
        stalled && seen.answers === 1 && arrived && shown.brand === "Watchlist, written" && shown.same && seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ stalled, answers: seen.answers, arrived, asked: seen.asked, shown }),
      );
      // The patch was answered before that page was asked for, so the page's layout drew it: the
      // navigation after reads <main> alone, not the whole page again. Only its reads of
      // /smoke/written count: the pointer left on the link clicked above can make the page that comes
      // prefetch /smoke/quoted, after the navigation's read (#2035).
      const sinceReturn = seen.asked.length;
      await own.evaluate(() => /** @type {any} */ (window).navigation.navigate("/smoke/written"));
      const returned = await own
        .waitForFunction(() => location.pathname === "/smoke/written" && !!document.querySelector("main form") && !document.querySelector("main[aria-busy]"), null, {
          timeout: 5000,
        })
        .then(
          () => true,
          () => false,
        );
      const reads = seen.asked.slice(sinceReturn).filter((a) => a.startsWith("GET /smoke/written "));
      check(
        "a write's patch answered before a navigation left it is drawn by that page, and the next navigation reads <main> alone",
        returned && reads.join() === "GET /smoke/written nav",
        JSON.stringify({ returned, reads, asked: seen.asked }),
      );
    } finally {
      release();
      await cleanUp(
        () => within(5000, "the patch case's routes were not removed within 5 s", own.unrouteAll({ behavior: "ignoreErrors" })),
        () => closeContext(own.context(), "the patch case's context"),
      );
    }
  }
}
