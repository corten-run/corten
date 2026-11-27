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
  // A redirect (3xx) of the form's request, the server's own (`/smoke/address-moved` answers a 303
  // to the day's scope, not Corten's `corten-location`): `fetch` follows it and shows no `#id` its
  // `Location` names. The answer is drawn in place, with no other request and no load, and the
  // address is where the redirect went, with no `#id` at all: from an action without one ("Moved,
  // bare") that is the browser's own GET's address, and from one with an `#id` the browser's own
  // GET reaches the `Location`'s `#id` when it names one ("Moved, placed"), else the action's
  // ("Moved"), which the runtime cannot tell apart, and does not guess. Each from the screen at
  // another query and from the screen at the redirect's destination but for an `#id`, with and
  // without the Navigation API; each beside the browser's own GET without JavaScript. Neither is
  // the submitted request's own address (`/smoke/address-moved`), so this catches a request of the
  // document after the answer, not a reload where the two differ by their `#id` alone.
  for (const plain of [false, true]) {
    const api = plain ? "without the Navigation API " : "";
    for (const from of ["/smoke/address", "/smoke/address?scope=day#smoke-address"]) {
      const runs = /** @type {const} */ ([
        ["Moved, bare", "moved", "/smoke/address?scope=day"],
        ["Moved", "moved", "/smoke/address?scope=day#smoke-address"],
        ["Moved, placed", "placed", "/smoke/address?scope=day#smoke-address-form"],
      ]);
      /** @type {Record<string, Awaited<ReturnType<typeof movedBy303>>>} */
      const got = {};
      for (const [name] of runs) got[name] = await movedBy303(browser, name, plain, errors, from);
      check(
        `${api}a data-address form's request redirected (3xx), pressed at ${from}, is drawn in place with no other request, and puts in the address it went to without an #id, which the browser's own GET reaches with the Location's #id, else the action's`,
        runs.every(
          ([name, scope, browserGet]) =>
            !got[name].loaded &&
            got[name].browserGet.at === browserGet &&
            got[name].at === "/smoke/address?scope=day" &&
            got[name].shown === "day" &&
            got[name].added === 0 &&
            got[name].documents.length === 0 &&
            got[name].asked.length === 2 &&
            got[name].asked[0] === `action /smoke/address-moved?scope=${scope}` &&
            got[name].asked[1].endsWith(" /smoke/address?scope=day") &&
            got[name].back === "/smoke/address-elsewhere",
        ),
        JSON.stringify(got),
      );
    }
  }
  // Without JavaScript the browser sends a data-address form itself: the page at its address.
  {
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    const bare = await noScript.newPage();
    await bare.goto(home);
    await Promise.all([bare.waitForNavigation({ timeout: 5000 }).catch(() => {}), bare.getByRole("button", { name: "Week", exact: true }).click()]);
    const sent = await bare.evaluate(() => ({ at: location.pathname + location.search, shown: document.querySelector("#smoke-address output")?.textContent }));
    check("without JavaScript a data-address form loads the page at its address", sent.at === "/smoke/address?scope=week" && sent.shown === "week", JSON.stringify(sent));
    // A submit that sends no field, to an action with a bare `#`: the browser's own GET keeps the
    // query's `?`, empty, and the `#`, and so does the address the runtime puts in.
    const unnamed = async (/** @type {import("@playwright/test").Page} */ page, /** @type {boolean} */ script) => {
      await page.goto(`${home}?scope=week`);
      await page.evaluate(() => {
        const day = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="day"]'));
        day.removeAttribute("name");
        day.setAttribute("formaction", "/smoke/address#");
      });
      const day = page.getByRole("button", { name: "Day", exact: true });
      if (script) await day.click();
      else await Promise.all([page.waitForNavigation({ timeout: 5000 }).catch(() => {}), day.click()]);
      await page.waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "all", undefined, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(script ? 300 : 0);
      return page.evaluate(() => ({ at: location.href.slice(location.origin.length), shown: document.querySelector("#smoke-address output")?.textContent }));
    };
    const browserGet = await unnamed(bare, false);
    const scripted = await browser.newPage();
    scripted.on("pageerror", (e) => errors.push(`unnamed: ${e.message}`));
    const runtimeGet = await unnamed(scripted, true);
    await scripted.close();
    check(
      "a data-address form's submit with no field to an action with a bare # puts in the address the browser's own GET goes to, with its empty query and #",
      browserGet.at === "/smoke/address?#" && browserGet.shown === "all" && runtimeGet.at === browserGet.at && runtimeGet.shown === "all",
      JSON.stringify({ browserGet, runtimeGet }),
    );
    // A form without the mark is as it was before the mark: the browser's own GET of a submit with
    // no field asks for the action with an empty query, `?` and all, while the runtime's request for
    // its patch asks for the action with no query, and leaves the address.
    const unmarkedAsked = async (/** @type {import("@playwright/test").Page} */ page, /** @type {boolean} */ script) => {
      await page.goto(home);
      await page.evaluate(() => document.querySelector('main form:not([id]) button[value="year"]')?.removeAttribute("name"));
      const asked = page
        .waitForRequest((r) => new URL(r.url()).pathname === "/smoke/address" && (script ? r.headers()["corten"] === "action" : r.resourceType() === "document"), { timeout: 5000 })
        .then((r) => r.url().slice(new URL(r.url()).origin.length), () => null);
      const year = page.getByRole("button", { name: "Year, in place", exact: true });
      if (script) await year.click();
      else await Promise.all([page.waitForNavigation({ timeout: 5000 }).catch(() => {}), year.click()]);
      const target = await asked;
      await page.waitForFunction(() => !Array.from(document.querySelectorAll("main form")).some((f) => f.hasAttribute("aria-busy")), undefined, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(script ? 300 : 0);
      return { target, at: await page.evaluate(() => location.href.slice(location.origin.length)) };
    };
    const browserAsked = await unmarkedAsked(bare, false);
    const scriptedUnmarked = await browser.newPage();
    scriptedUnmarked.on("pageerror", (e) => errors.push(`unmarked unnamed: ${e.message}`));
    const runtimeAsked = await unmarkedAsked(scriptedUnmarked, true);
    await scriptedUnmarked.close();
    check(
      "a form without the mark whose submit sends no field asks for its action with no query, as before the mark, and leaves the address",
      browserAsked.target === "/smoke/address?" && browserAsked.at === "/smoke/address?" && runtimeAsked.target === "/smoke/address" && runtimeAsked.at === "/smoke/address",
      JSON.stringify({ browserAsked, runtimeAsked }),
    );
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
    // Back between two entries of one address, each with a null state (a script's `pushState` to
    // the address it is at), is a move all the same: the browser fires `popstate`.
    const sameBack = await sameAddressBack(plain);
    check(
      "without the Navigation API a marked patch on its way while Back goes to another entry of the same address and state draws nothing",
      sameBack.out && sameBack.popped && sameBack.done && sameBack.at === "" && sameBack.shown === "all",
      JSON.stringify(sameBack),
    );
    // A press a `popstate` listener heard before the runtime's makes as that Back comes is on the
    // entry Back reached, though its address did not change.
    const pressedBack = await pressOnSameBack(plain);
    check(
      "without the Navigation API a marked patch pressed by a popstate listener put on before the runtime's as Back goes to another entry of the same address and state is sent, draws and puts its address in that entry",
      pressedBack.popped && pressedBack.reads === 1 && pressedBack.drawn && pressedBack.at === "?scope=week" && pressedBack.shown === "week" && pressedBack.ahead,
      JSON.stringify(pressedBack),
    );
    const hashed = await hashThenPress(plain);
    check(
      "without the Navigation API a marked patch pressed in the task that moves the page to an #id of it draws and puts its address in that entry",
      hashed.moved === "#smoke-address" && hashed.drawn && hashed.at === "?scope=week" && hashed.shown === "week",
      JSON.stringify(hashed),
    );
    const popped = await pressOnMove(plain, "popstate");
    check(
      "without the Navigation API a marked patch pressed by a popstate listener put on before the runtime's as the page moves to an #id of it draws and puts its address in that entry",
      popped.moved === "#smoke-address" && popped.drawn && popped.at === "?scope=week" && popped.shown === "week",
      JSON.stringify(popped),
    );
    const becameRead = await postThenRead(plain, false);
    check(
      "without the Navigation API a marked POST waiting for a write is sent as a read when the write's answer draws its form with method get, and puts its address in the entry",
      becameRead.saveSent && becameRead.drawn && becameRead.sent.join() === "POST scope=saved,?scope=week" && becameRead.at === "?scope=week" && becameRead.shown === "week",
      JSON.stringify(becameRead),
    );
    const leftRead = await postThenRead(plain, true);
    check(
      "without the Navigation API a marked POST waiting for a write, sent again as a read, is not sent once the page has moved to an #id of it",
      leftRead.saveSent && leftRead.moved === "#smoke-address" && leftRead.drawn && leftRead.sent.join() === "POST scope=saved" && leftRead.at === "#smoke-address" && leftRead.shown === "saved",
      JSON.stringify(leftRead),
    );
    const unmarkedRead = await postThenRead(plain, true, true);
    check(
      "without the Navigation API a POST pressed on an unmarked form, sent again as a read from the marked form a write's answer drew, draws and leaves the address",
      unmarkedRead.saveSent && unmarkedRead.moved === "#smoke-address" && unmarkedRead.drawn && unmarkedRead.sent.join() === "POST scope=saved,?scope=week" &&
        unmarkedRead.at === "#smoke-address" && unmarkedRead.shown === "week",
      JSON.stringify(unmarkedRead),
    );
    const retried = await retryMoved(plain);
    check(
      "without the Navigation API a marked GET sent again after a write is not fetched once a formdata listener moves the page to an #id of it",
      retried.saveSent && retried.done && retried.starts === 0 && retried.at === "#smoke-address" && retried.shown === "all",
      JSON.stringify(retried),
    );
    const busyPlain = await busyMoves(plain);
    if (!busyPlain) skip("without the Navigation API a marked GET is not fetched once a submit button's attributeChangedCallback moves the page as it is marked busy", "no customized built-in elements");
    else
      check(
        "without the Navigation API a marked GET is not fetched once a submit button's attributeChangedCallback moves the page as it is marked busy",
        busyPlain.done && busyPlain.starts === 0 && busyPlain.at === "#smoke-address" && busyPlain.shown === "all",
        JSON.stringify(busyPlain),
      );
    // A script's `replaceState` while a marked answer is on its way: to another address, the entry
    // the press was on is gone and the answer draws nothing; to the same address with another state,
    // it is drawn. Either way the address is the one the script put in, as without the mark.
    for (const how of /** @type {const} */ (["replaceState", "state"])) {
      const marked = await replacedWhileOut(plain, how, true);
      const unmarked = await replacedWhileOut(plain, how, false);
      check(
        `without the Navigation API a marked patch whose entry a script replaced (${how}) while it was on its way leaves the address the script put in, as without the mark`,
        [marked, unmarked].every((r) => r.sent && r.replaced && r.done && r.at === r.put && r.state === (how === "state")) && unmarked.shown === "week" &&
          marked.shown === (how === "state" ? "week" : "all"),
        JSON.stringify({ marked, unmarked }),
      );
    }
    // A `NaN` state is the same state each time the runtime reads it, so it does not stop the replace.
    await plain.goto(home);
    await plain.evaluate(() => history.replaceState(NaN, "", location.href));
    await plain.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
    const nanDrawn = await plain
      .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
      .then(() => true, () => false);
    await plain.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
    const nan = { drawn: nanDrawn, ...(await plain.evaluate(() => ({ at: location.search, state: Number.isNaN(history.state) }))) };
    check(
      "without the Navigation API a marked patch on an entry whose state is NaN puts its address in, keeping the state",
      nan.drawn && nan.at === "?scope=week" && nan.state,
      JSON.stringify(nan),
    );
    const twoPlain = await twoMarked(plain, false);
    check(
      "without the Navigation API two marked forms pressed before either answers leave the later answer's address",
      twoPlain.daySent && twoPlain.weekSent && twoPlain.weekDrawn && twoPlain.dayDone && twoPlain.at === "?scope=week" && twoPlain.shown === "day",
      JSON.stringify(twoPlain),
    );
    const drawnPlain = await drawnPress(plain, false);
    check(
      "without the Navigation API a marked patch whose drawn element presses the form again as it connects leaves the address of that press's drawn answer",
      drawnPlain.pressed && drawnPlain.answered && drawnPlain.drawn && drawnPlain.added === 0 && drawnPlain.shown === "day" && drawnPlain.at === "?scope=day",
      JSON.stringify(drawnPlain),
    );
    // A replacement the browser refuses without a word leaves the address as it was.
    const silent = await silentRefusal(plain);
    check(
      "without the Navigation API a marked patch whose replacement the browser refuses without a word stays drawn under the entry's address, and nothing reads the page again",
      silent.drawn && !silent.read && silent.replaces === 1 && silent.at === "" && silent.shown === "week",
      JSON.stringify(silent),
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
      form.id = "smoke-address-other-form";
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
  // The entry's own state stays as a marked answer puts its address in: its `history.state`, and
  // the Navigation API's (`getState()`), which `replaceState` drops and the runtime puts back on
  // the same entry, beginning no navigation.
  for (const plain of [false, true]) {
    const name = plain
      ? "without the Navigation API a marked patch keeps the entry's history.state as it puts its address in"
      : "a marked patch keeps the entry's history.state and Navigation API state as it puts its address in, on the same entry, beginning no navigation";
    const kept = await keptState(browser, plain, errors);
    if (!kept) skip(name, "no Navigation API");
    else
      check(
        name,
        kept.api === !plain && kept.drawn && kept.at === "?scope=week" && kept.added === 0 && kept.state === '{"page":"own"}' &&
          (plain || (kept.sameKey && kept.navState === '{"draft":"unsaved"}' && kept.navigates.join() === "replace" && kept.changes.join() === "replace,null" && !kept.transition)),
        JSON.stringify(kept),
      );
  }
  // A page's listener that, as the runtime puts the address in, cancels its replace and pushes an
  // entry to the same address in its place (`push`): that entry is another, which keeps no state of
  // the runtime's, and the entry Week was pressed on keeps its own. One that clears the entry's
  // state inside the replace (`clear`), and one that puts a state in the entry before the replace
  // commits (`precommit`), have put a state in it since the runtime read it: the runtime puts the
  // older one back over neither, and the entry the replace makes keeps the precommit one. A
  // `currententrychange` listener put on before the runtime's that puts a state in the entry the
  // replace made (`early`) has too, though the runtime hears the replace after that write. A page's
  // own `getState` that pushes an entry as the runtime reads the precommit state from the entry the
  // replace took the place of (`pushread`) leaves the pushed entry the screen's: the runtime puts
  // that state in neither entry.
  for (const how of /** @type {const} */ (["push", "clear", "precommit", "early", "pushread"])) {
    const name =
      how === "push"
        ? "a marked patch whose replacement a navigate listener cancels for a push to the same address puts the entry's state on neither entry, and the entry it was pressed on keeps it"
        : how === "clear"
          ? "a marked patch whose replace a currententrychange listener clears the entry's state in keeps that cleared state"
          : how === "precommit"
            ? "a marked patch whose replacement a navigate listener puts a state in the entry for, before it commits, keeps that state in the entry it makes"
            : how === "early"
              ? "a marked patch whose replace a currententrychange listener put on before the runtime's puts a state in keeps that state"
              : "a marked patch whose read of a navigate listener's precommit state pushes another entry puts that state in neither entry, and the pushed entry keeps its own";
    const wrote = await stateWrites(browser, how, errors);
    if (!wrote) skip(name, "no Navigation API");
    else if (typeof wrote.wrote === "string") skip(name, `updateCurrentEntry refuses an undefined state (${wrote.wrote})`);
    else
      check(
        name,
        wrote.wrote && wrote.drawn && wrote.at === "?scope=week" &&
          (how === "push"
            ? wrote.added === 1 && wrote.navState === "null" && wrote.before === '{"draft":"unsaved"}'
            : how === "clear"
              ? wrote.added === 0 && wrote.navState === "null"
              : how === "pushread"
                ? wrote.pushed === true && wrote.added === 1 && wrote.navState === '"pushed"' && wrote.made === "null"
                : wrote.added === 0 && wrote.navState === '"listener"'),
        JSON.stringify(wrote),
      );
  }
  const kept = await pressesKept(browser);
  if (!kept) skip("a form's press is let go once it settles", "no DevTools heap query (Chromium only)");
  else
    check(
      "a form's press is kept only while its submit is on its way: of the ids pressed, the latest press of each held one while it is held (not one whose form could not be read, or one a later press replaced), none once all have settled",
      kept.drawn && kept.during.join() === "smoke-press-kept-held,smoke-press-kept-read-c,smoke-press-kept-write-a,smoke-press-kept-write-c" && kept.done && kept.after.length === 0,
      JSON.stringify(kept),
    );
  check("no page errors on the data-address screens", errors.length === 0, errors.join(" | "));
}

/**
 * Presses `name`, a scope button whose `formaction` the server answers with a 303, on the screen
 * at `from` reached from the page before it, and says whether a document loaded, where the page is, how many
 * history entries it added, what it asked for of the `/smoke/address` routes (the documents loaded
 * as their address before the redirect), and where Back goes; and where the browser's own GET of
 * the button goes without JavaScript. With `plain`, without the Navigation API.
 * @param {import("@playwright/test").Browser} browser @param {string} name @param {boolean} plain @param {string[]} errors
 * @param {string} [from] the screen's address, a path and query
 */
async function movedBy303(browser, name, plain, errors, from = "/smoke/address") {
  const home = `${base}/smoke/address`;
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const bare = await noScript.newPage();
  await bare.goto(home);
  const arrived = (/** @type {URL} */ url) => url.pathname === "/smoke/address" && url.search === "?scope=day";
  await Promise.all([bare.waitForURL(arrived, { timeout: 5000 }).catch(() => {}), bare.getByRole("button", { name, exact: true }).click()]);
  const browserGet = await bare.evaluate(() => ({ at: location.href.slice(location.origin.length), shown: document.querySelector("#smoke-address output")?.textContent }));
  await noScript.close();
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`${name}${plain ? ", plain" : ""}: ${e.message}`));
  if (plain)
    await page.addInitScript(() => {
      delete (/** @type {any} */ (Window.prototype)).navigation;
      delete (/** @type {any} */ (window)).navigation;
    });
  await page.goto(`${base}/smoke/address-elsewhere`);
  // The screen, reached from the page before it: by the runtime's navigation, else by a load.
  if (plain) await page.goto(`${base}${from}`);
  else await page.evaluate((from) => /** @type {any} */ (window).navigation.navigate(from).finished, from);
  await page.waitForFunction(() => document.getElementById("smoke-address-form") && !document.querySelector("main")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 });
  const length = await page.evaluate(() => history.length);
  /** @type {string[]} */
  const asked = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/smoke/address")) asked.push(`${r.headers()["corten"] ?? r.resourceType()} ${url.pathname}${url.search}`);
  });
  const loading = page.waitForEvent("load", { timeout: 3000 }).then(() => true, () => false);
  await page.getByRole("button", { name, exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const loaded = await loading;
  await page
    .waitForFunction(() => location.search === "?scope=day" && document.querySelector("#smoke-address output")?.textContent === "day" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .catch(() => {});
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  const end = await page.evaluate(
    (length) => ({ at: location.href.slice(location.origin.length), shown: document.querySelector("#smoke-address output")?.textContent, added: history.length - length }),
    length,
  );
  // What it asked for, before Back asks for the page before.
  const sent = asked.splice(0);
  const documents = sent.filter((a) => a.startsWith("document ")).map((a) => a.slice("document ".length));
  // Back loads a document without the Navigation API, which can end the call before it returns.
  await page.evaluate(() => history.back()).catch(() => {});
  await page.waitForFunction(() => location.pathname === "/smoke/address-elsewhere", undefined, { timeout: 5000 }).catch(() => {});
  const back = await page.evaluate(() => location.pathname + location.search).catch((/** @type {Error} */ e) => e.message);
  await page.close();
  return { browserGet, loaded, ...end, asked: sent, documents, back };
}

/**
 * A marked answer draws, and puts its address in the entry, only on the entry and page it was sent
 * from, and only when its patch draws whole and is not a server's failure.
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
  const finished = () => wait(() => !(/** @type {any} */ (window).__form?.hasAttribute("aria-busy") ?? true));
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

  // Submit from the still-visible page after a visit starts, before its page can draw: the press is
  // for the page the visit leaves, so its read is not sent, and nothing draws, replaces the entry the
  // navigation is making or cancels the navigation.
  const pending = await hold(month, "nav");
  const before = await state();
  await startMonth();
  const navSent = await pending.sent;
  await trackForm();
  const weekAsked = page.waitForRequest((r) => r.url() === week && r.headers()["corten"] === "action", { timeout: 2000 }).then(() => true, () => false);
  await press("Week");
  const actionSent = await weekAsked;
  const actionDone = await finished();
  const still = await state();
  pending.release();
  const navDone = await finishMonth();
  await pending.clear();
  const after = await state();
  check(
    "a marked GET pressed on the visible page while a visit is on its way is not sent, and cannot draw or cancel that visit",
    navSent && !actionSent && actionDone && still.shown === "all" && still.index <= before.index + 1 && still.at !== "?scope=week" && navDone === "finished" &&
      after.shown === "month" && after.at === "?scope=month" && after.index === before.index + 1,
    JSON.stringify({ navSent, actionSent, actionDone, still, navDone, after, before }),
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
      // Ended once its body is read, or once its answer has come and a task has passed without the
      // runtime reading it, which it does in the same task when it draws.
      sent.then((res) => {
        const text = res.text;
        let read = false;
        res.text = () => ((read = true), text.call(res).finally(ended));
        setTimeout(() => read || ended());
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

  // A page's own `navigate` listener that cancels the replacement, and puts a state of its own in
  // the entry at the address it has, has taken the address over: the answer stays drawn under that
  // address, and the runtime neither reads the page again nor touches the entry after it, in every
  // engine (docs/design.md#choice-data-address).
  await page.goto(home);
  await page.evaluate(() =>
    /** @type {any} */ (window).navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (event.navigationType !== "replace" || new URL(event.destination.url).search !== "?scope=week") return;
      event.preventDefault();
      history.replaceState({ tab: 1 }, "", location.href);
    }),
  );
  const vetoStart = await state();
  const vetoRead = page.waitForRequest((r) => r.resourceType() === "document", { timeout: 2000 }).then(() => true, () => false);
  await trackForm();
  await press("Week");
  const vetoDone = await finished();
  const vetoReloaded = await vetoRead;
  const vetoed = { done: vetoDone, reloaded: vetoReloaded, tab: await page.evaluate(() => history.state?.tab), ...(await state()) };
  check(
    "a marked patch whose replacement a navigate listener cancels stays drawn under the address the page keeps, and nothing reads the page again",
    vetoed.done && !vetoed.reloaded && vetoed.at === "" && vetoed.shown === "week" && vetoed.tab === 1 && vetoed.entries === vetoStart.entries,
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
  // is then on its way all the same. Week, pressed while it waits for its page, is not sent, and
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
  const chainedAsked = chained.waitForRequest((r) => r.url() === week && r.headers()["corten"] === "action", { timeout: 2000 }).then(() => true, () => false);
  await chained.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const chainedSentWeek = await chainedAsked;
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
    "a marked GET pressed while a navigation another one's navigatesuccess began is on its way is not sent, and lets it finish",
    chainedNav && chainedStill0.shown === "day" && !chainedSentWeek && chainedDone && chainedStill.shown === "day" && chainedStill.at !== "?scope=week" &&
      chainedFinished === "finished" && chainedAfter.at === "?scope=month" && chainedAfter.shown === "month",
    JSON.stringify({ chainedNav, chainedStill0, chainedSentWeek, chainedDone, chainedStill, chainedFinished, chainedAfter }),
  );

  // A page's own `navigate` listener, put on before the runtime's, that begins a navigation to the
  // page elsewhere as it hears one to Month: the browser aborts Month, whose `navigate` the runtime
  // hears only after the one that took its place. Week, pressed while that one waits for its page, is
  // not sent, and lets it finish.
  const elsewhere = `${base}/smoke/address-elsewhere`;
  const nested = await browser.newPage();
  nested.on("pageerror", (e) => errors.push(`nested: ${e.message}`));
  await nested.addInitScript((url) => {
    const nav = /** @type {any} */ (window).navigation;
    nav?.addEventListener("navigate", (/** @type {any} */ event) => {
      if (new URL(event.destination.url).search !== "?scope=month" || /** @type {any} */ (window).__taken) return;
      const next = nav.navigate(url);
      next.committed.catch(() => {});
      Object.assign(window, { __taken: next.finished.then(() => "finished", (/** @type {Error} */ error) => error.name) });
    });
  }, elsewhere);
  await nested.goto(home);
  /** @type {() => void} */
  let releaseNested = () => {};
  const nestedHeld = new Promise((resolve) => (releaseNested = () => resolve(undefined)));
  await nested.route(elsewhere, async (route) => {
    if (route.request().headers()["corten"] !== "nav") return route.continue();
    await nestedHeld;
    await route.continue().catch(() => {});
  });
  const nestedSent = nested.waitForRequest((r) => r.url() === elsewhere && r.headers()["corten"] === "nav", { timeout: 5000 }).then(() => true, () => false);
  const monthAborted = await nested.evaluate((url) => {
    const nav = /** @type {any} */ (window).navigation.navigate(url);
    nav.committed.catch(() => {});
    return nav.finished.then(() => "finished", (/** @type {Error} */ error) => error.name);
  }, month);
  const nestedNav = await nestedSent;
  const nestedState = () => nested.evaluate(() => ({ path: location.pathname, at: location.search, shown: document.querySelector("#smoke-address output")?.textContent ?? null }));
  await nested.evaluate(() => Object.assign(window, { __form: document.getElementById("smoke-address-form") }));
  const nestedAsked = nested.waitForRequest((r) => r.url() === week && r.headers()["corten"] === "action", { timeout: 2000 }).then(() => true, () => false);
  await nested.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const nestedSentWeek = await nestedAsked;
  const nestedDone = await nested
    .waitForFunction(() => !(/** @type {any} */ (window).__form.hasAttribute("aria-busy")), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await nested.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  const nestedStill = await nestedState();
  releaseNested();
  const nestedFinished = await nested.evaluate(() => /** @type {any} */ (window).__taken).catch((/** @type {Error} */ e) => e.message);
  await nested.unroute(elsewhere);
  const nestedAfter = await nestedState().catch(() => null);
  await nested.close();
  check(
    "a marked GET pressed while a navigation a navigate listener began in place of another is on its way is not sent, and lets it finish",
    monthAborted === "AbortError" && nestedNav && !nestedSentWeek && nestedDone && nestedStill.shown === "all" && nestedStill.at !== "?scope=week" &&
      nestedFinished === "finished" && nestedAfter?.path === "/smoke/address-elsewhere" && nestedAfter.shown === "all",
    JSON.stringify({ monthAborted, nestedNav, nestedSentWeek, nestedDone, nestedStill, nestedFinished, nestedAfter }),
  );

  // A `navigate` event another script dispatches, one it says can be intercepted, with a signal of
  // its own, is no navigation: Week, pressed after it, draws and puts its address in the entry.
  await page.goto(home);
  const forged = await page.evaluate(async () => {
    const nav = /** @type {any} */ (window).navigation;
    /** @type {any} */
    let destination;
    const take = (/** @type {any} */ event) => (destination ??= event.destination);
    nav.addEventListener("navigate", take);
    await nav.navigate("#smoke-address").finished;
    nav.removeEventListener("navigate", take);
    const Event = /** @type {any} */ (window).NavigateEvent;
    try {
      nav.dispatchEvent(new Event("navigate", { destination, signal: new AbortController().signal, canIntercept: true, navigationType: "traverse" }));
      return "dispatched";
    } catch (error) {
      return `not made: ${error}`;
    }
  });
  if (forged !== "dispatched") skip("a marked patch draws after a navigate event another script dispatches", `no NavigateEvent constructor (${forged})`);
  else {
    await trackForm();
    await press("Week");
    const forgedDone = await finished();
    const afterForged = await state();
    check(
      "a marked patch draws and puts its address in the entry after a navigate event another script dispatches",
      forgedDone && afterForged.at === "?scope=week" && afterForged.shown === "week",
      JSON.stringify({ forgedDone, afterForged }),
    );
  }

  // Save's answer draws the form again and Week, which waited for it, is to be sent from the form
  // it drew in a task of its own (held here). Day, pressed on that form meanwhile, is drawn before
  // Week would be sent: Day is the newer press, so Week is not sent.
  await page.goto(home);
  const saveFirst = await hold(home, "action");
  await page.evaluate(() => {
    /** @type {string[]} */
    const reads = [];
    Object.assign(window, { __reads: reads, __saving: document.getElementById("smoke-address-form"), __retry: null });
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(String(input instanceof Request ? input.url : input), location.href);
      if (url.pathname === "/smoke/address" && /^\?scope=(day|week)$/.test(url.search) && new Headers(init?.headers).get("corten") === "action") reads.push(url.search);
      return fetch_.call(this, input, init);
    };
  });
  await press("Save");
  const saveFirstSent = await saveFirst.sent;
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
  saveFirst.release();
  const retryWaits = await wait(() => !!(/** @type {any} */ (window).__retry));
  await saveFirst.clear();
  const dayOnNew = await page.evaluate(() => {
    const day = /** @type {HTMLButtonElement | null} */ (document.querySelector('#smoke-address-form button[value="day"]'));
    return !!day && day.form !== /** @type {any} */ (window).__saving && !day.form?.hasAttribute("aria-busy");
  });
  await press("Day");
  const dayFirst = await wait(
    () => location.search === "?scope=day" && document.querySelector("#smoke-address output")?.textContent === "day" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"),
  );
  await page.evaluate(() => /** @type {any} */ (window).__retry?.());
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300))));
  const dayKept = { reads: await page.evaluate(() => /** @type {any} */ (window).__reads), ...(await state()) };
  check(
    "a GET waiting to be sent again after its write's answer is dropped by a press of the drawn form whose answer came first",
    saveFirstSent && retryWaits && dayOnNew && dayFirst && dayKept.reads.join() === "?scope=day" && dayKept.at === "?scope=day" && dayKept.shown === "day",
    JSON.stringify({ saveFirstSent, retryWaits, dayOnNew, dayFirst, dayKept }),
  );

  // A page's own `navigate` listener that cancels the replacement and begins a navigation to Month
  // in its place: that navigation is the page's now, so the entry's page is not read again over it.
  await page.goto(home);
  await page.evaluate((url) => {
    const nav = /** @type {any} */ (window).navigation;
    nav.addEventListener("navigate", (/** @type {any} */ event) => {
      if (event.navigationType !== "replace" || new URL(event.destination.url).search !== "?scope=week" || /** @type {any} */ (window).__instead) return;
      event.preventDefault();
      const next = nav.navigate(url);
      next.committed.catch(() => {});
      Object.assign(window, { __instead: next.finished.then(() => "finished", (/** @type {Error} */ error) => error.name) });
    });
  }, month);
  const insteadReload = page.waitForRequest((r) => r.resourceType() === "document", { timeout: 3000 }).then(() => true, () => false);
  await press("Week");
  const insteadFinished = await page
    .waitForFunction(() => /** @type {any} */ (window).__instead, undefined, { timeout: 5000 })
    .then(() => page.evaluate(() => /** @type {any} */ (window).__instead))
    .catch((/** @type {Error} */ e) => e.message);
  const reloadedOver = await insteadReload;
  const instead = await state().catch(() => null);
  check(
    "a marked patch whose replacement a navigate listener cancels for a navigation of its own leaves that navigation to finish",
    insteadFinished === "finished" && !reloadedOver && instead?.at === "?scope=month" && instead.shown === "month",
    JSON.stringify({ insteadFinished, reloadedOver, instead }),
  );

  // The same, with the page's own navigation to the very address the replacement was for, whose
  // page is held before it commits: the runtime does not take that navigation's event for its
  // replacement's, nor read the entry's page again over the navigation.
  await page.goto(home);
  const sameHeld = await hold(week, "nav");
  await page.evaluate((url) => {
    const nav = /** @type {any} */ (window).navigation;
    nav.addEventListener("navigate", (/** @type {any} */ event) => {
      if (event.navigationType !== "replace" || new URL(event.destination.url).search !== "?scope=week" || /** @type {any} */ (window).__same) return;
      event.preventDefault();
      const next = nav.navigate(url);
      next.committed.catch(() => {});
      Object.assign(window, { __same: next.finished.then(() => "finished", (/** @type {Error} */ error) => error.name) });
    });
  }, week);
  const sameReload = page.waitForRequest((r) => r.resourceType() === "document", { timeout: 3000 }).then(() => true, () => false);
  await press("Week");
  const sameSent = await sameHeld.sent;
  const sameReloaded = await sameReload;
  sameHeld.release();
  const sameFinished = await page
    .waitForFunction(() => /** @type {any} */ (window).__same, undefined, { timeout: 5000 })
    .then(() => page.evaluate(() => /** @type {any} */ (window).__same))
    .catch((/** @type {Error} */ e) => e.message);
  await sameHeld.clear();
  const sameEnd = await state().catch(() => null);
  check(
    "a marked patch whose replacement a navigate listener cancels for its own navigation to the same address, held before it commits, leaves that navigation to finish and reads nothing again",
    sameSent && !sameReloaded && sameFinished === "finished" && sameEnd?.at === "?scope=week" && sameEnd.shown === "week",
    JSON.stringify({ sameSent, sameReloaded, sameFinished, sameEnd }),
  );

  // A replacement the browser refuses with an exception (WebKit's SecurityError at its limit of
  // history updates) leaves the address as it was, the answer drawn under it: nothing reads the
  // page again. The runtime asks for it once, so no earlier guard of its own left the address.
  await page.goto(home);
  await page.evaluate(() => {
    let asked = 0;
    Object.assign(window, { __weekReplaces: () => asked });
    const replace = history.replaceState;
    history.replaceState = function (...args) {
      if (!String(args[2]).endsWith("?scope=week")) return replace.apply(this, args);
      asked += 1;
      throw new DOMException("history.replaceState() called too often", "SecurityError");
    };
  });
  const thrownRead = page.waitForRequest((r) => r.resourceType() === "document", { timeout: 3000 }).then(() => true, () => false);
  // A runtime that reads the page again is let finish loading before the next case.
  const thrownLoaded = page.waitForEvent("load", { timeout: 3000 }).then(() => true, () => false);
  await trackForm();
  await press("Week");
  const thrownDone = await finished();
  const thrown = { done: thrownDone, read: await thrownRead, loaded: await thrownLoaded, ...(await state()), replaces: await page.evaluate(() => /** @type {any} */ (window).__weekReplaces()) };
  check(
    "a marked patch whose replacement throws stays drawn under the entry's address, and nothing reads the page again",
    thrown.done && !thrown.read && !thrown.loaded && thrown.replaces === 1 && thrown.at === "" && thrown.shown === "week",
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
  // A removal with no id, or an empty one, names no element: alone it draws nothing, and the
  // address stays.
  const noId = await patch(200, "<template data-remove></template>");
  const emptyId = await patch(200, '<template id="" data-remove></template>');
  check(
    "a marked patch whose only removal has no id, or an empty one, leaves the address",
    [noId, emptyId].every((p) => p.done && p.at === "" && p.added === 0 && p.shown === "all"),
    JSON.stringify({ noId, emptyId }),
  );
  // Beside an element that is drawn, such a removal is one that found no place: the patch is not
  // drawn whole, and the address stays.
  const mixedNoId = await patch(200, '<template data-remove></template><section id="smoke-address"><output>Mixed</output></section>');
  const mixedEmptyId = await patch(200, '<section id="smoke-address"><output>Mixed</output></section><template id="" data-remove></template>');
  check(
    "a marked patch that draws an element beside a removal with no id, or an empty one, draws the element and leaves the address",
    [mixedNoId, mixedEmptyId].every((p) => p.done && p.at === "" && p.added === 0 && p.shown === "Mixed"),
    JSON.stringify({ mixedNoId, mixedEmptyId }),
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

  // A page answer to a form without the mark that cannot be drawn in place (a stylesheet it links
  // fails to load) loads the page in full instead, and its notice is said as the runtime gives the
  // swap up, as before the mark.
  await page.goto(home);
  await page.evaluate(() => {
    document.getElementById("smoke-address-form")?.removeAttribute("data-address");
    sessionStorage.removeItem("smoke-notice-said");
    document.addEventListener("corten:notice", (event) => sessionStorage.setItem("smoke-notice-said", /** @type {CustomEvent} */ (event).detail.message));
  });
  const missingStyle = `${base}/smoke/address-missing.css`;
  await page.route(missingStyle, (route) => route.fulfill({ status: 404, body: "" }));
  await page.route(week, (route) =>
    route.request().headers()["corten"] === "action"
      ? route.fulfill({ headers: { ...pageHeaders, "corten-notice": "m=Saved" }, body: `<link rel="stylesheet" data-corten-style href="${missingStyle}">${weekMarkup}` })
      : route.continue(),
  );
  const noticeLoad = page.waitForEvent("load", { timeout: 5000 }).then(() => true, () => false);
  await press("Week");
  const noticeLoaded = await noticeLoad;
  await page.unroute(week);
  await page.unroute(missingStyle);
  const noticeSaid = await page.evaluate(() => sessionStorage.getItem("smoke-notice-said"));
  check(
    "a page answer to a form without the mark that loads the page in full instead says its notice, as before the mark",
    noticeLoaded && noticeSaid === "Saved",
    JSON.stringify({ noticeLoaded, noticeSaid }),
  );

  const failed = await patch(500, '<section id="smoke-address"><output>Failed</output></section>');
  const invalid = await patch(422, '<section id="smoke-address"><output>Invalid</output></section>');
  check(
    "a drawn 5xx marked patch leaves the address alone while a drawn 4xx may change it",
    failed.done && failed.at === "" && failed.added === 0 && failed.shown === "Failed" && invalid.done && invalid.at === "?scope=week" && invalid.added === 0 &&
      invalid.shown === "Invalid",
    JSON.stringify({ failed, invalid }),
  );

  // Week, held on its way, then a link to an #id of the page (another entry), then Week again: the
  // same request as the one on its way, which can no longer draw on the entry it was pressed on. The
  // newer press is not dropped as a repeat of it: it takes the read on its way over, which is sent
  // once, and its answer draws and puts its address in the entry.
  await page.goto(home);
  const twin = await hold(week, "action");
  await page.evaluate(() => {
    let starts = 0;
    Object.assign(window, { __twinStarts: () => starts });
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(String(input instanceof Request ? input.url : input), location.href);
      if (url.pathname === "/smoke/address" && url.search === "?scope=week" && new Headers(init?.headers).get("corten") === "action") starts += 1;
      return fetch_.call(this, input, init);
    };
  });
  await trackForm();
  await press("Week");
  const twinSent = await twin.sent;
  const twinHash = await page.evaluate(
    () =>
      new Promise((resolve) => {
        addEventListener("hashchange", () => resolve(location.hash), { once: true });
        location.hash = "smoke-address";
      }),
  );
  await press("Week");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
  twin.release();
  const twinDrawn = await wait(
    () => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"),
  );
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  const twinStarts = await page.evaluate(() => /** @type {any} */ (window).__twinStarts());
  await twin.clear();
  const twinEnd = await state();
  check(
    "a press of a marked form the same as one on its way that can no longer draw takes that read over, sent once, and draws its answer and puts its address in the entry",
    twinSent && twinHash === "#smoke-address" && twinDrawn && twinStarts === 1 && twinEnd.at === "?scope=week" && twinEnd.shown === "week",
    JSON.stringify({ twinSent, twinHash, twinDrawn, twinStarts, twinEnd }),
  );

  // Week's answer is in and waits for a stylesheet it links (held here) before it draws when the page
  // moves to an #id of it and Week is pressed again: that answer, already drawing for the press it
  // came for, is not handed to the newer press on the entry it moved to, which sends its own read,
  // whose answer is drawn and puts its address in the entry.
  await page.goto(home);
  const heldStyle = `${base}/smoke/address-held.css`;
  /** @type {() => void} */
  let releaseStyle = () => {};
  const styleHeld = new Promise((resolve) => (releaseStyle = () => resolve(undefined)));
  let drawingAnswers = 0;
  await page.route(heldStyle, async (route) => {
    await styleHeld;
    await route.fulfill({ headers: { "content-type": "text/css" }, body: "" }).catch(() => {});
  });
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    drawingAnswers += 1;
    await route.fulfill({
      headers: { "corten-patch": "1", "content-type": "text/html" },
      body: `<link rel="stylesheet" data-corten-style href="${heldStyle}"><section id="smoke-address"><output>week ${drawingAnswers}</output></section>`,
    });
  });
  const styleAsked = page.waitForRequest(heldStyle, { timeout: 5000 }).then(() => true, () => false);
  await press("Week");
  const styleWaits = await styleAsked;
  const drawingHash = await page.evaluate(
    () =>
      new Promise((resolve) => {
        addEventListener("hashchange", () => resolve(location.hash), { once: true });
        location.hash = "smoke-address";
      }),
  );
  await press("Week");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  releaseStyle();
  const drawingDrawn = await wait(() => document.querySelector("#smoke-address output")?.textContent === "week 2" && location.search === "?scope=week");
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  await page.unroute(week);
  await page.unroute(heldStyle);
  const drawingEnd = { answers: drawingAnswers, ...(await state()) };
  check(
    "a press of a marked form the same as a read whose answer is already drawing sends its own read, and that answer is drawn and puts its address in the entry",
    styleWaits && drawingHash === "#smoke-address" && drawingDrawn && drawingEnd.answers === 2 && drawingEnd.at === "?scope=week" && drawingEnd.shown === "week 2",
    JSON.stringify({ styleWaits, drawingHash, drawingDrawn, drawingEnd }),
  );

  // The same for a form without the mark, as before the mark: the second press is the read whose
  // answer is drawing, and nothing more is sent.
  await page.goto(home);
  await page.evaluate(() => document.getElementById("smoke-address-form")?.removeAttribute("data-address"));
  const plainStyle = `${base}/smoke/address-held-unmarked.css`;
  /** @type {() => void} */
  let releasePlain = () => {};
  const plainHeld = new Promise((resolve) => (releasePlain = () => resolve(undefined)));
  let plainAnswers = 0;
  await page.route(plainStyle, async (route) => {
    await plainHeld;
    await route.fulfill({ headers: { "content-type": "text/css" }, body: "" }).catch(() => {});
  });
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    plainAnswers += 1;
    await route.fulfill({
      headers: { "corten-patch": "1", "content-type": "text/html" },
      body: `<link rel="stylesheet" data-corten-style href="${plainStyle}"><section id="smoke-address"><output>week ${plainAnswers}</output></section>`,
    });
  });
  const plainAsked = page.waitForRequest(plainStyle, { timeout: 5000 }).then(() => true, () => false);
  await press("Week");
  const plainWaits = await plainAsked;
  await press("Week");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  releasePlain();
  const plainDrawn = await wait(() => document.querySelector("#smoke-address output")?.textContent?.startsWith("week"));
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(week);
  await page.unroute(plainStyle);
  const plainEnd = { answers: plainAnswers, ...(await state()) };
  check(
    "a press of a form without the mark the same as a read whose answer is already drawing sends nothing more, as before the mark",
    plainWaits && plainDrawn && plainEnd.answers === 1 && plainEnd.at === "" && plainEnd.shown === "week 1",
    JSON.stringify({ plainWaits, plainDrawn, plainEnd }),
  );

  // Week's answer is the whole page (`corten-shell`, as a write's own page is), and waits for a
  // stylesheet it links (held here) before it draws when the page moves to an #id of it: the
  // press was made on the entry the page left, so the answer draws nothing on the one it is on.
  await page.goto(home);
  const wholeStyle = `${base}/smoke/address-held-whole.css`;
  /** @type {() => void} */
  let releaseWhole = () => {};
  const wholeHeld = new Promise((resolve) => (releaseWhole = () => resolve(undefined)));
  await page.route(wholeStyle, async (route) => {
    await wholeHeld;
    await route.fulfill({ headers: { "content-type": "text/css" }, body: "" }).catch(() => {});
  });
  const wholePage = await fetch(week);
  const wholeHeaders = Object.fromEntries(["corten-shell", "content-type"].flatMap((name) => (wholePage.headers.has(name) ? [[name, wholePage.headers.get(name) ?? ""]] : [])));
  const wholeMarkup = (await wholePage.text()).replace("</head>", `<link rel="stylesheet" data-corten-style href="${wholeStyle}"></head>`);
  await page.route(week, (route) => (route.request().headers()["corten"] === "action" ? route.fulfill({ headers: wholeHeaders, body: wholeMarkup }) : route.continue()));
  const wholeAsked = page.waitForRequest(wholeStyle, { timeout: 5000 }).then(() => true, () => false);
  await trackForm();
  await press("Week");
  const wholeWaits = await wholeAsked;
  const wholeHash = await page.evaluate(
    () =>
      new Promise((resolve) => {
        addEventListener("hashchange", () => resolve(location.hash), { once: true });
        location.hash = "smoke-address";
      }),
  );
  releaseWhole();
  const wholeDone = await finished();
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(week);
  await page.unroute(wholeStyle);
  const wholeEnd = await state();
  check(
    "a marked GET answered with the whole page that waits for a stylesheet as the page moves to an #id of it draws nothing on the entry it moved to",
    "corten-shell" in wholeHeaders && wholeWaits && wholeHash === "#smoke-address" && wholeDone && wholeEnd.at === "" && wholeEnd.shown === "all",
    JSON.stringify({ wholeHeaders, wholeWaits, wholeHash, wholeDone, wholeEnd }),
  );

  // A `formdata` listener of the page that, as Week's press reads the form, draws the form again
  // and presses Day on the one it drew: Day was pressed after Week, so Day's answer is the one drawn,
  // whichever comes first.
  await page.goto(home);
  await page.evaluate(() => {
    const form = /** @type {HTMLFormElement} */ (document.getElementById("smoke-address-form"));
    form.addEventListener(
      "formdata",
      () => {
        const again = /** @type {HTMLFormElement} */ (form.cloneNode(true));
        form.replaceWith(again);
        again.requestSubmit(/** @type {HTMLButtonElement} */ (again.querySelector('button[value="day"]')));
      },
      { once: true },
    );
  });
  await press("Week");
  const reentrantDrawn = await wait(
    () => location.search === "?scope=day" && document.querySelector("#smoke-address output")?.textContent === "day" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"),
  );
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300))));
  const reentrant = await state();
  check(
    "a marked GET pressed by a formdata listener as another press of the form reads it is the newer press, and its answer is drawn",
    reentrantDrawn && reentrant.at === "?scope=day" && reentrant.shown === "day",
    JSON.stringify({ reentrantDrawn, reentrant }),
  );

  // A `submit` listener of the page that, as Week is pressed, draws the form again and presses Day
  // on the one it drew: the runtime takes Day's submit first, as it hears it first, and sends it,
  // and Week's after it, so Week is the later press. Its answer is the one drawn, and its address is
  // the entry's: what the screen shows and the address agree.
  await page.goto(home);
  await page.evaluate(() => {
    /** @type {string[]} */
    const asked = [];
    Object.assign(window, { __asked: asked });
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(String(input instanceof Request ? input.url : input), location.href);
      if (url.pathname === "/smoke/address" && new Headers(init?.headers).get("corten") === "action") asked.push(url.searchParams.get("scope") ?? "");
      return fetch_.call(this, input, init);
    };
    const form = /** @type {HTMLFormElement} */ (document.getElementById("smoke-address-form"));
    form.addEventListener(
      "submit",
      () => {
        const again = /** @type {HTMLFormElement} */ (form.cloneNode(true));
        form.replaceWith(again);
        again.requestSubmit(/** @type {HTMLButtonElement} */ (again.querySelector('button[value="day"]')));
      },
      { once: true },
    );
  });
  await press("Week");
  const listenedDrawn = await wait(
    () => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"),
  );
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300))));
  const listened = { asked: await page.evaluate(() => /** @type {string[]} */ (/** @type {any} */ (window).__asked).join()), ...(await state()) };
  check(
    "a marked GET pressed by a submit listener as the form is pressed is taken and sent first, and the press taken last draws and puts its address in the entry",
    listenedDrawn && listened.asked === "day,week" && listened.at === "?scope=week" && listened.shown === "week",
    JSON.stringify({ listenedDrawn, listened }),
  );

  // A marked form without an id cannot tell its latest press from an older one: its answer is drawn
  // and leaves the address, as an unmarked form's does. So is each of two presses made as one (a
  // `formdata` listener that draws the form again, without an id, and presses it), whichever comes
  // last.
  await page.goto(home);
  await page.evaluate(() => {
    const form = /** @type {HTMLFormElement} */ (document.getElementById("smoke-address-form"));
    form.removeAttribute("id");
    Object.assign(window, { __form: form });
  });
  await press("Week");
  const idlessDrawn = await wait(() => document.querySelector("#smoke-address output")?.textContent === "week" && !(/** @type {any} */ (window).__form.hasAttribute("aria-busy")));
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  const idless = await state();
  await page.goto(home);
  const twoAnswered = Promise.all(
    ["day", "week"].map((scope) => page.waitForResponse((r) => r.url() === `${home}?scope=${scope}` && r.request().headers()["corten"] === "action", { timeout: 5000 })),
  ).then(() => true, () => false);
  await page.evaluate(() => {
    const form = /** @type {HTMLFormElement} */ (document.getElementById("smoke-address-form"));
    form.removeAttribute("id");
    form.addEventListener(
      "formdata",
      () => {
        const again = /** @type {HTMLFormElement} */ (form.cloneNode(true));
        form.replaceWith(again);
        again.requestSubmit(/** @type {HTMLButtonElement} */ (again.querySelector('button[value="day"]')));
      },
      { once: true },
    );
  });
  await press("Week");
  const twoSent = await twoAnswered;
  const twoDrawn = await wait(() => ["day", "week"].includes(document.querySelector("#smoke-address output")?.textContent ?? "") && !document.querySelector("main [aria-busy]"));
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300))));
  const twoPresses = await state();
  check(
    "a marked form without an id draws its answer and leaves the address, and so does each of two presses of it made as one",
    idlessDrawn && idless.at === "" && idless.shown === "week" && twoSent && twoDrawn && twoPresses.at === "" && ["day", "week"].includes(twoPresses.shown ?? ""),
    JSON.stringify({ idlessDrawn, idless, twoSent, twoDrawn, twoPresses }),
  );

  // A navigation of the page's own already on its way as a marked answer draws: a link marked
  // `data-reload`, which the runtime leaves to the page, whose `navigate` listener takes it and holds
  // it before its address changes (`precommitHandler`). The browser shows it as on its way
  // (`navigation.transition`), so the answer is drawn under the address as it is, which the replace
  // would have cancelled that navigation for, and the navigation finishes.
  if (!(await page.evaluate(() => "NavigationPrecommitController" in window))) skip("a marked patch leaves the address while a navigation of the page's own is on its way", "no precommitHandler");
  else {
    await page.goto(home);
    const ownMarked = await hold(week, "action");
    await trackForm();
    await press("Week");
    const ownSent = await ownMarked.sent;
    const ownStarted = await page.evaluate(async (href) => {
      /** @type {(value?: unknown) => void} */
      let release = () => {};
      const held = new Promise((resolve) => (release = resolve));
      Object.assign(window, { __releaseOwn: release, __own: "not begun" });
      const nav = /** @type {any} */ (window).navigation;
      nav.addEventListener(
        "navigate",
        (/** @type {any} */ event) => {
          if (event.destination.url !== href) return;
          Object.assign(window, { __own: "on its way" });
          event.signal.addEventListener("abort", () => Object.assign(window, { __own: "AbortError" }));
          event.intercept({ precommitHandler: () => held, handler: () => void Object.assign(window, { __own: "finished" }) });
        },
        { once: true },
      );
      const link = document.createElement("a");
      link.href = href;
      link.dataset.reload = "";
      document.body.append(link);
      link.click();
      // WebKit follows the link in a later task.
      for (let tries = 0; tries < 100 && /** @type {any} */ (window).__own === "not begun"; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve));
      return !!nav.transition;
    }, elsewhere);
    ownMarked.release();
    const ownDrawn = await wait(() => document.querySelector("#smoke-address output")?.textContent === "week" && !(/** @type {any} */ (window).__form.hasAttribute("aria-busy")));
    await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
    const ownDuring = await page.evaluate(() => ({ path: location.pathname + location.search, own: /** @type {any} */ (window).__own, shown: document.querySelector("#smoke-address output")?.textContent }));
    await page.evaluate(() => /** @type {any} */ (window).__releaseOwn());
    const ownEnded = await wait(() => /** @type {any} */ (window).__own !== "on its way");
    const ownAfter = await page.evaluate(() => ({ path: location.pathname + location.search, own: /** @type {any} */ (window).__own }));
    await ownMarked.clear();
    check(
      "a marked patch drawn while a navigation the page's navigate listener holds is on its way leaves the address, and the navigation finishes",
      ownSent && ownStarted && ownDrawn && ownDuring.path === "/smoke/address" && ownDuring.own === "on its way" && ownDuring.shown === "week" && ownEnded &&
        ownAfter.own === "finished" && ownAfter.path === "/smoke/address-elsewhere",
      JSON.stringify({ ownSent, ownStarted, ownDrawn, ownDuring, ownEnded, ownAfter }),
    );
  }

  // Something of the page's replaced the entry while a marked answer was on its way, keeping its key,
  // and is over: a navigation of its own that replaces (to an `#id` of the page, which the runtime
  // leaves to it), a script's `replaceState` to another address, and one to the same address with
  // another state. The answer is drawn under the address the page put in, as an unmarked form's is.
  // So it is when that navigation is still on its way as the answer comes (`held`: committed, its
  // `navigate` listener's handler held), and the navigation finishes.
  for (const how of /** @type {const} */ (["navigate", "held", "replaceState", "state"])) {
    const marked = await replacedWhileOut(page, how, true);
    const unmarked = await replacedWhileOut(page, how, false);
    check(
      `a marked patch whose entry the page replaced (${how}) while it was on its way is drawn and leaves the address the page put in, as without the mark`,
      [marked, unmarked].every(
        (r) => r.sent && r.replaced && r.done && r.at === r.put && r.shown === "week" && r.state === (how === "state") && (how !== "held" || (r.heldDuring && r.heldEnd === "finished")),
      ),
      JSON.stringify({ marked, unmarked }),
    );
  }

  // Two marked forms pressed before either answers, Week's answer first: Week's replace is a replace
  // of the entry since Day's press, so Day's answer is drawn under Week's address, as an unmarked
  // form's is. So it is when a `currententrychange` listener of the page replaces the entry again
  // (another state) while Week's replace is running: the runtime does not tell its own replace from
  // the page's, and the address and state the page put in stay.
  for (const listener of [false, true]) {
    const two = await twoMarked(page, listener);
    check(
      `two marked forms pressed before either answers leave the later answer's address${listener ? ", and a currententrychange listener's replace during the first answer's" : ""}`,
      two.daySent && two.weekSent && two.weekDrawn && two.dayDone && two.at === "?scope=week" && two.shown === "day" && two.listened === (listener ? "listener" : null) && two.within === (listener ? 1 : null) &&
        two.state === (listener ? "listener" : null),
      JSON.stringify(two),
    );
  }

  // A load of another document on its way (a link marked `data-reload`, held by the server) as a
  // marked answer comes: the platform shows no navigation on its way for it. A patch's replace
  // lets it go on and take the screen's place; Corten's redirect (`corten-location`) and a layout
  // that changed (a reload) are the runtime's for any `data-patch` form, and end as they do for the
  // same press without the mark.
  /** @type {Record<string, unknown>} */
  const loads = {};
  for (const kind of /** @type {const} */ (["patch", "location", "shell"])) {
    const marked = await heldLoad(page, kind, true);
    const unmarked = await heldLoad(page, kind, false);
    loads[kind] = { marked, unmarked };
  }
  const endsAlike = (/** @type {any} */ a, /** @type {any} */ b) =>
    a.sent && a.loading && b.sent && b.loading && a.cutOff === b.cutOff && a.final === b.final && a.aborted === b.aborted && [...a.asked].sort().join() === [...b.asked].sort().join();
  // Where the load did not cut the answer off (Chromium), the redirect and the reload are begun
  // while it is held, as without the mark, and the patch is drawn while it is held, the marked
  // press's address put in and the unmarked one's left; where it did (Firefox and WebKit), nothing
  // is, and nothing is drawn.
  const begun = (/** @type {"patch" | "location" | "shell"} */ kind, /** @type {string} */ navigation) => {
    const { marked } = /** @type {any} */ (loads[kind]);
    return marked.cutOff ? marked.asked.length === 0 : navigation ? marked.asked.includes(navigation) : marked.asked.length === 0;
  };
  const patched = /** @type {any} */ (loads.patch).marked;
  const unpatched = /** @type {any} */ (loads.patch).unmarked;
  const drewHeld =
    [patched, unpatched].every((l) => l.drew.fresh) &&
    (patched.cutOff
      ? [patched, unpatched].every((l) => l.drew.shown === "all" && l.drew.at === "/smoke/address")
      : patched.drew.shown === "week" && patched.drew.at === "/smoke/address?scope=week" && unpatched.drew.shown === "week" && unpatched.drew.at === "/smoke/address");
  check(
    "a load of another document on its way as a marked answer comes goes on through its patch's replace, and its redirect and reload end as the same press's without the mark",
    Object.values(loads).every((/** @type {any} */ l) => endsAlike(l.marked, l.unmarked)) && !patched.aborted && patched.final === "/smoke/address-elsewhere?held=1" && drewHeld &&
      begun("patch", "") && begun("location", "navigate push /smoke/address?scope=month") && begun("shell", "navigate reload /smoke/address"),
    JSON.stringify(loads),
  );

  // Week's patch draws an element whose `connectedCallback` presses Day, which the server answers
  // with a 204 that draws nothing: Week's answer has drawn whole, so its address is in the entry, as
  // the browser's own load of it would be.
  await page.goto(home);
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    // Uncompressed: Firefox's route.fetch reads a compressed body it was not sent as empty.
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
    const body = (await res.text()).replace("</section>", "<smoke-presses-day></smoke-presses-day></section>");
    await route.fulfill({ response: res, body });
  });
  const dayEmpty = `${home}?scope=day`;
  await page.route(dayEmpty, (route) => (route.request().headers()["corten"] === "action" ? route.fulfill({ status: 204 }) : route.continue()));
  const dayAnswered = page.waitForResponse((r) => r.url() === dayEmpty && r.status() === 204, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => {
    Object.assign(window, { __pressedDay: false });
    customElements.define(
      "smoke-presses-day",
      class extends HTMLElement {
        connectedCallback() {
          if (/** @type {any} */ (window).__pressedDay) return;
          Object.assign(window, { __pressedDay: true });
          const day = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="day"]'));
          day.form?.requestSubmit(day);
        }
      },
    );
  });
  await trackForm();
  await press("Week");
  const connectedDay = await wait(() => /** @type {any} */ (window).__pressedDay);
  const dayEmptied = await dayAnswered;
  const connectedDone = await wait(() => !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"));
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  await page.unroute(week);
  await page.unroute(dayEmpty);
  const connected = await state();
  check(
    "a marked patch whose drawn element presses the form again as it connects puts its address in the entry",
    connectedDay && dayEmptied && connectedDone && connected.at === "?scope=week" && connected.shown === "week",
    JSON.stringify({ connectedDay, dayEmptied, connectedDone, connected }),
  );

  // The same press of Day, which the server now answers with its patch (`drawnPress`); and again
  // with a `currententrychange` listener that replaces the entry inside Week's replace, which Day's
  // answer then leaves, as any replace but Week's own. A listener that puts a state of its own in
  // the entry there (`updateCurrentEntry`) replaces nothing: Day's answer puts its address in, and
  // the state is the listener's, which neither answer puts the entry's older one back over.
  for (const listener of /** @type {const} */ (["", "replace", "state"])) {
    const drawn = await drawnPress(page, listener);
    check(
      listener === "replace"
        ? "a marked patch whose drawn element presses the form again as it connects, and a currententrychange listener's replace during its own, leave the listener's address"
        : listener === "state"
          ? "a marked patch whose drawn element presses the form again as it connects puts that press's address in over a state a currententrychange listener puts in the entry during its own replace, and keeps that state"
          : "a marked patch whose drawn element presses the form again as it connects leaves the address of that press's drawn answer",
      drawn.pressed && drawn.answered && drawn.drawn && drawn.added === 0 && drawn.shown === "day" &&
        (listener === "replace"
          ? drawn.at === "?scope=week" && drawn.state === "listener"
          : listener === "state"
            ? drawn.at === "?scope=day" && drawn.state === null && drawn.navState === "listener"
            : drawn.at === "?scope=day" && drawn.state === null),
      JSON.stringify(drawn),
    );
  }

  // A page's own `getState` of the entry that pushes an entry of the page's, with a state of its
  // own, and answers the state of the entry it was asked on: Week's answer, which reads the entry's
  // state as it draws, is drawn on the entry it was pressed on, which is no longer the screen's. It
  // puts no address in and no state over the pushed entry's.
  const pushed = await pushedInRead(page);
  check(
    "a marked patch whose read of the entry's Navigation API state pushes another entry leaves that entry's address and state",
    pushed.read && pushed.pushed && pushed.drawn && pushed.at === "" && pushed.navState === "pushed" && pushed.ahead === 1 && pushed.before === "older",
    JSON.stringify(pushed),
  );

  // Week's patch draws an element whose `connectedCallback` begins a navigation to Month, which a
  // `navigate` listener of the page cancels: nothing took the screen's place, so Week's answer, drawn
  // whole, puts its address in the entry.
  await page.goto(home);
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
    const body = (await res.text()).replace("</section>", "<smoke-navigates></smoke-navigates></section>");
    await route.fulfill({ response: res, body });
  });
  await page.evaluate((url) => {
    const nav = /** @type {any} */ (window).navigation;
    nav.addEventListener("navigate", (/** @type {any} */ event) => {
      if (new URL(event.destination.url).search === "?scope=month") event.preventDefault();
    });
    customElements.define(
      "smoke-navigates",
      class extends HTMLElement {
        connectedCallback() {
          if (/** @type {any} */ (window).__navigated) return;
          const next = nav.navigate(url);
          next.committed.catch(() => {});
          Object.assign(window, { __navigated: next.finished.then(() => "finished", (/** @type {Error} */ error) => error.name) });
        }
      },
    );
  }, month);
  await press("Week");
  const connectedNav = await page
    .waitForFunction(() => /** @type {any} */ (window).__navigated, undefined, { timeout: 5000 })
    .then(() => page.evaluate(() => /** @type {any} */ (window).__navigated))
    .catch((/** @type {Error} */ e) => e.message);
  const connectedDrawn = await wait(() => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"));
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  await page.unroute(week);
  const connectedNavEnd = await state();
  check(
    "a marked patch whose drawn element begins a navigation a navigate listener cancels puts its address in the entry",
    connectedNav === "AbortError" && connectedDrawn && connectedNavEnd.at === "?scope=week" && connectedNavEnd.shown === "week",
    JSON.stringify({ connectedNav, connectedDrawn, connectedNavEnd }),
  );

  // Week, held on its way, is aborted as the runtime takes a navigation to Month, which a later
  // `navigate` listener of the page cancels; Week, pressed again in the same task, asks for what the
  // aborted read asked for, which is over: it is sent again, and its answer is drawn.
  await page.goto(home);
  let weekReads = 0;
  /** @type {() => void} */
  let releaseAborted = () => {};
  const abortedHeld = new Promise((resolve) => (releaseAborted = () => resolve(undefined)));
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    weekReads += 1;
    if (weekReads === 1) await abortedHeld;
    await route.continue().catch(() => {});
  });
  const abortedSent = page.waitForRequest((r) => r.url() === week && r.headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
  await press("Week");
  const abortedOut = await abortedSent;
  await page.evaluate((url) => {
    const nav = /** @type {any} */ (window).navigation;
    nav.addEventListener("navigate", (/** @type {any} */ event) => {
      if (new URL(event.destination.url).search === "?scope=month") event.preventDefault();
    });
    const next = nav.navigate(url);
    next.committed.catch(() => {});
    next.finished.catch(() => {});
    /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="week"]')).click();
  }, month);
  const pressedAgainDrawn = await wait(() => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"));
  releaseAborted();
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  await page.unroute(week);
  const pressedAgain = { reads: weekReads, ...(await state()) };
  check(
    "a marked GET pressed again as the read a cancelled navigation aborted is sent again and drawn",
    abortedOut && pressedAgainDrawn && pressedAgain.reads === 2 && pressedAgain.at === "?scope=week" && pressedAgain.shown === "week",
    JSON.stringify({ abortedOut, pressedAgainDrawn, pressedAgain }),
  );
  // The same with the GET form without the mark, which sends as before the mark: the press asks for
  // what the aborted read asked for, and sends nothing more, so nothing is drawn.
  await page.goto(home);
  const year = `${home}?scope=year`;
  let yearReads = 0;
  /** @type {() => void} */
  let releaseYear = () => {};
  const yearHeld = new Promise((resolve) => (releaseYear = () => resolve(undefined)));
  await page.route(year, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    yearReads += 1;
    if (yearReads === 1) await yearHeld;
    await route.continue().catch(() => {});
  });
  const yearSent = page.waitForRequest((r) => r.url() === year && r.headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
  await press("Year, in place");
  const yearOut = await yearSent;
  const yearCancelled = await page.evaluate((url) => {
    const nav = /** @type {any} */ (window).navigation;
    nav.addEventListener("navigate", (/** @type {any} */ event) => {
      if (new URL(event.destination.url).search === "?scope=month") event.preventDefault();
    });
    const next = nav.navigate(url);
    next.committed.catch(() => {});
    const ended = next.finished.then(() => "finished", (/** @type {Error} */ error) => error.name);
    /** @type {HTMLButtonElement} */ (Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Year, in place")).click();
    return ended;
  }, month);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 500)));
  releaseYear();
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(year);
  const unmarkedAgain = { reads: yearReads, ...(await state()) };
  check(
    "a GET without data-address pressed again as the read a cancelled navigation aborted sends nothing more and draws nothing, as before the mark",
    yearOut && yearCancelled === "AbortError" && unmarkedAgain.reads === 1 && unmarkedAgain.at === "" && unmarkedAgain.shown === "all",
    JSON.stringify({ yearOut, yearCancelled, unmarkedAgain }),
  );

  const hashed = await hashThenPress(page);
  check(
    "a marked patch pressed in the task that moves the page to an #id of it draws and puts its address in that entry",
    hashed.moved === "#smoke-address" && hashed.drawn && hashed.at === "?scope=week" && hashed.shown === "week",
    JSON.stringify(hashed),
  );

  // Pressed by a listener of the page that hears the move to an #id: `currententrychange`, which
  // comes before `popstate`, and a `popstate` listener put on before the runtime's. The entry has
  // moved before either is heard, so the press is on the entry it moved to.
  const changed = await pressOnMove(page, "currententrychange");
  check(
    "a marked patch pressed by a currententrychange listener as the page moves to an #id of it draws and puts its address in that entry",
    changed.moved === "#smoke-address" && changed.drawn && changed.at === "?scope=week" && changed.shown === "week",
    JSON.stringify(changed),
  );
  const popped = await pressOnMove(page, "popstate");
  check(
    "a marked patch pressed by a popstate listener put on before the runtime's as the page moves to an #id of it draws and puts its address in that entry",
    popped.moved === "#smoke-address" && popped.drawn && popped.at === "?scope=week" && popped.shown === "week",
    JSON.stringify(popped),
  );

  // A replacement the browser refuses without a word (Chromium past its limit of history updates
  // returns before any `navigate` event, and throws nothing) leaves the address as it was, as one
  // that throws does: the runtime cannot tell it from a page's listener that cancelled it.
  const silent = await silentRefusal(page);
  check(
    "a marked patch whose replacement the browser refuses without a word stays drawn under the entry's address, and nothing reads the page again",
    silent.drawn && !silent.read && silent.replaces === 1 && silent.at === "" && silent.shown === "week",
    JSON.stringify(silent),
  );

  // Save's answer draws the form again with `method="post"`: Week, pressed as a read while Save was
  // on its way, is sent from that form, by POST, a write now. Day, pressed while it is on its way,
  // waits for it and does not drop it: its answer is drawn, as a write's is.
  await page.goto(home);
  /** @type {string[]} */
  const posted = [];
  /** @type {Record<string, () => void>} */
  const letGo = {};
  const held = Object.fromEntries(["saved", "week"].map((name) => [name, new Promise((resolve) => (letGo[name] = () => resolve(undefined)))]));
  const postForm = (/** @type {string} */ shown) =>
    `<section id="smoke-address"><form id="smoke-address-form" method="post" action="/smoke/address" data-patch data-address><button name="scope" value="day">Day</button><button name="scope" value="week">Week</button></form><p>Scope: <output>${shown}</output></p></section>`;
  await page.route(home, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || request.headers()["corten"] !== "action") return route.continue();
    const scope = new URLSearchParams(request.postData() ?? "").get("scope") ?? "";
    posted.push(scope);
    await held[scope];
    await route.fulfill({ headers: { "corten-patch": "1", "content-type": "text/html" }, body: postForm(`${scope} posted`) }).catch(() => {});
  });
  await page.evaluate(() => {
    /** @type {string[]} */
    const shown = [];
    Object.assign(window, { __shown: shown });
    new MutationObserver(() => {
      const now = document.querySelector("#smoke-address output")?.textContent ?? "";
      if (shown.at(-1) !== now) shown.push(now);
    }).observe(/** @type {Element} */ (document.querySelector("main")), { childList: true, subtree: true, characterData: true });
  });
  const postedOf = async (/** @type {string} */ scope) => {
    for (let i = 0; i < 50 && !posted.includes(scope); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    return posted.includes(scope);
  };
  await press("Save");
  const savePosted = await postedOf("saved");
  await press("Week");
  letGo.saved();
  const weekPosted = await postedOf("week");
  const dayOnPost = await page.evaluate(() => {
    const day = /** @type {HTMLButtonElement | null} */ (document.querySelector('#smoke-address-form button[value="day"]'));
    day?.click();
    return day?.form?.method ?? null;
  });
  letGo.week();
  const dayPosted = await wait(() => document.querySelector("#smoke-address output")?.textContent === "day posted");
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  await page.unroute(home);
  const becameWrite = { posted, outputs: await page.evaluate(() => /** @type {any} */ (window).__shown), ...(await state()) };
  check(
    "a marked GET waiting for a write is sent as a write when the write's answer draws its form with method post, and a newer press does not drop its answer",
    savePosted && weekPosted && dayOnPost === "post" && dayPosted && becameWrite.posted.join() === "saved,week,day" &&
      becameWrite.outputs.join() === "saved posted,week posted,day posted" && becameWrite.at === "",
    JSON.stringify({ savePosted, weekPosted, dayOnPost, dayPosted, becameWrite }),
  );

  const becameRead = await postThenRead(page, false);
  check(
    "a marked POST waiting for a write is sent as a read when the write's answer draws its form with method get, and puts its address in the entry",
    becameRead.saveSent && becameRead.drawn && becameRead.sent.join() === "POST scope=saved,?scope=week" && becameRead.at === "?scope=week" && becameRead.shown === "week",
    JSON.stringify(becameRead),
  );
  const leftRead = await postThenRead(page, true);
  check(
    "a marked POST waiting for a write, sent again as a read, is not sent once the page has moved to an #id of it",
    leftRead.saveSent && leftRead.moved === "#smoke-address" && leftRead.drawn && leftRead.sent.join() === "POST scope=saved" && leftRead.at === "#smoke-address" && leftRead.shown === "saved",
    JSON.stringify(leftRead),
  );
  // Pressed on a form without the mark, the press knows no entry: sent again as a read from the
  // marked form the write's answer drew, it draws as an unmarked form's read does, and leaves the
  // address, here the entry the page moved to.
  const unmarkedRead = await postThenRead(page, true, true);
  check(
    "a POST pressed on an unmarked form, sent again as a read from the marked form a write's answer drew, draws and leaves the address",
    unmarkedRead.saveSent && unmarkedRead.moved === "#smoke-address" && unmarkedRead.drawn && unmarkedRead.sent.join() === "POST scope=saved,?scope=week" &&
      unmarkedRead.at === "#smoke-address" && unmarkedRead.shown === "week",
    JSON.stringify(unmarkedRead),
  );
  const retriedMoved = await retryMoved(page);
  check(
    "a marked GET sent again after a write is not fetched once a formdata listener moves the page to an #id of it",
    retriedMoved.saveSent && retriedMoved.done && retriedMoved.starts === 0 && retriedMoved.at === "#smoke-address" && retriedMoved.shown === "all",
    JSON.stringify(retriedMoved),
  );
  // Marking the form and its button busy runs the page's code: a customized button's
  // `attributeChangedCallback` that moves the page to an `#id` of it then. The read can no longer
  // draw, and is not fetched.
  const busyMoved = await busyMoves(page);
  if (!busyMoved) skip("a marked GET is not fetched once a submit button's attributeChangedCallback moves the page as it is marked busy", "no customized built-in elements");
  else
    check(
      "a marked GET is not fetched once a submit button's attributeChangedCallback moves the page as it is marked busy",
      busyMoved.done && busyMoved.starts === 0 && busyMoved.at === "#smoke-address" && busyMoved.shown === "all",
      JSON.stringify(busyMoved),
    );
  // So is marking a visit's link busy: a customized link's `attributeChangedCallback` that presses
  // the marked form as the visit marks it. That press is for the page the visit leaves, and is not
  // fetched.
  // A link marked busy is one the runtime marks: where the browser has customized built-ins, one
  // the visit did not mark (no press) fails the check rather than skipping it.
  const busyPressed = await busyPresses(page);
  if (!busyPressed) skip("a marked GET pressed as a visit marks its link busy is not fetched", "no customized built-in elements");
  else
    check(
      "a marked GET pressed as a visit marks its link busy is not fetched, and the visit draws its page",
      busyPressed.pressed === true && busyPressed.starts === 0 && busyPressed.at === "?scope=month" && busyPressed.shown === "month",
      JSON.stringify(busyPressed),
    );
  // So is clearing that mark when the visit is abandoned (`window.stop()`, its answer held): the
  // visit is still on its way as it clears it, and a press made there is not fetched, nor does its
  // answer move the address.
  const busyCleared = await busyClears(page);
  if (!busyCleared) skip("a marked GET pressed as an abandoned visit clears its link's busy mark is not fetched", "no customized built-in elements");
  else
    check(
      "a marked GET pressed as an abandoned visit clears its link's busy mark is not fetched, and the address stays",
      busyCleared.marked === true && busyCleared.pressed === true && busyCleared.starts === 0 && busyCleared.at === "" && busyCleared.shown === "all",
      JSON.stringify(busyCleared),
    );

  // A page's `history.state` with an enumerable getter that pushes an entry of the page's the first
  // time it is read once Week is pressed: the runtime copies the state (which runs the getter)
  // before it checks the entry, so the push is seen, and Week's answer is drawn on the entry it was
  // pressed on, no longer the screen's. Neither the pushed entry's address nor its state is written
  // over (before, the browser ran the getter as it took the state for the runtime's replace, and
  // the replace landed on the pushed entry).
  const gotten = await pushedInStateRead(page);
  check(
    "a marked patch whose history.state getter pushes an entry as the runtime takes the state leaves that entry's address and state",
    gotten.getter && gotten.pushed && gotten.drawn && gotten.at === "?pushed=1" && gotten.state === '{"pushed":true}' && gotten.ahead === 1 && gotten.before === "/smoke/address" &&
      gotten.shown === "week",
    JSON.stringify(gotten),
  );

  // A page's `navigate` listener that holds the runtime's own replace before its address goes in
  // (`precommitHandler`): Week is drawn, its address on its way. Day pressed while it is held is
  // for the address it will put in, and is taken as a press made while a visit is on its way: not
  // sent, so nothing is drawn over Week's panel before Week's address goes in (before, Day drew,
  // and the held replace then put Week's address over Day's panel).
  const deferred = await heldReplace(page);
  if (!deferred) skip("a marked GET pressed while a navigate listener holds the runtime's replace is not sent", "no precommitHandler");
  else
    check(
      "a marked GET pressed while a navigate listener holds the runtime's replace is not sent, and the held replace puts in the address of the panel on screen",
      deferred.held && deferred.drawn && deferred.during.at === "" && deferred.during.transition && deferred.daySent === false && deferred.ended &&
        deferred.after.at === "?scope=week" && deferred.after.shown === "week",
      JSON.stringify(deferred),
    );
  // A marked press is held back only while the browser shows that navigation: once it finishes, is
  // aborted (its `precommitHandler` rejects) or gives way to another (a move to an `#id` of the
  // page), the next press of the form is sent, drawn, and puts its address in.
  // Once let go its address goes in, and the navigation is still on its way while the listener's
  // own handler (`handler`, run after the commit) is: Day pressed then is not sent either (a block
  // lifted at the commit sends it, and its answer then draws under Week's address).
  if (deferred)
    check(
      "a marked GET pressed once a navigate listener's held replace has put its address in, while its handler still runs, is not sent",
      deferred.committed?.sent === 0 && deferred.committed.at === "?scope=week" && deferred.committed.transition && deferred.after.shown === "week",
      JSON.stringify(deferred),
    );
  // A `precommitHandler` runs inside the runtime's `replaceState` call, before the hold is seen
  // after it: Day pressed there is not sent either (before, it was sent, and its answer, let through
  // once the held replace had finished, drew under Week's address).
  const inside = await heldInside(page);
  if (!inside) skip("a marked GET pressed inside the runtime's replace by a navigate listener's precommitHandler is not sent", "no precommitHandler");
  else
    check(
      "a marked GET pressed inside the runtime's replace by a navigate listener's precommitHandler is not sent, and the held replace puts in the address of the panel on screen",
      inside.held && inside.pressedInCall === true && inside.drawn && inside.sent === 0 && inside.ended && inside.after.at === "?scope=week" && inside.after.shown === "week",
      JSON.stringify(inside),
    );
  // Week's replace commits its address, and a `currententrychange` listener begins a replace of
  // its own to that same address inside the call, which a `navigate` listener holds
  // (`precommitHandler`) and, let go, sends to `?scope=third`: the address is Week's as the call
  // returns, but a navigation is on its way. Day pressed then is not sent (before, the address
  // being Week's lifted the hold, Day drew, and the held replace then put `?scope=third` over
  // Day's panel).
  const committedHeld = await heldAfterCommit(page);
  if (!committedHeld) skip("a marked GET pressed while a navigation begun inside the runtime's committed replace is held is not sent", "no precommitHandler");
  else
    check(
      "a marked GET pressed while a navigation begun inside the runtime's committed replace is held is not sent, and the screen keeps Week's panel",
      committedHeld.begun && committedHeld.held && committedHeld.drawn && committedHeld.during.at === "?scope=week" && committedHeld.during.transition && committedHeld.sent === 0 && committedHeld.ended &&
        committedHeld.after.shown === "week" && committedHeld.after.redirected === true && committedHeld.after.at === "?scope=third",
      JSON.stringify(committedHeld),
    );
  // The same held navigation, and a getter of the page's on `navigation.transition` that presses
  // Day the first time the runtime reads it after its call, and answers the held navigation. The
  // runtime reads it while the call's hold is still on, so Day is not sent (before, the hold was
  // lifted for that read, Day was sent, and its answer, coming once the held navigation had gone
  // to `?scope=third`, drew there).
  const readPressed = await heldReadPresses(page);
  if (!readPressed) skip("a marked GET pressed as the runtime reads the navigation its replace left is not sent", "no precommitHandler");
  else
    check(
      "a marked GET pressed as the runtime reads the navigation its replace left is not sent, and the screen keeps Week's panel",
      readPressed.begun && readPressed.held && readPressed.pressed && readPressed.drawn && readPressed.sent === 0 && readPressed.ended && readPressed.after.shown === "week" &&
        readPressed.after.redirected === true && readPressed.after.at === "?scope=third",
      JSON.stringify(readPressed),
    );
  // The entry holds a Navigation API state, which the runtime puts back once Week's address is in;
  // a `currententrychange` listener then begins a replace of its own to that address, which a
  // `navigate` listener holds and, let go, sends to `?scope=third`. The runtime reads what is on
  // its way after it puts the state back, so Day pressed while that replace is held is not sent
  // (before, it read it before, Day was sent and drew, and the held replace put `?scope=third`
  // over Day's panel).
  const restoreHeld = await heldOnRestore(page);
  if (!restoreHeld) skip("a marked GET pressed while a navigation begun as the runtime puts the entry's state back is held is not sent", "no precommitHandler");
  else
    check(
      "a marked GET pressed while a navigation begun as the runtime puts the entry's state back is held is not sent, and the screen keeps Week's panel",
      restoreHeld.begun && restoreHeld.restored === "restored" && restoreHeld.held && restoreHeld.drawn && restoreHeld.during.at === "?scope=week" && restoreHeld.during.transition &&
        restoreHeld.sent === 0 && restoreHeld.ended && restoreHeld.after.shown === "week" && restoreHeld.after.redirected === true && restoreHeld.after.at === "?scope=third",
      JSON.stringify(restoreHeld),
    );
  // A `navigate` listener that cancels the runtime's replace and makes the next read of
  // `navigation.transition` throw: the runtime holds no longer once the call has returned, so the
  // next marked press is sent and drawn (before, the throw left the hold on for good). Week's
  // answer has drawn, so it is not said to have failed (before, the throw ended the submit, which
  // said so with `corten:error`).
  const throwHeld = await heldReadThrows(page);
  if (!throwHeld) skip("a marked GET pressed after a cancelled replace whose transition read threw is sent", "no Navigation API");
  else
    check(
      "a marked GET pressed after a cancelled replace whose transition read threw is sent and puts in its address, and the drawn answer is not said to have failed",
      throwHeld.vetoed && throwHeld.thrown && throwHeld.drawn && throwHeld.during === "" && throwHeld.sent === 1 && throwHeld.again.drawn && throwHeld.again.at === "?scope=day" &&
        throwHeld.errors.length === 0,
      JSON.stringify(throwHeld),
    );
  // Week's patch draws an element whose `connectedCallback` makes the next read of
  // `navigation.transition` throw, which the runtime makes as it checks Week's replace: the address
  // stays, and the drawn answer is not said to have failed (before, the throw ended the submit,
  // which said so with `corten:error`).
  const drawnThrows = await drawnReadThrows(page);
  if (!drawnThrows) skip("a marked answer whose transition read throws as its replace is checked is not said to have failed", "no Navigation API");
  else
    check(
      "a marked answer whose transition read throws as its replace is checked leaves the address and is not said to have failed",
      drawnThrows.thrown && drawnThrows.drawn && drawnThrows.at === "" && drawnThrows.errors.length === 0,
      JSON.stringify(drawnThrows),
    );
  // Once a held replace has finished, nothing of it is kept: a getter of the page's on
  // `navigation.transition` that throws, put on after, is not read as Day is pressed, which is sent
  // and drawn (before, the press read it to compare it with the ended hold, and was lost).
  const endedRead = await heldEndedRead(page);
  if (!endedRead) skip("a marked GET pressed once a held replace has finished does not read the navigation again", "no Navigation API");
  else
    check(
      "a marked GET pressed once a held replace has finished does not read the navigation again, and is sent and drawn",
      endedRead.held && endedRead.drawn && endedRead.ended && endedRead.at === "?scope=week" && endedRead.thrownAtPress === false && endedRead.sent === 1 && endedRead.again.shown === "day",
      JSON.stringify(endedRead),
    );
  const ended = /** @type {const} */ ({ finish: "has finished", abort: "was aborted", supersede: "gave way to another navigation" });
  for (const end of /** @type {const} */ (["finish", "abort", "supersede"])) {
    const name = `a marked GET pressed once a navigate listener's held replace ${ended[end]} is sent and puts in its address`;
    const after = end === "finish" ? deferred : await heldReplace(page, end);
    if (!after) skip(name, "no precommitHandler");
    else
      check(
        name,
        after.held && after.drawn && after.daySent === false && after.ended && after.after.shown === "week" &&
          after.after.at === { finish: "?scope=week", abort: "", supersede: "#smoke-address" }[end] && after.again.sent === 1 && after.again.drawn &&
          after.again.at === "?scope=day" && after.again.shown === "day",
        JSON.stringify(after),
      );
  }
  // Week's patch draws an element whose `connectedCallback` presses Day, sent before Week's replace
  // goes on to be held by a `navigate` listener (`precommitHandler`); Day's answer comes while it is
  // held, and draws nothing, as one that comes while a visit is on its way, so the held replace,
  // let go, puts in the address of the panel on screen (before, Day's answer drew, and the held
  // replace then put Week's address over Day's panel).
  const drawnHeld = await heldDrawnPress(page);
  if (!drawnHeld) skip("a marked answer that comes while a navigate listener holds the runtime's replace draws nothing", "no precommitHandler");
  else
    check(
      "a marked answer that comes while a navigate listener holds the runtime's replace draws nothing, and the held replace puts in the address of the panel on screen",
      drawnHeld.pressed && drawnHeld.held && drawnHeld.drawn && drawnHeld.daySent && drawnHeld.answered && drawnHeld.during.at === "" &&
        drawnHeld.during.shown === "week" && drawnHeld.during.transition && drawnHeld.ended && drawnHeld.after.at === "?scope=week" && drawnHeld.after.shown === "week",
      JSON.stringify(drawnHeld),
    );
  // The answer whose own replace is held has drawn, and goes on as any drawn answer does: a 422
  // puts focus on the field it marks invalid while its replace is held.
  const invalidHeld = await heldInvalid(page);
  if (!invalidHeld) skip("a marked 422 whose replace a navigate listener holds puts focus on its invalid field", "no precommitHandler");
  else
    check(
      "a marked 422 whose replace a navigate listener holds puts focus on its invalid field, and the held replace then puts in its address",
      invalidHeld.held && invalidHeld.drawn && invalidHeld.during.at === "" && invalidHeld.during.transition && invalidHeld.during.focused === "smoke-address-invalid" &&
        invalidHeld.ended && invalidHeld.after.at === "?scope=week",
      JSON.stringify(invalidHeld),
    );

  // A press the runtime refuses records nothing: Week's 422 redraws the form with its id and a field
  // marked invalid, and a `currententrychange` listener that hears the runtime put the entry's
  // state back presses Day on the form it drew, inside the call. Day is not sent, and Week, its
  // answer drawn, still puts focus on its invalid field (before, the refused press took Week's
  // place as the form's latest, and Week, no longer its latest, put focus nowhere).
  const refusedInvalid = await refusedInsideInvalid(page);
  if (!refusedInvalid) skip("a marked press refused inside a 422's replace leaves focus to the 422's invalid field", "no Navigation API");
  else
    check(
      "a marked press refused inside a 422's replace is not sent, and the 422 still puts focus on its invalid field and its address in",
      refusedInvalid.restored && refusedInvalid.pressed && refusedInvalid.drawn && refusedInvalid.sent === 0 && refusedInvalid.focused === "smoke-address-invalid" &&
        refusedInvalid.at === "?scope=week" && refusedInvalid.errors.length === 0,
      JSON.stringify(refusedInvalid),
    );
  // A `navigate` listener holds Elsewhere's replace to another route's address before it goes in
  // (`precommitHandler`): the nav link to the screen stays current while the address is the
  // screen's, and once let go, the nav link to the address the held replace put in is (before, the
  // link was marked as the answer drew, and the address that came in later left the old one current).
  const heldMarks = await heldCommitMarks(page);
  if (!heldMarks) skip("a marked patch whose replace a navigate listener holds marks the nav link current once its address goes in", "no precommitHandler");
  else
    check(
      "a marked patch whose replace a navigate listener holds marks the nav link current once its address goes in",
      heldMarks.held && heldMarks.drawn && heldMarks.during.at === "/smoke/address" && heldMarks.during.current === "/smoke/address" && heldMarks.ended &&
        heldMarks.after.at === "/smoke/address-elsewhere?scope=far" && heldMarks.after.shown === "far" && heldMarks.after.current === "/smoke/address-elsewhere",
      JSON.stringify(heldMarks),
    );
  // Week's replace is held after its address goes in (a listener's `handler`), and the runtime's
  // last read of `navigation.transition` answers it but puts on, in a microtask, a getter that throws
  // the next time it is read. Week has drawn: nothing the runtime reads after says it failed (before,
  // the submit read the getter to see whether the hold was its own, and said `corten:error`).
  const lateGetter = await heldLateGetter(page);
  if (!lateGetter) skip("a marked answer whose held replace is followed by a throwing transition getter is not said to have failed", "no Navigation API");
  else
    check(
      "a marked answer whose held replace is followed by a throwing transition getter is not said to have failed",
      lateGetter.held && lateGetter.armed && lateGetter.drawn && lateGetter.at === "?scope=week" && lateGetter.ended && lateGetter.errors.length === 0,
      JSON.stringify(lateGetter),
    );

  // An answer whose address is already the entry's copies no `history.state`: the runtime looks for
  // what would leave the address before it copies the state (before, it copied the state, running
  // a getter of the page's on it, before it found it had nothing to put in). It is drawn: the mark
  // only its answer carries is on screen (a runtime that drew no answer at the entry's own address
  // would copy nothing too).
  const noCopy = await stateCopies(page, "same");
  check(
    "a marked answer whose address is already the entry's does not copy history.state",
    noCopy.drawn && noCopy.reads === 0 && noCopy.at === "?scope=week" && noCopy.shown === "week",
    JSON.stringify(noCopy),
  );
  // A `history.state` the runtime cannot copy (a function on it): the answer is drawn and the
  // address stays as it was, as for a state the runtime cannot read.
  const uncopied = await stateCopies(page, "throws");
  check(
    "a marked answer whose history.state cannot be copied is drawn and leaves the address",
    uncopied.drawn && uncopied.at === "" && uncopied.shown === "week" && uncopied.kept,
    JSON.stringify(uncopied),
  );

  // A form without the mark whose submit sends no field, its read held, then marked and pressed
  // again: the marked press asks for `?` with an empty query, the unmarked one for no query, so it
  // is another request, sent and drawn, and its address goes in (before, the marked press took the
  // unmarked read over, as the same request, and that read's address went in).
  const overUnmarked = await markedOverUnmarked(page);
  check(
    "a marked press of a form whose unmarked read with no field is on its way sends its own request, with its empty query, and puts in that address",
    overUnmarked.first && overUnmarked.drawn && overUnmarked.asked.join() === "/smoke/address,/smoke/address?" && overUnmarked.at === "/smoke/address?" && overUnmarked.shown === "all",
    JSON.stringify(overUnmarked),
  );
  await page.close();
}

