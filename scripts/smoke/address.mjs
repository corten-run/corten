import { base, skip, check } from "./helpers.mjs";

// A GET data-patch form marked data-address (#1406): its answer is the page at the address it asked
// for, so as its patch is drawn that address takes the place of the history entry's, adding no
// entry, and only an answer that draws whole, from the visit it was sent from, does so. Back goes to
// the page before the screen, not to an earlier scope, and Back and Forward read the page at an
// entry's address, as for any entry; a reload draws the address's scope; a form without the mark
// leaves the address. Its submits are queued as any data-patch form's are.
/** @param {import("@playwright/test").Browser} browser */
export async function dataAddress(browser) {
  /** @type {string[]} */
  const errors = [];
  const home = `${base}/smoke/address`;
  const before = `${base}/smoke/address-elsewhere`;
  const scope = await browser.newPage();
  scope.on("pageerror", (e) => errors.push(`address: ${e.message}`));
  await scope.goto(before);
  if (!(await scope.evaluate(() => "navigation" in window))) skip("a data-address form's patch puts its address in the entry", "no Navigation API");
  else {
    // The screen, reached from the page before it by the runtime's navigation.
    await scope.evaluate(() => /** @type {any} */ (window).navigation.navigate("/smoke/address").finished);
    /**
     * The requests for the screen's address (or another `/smoke/address` route's, by its path) since
     * the last read: how each asked (`corten`, else a document load) and its query.
     * @type {string[]}
     */
    const asked = [];
    scope.on("request", (r) => {
      const url = new URL(r.url());
      if (url.pathname.startsWith("/smoke/address"))
        asked.push(`${r.headers()["corten"] ?? "document"} ${url.pathname === "/smoke/address" ? "" : url.pathname}${url.search}`);
    });
    const at = () => scope.evaluate(() => location.pathname + location.search + location.hash);
    const shown = () => scope.evaluate(() => document.querySelector("#smoke-address output")?.textContent);
    const index = () => scope.evaluate(() => /** @type {any} */ (window).navigation.currentEntry.index);
    const entries = () => scope.evaluate(() => /** @type {any} */ (window).navigation.entries().length);
    const key = () => scope.evaluate(() => /** @type {any} */ (window).navigation.currentEntry.key);
    /** The address of the entry `by` from the current one, if any. @param {number} by */
    const entryAt = (by) =>
      scope.evaluate((by) => {
        const nav = /** @type {any} */ (window).navigation;
        return nav.entries()[nav.currentEntry.index + by]?.url ?? "";
      }, by);
    /**
     * Does `act`, then waits until its submit's answer is drawn (the panel a new element) and the
     * submit has ended, and says whether it was.
     * @param {() => Promise<unknown>} act
     */
    const answered = async (act) => {
      await scope.evaluate(() => {
        const panel = document.getElementById("smoke-address");
        Object.assign(window, { __panel: panel, __forms: Array.from(document.querySelectorAll("main form")) });
      });
      await act();
      return scope
        .waitForFunction(
          () => document.getElementById("smoke-address") !== /** @type {any} */ (window).__panel && !(/** @type {any} */ (window).__forms.some((/** @type {Element} */ f) => f.hasAttribute("aria-busy"))),
          undefined,
          { timeout: 5000 },
        )
        .then(() => true, () => false);
    };
    /** Presses the scope button `name`, and waits for its answer to be drawn. @param {string} name */
    const press = (name) => answered(() => scope.getByRole("button", { name, exact: true }).click());
    /** Goes back or forward, and says where the page is once the traversal has finished. @param {"back" | "forward"} way */
    const traverse = (way) =>
      scope.evaluate((way) => /** @type {any} */ (window).navigation[way]().finished.then(() => location.pathname + location.search + location.hash, (/** @type {unknown} */ e) => String(e)), way);
    /** A task, then a frame: whatever the runtime does with an answer it has read is done. */
    const settle = () => scope.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
    // The answer's headers are in and its body held: the address is the page's until the answer
    // is drawn. It is the answer's before an observer or a timer can run after the draw: a mutation
    // observer of the panel the patch put in reads it, and presses Day from there, whose answer
    // takes the entry's place in turn. Neither adds an entry.
    const first = { index: await index(), entries: await entries(), key: await key() };
    let during = { reading: false, at: "", shown: "" };
    const drawn = await answered(async () => {
      await scope.evaluate(() => {
        const text = Response.prototype.text;
        /** @type {(value?: unknown) => void} */
        let release = () => {};
        const held = new Promise((resolve) => (release = resolve));
        Object.assign(window, { __release: release, __reading: false, __atReplace: null, __seenAt: null });
        Response.prototype.text = function () {
          if (!this.headers.has("corten-patch")) return text.call(this);
          Response.prototype.text = text;
          Object.assign(window, { __reading: true });
          return held.then(() => text.call(this));
        };
        const replace = history.replaceState;
        history.replaceState = function (...args) {
          history.replaceState = replace;
          Object.assign(window, { __atReplace: document.querySelector("#smoke-address output")?.textContent });
          return replace.apply(this, args);
        };
        const panel = document.getElementById("smoke-address");
        const seen = new MutationObserver(() => {
          const now = document.getElementById("smoke-address");
          if (now === panel) return;
          seen.disconnect();
          Object.assign(window, { __seenAt: location.search });
          const day = /** @type {HTMLButtonElement} */ (now?.querySelector('button[value="day"]'));
          day.form?.requestSubmit(day);
        });
        seen.observe(/** @type {Element} */ (document.querySelector("main")), { childList: true, subtree: true });
      });
      await scope.getByRole("button", { name: "Week", exact: true }).click();
      const reading = await scope.waitForFunction(() => /** @type {any} */ (window).__reading, undefined, { timeout: 5000 }).then(() => true, () => false);
      during = { reading, at: await at(), shown: (await shown()) ?? "" };
      await scope.evaluate(() => /** @type {any} */ (window).__release());
    });
    await scope.waitForFunction(() => location.search === "?scope=day" && document.querySelector("#smoke-address output")?.textContent === "day", undefined, { timeout: 5000 }).catch(() => {});
    const marks = await scope.evaluate(() => ({ atReplace: /** @type {any} */ (window).__atReplace, seenAt: /** @type {any} */ (window).__seenAt }));
    const replaced = {
      during,
      drawn,
      ...marks,
      at: await at(),
      index: (await index()) - first.index,
      added: (await entries()) - first.entries,
      sameKey: (await key()) === first.key,
      shown: await shown(),
      before: await entryAt(-1),
    };
    check(
      "a data-address form's patch puts the address it asked for in place of the entry's as it is drawn, before an observer of the draw runs, adding no entry",
      replaced.during.reading && replaced.during.at === "/smoke/address" && replaced.during.shown === "all" && replaced.drawn && replaced.atReplace === "week" &&
        replaced.seenAt === "?scope=week" && replaced.at === "/smoke/address?scope=day" && replaced.index === 0 && replaced.added === 0 && replaced.sameKey && replaced.shown === "day" &&
        replaced.before.endsWith("/smoke/address-elsewhere"),
      JSON.stringify(replaced),
    );
    // A form the patch draws that keeps the address's query (`keep_query`) sends the scope on
    // screen, not the one the page was drawn with: a link or form outside the patch keeps the
    // address it was drawn with, so one that carries the scope is drawn by the patch.
    const carried = await scope.evaluate(() => {
      const form = /** @type {HTMLFormElement} */ (Array.from(document.querySelectorAll("#smoke-address form")).find((f) => !f.hasAttribute("data-patch")));
      const sent = new URL(form.action);
      sent.search = new URLSearchParams(/** @type {any} */ (new FormData(form))).toString();
      return sent.pathname + sent.search;
    });
    check("a form a data-address form's patch draws, which keeps the address's query, sends the scope on screen", carried === "/smoke/address?scope=day", carried);
    // Back goes to the page before the screen, not to an earlier scope, and Forward reads the page
    // at the address the patch put in the entry (`corten: nav`), as for any entry.
    asked.length = 0;
    const steps = [];
    for (const way of /** @type {const} */ (["back", "forward"])) steps.push({ at: await traverse(way), shown: await shown(), asked: asked.splice(0).join() });
    check(
      "Back from a data-address form's answer goes to the page before, and Forward reads the page at the address the answer put in",
      steps[0].at === "/smoke/address-elsewhere" && steps[0].shown === "all" && steps[0].asked === "nav /smoke/address-elsewhere" &&
        steps[1].at === "/smoke/address?scope=day" && steps[1].shown === "day" && steps[1].asked === "nav ?scope=day",
      JSON.stringify(steps),
    );
    // A GET data-patch form without the mark draws its answer and leaves the address.
    const beforeYear = { index: await index(), entries: await entries() };
    const year = await press("Year, in place");
    const unmarked = { drawn: year, at: await at(), index: (await index()) - beforeYear.index, added: (await entries()) - beforeYear.entries, shown: await shown() };
    check(
      "a GET data-patch form without data-address leaves the address and the history entries",
      unmarked.drawn && unmarked.at === "/smoke/address?scope=day" && unmarked.index === 0 && unmarked.added === 0 && unmarked.shown === "year",
      JSON.stringify(unmarked),
    );
    // A reload of the address draws its scope: the whole screen, as without JavaScript.
    asked.length = 0;
    await scope.reload();
    const reloaded = { shown: await shown(), asked: asked.splice(0) };
    check("a reload of a data-address form's address draws the page for it", reloaded.shown === "day" && reloaded.asked.join() === "document ?scope=day", JSON.stringify(reloaded));
    // A submit a newer one of the form drops changes no address: Week's request is held before its
    // headers, Month is pressed and drawn, and Week's request, let go, is seen to its end (its
    // fetch fails, or its body is read: a timeout fails the check) and draws nothing. Month's
    // `formaction` names a place on the page, which the address keeps, as the browser keeps it
    // for the form without JavaScript.
    const week = (/** @type {URL} */ url) => url.pathname === "/smoke/address" && url.search === "?scope=week";
    /** @type {() => void} */
    let letWeekGo = () => {};
    const weekHeld = new Promise((resolve) => (letWeekGo = () => resolve(undefined)));
    await scope.route(week, async (route) => {
      if (route.request().headers()["corten"] !== "action") return route.continue();
      await weekHeld;
      await route.continue().catch(() => {});
    });
    // Week's request seen to its end: `__done` once its fetch fails or its body has been read;
    // these handlers run before the runtime's, put on after them.
    await scope.evaluate(() => {
      const fetch_ = window.fetch;
      Object.assign(window, { __done: false });
      window.fetch = function (input, init) {
        const sent = fetch_.call(this, input, init);
        const href = String(input instanceof Request ? input.url : input);
        if (!href.endsWith("/smoke/address?scope=week") || new Headers(init?.headers).get("corten") !== "action") return sent;
        window.fetch = fetch_;
        sent.then(
          (res) => {
            const text = res.text;
            res.text = () => text.call(res).finally(() => Object.assign(window, { __done: true }));
          },
          () => Object.assign(window, { __done: true }),
        );
        return sent;
      };
    });
    const beforeDrop = { index: await index(), entries: await entries() };
    asked.length = 0;
    const weekSent = scope.waitForRequest((r) => week(new URL(r.url())) && r.headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
    await scope.getByRole("button", { name: "Week", exact: true }).click();
    const weekOut = await weekSent;
    const month = await press("Month");
    const monthAt = { at: await at(), shown: await shown() };
    letWeekGo();
    const weekDone = await scope.waitForFunction(() => /** @type {any} */ (window).__done, undefined, { timeout: 5000 }).then(() => true, () => false);
    await settle();
    await scope.unroute(week);
    const dropped = {
      weekOut,
      month,
      monthAt,
      weekDone,
      at: await at(),
      shown: await shown(),
      index: (await index()) - beforeDrop.index,
      added: (await entries()) - beforeDrop.entries,
      asked: asked.splice(0),
    };
    check(
      "a data-address form's submit dropped by a newer one of the form changes no address, and the newer one's address keeps its formaction's #fragment",
      dropped.weekOut && dropped.month && dropped.weekDone && dropped.monthAt.at === "/smoke/address?scope=month#smoke-address" && dropped.monthAt.shown === "month" &&
        dropped.at === "/smoke/address?scope=month#smoke-address" && dropped.shown === "month" && dropped.index === 0 && dropped.added === 0 &&
        dropped.asked.join() === "action ?scope=week,action ?scope=month",
      JSON.stringify(dropped),
    );
    // A submit still on its way when Back is pressed is dropped: Back's entry is read, and the
    // form's answer, let go after it, draws nothing and puts no address in any entry.
    await scope.evaluate(() => {
      const text = Response.prototype.text;
      /** @type {(value?: unknown) => void} */
      let letGo = () => {};
      const waiting = new Promise((resolve) => (letGo = resolve));
      Object.assign(window, { __release: letGo, __reading: false, __read: false });
      Response.prototype.text = function () {
        if (!this.headers.has("corten-patch")) return text.call(this);
        Response.prototype.text = text;
        Object.assign(window, { __reading: true });
        return waiting.then(async () => {
          try {
            return await text.call(this);
          } finally {
            Object.assign(window, { __read: true });
          }
        });
      };
    });
    asked.length = 0;
    await scope.getByRole("button", { name: "Day", exact: true }).click();
    const heldDay = await scope.waitForFunction(() => /** @type {any} */ (window).__reading, undefined, { timeout: 5000 }).then(() => true, () => false);
    const leftFor = await traverse("back");
    await scope.evaluate(() => /** @type {any} */ (window).__release());
    const seen = await scope.waitForFunction(() => /** @type {any} */ (window).__read, undefined, { timeout: 5000 }).then(() => true, () => false);
    await settle();
    const abandoned = { heldDay, seen, leftFor, at: await at(), shown: await shown(), asked: asked.splice(0), ahead: await entryAt(1) };
    check(
      "a data-address form's submit on its way when Back is pressed draws nothing and puts no address in history",
      abandoned.heldDay && abandoned.seen && abandoned.at === "/smoke/address-elsewhere" && abandoned.shown === "all" &&
        abandoned.asked.join() === "action ?scope=day,nav /smoke/address-elsewhere" && abandoned.ahead.endsWith("/smoke/address?scope=month#smoke-address"),
      JSON.stringify(abandoned),
    );
    await traverse("forward");
    // A redirect (3xx) of the form's request, the server's own (`/smoke/address-moved` answers a
    // 303 to the day's scope): the address is where it went, with the `#fragment` of the form's
    // `formaction`, which the redirect's `Location` does not name. The request `fetch` follows
    // the redirect with is judged by its answer, a patch: Chromium does not tell Playwright the
    // headers it was sent with. Back goes to the page before the screen.
    const beforeMove = { index: await index(), entries: await entries() };
    asked.length = 0;
    const dayAnswer = scope
      .waitForResponse((r) => new URL(r.url()).pathname === "/smoke/address" && new URL(r.url()).search === "?scope=day", { timeout: 5000 })
      .then((r) => "corten-patch" in r.headers(), () => false);
    await press("Moved");
    const redirected = {
      at: await at(),
      index: (await index()) - beforeMove.index,
      added: (await entries()) - beforeMove.entries,
      shown: await shown(),
      patch: await dayAnswer,
      asked: asked.splice(0),
    };
    const redirectedBack = { at: await traverse("back"), shown: await shown(), asked: asked.splice(0) };
    check(
      "a data-address form's request redirected (3xx) puts the address it went to in the entry, with its formaction's #fragment",
      redirected.at === "/smoke/address?scope=day#smoke-address" && redirected.index === 0 && redirected.added === 0 && redirected.shown === "day" && redirected.patch &&
        redirected.asked.length === 2 && redirected.asked[0] === "action /smoke/address-moved?scope=moved" && redirected.asked[1].endsWith(" ?scope=day") &&
        redirectedBack.at === "/smoke/address-elsewhere" && redirectedBack.shown === "all" && redirectedBack.asked.join() === "nav /smoke/address-elsewhere",
      JSON.stringify({ redirected, redirectedBack }),
    );
    await traverse("forward");
    // A GET pressed while a write of the same form (its Save button) is on its way waits for the
    // write's answer, as any data-patch form's submit does, and is then sent from the form that
    // answer drew: its address takes the entry's place. The write puts none there.
    const saving = (/** @type {URL} */ url) => url.pathname === "/smoke/address" && url.search === "";
    /** @type {() => void} */
    let letSaveGo = () => {};
    const saveHeld = new Promise((resolve) => (letSaveGo = () => resolve(undefined)));
    await scope.route(saving, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await saveHeld;
      await route.continue().catch(() => {});
    });
    const beforeSave = { index: await index(), entries: await entries() };
    asked.length = 0;
    const saveSent = scope.waitForRequest((r) => saving(new URL(r.url())) && r.method() === "POST", { timeout: 5000 }).then(() => true, () => false);
    await scope.getByRole("button", { name: "Save", exact: true }).click();
    const saveOut = await saveSent;
    await scope.getByRole("button", { name: "Week", exact: true }).click();
    const waited = asked.slice();
    letSaveGo();
    await scope.waitForFunction(() => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week", undefined, { timeout: 5000 }).catch(() => {});
    await scope.unroute(saving);
    const queued = {
      saveOut,
      waited,
      at: await at(),
      shown: await shown(),
      index: (await index()) - beforeSave.index,
      added: (await entries()) - beforeSave.entries,
      asked: asked.splice(0),
    };
    check(
      "a data-address form's GET pressed while its write is on its way is sent once the write's answer is drawn, and puts its address in the entry",
      queued.saveOut && queued.waited.join() === "action " && queued.at === "/smoke/address?scope=week" && queued.shown === "week" && queued.index === 0 && queued.added === 0 &&
        queued.asked.join() === "action ,action ?scope=week",
      JSON.stringify(queued),
    );
    // A marked form sent to another route's address: the address is that one and its nav link the
    // current one, in the same entry, and Back goes to the page before the screen.
    const current = () => scope.evaluate(() => Array.from(document.querySelectorAll("main nav a[aria-current=page]"), (a) => a.getAttribute("href")).join());
    const wasCurrent = await current();
    const beforeAway = await entries();
    asked.length = 0;
    await press("Elsewhere");
    const away = { at: await at(), shown: await shown(), asked: asked.splice(0), current: await current(), added: (await entries()) - beforeAway };
    const awayBack = { at: await traverse("back"), shown: await shown(), asked: asked.splice(0) };
    check(
      "a data-address form sent to another route's address marks its nav link current, and Back from it goes to the page before",
      wasCurrent === "/smoke/address" && away.at === "/smoke/address-elsewhere?scope=far" && away.shown === "far" && away.asked.join() === "action /smoke/address-elsewhere?scope=far" &&
        away.current === "/smoke/address-elsewhere" && away.added === 0 && awayBack.at === "/smoke/address-elsewhere" && awayBack.shown === "all" &&
        awayBack.asked.join() === "nav /smoke/address-elsewhere",
      JSON.stringify({ wasCurrent, away, awayBack }),
    );
  }
  // A form without the mark keeps the queue it had: a write that waits for another of the form
  // is still sent after a GET the form sends in between. Post A is held, Post B pressed (it
  // waits for A), A answered 204, and the moment A's busy mark is cleared a script sends the
  // form's Read (a GET): the runtime asks for A, Read and B, in that order. Read by what the
  // runtime fetches: B's request cancels Read's, which Firefox can do before Read leaves.
  {
    await scope.goto(home);
    const queue = (/** @type {URL} */ url) => url.pathname === "/smoke/address" && (url.search === "" || url.search === "?scope=read");
    /** @type {() => void} */
    let letAGo = () => {};
    const aHeld = new Promise((resolve) => (letAGo = () => resolve(undefined)));
    await scope.route(queue, async (route) => {
      const req = route.request();
      if (req.headers()["corten"] !== "action") return route.continue();
      if (req.postData() === "scope=a") await aHeld;
      await route.fulfill({ status: 204 }).catch(() => {});
    });
    await scope.evaluate(() => {
      /** @type {string[]} */
      const fetched = [];
      Object.assign(window, { __fetched: fetched });
      const fetch_ = window.fetch;
      window.fetch = function (input, init) {
        const url = new URL(String(input instanceof Request ? input.url : input), location.href);
        if (url.pathname === "/smoke/address" && new Headers(init?.headers).get("corten") === "action")
          fetched.push(`${init?.method ?? "GET"} ${init?.body ?? url.search}`);
        return fetch_.call(this, input, init);
      };
      const form = /** @type {HTMLFormElement} */ (document.getElementById("smoke-address-queue"));
      const read = /** @type {HTMLButtonElement} */ (form.querySelector('button[value="read"]'));
      let busy = false;
      const seen = new MutationObserver(() => {
        if (form.hasAttribute("aria-busy")) return void (busy = true);
        if (!busy) return;
        seen.disconnect();
        form.requestSubmit(read);
      });
      seen.observe(form, { attributes: true, attributeFilter: ["aria-busy"] });
    });
    await scope.getByRole("button", { name: "Post A", exact: true }).click();
    await scope.waitForFunction(() => document.getElementById("smoke-address-queue")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).catch(() => {});
    await scope.getByRole("button", { name: "Post B", exact: true }).click();
    letAGo();
    await scope.waitForFunction(() => !document.getElementById("smoke-address-queue")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).catch(() => {});
    await scope.waitForFunction(() => /** @type {any} */ (window).__fetched.length >= 3, undefined, { timeout: 5000 }).catch(() => {});
    await scope.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
    const sent = await scope.evaluate(() => /** @type {any} */ (window).__fetched);
    await scope.unroute(queue);
    check(
      "a data-patch form's write waiting for another is still sent after a GET the form sends in between",
      sent.join() === "POST scope=a,GET ?scope=read,POST scope=b",
      JSON.stringify(sent),
    );
  }
  await scope.close();
  await markedPatchVisits(browser, errors);
  // Without JavaScript the browser sends a data-address form itself: the page at its address.
  {
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    const bare = await noScript.newPage();
    await bare.goto(home);
    await Promise.all([bare.waitForNavigation({ timeout: 5000 }).catch(() => {}), bare.getByRole("button", { name: "Week", exact: true }).click()]);
    const sent = await bare.evaluate(() => ({ at: location.pathname + location.search, shown: document.querySelector("#smoke-address output")?.textContent }));
    check("without JavaScript a data-address form loads the page at its address", sent.at === "/smoke/address?scope=week" && sent.shown === "week", JSON.stringify(sent));
    await noScript.close();
  }
  // Without the Navigation API the runtime still sends the form and draws its patch, and the
  // address it asked for takes the entry's place: there is no entry of the screen's own for Back
  // to come to, so nothing there needs the API (docs/design.md#limit-navigation-api).
  {
    const plain = await browser.newPage();
    plain.on("pageerror", (e) => errors.push(`plain address: ${e.message}`));
    await plain.addInitScript(() => {
      delete (/** @type {any} */ (Window.prototype)).navigation;
      delete (/** @type {any} */ (window)).navigation;
    });
    await plain.goto(home);
    const length = await plain.evaluate(() => (Object.assign(window, { __marker: 1 }), history.length));
    await plain.getByRole("button", { name: "Week", exact: true }).click();
    await plain.waitForFunction(() => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week", undefined, { timeout: 5000 }).catch(() => {});
    const sent = await plain.evaluate((length) => ({
      api: "navigation" in window,
      at: location.pathname + location.search,
      shown: document.querySelector("#smoke-address output")?.textContent,
      kept: /** @type {any} */ (window).__marker === 1,
      added: history.length - length,
    }), length);
    check(
      "without the Navigation API a data-address form's patch is drawn in place and its address takes the entry's place",
      !sent.api && sent.at === "/smoke/address?scope=week" && sent.shown === "week" && sent.kept && sent.added === 0,
      JSON.stringify(sent),
    );
    // Back and Forward between entries of the page that differ by their `#id` are entries all the
    // same without the API, seen by `popstate`.
    const trip = await fragmentRoundTrip(plain);
    check(
      "without the Navigation API a marked patch on its way while Back and Forward go to another #id of the page and back draws nothing",
      trip.out && trip.trip.join() === ",#smoke-address" && trip.done && trip.at === "#smoke-address" && trip.shown === "all",
      JSON.stringify(trip),
    );
    // The page reading itself again (`ReadAgain`, a tag put in the screen's head) goes by the
    // page's path without the API: an answer whose address is on another path starts it there.
    const other = `${base}/smoke/address-other?scope=week`;
    await plain.route(home, async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
      const body = (await res.text()).replace("</head>", '<noscript data-corten-read-again="2"></noscript></head>');
      await route.fulfill({ response: res, body });
    });
    await plain.route(other, (route) =>
      route.fulfill(
        route.request().headers()["corten"] === "action"
          ? { headers: { "corten-patch": "1", "content-type": "text/html" }, body: '<section id="smoke-address"><output>other</output></section>' }
          : { headers: { "content-type": "text/html" }, body: "<!doctype html><title>other</title>" },
      ),
    );
    await plain.goto(home);
    const readThere = plain.waitForRequest((r) => r.url() === other && r.resourceType() === "document", { timeout: 8000 }).then(() => true, () => false);
    await plain.evaluate((action) => {
      const form = document.createElement("form");
      form.action = action;
      form.dataset.patch = "";
      form.dataset.address = "";
      const field = document.createElement("input");
      field.name = "scope";
      field.value = "week";
      form.append(field);
      document.body.append(form);
      form.requestSubmit();
    }, other.split("?")[0]);
    const moved = await plain
      .waitForFunction(() => location.pathname === "/smoke/address-other" && document.querySelector("#smoke-address output")?.textContent === "other", undefined, { timeout: 5000 })
      .then(() => true, () => false);
    const readAgain = { moved, read: await readThere };
    await plain.unroute(home);
    await plain.unroute(other);
    check("without the Navigation API a marked patch that moves the address to another path reads the page again there", readAgain.moved && readAgain.read, JSON.stringify(readAgain));
    await plain.close();
  }
  check("no page errors on the data-address screens", errors.length === 0, errors.join(" | "));
}

/**
 * A marked answer draws, and puts its address in the entry, only on the visit it was sent from,
 * and only when its patch draws whole and is not a server's failure.
 * @param {import("@playwright/test").Browser} browser @param {string[]} errors
 */
async function markedPatchVisits(browser, errors) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`visits: ${e.message}`));
  const home = `${base}/smoke/address`;
  await page.goto(home);
  if (!(await page.evaluate(() => "navigation" in window))) {
    skip("a marked patch is fenced to its visit and moves the address only on a completed draw", "no Navigation API");
    await page.close();
    return;
  }
  const state = () =>
    page.evaluate(() => ({
      at: location.search,
      shown: document.querySelector("#smoke-address output")?.textContent ?? null,
      index: /** @type {any} */ (window).navigation.currentEntry.index,
      entries: /** @type {any} */ (window).navigation.entries().length,
    }));
  const press = (/** @type {string} */ name) => page.getByRole("button", { name, exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const wait = async (/** @type {() => unknown} */ predicate) => page.waitForFunction(predicate, undefined, { timeout: 5000 }).then(() => true, () => false);
  const trackForm = () =>
    page.evaluate(() => {
      Object.assign(window, { __form: document.getElementById("smoke-address-form") });
    });
  const finished = () => wait(() => !(/** @type {any} */ (window).__form.hasAttribute("aria-busy")));
  const week = `${home}?scope=week`;
  const month = `${home}?scope=month`;
  const startMonth = () =>
    page.evaluate((url) => {
      const nav = /** @type {any} */ (window).navigation.navigate(url);
      nav.committed.catch(() => {});
      Object.assign(window, { __month: nav.finished.then(() => "finished", (/** @type {Error} */ error) => error.name) });
    }, month);
  const finishMonth = () => page.evaluate(() => /** @type {any} */ (window).__month);
  const hold = async (/** @type {string} */ url, /** @type {string} */ mode, status = 0) => {
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    await page.route(url, async (route) => {
      if (route.request().headers()["corten"] !== mode) return route.continue();
      await held;
      if (status) await route.fulfill({ status });
      else await route.continue().catch(() => {});
    });
    const sent = page.waitForRequest((r) => r.url() === url && r.headers()["corten"] === mode, { timeout: 5000 }).then(() => true, () => false);
    return { sent, release, clear: () => page.unroute(url) };
  };

  // Submit from the still-visible page after a visit starts, before its page can draw: the answer,
  // which comes while the navigation waits, neither draws nor replaces the entry the navigation is
  // making, nor cancels the navigation.
  const pending = await hold(month, "nav");
  const before = await state();
  await startMonth();
  const navSent = await pending.sent;
  await trackForm();
  const weekAnswer = page.waitForResponse((r) => r.url() === week && r.request().headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
  await press("Week");
  const actionAnswered = await weekAnswer;
  const actionDone = await finished();
  const still = await state();
  pending.release();
  const navDone = await finishMonth();
  await pending.clear();
  const after = await state();
  check(
    "a marked patch from the visible page cannot draw or cancel a pending visit",
    navSent && actionAnswered && actionDone && still.shown === "all" && still.index <= before.index + 1 && still.at !== "?scope=week" && navDone === "finished" &&
      after.shown === "month" && after.at === "?scope=month" && after.index === before.index + 1,
    JSON.stringify({ navSent, actionAnswered, actionDone, still, navDone, after, before }),
  );

  // Another form's answer, a page, drawn in place while a marked answer is on its way, twice and
  // byte-identical: the page on screen is still the visit, on the same entry, so the marked answer
  // draws and puts its address in the entry.
  await page.goto(home);
  const ordinary = `${home}?scope=ordinary`;
  // The server's own page answer, its `corten-page` and `corten-shell` headers included, for each.
  const answer = await fetch(home, { headers: { corten: "nav" } });
  const markup = await answer.text();
  const headers = Object.fromEntries(["corten-page", "corten-shell", "content-type"].flatMap((name) => (answer.headers.has(name) ? [[name, answer.headers.get(name) ?? ""]] : [])));
  await page.route(ordinary, (route) => route.fulfill({ headers, body: markup }));
  const addOrdinary = () =>
    page.evaluate((action) => {
      const form = document.createElement("form");
      form.action = action;
      form.dataset.patch = "";
      const field = document.createElement("input");
      field.name = "scope";
      field.value = "ordinary";
      form.append(field);
      document.body.append(form);
      Object.assign(window, { __ordinary: form });
    }, home);
  await addOrdinary();
  const redraw = async () => {
    await page.evaluate(() => {
      Object.assign(window, { __before: document.getElementById("smoke-address") });
      /** @type {any} */ (window).__ordinary.requestSubmit();
    });
    return wait(() => document.getElementById("smoke-address") !== /** @type {any} */ (window).__before && !(/** @type {any} */ (window).__ordinary.hasAttribute("aria-busy")));
  };
  const firstDraw = await redraw();
  const marked = await hold(week, "action");
  await trackForm();
  await press("Week");
  const markedSent = await marked.sent;
  const secondDraw = await redraw();
  marked.release();
  const markedDone = await finished();
  await marked.clear();
  await page.unroute(ordinary);
  const identical = await state();
  check(
    "a marked patch draws and puts its address in the entry after another form's page is drawn in place",
    firstDraw && markedSent && secondDraw && markedDone && identical.shown === "week" && identical.at === "?scope=week",
    JSON.stringify({ firstDraw, markedSent, secondDraw, markedDone, identical }),
  );

  // Let the write answer 204, hold the queued retry task itself, then draw a page with the same form ID.
  await page.goto(home);
  const save = await hold(home, "action", 204);
  await press("Save");
  const saveSent = await save.sent;
  await press("Week");
  await page.evaluate(() => {
    const timeout = window.setTimeout;
    /** @type {any} */ (window).setTimeout = function (/** @type {TimerHandler} */ fn, /** @type {number | undefined} */ delay, /** @type {any[]} */ ...args) {
      if (delay !== undefined) return timeout.call(this, fn, delay, ...args);
      window.setTimeout = timeout;
      Object.assign(window, { __retry: fn });
      return 0;
    };
  });
  save.release();
  const retryHeld = await wait(() => !!(/** @type {any} */ (window).__retry));
  await save.clear();
  await startMonth();
  const queuedNav = await finishMonth();
  const retried = await page.evaluate(() => {
    let sent = false;
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      if (String(input).endsWith("?scope=week") && new Headers(init?.headers).get("corten") === "action") sent = true;
      return fetch_.call(this, input, init);
    };
    /** @type {any} */ (window).__retry?.();
    window.fetch = fetch_;
    return sent;
  });
  const queued = await state();
  check(
    "a marked GET queued behind a 204 write is not retried from the next visit",
    saveSent && retryHeld && queuedNav === "finished" && !retried && queued.at === "?scope=month" && queued.shown === "month",
    JSON.stringify({ saveSent, retryHeld, queuedNav, retried, queued }),
  );

  // The page reading itself again (`ReadAgain`, here a tag put in the screen's head) is the same
  // visit on the same entry: Week, pressed while the read is on its way, draws, and its address takes
  // the entry's place, which cancels the read; the read starts again later, at that address.
  await page.goto(home);
  const reading = await hold(home, "nav");
  await page.route(home, async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    // Uncompressed: Firefox's route.fetch reads a compressed body it was not sent as empty.
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
    const body = (await res.text()).replace("</head>", '<noscript data-corten-read-again="1"></noscript></head>');
    await route.fulfill({ response: res, body });
  });
  await page.goto(home);
  const readSent = await reading.sent;
  const readOnItsWay = await page.evaluate(() => !!(/** @type {any} */ (window).navigation.transition));
  await trackForm();
  const againAnswer = page.waitForResponse((r) => r.url() === week && r.request().headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
  const readAgain = page.waitForRequest((r) => r.url() === week && r.headers()["corten"] === "nav", { timeout: 5000 }).then(() => true, () => false);
  await press("Week");
  const againAnswered = await againAnswer;
  const againDone = await finished();
  const duringRead = await state();
  const readCancelled = await page.evaluate(() => !(/** @type {any} */ (window).navigation.transition));
  reading.release();
  const readLater = await readAgain;
  await page.unroute(home);
  await reading.clear();
  const afterRead = await state();
  check(
    "a marked patch pressed while the page reads itself again draws and puts its address in the entry, and the read starts again there",
    readSent && readOnItsWay && againAnswered && againDone && duringRead.at === "?scope=week" && duringRead.shown === "week" && duringRead.entries === afterRead.entries &&
      readCancelled && readLater && afterRead.at === "?scope=week" && afterRead.shown === "week",
    JSON.stringify({ readSent, readOnItsWay, againAnswered, againDone, duringRead, readCancelled, readLater, afterRead }),
  );

  // Back to an entry of the same page that differs by its `#id` alone, which the runtime does not
  // take (nothing to read), is another entry all the same: an answer on its way draws nothing, and
  // puts its address in neither entry.
  await page.goto(home);
  await page.evaluate(() => /** @type {any} */ (window).navigation.navigate("#smoke-address").finished);
  const fragment = await hold(week, "action");
  await trackForm();
  await press("Week");
  const fragmentSent = await fragment.sent;
  const backTo = await page.evaluate(() => /** @type {any} */ (window).navigation.back().finished.then(() => location.hash, (/** @type {Error} */ e) => e.name));
  fragment.release();
  const fragmentDone = await finished();
  await fragment.clear();
  const fragmentBack = await page.evaluate(() => {
    const nav = /** @type {any} */ (window).navigation;
    return { at: location.search + location.hash, shown: document.querySelector("#smoke-address output")?.textContent, ahead: nav.entries()[nav.currentEntry.index + 1]?.url ?? "" };
  });
  check(
    "a marked patch on its way when Back goes to an entry of the page that differs by its #id draws nothing and puts no address in history",
    fragmentSent && backTo === "" && fragmentDone && fragmentBack.at === "" && fragmentBack.shown === "all" && fragmentBack.ahead === `${home}#smoke-address`,
    JSON.stringify({ fragmentSent, backTo, fragmentDone, fragmentBack }),
  );
  // Back to that entry and Forward again, to the entry the submit was sent from, before its answer
  // comes: the page has left the entry and come back, so the answer draws nothing all the same.
  const trip = await fragmentRoundTrip(page);
  check(
    "a marked patch on its way while Back and Forward go to another #id of the page and back draws nothing and puts no address in history",
    trip.out && trip.trip.join() === ",#smoke-address" && trip.done && trip.at === "#smoke-address" && trip.shown === "all",
    JSON.stringify(trip),
  );

  // Day, pressed on the form drawn in place of the one Week was pressed on (another form's page
  // drawn in place between the presses), is a newer submit of the same form, by its id: it drops
  // Week, whose answer, let go after Day's has drawn, draws nothing and puts no address in the entry.
  await page.goto(home);
  await page.route(ordinary, (route) => route.fulfill({ headers, body: markup }));
  await addOrdinary();
  const weekHeld = await hold(week, "action");
  const dayHeld = await hold(`${home}?scope=day`, "action");
  await page.evaluate(() => {
    const fetch_ = window.fetch;
    Object.assign(window, { __weekEnded: false });
    window.fetch = function (input, init) {
      const sent = fetch_.call(this, input, init);
      if (!String(input instanceof Request ? input.url : input).endsWith("?scope=week") || new Headers(init?.headers).get("corten") !== "action") return sent;
      window.fetch = fetch_;
      const ended = () => Object.assign(window, { __weekEnded: true });
      sent.then((res) => {
        const text = res.text;
        res.text = () => text.call(res).finally(ended);
      }, ended);
      return sent;
    };
  });
  await press("Week");
  const weekOut = await weekHeld.sent;
  const redrawn = await redraw();
  await press("Day");
  const dayOut = await dayHeld.sent;
  dayHeld.release();
  const dayDrawn = await wait(() => location.search === "?scope=day" && document.querySelector("#smoke-address output")?.textContent === "day");
  weekHeld.release();
  const weekEnded = await wait(() => /** @type {any} */ (window).__weekEnded);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  await weekHeld.clear();
  await dayHeld.clear();
  await page.unroute(ordinary);
  const latest = await state();
  check(
    "a marked GET pressed on the form drawn in place of the one an earlier press came from drops that press, whose late answer draws nothing",
    weekOut && redrawn && dayOut && dayDrawn && weekEnded && latest.at === "?scope=day" && latest.shown === "day",
    JSON.stringify({ weekOut, redrawn, dayOut, dayDrawn, weekEnded, latest }),
  );

  // A page's own `navigate` listener that cancels the replacement refuses the address: the entry's
  // own page is read again whole, so the answer is not left on screen under the entry's address.
  await page.goto(home);
  await page.evaluate(() =>
    /** @type {any} */ (window).navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (event.navigationType === "replace" && new URL(event.destination.url).search === "?scope=week") event.preventDefault();
    }),
  );
  const vetoStart = await state();
  const vetoRead = page.waitForRequest((r) => r.url() === home && r.resourceType() === "document", { timeout: 5000 }).then(() => true, () => false);
  const vetoLoaded = page.waitForEvent("load", { timeout: 5000 }).then(() => true, () => false);
  await press("Week");
  const vetoed = { read: await vetoRead, loaded: await vetoLoaded, ...(await state()) };
  check(
    "a marked patch whose replacement a navigate listener cancels reads the entry's own page again",
    vetoed.read && vetoed.loaded && vetoed.at === "" && vetoed.shown === "all" && vetoed.entries === vetoStart.entries,
    JSON.stringify({ vetoStart, vetoed }),
  );

  // A page's own `navigate` listener that submits a marked form as a navigation to another page
  // begins, after the runtime's listener: the runtime has begun that visit, though the browser
  // shows the navigation as on its way only once the event is dispatched. The answer, which comes
  // while the navigation waits for its page, draws nothing and leaves the navigation to finish.
  await page.goto(home);
  const navigating = await hold(month, "nav");
  await page.evaluate(() =>
    /** @type {any} */ (window).navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (new URL(event.destination.url).search !== "?scope=month") return;
      const button = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="week"]'));
      button.form?.requestSubmit(button);
    }),
  );
  await trackForm();
  const listenerAnswer = page.waitForResponse((r) => r.url() === week && r.request().headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
  await startMonth();
  const listenerNavSent = await navigating.sent;
  const listenerAnswered = await listenerAnswer;
  const listenerDone = await finished();
  const listenerStill = await state();
  navigating.release();
  const listenerNav = await finishMonth();
  await navigating.clear();
  const listenerAfter = await state();
  check(
    "a marked patch a navigate listener sends as a navigation to another page begins draws nothing and lets the navigation finish",
    listenerNavSent && listenerAnswered && listenerDone && listenerStill.shown === "all" && listenerStill.at !== "?scope=week" && listenerNav === "finished" &&
      listenerAfter.at === "?scope=month" && listenerAfter.shown === "month",
    JSON.stringify({ listenerNavSent, listenerAnswered, listenerDone, listenerStill, listenerNav, listenerAfter }),
  );

  // The page read again for a refused replacement is another visit as it begins: another marked
  // answer, let go while that read is on its way, draws nothing and puts no address in the entry.
  // What the page draws is said from the page as it happens: the page can be read from no more
  // while its read is on its way.
  /** @type {string[]} */
  const drawnWhile = [];
  /** @type {(value?: unknown) => void} */
  let heldEnded = () => {};
  const heldEnd = new Promise((resolve) => (heldEnded = resolve));
  await page.exposeFunction("__addressSeen", (/** @type {string} */ seen) => (seen === "ended" ? heldEnded() : drawnWhile.push(seen)));
  await page.goto(home);
  const held = `${home}?scope=held`;
  /** @type {() => void} */
  let releaseHeld = () => {};
  const heldAnswer = new Promise((resolve) => (releaseHeld = () => resolve(undefined)));
  await page.route(held, async (route) => {
    await heldAnswer;
    await route.fulfill({ headers: { "corten-patch": "1", "content-type": "text/html" }, body: '<section id="smoke-address"><output>held</output></section>' }).catch(() => {});
  });
  /** @type {() => void} */
  let releaseReload = () => {};
  const reloadHeld = new Promise((resolve) => (releaseReload = () => resolve(undefined)));
  await page.route(home, async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    await reloadHeld;
    await route.continue().catch(() => {});
  });
  const heldSent = page.waitForRequest((r) => r.url() === held, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate((action) => {
    const say = /** @type {(seen: string) => void} */ (/** @type {any} */ (window).__addressSeen);
    /** @type {any} */ (window).navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (event.navigationType === "replace" && new URL(event.destination.url).search === "?scope=week") event.preventDefault();
    });
    const form = document.createElement("form");
    form.action = action;
    form.dataset.patch = "";
    form.dataset.address = "";
    const field = document.createElement("input");
    field.name = "scope";
    field.value = "held";
    form.append(field);
    document.body.append(form);
    new MutationObserver(() => say(`${location.search} ${document.querySelector("#smoke-address output")?.textContent}`)).observe(
      /** @type {Element} */ (document.querySelector("main")),
      { childList: true, subtree: true },
    );
    let busy = false;
    new MutationObserver(() => {
      if (form.hasAttribute("aria-busy")) return void (busy = true);
      if (busy) setTimeout(() => requestAnimationFrame(() => say("ended")));
    }).observe(form, { attributes: true, attributeFilter: ["aria-busy"] });
    form.requestSubmit();
  }, home);
  const heldOut = await heldSent;
  const reloadSent = page.waitForRequest((r) => r.url() === home && r.resourceType() === "document", { timeout: 5000 }).then(() => true, () => false);
  await press("Week");
  const reloading = await reloadSent;
  releaseHeld();
  // WebKit stops the held request as the page is read again; nothing ends it the page can say.
  await Promise.race([heldEnd, new Promise((resolve) => setTimeout(resolve, 3000))]);
  const reloaded = page.waitForEvent("load", { timeout: 5000 }).then(() => true, () => false);
  releaseReload();
  const reloadDone = await reloaded;
  await page.unroute(home);
  await page.unroute(held);
  const afterReload = { heldOut, reloading, drawnWhile, done: reloadDone, ...(await state()) };
  check(
    "a marked patch let go while the page is read again for a refused replacement draws nothing and puts no address in the entry",
    heldOut && reloading && drawnWhile.length > 0 && drawnWhile.every((seen) => seen === " week") && afterReload.done && afterReload.at === "" && afterReload.shown === "all",
    JSON.stringify(afterReload),
  );
  // A GET queued behind a write of the form is an older press than one of the form a read drew in
  // its place: Day, pressed there, is not dropped for Week when the write's answer comes.
  await page.goto(home);
  await page.route(ordinary, (route) => route.fulfill({ headers, body: markup }));
  await addOrdinary();
  const writing = await hold(home, "action", 204);
  const dayLater = await hold(`${home}?scope=day`, "action");
  await page.evaluate(() => {
    /** @type {string[]} */
    const reads = [];
    Object.assign(window, { __reads: reads, __saving: document.getElementById("smoke-address-form") });
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(String(input instanceof Request ? input.url : input), location.href);
      if (url.pathname === "/smoke/address" && /^\?scope=(day|week)$/.test(url.search) && new Headers(init?.headers).get("corten") === "action") reads.push(url.search);
      return fetch_.call(this, input, init);
    };
  });
  await press("Save");
  const writeSent = await writing.sent;
  await press("Week");
  const formRedrawn = await redraw();
  await press("Day");
  const laterSent = await dayLater.sent;
  writing.release();
  const writeDone = await wait(() => !(/** @type {any} */ (window).__saving.hasAttribute("aria-busy")));
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  dayLater.release();
  const laterDrawn = await wait(() => location.search === "?scope=day" && document.querySelector("#smoke-address output")?.textContent === "day");
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  await writing.clear();
  await dayLater.clear();
  await page.unroute(ordinary);
  const superseded = { reads: await page.evaluate(() => /** @type {any} */ (window).__reads), ...(await state()) };
  check(
    "a GET queued behind a write is dropped by a press of the form a read drew in its place",
    writeSent && formRedrawn && laterSent && writeDone && laterDrawn && superseded.reads.join() === "?scope=day" && superseded.at === "?scope=day" && superseded.shown === "day",
    JSON.stringify({ writeSent, formRedrawn, laterSent, writeDone, laterDrawn, superseded }),
  );

  // Pressed once the write's answer has drawn the form again, before the GET that waited for it is
  // sent (in a task of its own), Day is newer than that GET all the same: it drops Week, which is not
  // sent. Pressed the moment the write's busy mark is cleared, as its submit ends.
  await page.goto(home);
  const saving = await hold(home, "action");
  const dayAfter = await hold(`${home}?scope=day`, "action");
  await page.evaluate(() => {
    /** @type {string[]} */
    const reads = [];
    const form = /** @type {HTMLFormElement} */ (document.getElementById("smoke-address-form"));
    Object.assign(window, { __reads: reads, __saving: form, __dayPressed: false });
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(String(input instanceof Request ? input.url : input), location.href);
      if (url.pathname === "/smoke/address" && /^\?scope=(day|week)$/.test(url.search) && new Headers(init?.headers).get("corten") === "action") reads.push(url.search);
      return fetch_.call(this, input, init);
    };
    let busy = false;
    const watch = new MutationObserver(() => {
      if (form.hasAttribute("aria-busy")) return void (busy = true);
      if (!busy) return;
      watch.disconnect();
      const day = /** @type {HTMLButtonElement | null} */ (document.querySelector('#smoke-address-form button[value="day"]'));
      Object.assign(window, { __dayPressed: !!day && day.form !== form });
      day?.click();
    });
    watch.observe(form, { attributes: true, attributeFilter: ["aria-busy"] });
  });
  await press("Save");
  const savingSent = await saving.sent;
  await press("Week");
  saving.release();
  const daySentAfter = await dayAfter.sent;
  const dayPressed = await page.evaluate(() => /** @type {any} */ (window).__dayPressed);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  dayAfter.release();
  const dayAfterDrawn = await wait(() => location.search === "?scope=day" && document.querySelector("#smoke-address output")?.textContent === "day");
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  await saving.clear();
  await dayAfter.clear();
  const afterSave = { reads: await page.evaluate(() => /** @type {any} */ (window).__reads), ...(await state()) };
  check(
    "a GET queued behind a write is dropped by a press of the form the write's answer drew before that GET is sent",
    savingSent && daySentAfter && dayPressed && dayAfterDrawn && afterSave.reads.join() === "?scope=day" && afterSave.at === "?scope=day" && afterSave.shown === "day",
    JSON.stringify({ savingSent, daySentAfter, dayPressed, dayAfterDrawn, afterSave }),
  );

  // A page's own `navigatesuccess` listener, put on before the runtime's, that begins a navigation to
  // another page as one ends: the runtime hears the one that ended end after the next began, which
  // is then on its way all the same. Week, pressed while it waits for its page, draws nothing and
  // lets it finish.
  const chained = await browser.newPage();
  chained.on("pageerror", (e) => errors.push(`chained: ${e.message}`));
  await chained.addInitScript((url) => {
    const nav = /** @type {any} */ (window).navigation;
    nav?.addEventListener("navigatesuccess", () => {
      if (location.search !== "?scope=day" || /** @type {any} */ (window).__chainedMonth) return;
      const next = nav.navigate(url);
      next.committed.catch(() => {});
      Object.assign(window, { __chainedMonth: next.finished.then(() => "finished", (/** @type {Error} */ error) => error.name) });
    });
  }, month);
  await chained.goto(home);
  /** @type {() => void} */
  let releaseChained = () => {};
  const chainedHeld = new Promise((resolve) => (releaseChained = () => resolve(undefined)));
  await chained.route(month, async (route) => {
    if (route.request().headers()["corten"] !== "nav") return route.continue();
    await chainedHeld;
    await route.continue().catch(() => {});
  });
  const chainedSent = chained.waitForRequest((r) => r.url() === month && r.headers()["corten"] === "nav", { timeout: 5000 }).then(() => true, () => false);
  await chained.evaluate((url) => /** @type {any} */ (window).navigation.navigate(url).finished.catch(() => {}), `${home}?scope=day`);
  const chainedNav = await chainedSent;
  const chainedState = () =>
    chained.evaluate(() => ({ at: location.search, shown: document.querySelector("#smoke-address output")?.textContent ?? null }));
  const chainedStill0 = await chainedState();
  await chained.evaluate(() => Object.assign(window, { __form: document.getElementById("smoke-address-form") }));
  const chainedAnswer = chained.waitForResponse((r) => r.url() === week && r.request().headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
  await chained.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const chainedAnswered = await chainedAnswer;
  const chainedDone = await chained
    .waitForFunction(() => !(/** @type {any} */ (window).__form.hasAttribute("aria-busy")), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await chained.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  const chainedStill = await chainedState();
  releaseChained();
  const chainedFinished = await chained.evaluate(() => /** @type {any} */ (window).__chainedMonth);
  await chained.unroute(month);
  const chainedAfter = await chainedState();
  await chained.close();
  check(
    "a marked patch pressed while a navigation another one's navigatesuccess began is on its way draws nothing and lets it finish",
    chainedNav && chainedStill0.shown === "day" && chainedAnswered && chainedDone && chainedStill.shown === "day" && chainedStill.at !== "?scope=week" &&
      chainedFinished === "finished" && chainedAfter.at === "?scope=month" && chainedAfter.shown === "month",
    JSON.stringify({ chainedNav, chainedStill0, chainedAnswered, chainedDone, chainedStill, chainedFinished, chainedAfter }),
  );

  // A replacement the browser refuses with an exception (WebKit's SecurityError at its limit of
  // history updates) is refused all the same: the entry's own page is read again, whole.
  await page.goto(home);
  await page.evaluate(() => {
    const replace = history.replaceState;
    history.replaceState = function (...args) {
      if (!String(args[2]).endsWith("?scope=week")) return replace.apply(this, args);
      history.replaceState = replace;
      throw new DOMException("history.replaceState() called too often", "SecurityError");
    };
  });
  const thrownRead = page.waitForRequest((r) => r.url() === home && r.resourceType() === "document", { timeout: 5000 }).then(() => true, () => false);
  const thrownLoaded = page.waitForEvent("load", { timeout: 5000 }).then(() => true, () => false);
  await press("Week");
  const thrown = { read: await thrownRead, loaded: await thrownLoaded, ...(await state()) };
  check(
    "a marked patch whose replacement throws reads the entry's own page again",
    thrown.read && thrown.loaded && thrown.at === "" && thrown.shown === "all",
    JSON.stringify(thrown),
  );
  const patch = async (/** @type {number} */ status, /** @type {string} */ body) => {
    await page.goto(home);
    const start = await state();
    await page.route(week, (route) => route.fulfill({ status, headers: { "corten-patch": "1", "content-type": "text/html" }, body }));
    await trackForm();
    await press("Week");
    const done = await finished();
    await page.unroute(week);
    const end = await state();
    return { done, ...end, added: end.entries - start.entries };
  };
  const empty = await patch(200, "");
  const missing = await patch(200, '<p id="missing-scope">Missing</p>');
  const partial = await patch(200, '<template id="smoke-address" data-remove></template><p id="smoke-address">Too late</p>');
  const ordered = await patch(200, '<section id="smoke-address"><output id="new-scope">First</output></section><output id="new-scope">Second</output>');
  // A removal of an element the page no longer has is done: what it asks for is the case.
  const gone = await patch(200, '<template id="smoke-address-gone" data-remove></template><section id="smoke-address"><output>Kept</output></section>');
  const goneAlone = await patch(200, '<template id="smoke-address-gone" data-remove></template>');
  check(
    "a marked patch puts its address in the entry only when it draws and skips no element",
    [empty, missing, partial].every((p) => p.done && p.at === "" && p.added === 0) && empty.shown === "all" && missing.shown === "all" && partial.shown === null &&
      ordered.done && ordered.at === "?scope=week" && ordered.added === 0 && ordered.shown === "Second",
    JSON.stringify({ empty, missing, partial, ordered }),
  );
  check(
    "a marked patch that removes an element the page no longer has puts its address in the entry",
    [gone, goneAlone].every((p) => p.done && p.at === "?scope=week" && p.added === 0) && gone.shown === "Kept" && goneAlone.shown === "all",
    JSON.stringify({ gone, goneAlone }),
  );

  // A page answer (`corten-page`, `<main>`) is the page at the address asked for too: it is drawn
  // in place, and the address takes the entry's place.
  const weekPage = await fetch(week, { headers: { corten: "nav" } });
  const weekMarkup = await weekPage.text();
  const pageHeaders = Object.fromEntries(["corten-page", "corten-shell", "content-type"].flatMap((name) => (weekPage.headers.has(name) ? [[name, weekPage.headers.get(name) ?? ""]] : [])));
  await page.goto(home);
  const pageStart = await state();
  await page.route(week, (route) => (route.request().headers()["corten"] === "action" ? route.fulfill({ headers: pageHeaders, body: weekMarkup }) : route.continue()));
  await trackForm();
  await press("Week");
  const pageDone = await finished();
  await page.unroute(week);
  const pageEnd = await state();
  check(
    "a marked form's page answer is drawn in place and puts its address in the entry",
    "corten-page" in pageHeaders && pageDone && pageEnd.at === "?scope=week" && pageEnd.shown === "week" && pageEnd.entries === pageStart.entries,
    JSON.stringify({ pageHeaders, pageDone, pageStart, pageEnd }),
  );

  const failed = await patch(500, '<section id="smoke-address"><output>Failed</output></section>');
  const invalid = await patch(422, '<section id="smoke-address"><output>Invalid</output></section>');
  check(
    "a drawn 5xx marked patch leaves the address alone while a drawn 4xx may change it",
    failed.done && failed.at === "" && failed.added === 0 && failed.shown === "Failed" && invalid.done && invalid.at === "?scope=week" && invalid.added === 0 &&
      invalid.shown === "Invalid",
    JSON.stringify({ failed, invalid }),
  );
  await page.close();
}

/**
 * Presses Week on the screen's entry at its `#id`, holds its answer, goes Back to the entry before
 * and Forward to that one again by the history API (so the same in a browser without the
 * Navigation API), then lets the answer go, and says where the page is once its submit has ended.
 * @param {import("@playwright/test").Page} page
 */
async function fragmentRoundTrip(page) {
  const week = `${base}/smoke/address?scope=week`;
  await page.goto(`${base}/smoke/address`);
  await page.evaluate(() => (location.hash = "smoke-address"));
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    await held;
    await route.continue().catch(() => {});
  });
  const sent = page.waitForRequest((r) => r.url() === week && r.headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => Object.assign(window, { __form: document.getElementById("smoke-address-form") }));
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const out = await sent;
  const trip = await page.evaluate(async () => {
    const step = (/** @type {"back" | "forward"} */ way) =>
      new Promise((resolve) => {
        addEventListener("popstate", () => resolve(location.hash), { once: true });
        history[way]();
      });
    return [await step("back"), await step("forward")];
  });
  release();
  const done = await page
    .waitForFunction(() => !(/** @type {any} */ (window).__form.hasAttribute("aria-busy")), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  await page.unroute(week);
  const end = await page.evaluate(() => ({ at: location.search + location.hash, shown: document.querySelector("#smoke-address output")?.textContent }));
  return { out, trip, done, ...end };
}
