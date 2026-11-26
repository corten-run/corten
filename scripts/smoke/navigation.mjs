import { base, swapped, shadowing, engine, skip, check, precommits, entriesWhileRecordingAddresses, pollFor } from "./helpers.mjs";

export async function sectionNavigation(feedSources, page, redirectName, openFeeds, holdWatch, abandoned, openStreams, swaps) {
  // The feed sources before the write: a write that swaps the page in brings the component a new one.
  const feedsBeforeGo = (await feedSources()).length;
  let goSwapped = false;
  if (!(await page.evaluate(() => "navigation" in window))) skip(redirectName, "without the Navigation API the browser loads that page in full");
  else {
    goSwapped = true;
    // Pressed and read in one task in the page, so the mark is read before the write's answer
    // can come back, however slowly the browser runs.
    const goBusy = await page.evaluate(() => {
      /** @type {HTMLButtonElement} */ (document.getElementById("busy-wgo")).click();
      return /** @type {any} */ (window).__goHeld.getAttribute("aria-busy");
    });
    // Settled within 5 s, a page that settles after them failing the check.
    const goSettled = !!(await pollFor(5000, () =>
      page.evaluate(() => !document.getElementById("busy-w") && /** @type {any} */ (window).__goHeld.getAttribute("aria-busy") !== "true" && !document.querySelector("main[aria-busy]")),
    ));
    const goAfter = await page.evaluate(() => ({
      held: /** @type {any} */ (window).__goHeld.getAttribute("aria-busy"),
      cleared: /** @type {any} */ (window).__goCleared ?? null,
      path: location.pathname,
      form: !!document.getElementById("busy-w"),
    }));
    check(redirectName, goSettled && goBusy === "true" && goAfter.held === null && goAfter.cleared?.pageIn === true && goAfter.path === "/" && !goAfter.form, JSON.stringify({ goSettled, goBusy, goAfter }));
  }
  await page.unroute("**/busy-write*");
  await page.evaluate(() => ["busy-w", "busy-w-said", "busy-wa", "busy-wb", "busy-wgo"].forEach((id) => document.getElementById(id)?.remove()));

  const current = () => page.$$eval("a[data-nav][aria-current=page]", (links) => links.map((l) => l.getAttribute("href")).join());
  check("the shell marks the current link", (await current()) === "/");
  // The sector links beside <main> are marked `page`: each navigation brings the page's.
  const sectors = () => page.$$eval("#sector-nav a", (links) => links.length);
  check("a layout element marked page is the page's: no sector links outside the news", (await sectors()) === 0);
  // When the page has just swapped back to /, its component may not have opened its feed yet and
  // the one it left may not be closed, so the state is awaited rather than read once (#1134): the
  // newest feed source open, every earlier one closed, and a new one if the page was swapped in.
  const oneFeed = await page
    .waitForFunction(
      (/** @type {number} */ min) => {
        const feeds = /** @type {EventSource[]} */ ((/** @type {any} */ (window)).__sources.filter((/** @type {EventSource} */ s) => s.url.includes("/feed/")));
        return feeds.length >= min && feeds.at(-1)?.readyState !== EventSource.CLOSED && feeds.slice(0, -1).every((s) => s.readyState === EventSource.CLOSED);
      },
      Math.max(1, feedsBeforeGo + (goSwapped ? 1 : 0)),
      { timeout: 5000 },
    )
    .then(() => true, () => false);
  check("one feed stream while the component is on the page", oneFeed, `${await openFeeds()} open of ${JSON.stringify(await feedSources())}, ${feedsBeforeGo} before the write, ${goSwapped ? "swapped in" : "not swapped"}`);
  // The news page's disclaimer is in an area (Area::components): its stylesheet loads before the page is
  // swapped in, so the note is styled the moment it joins the page.
  await page.evaluate(() => {
    new MutationObserver((_, observer) => {
      const note = document.querySelector(".disclaimer__note");
      if (!note) return;
      (/** @type {any} */ (window)).__noteBorder = getComputedStyle(note).borderInlineStartWidth;
      observer.disconnect();
    }).observe(document.body, { childList: true, subtree: true });
  });
  const noteBorder = () => page.$eval(".disclaimer__note", (note) => getComputedStyle(note).borderInlineStartWidth);
  const styleLinks = () => page.$$eval("link[data-corten-style]", (links) => links.length);
  check("a page outside the section does not link its stylesheet", (await styleLinks()) === 0);
  // A navigation abandons a pending submit, whose reply was for the page being left, and the
  // newer submit that waited for it. The first write is held until the page has gone and the
  // page has given it up, so the second press and the link meet it still out however slowly they
  // come; each press runs in the page and is counted, so a second press that sends nothing is
  // seen to have been made (#2014). The held write counts as given up only if it failed while it
  // was still held, within 5 s of the page's leaving; the listeners, the hold and the press count
  // go however the case ends.
  /** @param {import("@playwright/test").Request} r */
  const isWatchPost = (r) => r.method() === "POST" && r.url().endsWith("/watch");
  const stockOf = (/** @type {import("@playwright/test").Request} */ r) => new URLSearchParams(r.postData() ?? "").get("id");
  /** @type {(string | null)[]} */
  const posted = [];
  /** The writes that failed while the first was held, and after. @type {(string | null)[]} */
  const gaveUp = [];
  /** @type {(string | null)[]} */
  const failedAfter = [];
  let held = true;
  /** @param {import("@playwright/test").Request} r */
  const onPost = (r) => isWatchPost(r) && posted.push(stockOf(r));
  /** @param {import("@playwright/test").Request} r */
  const onGaveUp = (r) => isWatchPost(r) && (held ? gaveUp : failedAfter).push(stockOf(r));
  const pressWatch = () => page.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector("#watch-form button")).click());
  let releaseWatch = () => {};
  holdWatch.value = new Promise((resolve) => (releaseWatch = () => resolve(undefined)));
  let presses = 0;
  /** @type {string | null} */
  let first = null;
  let gaveUpInTime = false;
  /** What the case saw, read before its listeners go. */
  let seen = { posted: "", gaveUp: "", failedAfter: "" };
  page.on("request", onPost);
  page.on("requestfailed", onGaveUp);
  try {
    try {
      await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__watchPresses = 0;
        w.__watchPressCount = new AbortController();
        // Capturing on the window, so the submit is heard before any listener of the page's.
        window.addEventListener("submit", (e) => e.target === document.getElementById("watch-form") && (w.__watchPresses += 1), { capture: true, signal: w.__watchPressCount.signal });
      });
      // The first, of the stock the form shows, is out before the form changes.
      first = stockOf((await Promise.all([page.waitForRequest(isWatchPost, { timeout: 6000 }), pressWatch()]))[0]);
      await page.selectOption("select[name=id]", "NRTH");
      await pressWatch();
      presses = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__watchPressCount.abort();
        return /** @type {number} */ (w.__watchPresses);
      });
      await page.evaluate(() => /** @type {HTMLAnchorElement} */ (document.querySelector('header a[href="/news"]')).click());
      await page.waitForFunction(() => document.title === "News | Watchlist");
      // The page gives the held write up as it leaves (every engine reports it failed while the
      // route still holds it).
      gaveUpInTime = !!(await pollFor(5000, async () => gaveUp.length > 0));
    } finally {
      held = false;
      holdWatch.value = null;
      releaseWatch();
    }
    // Time in which a send the navigation must not let through would be seen.
    await page.waitForTimeout(1600);
    seen = { posted: posted.join(), gaveUp: gaveUp.join(), failedAfter: failedAfter.join() };
  } finally {
    page.off("request", onPost);
    page.off("requestfailed", onGaveUp);
    await page.evaluate(() => /** @type {any} */ (window).__watchPressCount?.abort()).catch(() => {});
  }
  check(
    "navigating away abandons a pending submit and the one that waited",
    presses === 2 && first !== null && first !== "NRTH" && abandoned.length === 1 && seen.posted === first && gaveUpInTime && seen.gaveUp === first && seen.failedAfter === "",
    `${abandoned.join()}; presses: ${presses}; posts: ${seen.posted}; given up while held: ${seen.gaveUp || (gaveUpInTime ? "" : "none within 5 s")}; failed after the release: ${seen.failedAfter || "none"}`,
  );
  check("the feed stream closes when its component leaves the page (its signal aborts)", (await openFeeds()) === 0);
  check("the <corten-live> stream closes when it leaves the page", (await openStreams("/live/trades")) === 0);
  check("client navigation moves aria-current in the shell", (await current()) === "/news");
  check("a navigation into the news brings the layout's sector links (marked page)", (await sectors()) === 5);
  check("main is not left busy", (await page.getAttribute("main", "aria-busy")) === null);
  check("client navigation swaps <main>", (await page.textContent("main h1")) === "Market news");
  if (swaps) {
    const border = await page.evaluate(() => (/** @type {any} */ (window)).__noteBorder);
    check("a section's stylesheet loads before its page is swapped in", border === "4px", border);
  } else {
    check("a section's page links its stylesheet", (await noteBorder()) === "4px" && (await styleLinks()) === 1);
  }
  if (swaps) check("client navigation keeps the page", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1));
  else check("without the Navigation API a link loads the whole page", await page.evaluate(() => (/** @type {any} */ (window)).__marker === undefined));
  check("navigation updates the URL", new URL(page.url()).pathname === "/news");
  return { sectors, styleLinks, noteBorder };
}

