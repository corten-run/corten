import { randomUUID } from "node:crypto";
import { base, engine, skip, check, within } from "./helpers.mjs";

/** An error's first line, or the value as text. @param {unknown} error */
const firstLine = (error) => (error instanceof Error ? error.message : String(error)).split("\n")[0];

/**
 * Calls `probe` every 50 ms until `done` takes its answer or the deadline, each call bounded by
 * what is left, and says whether one was taken in time, with the last answer and the last
 * error a call threw: a failure reports what the page last showed and why a probe last failed,
 * not what one more probe after the deadline saw. An answer that comes after the deadline is none,
 * and a call the deadline cut off is the error only when no call failed for a reason of its own.
 * @template T @param {number} until @param {() => Promise<T>} probe @param {(seen: T) => boolean} done
 * @returns {Promise<{ ok: boolean, last: T | undefined, error: string }>}
 */
async function watch(until, probe, done) {
  const cut = "the last probe was still running when the time ran out";
  /** @type {T | undefined} */
  let last;
  let error = "";
  for (;;) {
    const left = until - performance.now();
    if (left <= 0) return { ok: false, last, error };
    try {
      const seen = await within(left, cut, probe());
      if (performance.now() >= until) return { ok: false, last, error: error || cut };
      last = seen;
      if (done(seen)) return { ok: true, last, error };
    } catch (e) {
      const why = firstLine(e);
      if (why !== cut || !error) error = why;
    }
    const pause = Math.min(50, until - performance.now());
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

/**
 * Follows the waiting part's link to the page with the picks read in, and says which step did not
 * happen, or "" when every one did (#2246):
 * 1. one keyboard activation on a link to the exact Watchlist picks URL;
 * 2. the first request to that address after the click lands (a whole load or `corten: nav` or
 *    `page`) answers with the picks and no read template. Both steps have 10 s from invoking
 *    the key press, including any navigation that Playwright waits for;
 * 3. those picks drawn at that address: the page's address is the expected one when they are seen, the
 *    rows are the ones that answer carried, the waiting part is gone, and no part read
 *    (`corten: action`) was sent after the click that could have filled them. Drawing has 10 s
 *    from accepting the answer.
 * @param {import("@playwright/test").Page} page
 * @param {{ answerMs?: number, drawMs?: number }} [budgets] Shorter deadlines for fixture tests.
 */
export async function followPicks(page, { answerMs = 10_000, drawMs = 10_000 } = {}) {
  const target = new URL("/?picks=true", page.url()).href;
  const marker = `smoke picks click ${randomUUID()}`;
  let link = "";
  try {
    link = await within(
      5000,
      "not settled within 5 s",
      page.evaluate(({ target, marker }) => {
        const part = document.querySelector("#picks");
        const a = part?.querySelector("a");
        if (!(a instanceof HTMLAnchorElement)) return "";
        if (a.href === target) {
          /** @type {any} */ (part).__waitingPicks = true;
          // Session storage keeps the capture-phase witness across a same-origin whole load.
          /** @param {MouseEvent} event */
          const land = (event) => {
            if (!event.isTrusted || event.button !== 0 || !event.composedPath().includes(a) || a.href !== target) return;
            window.removeEventListener("click", land, true);
            sessionStorage.setItem(marker, String(performance.timeOrigin + performance.now()));
          };
          window.addEventListener("click", land, true);
        }
        return a.href;
      }, { target, marker }),
    );
  } catch (error) {
    return `the link could not be read (${firstLine(error)}), at ${page.url()}`;
  }
  if (!link) return `the waiting part has no link to follow, at ${page.url()}`;
  if (link !== target) return `the waiting part links to ${link}, expected ${target}`;
  /** @typedef {import("@playwright/test").Request} Request */
  /** @typedef {import("@playwright/test").Response} Response */
  /** @typedef {{ request: Request, how: string, response?: Response, parsed?: { rows: string[], readNow: boolean }, unread?: string }} Answer */
  /** @type {Map<Request, Answer>} */
  const candidates = new Map();
  let reads = 0;
  let until = 0;
  let landed = 0;
  /** @param {Request} r */
  const onRequest = (r) => {
    if (!until) return;
    const { corten, purpose } = r.headers();
    if (corten === "action") reads++;
    if (purpose === "prefetch" || r.url() !== target || r.method() !== "GET") return;
    const how = r.resourceType() === "document" ? "load" : corten === "nav" || corten === "page" ? corten : "";
    if (how) candidates.set(r, { request: r, how });
  };
  /** @param {Response} res */
  const onResponse = (res) => {
    const a = candidates.get(res.request());
    if (a) a.response = res;
  };
  // Keep arrivals before the page witness is read. Timing excludes requests already in flight
  // at activation, not work caused by a hover. Without a response, Playwright may have no start
  // time: keep that candidate for diagnostics and never let it stand in for an answer.
  const afterClick = () => landed
    ? [...candidates.values()].filter(({ request, response }) => !response || request.timing().startTime > landed)
    : [];
  /** The picks in an answer's markup, parsed by the browser. @param {string} body */
  const parse = (body) =>
    page.evaluate((body) => {
      const html = /** @type {any} */ (window).__html?.(body) ?? body;
      const doc = new DOMParser().parseFromString(html, "text/html");
      return { rows: Array.from(doc.querySelectorAll("ul#picks li"), (li) => li.textContent ?? ""), readNow: !!doc.querySelector("template[data-corten-read-now]") };
    }, body);
  const lateBody = "body not read in time";
  /** @param {Answer} a */
  const readAnswer = async (a) => {
    if (!a.response?.ok()) return;
    // The body read is bounded by the time left since invoking the key press.
    try {
      const left = until - performance.now();
      if (left <= 0) throw new Error(lateBody);
      const body = await within(left, lateBody, a.response.text());
      // A document navigation can replace the evaluation context while parsing.
      const parsed = await watch(until, () => parse(body), () => true);
      if (parsed.ok) a.parsed = parsed.last;
      else a.unread = parsed.error ? `body not parsed in time: ${parsed.error}` : lateBody;
    } catch (error) {
      a.unread = firstLine(error);
    }
  };
  /** @param {Answer | undefined} a */
  const carries = (a) => a?.parsed?.rows.length === 2 && !a.parsed.readNow;
  /** @param {Answer} a */
  const bodyStatus = (a) => {
    if (a.parsed) return carries(a) ? "carries the picks" : "body lacks the picks";
    if (a.response && !a.response.ok()) return "non-2xx response";
    return a.request.failure()?.errorText ?? a.unread ?? (a.response ? lateBody : "no response");
  };
  /** The click's first answer, without its markup. @param {Answer} a */
  const describe = (a) => ({
    how: a.how,
    status: a.response?.status(),
    body: bodyStatus(a),
    items: a.parsed?.rows.length,
    readNow: a.parsed?.readNow,
  });
  /** @param {Answer | undefined} a */
  const noAnswer = (a) =>
    `no answer to the navigation to ${target} carried the picks (${answerMs / 1000} s from activation start, ${afterClick().length} click requests, answer ${JSON.stringify(a ? describe(a) : null)}), at ${page.url()}`;
  page.on("request", onRequest);
  page.on("response", onResponse);
  try {
    until = performance.now() + answerMs;
    try {
      // Focus and press Enter so the trusted click has no pointerover or pointerenter. The
      // dedicated prefetch smoke exercises hover separately.
      await page.press("#picks a", "Enter", { timeout: Math.max(1, Math.floor(until - performance.now())) });
    } catch (error) {
      return `keyboard activation of the link failed (${firstLine(error)}; ${answerMs / 1000} s activation budget), ${candidates.size} candidate requests for ${target}, at ${page.url()}`;
    }
    const activation = await watch(until, () => page.evaluate((key) => Number(sessionStorage.getItem(key)), marker), (at) => at > 0);
    if (!activation.ok || !activation.last) {
      const error = activation.error ? ` (${activation.error})` : "";
      return `no keyboard click reached the link within ${answerMs / 1000} s${error}, at ${page.url()}`;
    }
    landed = activation.last;
    const answered = await watch(
      until,
      async () => afterClick()[0],
      (a) => !!a && !!(a.response || a.request.failure()),
    );
    const a = answered.last;
    if (!answered.ok || !a) return noAnswer(a);
    await readAnswer(a);
    if (!carries(a)) return noAnswer(a);
    const drawn = await watch(
      performance.now() + drawMs,
      () => page.evaluate(() => {
        const part = document.querySelector("#picks");
        return {
          at: location.href,
          rows: Array.from(document.querySelectorAll("ul#picks li"), (li) => li.textContent ?? ""),
          readNow: !!document.querySelector("template[data-corten-read-now]"),
          waiting: !!part && !!(/** @type {any} */ (part).__waitingPicks),
        };
      }),
      (seen) => seen.at === target && !seen.readNow && !seen.waiting && reads === 0 && JSON.stringify(a.parsed?.rows) === JSON.stringify(seen.rows),
    );
    if (!drawn.ok) {
      const error = drawn.error ? `; last probe error: ${drawn.error}` : "";
      return `the picks the answer carried were not drawn at ${target} within ${drawMs / 1000} s of accepting it (last seen ${JSON.stringify(drawn.last ?? null)}, ${reads} part reads, ${afterClick().length} click requests, answer ${JSON.stringify(describe(a))}${error})`;
    }
    return "";
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
  }
}

export async function partReads(page, browser, swaps, noSwaps) {
  // A slow part (the picks): drawn waiting, and read from the page's own route as a patch once the
  // page is on the screen (`ReadAgain::now`, answered by `req.patch_or_with`, #1400).
  await page.waitForSelector("ul#picks", { state: "attached", timeout: 4000 }).catch(() => {});
  check("a slow part the page waits for is read from its route and drawn", (await page.$$("ul#picks li")).length === 2 && (await page.$("#picks[aria-busy]")) === null);
  // The reads are a module of their own (part.js, beside the runtime): a page without a slow part
  // never fetches it, and one with it fetches it once, preloaded with the runtime, which imports
  // it from there (#1400).
  {
    const lean = await (await browser.newContext()).newPage();
    /** @type {string[]} */
    const fetched = [];
    lean.on("request", (r) => new URL(r.url()).pathname.endsWith("/part.js") && fetched.push(`${new URL(lean.url() || base).pathname} ${r.url()}`));
    await lean.goto(`${base}/news`);
    await lean.waitForLoadState("load");
    await lean.waitForTimeout(300);
    const onNews = fetched.length;
    await lean.goto(`${base}/`);
    await lean.waitForSelector("ul#picks li", { state: "attached", timeout: 5000 }).catch(() => {});
    check(
      "a page without a slow part loads no part module, and one with it loads it once, with the runtime",
      onNews === 0 && fetched.length === 1 && (await lean.$$("ul#picks li")).length === 2 && (await lean.$('head link[rel="modulepreload"][href$="/part.js"]')) !== null,
      fetched.join(", "),
    );
    await lean.context().close();
  }
  // While the read may still bring it, the waiting part says it is on its way, is busy and hides
  // the link to the page with it read in: in the page loaded, and in one a client navigation drew.
  // Held, so the waiting part is what is drawn. A read whose patch leaves the part as it was did not
  // bring it, and neither did one that fails (offline): the part shows the link instead, and the
  // page it opens has the part read in (#1264).
  {
    const held = await browser.newPage();
    /** @type {"hold" | "empty" | "abort"} */
    let answer = "hold";
    let reads = 0;
    // The runtime's read of the part is the page's own address, asked with `corten: action`.
    await held.route(`${base}/`, (route) => {
      if (route.request().headers().corten !== "action") return route.continue();
      reads++;
      if (answer === "hold") return new Promise(() => {});
      if (answer === "abort") return route.abort("internetdisconnected");
      return route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: "" });
    });
    const read = () => held.waitForResponse((r) => r.request().headers().corten === "action", { timeout: 5000 }).catch(() => {});
    const placeholder = async () => ({
      reads,
      busy: await held.getAttribute("#picks", "aria-busy"),
      failed: await held.getAttribute("#picks", "data-corten-read-failed"),
      line: await held.isVisible("#picks span"),
      link: await held.isVisible("#picks a"),
    });
    await held.goto(`${base}/`);
    await held.waitForSelector('#picks[aria-busy="true"]', { state: "attached", timeout: 5000 }).catch(() => {});
    const loaded = await placeholder();
    // Busy: the runtime ran and sent the read, which the route holds unanswered.
    check("with JavaScript a slow part waiting says it is on its way and is busy, with no link for it", loaded.line && !loaded.link && loaded.busy === "true" && loaded.failed === null && loaded.reads === 1, JSON.stringify(loaded));
    if (swaps) {
      let documents = 0;
      held.on("request", (r) => r.resourceType() === "document" && documents++);
      await held.click('header nav a[href="/news"]');
      await held.waitForFunction(() => document.title === "News | Watchlist");
      await held.click('header nav a[href="/"]');
      await held.waitForFunction(() => location.pathname === "/" && !!document.querySelector('#picks[aria-busy="true"]'), null, { timeout: 5000 }).catch(() => {});
      // The part is busy once its fetch starts, which in Firefox can be before the route sees it.
      for (let waited = 0; reads < 2 && waited < 5000; waited += 100) await held.waitForTimeout(100);
      const drawn = { ...(await placeholder()), documents };
      check("and so does it in a page a client navigation drew", drawn.line && !drawn.link && drawn.busy === "true" && drawn.reads === 2 && documents === 0, JSON.stringify(drawn));
    } else skip("and so does it in a page a client navigation drew", noSwaps);
    answer = "empty";
    const emptyRead = read();
    await held.goto(`${base}/`);
    await emptyRead;
    await held.waitForFunction(() => !document.querySelector("#picks[aria-busy]"), null, { timeout: 5000 }).catch(() => {});
    const kept = await placeholder();
    check("a read whose patch leaves the part as it was marks it failed, as it did not bring it", kept.busy === null && kept.failed === "" && !kept.line && kept.link, JSON.stringify(kept));
    answer = "abort";
    await held.goto(`${base}/`);
    await held.waitForSelector("#picks[data-corten-read-failed]", { state: "attached", timeout: 5000 }).catch(() => {});
    const failed = await placeholder();
    check("a slow part whose read failed links to the page with it read in, in place of its line", failed.failed === "" && failed.busy === null && !failed.line && failed.link, JSON.stringify(failed));
    // Followed only when shown, so a link that is not fails the checks, not the run; the check says
    // which step did not happen.
    const followed = failed.link ? await followPicks(held) : "the link was not shown, so not followed";
    check("the page it links to has the slow part read in, with JavaScript too", followed === "", followed || held.url());
    await held.unrouteAll({ behavior: "ignoreErrors" });
    await held.context().close();
  }
  // The part module does not load (a 503), though the page and the runtime do: no read starts, and
  // the waiting part shows its link, as without JavaScript: nothing marked it busy, which alone
  // hides the link (#1400).
  {
    const unread = await (await browser.newContext()).newPage();
    let partReads = 0;
    let moduleAsked = 0;
    await unread.route("**/part.js", (route) => (moduleAsked++, route.fulfill({ status: 503, body: "" })));
    await unread.route(`${base}/`, (route) => (route.request().headers().corten === "action" && partReads++, route.continue()));
    await unread.goto(`${base}/`);
    await unread.waitForLoadState("load");
    for (let waited = 0; moduleAsked === 0 && waited < 5000; waited += 100) await unread.waitForTimeout(100);
    await unread.waitForTimeout(500);
    const without = {
      asked: moduleAsked,
      reads: partReads,
      failed: await unread.getAttribute("#picks", "data-corten-read-failed"),
      busy: await unread.getAttribute("#picks", "aria-busy"),
      link: await unread.isVisible("#picks a"),
      line: await unread.isVisible("#picks span"),
    };
    check(
      "a slow part whose read module does not load shows its link, as without JavaScript",
      without.asked > 0 && without.reads === 0 && without.failed === null && without.busy === null && without.link && !without.line,
      JSON.stringify(without),
    );
    await unread.unrouteAll({ behavior: "ignoreErrors" });
    await unread.context().close();
  }
  // A page whose head asks to be read again (`ReadAgain`) and which waits for a slow part: the part
  // is read once, so it does not stop the page's own reads as a part read again would (#1400).
  {
    const both = await browser.newPage();
    let first = true;
    await both.route(`${base}/`, async (route) => {
      if (route.request().headers().corten || !first) return route.continue();
      first = false;
      const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
      const headers = res.headers();
      delete headers["content-encoding"];
      delete headers["content-length"];
      const body = (await res.text()).replace("</title>", '</title><noscript data-corten-read-again="1" data-corten-head><meta http-equiv="refresh" content="1"></noscript>');
      await route.fulfill({ status: res.status(), headers, body }).catch(() => {});
    });
    // The page's read again: a navigation's fetch of it, or a reload where there is no Navigation
    // API. Every whole read after the load's own counts, from the first request on: a loaded
    // WebKit fires `load` late enough that the read again can come before `goto` returns.
    let wholeReads = -1;
    both.on("request", (r) => new URL(r.url()).pathname === "/" && r.method() === "GET" && r.headers().corten !== "action" && wholeReads++);
    // Whether the picks were drawn at all, seen as they are: the page's read again, about when
    // they come (a loaded WebKit draws them some 300 ms after their read ends), swaps in <main>
    // with them waiting again, so a look afterwards can miss them.
    let drawnFirst = false;
    await both.exposeBinding("__picksDrawn", () => {
      drawnFirst = true;
    });
    await both.addInitScript(() =>
      new MutationObserver(() => document.querySelectorAll("ul#picks li").length === 2 && (/** @type {any} */ (window)).__picksDrawn()).observe(document, { childList: true, subtree: true }),
    );
    await both.goto(`${base}/`);
    for (let waited = 0; !drawnFirst && waited < 5000; waited += 100) await both.waitForTimeout(100);
    for (let waited = 0; wholeReads < 1 && waited < 5000; waited += 100) await both.waitForTimeout(100);
    const whole = wholeReads > 0;
    check("a page that asks to be read again is, though it also waits for a slow part", drawnFirst && whole, `picks drawn ${drawnFirst}, read again ${whole}`);
    await both.unrouteAll({ behavior: "ignoreErrors" });
    await both.context().close();
  }
  // A part whose read never ends, on a page that reads itself again and whose data changes each
  // time it is read: the page's reads are not put off for the part, and each draws the part waiting
  // again, which cancels the read before and reads it again (a part slower than the page's own
  // interval never comes; docs/design.md#choice-slow-part-link) (#1400).
  {
    const slower = await (await browser.newContext()).newPage();
    let [wholeAnswers, partReads, cancelled] = [0, 0, 0];
    slower.on("requestfailed", (r) => r.headers().corten === "action" && cancelled++);
    await slower.route(`${base}/`, async (route) => {
      if (route.request().headers().corten === "action") {
        partReads++;
        return new Promise(() => {});
      }
      const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
      const headers = res.headers();
      delete headers["content-encoding"];
      delete headers["content-length"];
      wholeAnswers++;
      const body = (await res.text()).replace(
        "</title>",
        `</title><noscript data-corten-read-again="1" data-corten-head><meta http-equiv="refresh" content="1"></noscript><!--read ${wholeAnswers}-->`,
      );
      await route.fulfill({ status: res.status(), headers, body }).catch(() => {});
    });
    await slower.goto(`${base}/`);
    for (let waited = 0; (wholeAnswers < 3 || partReads < 2) && waited < 8000; waited += 100) await slower.waitForTimeout(100);
    check(
      "a part whose read never ends does not put off the page's read again, which draws the part waiting again and reads it again",
      wholeAnswers >= 3 && partReads >= 2 && cancelled >= 1,
      `page read ${wholeAnswers} times, part ${partReads}, ${cancelled} cancelled`,
    );
    await slower.unrouteAll({ behavior: "ignoreErrors" });
    await slower.context().close();
  }
  // A navigation away while the part's read is on its way: a client navigation stops the read and
  // leaves nothing marked failed on the page it draws; a page the browser left whole (and may keep
  // in its back-forward cache) has the part read when it is back, never marked failed (#1400).
  {
    const away = await (await browser.newContext()).newPage();
    // Whether the way back restored the page (the back-forward cache) or loaded it again, for the
    // check's detail: either way the part must come.
    await away.addInitScript(() => addEventListener("pageshow", (e) => (/** @type {any} */ (window).__restored = e.persisted)));
    let hold = true;
    let reads = 0;
    let releaseAway = () => {};
    await away.route(`${base}/`, async (route) => {
      if (route.request().headers().corten !== "action") return route.continue();
      reads++;
      if (hold) await new Promise((resolve) => (releaseAway = () => resolve(undefined)));
      await route.continue().catch(() => {});
    });
    await away.goto(`${base}/`);
    await away.waitForSelector('#picks[aria-busy="true"]', { state: "attached", timeout: 5000 }).catch(() => {});
    if (swaps) {
      await away.click('header nav a[href="/news"]');
      await away.waitForFunction(() => document.title === "News | Watchlist", null, { timeout: 5000 }).catch(() => {});
      releaseAway();
      await away.waitForTimeout(500);
      check(
        "a client navigation away while a part is read leaves nothing marked failed or busy for it",
        (await away.$("[data-corten-read-failed]")) === null && (await away.$("#picks")) === null && reads === 1,
        `${reads} reads, ${away.url()}`,
      );
    } else skip("a client navigation away while a part is read leaves nothing marked failed or busy for it", noSwaps);
    hold = true;
    await away.goto(`${base}/`);
    await away.waitForSelector('#picks[aria-busy="true"]', { state: "attached", timeout: 5000 }).catch(() => {});
    await away.goto("about:blank");
    hold = false;
    releaseAway();
    await away.goBack();
    await away.waitForSelector("ul#picks li", { state: "attached", timeout: 5000 }).catch(() => {});
    check(
      "a page left whole while its part was read has the part when it is back, not marked failed",
      (await away.$$("ul#picks li")).length === 2 && (await away.$("[data-corten-read-failed]")) === null,
      `restored ${await away.evaluate(() => /** @type {any} */ (window).__restored)}, ${await away.evaluate(() => document.getElementById("picks")?.outerHTML)}`,
    );
    await away.unrouteAll({ behavior: "ignoreErrors" });
    await away.context().close();
  }
  // A read the browser ends by hiding the page (the back-forward cache) is read again once the page
  // is shown, but not over a part a form's answer replaced meanwhile. Playwright does not always
  // keep a page in the cache, so the browser's two events are dispatched here (#1400).
  {
    const hidden = await (await browser.newContext()).newPage();
    /** Reads asked once the page is shown again. @type {Record<string, number>} */
    const hiddenAsked = {};
    /** @type {(() => void)[]} */
    const hiddenHeld = [];
    let shown = false;
    await hidden.route("**/smoke/hidden-*", async (route) => {
      const name = new URL(route.request().url()).pathname.slice("/smoke/".length);
      // Every read until the page is shown fails, a request WebKit sends again after an abort too.
      if (!shown) {
        await new Promise((resolve) => hiddenHeld.push(() => resolve(undefined)));
        return route.abort().catch(() => {});
      }
      hiddenAsked[name] = (hiddenAsked[name] ?? 0) + 1;
      await route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: `<p id="${name}">Read when shown</p>` }).catch(() => {});
    });
    await hidden.goto(`${base}/`);
    await hidden.evaluate(async () => {
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="hidden-0"></div>'));
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      await corten.patch(
        __html(
          '<div id="hidden-0"><p id="hidden-a">Waiting<template data-corten-read-now data-from="/smoke/hidden-a"></template></p><p id="hidden-b">Waiting<template data-corten-read-now data-from="/smoke/hidden-b"></template></p></div>',
        ),
      );
    });
    for (let waited = 0; hiddenHeld.length < 2 && waited < 5000; waited += 50) await hidden.waitForTimeout(50);
    // Both reads end while the page is hidden, so each waits to be made again when it is shown; a
    // form's answer then replaces one of their parts before it is.
    await hidden.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    for (let waited = 0; waited < 400; waited += 50) {
      for (const release of hiddenHeld.splice(0)) release();
      await hidden.waitForTimeout(50);
    }
    await hidden.evaluate(async () => {
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      await corten.patch(__html('<p id="hidden-b">Drawn by a form</p>'));
    });
    for (const release of hiddenHeld.splice(0)) release();
    shown = true;
    await hidden.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await hidden.waitForFunction(() => document.getElementById("hidden-a")?.textContent === "Read when shown", null, { timeout: 5000 }).catch(() => {});
    await hidden.waitForTimeout(300);
    const after = await hidden.evaluate(() =>
      ["hidden-a", "hidden-b"].map((id) => {
        const el = document.getElementById(id);
        return [el?.textContent, el?.getAttribute("data-corten-read-failed") ?? null, el?.getAttribute("aria-busy") ?? null];
      }),
    );
    check(
      "a part whose read ended when the browser hid the page is read again once it is shown",
      after[0][0] === "Read when shown" && after[0][1] === null && hiddenAsked["hidden-a"] === 1,
      JSON.stringify({ after, hiddenAsked }),
    );
    check(
      "but not a part a form's answer replaced while the page was hidden",
      after[1][0] === "Drawn by a form" && after[1][1] === null && after[1][2] === null && !hiddenAsked["hidden-b"],
      JSON.stringify({ after, hiddenAsked }),
    );
    await hidden.unrouteAll({ behavior: "ignoreErrors" });
    await hidden.context().close();
  }
  // A page the browser prerenders reads its parts once it is shown, not before: the server's slow
  // read is for a page someone sees (#1400). Playwright's headless Chromium did not prerender a
  // Speculation Rules page when this was written, so the browser's state is stood in for:
  // `document.prerendering` true until the test fires `prerenderingchange`.
  {
    const ahead = await (await browser.newContext()).newPage();
    await ahead.addInitScript(() => {
      let prerendering = true;
      Object.defineProperty(Document.prototype, "prerendering", { configurable: true, get: () => prerendering });
      Object.defineProperty(window, "__activate", {
        value: () => {
          prerendering = false;
          document.dispatchEvent(new Event("prerenderingchange"));
        },
      });
    });
    let aheadReads = 0;
    ahead.on("request", (r) => new URL(r.url()).pathname === "/" && r.headers().corten === "action" && aheadReads++);
    await ahead.goto(`${base}/`);
    await ahead.waitForTimeout(1500);
    const beforeShown = { reads: aheadReads, busy: await ahead.getAttribute("#picks", "aria-busy"), drawn: (await ahead.$$("ul#picks li")).length };
    await ahead.evaluate(() => /** @type {any} */ (window).__activate());
    await ahead.waitForSelector("ul#picks li", { state: "attached", timeout: 5000 }).catch(() => {});
    const afterShown = { reads: aheadReads, drawn: (await ahead.$$("ul#picks li")).length };
    check(
      "a prerendered page reads its slow part once it is shown, not before",
      beforeShown.reads === 0 && beforeShown.drawn === 0 && afterShown.reads === 1 && afterShown.drawn === 2,
      JSON.stringify({ beforeShown, afterShown }),
    );
    await ahead.context().close();
  }
  // A part in one of the layout's elements that are the page's (`page` in html!, outside
  // <main>) is read as one in <main> is (#1400).
  {
    const laid = await (await browser.newContext()).newPage();
    await laid.route(`${base}/`, async (route) => {
      if (route.request().headers().corten) return route.continue();
      const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
      const headers = res.headers();
      delete headers["content-encoding"];
      delete headers["content-length"];
      const part = '<aside id="layout-part" data-corten-page><p id="layout-a">Waiting<template data-corten-read-now data-from="/smoke/layout-part"></template></p></aside>';
      await route.fulfill({ status: res.status(), headers, body: (await res.text()).replace("<main", `${part}<main`) }).catch(() => {});
    });
    await laid.route("**/smoke/layout-part", (route) =>
      route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: '<p id="layout-a">Layout part drawn</p>' }),
    );
    await laid.goto(`${base}/`);
    await laid.waitForFunction(() => document.getElementById("layout-a")?.textContent === "Layout part drawn", null, { timeout: 5000 }).catch(() => {});
    check("a waiting part in a layout element that is the page's is read and drawn", (await laid.textContent("#layout-a")) === "Layout part drawn", `${await laid.textContent("#layout-a")}`);
    await laid.unrouteAll({ behavior: "ignoreErrors" });
    await laid.context().close();
  }
}