/**
 * Gives the entry a `history.state` object whose enumerable `draft` getter, the first time it is
 * read once armed, pushes an entry of the page's (`?pushed=1`, state `{ pushed: true }`). Presses
 * Week and says whether the getter was on the state and pushed, whether Week drew, and where the
 * page is then: its address, its `history.state`, how far its entry is past the one Week was
 * pressed on, that entry's address, and what it shows. The Navigation API only.
 * @param {import("@playwright/test").Page} page
 */
async function pushedInStateRead(page) {
  await page.goto(`${base}/smoke/address`);
  const getter = await page.evaluate(() => {
    history.replaceState({}, "");
    Object.assign(window, { __armed: false, __pushed: false, __pressedOn: /** @type {any} */ (window).navigation.currentEntry });
    Object.defineProperty(history.state, "draft", {
      enumerable: true,
      get() {
        const w = /** @type {any} */ (window);
        if (w.__armed) {
          w.__armed = false;
          history.pushState({ pushed: true }, "", "/smoke/address?pushed=1");
          w.__pushed = true;
        }
        return "kept";
      },
    });
    Object.assign(window, { __armed: true });
    // The same object each time it is read, so the runtime's read of it has the getter.
    return history.state === history.state && !!Object.getOwnPropertyDescriptor(history.state, "draft")?.get;
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  const end = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__armed = false;
    return {
      pushed: w.__pushed,
      at: location.search,
      state: JSON.stringify(history.state),
      ahead: w.navigation.currentEntry.index - w.__pressedOn.index,
      before: w.__pressedOn.url.slice(location.origin.length),
      shown: document.querySelector("#smoke-address output")?.textContent,
    };
  });
  return { getter, drawn, ...end };
}