export async function redirects(browser, bug, page, live, sectors, swaps, styleLinks, noteBorder, noSwaps) {
  // A story's link, a route that redirects to a place on another site (`/news/{id}/read`,
  // `Elsewhere::at`): the runtime's fetch cannot follow it (connect-src, CORS), so the server names
  // the address and the browser goes there, in one request to the app and without a console error,
  // the hover's prefetch included.
  {
    const away = await browser.newPage();
    const awayErrors = [];
    away.on("console", (m) => m.type() === "error" && !bug(m.text()) && awayErrors.push(m.text()));
    away.on("pageerror", (e) => awayErrors.push(e.message));
    await away.route("https://news.example.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Elsewhere</title>" }));
    let asked = 0;
    away.on("request", (r) => new URL(r.url()).pathname === "/news/acme-outlook/read" && asked++);
    await away.goto(`${base}/news`);
    await away.hover(`main a[href="/news/acme-outlook/read"]`);
    await away.waitForTimeout(300);
    // The browser's request to the other site is what matters, not that site's load (WebKit does
    // not always hand a redirected navigation to the route above), so the click does not wait.
    // The request leaves out the place (`#guidance`), which only the browser's address keeps.
    const left = away.waitForRequest((r) => r.url() === "https://news.example.com/markets/acme-outlook", { timeout: 5000 }).then(() => true, () => false);
    await away.evaluate(() => /** @type {HTMLAnchorElement} */ (document.querySelector(`main a[href="/news/acme-outlook/read"]`)).click());
    const arrived = await left;
    check("a redirect to another site leaves the app in one request", arrived && asked === 1, `left ${arrived} requests ${asked}`);
    // The browser's address keeps the place.
    if (engine !== "webkit") {
      const placed = await away.waitForURL("https://news.example.com/markets/acme-outlook#guidance", { timeout: 5000 }).then(() => true, () => false);
      check("the address keeps the place on the other site", placed, away.url());
    } else skip("the address keeps the place on the other site", "WebKit does not always hand a redirected navigation to the route");
    check("without a console error", awayErrors.length === 0, awayErrors.join(" | "));
    await away.close();
  }

  await page.goBack();
  await page.waitForFunction(() => document.title === "Stocks | Watchlist");
  await page.waitForSelector(`${live}[data-status="live"]`, { timeout: 5000 }).catch(() => {});
  check("back navigation restores the watchlist and on:connect resubscribes", (await page.getAttribute(live, "data-status")) === "live");
  check("back out of the news empties the sector links", (await sectors()) === 0);
  if (swaps) {
    check("a section's stylesheet stays when the page leaves the section", (await styleLinks()) === 1);
    await page.goForward();
    await page.waitForFunction(() => document.title === "News | Watchlist");
    check("coming back into the section does not link its stylesheet twice", (await styleLinks()) === 1 && (await noteBorder()) === "4px");
    await page.goBack();
    await page.waitForFunction(() => document.title === "Stocks | Watchlist");
    await page.waitForSelector(`${live}[data-status="live"]`, { timeout: 5000 }).catch(() => {});
  } else {
    for (const name of ["a section's stylesheet stays when the page leaves the section", "coming back into the section does not link its stylesheet twice"]) skip(name, noSwaps);
  }
  // A link followed from the sector links, whose page draws them the same, leaves them in place.
  if (swaps) {
    const partPage = await (await browser.newContext()).newPage();
    await partPage.goto(`${base}/news`);
    await partPage.evaluate(() => ((/** @type {any} */ (document.querySelector("#sector-nav"))).__kept = 1));
    await partPage.focus("#sector-nav a:nth-child(2)");
    await partPage.keyboard.press("Enter");
    await partPage.waitForURL(/sector=energy/);
    await partPage.waitForFunction(() => document.querySelectorAll("#stories > li").length === 3 && !document.querySelector("main[aria-busy]"));
    const kept = await partPage.evaluate(() => (/** @type {any} */ (document.querySelector("#sector-nav")))?.__kept === 1);
    check("a part marked page that the next page draws the same is left in place", kept);
    await partPage.context().close();
    // The same when its links are nav links (`req.nav`) and the next page marks another one
    // current: the answers are rewritten so the sector links carry `data-nav`, and the second
    // page's marks its own sector's link, as the server marks a section's page.
    const navPage = await (await browser.newContext()).newPage();
    await navPage.route(/\/news(\?|$)/, async (r) => {
      // Uncompressed, so the rewrite reads text: Firefox asks for zstd, which route.fetch keeps.
      const res = await r.fetch({ headers: { ...r.request().headers(), "accept-encoding": "identity" } });
      const sector = new URL(r.request().url()).searchParams.get("sector");
      const body = (await res.text()).replace(/<a href="(\/news\?sector=[^"]*)"/g, (_, href) =>
        href === `/news?sector=${sector}` ? `<a href="${href}" data-nav aria-current="page"` : `<a href="${href}" data-nav`,
      );
      const headers = { ...res.headers() };
      delete headers["content-encoding"];
      delete headers["content-length"];
      await r.fulfill({ status: res.status(), headers, body });
    });
    await navPage.goto(`${base}/news`);
    await navPage.evaluate(() => ((/** @type {any} */ (document.querySelector("#sector-nav"))).__kept = 1));
    await navPage.click("#sector-nav a:nth-child(2)");
    await navPage.waitForURL(/sector=energy/);
    await navPage.waitForFunction(() => document.querySelectorAll("#stories > li").length === 3 && !document.querySelector("main[aria-busy]"));
    const navKept = await navPage.evaluate(() => (/** @type {any} */ (document.querySelector("#sector-nav")))?.__kept === 1);
    check("a part marked page whose nav links the next page marks differently is left in place", navKept);
    await navPage.context().close();
    // A part a write's page drew anew is what the next navigation compares with: the first load's
    // sector links carry a mark the server never draws again, so the write's page replaces them,
    // and a link that draws them the same then leaves them in place.
    const writePage = await (await browser.newContext()).newPage();
    let first = true;
    await writePage.route(/\/news$/, async (r) => {
      if (!first || r.request().method() !== "GET" || r.request().resourceType() !== "document") return r.continue();
      first = false;
      const res = await r.fetch({ headers: { ...r.request().headers(), "accept-encoding": "identity" } });
      const body = (await res.text()).replace('id="sector-nav"', 'id="sector-nav" data-first');
      const headers = { ...res.headers() };
      delete headers["content-encoding"];
      delete headers["content-length"];
      await r.fulfill({ status: res.status(), headers, body });
    });
    await writePage.goto(`${base}/news`);
    const marked = await writePage.evaluate(() => document.querySelector("#sector-nav")?.hasAttribute("data-first"));
    await writePage.evaluate(() => {
      // Gone if the write's page loaded in full rather than being drawn into this one.
      (/** @type {any} */ (window)).__noLoad = 1;
      /** @type {HTMLInputElement} */ (document.querySelector("#briefing [name=email]")).value = "part@example.com";
      /** @type {HTMLButtonElement} */ (document.querySelector("#briefing button")).click();
    });
    await writePage
      .waitForFunction(() => document.querySelector("#briefing [role=status]")?.textContent === "You're on the list for the morning briefing." && !document.querySelector("main[aria-busy]"), null, { timeout: 5000 })
      .catch(() => {});
    const redrawn = await writePage.evaluate(() => (/** @type {any} */ (window)).__noLoad === 1 && !document.querySelector("#sector-nav")?.hasAttribute("data-first"));
    await writePage.evaluate(() => ((/** @type {any} */ (document.querySelector("#sector-nav"))).__kept = 1));
    await writePage.click("#sector-nav a:nth-child(2)");
    await writePage.waitForURL(/sector=energy/);
    await writePage.waitForFunction(() => document.querySelectorAll("#stories > li").length === 3 && !document.querySelector("main[aria-busy]"));
    const writeKept = await writePage.evaluate(() => (/** @type {any} */ (document.querySelector("#sector-nav")))?.__kept === 1);
    check("a part a write's page drew anew is left in place by the next link that draws it the same", marked && redrawn && writeKept, `marked ${marked} redrawn ${redrawn} kept ${writeKept}`);
    await writePage.context().close();
  } else {
    skip("a part marked page that the next page draws the same is left in place", noSwaps);
    skip("a part marked page whose nav links the next page marks differently is left in place", noSwaps);
    skip("a part a write's page drew anew is left in place by the next link that draws it the same", noSwaps);
  }
}

export async function guardedNavigation(page, browser, bug) {
  // /account is guarded (Area::guard): signed out, a navigation there follows the redirect to the
  // watchlist, where the sign-in button is.
  await page.goto(`${base}/news`);
  // The formatter is a module of its own: the news page's handlers take no format, so it is not loaded.
  const formatLoaded = () => page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/corten-format.js")));
  check("a page whose handlers take no format does not load the format module", !(await formatLoaded()));
  // Nor the field module: none of its handlers takes a form field.
  check(
    "a page whose handlers take no form field does not load the field module",
    !(await page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/corten-field.js")))),
  );
  // A visitor's header has no account link (the sign-in button is in its place), so the page gets one.
  await page.evaluate(() => document.querySelector("main")?.insertAdjacentHTML("afterbegin", __html('<a id="to-account" href="/account">Account</a>')));
  const entriesBefore = await page.evaluate(entriesWhileRecordingAddresses);
  await page.click("#to-account");
  await page.waitForFunction(() => document.title === "Stocks | Watchlist", null, { timeout: 5000 }).catch(() => {});
  check(
    "a guarded page sends someone signed out to sign in",
    (await page.title()) === "Stocks | Watchlist" && new URL(page.url()).pathname === "/",
    page.url(),
  );
  // Where the address waits for the answer, a redirect's target is the only address the link
  // gives, in one new history entry, as a full load's redirect is (#992).
  if (await page.evaluate(precommits)) {
    // A page loaded in full in its place has no record: none, which fails the check.
    const [addresses, entries] = await page.evaluate(() => [/** @type {any} */ (window).__addresses ?? [], /** @type {any} */ (window).navigation.entries().length]);
    check(
      "a link the server redirects shows only the redirect's address, in one history entry",
      addresses.join() === "/news,/" && entries === entriesBefore + 1,
      `${addresses.join(" -> ")}, ${entriesBefore} -> ${entries} entries`,
    );
    // The same for a link the server sends to a place on a page (`corten-location`, which `fetch`
    // cannot follow with its `#id`): the place's address alone, with its `#id`, in one new entry.
    const placed = await (await browser.newContext()).newPage();
    /** @type {string[]} */
    const placedErrors = [];
    placed.on("console", (m) => m.type() === "error" && !bug(m.text()) && placedErrors.push(m.text()));
    placed.on("pageerror", (e) => placedErrors.push(e.message));
    await placed.route(
      (url) => url.pathname === "/to-briefing",
      (route) => (route.request().headers().corten ? route.fulfill({ status: 204, headers: { "corten-location": "/news#briefing" } }) : route.fallback()),
    );
    await placed.goto(`${base}/alerts`);
    await placed.evaluate(() => document.querySelector("main")?.insertAdjacentHTML("afterbegin", __html('<a id="to-briefing" href="/to-briefing">Briefing</a>')));
    const placedBefore = await placed.evaluate(entriesWhileRecordingAddresses);
    await placed.click("#to-briefing");
    await placed.waitForFunction(() => document.title === "News | Watchlist" && !document.querySelector("[aria-busy]"), null, { timeout: 5000 }).catch(() => {});
    const [placedAddresses, placedEntries, hash, busy] = await placed.evaluate(() => [
      /** @type {any} */ (window).__addresses ?? [],
      /** @type {any} */ (window).navigation.entries().length,
      location.hash,
      document.querySelectorAll("[aria-busy]").length,
    ]);
    // The link's navigation is left for the place's before its address changes: it ends quietly,
    // with nothing left busy.
    check(
      "a link the server sends to a place shows only the place's address, in one history entry",
      placedAddresses.join() === "/alerts,/news" && hash === "#briefing" && placedEntries === placedBefore + 1 && busy === 0 && placedErrors.length === 0,
      `${placedAddresses.join(" -> ")}${hash}, ${placedBefore} -> ${placedEntries} entries, ${busy} busy, errors: ${placedErrors.join(" | ")}`,
    );
    await placed.context().close();
  } else {
    const why = "no precommitHandler: the address changes at the click";
    skip("a link the server redirects shows only the redirect's address, in one history entry", why);
    skip("a link the server sends to a place shows only the place's address, in one history entry", why);
  }
  return { formatLoaded };
}

export async function shellChanges(prices, page, formatLoaded, signsIn, swaps, noSwaps) {
  // The watchlist's live prices take the money format: reached from the news page, it loads the
  // module before its markup joins, and the script writes prices with it.
  const firstPrices = await prices();
  await page.waitForFunction((first) => JSON.stringify(Array.from(document.querySelectorAll('[data-ref="price"]'), (c) => c.textContent)) !== first, JSON.stringify(firstPrices), { timeout: 5000 }).catch(() => {});
  const written = await prices();
  check(
    "a page reached from one without formats loads the module and its script writes with it",
    (await formatLoaded()) && JSON.stringify(written) !== JSON.stringify(firstPrices) && written.every((p) => /^\$[\d,]+\.\d\d$/.test(p ?? "")),
    `${firstPrices.join(", ")} -> ${written.join(", ")}`,
  );

  // Signing in changes the shell's context, so the redirect loads the whole document.
  if (signsIn) {
    await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 2));
    await page.click("header form[data-patch] button");
    await page.waitForFunction(() => document.querySelector("#viewer-badge")?.textContent?.trim() === "Ada", null, { timeout: 5000 }).catch(() => {});
    check("signing in shows the viewer in the shell", ((await page.textContent("#viewer-badge")) ?? "").trim() === "Ada");
    check("a new shell context loads the whole document", await page.evaluate(() => (/** @type {any} */ (window)).__marker === undefined));
    await page.click('header a[href="/account"]');
    await page.waitForFunction(() => document.title === "Account | Watchlist", null, { timeout: 5000 }).catch(() => {});
    check("a guarded page opens for someone signed in", ((await page.textContent("main")) ?? "").includes("Signed in as Ada."));
  } else {
    skip("signing in shows the viewer in the shell", "the browser does not send Secure cookies over http");
    skip("a guarded page opens for someone signed in", "the browser does not send Secure cookies over http");
  }
  await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 3));
  await page.click('header a[href="/news"]');
  await page.waitForFunction(() => document.title === "News | Watchlist");
  if (swaps) check("same context: navigation swaps again", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 3));
  else skip("same context: navigation swaps again", noSwaps);

  // A patch into an element the server drew in the layout (the viewer's badge, by its id) is kept
  // as the server's markup with the patch applied: a write's page that draws what the patch drew
  // leaves the header as it is, and one that draws otherwise draws the badge again.
  const copyChecks = [
    "a write's page that draws what a patch drew in the layout leaves the element as it is",
    "a write's page that draws otherwise than a patch drew in the layout draws it again",
  ];
  if (signsIn && swaps) {
    /** @param {boolean} more Whether the patch draws more than the server does. */
    const writeAfter = async (more) => {
      await page.evaluate(async (more) => {
        const badge = /** @type {Element} */ (document.getElementById("viewer-badge")).cloneNode(true);
        if (more) badge.appendChild(document.createTextNode(" (patched)"));
        const corten = /** @type {typeof import("../crates/corten/js/corten.js")} */ (await import(/** @type {string} */ ("corten")));
        await corten.patch(__html(/** @type {Element} */ (badge).outerHTML));
      }, more);
      await page.evaluate(() => {
        scrollTo(0, 0);
        (/** @type {any} */ (window)).__marker = 5;
        (/** @type {any} */ (document.querySelector("header"))).__same = 1;
      });
      const page_ = page.waitForResponse((r) => new URL(r.url()).pathname === "/news" && r.request().method() === "GET" && !swapped(r.request()), { timeout: 5000 });
      await page.evaluate(() => {
        /** @type {HTMLInputElement} */ (document.querySelector("#briefing [name=email]")).value = "ada@example.com";
        /** @type {HTMLButtonElement} */ (document.querySelector("#briefing button")).click();
      });
      const came = await page_.then(() => true, () => false);
      await page.waitForFunction(() => location.hash === "#briefing" && !document.querySelector("main[aria-busy]"), null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(200);
      return {
        came,
        ...(await page.evaluate(() => ({
          marker: (/** @type {any} */ (window)).__marker,
          same: (/** @type {any} */ (document.querySelector("header"))).__same === 1,
          badge: document.getElementById("viewer-badge")?.textContent?.trim(),
        }))),
      };
    };
    // The patch draws the badge as the server does.
    const kept = await writeAfter(false);
    check(copyChecks[0], kept.came && kept.marker === 5 && kept.same && kept.badge === "Ada", JSON.stringify(kept));
    // The patch draws more than the server does, so the write's page puts the server's back.
    const redrawn = await writeAfter(true);
    check(copyChecks[1], redrawn.came && redrawn.marker === 5 && redrawn.badge === "Ada", JSON.stringify(redrawn));
  } else for (const name of copyChecks) skip(name, swaps ? "the browser does not send Secure cookies over http" : noSwaps);
}

