import { base, skip, check, pollRecord, pollAsync, cleanUp, steps, within, readWithin, actWithin, cameWithin, leftOf, notedBy, lookUntil, pause, exchange, letThrough, opened, closeContext } from "./helpers.mjs";

export async function pageWrites(page, browser) {
  /** Whether the browser has the Navigation API, read within 5 s. */
  const hasNavigation = () => readWithin("whether the browser has the Navigation API", page.evaluate(() => "navigation" in window));
  // After a write, the page it sends the browser to is fetched whole; when that page's handler
  // sends it on to a place, the server names the place (`corten-location`, for the runtime's
  // `corten: page`), so it keeps its `#id` rather than `fetch` following a 303 without it
  // (#1034). The stand-in answers as the server does: `corten-location` to the runtime's
  // fetches, a 303 to any other.
  const wholePlaceName = "a page fetched whole after a write that sends the browser to a place lands on the place";
  if (!(await hasNavigation())) skip(wholePlaceName, "without the Navigation API a write's page is a full load");
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
   * A moment a read is counted from: the length of `seen.asked` then (`at`) and the time by the
   * smoke's monotonic clock (`performance.now()` here, as `seen.askedAt`), or, for a moment the page
   * recorded as it made it (`page`), by the page's own monotonic clock (`performance.now()` there).
   * Neither is the wall clock, which a step moves, and the two monotonic clocks are never compared
   * with each other: a time the stand-in recorded is compared with another the stand-in recorded,
   * and one the page recorded with another the page recorded (a draw with the start of the read it
   * draws, `seen.startedAt`, or with the press the page made, `Pressed.at`). With `page`, `time` is
   * the smoke's moment just before it asked the page, for details only.
   * @typedef {{ at: number, time: number, page?: number }} Since
   */
  /** Now, as a `Since`, by the smoke's monotonic clock. @param {{ asked: string[] }} seen @returns {Since} */
  const sinceNow = (seen) => ({ at: seen.asked.length, time: performance.now() });
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
   * `askedAt` holds the time each request in `asked` reached the stand-in, by the same place, by the
   * smoke's monotonic clock; `startedAt`, by the same place, the time the page started that request,
   * by the page's monotonic clock, as the request itself carries it (`smoke-start`, which a wrapper of
   * the page's `fetch`, added before the page loads, puts on each of its same-origin fetches; NaN for
   * a request without it, such as a load), so a draw the page recorded can be counted from the read
   * that brought it by one clock. `styled`, by the same place, whether the page had noted the held
   * stylesheet's load (`__heldStyleAt`, which the stylesheet case sets as the document captures that
   * load) when it started the request, as the wrapper marks it on the request in the same task
   * (`smoke-styled`), so which came first is the page's own order of events, not two times compared.
   * `settled` holds, by each write's number, the length of `asked` and the time the moment the
   * stand-in fails that write or hands the page its answer (`Since`): no read the page asked after
   * it saw that answer, or that write fail, has a place before it, and a bound on that read counts
   * from that time, not from when a check saw the outcome.
   * `delivered` holds, by its place in `asked`, the same for each read a case held (`holdRead`), the
   * moment the stand-in hands the page its answer once the hold is let go.
   * Each answer's steps (its fetch, its body and its fulfill) have 5 s each (`exchange`), a hold the
   * case controls aside, and none is sent once the case sets `over` (each case does as it ends, before
   * it lets go of what it holds): the request is aborted instead, its context closing. Why an answer
   * was not given as meant is in `faults`, and `answers` counts only the writes whose fulfill was
   * confirmed. Each write's answer carries a mark of its own (its `smoke-write` header, unique to the
   * page and the write's number), and `finished` holds, by the write's number, the length of `asked`
   * and the time the check heard the browser finish loading that write with that answer (its
   * `requestfinished`): a fulfill that resolves need not have answered the write.
   * Making the context and the page is bounded to 30 s, Playwright's own timeout, as their closing
   * is (`opened`, `closeContext`); setting its route and marking it are each bounded to 5 s (its
   * load has Playwright's own 30 s), and the page is closed (`closeContext`) if one of them fails.
   * @param {(body: string, writes: number, headers?: Record<string, string>, at?: number) => string} edit @param {(body: string) => string} [before]
   * @param {string} [path]
   */
  const writtenPage = async (edit, before = (body) => body, path = "/smoke/written") => {
    const context = await opened("the write case's context", browser.newContext());
    /** The mark of this page's write answers (`smoke-write`), with each write's number after it. */
    const mark = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const seen = {
      /** Set as the case ends: no answer under way is sent (`exchange`). */
      over: false,
      /** Why an answer was not given as meant (`exchange`), in the order they came. @type {string[]} */
      faults: [],
      /** By write number, the length of `asked` and the time the browser finished that write with its marked answer. @type {Record<number, Since>} */
      finished: {},
      written: false,
      fail: false,
      draws: true,
      status: 0,
      writes: 0,
      answers: 0,
      /** @type {string[]} */ asked: [],
      /** When each request in `asked` reached the stand-in (`performance.now()` here). @type {number[]} */ askedAt: [],
      /** When the page started each request in `asked` (`performance.now()` there, its `smoke-start`), or NaN. @type {number[]} */ startedAt: [],
      /** Whether the page had noted the held stylesheet's load when it started each request in `asked` (its `smoke-styled`). @type {boolean[]} */ styled: [],
      /** @type {Record<string, string>} */ answered: {},
      /** By write number, the length of `asked` and the time when the stand-in failed or answered it. @type {Record<number, Since>} */
      settled: {},
      /** By its place in `asked`, the length of `asked` and the time when the stand-in handed a held read its answer. @type {Record<number, Since>} */
      delivered: {},
      /** Changes a navigation's <main>, given the request's place in `asked`. @type {(body: string, at: number) => string} */
      nav: (/** @type {string} */ body, /** @type {number} */ _at) => body,
      /** What a write's answer waits for, by the write's number. @type {(writes: number) => Promise<unknown> | undefined} */
      hold: (/** @type {number} */ _writes) => /** @type {Promise<unknown> | undefined} */ (undefined),
      /**
       * What the answer to any other request waits for, by its place in `asked`: asked the moment the
       * request reaches the stand-in, before its answer is fetched, which then waits for it.
       * @type {(at: number) => Promise<unknown> | undefined}
       */
      holdRead: (/** @type {number} */ _at) => /** @type {Promise<unknown> | undefined} */ (undefined),
    };
    // Closed here if the page, its route or its load fails: no case has the page to close yet.
    try {
      const own = await within(30_000, "the write case's page was not made within 30 s", context.newPage());
      // Each same-origin fetch the page makes carries the time the page started it, by its own
      // monotonic clock (`smoke-start`), from before its load, and, once the page has noted the held
      // stylesheet's load (`__heldStyleAt`), that it had (`smoke-styled`), read in the same task.
      await within(
        5000,
        "the write case's fetch wrapper was not added within 5 s",
        own.addInitScript(() => {
          const original = window.fetch;
          window.fetch = function (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit | undefined} */ init) {
            const started = performance.now();
            try {
              if (new URL(input instanceof Request ? input.url : String(input), location.href).origin === location.origin) {
                const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
                headers.set("smoke-start", String(started));
                if ((/** @type {any} */ (window)).__heldStyleAt !== undefined) headers.set("smoke-styled", "1");
                return original.call(this, input, { ...init, headers });
              }
            } catch {}
            return original.apply(this, /** @type {any} */ (arguments));
          };
        }),
      );
      await within(
        5000,
        "the write case's route was not set within 5 s",
        own.route(
          (url) => url.origin === new URL(base).origin && !url.pathname.startsWith("/assets/"),
          async (route) => {
            const req = route.request();
            const mode = req.headers().corten;
            const write = req.method() === "POST" && ["/smoke/written", "/smoke/written/again"].includes(new URL(req.url()).pathname);
            if (seen.over || (!write && !(req.resourceType() === "document" || mode === "page" || mode === "nav"))) return letThrough(route);
            const at = seen.asked.length;
            seen.asked.push(`${req.method()} ${new URL(req.url()).pathname} ${mode ?? "-"}`);
            seen.askedAt.push(performance.now());
            seen.startedAt.push(Number(req.headers()["smoke-start"] ?? NaN));
            seen.styled.push(req.headers()["smoke-styled"] === "1");
            // Counted as the write is sent, so the writes are numbered in the order the page sent them.
            if (write) seen.writes += 1;
            const writes = seen.writes;
            // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
            const sent = { ...req.headers(), "accept-encoding": "identity" };
            // The page's start time and its note of the stylesheet are the check's, not the server's.
            delete sent["smoke-start"];
            delete sent["smoke-styled"];
            if (write && !seen.draws) delete sent.prefer;
            // Each step within 5 s, and nothing sent once the case is over, when the request is aborted
            // (`exchange`); the holds are the case's, outside those bounds.
            const ex = exchange(route, `the write case's answer to ${write ? `write ${writes}` : seen.asked[at]}`, () => seen.over, () => route.abort());
            try {
              // Decide the hold on arrival. Observe a rejection even while the fetch is still
              // pending; awaiting the same promise below still reports the original failure.
              const holding = write ? undefined : seen.holdRead(at);
              holding?.catch(() => {});
              const res = await ex.step(5000, "its fetch", () => route.fetch({ headers: sent }));
              const headers = res.headers();
              if (write) seen.answered = { ...headers };
              delete headers["content-encoding"];
              delete headers["content-length"];
              const text = await ex.step(5000, "reading its answer", () => res.text());
              // A navigation's <main> has no layout to change: only `seen.nav` changes it.
              const body = mode === "nav" ? seen.nav(text, at) : write || seen.written ? edit(text, writes, write ? headers : undefined, at) : before(text);
              seen.written ||= write;
              if (write && seen.fail) {
                seen.settled[writes] = sinceNow(seen);
                await ex.send(5000, "its abort", () => route.abort("failed"));
                return;
              }
              if (write) await seen.hold(writes);
              else if (holding) {
                await holding;
                seen.delivered[at] = sinceNow(seen);
              }
              if (write) {
                seen.settled[writes] = sinceNow(seen);
                headers["smoke-write"] = `${mark}:${writes}`;
              }
              await ex.send(5000, "its fulfill", () => route.fulfill({ status: write && seen.status ? seen.status : res.status(), headers, body }));
              if (write) seen.answers += 1;
            } catch (error) {
              if (!ex.fault) await ex.stop(error instanceof Error ? error.message : String(error));
            } finally {
              if (ex.fault) seen.faults.push(ex.fault);
            }
          },
        ),
      );
      // The browser's end of each write with its marked answer (`finished`): the response's mark is
      // heard before the request's end, and only a write with this page's mark for its own number counts.
      /** @type {WeakMap<import("@playwright/test").Request, string>} */
      const marks = new WeakMap();
      own.on("response", (res) => {
        const written = res.headers()["smoke-write"];
        if (written !== undefined) marks.set(res.request(), written);
      });
      own.on("requestfinished", (r) => {
        const written = marks.get(r);
        const writes = written?.startsWith(`${mark}:`) ? Number(written.slice(mark.length + 1)) : NaN;
        if (r.method() === "POST" && Number.isInteger(writes) && writes > 0) seen.finished[writes] ??= sinceNow(seen);
      });
      await actWithin("the write case's page load", own.goto(`${base}${path}`));
      await within(
        5000,
        "the write case's page was not marked within 5 s",
        own.evaluate(() => ((/** @type {any} */ (window)).__marker = 1)),
      );
      return { own, seen };
    } catch (error) {
      seen.over = true;
      await closeContext(context, "the write case's context").catch(() => {});
      throw error;
    }
  };
  const brand = (/** @type {string} */ body) => body.replace(">Watchlist</span>", ">Watchlist, written</span>");
  /**
   * Whether the brand comes to read `text` within 5 s of `from`, the `performance.now()` time taken
   * just before what draws it (a press, or a held answer let go), by the smoke's clock (`cameWithin`).
   * @param {import("@playwright/test").Page} own @param {string} text @param {number} from
   */
  const brandBecomes = (own, text, from) => cameWithin(leftOf(from, 5000), own.waitForFunction((text) => document.querySelector("header span")?.textContent === text, text, { timeout: 5000 }));
  /** What the page shows of the layout, read within 5 s (`readWithin`). @param {import("@playwright/test").Page} own */
  const shownOf = (own) =>
    readWithin("what the page shows of the layout", own.evaluate(() => ({
      brand: document.querySelector("header span")?.textContent,
      section: document.getElementById("sector-nav")?.textContent ?? null,
      same: (/** @type {any} */ (window)).__marker === 1,
      path: location.pathname,
      title: document.title,
    })));
  /**
   * Whether the write's own page comes in within 5 s of `from`, the `performance.now()` time taken
   * just before the press that sends the write, by the smoke's clock (`cameWithin`, `leftOf`).
   * @param {import("@playwright/test").Page} own @param {number} from
   */
  const writtenIn = (own, from) =>
    cameWithin(
      leftOf(from, 5000),
      own.waitForFunction(() => document.querySelector("main")?.textContent?.includes("Written by the form's own page.") && !document.querySelector("[aria-busy]"), null, {
        timeout: 5000,
      }),
    );
  /**
   * What became of a press (`pressThen`): `ok`, or the step that failed (`failed`), so a check's
   * details say whether the press task stalled, failed or found nothing, or what it led to did not
   * come; and `at`, the moment the page pressed, by the page's monotonic clock (`performance.now()`
   * there, taken in the press task just before it presses), where the press task answers one (null
   * where it does not, or found nothing), for a bound on what the page records after the press.
   * @typedef {{ ok: boolean, failed: string | null, at: number | null }} Pressed
   */
  /**
   * Runs `press`, a page task that finds an element and presses it and says whether it found one,
   * then polls `came` until it holds, both within 5 s counted from just before the page is asked to
   * press (`steps`): a press task that has not returned by then, or returns after them, fails the
   * press however soon its outcome came. Says which step failed, by what `outcome` names, without
   * adding to the 5 s.
   * @param {() => Promise<boolean | number>} press @param {string} missing what the press found nothing of
   * @param {() => Promise<boolean>} came @param {string} outcome what the press must lead to
   * @returns {Promise<Pressed>}
   */
  const pressThen = async (press, missing, came, outcome) => {
    const ranOut = "the 5 s from the press ran out";
    const budget = steps(5000, ranOut);
    let pressing = true;
    /** @type {number | null} */
    let at = null;
    try {
      const pressed = await budget.step(press);
      if (pressed === false) return { ok: false, failed: `the press task found no ${missing}`, at };
      if (typeof pressed === "number") at = pressed;
      pressing = false;
      await budget.poll(came);
      return { ok: true, failed: null, at };
    } catch (error) {
      const why = budget.over || (error instanceof Error ? error.message.split("\n")[0] : String(error));
      if (pressing) return { ok: false, failed: why === ranOut ? "the press task did not return within 5 s of the press" : `the press task failed: ${why}`, at };
      return { ok: false, failed: why === ranOut ? `${outcome} did not come within 5 s of the press` : `the wait for ${outcome} failed: ${why}`, at };
    }
  };
  /**
   * Finds the button at `selector` and presses it in one page task, and whether the write it sends
   * reaches the stand-in within 5 s counted from just before the page is asked to press, the press
   * task and the wait for its write sharing those 5 s (`pressThen`). A page that reads itself again
   * swaps <main> a second after it loads, and again whenever its answer changes: a Playwright click
   * can find the button, then land once it is gone, and a press that reaches no button sends nothing
   * (#2035). The press task answers the page's time just before it presses (`Pressed.at`).
   * @param {import("@playwright/test").Page} own @param {{ writes: number }} seen @param {string} selector
   */
  const pressWrite = async (own, seen, selector) => {
    const writes = seen.writes;
    return pressThen(
      () =>
        own.evaluate((selector) => {
          const button = /** @type {HTMLButtonElement | null} */ (document.querySelector(selector));
          if (!button) return false;
          const at = performance.now();
          button.click();
          return at;
        }, selector),
      `button at ${selector}`,
      async () => seen.writes > writes,
      "the write at the stand-in",
    );
  };
  /**
   * Notes, from now on, each mark a case's stand-in put in an answer (`data-smoke-at`, the answer's
   * place in `seen.asked`) as the page draws it, so a draw that the next one replaces is seen too:
   * the time the page's observer saw that draw (`performance.now()` in the page), what the header said had
   * failed at the moment of the draw itself (its `data-failed`, or null), and the mark of the failure
   * event that said it (its `data-failed-mark`, or null, where a case marks its failures). The one
   * observer sees the marks and the header's changes in the order they were made: a failure shown
   * after the draw, though before the observer ran (a promise reaction queued before the draw), is
   * undone for that draw by its record's old value, so it is not taken as shown at the draw. A header
   * put in after the draw said nothing then. `drawnBy` reads them. Set up within 5 s.
   * @param {import("@playwright/test").Page} own
   */
  const watchMarks = (own) =>
    within(
      5000,
      "the page did not start noting its draws within 5 s",
      own.evaluate(() => {
        /** @typedef {{ time: number, failed: string | null, mark: string | null }} Drawn */
        /** @type {Record<string, Drawn>} */
        const marks = Object.create(null);
        (/** @type {any} */ (window)).__marks = marks;
        /** Each marked element in or at `node`. @param {Node} node @returns {Element[]} */
        const marked = (node) =>
          node instanceof Element ? [...(node.hasAttribute("data-smoke-at") ? [node] : []), ...Array.from(node.querySelectorAll("[data-smoke-at]"))] : [];
        /** @param {MutationRecord[]} records */
        const note = (records) => {
          const time = performance.now();
          const header = document.querySelector("header");
          // The header's state now, taken back record by record, last first, to each draw's moment.
          let failed = header?.getAttribute("data-failed") ?? null;
          let mark = header?.getAttribute("data-failed-mark") ?? null;
          /** This batch's draws, the earliest kept. @type {Record<string, Drawn>} */
          const batch = Object.create(null);
          for (let i = records.length - 1; i >= 0; i--) {
            const r = records[i];
            if (r.type === "attributes" && r.attributeName !== "data-smoke-at") {
              if (r.target !== header) continue;
              if (r.attributeName === "data-failed") failed = r.oldValue;
              else if (r.attributeName === "data-failed-mark") mark = r.oldValue;
              continue;
            }
            const drawn = r.type === "attributes" ? marked(r.target) : Array.from(r.addedNodes).flatMap(marked);
            for (const el of drawn) batch[/** @type {string} */ (el.getAttribute("data-smoke-at"))] = { time, failed, mark };
            // Before the header now in the page was put in, it said nothing.
            if (header && r.type === "childList" && Array.from(r.addedNodes).some((n) => n === header || n.contains(header))) failed = mark = null;
          }
          for (const at in batch) marks[at] ??= batch[at];
        };
        for (const el of Array.from(document.querySelectorAll("[data-smoke-at]"))) {
          const header = document.querySelector("header");
          marks[/** @type {string} */ (el.getAttribute("data-smoke-at"))] ??= {
            time: performance.now(),
            failed: header?.getAttribute("data-failed") ?? null,
            mark: header?.getAttribute("data-failed-mark") ?? null,
          };
        }
        new MutationObserver(note).observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeOldValue: true,
          attributeFilter: ["data-smoke-at", "data-failed", "data-failed-mark"],
        });
      }),
    );
  /**
   * The page's record of its draw of the answer to `seen.asked[at]` (`watchMarks`), if the page drew
   * it by `by`, a time by the page's own monotonic clock (`performance.now()` there, as the record's),
   * else null. The draw's own time, recorded by the page as it drew, decides: the check looks, each
   * look reading the record and the page's time in one task, until that clock reaches `by`
   * (`lookUntil`), so a check that looks late neither fails a draw made in time nor passes one made
   * after `by`. A `by` that is not a number (a read the page did not say it started) draws nothing.
   * @param {import("@playwright/test").Page} own @param {number} at @param {number} by
   */
  const drawnBy = async (own, at, by) => {
    const drawn = await lookUntil(
      own,
      by,
      (at) => ({
        origin: performance.timeOrigin,
        now: performance.now(),
        value: /** @type {{ time: number, failed: string | null, mark: string | null } | undefined} */ ((/** @type {any} */ (window)).__marks[String(at)]),
      }),
      at,
    );
    return drawn && drawn.time <= by ? drawn : null;
  };
  /** The page's time 5 s after it started `seen.asked[at]` (`seen.startedAt`), the bound on that read's draw, by the page's clock. @param {{ startedAt: number[] }} seen @param {number} at */
  const drawBound = (seen, at) => seen.startedAt[at] + 5000;
  /**
   * Waits by the smoke's own timer (`pause`) until the page's monotonic clock has passed `time`, a
   * time the page recorded by it: the page's time is read (bounded to 5 s) and only what is left of
   * it waited. If the page's time cannot be read, waits `fallback` instead, the wait from now that
   * passes `time` anyway (the page recorded `time` before it was read).
   * @param {import("@playwright/test").Page} own @param {number} time @param {number} fallback
   */
  const pausePast = async (own, time, fallback) => {
    const now = await readWithin("the page's clock", own.evaluate(() => performance.now())).catch(() => null);
    await pause(now === null ? fallback : Math.max(0, time - now));
  };
  /**
   * The place in `seen.asked` of the first read of `/smoke/written/again` from `from` on (at or after
   * its place, `from.at`, and reaching the stand-in after its time, `from.time`, not in the same
   * millisecond), if it reached the stand-in within 5 s of `from.time`, else null: a first read asked
   * later fails however soon the check looks, and the check waits for one only until then. Its place
   * alone does not do: a place taken before the page is asked to do something (let a held body go)
   * lets in a read that reached the stand-in while that task waited to run, before what the read must
   * follow, and a read in the same millisecond as that moment may have come before it. Both times
   * are the stand-in's, by the smoke's monotonic clock.
   * Given `resumed`, a later time at which the page was let go of a read it was waiting on (a held
   * read's answer handed to it), a first read that reached the stand-in after `resumed` has its 5 s
   * counted from `resumed` instead: the page could not make it sooner. One that came before then
   * keeps the 5 s from `from.time`, and a `resumed` not after `from.time` changes nothing.
   * A `from` the page recorded (`from.page`, by the page's clock: a held body's release) is compared
   * with the time the page started each read (`seen.startedAt`), by that same clock: the first read
   * the page started after it, which it must have started within 5 s of it. The check waits 10 s for
   * that read to reach the stand-in (the 5 s, from no later than the call, and 5 s for the request to
   * get there), and the time the page started it decides.
   * @param {{ asked: string[], askedAt: number[], startedAt: number[] }} seen @param {Since} from @param {number} [resumed]
   */
  const readAsked = async (seen, from, resumed) => {
    if (from.page !== undefined) {
      const page = from.page;
      const first = () => seen.asked.findIndex((a, i) => i >= from.at && seen.startedAt[i] > page && a.startsWith("GET /smoke/written/again"));
      const at = (await pollRecord(10_000, () => (first() >= 0 ? first() : false))) ?? -1;
      return at >= 0 && seen.startedAt[at] <= page + 5000 ? at : null;
    }
    const after = resumed !== undefined && resumed > from.time ? resumed : undefined;
    const last = (after ?? from.time) + 5000;
    const first = () => seen.asked.findIndex((a, i) => i >= from.at && seen.askedAt[i] > from.time && a.startsWith("GET /smoke/written/again"));
    if (first() < 0) await pollAsync(Math.max(0, last - performance.now()), async () => first() >= 0);
    const at = first();
    if (at < 0) return null;
    const by = (after !== undefined && seen.askedAt[at] > after ? after : from.time) + 5000;
    return seen.askedAt[at] <= by ? at : null;
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
          w.__writtenSeen = null;
          const drawn = () =>
            !!document.querySelector("main")?.textContent?.includes("Written by the form's own page.") &&
            !document.querySelector(inMain ? "main[aria-busy], main [aria-busy]" : "[aria-busy]") &&
            (brand === null || document.querySelector("header span")?.textContent === brand);
          new MutationObserver((_, observer) => {
            if (!drawn()) return;
            w.__writtenSeen = performance.now();
            observer.disconnect();
          }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-busy"] });
        },
        { brand: brand ?? null, inMain },
      ),
    );
  /**
   * Whether `watchWritten` saw the write's own page drawn after the press that sends the write and
   * within 5 s of it, by the page's monotonic clock: `pressed`, the time the page recorded in the
   * press task just before it pressed (`Pressed.at`), against the time the page recorded as it drew
   * it. Looked for, each look reading the record and the page's time in one task, until that clock
   * passes the 5 s (`lookUntil`), so a check that looks late neither fails a draw in time nor passes
   * one after them. A press the page did not time (null) is no draw.
   * @param {import("@playwright/test").Page} own @param {number | null} pressed
   */
  const writtenSeen = async (own, pressed) => {
    if (pressed === null) return false;
    const by = pressed + 5000;
    const drawn = await lookUntil(own, by, () => ({ origin: performance.timeOrigin, now: performance.now(), value: /** @type {number | false} */ ((/** @type {any} */ (window)).__writtenSeen ?? false) }));
    return typeof drawn === "number" && drawn >= pressed && drawn <= by;
  };
  /**
   * Marks a navigation's <main> with its read's place in `seen.asked` (as `seen.nav`), for
   * `watchMarks` to note the moment it is drawn. @param {string} body @param {number} at
   */
  const markNav = (body, at) => body.replace(">Quoted arguments</a>", `>Quoted arguments</a><i data-smoke-at="${at}" hidden></i>`);
  /**
   * The page's first read of itself from `from` on, asked within 5 s of `from` (`readAsked`), and
   * whether its answer is drawn within 5 s of the page starting that read, both by the page's clock
   * (`drawnBy`, `drawBound`), with the header already saying `failure` had failed at that draw: the read's own
   * mark (`markNav`), not a request or a pause, is what shows the poll drew, and a poll drawn before
   * the failure was shown is not a poll that kept it. Given `mark`, the header must also say at that
   * draw that the failure event marked `mark` said it (`data-failed-mark`), so another failure with
   * the same status in its place does not do; a null `mark` (no such event) never does. `from` is
   * taken at what the read follows (a write's `settled` moment, or a held body's release, its time
   * recorded by the page), not once the check has seen that in the page, by when the read may
   * already have been asked and its time run; without one (the write never answered) there is no
   * such read. `resumed` is `readAsked`'s.
   * @param {import("@playwright/test").Page} own @param {{ asked: string[], askedAt: number[], startedAt: number[] }} seen @param {Since | undefined} from @param {string} failure
   * @param {string | null} [mark] @param {number} [resumed]
   */
  const nextPollDrawn = async (own, seen, from, failure, mark, resumed) => {
    if (from === undefined) return { again: null, drewAgain: false, drawn: null };
    const at = await readAsked(seen, from, resumed);
    const drawn = at === null ? null : await drawnBy(own, at, drawBound(seen, at));
    const marked = mark === undefined || (mark !== null && drawn?.mark === mark);
    return { again: at === null ? null : seen.asked[at], drewAgain: !!drawn && drawn.failed === failure && marked, drawn };
  };
  {
    const { own, seen } = await writtenPage(brand);
    try {
      const first = await shownOf(own);
      const pressedAt = performance.now();
      await actWithin("the press of the form's button", own.click("main form button"));
      const drawn = await writtenIn(own, pressedAt);
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
    } finally {
      seen.over = true;
      await closeContext(own.context(), "the whole write case's context");
    }
  }
  // Left while the write's own page is on its way (its modules still loading), by a link to a page
  // in the same area and layout, which a navigation swaps in: the write is done, so that page is
  // read whole and shows what the write changed, as after a write that redirects.
  const leftName = "a navigation that leaves a write's own page on its way reads the next page whole, with what the write changed";
  if (!(await hasNavigation())) skip(leftName, "without the Navigation API a link is a full load");
  else {
    const { own, seen } = await writtenPage(brand);
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {() => void} */
    let asked = () => {};
    /** When the page asked for the held script, by the smoke's monotonic clock. @type {number | null} */
    let askedAt = null;
    const waiting = new Promise((resolve) => (asked = () => resolve(true)));
    // The held script is let go and the page closed (bounded) however the case ends.
    try {
      // Held only while the write's page waits for it: the page the user goes to may need it too.
      await within(
        5000,
        "the held script's route was not set within 5 s",
        own.route("**/scripts/quoted.js", async (route) => {
          askedAt ??= performance.now();
          asked();
          await held;
          // Let through once let go, bounded, or aborted once the case is over.
          await within(5000, "", seen.over ? route.abort() : route.fallback()).catch(() => {});
        }),
      );
      // The script asked for within 5 s of the press, by when the route heard it (`notedBy`), and
      // the link pressed only then; its page in within 5 s of that press.
      const pressedAt = performance.now();
      await actWithin("the press of the form's button", own.click("main form button"));
      const stalled = await notedBy(pressedAt + 5000, () => askedAt, waiting);
      let arrived = false;
      if (stalled) {
        const linkAt = performance.now();
        await actWithin("the press of the link to /smoke/quoted", own.click('main a[href="/smoke/quoted"]'));
        release();
        arrived = await cameWithin(
          leftOf(linkAt, 5000),
          own.waitForFunction(() => location.pathname === "/smoke/quoted" && !!document.querySelector("main output#quoted") && !document.querySelector("main form") && !document.querySelector("[aria-busy]"), null, {
            timeout: 5000,
          }),
        );
      }
      release();
      const shown = await readWithin("what the page shows after the link", shownOf(own));
      check(
        leftName,
        stalled && arrived && shown.brand === "Watchlist, written" && shown.same && seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ stalled, arrived, asked: seen.asked, shown }),
      );
    } finally {
      seen.over = true;
      release();
      await closeContext(own.context(), "the left write case's context");
    }
  }
  // Two writes from two forms, both done on the server, whose own pages are on their way. The
  // second's page comes first and waits for a module; then the first's comes and draws (made before
  // the second write was done, its count is 1), and the user leaves by a link. The first page's
  // layout does not draw what the second write changed, so the next page is still read whole and
  // shows the count the server has, 2.
  const bothName = "a write's own page drawn first leaves another write's change to the layout for the next page to draw";
  if (!(await hasNavigation())) skip(bothName, "without the Navigation API a link is a full load");
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
    /** When the page asked for the held script, by the smoke's monotonic clock. @type {number | null} */
    let askedAt = null;
    const waiting = new Promise((resolve) => (asked = () => resolve(true)));
    // The held write and script are let go and the page closed (bounded) however the case ends.
    try {
      await within(
        5000,
        "the held script's route was not set within 5 s",
        own.route("**/scripts/quoted.js", async (route) => {
          askedAt ??= performance.now();
          asked();
          await held;
          // Let through once let go, bounded, or aborted once the case is over.
          await within(5000, "", seen.over ? route.abort() : route.fallback()).catch(() => {});
        }),
      );
      await within(
        5000,
        "the second form was not added within 5 s",
        own.evaluate(() =>
          document.body.insertAdjacentHTML("beforeend", __html('<form id="second-write" method="post" action="/smoke/written" data-patch><button id="second-go">Write</button></form>')),
        ),
      );
      await actWithin("the press of the form's button", own.click("main form button"));
      const secondAt = performance.now();
      await actWithin("the press of the second form's button", own.click("#second-go"));
      // The second write's page has come and waits for the module, asked for within 5 s of the
      // second press (`notedBy`); then the first's comes and draws, within 5 s of its answer let go,
      // and only then is the link pressed, its page in within 5 s of that press.
      const stalled = await notedBy(secondAt + 5000, () => askedAt, waiting);
      let drewFirst = false;
      let arrived = false;
      if (stalled) {
        const firstAt = performance.now();
        answerFirst();
        drewFirst = await cameWithin(
          leftOf(firstAt, 5000),
          own.waitForFunction(() => document.querySelector("header span")?.textContent === "Count 1" && !!document.querySelector("main p"), null, { timeout: 5000 }),
        );
      }
      if (drewFirst) {
        const linkAt = performance.now();
        await actWithin("the press of the link to /smoke/quoted", own.click('main a[href="/smoke/quoted"]'));
        release();
        arrived = await cameWithin(
          leftOf(linkAt, 5000),
          own.waitForFunction(() => location.pathname === "/smoke/quoted" && !!document.querySelector("main output#quoted") && !document.querySelector("main form") && !document.querySelector("main[aria-busy], main [aria-busy]"), null, {
            timeout: 5000,
          }),
        );
      }
      release();
      const shown = await readWithin("what the page shows after the link", shownOf(own));
      check(
        bothName,
        stalled && drewFirst && seen.answers === 2 && arrived && shown.brand === "Count 2" && seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ stalled, drewFirst, answers: seen.answers, arrived, asked: seen.asked, shown }),
      );
    } finally {
      seen.over = true;
      answerFirst();
      release();
      await closeContext(own.context(), "the two writes case's context");
    }
  }
  // The other order: two writes from two forms. The first is done on the server but its answer
  // is held; the second's page, made after both writes (count 2), draws. Then the first's comes
  // and draws, made before the second write (count 1): its layout is older than the one it
  // replaced, so the second write is undrawn again and the next page is read whole, with the count
  // the server has.
  const laterName = "a write's own page drawn after a later write's leaves that write's change to the layout for the next page to draw";
  if (!(await hasNavigation())) skip(laterName, "without the Navigation API a link is a full load");
  else {
    const counted = (/** @type {string} */ body, /** @type {number} */ writes) => body.replace(">Watchlist</span>", `>Count ${writes}</span>`);
    const { own, seen } = await writtenPage(counted);
    /** @type {() => void} */
    let answerFirst = () => {};
    const first = new Promise((resolve) => (answerFirst = () => resolve(undefined)));
    /** @type {() => void} */
    let reached = () => {};
    /** When the stand-in had done the first write and held its answer, by the smoke's monotonic clock. @type {number | null} */
    let reachedAt = null;
    const done = new Promise((resolve) => (reached = () => resolve(true)));
    seen.hold = (writes) => (writes === 1 ? ((reachedAt ??= performance.now()), reached(), first) : undefined);
    // The held write is let go and the page closed (bounded) however the case ends.
    try {
      await within(
        5000,
        "the second form was not added within 5 s",
        own.evaluate(() =>
          document.body.insertAdjacentHTML("beforeend", __html('<form id="second-write" method="post" action="/smoke/written" data-patch><button id="second-go">Write</button></form>')),
        ),
      );
      // Each step within 5 s of what starts it (`notedBy`, `brandBecomes`), and none pressed once one
      // before it did not come: the first write done within 5 s of its press, the second's page drawn
      // within 5 s of its press, the first's within 5 s of its answer let go, the link's page within
      // 5 s of its press.
      const pressedAt = performance.now();
      await actWithin("the press of the form's button", own.click("main form button"));
      const written = await notedBy(pressedAt + 5000, () => reachedAt, done);
      let drewSecond = false;
      let drewFirst = false;
      let arrived = false;
      if (written) {
        const secondAt = performance.now();
        await actWithin("the press of the second form's button", own.click("#second-go"));
        drewSecond = await brandBecomes(own, "Count 2", secondAt);
      }
      if (drewSecond) {
        const firstAt = performance.now();
        answerFirst();
        drewFirst = await brandBecomes(own, "Count 1", firstAt);
      }
      if (drewFirst) {
        const linkAt = performance.now();
        await actWithin("the press of the link to /smoke/quoted", own.click('main a[href="/smoke/quoted"]'));
        arrived = await cameWithin(
          leftOf(linkAt, 5000),
          own.waitForFunction(() => location.pathname === "/smoke/quoted" && !!document.querySelector("main output#quoted") && !document.querySelector("main form") && !document.querySelector("main[aria-busy], main [aria-busy]"), null, {
            timeout: 5000,
          }),
        );
      }
      const shown = await readWithin("what the page shows after the link", shownOf(own));
      check(
        laterName,
        written && drewSecond && drewFirst && arrived && shown.brand === "Count 2" && seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ written, drewSecond, drewFirst, answers: seen.answers, arrived, asked: seen.asked, shown }),
      );
    } finally {
      seen.over = true;
      answerFirst();
      await closeContext(own.context(), "the later write case's context");
    }
  }
  // A write the server has done, whose answer has not come when the user follows a link: the
  // navigation cuts it off, and since the write may have been applied, the next page is read whole
  // and shows what it changed.
  const cutOffName = "a navigation that cuts off a write before its answer reads the next page whole, with what the write changed";
  if (!(await hasNavigation())) skip(cutOffName, "without the Navigation API a link is a full load");
  else {
    const { own, seen } = await writtenPage(brand);
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {() => void} */
    let reached = () => {};
    /** When the stand-in had done the write and held its answer, by the smoke's monotonic clock. @type {number | null} */
    let reachedAt = null;
    const done = new Promise((resolve) => (reached = () => resolve(true)));
    seen.hold = () => ((reachedAt ??= performance.now()), reached(), held);
    // The held write is let go and the page closed (bounded) however the case ends.
    try {
      // The server has done the write within 5 s of the press, its answer held (`notedBy`); only then
      // is the link pressed, its page in within 5 s of that press.
      const pressedAt = performance.now();
      await actWithin("the press of the form's button", own.click("main form button"));
      const written = await notedBy(pressedAt + 5000, () => reachedAt, done);
      let arrived = false;
      if (written) {
        const linkAt = performance.now();
        await actWithin("the press of the link to /smoke/quoted", own.click('main a[href="/smoke/quoted"]'));
        arrived = await cameWithin(
          leftOf(linkAt, 5000),
          own.waitForFunction(() => location.pathname === "/smoke/quoted" && !!document.querySelector("main output#quoted") && !document.querySelector("main form") && !document.querySelector("main[aria-busy], main [aria-busy]"), null, {
            timeout: 5000,
          }),
        );
      }
      const shown = await readWithin("what the page shows after the link", shownOf(own));
      release();
      check(
        cutOffName,
        written && arrived && shown.brand === "Watchlist, written" && shown.same && seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ written, arrived, asked: seen.asked, shown }),
      );
    } finally {
      seen.over = true;
      release();
      await closeContext(own.context(), "the cut-off write case's context");
    }
  }
  /**
   * Follows the link to /smoke/quoted, found and pressed in one page task, and whether that page
   * came in within 5 s counted from just before the press: the press task and the wait share those
   * 5 s (`pressThen`). It came once the address is `/smoke/quoted` and its <main> holds its
   * `<output id="quoted">` and no form, with neither <main> nor anything in it busy (`aria-busy`):
   * the written page has that output too, inside its form, so the output alone is not the page, nor
   * the address alone, and an empty <main> has no form and nothing busy either. A page that reads itself again swaps <main>
   * every second, so a Playwright click can find the link, then land once it is gone, and the page
   * never leaves (#2035).
   * @param {import("@playwright/test").Page} own
   */
  const toQuoted = async (own) =>
    pressThen(
      () =>
        own.evaluate(() => {
          const link = /** @type {HTMLAnchorElement | null} */ (document.querySelector('main a[href="/smoke/quoted"]'));
          link?.click();
          return !!link;
        }),
      "link to /smoke/quoted",
      () => own.evaluate(() => location.pathname === "/smoke/quoted" && !!document.querySelector("main output#quoted") && !document.querySelector("main form") && !document.querySelector("main[aria-busy], main [aria-busy]")),
      "/smoke/quoted",
    );
  /**
   * Whether the page comes to show a write's failure in its header with nothing busy, within 5 s of
   * `from`, the `performance.now()` time taken just before the press that sends the write, by the
   * smoke's own clock (`within`, `leftOf`): the driver's timeout counts from when it receives the
   * wait, and a wait whose answer never comes would keep the case from its cleanup.
   * @param {import("@playwright/test").Page} own @param {number} from
   */
  const failureShown = (own, from) =>
    within(
      leftOf(from, 5000),
      "the failure was not shown within 5 s",
      own.waitForFunction(() => !!document.querySelector("header[data-failed]") && !document.querySelector("[aria-busy]"), null, { timeout: 5000 }),
    ).then(
      () => true,
      () => false,
    );
  // A write the server applied whose answer the network lost: the page shows the failure in its
  // layout (as a toaster there does), for the user to send again. The page reading itself again
  // (`ReadAgain`) reads <main> alone and keeps the failure shown, where a whole page, whose header
  // the write changed, would draw it away; the next navigation reads the whole page, which shows
  // what the write changed.
  for (const legacy of [false, true]) {
    const failedName = legacy
      ? "a legacy write left undrawn does not make a poll replace the layout after a write failed"
      : "a write that failed in view leaves its change to the layout for the next page, and the page reading itself again keeps the failure shown";
    if (!(await hasNavigation())) {
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
      const pressedAt = performance.now();
      const sent = await pressWrite(own, seen, "main form button");
      const failed = sent.ok && (await failureShown(own, pressedAt));
      /** @type {Pressed | null} */
      let legacySent = null;
      let legacyDrew = true;
      if (legacy) {
        seen.fail = false;
        seen.draws = false;
        // Sent within 5 s from just before the press, and its <main> drawn within 5 s of the press
        // too, by the time the page recorded as it drew it.
        await watchWritten(own);
        follows = seen.writes + 1;
        legacySent = await pressWrite(own, seen, "main form button");
        legacyDrew = legacySent.ok && (await writtenSeen(own, legacySent.at)) && "corten-page" in seen.answered;
      }
      // The page's first read of itself after the stand-in failed or answered that write, drawn
      // with the failure already shown (`nextPollDrawn`), and the failure still shown at a look at
      // least 500 ms after that draw, by the time the page recorded as it drew it and the page's own
      // clock, waited by the smoke's own timer (`pausePast`), so a driver that never answers cannot
      // keep the case from its cleanup.
      const { again, drewAgain, drawn } = await nextPollDrawn(own, seen, seen.settled[follows], "");
      if (drewAgain && drawn) await pausePast(own, drawn.time + 500, 500);
      const kept =
        drewAgain &&
        (await readWithin(
          "whether the failure was still shown",
          own.evaluate(() => !!document.querySelector("header[data-failed]") && location.pathname === "/smoke/written/again"),
        ));
      // The link is pressed only once every step before it came in time.
      /** @type {Pressed} */
      const arrived =
        failed && legacyDrew && again === "GET /smoke/written/again nav" && drewAgain && kept ? await toQuoted(own) : { ok: false, failed: "not pressed: a step before it did not come" };
      const shown = await readWithin("what the page shows after the link", shownOf(own));
      check(
        failedName,
        failed && legacyDrew && again === "GET /smoke/written/again nav" && drewAgain && kept && arrived.ok && shown.brand === "Watchlist, written" && shown.same && seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ sent, failed, legacySent, legacyDrew, again, drawn, drewAgain, kept, arrived, asked: seen.asked, shown }),
      );
    } finally {
      seen.over = true;
      await closeContext(own.context(), "the failed write case's context");
    }
  }
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
  if (!(await hasNavigation())) skip(overName, "without the Navigation API a link is a full load");
  else {
    const { before, edit } = patchedAndWhole(2);
    const { own, seen } = await writtenPage(edit, before);
    /** @type {() => void} */
    let answerFirst = () => {};
    const first = new Promise((resolve) => (answerFirst = () => resolve(undefined)));
    seen.hold = (writes) => (writes === 1 ? first : undefined);
    // The held write is let go and the page closed (bounded) however the case ends.
    try {
      await within(5000, "the second form was not added within 5 s", secondForm(own));
      await actWithin("the press of the form's button", own.click("main form button"));
      const secondAt = performance.now();
      await actWithin("the press of the second form's button", own.click("#second-go"));
      // The second write's patch drawn within 5 s of its press, the first's page within 5 s of its
      // answer let go, and the link pressed only once both are.
      const patched = await brandBecomes(own, "Count 2", secondAt);
      let drewOver = false;
      if (patched) {
        const firstAt = performance.now();
        answerFirst();
        drewOver = await brandBecomes(own, "Count 1", firstAt);
      }
      /** @type {Pressed} */
      const arrived = drewOver ? await toQuoted(own) : { ok: false, failed: "not pressed: a step before it did not come" };
      const shown = await readWithin("what the page shows after the link", shownOf(own));
      check(
        overName,
        patched && drewOver && arrived.ok && shown.brand === "Count 2" && shown.same && seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ patched, drewOver, answers: seen.answers, arrived, asked: seen.asked, shown }),
      );
    } finally {
      seen.over = true;
      answerFirst();
      await closeContext(own.context(), "the patch order case's context");
    }
  }
  // The other order: the first write's own page draws (count 1), then the second write's patch,
  // made after it, draws the count the server has (2). Nothing is older than what is drawn, so the
  // next page reads <main> alone and the count stays 2.
  const underName = "a write's patch to the layout drawn after another write's own page is current, and the next page reads <main> alone";
  if (!(await hasNavigation())) skip(underName, "without the Navigation API a link is a full load");
  else {
    const { before, edit } = patchedAndWhole(2);
    const { own, seen } = await writtenPage(edit, before);
    /** @type {() => void} */
    let answerSecond = () => {};
    const second = new Promise((resolve) => (answerSecond = () => resolve(undefined)));
    seen.hold = (writes) => (writes === 2 ? second : undefined);
    // The held write is let go and the page closed (bounded) however the case ends.
    try {
      await within(5000, "the second form was not added within 5 s", secondForm(own));
      const firstAt = performance.now();
      await actWithin("the press of the form's button", own.click("main form button"));
      await actWithin("the press of the second form's button", own.click("#second-go"));
      // The first write's page drawn within 5 s of its press, the second's patch within 5 s of its
      // answer let go, and the link pressed only once both are.
      const drewFirst = await brandBecomes(own, "Count 1", firstAt);
      let patched = false;
      if (drewFirst) {
        const secondAt = performance.now();
        answerSecond();
        patched = await brandBecomes(own, "Count 2", secondAt);
      }
      /** @type {Pressed} */
      const arrived = patched ? await toQuoted(own) : { ok: false, failed: "not pressed: a step before it did not come" };
      const shown = await readWithin("what the page shows after the link", shownOf(own));
      check(
        underName,
        drewFirst && patched && arrived.ok && shown.brand === "Count 2" && shown.same && seen.asked.includes("GET /smoke/quoted nav"),
        JSON.stringify({ drewFirst, patched, answers: seen.answers, arrived, asked: seen.asked, shown }),
      );
    } finally {
      seen.over = true;
      answerSecond();
      await closeContext(own.context(), "the patch order case's context");
    }
  }
  /**
   * When the page noted a held body cut (or given) and the failure shown for it (`__bodyAt`,
   * `__failedAt`), and by when they had to come (`by`): 5 s from the body's release, by the time the
   * page recorded as it let go (`__releasedAt`), all by the page's own monotonic clock
   * (`performance.now()` there). A release the check already has (`released`, the page's time it
   * returned as it let go) bounds the first look too; without one, while the page has not said it let
   * go, `by` is 5 s from the page's time at the first look. Each look reads the records and the
   * page's time in one task, and the check looks until the failure is noted or the page's own clock
   * is at or past `by`, so the recorded times decide: a check that looks late neither passes an
   * outcome that came after `by` nor fails one that came before it. The wait as a whole has 10 s by
   * the smoke's own monotonic clock (`performance.now()` here), from `heard`, the moment the check
   * heard of the release it let go, or else from the start of the wait: the 5 s for the outcome and
   * 5 s more for the look that finds the page's clock past them. Each look has what is left of those
   * 10 s, at most 5 s, and none starts once they are over; the pause between looks ends with them
   * too. A look not answered in its time ends the wait with nothing, and one cut short by the 10 s
   * with what the last answered look saw (a failure it did not see is no failure).
   * @param {import("@playwright/test").Page} own @param {number} [released] @param {number} [heard]
   */
  const bodyOutcome = async (own, released, heard) => {
    const until = (heard ?? performance.now()) + 10_000;
    const look = () =>
      own.evaluate(() => {
        const state = /** @type {any} */ (window);
        return {
          now: performance.now(),
          releasedAt: /** @type {number | null} */ (state.__releasedAt ?? null),
          bodyAt: /** @type {number | null} */ (state.__bodyAt ?? null),
          failedAt: /** @type {number | null} */ (state.__failedAt ?? null),
          failedMark: /** @type {string | null} */ (state.__failedMark ?? null),
        };
      });
    let start = released;
    /** What the last answered look saw, with the bound it gave. */
    let last = { releasedAt: /** @type {number | null} */ (null), bodyAt: /** @type {number | null} */ (null), failedAt: /** @type {number | null} */ (null), failedMark: /** @type {string | null} */ (null), by: /** @type {number | null} */ (null) };
    for (;;) {
      const left = until - performance.now();
      if (left <= 0) return last;
      const seenNow = await within(Math.min(5000, left), "the page did not say what became of the body in time", look()).catch(() => null);
      if (seenNow === null) return { releasedAt: null, bodyAt: null, failedAt: null, failedMark: null, by: null };
      const { now, ...records } = seenNow;
      start ??= now;
      const by = (records.releasedAt ?? start) + 5000;
      last = { ...records, by };
      if (records.failedAt !== null || now >= by) return last;
      const wait = Math.min(50, by - now, until - performance.now());
      if (!(wait > 0)) return last;
      await pause(wait);
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
    if (!(await hasNavigation())) {
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
            // the body's only if it came after the body was cut (or given), on that form. Each has a mark
            // of its own, which the header carries with its status (`data-failed-mark`), so a later
            // look knows the failure it shows is that one, not another with the same status.
            /** @type {{ status: number, body: string | null, onHeldForm: boolean, target: string, time: number, mark: string }[]} */
            const errors = [];
            state.__errors = errors;
            addEventListener("corten:error", (event) => {
              const failed = String((/** @type {CustomEvent} */ (event)).detail.status);
              const target = event.target;
              const mark = `${errors.length}-${Math.random().toString(36).slice(2)}`;
              errors.push({
                status: Number(failed),
                body: state.__bodyAfterHeaders ?? null,
                onHeldForm: target instanceof HTMLFormElement && target === state.__heldForm,
                target: target instanceof Element ? `${target.localName}${target.id ? `#${target.id}` : ""}` : target === window ? "window" : String(target),
                time: performance.now(),
                mark,
              });
              const header = document.querySelector("header");
              header?.setAttribute("data-failed", failed);
              header?.setAttribute("data-failed-mark", mark);
            });
            // The moment the expected failure is shown for the body, by the page's clock: the body cut
            // (or given), the page's first failure the expected one, said after that on the form that
            // sent the held write, the header saying it (by its mark) and nothing busy. The check
            // compares that moment with the body's release, however late it looks, and takes that
            // failure's mark (`__failedMark`) as the one the poll and the later look must still show.
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
                document.querySelector("header")?.getAttribute("data-failed-mark") === first.mark &&
                !document.querySelector("[aria-busy]");
              if (!shown) return;
              state.__failedAt = performance.now();
              state.__failedMark = first.mark;
              observer.disconnect();
            }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy", "data-failed", "data-failed-mark"] });
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
                    state.__releasedAt = performance.now();
                    if (!complete) {
                      state.__bodyAfterHeaders = "cut";
                      state.__bodyAt = performance.now();
                      reject(new TypeError("network error"));
                      return;
                    }
                    body().then((value) => {
                      state.__bodyAfterHeaders = "completed";
                      state.__bodyAt = performance.now();
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
      const pressedAt = performance.now();
      const sent = await pressWrite(own, seen, overlap ? "#held-write button" : "main form button");
      /** The second write's press, with a second write. @type {Pressed | null} */
      let sentSecond = null;
      // With a second write, the first's body is asked for within 5 s of its press.
      let bodyAsked = !overlap;
      let drewOver = true;
      let released = !overlap;
      /** @type {Since | undefined} */
      let releasedAt;
      if (overlap && sent.ok) {
        bodyAsked = await cameWithin(leftOf(pressedAt, 5000), own.waitForFunction(() => typeof (/** @type {any} */ (window)).__releaseBody === "function", null, { timeout: 5000 }));
        drewOver = false;
        if (bodyAsked) {
          seen.status = 0;
          // The second write's own page drawn before the first's body is let go: its <main> and the
          // brand it brought at the same moment, nothing in <main> busy (the first form, outside it,
          // waits for its body), within 5 s of its press.
          await watchWritten(own, "Watchlist, written", true);
          sentSecond = await pressWrite(own, seen, "main form button");
          drewOver = sentSecond.ok && (await writtenSeen(own, sentSecond.at));
          // Let go in a page task that does not wait for the body, bounded: whether the body came
          // and the failure it brings are what the bounded wait below checks. The page's next read
          // is counted from the release itself: its place among the reads is taken before the page
          // is asked to let go, and its time is the one the page recorded as it let go, and a read
          // counts only if the page started it after that time, by the same clock (`readAsked`), so
          // a read made while the body was still held, or while the task that lets it go waited to
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
            if (released) releasedAt = { at, time: performance.now(), page: /** @type {number} */ (time) };
          }
        }
      }
      // The body cut (or given in full) and the failure shown for it, both within 5 s of the body's
      // release, by the times the page recorded for the three (`bodyOutcome`), counted from the
      // release the check let go, when it did: the page's first failure must be the expected one,
      // said once the body was cut (or given), not before, and on the form that sent the held write.
      const outcome = await bodyOutcome(own, releasedAt?.page, releasedAt?.time);
      const failed =
        outcome.by !== null && outcome.bodyAt !== null && outcome.bodyAt <= outcome.by && outcome.failedAt !== null && outcome.failedAt <= outcome.by;
      const { afterHeaders, errors } = await readWithin(
        "what became of the held body and the page's failures",
        own.evaluate(() => ({
          afterHeaders: /** @type {string | undefined} */ ((/** @type {any} */ (window)).__bodyAfterHeaders) ?? null,
          errors: /** @type {unknown[]} */ ((/** @type {any} */ (window)).__errors),
        })),
      );
      const expected = String(complete ? 503 : 0);
      // The poll must draw with the body's own failure shown: its status and the mark of the failure
      // event the page took as the body's (`outcome.failedMark`).
      const { again, drewAgain, drawn } = await nextPollDrawn(own, seen, overlap ? releasedAt : seen.settled[first], expected, outcome.failedMark);
      // Looked at again at least 500 ms after the poll's draw, by the time the page recorded as it
      // drew it (a later look, not a watch through them): the failure then shown must still be the
      // body's, by its status and its event's mark, not another that took its place, even with the
      // same status. Waited by the smoke's own timer until the page's clock has passed it (`pausePast`).
      if (drewAgain && drawn) await pausePast(own, drawn.time + 500, 500);
      const keptAs = drewAgain
        ? await readWithin(
            "the failure shown 500 ms after the poll",
            own.evaluate(() => {
              const header = document.querySelector("header");
              return { failed: header?.getAttribute("data-failed") ?? null, mark: header?.getAttribute("data-failed-mark") ?? null };
            }),
          )
        : null;
      const kept = keptAs !== null && keptAs.failed === expected && outcome.failedMark !== null && keptAs.mark === outcome.failedMark;
      // The link is pressed only once every step before it came in time.
      const proven =
        sent.ok && (!overlap || !!sentSecond?.ok) && bodyAsked && drewOver && released && failed && afterHeaders === (complete ? "completed" : "cut") && seen.answers === (overlap ? 2 : 1) &&
        again === "GET /smoke/written/again nav" && drewAgain && kept;
      /** @type {Pressed} */
      const arrived = proven ? await toQuoted(own) : { ok: false, failed: "not pressed: a step before it did not come" };
      const shown = await readWithin("what the page shows after the link", shownOf(own));
      check(
        cutBodyName,
        proven && arrived.ok && shown.brand === (overlap ? "Poll brand" : "Watchlist, written") && seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ sent, sentSecond, bodyAsked, drewOver, released, failed, outcome, afterHeaders, errors, answers: seen.answers, again, drawn, drewAgain, kept, keptAs, arrived, asked: seen.asked, shown }),
      );
    } finally {
      seen.over = true;
      await closeContext(own.context(), "the cut body case's context");
    }
  }
  // A write whose own page reads itself again (ReadAgain) draws, so the page reads itself whole
  // from then on; then a second write is applied and its answer lost, and the page shows the
  // failure in its layout. Reading itself again, the page reads <main> alone, which keeps the
  // failure shown, where a whole page (whose count the second write changed) would draw it away.
  const againName = "after a write's own page that reads itself again, a write that failed in view stays shown while the page reads itself again";
  if (!(await hasNavigation())) skip(againName, "without the Navigation API a link is a full load");
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
    /** @type {() => void} */
    let releaseHeld = () => {};
    const heldRead = new Promise((resolve) => (releaseHeld = () => resolve(undefined)));
    /** The place in `seen.asked` of the read held through the second write, once one is. @type {number | null} */
    let heldAt = null;
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
      // The page's second read of itself from the first write's answer on, counted as `readAsked`
      // counts the first (the whole read below), is held at the stand-in, answer and all, from the
      // moment it reaches it until it is let go below: the next read after the whole one, whatever
      // its kind.
      seen.holdRead = (at) => {
        const from = seen.settled[firstWrite];
        if (heldAt !== null || from === undefined || !seen.asked[at].startsWith("GET /smoke/written/again")) return undefined;
        const reads = seen.asked.flatMap((a, i) => (i >= from.at && seen.askedAt[i] > from.time && a.startsWith("GET /smoke/written/again") ? [i] : []));
        if (reads[1] !== at) return undefined;
        heldAt = at;
        return heldRead;
      };
      const sentFirst = await pressWrite(own, seen, "main form button");
      const drew = sentFirst.ok && (await writtenSeen(own, sentFirst.at));
      // Read whole while it reads itself again: the page's first read of itself after the stand-in
      // answered the write is asked within 5 s of that answer, and its answer drawn within 5 s of
      // the page starting that read, by its clock (`drawnBy`), before the second write is clicked.
      const firstSettled = seen.settled[firstWrite];
      const wholeAt = firstSettled === undefined ? null : await readAsked(seen, firstSettled);
      const wholeBefore = wholeAt === null ? null : seen.asked[wholeAt];
      const wholeDraw = wholeAt === null ? null : await drawnBy(own, wholeAt, drawBound(seen, wholeAt));
      const wholeDrawn = wholeDraw !== null;
      seen.fail = true;
      // The second write is pressed in one page task (`pressWrite`) while the page's next read of
      // itself after the whole one is held at the stand-in (above), so no read's answer is drawn
      // between the press finding the button and pressing it (a click the one-second poll's draw
      // lands on can reach no button, #2035), nor while the write is out (a draw then replaces the
      // form while the write is out, and the runtime says the failure on the form's successor or the
      // document, #2068, which other cases test). The held read must be started by the page within
      // 5 s of the whole read's draw, both by the times the page recorded by its own clock (the draw's,
      // and the read's start the read carries), the check waiting 10 s for it to reach the stand-in;
      // the press and its write reaching the stand-in share 5 s (`pressWrite`),
      // and the failure must be shown within 5 s of the press. Then the held read is let
      // go: a whole read asked before the failure, which the runtime makes again as a read of <main>
      // (`deferWholeRead`, as the waiting-poll case below tests). The read checked below is the
      // first asked after the write failed, which the held one is not. Its 5 s count from the
      // stand-in failing the write, or, for a read that came after the held read's answer was handed
      // to the page, from that moment (`resumed`): the page waits on the held read until then, and a
      // runtime that drops its answer may read again on its one-second timer, so the time the check
      // took to see the failure (up to its own 5 s) is not taken from the read's.
      /** @type {Awaited<ReturnType<typeof pressWrite>> | null} */
      let sentSecondAs = null;
      let held = false;
      let sentSecond = false;
      let failed = false;
      /** @type {number | undefined} */
      let secondWrite;
      if (wholeDraw !== null) {
        const heldBy = wholeDraw.time + 5000;
        if (heldAt === null) await pollRecord(10_000, () => heldAt !== null);
        const heldRead = heldAt;
        held = heldRead !== null && /** @type {number} */ (seen.startedAt[heldRead]) <= heldBy;
        if (held) {
          secondWrite = seen.writes + 1;
          const secondAt = performance.now();
          sentSecondAs = await pressWrite(own, seen, "main form button");
          sentSecond = sentSecondAs.ok;
          failed = sentSecond && (await failureShown(own, secondAt));
        }
      }
      releaseHeld();
      // When the stand-in handed the held read its answer, once let go: the stand-in's plumbing,
      // bounded to 10 s, not part of the read's 5 s.
      const heldOne = heldAt;
      const resumed = heldOne === null ? undefined : ((await pollAsync(10000, async () => seen.delivered[heldOne] ?? false))?.time ?? undefined);
      // The page's first read of itself after the stand-in failed the second write, drawn with the
      // failure already shown.
      const { again, drewAgain, drawn } = await nextPollDrawn(own, seen, secondWrite === undefined ? undefined : seen.settled[secondWrite], "", undefined, resumed);
      // Looked at again at least 500 ms after that draw, by the time the page recorded as it drew it
      // and the page's own clock, waited by the smoke's own timer (`pausePast`).
      if (drewAgain && drawn) await pausePast(own, drawn.time + 500, 500);
      const kept =
        drewAgain &&
        (await readWithin(
          "whether the failure was still shown",
          own.evaluate(() => !!document.querySelector("header[data-failed]") && document.querySelector("header span")?.textContent === "Count 1"),
        ));
      // The link is pressed only once every step before it came in time.
      /** @type {Pressed} */
      const arrived =
        drew && wholeBefore === "GET /smoke/written/again page" && wholeDrawn && held && sentSecond && failed && again === "GET /smoke/written/again nav" && drewAgain && kept
          ? await toQuoted(own)
          : { ok: false, failed: "not pressed: a step before it did not come" };
      const shown = await readWithin("what the page shows after the link", shownOf(own));
      check(
        againName,
        drew &&
          wholeBefore === "GET /smoke/written/again page" &&
          wholeDrawn &&
          held &&
          sentSecond &&
          failed &&
          again === "GET /smoke/written/again nav" &&
          drewAgain &&
          kept &&
          arrived.ok &&
          shown.brand === "Count 2" &&
          seen.asked.includes("GET /smoke/quoted page"),
        JSON.stringify({ sentFirst, drew, wholeBefore, wholeDrawn, held, heldRead: heldAt === null ? null : seen.asked[heldAt], sentSecondAs, failed, again, drawn, drewAgain, kept, arrived, asked: seen.asked, shown }),
      );
    } finally {
      seen.over = true;
      releaseHeld();
      await closeContext(own.context(), "the read-again failure case's context");
    }
  }
  const waitingPollName = "a whole poll waiting for its stylesheet does not replace the layout after a write fails";
  if (!(await hasNavigation())) skip(waitingPollName, "without the Navigation API the poll reloads");
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
      sent: /** @type {Pressed | null} */ (null),
      drew: false,
      waiting: false,
      sentFailing: /** @type {Pressed | null} */ (null),
      failed: false,
      retry: /** @type {string | undefined} */ (undefined),
      /** When the page started that next read, by its clock (`seen.startedAt`), or null. */
      retryStartedAt: /** @type {number | null} */ (null),
      /** Whether the page had noted the stylesheet's load when it started that read (`seen.styled`). */
      retryStyled: false,
      /** When the page had the released stylesheet, by its clock. */
      styleAt: /** @type {number | null} */ (null),
      drawnNext: /** @type {{ time: number, failed: string | null } | null} */ (null),
      /** Whether that read started, and its answer was drawn, after the page had the stylesheet. */
      afterStyle: false,
      drewNext: false,
      kept: false,
      /** Whether the held stylesheet's answer was sent and confirmed (`exchange`), or why not. */
      styled: /** @type {true | string} */ ("not sent"),
    };
    try {
      await within(
        5000,
        "the held stylesheet's route was not set within 5 s",
        own.route("**/assets/smoke-held-poll.css", async (route) => {
          await held;
          // Sent within 5 s once let go, and not once the case is over (`exchange`).
          const ex = exchange(route, "the held stylesheet's answer", () => seen.over, () => route.abort());
          await ex.send(5000, "its fulfill", () => route.fulfill({ contentType: "text/css", body: "" })).catch(() => {});
          got.styled = ex.fault || true;
        }),
      );
      await within(
        5000,
        "the page's failure and stylesheet listeners were not set within 5 s",
        own.evaluate(() => {
          addEventListener("corten:error", () => document.querySelector("header")?.setAttribute("data-failed", ""));
          // The moment the held stylesheet loads, by the page's clock: a `load` does not bubble, and
          // an element's `load` does not reach the window, so it is heard as the document captures it.
          document.addEventListener(
            "load",
            (event) => {
              const link = event.target;
              if (link instanceof HTMLLinkElement && new URL(link.href).pathname === "/assets/smoke-held-poll.css") (/** @type {any} */ (window)).__heldStyleAt ??= performance.now();
            },
            { capture: true },
          );
        }),
      );
      await watchWritten(own, "Watchlist, written");
      await watchMarks(own);
      // The whole poll that reads the page a second after the write's page is drawn asks for the
      // stylesheet, within 5 s from just before the press.
      const asset = cameWithin(5000, own.waitForRequest("**/assets/smoke-held-poll.css", { timeout: 5000 }));
      got.sent = await pressWrite(own, seen, "main form button");
      got.drew = got.sent.ok && (await writtenSeen(own, got.sent.at));
      got.waiting = await asset;
      if (got.drew && got.waiting) {
        seen.fail = true;
        const failingAt = performance.now();
        got.sentFailing = await pressWrite(own, seen, "main form button");
        got.failed = got.sentFailing.ok && (await failureShown(own, failingAt));
      }
      if (got.failed) {
        // Once the held poll is out of the way, the next read asks for a partial response, and its
        // answer is drawn with the failure shown, both within 5 s of the hold's release: the read as
        // the stand-in heard it, by the smoke's clock, against the moment before it let go; the draw
        // as the page recorded it, by the page's clock, against the moment the page had the released
        // stylesheet (its `load`, noted by the page as it came, `__heldStyleAt`), which cannot come
        // before the release. The read must be one the page started once it had the stylesheet: the
        // page's fetch wrapper marks, in the task that starts the read, whether that note was made by
        // then (`seen.styled`), so the order is the page's own and a clock coarsened so that the two
        // times are equal does not decide it. The load is noted as the document captures it, before
        // the runtime hears of it. A retry made while the stylesheet still held the poll is not one the
        // held poll's end let go, and its draw must come at or after the load by the page's clock (the
        // draw's record). A whole draw of the held answer would have replaced the header and lost its
        // failure mark.
        const from = sinceNow(seen);
        release();
        const nextAt = await readAsked(seen, from);
        got.retry = nextAt === null ? undefined : seen.asked[nextAt].split(" ")[2];
        got.retryStartedAt = nextAt === null || !Number.isFinite(seen.startedAt[nextAt]) ? null : seen.startedAt[nextAt];
        got.retryStyled = nextAt !== null && seen.styled[nextAt] === true;
        // The page's note of the stylesheet's load, read once the read it leads to has come (bounded
        // plumbing): the load comes before the held poll's draw, and so before that read.
        got.styleAt = nextAt === null ? null : ((await pollAsync(5000, () => own.evaluate(() => /** @type {number | false} */ ((/** @type {any} */ (window)).__heldStyleAt ?? false)))) ?? null);
        got.drawnNext = nextAt === null || got.styleAt === null ? null : await drawnBy(own, nextAt, got.styleAt + 5000);
        got.afterStyle = got.styleAt !== null && got.retryStyled && got.drawnNext !== null && got.drawnNext.time >= got.styleAt;
        got.drewNext = got.drawnNext?.failed === "";
        got.kept = await readWithin(
          "whether the failure was still shown",
          own.evaluate(() => !!document.querySelector("header[data-failed]") && document.querySelector("header span")?.textContent === "Watchlist, written"),
        );
      }
    } finally {
      seen.over = true;
      release();
      await cleanUp(
        () => within(5000, "the stylesheet case's routes were not removed within 5 s", own.unrouteAll({ behavior: "ignoreErrors" })),
        () => closeContext(own.context(), "the stylesheet case's context"),
      );
    }
    check(
      waitingPollName,
      !!got.sent?.ok && got.drew && got.waiting && !!got.sentFailing?.ok && got.failed && got.retry === "nav" && got.afterStyle && got.drewNext && got.kept && got.styled === true,
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
    try {
      seen.status = 422;
      const entries = await readWithin("the page's history length", own.evaluate(() => history.length));
      await actWithin("the layout field's fill", own.fill("#smoke-find", "abcdef"));
      const pressedAt = performance.now();
      await actWithin("the press of the form's button", own.click("main form button"));
      const drawn = await cameWithin(leftOf(pressedAt, 5000), own.waitForFunction(() => document.activeElement?.getAttribute("name") === "price", null, { timeout: 5000 }));
      const shown = await shownOf(own);
      const state = await readWithin("the refused page's state", own.evaluate(() => {
        const findIn = /** @type {HTMLInputElement | null} */ (document.getElementById("smoke-find"));
        const field = document.activeElement?.getBoundingClientRect();
        return {
          entries: history.length,
          find: findIn?.value,
          // Shown, not whole: WebKit scrolls a focused field just far enough to show part of it.
          inView: !!field && field.bottom > 0 && field.top < innerHeight,
          scrolled: scrollY > 0,
        };
      }));
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
    } finally {
      seen.over = true;
      await closeContext(own.context(), "the refused write case's context");
    }
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
    const { own, seen } = await writtenPage((body) => section("New")(body).replace("<body ", '<body data-smoke-frame="other" '), section("Old"));
    try {
      const first = await shownOf(own);
      const pressedAt = performance.now();
      await actWithin("the press of the form's button", own.click("main form button"));
      const drawn = await writtenIn(own, pressedAt);
      const shown = await shownOf(own);
      check(
        `a write's own page in another frame draws <main> and its layout parts with a form control named ${shadow}`,
        first.section === "Old section" && drawn && shown.section === "New section" && shown.same && shown.path === "/smoke/written",
        JSON.stringify({ first: first.section, drawn, shown }),
      );
    } finally {
      seen.over = true;
      await closeContext(own.context(), "the other frame case's context");
    }
  }
  // A write sent without its `Prefer: corten-draws=whole`, as a runtime from before it sends one (a tab open across
  // the deploy that brought it): the server answers <main> alone, as it did then, which that
  // runtime draws, where a whole page would be an answer it does not draw (it would say the write
  // failed). This runtime, given <main> alone for a write (a server from before), draws it and reads
  // the next page whole, which shows what the write changed.
  const oldName = "a write that does not say it draws the whole page gets <main> alone, and the next page is read whole";
  if (!(await hasNavigation())) skip(oldName, "without the Navigation API a link is a full load");
  else {
    const { own, seen } = await writtenPage(brand);
    // Each step bounded by the smoke's clock, and the page closed (bounded) however the case ends.
    try {
      seen.draws = false;
      await within(5000, "the page's failure listener was not set within 5 s", own.evaluate(() => addEventListener("corten:error", () => ((/** @type {any} */ (window)).__failed = true))));
      // The write's <main> drawn within 5 s of its press, and the link pressed only then, its page in
      // within 5 s of that press.
      const pressedAt = performance.now();
      await actWithin("the press of the form's button", own.click("main form button"));
      const drawn = await writtenIn(own, pressedAt);
      const between = await readWithin("what the page shows after the write", shownOf(own));
      let arrived = false;
      if (drawn) {
        const linkAt = performance.now();
        await actWithin("the press of the link to /smoke/quoted", own.click('main a[href="/smoke/quoted"]'));
        arrived = await cameWithin(
          leftOf(linkAt, 5000),
          own.waitForFunction(() => location.pathname === "/smoke/quoted" && !!document.querySelector("main output#quoted") && !document.querySelector("main form") && !document.querySelector("main[aria-busy], main [aria-busy]"), null, {
            timeout: 5000,
          }),
        );
      }
      const failed = await readWithin("whether the page said a write failed", own.evaluate(() => !!(/** @type {any} */ (window)).__failed));
      const shown = await readWithin("what the page shows after the link", shownOf(own));
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
    } finally {
      seen.over = true;
      await closeContext(own.context(), "the old write case's context");
    }
  }
  // A real mixed deployment has different runtime bytes and therefore a different shell key.
  // Keep the shell guard: reload the current URL, without drawing or resending the refusal.
  {
    const { own, seen } = await writtenPage((body, _writes, headers) => {
      if (!headers) return body;
      headers["corten-shell"] = "old-deploy";
      return body.replace("Written by the form's own page.", "An old server refused this write.");
    });
    try {
      seen.draws = false;
      seen.status = 422;
      const reloaded = cameWithin(5000, own.waitForEvent("framenavigated", { predicate: (frame) => frame === own.mainFrame(), timeout: 5000 }));
      await readWithin("the press of the form's button", own.locator("main form button").evaluate((button) => /** @type {HTMLButtonElement} */ (button).click()));
      const loaded = await reloaded;
      const shown = await shownOf(own);
      const refused = await readWithin("the refused page's main", own.locator("main").textContent());
      check(
        "a legacy action answer with a different shell key reloads without drawing or resending the refusal",
        loaded && "corten-page" in seen.answered && !shown.same && shown.path === "/smoke/written" && seen.writes === 1 &&
          seen.asked.filter((ask) => ask === "GET /smoke/written -").length === 2 && !refused?.includes("refused this write"),
        JSON.stringify({ loaded, shown, writes: seen.writes, asked: seen.asked, refused }),
      );
    } finally {
      seen.over = true;
      await closeContext(own.context(), "the shell key case's context");
    }
  }
  // A write that answers a patch (here one for an element of the layout) is done once its answer
  // comes, but drawn only once the scripts the patch names load. Left by a link in that window,
  // the navigation cuts it off: the next page is read whole, with what the write changed.
  const patchName = "a navigation that leaves a write's patch before it is drawn reads the next page whole";
  if (!(await hasNavigation())) skip(patchName, "without the Navigation API a link is a full load");
  else {
    // What the write changed: the section, which its patch draws and every page after it draws too
    // (its whole pages, and a navigation's answer, which carries the layout's elements that are the
    // page's), and the brand, which only a whole page draws. The section's text is the fixture's own,
    // so a page that drew neither the patch nor a page after the write does not show it. The patch's
    // element alone carries `data-smoke-patch`, so whether the patch itself was ever drawn, even for a
    // moment before a page drew over it, is told apart from the pages that draw the same section.
    const patchedSection = "Section the write patched";
    /** `body` with the section the write patched in place of the server's. @param {string} body */
    const withSection = (body) => body.replace(/<nav(\b[^>]*\bid="sector-nav"[^>]*)>[\s\S]*?<\/nav>/, `<nav$1>${patchedSection}</nav>`);
    const patched = (/** @type {string} */ body, /** @type {number} */ _writes, /** @type {Record<string, string> | undefined} */ headers) => {
      if (!headers) return withSection(brand(body));
      delete headers["corten-shell"];
      headers["corten-patch"] = "";
      return `<nav id="sector-nav" data-smoke-patch data-on="connect:quoted.show()">${patchedSection}</nav>`;
    };
    const { own, seen } = await writtenPage(patched);
    seen.nav = (body) => (seen.written ? withSection(body) : body);
    /** The section the page shows, and whether a page drew it (its `data-corten-page`), not the patch. */
    const sectionOf = () =>
      readWithin(
        "the page's section",
        own.evaluate(() => {
          const nav = document.getElementById("sector-nav");
          return { text: nav?.textContent ?? null, page: !!nav?.hasAttribute("data-corten-page") };
        }),
      );
    /**
     * Watches the page, from before the write is sent, for the patch's own element
     * (`[data-smoke-patch]`) entering it: put in, or marked, at any moment, however soon it is taken
     * out again (a MutationObserver's records keep every insertion). The watch lasts 120 s at most;
     * `patchDrawn` reads it, a watch that ended or was lost (a full load) reading as not kept.
     */
    const watchPatch = () =>
      readWithin(
        "the watch for the patch's element",
        own.evaluate(() => {
          const w = /** @type {any} */ (window);
          const MARK = "[data-smoke-patch]";
          /** @param {Node} node */
          const holds = (node) => node instanceof Element && (node.matches(MARK) || !!node.querySelector(MARK));
          const record = { kept: true, drawn: !!document.querySelector(MARK), take: () => {} };
          /** @param {MutationRecord[]} records */
          const note = (records) => {
            for (const r of records) {
              // An attribute record is the mark set on, or taken off, an element in the page: either way
              // it was there.
              if (r.type === "attributes" || Array.from(r.addedNodes).some(holds)) record.drawn = true;
            }
          };
          const observer = new MutationObserver(note);
          observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-smoke-patch"] });
          record.take = () => note(observer.takeRecords());
          setTimeout(() => {
            record.take();
            observer.disconnect();
            record.kept = false;
          }, 120000);
          w.__smokePatch = record;
        }),
      );
    /** What the watch saw (`watchPatch`): `{ kept, drawn }`, with the records not yet delivered read. */
    const patchDrawn = () =>
      readWithin(
        "whether the patch's element was drawn",
        own.evaluate(() => {
          const record = /** @type {any} */ (window).__smokePatch;
          if (!record) return { kept: false, drawn: null };
          record.take();
          return { kept: record.kept, drawn: record.drawn };
        }),
      );
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {() => void} */
    let asked = () => {};
    /** When the route saw each request for the held script, in order, by the smoke's monotonic clock. @type {number[]} */
    const scriptAsks = [];
    /** When the page asked for the held script, by the smoke's monotonic clock: the first request the route saw. @type {number | null} */
    let askedAt = null;
    const waiting = new Promise((resolve) => (asked = () => resolve(true)));
    // The held script is let go, its route removed and the page closed however the case ends, each
    // bounded, as setting the route is.
    try {
      await within(
        5000,
        "the held script's route was not set within 5 s",
        own.route("**/scripts/quoted.js", async (route) => {
          scriptAsks.push(performance.now());
          askedAt ??= scriptAsks[0];
          asked();
          await held;
          // Let through once let go, bounded, or aborted once the case is over.
          await within(5000, "", seen.over ? route.abort() : route.fallback()).catch(() => {});
        }),
      );
      await watchPatch();
      // The link is pressed only once the browser finished loading that exact write with its marked
      // answer (its `smoke-write` mark) within 5 s of the press (`pressedAt`, taken just before the
      // click is asked for), by the time the check heard it finish (`finished.time`), and the page
      // asked for the script its patch names, which is held, within 5 s of that finish: a fulfill
      // that resolves need not have answered the write, and a request for the script does not say
      // the write was answered. That request is tied to the patch by order: it must be the page's
      // first request for the script, heard after the stand-in handed the page the write's answer
      // (`seen.settled`), before which the page had no patch to name it, so a request for it made
      // before the patch came does not pass for the patch's. The page's end of the body can come before
      // the check hears the write finish, so the request may be heard before that finish, not before
      // the answer was handed over. Without all of it, the link is not pressed and the case fails.
      const pressedAt = performance.now();
      await actWithin("the press of the form's button", own.click("main form button"));
      const finishedBy = pressedAt + 5000;
      // Judged by the time the check heard the finish (`heard.time`), looked at once more when the
      // 5 s are over (`pollRecord`, which reads the record at once), so a finish heard in time counts
      // however late the click returned.
      const heard = (await pollRecord(finishedBy - performance.now(), () => seen.finished[1] ?? false)) || null;
      const finished = heard !== null && heard.time <= finishedBy ? heard : null;
      if (finished !== null && askedAt === null) await cameWithin(leftOf(finished.time, 5000), waiting);
      const handed = seen.settled[1]?.time ?? null;
      const stalled = finished !== null && handed !== null && askedAt !== null && askedAt >= handed && askedAt <= finished.time + 5000;
      let arrived = false;
      if (finished !== null && stalled) {
        const linkAt = performance.now();
        await actWithin("the press of the link to /smoke/quoted", own.click('main a[href="/smoke/quoted"]'));
        release();
        arrived = await cameWithin(
          leftOf(linkAt, 5000),
          own.waitForFunction(() => location.pathname === "/smoke/quoted" && !!document.querySelector("main output#quoted") && !document.querySelector("main form") && !document.querySelector("main[aria-busy], main [aria-busy]"), null, {
            timeout: 5000,
          }),
        );
      }
      release();
      const shown = await readWithin("what the page shows after the link", shownOf(own));
      const section = await sectionOf();
      const patch = await patchDrawn();
      // The link's page read whole draws what the write changed: its brand, and the section the
      // write patched, drawn by that page (its own element), not by the patch left behind, which
      // never entered the page, not even for a moment before that page drew over it.
      const leftWhole =
        stalled &&
        seen.answers === 1 &&
        !!finished &&
        arrived &&
        shown.brand === "Watchlist, written" &&
        section.text === patchedSection &&
        section.page &&
        patch.kept &&
        patch.drawn === false &&
        shown.same &&
        seen.asked.includes("GET /smoke/quoted page");
      const timing = {
        pressedAt,
        handedIn: handed === null ? null : Math.round(handed - pressedAt),
        finishedIn: heard === null ? null : Math.round(heard.time - pressedAt),
        scriptAskedIn: scriptAsks.map((at) => Math.round(at - pressedAt)),
      };
      check(patchName, leftWhole, JSON.stringify({ stalled, answers: seen.answers, finished, timing, faults: seen.faults, arrived, asked: seen.asked, shown, section, patch }));
      // The patch was answered before that page was asked for, so the page's layout drew it: the
      // navigation after reads <main> alone, not the whole page again. Only its reads of
      // /smoke/written count: the pointer left on the link clicked above can make the page that comes
      // prefetch /smoke/quoted, after the navigation's read (#2035). It needs all the step above
      // passed on: the write answered once with its scripts held, the link's page read whole and
      // come, and what the write changed (the brand and the patched section) drawn in the document
      // the page kept, by that page and never by the patch. Without them no patch was left behind and
      // drawn, and a return that reads <main> alone shows nothing. The return must leave that section
      // drawn, the patch's element still never in the page.
      const returnName = "a write's patch answered before a navigation left it is drawn by that page, and the next navigation reads <main> alone";
      if (!leftWhole) {
        check(returnName, false, `no write's patch held, left by a whole navigation and drawn by its page before the return: ${JSON.stringify({ stalled, answers: seen.answers, finished, faults: seen.faults, arrived, asked: seen.asked, shown, section, patch })}`);
      } else {
        const sinceReturn = seen.asked.length;
        const returnAt = performance.now();
        await within(
          5000,
          "the page was not sent back to /smoke/written within 5 s",
          own.evaluate(() => /** @type {any} */ (window).navigation.navigate("/smoke/written")),
        );
        const returned = await cameWithin(
          leftOf(returnAt, 5000),
          own.waitForFunction(() => location.pathname === "/smoke/written" && !!document.querySelector("main form") && !document.querySelector("main[aria-busy], main [aria-busy]"), null, {
            timeout: 5000,
          }),
        );
        const reads = seen.asked.slice(sinceReturn).filter((a) => a.startsWith("GET /smoke/written "));
        const kept = await sectionOf();
        const after = await patchDrawn();
        check(
          returnName,
          returned && reads.join() === "GET /smoke/written nav" && kept.text === patchedSection && after.kept && after.drawn === false,
          JSON.stringify({ returned, reads, asked: seen.asked, section: kept, patch: after }),
        );
      }
    } finally {
      seen.over = true;
      release();
      await cleanUp(
        () => within(5000, "the patch case's routes were not removed within 5 s", own.unrouteAll({ behavior: "ignoreErrors" })),
        () => closeContext(own.context(), "the patch case's context"),
      );
    }
  }
}