/**
 * A `navigate` listener of the page holds the runtime's replace to Week's address before it goes
 * in (`precommitHandler`), and after it too, in its own `handler`, held apart. Presses Week, then
 * Day while the replace is held, then ends it as `end` says: lets it go ("finish"), pressing Day
 * once its address is in while the `handler` still holds it, then lets that go; rejects the
 * listener's `precommitHandler`, which aborts it ("abort"); or moves to an `#id` of the page, a
 * navigation that takes its place ("supersede"); then presses Day again. Says whether it
 * was held, whether Week drew, where the page was while it was held, whether Day's read was sent
 * then, how many reads the press after the commit sent and where the page was then ("finish"),
 * where the page is once the held navigation has ended, and how many reads the press after
 * sent, whether its answer drew and where the page is then; null where the browser has no
 * `precommitHandler`.
 * @param {import("@playwright/test").Page} page @param {"finish" | "abort" | "supersede"} [end]
 */
async function heldReplace(page, end = "finish") {
  const home = `${base}/smoke/address`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  if (!(await page.evaluate(() => "NavigationPrecommitController" in window))) return null;
  let daySends = 0;
  await page.route(day, (route) => {
    if (route.request().headers()["corten"] === "action") daySends += 1;
    return route.continue();
  });
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    /** @type {(reason?: unknown) => void} */
    let fail = () => {};
    const held = new Promise((resolve, reject) => ((release = resolve), (fail = reject)));
    /** @type {(value?: unknown) => void} */
    let finish = () => {};
    const after = new Promise((resolve) => (finish = resolve));
    Object.assign(w, { __release: release, __fail: fail, __finish: finish, __held: false, __heldError: null });
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (w.__held || event.navigationType !== "replace" || new URL(event.destination.url).search !== "?scope=week") return;
      try {
        event.intercept({ precommitHandler: () => held, handler: () => after });
        w.__held = true;
      } catch (error) {
        w.__heldError = String(error);
      }
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  const during = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return { held: w.__held, error: w.__heldError, at: location.search, transition: !!w.navigation.transition };
  });
  await page.getByRole("button", { name: "Day", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 500)));
  const daySent = daySends > 0;
  await page.evaluate((end) => {
    const w = /** @type {any} */ (window);
    if (end === "abort") w.__fail(new DOMException("held", "AbortError"));
    else {
      if (end === "supersede") location.hash = "smoke-address";
      // Let go once it has given way too, so nothing of the page's is left waiting.
      w.__release();
    }
  }, end);
  // Let go, its address goes in, and its own handler (`handler`, after the commit) still holds it:
  // Day pressed now is not sent either.
  /** @type {{ sent: number, at: string, transition: boolean } | undefined} */
  let committed;
  if (end === "finish") {
    const n = daySends;
    await page.waitForFunction(() => location.search === "?scope=week", undefined, { timeout: 5000 }).catch(() => {});
    await page.getByRole("button", { name: "Day", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
    await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 500)));
    committed = { sent: daySends - n, ...(await page.evaluate(() => ({ at: location.search, transition: !!(/** @type {any} */ (window).navigation.transition) }))) };
  }
  await page.evaluate(() => /** @type {any} */ (window).__finish());
  const ended = await page.waitForFunction(() => !(/** @type {any} */ (window).navigation.transition), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.waitForFunction(() => !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  const after = await page.evaluate(() => ({ at: location.search + location.hash, shown: document.querySelector("#smoke-address output")?.textContent }));
  // The next press, once the held navigation has ended.
  const before = daySends;
  await page.getByRole("button", { name: "Day", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const againDrawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "day" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  await page.unroute(day);
  const again = await page.evaluate(() => ({ at: location.search + location.hash, shown: document.querySelector("#smoke-address output")?.textContent }));
  return { held: during.held, drawn, during, daySent, committed, ended, after, again: { sent: daySends - before, drawn: againDrawn, ...again } };
}

/**
 * A `navigate` listener of the page holds the runtime's replace to Week's address before it goes
 * in (`precommitHandler`), and its `precommitHandler` presses Day, which the browser runs inside
 * the runtime's `replaceState` call. A read of Day is answered only once the held replace has
 * ended. Presses Week, then lets the replace go. Says whether it was held, whether Day was pressed
 * inside the call, whether Week drew, how many reads of Day were sent, whether the held replace
 * ended, and where the page is once any answer of Day's has come; null where the browser has no
 * `precommitHandler`.
 * @param {import("@playwright/test").Page} page
 */
async function heldInside(page) {
  const home = `${base}/smoke/address`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  if (!(await page.evaluate(() => "NavigationPrecommitController" in window))) return null;
  let daySends = 0;
  /** @type {() => void} */
  let letDay = () => {};
  const dayHeld = new Promise((resolve) => (letDay = () => resolve(undefined)));
  await page.route(day, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    daySends += 1;
    await dayHeld;
    await route.continue().catch(() => {});
  });
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    Object.assign(w, { __release: release, __held: false, __inCall: false, __pressedInCall: null });
    const replace = history.replaceState;
    history.replaceState = function (/** @type {any[]} */ ...args) {
      w.__inCall = true;
      try {
        return replace.apply(this, /** @type {any} */ (args));
      } finally {
        w.__inCall = false;
      }
    };
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (w.__held || event.navigationType !== "replace" || new URL(event.destination.url).search !== "?scope=week") return;
      event.intercept({
        precommitHandler: () => {
          w.__pressedInCall = w.__inCall;
          const day = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="day"]'));
          day.form?.requestSubmit(day);
          return held;
        },
      });
      w.__held = true;
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && /** @type {any} */ (window).__pressedInCall !== null, undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 500)));
  const begun = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return { held: w.__held, pressedInCall: w.__pressedInCall };
  });
  await page.evaluate(() => /** @type {any} */ (window).__release());
  const ended = await page.waitForFunction(() => !(/** @type {any} */ (window).navigation.transition), undefined, { timeout: 5000 }).then(() => true, () => false);
  // Any read of Day's is answered only now, once the held replace has ended.
  const answered = daySends ? page.waitForResponse((r) => r.url() === day, { timeout: 5000 }).catch(() => null) : null;
  letDay();
  await answered;
  await page.waitForFunction(() => !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(day);
  const after = await page.evaluate(() => ({ at: location.search, shown: document.querySelector("#smoke-address output")?.textContent }));
  return { ...begun, drawn, sent: daySends, ended, after };
}