export async function navigationMarks(page) {
  // A nav link a patch puts on the page is marked against the page, not the request that made
  // the patch (#347): the server marked "elsewhere" (the form's action) and not this page.
  await page.evaluate(() => document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="nav-part"></div>')));
  const patchedMarks = await page.evaluate(async () => {
    const { patch } = await import("corten");
    const here = location.pathname;
    await patch(__html(`<div id="nav-part"><a id="patched-here" href="${here}" data-nav>Here</a><a id="patched-there" href="/elsewhere" data-nav aria-current="page">There</a></div>`));
    // Appended (`Append`) as well as replaced.
    await patch(__html(`<template id="nav-part" data-append><a id="appended-here" href="${here}" data-nav>Here</a></template>`));
    const marks = ["patched-here", "patched-there", "appended-here"].map((id) => document.getElementById(id)?.getAttribute("aria-current") ?? "-").join(" ");
    // A group (Req::nav_of) whose deepest link a patch removes: the section at "/" takes the mark.
    await patch(
      __html(`<div id="nav-part"><a id="group-root" href="/" data-nav="section" data-nav-group="p">All</a><span id="group-deep"><a href="${here}" data-nav data-nav-group="p">Here</a></span></div>`),
    );
    const root = () => document.getElementById("group-root")?.getAttribute("aria-current") ?? "-";
    const before = root();
    await patch(__html('<template id="group-deep" data-remove></template>'));
    const after = root();
    document.getElementById("nav-part")?.remove();
    return { marks, root: `${before} -> ${after}`, here };
  });
  check("a nav link a patch puts on the page is marked against the page", patchedMarks.marks === "page - page", patchedMarks.marks);
  check(
    "a patch that removes a group's current link marks the next deepest",
    patchedMarks.root === (patchedMarks.here === "/" ? "page -> page" : "- -> page"),
    `${patchedMarks.root} on ${patchedMarks.here}`,
  );
}

export async function currentLinks(browser, swaps, noSwaps) {
  // A current nav link is brought into view in the box that scrolls it (a nav row wider than the
  // bar), never by scrolling the page: on a full load at a fragment, and when a client navigation
  // makes another link current; a link that stays current is left where the row was scrolled.
  // The header's nav is made a narrow row that scrolls, with links ahead of the real ones, before
  // the runtime starts.
  {
    const rowPage = await (await browser.newContext({ viewport: { width: 800, height: 400 } })).newPage();
    await rowPage.addInitScript(() => {
      new MutationObserver((_, seen) => {
        const nav = /** @type {HTMLElement | null} */ (document.querySelector("header nav"));
        if (!nav) return;
        seen.disconnect();
        Object.assign(nav.style, { display: "flex", flexWrap: "nowrap", overflowX: "auto", width: "12rem", whiteSpace: "nowrap" });
        for (let i = 8; i >= 1; i--) {
          const a = document.createElement("a");
          a.href = `/filler-${i}`;
          a.setAttribute("data-nav", "");
          a.textContent = `Filler ${i}`;
          a.style.paddingInline = "1rem";
          nav.prepend(a);
        }
      }).observe(document, { childList: true, subtree: true });
    });
    const drawn = () => rowPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const shown = () =>
      rowPage.evaluate(() => {
        const nav = /** @type {HTMLElement} */ (document.querySelector("header nav"));
        const link = /** @type {HTMLElement} */ (nav.querySelector('[aria-current="page"]'));
        const [box, at] = [nav.getBoundingClientRect(), link.getBoundingClientRect()];
        const target = document.getElementById("briefing")?.getBoundingClientRect();
        return {
          href: link.getAttribute("href"),
          inside: at.left >= box.left - 0.5 && at.right <= box.right + 0.5,
          scrolled: Math.round(nav.scrollLeft),
          sideways: nav.scrollWidth > nav.clientWidth,
          // The fragment's target is still where the load put it.
          target: target ? Math.round(target.top) >= 0 && target.top < innerHeight : null,
          page: Math.round(scrollY),
        };
      });
    await rowPage.goto(`${base}/news#briefing`);
    await drawn();
    const loaded = await shown();
    check(
      "a full load brings the current nav link into the row that scrolls it, not the page to the header",
      loaded.href === "/news" && loaded.inside && loaded.scrolled > 0 && loaded.sideways && loaded.target === true,
      JSON.stringify(loaded),
    );
    if (swaps) {
      await rowPage.evaluate(() => /** @type {HTMLElement} */ (document.querySelector("header nav")).scrollTo({ left: 0, behavior: "instant" }));
      await rowPage.evaluate(() => (/** @type {any} */ (window)).navigation.navigate("/"));
      await rowPage.waitForFunction(() => document.title === "Stocks | Watchlist");
      await drawn();
      const moved = await shown();
      check("a client navigation brings the link it makes current into the row's view", moved.href === "/" && moved.inside && moved.scrolled > 0, JSON.stringify(moved));
      await rowPage.evaluate(() => /** @type {HTMLElement} */ (document.querySelector("header nav")).scrollTo({ left: 0, behavior: "instant" }));
      await rowPage.evaluate(() => (/** @type {any} */ (window)).navigation.navigate("/?again=1"));
      await rowPage.waitForFunction(() => location.search === "?again=1" && document.querySelector("main")?.getAttribute("aria-busy") === null);
      await drawn();
      const stayed = await shown();
      check("a link that stays current is left where the row was scrolled", stayed.href === "/" && stayed.scrolled === 0, JSON.stringify(stayed));
    } else {
      skip("a client navigation brings the link it makes current into the row's view", noSwaps);
      skip("a link that stays current is left where the row was scrolled", noSwaps);
    }
    await rowPage.context().close();
    // A row a write's page draws again comes with its current link marked by the server, and that
    // link is brought into view too. The row is made narrow by a stylesheet the page adopts, which
    // the new header keeps; the write's page draws another brand, so the header is drawn again.
    if (swaps) {
      const redrawPage = await (await browser.newContext({ viewport: { width: 800, height: 400 } })).newPage();
      await redrawPage.goto(`${base}/news#briefing`);
      await redrawPage.evaluate(() => {
        const sheet = new CSSStyleSheet();
        // Important, since the nav's own utility classes outrank an element selector.
        sheet.replaceSync(
          "header nav { display: flex !important; flex-wrap: nowrap !important; overflow-x: auto !important; width: 8rem !important; white-space: nowrap !important } header nav a { padding-inline: 2rem !important }",
        );
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      await redrawPage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          if (route.request().method() !== "GET" || swapped(route.request())) return route.fallback();
          // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          await route.fulfill({ status: res.status(), headers, body: (await res.text()).replace(">Watchlist</span>", ">Watchlist, row</span>") });
        },
      );
      const before = await redrawPage.evaluate(() => {
        const nav = /** @type {HTMLElement} */ (document.querySelector("header nav"));
        nav.scrollTo({ left: 0, behavior: "instant" });
        (/** @type {any} */ (nav)).__old = 1;
        return nav.scrollWidth > nav.clientWidth;
      });
      await redrawPage.evaluate(() => {
        /** @type {HTMLInputElement} */ (document.querySelector("#briefing [name=email]")).value = "ada@example.com";
        /** @type {HTMLButtonElement} */ (document.querySelector("#briefing button")).click();
      });
      const drawnAgain = await redrawPage
        .waitForFunction(() => document.querySelector("header span")?.textContent === "Watchlist, row" && !document.querySelector("main[aria-busy]"), null, { timeout: 5000 })
        .then(() => true, () => false);
      await redrawPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const redrawn = await redrawPage.evaluate(() => {
        const nav = /** @type {HTMLElement} */ (document.querySelector("header nav"));
        const link = /** @type {HTMLElement} */ (nav.querySelector('[aria-current="page"]'));
        const [box, at] = [nav.getBoundingClientRect(), link.getBoundingClientRect()];
        return { href: link.getAttribute("href"), fresh: (/** @type {any} */ (nav)).__old !== 1, inside: at.left >= box.left - 0.5 && at.right <= box.right + 0.5, scrolled: Math.round(nav.scrollLeft) };
      });
      check(
        "a nav row a write's page draws again brings its current link into the row's view",
        before && drawnAgain && redrawn.href === "/news" && redrawn.fresh && redrawn.inside && redrawn.scrolled > 0,
        JSON.stringify({ before, drawnAgain, redrawn }),
      );
      await redrawPage.context().close();
    } else skip("a nav row a write's page draws again brings its current link into the row's view", noSwaps);
    // A live region around <main> that is a form with controls named after the members the runtime
    // reads on it: a write's page draws its new text into it, the form kept.
    if (swaps) {
      const layoutPage = await (await browser.newContext()).newPage();
      /** @type {string[]} */
      const layoutErrors = [];
      layoutPage.on("pageerror", (e) => layoutErrors.push(e.message));
      const controls = shadowing.map((name) => `<input type="hidden" name="${name}" value="x" disabled>`).join("");
      let drawnTimes = 0;
      await layoutPage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          if (route.request().method() !== "GET" || swapped(route.request())) return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          // An attribute that changes on each draw, so the region's attributes are set and removed
          // (through Element's own: the form's controls shadow setAttribute and removeAttribute).
          const drawn = drawnTimes++;
          const form = `<form id="smoke-layout-form" role="status" data-drawn="${drawn}"${drawn ? "" : " data-first"}>${controls}<span>Drawn ${drawn}</span></form>`;
          await route.fulfill({ status: res.status(), headers, body: (await res.text()).replace(/(<header\b[^>]*>)/, `$1${form}`) });
        },
      );
      await layoutPage.goto(`${base}/news#briefing`);
      await layoutPage.evaluate(() => {
        (/** @type {any} */ (document.getElementById("smoke-layout-form"))).__old = 1;
        /** @type {HTMLInputElement} */ (document.querySelector("#briefing [name=email]")).value = "ada@example.com";
        /** @type {HTMLButtonElement} */ (document.querySelector("#briefing button")).click();
      });
      const layoutDrawn = await layoutPage
        .waitForFunction(() => document.querySelector("#smoke-layout-form span")?.textContent === "Drawn 1" && !document.querySelector("main[aria-busy]"), null, { timeout: 5000 })
        .then(() => true, () => false);
      const layoutKept = await layoutPage.evaluate(() => {
        const form = document.getElementById("smoke-layout-form");
        const own = Element.prototype;
        return (/** @type {any} */ (form))?.__old === 1 && own.getAttribute.call(form, "data-drawn") === "1" && !own.hasAttribute.call(form, "data-first");
      });
      check(
        "a write's page draws its text into a live region around <main> that is a form with controls named after the members the runtime reads on it",
        layoutDrawn && layoutKept && !layoutErrors.length,
        JSON.stringify({ layoutDrawn, layoutKept, layoutErrors }),
      );
      await layoutPage.context().close();
    } else skip("a write's page draws its text into a live region around <main> that is a form with controls named after the members the runtime reads on it", noSwaps);
    // A waiting part (`ReadAgain::now`) in a live region around <main>, which a write's page draws
    // in place (its new children into the region on screen): read once the write's page is drawn,
    // and once a read again that leaves <main> as it was draws it there (#1400).
    const liveNames = [
      "a waiting part a write's page draws into a live region around <main> is read",
      "a waiting part a read again draws into a live region around <main>, the page as it was, is read",
    ];
    if (swaps) {
      const livePage = await (await browser.newContext()).newPage();
      let liveDrawn = 0;
      let liveReads = 0;
      // What each whole page draws in the region, by its turn: idle, the part waiting, then the
      // page asking to be read again with the region calm, then the part waiting in that read.
      const regionOf = (/** @type {number} */ n) =>
        n === 1 || n >= 3 ? '<span id="live-part">Waiting<template data-corten-read-now data-from="/smoke/live-part"></template></span>' : n === 2 ? "<span>Calm</span>" : "<span>Idle</span>";
      await livePage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          if (route.request().method() !== "GET" || swapped(route.request())) return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const n = liveDrawn++;
          let body = (await res.text()).replace(/(<header\b[^>]*>)/, `$1<p id="live-region" role="status">${regionOf(n)}</p>`);
          if (n >= 2) body = body.replace("</title>", '</title><noscript data-corten-read-again="1" data-corten-head><meta http-equiv="refresh" content="1"></noscript>');
          await route.fulfill({ status: res.status(), headers, body });
        },
      );
      await livePage.route("**/smoke/live-part", (route) => {
        liveReads++;
        return route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: `<span id="live-part">Live part drawn ${liveReads}</span>` });
      });
      await livePage.goto(`${base}/news#briefing`);
      const thankLive = () =>
        livePage.evaluate(() => {
          /** @type {HTMLInputElement} */ (document.querySelector("#briefing [name=email]")).value = "ada@example.com";
          /** @type {HTMLButtonElement} */ (document.querySelector("#briefing button")).click();
        });
      const liveText = () => livePage.evaluate(() => document.getElementById("live-region")?.textContent ?? "");
      await thankLive();
      const written = await livePage
        .waitForFunction(() => document.getElementById("live-part")?.textContent?.startsWith("Live part drawn"), null, { timeout: 5000 })
        .then(() => true, () => false);
      check(liveNames[0], written && liveReads === 1, JSON.stringify({ drawn: liveDrawn, reads: liveReads, text: await liveText() }));
      // A second write, whose page asks to be read again with the region calm; its read again keeps
      // <main> and draws the part waiting in the region.
      await thankLive();
      await livePage.waitForFunction(() => document.getElementById("live-region")?.textContent === "Calm", null, { timeout: 5000 }).catch(() => {});
      const marked = await livePage.evaluate(() => {
        const first = document.querySelector("main")?.firstElementChild;
        if (first) (/** @type {any} */ (first)).__same = 1;
        return !!first;
      });
      const readIn = await livePage
        // Each read again after it draws the part waiting again, as the server sends it: any of
        // those reads drawn is the read in.
        .waitForFunction(() => /^Live part drawn [2-9]/.test(document.getElementById("live-part")?.textContent ?? ""), null, { timeout: 6000 })
        .then(() => true, () => false);
      const kept = await livePage.evaluate(() => (/** @type {any} */ (document.querySelector("main")?.firstElementChild))?.__same === 1);
      check(liveNames[1], marked && readIn && kept, JSON.stringify({ drawn: liveDrawn, reads: liveReads, kept, text: await liveText() }));
      await livePage.unrouteAll({ behavior: "ignoreErrors" });
      await livePage.context().close();
    } else for (const name of liveNames) skip(name, noSwaps);
    // A waiting part that is itself a live region around <main>, kept and drawn again in place by a
    // write's page with a new tag while its first read is held: the new tag is read, the first read
    // is cancelled, and its answer, let through later, is not drawn over the newer one. Beside it in a
    // kept element, a part the page draws as it was keeps its read on its way (not read twice), and
    // one whose read failed stays failed (not read again); and so does a part whose own attributes
    // the page changes, its tag kept, which keeps its marks: busy while its read is held, or failed.
    // A tag kept with another address is read at it: its old read, held, is cancelled and its answer
    // not drawn, and an old read that failed does not stop the new address's (#1400).
    const keptNames = [
      "a part that is a live region kept in place reads its new tag, and its first read is cancelled and not drawn",
      "a part a write's page draws as it was in a kept element keeps its read on its way, not read twice",
      "a part a write's page draws as it was in a kept element stays failed, not read again",
      "a part whose own attributes a write's page changes in a kept element, its tag kept, stays busy while its read is on its way, not read twice",
      "a part whose own attributes a write's page changes in a kept element, its tag kept, stays failed, not read again",
      "a part whose tag a write's page keeps with another address reads the new address, and its old read is cancelled and not drawn",
      "a part whose read failed is read at the new address a write's page keeps its tag with",
    ];
    if (swaps) {
      const keptPage = await (await browser.newContext()).newPage();
      let keptTurn = 0;
      /** @type {Record<string, number>} */
      const keptReads = {
        "region-old": 0,
        "region-new": 0,
        "kept-held": 0,
        "kept-failed": 0,
        "turn-held": 0,
        "turn-failed": 0,
        "moved-one": 0,
        "moved-two": 0,
        "refail-one": 0,
        "refail-two": 0,
      };
      /** @type {((value?: unknown) => void)[]} */
      const releases = [];
      let oldCancelled = false;
      let movedCancelled = false;
      keptPage.on("requestfailed", (r) => r.url().endsWith("/smoke/region-old") && (oldCancelled = true));
      keptPage.on("requestfailed", (r) => r.url().endsWith("/smoke/moved-one") && (movedCancelled = true));
      const tagOf = (/** @type {string} */ from) => `<template data-corten-read-now data-from="/smoke/${from}"></template>`;
      await keptPage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          if (route.request().method() !== "GET" || swapped(route.request())) return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const n = keptTurn++;
          const box =
            `<div id="kept-box"><p role="status">Turn ${n}</p><span id="kept-held">Waiting${tagOf("kept-held")}</span><span id="kept-failed">Waiting${tagOf("kept-failed")}</span>` +
            `<span id="turn-held" data-turn="${n}">Waiting${tagOf("turn-held")}</span><span id="turn-failed" data-turn="${n}">Waiting${tagOf("turn-failed")}</span>` +
            `<span id="kept-moved">Waiting${tagOf(n ? "moved-two" : "moved-one")}</span><span id="kept-refail">Waiting${tagOf(n ? "refail-two" : "refail-one")}</span></div>` +
            `<p id="slow-region" role="status">Waiting ${n}${tagOf(n ? "region-new" : "region-old")}</p>`;
          // The page draws parts in its layout, so its head preloads the part module, marked, as the
          // server writes it for such a page.
          const body = (await res.text())
            .replace(/(<header\b[^>]*>)/, `$1${box}`)
            .replace(/(<script type="module" src="([^"]*\/)corten\.js"><\/script>)/, '$1<link rel="modulepreload" href="$2part.js" data-corten-part>');
          await route.fulfill({ status: res.status(), headers, body });
        },
      );
      await keptPage.route("**/smoke/*", async (route) => {
        const name = new URL(route.request().url()).pathname.slice("/smoke/".length);
        if (!(name in keptReads)) return route.fallback();
        keptReads[name] = (keptReads[name] ?? 0) + 1;
        const patch = (/** @type {string} */ body) =>
          route.fulfill({ status: 200, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body }).catch(() => {});
        if (name === "kept-failed" || name === "turn-failed" || name === "refail-one") return route.fulfill({ status: 500, body: "" });
        if (name === "region-new") return patch('<p id="slow-region" role="status">New answer</p>');
        if (name === "moved-two") return patch('<span id="kept-moved">Moved two answer</span>');
        if (name === "refail-two") return patch('<span id="kept-refail">Refail two answer</span>');
        await new Promise((resolve) => releases.push(resolve));
        if (name === "turn-held") return patch('<span id="turn-held">Turn held answer</span>');
        if (name === "moved-one") return patch('<span id="kept-moved">Moved one answer</span>');
        return patch(name === "kept-held" ? '<span id="kept-held">Held answer</span>' : '<p id="slow-region" role="status">Old answer</p>');
      });
      await keptPage.goto(`${base}/news#briefing`);
      await keptPage.waitForSelector("#kept-failed[data-corten-read-failed]", { state: "attached", timeout: 5000 }).catch(() => {});
      await keptPage.waitForSelector("#turn-failed[data-corten-read-failed]", { state: "attached", timeout: 5000 }).catch(() => {});
      await keptPage.waitForSelector("#kept-refail[data-corten-read-failed]", { state: "attached", timeout: 5000 }).catch(() => {});
      const heldFirst = () => keptReads["region-old"] === 0 || keptReads["kept-held"] === 0 || keptReads["turn-held"] === 0 || keptReads["moved-one"] === 0;
      for (let waited = 0; heldFirst() && waited < 5000; waited += 100) await keptPage.waitForTimeout(100);
      await keptPage.evaluate(() => {
        /** @type {HTMLInputElement} */ (document.querySelector("#briefing [name=email]")).value = "ada@example.com";
        /** @type {HTMLButtonElement} */ (document.querySelector("#briefing button")).click();
      });
      await keptPage.waitForFunction(() => document.getElementById("slow-region")?.textContent === "New answer", null, { timeout: 5000 }).catch(() => {});
      await keptPage.waitForFunction(() => document.getElementById("kept-moved")?.textContent === "Moved two answer", null, { timeout: 5000 }).catch(() => {});
      const turned = await keptPage.evaluate(() => document.querySelector("#kept-box p")?.textContent ?? "");
      // The parts whose attributes the write's page changed, before the held reads are let through.
      await keptPage.waitForTimeout(300);
      const turnedParts = await keptPage.evaluate(() => {
        const at = (/** @type {string} */ id) => document.getElementById(id);
        return {
          turn: at("turn-held")?.getAttribute("data-turn"),
          heldBusy: at("turn-held")?.getAttribute("aria-busy") ?? null,
          failedMark: at("turn-failed")?.getAttribute("data-corten-read-failed") ?? null,
          failedTurn: at("turn-failed")?.getAttribute("data-turn"),
        };
      });
      // Let the held reads through: the first region read's answer comes too late to be drawn.
      for (const release of releases.splice(0)) release();
      await keptPage.waitForTimeout(500);
      const kept = await keptPage.evaluate(() => {
        const at = (/** @type {string} */ id) => document.getElementById(id);
        const region = at("slow-region");
        return {
          region: region?.textContent,
          regionBusy: region?.getAttribute("aria-busy") ?? null,
          regionFailed: region?.getAttribute("data-corten-read-failed") ?? null,
          held: at("kept-held")?.textContent,
          failed: at("kept-failed")?.getAttribute("data-corten-read-failed") ?? null,
          failedText: at("kept-failed")?.textContent,
          turnHeld: at("turn-held")?.textContent,
          turnFailed: at("turn-failed")?.getAttribute("data-corten-read-failed") ?? null,
          moved: at("kept-moved")?.textContent,
          movedBusy: at("kept-moved")?.getAttribute("aria-busy") ?? null,
          movedFailed: at("kept-moved")?.getAttribute("data-corten-read-failed") ?? null,
          refail: at("kept-refail")?.textContent,
          refailFailed: at("kept-refail")?.getAttribute("data-corten-read-failed") ?? null,
        };
      });
      const keptSaw = JSON.stringify({ ...kept, turned, turnedParts, reads: keptReads, oldCancelled, movedCancelled });
      check(
        keptNames[0],
        turned === "Turn 1" && kept.region === "New answer" && kept.regionBusy === null && kept.regionFailed === null && keptReads["region-new"] === 1 && oldCancelled,
        keptSaw,
      );
      check(keptNames[1], turned === "Turn 1" && keptReads["kept-held"] === 1 && kept.held === "Held answer", keptSaw);
      check(keptNames[2], turned === "Turn 1" && keptReads["kept-failed"] === 1 && kept.failed === "" && kept.failedText === "Waiting", keptSaw);
      check(
        keptNames[3],
        turnedParts.turn === "1" && turnedParts.heldBusy === "true" && keptReads["turn-held"] === 1 && kept.turnHeld === "Turn held answer",
        keptSaw,
      );
      check(keptNames[4], turnedParts.failedTurn === "1" && turnedParts.failedMark === "" && keptReads["turn-failed"] === 1 && kept.turnFailed === "", keptSaw);
      check(
        keptNames[5],
        turned === "Turn 1" &&
          kept.moved === "Moved two answer" &&
          kept.movedBusy === null &&
          kept.movedFailed === null &&
          keptReads["moved-one"] === 1 &&
          keptReads["moved-two"] === 1 &&
          movedCancelled,
        keptSaw,
      );
      check(
        keptNames[6],
        turned === "Turn 1" && kept.refail === "Refail two answer" && kept.refailFailed === null && keptReads["refail-one"] === 1 && keptReads["refail-two"] === 1,
        keptSaw,
      );
      await keptPage.unrouteAll({ behavior: "ignoreErrors" });
      await keptPage.context().close();
    } else for (const name of keptNames) skip(name, noSwaps);
    // A swap that keeps the user's place (data-keep-place) puts back a row in <main> where the user
    // scrolled it, and its current link is left there, out of view. The row is put in <main> on its
    // way from the server, its current link first.
    if (swaps) {
      const keptPage = await (await browser.newContext({ viewport: { width: 800, height: 400 } })).newPage();
      await keptPage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          // Marked current as the server marks a req.nav link.
          const row = `<nav id="tab-row"><a href="/news" data-nav aria-current="page">News</a>${Array.from({ length: 8 }, (_, i) => `<a href="/tab-${i}" data-nav>Tab ${i}</a>`).join("")}</nav>`;
          // A full page has <main>; the runtime's navigation answer is what goes in it, its head tags first.
          const body = await res.text();
          await route.fulfill({ status: res.status(), headers, body: /<main\b/.test(body) ? body.replace(/(<main\b[^>]*>)/, `$1${row}`) : body.replace("<div", `${row}<div`) });
        },
      );
      await keptPage.goto(`${base}/news`);
      await keptPage.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("#tab-row { display: flex !important; overflow-x: auto !important; width: 8rem !important; white-space: nowrap !important } #tab-row a { padding-inline: 2rem !important }");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      const settled = () => keptPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await settled();
      // The user scrolls the row to its end, past its current link.
      await keptPage.evaluate(() => {
        const row = /** @type {HTMLElement} */ (document.getElementById("tab-row"));
        row.scrollTo({ left: row.scrollWidth, behavior: "instant" });
      });
      await settled();
      const before = await keptPage.evaluate(() => Math.round(/** @type {HTMLElement} */ (document.getElementById("tab-row")).scrollLeft));
      await keptPage.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]")).click());
      const swapped = await keptPage
        .waitForFunction(() => location.search === "?mine=on" && document.getElementById("stories-title")?.textContent === "Stories about your stocks", null, { timeout: 5000 })
        .then(() => true, () => false);
      await settled();
      const after = await keptPage.evaluate(() => {
        const row = /** @type {HTMLElement} */ (document.getElementById("tab-row"));
        const current = row.querySelector('[aria-current="page"]')?.getAttribute("href");
        return { left: Math.round(row.scrollLeft), current };
      });
      check(
        "a swap that keeps the user's place leaves a row in <main> where the user scrolled it",
        before > 0 && swapped && after.current === "/news" && Math.abs(after.left - before) <= 1,
        JSON.stringify({ before, swapped, after }),
      );
      await keptPage.context().close();
    } else skip("a swap that keeps the user's place leaves a row in <main> where the user scrolled it", noSwaps);
    // A data-keep-place form with controls named after the members the runtime reads on it (its
    // `closest` as the navigation's source, its scroll, its `focus`), drawn so by the server and
    // scrolling on its own: the swap keeps the form's scroll and focus on the box changed.
    if (swaps) {
      const keptPage = await (await browser.newContext({ viewport: { width: 800, height: 400 } })).newPage();
      /** @type {string[]} */
      const keptErrors = [];
      keptPage.on("pageerror", (e) => keptErrors.push(e.message));
      const controls = ["closest", "matches", "getAttribute", "scrollTop", "scrollLeft", "scrollTo", "focus", "contains"].map((name) => `<input type="hidden" name="${name}" value="x" disabled>`).join("");
      await keptPage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          await route.fulfill({ status: res.status(), headers, body: (await res.text()).replace(/(<form\b[^>]*data-keep-place[^>]*>)/, `$1${controls}`) });
        },
      );
      await keptPage.goto(`${base}/news`);
      await keptPage.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("main form[data-keep-place] { max-height: 6rem !important; overflow: auto !important }");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      const settled = () => keptPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await settled();
      const formTop = () => keptPage.evaluate(() => Math.round(Reflect.get(Element.prototype, "scrollTop", /** @type {Element} */ (document.querySelector("main form[data-keep-place]")))));
      await keptPage.evaluate(() => {
        // Its box is in a group the server draws closed.
        for (const group of Array.from(document.querySelectorAll("main form[data-keep-place] details"))) /** @type {HTMLDetailsElement} */ (group).open = true;
        const box = /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]"));
        box.focus({ preventScroll: true });
        Element.prototype.scrollTo.call(/** @type {Element} */ (document.querySelector("main form[data-keep-place]")), 0, 40);
      });
      await settled();
      const before = await formTop();
      await keptPage.keyboard.press("Space");
      const swapped = await keptPage
        .waitForFunction(() => location.search === "?mine=on" && document.getElementById("stories-title")?.textContent === "Stories about your stocks", null, { timeout: 5000 })
        .then(() => true, () => false);
      await settled();
      const after = {
        top: await formTop(),
        focused: await keptPage.evaluate(() => document.activeElement && Element.prototype.getAttribute.call(document.activeElement, "name")),
        drawn: await keptPage.evaluate(() => !!document.querySelector("main form[data-keep-place] input[name=closest]")),
      };
      check(
        "a data-keep-place form with controls named closest, scrollTo, focus and the like keeps its scroll and focus through the swap",
        before > 0 && swapped && after.drawn && Math.abs(after.top - before) <= 1 && after.focused === "mine" && !keptErrors.length,
        JSON.stringify({ before, swapped, after, keptErrors }),
      );
      await keptPage.context().close();
    } else skip("a data-keep-place form with controls named closest, scrollTo, focus and the like keeps its scroll and focus through the swap", noSwaps);
    // Applying a filter adds another form ahead of it, repeating the chosen field. Inputs of type
    // hidden never take the user's place, nor does a copy in another form when the filter has an id.
    // Without ids, a copy that cannot take focus inserted ahead of it takes its index: focus is
    // left alone there, as before this lookup (docs/design.md#limit-keep-place-identity).
    // One more: a hidden input inside the filter form itself, ahead of the box.
    for (const [kind, anchored, excluded, inside] of [["hidden", true, "", false], ["checkbox", true, "", false], ["hidden", false, "", false], ["checkbox", false, "disabled", false], ["checkbox", false, "hidden", false], ["checkbox", false, "inert", false], ["hidden", true, "", true]]) {
      const label = excluded
        ? `a data-keep-place filter without ids leaves focus alone when an earlier ${excluded} checkbox duplicate is inserted`
        : `a data-keep-place filter keeps focus past an earlier ${kind} duplicate${inside ? " inside its form" : ""} (${anchored ? "anchored" : "main"})`;
      const duplicatePage = await (await browser.newContext()).newPage();
      await duplicatePage.goto(`${base}/news`);
      if (!(await duplicatePage.evaluate(() => "navigation" in window))) {
        skip(label, noSwaps);
        await duplicatePage.context().close();
        continue;
      }
      await duplicatePage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const applied = new URL(route.request().url()).searchParams.has("mine");
          const copy = `<input type="${kind}" ${excluded === "disabled" ? "disabled" : ""} name="mine" value="on">`;
          const duplicate = applied && !inside ? `<form ${excluded === "disabled" ? "" : excluded}>${copy}<button>Export</button></form>` : "";
          const body = (await res.text())
            .replace(/(<input\b[^>]*name="mine")/, '$1 value="on"')
            .replace(/(<form\b[^>]*data-keep-place[^>]*>)/, (_, form) => `${duplicate}${anchored ? form.replace("<form", '<form id="smoke-filter"') : form}${applied && inside ? copy : ""}`);
          await route.fulfill({ status: res.status(), headers, body });
        },
      );
      await duplicatePage.goto(`${base}/news`);
      // Stay inside the page across the swap, as in the WebKit navigation probe above.
      const after = await duplicatePage.evaluate(async () => {
        const box = /** @type {HTMLInputElement} */ (document.querySelector("main form[data-keep-place] input[name=mine]"));
        /** @type {HTMLDetailsElement} */ (box.closest("details")).open = true;
        box.focus();
        const before = document.activeElement === box;
        box.click();
        const done = () => location.search === "?mine=on" && document.getElementById("stories-title")?.textContent === "Stories about your stocks" && !document.querySelector("main[aria-busy]");
        for (let i = 0; i < 100 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
          before,
          swapped: done() && !box.isConnected,
          // The box, not a hidden copy put ahead of it in the same form.
          focused: document.activeElement === document.querySelector('main form[data-keep-place] input[name=mine]:not([type="hidden"])'),
          matches: document.querySelectorAll('main input[name=mine][value="on"]').length,
          body: document.activeElement === document.body,
          active: document.activeElement?.outerHTML.slice(0, 150),
        };
      });
      check(label, after.before && after.swapped && after.matches === 3 && (excluded ? after.body : after.focused), JSON.stringify(after));
      await duplicatePage.context().close();
    }
    // Focus correspondence does not change when a preceding duplicate's eligibility changes. A
    // control that is still there but cannot take focus keeps it from no other control, and one
    // missing from an ancestor that still holds matches is not looked for elsewhere; only when
    // nothing under the ancestor matches is it looked for again in <main>, by its index there.
    const shownKind = "become hidden but shown by a style";
    const turningKind = "turn an earlier copy type=hidden";
    for (const kind of ["enable preceding", "disable preceding", "lose ancestor", "lose ancestor beside an unchanged duplicate", "move between forms", "become disabled", "become hidden", "become inert", shownKind, turningKind]) {
      const shown = kind === shownKind;
      const turning = kind === turningKind;
      const becoming = shown ? "hidden" : kind.startsWith("become ") ? kind.slice("become ".length) : "";
      const alone = (!!becoming && !shown) || turning;
      const label = turning
        ? "a data-keep-place swap leaves focus alone when an earlier copy in its form turns type=hidden, beside a later form's copy"
        : alone
          ? `a data-keep-place swap leaves focus alone when its control must become ${becoming}, beside another form's copy`
          : `a data-keep-place swap keeps focus and caret when it must ${kind}`;
      const correspondencePage = await (await browser.newContext()).newPage();
      await correspondencePage.goto(`${base}/news`);
      if (!(await correspondencePage.evaluate(() => "navigation" in window))) {
        skip(label, noSwaps);
        await correspondencePage.context().close();
        continue;
      }
      await correspondencePage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const applied = new URL(route.request().url()).searchParams.has("mine");
          const losing = kind.startsWith("lose ancestor");
          const moved = kind === "move between forms" && applied;
          const target = `<input name="q" value="abcdef" data-smoke-focused ${becoming && applied ? becoming : ""}>`;
          const preceding = kind.endsWith(" preceding")
            ? `<input name="q" value="abcdef" ${applied === (kind === "disable preceding") ? "disabled" : ""}>`
            : turning
              ? `<input name="q" value="abcdef" ${applied ? 'type="hidden"' : ""}>`
              : "";
          // After the filter form, so its index in <main> is the focused control's once the copy
          // turns. (A swap's answer is <main>'s part, without its closing tag.)
          const later = turning ? '<form><input name="q" value="abcdef"></form>' : "";
          const other =
            kind === "lose ancestor beside an unchanged duplicate"
              ? '<form><input name="q" value="abcdef"></form>'
              : kind === "move between forms"
                ? `<form id="smoke-other"><input name="q" value="abcdef">${moved ? target : ""}</form>`
                : becoming
                  ? '<form id="smoke-export"><input name="q" value="abcdef"></form>'
                  : "";
          const body = (await res.text())
            .replace(/(<form\b[^>]*data-keep-place[^>]*>)/, (_, form) => `${other}${losing && applied ? form : form.replace("<form", '<form id="smoke-filter"')}${preceding}${moved ? "" : target}`)
            .replace(/(<form id="smoke-filter"[\s\S]*?<\/form>)/, (_, form) => `${form}${later}`);
          await route.fulfill({ status: res.status(), headers, body });
        },
      );
      await correspondencePage.goto(`${base}/news`);
      const after = await correspondencePage.evaluate(async (shown) => {
        if (shown) {
          // A hidden attribute the app's style overrides: the control can still take focus.
          const sheet = new CSSStyleSheet();
          sheet.replaceSync("[data-smoke-focused][hidden] { display: inline-block !important }");
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        }
        const input = /** @type {HTMLInputElement} */ (document.querySelector("[data-smoke-focused]"));
        input.focus();
        input.setSelectionRange(1, 4, "backward");
        const before = document.activeElement === input;
        const mine = /** @type {HTMLInputElement} */ (document.querySelector("main form[data-keep-place] input[name=mine]"));
        mine.click();
        const done = () => new URL(location.href).searchParams.has("mine") && document.getElementById("stories-title")?.textContent === "Stories about your stocks" && !document.querySelector("main[aria-busy]");
        for (let i = 0; i < 100 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const fresh = /** @type {HTMLInputElement} */ (document.querySelector("[data-smoke-focused]"));
        return {
          before,
          swapped: done() && !input.isConnected,
          focused: document.activeElement === fresh,
          caret: [fresh.selectionStart, fresh.selectionEnd, fresh.selectionDirection],
          body: document.activeElement === document.body,
          active: document.activeElement?.outerHTML.slice(0, 150),
        };
      }, shown);
      check(label, after.before && after.swapped && (alone ? after.body : after.focused && after.caret.join() === "1,4,backward"), JSON.stringify(after));
      await correspondencePage.context().close();
    }
    // A group the server drew open in the page as it loaded, closed by the user: the swap keeps it
    // closed though the new page draws it open too, which takes what the load recorded of it.
    const loadedGroupCheck = "a data-keep-place swap keeps closed a group the loaded page drew open and the user closed";
    if (swaps) {
      const groupPage = await (await browser.newContext()).newPage();
      await groupPage.goto(`${base}/news?sector=energy`);
      const groups = () => groupPage.$$eval("main form[data-keep-place] details", (all) => all.map((d) => /** @type {HTMLDetailsElement} */ (d).open).join());
      const drawn = await groups();
      await groupPage.evaluate(() => {
        const [sectors, mine] = /** @type {HTMLDetailsElement[]} */ (Array.from(document.querySelectorAll("main form[data-keep-place] details")));
        sectors.open = false;
        mine.open = true;
        /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]")).focus();
      });
      await groupPage.keyboard.press("Space");
      const swapped = await groupPage
        .waitForFunction(() => location.search === "?sector=energy&mine=on" && document.getElementById("stories-title")?.textContent === "Stories about your stocks", null, { timeout: 5000 })
        .then(() => true, () => false);
      const after = await groups();
      check(loadedGroupCheck, drawn === "true,false" && swapped && after === "false,true", JSON.stringify({ drawn, swapped, after }));
      await groupPage.context().close();
    } else skip(loadedGroupCheck, noSwaps);

    // Focus kept by a swap on an element that is not HTML (a chart's point, in SVG): its own focus
    // is SVGElement's, which the swap calls rather than HTMLElement's.
    if (swaps) {
      const svgPage = await (await browser.newContext()).newPage();
      /** @type {string[]} */
      const svgErrors = [];
      svgPage.on("pageerror", (e) => svgErrors.push(e.message));
      await svgPage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const chart = `<svg id="smoke-chart" width="40" height="40"><a id="smoke-point" href="#smoke-chart" tabindex="0"><circle cx="20" cy="20" r="10"></circle></a></svg>`;
          const body = await res.text();
          await route.fulfill({ status: res.status(), headers, body: /<main\b/.test(body) ? body.replace(/(<main\b[^>]*>)/, `$1${chart}`) : body.replace("<div", `${chart}<div`) });
        },
      );
      await svgPage.goto(`${base}/news`);
      const focusedBefore = await svgPage.evaluate(() => {
        const point = /** @type {SVGElement} */ (document.getElementById("smoke-point"));
        point.focus({ preventScroll: true });
        const mine = /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]"));
        mine.checked = !mine.checked;
        mine.dispatchEvent(new Event("input", { bubbles: true }));
        mine.dispatchEvent(new Event("change", { bubbles: true }));
        return document.activeElement === point;
      });
      const swapped = await svgPage
        .waitForFunction(() => location.search === "?mine=on" && document.getElementById("stories-title")?.textContent === "Stories about your stocks", null, { timeout: 5000 })
        .then(() => true, () => false);
      await svgPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const focusedAfter = await svgPage.evaluate(() => document.activeElement?.id ?? "");
      check(
        "a swap that keeps the user's place gives focus back to an SVG element",
        focusedBefore && swapped && focusedAfter === "smoke-point" && !svgErrors.length,
        JSON.stringify({ focusedBefore, swapped, focusedAfter, svgErrors }),
      );
      await svgPage.context().close();
    } else skip("a swap that keeps the user's place gives focus back to an SVG element", noSwaps);
    // The same when the row's scroll event has not come yet as the page is swapped: focus in the row
    // (a link the user tabbed to, which scrolls it) and the row scrolled with its scroll events held
    // back, then the filter changed without moving focus.
    if (swaps) {
      const keptPage = await (await browser.newContext({ viewport: { width: 800, height: 400 } })).newPage();
      await keptPage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          // Marked current as the server marks a req.nav link.
          const row = `<nav id="tab-row"><a href="/news" data-nav aria-current="page">News</a>${Array.from({ length: 8 }, (_, i) => `<a href="/tab-${i}" data-nav>Tab ${i}</a>`).join("")}</nav>`;
          // A full page has <main>; the runtime's navigation answer is what goes in it, its head tags first.
          const body = await res.text();
          await route.fulfill({ status: res.status(), headers, body: /<main\b/.test(body) ? body.replace(/(<main\b[^>]*>)/, `$1${row}`) : body.replace("<div", `${row}<div`) });
        },
      );
      await keptPage.goto(`${base}/news`);
      await keptPage.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("#tab-row { display: flex !important; overflow-x: auto !important; width: 8rem !important; white-space: nowrap !important } #tab-row a { padding-inline: 2rem !important }");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      const settled = () => keptPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await settled();
      const before = await keptPage.evaluate(() => {
        const row = /** @type {HTMLElement} */ (document.getElementById("tab-row"));
        addEventListener("scroll", (event) => event.target === row && event.stopImmediatePropagation(), { capture: true });
        /** @type {HTMLElement} */ (row.lastElementChild).focus({ preventScroll: true });
        row.scrollTo({ left: row.scrollWidth, behavior: "instant" });
        const mine = /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]"));
        mine.checked = !mine.checked;
        mine.dispatchEvent(new Event("input", { bubbles: true }));
        mine.dispatchEvent(new Event("change", { bubbles: true }));
        return Math.round(row.scrollLeft);
      });
      const swapped = await keptPage
        .waitForFunction(() => location.search === "?mine=on" && document.getElementById("stories-title")?.textContent === "Stories about your stocks", null, { timeout: 5000 })
        .then(() => true, () => false);
      await settled();
      const after = await keptPage.evaluate(() => {
        const row = /** @type {HTMLElement} */ (document.getElementById("tab-row"));
        const current = row.querySelector('[aria-current="page"]')?.getAttribute("href");
        return { left: Math.round(row.scrollLeft), current };
      });
      check(
        "a swap that keeps the user's place leaves a row the user scrolled in the same moment as the swap, before its scroll event",
        before > 0 && swapped && after.current === "/news" && Math.abs(after.left - before) <= 1,
        JSON.stringify({ before, swapped, after }),
      );
      await keptPage.context().close();
    } else skip("a swap that keeps the user's place leaves a row the user scrolled in the same moment as the swap, before its scroll event", noSwaps);
    // The same for a row the user scrolled back to its start, its current link past the row's end:
    // the row stays at its start.
    if (swaps) {
      const startPage = await (await browser.newContext({ viewport: { width: 800, height: 400 } })).newPage();
      await startPage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const row = `<nav id="start-row">${Array.from({ length: 8 }, (_, i) => `<a href="/tab-${i}" data-nav>Tab ${i}</a>`).join("")}<a href="/news" data-nav aria-current="page">News</a></nav>`;
          const body = await res.text();
          await route.fulfill({ status: res.status(), headers, body: /<main\b/.test(body) ? body.replace(/(<main\b[^>]*>)/, `$1${row}`) : body.replace("<div", `${row}<div`) });
        },
      );
      await startPage.goto(`${base}/news`);
      await startPage.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("#start-row { display: flex !important; overflow-x: auto !important; width: 8rem !important; white-space: nowrap !important } #start-row a { padding-inline: 2rem !important }");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      const settled = () => startPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await settled();
      // The user scrolls the row to its end, then back to its start, away from its current link.
      for (const to of ["end", "start"]) {
        await startPage.evaluate((to) => {
          const row = /** @type {HTMLElement} */ (document.getElementById("start-row"));
          row.scrollTo({ left: to === "end" ? row.scrollWidth : 0, behavior: "instant" });
        }, to);
        await settled();
      }
      await startPage.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]")).click());
      const swapped = await startPage
        .waitForFunction(() => location.search === "?mine=on" && document.getElementById("stories-title")?.textContent === "Stories about your stocks", null, { timeout: 5000 })
        .then(() => true, () => false);
      await settled();
      const left = await startPage.evaluate(() => Math.round(/** @type {HTMLElement} */ (document.getElementById("start-row")).scrollLeft));
      check("a swap that keeps the user's place leaves a row in <main> the user scrolled back to its start there", swapped && left === 0, JSON.stringify({ swapped, left }));
      await startPage.context().close();
    } else skip("a swap that keeps the user's place leaves a row in <main> the user scrolled back to its start there", noSwaps);
    // A row a swap that keeps the user's place draws for the first time was not put back, so its
    // current link, past the row's end, is brought into view.
    if (swaps) {
      const newPage = await (await browser.newContext({ viewport: { width: 800, height: 400 } })).newPage();
      await newPage.route(
        (url) => url.pathname === "/news" && url.searchParams.get("mine") === "on",
        async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const row = `<nav id="new-row">${Array.from({ length: 8 }, (_, i) => `<a href="/tab-${i}" data-nav>Tab ${i}</a>`).join("")}<a href="/news" data-nav aria-current="page">News</a></nav>`;
          const body = await res.text();
          await route.fulfill({ status: res.status(), headers, body: /<main\b/.test(body) ? body.replace(/(<main\b[^>]*>)/, `$1${row}`) : body.replace("<div", `${row}<div`) });
        },
      );
      await newPage.goto(`${base}/news`);
      await newPage.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("#new-row { display: flex !important; overflow-x: auto !important; width: 8rem !important; white-space: nowrap !important } #new-row a { padding-inline: 2rem !important }");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      await newPage.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]")).click());
      const swapped = await newPage
        .waitForFunction(() => location.search === "?mine=on" && !!document.getElementById("new-row"), null, { timeout: 5000 })
        .then(() => true, () => false);
      await newPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const seen = await newPage.evaluate(() => {
        const row = document.getElementById("new-row");
        const link = row?.querySelector('[aria-current="page"]');
        if (!row || !link) return null;
        const [r, l] = [row.getBoundingClientRect(), link.getBoundingClientRect()];
        return { left: Math.round(row.scrollLeft), inside: l.left >= r.left - 1 && l.right <= r.right + 1 };
      });
      check(
        "a row a swap that keeps the user's place draws for the first time brings its current link into view",
        swapped && !!seen && seen.left > 0 && seen.inside,
        JSON.stringify({ swapped, seen }),
      );
      await newPage.context().close();
    } else skip("a row a swap that keeps the user's place draws for the first time brings its current link into view", noSwaps);
    // Boxes that scroll both ways, and a wrapper: a box the user scrolled only up and down was not
    // scrolled sideways, so a current link new in it is brought into view; one scrolled sideways and
    // back to its start, and down, is left at its start and its height; a new row inside a wrapper
    // the user scrolled sideways gets its link brought into view, and the wrapper stays.
    const bothNames = [
      "a swap that keeps the user's place brings a current link into view in a box the user scrolled only up and down",
      "a swap that keeps the user's place leaves a box the user scrolled sideways back to its start, and down, there",
      "a swap that keeps the user's place brings a new row's current link into view inside a wrapper the user scrolled sideways, and leaves the wrapper",
    ];
    if (swaps) {
      const bothPage = await (await browser.newContext({ viewport: { width: 800, height: 400 } })).newPage();
      await bothPage.route(
        (url) => url.pathname === "/news",
        async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const mine = new URL(route.request().url()).searchParams.get("mine") === "on";
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          // The link to this page is only in the swapped page's rows, so the load brings none in.
          const tabs = Array.from({ length: 8 }, (_, i) => `<a href="/tab-${i}" data-nav>Tab ${i}</a>`).join("");
          const news = mine ? '<a href="/news" data-nav aria-current="page">News</a>' : "";
          const box = (/** @type {string} */ id) => `<div id="${id}" class="nbx"><nav>${tabs}${news}</nav><div class="tall"></div></div>`;
          const inner = mine ? `<nav id="inner">${tabs}${news}</nav>` : "";
          const boxes = `${box("both")}${box("both2")}<div id="wrap"><div class="wide"></div>${inner}</div>`;
          const body = await res.text();
          await route.fulfill({ status: res.status(), headers, body: /<main\b/.test(body) ? body.replace(/(<main\b[^>]*>)/, `$1${boxes}`) : body.replace("<div", `${boxes}<div`) });
        },
      );
      await bothPage.goto(`${base}/news`);
      await bothPage.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(
          ".nbx { display: block !important; overflow: auto !important; width: 8rem !important; height: 3rem !important } " +
            ".nbx nav, #inner { display: flex !important; white-space: nowrap !important } .nbx nav a, #inner a { padding-inline: 2rem !important } " +
            ".tall { height: 10rem } #wrap { display: block !important; overflow-x: auto !important; width: 10rem !important } .wide { width: 40rem; height: 1px } " +
            "#inner { overflow-x: auto !important; width: 8rem !important }",
        );
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      const settled = () => bothPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await settled();
      for (const [id, left, top] of /** @type {[string, number, number][]} */ ([["both", 0, 50], ["both", 0, 0], ["both2", 1e4, 0], ["both2", 0, 50], ["wrap", 100, 0]])) {
        await bothPage.evaluate(([id, left, top]) => /** @type {HTMLElement} */ (document.getElementById(id)).scrollTo({ left, top, behavior: "instant" }), [id, left, top]);
        await settled();
      }
      await bothPage.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]")).click());
      const swapped = await bothPage
        .waitForFunction(() => location.search === "?mine=on" && !!document.getElementById("inner"), null, { timeout: 5000 })
        .then(() => true, () => false);
      await settled();
      const seen = await bothPage.evaluate(() => {
        /** @param {string} id */
        const at = (id) => {
          const box = /** @type {HTMLElement} */ (document.getElementById(id));
          const link = box.querySelector('[aria-current="page"]');
          const [b, l] = [box.getBoundingClientRect(), link?.getBoundingClientRect()];
          return { left: Math.round(box.scrollLeft), top: Math.round(box.scrollTop), inside: !!l && l.left >= b.left - 1 && l.right <= b.right + 1 };
        };
        return { both: at("both"), both2: at("both2"), inner: at("inner"), wrap: Math.round(/** @type {HTMLElement} */ (document.getElementById("wrap")).scrollLeft) };
      });
      const detail = JSON.stringify({ swapped, seen });
      check(bothNames[0], swapped && seen.both.left > 0 && seen.both.inside && seen.both.top === 0, detail);
      check(bothNames[1], swapped && seen.both2.left === 0 && Math.abs(seen.both2.top - 50) <= 1, detail);
      check(bothNames[2], swapped && seen.inner.left > 0 && seen.inner.inside && Math.abs(seen.wrap - 100) <= 1, detail);
      await bothPage.context().close();
    } else for (const name of bothNames) skip(name, noSwaps);
  }
}

