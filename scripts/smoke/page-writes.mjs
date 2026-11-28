import { base, skip, check, steps, within } from "./helpers.mjs";

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
   * A page of its own at /smoke/written, with the stand-in in front: `edit` changes each whole
   * page from the write's answer on (`written`), `before` each one until then, each given the count
   * of writes sent by then (`writes`), its own included. Each request's mode for a path is recorded
   * in `asked`, and the writes answered are counted in `answers`; a write's answer waits for what
   * `hold` gives for its number. While `fail` is set, a write is done but its answer is dropped, as a
   * network that fails after the server applied it. While `draws` is false, a write goes without
   * its `Prefer: corten-draws=whole`, as from a runtime from before it. A write's answer's headers are given to `edit`
   * too, to change, and while `status` is set it is the write's answer's status. The page opened is `path`; a write
   * is a post to `/smoke/written` or, from the page that reads itself again, to its own address.
   * @param {(body: string, writes: number, headers?: Record<string, string>) => string} edit @param {(body: string) => string} [before]
   * @param {string} [path]
   */
  const writtenPage = async (edit, before = (body) => body, path = "/smoke/written") => {
    const own = await (await browser.newContext()).newPage();
    const seen = {
      written: false,
      fail: false,
      draws: true,
      status: 0,
      writes: 0,
      answers: 0,
      /** @type {string[]} */ asked: [],
      /** @type {Record<string, string>} */ answered: {},
      /** Optional stand-in for a navigation fragment. @type {((text: string, req: import("@playwright/test").Request, res: import("@playwright/test").APIResponse) => Promise<string>) | undefined} */
      fragment: undefined,
      /** What a write's answer waits for, by the write's number. @type {(writes: number) => Promise<unknown> | undefined} */
      hold: (/** @type {number} */ _writes) => /** @type {Promise<unknown> | undefined} */ (undefined),
    };
    await own.route(
      (url) => url.origin === new URL(base).origin && !url.pathname.startsWith("/assets/"),
      async (route) => {
        const req = route.request();
        const mode = req.headers().corten;
        const write = req.method() === "POST" && ["/smoke/written", "/smoke/written/again"].includes(new URL(req.url()).pathname);
        if (!write && !(req.resourceType() === "document" || mode === "page" || mode === "nav")) return route.fallback();
        seen.asked.push(`${req.method()} ${new URL(req.url()).pathname} ${mode ?? "-"}`);
        // Counted as the write is sent, so the writes are numbered in the order the page sent them.
        if (write) seen.writes += 1;
        const writes = seen.writes;
        // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
        const sent = { ...req.headers(), "accept-encoding": "identity" };
        if (write && !seen.draws) delete sent.prefer;
        const markedRead = seen.fragment && sent["x-smoke-written-read"] === "1";
        if (markedRead) delete sent["x-smoke-written-read"];
        const res = await route.fetch({ headers: sent, ...(markedRead && { maxRedirects: 0 }) });
        const headers = res.headers();
        if (write) seen.answered = { ...headers };
        delete headers["content-encoding"];
        delete headers["content-length"];
        const text = await res.text();
        // A navigation's <main> has no layout to change; only the failed-write cases mark its draw.
        const body = mode === "nav" ? (seen.fragment ? await seen.fragment(text, req, res) : text)
          : write || seen.written ? edit(text, writes, write ? headers : undefined) : before(text);
        seen.written ||= write;
        if (write && seen.fail) return route.abort("failed");
        if (write) await seen.hold(writes);
        await route.fulfill({ status: write && seen.status ? seen.status : res.status(), headers, body }).catch(() => {});
        if (write) seen.answers += 1;
      },
    );
    await own.goto(`${base}${path}`);
    await own.evaluate(() => ((/** @type {any} */ (window)).__marker = 1));
    return { own, seen };
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
  // A write the server applied whose answer the network lost: the page shows the failure in its
  // layout (as a toaster there does), for the user to send again. The page reading itself again
  // (`ReadAgain`) reads <main> alone and keeps the failure shown, where a whole page, whose header
  // the write changed, would draw it away; the next navigation reads the whole page, which shows
  // what the write changed.
  for (const order of ["failed", "legacy", "late"]) {
    const legacy = order !== "failed";
    const failedName = order === "late"
      ? "a poll already sent before the press cannot stand in for the poll after the legacy write drew"
      : legacy ? "a legacy write left undrawn does not make a poll replace the layout after a write failed"
      : "a write that failed in view leaves its change to the layout for the next page, and the page reading itself again keeps the failure shown";
    if (!(await page.evaluate(() => "navigation" in window))) {
      skip(failedName, "without the Navigation API a link is a full load");
      continue;
    }
    const target = new URL("/smoke/written/again", base).href;
    const { own, seen } = await writtenPage((body, writes, headers) =>
      legacy && writes === 2 && headers && "corten-page" in headers
        ? body + "<smoke-written></smoke-written>"
        : brand(body), undefined, "/smoke/written/again");
    const early = Promise.withResolvers(), release = Promise.withResolvers();
    let held = false;
    let failure = null, cleanup = null;
    const message = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error)).split("\n")[0];
    try {
      seen.fragment = async (text, req, res) => {
        if (req.method() !== "GET" || req.url() !== target || res.url() !== target || !res.ok() || !("corten-page" in res.headers())) return text;
        if (order === "late" && !held && !seen.writes) {
          held = true;
          early.resolve(req);
          await release.promise;
        }
        if (req.headers()["x-smoke-written-read"] !== "1") return text;
        // Only this response changes the button. Stop the fixture's polls once it has drawn.
        return text.replace(' data-corten-read-again="1"', "").replace(">Write</button>", ">Write (read again)</button>");
      };
      const delayed = order === "late" ? await within(5000, "no pre-press poll to delay", early.promise) : null;
      seen.fail = true;
      const lost = steps(5000, "the pressed form did not report its lost write");
      await lost.step(() => own.locator("main form button").evaluate((el, legacy) => {
        const button = /** @type {HTMLButtonElement} */ (el);
        const form = button.form;
        const header = document.querySelector("header");
        const here = location.href;
        // Latch the actual legacy draw. A GET sent before this POST may replace <main> again
        // before Playwright samples it or the next poll starts.
        customElements.define("smoke-written", class extends HTMLElement {
          connectedCallback() {
            if (document.querySelector("main > smoke-written") === this &&
                document.querySelector("main form p")?.textContent === "Written by the form's own page.") header?.setAttribute("data-legacy", "");
          }
        });
        const failed = (/** @type {Event} */ event) => {
          if (here === location.href && (event.target === form || (event.target === document && !form?.isConnected)) && (/** @type {CustomEvent} */ (event)).detail?.status === 0) {
            header?.setAttribute("data-failed", "");
            removeEventListener("corten:error", failed);
          }
        };
        addEventListener("corten:error", failed);
        const fetch_ = window.fetch;
        window.fetch = function (input, init) {
          const headers = new Headers(init?.headers);
          if ((init?.method ?? "GET") === "GET" && !headers.has("purpose") && header?.hasAttribute("data-failed") &&
              (!legacy || header.hasAttribute("data-legacy"))) {
            window.fetch = fetch_;
            headers.set("x-smoke-written-read", "1");
            return fetch_.call(this, input, { ...init, headers });
          }
          return fetch_.call(this, input, init);
        };
        button.click();
      }, legacy));
      await lost.poll(() => own.evaluate(() => !!document.querySelector("header[data-failed]") && !document.querySelector("[aria-busy]")));
      if (seen.writes !== 1 || !("corten-shell" in seen.answered) || "corten-page" in seen.answered)
        throw new Error("the lost write did not reach the server for its whole action answer");
      if (legacy) {
        seen.fail = false;
        seen.draws = false;
        const write = steps(5000, "the second press did not draw the legacy fragment");
        await write.step(() => own.locator("main form button").evaluate((el) => /** @type {HTMLButtonElement} */ (el).click()));
        await write.poll(() => own.evaluate(() => !!document.querySelector("header[data-failed][data-legacy]") && !document.querySelector("[aria-busy]")));
      }
      const read = steps(5000, "the post-write poll did not draw");
      release.resolve();
      if (delayed) await read.step(async () => {
        const response = await delayed.response();
        if (!response?.ok() || await response.finished()) throw new Error("the browser did not receive the delayed pre-press poll");
      });
      await read.poll(() => own.evaluate((url) =>
        location.href === url && /** @type {any} */ (window).__marker === 1 && document.title === "Write | Watchlist" && !!document.querySelector("header[data-failed]") &&
        document.querySelector("main form button")?.textContent === "Write (read again)", target));
      const writes = seen.asked.filter((ask) => ask.startsWith("POST "));
      if (writes.length !== (legacy ? 2 : 1) || writes.some((ask) => ask !== "POST /smoke/written/again action"))
        throw new Error("the presses did not send exactly the expected writes");
      const after = seen.asked.length;
      const leave = steps(5000, "the next page did not draw the changed layout");
      await leave.step(() => own.locator('main a[href="/smoke/quoted"]').evaluate((el) => /** @type {HTMLAnchorElement} */ (el).click()));
      await leave.poll(() => own.evaluate(() => location.pathname === "/smoke/quoted" && !document.querySelector("main form, [aria-busy]") &&
        document.querySelector("header span")?.textContent === "Watchlist, written" && /** @type {any} */ (window).__marker === 1));
      if (!seen.asked.slice(after).includes("GET /smoke/quoted page")) throw new Error("the next page was not read whole");
    } catch (error) {
      failure = message(error);
    } finally {
      release.resolve();
      try { await within(5000, "route cleanup timed out", own.unrouteAll({ behavior: "ignoreErrors" })); } catch (error) { cleanup = message(error); }
      try { await within(5000, "context close timed out", own.context().close()); } catch (error) { cleanup ??= message(error); }
    }
    check(failedName, failure === null && cleanup === null, JSON.stringify({ failure, cleanup, asked: seen.asked }));
  }
  /** Follows the link to /smoke/quoted, and whether that page came in. @param {import("@playwright/test").Page} own */
  const toQuoted = async (own) => {
    await own.click('main a[href="/smoke/quoted"]');
    return own
      .waitForFunction(() => location.pathname === "/smoke/quoted" && !document.querySelector("main form") && !document.querySelector("main[aria-busy]"), null, {
        timeout: 5000,
      })
      .then(
        () => true,
        () => false,
      );
  };
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
    seen.status = status;
    await own.evaluate(({ overlap, status, complete }) => {
      const state = /** @type {any} */ (window);
      addEventListener("corten:error", (event) => document.querySelector("header")?.setAttribute("data-failed", String((/** @type {CustomEvent} */ (event)).detail.status)));
      const fetch_ = window.fetch;
      let cut = false;
      window.fetch = async function (input, init) {
        const res = await fetch_.call(this, input, init);
        if (!cut && init?.method === "POST") {
          cut = true;
          /** @template T @param {() => Promise<T>} body */
          const held = (body) => new Promise((resolve, reject) => {
            const release = () => complete ? body().then(resolve, reject) : reject(new TypeError("network error"));
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
    }, { overlap, status, complete });
    await own.click(overlap ? "#held-write button" : "main form button");
    let drewOver = true;
    if (overlap) {
      await own.waitForFunction(() => typeof (/** @type {any} */ (window)).__releaseBody === "function");
      seen.status = 0;
      await own.locator("main form button").evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
      drewOver = await brandBecomes(own, "Watchlist, written");
      await own.evaluate(() => (/** @type {any} */ (window)).__releaseBody());
    }
    const failed = await own
      .waitForFunction((status) => document.querySelector("header")?.getAttribute("data-failed") === String(status) && !document.querySelector("[aria-busy]"), complete ? 503 : 0, { timeout: 5000 })
      .then(
        () => true,
        () => false,
      );
    const after = seen.asked.length;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !seen.asked.slice(after).some((a) => a.startsWith("GET /smoke/written/again"))) await own.waitForTimeout(50);
    const again = seen.asked.slice(after).find((a) => a.startsWith("GET /smoke/written/again")) ?? null;
    await own.waitForTimeout(500);
    const kept = await own.evaluate(() => !!document.querySelector("header[data-failed]"));
    const arrived = await toQuoted(own);
    const shown = await shownOf(own);
    check(
      cutBodyName,
      drewOver && failed && seen.answers === (overlap ? 2 : 1) && again === "GET /smoke/written/again nav" && kept && arrived &&
        shown.brand === (overlap ? "Poll brand" : "Watchlist, written") && seen.asked.includes("GET /smoke/quoted page"),
      JSON.stringify({ drewOver, failed, answers: seen.answers, again, kept, arrived, asked: seen.asked, shown }),
    );
    await own.context().close();
  }
  // A write whose own page reads itself again (ReadAgain) draws, so the page reads itself whole
  // from then on; then a second write is applied and its answer lost, and the page shows the
  // failure in its layout. Reading itself again, the page reads <main> alone, which keeps the
  // failure shown, where a whole page (whose count the second write changed) would draw it away.
  const againName = "after a write's own page that reads itself again, a write that failed in view stays shown while the page reads itself again";
  if (!(await page.evaluate(() => "navigation" in window))) skip(againName, "without the Navigation API a link is a full load");
  else {
    const counted = (/** @type {string} */ body, /** @type {number} */ writes) => body.replace(">Watchlist</span>", `>Count ${writes}</span>`);
    const { own, seen } = await writtenPage(counted, undefined, "/smoke/written/again");
    await own.evaluate(() => addEventListener("corten:error", () => document.querySelector("header")?.setAttribute("data-failed", "")));
    await own.click("main form button");
    const drew = (await brandBecomes(own, "Count 1")) && (await writtenIn(own));
    // Read whole while it reads itself again.
    const start = seen.asked.length;
    const until = Date.now() + 5000;
    while (Date.now() < until && !seen.asked.slice(start).some((a) => a.startsWith("GET /smoke/written/again"))) await own.waitForTimeout(50);
    const wholeBefore = seen.asked.slice(start).find((a) => a.startsWith("GET /smoke/written/again")) ?? null;
    seen.fail = true;
    await own.click("main form button");
    const failed = await own
      .waitForFunction(() => !!document.querySelector("header[data-failed]") && !document.querySelector("[aria-busy]"), null, { timeout: 5000 })
      .then(
        () => true,
        () => false,
      );
    const after = seen.asked.length;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !seen.asked.slice(after).some((a) => a.startsWith("GET /smoke/written/again"))) await own.waitForTimeout(50);
    const again = seen.asked.slice(after).find((a) => a.startsWith("GET /smoke/written/again")) ?? null;
    await own.waitForTimeout(500);
    const kept = await own.evaluate(() => !!document.querySelector("header[data-failed]") && document.querySelector("header span")?.textContent === "Count 1");
    const arrived = await toQuoted(own);
    const shown = await shownOf(own);
    check(
      againName,
      drew &&
        wholeBefore === "GET /smoke/written/again page" &&
        failed &&
        again === "GET /smoke/written/again nav" &&
        kept &&
        arrived &&
        shown.brand === "Count 2" &&
        seen.asked.includes("GET /smoke/quoted page"),
      JSON.stringify({ drew, wholeBefore, failed, again, kept, arrived, asked: seen.asked, shown }),
    );
    await own.context().close();
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
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    await own.route("**/assets/smoke-held-poll.css", async (route) => {
      await held;
      await route.fulfill({ contentType: "text/css", body: "" }).catch(() => {});
    });
    await own.evaluate(() => addEventListener("corten:error", () => document.querySelector("header")?.setAttribute("data-failed", "")));
    const asset = own.waitForRequest("**/assets/smoke-held-poll.css", { timeout: 5000 }).then(() => true, () => false);
    await own.click("main form button");
    const drew = (await brandBecomes(own, "Watchlist, written")) && (await writtenIn(own));
    const waiting = await asset;
    seen.fail = true;
    await own.locator("main form button").evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
    const failed = await own
      .waitForFunction(() => !!document.querySelector("header[data-failed]") && !document.querySelector("[aria-busy]"), null, { timeout: 5000 })
      .then(() => true, () => false);
    // Once the held poll is out of the way, the next one asks for a partial response. A whole
    // draw of the held answer would have replaced the header and lost its failure mark.
    const next = own.waitForResponse((res) => new URL(res.url()).pathname === "/smoke/written/again" && res.request().method() === "GET", { timeout: 5000 }).catch(() => null);
    release();
    const response = await next;
    await response?.finished();
    const retry = response?.request().headers().corten;
    const kept = await own.evaluate(() => !!document.querySelector("header[data-failed]") && document.querySelector("header span")?.textContent === "Watchlist, written");
    check(waitingPollName, drew && waiting && failed && retry === "nav" && kept, JSON.stringify({ drew, waiting, failed, retry, kept, asked: seen.asked }));
    await own.unrouteAll({ behavior: "ignoreErrors" });
    await own.context().close();
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
    // navigation after reads <main> alone, not the whole page again.
    const target = new URL("/smoke/written", base).href;
    /** @type {{ mode: string, purpose?: string }[]} */
    const returnReads = [];
    let recording = false;
    let returned = false;
    let returnError = "";
    let closeError = null;
    try {
      // Record before the fixture answers, so the draw cannot beat its request onto the list.
      await within(5000, "return route setup timed out", own.route((url) => url.href === target, (route) => {
        const request = route.request();
        if (recording && request.method() === "GET") {
          const { corten, purpose } = request.headers();
          returnReads.push({ mode: request.isNavigationRequest() ? "document" : corten ?? "-", purpose });
        }
        return route.fallback();
      }));
      const returning = steps(10_000, "return navigation did not draw within 10 s");
      recording = true;
      await returning.step(() => own.evaluate((url) => { /** @type {any} */ (window).navigation.navigate(url); }, target));
      await returning.step(() => own.waitForFunction((url) =>
        location.href === url && !!document.querySelector("main form") && !document.querySelector("main[aria-busy]"),
      target, { timeout: 10_000 }));
      returned = true;
    } catch (error) {
      returnError = error instanceof Error ? error.message.split("\n")[0] : String(error);
    } finally {
      recording = false;
      try {
        await within(5000, "return context close timed out", own.context().close());
      } catch (error) {
        closeError = error instanceof Error ? error.message.split("\n")[0] : String(error);
      }
    }
    const visits = returnReads.filter(({ mode, purpose }) => mode !== "nav" || purpose !== "prefetch");
    check(
      "a write's patch answered before a navigation left it is drawn by that page, and the next navigation reads <main> alone",
      returned && visits.length === 1 && visits[0].mode === "nav" && closeError === null,
      JSON.stringify({ returned, returnReads, returnError, closeError, asked: seen.asked }),
    );
  }
}