/**
 * Week's replace commits its address; a `currententrychange` listener of the page then begins a
 * replace of its own to the same address (`history.replaceState`) inside the runtime's call,
 * which a `navigate` listener holds (`precommitHandler`) and, let go, sends to `?scope=third`
 * (`redirect`, where the browser has it). Presses Week, then Day while that replace is held, then
 * lets it go. Says whether the listener's replace was begun and held, whether Week drew, where the
 * page was while it was held, how many reads of Day were sent, whether it ended, and where the page
 * is then; null where the browser has no `precommitHandler`.
 * @param {import("@playwright/test").Page} page
 */
async function heldAfterCommit(page) {
  const home = `${base}/smoke/address`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  if (!(await page.evaluate(() => "NavigationPrecommitController" in window))) return null;
  let daySends = 0;
  await page.route(day, (route) => {
    if (route.request().headers()["corten"] === "action") daySends += 1;
    return route.continue();
  });
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    Object.assign(w, { __release: release, __begun: false, __held: false, __redirected: null });
    w.navigation.addEventListener("currententrychange", () => {
      if (w.__begun || location.search !== "?scope=week") return;
      w.__begun = true;
      history.replaceState(history.state, "", location.href);
    });
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (!w.__begun || w.__held || event.navigationType !== "replace") return;
      w.__held = true;
      event.intercept({
        precommitHandler: async (/** @type {any} */ controller) => {
          await held;
          try {
            controller.redirect(`${location.pathname}?scope=third`);
            w.__redirected = true;
          } catch {
            w.__redirected = false;
          }
        },
      });
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  const during = await page.evaluate(() => ({ at: location.search, transition: !!(/** @type {any} */ (window).navigation.transition) }));
  await page.getByRole("button", { name: "Day", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 500)));
  await page.waitForFunction(() => !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).catch(() => {});
  const begun = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return { begun: w.__begun, held: w.__held };
  });
  await page.evaluate(() => /** @type {any} */ (window).__release());
  const ended = await page.waitForFunction(() => !(/** @type {any} */ (window).navigation.transition), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(day);
  const after = await page.evaluate(() => ({
    at: location.search,
    shown: document.querySelector("#smoke-address output")?.textContent,
    redirected: /** @type {any} */ (window).__redirected,
  }));
  return { ...begun, drawn, during, sent: daySends, ended, after };
}

