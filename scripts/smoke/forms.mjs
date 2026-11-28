import http from "node:http";
import { base, shadowing, engine, skip, check, steps, pollFor, cleanUp } from "./helpers.mjs";

/**
 * A named control must not turn a runtime walk into form -> control -> form. The timeout
 * lives outside the page: a renderer stuck in that loop cannot run its own timers.
 * @param {import("@playwright/test").Browser} browser
 */
export async function namedFormNavigation(browser) {
  for (const names of [["parentElement"], ["parentNode"], shadowing]) {
    const label = names.length === 1 ? `a control named ${names[0]}` : "controls named after DOM members";
    const page = await browser.newPage();
    let timer;
    try {
      await page.goto(base);
      const patched = await Promise.race([
        page.evaluate(async (names) => {
          const { patch, ready } = await import("corten");
          await ready;
          const controls = names.map((name) => `<input type="hidden" name="${name}">`).join("");
          document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<form id="named-form">${controls}<p id="named-output">Before</p></form>`));
          await patch(__html('<p id="named-output">After</p>'));
          await patch(__html(`<form id="named-form">${controls}<p id="named-output">Replaced</p></form>`));
          await patch(__html('<template id="named-form" data-append><span id="named-appended">Appended</span></template>'));
          await new Promise((done) => setTimeout(done, 0));
          return document.getElementById("named-output")?.textContent === "Replaced" && document.getElementById("named-appended")?.textContent === "Appended";
        }, names),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("tab did not answer within 6 s")), 6000))),
      ]);
      check(`patching a form with ${label} applies and leaves the tab responsive`, patched === true);
    } catch (error) {
      check(`patching a form with ${label} applies and leaves the tab responsive`, false, String(error));
    } finally {
      clearTimeout(timer);
      await page.context().close();
    }
  }
}

/**
 * The view classes #[component(view)] generates (`/smoke/views`, served as `corten/views`) whose
 * holes are two elements into a form, past a form, and a form's whole text, with controls outside
 * each form, joined to it by `form=`, named after the members the classes' paths read
 * (`firstElementChild`, `nextElementSibling`, `textContent`): each property reads, writes and
 * fills its element, never one of those controls.
 * @param {import("@playwright/test").Browser} browser
 */
export async function generatedFormViews(browser) {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/smoke/views`);
    const seen = await page.evaluate(async () => {
      const { FormNested, PastForm, FormText } = await import("corten/views");
      const own = Element.prototype;
      /** @param {string} id */
      const form = (id) => /** @type {Element} */ (document.getElementById(id));
      /** The text of the element `css` finds under `root`, read past any named control. @param {Element} root @param {string} css */
      const shown = (root, css) => Reflect.get(Node.prototype, "textContent", css ? own.querySelector.call(root, css) : root);
      /** @param {() => unknown} step */
      const run = (step) => {
        try {
          return String(step());
        } catch (error) {
          return String(error);
        }
      };
      const nestedForm = form("nested-form");
      const nested = new FormNested(nestedForm);
      const pastRoot = /** @type {Element} */ (form("past-form").parentElement);
      const past = new PastForm(pastRoot);
      const textForm = form("text-form");
      const whole = new FormText(textForm);
      const out = {
        nested: run(() => {
          const read = nested.label;
          nested.label = "Set";
          const set = shown(nestedForm, "span");
          FormNested.fill(nestedForm, { label: "Filled" });
          return `${read};${set};${shown(nestedForm, "span")}`;
        }),
        past: run(() => {
          const read = past.note;
          past.note = "Set";
          const set = shown(pastRoot, "p");
          PastForm.fill(pastRoot, { note: "Filled" });
          return `${read};${set};${shown(pastRoot, "p")}`;
        }),
        whole: run(() => {
          const read = whole.text;
          whole.text = "Set";
          const set = `${typeof whole.text}:${whole.text}:${shown(textForm, "")}`;
          FormText.fill(textForm, { text: "Filled" });
          return `${typeof read}:${read};${set};${shown(textForm, "")}`;
        }),
        // The controls each form's members would have been: none was written (a value, or text
        // put inside one).
        controls: Array.from(document.querySelectorAll("input[form]"), (input) => `${/** @type {HTMLInputElement} */ (input).value}/${input.childNodes.length}`).join(),
      };
      return out;
    });
    check("a generated view reads, writes and fills a hole two elements into a form with a control named firstElementChild", seen.nested === "Nested;Set;Filled", seen.nested);
    check("a generated view reads, writes and fills a hole past a form with a control named nextElementSibling", seen.past === "Past;Set;Filled", seen.past);
    check("a generated view reads, writes and fills a form's whole text with a control named textContent", seen.whole === "string:;string:Set:Set;Filled", seen.whole);
    check("a generated view's named form controls are left as they were", seen.controls === Array(9).fill("kept/0").join(), seen.controls);
  } finally {
    await page.context().close();
  }
}

export async function formFailures(page, failWatch, openFeeds) {
  // A submit the network fails: the form stays, and the page hears about it. The press runs in
  // the page, in the same task that starts listening for the form's own error and its six seconds,
  // so a press that never submits fails the check in 6 s from the press rather than waiting on the
  // stall watchdog, and another form's error does not count (#2014). The handler checks the time
  // itself: an error heard after the six seconds fails the check even if the timer has not run.
  const messageBefore = await page.textContent("#watch-message");
  /** @type {string} */
  let failedWith;
  // A press that sent nothing leaves the failure armed for the next post: it is disarmed however
  // the press ends.
  failWatch.value = true;
  try {
    failedWith = JSON.stringify(
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            const form = /** @type {HTMLFormElement} */ (document.getElementById("watch-form"));
            const stop = new AbortController();
            const from = performance.now();
            const late = setTimeout(() => (stop.abort(), resolve(null)), 6000);
            form.addEventListener(
              "corten:error",
              (e) => {
                clearTimeout(late);
                stop.abort();
                const after = performance.now() - from;
                resolve(after <= 6000 ? [/** @type {CustomEvent} */ (e).detail.status, e.cancelable] : `heard after ${Math.round(after)} ms`);
              },
              { signal: stop.signal },
            );
            /** @type {HTMLButtonElement} */ (form.querySelector("button")).click();
          }),
      ),
    );
  } finally {
    failWatch.value = false;
  }
  check("a submit the network fails dispatches corten:error with status 0, cancelable", failedWith === "[0,true]", failedWith);
  check(
    "a failed submit leaves the page and the form as they were",
    (await page.textContent("#watch-message")) === messageBefore && (await page.getAttribute("#watch-form", "aria-busy")) === null,
  );
  // The form's on:corten:error runs (the runtime's event, on the form): it says the change failed.
  const told = await page.waitForSelector("#watch-form [role=alert]", { state: "visible", timeout: 5000 }).then(() => true, () => false);
  check("a form's on:corten:error handler runs for a submit the network fails", told);
  // A form with controls named after the members the runtime reads on it (hasAttribute, closest,
  // querySelectorAll, isConnected and the rest of `shadowing`) still runs its handlers, as the
  // runtime reads them through Element's and Node's own: the form the page loaded with,
  // hearing an event that bubbles, and copies put in after load, bound to an event no element
  // listened for until they joined (so only the runtime's scan of them can hear it), one hearing
  // it bubble and one not.
  const shadowed = await page.evaluate(async (names) => {
    const inputs = names.map((name) => `<input type="hidden" name="${name}" value="x">`).join("");
    const form = /** @type {HTMLFormElement} */ (document.getElementById("watch-form"));
    const markup = form.outerHTML.replace(/^<form[^>]*>/, (open) => open + inputs);
    for (const n of [1, 2]) {
      const copy = markup
        .replace(/ id="([^"]+)"/g, (_, id) => ` id="smoke-${n}-${id}"`)
        .replace(/data-on="corten:error:([\w.]+)\(@(\w+)\)"/, (_, f, ref) => `data-on="smoke-shadowed-${n}:${f}(@${ref}) smoke-closest-${n}:${f}(^${ref})"`);
      document.querySelector("main")?.insertAdjacentHTML("beforeend", /** @type {any} */ (window).__html(copy));
    }
    form.insertAdjacentHTML("afterbegin", /** @type {any} */ (window).__html(inputs));
    // The copies' handlers are bound as they join the page, once the runtime hears they did.
    await new Promise((r) => setTimeout(r, 100));
    const heard = (/** @type {string} */ id, /** @type {string} */ type, /** @type {boolean} */ bubbles) => {
      const at = /** @type {Element} */ (document.getElementById(id));
      const note = /** @type {HTMLElement} */ (document.querySelector(`#${id} [role=alert]`));
      note.hidden = true;
      Element.prototype.dispatchEvent.call(at, new CustomEvent(type, { bubbles, cancelable: true, detail: { status: 0 } }));
      return !note.hidden;
    };
    // A handler on the form given the element the event came from (`^ref`), which it finds by
    // reading the form's own scope.
    // From the ref, it is found; from another element of the form, the runtime reads the form
    // on the way and finds none, so the handler is skipped and nothing is reported.
    const closest = () => {
      const note = /** @type {HTMLElement} */ (document.querySelector("#smoke-1-watch-form [role=alert]"));
      const heading = /** @type {HTMLElement} */ (document.querySelector("#smoke-1-watch-form h2"));
      let reported = 0;
      const report = () => (reported += 1);
      window.addEventListener("error", report);
      note.hidden = true;
      heading.dispatchEvent(new CustomEvent("smoke-closest-1", { bubbles: true }));
      const skipped = note.hidden && reported === 0;
      note.dispatchEvent(new CustomEvent("smoke-closest-1", { bubbles: true }));
      window.removeEventListener("error", report);
      return skipped && !note.hidden && reported === 0;
    };
    // One that leaves the page ends its life, so its on:connect runs again when it comes back:
    // the runtime reads whether it is still on the page past its control named isConnected.
    const comesBack = async () => {
      const made = document.createElement("template");
      made.innerHTML = /** @type {any} */ (window).__html(
        markup
          .replace(/ id="([^"]+)"/g, (_, id) => ` id="smoke-3-${id}"`)
          .replace(/data-on="corten:error:([\w.]+)\(@(\w+)\)"/, (_, f, ref) => `data-on="connect:${f}(@${ref})"`),
      );
      const form = /** @type {Element} */ (made.content.firstElementChild);
      const note = /** @type {HTMLElement} */ (Element.prototype.querySelector.call(form, "[role=alert]"));
      const main = /** @type {HTMLElement} */ (document.querySelector("main"));
      const settle = () => new Promise((r) => setTimeout(r, 100));
      note.hidden = true;
      main.append(form);
      await settle();
      const first = !note.hidden;
      note.hidden = true;
      Element.prototype.remove.call(form);
      await settle();
      main.append(form);
      await settle();
      const again = !note.hidden;
      Element.prototype.remove.call(form);
      return first && again;
    };
    try {
      return {
        loaded: heard("watch-form", "corten:error", true),
        added: heard("smoke-1-watch-form", "smoke-shadowed-1", true),
        notBubbling: heard("smoke-2-watch-form", "smoke-shadowed-2", false),
        closest: closest(),
        comesBack: await comesBack(),
      };
    } finally {
      for (const n of [1, 2]) {
        const copy = document.getElementById(`smoke-${n}-watch-form`);
        if (copy) Element.prototype.remove.call(copy);
      }
      for (const name of names) document.querySelector(`#watch-form > input[name="${name}"]`)?.remove();
    }
  }, shadowing);
  check(
    "a form with controls named after the members the runtime reads on it runs its handlers, loaded with the page or added after, for events that bubble or not, and on:connect again when it comes back",
    shadowed.loaded && shadowed.added && shadowed.notBubbling && shadowed.closest && shadowed.comesBack,
    JSON.stringify(shadowed),
  );
  // The rest of what the runtime does with such a form, each through Element's and Node's own: a
  // page-wide handler on it runs for an event anywhere, and not once it left the page; elements a
  // patch appends to it, more at once than the runtime wires one by one (it queries the form),
  // run their handlers; focus in it stays on the field's counterpart when a patch replaces it,
  // goes to the new form when that field is gone, and to the element around it when a patch
  // removes it.
  const ways = await page.evaluate(async (names) => {
    const { patch } = await import("corten");
    const w = /** @type {any} */ (window);
    const own = Element.prototype;
    const inputs = names.map((name) => `<input type="hidden" name="${name}" value="x">`).join("");
    const main = /** @type {HTMLElement} */ (document.querySelector("main"));
    const watch = /** @type {Element} */ (document.getElementById("watch-form"));
    const failed = /data-on="corten:error:([\w.]+)\(@(\w+)\)"/;
    const [, f, ref] = /** @type {RegExpMatchArray} */ (watch.outerHTML.match(failed));
    const on = `document.smoke-anywhere:${f}(@${ref})`;
    // The watch form with the controls, its ids its own and the page-wide handler for its own; with
    // a button first, which a copy `without` it lacks.
    const copy = (/** @type {boolean} */ button = true) =>
      watch.outerHTML
        .replace(/^<form[^>]*>/, (open) => open + (button ? '<button type="button">B</button>' : "") + inputs)
        .replace(/ id="([^"]+)"/g, (_, id) => ` id="smoke-4-${id}"`)
        .replace(failed, `data-on="${on}"`);
    const settle = () => new Promise((r) => setTimeout(r, 100));
    const form = () => /** @type {Element} */ (document.getElementById("smoke-4-watch-form"));
    const note = () => /** @type {HTMLElement} */ (document.querySelector("#smoke-4-watch-form [role=alert]"));
    const anywhere = () => {
      const shown = note();
      shown.hidden = true;
      document.body.dispatchEvent(new CustomEvent("smoke-anywhere", { bubbles: true }));
      return !shown.hidden;
    };
    const errors = /** @type {string[]} */ ([]);
    const report = (/** @type {ErrorEvent} */ e) => errors.push(String(e.message));
    window.addEventListener("error", report);
    try {
      main.insertAdjacentHTML("beforeend", w.__html(copy()));
      await settle();
      const heardAnywhere = anywhere();
      const many = Array.from({ length: 40 }, (_, i) => `<p id="smoke-many-${i}" data-on="smoke-many:${f}(@${ref})">${i}</p>`).join("");
      await patch(w.__html(`<template id="smoke-4-watch-form" data-append>${many}</template>`));
      await settle();
      note().hidden = true;
      /** @type {Element} */ (document.getElementById("smoke-many-39")).dispatchEvent(new CustomEvent("smoke-many", { bubbles: true }));
      const batch = !note().hidden && own.querySelectorAll.call(form(), "p[id^=smoke-many-]").length === 40;
      // Focus on its select (named id), then the form drawn again: focus is on the new one's.
      const first = form();
      /** @type {HTMLElement} */ (own.querySelector.call(first, "select")).focus();
      await patch(w.__html(copy()));
      const kept = form() !== first && document.activeElement instanceof HTMLSelectElement && Node.prototype.contains.call(form(), document.activeElement);
      // Focus on its first button, then the form drawn without it: focus goes to the new form.
      const second = form();
      /** @type {HTMLElement} */ (own.querySelector.call(second, "button")).focus();
      await patch(w.__html(copy(false)));
      const toForm = form() !== second && document.activeElement === form();
      // Focus on its select, then the form taken away: focus goes to <main> around it.
      const last = form();
      const lastNote = note();
      /** @type {HTMLElement} */ (own.querySelector.call(last, "select")).focus();
      await patch(w.__html('<template id="smoke-4-watch-form" data-remove></template>'));
      await settle();
      const removed = !document.getElementById("smoke-4-watch-form") && document.activeElement === main;
      // Gone from the page, its page-wide handler no longer runs.
      lastNote.hidden = true;
      document.body.dispatchEvent(new CustomEvent("smoke-anywhere", { bubbles: true }));
      const stopped = lastNote.hidden;
      return { heardAnywhere, batch, kept, toForm, removed, stopped, errors };
    } finally {
      window.removeEventListener("error", report);
      const left = document.getElementById("smoke-4-watch-form");
      if (left) own.remove.call(left);
    }
  }, shadowing);
  check(
    "a form with controls named after the members the runtime reads on it gets page-wide handlers and a batch appended to it, keeps focus through a patch, and gives it up when removed",
    ways.heardAnywhere && ways.batch && ways.kept && ways.toForm && ways.removed && ways.stopped && !ways.errors.length,
    JSON.stringify(ways),
  );
  // Its on:connect handler's `signal` aborts when it leaves the page, though the runtime reads
  // whether it is still there past its control named isConnected: the live prices drawn in such a
  // form open a feed stream of their own, which closes once the form is taken away.
  const feedsBefore = await openFeeds();
  await page.evaluate((names) => {
    const inputs = names.map((name) => `<input type="hidden" name="${name}" value="x">`).join("");
    const prices = /** @type {Element} */ (document.querySelector('[data-on*=".watch("]'));
    // Its rows' remove forms go: a form inside a form is not parsed as one.
    const life = prices.outerHTML
      .replace(/<form[\s\S]*?<\/form>/g, "")
      .replace(/ id="([^"]+)"/g, (_, id) => ` id="smoke-life-${id}"`)
      .replace(/^<div([^>]*)>/, (_, attrs) => `<form id="smoke-life"${attrs.replace(/ id="[^"]*"/, "")}>${inputs}`)
      .replace(/<\/div>$/, "</form>");
    document.querySelector("main")?.insertAdjacentHTML("beforeend", /** @type {any} */ (window).__html(life));
  }, shadowing);
  /** @param {number} n */
  const feedsAre = (n) =>
    page
      .waitForFunction((n) => (/** @type {any} */ (window)).__sources.filter((/** @type {EventSource} */ s) => s.url.includes("/feed/") && s.readyState !== EventSource.CLOSED).length === n, n, { timeout: 5000 })
      .then(() => true, () => false);
  const lifeOpened = await feedsAre(feedsBefore + 1);
  await page.evaluate(() => {
    const life = document.getElementById("smoke-life");
    if (life) Element.prototype.remove.call(life);
  });
  const lifeClosed = await feedsAre(feedsBefore);
  check("a form with controls named after the members the runtime reads on it ends its life when it leaves: its handler's signal aborts", lifeOpened && lifeClosed, JSON.stringify({ feedsBefore, lifeOpened, lifeClosed }));
}

