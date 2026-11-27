import { base, skip, check, precommits } from "./helpers.mjs";

export async function prefetch(swaps, page, navRequests, browser, errors, noteBorder, noSwaps) {
  // Swaps only: these links live in the shell, which a full page load replaces.
  if (swaps) {
    // data-nav="section": current on its page and every page under it. Of the links of one
    // data-nav-group (Req::nav_of), only the deepest that holds the page is current, wherever
    // they are: group "a" is split between a <nav> and an <aside>; group "b" is another nav. Group
    // "c+" (the "+" says a link of it has other addresses) has a second link that goes to /latest and
    // holds the page at the other paths of its data-nav-also (NavTo::also) too, ranked by the same
    // rule: deeper than the section above it at /news.
    await page.evaluate(() => {
      document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a id="section-link" href="/" data-nav="section">All</a>'));
      document.querySelector("header")?.insertAdjacentHTML(
        "beforeend",
        __html('<nav><a id="group-all" href="/" data-nav="section" data-nav-group="a">All</a></nav>' +
          '<aside><a id="group-news" href="/news" data-nav data-nav-group="a">News</a></aside>' +
          '<nav><a id="other-all" href="/" data-nav="section" data-nav-group="b">All</a></nav>' +
          '<nav><a id="also-all" href="/" data-nav="section" data-nav-group="c+">All</a>' +
          '<a id="also-latest" href="/latest" data-nav data-nav-group="c+" data-nav-also="/old-news /news">Latest</a></nav>'),
      );
    });
    /** The aria-current of group "c"'s two links. */
    const alsoMarks = () => page.evaluate(() => ["also-all", "also-latest"].map((id) => document.getElementById(id)?.getAttribute("aria-current") ?? "-").join(" "));
    await page.click('header a[href="/"]:not(#section-link, #group-all, #other-all, #also-all)');
    await page.waitForFunction(() => document.title === "Stocks | Watchlist");
    const atHome = await alsoMarks();
    await page.click('header nav a[href="/news"]');
    await page.waitForFunction(() => document.title === "News | Watchlist");
    const marks = await page.evaluate(() =>
      ["section-link", "group-all", "group-news", "other-all"].map((id) => document.getElementById(id)?.getAttribute("aria-current") ?? "-").join(" "),
    );
    check(
      'data-nav="section" marks the link on pages under it',
      marks.startsWith("page ") && (await page.getAttribute('header a[href="/"]:not(#section-link, #group-all, #other-all, #also-all)', "aria-current")) === null,
      marks,
    );
    check("in one data-nav-group only the deepest link that holds the page is current", marks === "page - page page", marks);
    const atNews = await alsoMarks();
    check(
      "a nav link is current at a path of its data-nav-also after a client navigation, ranked as at its own",
      atHome === "page -" && atNews === "- page",
      `at /: ${atHome}; at /news: ${atNews}`,
    );
    await page.evaluate(() => {
      document.getElementById("section-link")?.remove();
      for (const id of ["group-all", "group-news", "other-all", "also-all"]) document.getElementById(id)?.parentElement?.remove();
    });

    // data-no-prefetch: hovering does not fetch; an ordinary link does (the control).
    await page.evaluate(() =>
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<p><a id="no-prefetch" href="/" data-no-prefetch>Home</a> <a id="prefetch" href="/?from=hover">Home</a></p>')),
    );
    // Each count is read once the request it counts has been seen, not after a pause (#1053). A
    // request may be a prefetch (true), a visit (false) or either (undefined).
    /** @param {string} search @param {boolean} [prefetch] */
    const navTo = (search, prefetch) =>
      page
        .waitForRequest(
          (request) =>
            request.headers()["corten"] === "nav" &&
            new URL(request.url()).search === search &&
            (prefetch === undefined || (request.headers()["purpose"] === "prefetch") === prefetch),
          { timeout: 15_000 },
        )
        .catch(() => null);
    navRequests.length = 0;
    await page.hover("#no-prefetch");
    // Nothing to wait for: the check is that no request comes. The pause is the page's own timer,
    // set after the hover's dwell timer, so it ends after the dwell would have fetched.
    await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
    const afterOptOut = navRequests.length;
    const control = navTo("?from=hover", true);
    await page.hover("#prefetch");
    const controlSeen = (await control) !== null;
    check("data-no-prefetch: hovering the link fetches nothing", afterOptOut === 0 && controlSeen && navRequests.length === 1, `${afterOptOut} then ${navRequests.join()}`);
    // The pointer resting on a form with a control named closest (the form itself the target): the
    // hover's dwell looks for a link around it and throws nothing.
    const hovered = await page.evaluate(async () => {
      const form = document.createElement("form");
      form.innerHTML = __html('<input type="hidden" name="closest" disabled>');
      document.querySelector("main")?.append(form);
      let thrown = "";
      const caught = (/** @type {ErrorEvent} */ e) => (thrown = e.message);
      addEventListener("error", caught);
      form.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await new Promise((done) => setTimeout(done, 200));
      removeEventListener("error", caught);
      form.remove();
      return thrown;
    });
    check("the pointer resting on a form with a control named closest throws nothing", hovered === "", hovered);

    // The prefetch cache keeps the 8 newest pages: after hovering 9 links, following the oldest of
    // the 8 kept and the newest reuses their prefetches, so a cache of fewer than 8 fails here, and
    // following the oldest fetches it again, so one of more than 8 fails. The links sit in the
    // shell, which navigation keeps.
    await page.evaluate(() =>
      document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html(Array.from({ length: 9 }, (_, i) => `<a class="hovered" href="/news?p=${i}">${i}</a>`).join(" "))),
    );
    let p1Prefetched = 0;
    /** @type {number[]} */
    const unseen = [];
    for (let i = 0; i < 9; i += 1) {
      const prefetched = navTo(`?p=${i}`, true);
      await page.hover(`header a.hovered[href="/news?p=${i}"]`);
      // Each hover's own prefetch must be seen: a missing one is not made up for by another request.
      if ((await prefetched) === null) unseen.push(i);
      else if (i === 1) p1Prefetched = Date.now();
    }
    const hoveredCount = navRequests.length;
    // A prefetch older than the runtime's 10 s is not reused, so a slow run is told apart from a
    // cache that keeps too few. The age runs from when the prefetch was seen, so it reads low.
    const p1Age = Date.now() - p1Prefetched;
    await page.click('header a.hovered[href="/news?p=1"]');
    await page.waitForFunction(() => location.search === "?p=1");
    await page.click('header a.hovered[href="/news?p=8"]');
    await page.waitForFunction(() => location.search === "?p=8");
    // The oldest is fetched again by its click, or by its hover's dwell when that ends first.
    const fetchedAgain = navTo("?p=0");
    await page.click('header a.hovered[href="/news?p=0"]');
    await page.waitForFunction(() => location.search === "?p=0");
    // Playwright can report the request after the address changes.
    const oldestFetched = (await fetchedAgain) !== null;
    // The oldest kept and the newest were reused: no visit fetched either, however late its
    // request was reported.
    const keptFetched = ["/news?p=1", "/news?p=8"].filter((path) => navRequests.includes(new URL(path, base).href));
    check(
      "prefetch keeps the 8 newest pages: the oldest kept and the newest are reused, the oldest is fetched again",
      unseen.length === 0 && hoveredCount === 10 && keptFetched.length === 0 && oldestFetched && navRequests.length === 11,
      `${unseen.length ? `no prefetch seen for ${unseen.join(" ")}, ` : ""}${hoveredCount}, ${oldestFetched ? "" : "the oldest not fetched again, "}${keptFetched.length ? `fetched ${keptFetched.join(" ")}` : "both reused"} (p1 prefetch seen about ${p1Age} ms before its click), ${navRequests.length}: ${navRequests.map((u) => u.replace(base, "")).join(" ")}`,
    );

    // The page a visit is fetching is not prefetched as well, by the dwell the click cut short or
    // by the pointer leaving its link and coming back: the address stays this page's until that
    // page is in, so the prefetch would fetch it a second time (#1053). Its answer is held until
    // both dwells have ended, however long the hover takes: once the address changes, a dwell
    // finds its link is this page and fetches nothing, so the check would pass untested. A
    // prefetch is held too: one sent before the click, when a slow click lets the first dwell end,
    // is the fetch the visit reuses, and still counts once.
    if (await page.evaluate(precommits)) {
      await page.evaluate(() => document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a class="hovered" href="/news?p=held">held</a>')));
      /** @param {URL} url */
      const heldPage = (url) => url.pathname === "/news" && url.searchParams.get("p") === "held";
      /** @type {() => void} */
      let releaseHeld = () => {};
      const heldReleased = new Promise((resolve) => (releaseHeld = () => resolve(undefined)));
      await page.route(heldPage, async (route) => {
        await heldReleased;
        await route.continue().catch(() => {});
      });
      navRequests.length = 0;
      await page.click('header a.hovered[href="/news?p=held"]');
      await page.mouse.move(0, 0);
      await page.hover('header a.hovered[href="/news?p=held"]');
      // The page's own timer, set after the hover's dwell timer, ends after the dwell would have
      // fetched; only then is the answer let through.
      await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
      const heldSearch = await page.evaluate(() => location.search);
      releaseHeld();
      await page.waitForFunction(() => location.search === "?p=held");
      check(
        "a link followed during its hover's dwell is fetched once, with no prefetch of its page",
        heldSearch !== "?p=held" && navRequests.length === 1,
        `${heldSearch === "?p=held" ? "the address changed before the dwell ended: not tested; " : ""}${navRequests.map((u) => u.replace(base, "")).join(" ") || "none"}`,
      );
      await page.unroute(heldPage);
    } else {
      skip("a link followed during its hover's dwell is fetched once, with no prefetch of its page", "no precommitHandler: the address changes at the click");
    }
    await page.evaluate(() => document.querySelectorAll("header a.hovered").forEach((a) => a.remove()));

    // A prefetch pushed out while its answer is still coming is aborted, so the server sees the
    // client go: the oldest of 9 hovered links is held until it is dropped.
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    await page.route("**/news?q=0", async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    const aborted = page.waitForEvent("requestfailed", { predicate: (r) => r.url().endsWith("/news?q=0"), timeout: 5000 }).then(
      () => true,
      () => false,
    );
    await page.evaluate(() =>
      document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html(Array.from({ length: 9 }, (_, i) => `<a class="hovered" href="/news?q=${i}">${i}</a>`).join(" "))),
    );
    for (let i = 0; i < 9; i += 1) {
      await page.hover(`header a.hovered[href="/news?q=${i}"]`);
      await page.waitForTimeout(150);
    }
    check("a prefetch dropped before it answers is aborted", await aborted);
    release();
    await page.unroute("**/news?q=0");
    await page.evaluate(() => document.querySelectorAll("header a.hovered").forEach((a) => a.remove()));

    // A hover's request says it is a prefetch (`purpose: prefetch`), so a debug build can name a
    // page too costly to fetch on a hover; the click it is used for is a swap.
    /** @type {string[]} */
    const purposes = [];
    await page.route("**/news?r=1", async (route) => {
      purposes.push(route.request().headers()["purpose"] ?? "");
      await route.continue().catch(() => {});
    });
    await page.evaluate(() => document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a class="hovered" href="/news?r=1">r</a>')));
    await page.hover('header a.hovered[href="/news?r=1"]');
    for (let waited = 0; purposes.length < 1 && waited < 2000; waited += 50) await page.waitForTimeout(50);
    await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 6));
    await page.click('header a.hovered[href="/news?r=1"]');
    await page.waitForFunction(() => document.title === "News | Watchlist" && location.search === "?r=1");
    const swappedAfterPrefetch = await page.evaluate(() => (/** @type {any} */ (window)).__marker === 6);
    check(
      "a hover's prefetch says so (purpose: prefetch), and the click uses it",
      purposes.join() === "prefetch" && swappedAfterPrefetch,
      `${purposes.join()} ${swappedAfterPrefetch}`,
    );
    await page.unroute("**/news?r=1");
    await page.evaluate(() => document.querySelectorAll("header a.hovered").forEach((a) => a.remove()));

    // A prefetch answered with something that is not a page (a proxy's 204) is not handed to the
    // click: it fetches the page again and swaps it in, rather than load the document in full.
    /** @type {string[]} */
    const asked = [];
    await page.route("**/news?r=2", async (route) => {
      const purpose = route.request().headers()["purpose"] ?? "";
      asked.push(purpose || "click");
      if (purpose === "prefetch") return route.fulfill({ status: 204 });
      await route.continue().catch(() => {});
    });
    await page.evaluate(() => document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a class="hovered" href="/news?r=2">r</a>')));
    await page.hover('header a.hovered[href="/news?r=2"]');
    for (let waited = 0; asked.length < 1 && waited < 2000; waited += 50) await page.waitForTimeout(50);
    // Hovered again within the prefetch's 10 s, the refused answer is not asked for again.
    await page.hover('header a[href="/news"]');
    await page.waitForTimeout(150);
    await page.hover('header a.hovered[href="/news?r=2"]');
    await page.waitForTimeout(300);
    const askedOnce = asked.join();
    await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 7));
    await page.click('header a.hovered[href="/news?r=2"]');
    await page.waitForFunction(() => document.title === "News | Watchlist" && location.search === "?r=2");
    const swappedAfterNotAPage = await page.evaluate(() => (/** @type {any} */ (window)).__marker === 7);
    check(
      "a prefetch answered with no page is not asked for again on a hover, is fetched again on the click, and swapped in",
      askedOnce === "prefetch" && asked.join() === "prefetch,click" && swappedAfterNotAPage,
      `${askedOnce} then ${asked.join()} ${swappedAfterNotAPage}`,
    );
    await page.unroute("**/news?r=2");
    await page.evaluate(() => document.querySelectorAll("header a.hovered").forEach((a) => a.remove()));

    // A prefetch answered with Corten's own redirect (`corten-location`, a route to a place on a
    // page or another origin) is the visit: the click follows it with no further request.
    /** @type {string[]} */
    const sent = [];
    await page.route("**/news?r=3", async (route) => {
      sent.push(route.request().headers()["purpose"] || "click");
      return route.fulfill({ status: 204, headers: { "corten-location": "/news?r=4" } });
    });
    await page.evaluate(() => document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a class="hovered" href="/news?r=3">r</a>')));
    await page.hover('header a.hovered[href="/news?r=3"]');
    for (let waited = 0; sent.length < 1 && waited < 2000; waited += 50) await page.waitForTimeout(50);
    await page.click('header a.hovered[href="/news?r=3"]');
    await page.waitForFunction(() => document.title === "News | Watchlist" && location.search === "?r=4");
    check("a prefetch answered with Corten's redirect is followed on the click with no further request", sent.join() === "prefetch", sent.join());
    await page.unroute("**/news?r=3");

    // A tap prefetches its link at touchstart, with no dwell: a link nothing hovered is asked for
    // before the tap's click, and the visit uses that answer, so the page sends one request, the
    // prefetch, and is swapped in (#1229). In a context with a touch screen, on a fresh page. A tap
    // also sends pointerover, whose dwell prefetches too: it is stopped before the runtime hears it,
    // so touchstart is the only way the prefetch can come.
    const touch = await browser.newContext({ hasTouch: true });
    const tapPage = await touch.newPage();
    tapPage.on("pageerror", (e) => errors.push(e.message));
    await tapPage.goto(base);
    await tapPage.evaluate(() => {
      addEventListener("pointerover", (e) => e.stopImmediatePropagation(), { capture: true });
      document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a id="tapped" href="/news?t=1">t</a>'));
    });
    /** @type {string[]} */
    const tapRequests = [];
    tapPage.on("request", (r) => {
      if (r.headers()["corten"] === "nav" && new URL(r.url()).search === "?t=1") tapRequests.push(r.headers()["purpose"] === "prefetch" ? "prefetch" : "visit");
    });
    await tapPage.evaluate(() => ((/** @type {any} */ (window)).__marker = 8));
    await tapPage.tap("#tapped");
    const tappedIn = await tapPage
      .waitForFunction(() => document.title === "News | Watchlist" && location.search === "?t=1", null, { timeout: 10_000 })
      .then(() => true, () => false);
    const swappedAfterTap = tappedIn && (await tapPage.evaluate(() => (/** @type {any} */ (window)).__marker === 8));
    await touch.close();
    check(
      "a tapped link is prefetched at touchstart, before its click, and the visit uses it",
      tapRequests.join() === "prefetch" && swappedAfterTap,
      `${tapRequests.join() || "no request"}; ${tappedIn ? (swappedAfterTap ? "swapped in" : "loaded in full") : "the page did not arrive in 10 s"}`,
    );

    // A section stylesheet that fails to load: the runtime loads the page in full instead of
    // showing it unstyled. A fresh document, so the stylesheet is not already in it.
    await page.goto(base);
    let failStyle = true;
    await page.route("**/sections/**", (route) => {
      if (!failStyle) return route.continue();
      failStyle = false;
      return route.abort("internetdisconnected");
    });
    const logged = errors.length;
    await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 5));
    await page.click('header a[href="/news"]');
    await page.waitForFunction(() => document.title === "News | Watchlist" && document.readyState === "complete");
    check(
      "a section stylesheet that fails to load makes the page load in full",
      !failStyle && (await page.evaluate(() => (/** @type {any} */ (window)).__marker === undefined)) && (await noteBorder()) === "4px",
    );
    await page.unroute("**/sections/**");
    // The browser logs the stylesheet it could not load.
    errors.splice(logged, errors.length, ...errors.slice(logged).filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e)));
  } else {
    for (const name of [
      'data-nav="section" marks the link on pages under it',
      "data-no-prefetch: hovering the link fetches nothing",
      "the pointer resting on a form with a control named closest throws nothing",
      "prefetch keeps the 8 newest pages",
      "a link followed during its hover's dwell is fetched once, with no prefetch of its page",
      "a prefetch dropped before it answers is aborted",
      "a hover's prefetch says so (purpose: prefetch), and the click uses it",
      "a prefetch answered with no page is not asked for again on a hover, is fetched again on the click, and swapped in",
      "a prefetch answered with Corten's redirect is followed on the click with no further request",
      "a tapped link is prefetched at touchstart, before its click, and the visit uses it",
      "a section stylesheet that fails to load makes the page load in full",
    ])
      skip(name, noSwaps);
  }

  // With the browser's data saver on, hovering fetches nothing.
  const saver = await browser.newContext();
  await saver.addInitScript(() => Object.defineProperty(Navigator.prototype, "connection", { get: () => ({ saveData: true }) }));
  const saving = await saver.newPage();
  /** @type {string[]} */
  const savingRequests = [];
  saving.on("request", (request) => request.headers()["corten"] === "nav" && savingRequests.push(request.url()));
  await saving.goto(`${base}/news`);
  await saving.hover('header a[href="/"]');
  await saving.waitForTimeout(300);
  check("data saver: hovering a link fetches nothing", savingRequests.length === 0, savingRequests.join());
  await saver.close();
}