/**
 * A `navigate` listener of the page cancels the runtime's replace to Week's address and makes the
 * next read of `navigation.transition` throw, once. Presses Week, then Day once Week has drawn.
 * Says whether the replace was cancelled and the read threw, whether Week drew, where the page was
 * then, how many reads of Day were sent, and whether Day's answer drew and where the page is then;
 * and the status of each `corten:error` the page heard; null where the browser has no Navigation
 * API.
 * @param {import("@playwright/test").Page} page
 */
async function heldReadThrows(page) {
  const home = `${base}/smoke/address`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  if (!(await page.evaluate(() => "navigation" in window))) return null;
  let daySends = 0;
  await page.route(day, (route) => {
    if (route.request().headers()["corten"] === "action") daySends += 1;
    return route.continue();
  });
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    Object.assign(w, { __vetoed: false, __thrown: false, __errors: [] });
    document.addEventListener("corten:error", (event) => w.__errors.push(/** @type {CustomEvent} */ (event).detail?.status ?? null));
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (w.__vetoed || event.navigationType !== "replace" || new URL(event.destination.url).search !== "?scope=week") return;
      w.__vetoed = true;
      event.preventDefault();
      Object.defineProperty(w.navigation, "transition", {
        configurable: true,
        get() {
          delete w.navigation.transition;
          w.__thrown = true;
          throw new Error("smoke: a one-shot transition getter");
        },
      });
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  const state = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return { vetoed: w.__vetoed, thrown: w.__thrown, during: location.search };
  });
  await page.getByRole("button", { name: "Day", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const againDrawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "day" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  await page.unroute(day);
  const { at, errors } = await page.evaluate(() => ({ at: location.search, errors: /** @type {any} */ (window).__errors }));
  return { ...state, drawn, sent: daySends, again: { drawn: againDrawn, at }, errors };
}

/**
 * As {@link heldAfterCommit}: Week's replace commits its address, a `currententrychange` listener
 * begins a replace of its own to that address inside the runtime's call, which a `navigate`
 * listener holds (`precommitHandler`) and, let go, sends to `?scope=third`. That listener then
 * puts on a getter of `navigation.transition` which, read once, presses Day and answers the held
 * navigation. A read of Day is answered only once the held navigation has ended. Presses Week,
 * then lets it go. Says whether the listener's replace was begun and held, whether the getter
 * pressed Day, whether Week drew, how many reads of Day were sent, whether the held navigation
 * ended, and where the page is once any answer of Day's has come; null where the browser has no
 * `precommitHandler`.
 * @param {import("@playwright/test").Page} page
 */
async function heldReadPresses(page) {
  const home = `${base}/smoke/address`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  if (!(await page.evaluate(() => "NavigationPrecommitController" in window))) return null;
  let daySends = 0;
  /** @type {() => void} */
  let letDay = () => {};
  const dayHeld = new Promise((resolve) => (letDay = () => resolve(undefined)));
  await page.route(day, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    daySends += 1;
    await dayHeld;
    await route.continue().catch(() => {});
  });
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const real = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w.navigation), "transition")).get;
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    Object.assign(w, { __release: release, __begun: false, __held: false, __pressed: false, __redirected: null });
    w.navigation.addEventListener("currententrychange", () => {
      if (w.__begun || location.search !== "?scope=week") return;
      w.__begun = true;
      history.replaceState(history.state, "", location.href);
      // Read once, it presses Day and answers what the browser's own getter does.
      Object.defineProperty(w.navigation, "transition", {
        configurable: true,
        get() {
          delete w.navigation.transition;
          w.__pressed = true;
          const day = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="day"]'));
          day.form?.requestSubmit(day);
          return real?.call(w.navigation);
        },
      });
    });
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (!w.__begun || w.__held || event.navigationType !== "replace") return;
      w.__held = true;
      event.intercept({
        precommitHandler: async (/** @type {any} */ controller) => {
          await held;
          try {
            controller.redirect(`${location.pathname}?scope=third`);
            w.__redirected = true;
          } catch {
            w.__redirected = false;
          }
        },
      });
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && /** @type {any} */ (window).__pressed, undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 500)));
  const begun = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return { begun: w.__begun, held: w.__held, pressed: w.__pressed };
  });
  await page.evaluate(() => /** @type {any} */ (window).__release());
  const ended = await page.waitForFunction(() => !(/** @type {any} */ (window).navigation.transition), undefined, { timeout: 5000 }).then(() => true, () => false);
  // Any read of Day's is answered only now, once the held navigation has ended.
  const answered = daySends ? page.waitForResponse((r) => r.url() === day, { timeout: 5000 }).catch(() => null) : null;
  letDay();
  await answered;
  await page.waitForFunction(() => !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(day);
  const after = await page.evaluate(() => ({
    at: location.search,
    shown: document.querySelector("#smoke-address output")?.textContent,
    redirected: /** @type {any} */ (window).__redirected,
  }));
  return { ...begun, drawn, sent: daySends, ended, after };
}

/**
 * Gives the entry a Navigation API state, which the runtime puts back once Week's address is in
 * (`updateCurrentEntry`, a `currententrychange` with a null `navigationType`); a listener of that
 * event then begins a replace of its own to Week's address, which a `navigate` listener holds
 * (`precommitHandler`) and, let go, sends to `?scope=third`. Presses Week, then Day while that
 * replace is held, then lets it go. Says whether the listener's replace was begun, the state it
 * found back, whether it was held, whether Week drew, where the page was while it was held, how
 * many reads of Day were sent, whether it ended, and where the page is then; null where the
 * browser has no `precommitHandler`.
 * @param {import("@playwright/test").Page} page
 */
async function heldOnRestore(page) {
  const home = `${base}/smoke/address`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  if (!(await page.evaluate(() => "NavigationPrecommitController" in window))) return null;
  let daySends = 0;
  await page.route(day, (route) => {
    if (route.request().headers()["corten"] === "action") daySends += 1;
    return route.continue();
  });
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    Object.assign(w, { __release: release, __begun: false, __restored: null, __held: false, __redirected: null });
    w.navigation.updateCurrentEntry({ state: { smoke: "restored" } });
    w.navigation.addEventListener("currententrychange", (/** @type {any} */ event) => {
      if (w.__begun || event.navigationType !== null || location.search !== "?scope=week") return;
      w.__begun = true;
      w.__restored = w.navigation.currentEntry.getState()?.smoke ?? null;
      history.replaceState(history.state, "", location.href);
    });
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (!w.__begun || w.__held || event.navigationType !== "replace") return;
      w.__held = true;
      event.intercept({
        precommitHandler: async (/** @type {any} */ controller) => {
          await held;
          try {
            controller.redirect(`${location.pathname}?scope=third`);
            w.__redirected = true;
          } catch {
            w.__redirected = false;
          }
        },
      });
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  const during = await page.evaluate(() => ({ at: location.search, transition: !!(/** @type {any} */ (window).navigation.transition) }));
  await page.getByRole("button", { name: "Day", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 500)));
  await page.waitForFunction(() => !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).catch(() => {});
  const begun = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return { begun: w.__begun, restored: w.__restored, held: w.__held };
  });
  await page.evaluate(() => /** @type {any} */ (window).__release());
  const ended = await page.waitForFunction(() => !(/** @type {any} */ (window).navigation.transition), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(day);
  const after = await page.evaluate(() => ({
    at: location.search,
    shown: document.querySelector("#smoke-address output")?.textContent,
    redirected: /** @type {any} */ (window).__redirected,
  }));
  return { ...begun, drawn, during, sent: daySends, ended, after };
}

