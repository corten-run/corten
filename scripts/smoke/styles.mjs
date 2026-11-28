import { base, skip, check, steps } from "./helpers.mjs";

export async function styles(browser, errors, swaps, noSwaps) {
  // A data-patch form on a page outside an area whose handler is in it (Area::components): the
  // patch links the area's stylesheet, which the runtime loads before it puts the patch in place,
  // as a navigation into the area does. One that fails to load leaves the patch in place
  // unstyled, and the next patch that links it tries again.
  {
    const styled = await browser.newPage();
    styled.on("pageerror", (e) => errors.push(`styled patch: ${e.message}`));
    // What the runtime says of the patch (a runtime that does not take the link out of the patch
    // says it has no id); the failed load is the browser's, not the runtime's.
    const said = /** @type {string[]} */ ([]);
    styled.on("console", (m) => m.type() === "error" && m.text().startsWith("corten:") && said.push(m.text()));
    await styled.goto(base);
    await styled.evaluate(() =>
      document
        .querySelector("main")
        ?.insertAdjacentHTML("beforeend", __html('<form id="styled-form" method="post" action="/smoke/styled" data-patch><button>Save</button></form>')),
    );
    // The note's border the moment the patch puts it in the page, and the area links then.
    const save = async () => {
      await styled.evaluate(() => {
        document.getElementById("styled-note")?.remove();
        document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<p id="styled-note"></p>'));
        const at = /** @type {any} */ (window);
        at.__styled = null;
        new MutationObserver((_, observer) => {
          const note = document.querySelector(".styled-note__note");
          if (!note) return;
          at.__styled = `${note.textContent} ${getComputedStyle(note).borderInlineStartWidth}`;
          observer.disconnect();
        }).observe(document.body, { childList: true, subtree: true });
      });
      // A click on the button itself, not at a point: the watchlist is still drawing its prices
      // below the form's place, and a click at the button's point can land beside it once they
      // move it (Firefox under load: mousedown on the button, the click on <main>, nothing sent).
      await styled.dispatchEvent("#styled-form button", "click");
      const drawn = await styled
        .waitForFunction(() => (/** @type {any} */ (window)).__styled, undefined, { timeout: 5000 })
        .then((got) => got.jsonValue(), () => "not drawn");
      const links = await styled.$$eval('link[data-corten-style][href*="/sections/smoke"]', (all) => all.length);
      return `${drawn}, ${links} link`;
    };
    check("a page outside an area links none of its stylesheets", (await styled.$$eval("link[data-corten-style]", (all) => all.length)) === 0);
    await styled.route("**/sections/**", (route) => route.abort("internetdisconnected"));
    const failed = await save();
    check(
      "a patch whose area stylesheet fails to load is put in place unstyled, the link taken out",
      failed === "Saved 0px, 0 link" && said.length === 0,
      [failed, ...said].join("; "),
    );
    await styled.unroute("**/sections/**");
    const first = await save();
    check("a patch from another area's handler loads that area's stylesheet before it is put in place", first === "Saved 5px, 1 link", first);
    const second = await save();
    check("the next patch from that area does not link its stylesheet again", second === "Saved 5px, 1 link" && said.length === 0, [second, ...said].join("; "));
    await styled.close();
  }
  // Two patches that link a stylesheet still loading: the second waits for the same load rather
  // than take the link the first put in the head for a loaded stylesheet.
  {
    const raced = await browser.newPage();
    raced.on("pageerror", (e) => errors.push(`raced patches: ${e.message}`));
    await raced.goto(base);
    await raced.route("**/sections/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    const drawn = await raced.evaluate(async () => {
      const { patch } = await import("corten");
      const answer = await fetch("/smoke/styled", { method: "POST", headers: { corten: "action" } }).then((r) => r.text());
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<p id="styled-note"></p>'));
      // The note's border each time a patch puts it in the page.
      const seen = /** @type {string[]} */ ([]);
      const observer = new MutationObserver(() => {
        const note = document.querySelector(".styled-note__note");
        if (note) seen.push(getComputedStyle(note).borderInlineStartWidth);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      await Promise.all([patch(__html(answer)), patch(__html(answer))]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      observer.disconnect();
      return `${seen.join(" ")}, ${document.head.querySelectorAll('link[data-corten-style][href*="/sections/smoke"]').length} link`;
    });
    check("a patch sent while another's area stylesheet is loading waits for that load", /^5px( 5px)*, 1 link$/.test(drawn), drawn);
    await raced.close();
  }
  // A navigation into an area while a patch's load of the area's stylesheet is in flight shares
  // that load, rather than take the link the patch put in the head for a loaded stylesheet: the
  // news area's Load more patch, sent on the home page, then a link to the news. The patch's
  // request for its one stylesheet is held until the runtime has read the navigation's answer, so
  // the navigation meets that load still out however slowly each step comes (#2014). The runtime
  // reads the answer with `text()` and looks up its stylesheets in the same task, and the page
  // notes the read a task later, so the lookup has been made once the note is there. The page
  // must not swap while the stylesheet is held, nor the browser request it again.
  // Then the load succeeds, and a probe with the news area's class, outside <main>, shows its rules
  // applied when the page swapped; or it fails, and the navigation loads the page in full, as one
  // whose own stylesheet fails does. A navigation that took the patch's link for a loaded
  // stylesheet swaps the page in unstyled instead. Unlike the probe's border, that outcome does not
  // depend on whether the page's handler modules, which also hold the swap, come before or after
  // the stylesheet. The steps before the release share 15 s, and each arm after it 10 s; a step
  // that fails, runs out of that time or settles after it fails the case, and no page work starts
  // after it. A handle a wait returns is read in a step of its own. The stylesheet is released
  // however the steps before it end, and the page is closed however the case ends.
  /** @param {boolean} fails */
  const sharedLoad = async (fails) => {
    const name = fails
      ? "a navigation into an area while a patch's load of its stylesheet fails loads the page in full"
      : "a navigation into an area while a patch is loading its stylesheet waits for that load";
    const entered = await browser.newPage();
    // Closed however the case ends, which takes its route with it.
    try {
      entered.on("pageerror", (e) => errors.push(`navigation during a patch's load: ${e.message}`));
      await entered.goto(base);
      /** The stylesheet the patch links, by its URL. */
      let sheet = "";
      /** The page's requests for it: all of them, and those before the release. */
      let requested = 0;
      let requestedHeld = 0;
      let asked = () => {};
      const patchAsked = new Promise((resolve) => (asked = () => resolve(undefined)));
      let release = () => {};
      const held = new Promise((resolve) => (release = () => resolve(undefined)));
      /** Holds the first request for the patch's stylesheet; a page loaded in full asks again. @param {import("@playwright/test").Route} route */
      const hold = async (route) => {
        requested += 1;
        if (requested > 1) return route.continue().catch(() => {});
        asked();
        await held;
        // The page may have closed by the time a failed case releases it.
        await (fails ? route.abort("internetdisconnected") : route.continue()).catch(() => {});
      };
      /** The probe's border if the page swapped while the stylesheet was held. @type {string | null} */
      let early = null;
      const setup = steps(15_000, "the patch's load or the navigation's read took over 15 s");
      try {
        sheet = await setup.step(() =>
          entered.evaluate(async () => {
            const answer = await fetch("/news?shown=3", { headers: { corten: "action" } }).then((r) => r.text());
            /** @type {any} */ (window).__answer = answer;
            const parsed = document.createElement("template");
            parsed.innerHTML = __html(answer);
            const links = Array.from(parsed.content.querySelectorAll("link[data-corten-style]"), (link) => new URL(link.getAttribute("href") ?? "", location.href).href);
            return links.length === 1 ? links[0] : `${links.length} stylesheets`;
          }),
        );
        if (!sheet.startsWith("http")) setup.end(`the patch links ${sheet}`);
        await setup.step(() => entered.route((url) => url.href === sheet, hold));
        await setup.step(() =>
          entered.evaluate(async () => {
            const { patch } = await import("corten");
            // The elements the patch replaces, outside <main> so the swap leaves them.
            const stories = document.createElement("ul");
            stories.id = "stories";
            const more = document.createElement("form");
            more.id = "load-more";
            const probe = document.createElement("p");
            probe.className = "disclaimer__note";
            document.body.append(stories, more, probe);
            const at = /** @type {any} */ (window);
            // Gone if the page loads in full.
            at.__sameDocument = true;
            at.__entered = null;
            new MutationObserver((_, observer) => {
              if (document.querySelector("main h1")?.textContent !== "Market news") return;
              at.__entered = getComputedStyle(probe).borderInlineStartWidth;
              observer.disconnect();
            }).observe(document.body, { childList: true, subtree: true });
            // Not awaited: the navigation starts while this patch's stylesheet is still loading.
            patch(__html(at.__answer)).catch(() => {});
          }),
        );
        await setup.step(() => patchAsked);
        await setup.step(() =>
          entered.evaluate(() => {
            const at = /** @type {any} */ (window);
            at.__read = false;
            const text = Response.prototype.text;
            const news = new URL("/news", location.href).href;
            at.__restoreText = () => (Response.prototype.text = text);
            Response.prototype.text = function () {
              const read = text.call(this);
              if (this.url === news) {
                at.__restoreText();
                read.then(() => setTimeout(() => (at.__read = true)), () => {});
              }
              return read;
            };
            /** @type {HTMLAnchorElement} */ (document.querySelector('header a[href="/news"]')).click();
          }),
        );
        // Polled on a timer: a loaded browser may not be delivering animation frames.
        await setup.step(() => entered.waitForFunction(() => (/** @type {any} */ (window)).__read, undefined, { timeout: 10_000, polling: 50 }));
        early = await setup.step(() => entered.evaluate(() => (/** @type {any} */ (window)).__entered));
      } catch {
        // Its reason is the setup's.
      } finally {
        requestedHeld = requested;
        release();
      }
      const whileHeld = `${setup.over ? `${setup.over}; ` : ""}${early === null ? "" : `swapped while held: ${early}; `}requested ${requestedHeld} times while held`;
      // A step that failed or ran out of time may still be running in the page: the case fails, and
      // the page is closed rather than used again.
      if (setup.over) {
        check(name, false, whileHeld);
        return;
      }
      const after = steps(10_000, "the page did not end its navigation within 10 s");
      if (!fails) {
        let seen = "";
        try {
          const drawn = await after.step(() => entered.waitForFunction(() => (/** @type {any} */ (window)).__entered, undefined, { timeout: 10_000, polling: 50 }));
          const border = await after.step(() => drawn.jsonValue());
          const marked = await after.step(() =>
            entered.evaluate(
              (sheet) => Array.from(document.head.querySelectorAll("link[data-corten-style]")).filter((link) => /** @type {HTMLLinkElement} */ (link).href === sheet).length,
              sheet,
            ),
          );
          seen = `${border}, ${marked} link`;
        } catch {
          seen = after.over;
        }
        check(
          name,
          early === null && requestedHeld === 1 && seen === "4px, 1 link" && requested === 1,
          `${whileHeld}, ${requested} in all; ${seen}`,
        );
      } else {
        // Where the page ended: swapped into this document, or this document replaced by a full
        // load (the wait goes on across that load).
        let ended = "";
        try {
          const settled = await after.step(() =>
            entered.waitForFunction(
              () =>
                document.readyState === "complete" && location.pathname === "/news" && document.querySelector("main h1")?.textContent === "Market news"
                  ? /** @type {any} */ (window).__sameDocument
                    ? "swapped"
                    : "loaded in full"
                  : "",
              undefined,
              { timeout: 10_000, polling: 50 },
            ),
          );
          ended = await after.step(() => settled.jsonValue());
        } catch {
          ended = after.over;
        }
        check(name, early === null && requestedHeld === 1 && ended === "loaded in full", `${whileHeld}; ${ended}`);
      }
    } finally {
      await entered.close().catch(() => {});
    }
  };
  if (swaps) {
    await sharedLoad(false);
    await sharedLoad(true);
  } else {
    skip("a navigation into an area while a patch is loading its stylesheet waits for that load", noSwaps);
    skip("a navigation into an area while a patch's load of its stylesheet fails loads the page in full", noSwaps);
  }
}