export async function submitKeys(page, holdWatch, failWatch, errors, browser, bug, cut) {
  /**
   * Listens for the first `corten:error` the form at `selector` dispatches, from before its press.
   * `seen` waits at most 6 s from when it is called (once the press has returned, or the held
   * answer is let go) and gives its status, or null if none came within them, a late one included.
   * `stop` ends the listening, and goes in the case's `finally`, so a press that throws does not
   * leave it behind; `seen` stops it too.
   * @param {string} selector
   */
  const formError = async (selector) => {
    await page.evaluate((selector) => {
      const w = /** @type {any} */ (window);
      w.__formError?.stop.abort();
      const stop = new AbortController();
      w.__formError = { stop, status: undefined };
      document.querySelector(selector)?.addEventListener(
        "corten:error",
        (e) => {
          w.__formError.status = /** @type {CustomEvent} */ (e).detail.status;
          stop.abort();
        },
        { signal: stop.signal },
      );
    }, selector);
    const stop = () => page.evaluate(() => /** @type {any} */ (window).__formError?.stop.abort()).catch(() => {});
    return {
      stop,
      /** @returns {Promise<number | null>} */
      async seen() {
        try {
          // Polled on a timer: a loaded browser may not be delivering animation frames.
          return await pollFor(6000, () => page.evaluate(() => /** @type {number | undefined} */ (/** @type {any} */ (window).__formError.status)));
        } finally {
          await stop();
        }
      },
    };
  };
  // A newer submit that waited for a write the network failed is not sent: it would fail the
  // same way, and the user sends it again. The failed write is held until the newer press is
  // made, so that press meets it still out (a fixed delay let a loaded browser press after the
  // failure, #1149), and both presses run in the page, so the first is sent before the test
  // picks another stock. The form's submits are counted, so the newer press, which sends nothing,
  // is seen to have been made. The listeners, the hold and the press count go however it ends.
  let afterFailure = 0;
  /** @param {import("@playwright/test").Request} r */
  const isWrite = (r) => r.method() === "POST" && r.url().endsWith("/watch");
  /** @param {import("@playwright/test").Request} r */
  const onRetry = (r) => isWrite(r) && (afterFailure += 1);
  const pressWatch = () => page.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector("#watch-form button")).click());
  let watchWasSent = false;
  let watchPresses = 0;
  /** @type {number | null} */
  let watchFailed = null;
  let posts = 0;
  const failedAgain = await formError("#watch-form");
  page.on("request", onRetry);
  try {
    let releaseWatch = () => {};
    holdWatch.value = new Promise((resolve) => (releaseWatch = () => resolve(undefined)));
    failWatch.value = true;
    try {
      await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__failedPresses = 0;
        w.__failedPressCount = new AbortController();
        // Capturing on the window, so the submit is heard before any listener of the page's.
        window.addEventListener("submit", (e) => e.target === document.getElementById("watch-form") && (w.__failedPresses += 1), { capture: true, signal: w.__failedPressCount.signal });
      });
      // The wait is joined with the press, so neither can fail unheard.
      [watchWasSent] = await Promise.all([page.waitForRequest(isWrite, { timeout: 5000 }).then(() => true, () => false), pressWatch()]);
      // Another stock the form still offers, so the newer submit differs from the one it waits for.
      const other = await page.$eval("select[name=id]", (s) =>
        [.../** @type {HTMLSelectElement} */ (s).options].map((o) => o.value).find((v) => v && v !== /** @type {HTMLSelectElement} */ (s).value),
      );
      check("the form offers another stock to send", other !== undefined);
      if (other) await page.selectOption("select[name=id]", other);
      await pressWatch();
      watchPresses = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__failedPressCount.abort();
        return /** @type {number} */ (w.__failedPresses);
      });
    } finally {
      holdWatch.value = null;
      failWatch.value = false;
      releaseWatch();
    }
    // The failure's 6 s start once it is let go.
    watchFailed = await failedAgain.seen();
    // Time in which the waiting submit, which must not go, would be seen; none if the failure did not come.
    if (watchFailed !== null) await page.waitForTimeout(500);
    posts = afterFailure;
  } finally {
    page.off("request", onRetry);
    await failedAgain.stop();
    await page.evaluate(() => /** @type {any} */ (window).__failedPressCount?.abort()).catch(() => {});
  }
  check(
    "a submit that waited for a write the network failed is not sent",
    watchWasSent && watchPresses === 2 && watchFailed === 0 && posts === 1,
    `presses: ${watchPresses}; posts: ${posts}${watchWasSent ? "" : ", the first not sent in 5 s"}; error: ${watchFailed ?? "none within 6 s"}`,
  );

  // A submit key (SubmitKey::field) is sent again until the submission has an answer, then renewed
  // as another UUID v4. Its presses, and the template copies' below, run in the page: a loaded
  // Firefox can acknowledge Playwright's click before the page gets it, and in a reproduction the
  // page had moved the button from under the point clicked by then, so a retry was never sent
  // (#2014). Each failure waited for is the form's own, for 6 s at most from the press's return; a
  // case whose failure does not come in them fails and stops, without its retry.
  const press = (/** @type {string} */ selector) => page.evaluate((selector) => /** @type {HTMLButtonElement} */ (document.querySelector(selector)).click(), selector);
  const zero = "00000000-0000-4000-8000-000000000000";
  await page.evaluate((zero) =>
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      __html(`<form id="keyed" method="post" action="/watch" data-patch><input type="hidden" name="id" value="ACME"><input type="hidden" name="submit" data-submit value="${zero}"><button>Watch</button></form>`),
    ), zero);
  /** @type {(string | null)[]} */
  const keys = [];
  /** @param {import("@playwright/test").Request} r */
  const keyOf = (r) => r.method() === "POST" && r.url().endsWith("/watch") && keys.push(new URLSearchParams(r.postData() ?? "").get("submit"));
  /** @type {number | null} */
  let keyedStatus = null;
  let kept = "";
  /** The key once the retry is answered, within 5 s, or null. @type {string | null} */
  let renewed = null;
  let keysSent = "";
  const keyedFailed = await formError("#keyed");
  page.on("request", keyOf);
  try {
    failWatch.value = true;
    try {
      await press("#keyed button");
      keyedStatus = await keyedFailed.seen();
    } finally {
      failWatch.value = false;
    }
    if (keyedStatus !== null) {
      kept = await page.inputValue("#keyed [name=submit]");
      await press("#keyed button");
      renewed = await pollFor(5000, () =>
        page.evaluate((zero) => {
          const key = /** @type {HTMLInputElement | null} */ (document.querySelector("#keyed [name=submit]"))?.value;
          return key && key !== zero ? key : undefined;
        }, zero),
      );
    }
    keysSent = keys.join(", ");
  } finally {
    page.off("request", keyOf);
    await keyedFailed.stop();
  }
  check(
    "a submit key is sent again after a failed submit and renewed once the submit is answered",
    keyedStatus === 0 && kept === zero && keys.length === 2 && keys.every((k) => k === zero) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(renewed ?? "") && renewed !== zero,
    keyedStatus === null ? `no corten:error within 6 s of the press, so no retry was made; sent ${keysSent}` : `${keysSent} -> ${renewed ?? "not renewed within 5 s"}; error: ${keyedStatus}`,
  );
  await page.evaluate(() => document.querySelector("#keyed")?.remove());

  // A 5xx patch that draws the form again (Refusal::Upstream: the service may have applied the
  // write) cannot swap in the key it drew: the retry is the same submission.
  await page.evaluate((zero) =>
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      __html(`<form id="keyed" method="post" action="/watch-upstream" data-patch><input type="hidden" name="submit" data-submit value="${zero}"><button>Watch</button></form>`),
    ), zero);
  /** @type {(string | null)[]} */
  const upstreamKeys = [];
  let upstreamFails = true;
  await page.route("**/watch-upstream", (route) => {
    upstreamKeys.push(new URLSearchParams(route.request().postData() ?? "").get("submit"));
    const fail = upstreamFails;
    upstreamFails = false;
    const other = "11111111-1111-4111-8111-111111111111";
    return route.fulfill({
      status: fail ? 502 : 200,
      headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" },
      body: `<form id="keyed" method="post" action="/watch-upstream" data-patch><input type="hidden" name="submit" data-submit value="${other}"><p id="upstream-said">${fail ? "The carrier did not answer." : "Watching."}</p><button>Watch</button></form>`,
    });
  });
  const upstreamLogged = errors.length;
  /** Each answer's patch drawn within 5 s, and the key then. @type {string | null} */
  let afterUpstream = null;
  /** @type {string | null} */
  let afterAnswer = null;
  // Each answer is drawn within 5 s of its press; without the first, the retry is not made.
  const drawnThen = (/** @type {string} */ said) =>
    pollFor(5000, () =>
      page.evaluate(
        (said) => (document.querySelector("#upstream-said")?.textContent === said ? /** @type {HTMLInputElement} */ (document.querySelector("#keyed [name=submit]")).value : undefined),
        said,
      ),
    );
  try {
    await press("#keyed button");
    afterUpstream = await drawnThen("The carrier did not answer.");
    if (afterUpstream !== null) {
      await press("#keyed button");
      afterAnswer = await drawnThen("Watching.");
    }
  } finally {
    await page.unroute("**/watch-upstream");
  }
  check(
    "a 5xx patch keeps the form's submit key, and the retry sends it",
    afterUpstream === zero && upstreamKeys.length === 2 && upstreamKeys.every((k) => k === zero) && afterAnswer !== null && afterAnswer !== zero && afterAnswer !== "11111111-1111-4111-8111-111111111111",
    `${upstreamKeys.join(", ")}: after 502 ${afterUpstream ?? "not drawn within 5 s, so no retry was made"}, after 200 ${afterAnswer ?? "not drawn within 5 s"}`,
  );
  await page.evaluate(() => document.querySelector("#keyed")?.remove());
  // The browser logs the 502.
  errors.splice(upstreamLogged, errors.length, ...errors.slice(upstreamLogged).filter((e) => !/502|Bad Gateway/i.test(e)));

  // So is one whose answer's body is cut off on the way: its headers came, but the write it answers
  // may be the one a retry must not repeat. A server of the smoke's own sends the headers and part
  // of the body, then drops the connection (a route cannot stream a body to fail midway).
  const cutName = "a submit key is kept when the answer's body is cut off";
  // WebKit sends a request routed to another URL as a cross-origin one, which the CSP blocks.
  if (engine === "webkit") skip(cutName, "a routed request is cross-origin there");
  else {
    // The answer is a patch, or one the runtime does not draw (a 200 with no Corten header): the
    // write either way, and the key is kept until either has arrived whole.
    const cutServer = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const patch = req.url === "/watch-cut";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(patch ? { "corten-patch": "1" } : {}), "content-length": "500" });
        res.write(patch ? '<p id="watch-message">' : "<p>Watching", () => res.socket?.destroy());
      });
    });
    const cutLogged = errors.length;
    /** @type {string[]} */
    const cutSeen = [];
    // The server, the route and the form go however the case ends, set up in full or not, and each
    // goes even when removing another fails.
    try {
      await new Promise((resolve, reject) => {
        cutServer.once("error", reject);
        cutServer.listen(0, "127.0.0.1", () => resolve(undefined));
      });
      const cutPort = /** @type {import("node:net").AddressInfo} */ (cutServer.address()).port;
      await page.route("**/watch-cut*", (route) => route.continue({ url: `http://127.0.0.1:${cutPort}${new URL(route.request().url()).pathname}` }));
      // A form whose failure does not come within 6 s of its press stops the case.
      for (const action of ["/watch-cut", "/watch-cut-plain"]) {
        await page.evaluate(
          ([zero, action]) =>
            document.querySelector("main")?.insertAdjacentHTML(
              "beforeend",
              __html(`<form id="cut" method="post" action="${action}" data-patch><input type="hidden" name="submit" data-submit value="${zero}"><button>Watch</button></form>`),
            ),
          [zero, action],
        );
        const cutFailed = await formError("#cut");
        /** @type {number | null} */
        let cutStatus = null;
        try {
          await press("#cut button");
          cutStatus = await cutFailed.seen();
        } finally {
          await cutFailed.stop();
        }
        const cutKey = await page.inputValue("#cut [name=submit]");
        cutSeen.push(`${action}: status ${cutStatus ?? "none within 6 s"}, key ${cutKey === zero ? "kept" : cutKey}`);
        await page.evaluate(() => document.querySelector("#cut")?.remove());
        if (cutStatus === null) break;
      }
    } finally {
      await cleanUp(
        () => page.unroute("**/watch-cut*"),
        () => cutServer.close(),
        () => page.evaluate(() => document.querySelector("#cut")?.remove()),
      );
    }
    check(cutName, cutSeen.length === 2 && cutSeen.every((seen) => seen.endsWith("status 0, key kept")), cutSeen.join("; "));
    // The browser logs the answer it could not read.
    errors.splice(cutLogged, errors.length, ...errors.slice(cutLogged).filter((e) => !/Failed to load resource|ERR_|NetworkError|network connection was lost/i.test(e)));
  }

  // A form a script copies from a <template> draws its key field empty
  // (SubmitKey::template_field): the runtime gives each copy a key of its own when it is first
  // sent, keeps it for a retry until an answer, and fills a plain post's too. It fills it before
  // the submit's handlers run, so an on:submit handler that reads the form sees the key that is
  // sent. The route stands in for an app that stores keys: a key it has seen applies nothing. The
  // plain post leaves a page of its own for the page the route answers with (the app's CSP allows
  // no frame to send it to), and the key checked is the one in the body the browser sent.
  {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    /** @type {string[]} */
    const sent = [];
    /** @type {Set<string>} */
    const applied = new Set();
    let down = true;
    // The on:submit handler notes the key it reads, on the form and for the page a post leads to.
    /** @param {import("playwright").Route} route */
    const readKey = (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: 'export function read(event) { const key = String(new FormData(event.target).get("submit") ?? ""); event.target.setAttribute("data-read", key); sessionStorage.setItem("read-key", key); }\nwindow.readKeyLoaded = true;',
      });
    /**
     * Copies the template's form into the page once for each row, and waits for its handler.
     * @param {import("playwright").Page} p @param {string[]} rows
     */
    const copies = async (p, rows) => {
      await p.evaluate((rows) => {
        document.querySelector("main")?.insertAdjacentHTML(
          "beforeend",
          __html(
            '<template id="count-rows"><form method="post" action="/count-row" data-patch data-on="submit:read-key.read($e)"><input type="hidden" name="submit" data-submit><input type="hidden" name="row"><p></p><button>Count</button></form></template><div id="count-row-list"></div>',
          ),
        );
        const template = /** @type {HTMLTemplateElement} */ (document.getElementById("count-rows"));
        for (const row of rows) {
          const form = /** @type {HTMLFormElement} */ (template.content.firstElementChild?.cloneNode(true));
          form.id = `count-row-${row}`;
          /** @type {HTMLInputElement} */ (form.querySelector("[name=row]")).value = row;
          /** @type {HTMLElement} */ (form.querySelector("p")).id = `count-row-${row}-said`;
          if (row === "plain") form.removeAttribute("data-patch");
          document.getElementById("count-row-list")?.append(form);
        }
      }, rows);
      // The handler's module loads when the copies join the page; it runs from then on.
      await p.waitForFunction(() => "readKeyLoaded" in window, null, { timeout: 5000 });
    };
    /** @param {import("playwright").Route} route */
    const countRow = (route) => {
      const body = new URLSearchParams(route.request().postData() ?? "");
      const key = body.get("submit") ?? "";
      const row = body.get("row") ?? "";
      sent.push(`${row} ${key || "(empty)"}`);
      if (down) {
        down = false;
        return route.fulfill({ status: 502, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Bad Gateway" });
      }
      const fresh = uuidV4.test(key) && !applied.has(key);
      if (fresh) applied.add(key);
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" },
        body: `<p id="count-row-${row}-said">${fresh ? "Counted." : "Already counted."}</p>`,
      });
    };
    const logged = errors.length;
    const names = ["each copy of a template's form gets a submit key of its own when first sent, kept for its retry", "an on:submit handler that reads a template copy's form sees the key it sends"];
    /** Why the case stopped, if it did: a failure, answer or post that did not come in time. */
    let stopped = "";
    /** @type {number | null} */
    let failedA = null;
    let kept = "";
    /** @type {string | null} */
    let readA = null;
    /** Each copy's answer, drawn within 5 s of its press, or null. @type {string | null} */
    let saidA = null;
    /** @type {string | null} */
    let saidB = null;
    /** @param {string} row */
    const keyOf = (row) => page.inputValue(`#count-row-${row} [name=submit]`);
    /** @param {string} row */
    const saidBy = (row) => pollFor(5000, () => page.evaluate((row) => document.getElementById(`count-row-${row}-said`)?.textContent || undefined, row));
    // The routes, the copies and the failure's listener go however the case ends, set up in full or
    // not, and each goes even when removing another fails.
    try {
      await page.route("**/scripts/read-key.js", readKey);
      await page.route("**/count-row", countRow);
      await copies(page, ["a", "b"]);
      const failed = await formError("#count-row-a");
      try {
        await press("#count-row-a button");
        failedA = await failed.seen();
      } finally {
        await failed.stop();
      }
      if (failedA === null) stopped = "no corten:error within 6 s of a's first press, so no retry was made";
      else {
        kept = await keyOf("a");
        readA = await page.getAttribute("#count-row-a", "data-read");
        await press("#count-row-a button");
        saidA = await saidBy("a");
        if (saidA === null) stopped = "a's retry not answered within 5 s, so b was not pressed";
        else {
          await press("#count-row-b button");
          saidB = await saidBy("b");
          if (saidB === null) stopped = "b not answered within 5 s";
        }
      }
    } finally {
      await cleanUp(
        () => page.unroute("**/count-row", countRow),
        () => page.unroute("**/scripts/read-key.js", readKey),
        () => page.evaluate(() => (document.getElementById("count-rows")?.remove(), document.getElementById("count-row-list")?.remove())),
      );
    }
    // The browser logs the 502.
    errors.splice(logged, errors.length, ...errors.slice(logged).filter((e) => !/502|Bad Gateway/i.test(e)));
    /** @type {string[]} */
    const plainSent = [];
    /** @type {string | null} */
    let readPlain = null;
    if (!stopped) {
      const plainContext = await browser.newContext();
      // Closed however the case ends, a page that could not be opened included, which takes its
      // routes with it.
      try {
        const plainPage = await plainContext.newPage();
        plainPage.on("console", (m) => {
          const text = m.type() === "error" ? m.text() : "";
          if (text && !bug(text) && !cut.test(text)) errors.push(`plain post: ${text}`);
        });
        plainPage.on("pageerror", (e) => errors.push(`plain post: ${e.message}`));
        await plainPage.route("**/scripts/read-key.js", readKey);
        await plainPage.route("**/count-row", (route) => {
          plainSent.push(new URLSearchParams(route.request().postData() ?? "").get("submit") || "(empty)");
          return route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<!doctype html><title>Counted</title><p>Counted.</p>" });
        });
        await plainPage.goto(base);
        await copies(plainPage, ["plain"]);
        // In the page too: the fresh page's live updates can still be moving the copy when it is pressed.
        await plainPage.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector("#count-row-plain button")).click());
        // The post's page, within 5 s of the press.
        if (!(await pollFor(5000, async () => plainSent.length > 0 && new URL(plainPage.url()).pathname === "/count-row"))) stopped = "the plain copy's post did not land within 5 s";
        else readPlain = await plainPage.evaluate(() => sessionStorage.getItem("read-key")).catch(() => null);
      } finally {
        await plainContext.close();
      }
    }
    const [plainKey = "(none)"] = plainSent;
    const [a1, a2, b, ...more] = sent.map((s) => s.split(" ")[1]);
    check(
      names[0],
      !stopped && failedA === 502 && !more.length && uuidV4.test(kept) && a1 === kept && a2 === kept && uuidV4.test(b ?? "") && b !== kept && saidA === "Counted." && saidB === "Counted." && plainSent.length === 1 && uuidV4.test(plainKey) && plainKey !== kept && plainKey !== b,
      `${stopped ? `${stopped}; ` : ""}${sent.join(", ")}; plain ${plainSent.join(", ") || "(none)"}; a: ${failedA ?? "no error"} then ${saidA ?? "no answer"}, b: ${saidB ?? "no answer"}`,
    );
    check(names[1], !stopped && readA === kept && readPlain === plainKey, `${stopped ? `${stopped}; ` : ""}a: ${readA || "(empty)"}, plain: ${readPlain || "(empty)"}`);
  }

  // A submit button's formaction and formmethod win over the form's, as in a plain post.
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      __html('<form id="via-button" method="get" action="/nowhere" data-patch><input type="hidden" name="id" value="ACME"><button formmethod="post" formaction="/watch">Watch</button></form>'),
    ),
  );
  // The message already says Acme from the keyed form, so the check waits for this post's own
  // answer: otherwise a slow post (Firefox) is still going out during the next check, which
  // counts the posts it sees (#161). It waits 15 s, past the 5 s most of the smoke's waits take,
  // because a loaded Firefox has taken over 4 s to answer this post (#1149). The button is pressed
  // in the page: a loaded Firefox's click can land beside a button the page has moved (#2014).
  // The answer and its body share the 15 s from before the press, the body read in a step of its
  // own, and the message has 15 s from then; anything that comes after its time fails the check.
  const answered = steps(15_000, "the post was not answered within 15 s");
  const viaResponse = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/watch", { timeout: 15_000 });
  // Its rejection is the step's, if the step is reached.
  viaResponse.catch(() => {});
  await press("#via-button button");
  let viaButtonStatus = 0;
  try {
    const response = await answered.step(() => viaResponse);
    await answered.step(() => response.finished());
    viaButtonStatus = response.status();
  } catch {
    // Its reason is `answered.over`.
  }
  const watching = !!viaButtonStatus && !!(await pollFor(15_000, () => page.evaluate(() => !!document.getElementById("watch-message")?.textContent?.startsWith("Watching Acme Corp"))));
  check(
    "a submit button's formaction and formmethod are used",
    viaButtonStatus === 200 && watching,
    `${answered.over || viaButtonStatus}${watching ? "" : "; no Acme Corp message within 15 s of the answer"}`,
  );

  // Controls named like the form's properties (`<button name="action">` makes `form.action` that
  // button) do not change where or how the runtime posts it.
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      __html('<form id="shadowed" method="post" action="/watch" data-patch><input type="hidden" name="id" value="GLBX"><input type="hidden" name="method" value="x"><input type="hidden" name="enctype" value="x"><input type="hidden" name="elements" value="x"><input type="hidden" name="setAttribute" value="x"><input type="hidden" name="hasAttribute" value="x"><input type="hidden" name="getAttribute" value="x"><button name="action" value="go">Watch</button></form>'),
    ),
  );
  const shadowedPosts = /** @type {string[]} */ ([]);
  // The answer's list subscribes to its feed again (`GET /feed/stocks`), which is not the post.
  // Each entry names the form's `id` field, so a late event from an earlier check shows as one.
  const onShadowed = (/** @type {import("@playwright/test").Request} */ r) =>
    r.resourceType() === "fetch" &&
    !new URL(r.url()).pathname.startsWith("/feed/") &&
    shadowedPosts.push(`${r.method()} ${new URL(r.url()).pathname} ${new URLSearchParams(r.postData() ?? "").get("id")}`);
  page.on("request", onShadowed);
  // The answer draws the watch form again: one with controls named after the members the runtime
  // reads on it (`shadowing`) is replaced as any other, and no corten:error says the write failed.
  await page.evaluate((names) => {
    document
      .getElementById("watch-form")
      ?.insertAdjacentHTML("afterbegin", __html(names.map((name) => `<input type="hidden" name="${name}" value="x">`).join("")));
    /** @type {any} */ (window).__shadowedErrors = 0;
    document.addEventListener("corten:error", () => (/** @type {any} */ (window).__shadowedErrors += 1));
  }, shadowing);
  // Clicked from the page: Playwright's own click reads the form's getAttribute, which the
  // control named getAttribute shadows.
  await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector("#shadowed button")).click());
  await page.waitForFunction(() => document.getElementById("watch-message")?.textContent?.startsWith("Watching Globex"), null, { timeout: 4000 }).catch(() => {});
  page.off("request", onShadowed);
  check(
    "controls named action, method, id and the like do not change the post",
    ((await page.textContent("#watch-message")) ?? "").startsWith("Watching Globex") && shadowedPosts.join() === "POST /watch GLBX",
    `${shadowedPosts.join()}; ${await page.textContent("#watch-message")}`,
  );
  const redrawn = await page.evaluate(() => ({
    replaced: !document.querySelector("#watch-form > input[name=hasAttribute]"),
    errors: /** @type {any} */ (window).__shadowedErrors,
  }));
  // And an answer that carries such controls itself, as the server's would for a form that has
  // them: drawn as any other, its reads of the new form go through Element's own methods too.
  const carried = await page.evaluate(async (names) => {
    const { patch } = await import("corten");
    const form = /** @type {HTMLFormElement} */ (document.getElementById("watch-form"));
    const inputs = names.map((name) => `<input type="hidden" name="${name}" value="x">`).join("");
    // With a custom property of its own (`style={..}`), which the runtime sets through the
    // form's `style`, a member its control named style shadows.
    const fresh = /** @type {string} */ (Reflect.get(Element.prototype, "outerHTML", form)).replace(/^<form([^>]*)>/, (_, attrs) => `<form${attrs} data-vars="--smoke-shadowed:3px">${inputs}`);
    /** @type {unknown} */
    let failed = null;
    try {
      await patch(__html(fresh));
    } catch (error) {
      failed = String(error);
    }
    const now = document.getElementById("watch-form");
    // The new form's own querySelector is its control of that name.
    const drawn =
      now !== form &&
      !!now &&
      !!Element.prototype.querySelector.call(now, "input[name=hasAttribute]") &&
      /** @type {CSSStyleDeclaration} */ (Reflect.get(HTMLElement.prototype, "style", now)).getPropertyValue("--smoke-shadowed") === "3px";
    for (const name of names) document.querySelector(`#watch-form > input[name="${name}"]`)?.remove();
    return { drawn, failed };
  }, shadowing);
  check(
    "a patch draws again a form with controls named after the members the runtime reads on it, and says no write failed",
    redrawn.replaced && redrawn.errors === 0 && carried.drawn && carried.failed === null,
    JSON.stringify({ ...redrawn, ...carried }),
  );
  await page.evaluate(() => document.getElementById("shadowed")?.remove());
  return { zero };
}