/**
 * Presses Week, whose patch draws an element whose `connectedCallback` makes the next read of
 * `navigation.transition` throw, once. Says whether it threw, whether Week drew, where the page is
 * then, and the status of each `corten:error` the page heard; null where the browser has no
 * Navigation API.
 * @param {import("@playwright/test").Page} page
 */
async function drawnReadThrows(page) {
  const home = `${base}/smoke/address`;
  const week = `${home}?scope=week`;
  await page.goto(home);
  if (!(await page.evaluate(() => "navigation" in window))) return null;
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    // Uncompressed: Firefox's route.fetch reads a compressed body it was not sent as empty.
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
    const body = (await res.text()).replace("</section>", "<smoke-throws-on-read></smoke-throws-on-read></section>");
    await route.fulfill({ response: res, body });
  });
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    Object.assign(w, { __thrown: false, __errors: [] });
    document.addEventListener("corten:error", (event) => w.__errors.push(/** @type {CustomEvent} */ (event).detail?.status ?? null));
    customElements.define(
      "smoke-throws-on-read",
      class extends HTMLElement {
        connectedCallback() {
          Object.defineProperty(w.navigation, "transition", {
            configurable: true,
            get() {
              delete w.navigation.transition;
              w.__thrown = true;
              throw new Error("smoke: a one-shot transition getter");
            },
          });
        }
      },
    );
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(week);
  const state = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return { thrown: w.__thrown, at: location.search, errors: w.__errors };
  });
  return { ...state, drawn };
}

/**
 * A `navigate` listener of the page holds the runtime's replace to Week's address once it is in,
 * in its own `handler`. Presses Week, lets the replace go and waits for it to finish, then puts on
 * a getter of `navigation.transition` that throws, read once, and presses Day. Says whether the
 * replace was held, whether Week drew, whether the held navigation ended and where the page was
 * then, whether the getter had been read by the time Day was pressed, how many reads of Day were
 * sent, and what the page shows then; null where the browser has no Navigation API.
 * @param {import("@playwright/test").Page} page
 */
async function heldEndedRead(page) {
  const home = `${base}/smoke/address`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  if (!(await page.evaluate(() => "navigation" in window))) return null;
  let daySends = 0;
  await page.route(day, (route) => {
    if (route.request().headers()["corten"] === "action") daySends += 1;
    return route.continue();
  });
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    Object.assign(w, { __release: release, __held: false, __thrown: false });
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (w.__held || event.navigationType !== "replace" || new URL(event.destination.url).search !== "?scope=week") return;
      event.intercept({ handler: () => held });
      w.__held = true;
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  const held = await page.evaluate(() => /** @type {any} */ (window).__held);
  await page.evaluate(() => /** @type {any} */ (window).__release());
  const ended = await page.waitForFunction(() => !(/** @type {any} */ (window).navigation.transition), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  const at = await page.evaluate(() => location.search);
  // Pressed in the same task as the getter is put on, so nothing else reads it first.
  const thrownAtPress = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    Object.defineProperty(w.navigation, "transition", {
      configurable: true,
      get() {
        delete w.navigation.transition;
        w.__thrown = true;
        throw new Error("smoke: a one-shot transition getter");
      },
    });
    const day = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="day"]'));
    try {
      day.form?.requestSubmit(day);
    } catch {
      // Reported by what the press sent.
    }
    return w.__thrown;
  });
  await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "day" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .catch(() => {});
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  await page.unroute(day);
  const again = await page.evaluate(() => {
    delete (/** @type {any} */ (window).navigation.transition);
    return { shown: document.querySelector("#smoke-address output")?.textContent };
  });
  return { held, drawn, ended, at, thrownAtPress, sent: daySends, again };
}

/**
 * Presses Week, whose patch draws an element whose `connectedCallback` presses Day before Week's
 * address goes in; a `navigate` listener of the page then holds Week's replace
 * (`precommitHandler`). Day's read is sent before the hold and its answer held until the replace
 * is held, then let through; once it has come, the replace is let go. Says whether Day was pressed
 * and sent, whether the replace was held, whether Week drew, whether Day's answer came, where the
 * page was while the replace was held, and where it is once the held replace has ended; null
 * where the browser has no `precommitHandler`.
 * @param {import("@playwright/test").Page} page
 */
async function heldDrawnPress(page) {
  const home = `${base}/smoke/address`;
  const week = `${home}?scope=week`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  if (!(await page.evaluate(() => "NavigationPrecommitController" in window))) return null;
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    // Uncompressed: Firefox's route.fetch reads a compressed body it was not sent as empty.
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
    const body = (await res.text()).replace("</section>", "<smoke-presses-day></smoke-presses-day></section>");
    await route.fulfill({ response: res, body });
  });
  let daySends = 0;
  /** @type {() => void} */
  let letDay = () => {};
  const dayHeld = new Promise((resolve) => (letDay = () => resolve(undefined)));
  await page.route(day, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    daySends += 1;
    await dayHeld;
    return route.continue();
  });
  const dayAnswered = page.waitForResponse((r) => r.url() === day && r.status() === 200, { timeout: 10000 }).then(() => true, () => false);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    Object.assign(w, { __release: release, __held: false, __pressedDay: false });
    customElements.define(
      "smoke-presses-day",
      class extends HTMLElement {
        connectedCallback() {
          if (w.__pressedDay) return;
          w.__pressedDay = true;
          const day = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="day"]'));
          day.form?.requestSubmit(day);
        }
      },
    );
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (w.__held || event.navigationType !== "replace" || new URL(event.destination.url).search !== "?scope=week") return;
      event.intercept({ precommitHandler: () => held });
      w.__held = true;
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && /** @type {any} */ (window).__held, undefined, { timeout: 5000 })
    .then(() => true, () => false);
  // Day's read was sent as Week's answer drew, before the hold: its route has it.
  for (let waited = 0; !daySends && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  const daySent = daySends === 1;
  const begun = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return { pressed: w.__pressedDay, held: w.__held };
  });
  letDay();
  const answered = await dayAnswered;
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 500)));
  const during = await page.evaluate(() => ({
    at: location.search,
    shown: document.querySelector("#smoke-address output")?.textContent,
    transition: !!(/** @type {any} */ (window).navigation.transition),
  }));
  await page.evaluate(() => /** @type {any} */ (window).__release());
  const ended = await page.waitForFunction(() => !(/** @type {any} */ (window).navigation.transition), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.waitForFunction(() => !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(week);
  await page.unroute(day);
  const after = await page.evaluate(() => ({ at: location.search, shown: document.querySelector("#smoke-address output")?.textContent }));
  return { ...begun, drawn, daySent, answered, during, ended, after };
}

/**
 * A `navigate` listener of the page holds the runtime's replace to Week's address before it goes
 * in (`precommitHandler`), and Week is answered with a 422 patch whose section holds a field marked
 * invalid. Presses Week, then lets the replace go. Says whether it was held, whether the 422 drew,
 * where the page was and which element had focus while it was held, and where the page is once the
 * held replace has ended; null where the browser has no `precommitHandler`.
 * @param {import("@playwright/test").Page} page
 */
async function heldInvalid(page) {
  const home = `${base}/smoke/address`;
  const week = `${home}?scope=week`;
  await page.goto(home);
  if (!(await page.evaluate(() => "NavigationPrecommitController" in window))) return null;
  await page.route(week, (route) =>
    route.request().headers()["corten"] === "action"
      ? route.fulfill({
          status: 422,
          headers: { "corten-patch": "1", "content-type": "text/html" },
          body: '<section id="smoke-address"><output>Invalid</output><input id="smoke-address-invalid" aria-invalid="true"></section>',
        })
      : route.continue(),
  );
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    Object.assign(w, { __release: release, __held: false });
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (w.__held || event.navigationType !== "replace" || new URL(event.destination.url).search !== "?scope=week") return;
      event.intercept({ precommitHandler: () => held });
      w.__held = true;
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "Invalid" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  const during = await page.evaluate(() => ({
    at: location.search,
    transition: !!(/** @type {any} */ (window).navigation.transition),
    focused: document.activeElement?.id ?? null,
  }));
  const held = await page.evaluate(() => /** @type {any} */ (window).__held);
  await page.evaluate(() => /** @type {any} */ (window).__release());
  const ended = await page.waitForFunction(() => !(/** @type {any} */ (window).navigation.transition), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.unroute(week);
  const after = await page.evaluate(() => ({ at: location.search }));
  return { held, drawn, during, ended, after };
}

/**
 * Gives the entry a Navigation API state, which the runtime puts back once Week's address is in, and
 * answers Week with a 422 patch: its own panel, the form with its id among it, and a field marked
 * invalid. A `currententrychange` listener of the page that hears that state go back (a null
 * `navigationType`) presses Day on the form Week drew, inside the runtime's call. Says whether the
 * state went back and Day was pressed, whether the 422 drew, how many reads of Day were sent, which
 * element has focus, where the page is, and the `corten:error` statuses said; null where the browser
 * has no Navigation API.
 * @param {import("@playwright/test").Page} page
 */
async function refusedInsideInvalid(page) {
  const home = `${base}/smoke/address`;
  const week = `${home}?scope=week`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  if (!(await page.evaluate(() => "navigation" in window))) return null;
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    // Uncompressed: Firefox's route.fetch reads a compressed body it was not sent as empty.
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
    const body = (await res.text()).replace("</section>", '<input id="smoke-address-invalid" aria-invalid="true"></section>');
    await route.fulfill({ response: res, status: 422, body });
  });
  let daySends = 0;
  await page.route(day, (route) => {
    if (route.request().headers()["corten"] === "action") daySends += 1;
    return route.continue();
  });
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    Object.assign(w, { __restored: false, __pressed: false, __errors: [] });
    document.addEventListener("corten:error", (event) => w.__errors.push(/** @type {CustomEvent} */ (event).detail?.status ?? null));
    w.navigation.updateCurrentEntry({ state: { kept: true } });
    w.navigation.addEventListener("currententrychange", (/** @type {any} */ event) => {
      if (w.__pressed || event.navigationType !== null || location.search !== "?scope=week") return;
      w.__restored = w.navigation.currentEntry.getState()?.kept === true;
      w.__pressed = true;
      const day = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="day"]'));
      day.form?.requestSubmit(day);
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => !!document.getElementById("smoke-address-invalid") && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(week);
  await page.unroute(day);
  const state = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return { restored: w.__restored, pressed: w.__pressed, focused: document.activeElement?.id ?? null, at: location.search, errors: w.__errors };
  });
  return { ...state, drawn, sent: daySends };
}

/**
 * A `navigate` listener of the page holds the runtime's replace to Elsewhere's address, another
 * route's, before it goes in (`precommitHandler`). Presses Elsewhere on the screen, then lets the
 * replace go. Says whether it was held, whether Elsewhere's panel drew, where the page was and which
 * nav link was current while it was held, whether the held replace ended, and where the page is,
 * what it shows and which nav link is current then; null where the browser has no
 * `precommitHandler`.
 * @param {import("@playwright/test").Page} page
 */
async function heldCommitMarks(page) {
  await page.goto(`${base}/smoke/address`);
  if (!(await page.evaluate(() => "NavigationPrecommitController" in window))) return null;
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    Object.assign(w, { __release: release, __held: false });
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (w.__held || event.navigationType !== "replace" || new URL(event.destination.url).pathname !== "/smoke/address-elsewhere") return;
      event.intercept({ precommitHandler: () => held });
      w.__held = true;
    });
  });
  const where = () =>
    page.evaluate(() => ({
      at: location.pathname + location.search,
      shown: document.querySelector("#smoke-address output")?.textContent,
      current: Array.from(document.querySelectorAll("main nav a[aria-current=page]"), (a) => a.getAttribute("href")).join(),
    }));
  await page.getByRole("button", { name: "Elsewhere", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "far" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  const during = await where();
  const held = await page.evaluate(() => /** @type {any} */ (window).__held);
  await page.evaluate(() => /** @type {any} */ (window).__release());
  const ended = await page.waitForFunction(() => !(/** @type {any} */ (window).navigation.transition), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  return { held, drawn, during, ended, after: await where() };
}

/**
 * A `navigate` listener of the page holds the runtime's replace to Week's address once it is in, in
 * its own `handler`. A `currententrychange` listener, which hears that address go in after the
 * runtime's own listeners, puts on a getter of `navigation.transition` that answers the browser's
 * own once (the runtime's read as its call returns) and then, in a microtask, puts on one that
 * throws the next time it is read. Presses Week, then lets the replace go. Says whether the replace
 * was held and the getter put on, whether Week drew, where the page is, whether the held replace
 * ended, and the `corten:error` statuses said; null where the browser has no Navigation API.
 * @param {import("@playwright/test").Page} page
 */
async function heldLateGetter(page) {
  await page.goto(`${base}/smoke/address`);
  if (!(await page.evaluate(() => "navigation" in window))) return null;
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const real = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w.navigation), "transition")).get;
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    Object.assign(w, { __release: release, __held: false, __armed: false, __errors: [] });
    document.addEventListener("corten:error", (event) => w.__errors.push(/** @type {CustomEvent} */ (event).detail?.status ?? null));
    w.navigation.addEventListener("navigate", (/** @type {any} */ event) => {
      if (w.__held || event.navigationType !== "replace" || new URL(event.destination.url).search !== "?scope=week") return;
      event.intercept({ handler: () => held });
      w.__held = true;
    });
    w.navigation.addEventListener("currententrychange", (/** @type {any} */ event) => {
      if (w.__armed || event.navigationType !== "replace" || location.search !== "?scope=week") return;
      w.__armed = true;
      Object.defineProperty(w.navigation, "transition", {
        configurable: true,
        get() {
          delete w.navigation.transition;
          queueMicrotask(() =>
            Object.defineProperty(w.navigation, "transition", {
              configurable: true,
              get() {
                delete w.navigation.transition;
                throw new Error("smoke: a one-shot transition getter");
              },
            }),
          );
          return real?.call(w.navigation);
        },
      });
    });
  });
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  const state = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    // The getter, if it is still on, is not read again by the test.
    delete w.navigation.transition;
    return { held: w.__held, armed: w.__armed, at: location.search };
  });
  await page.evaluate(() => /** @type {any} */ (window).__release());
  const ended = await page.waitForFunction(() => !(/** @type {any} */ (window).navigation.transition), undefined, { timeout: 5000 }).then(() => true, () => false);
  const errors = await page.evaluate(() => /** @type {any} */ (window).__errors);
  return { ...state, drawn, ended, errors };
}

/**
 * Gives the entry a `history.state` object and presses Week. With `how` "same", from Week's own
 * address, the state's enumerable `draft` getter counts its reads once Week is pressed; with
 * "throws", from the page's own address, a function on the state makes it one `structuredClone`
 * cannot copy. Week's answer carries a mark the page does not. Says whether Week's answer drew
 * (with its mark), how many times the getter was read, where the page
 * is then, what it shows, and whether the entry's state is still the object it was given.
 * @param {import("@playwright/test").Page} page @param {"same" | "throws"} how
 */
async function stateCopies(page, how) {
  const home = `${base}/smoke/address`;
  const week = `${home}?scope=week`;
  await page.goto(how === "same" ? week : home);
  // Week's answer carries a mark the page at Week's address does not, so it is seen drawn even where
  // Week is on screen already.
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    // Uncompressed: Firefox's route.fetch reads a compressed body it was not sent as empty.
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
    await route.fulfill({ response: res, body: (await res.text()).replace("</section>", '<i id="smoke-address-answered"></i></section>') });
  });
  const answered = page.waitForResponse((r) => r.url() === week && r.request().headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate((how) => {
    history.replaceState({}, "");
    const state = history.state;
    Object.assign(window, { __reads: 0, __armed: false, __state: state });
    if (how === "throws") state.fn = () => {};
    else
      Object.defineProperty(state, "draft", {
        enumerable: true,
        get() {
          const w = /** @type {any} */ (window);
          if (w.__armed) w.__reads += 1;
          return "kept";
        },
      });
    Object.assign(window, { __armed: true });
  }, how);
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const came = await answered;
  const drawn =
    came &&
    (await page
      .waitForFunction(
        () => document.querySelector("#smoke-address output")?.textContent === "week" && !!document.getElementById("smoke-address-answered") && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"),
        undefined,
        { timeout: 5000 },
      )
      .then(() => true, () => false));
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  await page.unroute(week);
  return page.evaluate((drawn) => {
    const w = /** @type {any} */ (window);
    w.__armed = false;
    return { drawn, reads: w.__reads, at: location.search, shown: document.querySelector("#smoke-address output")?.textContent, kept: history.state === w.__state };
  }, drawn);
}

/**
 * Takes `data-address` off the form and the name off its Day button, so its submit sends no field,
 * from `?scope=week`; presses Day with its read held, marks the form again and presses Day once
 * more, then lets the reads go. Says whether the first read was sent, which requests were made,
 * whether an answer drew, and where the page is then.
 * @param {import("@playwright/test").Page} page
 */
async function markedOverUnmarked(page) {
  const home = `${base}/smoke/address`;
  await page.goto(`${home}?scope=week`);
  /** @type {string[]} */
  const asked = [];
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  const bare = (/** @type {URL} */ url) => url.pathname === "/smoke/address" && url.search === "";
  await page.route(bare, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    const url = route.request().url();
    asked.push(url.slice(new URL(url).origin.length));
    await held;
    await route.continue().catch(() => {});
  });
  await page.evaluate(() => {
    const form = /** @type {HTMLFormElement} */ (document.getElementById("smoke-address-form"));
    form.removeAttribute("data-address");
    form.querySelector('button[value="day"]')?.removeAttribute("name");
  });
  const day = page.getByRole("button", { name: "Day", exact: true });
  await day.evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  let first = false;
  for (let i = 0; i < 50 && !(first = asked.length > 0); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  await page.evaluate(() => document.getElementById("smoke-address-form")?.setAttribute("data-address", ""));
  await day.evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 500)));
  release();
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "all" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  await page.unroute(bare);
  const end = await page.evaluate(() => ({ at: location.href.slice(location.origin.length), shown: document.querySelector("#smoke-address output")?.textContent }));
  return { first, asked, drawn, ...end };
}

/**
 * Presses Save, then Week on the form drawn with `method="post"` while Save is on its way: a write
 * then, which waits for Save's answer. That answer draws the form as the server writes it, with
 * `method="get"`, so Week is sent again from it as a read, fenced as one. With `move`, the page
 * moves to an `#id` of it before Save's answer: Week was pressed on the entry the page left. With
 * `unmarked`, the form is pressed without `data-address`, which the answer draws it with. Says
 * what the runtime sent and where the page is once Save's answer, and any read after it, is drawn.
 * @param {import("@playwright/test").Page} page @param {boolean} move @param {boolean} [unmarked]
 */