/**
 * `NavTo::also` at older addresses written in forms the browser does not show as written: a character
 * beyond ASCII, a `%2e%2E` segment, a `|` (raw in Firefox's and WebKit's request and pathname,
 * `%7C` in Chromium's), a lowercase escape (`%7c`, which WebKit keeps in `location.pathname` but
 * sends as `%7C`) and a trailing space. For each, the server marks the entry at the browser's own
 * request for that address (a navigation, so each engine's network path), and the runtime, ranking
 * copies of the same links it never saw marked, marks the same one at that address after a client
 * navigation. Then addresses where neither marks it, only the section: two the nav names with
 * escaped unreserved characters (`%2e%2ex`, `%7eold%41`), which WebKit keeps in `location.pathname`
 * but sends decoded, so the server leaves them out; and two typed by hand, `/smoke/nav/%73ettings`
 * (the older address `/smoke/nav/settings` with its `s` escaped, compared as written) and
 * `/smoke/nav/%7%33ettings` (a `%` without two hex digits, then `%33`). WebKit asks for the first
 * as `/smoke/nav/settings`, so there its server marks the entry and its runtime does not (the limit
 * the guide names), and it is checked in Chromium and Firefox only. Then a nav whose deeper entry's
 * own URL (`/smoke/nav/old%7c/team/people`) is under another entry's older address: it wins at a page
 * under it in either spelling of the escape, and at a page under that older address and outside
 * People (`/smoke/nav/old%7c/team/other`) the section naming it wins by that address alone, by the
 * server, by the runtime at load with the server's marks taken out, and by the runtime after a
 * client navigation.
 */
