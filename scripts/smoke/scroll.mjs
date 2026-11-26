import { base, swapped, engine, skip, check, within, steps, pollFor, cleanUp } from "./helpers.mjs";

export async function scroll(swaps, page, errors, browser, noSwaps) {
  // A filter applied on change (data-keep-place): the page changes under the user, who stays
  // where they were, on the box they checked.
  if (swaps) {
    const entry = await page.evaluate(() => navigation.currentEntry.key);
    const size = page.viewportSize();
    await page.setViewportSize({ width: 360, height: 160 });
    // The user opens both groups of the filter rail (which scrolls on its own), scrolls to the
    // box and checks it. The server draws a group open only when its box is checked.
    const rail = ".news-filter__rail";
    const groups = () => page.$$eval(`${rail} details`, (all) => all.map((d) => /** @type {HTMLDetailsElement} */ (d).open).join());
    await page.evaluate((rail) => {
      for (const group of Array.from(document.querySelectorAll(`${rail} details`))) /** @type {HTMLDetailsElement} */ (group).open = true;
      const box = /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]"));
      box.scrollIntoView({ block: "end" });
      box.focus();
    }, rail);
    // Read once the scroll has settled: Firefox rounds a scroll to a fractional place a frame later.
    const before = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(scrollY)))));
    const railBefore = await page.$eval(rail, (r) => r.scrollTop);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => location.search === "?mine=on" && document.getElementById("stories-title")?.textContent === "Stories about your stocks");
    const after = await page.evaluate(() => ({
      y: scrollY,
      focused: document.activeElement?.getAttribute("name"),
      checked: /** @type {HTMLInputElement} */ (document.activeElement).checked,
      marker: (/** @type {any} */ (window)).__marker,
    }));
    const railAfter = await page.$eval(rail, (r) => r.scrollTop);
    check("the rail keeps its own scroll", railBefore > 0 && railAfter === railBefore, `${railBefore} -> ${railAfter}`);
    check("a group the user opened stays open though the server drew it closed", (await groups()) === "true,true", await groups());
    check("a data-keep-place form swaps the page in place", after.marker === 1, JSON.stringify(after));
    check("it keeps the scroll position", before > 0 && after.y === before, `${before} -> ${after.y}`);
    check("focus stays on the control the user changed", after.focused === "mine" && after.checked, JSON.stringify(after));
    await page.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]")).focus());
    await page.keyboard.press("Space");
    await page.waitForFunction(() => location.search === "");
    check("unchecking applies again, focus still on it", await page.evaluate(() => document.activeElement?.getAttribute("name") === "mine" && scrollY > 0));
    check("the group of the box unchecked stays open, so focus is not lost to the body", (await groups()) === "true,true", await groups());
    // Clicked from the page, so Playwright does not scroll to the link first.
    await page.evaluate(() => /** @type {HTMLAnchorElement} */ (document.querySelector(`header a[href="/news"]`)).click());
    await page.waitForFunction(() => location.search === "" && location.href.endsWith("/news") && scrollY === 0, null, { timeout: 5000 }).catch(() => {});
    check("a plain link still goes to the top", await page.evaluate(() => scrollY === 0));
    // A write that sends the browser back to a place on the page (`News { .. }.at(BriefingId)`,
    // below the fold): the address keeps `#briefing`, the page is fetched again and the form is in
    // view. A second time, when only the `#id` matches the address, the page is still fetched again.
    {
      let loads = 0;
      const onNews = (/** @type {import("@playwright/test").Request} */ r) => r.method() === "GET" && new URL(r.url()).pathname === "/news" && loads++;
      page.on("request", onNews);
      const back = () =>
        page
          .waitForFunction(() => {
            const form = document.getElementById("briefing");
            const top = form?.getBoundingClientRect().top ?? -1;
            // Layout in fractions of a pixel can leave the top a fraction above the scroll position.
            return location.hash === "#briefing" && !document.querySelector("main[aria-busy]") && scrollY > 0 && top > -1 && top < innerHeight;
          }, null, { timeout: 5000 })
          .then(() => true, () => false);
      const thank = () =>
        page.evaluate(() => {
          /** @type {HTMLInputElement} */ (document.querySelector("#briefing [name=email]")).value = "ada@example.com";
          /** @type {HTMLButtonElement} */ (document.querySelector("#briefing button")).click();
        });
      await page.evaluate(() => {
        (/** @type {any} */ (window)).__notices = 0;
        document.addEventListener("corten:notice", () => (/** @type {any} */ (window)).__notices++);
      });
      // The page a write sends the browser to is fetched whole, as a full load reads it, and what
      // the write changed in the layout around <main> is drawn again: here the header, changed on
      // its way so the write has something to change.
      /** @param {URL} url */
      const news = (url) => url.pathname === "/news";
      // What the route changes in the page: the brand in the header, a banner before the header (a run
      // of another length), an attribute of <html>.
      let [banner, frame] = ["", ""];
      // Later checks: the section stylesheet's address made new, so it loads before the page is
      // drawn (`late`); a read-again tag in the page and its navigation answers (`readAgain`); the
      // whole page held back until `slow` settles.
      let [late, readAgain] = [false, false];
      /** @type {Promise<unknown> | null} */
      let slow = null;
      // The page's notice marked as not drawn, so the runtime dispatches it (`undrawn`).
      let undrawn = false;
      // The brand the write's page draws in the header.
      let brandNow = "Watchlist, again";
      const readAgainTag = '<noscript data-corten-read-again="1" data-corten-head><meta http-equiv="refresh" content="1"></noscript>';
      // A module preload in the head of the page the write sends the browser to, as the server
      // writes for a handler module's imports: the runtime fetches it when it swaps the page in.
      /** @type {string[]} */
      const probed = [];
      const onProbe = (/** @type {import("@playwright/test").Request} */ r) => void (r.url().endsWith("?swap-preload") && probed.push(r.url()));
      page.on("request", onProbe);
      /** @param {import("@playwright/test").Route} route */
      const drawNews = async (route) => {
        const nav = swapped(route.request());
        if (route.request().method() !== "GET" || nav) return route.fallback();
        // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
        const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        const headers = res.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        let body = await res.text();
        if (readAgain) body = body.replace("</title>", `</title>${readAgainTag}`);
        if (undrawn && headers["corten-notice"]) {
          const notice = new URLSearchParams(headers["corten-notice"]);
          notice.delete("d");
          headers["corten-notice"] = notice.toString();
        }
        // A layout whose <title> is not first in its head (#680): the reads again compare the same.
        if (readAgain && !nav) body = body.replace(/(<title>[^<]*<\/title>)([\s\S]*?)(<\/head>)/, "$2$1$3");
        if (!nav) {
          body = body
            .replace(">Watchlist</span>", `>${brandNow}</span>`)
            .replace("<header", `${banner}<header`)
            .replace("<html", `<html${frame}`)
            // After the import map, as the server writes its preloads: a module fetched before it
            // would leave "corten" unmapped on a full load of this answer (a back navigation).
            .replace("</head>", `<link rel="modulepreload" href="${/<meta name="corten-scripts" content="([^"]+)">/.exec(body)?.[1]}live_prices.js?swap-preload"></head>`);
          if (late) body = body.replace(/<link\b[^>]*\bdata-corten-style\b[^>]*>/, (tag) => tag.replace(/href="([^"]+)"/, 'href="$1?late=1"'));
          if (slow) await slow;
        }
        await route.fulfill({ status: res.status(), headers, body }).catch(() => {});
      };
      await page.route(news, drawNews);
      /**
       * Lets go of the page held back and removes the News page's route and listeners, each even
       * when removing another fails: at the end, and before a case that could not get back to the
       * News page stops the smoke.
       */
      const leaveNews = () => {
        slow = null;
        return cleanUp(
          () => page.off("request", onNews),
          () => page.off("request", onProbe),
          () => page.unroute(news, drawNews),
        );
      };
      // Something a script put beside <main> is not the layout's, and stays.
      await page.evaluate(() => document.body.append(Object.assign(document.createElement("div"), { id: "extension" })));
      await thank();
      const first = await back();
      check("a redirect to a place keeps its #id and scrolls to it", first && loads === 1, `${await page.evaluate(() => [location.href, scrollY])} loads ${loads}`);
      // Scrolled by the browser's scroll to the fragment, which makes the place the page's target.
      const target = () => page.evaluate(() => document.querySelector(":target")?.id ?? null);
      check("the place a write's redirect names matches :target", (await target()) === "briefing", `${await target()}`);
      const brand = await page.evaluate(() => document.querySelector("header span")?.textContent);
      check("a write's page draws the layout again, in the same document", brand === "Watchlist, again" && (await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1)), brand ?? "");
      check("a write's page fetches the module preloads in its head", probed.length > 0, probed.join());
      check("what a script put beside <main> stays", await page.evaluate(() => !!document.getElementById("extension")));
      // The write's notice (`req.redirect_with_notice`): the page draws it, so the runtime does
      // not hand it on too, the address carries nothing for it, and it is gone once read.
      const notices = ["the page it redirected to says what the write did", "a notice the page drew is not dispatched as well", "the notice is said once"];
      if (engine !== "webkit") {
        const said = await page.evaluate(() => document.querySelector("#briefing [role=status]")?.textContent ?? "");
        check(notices[0], said === "You're on the list for the morning briefing." && new URL(page.url()).search === "", `${said} ${page.url()}`);
        check(notices[1], (await page.evaluate(() => (/** @type {any} */ (window)).__notices)) === 0);
      } else for (const name of notices) skip(name, "Playwright's WebKit never sends a Secure cookie back over http");
      // The same header again: the element stays as it is, not replaced.
      await page.evaluate(() => {
        scrollTo(0, 0);
        (/** @type {any} */ (document.querySelector("header"))).__same = 1;
      });
      await thank();
      const second = await back();
      check("the same place again fetches the page again", second && loads === 2, `loads ${loads}`);
      // Firefox's scroll to the fragment sets `:target` only the first time in a document.
      if (engine === "firefox") skip("the same place again matches :target", "Firefox's NavigateEvent.scroll() sets it only for a document's first #fragment");
      else check("the same place again matches :target", (await target()) === "briefing", `${await target()}`);
      check("both kept the document", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1));
      check("a layout element the write did not change stays the same element", await page.evaluate(() => (/** @type {any} */ (document.querySelector("header"))).__same === 1));
      // A patch inside the header (a cart count) changes it from what the server drew, so the next
      // write's page draws it again even when that page's header is the one drawn before.
      await page.evaluate(async () => {
        scrollTo(0, 0);
        const brand = /** @type {HTMLElement} */ (document.querySelector("header span"));
        brand.id = "smoke-brand";
        const corten = /** @type {typeof import("../crates/corten/js/corten.js")} */ (await import(/** @type {string} */ ("corten")));
        await corten.patch(__html('<span id="smoke-brand">Patched</span>'));
      });
      await thank();
      await back();
      const redrawn = await page.evaluate(() => document.querySelector("header span")?.textContent);
      check("a layout element a patch changed is drawn again by the next write", redrawn === "Watchlist, again", redrawn ?? "");
      // A notice the page did not draw is the runtime's `corten:notice` on the document, which an
      // element's on:document:corten:notice hears (here one beside <main>, which stays).
      const heardName = "on:document:corten:notice runs for a notice the page did not draw";
      if (engine !== "webkit") {
        await page.evaluate(() => {
          scrollTo(0, 0);
          const host = document.createElement("div");
          host.id = "notice-heard";
          host.innerHTML = __html('<p hidden data-on="document.corten:notice:watch_form.failed($t)"></p>');
          document.body.append(host);
        });
        undrawn = true;
        await thank();
        await back();
        undrawn = false;
        const heard = await page.evaluate(() => {
          const shown = document.querySelector("#notice-heard p")?.hasAttribute("hidden") === false;
          document.getElementById("notice-heard")?.remove();
          // Counted from here on by the checks that a drawn notice is not dispatched.
          (/** @type {any} */ (window)).__notices = 0;
          return shown;
        });
        check(heardName, heard);
      } else skip(heardName, "Playwright's WebKit never sends a Secure cookie back over http");
      // Pages require Trusted Types, so markup a script builds from a string is refused, by the
      // runtime's patch as by any other sink: what the runtime fetched is all its policy lets in.
      {
        const logged = errors.length;
        // Firefox logs the refusal after the call has thrown: wait for it before leaving it out.
        const said = page.waitForEvent("console", { predicate: (m) => /trusted/i.test(m.text()), timeout: 3000 }).catch(() => {});
        const refused = await page.evaluate(async () => {
          // Deliberately bypass patch's TrustedHTML type to exercise the browser's refusal too.
          const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
          const brand = /** @type {HTMLElement} */ (document.querySelector("header span"));
          brand.id = "smoke-brand";
          const outcome = await corten.patch('<span id="smoke-brand">From a string</span>').then(() => "applied", (/** @type {unknown} */ e) => (e instanceof TypeError ? "refused" : String(e)));
          brand.removeAttribute("id");
          return [outcome, brand.textContent];
        });
        check("a script's string is refused by the runtime's patch", refused[0] === "refused" && refused[1] === "Watchlist, again", refused.join(", "));
        await said;
        errors.splice(logged, errors.length, ...errors.slice(logged).filter((e) => !/TrustedHTML|Trusted Type|trusted-types/i.test(e)));
      }
      // A patch that lands after the write's page came and before it is drawn (here while the
      // stylesheet it links loads) is newer than the page: the element keeps it.
      {
        const lateStyle = (/** @type {URL} */ url) => url.searchParams.has("late");
        let patchedLate = false;
        await page.route(lateStyle, async (route) => {
          await page.evaluate(async () => {
            const corten = /** @type {typeof import("../crates/corten/js/corten.js")} */ (await import(/** @type {string} */ ("corten")));
            await corten.patch(__html('<span id="smoke-brand">Late</span>'));
          });
          patchedLate = true;
          const url = new URL(route.request().url());
          url.searchParams.delete("late");
          await route.fulfill({ response: await route.fetch({ url: url.href }) });
        });
        await page.evaluate(() => {
          scrollTo(0, 0);
          /** @type {HTMLElement} */ (document.querySelector("header span")).id = "smoke-brand";
        });
        // The write's page draws another header, which the patch is newer than.
        [late, brandNow] = [true, "Watchlist, late"];
        await thank();
        await back();
        [late, brandNow] = [false, "Watchlist, again"];
        await page.unroute(lateStyle);
        const kept = await page.evaluate(() => document.querySelector("header span")?.textContent);
        check("a patch that lands while the write's page is drawn is kept", patchedLate && kept === "Late", `patched ${patchedLate}, ${kept}`);
      }
      // A page the write sent the browser to that reads itself again (ReadAgain) reads the whole
      // page, as a browser without JavaScript does: a read with nothing new leaves the page as it
      // is, with what the user typed, and one whose layout changed draws it (#690).
      {
        /** @param {import("@playwright/test").Request} r */
        const wholeRead = (r) => news(new URL(r.url())) && r.method() === "GET" && !swapped(r);
        let reads = 0;
        /** The notice each read again sent back. @type {(string | undefined)[]} */
        const sentBack = [];
        const onRead = (/** @type {import("@playwright/test").Request} */ r) => {
          if (!wholeRead(r)) return;
          reads++;
          sentBack.push(r.headers()["corten-notice"]);
        };
        page.on("request", onRead);
        readAgain = true;
        await page.evaluate(() => scrollTo(0, 0));
        await thank();
        await back();
        await page.evaluate(() => {
          (/** @type {any} */ (document.querySelector("main")?.firstElementChild)).__same = 1;
          /** @type {HTMLInputElement} */ (document.querySelector("#briefing [name=email]")).value = "typed@example.com";
        });
        await page.waitForFunction(() => document.head.querySelector("noscript[data-corten-read-again]"), null, { timeout: 5000 }).catch(() => {});
        const read = await page.waitForEvent("requestfinished", { predicate: wholeRead, timeout: 5000 }).then(() => true, () => false);
        await page.waitForTimeout(300);
        const stayed = await page.evaluate(() => ({
          same: (/** @type {any} */ (document.querySelector("main")?.firstElementChild))?.__same === 1,
          typed: /** @type {HTMLInputElement | null} */ (document.querySelector("#briefing [name=email]"))?.value,
        }));
        check("a write's page read again with nothing new stays as it is", read && stayed.same && stayed.typed === "typed@example.com", `read ${read} ${JSON.stringify(stayed)}`);
        // The write's notice the page drew is sent back with the read, which draws it again, so it
        // stays on the page (#641).
        const keptNotice = "a write's page read again keeps the notice it drew";
        if (engine !== "webkit") {
          const said = await page.evaluate(() => document.querySelector("#briefing [role=status]")?.textContent ?? "");
          const text = "You're on the list for the morning briefing.";
          const asked = sentBack.at(-1) === new URLSearchParams({ p: "/news", m: text }).toString();
          check(keptNotice, said === text && asked && (await page.evaluate(() => (/** @type {any} */ (window)).__notices)) === 0, `${said} ${JSON.stringify(sentBack)}`);
        } else skip(keptNotice, "Playwright's WebKit never sends a Secure cookie back over http");
        // What the layout could not read yet when the write's page came (a cart count) is drawn
        // when a read again finds it, keeping what the user typed.
        brandNow = "Watchlist, read";
        const counted = await page
          .waitForFunction(() => document.querySelector("header span")?.textContent === "Watchlist, read", null, { timeout: 5000 })
          .then(() => true, () => false);
        const typed = await page.evaluate(() => /** @type {HTMLInputElement | null} */ (document.querySelector("#briefing [name=email]"))?.value);
        check("a write's page read again draws what changed in its layout", counted && typed === "typed@example.com" && (await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1)), `${counted} ${typed}`);
        brandNow = "Watchlist, again";
        // The next answer has no read-again tag: it differs, is swapped in, and the reads stop.
        readAgain = false;
        const gone = await page
          .waitForFunction(() => !document.head.querySelector("noscript[data-corten-read-again]"), null, { timeout: 5000 })
          .then(() => true, () => false);
        const settled = reads;
        await page.waitForTimeout(1500);
        page.off("request", onRead);
        check("reading again stops once the page no longer asks", gone && reads === settled, `tag gone ${gone}, ${reads - settled} more reads`);
      }
      // A navigation the user starts before the write's page comes reads the whole page, so what
      // the write changed in the layout is drawn there too. The write's page is held until that
      // navigation's request is out, so the navigation starts first however slowly it comes (#2014).
      // The case requires the write's request, then the navigation's request, read whole, and the
      // Stocks page drawn in the same document (its title, and its watch form in <main>, which the
      // runtime puts there after the title), each within 5 s (a result after them failing). Each press
      // and the wait for the request it sends share those 5 s, so a press that stalls fails the case
      // too. A case without one fails and does no more work on its page: the next case starts from
      // the News page it left, gone back to by its history entry within 10 s: from a page that has
      // loaded, to a News page that has loaded, which may load in full on the way (a read of the page
      // that fails while it loads is not yet an answer). A case that stops before its first press has
      // not left the News page and does not go back. A page that does not get back in that time stops
      // the smoke, once the route and the listeners are removed.
      {
        const name = "a navigation started before a write's page comes reads the whole page";
        /** @type {string[]} */
        const asked = [];
        const stocks = (/** @type {import("@playwright/test").Request} */ r) => r.method() === "GET" && new URL(r.url()).pathname === "/";
        const onStocks = (/** @type {import("@playwright/test").Request} */ r) => stocks(r) && asked.push(swapped(r) ? r.headers()["corten"] : "whole");
        /**
         * Presses with `press` and waits for the request it sends, both within 5 s: the request, or
         * why the case stops (a press that threw says so, whether or not its request went).
         * @param {string} what @param {(r: import("@playwright/test").Request) => boolean} sent @param {() => Promise<unknown>} press
         */
        const pressFor = async (what, sent, press) => {
          /** @type {import("@playwright/test").Request | null} */
          let got = null;
          /** How the press ended: null while it runs, "" once it returned, or why it threw. @type {string | null} */
          let pressed = null;
          await within(
            5000,
            `the press that asked for ${what} and its request not done within 5 s`,
            Promise.all([
              page.waitForRequest(sent, { timeout: 5000 }).then((r) => (got = r)),
              press().then(
                () => (pressed = ""),
                (error) => {
                  pressed = `the press that asked for ${what} threw: ${(error instanceof Error ? error.message.split("\n")[0] : String(error)) || "no message"}`;
                  throw error;
                },
              ),
            ]),
          ).catch(() => {});
          if (pressed) return pressed;
          if (!got) return `no request for ${what} within 5 s`;
          return pressed === "" ? got : `the press that asked for ${what} did not return within 5 s`;
        };
        let release = () => {};
        /** Where the case stopped, if it did. */
        let stopped = "";
        /** The News page's history entry, which the next case starts from. @type {string | null} */
        let left = null;
        /** Whether a press was made: before the first, the page has not left the News page. */
        let began = false;
        // The listener and the hold go however the case ends.
        page.on("request", onStocks);
        try {
          try {
            slow = new Promise((resolve) => (release = () => resolve(undefined)));
            left = await within(
              5000,
              "the News page's history entry not read within 5 s",
              page.evaluate(() => (scrollTo(0, 0), navigation.currentEntry?.key ?? "")),
            );
            began = true;
            const wrote = await pressFor("the write's page", (r) => news(new URL(r.url())) && !swapped(r), thank);
            if (typeof wrote === "string") stopped = wrote;
            else {
              asked.length = 0;
              const navigated = await pressFor("the Stocks page", stocks, () =>
                page.evaluate(() => /** @type {HTMLAnchorElement} */ (document.querySelector('header a[href="/"]')).click()),
              );
              if (typeof navigated === "string") stopped = navigated;
              else if (swapped(navigated) || asked[0] !== "whole") stopped = `the Stocks page asked for as ${asked.join() || "nothing"}, not whole`;
            }
          } catch (error) {
            stopped ||= error instanceof Error && error.message ? error.message.split("\n")[0] : "the case's setup failed";
          } finally {
            slow = null;
            release();
          }
          if (
            !stopped &&
            !(await pollFor(5000, () =>
              page.evaluate(() => document.title === "Stocks | Watchlist" && !!document.querySelector("main #watch-form") && (/** @type {any} */ (window)).__marker === 1),
            ))
          )
            stopped = "the Stocks page not drawn in the same document within 5 s";
        } finally {
          page.off("request", onStocks);
        }
        check(name, !stopped, stopped || `asked ${asked.join()}`);
        // Back to the News page, in 10 s: by its entry after a failure, by its link after a pass, and
        // not at all when the case stopped before its first press, as the page never left it.
        const back = steps(10_000, "not back on the News page within 10 s");
        /**
         * A read of the page for `back.poll`: one that fails, or takes over 2 s, while a page loads
         * is not yet an answer, and the 10 s still bound them all.
         * @param {() => boolean} probe
         */
        const read = (probe) => within(2000, "the page not read within 2 s", page.evaluate(probe)).catch(() => false);
        const atNews =
          !began ||
          (await (async () => {
            if (stopped) {
              if (!left) return back.end("the News page's history entry was not read");
              const entry = left;
              // From a page that has loaded, as the runtime handles navigations only then: a Stocks
              // page loaded in full and gone back from while it still loads keeps its own content at
              // the News page's address. The traverse is started, not awaited, as the poll below says
              // whether the page got back, and a read made as its document goes is lost with it,
              // which is not a failure.
              await back.poll(() => read(() => document.readyState === "complete"));
              await back.step(() =>
                page
                  .evaluate((key) => {
                    const { committed, finished } = navigation.traverseTo(key);
                    committed.catch(() => {});
                    finished.catch(() => {});
                  }, entry)
                  .catch((error) => {
                    if (!(error instanceof Error && error.message.includes("Execution context was destroyed"))) throw error;
                  }),
              );
            } else await back.step(() => page.evaluate(() => /** @type {HTMLAnchorElement} */ (document.querySelector('header a[href="/news"]')).click()));
            // Loaded too, after a way back that loads it in full: the next case's write is the runtime's.
            return back.poll(() => read(() => document.readyState === "complete" && document.title === "News | Watchlist" && !!document.getElementById("briefing")));
          })().then(
            () => true,
            () => false,
          ));
        if (!atNews) {
          await leaveNews().catch(() => {});
          throw new Error(`${name}: ${back.over}, so the cases after it cannot run`);
        }
      }
      // More elements around <main>, or another attribute on an element around it: the page loads in
      // full, as the server draws it.
      for (const [name, change] of /** @type {const} */ ([
        ["a write's page with more elements around <main> loads in full", () => (banner = '<p id="banner">Closed Monday</p>')],
        ["a write's page whose <html> differs loads in full", () => (frame = ' data-theme="dark"')],
      ])) {
        change();
        await page.evaluate(() => {
          scrollTo(0, 0);
          (/** @type {any} */ (window)).__marker = 4;
        });
        await thank();
        await page.waitForFunction(() => (/** @type {any} */ (window)).__marker === undefined && document.getElementById("briefing"), null, { timeout: 10000 }).catch(() => {});
        // The full load's runtime listens only once the document has loaded: a form sent before
        // that posts natively, and the page its redirect lands on is not the one this route draws.
        await page.waitForLoadState("load");
        const drawnNow = await page.evaluate(() => ({ marker: (/** @type {any} */ (window)).__marker, banner: !!document.getElementById("banner"), theme: document.documentElement.getAttribute("data-theme") }));
        check(name, drawnNow.marker === undefined && drawnNow.banner && (frame === "" || drawnNow.theme === "dark"), JSON.stringify(drawnNow));
      }
      await leaveNews();
      // After the loads are counted: the page that drew the notice removed it.
      if (engine !== "webkit") check("the notice is said once", !(await page.evaluate(async () => (await (await fetch("/news")).text()).includes("on the list"))));
      // A browser extension that marks <html> and adds to <head> before the runtime starts (a
      // dark-mode extension) is in the frame the first write's page is compared with: the write
      // still swaps its page into the same document, with one request.
      const extensionCheck = "a write on a page a script and an extension marked before the runtime started keeps the document and the marks";
      if (engine !== "webkit") {
        const marked = await (await browser.newContext()).newPage();
        await marked.addInitScript(() => {
          new MutationObserver((_, seen) => {
            if (!document.head) return;
            document.documentElement.setAttribute("data-darkreader-scheme", "dark");
            // A blocking theme script's choice, which no page the server writes carries.
            document.documentElement.setAttribute("data-theme", "dark");
            document.head.append(Object.assign(document.createElement("style"), { className: "darkreader" }));
            seen.disconnect();
          }).observe(document, { childList: true, subtree: true });
        });
        await marked.goto(`${base}/news`);
        let documents = 0;
        marked.on("request", (r) => r.resourceType() === "document" && documents++);
        await marked.evaluate(() => {
          (/** @type {any} */ (window)).__marker = 1;
          /** @type {HTMLInputElement} */ (document.querySelector("#briefing [name=email]")).value = "ada@example.com";
          /** @type {HTMLButtonElement} */ (document.querySelector("#briefing button")).click();
        });
        const said = await marked
          .waitForFunction(() => document.querySelector("#briefing [role=status]")?.textContent === "You're on the list for the morning briefing.", null, { timeout: 5000 })
          .then(() => true, () => false);
        const kept = await marked.evaluate(() => (/** @type {any} */ (window)).__marker === 1);
        // What the script and the extension put there before the runtime started is still there.
        const marks = await marked.evaluate(() => ({
          theme: document.documentElement.getAttribute("data-theme"),
          scheme: document.documentElement.getAttribute("data-darkreader-scheme"),
          style: !!document.head.querySelector("style.darkreader"),
        }));
        const stays = marks.theme === "dark" && marks.scheme === "dark" && marks.style;
        check(extensionCheck, said && kept && stays && documents === 0, `said ${said}, kept ${kept}, marks ${JSON.stringify(marks)}, document requests ${documents}`);
        await marked.context().close();
      } else skip(extensionCheck, "no Navigation API: navigations are full page loads");
    }
    if (size) await page.setViewportSize(size);
    // Back over the entries this added (checked, unchecked, the link, the place, and each write's
    // page) to the news page the watchlist led to, by its key rather than a count.
    await page.evaluate((key) => navigation.traverseTo(key).finished.catch(() => {}), entry);
    await page.waitForFunction((key) => navigation.currentEntry.key === key && !document.querySelector("main[aria-busy]"), entry);
  } else {
    for (const name of [
      "a data-keep-place form swaps the page in place",
      "it keeps the scroll position",
      "focus stays on the control the user changed",
      "the rail keeps its own scroll",
      "a group the user opened stays open though the server drew it closed",
    ])
      skip(name, noSwaps);
  }
  // The rail scrolled in the same frame as the change, so the swap lands before the `scroll` event
  // that would name it (a slow machine, or a control focus scrolled into view): it keeps its scroll
  // all the same. In a page of its own, so this page's history stays as it is.
  if (swaps) {
    const quick = await browser.newPage({ viewport: { width: 360, height: 160 } });
    await quick.goto(`${base}/news`);
    const top = await quick.evaluate(() => {
      const rail = /** @type {Element} */ (document.querySelector(".news-filter__rail"));
      for (const group of Array.from(rail.querySelectorAll("details"))) /** @type {HTMLDetailsElement} */ (group).open = true;
      const box = /** @type {HTMLInputElement} */ (document.querySelector("main input[name=mine]"));
      box.scrollIntoView({ block: "end" });
      box.focus();
      box.click();
      return rail.scrollTop;
    });
    await quick.waitForFunction(() => location.search === "?mine=on" && document.getElementById("stories-title")?.textContent === "Stories about your stocks");
    const after = await quick.$eval(".news-filter__rail", (r) => r.scrollTop);
    check("the rail keeps a scroll made in the same frame as the change", top > 0 && after === top, `${top} -> ${after}`);
    await quick.close();
  } else skip("the rail keeps a scroll made in the same frame as the change", noSwaps);
}
