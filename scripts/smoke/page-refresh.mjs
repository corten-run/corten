import { base, shadowing, skip, check } from "./helpers.mjs";

export async function pageRefresh(page, swaps, noSwaps, errors, signsIn) {
  // A page that waits for a write (ReadAgain) reads itself again until the write is in,
  // however it was reached: a full load, or the runtime's navigation (a link, or a data-patch
  // form's corten-location, which navigates the same way). Each read is the same URL in place of
  // the history entry, and a navigation away stops it.
  {
    // A write that has not landed: an alert saved as the form saves one, whose answer names the
    // page that waits for it (`/alerts?saved=..`); the store's reads see it 1.5 s later.
    const pending = async () => {
      const from = await page.evaluate(async () => {
        const res = await fetch("/alerts", { method: "POST", headers: { corten: "action", "content-type": "application/x-www-form-urlencoded" }, body: "id=ACME&above=175" });
        return /data-from="([^"]+)"/.exec(await res.text())?.[1];
      });
      return `${base}${from}`;
    };
    /** Navigates the runtime's way, and waits until the page is there, still saving. @param {string} url */
    const go = async (url) => {
      await page.evaluate((url) => (/** @type {any} */ (window)).navigation.navigate(url), url);
      await page.waitForFunction((url) => location.href === url && document.getElementById("alert-status")?.textContent === "Saving...", url);
    };
    const saved = () => page.textContent("#alert-status");
    const savedSoon = () =>
      page.waitForFunction(() => document.getElementById("alert-status")?.textContent === "Saved.", null, { timeout: 6000 }).catch(() => {});
    /** @type {string[]} */
    const reads = [];
    const onSaved = (/** @type {import("@playwright/test").Request} */ r) => r.url().includes("/alerts") && reads.push(r.url());

    // The alerts page asks for its status line and list to be read again (ReadAgain::from in the
    // page): with JavaScript only they are read, from their route as a patch, however the page was
    // reached, and the form beside them stays as the user has it. Its head's ReadAgain is for a
    // browser without JavaScript.
    {
      /** @type {string[]} */
      const parts = [];
      /** @type {string[]} */
      const whole = [];
      const onPart = (/** @type {import("@playwright/test").Request} */ r) => {
        if (r.method() !== "GET" || !r.url().includes("/alerts?saved=")) return;
        (r.headers()["corten"] === "action" ? parts : whole).push(r.url());
      };
      const url = await pending();
      // The page's own tag, as the server drew it, so the check below can tell it from the one an
      // answer put in its place.
      await page.addInitScript(() =>
        document.addEventListener("DOMContentLoaded", () => {
          (/** @type {any} */ (window)).__pageTag = document.querySelector("main template[data-corten-read-again][data-from]");
        }),
      );
      await page.goto(url);
      page.on("request", onPart);
      const waiting = await saved();
      await page.fill("input[name=above]", "123.45");
      await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 8));
      const entries = await page.evaluate(() => history.length);
      await savedSoon();
      check(
        "a page's part waiting for a write is read again after a full load, not the page",
        waiting === "Saving..." && (await saved()) === "Saved." && parts.length > 0 && whole.length === 0 && page.url() === url,
        `${waiting} -> ${await saved()} after ${parts.length} part and ${whole.length} page reads`,
      );
      const kept = await page.evaluate(() => ({
        marker: (/** @type {any} */ (window)).__marker,
        entries: history.length,
        above: /** @type {HTMLInputElement | null} */ (document.querySelector("input[name=above]"))?.value,
      }));
      check("reading a page's part keeps the document, its history entry and the form", kept.marker === 8 && kept.entries === entries && kept.above === "123.45", JSON.stringify(kept));
      // The part's answer that asked again put its tag in the page's tag's place: one tag, the
      // last read's, and not the page's own (whose address is the same here).
      const tagged = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("main template[data-corten-read-again][data-from]"));
        const first = (/** @type {any} */ (window)).__pageTag;
        return {
          tags: all.map((t) => new URL(/** @type {string} */ (t.getAttribute("data-from")), location.href).href),
          pageTag: !!first,
          pageTagGone: !!first && !first.isConnected && !all.includes(first),
        };
      });
      const tags = tagged.tags;
      check(
        "a page part's answer that asks again takes the place of the tag that asked",
        tags.length === 1 && tags[0] === parts.at(-1) && tagged.pageTag && tagged.pageTagGone,
        `${JSON.stringify(tagged)} after ${parts.at(-1)}`,
      );
      const settled = parts.length;
      await page.waitForTimeout(2200);
      check("a page's part stops once its patch no longer asks", parts.length === settled, `${parts.length - settled} more reads`);
      if (swaps) {
        const from = parts.length;
        await go(await pending());
        await savedSoon();
        check(
          "a page's part reached by the runtime's navigation is read again, not the page",
          (await saved()) === "Saved." && parts.length > from && whole.length === 1,
          `${await saved()} after ${parts.length - from} part reads, ${whole.length} page loads (the navigation's)`,
        );
        // Away before the read: the runtime's navigation leaves the page, and its part is not read.
        await go(await pending());
        const left = parts.length;
        await page.click('header a[href="/news"]');
        await page.waitForFunction(() => document.title === "News | Watchlist");
        await page.waitForTimeout(2200);
        check("navigating away stops a page's part reads", parts.length === left, `${parts.length - left} more reads`);
      } else {
        for (const name of ["a page's part reached by the runtime's navigation is read again, not the page", "navigating away stops a page's part reads"]) skip(name, noSwaps);
      }
      page.off("request", onPart);
    }

    // The rest reads the page whole: the page as one that asks only that (its head's ReadAgain,
    // without the part's tag). Fetched uncompressed: Playwright does not decode zstd, which
    // Firefox asks for.
    const wholeOnly = async (/** @type {import("@playwright/test").Route} */ route) => {
      if (route.request().headers()["corten"] === "action") return route.fallback();
      const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
      const headers = res.headers();
      delete headers["content-encoding"];
      delete headers["content-length"];
      const body = (await res.text()).replace(/<template data-corten-read-again[^>]*><\/template>/g, "");
      await route.fulfill({ status: res.status(), headers, body });
    };
    await page.route("**/alerts?saved=*", wholeOnly);
    page.on("request", onSaved);
    await page.goto(await pending());
    const waiting = await saved();
    await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 5));
    await savedSoon();
    check("a page waiting for a write reads itself again after a full load", waiting === "Saving..." && (await saved()) === "Saved.", `${waiting} -> ${await saved()}`);
    if (swaps) check("reading again keeps the document", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 5));
    else skip("reading again keeps the document", noSwaps);
    const settled = reads.length;
    await page.waitForTimeout(2200);
    check("it stops once the page no longer asks", reads.length === settled, `${reads.length - settled} more reads`);
    // At a place on the page (a write redirected to `route.at(..)`): read again all the same.
    await page.goto(`${await pending()}#alert-status`);
    await savedSoon();
    check("a page at a place (#id) reads itself again too", (await saved()) === "Saved." && new URL(page.url()).hash === "#alert-status", `${await saved()} ${page.url()}`);
    // A query a script put in the address (corten-ui's rows::sort writes the order it shows) is
    // read again with the page, so the page read again draws what is on screen.
    {
      await page.goto(await pending());
      const from = reads.length;
      await page.evaluate(() => {
        const to = new URL(location.href);
        to.searchParams.set("shown", "1");
        history.replaceState(history.state, "", to);
      });
      await savedSoon();
      const again = reads.slice(from);
      check(
        "a page reads itself again at the address a script replaced",
        (await saved()) === "Saved." && again.length > 0 && again.every((u) => new URL(u).searchParams.get("shown") === "1"),
        `${await saved()} ${again.join()}`,
      );
    }
    // A script's replaceState while a read is on its way (a sort clicked as it polls) cancels that
    // read; the next is still made, at the address the script put, so the page does not stop short
    // of the write.
    if (swaps) {
      // The page's first read of itself is held until the script has replaced the address, so the
      // replaceState meets it still on its way however slowly it comes (#2014). The hold is in
      // before the page is loaded, so the read it holds is the first, however soon it is made; the
      // page's own load goes by, and so does a read of any other address. The case waits for the
      // hold, then requires that read cancelled and a read of the replaced address answered.
      let replaced = () => {};
      const released = new Promise((resolve) => (replaced = () => resolve(undefined)));
      /** The page's address as it came. */
      let address = "";
      /** The read held, once there is one. @type {import("@playwright/test").Request | null} */
      let heldRead = null;
      let holding = () => {};
      const isHeld = new Promise((resolve) => (holding = () => resolve(undefined)));
      /** Whether `request` reads the page at its address as it came. @param {import("@playwright/test").Request} request */
      const readsAsCame = (request) => {
        if (request.isNavigationRequest() || request.method() !== "GET") return false;
        const url = new URL(request.url());
        return !url.searchParams.has("shown") && url.searchParams.get("saved") === new URL(address).searchParams.get("saved");
      };
      const slow = async (/** @type {import("@playwright/test").Route} */ route) => {
        if (heldRead || !readsAsCame(route.request())) return route.fallback();
        heldRead = route.request();
        holding();
        await released;
        await route.fallback().catch(() => {});
      };
      let heldCancelled = false;
      const onFailed = (/** @type {import("@playwright/test").Request} */ r) => void (r === heldRead && (heldCancelled = true));
      /** The reads of the replaced address that were answered. @type {string[]} */
      const replacedReads = [];
      const onFinished = (/** @type {import("@playwright/test").Request} */ r) =>
        void (!r.isNavigationRequest() && r.method() === "GET" && r.url().includes("/alerts?") && new URL(r.url()).searchParams.get("shown") === "2" && replacedReads.push(r.url()));
      page.on("requestfailed", onFailed);
      page.on("requestfinished", onFinished);
      const from = reads.length;
      let waiting = false;
      let held = false;
      // Armed inside the guard: the read the route holds is let go however the steps end.
      try {
        await page.route("**/alerts?saved=*", slow);
        // The page must come in still saving, or it starts no read to cancel; a write that landed
        // first is tried again.
        for (let tries = 0; tries < 3 && !waiting; tries++) {
          address = await pending();
          await page.goto(address);
          waiting = (await saved()) === "Saving...";
        }
        if (waiting) {
          held = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), 5000);
            isHeld.then(() => (clearTimeout(timer), resolve(true)));
          });
          if (held)
            await page.evaluate(() => {
              const to = new URL(location.href);
              to.searchParams.set("shown", "2");
              history.replaceState(history.state, "", to);
            });
        }
      } finally {
        replaced();
        await page.unroute("**/alerts?saved=*", slow);
      }
      await savedSoon();
      // The answered read's event may come a moment after its page is drawn.
      for (let waited = 0; waiting && held && !replacedReads.length && waited < 1000; waited += 50) await page.waitForTimeout(50);
      page.off("requestfailed", onFailed);
      page.off("requestfinished", onFinished);
      const at = new URL(page.url()).searchParams.get("shown");
      if (waiting)
        check(
          "a read a script's replaceState cancels on its way is made again",
          (await saved()) === "Saved." && held && heldCancelled && replacedReads.length > 0 && at === "2",
          `${await saved()} at shown=${at} after ${reads.length - from} reads; ${held ? `held read ${heldCancelled ? "cancelled" : "not cancelled"}` : "no read held within 5 s"}; ${replacedReads.length} of the replaced address answered`,
        );
      else skip("a read a script's replaceState cancels on its way is made again", "each write landed before its page came in");
    } else {
      skip("a read a script's replaceState cancels on its way is made again", noSwaps);
    }
    if (swaps) {
      await page.evaluate(() => (/** @type {any} */ (window)).__marker = 6);
      const entries = await page.evaluate(() => history.length);
      await go(await pending());
      const reached = await saved();
      await savedSoon();
      check(
        "a page reached by the runtime's navigation reads itself again in place",
        reached === "Saving..." && (await saved()) === "Saved." && (await page.evaluate(() => (/** @type {any} */ (window)).__marker === 6)),
        `${reached} -> ${await saved()}`,
      );
      check("each read replaces the history entry", (await page.evaluate(() => history.length)) === entries + 1, `${entries} -> ${await page.evaluate(() => history.length)}`);
      // Away while a write lands: once the page is in and has armed its read again (the head's
      // read-again tag), it is left at once, with no wait for its text. A write that landed before
      // the page came in arms nothing, so another is tried.
      let armed = false;
      for (let tries = 0; tries < 3 && !armed; tries++) {
        const leaving = await pending();
        await page.evaluate(() => document.getElementById("alert-status")?.setAttribute("data-old", ""));
        await page.evaluate((url) => (/** @type {any} */ (window)).navigation.navigate(url), leaving);
        await page.waitForFunction((url) => location.href === url && !document.querySelector("#alert-status[data-old]"), leaving);
        armed = await page.evaluate(() => !!document.head.querySelector("noscript[data-corten-read-again]"));
      }
      await page.click('header a[href="/news"]');
      await page.waitForFunction(() => document.title === "News | Watchlist");
      const left = reads.length;
      await page.waitForTimeout(2200);
      if (armed) check("navigating away stops the reads", reads.length === left, `${reads.length - left} more reads`);
      else skip("navigating away stops the reads", "each write landed before its page came in");
    } else {
      for (const name of ["a page reached by the runtime's navigation reads itself again in place", "each read replaces the history entry", "navigating away stops the reads"]) skip(name, noSwaps);
    }
    page.off("request", onSaved);
    await page.unroute("**/alerts?saved=*", wholeOnly);

    // A data-patch write answered in place while its read catches up (ReadAgain::from): the
    // status line is patched, then read again from its route (`corten: action`) until the write
    // is in, with no navigation; the button keeps focus, and a navigation away stops the reads.
    /** @type {string[]} */
    const again = [];
    const onAgain = (/** @type {import("@playwright/test").Request} */ r) =>
      r.method() === "GET" && r.url().includes("/alerts?saved=") && r.headers()["corten"] === "action" && again.push(r.url());
    page.on("request", onAgain);
    const save = 'form[action="/alerts"] button';
    const submit = async () => {
      await page.fill("input[name=above]", "150");
      await page.focus(save);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("alert-status")?.textContent === "Saving...");
    };
    await page.goto(`${base}/alerts`);
    // A price the server refuses: the form comes back with the field marked and its message,
    // and focus on it.
    const errorsAtRefusal = errors.length;
    await page.fill("input[name=above]", "1.234");
    const belowFold = await page.locator(save).evaluate((button) => {
      const submit = /** @type {HTMLButtonElement} */ (button);
      const field = document.querySelector("input[name=above]");
      const spacer = document.createElement("div");
      spacer.id = "smoke-refusal-spacer";
      spacer.append(...Array.from({ length: 200 }, () => document.createElement("br")));
      document.querySelector("main")?.prepend(spacer);
      submit.focus({ preventScroll: true });
      scrollTo({ top: 0, behavior: "instant" });
      const below = !!field && field.getBoundingClientRect().top >= innerHeight;
      submit.click();
      return below;
    });
    await page.waitForSelector('input[name=above][aria-invalid="true"]', { timeout: 5000 }).catch(() => {});
    const refused = await page.evaluate(() => {
      const field = /** @type {HTMLInputElement | null} */ (document.querySelector("input[name=above]"));
      const rect = field?.getBoundingClientRect();
      const result = {
        message: document.getElementById("alert-form-above-error")?.textContent,
        focused: document.activeElement === field,
        value: field?.value,
        inView: !!rect && rect.bottom > 0 && rect.top < innerHeight && scrollY > 0,
      };
      document.getElementById("smoke-refusal-spacer")?.remove();
      return result;
    });
    check(
      "a refused patch field below the fold comes back marked, with its message and focus in view",
      belowFold && refused.inView && refused.message === "Enter a price in dollars and cents, such as 129.99." && refused.focused && refused.value === "1.234",
      JSON.stringify({ belowFold, ...refused }),
    );
    // The browser logs the 422 as a failed resource; Corten adds nothing.
    const refusedLogs = errors.slice(errorsAtRefusal);
    check("a refused field logs no console error of Corten's", refusedLogs.every((e) => e.includes("422")), refusedLogs.join(" | "));
    errors.splice(errorsAtRefusal);
    // The same refusal from a form with controls named after the members the runtime reads on it
    // (whether it is on the page and holds focus): focus goes from its button to the marked field.
    // Sent by keys: Playwright's own fill and click read the form's getAttribute.
    const errorsAtShadowed = errors.length;
    await page.evaluate((names) => {
      const form = /** @type {Element} */ (document.getElementById("alert-form"));
      form.insertAdjacentHTML("afterbegin", __html(names.map((name) => `<input type="hidden" name="${name}" value="x" disabled>`).join("")));
      /** @type {HTMLInputElement} */ (Element.prototype.querySelector.call(form, "input[name=above]")).value = "1.235";
      /** @type {HTMLElement} */ (Element.prototype.querySelector.call(form, "button")).focus();
    }, shadowing);
    await page.keyboard.press("Enter");
    const shadowRefused = await page
      .waitForFunction(
        () => {
          const field = document.querySelector('#alert-form input[name=above][aria-invalid="true"]');
          return !!field && document.activeElement === field && !document.querySelector("#alert-form input[name=hasAttribute]");
        },
        null,
        { timeout: 5000 },
      )
      .then(() => true, () => false);
    const shadowLogs = errors.slice(errorsAtShadowed);
    check(
      "a refused field in a form with controls named after the members the runtime reads on it gets focus",
      shadowRefused && shadowLogs.every((e) => e.includes("422")),
      shadowLogs.join(" | "),
    );
    errors.splice(errorsAtShadowed);
    await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 7));
    await submit();
    await savedSoon();
    check(
      "a patch waiting for a write is read again from its route until the write is in",
      (await saved()) === "Saved." && again.length > 0 && page.url() === `${base}/alerts` && (await page.evaluate(() => (/** @type {any} */ (window)).__marker === 7)),
      `${await saved()} after ${again.length} reads at ${page.url()}`,
    );
    check("reading a patch again keeps focus", await page.evaluate(() => document.activeElement?.textContent === "Save alert"));
    // The list read again with the status line shows the alert once it is in; a remove is a write
    // of its own, read again until the list no longer has it. The list is the browser's, kept under
    // its visitor cookie, which this browser does not send over http.
    const listed = () => page.$$eval("#alert-list li span", (spans) => spans.map((s) => s.textContent));
    if (signsIn) {
      // The writes above saved ACME at $175.00; this one, at $150.00, is the only such alert.
      const shown = await listed();
      check("a saved alert is listed once it lands", shown.filter((s) => s === "ACME above $150.00").length === 1, shown.join(", "));
      await page.click("#alert-list li:last-child button");
      await page.waitForFunction(() => document.getElementById("alert-status")?.textContent === "Saving...", null, { timeout: 5000 }).catch(() => {});
      await savedSoon();
      const left = await listed();
      check("a removed alert leaves the list once the removal lands", left.length === shown.length - 1 && (await saved()) === "Saved.", `${shown.length} -> ${left.length}`);
    } else {
      for (const name of ["a saved alert is listed once it lands", "a removed alert leaves the list once the removal lands"]) skip(name, "the browser does not send Secure cookies over http");
    }
    // The save after the refusal above answered the whole form, so the field is no longer marked.
    const cleared = await page.evaluate(() => !document.querySelector("#alert-form [aria-invalid]") && !document.getElementById("alert-form-above-error"));
    check("a save after a refusal clears the field's error", cleared);
    const done = again.length;
    await page.waitForTimeout(2200);
    check("it stops once the patch no longer asks", again.length === done, `${again.length - done} more reads`);
    await submit();
    await page.click('header a[href="/news"]');
    await page.waitForFunction(() => document.title === "News | Watchlist");
    const away = again.length;
    await page.waitForTimeout(2200);
    check("navigating away stops a patch's reads", again.length === away, `${again.length - away} more reads`);
    // A read the server fails (its error page, not a patch) stops the reads without a console
    // error: the server logged the failure, and the part stays as it was.
    const errorsBefore = errors.length;
    const failRead = (/** @type {import("@playwright/test").Route} */ route) =>
      route.request().headers()["corten"] === "action" ? route.fulfill({ status: 502, contentType: "text/html", body: "<p>Bad gateway</p>" }) : route.fallback();
    await page.route("**/alerts?saved=*", failRead);
    await page.goto(`${base}/alerts`);
    const readsBefore = again.length;
    await submit();
    for (let i = 0; i < 40 && again.length === readsBefore; i++) await page.waitForTimeout(100);
    const failedAt = again.length;
    await page.waitForTimeout(2200);
    // The browser itself reports the 502 as a failed resource; Corten adds nothing.
    const logged = errors.slice(errorsBefore).filter((e) => !e.includes("502"));
    check(
      "a read the server fails stops the reads, without a console error",
      failedAt === readsBefore + 1 && again.length === failedAt && (await saved()) === "Saving..." && logged.length === 0,
      `${failedAt - readsBefore} then ${again.length - failedAt} reads, ${logged.join(" | ")}`,
    );
    errors.splice(errorsBefore);
    await page.unroute("**/alerts?saved=*", failRead);
    page.off("request", onAgain);
  }

  // data-reload: the link loads the whole document instead of swapping <main>.
  await page.evaluate(() => {
    (/** @type {any} */ (window)).__marker = 4;
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<a id="reload-link" href="/" data-reload>Home</a>'));
  });
  await page.click("#reload-link");
  await page.waitForFunction(() => document.title === "Stocks | Watchlist");
  check("data-reload loads the whole document", await page.evaluate(() => (/** @type {any} */ (window)).__marker === undefined));
}