export async function navAlso(browser, swaps) {
  const name = "a nav entry is current at its page's older addresses, by the server and the runtime alike";
  const not = "a nav entry is not current at an address with an escaped unreserved character, by the server and the runtime alike";
  const team = "in a nav with other addresses a deeper entry's own URL wins in any spelling, and a section's other address holds a page under it, by the server and the runtime alike";
  const engine = browser.browserType().name();
  const context = await browser.newContext();
  const page = await context.newPage();
  // Each older address as a stored link carries it, with the path the server writes for it.
  const cases = [
    ["/smoke/nav/caf\u00e9", "/smoke/nav/caf%C3%A9"],
    ["/smoke/old/%2e%2E/nav/settings", "/smoke/nav/settings"],
    ["/smoke/nav/a|b", "/smoke/nav/a%7Cb"],
    ["/smoke/nav/old%7chome", "/smoke/nav/old%7Chome"],
    ["/smoke/nav/older", "/smoke/nav/older"],
  ];
  // Addresses where only the section is current: two the nav names and the server leaves out, and
  // two typed by hand. WebKit asks for `%73ettings` decoded, `/smoke/nav/settings`, an older address.
  const nots = ["/smoke/nav/%2e%2ex", "/smoke/nav/%7eold%41", "/smoke/nav/%7%33ettings"];
  if (engine !== "webkit") nots.push("/smoke/nav/%73ettings");
  // Pages under the team nav's People entry, in the spelling its URL has and in another, where People
  // is current; and a page under Settings's older address that People does not hold, where only that
  // older address, matched as a prefix, makes Settings current. Each with the Settings and People marks.
  const visits = [
    ["/smoke/nav/old%7c/team/people/alex", "- page"],
    ["/smoke/nav/old%7C/team/people/alex", "- page"],
    ["/smoke/nav/old%7c/team/other", "page -"],
    ["/smoke/nav/old%7C/team/other", "page -"],
  ];
  const also = cases.map(([, path]) => path).join(" ");
  /** Whether the server draws the entry marked and the section not, in one answer. */
  const marked = (/** @type {string} */ html) => {
    const entry = /<a href="\/smoke\/nav\/here" [^>]*aria-current="page"[^>]*>Here<\/a>/.test(html);
    const section = /<a href="\/smoke\/nav" data-nav="section" [^>]*>Nav<\/a>/.test(html) && !/<a href="\/smoke\/nav" [^>]*aria-current/.test(html);
    return entry && section;
  };
  /** The same, for a request sent outside the browser. */
  const served = async (/** @type {string} */ href) => marked(await (await page.request.get(new URL(href, base).href)).text());
  /** The aria-current of the nav's section and entry links in one answer, with its status. */
  const navMarks = (/** @type {number} */ status, /** @type {string} */ html) =>
    `${status} ${["Nav", "Here"].map((label) => (new RegExp(`<a [^>]*aria-current="page"[^>]*>${label}</a>`).test(html) ? "page" : "-")).join(" ")}`;
  /** The aria-current of the team nav's Settings and People links in one answer. */
  const teamMarks = (/** @type {string} */ html) =>
    ["Settings", "People"].map((label) => (new RegExp(`<a [^>]*aria-current="page"[^>]*>${label}</a>`).test(html) ? "page" : "-")).join(" ");
  /** @type {string[]} */
  const seen = [];
  /** @type {string[]} */
  const teamSeen = [];
  /** @type {string[]} */
  const notSeen = [];
  const drawn = await (await page.request.get(`${base}/smoke/nav/here`)).text();
  const written = drawn.match(/<a href="\/smoke\/nav\/here" data-nav data-nav-group="[0-9a-f]{8}(\+?)" data-nav-also="([^"]*)"/);
  if (written?.[1] !== "+" || written[2] !== also) seen.push(`server wrote group mark "${written?.[1]}" and paths "${written?.[2]}"`);
  for (const [href] of cases) {
    // Node asks for a raw `|` as Firefox and WebKit do; Chromium's `%7C` is a request of its own.
    for (const asked of href.includes("|") ? [href, href.replace("|", "%7C")] : [href]) {
      if (!(await served(asked))) seen.push(`server at ${asked}: unmarked`);
    }
    // The browser's own request for it, as a stored link's full load sends it: WebKit asks for
    // `%7c` as `%7C`, Chromium for `|` as `%7C`.
    const response = await page.goto(new URL(href, base).href);
    if (!response || !marked(await response.text())) seen.push(`server at the browser's request for ${href} (${response?.url()}): unmarked`);
  }
  for (const href of nots) {
    const outside = await page.request.get(new URL(href, base).href);
    const outsideMarks = navMarks(outside.status(), await outside.text());
    if (outsideMarks !== "200 page -") notSeen.push(`server at ${href}: ${outsideMarks}`);
    const response = await page.goto(new URL(href, base).href);
    const marks = response ? navMarks(response.status(), await response.text()) : "no answer";
    if (marks !== "200 page -") notSeen.push(`server at the browser's request for ${href} (${response?.url()}): ${marks}`);
  }
  for (const [visit, want] of visits) {
    const outside = teamMarks(await (await page.request.get(new URL(visit, base).href)).text());
    if (outside !== want) teamSeen.push(`server at ${visit}: ${outside}`);
    const response = await page.goto(new URL(visit, base).href);
    const marks = response ? teamMarks(await response.text()) : "no answer";
    if (marks !== want) teamSeen.push(`server at the browser's request for ${visit}: ${marks}`);
  }
  // A page that only Settings's older address holds, loaded with every mark taken out of the
  // server's answer before the runtime starts: only the runtime's ranking at load, which must match
  // that address as a prefix, can mark Settings.
  for (const [visit, want] of visits.filter(([visit]) => visit.endsWith("/team/other"))) {
    const unmarkedContext = await browser.newContext({ serviceWorkers: "block" });
    const unmarked = await unmarkedContext.newPage();
    /** How many marks each intercepted answer held before they were taken out. @type {number[]} */
    const removed = [];
    // WebKit asks for `%7c` as `%7C`.
    await unmarked.route(
      (url) => url.origin === new URL(base).origin && url.pathname.toLowerCase() === visit.toLowerCase(),
      async (route) => {
        if (route.request().resourceType() !== "document") return route.continue();
        // Uncompressed, since Playwright's Firefox hands a zstd body over undecoded.
        const answer = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        const html = await answer.text();
        removed.push((html.match(/\saria-current="page"/g) ?? []).length);
        return route.fulfill({ response: answer, body: html.replace(/\saria-current="page"/g, "") });
      },
    );
    await unmarked.goto(new URL(visit, base).href);
    await unmarked.waitForFunction(() => !!document.querySelector("main a[data-nav-group][aria-current]"), null, { timeout: 5000 }).catch(() => {});
    const reranked = await unmarked.evaluate(() => ({
      at: location.pathname,
      marks: Array.from(document.querySelectorAll("main a[data-nav-group]")).map((link) => link.getAttribute("aria-current") ?? "-").join(" "),
    }));
    await unmarkedContext.close();
    if (removed.length !== 1 || removed[0] < 1) teamSeen.push(`marks taken out of the intercepted answers for ${visit}: ${JSON.stringify(removed)}`);
    if (reranked.marks !== want) teamSeen.push(`runtime at load of ${reranked.at} with the server's marks taken out: ${reranked.marks}`);
  }
  if (!swaps) {
    check(name, seen.length === 0, seen.join("; ") || "server only: without swaps a client navigation loads the page in full");
    skip(`${name} (runtime)`, "without the Navigation API the browser loads that page in full");
    check(not, notSeen.length === 0, notSeen.join("; ") || `server only at ${nots.join(" ")}: without swaps a client navigation loads the page in full`);
    skip(`${not} (runtime)`, "without the Navigation API the browser loads that page in full");
    check(team, teamSeen.length === 0, teamSeen.join("; ") || "server and the runtime's ranking at load only: without swaps a client navigation loads the page in full");
    skip(`${team} (runtime)`, "without the Navigation API the browser loads that page in full");
    await context.close();
    return;
  }
  for (const [href] of cases) {
    await page.goto(`${base}/smoke/nav/here`);
    // Copies of the nav's links in the shell, which a client navigation keeps, unmarked: only the
    // runtime marks them. Beside them a plain link to the older address, as a stored link carries it.
    await page.evaluate((href) => {
      const nav = document.createElement("nav");
      nav.id = "also-copy";
      for (const link of Array.from(document.querySelectorAll("main a[data-nav-group]"))) {
        const copy = /** @type {Element} */ (link.cloneNode(true));
        copy.removeAttribute("aria-current");
        nav.append(copy);
      }
      const older = document.createElement("a");
      older.id = "also-older";
      older.setAttribute("href", href);
      older.textContent = "Older";
      document.querySelector("header")?.append(nav, older);
    }, href);
    const before = await page.evaluate(() => location.pathname);
    await page.click("#also-older");
    await page.waitForFunction((before) => location.pathname !== before && document.title.startsWith("Nav"), before);
    await page.waitForFunction(() => document.querySelector("#also-copy a[data-nav-also]")?.getAttribute("aria-current") === "page", null, { timeout: 5000 }).catch(() => {});
    const marks = await page.evaluate(() => Array.from(document.querySelectorAll("#also-copy a")).map((link) => link.getAttribute("aria-current") ?? "-").join(" "));
    const at = await page.evaluate(() => location.pathname);
    if (marks !== "- page") seen.push(`runtime at ${at}: ${marks}`);
  }
  check(name, seen.length === 0, seen.join("; ") || "server and runtime marked the entry at every older address");
  for (const href of nots) {
    await page.goto(`${base}/smoke/nav/here`);
    // Unmarked copies of the nav's links, and a plain link to the address, as for an older one.
    await page.evaluate((href) => {
      const nav = document.createElement("nav");
      nav.id = "not-copy";
      for (const link of Array.from(document.querySelectorAll("main a[data-nav-group]"))) {
        const copy = /** @type {Element} */ (link.cloneNode(true));
        copy.removeAttribute("aria-current");
        nav.append(copy);
      }
      const other = document.createElement("a");
      other.id = "not-other";
      other.setAttribute("href", href);
      other.textContent = "Other";
      document.querySelector("header")?.append(nav, other);
    }, href);
    const before = await page.evaluate(() => location.pathname);
    await page.click("#not-other");
    await page.waitForFunction((before) => location.pathname !== before && document.title.startsWith("Nav"), before);
    await page.waitForFunction(() => !!document.querySelector("#not-copy a[aria-current]"), null, { timeout: 5000 }).catch(() => {});
    const marks = await page.evaluate(() => Array.from(document.querySelectorAll("#not-copy a")).map((link) => link.getAttribute("aria-current") ?? "-").join(" "));
    if (marks !== "page -") notSeen.push(`runtime at ${await page.evaluate(() => location.pathname)}: ${marks}`);
  }
  check(not, notSeen.length === 0, notSeen.join("; ") || `server and runtime marked only the section at ${nots.join(" ")}`);
  for (const [visit, want] of visits) {
    await page.goto(`${base}/smoke/nav/old%7c/team/people/start`);
    // Unmarked copies of the team nav's links in the shell, and a plain link to the page under it.
    await page.evaluate((visit) => {
      const nav = document.createElement("nav");
      nav.id = "team-copy";
      for (const link of Array.from(document.querySelectorAll("main a[data-nav-group]"))) {
        const copy = /** @type {Element} */ (link.cloneNode(true));
        copy.removeAttribute("aria-current");
        nav.append(copy);
      }
      const under = document.createElement("a");
      under.id = "team-visit";
      under.setAttribute("href", visit);
      under.textContent = "Alex";
      document.querySelector("header")?.append(nav, under);
    }, visit);
    const before = await page.evaluate(() => location.pathname);
    await page.click("#team-visit");
    await page.waitForFunction((before) => location.pathname !== before && document.title.startsWith("Nav team"), before);
    await page.waitForFunction(() => !!document.querySelector("#team-copy a[aria-current]"), null, { timeout: 5000 }).catch(() => {});
    const marks = await page.evaluate(() => Array.from(document.querySelectorAll("#team-copy a")).map((link) => link.getAttribute("aria-current") ?? "-").join(" "));
    if (marks !== want) teamSeen.push(`runtime at ${await page.evaluate(() => location.pathname)}: ${marks}`);
  }
  check(team, teamSeen.length === 0, teamSeen.join("; ") || "server and runtime marked People under it and Settings under its older address, in both spellings");
  await context.close();
}

