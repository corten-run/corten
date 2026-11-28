import { readFile } from "node:fs/promises";
import { check, pollFor, skip } from "./helpers.mjs";

/** A waiting press belongs to the page where it was made, not whichever form has its id later. */
export async function queuedPage(/** @type {import("@playwright/test").Browser} */ browser, report = check) {
  const origin = "http://127.0.0.1";
  const runtime = await readFile(new URL("../../crates/corten/js/dist/corten.js", import.meta.url));
  const form = (/** @type {string} */ side, value = side) => `<form id="save" data-patch method="post" action="/save-${side}"><input name="n" value="${value}"><button>Save</button></form>`;
  const original = "POST /save-home n=home";
  const retry = "POST /save-home n=home2";
  const destination = "POST /save-dest n=dest";
  const cases = [
    { move: "link", visits: "nav /dest", away: true },
    { move: "query", visits: "nav /home?view=other", away: true },
    { move: "back", visits: "nav /dest", away: true },
    { move: "forward", visits: "nav /dest", away: true },
    { move: "round trip", visits: "nav /dest, nav /home", away: true },
    { move: "server redirect", visits: "nav /redirect, nav /dest", away: true },
    { move: "write redirect", visits: "action /go, page /dest", away: true },
    { move: "visit draws before write answers", visits: "nav /dest", away: true, overlap: true },
    { move: "press on the new page", visits: "nav /dest", retry: true, overlap: true, layout: true },
    { move: "press as main connects", visits: "nav /dest", connect: "main" },
    { move: "press as a layout part connects", visits: "nav /dest", connect: "part" },
    { move: "press as a whole page connects", visits: "action /go, page /dest", connect: "whole" },
    ...["partial", "whole"].flatMap((swap) => ["outgoing", "outgoing shared action", "outgoing failure", "retained"].map((mixed) => ({
      move: `${swap} swap presses the ${mixed} form`, visits: swap === "partial" ? "nav /dest" : "action /go, page /dest", swap, mixed,
    }))),
    { move: "same-address visit", visits: "nav /redirect, nav /home", retry: true, redraw: true },
    { move: "patch", retry: true, redraw: true },
    { move: "fragment", retry: true },
    { move: "cancelled visit", retry: true },
    { move: "pagehide" },
  ];
  for (const test of cases) {
    const { move, away } = test;
    const name = `a waiting submit stays on its page: ${move}`;
    const p = await browser.newPage();
    /** @type {string[]} */
    const posts = [];
    /** @type {string[]} */
    const visits = [];
    let answerFirst = () => {};
    const hold = new Promise((resolve) => (answerFirst = () => resolve(undefined)));
    let releaseVisit = () => {};
    const holdVisit = new Promise((resolve) => (releaseVisit = () => resolve(undefined)));
    try {
      await p.route(`${origin}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/runtime.js") return route.fulfill({ contentType: "text/javascript", body: runtime });
        const mode = request.headers().corten;
        if (url.pathname === "/go") {
          visits.push(`${mode} ${url.pathname}`);
          return route.fulfill({ status: 204, headers: { "corten-location": "/dest" } });
        }
        if (request.method() === "POST") {
          if (!["/save-home", "/save-dest"].includes(url.pathname)) throw new Error("unexpected fixture POST");
          posts.push(`${request.method()} ${url.pathname} ${request.postData()}`);
          if (posts.length === 1) {
            await hold;
            if (test.mixed === "outgoing failure") return route.fulfill({ status: 409 });
            if (move === "patch") return route.fulfill({ contentType: "text/html", headers: { "corten-patch": "1" }, body: form("home", "home2") });
          }
          return route.fulfill({ status: 204 });
        }
        if (mode) visits.push(`${mode} ${url.pathname}${url.search}`);
        if (test.overlap && mode === "nav" && url.pathname === "/dest") await holdVisit;
        if (url.pathname === "/redirect") return route.fulfill({ status: 204, headers: { "corten-location": move === "same-address visit" ? "/home" : "/dest" } });
        const side = url.pathname === "/dest" || url.search ? "dest" : "home";
        const value = mode && move === "same-address visit" ? "home2" : side;
        const shared = test.mixed === "outgoing failure" || test.mixed === "outgoing shared action";
        const save = test.connect && side === "dest" ? `<press-twice>${form(side, "B1")}</press-twice>` : form(shared ? "home" : side, value);
        const callback = side === "dest" ? "<press-twice></press-twice>" : "";
        // Partial: the part connects before main is replaced. Whole: main connects before the
        // changed layout sibling is replaced. An unchanged sibling keeps the original form.
        const part = test.swap === "partial" ? `<aside data-corten-page id="panel">${callback}</aside>` : test.connect === "part" ? `<aside data-corten-page id="panel">${save}</aside>` : "";
        const outside = test.layout || test.mixed === "retained" ? form("home") : test.swap === "whole" ? save : "";
        const inside = test.swap === "whole" ? callback : outside || test.connect === "part" ? "" : save;
        const body = `<h1>${side}</h1>${inside}<a id="home" href="/home">Home</a><a id="dest" href="/dest">Destination</a><a id="query" href="/home?view=other">Other view</a><a id="redirect" href="/redirect">Redirect</a><a id="fragment" href="#save">Fragment</a><form id="go" data-patch method="post" action="/go"><button>Go</button></form>`;
        const document = `<!doctype html><title>Submit queue fixture</title><meta name="corten-shell" content="fixture"><script type="module" src="/runtime.js"></script>${outside}${part}<main>${body}</main>`;
        return route.fulfill({
          contentType: "text/html",
          headers: mode === "page" ? { "corten-shell": "fixture" } : mode ? { "corten-page": "1" } : {},
          body: mode === "nav" ? part + body : document,
        });
      });
      const click = (/** @type {string} */ selector) => p.evaluate((s) => /** @type {HTMLElement} */ (document.querySelector(s)).click(), selector);
      const drawn = (/** @type {string} */ side) => p.waitForFunction((side) => document.querySelector("main h1")?.textContent === side, side, { timeout: 6000 });
      const traverse = (/** @type {"back" | "forward"} */ way) => p.evaluate((way) => window.navigation[way]().finished.then(() => {}), way);
      await p.goto(`${origin}/${move === "back" ? "dest" : "home"}`);
      if (!(await p.evaluate(() => "navigation" in window))) {
        skip("waiting submits across visits", "no Navigation API");
        return;
      }
      if (move === "back") {
        await click("#home");
        await drawn("home");
      } else if (move === "forward") {
        await click("#dest");
        await drawn("dest");
        await traverse("back");
        await drawn("home");
      }
      visits.length = 0;

      // Start the visit first, so it cannot abort the write at admission. Release its draw
      // on either side of the waiting press, before giving the write its response.
      if (test.overlap) {
        await Promise.all([p.waitForRequest((r) => r.headers().corten === "nav" && new URL(r.url()).pathname === "/dest", { timeout: 6000 }), click("#dest")]);
      }
      await p.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.presses = 0;
        document.addEventListener("submit", (e) => e.target === document.getElementById("save") && (w.presses += 1), { capture: true });
        const later = window.setTimeout;
        const fetch = window.fetch;
        /** @type {Promise<Response>[]} */
        const writes = [];
        window.fetch = (url, init) => {
          const request = fetch(url, init);
          if (init?.method === "POST") writes.push(request);
          return request;
        };
        // A bare response or simple patch, with nothing else scheduled: hold the queue's task.
        // After it runs, join every POST fetch it started before checking the route's records.
        window.setTimeout = (fn, delay, ...args) => {
          if (typeof fn !== "function" || delay !== undefined) return later(fn, delay, ...args);
          window.setTimeout = later;
          w.releaseRetry = async () => {
            fn(...args);
            await Promise.all(writes);
          };
          return 0;
        };
        w.formBefore = document.getElementById("save");
      });
      if (test.mixed) {
        await p.evaluate(() => {
          const w = /** @type {any} */ (window);
          document.addEventListener("corten:error", (e) => {
            w.errorAt = [e.detail.status, e.target === document ? "document" : e.target === document.getElementById("save") ? "current form" : "other"];
          });
          customElements.define("press-twice", class extends HTMLElement {
            connectedCallback() {
              const form = document.getElementById("save");
              w.pressedOriginal = form === w.formBefore && form.isConnected;
              form.requestSubmit();
              form.elements.n.value = "home2";
              form.requestSubmit();
            }
          });
        });
        await Promise.all([p.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/save-home", { timeout: 6000 }), click(test.swap === "whole" ? "#go button" : "#dest")]);
        await drawn("dest");
        answerFirst();
        const failed = test.mixed === "outgoing failure", retained = test.mixed === "retained";
        if (failed) await p.waitForFunction(() => window.errorAt, undefined, { timeout: 6000 });
        else {
          await p.waitForFunction(() => typeof window.releaseRetry === "function", undefined, { timeout: 6000 });
          await p.evaluate(() => window.releaseRetry());
        }
        const state = await p.evaluate(() => {
          const w = /** @type {any} */ (window), form = document.getElementById("save");
          return [w.pressedOriginal, w.presses, form === w.formBefore, location.pathname, form.getAttribute("action"), w.errorAt ?? null];
        });
        const expected = [true, 2, retained, "/dest", test.mixed === "outgoing" ? "/save-dest" : "/save-home", failed ? [409, "document"] : null];
        report(name, JSON.stringify(state) === JSON.stringify(expected) && visits.join(", ") === test.visits &&
          posts.join(", ") === (retained ? `${original}, ${retry}` : original), `state: ${JSON.stringify(state)}; visits: ${visits.join(", ")}; posts: ${posts.join(", ")}`);
        continue;
      }
      if (test.connect) {
        await p.evaluate(() => customElements.define("press-twice", class extends HTMLElement {
          connectedCallback() {
            const form = this.querySelector("form");
            form.requestSubmit();
            form.elements.n.value = "B2";
            form.requestSubmit();
          }
        }));
        await Promise.all([p.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/save-dest", { timeout: 6000 }), click(test.connect === "whole" ? "#go button" : "#dest")]);
        answerFirst();
        await p.waitForFunction(() => typeof window.releaseRetry === "function", undefined, { timeout: 6000 });
        const before = posts.join(", ");
        const presses = await p.evaluate(async () => { await window.releaseRetry(); return window.presses; });
        report(name, before === "POST /save-dest n=B1" && posts.join(", ") === `${before}, POST /save-dest n=B2` && presses === 2 && visits.join(", ") === test.visits,
          `before: ${before}; after retry: ${posts.join(", ")}; visits: ${visits.join(", ")}; presses: ${presses}`);
        continue;
      }
      await Promise.all([p.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/save-home", { timeout: 6000 }), click("#save button")]);
      if (test.layout) {
        releaseVisit();
        await drawn("dest");
      }
      await p.evaluate(() => {
        document.querySelector("#save input").value = "home2";
        document.querySelector("#save button").click();
      });
      if (test.overlap && !test.layout) {
        releaseVisit();
        await drawn("dest");
      }
      answerFirst();
      await p.waitForFunction(() => typeof window.releaseRetry === "function", undefined, { timeout: 6000 });
      const before = posts.join(", ");

      if (move === "link" || move === "round trip") await click("#dest");
      else if (move === "query") await click("#query");
      else if (move === "back" || move === "forward") await traverse(move);
      else if (move === "server redirect" || move === "same-address visit") await click("#redirect");
      else if (move === "write redirect") await click("#go button");
      else if (move === "fragment") {
        await click("#fragment");
        await p.waitForURL("**/home#save", { timeout: 6000 });
      } else if (move === "cancelled visit") {
        await p.evaluate(() => {
          window.navigation.addEventListener("navigate", (e) => e.preventDefault(), { once: true });
          const { committed, finished } = window.navigation.navigate("/dest");
          return Promise.allSettled([committed, finished]).then((results) => {
            if (!results.every((r) => r.status === "rejected")) throw new Error("fixture visit was not cancelled");
          });
        });
      } else if (move === "pagehide") await p.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
      if (away) await drawn("dest");
      if (test.redraw) await p.waitForFunction(() => window.formBefore !== document.getElementById("save"), undefined, { timeout: 6000 });
      if (move === "round trip") {
        await traverse("back");
        await drawn("home");
      }
      const state = await p.evaluate(async () => {
        const w = /** @type {any} */ (window);
        const form = document.getElementById("save");
        await w.releaseRetry();
        return { presses: w.presses, replaced: w.formBefore !== form };
      });
      const replayed = posts.join(", ");
      // A fresh press on the destination proves its form really can send; its POST is not the retry.
      const freshPress = away && move !== "round trip";
      if (freshPress) {
        await p.waitForFunction(() => !document.getElementById("save")?.hasAttribute("aria-busy"), undefined, { timeout: 6000 });
        await Promise.all([p.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/save-dest", { timeout: 6000 }), click("#save button")]);
      }
      const expected = test.retry ? `${original}, ${retry}` : original;
      report(
        name,
        before === original &&
          replayed === expected &&
          state.presses === 2 &&
          state.replaced === Boolean(away || test.redraw) &&
          visits.join(", ") === (test.visits ?? "") &&
          posts.join(", ") === (freshPress ? `${expected}, ${destination}` : expected),
        `before: ${before}; after retry: ${replayed}; final: ${posts.join(", ")}; visits: ${visits.join(", ") || "none"}; presses: ${state.presses}; replaced: ${state.replaced}`,
      );
    } finally {
      answerFirst();
      releaseVisit();
      await p.close();
    }
  }
}

export async function submitQueue(holdWatch, page, abandoned, errors, zero) {
  // The cases below press their buttons in the page (`button.click()`), so each submit has run
  // before the case changes the form, presses again or releases a held answer, and they count the
  // submits, so a press meant to send nothing is seen to have been made. A loaded Firefox can
  // acknowledge Playwright's click before the page gets it; in a reproduction the page had moved
  // by then and the press landed on another element (#2014).
  const press = (/** @type {string} */ selector) => page.evaluate((selector) => /** @type {HTMLButtonElement} */ (document.querySelector(selector)).click(), selector);
  /**
   * Presses `selector` in the page and waits at most 6 s for the request `sent` matches. The wait
   * is armed before the press and joined with it, so neither can fail unheard.
   * @param {string} selector @param {(r: import("@playwright/test").Request) => boolean} sent
   */
  const pressFor = async (selector, sent) => (await Promise.all([page.waitForRequest(sent, { timeout: 6000 }), press(selector)]))[0];
  /** Counts the submits of the form at `selector` from now on, read (and stopped) by `submits`. @param {string} selector */
  const countSubmits = (selector) =>
    page.evaluate((selector) => {
      const w = /** @type {any} */ (window);
      w.__submitCount?.abort();
      w.__submitCount = new AbortController();
      w.__submits = 0;
      // On the window, capturing, so it hears the submit before any listener of the page's.
      window.addEventListener("submit", (e) => e.target === document.querySelector(selector) && (w.__submits += 1), { capture: true, signal: w.__submitCount.signal });
    }, selector);
  const submits = () =>
    page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__submitCount?.abort();
      return /** @type {number} */ (w.__submits);
    });
  /** Stops `countSubmits`'s and `queueCase`'s listeners in the page, for a case that ended before it read them. */
  const stopCounting = () =>
    page
      .evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__submitCount?.abort();
        w.__queueCase?.abort();
      })
      .catch(() => {});
  /** A request's fields, from its address or its body. @param {import("@playwright/test").Request} request */
  const fieldsOf = (request) => (request.method() === "GET" ? new URL(request.url()).searchParams : new URLSearchParams(request.postData() ?? ""));
  // The latest submit wins, but a pending write is not abandoned (the server may have applied
  // it): the newer submit waits for its answer and goes out after it, from the form as the answer
  // left it. The first write's answer is held until every press has been made and the busy mark
  // read, so the newer presses meet it still out however slowly they come (#2014).
  /** @type {string[]} */
  const writes = [];
  /** @param {import("@playwright/test").Request} r */
  const onWrite = (r) => r.method() === "POST" && r.url().endsWith("/watch") && writes.push(`sent ${new URLSearchParams(r.postData() ?? "").get("id")}`);
  /** @param {import("@playwright/test").Response} r */
  const onAnswer = (r) => r.request().method() === "POST" && r.url().endsWith("/watch") && writes.push(`answered ${new URLSearchParams(r.request().postData() ?? "").get("id")}`);
  /** @type {string | null} */
  let busyWhileWriting = null;
  let watchPresses = 0;
  /** The outcome, read before the listeners go: whether the message came within 6 s, and the log then. */
  let watched = false;
  let written = "";
  // The listeners, the hold and the submit count go however the case ends, a press that throws
  // included.
  page.on("request", onWrite);
  page.on("response", onAnswer);
  try {
    let releaseWatch = () => {};
    holdWatch.value = new Promise((resolve) => (releaseWatch = () => resolve(undefined)));
    try {
      await page.selectOption("select[name=id]", "PNTR");
      await countSubmits("#watch-form");
      // The first is out before the form changes.
      await pressFor("#watch-form button", (r) => r.method() === "POST" && r.url().endsWith("/watch") && fieldsOf(r).get("id") === "PNTR");
      // The same press again sends nothing, and two newer ones are one submit of where the form ended.
      await press("#watch-form button");
      await page.selectOption("select[name=id]", "NRTH");
      await press("#watch-form button");
      await page.selectOption("select[name=id]", "VTGO");
      await press("#watch-form button");
      busyWhileWriting = await page.getAttribute("#watch-form", "aria-busy");
      watchPresses = await submits();
    } finally {
      holdWatch.value = null;
      releaseWatch();
    }
    watched = !!(await pollFor(6000, () => page.evaluate(() => !!document.getElementById("watch-message")?.textContent?.startsWith("Watching Vertigo Robotics"))));
    // Time in which a send the queue must not make would be seen.
    await page.waitForTimeout(300);
    written = writes.join();
  } finally {
    page.off("request", onWrite);
    page.off("response", onAnswer);
    await stopCounting();
  }
  check(
    "a newer submit waits for a pending write, which is answered, and then goes out",
    watched && busyWhileWriting === "true" && watchPresses === 4 && abandoned.length === 0 && written === "sent PNTR,answered PNTR,sent VTGO,answered VTGO",
    `${watched ? "" : "no Vertigo Robotics message within 6 s; "}${await page.textContent("#watch-message")}; busy: ${busyWhileWriting}; presses: ${watchPresses}; ${written}; abandoned: ${abandoned.join()}`,
  );
  check("the form is not left busy", (await page.getAttribute("#watch-form", "aria-busy")) === null);

  // The queue's other answers, against a form of the smoke's own whose answers it writes: each
  // case presses once, changes the field and presses again while the first is out.
  /** @type {{ status: number, headers?: Record<string, string>, body: string }} */
  let queueAnswer = { status: 200, body: "" };
  /** @type {string[]} */
  let queueSent = [];
  // Requests the route has answered or tried to (an aborted one's answer goes nowhere, and counts).
  let queueAnswered = 0;
  // The n of each request the page gave up on (an aborted read), which every engine reports as
  // failed even while the route holds it (net::ERR_ABORTED, NS_BINDING_ABORTED, Load request
  // cancelled); fulfilling it afterwards does not throw.
  /** @type {string[]} */
  let queueRefused = [];
  const queueGaveUp = (/** @type {import("@playwright/test").Request} */ request) => {
    if (new URL(request.url()).pathname !== "/queue") return;
    const n = fieldsOf(request).get("n") ?? "";
    if (!queueRefused.includes(n)) queueRefused.push(n);
  };
  // No answer goes before the case's second press is made, so that press meets the first submit
  // still out: the check is of the queue and not of two sends, however slow the press.
  /** @type {Promise<void>} */
  let queuePressed = Promise.resolve();
  // A case that reads the form between its two answers holds the second until it has.
  /** @type {Promise<void>} */
  let queueSecondHeld = Promise.resolve();
  // The route, the listener and the page's listeners go however the cases end, a press that
  // throws included.
  const queueLogged = errors.length;
  page.on("requestfailed", queueGaveUp);
  try {
    await page.route("**/queue*", async (route) => {
      const request = route.request();
      const fields = fieldsOf(request);
      const sent = queueSent.push(`${request.method()} ${fields.get("n")}${fields.has("submit") ? ` ${fields.get("submit")}` : ""}${fields.has("b") ? ` ${fields.get("b")}` : ""}`);
      const answer = queueAnswer;
      // The first of two reads answers last, so a read that was not aborted would draw over the newer.
      const late = request.method() === "GET" && fields.get("n") === "1";
      await queuePressed;
      if (sent === 2) await queueSecondHeld;
      await new Promise((resolve) => setTimeout(resolve, late ? 1200 : 400));
      const body = answer.body.replace("{n}", fields.get("n") ?? "");
      await route
        .fulfill({ status: answer.status, headers: { "content-type": "text/html; charset=utf-8", ...answer.headers }, body })
        .catch(() => {});
      queueAnswered += 1;
    });
    /** Whether a request is the queue form's, with `field` set to `value`. @param {string} field @param {string} value */
    const queueSends = (field, value) => (/** @type {import("@playwright/test").Request} */ r) => new URL(r.url()).pathname === "/queue" && fieldsOf(r).get(field) === value;
    /**
     * Puts the form (in a box a patch can redraw), presses, sets n to 2 and presses again, then
     * waits until `done` says the case's outcome is on the page (6 s at most, and `ended` is false)
     * and 700 ms more, in which a send the queue must not make would be seen. `status`: the case's
     * `corten:error`, or null, heard on the form too, so one sent to a form the answer took off the
     * page is not missed. `refused`: the n of each request the page gave up on. `presses`: the
     * submits the two presses made, so a second press that sends nothing is seen to have been made.
     * @param {string} form @param {() => Promise<boolean>} done
     */
    const queueCase = async (form, done) => {
      queueSent = [];
      queueAnswered = 0;
      queueRefused = [];
      /** @type {() => void} */
      let pressed = () => {};
      await page.evaluate((form) => {
        document.getElementById("queue-box")?.remove();
        document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<div id="queue-box">${form}<p id="queue-out"></p></div>`));
        // The case's corten:error, if it gets one; the listener goes with the case.
        const w = /** @type {any} */ (window);
        w.__queueCase?.abort();
        w.__queueCase = new AbortController();
        w.__queueError = null;
        const heard = (/** @type {Event} */ e) => (w.__queueError = /** @type {CustomEvent} */ (e).detail.status);
        document.addEventListener("corten:error", heard, { signal: w.__queueCase.signal });
        document.querySelector("#queue-box form")?.addEventListener("corten:error", heard, { signal: w.__queueCase.signal });
      }, form);
      // The first press must run before n changes, the second before pressed(), which the case
      // calls however it ends, so no answer stays held.
      /** @type {string | null} */
      let busy = null;
      let presses = 0;
      try {
        queuePressed = new Promise((resolve) => (pressed = resolve));
        await countSubmits("#queue-box form");
        await pressFor("#queue-box button", queueSends("n", "1"));
        await page.fill("#queue-box [name=n]", "2");
        busy = await page.getAttribute("#queue-box form", "aria-busy");
        await press("#queue-box button");
        presses = await submits();
      } finally {
        pressed();
      }
      // A `done` that comes true only after the 6 s is not ended.
      const ended = !!(await pollFor(6000, done));
      await page.waitForTimeout(700);
      const status = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__queueCase.abort();
        return /** @type {number | null} */ (w.__queueError);
      });
      return { sent: queueSent.join(), status, busy, ended, refused: queueRefused.join(), presses };
    };
    const queueOut = () => page.evaluate(() => document.getElementById("queue-out")?.textContent ?? null);
    const patchHeaders = { "corten-patch": "1" };
    const queueForm = (/** @type {string} */ method, /** @type {string} */ extra = "") =>
      `<form id="queue" method="${method}" action="/queue" data-patch><input name="n" value="1">${extra}<button>Go</button></form>`;

    // A newer GET aborts the older one, whose answer is worth nothing now: the first answers last,
    // and the page keeps the newer's.
    queueAnswer = { status: 200, headers: patchHeaders, body: '<p id="queue-out">read {n}</p>' };
    // Ended once the older's late answer was tried too, so it had its chance to draw.
    const read = await queueCase(queueForm("get"), async () => queueAnswered === 2 && (await queueOut()) === "read 2");
    check(
      "a newer GET submit aborts the older one",
      read.ended && read.presses === 2 && read.status === null && read.sent === "GET 1,GET 2" && read.refused === "1" && (await queueOut()) === "read 2",
      `${read.sent}; ${await queueOut()}; ended: ${read.ended}; presses: ${read.presses}; error: ${read.status}; refused: ${read.refused}`,
    );

    // An answer the runtime does not draw (a proxy's 503) drops the submit that waited.
    queueAnswer = { status: 503, body: "Service Unavailable" };
    const undrawn = await queueCase(queueForm("post"), async () => (await page.evaluate(() => /** @type {any} */ (window).__queueError)) !== null);
    check(
      "a submit that waited for an answer the runtime does not draw is not sent",
      undrawn.ended && undrawn.presses === 2 && undrawn.sent === "POST 1" && undrawn.status === 503,
      `${undrawn.sent}; ${undrawn.status}; ended: ${undrawn.ended}; presses: ${undrawn.presses}`,
    );

    // A 5xx patch is drawn, but the write may or may not have applied: the waiting submit drops.
    queueAnswer = { status: 500, headers: patchHeaders, body: '<p id="queue-out">failed</p>' };
    const failedPatch = await queueCase(queueForm("post"), async () => (await queueOut()) === "failed");
    check(
      "a submit that waited for a 5xx is not sent, and the 5xx's patch is drawn",
      failedPatch.ended && failedPatch.presses === 2 && failedPatch.status === null && failedPatch.sent === "POST 1" && (await queueOut()) === "failed",
      `${failedPatch.sent}; ${await queueOut()}; ended: ${failedPatch.ended}; presses: ${failedPatch.presses}; error: ${failedPatch.status}`,
    );

    // A refusal of the state the write was made against (Errors::refuse, 409) is drawn and drops
    // the waiting submit: the user reads it before anything else goes.
    queueAnswer = { status: 409, headers: patchHeaders, body: '<p id="queue-out">stale</p>' };
    const stale = await queueCase(queueForm("post"), async () => (await queueOut()) === "stale");
    check(
      "a submit that waited is not sent after a 409 refusal, which is drawn",
      stale.ended && stale.presses === 2 && stale.status === null && stale.sent === "POST 1" && (await queueOut()) === "stale",
      `${stale.sent}; ${await queueOut()}; ended: ${stale.ended}; presses: ${stale.presses}; error: ${stale.status}`,
    );

    // An answer that removes the form drops it.
    queueAnswer = { status: 200, headers: patchHeaders, body: '<template id="queue" data-remove></template>' };
    const removed = await queueCase(queueForm("post"), async () => (await page.$("#queue")) === null);
    check(
      "a submit that waited is not sent when the answer removes its form",
      removed.ended && removed.presses === 2 && removed.status === null && removed.sent === "POST 1" && (await page.$("#queue")) === null,
      `${removed.sent}; ended: ${removed.ended}; presses: ${removed.presses}; error: ${removed.status}`,
    );

    // A form without an id that the answer took off the page is not found again: its values are
    // the ones from before the answer.
    queueAnswer = { status: 200, headers: patchHeaders, body: '<div id="queue-box"><form method="post" action="/queue" data-patch><input name="n" value="1"><button>Go</button></form></div>' };
    // The answer's box has no #queue-out: drawn once it is gone.
    const noId = await queueCase('<form method="post" action="/queue" data-patch><input name="n" value="1"><button>Go</button></form>', async () => (await queueOut()) === null);
    check(
      "a submit that waited is not sent when its form without an id left the page",
      noId.ended && noId.presses === 2 && noId.status === null && noId.sent === "POST 1",
      `${noId.sent}; ended: ${noId.ended}; presses: ${noId.presses}; error: ${noId.status}`,
    );

    // The submit that waited goes under the form's new key: the write's answer renewed it.
    queueAnswer = { status: 200, headers: patchHeaders, body: '<p id="queue-out">saved {n}</p>' };
    // Ended once the waiting submit's own answer is drawn.
    const keyed = await queueCase(queueForm("post", `<input type="hidden" name="submit" data-submit value="${zero}">`), async () => (await queueOut()) === "saved 2");
    const [firstKey, secondKey] = keyed.sent.split(",").map((s) => s.split(" ")[2]);
    check(
      "a submit that waited goes out after the write's answer, under the key the answer renewed",
      keyed.ended && keyed.presses === 2 && keyed.status === null && keyed.busy === "true" && keyed.sent.split(",").length === 2 && keyed.sent.startsWith("POST 1 ") && keyed.sent.includes(",POST 2 ") && firstKey === zero && /^[0-9a-f-]{36}$/.test(secondKey ?? "") && secondKey !== zero,
      `${keyed.sent}; ended: ${keyed.ended}; presses: ${keyed.presses}; error: ${keyed.status}`,
    );

    // A 204 or 205 with none of Corten's headers took the write and has nothing to draw (RFC 9110,
    // 15.3.5 and 15.3.6; #1258): no corten:error, and the submit that waited goes, under the key the
    // answer renewed. A 205 resets the form only when nothing waits: the second submit goes with the
    // values it was pressed with, and its own 205 then resets the form, which has a new key after.
    // The placeholder key matches the UUID pattern, so each key is also held apart from it.
    const keyField = `<input type="hidden" name="submit" data-submit value="${zero}">`;
    const queueFields = () =>
      page.evaluate(() => ({
        n: /** @type {HTMLInputElement | null} */ (document.querySelector("#queue-box [name=n]"))?.value,
        key: /** @type {HTMLInputElement | null} */ (document.querySelector("#queue-box [name=submit]"))?.value,
      }));
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const status of [204, 205]) {
      queueAnswer = { status, body: "" };
      // Ended once the waiting submit's own answer is in and the form is no longer busy.
      const quiet = await queueCase(queueForm("post", keyField), async () => queueAnswered === 2 && (await page.getAttribute("#queue-box form", "aria-busy")) === null);
      const [first, second] = quiet.sent.split(",").map((s) => s.split(" ")[2]);
      const left = await queueFields();
      check(
        `a submit that waited for a bare ${status} goes out after it under a new key, with no corten:error${status === 205 ? ", and the last 205 resets the form" : ""}`,
        quiet.ended &&
          quiet.presses === 2 &&
          quiet.status === null &&
          quiet.busy === "true" &&
          quiet.sent.split(",").length === 2 &&
          quiet.sent.startsWith("POST 1 ") &&
          quiet.sent.includes(",POST 2 ") &&
          first === zero &&
          uuid.test(second ?? "") &&
          second !== zero &&
          left.n === (status === 205 ? "1" : "2") &&
          uuid.test(left.key ?? "") &&
          left.key !== zero &&
          left.key !== second,
        `${quiet.sent}; ended: ${quiet.ended}; presses: ${quiet.presses}; error: ${quiet.status}; left ${JSON.stringify(left)}`,
      );
    }
    // With nothing waiting, a 205 resets the form that sent it to the markup's values, and the form
    // has a new key after (the reset comes before the key is renewed, so this does not see the reset
    // leave a key alone: a hidden input's value is its attribute, which a reset keeps). A form the
    // user changed after it was sent keeps their work, as it does against a patch, and so does one a
    // control was added to: a hidden input too, which has no state of its own the reset could be
    // seen to change. So does another file of the same name chosen while the write is out (its size
    // differs), and text a number input cannot read, whose value is "" as an empty field's is. The
    // form has a control named reset, so `form.reset` is that control and the form's own method has
    // to be reached through its prototype.
    /** Sets the queue form's file to one named card.png, of `text`. @param {string} text */
    const pickQueueFile = (text) =>
      page.evaluate((text) => {
        const files = new DataTransfer();
        files.items.add(new File([text], "card.png", { type: "image/png", lastModified: 1 }));
        /** @type {HTMLInputElement} */ (document.querySelector("#queue-box [name=f]")).files = files.files;
      }, text);
    for (const change of ["none", "edited", "added", "hidden", "file", "unreadable"]) {
      queueSent = [];
      queueAnswered = 0;
      queueAnswer = { status: 205, body: "" };
      /** @type {() => void} */
      let pressed = () => {};
      await page.evaluate((form) => {
        document.getElementById("queue-box")?.remove();
        document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<div id="queue-box">${form}</div>`));
        const w = /** @type {any} */ (window);
        w.__queueCase?.abort();
        w.__queueCase = new AbortController();
        w.__queueError = null;
        document.addEventListener("corten:error", (e) => (w.__queueError = /** @type {CustomEvent} */ (e).detail.status), { signal: w.__queueCase.signal });
      }, queueForm("post", `${keyField}<input type="hidden" name="reset" value="x">${change === "file" ? '<input type="file" name="f">' : change === "unreadable" ? '<input type="number" name="q">' : ""}`));
      await page.fill("#queue-box [name=n]", "5");
      if (change === "file") await pickQueueFile("first");
      // The answer is held until the case has changed the form, and released however it ends.
      try {
        queuePressed = new Promise((resolve) => (pressed = resolve));
        await pressFor("#queue-box button", queueSends("n", "5"));
        if (change === "edited") await page.fill("#queue-box [name=n]", "6");
        if (change === "added") await page.evaluate(() => document.querySelector("#queue-box form")?.insertAdjacentHTML("beforeend", __html('<input name="extra">')));
        if (change === "hidden") await page.evaluate(() => document.querySelector("#queue-box form")?.insertAdjacentHTML("beforeend", __html('<input type="hidden" name="tag" value="a">')));
        if (change === "file") await pickQueueFile("another picture");
        if (change === "unreadable") {
          await page.focus("#queue-box [name=q]");
          await page.keyboard.type("1e");
        }
      } finally {
        pressed();
      }
      const ended = !!(await pollFor(6000, async () => queueAnswered === 1 && (await page.getAttribute("#queue-box form", "aria-busy")) === null));
      // Time for a corten:error to be heard, or a waiting submit to go.
      await page.waitForTimeout(300);
      const reset = await queueFields();
      // What the case says it changed is still there: the second file, and the number input's text.
      const other = await page.evaluate(() => ({
        file: /** @type {HTMLInputElement | null} */ (document.querySelector("#queue-box [name=f]"))?.files?.[0]?.size,
        bad: /** @type {HTMLInputElement | null} */ (document.querySelector("#queue-box [name=q]"))?.validity.badInput,
      }));
      const error = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__queueCase.abort();
        return /** @type {number | null} */ (w.__queueError);
      });
      /** @type {Record<string, string>} */
      const keeps = {
        edited: "a form the user changed after it was sent",
        added: "a form a control was added to after it was sent",
        hidden: "a form a hidden input was added to after it was sent",
        file: "a form whose file was swapped for another of the same name after it was sent",
        unreadable: "a form whose number input was given text it cannot read after it was sent",
      };
      check(
        change === "none" ? "a bare 205 with nothing waiting resets the form that sent it, gives it a new key, and dispatches no corten:error" : `a bare 205 keeps ${keeps[change]}, with no corten:error`,
        ended &&
          queueSent.length === 1 &&
          queueSent[0].startsWith("POST 5 ") &&
          error === null &&
          reset.n === (change === "none" ? "1" : change === "edited" ? "6" : "5") &&
          uuid.test(reset.key ?? "") &&
          reset.key !== zero &&
          (change !== "file" || other.file === "another picture".length) &&
          (change !== "unreadable" || other.bad === true),
        `${ended ? "" : "not answered and settled within 6 s; "}${queueSent.join()}; error: ${error}; left ${JSON.stringify({ ...reset, ...other })}`,
      );
    }
    // A press with other values while a write is out waits, and the write's 205 does not reset the
    // form under it: the waiting submit goes with what the user typed, and its own 205 then resets
    // the form. The second press is the form's other button, so the values differ only by the button
    // and nothing is typed between the presses: only the waiting submit keeps the first 205 from
    // resetting the form. The second answer is held until the form has been read with the waiting
    // submit out, so a reset by the first 205 after that submit's values were taken is seen too, and
    // the reset seen at the end is the second 205's.
    {
      queueSent = [];
      queueAnswered = 0;
      queueAnswer = { status: 205, body: "" };
      /** @type {() => void} */
      let pressed = () => {};
      await page.evaluate((form) => {
        document.getElementById("queue-box")?.remove();
        document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<div id="queue-box">${form}</div>`));
        const w = /** @type {any} */ (window);
        w.__queueCase?.abort();
        w.__queueCase = new AbortController();
        w.__queueError = null;
        document.addEventListener("corten:error", (e) => (w.__queueError = /** @type {CustomEvent} */ (e).detail.status), { signal: w.__queueCase.signal });
      }, `<form id="queue" method="post" action="/queue" data-patch><input name="n" value="1">${keyField}<button name="b" value="save">Save</button><button name="b" value="other">Other</button></form>`);
      await page.fill("#queue-box [name=n]", "5");
      /** @type {() => void} */
      let answerOther = () => {};
      /** The field once the waiting submit is out and before its answer, or why it was not read. */
      let whileOther = "";
      // The waiting submit is heard from before the presses, so it is not missed, but its six seconds
      // start only once the presses are made, as the first answer is let go: the first press's own
      // wait and the second press do not use them up. When it was heard decides, not which of it and
      // the timer is handled first: one heard after the six seconds fails the case.
      /** @type {(at: number) => void} */
      let heardOther = () => {};
      /** @type {Promise<number>} */
      const otherHeard = new Promise((resolve) => (heardOther = resolve));
      const onOther = (/** @type {import("@playwright/test").Request} */ r) => void (queueSends("b", "other")(r) && heardOther(performance.now()));
      page.on("request", onOther);
      try {
        queueSecondHeld = new Promise((resolve) => (answerOther = () => resolve(undefined)));
        /** @type {Promise<boolean>} */
        let otherSent = Promise.resolve(false);
        try {
          queuePressed = new Promise((resolve) => (pressed = resolve));
          await pressFor("#queue-box button[value=save]", queueSends("b", "save"));
          await press("#queue-box button[value=other]");
          /** @type {ReturnType<typeof setTimeout> | undefined} */
          let timer;
          const from = performance.now();
          otherSent = Promise.race([otherHeard.then((at) => at - from <= 6000), new Promise((resolve) => (timer = setTimeout(() => resolve(false), 6000)))]).finally(() => clearTimeout(timer));
        } finally {
          pressed();
        }
        whileOther = (await otherSent) ? ((await queueFields()).n ?? "no field") : "the other submit was not sent within 6 s of the first answer's release";
      } finally {
        page.off("request", onOther);
        answerOther();
        queueSecondHeld = Promise.resolve();
      }
      const ended = !!(await pollFor(6000, async () => queueAnswered === 2 && (await page.getAttribute("#queue-box form", "aria-busy")) === null));
      await page.waitForTimeout(300);
      const after = await queueFields();
      const error = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__queueCase.abort();
        return /** @type {number | null} */ (w.__queueError);
      });
      const [one, two] = queueSent;
      check(
        "a 205 does not reset a form pressed again with other values while it was out: the waiting submit goes with the typed value, and its own 205 resets the form",
        ended &&
          queueSent.length === 2 &&
          (one ?? "").startsWith(`POST 5 ${zero} `) &&
          (one ?? "").endsWith(" save") &&
          (two ?? "").startsWith("POST 5 ") &&
          (two ?? "").endsWith(" other") &&
          !(two ?? "").includes(zero) &&
          error === null &&
          whileOther === "5" &&
          after.n === "1",
        `${ended ? "" : "not answered and settled within 6 s; "}${queueSent.join()}; error: ${error}; n while the other was out: ${whileOther}; left ${JSON.stringify(after)}`,
      );
    }
  } finally {
    queuePressed = Promise.resolve();
    queueSecondHeld = Promise.resolve();
    page.off("requestfailed", queueGaveUp);
    await stopCounting();
    await page.unroute("**/queue*");
  }
  await page.evaluate(() => document.getElementById("queue-box")?.remove());
  // The browser logs the 503, 500 and 409 the smoke answered; nothing else is expected.
  errors.splice(queueLogged, errors.length, ...errors.slice(queueLogged).filter((e) => !/Failed to load resource/.test(e)));

  // A file is in a pending submit's key by its size and time as well as its name, so another file
  // of the same name, chosen while a write sending the first is out, is a new submit: it goes once
  // the write's answer is drawn. The same press again with the same file sends nothing (#1229).
  // Each write's answer is held until the second press is made, so that press meets it still out.
  // The files are made in the page, so each part of the key is told apart: another size at the
  // same time, and the same size at another time.
  let fileSends = 0;
  /** @type {Promise<void>} */
  let filePressed = Promise.resolve();
  await page.route("**/queue-file", async (route) => {
    const n = (fileSends += 1);
    await filePressed;
    await route
      .fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body: `<p id="queue-file-out">saved ${n}</p>` })
      .catch(() => {});
  });
  /** Sets the form's file to one named card.png, of `text`, last modified at `time`. @param {[string, number]} file */
  const pickFile = (file) =>
    page.evaluate(([text, time]) => {
      const files = new DataTransfer();
      files.items.add(new File([text], "card.png", { type: "image/png", lastModified: time }));
      /** @type {HTMLInputElement} */ (document.querySelector("#queue-file [name=f]")).files = files.files;
    }, file);
  /**
   * Presses with a file, then again with `second` chosen (or the same file), and counts the sends
   * and the submits the two presses made. @param {[string, number] | null} second
   */
  const fileCase = async (second) => {
    fileSends = 0;
    /** @type {() => void} */
    let pressed = () => {};
    await page.evaluate(() => {
      document.getElementById("queue-file-box")?.remove();
      document
        .querySelector("main")
        ?.insertAdjacentHTML(
          "beforeend",
          __html('<div id="queue-file-box"><form id="queue-file" method="post" action="/queue-file" enctype="multipart/form-data" data-patch><input type="file" name="f"><button>Send</button></form><p id="queue-file-out"></p></div>'),
        );
    });
    await pickFile(["first", 1]);
    // As in queueCase, the submit must run before changing the file or releasing its answer.
    /** @type {string | null} */
    let busy = null;
    let presses = 0;
    try {
      filePressed = new Promise((resolve) => (pressed = resolve));
      await countSubmits("#queue-file");
      await pressFor("#queue-file button", (r) => new URL(r.url()).pathname === "/queue-file" && r.method() === "POST");
      if (second) await pickFile(second);
      busy = await page.getAttribute("#queue-file", "aria-busy");
      await press("#queue-file button");
      presses = await submits();
    } finally {
      pressed();
    }
    const want = second ? "saved 2" : "saved 1";
    // Polled on a timer, as a loaded browser may not be delivering animation frames; a match after
    // the 6 s is not ended.
    const ended = !!(await pollFor(6000, () => page.evaluate((want) => document.getElementById("queue-file-out")?.textContent === want, want)));
    // Time in which a send the queue must not make would be seen.
    await page.waitForTimeout(700);
    const out = await page.evaluate(() => document.getElementById("queue-file-out")?.textContent ?? null);
    return { sends: fileSends, busy, ended, out, presses };
  };
  /** @type {Awaited<ReturnType<typeof fileCase>>[]} */
  let fileCases = [];
  // The route and the page's submit count go however the cases end.
  try {
    for (const second of /** @type {([string, number] | null)[]} */ ([null, ["another picture", 1], ["secnd", 2]])) fileCases.push(await fileCase(second));
  } finally {
    filePressed = Promise.resolve();
    await stopCounting();
    await page.unroute("**/queue-file");
  }
  const [sameFile, otherSize, otherTime] = fileCases;
  await page.evaluate(() => document.getElementById("queue-file-box")?.remove());
  check(
    "another file of the same name pressed while a write sending one is out is sent after it, whether its size or its time differs; the same file pressed again is not",
    [sameFile, otherSize, otherTime].every((c) => c.busy === "true" && c.ended && c.presses === 2) && sameFile.sends === 1 && otherSize.sends === 2 && otherTime.sends === 2,
    `same file: ${JSON.stringify(sameFile)}; another size: ${JSON.stringify(otherSize)}; another time: ${JSON.stringify(otherTime)}`,
  );
}