export async function fragmentTargets(browser) {
  // A page the runtime draws at a `#fragment` is scrolled there as a full load's is, by the
  // browser's own scroll to the fragment: `:target` is its element, an `<a name>` is found as an id
  // is, and the fragment is tried as written, then percent-decoded as HTML decodes it. A page
  // without one starts at the top, not where the last one was scrolled. Read from inside the page,
  // which Playwright's WebKit with the Navigation API needs (openWatchlist), so WebKit is checked
  // too: one document's navigations in one `evaluate`, each document on a page of its own. The news
  // page is given a named anchor and ids that need decoding at the end of <main>, below a short
  // window's fold, and an id after <main>, which a navigation's swap leaves in place.
  const names = [
    "a client navigation without a #fragment starts at the top",
    "a client navigation to an #id scrolls to it and :target matches it",
    "a client navigation to an <a name> scrolls to it and :target matches it",
    "a percent-encoded #fragment finds the element its decoded text names",
    "a link the server redirects keeps its #fragment, scrolled to on the redirect's page",
    "a replace to the #fragment of an element outside <main>, already :target, scrolls to it again",
    "a #fragment with a malformed escape finds what a full load finds",
    "a #fragment that is not UTF-8 once decoded finds what a full load finds",
    "a #fragment that starts with an escaped U+FEFF finds the id that keeps it, not the one without",
    "a #fragment that is one id as written and another decoded finds the one as written",
    "a focus handler that changes the address in the scroll to a #fragment ends the navigation, which scrolls no further",
    "the browser's scroll to a kept :target that runs a focus handler is not scrolled again",
    "a client navigation to a heading's #fragment from a focused link makes the heading :target",
    "a client navigation to a #fragment that names nothing moves focus off the link kept outside <main>",
    "a focus handler that moves focus back in the browser's scroll to a kept :target keeps it there, not scrolled again",
    "focus moved while a page with a #fragment that names nothing loads stays where it was moved",
    "a kept :target's own focus handler that blurs it in the browser's scroll is not scrolled again",
    "a browser scroll to a #fragment that throws leaves no focus listener of the runtime's on the window",
  ];
  // Two spellings of one fragment, each an id, far enough apart that one is out of view when the
  // other is in it: the one HTML finds, and the one it would find if it dropped a leading U+FEFF
  // or decoded before trying the fragment as written.
  const apart = `<p>${"<br>".repeat(24)}</p>`;
  const spellings = `<p id="smoke-bom">BOM dropped</p>${apart}<p id="\ufeffsmoke-bom">BOM kept</p>${apart}<p id="smoke-%41">As written</p>${apart}<p id="smoke-A">Decoded</p>`;
  // A heading Tab goes on from, and a button a focus handler is on, far from the place it sends the address to.
  const focusing = `<h2 id="smoke-heading">Heading</h2><button id="smoke-after-heading">After heading</button>${apart}<button id="smoke-focus-inside">Inside</button>${apart}<p id="smoke-after-focus">After focus</p>`;
  // A navigation answer whose address has `hold` waits for `held.release()`, so focus can move
  // while it loads; `held.reached` settles once it waits. Both are made before the request.
  const gate = () => {
    let [reach, release] = [() => {}, () => {}];
    const reached = new Promise((done) => (reach = () => done(true)));
    const released = new Promise((done) => (release = () => done(undefined)));
    return { reach, reached, release, released };
  };
  let held = gate();
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 200 } });
    await page.route(
      (url) => url.pathname === "/news",
      async (route) => {
        // A page, whole or a navigation's; not a form's or a part's answer on the same path.
        const asked = route.request().headers().corten;
        if (route.request().method() !== "GET" || (asked && asked !== "nav")) return route.fallback();
        // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
        const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        const headers = res.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        // At the end of <main>: before its end tag in a whole page, and at the end of a navigation's
        // answer, which ends with what <main> holds and has no <main> tag. The id after <main> is in
        // the whole page only.
        const anchors = `<p><a name="smoke-named">Named</a></p><p id="smoke-caf\u00e9">Decoded</p><p id="caf\u00e9%xx">Malformed</p><p id="bad\ufffd">Not UTF-8</p>${spellings}${focusing}`;
        const text = await res.text();
        const body = text.includes("</main>") ? text.replace("</main>", `${anchors}</main><p id="smoke-outside">Outside</p>${apart}<button id="smoke-outside-button">Outside</button>`) : text + anchors;
        if (asked && new URL(route.request().url()).searchParams.has("hold")) {
          const { reach, released } = held;
          reach();
          await released;
        }
        await route.fulfill({ status: res.status(), headers, body }).catch(() => {});
      },
    );
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window);
      /**
       * Where the page is, what `:target` is, and whether the elements `place` and `other` select are in view.
       * @param {string} [place] @param {string} [other]
       */
      w.__at = (place, other) => {
        const target = document.querySelector(":target");
        // Layout in fractions of a pixel can leave the top a fraction above the scroll position.
        const shown = (/** @type {string | undefined} */ selector) => {
          const top = (selector && document.querySelector(selector)?.getBoundingClientRect().top) ?? -1;
          return top > -1 && top < innerHeight;
        };
        return {
          url: location.pathname + location.search + location.hash,
          target: target ? target.id || `name=${target.getAttribute("name")}` : null,
          inView: shown(place),
          otherInView: shown(other),
          y: Math.round(scrollY),
          swapped: w.__marker === 1,
          error: "",
        };
      };
      w.__drawn = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      // The id or text of the focused element, else "body".
      w.__focus = () => {
        const el = document.activeElement;
        return !el || el === document.body ? "body" : el.id || `${el.localName}: ${el.textContent?.trim()}`;
      };
      // The elements scrolled to with `scrollIntoView`, which the runtime uses, captured before it loads.
      /** @type {string[]} */
      w.__scrolledInto = [];
      const into = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (/** @type {any} */ ...args) {
        w.__scrolledInto.push(this.id);
        return into.apply(this, args);
      };
      // The focus and scroll listeners on the window, as added and not yet removed, counted from
      // before the runtime loads.
      /** @type {Map<unknown, Set<string>>} */
      const listening = new Map();
      w.__listening = () => [...listening.values()].reduce((count, types) => count + types.size, 0);
      /** @param {string} type @param {boolean | { capture?: boolean } | undefined} options */
      const kind = (type, options) => /^(focus|focusin|blur|focusout|scroll)$/.test(type) && `${type} ${typeof options === "boolean" ? options : !!options?.capture}`;
      const [add, remove] = [EventTarget.prototype.addEventListener, EventTarget.prototype.removeEventListener];
      EventTarget.prototype.addEventListener = function (/** @type {any} */ type, /** @type {any} */ fn, /** @type {any} */ options) {
        const as = (this ?? window) === window && kind(type, options);
        if (as) listening.set(fn, (listening.get(fn) ?? new Set()).add(as));
        return add.call(this ?? window, type, fn, options);
      };
      EventTarget.prototype.removeEventListener = function (/** @type {any} */ type, /** @type {any} */ fn, /** @type {any} */ options) {
        const as = (this ?? window) === window && kind(type, options);
        if (as) listening.get(fn)?.delete(as);
        return remove.call(this ?? window, type, fn, options);
      };
      /**
       * @param {string} url @param {string} [place] a selector for the element the fragment names
       * @param {"push" | "replace"} [history] @param {string} [other] a selector for one it must not be at
       */
      w.__to = async (url, place, history = "push", other) => {
        const error = await w.navigation.navigate(url, { history }).finished.then(() => "", (/** @type {Error} */ e) => String(e));
        await w.__drawn();
        return { ...w.__at(place, other), error };
      };
    });
    return page;
  };
  /** @typedef {{ url: string, target: string | null, inView: boolean, otherInView: boolean, y: number, swapped: boolean, error: string }} Step */
  let page = await open();
  await page.goto(`${base}/news`);
  if (!(await page.evaluate(() => "navigation" in window))) {
    for (const name of names) skip(name, "no Navigation API: navigations are full page loads");
    await page.close();
    return;
  }
  const precommit = await page.evaluate(precommits);
  const seen = await page.evaluate(async (precommit) => {
    const w = /** @type {any} */ (window);
    w.__marker = 1;
    scrollTo(0, document.documentElement.scrollHeight);
    const before = Math.round(scrollY);
    /** @type {Step & { before: number }} */
    const top = { ...(await w.__to("/news?mine=on")), before };
    /** @type {Step} */
    const id = await w.__to("/news#briefing", "#briefing");
    /** @type {Step} */
    const named = await w.__to("/news?mine=on#smoke-named", 'a[name="smoke-named"]');
    /** @type {Step} */
    const decoded = await w.__to("/news#smoke-caf%C3%A9", '[id="smoke-caf\u00e9"]');
    // A full load keeps the link's #fragment on the redirect's page, and so does the address
    // where it waits for the answer: /account sends someone signed out to the stocks page with a
    // 303, which draws its picks at the end of its <main>.
    /** @type {Step | null} */
    const redirected = precommit ? await w.__to("/account#picks", "#picks") : null;
    return { top, id, named, decoded, redirected };
  }, precommit);
  await page.close();
  const { top, id, named, decoded, redirected } = seen;
  // Firefox's scroll() goes to a document's fragment only the first time, the #id here: the
  // runtime scrolls to the later ones itself, which leaves `:target` unset.
  const once = engine === "firefox";
  /** @param {Step} step @param {string} want @param {boolean} [first] */
  const at = (step, want, first = false) =>
    step.swapped && step.inView && step.y > 0 && !step.error && (step.target === want || (once && !first && step.target === null));
  check(names[0], top.swapped && top.before > 0 && top.y === 0 && !top.error, JSON.stringify(top));
  check(names[1], at(id, "briefing", true), JSON.stringify(id));
  check(names[2], at(named, "name=smoke-named"), JSON.stringify(named));
  check(names[3], at(decoded, "smoke-caf\u00e9"), JSON.stringify(decoded));
  if (redirected) check(names[4], redirected.url === "/#picks" && at(redirected, "picks"), JSON.stringify(redirected));
  else skip(names[4], "no precommitHandler: the runtime follows the redirect to fetch's address, which has no #fragment");
  if (once) skip(":target after a document's first #fragment", "Firefox's NavigateEvent.scroll() sets it only for the first");

  // An element a swap leaves in place stays `:target`. Firefox does not scroll to it again for a
  // later address with its #fragment (its first scroll to a fragment was this one), and the page
  // must be, as after a full load at that address.
  page = await open();
  await page.goto(`${base}/news`);
  const kept = await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    w.__marker = 1;
    /** @type {Step} */
    const first = await w.__to("/news?mine=on#smoke-outside", "#smoke-outside");
    scrollTo(0, 0);
    await w.__drawn();
    /** @type {Step} */
    const away = w.__at("#smoke-outside");
    /** @type {Step} */
    const again = await w.__to("/news?sector=energy#smoke-outside", "#smoke-outside", "replace");
    return { first, away, again };
  });
  await page.close();
  check(names[5], at(kept.first, "smoke-outside", true) && !kept.away.inView && at(kept.again, "smoke-outside"), JSON.stringify(kept));

  // HTML decodes a fragment's escapes even beside a malformed one, and bytes that are not UTF-8 as
  // U+FFFD. Compared with a full load at the same #fragment in this browser: a client navigation
  // finds the element when it does, and is where it is when it does not.
  for (const [index, fragment, want] of /** @type {const} */ ([
    [6, "caf%C3%A9%xx", "caf\u00e9%xx"],
    [7, "bad%FF", "bad\ufffd"],
  ])) {
    const place = `[id="${want}"]`;
    page = await open();
    await page.goto(`${base}/news#${fragment}`);
    await page.evaluate(() => /** @type {any} */ (window).__drawn());
    /** @type {Step} */
    const full = await page.evaluate((place) => /** @type {any} */ (window).__at(place), place);
    await page.close();
    page = await open();
    await page.goto(`${base}/news`);
    /** @type {Step} */
    const client = await page.evaluate(
      async ([fragment, place]) => {
        const w = /** @type {any} */ (window);
        w.__marker = 1;
        scrollTo(0, 0);
        return w.__to(`/news?mine=on#${fragment}`, place);
      },
      [fragment, place],
    );
    await page.close();
    const found = full.target === want && full.inView;
    const same = found ? at(client, want) : client.swapped && !client.error && client.inView === full.inView && client.target === full.target;
    check(names[index], same, `${found ? "found by a full load" : "not found by a full load, so compared with it"}: ${JSON.stringify({ full, client })}`);
  }

  // HTML keeps a leading U+FEFF a fragment decodes to, and tries the fragment as written before
  // decoded. Each fragment here has both spellings on the page: a client navigation must be at the
  // one HTML names, whether the browser's scroll or the runtime's found it, and not at the other.
  // A full load's result is in the detail only.
  for (const [index, fragment, want, other] of /** @type {const} */ ([
    [8, "%EF%BB%BFsmoke-bom", "\ufeffsmoke-bom", "smoke-bom"],
    [9, "smoke-%41", "smoke-%41", "smoke-A"],
  ])) {
    const [place, wrong] = [`[id="${want}"]`, `[id="${other}"]`];
    page = await open();
    await page.goto(`${base}/news#${fragment}`);
    await page.evaluate(() => /** @type {any} */ (window).__drawn());
    /** @type {Step} */
    const full = await page.evaluate(([place, wrong]) => /** @type {any} */ (window).__at(place, wrong), [place, wrong]);
    await page.close();
    page = await open();
    await page.goto(`${base}/news`);
    /** @type {Step} */
    const client = await page.evaluate(
      async ([fragment, place, wrong]) => {
        const w = /** @type {any} */ (window);
        w.__marker = 1;
        scrollTo(0, 0);
        return w.__to(`/news?mine=on#${fragment}`, place, "push", wrong);
      },
      [fragment, place, wrong],
    );
    await page.close();
    check(names[index], at(client, want) && !client.otherInView, JSON.stringify({ client, full }));
  }

  // The browser's scroll focuses a button the fragment names, and a focus handler of the page's
  // changes the address: that ends the navigation (its `finished` rejects), and the runtime then
  // scrolls to neither fragment, the address's new one included. The change is the page's own.
  page = await open();
  await page.goto(`${base}/news`);
  const focused = await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    w.__marker = 1;
    scrollTo(0, 0);
    let fired = false;
    addEventListener("focusin", (e) => {
      if (fired || /** @type {Element} */ (e.target).id !== "smoke-focus-inside") return;
      fired = true;
      history.replaceState(null, "", "#smoke-after-focus");
    });
    /** @type {Step} */
    const step = await w.__to("/news?mine=on#smoke-focus-inside", "#smoke-focus-inside", "push", "#smoke-after-focus");
    return { ...step, fired, scrolledInto: /** @type {string[]} */ (w.__scrolledInto) };
  });
  await page.close();
  check(
    names[10],
    focused.fired && /abort/i.test(focused.error) && focused.url === "/news?mine=on#smoke-after-focus" && focused.inView && !focused.otherInView && focused.scrolledInto.length === 0,
    JSON.stringify(focused),
  );

  // A button the swap leaves in place (after <main>) is the target, then focus leaves it, and a
  // later address has its #fragment again. A browser whose scroll goes there focuses it, and the
  // page's focus handler scrolls elsewhere: the runtime must not scroll to it on top. Whether it
  // did is read from its `scrollIntoView` calls, not the position: Chromium's own scroll comes
  // after the focus handler's, and WebKit's comes again after layout. Firefox's goes neither there
  // nor to the button, and the runtime scrolls to it.
  page = await open();
  await page.goto(`${base}/news`);
  const handled = await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    w.__marker = 1;
    /** @type {Step} */
    const first = await w.__to("/news?mine=on#smoke-outside-button", "#smoke-outside-button");
    /** @type {HTMLElement} */ (document.activeElement).blur();
    scrollTo(0, 0);
    await w.__drawn();
    w.__scrolledInto.length = 0;
    let fired = false;
    addEventListener("focusin", (e) => {
      if (/** @type {Element} */ (e.target).id !== "smoke-outside-button") return;
      fired = true;
      scrollTo(0, 500);
    });
    /** @type {Step} */
    const again = await w.__to("/news?sector=energy#smoke-outside-button", "#smoke-outside-button", "replace");
    return { first, again, fired, scrolledInto: /** @type {string[]} */ ([...w.__scrolledInto]) };
  });
  await page.close();
  check(
    names[11],
    at(handled.first, "smoke-outside-button", true) && handled.again.swapped && !handled.again.error && (handled.fired ? handled.scrolledInto.length === 0 : handled.again.inView),
    JSON.stringify(handled),
  );

  // As the last, but the page's focus handler sends focus back to the header link that had it
  // (and scrolls elsewhere): focus is where the page has put it, the same element as before the
  // browser's scroll, and the runtime neither scrolls to the button on top nor moves focus off it.
  // Firefox's scroll goes neither there nor to the button, and the runtime scrolls to it.
  page = await open();
  await page.goto(`${base}/news`);
  const returned = await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    w.__marker = 1;
    /** @type {Step} */
    const first = await w.__to("/news?mine=on#smoke-outside-button", "#smoke-outside-button");
    const link = /** @type {HTMLElement} */ (document.querySelector("header a[href]"));
    link.focus();
    scrollTo(0, 0);
    await w.__drawn();
    w.__scrolledInto.length = 0;
    let fired = false;
    addEventListener("focusin", (e) => {
      if (fired || /** @type {Element} */ (e.target).id !== "smoke-outside-button") return;
      fired = true;
      link.focus();
      scrollTo(0, 500);
    });
    /** @type {Step} */
    const again = await w.__to("/news?sector=energy#smoke-outside-button", "#smoke-outside-button", "replace");
    return { first, again, fired, focus: w.__focus(), link: link === document.activeElement, scrolledInto: /** @type {string[]} */ ([...w.__scrolledInto]) };
  });
  await page.close();
  check(
    names[14],
    at(returned.first, "smoke-outside-button", true) && returned.again.swapped && !returned.again.error && (returned.fired ? returned.link && returned.scrolledInto.length === 0 : returned.again.inView),
    JSON.stringify(returned),
  );

  // As the last two, but the button's own `focus` handler blurs it and scrolls elsewhere: no
  // `focusin` follows (Chromium, WebKit), and focus ends where it was before the browser's scroll,
  // on the body. The runtime still must not scroll to the button on top. Firefox's scroll goes
  // neither there nor to the button, and the runtime scrolls to it.
  page = await open();
  await page.goto(`${base}/news`);
  const blurred = await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    w.__marker = 1;
    /** @type {Step} */
    const first = await w.__to("/news?mine=on#smoke-outside-button", "#smoke-outside-button");
    /** @type {HTMLElement} */ (document.activeElement).blur();
    scrollTo(0, 0);
    await w.__drawn();
    w.__scrolledInto.length = 0;
    const button = /** @type {HTMLElement} */ (document.querySelector("#smoke-outside-button"));
    let fired = false;
    button.addEventListener("focus", () => {
      if (fired) return;
      fired = true;
      button.blur();
      scrollTo(0, 500);
    });
    /** @type {Step} */
    const again = await w.__to("/news?sector=energy#smoke-outside-button", "#smoke-outside-button", "replace");
    return { first, again, fired, focus: w.__focus(), scrolledInto: /** @type {string[]} */ ([...w.__scrolledInto]) };
  });
  await page.close();
  check(
    names[16],
    at(blurred.first, "smoke-outside-button", true) && blurred.again.swapped && !blurred.again.error && (blurred.fired ? blurred.scrolledInto.length === 0 : blurred.again.inView),
    JSON.stringify(blurred),
  );

  // A handler of the page's own that calls the navigation's `scroll()` first makes the runtime's
  // call throw, which rejects the navigation's `finished`: the runtime leaves no listener behind.
  page = await open();
  await page.goto(`${base}/news`);
  const thrown = await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    w.__marker = 1;
    const before = w.__listening();
    const first = (/** @type {any} */ e) => e.intercept({ handler: () => e.scroll() });
    w.navigation.addEventListener("navigate", first);
    /** @type {Step} */
    const step = await w.__to("/news?mine=on#briefing", "#briefing");
    w.navigation.removeEventListener("navigate", first);
    return { ...step, before, after: w.__listening() };
  });
  await page.close();
  check(names[17], thrown.swapped && /InvalidState/.test(thrown.error) && thrown.after === thrown.before, JSON.stringify(thrown));

  // A full load at a heading's #fragment starts the next Tab from the heading (HTML's sequential
  // focus navigation starting point). A client navigation there from a link kept outside <main>
  // that has focus makes the heading `:target` too, but the Navigation API's focus reset after it
  // may start the next Tab at the top (Chromium's does), and no API moves that starting point: the
  // next Tab after each is in the detail only, as the guide says.
  /** @param {string} fragment @param {boolean} client */
  const tabbed = async (fragment, client) => {
    page = await open();
    await page.goto(`${base}/news${client ? "" : `?mine=on#${fragment}`}`);
    const was = await page.evaluate(
      async ([fragment, client]) => {
        const w = /** @type {any} */ (window);
        await w.__drawn();
        if (!client) return { focus: w.__focus(), target: document.querySelector(":target")?.id ?? null, swapped: false, error: "" };
        w.__marker = 1;
        /** @type {HTMLElement} */ (document.querySelector("header a[href]")).focus();
        /** @type {Step} */
        const step = await w.__to(`/news?mine=on#${fragment}`);
        return { focus: w.__focus(), target: step.target, swapped: step.swapped, error: step.error };
      },
      /** @type {const} */ ([fragment, client]),
    );
    await page.keyboard.press("Tab");
    const tab = await page.evaluate(() => /** @type {any} */ (window).__focus());
    await page.close();
    return { ...was, tab };
  };
  const [heading, headingFull] = [await tabbed("smoke-heading", true), await tabbed("smoke-heading", false)];
  check(names[12], heading.swapped && !heading.error && heading.target === "smoke-heading", JSON.stringify({ client: heading, full: headingFull }));
  // With no element to scroll to, the Navigation API's focus reset moves focus off the link. The
  // next Tab is in the detail only: in Chromium and Firefox it goes on from the link, not the top.
  const [nothing, nothingFull] = [await tabbed("smoke-nothing", true), await tabbed("smoke-nothing", false)];
  check(names[13], nothing.swapped && !nothing.error && nothing.focus === "body", JSON.stringify({ client: nothing, full: nothingFull }));

  // The reset leaves focus alone when it moved during the navigation: one moved to another header
  // link while the page loads stays there, though the fragment names nothing on the new page. An
  // answer that never reaches the route in time fails the check; the gate is opened either way, so
  // a late one goes through instead of holding the navigation.
  page = await open();
  await page.goto(`${base}/news`);
  held = gate();
  await page.evaluate(() => {
    /** @type {any} */ (window).__marker = 1;
    /** @type {HTMLElement} */ (document.querySelectorAll("header a[href]")[0]).focus();
  });
  const going = page.evaluate(() =>
    /** @type {any} */ (window).navigation.navigate("/news?mine=on&hold=1#smoke-nothing").finished.then(
      () => "",
      (/** @type {Error} */ e) => String(e),
    ),
  );
  const asked = await Promise.race([held.reached, new Promise((late) => setTimeout(() => late(false), 5000))]);
  const during = await page.evaluate(() => {
    /** @type {HTMLElement} */ (document.querySelectorAll("header a[href]")[1]).focus();
    return /** @type {any} */ (window).__focus();
  });
  held.release();
  const error = await going;
  const stayed = await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    await w.__drawn();
    return { url: location.pathname + location.search + location.hash, focus: w.__focus(), swapped: w.__marker === 1 };
  });
  await page.close();
  const gated = asked ? {} : { gate: "the navigation's answer did not reach the route within 5 seconds" };
  check(names[15], asked && !error && stayed.swapped && stayed.url.endsWith("#smoke-nothing") && stayed.focus === during && during !== "body", JSON.stringify({ ...gated, asked, during, error, ...stayed }));
}