/**
 * Nav links whose `href` leads off this site, `//corten.invalid/smoke/far/old` and the same with
 * `/\` or a tab after the first `/`, which the browser reads as that host's `/smoke/far/old`: in a
 * nav with other addresses, in one without and as a lone `req.nav` link (`/smoke/far/{name}`). None
 * is current at `/smoke/far/old`, nor at `/smoke/far/older`, an other address the server leaves out
 * of an off-site entry; only the sections are. Here, whose other address leads off too and is left
 * out, is current at its kept one, `/smoke/far/before`. The nav without other addresses holds
 * `//[` too, which no browser parses as a URL: never current, and the runtime ranks its siblings
 * at a full load and after a client navigation without throwing. The server's answer to the
 * browser's own request, and the runtime after a client navigation on copies of the links it never
 * saw marked.
 */
export async function navFar(browser, swaps) {
  const name = "a nav link that leads off this site is never current, by the server and the runtime alike";
  const context = await browser.newContext();
  const page = await context.newPage();
  /** What the page threw: the runtime ranking the links must not. @type {string[]} */
  const thrown = [];
  page.on("pageerror", (error) => thrown.push(`${page.url()}: ${error.message}`));
  const labels = ["Far", "Slashes", "Backslash", "Tab", "Here", "Plain far", "Plain slashes", "Plain backslash", "Plain tab", "Plain malformed", "Lone"];
  const sections = "page - - - - page - - - - -";
  /** Each page, with the marks the server and the runtime give the links there. */
  const visits = [
    ["/smoke/far/old", sections],
    ["/smoke/far/older", sections],
    ["/smoke/far/before", "- - - - page page - - - - -"],
  ];
  /** The aria-current of each link in one answer. */
  const marks = (/** @type {string} */ html) =>
    labels.map((label) => (new RegExp(`<a [^>]*aria-current="page"[^>]*>${label}</a>`).test(html) ? "page" : "-")).join(" ");
  /** @type {string[]} */
  const seen = [];
  const drawn = await (await page.request.get(`${base}/smoke/far/here`)).text();
  if (!/<a href="\/\/corten\.invalid\/smoke\/far\/old" data-nav data-nav-group="[0-9a-f]{8}\+">Slashes<\/a>/.test(drawn)) seen.push("server wrote other addresses for the off-site entry, or not its group");
  if (!/<a href="\/smoke\/far\/here" data-nav data-nav-group="[0-9a-f]{8}\+" data-nav-also="\/smoke\/far\/before" aria-current="page">Here<\/a>/.test(drawn)) seen.push("server did not write Here's kept address alone");
  if (!/<a href="\/\/\[" data-nav data-nav-group="[0-9a-f]{8}">Plain malformed<\/a>/.test(drawn)) seen.push("server did not write the malformed link as it is, unmarked");
  for (const [visit, expected] of visits) {
    const outside = marks(await (await page.request.get(new URL(visit, base).href)).text());
    if (outside !== expected) seen.push(`server at ${visit}: ${outside}`);
    const response = await page.goto(new URL(visit, base).href);
    const at = response ? marks(await response.text()) : "no answer";
    if (at !== expected) seen.push(`server at the browser's request for ${visit}: ${at}`);
  }
  if (!swaps) {
    seen.push(...thrown);
    check(name, seen.length === 0, seen.join("; ") || "server only: without swaps a client navigation loads the page in full");
    skip(`${name} (runtime)`, "without the Navigation API the browser loads that page in full");
    await context.close();
    return;
  }
  for (const [visit, expected] of visits) {
    await page.goto(`${base}/smoke/far/here`);
    // Unmarked copies of every nav link in the shell, which a client navigation keeps, and a plain
    // link to the page.
    await page.evaluate((visit) => {
      const nav = document.createElement("nav");
      nav.id = "far-copy";
      for (const link of Array.from(document.querySelectorAll("main a[data-nav]"))) {
        const copy = /** @type {Element} */ (link.cloneNode(true));
        copy.removeAttribute("aria-current");
        nav.append(copy);
      }
      const to = document.createElement("a");
      to.id = "far-visit";
      to.setAttribute("href", visit);
      to.textContent = "Visit";
      document.querySelector("header")?.append(nav, to);
    }, visit);
    const before = await page.evaluate(() => location.pathname);
    await page.click("#far-visit");
    await page.waitForFunction((before) => location.pathname !== before && document.title.startsWith("Nav far"), before);
    await page.waitForFunction(() => !!document.querySelector("#far-copy a[aria-current]"), null, { timeout: 5000 }).catch(() => {});
    const copies = await page.evaluate(() => Array.from(document.querySelectorAll("#far-copy a")).map((link) => link.getAttribute("aria-current") ?? "-").join(" "));
    if (copies !== expected) seen.push(`runtime at ${await page.evaluate(() => location.pathname)}: ${copies}`);
  }
  seen.push(...thrown);
  check(name, seen.length === 0, seen.join("; ") || "server and runtime marked only the sections, and Here at its kept address");
  await context.close();
}