export async function formSubmission(browser) {
  // A navigating form goes the way its submit button says, as without the runtime (#190):
  // Chromium's NavigateEvent.formData follows the form's own method, not the button's.
  // Not in WebKit with the Navigation API: Playwright loses its page there (see the probe above).
  const forms = await browser.newPage();
  await forms.goto(`${base}/news`);
  if (engine !== "webkit" && (await forms.evaluate(() => "navigation" in window))) {
    /** @type {string[]} */
    const sent = [];
    forms.on("request", (r) => {
      const url = new URL(r.url());
      if (["document", "fetch"].includes(r.resourceType()) && ["/watch", "/news"].includes(url.pathname)) {
        sent.push(`${r.method()} ${url.pathname}${url.search} ${r.postData() ?? ""}`.trim());
      }
    });
    await forms.evaluate(() => {
      (/** @type {any} */ (window)).__forms = 1;
      document.querySelector("main")?.insertAdjacentHTML(
        "beforeend",
        __html('<form id="post-form" method="post" action="/watch"><input type="hidden" name="mine" value="on"><button formmethod="get" formaction="/news">Apply</button></form>'),
      );
    });
    await forms.click("#post-form button");
    // The address changes as the navigation is taken over, before the page is fetched: wait for
    // the new page itself.
    await forms
      .waitForFunction(() => document.getElementById("stories-title")?.textContent === "Stories about your stocks", null, { timeout: 5000 })
      .catch(() => {});
    const swapped = await forms.evaluate(() => (/** @type {any} */ (window)).__forms === 1);
    check("a GET button in a POST form is a GET, swapped in place", sent.join() === "GET /news?mine=on" && swapped, `${sent.join()} kept=${swapped}`);
    sent.length = 0;
    await forms.evaluate(() =>
      document.querySelector("main")?.insertAdjacentHTML(
        "beforeend",
        __html('<form id="get-form" method="get" action="/news"><input type="hidden" name="id" value="ACME"><button formmethod="post" formaction="/watch">Watch</button></form>'),
      ),
    );
    const posted = forms.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/watch", { timeout: 5000 }).catch(() => null);
    await forms.click("#get-form button");
    const post = await posted;
    check("a POST button in a GET form posts its fields", post?.postData() === "id=ACME", sent.join() || "nothing sent");
  }

  /**
   * On a fresh /news page with `html` in its main: the first request `act` sends to /watch or
   * /news, as "METHOD path?query body", and "(runtime)" after it when the runtime sent it (its
   * `corten: action` header) rather than the browser.
   * @param {string} html
   * @param {() => Promise<unknown>} act
   * @param {number} [timeout]
   */
  const firstSent = async (html, act, timeout = 5000) => {
    await forms.goto(`${base}/news`);
    await forms.evaluate((html) => document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(html)), html);
    const request = forms
      .waitForRequest((r) => ["document", "fetch"].includes(r.resourceType()) && ["/watch", "/news"].includes(new URL(r.url()).pathname), { timeout })
      .catch(() => null);
    await act().catch(() => {});
    const r = await request;
    if (!r) return "nothing sent";
    const url = new URL(r.url());
    const by = r.headers()["corten"] === "action" ? " (runtime)" : "";
    return `${r.method()} ${url.pathname}${url.search} ${r.postData() ?? ""}`.trim() + by;
  };
  // A data-patch form reads its button as the browser does (#196): an invalid formmethod is a GET,
  // and an empty formaction is the page's own address.
  const invalid = await firstSent(
    '<form id="patch-put" method="post" action="/watch" data-patch><input type="hidden" name="mine" value="on"><button formmethod="put" formaction="/news">Go</button></form>',
    () => forms.click("#patch-put button"),
  );
  check("a data-patch form's invalid formmethod is a GET", invalid === "GET /news?mine=on (runtime)", invalid);
  const empty = await firstSent(
    '<form id="patch-empty" method="post" action="/watch" data-patch><input type="hidden" name="mine" value="on"><button formmethod="" formaction="">Go</button></form>',
    () => forms.click("#patch-empty button"),
  );
  check("a data-patch form's empty formmethod and formaction are a GET of the page", empty === "GET /news?mine=on (runtime)", empty);
  // The button's formenctype decides the body, as it does for the browser.
  const multipart = await firstSent(
    '<form id="patch-enctype" method="post" action="/watch" data-patch><input type="hidden" name="id" value="ACME"><button formenctype="multipart/form-data">Go</button></form>',
    () => forms.click("#patch-enctype button"),
  );
  check("a data-patch form's formenctype button sends multipart", /^POST \/watch -+[\w-]+\r\nContent-Disposition: form-data; name="id"/.test(multipart) && multipart.endsWith("(runtime)"), multipart.slice(0, 80));
  // A dialog's form closes the dialog and sends nothing, data-patch or not.
  const dialog = await firstSent(
    '<dialog id="patch-dialog" open><form method="dialog" action="/watch" data-patch><button value="ok">OK</button></form></dialog>',
    () => forms.click("#patch-dialog button"),
    1500,
  );
  const closed = await forms.evaluate(() => {
    const d = /** @type {HTMLDialogElement} */ (document.getElementById("patch-dialog"));
    return !d.open && d.returnValue === "ok";
  });
  check("a data-patch form in a dialog closes it and sends nothing", dialog === "nothing sent" && closed, `${dialog} closed=${closed}`);
  // A handler that cancels the submit stops a data-patch form, as it stops any form (#199). It
  // listens on the document after the runtime loaded, where the page's on:submit handlers listen
  // (by the form's id attribute: its control named id shadows form.id).
  const canceled = await firstSent(
    '<form id="patch-cancel" method="post" action="/watch" data-patch><input type="hidden" name="id" value="ACME"><button>Go</button></form>',
    async () => {
      await forms.evaluate(() => document.addEventListener("submit", (event) => /** @type {Element} */ (event.target).getAttribute("id") === "patch-cancel" && event.preventDefault()));
      await forms.click("#patch-cancel button");
    },
    1500,
  );
  check("a data-patch form whose submit a handler cancels sends nothing", canceled === "nothing sent", canceled);
  // An on:submit handler that only stops its propagation still gets the runtime's patch: it keeps
  // the submit from the page's outer handlers, not from the runtime. The handler's module is
  // served here, as one of the app's would be.
  await forms.route("**/scripts/stop-submit.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "export function stop(event) { event.stopPropagation(); }" }),
  );
  const stopped = await firstSent(
    '<form id="patch-stop" method="post" action="/watch" data-patch data-on="submit:stop-submit.stop($e)"><input type="hidden" name="id" value="ACME"><button>Go</button></form>',
    async () => {
      // The module loads when the form joins the page; the handler runs from then on.
      await forms.waitForTimeout(500);
      await forms.click("#patch-stop button");
    },
  );
  check("a data-patch form whose on:submit stops its propagation is still a patch", stopped === "POST /watch id=ACME (runtime)", stopped);
  // A data-patch form's body is the browser's (#200): a file is its name, a line break is CRLF.
  const encoded = await firstSent(
    '<form id="patch-encoded" method="post" action="/watch" data-patch><textarea name="note">a\nb</textarea><input type="file" name="doc"><button>Go</button></form>',
    async () => {
      await forms.setInputFiles("#patch-encoded input[type=file]", { name: "list.txt", mimeType: "text/plain", buffer: Buffer.from("ACME") });
      await forms.click("#patch-encoded button");
    },
  );
  check("a data-patch form sends a file's name and CRLF line breaks", encoded === "POST /watch note=a%0D%0Ab&doc=list.txt (runtime)", encoded);
  // text/plain is sent as text/plain: each entry on its own line, nothing escaped.
  await forms.goto(`${base}/news`);
  await forms.evaluate(() =>
    document
      .querySelector("main")
      ?.insertAdjacentHTML("beforeend", __html('<form id="patch-plain" method="post" action="/watch" enctype="text/plain" data-patch><input type="hidden" name="id" value="ACME"><input type="hidden" name="n" value="a b&c"><button>Go</button></form>')),
  );
  const plainSent = forms.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/watch", { timeout: 5000 }).catch(() => null);
  await forms.click("#patch-plain button");
  const plainRequest = await plainSent;
  const plainBody = plainRequest?.postData() ?? "";
  const plainType = plainRequest?.headers()["content-type"] ?? "";
  const plainBy = plainRequest?.headers()["corten"] ?? "the browser";
  check("a text/plain data-patch form sends text/plain", plainBody === "id=ACME\r\nn=a b&c\r\n" && plainType === "text/plain" && plainBy === "action", `${JSON.stringify(plainBody)} ${plainType} by ${plainBy}`);
  if (engine !== "webkit" && (await forms.evaluate(() => "navigation" in window))) {
    // A submit input outside its form (form=), and a form sent with no button.
    const outside = await firstSent(
      '<form id="outside" method="get" action="/news"><input type="hidden" name="id" value="ACME"></form><input id="outside-submit" type="submit" form="outside" formmethod="post" formaction="/watch">',
      () => forms.click("#outside-submit"),
    );
    check("a POST submit input outside its GET form posts the form's fields", outside === "POST /watch id=ACME", outside);
    const unsent = await firstSent('<form id="no-button" method="post" action="/watch"><input type="hidden" name="id" value="ACME"></form>', () =>
      forms.evaluate(() => /** @type {HTMLFormElement} */ (document.getElementById("no-button")).requestSubmit()),
    );
    check("a POST form sent without a button posts its fields", unsent === "POST /watch id=ACME", unsent);
  }
  await forms.close();
}