export async function partsInPatches(page, openStreams, browser) {
  // A <corten-live> whose stream finishes (here one fragment, then `end`) applies it and stays
  // closed: no reconnect after the browser's retry delay (about 3 s in Chromium). Without the
  // Navigation API the page above was a full load, whose title is in before <main> is.
  await page.waitForLoadState("domcontentloaded");
  let onceRequests = 0;
  await page.route("**/live/once", (route) => {
    onceRequests += 1;
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: 'event: patch\ndata: <p id="once">Ready</p>\n\nevent: end\ndata: end\n\n',
    });
  });
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<corten-live id="once-live" src="/live/once"><p id="once">Waiting</p></corten-live>')),
  );
  await page.waitForFunction(() => document.querySelector("#once")?.textContent === "Ready", null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(4500);
  check(
    "a <corten-live> stream that ends is applied once and not reopened",
    (await page.textContent("#once")) === "Ready" && onceRequests === 1 && (await openStreams("/live/once")) === 0 && (await page.getAttribute("#once-live", "status")) === "ended",
    `${await page.textContent("#once")}, ${onceRequests} requests`,
  );
  await page.evaluate(() => document.querySelector("#once-live")?.remove());

  // A <corten-live> fragment that draws a part waiting (`ReadAgain::now`) has it read, as a form's
  // answer does: one read a fragment, and a fragment that draws the part again ends the read the
  // one before started. The second fragment comes once the first read is on its way (the stream
  // drops and the reconnect brings it), the first read is held until the second is drawn, and then
  // let through: it was cancelled, and the second stays drawn (#1400).
  {
    let fragmentReads = 0;
    let streams = 0;
    let firstCancelled = false;
    /** @type {(value?: unknown) => void} */
    let releaseFirst = () => {};
    /** @type {(value?: unknown) => void} */
    let sawFirst = () => {};
    const firstSeen = new Promise((resolve) => (sawFirst = resolve));
    // Only the first read is held, so a failed request to it is that read cancelled.
    const onFailed = (/** @type {import("@playwright/test").Request} */ r) => r.url().endsWith("/smoke/fragment-part") && (firstCancelled = true);
    page.on("requestfailed", onFailed);
    const fragmentOf = (/** @type {number} */ n) => `event: patch\ndata: <p id="fragment-a">Waiting ${n}<template data-corten-read-now data-from="/smoke/fragment-part"></template></p>\n\n`;
    await page.route("**/live/fragment-part", async (route) => {
      if (++streams === 1) return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `retry: 100\n${fragmentOf(1)}` });
      await firstSeen;
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `${fragmentOf(2)}event: end\ndata: end\n\n` });
    });
    await page.route("**/smoke/fragment-part", async (route) => {
      const n = ++fragmentReads;
      if (n === 1) {
        sawFirst();
        await new Promise((resolve) => (releaseFirst = resolve));
      }
      await route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: `<p id="fragment-a">Fragment part ${n}</p>` }).catch(() => {});
    });
    await page.evaluate(() =>
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<corten-live id="fragment-live" src="/live/fragment-part"><p id="fragment-a">Idle</p></corten-live>')),
    );
    await page.waitForFunction(() => document.querySelector("#fragment-a")?.textContent === "Fragment part 2", null, { timeout: 5000 }).catch(() => {});
    releaseFirst();
    await page.waitForTimeout(500);
    const fragment = await page.evaluate(() => {
      const el = document.getElementById("fragment-a");
      return { text: el?.textContent, failed: el?.getAttribute("data-corten-read-failed") ?? null, busy: el?.getAttribute("aria-busy") ?? null };
    });
    check(
      "a part a <corten-live> fragment draws waiting is read, one read a fragment, and a later fragment's read cancels the one before, whose late answer is not drawn",
      fragment.text === "Fragment part 2" && fragmentReads === 2 && firstCancelled && fragment.failed === null && fragment.busy === null,
      JSON.stringify({ ...fragment, reads: fragmentReads, streams, firstCancelled }),
    );
    page.off("requestfailed", onFailed);
    await page.unroute("**/live/fragment-part");
    await page.unroute("**/smoke/fragment-part");
    await page.evaluate(() => document.querySelector("#fragment-live")?.remove());
  }

  // ReadAgain::now in markup a patch puts on the page (a form's answer that draws a part waiting,
  // its tag inside it): the parts it waits for are read at once, and two waiting parts that name
  // one address share one read, whose patch draws both (#1400).
  let duoReads = 0;
  await page.route("**/smoke/duo", (route) => {
    duoReads += 1;
    return route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: '<p id="duo-a">A</p><p id="duo-b">B</p>' });
  });
  await page.evaluate(async () => {
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="duo-1"></div><div id="duo-2"></div>'));
    const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
    const waiting = (/** @type {string} */ box, /** @type {string} */ part) =>
      `<div id="${box}"><p id="${part}">Waiting<template data-corten-read-now data-from="/smoke/duo"></template></p></div>`;
    await corten.patch(__html(waiting("duo-1", "duo-a") + waiting("duo-2", "duo-b")));
  });
  await page.waitForFunction(() => document.getElementById("duo-b")?.textContent === "B", null, { timeout: 5000 }).catch(() => {});
  check(
    "two parts a patch draws waiting for one address are read once, at once, and drawn",
    (await page.textContent("#duo-a")) === "A" && (await page.textContent("#duo-b")) === "B" && duoReads === 1 && (await page.$("#duo-1 [aria-busy], #duo-2 [aria-busy]")) === null,
    `${await page.textContent("#duo-a")} ${await page.textContent("#duo-b")}, ${duoReads} reads`,
  );
  await page.evaluate(() => {
    for (const id of ["duo-1", "duo-2"]) document.getElementById(id)?.remove();
  });
  await page.unroute("**/smoke/duo");

  // One of two parts that share a read removed while it is on its way: the read stops, as its
  // patch would draw over the gap, and the other is marked failed at once, so its link shows, not
  // left busy with nothing coming (#1400).
  let releaseDuo = () => {};
  const duoHeld = new Promise((resolve) => (releaseDuo = () => resolve(undefined)));
  let duoAsked = () => {};
  const duoSent = new Promise((resolve) => (duoAsked = () => resolve(undefined)));
  await page.route("**/smoke/duo-held", async (route) => {
    duoAsked();
    await duoHeld;
    await route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: '<p id="duo-c">C</p><p id="duo-d">D</p>' }).catch(() => {});
  });
  await page.evaluate(async () => {
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="duo-3"></div><div id="duo-4"></div>'));
    const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
    const waiting = (/** @type {string} */ box, /** @type {string} */ part) =>
      `<div id="${box}"><p id="${part}">Waiting<template data-corten-read-now data-from="/smoke/duo-held"></template></p></div>`;
    await corten.patch(__html(waiting("duo-3", "duo-c") + waiting("duo-4", "duo-d")));
  });
  await Promise.race([duoSent, page.waitForTimeout(5000)]);
  await page.evaluate(() => document.getElementById("duo-3")?.remove());
  await page.waitForSelector("#duo-d[data-corten-read-failed]", { state: "attached", timeout: 5000 }).catch(() => {});
  check(
    "a part whose shared read lost its other part is marked failed at once, not left busy",
    (await page.textContent("#duo-d")) === "Waiting" && (await page.$("#duo-d[data-corten-read-failed]:not([aria-busy])")) !== null,
    `${await page.evaluate(() => document.getElementById("duo-d")?.outerHTML)}`,
  );
  releaseDuo();
  await page.evaluate(() => document.getElementById("duo-4")?.remove());
  await page.unroute("**/smoke/duo-held");

  // A part replaced while its read's patch waits for a stylesheet it links: the patch, drawn for
  // the part as it was, is not drawn over the one now there (#1400).
  let releaseSheet = () => {};
  const sheetHeld = new Promise((resolve) => (releaseSheet = () => resolve(undefined)));
  let sheetAsked = () => {};
  const sheetSent = new Promise((resolve) => (sheetAsked = () => resolve(undefined)));
  await page.route("**/smoke/late-sheet.css", async (route) => {
    sheetAsked();
    await sheetHeld;
    await route.fulfill({ status: 200, contentType: "text/css", body: "" }).catch(() => {});
  });
  await page.route("**/smoke/late-part", (route) =>
    route.fulfill({
      status: 200,
      headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" },
      body: '<link rel="stylesheet" data-corten-style href="/smoke/late-sheet.css"><p id="late-a">Drawn</p>',
    }),
  );
  await page.evaluate(async () => {
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="late-1"></div>'));
    const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
    await corten.patch(__html('<div id="late-1"><p id="late-a">Waiting<template data-corten-read-now data-from="/smoke/late-part"></template></p></div>'));
  });
  await Promise.race([sheetSent, page.waitForTimeout(5000)]);
  await page.evaluate(() => {
    const fresh = document.createElement("p");
    fresh.id = "late-a";
    fresh.textContent = "Fresh";
    // The part replaced, kept here: its read has ended once its busy mark is gone, which only the
    // read's own end takes away (the stylesheet still held).
    const old = document.getElementById("late-a");
    (/** @type {any} */ (window)).__lateOld = old;
    old?.replaceWith(fresh);
  });
  const lateEnded = await page
    .waitForFunction(() => !(/** @type {any} */ (window)).__lateOld?.hasAttribute("aria-busy"), null, { timeout: 3000 })
    .then(() => true, () => false);
  const lateSettled = await page.evaluate(() => document.getElementById("late-1")?.innerHTML);
  releaseSheet();
  await page.waitForTimeout(300);
  check(
    "a part replaced while its read's stylesheet loads keeps what replaced it, and its read ends without waiting for the stylesheet",
    lateEnded && (await page.textContent("#late-a")) === "Fresh" && (await page.$("#late-a[data-corten-read-failed], #late-1 [aria-busy]")) === null && lateSettled === '<p id="late-a">Fresh</p>',
    `ended ${lateEnded}: ${lateSettled} then ${await page.evaluate(() => document.getElementById("late-1")?.innerHTML)}`,
  );
  await page.evaluate(() => delete (/** @type {any} */ (window)).__lateOld);
  // The stylesheet stays in the head once loaded, as a section's does; the checks that count those
  // must not count it.
  await page.evaluate(() => {
    document.getElementById("late-1")?.remove();
    document.head.querySelector('link[href="/smoke/late-sheet.css"]')?.remove();
  });
  await page.unroute("**/smoke/late-part");
  await page.unroute("**/smoke/late-sheet.css");

  // A newer patch (a script's) that replaces a part and links a stylesheet, and the part's read's
  // answer, which links the same one, both waiting for it: once it loads, both go on in one task,
  // the newer first, and the part's answer, for a part no longer there, is not drawn over it (#1400).
  {
    /** @type {(value?: unknown) => void} */
    let releaseShared = () => {};
    const sharedHeld = new Promise((resolve) => (releaseShared = resolve));
    /** @type {(value?: unknown) => void} */
    let sharedAsked = () => {};
    const sharedSent = new Promise((resolve) => (sharedAsked = resolve));
    /** @type {(value?: unknown) => void} */
    let releasePart = () => {};
    const partHeld = new Promise((resolve) => (releasePart = resolve));
    /** @type {(value?: unknown) => void} */
    let partAsked = () => {};
    const partSent = new Promise((resolve) => (partAsked = resolve));
    await page.route("**/smoke/shared-sheet.css", async (route) => {
      sharedAsked();
      await sharedHeld;
      await route.fulfill({ status: 200, contentType: "text/css", body: "" }).catch(() => {});
    });
    await page.route("**/smoke/shared-part", async (route) => {
      partAsked();
      await partHeld;
      await route
        .fulfill({
          status: 200,
          headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" },
          body: '<link rel="stylesheet" data-corten-style href="/smoke/shared-sheet.css"><p id="shared-a">Stale answer</p>',
        })
        .catch(() => {});
    });
    await page.evaluate(async () => {
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="shared-1"></div>'));
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      await corten.patch(__html('<div id="shared-1"><p id="shared-a">Waiting<template data-corten-read-now data-from="/smoke/shared-part"></template></p></div>'));
    });
    await Promise.race([partSent, page.waitForTimeout(5000)]);
    // The newer patch first, waiting for the stylesheet; then the part's answer, waiting for it too.
    await page.evaluate(async () => {
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      (/** @type {any} */ (window)).__sharedNewer = corten.patch(
        __html('<link rel="stylesheet" data-corten-style href="/smoke/shared-sheet.css"><p id="shared-a">Newer answer</p>'),
      );
    });
    await Promise.race([sharedSent, page.waitForTimeout(5000)]);
    const answered = page.waitForResponse((r) => r.url().endsWith("/smoke/shared-part"), { timeout: 5000 }).catch(() => null);
    releasePart();
    await answered;
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => document.getElementById("shared-a")?.textContent);
    releaseShared();
    await page.evaluate(() => (/** @type {any} */ (window)).__sharedNewer);
    await page.waitForTimeout(300);
    const shared = {
      before,
      ...(await page.evaluate(() => {
        const el = document.getElementById("shared-a");
        return { text: el?.textContent, busy: el?.getAttribute("aria-busy") ?? null, failed: el?.getAttribute("data-corten-read-failed") ?? null };
      })),
    };
    check(
      "a part's answer waiting for the stylesheet a newer patch that replaced the part also waits for is not drawn over it once the stylesheet loads",
      shared.before === "Waiting" && shared.text === "Newer answer" && shared.busy === null && shared.failed === null,
      JSON.stringify(shared),
    );
    await page.evaluate(() => {
      delete (/** @type {any} */ (window)).__sharedNewer;
      document.getElementById("shared-1")?.remove();
      document.head.querySelector('link[href="/smoke/shared-sheet.css"]')?.remove();
    });
    await page.unroute("**/smoke/shared-part");
    await page.unroute("**/smoke/shared-sheet.css");
  }

  // A part's answer and a form's, unrelated to it, both waiting for one stylesheet: once it loads,
  // both are drawn in one task, the part's first. A part the part's answer draws waiting is marked
  // failed and not read, as reads do not chain; the one the form's answer draws is read (#1400).
  {
    /** @type {(value?: unknown) => void} */
    let releaseSheet = () => {};
    const sheetHeld = new Promise((resolve) => (releaseSheet = resolve));
    /** @type {(value?: unknown) => void} */
    let sheetAsked = () => {};
    const sheetSent = new Promise((resolve) => (sheetAsked = resolve));
    /** @type {(value?: unknown) => void} */
    let releasePart = () => {};
    const partHeld = new Promise((resolve) => (releasePart = resolve));
    /** @type {(value?: unknown) => void} */
    let partAsked = () => {};
    const partSent = new Promise((resolve) => (partAsked = resolve));
    /** @type {string[]} */
    const reads = [];
    const sheet = '<link rel="stylesheet" data-corten-style href="/smoke/together-sheet.css">';
    const patchOf = (/** @type {string} */ body) => ({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body });
    await page.route("**/smoke/together-sheet.css", async (route) => {
      sheetAsked();
      await sheetHeld;
      await route.fulfill({ status: 200, contentType: "text/css", body: "" }).catch(() => {});
    });
    await page.route("**/smoke/together-*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(".css")) return route.fallback();
      reads.push(path);
      if (path === "/smoke/together-a") {
        partAsked();
        await partHeld;
        return route
          .fulfill(patchOf(`${sheet}<p id="together-a">A drawn<span id="together-c">C waiting<template data-corten-read-now data-from="/smoke/together-c"></template></span></p>`))
          .catch(() => {});
      }
      if (path === "/smoke/together-form")
        return route.fulfill(patchOf(`${sheet}<p id="together-out">Saved<span id="together-b">B waiting<template data-corten-read-now data-from="/smoke/together-b"></template></span></p>`));
      return route.fulfill(patchOf(`<span id="${path.slice("/smoke/".length)}">${path.slice(-1).toUpperCase()} drawn</span>`));
    });
    await page.evaluate(async () => {
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="together-1"></div>'));
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      await corten.patch(
        __html(
          '<div id="together-1"><p id="together-a">A waiting<template data-corten-read-now data-from="/smoke/together-a"></template></p>' +
            '<form id="together-form" method="post" action="/smoke/together-form" data-patch><button>Save</button></form><p id="together-out"></p></div>',
        ),
      );
    });
    await Promise.race([partSent, page.waitForTimeout(5000)]);
    // The part's answer first, waiting for the stylesheet; then the form's, waiting for it too.
    const partAnswered = page.waitForResponse((r) => r.url().endsWith("/smoke/together-a"), { timeout: 5000 }).catch(() => null);
    releasePart();
    await partAnswered;
    await Promise.race([sheetSent, page.waitForTimeout(5000)]);
    const formAnswered = page.waitForResponse((r) => r.url().endsWith("/smoke/together-form"), { timeout: 5000 }).catch(() => null);
    await page.dispatchEvent("#together-form button", "click");
    await formAnswered;
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => [document.getElementById("together-a")?.textContent, document.getElementById("together-out")?.textContent]);
    releaseSheet();
    await page.waitForFunction(() => document.getElementById("together-b")?.textContent === "B drawn", null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const together = {
      before,
      reads,
      ...(await page.evaluate(() =>
        Object.fromEntries(
          ["together-a", "together-b", "together-c"].map((id) => {
            const el = document.getElementById(id);
            return [id, [el?.textContent, el?.getAttribute("aria-busy") ?? null, el?.getAttribute("data-corten-read-failed") ?? null]];
          }),
        ),
      )),
    };
    check(
      "a part a form's answer draws waiting, drawn in the task a part's answer is (one stylesheet held for both), is read; the one the part's answer draws is not",
      JSON.stringify(together.before) === JSON.stringify(["A waiting", ""]) &&
        JSON.stringify(together["together-a"]) === JSON.stringify(["A drawnC waiting", null, null]) &&
        JSON.stringify(together["together-b"]) === JSON.stringify(["B drawn", null, null]) &&
        JSON.stringify(together["together-c"]) === JSON.stringify(["C waiting", null, ""]) &&
        JSON.stringify(reads) === JSON.stringify(["/smoke/together-a", "/smoke/together-form", "/smoke/together-b"]),
      JSON.stringify(together),
    );
    await page.evaluate(() => {
      document.getElementById("together-1")?.remove();
      document.head.querySelector('link[href="/smoke/together-sheet.css"]')?.remove();
    });
    await page.unroute("**/smoke/together-*");
    await page.unroute("**/smoke/together-sheet.css");
  }

  // Which parts a part's answer drew is decided by the elements it put in the page, not by the
  // addresses its text names. With one stylesheet held for the part's answer and a newer answer,
  // both drawn in one task once it loads: a part the newer answer draws at an address the part's
  // answer also drew waiting (in its place, or beside it once it removed it), or one at an address
  // only a template's content in the part's answer names, is read; so is one a part read again
  // (`ReadAgain::from`) draws in its place (#1400).
  for (const [name, newer] of [
    ["replace", "form"],
    ["remove", "form"],
    ["poll", "poll"],
    ["inert", "form"],
  ]) {
    const at = `/smoke/own-${name}`;
    const id = `own-${name}`;
    const wait = `<template data-corten-read-now data-from="${at}-shared"></template>`;
    /** @type {(value?: unknown) => void} */
    let releaseSheet = () => {};
    const sheetHeld = new Promise((resolve) => (releaseSheet = resolve));
    /** @type {(value?: unknown) => void} */
    let sheetAsked = () => {};
    const sheetSent = new Promise((resolve) => (sheetAsked = resolve));
    /** @type {(value?: unknown) => void} */
    let releasePart = () => {};
    const partHeld = new Promise((resolve) => (releasePart = resolve));
    /** @type {(value?: unknown) => void} */
    let partAsked = () => {};
    const partSent = new Promise((resolve) => (partAsked = resolve));
    /** @type {string[]} */
    const reads = [];
    const sheet = `<link rel="stylesheet" data-corten-style href="${at}.css">`;
    const patchOf = (/** @type {string} */ body) => ({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body });
    // Where the read of the shared address draws: the part the newer answer drew.
    const drawnIn = name === "replace" || name === "poll" ? `${id}-c` : `${id}-b`;
    await page.route(`**${at}.css`, async (route) => {
      sheetAsked();
      await sheetHeld;
      await route.fulfill({ status: 200, contentType: "text/css", body: "" }).catch(() => {});
    });
    await page.route(`**${at}-*`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      reads.push(path.slice(at.length + 1));
      if (path === `${at}-a`) {
        partAsked();
        await partHeld;
        const drew = name === "inert" ? `<template><div>Inert${wait}</div></template>` : `<div id="${id}-c">C old waiting${wait}</div>`;
        return route.fulfill(patchOf(`${sheet}<section id="${id}-a">A done${drew}</section>`)).catch(() => {});
      }
      if (path === `${at}-${newer}`)
        return route.fulfill(
          patchOf(
            sheet +
              {
                replace: `<div id="${id}-c">C new waiting${wait}</div>`,
                remove: `<template id="${id}-c" data-remove></template><p id="${id}-out">Saved<span id="${id}-b">B waiting${wait}</span></p>`,
                poll: `<div id="${id}-c">C new waiting${wait}</div>`,
                inert: `<p id="${id}-out">Saved<span id="${id}-b">B waiting${wait}</span></p>`,
              }[name],
          ),
        );
      return route.fulfill(patchOf(`<${drawnIn.endsWith("-c") ? "div" : "span"} id="${drawnIn}">Shared drawn</${drawnIn.endsWith("-c") ? "div" : "span"}>`));
    });
    await page.evaluate(
      async ({ at, id, poll }) => {
        document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<div id="${id}-1"></div>`));
        const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
        await corten.patch(
          __html(
            `<div id="${id}-1"><section id="${id}-a">A waiting<template data-corten-read-now data-from="${at}-a"></template></section>` +
              `<form id="${id}-form" method="post" action="${at}-form" data-patch><button>Save</button></form><p id="${id}-out"></p></div>` +
              (poll ? `<template data-corten-read-again="1" data-from="${at}-poll"></template>` : ""),
          ),
        );
      },
      { at, id, poll: newer === "poll" },
    );
    await Promise.race([partSent, page.waitForTimeout(5000)]);
    const partAnswered = page.waitForResponse((r) => r.url().endsWith(`${at}-a`), { timeout: 5000 }).catch(() => null);
    releasePart();
    await partAnswered;
    await Promise.race([sheetSent, page.waitForTimeout(5000)]);
    const newerAnswered = page.waitForResponse((r) => r.url().endsWith(`${at}-${newer}`), { timeout: 5000 }).catch(() => null);
    if (newer === "form") await page.dispatchEvent(`#${id}-form button`, "click");
    await newerAnswered;
    await page.waitForTimeout(300);
    releaseSheet();
    await page.waitForFunction((drawnIn) => document.getElementById(drawnIn)?.textContent === "Shared drawn", drawnIn, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const state = await page.evaluate(
      ({ id, drawnIn }) => ({
        drawn: document.getElementById(drawnIn)?.textContent,
        marked: Array.from(document.querySelectorAll(`#${id}-1 [aria-busy], #${id}-1 [data-corten-read-failed]`), (el) => el.id),
      }),
      { id, drawnIn },
    );
    check(
      {
        replace: "a part a form's answer draws in place of one a part's answer drew waiting at the same address, in the same task, is read",
        remove: "a part a form's answer draws at the address of one a part's answer drew waiting, which it removed, in the same task, is read",
        poll: "a part a part read again draws in place of one a part's answer drew waiting at the same address, in the same task, is read",
        inert: "a part a form's answer draws at an address only a template's content in a part's answer names, in the same task, is read",
      }[name],
      state.drawn === "Shared drawn" && state.marked.length === 0 && reads.filter((read) => read === "shared").length === 1,
      `${JSON.stringify(state)}, reads ${reads.join(" ")}`,
    );
    await page.evaluate(({ at, id }) => {
      document.getElementById(`${id}-1`)?.remove();
      document.head.querySelector(`link[href="${at}.css"]`)?.remove();
    }, { at, id });
    await page.unroute(`**${at}-*`);
    await page.unroute(`**${at}.css`);
  }


  // A script that draws a waiting part while a part's answer is drawn, from a callback the drawing
  // runs (the focus it moves to the answer's field, a custom element in it connecting), draws a
  // part of its own, which is read: only the tags in the answer's markup are the answer's. So is
  // one it draws a microtask later or with a patch of its own (#1400).
  for (const [on, how] of [
    ["focus", "sync"],
    ["focus", "micro"],
    ["focus", "patch"],
    ["connect", "sync"],
    ["connect", "micro"],
    ["connect", "patch"],
  ]) {
    const id = `cb-${on}-${how}`;
    /** @type {(value?: unknown) => void} */
    let releasePart = () => {};
    const partHeld = new Promise((resolve) => (releasePart = resolve));
    /** @type {(value?: unknown) => void} */
    let partAsked = () => {};
    const partSent = new Promise((resolve) => (partAsked = resolve));
    /** @type {string[]} */
    const reads = [];
    const patchOf = (/** @type {string} */ body) => ({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body });
    await page.route(`**/smoke/${id}-*`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      reads.push(path.slice(`/smoke/${id}-`.length));
      if (path.endsWith("-a")) {
        partAsked();
        await partHeld;
        const drew = on === "focus" ? `<input id="${id}-field" aria-label="Field">` : `<smoke-part-maker data-into="${id}-b" data-how="${how}"></smoke-part-maker>`;
        return route.fulfill(patchOf(`<section id="${id}-a">A done${drew}</section>`)).catch(() => {});
      }
      return route.fulfill(patchOf(`<span id="${id}-bp">B drawn</span>`));
    });
    await page.evaluate(
      async ({ id, on }) => {
        const w = /** @type {any} */ (window);
        w.__corten ??= await import(/** @type {string} */ ("corten"));
        // Draws B waiting in `into`: at once, a microtask later, or with a patch of its own.
        w.__makePart ??= (/** @type {string} */ into, /** @type {string} */ how) => {
          const markup = `<span id="${into}p">B waiting<template data-corten-read-now data-from="/smoke/${into}"></template></span>`;
          const put = () => document.getElementById(into)?.insertAdjacentHTML("beforeend", __html(markup));
          if (how === "sync") put();
          else if (how === "micro") queueMicrotask(put);
          else w.__corten.patch(__html(`<div id="${into}">${markup}</div>`));
        };
        if (!customElements.get("smoke-part-maker"))
          customElements.define(
            "smoke-part-maker",
            class extends HTMLElement {
              connectedCallback() {
                w.__makePart(this.dataset.into, this.dataset.how);
              }
            },
          );
        document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<div id="${id}-1"></div>`));
        const field = on === "focus" ? `<input id="${id}-field" aria-label="Field">` : "";
        await w.__corten.patch(
          __html(`<div id="${id}-1"><section id="${id}-a">A waiting${field}<template data-corten-read-now data-from="/smoke/${id}-a"></template></section><div id="${id}-b"></div></div>`),
        );
      },
      { id, on },
    );
    await Promise.race([partSent, page.waitForTimeout(5000)]);
    if (on === "focus") {
      await page.focus(`#${id}-field`);
      // Armed once the field has focus: the focus the answer's drawing moves to its own field.
      await page.evaluate(
        ({ id, how }) =>
          document.addEventListener("focusin", function made(event) {
            if (/** @type {Element} */ (event.target).id !== `${id}-field`) return;
            document.removeEventListener("focusin", made);
            /** @type {any} */ (window).__makePart(`${id}-b`, how);
          }),
        { id, how },
      );
    }
    const partAnswered = page.waitForResponse((r) => r.url().endsWith(`/smoke/${id}-a`), { timeout: 5000 }).catch(() => null);
    releasePart();
    await partAnswered;
    await page.waitForFunction((id) => document.getElementById(`${id}-bp`)?.textContent === "B drawn", id, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
    const state = await page.evaluate(
      (id) => ({
        a: document.getElementById(`${id}-a`)?.textContent,
        focused: document.activeElement?.id ?? null,
        b: document.getElementById(`${id}-bp`)?.textContent ?? null,
        marked: Array.from(document.querySelectorAll(`#${id}-1 [aria-busy], #${id}-1 [data-corten-read-failed]`), (el) => el.id),
      }),
      id,
    );
    check(
      `a part a script draws ${{ sync: "at once", micro: "a microtask later", patch: "with a patch of its own" }[how]} as ${on === "focus" ? "the focus moves to a part's answer's field" : "a custom element in a part's answer connects"} is read`,
      state.a === "A done" && state.b === "B drawn" && state.marked.length === 0 && reads.filter((read) => read === "b").length === 1 && (on !== "focus" || state.focused === `${id}-field`),
      `${JSON.stringify(state)}, reads ${reads.join(" ")}`,
    );
    await page.evaluate((id) => document.getElementById(`${id}-1`)?.remove(), id);
    await page.unroute(`**/smoke/${id}-*`);
  }


  // A patch a script makes before a part's answer has even waited for its stylesheet (from the
  // `connectedCallback` of the answer's stylesheet link, a customized built-in, as the runtime puts
  // it in the head) is not taken for the answer: its waiting part is read, and the answer's own is
  // still marked failed, not read (#1400).
  {
    // WebKit has no customized built-in elements.
    const supported = await page.evaluate(() => {
      try {
        class Probe extends HTMLLinkElement {}
        customElements.define("smoke-built-in-probe", Probe, { extends: "link" });
        return document.createElement("link", { is: "smoke-built-in-probe" }) instanceof Probe;
      } catch {
        return false;
      }
    });
    const name = "a script's patch from a part's answer's stylesheet link as it connects is read, and the answer's own part is not";
    if (supported) {
      /** @type {string[]} */
      const asked = [];
      const patchOf = (/** @type {string} */ body) => ({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body });
      await page.route("**/smoke/sheet-cb*", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith(".css")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
        asked.push(path);
        if (path.endsWith("-a"))
          return route.fulfill(
            patchOf(
              '<section id="sheet-cb-a">A done<link is="smoke-sheet-patcher" rel="stylesheet" data-corten-style href="/smoke/sheet-cb.css">' +
                '<div id="sheet-cb-owned">Owned waiting<template data-corten-read-now data-from="/smoke/sheet-cb-owned"></template></div></section>',
            ),
          );
        if (path.endsWith("-b")) return route.fulfill(patchOf('<p id="sheet-cb-bp">B drawn</p>'));
        return route.fulfill(patchOf('<div id="sheet-cb-owned">Owned drawn</div>'));
      });
      await page.evaluate(async () => {
        const w = /** @type {any} */ (window);
        const corten = /** @type {{ patch: (html: unknown) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
        customElements.define(
          "smoke-sheet-patcher",
          class extends HTMLLinkElement {
            connectedCallback() {
              if (w.__sheetPatched) return;
              w.__sheetPatched = true;
              corten.patch(__html('<div id="sheet-cb-b"><p id="sheet-cb-bp">B waiting<template data-corten-read-now data-from="/smoke/sheet-cb-b"></template></p></div>'));
            }
          },
          { extends: "link" },
        );
        document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="sheet-cb-1"></div>'));
        await corten.patch(
          __html('<div id="sheet-cb-1"><section id="sheet-cb-a">A waiting<template data-corten-read-now data-from="/smoke/sheet-cb-a"></template></section><div id="sheet-cb-b"></div></div>'),
        );
      });
      await page.waitForFunction(() => document.getElementById("sheet-cb-bp")?.textContent === "B drawn", null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      const state = await page.evaluate(() => ({
        patched: !!(/** @type {any} */ (window).__sheetPatched),
        a: document.getElementById("sheet-cb-a")?.firstChild?.textContent ?? null,
        b: document.getElementById("sheet-cb-bp")?.textContent ?? null,
        owned: [document.getElementById("sheet-cb-owned")?.textContent ?? null, document.getElementById("sheet-cb-owned")?.getAttribute("data-corten-read-failed") ?? null],
      }));
      check(
        name,
        state.patched && state.a === "A done" && state.b === "B drawn" && JSON.stringify(state.owned) === JSON.stringify(["Owned waiting", ""]) && JSON.stringify(asked) === JSON.stringify(["/smoke/sheet-cb-a", "/smoke/sheet-cb-b"]),
        `${JSON.stringify(state)}, asked ${asked.join(" ")}`,
      );
      await page.evaluate(() => {
        document.getElementById("sheet-cb-1")?.remove();
        document.head.querySelector('link[href="/smoke/sheet-cb.css"]')?.remove();
      });
      await page.unroute("**/smoke/sheet-cb*");
    } else skip(name, "no customized built-in elements");
  }

  // A script's signal is only a signal: an `o` on it, a number or a function, is not taken for the
  // part module's (which apply is given as an argument), whether or not it has aborted (#1400).
  {
    const state = await page.evaluate(async () => {
      const corten = /** @type {{ patch: (html: unknown, signal?: AbortSignal) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="signal-o">Before</div>'));
      const text = () => document.getElementById("signal-o")?.textContent ?? null;
      let called = 0;
      const shown = (/** @type {DocumentFragment} */ content) => {
        called++;
        if (content.firstElementChild) content.firstElementChild.textContent = "Unexpected";
      };
      /** @type {Record<string, unknown>} */
      const seen = {};
      try {
        await corten.patch(__html('<div id="signal-o">Numeric</div>'), Object.assign(new AbortController().signal, { o: 17 }));
        seen.numeric = text();
      } catch (e) {
        seen.numeric = String(e);
      }
      await corten.patch(__html('<div id="signal-o">Callable</div>'), Object.assign(new AbortController().signal, { o: shown }));
      seen.callable = text();
      await corten.patch(__html('<div id="signal-o">Aborted</div>'), Object.assign(AbortSignal.abort(), { o: shown }));
      seen.aborted = text();
      seen.called = called;
      document.getElementById("signal-o")?.remove();
      return seen;
    });
    check(
      "a script's signal with an o property is only a signal to patch(): a number does not refuse the patch, a function is not shown its markup",
      JSON.stringify(state) === JSON.stringify({ numeric: "Numeric", callable: "Callable", aborted: "Callable", called: 0 }),
      JSON.stringify(state),
    );
  }

  // What a patch parsed is kept by nothing once it settles: not when the part it answers left
  // before its stylesheet loaded, not when its signal had aborted, not when its element's target
  // is not on the page. Counted with Chromium's heap, after a collection (#1400).
  {
    const name = "the markup a patch parsed is not kept once it is cancelled, aborted or finds no target";
    if (engine === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      /** Fragments still alive whose first element carries `data-release`, after a collection. @param {string} which */
      const alive = async (which) => {
        await cdp.send("HeapProfiler.collectGarbage");
        const proto = await cdp.send("Runtime.evaluate", { expression: "DocumentFragment.prototype" });
        const found = await cdp.send("Runtime.queryObjects", { prototypeObjectId: /** @type {string} */ (proto.result.objectId) });
        const counted = await cdp.send("Runtime.callFunctionOn", {
          objectId: /** @type {string} */ (found.objects.objectId),
          functionDeclaration: `function () { return this.filter((f) => f.firstElementChild?.getAttribute("data-release") === ${JSON.stringify(which)}).length; }`,
          returnByValue: true,
        });
        await cdp.send("Runtime.releaseObject", { objectId: /** @type {string} */ (found.objects.objectId) });
        return /** @type {number} */ (counted.result.value);
      };
      /** @type {(value?: unknown) => void} */
      let releaseSheet = () => {};
      const sheetHeld = new Promise((resolve) => (releaseSheet = resolve));
      await page.route("**/smoke/release.css", async (route) => {
        await sheetHeld;
        await route.fulfill({ status: 200, contentType: "text/css", body: "" }).catch(() => {});
      });
      await page.route("**/smoke/release-part", (route) =>
        route.fulfill({
          status: 200,
          headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" },
          body: '<section id="release-a" data-release="cancelled"><link rel="stylesheet" data-corten-style href="/smoke/release.css">Drawn</section>',
        }),
      );
      const answered = page.waitForResponse((r) => r.url().endsWith("/smoke/release-part"), { timeout: 5000 }).catch(() => null);
      await page.evaluate(async () => {
        document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="release-1"></div>'));
        const corten = /** @type {{ patch: (html: unknown) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
        await corten.patch(__html('<div id="release-1"><section id="release-a">Waiting<template data-corten-read-now data-from="/smoke/release-part"></template></section></div>'));
      });
      await answered;
      await page.waitForTimeout(200);
      // The part leaves while its answer waits for the stylesheet; then the stylesheet loads.
      await page.evaluate(() => document.getElementById("release-a")?.remove());
      releaseSheet();
      await page.waitForTimeout(500);
      const cancelled = await alive("cancelled");
      await page.evaluate(async () => {
        const corten = /** @type {{ patch: (html: unknown, signal?: AbortSignal) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
        await corten.patch(__html('<div id="release-1" data-release="aborted">Aborted</div>'), AbortSignal.abort());
      });
      const aborted = await alive("aborted");
      await page.evaluate(async () => {
        const corten = /** @type {{ patch: (html: unknown) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
        await corten.patch(__html('<template id="release-nowhere" data-release="missing" data-remove></template>'));
      });
      const missing = await alive("missing");
      const kept = await page.evaluate(() => document.getElementById("release-1")?.textContent ?? null);
      check(name, cancelled === 0 && aborted === 0 && missing === 0 && kept === "", `cancelled ${cancelled}, aborted ${aborted}, missing ${missing}, release-1 "${kept}"`);
      await page.evaluate(() => {
        document.getElementById("release-1")?.remove();
        document.head.querySelector('link[href="/smoke/release.css"]')?.remove();
      });
      await page.unroute("**/smoke/release.css");
      await page.unroute("**/smoke/release-part");
      await cdp.detach();
    } else skip(name, "the heap is counted through Chromium's DevTools protocol");
  }

  // A script's patch that draws a page's first waiting part has the part module, which the page's
  // head did not preload, read it, however its markup spells the tag's attribute: after a newline,
  // a tab, in capitals, as HTML reads them (#1400).
  for (const [spelling, tag] of [
    ["as the server writes it", "<template data-corten-read-now data-from=\"/smoke/cold-part\">"],
    ["after a newline", "<template\ndata-corten-read-now data-from=\"/smoke/cold-part\">"],
    ["after a tab, in capitals", "<template\tDATA-CORTEN-READ-NOW data-from=\"/smoke/cold-part\">"],
  ]) {
    const cold = await (await browser.newContext()).newPage();
    let moduleAsked = 0;
    cold.on("request", (r) => new URL(r.url()).pathname.endsWith("/part.js") && moduleAsked++);
    await cold.route("**/smoke/cold-part", (route) =>
      route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: '<p id="cold-a">Cold drawn</p>' }),
    );
    await cold.goto(`${base}/news`);
    const preloaded = await cold.evaluate(() => !!document.querySelector("[data-corten-part]"));
    const askedBefore = moduleAsked;
    await cold.evaluate(async (tag) => {
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="cold-1"></div>'));
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      await corten.patch(__html(`<div id="cold-1"><p id="cold-a">Waiting${tag}</template></p></div>`));
    }, tag);
    await cold.waitForFunction(() => document.getElementById("cold-a")?.textContent === "Cold drawn", null, { timeout: 5000 }).catch(() => {});
    const coldText = await cold.textContent("#cold-a");
    check(
      `a script's patch that draws a page's first waiting part, its tag written ${spelling}, loads the part module, which reads it`,
      !preloaded && askedBefore === 0 && moduleAsked === 1 && coldText === "Cold drawn",
      `preloaded ${preloaded}, module asked ${askedBefore} then ${moduleAsked}, ${coldText}`,
    );
    await cold.context().close();
  }

  // A waiting part a patch appends (`data-append`): read as one the patch replaces is (#1400).
  let appendedReads = 0;
  await page.route("**/smoke/appended", (route) => {
    appendedReads += 1;
    return route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: '<p id="appended-a">Appended</p>' });
  });
  await page.evaluate(async () => {
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="appended-1"></div>'));
    const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
    await corten.patch(__html('<template id="appended-1" data-append><p id="appended-a">Waiting<template data-corten-read-now data-from="/smoke/appended"></template></p></template>'));
  });
  await page.waitForFunction(() => document.getElementById("appended-a")?.textContent === "Appended", null, { timeout: 5000 }).catch(() => {});
  check(
    "a waiting part a patch appends is read and drawn",
    (await page.textContent("#appended-a")) === "Appended" && appendedReads === 1 && (await page.$("#appended-1 [aria-busy], #appended-1 [data-corten-read-failed]")) === null,
    `${await page.evaluate(() => document.getElementById("appended-1")?.innerHTML)}, ${appendedReads} reads`,
  );
  await page.evaluate(() => document.getElementById("appended-1")?.remove());
  await page.unroute("**/smoke/appended");

  // A part's read depends only on the element its tag is in: a cell beside it in the same grid is
  // not busy, and a patch of that cell, or of a live row beside a slow row in a list, while the
  // read is on its way neither stops the read nor marks anything failed. A part may be a form
  // whose controls shadow what the runtime reads on it (#1400).
  {
    /** @type {Record<string, () => void>} */
    const release = {};
    /** @type {Record<string, Promise<void>>} */
    const sent = {};
    const names = ["grid", "row", "form"];
    for (const name of names) sent[name] = new Promise((resolve) => (release[`${name}-sent`] = () => resolve(undefined)));
    const held = Object.fromEntries(names.map((name) => [name, new Promise((resolve) => (release[name] = () => resolve(undefined)))]));
    await page.route("**/smoke/sibling-*", async (route) => {
      const name = new URL(route.request().url()).pathname.slice("/smoke/sibling-".length);
      release[`${name}-sent`]();
      await held[name];
      const body = {
        grid: '<section id="cell-slow">Slow drawn</section>',
        row: '<li id="row-slow">Slow row drawn</li>',
        form: '<form id="form-slow">Form drawn</form>',
      }[name];
      await route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body }).catch(() => {});
    });
    // Not `parentElement`: a patch of a form with that control loops in the runtime's `changedIn`
    // (main's, beyond this part's read, which reads no part's parent).
    const shadows = ["id", "hasAttribute", "getAttribute", "setAttribute", "removeAttribute", "isConnected"].map((name) => `<input name="${name}">`).join("");
    await page.evaluate(async (shadows) => {
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="sibling-1"></div>'));
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      await corten.patch(
        __html(
          '<div id="sibling-1"><div id="cells"><section id="cell-fast">Fast</section>' +
            '<section id="cell-slow">Waiting<template data-corten-read-now data-from="/smoke/sibling-grid"></template></section></div>' +
            '<ul id="rows"><li id="row-live">Live 1</li><li id="row-slow">Waiting<template data-corten-read-now data-from="/smoke/sibling-row"></template></li><li id="row-other">Other</li></ul>' +
            `<form id="form-slow">${shadows}Waiting<template data-corten-read-now data-from="/smoke/sibling-form"></template></form></div>`,
        ),
      );
    }, shadows);
    await Promise.all(names.map((name) => Promise.race([sent[name], page.waitForTimeout(5000)])));
    const during = await page.evaluate(() =>
      Object.fromEntries(["cell-slow", "cell-fast", "row-slow", "row-live", "form-slow"].map((id) => [id, Element.prototype.getAttribute.call(document.getElementById(id), "aria-busy")])),
    );
    check(
      "only the part a read's tag is in is busy while it is on its way, not the cells or rows beside it",
      during["cell-slow"] === "true" && during["row-slow"] === "true" && during["form-slow"] === "true" && during["cell-fast"] === null && during["row-live"] === null,
      JSON.stringify(during),
    );
    await page.evaluate(async () => {
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      await corten.patch(__html('<section id="cell-fast">Fast again</section><li id="row-live">Live 2</li>'));
    });
    for (const name of names) release[name]();
    await page
      .waitForFunction(
        () => ["cell-slow", "row-slow", "form-slow"].every((id) => document.getElementById(id)?.textContent?.includes("drawn")),
        null,
        { timeout: 5000 },
      )
      .catch(() => {});
    check(
      "a patch of a cell or a live row beside a part while it is read does not stop its read, and a form that is the part is drawn",
      (await page.textContent("#cell-slow")) === "Slow drawn" &&
        (await page.textContent("#row-slow")) === "Slow row drawn" &&
        (await page.textContent("#form-slow")) === "Form drawn" &&
        (await page.textContent("#cell-fast")) === "Fast again" &&
        (await page.textContent("#row-live")) === "Live 2" &&
        (await page.$("#sibling-1 [aria-busy], #sibling-1 [data-corten-read-failed]")) === null,
      `${await page.evaluate(() => document.getElementById("sibling-1")?.innerHTML)}`,
    );
    await page.evaluate(() => document.getElementById("sibling-1")?.remove());
    await page.unroute("**/smoke/sibling-*");
  }

  // Reads do not chain: a part waiting in a part's answer is marked failed rather than read, so two
  // parts whose answers each draw the other waiting cannot read each other without end. One waiting
  // in the answer to a part read again (`ReadAgain::from`) is read, as one a form's answer draws:
  // that read's own interval spaces them (#1400).
  {
    /** @type {string[]} */
    const asked = [];
    const patchOf = (/** @type {string} */ body) => ({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body });
    await page.route("**/smoke/chain-*", (route) => {
      const path = new URL(route.request().url()).pathname;
      asked.push(path);
      if (path === "/smoke/chain-a") return route.fulfill(patchOf('<p id="chain-a">A drawn</p><p id="chain-b">B waiting<template data-corten-read-now data-from="/smoke/chain-b"></template></p>'));
      if (path === "/smoke/chain-b") return route.fulfill(patchOf('<p id="chain-b">B drawn</p><p id="chain-a">A waiting<template data-corten-read-now data-from="/smoke/chain-a"></template></p>'));
      if (path === "/smoke/chain-poll") return route.fulfill(patchOf('<p id="chain-e">Poll part drawn</p>'));
      return route.fulfill(patchOf('<p id="chain-e">Polled<template data-corten-read-now data-from="/smoke/chain-poll"></template></p>'));
    });
    await page.evaluate(async () => {
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="chain-1"><p id="chain-b">B</p><p id="chain-e">Every</p></div>'));
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      await corten.patch(
        __html('<div id="chain-1"><p id="chain-a">A waiting<template data-corten-read-now data-from="/smoke/chain-a"></template></p><p id="chain-b">B</p><p id="chain-e">Every</p></div><template data-corten-read-again="1" data-from="/smoke/chain-every"></template>'),
      );
    });
    await page.waitForFunction(() => document.getElementById("chain-e")?.textContent === "Poll part drawn", null, { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(500);
    const chained = await page.evaluate(() =>
      Object.fromEntries(["chain-a", "chain-b", "chain-e"].map((id) => [id, [document.getElementById(id)?.textContent, document.getElementById(id)?.getAttribute("data-corten-read-failed") ?? null]])),
    );
    check(
      "a part waiting in a part's answer is marked failed, not read; one in a part read again is read",
      chained["chain-a"][0] === "A drawn" &&
        chained["chain-b"][1] === "" &&
        chained["chain-e"][0] === "Poll part drawn" &&
        chained["chain-e"][1] === null &&
        !asked.includes("/smoke/chain-b") &&
        asked.filter((p) => p === "/smoke/chain-a").length === 1 &&
        asked.filter((p) => p === "/smoke/chain-poll").length === 1,
      `${JSON.stringify(chained)}, asked ${asked.join(" ")}`,
    );
    await page.evaluate(() => document.getElementById("chain-1")?.remove());
    await page.unroute("**/smoke/chain-*");
  }

  // A part waiting in what a part's answer appends (`data-append`), whose content joins the page,
  // is that answer's too: marked failed, not read (#1400).
  {
    /** @type {string[]} */
    const asked = [];
    const patchOf = (/** @type {string} */ body) => ({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body });
    await page.route("**/smoke/chain-append-*", (route) => {
      const path = new URL(route.request().url()).pathname;
      asked.push(path);
      if (path.endsWith("-a"))
        return route.fulfill(
          patchOf('<p id="chain-append-a">A drawn</p><template id="chain-append-list" data-append><li id="chain-append-b">B waiting<template data-corten-read-now data-from="/smoke/chain-append-b"></template></li></template>'),
        );
      return route.fulfill(patchOf('<li id="chain-append-b">B drawn</li>'));
    });
    await page.evaluate(async () => {
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="chain-append-1"></div>'));
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      await corten.patch(
        __html('<div id="chain-append-1"><p id="chain-append-a">A waiting<template data-corten-read-now data-from="/smoke/chain-append-a"></template></p><ul id="chain-append-list"></ul></div>'),
      );
    });
    await page.waitForSelector("#chain-append-b[data-corten-read-failed]", { state: "attached", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const appended = await page.evaluate(() => [document.getElementById("chain-append-a")?.textContent, document.getElementById("chain-append-b")?.textContent, document.getElementById("chain-append-b")?.getAttribute("data-corten-read-failed") ?? null]);
    check(
      "a part waiting in what a part's answer appends is marked failed, not read",
      JSON.stringify(appended) === JSON.stringify(["A drawn", "B waiting", ""]) && JSON.stringify(asked) === JSON.stringify(["/smoke/chain-append-a"]),
      `${JSON.stringify(appended)}, asked ${asked.join(" ")}`,
    );
    await page.evaluate(() => document.getElementById("chain-append-1")?.remove());
    await page.unroute("**/smoke/chain-append-*");
  }

  // A part whose read the server answers with an error page, or redirects (`corten-location`, a
  // sign-in), is marked failed and the page stays: its link follows the redirect as any
  // navigation does. A tag in an element with no id, which no patch could replace, is an error in
  // the console, and the element it is in shows its link (#1400).
  {
    // In a page of its own: the browser logs the 500 and the runtime the tag with no part, which
    // the main page's console check counts.
    const broken = await (await browser.newContext()).newPage();
    /** @type {string[]} */
    const said = [];
    broken.on("console", (m) => m.type() === "error" && said.push(m.text()));
    await broken.route("**/smoke/broken-part", (route) =>
      route.fulfill({ status: 500, headers: { "content-type": "text/html; charset=utf-8" }, body: "<!doctype html><title>Error</title><main><p>Something went wrong</p></main>" }),
    );
    await broken.route("**/smoke/signed-out-part", (route) => route.fulfill({ status: 204, headers: { "corten-location": "/news", vary: "corten" } }));
    let idlessReads = 0;
    await broken.route("**/smoke/idless", (route) => {
      idlessReads++;
      return route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: "" });
    });
    await broken.goto(`${base}/`);
    await broken.evaluate(async () => {
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="broken-1"></div>'));
      const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
      await corten.patch(
        __html(
          '<div id="broken-1"><p id="broken-a">Waiting<template data-corten-read-now data-from="/smoke/broken-part"></template></p>' +
            '<p id="signed-a">Waiting<template data-corten-read-now data-from="/smoke/signed-out-part"></template></p>' +
            '<div class="idless">Waiting<template data-corten-read-now data-from="/smoke/idless"></template></div></div>',
        ),
      );
    });
    await broken.waitForSelector("#broken-a[data-corten-read-failed]", { state: "attached", timeout: 5000 }).catch(() => {});
    await broken.waitForSelector("#signed-a[data-corten-read-failed]", { state: "attached", timeout: 5000 }).catch(() => {});
    await broken.waitForTimeout(500);
    check(
      "a part whose read gets an error page is marked failed, not left busy",
      (await broken.$("#broken-a[data-corten-read-failed]:not([aria-busy])")) !== null && (await broken.textContent("#broken-a")) === "Waiting",
      `${await broken.evaluate(() => document.getElementById("broken-1")?.innerHTML)}`,
    );
    check(
      "a part whose read is redirected (corten-location) is marked failed, and the page stays",
      new URL(broken.url()).pathname === "/" && (await broken.$("#signed-a[data-corten-read-failed]:not([aria-busy])")) !== null && !said.some((text) => text.includes("needs a patch")),
      `${broken.url()} ${said.join(" | ")}`,
    );
    check(
      "a waiting tag in an element with no id is an error, not read, and that element shows its link",
      idlessReads === 0 && (await broken.$(".idless[data-corten-read-failed]")) !== null && said.some((text) => text.includes("ReadAgain::now goes in the element its patch replaces")),
      `${idlessReads} reads, ${said.join(" | ")}`,
    );
    await broken.unrouteAll({ behavior: "ignoreErrors" });
    await broken.context().close();
  }
}