/**
 * `NavTo::also` at an older address with a character HTML escapes, `/smoke/amp/a&copy;`, which the
 * browser keeps in a path as written. The parsed `data-nav-also` holds that address literally (an
 * unescaped `&copy;` would parse as the copyright sign), the group says the nav has other addresses, and the
 * entry is current there: in the server's answer to the browser's own request, in that page once the
 * runtime has ranked its links (also when the server's mark is taken out of the answer before the
 * runtime starts, so the runtime's own ranking at load must put it back), and, on copies of the links
 * it never saw marked, after a client navigation.
 */
export async function navAmp(browser, swaps) {
  const name = "a nav entry is current at an older address with a character HTML escapes, by the server and the runtime alike";
  const context = await browser.newContext();
  const page = await context.newPage();
  const older = "/smoke/amp/a&copy;";
  /** The aria-current of the nav's section and entry links in the server's answer. */
  const marks = (/** @type {string} */ html) =>
    ["Amp", "Here"].map((label) => (new RegExp(`<a [^>]*aria-current="page"[^>]*>${label}</a>`).test(html) ? "page" : "-")).join(" ");
  /** @type {string[]} */
  const seen = [];
  await page.goto(`${base}/smoke/amp/here`);
  const parsed = await page.evaluate(() => {
    const link = document.querySelector('main a[href="/smoke/amp/here"]');
    return { group: link?.getAttribute("data-nav-group"), also: link?.getAttribute("data-nav-also") };
  });
  if (!/^[0-9a-f]{8}\+$/.test(parsed.group ?? "") || parsed.also !== older) seen.push(`parsed group "${parsed.group}" and paths ${JSON.stringify(parsed.also)}`);
  const response = await page.goto(new URL(older, base).href);
  const at = await page.evaluate(() => location.pathname);
  if (at !== older) seen.push(`the browser shows ${older} as ${at}`);
  const served = response ? marks(await response.text()) : "no answer";
  if (response?.status() !== 200 || served !== "- page") seen.push(`server at the browser's request for ${older} (${response?.url()}): ${response?.status()} ${served}`);
  // The runtime ranks the links again once the page has loaded, by the parsed attribute.
  const loaded = await page.evaluate(() => Array.from(document.querySelectorAll("main a[data-nav-group]")).map((link) => link.getAttribute("aria-current") ?? "-").join(" "));
  if (loaded !== "- page") seen.push(`page loaded at ${older}: ${loaded}`);
  // That page's links came marked by the server. Load it again with every mark taken out of the
  // server's answer before the runtime starts: only the runtime's ranking at load can put it back.
  const unmarkedContext = await browser.newContext({ serviceWorkers: "block" });
  const unmarked = await unmarkedContext.newPage();
  /** How many marks each intercepted answer for the older address held before they were taken out. @type {number[]} */
  const removed = [];
  await unmarked.route(
    (url) => url.origin === new URL(base).origin && url.pathname === older,
    async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      // Uncompressed, since Playwright's Firefox hands a zstd body over undecoded.
      const answer = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
      const html = await answer.text();
      removed.push((html.match(/\saria-current="page"/g) ?? []).length);
      return route.fulfill({ response: answer, body: html.replace(/\saria-current="page"/g, "") });
    },
  );
  await unmarked.goto(new URL(older, base).href);
  await unmarked.waitForFunction(() => !!document.querySelector("main a[data-nav-group][aria-current]"), null, { timeout: 5000 }).catch(() => {});
  const reranked = await unmarked.evaluate(() => ({
    at: location.pathname,
    marks: Array.from(document.querySelectorAll("main a[data-nav-group]")).map((link) => link.getAttribute("aria-current") ?? "-").join(" "),
  }));
  await unmarkedContext.close();
  if (removed.length !== 1 || removed[0] < 1) seen.push(`marks taken out of the intercepted answers for ${older}: ${JSON.stringify(removed)}`);
  if (reranked.at !== older || reranked.marks !== "- page") seen.push(`runtime at load of ${reranked.at} with the server's marks taken out: ${reranked.marks}`);
  if (!swaps) {
    check(name, seen.length === 0, seen.join("; ") || "server and the runtime's ranking at load only: without swaps a client navigation loads the page in full");
    skip(`${name} (runtime)`, "without the Navigation API the browser loads that page in full");
    await context.close();
    return;
  }
  await page.goto(`${base}/smoke/amp/here`);
  // Unmarked copies of the nav's links in the shell, which a client navigation keeps, and a plain
  // link to the older address, as a stored link carries it.
  await page.evaluate((older) => {
    const nav = document.createElement("nav");
    nav.id = "amp-copy";
    for (const link of Array.from(document.querySelectorAll("main a[data-nav-group]"))) {
      const copy = /** @type {Element} */ (link.cloneNode(true));
      copy.removeAttribute("aria-current");
      nav.append(copy);
    }
    const to = document.createElement("a");
    to.id = "amp-older";
    to.setAttribute("href", older);
    to.textContent = "Older";
    document.querySelector("header")?.append(nav, to);
  }, older);
  const before = await page.evaluate(() => location.pathname);
  await page.click("#amp-older");
  await page.waitForFunction((before) => location.pathname !== before && document.title.startsWith("Nav amp"), before);
  await page.waitForFunction(() => !!document.querySelector("#amp-copy a[aria-current]"), null, { timeout: 5000 }).catch(() => {});
  const copies = await page.evaluate(() => Array.from(document.querySelectorAll("#amp-copy a")).map((link) => link.getAttribute("aria-current") ?? "-").join(" "));
  if (copies !== "- page") seen.push(`runtime at ${await page.evaluate(() => location.pathname)}: ${copies}`);
  check(name, seen.length === 0, seen.join("; ") || `server and runtime marked the entry at ${older}, whose address the link carries as written`);
  await context.close();
}