async function postThenRead(page, move, unmarked = false) {
  const home = `${base}/smoke/address`;
  await page.goto(home);
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  await page.route(home, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || request.headers()["corten"] !== "action") return route.continue();
    await held;
    await route.continue().catch(() => {});
  });
  const posted = page.waitForRequest((r) => r.url() === home && r.method() === "POST", { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate((unmarked) => {
    /** @type {string[]} */
    const sent = [];
    Object.assign(window, { __sent: sent });
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(String(input instanceof Request ? input.url : input), location.href);
      if (url.pathname === "/smoke/address" && new Headers(init?.headers).get("corten") === "action")
        sent.push((init?.method ?? "GET").toUpperCase() === "GET" ? url.search : `POST ${init?.body}`);
      return fetch_.call(this, input, init);
    };
    const form = /** @type {HTMLFormElement} */ (document.getElementById("smoke-address-form"));
    form.setAttribute("method", "post");
    if (unmarked) form.removeAttribute("data-address");
  }, unmarked);
  const click = (/** @type {string} */ name) => page.getByRole("button", { name, exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  await click("Save");
  const saveSent = await posted;
  await click("Week");
  const moved = move
    ? await page.evaluate(
        () =>
          new Promise((resolve) => {
            addEventListener("hashchange", () => resolve(location.hash), { once: true });
            location.hash = "smoke-address";
          }),
      )
    : null;
  release();
  const settled = () => page.waitForFunction(() => !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).then(() => true, () => false);
  const drawn = move
    ? await page
        .waitForFunction((shown) => document.querySelector("#smoke-address output")?.textContent === shown, unmarked ? "week" : "saved", { timeout: 5000 })
        .then(() => true, () => false)
    : await page.waitForFunction(() => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week", undefined, { timeout: 5000 }).then(() => true, () => false);
  // Long enough for a read sent after Save's answer (in a task of its own) to be on its way, then
  // drawn.
  await page.waitForTimeout(500);
  await settled();
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  await page.unroute(home);
  const end = await page.evaluate(() => ({
    sent: /** @type {string[]} */ (/** @type {any} */ (window).__sent),
    at: location.search + location.hash,
    shown: document.querySelector("#smoke-address output")?.textContent,
  }));
  return { saveSent, moved, drawn, ...end };
}

/**
 * Presses Week, marked or not, and while its answer is held follows a link marked `data-reload` to
 * another document, whose load the route holds too; then lets Week's answer come as `kind` says (its
 * patch, Corten's redirect to Month, or its patch with a layout that changed), and the load after it.
 * Says whether each was sent, whether the load was aborted, what was drawn and where the page was
 * while the load was held, and where the page ended.
 * @param {import("@playwright/test").Page} page @param {"patch" | "location" | "shell"} kind @param {boolean} marked
 */
async function heldLoad(page, kind, marked) {
  const home = `${base}/smoke/address`;
  const week = `${home}?scope=week`;
  const other = `${base}/smoke/address-elsewhere?held=1`;
  await page.goto(home);
  /** @type {() => void} */
  let releaseWeek = () => {};
  const weekHeld = new Promise((resolve) => (releaseWeek = () => resolve(undefined)));
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    await weekHeld;
    if (kind === "location") return route.fulfill({ headers: { "corten-location": "/smoke/address?scope=month" }, body: "" });
    // Uncompressed: Firefox's route.fetch reads a compressed body it was not sent as empty.
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
    const { "content-length": _length, "content-encoding": _encoding, ...headers } = res.headers();
    if (kind === "shell") headers["corten-shell"] = "changed";
    return route.fulfill({ status: res.status(), headers, body: await res.text() });
  });
  /** @type {() => void} */
  let releaseOther = () => {};
  const otherHeld = new Promise((resolve) => (releaseOther = () => resolve(undefined)));
  let aborted = false;
  await page.route(other, async (route) => {
    await otherHeld;
    await route.continue().catch(() => (aborted = true));
  });
  // Firefox and WebKit abort the page's requests, Week's among them, as the load begins.
  let weekAborted = false;
  const failed = (/** @type {import("@playwright/test").Request} */ r) => void (r.url() === other ? (aborted = true) : r.url() === week && (weekAborted = true));
  page.on("requestfailed", failed);
  if (!marked) await page.evaluate(() => document.getElementById("smoke-address-form")?.removeAttribute("data-address"));
  // Each navigation to another document the page begins, kept in the tab's session storage, which
  // outlasts the document (put on now: the page cannot be reached while the held load is on its way).
  await page.evaluate(() => {
    sessionStorage.removeItem("smoke-navigations");
    // And where the page is and what it shows, every 50 ms until it unloads, the last 40 kept.
    sessionStorage.removeItem("smoke-looks");
    setInterval(() => {
      const looks = JSON.parse(sessionStorage.getItem("smoke-looks") ?? "[]").slice(-39);
      looks.push([Date.now(), location.pathname + location.search, document.querySelector("#smoke-address output")?.textContent ?? null]);
      sessionStorage.setItem("smoke-looks", JSON.stringify(looks));
    }, 50);
    /** @type {any} */ (window).navigation?.addEventListener("navigate", (/** @type {any} */ event) => {
      if (event.destination.sameDocument) return;
      const to = new URL(event.destination.url);
      const seen = JSON.parse(sessionStorage.getItem("smoke-navigations") ?? "[]");
      sessionStorage.setItem("smoke-navigations", JSON.stringify([...seen, `navigate ${event.navigationType} ${to.pathname}${to.search}`]));
    });
  });
  const weekSent = page.waitForRequest((r) => r.url() === week, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="week"]')).click());
  const sent = await weekSent;
  const otherSent = page.waitForRequest((r) => r.url() === other, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate((href) => {
    const link = document.createElement("a");
    link.href = href;
    link.dataset.reload = "";
    document.body.append(link);
    link.click();
  }, other);
  const loading = await otherSent;
  await page.waitForTimeout(100);
  const cutOff = weekAborted;
  // What the answer begins while the load is held: Corten's redirect, a reload, or nothing, each a
  // navigation (`navigate` fires whether or not the browser sends its request), and the requests
  // the browser sends for it then.
  /** @type {string[]} */
  const requested = [];
  let asking = true;
  const ask = (/** @type {import("@playwright/test").Request} */ r) => {
    const url = new URL(r.url());
    if (asking && r.url() !== other && r.url() !== week) requested.push(`${r.headers()["corten"] ?? r.resourceType()} ${url.pathname}${url.search}`);
  };
  page.on("request", ask);
  releaseWeek();
  await page.waitForTimeout(1000);
  asking = false;
  page.off("request", ask);
  // What the answer drew while the load is held, and the address then: the page's last look before
  // the load is let go (the page is not asked while that load is on its way).
  const releasedAt = Date.now();
  releaseOther();
  await page.waitForTimeout(1500);
  page.off("requestfailed", failed);
  await page.unroute(week);
  await page.unroute(other);
  const final = new URL(page.url());
  /** @type {string[]} */
  const begun = await page.evaluate(() => JSON.parse(sessionStorage.getItem("smoke-navigations") ?? "[]"));
  const asked = [...begun.filter((n) => !n.endsWith(" /smoke/address-elsewhere?held=1")), ...requested];
  /** @type {[number, string, string | null][]} */
  const looks = await page.evaluate(() => JSON.parse(sessionStorage.getItem("smoke-looks") ?? "[]"));
  const last = looks.filter(([t]) => t < releasedAt).at(-1);
  const drew = { at: last?.[1] ?? null, shown: last?.[2] ?? null, fresh: !!last && releasedAt - last[0] < 500 };
  return { sent, loading, cutOff, aborted, asked, drew, final: final.pathname + final.search };
}

/**
 * Presses Week, whose patch draws an element whose `connectedCallback` presses Day on the form
 * Week's answer drew, before Week's address goes in; the server answers both, and Day's answer
 * draws. Says whether
 * Day was pressed, answered and drawn, and where the page is then, with its state and how many
 * entries were added. With `listener` "replace" (the Navigation API only), a `currententrychange`
 * listener of the page replaces the entry again (the same address, another state) inside Week's
 * replace; with "state", the entry has a Navigation API state of its own before Week is pressed,
 * and the listener puts another in the entry inside Week's replace (`updateCurrentEntry`).
 * @param {import("@playwright/test").Page} page @param {"" | "replace" | "state"} listener
 */
async function drawnPress(page, listener) {
  const home = `${base}/smoke/address`;
  const week = `${home}?scope=week`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    // Uncompressed: Firefox's route.fetch reads a compressed body it was not sent as empty.
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
    const body = (await res.text()).replace("</section>", "<smoke-presses-day></smoke-presses-day></section>");
    await route.fulfill({ response: res, body });
  });
  const answered = page.waitForResponse((r) => r.url() === day && r.status() === 200, { timeout: 5000 }).then(() => true, () => false);
  const length = await page.evaluate((listener) => {
    Object.assign(window, { __pressedDay: false });
    customElements.define(
      "smoke-presses-day",
      class extends HTMLElement {
        connectedCallback() {
          if (/** @type {any} */ (window).__pressedDay) return;
          Object.assign(window, { __pressedDay: true });
          const day = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="day"]'));
          day.form?.requestSubmit(day);
        }
      },
    );
    const nav = /** @type {any} */ (window).navigation;
    if (listener === "state") nav.updateCurrentEntry({ state: "older" });
    if (listener) {
      let once = false;
      nav.addEventListener("currententrychange", (/** @type {any} */ event) => {
        if (once || event.navigationType !== "replace") return;
        once = true;
        if (listener === "state") nav.updateCurrentEntry({ state: "listener" });
        else history.replaceState("listener", "", location.href);
      });
    }
    return history.length;
  }, listener);
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const pressed = await page.waitForFunction(() => /** @type {any} */ (window).__pressedDay, undefined, { timeout: 5000 }).then(() => true, () => false);
  const came = await answered;
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "day" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  await page.unroute(week);
  const end = await page.evaluate(
    (length) => ({
      at: location.search,
      state: history.state,
      navState: /** @type {any} */ (window).navigation?.currentEntry.getState() ?? null,
      shown: document.querySelector("#smoke-address output")?.textContent ?? null,
      added: history.length - length,
    }),
    length,
  );
  return { pressed, answered: came, drawn, ...end };
}

/**
 * Gives the entry a Navigation API state, and wraps the entries' `getState` so that the first
 * read of it once Week is pressed pushes an entry of the page's at the same address with a state
 * of its own (`updateCurrentEntry`), then answers the state of the entry it was asked on. Presses
 * Week and says whether the state was read and the entry pushed, whether Week's answer drew,
 * where the page is then, the screen's entry's state, the state of the entry Week was pressed on
 * and how far the screen's entry is past it. The Navigation API only.
 * @param {import("@playwright/test").Page} page
 */
async function pushedInRead(page) {
  await page.goto(`${base}/smoke/address`);
  await page.evaluate(() => {
    const nav = /** @type {any} */ (window).navigation;
    nav.updateCurrentEntry({ state: "older" });
    const proto = Object.getPrototypeOf(nav.currentEntry);
    const getState = proto.getState;
    Object.assign(window, { __read: false, __pushed: false, __armed: false, __pressedOn: nav.currentEntry });
    proto.getState = function () {
      const w = /** @type {any} */ (window);
      if (w.__armed) {
        w.__armed = false;
        w.__read = true;
        history.pushState(null, "", location.href);
        nav.updateCurrentEntry({ state: "pushed" });
        w.__pushed = nav.currentEntry !== this;
      }
      return getState.call(this);
    };
  });
  await page.evaluate(() => Object.assign(window, { __armed: true }));
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  const end = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__armed = false;
    return {
      read: w.__read,
      pushed: w.__pushed,
      at: location.search,
      navState: w.navigation.currentEntry.getState() ?? null,
      before: w.__pressedOn.getState() ?? null,
      ahead: w.navigation.currentEntry.index - w.__pressedOn.index,
    };
  });
  return { drawn, ...end };
}

/**
 * Presses a second marked form the page adds outside the panel (its Day) and then Week, both
 * answers held, and lets Week's come and draw first, then Day's. With `listener`, a
 * `currententrychange` listener of the page replaces the entry again (the same address, another
 * state) as Week's answer replaces it, while the runtime's replace is running. Says whether each
 * was sent and drawn, the state the listener left and how many calls of `replaceState` were
 * running as it began its own (the runtime's: 1), and where the page is once Day's is drawn.
 * @param {import("@playwright/test").Page} page @param {boolean} listener
 */
async function twoMarked(page, listener) {
  const home = `${base}/smoke/address`;
  const week = `${home}?scope=week`;
  const day = `${home}?scope=day`;
  await page.goto(home);
  /** @type {Record<string, () => void>} */
  const letGo = {};
  /** @type {Record<string, Promise<unknown>>} */
  const held = {};
  for (const url of [week, day]) {
    held[url] = new Promise((resolve) => (letGo[url] = () => resolve(undefined)));
    await page.route(url, async (route) => {
      if (route.request().headers()["corten"] !== "action") return route.continue();
      await held[url];
      await route.continue().catch(() => {});
    });
  }
  const sent = (/** @type {string} */ url) => page.waitForRequest((r) => r.url() === url && r.headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
  const dayAsked = sent(day);
  await page.evaluate((listener) => {
    // A state an earlier check left (a load of the same address keeps it) is not this one's.
    history.replaceState(null, "", location.href);
    const form = document.createElement("form");
    form.id = "smoke-address-second";
    form.action = "/smoke/address";
    form.dataset.patch = "";
    form.dataset.address = "";
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "scope";
    field.value = "day";
    form.append(field);
    document.querySelector("main")?.append(form);
    Object.assign(window, { __second: form, __listened: null });
    // How many calls of `replaceState` are running, so the listener can say it ran inside the runtime's.
    let depth = 0;
    const replace = history.replaceState;
    history.replaceState = function (...args) {
      depth += 1;
      try {
        return replace.apply(this, args);
      } finally {
        depth -= 1;
      }
    };
    if (listener)
      /** @type {any} */ (window).navigation.addEventListener("currententrychange", () => {
        if (location.search !== "?scope=week" || /** @type {any} */ (window).__listened) return;
        Object.assign(window, { __listened: "replacing", __within: depth });
        history.replaceState({ smoke: "listener" }, "", location.href);
        Object.assign(window, { __listened: history.state?.smoke ?? "none" });
      });
    form.requestSubmit();
  }, listener);
  const daySent = await dayAsked;
  const weekAsked = sent(week);
  await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="week"]')).click());
  const weekSent = await weekAsked;
  letGo[week]();
  const weekDrawn = await page
    .waitForFunction(
      () => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"),
      undefined,
      { timeout: 5000 },
    )
    .then(() => true, () => false);
  const listened = await page.evaluate(() => /** @type {any} */ (window).__listened);
  const within = await page.evaluate(() => /** @type {any} */ (window).__within ?? null);
  letGo[day]();
  const dayDone = await page
    .waitForFunction(
      () => document.querySelector("#smoke-address output")?.textContent === "day" && !(/** @type {any} */ (window).__second.hasAttribute("aria-busy")),
      undefined,
      { timeout: 5000 },
    )
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200))));
  await page.unroute(week);
  await page.unroute(day);
  const end = await page.evaluate(() => ({ at: location.search, shown: document.querySelector("#smoke-address output")?.textContent, state: history.state?.smoke ?? null }));
  return { daySent, weekSent, weekDrawn, listened, within, dayDone, ...end };
}

/**
 * Presses Week, marked or not, and while its answer is held replaces the entry as `how` says, the
 * page's own doing, which keeps the entry's key and is over before the answer comes: a navigation
 * to an `#id` of the page that replaces (the Navigation API's), `replaceState` to another address,
 * or to the same address with another state. `held` is that navigation still on its way as the
 * answer comes: committed, with the handler a `navigate` listener gave it held until Week's submit
 * has ended. Says where the page is then.
 * @param {import("@playwright/test").Page} page @param {"navigate" | "held" | "replaceState" | "state"} how @param {boolean} marked
 */
async function replacedWhileOut(page, how, marked) {
  const home = `${base}/smoke/address`;
  const week = `${home}?scope=week`;
  await page.goto(home);
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  await page.route(week, async (route) => {
    if (route.request().headers()["corten"] !== "action") return route.continue();
    await held;
    await route.continue().catch(() => {});
  });
  const weekSent = page.waitForRequest((r) => r.url() === week && r.headers()["corten"] === "action", { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate((marked) => {
    const form = /** @type {HTMLFormElement} */ (document.getElementById("smoke-address-form"));
    if (!marked) form.removeAttribute("data-address");
    Object.assign(window, { __form: form });
  }, marked);
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const sent = await weekSent;
  const put = await page.evaluate(async (how) => {
    const nav = /** @type {any} */ (window).navigation;
    if (how === "navigate") await nav.navigate("#smoke-address", { history: "replace" }).finished;
    else if (how === "held") {
      /** @type {(value?: unknown) => void} */
      let release = () => {};
      const handlerHeld = new Promise((resolve) => (release = resolve));
      nav.addEventListener(
        "navigate",
        (/** @type {any} */ event) => void (new URL(event.destination.url).hash === "#smoke-address" && event.intercept({ handler: () => handlerHeld })),
        { once: true },
      );
      const { committed, finished } = nav.navigate("#smoke-address", { history: "replace" });
      Object.assign(window, { __releaseHeld: release, __heldEnd: finished.then(() => "finished", (/** @type {Error} */ e) => e.name) });
      await committed;
    } else if (how === "replaceState") history.replaceState(null, "", "?sort=name");
    else history.replaceState({ smoke: "state" }, "", location.href);
    return location.href;
  }, how);
  // Still on its way as the page replaced the entry.
  const replaced = await page.evaluate(() => /** @type {any} */ (window).__form.hasAttribute("aria-busy"));
  release();
  const done = await page
    .waitForFunction(() => !(/** @type {any} */ (window).__form.hasAttribute("aria-busy")), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200))));
  await page.unroute(week);
  const end = await page.evaluate(() => ({
    at: location.href,
    shown: document.querySelector("#smoke-address output")?.textContent,
    state: history.state?.smoke === "state",
  }));
  if (how !== "held") return { sent, replaced, done, put, ...end };
  // The page's navigation was still on its way as the answer was drawn, and finishes once let go.
  const heldDuring = await page.evaluate(() => !!(/** @type {any} */ (window).navigation.transition));
  /** @type {string} */
  const heldEnd = await page.evaluate(() => {
    /** @type {any} */ (window).__releaseHeld();
    return /** @type {any} */ (window).__heldEnd;
  });
  return { sent, replaced, done, put, ...end, heldDuring, heldEnd };
}

/**
 * Moves the page to an `#id` of it, and presses Week from a listener of the page that hears the move,
 * `currententrychange` or `popstate`, put on before the runtime's (by a script in the page before
 * it), so the press comes before the runtime hears the move. Says where the page is once Week's
 * answer is drawn.
 * @param {import("@playwright/test").Page} page @param {"currententrychange" | "popstate"} type
 */
async function pressOnMove(page, type) {
  await page.addInitScript((type) => {
    const name = `__pressOn${type}`;
    (type === "popstate" ? window : /** @type {any} */ (window).navigation)?.addEventListener(type, () => {
      const press = /** @type {any} */ (window)[name];
      Object.assign(window, { [name]: undefined });
      press?.();
    });
  }, type);
  await page.goto(`${base}/smoke/address`);
  const moved = await page.evaluate(
    (type) =>
      new Promise((resolve) => {
        // Where the page is as the listener presses: the answer may replace the address before the
        // move's `hashchange` comes.
        const press = () => {
          const moved = location.hash;
          /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="week"]')).click();
          resolve(moved);
        };
        Object.assign(window, { [`__pressOn${type}`]: press });
        location.hash = "smoke-address";
      }),
    type,
  );
  const drawn = await page.waitForFunction(() => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  const end = await page.evaluate(() => ({ at: location.search + location.hash, shown: document.querySelector("#smoke-address output")?.textContent }));
  return { moved, drawn, ...end };
}

/**
 * Presses Week with `history.replaceState` made to do nothing for its address, and throw nothing,
 * as a browser that refuses it without a word does, and says whether its answer drew, whether the
 * page was read again, how often the runtime asked for the replacement and where the page is.
 * @param {import("@playwright/test").Page} page
 */
async function silentRefusal(page) {
  const home = `${base}/smoke/address`;
  await page.goto(home);
  await page.evaluate(() => {
    let asked = 0;
    Object.assign(window, { __weekReplaces: () => asked });
    const replace = history.replaceState;
    history.replaceState = function (...args) {
      if (!String(args[2]).endsWith("?scope=week")) return replace.apply(this, args);
      asked += 1;
    };
  });
  const read = page.waitForRequest((r) => r.resourceType() === "document", { timeout: 3000 }).then(() => true, () => false);
  // A runtime that reads the page again is let finish loading before the next case.
  const loaded = page.waitForEvent("load", { timeout: 3000 }).then(() => true, () => false);
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(() => document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  const [asked, reloaded] = [await read, await loaded];
  const result = { drawn, read: asked || reloaded };
  const end = await page.evaluate(() => ({ at: location.search, shown: document.querySelector("#smoke-address output")?.textContent, replaces: /** @type {any} */ (window).__weekReplaces() }));
  return { ...result, ...end };
}

/**
 * Presses Week on the screen once its entry holds a state of the page's own (`history.state`, and
 * `getState()` where the Navigation API is), and says what the entry holds once the answer is
 * drawn: the address, the entries added, both states, whether the key stayed, and each `navigate`
 * and `currententrychange` since the press. With `plain`, without the Navigation API; null when the engine lacks it.
 * @param {import("@playwright/test").Browser} browser @param {boolean} plain @param {string[]} errors
 */
async function keptState(browser, plain, errors) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`kept state${plain ? " plain" : ""}: ${e.message}`));
  if (plain)
    await page.addInitScript(() => {
      delete (/** @type {any} */ (Window.prototype)).navigation;
      delete (/** @type {any} */ (window)).navigation;
    });
  await page.goto(`${base}/smoke/address`);
  const first = await page.evaluate(() => {
    const nav = /** @type {any} */ (window).navigation;
    // `history.state` first: a `replaceState` drops the Navigation API's state.
    history.replaceState({ page: "own" }, "", location.href);
    nav?.updateCurrentEntry({ state: { draft: "unsaved" } });
    /** @type {string[]} */
    const navigates = [];
    /** @type {{ type: string | null, id: string }[]} */
    const changes = [];
    nav?.addEventListener("navigate", (/** @type {any} */ event) => navigates.push(event.navigationType));
    nav?.addEventListener("currententrychange", (/** @type {any} */ event) => changes.push({ type: event.navigationType, id: nav.currentEntry.id }));
    Object.assign(window, { __navigates: navigates, __changes: changes });
    return { api: !!nav, length: history.length, key: nav?.currentEntry.key ?? null };
  });
  if (!plain && !first.api) {
    await page.close();
    return null;
  }
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(
      () => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"),
      undefined,
      { timeout: 5000 },
    )
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  const end = await page.evaluate((first) => {
    const nav = /** @type {any} */ (window).navigation;
    return {
      api: !!nav,
      at: location.search,
      added: history.length - first.length,
      state: JSON.stringify(history.state),
      navState: nav ? JSON.stringify(nav.currentEntry.getState()) : null,
      sameKey: nav ? nav.currentEntry.key === first.key : null,
      navigates: /** @type {string[]} */ (/** @type {any} */ (window).__navigates),
      // Each change of the entry since the press: the replace, then the state put back, whose
      // entry is the one the replace made (the same id).
      changes: /** @type {{ type: string | null, id: string }[]} */ (/** @type {any} */ (window).__changes).map((c) => `${c.type}${c.id === nav?.currentEntry.id ? "" : " other"}`),
      transition: nav ? !!nav.transition : null,
    };
  }, first);
  await page.close();
  return { drawn, ...end };
}

