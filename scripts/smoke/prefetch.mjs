import { base, skip, check, precommits } from "./helpers.mjs";

export async function prefetch(swaps, page, navRequests, browser, errors, noteBorder, noSwaps) {
  // Swaps only: these links live in the shell, which a full page load replaces.
  if (swaps) {
    // data-nav="section": current on its page and every page under it. Of the links of one
    // data-nav-group (Req::nav_of), only the deepest that holds the page is current, wherever
    // they are: group "a" is split between a <nav> and an <aside>; group "b" is another nav.
    await page.evaluate(() => {
      document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a id="section-link" href="/" data-nav="section">All</a>'));
      document.querySelector("header")?.insertAdjacentHTML(
        "beforeend",
        __html('<nav><a id="group-all" href="/" data-nav="section" data-nav-group="a">All</a></nav>' +
          '<aside><a id="group-news" href="/news" data-nav data-nav-group="a">News</a></aside>' +
          '<nav><a id="other-all" href="/" data-nav="section" data-nav-group="b">All</a></nav>'),
      );
    });
    await page.click('header a[href="/"]:not(#section-link, #group-all, #other-all)');
    await page.waitForFunction(() => document.title === "Stocks | Watchlist");
    await page.click('header nav a[href="/news"]');
    await page.waitForFunction(() => document.title === "News | Watchlist");
    const marks = await page.evaluate(() =>
      ["section-link", "group-all", "group-news", "other-all"].map((id) => document.getElementById(id)?.getAttribute("aria-current") ?? "-").join(" "),
    );
    check(
      'data-nav="section" marks the link on pages under it',
      marks.startsWith("page ") && (await page.getAttribute('header a[href="/"]:not(#section-link, #group-all, #other-all)', "aria-current")) === null,
      marks,
    );
    check("in one data-nav-group only the deepest link that holds the page is current", marks === "page - page page", marks);
    await page.evaluate(() => {
      document.getElementById("section-link")?.remove();
      for (const id of ["group-all", "group-news", "other-all"]) document.getElementById(id)?.parentElement?.remove();
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