/**
 * `NavTo::also` naming an older address that holds a raw NUL, `/smoke/nul/raw<NUL>x`, which is not
 * a usable address: Chromium and WebKit ask for it as `/smoke/nul/raw%00x` and Firefox cuts it at
 * the NUL and asks for `/smoke/nul/raw`. The server leaves it out of `data-nav-also` and never
 * marks the entry by it, so only the section is current at every engine's own request for it (a
 * full load from a stored link, `data-reload`) and, in the runtime, after a client navigation to it.
 * The same address written with the escape, `/smoke/nul/esc%00x`, is kept, and there the entry is
 * current, by the server and the runtime alike.
 */
export async function navNul(browser, swaps) {
  const name = "a nav entry is never current by an older address holding a raw NUL, and is at the escaped one, by the server and the runtime alike";
  const context = await browser.newContext();
  const page = await context.newPage();
  const raw = "/smoke/nul/raw\u0000x";
  const escaped = "/smoke/nul/esc%00x";
  /** Each link to follow, with the marks of the section and the entry there. */
  const visits = [
    [raw, "page -"],
    [escaped, "- page"],
  ];
  /** The aria-current of the nav's section and entry links in one answer. */
  const marks = (/** @type {string} */ html) =>
    ["Nul", "Here"].map((label) => (new RegExp(`<a [^>]*aria-current="page"[^>]*>${label}</a>`).test(html) ? "page" : "-")).join(" ");
  /** @type {string[]} */
  const seen = [];
  /** Where each engine's own request for each link went. @type {string[]} */
  const reached = [];
  const drawn = await (await page.request.get(`${base}/smoke/nul/here`)).text();
  const written = drawn.match(/<a href="\/smoke\/nul\/here" data-nav data-nav-group="[0-9a-f]{8}(\+?)"(?: data-nav-also="([^"]*)")?/);
  if (written?.[1] !== "+" || written[2] !== escaped) seen.push(`server wrote group mark "${written?.[1]}" and paths "${written?.[2]}"`);
  // Each request an engine sends for the raw address, and the escaped one, outside the browser.
  for (const [href, expected] of [["/smoke/nul/raw%00x", "page -"], ["/smoke/nul/raw", "page -"], [escaped, "- page"]]) {
    const response = await page.request.get(new URL(href, base).href);
    const at = `${response.status()} ${marks(await response.text())}`;
    if (at !== `200 ${expected}`) seen.push(`server at ${href}: ${at}`);
  }
  /** Puts a link to `href` in the shell, beside unmarked copies of the nav's links; with `reload` the browser follows it with a full load. */
  const linkTo = (/** @type {string} */ href, /** @type {boolean} */ reload) =>
    page.evaluate(
      ([href, reload]) => {
        const nav = document.createElement("nav");
        nav.id = "nul-copy";
        for (const link of Array.from(document.querySelectorAll("main a[data-nav-group]"))) {
          const copy = /** @type {Element} */ (link.cloneNode(true));
          copy.removeAttribute("aria-current");
          nav.append(copy);
        }
        const to = document.createElement("a");
        to.id = "nul-visit";
        // As a stored link carries it: set as text, so a raw NUL stays one (the HTML parser would
        // make it U+FFFD).
        to.setAttribute("href", /** @type {string} */ (href));
        if (reload) to.setAttribute("data-reload", "");
        to.textContent = "Visit";
        document.querySelector("header")?.append(nav, to);
      },
      [href, reload],
    );
  for (const [href, expected] of visits) {
    // The browser's own request for the link, a full load.
    await page.goto(`${base}/smoke/nul/here`);
    await linkTo(href, true);
    const answer = page.waitForResponse((r) => r.request().isNavigationRequest() && r.request().frame() === page.mainFrame());
    await page.click("#nul-visit");
    const response = await answer;
    const path = new URL(response.url()).pathname;
    reached.push(path);
    const at = `${response.status()} ${marks(await response.text())}`;
    if (at !== `200 ${expected}`) seen.push(`server at the browser's request for ${JSON.stringify(href)} (${path}): ${at}`);
    await page.waitForLoadState();
  }
  if (!swaps) {
    check(name, seen.length === 0, seen.join("; ") || `server only, requests ${reached.join(" ")}: without swaps a client navigation loads the page in full`);
    skip(`${name} (runtime)`, "without the Navigation API the browser loads that page in full");
    await context.close();
    return;
  }
  for (const [href, expected] of visits) {
    await page.goto(`${base}/smoke/nul/here`);
    await linkTo(href, false);
    const before = await page.evaluate(() => location.pathname);
    await page.click("#nul-visit");
    await page.waitForFunction((before) => location.pathname !== before && document.title.startsWith("Nav nul"), before);
    await page.waitForFunction(() => !!document.querySelector("#nul-copy a[aria-current]"), null, { timeout: 5000 }).catch(() => {});
    const copies = await page.evaluate(() => Array.from(document.querySelectorAll("#nul-copy a")).map((link) => link.getAttribute("aria-current") ?? "-").join(" "));
    const at = await page.evaluate(() => location.pathname);
    reached.push(at);
    if (copies !== expected) seen.push(`runtime at ${at}: ${copies}`);
  }
  check(name, seen.length === 0, seen.join("; ") || `server and runtime marked the section at the raw address and the entry at the escaped one, at ${reached.join(" ")}`);
  await context.close();
}