export async function earlyNavigation(browser) {
  // A navigation started before the first document has loaded is the browser's own: a script's
  // form submit (one made from on:connect) makes Chromium stop loading the document, and a page
  // taken over then never fires load.
  const early = await browser.newPage();
  // What the browser did, for the check's detail when it fails (#232): the documents it asked
  // for and got, the frames it committed, and the loads that failed.
  /** @type {string[]} */
  const trail = [];
  const at = Date.now();
  const note = (/** @type {string} */ what) => trail.push(`${Date.now() - at}ms ${what}`);
  early.on("request", (r) => r.isNavigationRequest() && note(`request ${r.method()} ${new URL(r.url()).pathname}`));
  early.on("response", (r) => r.request().isNavigationRequest() && note(`response ${r.status()} ${new URL(r.url()).pathname}`));
  early.on("requestfailed", (r) => note(`failed ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
  early.on("framenavigated", (f) => f === early.mainFrame() && note(`committed ${new URL(f.url()).pathname}`));
  early.on("domcontentloaded", () => note("domcontentloaded"));
  early.on("load", () => note("load"));
  early.on("console", (m) => m.type() === "error" && note(`console ${m.text()}`));
  early.on("pageerror", (e) => note(`pageerror ${e.message}`));
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((/** @type {(v?: unknown) => void} */ r) => (release = r));
  await early.route("**/slow.png", async (route) => {
    await held;
    await route.fulfill({ status: 404, body: "" }).catch(() => {});
  });
  await early.addInitScript(() => {
    if (location.pathname !== "/") return;
    document.addEventListener("DOMContentLoaded", () => {
      const img = new Image();
      img.src = "/slow.png";
      document.body.append(img);
      const form = document.createElement("form");
      form.method = "get";
      form.action = "/news";
      form.hidden = true;
      document.body.append(form);
      form.requestSubmit();
    });
  });
  await early.goto(base, { waitUntil: "commit" });
  await early.waitForFunction(() => document.title === "News | Watchlist", null, { timeout: 5000 }).catch(() => {});
  release();
  await early.waitForFunction(() => /** @type {PerformanceNavigationTiming} */ (performance.getEntriesByType("navigation")[0])?.loadEventEnd > 0, null, { timeout: 5000 }).catch(() => {});
  const loaded = await early.evaluate(() => {
    const entry = /** @type {PerformanceNavigationTiming} */ (performance.getEntriesByType("navigation")[0]);
    return { path: new URL(entry.name).pathname, load: entry.loadEventEnd > 0, title: document.title };
  });
  const navigated = loaded.title === "News | Watchlist" && loaded.load;
  check(
    "a form submitted before the first page loads navigates, and the page loads",
    navigated,
    navigated ? JSON.stringify(loaded) : `${JSON.stringify(loaded)}; ${trail.join(", ")}`,
  );
  await early.close();
}