/**
 * Presses Save, held, and Week, which waits for it; Save is answered with a 204, and as Week, sent
 * again after it, reads the form, a `formdata` listener of the page moves it to an `#id` of it.
 * Says how often Week was fetched and where the page is once the retry has had its turn.
 * @param {import("@playwright/test").Page} page
 */
async function retryMoved(page) {
  const home = `${base}/smoke/address`;
  await page.goto(home);
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  await page.route(home, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || request.headers()["corten"] !== "action") return route.continue();
    await held;
    await route.fulfill({ status: 204 }).catch(() => {});
  });
  const posted = page.waitForRequest((r) => r.url() === home && r.method() === "POST", { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => {
    let starts = 0;
    Object.assign(window, { __weekStarts: () => starts, __form: document.getElementById("smoke-address-form") });
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(String(input instanceof Request ? input.url : input), location.href);
      if (url.pathname === "/smoke/address" && url.search === "?scope=week" && new Headers(init?.headers).get("corten") === "action") starts += 1;
      return fetch_.call(this, input, init);
    };
  });
  const click = (/** @type {string} */ name) => page.getByRole("button", { name, exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  await click("Save");
  const saveSent = await posted;
  await click("Week");
  await page.evaluate(() => document.addEventListener("formdata", () => (location.hash = "smoke-address"), { once: true }));
  release();
  const done = await page.waitForFunction(() => !(/** @type {any} */ (window).__form.hasAttribute("aria-busy")), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300))));
  await page.unroute(home);
  const end = await page.evaluate(() => ({
    starts: /** @type {any} */ (window).__weekStarts(),
    at: location.search + location.hash,
    shown: document.querySelector("#smoke-address output")?.textContent,
  }));
  return { saveSent, done, ...end };
}

/**
 * Moves the page to an `#id` of it and presses Week in the same task, before the browser says it
 * moved (`hashchange`), and says where the page is once Week's answer is drawn.
 * @param {import("@playwright/test").Page} page
 */
async function hashThenPress(page) {
  await page.goto(`${base}/smoke/address`);
  const moved = await page.evaluate(
    () =>
      new Promise((resolve) => {
        location.hash = "smoke-address";
        // Read as it moved: the answer may replace the address before the move's `hashchange` comes.
        const moved = location.hash;
        /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="week"]')).click();
        addEventListener("hashchange", () => setTimeout(() => resolve(moved)), { once: true });
      }),
  );
  const drawn = await page.waitForFunction(() => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  const end = await page.evaluate(() => ({ at: location.search + location.hash, shown: document.querySelector("#smoke-address output")?.textContent }));
  return { moved, drawn, ...end };
}

/**
 * Presses Week by a customized submit button (`is=`) of the scope form whose
 * `attributeChangedCallback` moves the page to an `#id` of it as the runtime marks the button busy,
 * just before the read would be fetched. Says how often Week was fetched and where the page is once
 * its submit has ended; null where the browser has no customized built-in elements (WebKit).
 * @param {import("@playwright/test").Page} page
 */
async function busyMoves(page) {
  await page.goto(`${base}/smoke/address`);
  const defined = await page.evaluate(() => {
    let starts = 0;
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(String(input instanceof Request ? input.url : input), location.href);
      if (url.pathname === "/smoke/address" && url.search === "?scope=week" && new Headers(init?.headers).get("corten") === "action") starts += 1;
      return fetch_.call(this, input, init);
    };
    const form = document.getElementById("smoke-address-form");
    Object.assign(window, { __weekStarts: () => starts, __form: form });
    class BusyMoves extends HTMLButtonElement {
      static observedAttributes = ["aria-busy"];
      /** @param {string} _name @param {string | null} _old @param {string | null} now */
      attributeChangedCallback(_name, _old, now) {
        if (now === "true" && !location.hash) location.hash = "smoke-address";
      }
    }
    try {
      customElements.define("smoke-busy-moves", BusyMoves, { extends: "button" });
    } catch {
      return false;
    }
    const button = document.createElement("button", { is: "smoke-busy-moves" });
    if (!(button instanceof BusyMoves)) return false;
    button.name = "scope";
    button.value = "week";
    button.textContent = "Week, moving";
    form?.append(button);
    return true;
  });
  if (!defined) return null;
  await page.getByRole("button", { name: "Week, moving", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const done = await page.waitForFunction(() => !(/** @type {any} */ (window).__form.hasAttribute("aria-busy")), undefined, { timeout: 5000 }).then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  const end = await page.evaluate(() => ({
    starts: /** @type {any} */ (window).__weekStarts(),
    at: location.search + location.hash,
    shown: document.querySelector("#smoke-address output")?.textContent,
  }));
  return { done, ...end };
}

/**
 * Follows a customized link (`is=`) to the screen's month scope whose `attributeChangedCallback`
 * presses Week on the marked scope form as the runtime marks the link busy for its visit, before
 * the visit is fetched. Says whether it pressed, how often Week was fetched and where the page is
 * once the visit has ended; null where the browser has no customized built-in elements (WebKit).
 * @param {import("@playwright/test").Page} page
 */
async function busyPresses(page) {
  await page.goto(`${base}/smoke/address`);
  const defined = await page.evaluate(() => {
    let starts = 0;
    let pressed = false;
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(String(input instanceof Request ? input.url : input), location.href);
      if (url.pathname === "/smoke/address" && url.search === "?scope=week" && new Headers(init?.headers).get("corten") === "action") starts += 1;
      return fetch_.call(this, input, init);
    };
    Object.assign(window, { __weekStarts: () => starts, __pressed: () => pressed });
    class BusyPresses extends HTMLAnchorElement {
      static observedAttributes = ["aria-busy"];
      /** @param {string} _name @param {string | null} _old @param {string | null} now */
      attributeChangedCallback(_name, _old, now) {
        if (now !== "true" || pressed) return;
        pressed = true;
        const week = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="week"]'));
        week.form?.requestSubmit(week);
      }
    }
    try {
      customElements.define("smoke-busy-presses", BusyPresses, { extends: "a" });
    } catch {
      return false;
    }
    const link = document.createElement("a", { is: "smoke-busy-presses" });
    if (!(link instanceof BusyPresses)) return false;
    link.href = "/smoke/address?scope=month";
    link.textContent = "Month, pressing";
    document.querySelector("main")?.append(link);
    return true;
  });
  if (!defined) return null;
  await page.getByRole("link", { name: "Month, pressing", exact: true }).evaluate((link) => /** @type {HTMLAnchorElement} */ (link).click());
  await page
    .waitForFunction(() => location.search === "?scope=month" && document.querySelector("#smoke-address output")?.textContent === "month" && !document.querySelector("main")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .catch(() => {});
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 300)));
  const end = await page.evaluate(() => ({
    pressed: /** @type {any} */ (window).__pressed?.() ?? null,
    starts: /** @type {any} */ (window).__weekStarts?.() ?? null,
    at: location.search + location.hash,
    shown: document.querySelector("#smoke-address output")?.textContent,
  }));
  return end;
}

/**
 * Follows a customized link (`is=`) to the screen's month scope, whose answer is held, and abandons
 * the visit with `window.stop()` once the runtime has marked the link busy. The link's
 * `attributeChangedCallback` presses Week on the marked scope form as that mark is cleared. Says
 * whether the link was marked, whether it pressed, how often Week was fetched and where the page is
 * once Week's answer would have come; null where the browser has no customized built-in elements
 * (WebKit).
 * @param {import("@playwright/test").Page} page
 */
async function busyClears(page) {
  await page.goto(`${base}/smoke/address`);
  const month = `${base}/smoke/address?scope=month`;
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  await page.route(month, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  const defined = await page.evaluate(() => {
    let starts = 0;
    let marked = false;
    let pressed = false;
    const fetch_ = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(String(input instanceof Request ? input.url : input), location.href);
      if (url.pathname === "/smoke/address" && url.search === "?scope=week" && new Headers(init?.headers).get("corten") === "action") starts += 1;
      return fetch_.call(this, input, init);
    };
    Object.assign(window, { __clearStarts: () => starts, __clearPressed: () => pressed, __clearMarked: () => marked });
    class BusyClears extends HTMLAnchorElement {
      static observedAttributes = ["aria-busy"];
      /** @param {string} _name @param {string | null} old @param {string | null} now */
      attributeChangedCallback(_name, old, now) {
        if (now === "true") marked = true;
        if (old !== "true" || now !== null || pressed) return;
        pressed = true;
        const week = /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="week"]'));
        week.form?.requestSubmit(week);
      }
    }
    try {
      customElements.define("smoke-busy-clears", BusyClears, { extends: "a" });
    } catch {
      return false;
    }
    const link = document.createElement("a", { is: "smoke-busy-clears" });
    if (!(link instanceof BusyClears)) return false;
    link.href = "/smoke/address?scope=month";
    link.textContent = "Month, held";
    document.querySelector("main")?.append(link);
    return true;
  });
  if (!defined) {
    await page.unroute(month);
    return null;
  }
  const asked = page.waitForRequest((r) => r.url() === month, { timeout: 5000 }).then(() => true, () => false);
  await page.getByRole("link", { name: "Month, held", exact: true }).evaluate((link) => /** @type {HTMLAnchorElement} */ (link).click());
  await asked;
  await page.evaluate(() => window.stop());
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 500)));
  const end = await page.evaluate(() => ({
    marked: /** @type {any} */ (window).__clearMarked?.() ?? null,
    pressed: /** @type {any} */ (window).__clearPressed?.() ?? null,
    starts: /** @type {any} */ (window).__clearStarts?.() ?? null,
    at: location.search + location.hash,
    shown: document.querySelector("#smoke-address output")?.textContent,
  }));
  release();
  await page.unroute(month);
  return end;
}

/**
 * Submits 41 forms of ids of their own, unmarked and marked, holding one's answer, and asks the
 * browser's heap (Chromium's DevTools protocol, `Runtime.queryObjects`) which of the page's maps
 * hold their ids as keys: the held one's while its read is on its way, and none once every press
 * has settled. With them, a form whose `submit` listener takes its button out, so the runtime
 * cannot read the form for it (`new FormData` throws), and two forms pressed three times, each
 * press under a new id: one's write is held, which its two reads wait for, the second replacing the
 * first; the other's read is held, which each later press takes over. Only the latest press of
 * each is kept while it is held. Null in a browser without that protocol.
 * @param {import("@playwright/test").Browser} browser
 */
async function pressesKept(browser) {
  if (browser.browserType().name() !== "chromium") return null;
  const home = `${base}/smoke/address`;
  const page = await browser.newPage();
  await page.goto(home);
  const cdp = await page.context().newCDPSession(page);
  const prefix = "smoke-press-kept-";
  /** The ids pressed here that any map of the page holds as a key, sorted. */
  const kept = async () => {
    const group = "smoke-press-kept";
    const { result: proto } = await cdp.send("Runtime.evaluate", { expression: "Map.prototype", objectGroup: group });
    const { objects } = await cdp.send("Runtime.queryObjects", { prototypeObjectId: /** @type {string} */ (proto.objectId), objectGroup: group });
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: /** @type {string} */ (objects.objectId),
      functionDeclaration: "function (prefix) { return this.flatMap((m) => Array.from(m.keys()).filter((k) => typeof k === 'string' && k.startsWith(prefix))).sort(); }",
      arguments: [{ value: prefix }],
      returnByValue: true,
    });
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group });
    return /** @type {string[]} */ (result.value);
  };
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => (release = () => resolve(undefined)));
  const heldUrl = `${home}?scope=held`;
  await page.route(heldUrl, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  const coalesceUrl = `${home}?scope=coalesce`;
  await page.route(coalesceUrl, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.route(home, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await held;
    await route.fulfill({ status: 204 }).catch(() => {});
  });
  const heldSent = page.waitForRequest((r) => r.url() === heldUrl, { timeout: 5000 }).then(() => true, () => false);
  const coalesceSent = page.waitForRequest((r) => r.url() === coalesceUrl, { timeout: 5000 }).then(() => true, () => false);
  const writeSent = page.waitForRequest((r) => r.url() === home && r.method() === "POST", { timeout: 5000 }).then(() => true, () => false);
  const readAfterWrite = page.waitForResponse((r) => r.url() === `${home}?scope=w`, { timeout: 10000 }).then(() => true, () => false);
  await page.evaluate(
    ({ prefix, action }) => {
      const add = (/** @type {string} */ id, /** @type {string} */ scope, /** @type {boolean} */ marked) => {
        const form = document.createElement("form");
        form.id = id;
        form.action = action;
        form.dataset.patch = "";
        if (marked) form.dataset.address = "";
        const field = document.createElement("input");
        field.type = "hidden";
        field.name = "scope";
        field.value = scope;
        form.append(field);
        document.body.append(form);
        return form;
      };
      const forms = Array.from({ length: 40 }, (_, i) => add(`${prefix}${i}`, "all", i % 4 === 0));
      forms.push(add(`${prefix}held`, "held", false));
      Object.assign(window, { __kept: forms });
      for (const form of forms) form.requestSubmit();
      const throws = add(`${prefix}throws`, "throws", false);
      const taken = document.createElement("button");
      throws.append(taken);
      throws.addEventListener("submit", (event) => /** @type {SubmitEvent} */ (event).submitter?.remove());
      throws.requestSubmit(taken);
      const write = add(`${prefix}write-a`, "w", false);
      write.method = "post";
      const read = document.createElement("button");
      read.formMethod = "get";
      write.append(read);
      write.requestSubmit();
      write.id = `${prefix}write-b`;
      write.requestSubmit(read);
      write.id = `${prefix}write-c`;
      write.requestSubmit(read);
      const coalesced = add(`${prefix}read-a`, "coalesce", false);
      coalesced.requestSubmit();
      coalesced.id = `${prefix}read-b`;
      coalesced.requestSubmit();
      coalesced.id = `${prefix}read-c`;
      coalesced.requestSubmit();
      Object.assign(window, { __later: [write, coalesced] });
    },
    { prefix, action: home },
  );
  const sent = (await heldSent) && (await coalesceSent) && (await writeSent);
  const drawn = await page
    .waitForFunction(() => /** @type {HTMLFormElement[]} */ (/** @type {any} */ (window).__kept).slice(0, -1).every((f) => !f.hasAttribute("aria-busy")), undefined, { timeout: 10000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  const during = await kept();
  release();
  const answered = await readAfterWrite;
  const done = await page
    .waitForFunction(() => !(/** @type {HTMLFormElement[]} */ ([...(/** @type {any} */ (window).__kept), ...(/** @type {any} */ (window).__later)]).some((f) => f.hasAttribute("aria-busy"))), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)))));
  const after = await kept();
  await page.unroute(heldUrl);
  await page.unroute(coalesceUrl);
  await page.unroute(home);
  await cdp.detach();
  await page.close();
  return { drawn: sent && drawn, during, done: answered && done, after };
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

/**
 * Pushes an entry of the page at the address it is at, with a null state, as a script can, then
 * presses Week, held, and goes Back to the entry before, which has the same address and state;
 * then lets Week's answer come. Says whether Week was sent, whether Back fired `popstate`, whether
 * the submit ended, and where the page is and what it shows then.
 * @param {import("@playwright/test").Page} page
 */
async function sameAddressBack(page) {
  const week = `${base}/smoke/address?scope=week`;
  await page.goto(`${base}/smoke/address`);
  await page.evaluate(() => history.pushState(null, "", location.href));
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
  const popped = await page.evaluate(
    () =>
      new Promise((resolve) => {
        addEventListener("popstate", () => resolve(true), { once: true });
        history.back();
      }),
  );
  release();
  const done = await page
    .waitForFunction(() => !(/** @type {any} */ (window).__form.hasAttribute("aria-busy")), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  await page.unroute(week);
  const end = await page.evaluate(() => ({ at: location.search + location.hash, shown: document.querySelector("#smoke-address output")?.textContent }));
  return { out, popped, done, ...end };
}

/**
 * Pushes an entry of the page at the address it is at, with a null state, and goes Back to the
 * entry before, which has the same address and state, pressing Week from a `popstate` listener of
 * the page put on before the runtime's (by a script in the page before it). Says whether Back fired
 * `popstate`, how often Week was asked for, whether its answer drew, where the page is and what it
 * shows then, and whether the entry Back left is still ahead.
 * @param {import("@playwright/test").Page} page
 */
async function pressOnSameBack(page) {
  const week = `${base}/smoke/address?scope=week`;
  await page.addInitScript(() =>
    addEventListener("popstate", () => {
      const press = /** @type {any} */ (window).__pressOnSameBack;
      Object.assign(window, { __pressOnSameBack: undefined });
      press?.();
    }),
  );
  let reads = 0;
  await page.route(week, (route) => {
    if (route.request().headers()["corten"] === "action") reads += 1;
    return route.continue();
  });
  await page.goto(`${base}/smoke/address`);
  const length = await page.evaluate(() => (history.pushState(null, "", location.href), history.length));
  const popped = await page.evaluate(
    () =>
      new Promise((resolve) => {
        Object.assign(window, {
          __pressOnSameBack: () => {
            /** @type {HTMLButtonElement} */ (document.querySelector('#smoke-address-form button[value="week"]')).click();
            resolve(true);
          },
        });
        history.back();
      }),
  );
  const drawn = await page
    .waitForFunction(() => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"), undefined, { timeout: 5000 })
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  await page.unroute(week);
  const end = await page.evaluate((length) => ({ at: location.search + location.hash, shown: document.querySelector("#smoke-address output")?.textContent, ahead: history.length === length }), length);
  return { popped, reads, drawn, ...end };
}

/**
 * Presses Week once the entry holds a Navigation API state of the page's, with a listener of the
 * page that, as the runtime puts Week's address in, does as `how` says: "push" cancels the
 * runtime's replace (`navigate`) and pushes an entry to the same address in its place; "clear"
 * clears the state of the entry the replace made (`currententrychange`, `updateCurrentEntry`);
 * "precommit" puts a state in the entry before the replace commits (`navigate`); "early" puts a
 * state in the entry the replace made from a `currententrychange` listener put on before the
 * runtime's (by a script in the page before it); "pushread" is "precommit" with the entries'
 * `getState` wrapped so that a read of the replaced entry, once the screen's is another, pushes an
 * entry at the same address with a state of its own. Says whether the listener ran (and the entry
 * was pushed), whether Week's answer drew, where the page is, the entries added, and the states of
 * the screen's entry, of the entry before it and of the entry Week was pressed on. Null without the
 * Navigation API.
 * @param {import("@playwright/test").Browser} browser @param {"push" | "clear" | "precommit" | "early" | "pushread"} how @param {string[]} errors
 */
async function stateWrites(browser, how, errors) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`state writes ${how}: ${e.message}`));
  if (how === "early")
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window);
      w.navigation?.addEventListener("currententrychange", (/** @type {any} */ event) => {
        if (w.__wrote !== false || event.navigationType !== "replace" || new URL(location.href).search !== "?scope=week") return;
        w.__wrote = true;
        w.navigation.updateCurrentEntry({ state: "listener" });
      });
    });
  await page.goto(`${base}/smoke/address`);
  const first = await page.evaluate((how) => {
    const w = /** @type {any} */ (window);
    const nav = w.navigation;
    if (!nav) return null;
    nav.updateCurrentEntry({ state: { draft: "unsaved" } });
    Object.assign(window, { __wrote: false, __pressedOn: nav.currentEntry });
    const week = (/** @type {string} */ url) => new URL(url).search === "?scope=week";
    if (how === "pushread") {
      const proto = Object.getPrototypeOf(nav.currentEntry);
      const getState = proto.getState;
      proto.getState = function () {
        if (w.__wrote === true && w.__pushed === undefined && this === w.__pressedOn && nav.currentEntry !== this) {
          history.pushState(null, "", location.href);
          nav.updateCurrentEntry({ state: "pushed" });
          w.__pushed = nav.currentEntry !== this;
        }
        return getState.call(this);
      };
    }
    if (how === "early") return { length: history.length };
    if (how === "clear")
      nav.addEventListener("currententrychange", (/** @type {any} */ event) => {
        if (w.__wrote || event.navigationType !== "replace" || !week(location.href)) return;
        // Chromium refuses an undefined state (a required member).
        try {
          nav.updateCurrentEntry({ state: undefined });
          w.__wrote = true;
        } catch (/** @type {any} */ error) {
          w.__wrote = error.name;
        }
      });
    else
      nav.addEventListener("navigate", (/** @type {any} */ event) => {
        if (w.__wrote || event.navigationType !== "replace" || !week(event.destination.url)) return;
        w.__wrote = true;
        if (how !== "push") return void nav.updateCurrentEntry({ state: "listener" });
        event.preventDefault();
        history.pushState(null, "", event.destination.url);
      });
    return { length: history.length };
  }, how);
  if (!first) {
    await page.close();
    return null;
  }
  await page.getByRole("button", { name: "Week", exact: true }).evaluate((button) => /** @type {HTMLButtonElement} */ (button).click());
  const drawn = await page
    .waitForFunction(
      () => location.search === "?scope=week" && document.querySelector("#smoke-address output")?.textContent === "week" && !document.getElementById("smoke-address-form")?.hasAttribute("aria-busy"),
      undefined,
      { timeout: 5000 },
    )
    .then(() => true, () => false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve(undefined)), 200)));
  const end = await page.evaluate((first) => {
    const w = /** @type {any} */ (window);
    return {
      wrote: w.__wrote,
      at: location.search,
      added: history.length - first.length,
      pushed: w.__pushed,
      navState: JSON.stringify(w.navigation.currentEntry.getState() ?? null),
      made: JSON.stringify(w.navigation.entries()[w.navigation.currentEntry.index - 1]?.getState() ?? null),
      before: JSON.stringify(w.__pressedOn.getState() ?? null),
    };
  }, first);
  await page.close();
  return { drawn, ...end };
}
