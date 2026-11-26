import { chromium, firefox, webkit } from "@playwright/test";
import { steady } from "../steady.mjs";
import { stall } from "../stall.mjs";
import { validateServer, httpChecks } from "./http.mjs";

const base = process.argv[2] ?? "http://localhost:18480";
const engines = { chromium, firefox, webkit };
/**
 * The runtime swaps this request's answer into the page (`corten: nav` or `action`); the page it
 * fetches whole after a write asks with `corten: page` and is drawn as a full load's.
 * @param {import("@playwright/test").Request} r
 */
const swapped = (r) => ["nav", "action"].includes(r.headers()["corten"] ?? "");
/**
 * Names of form controls that shadow a member the runtime reads or calls on a form (a control's
 * `name` becomes the form's property): the shadowed-form checks put a control of each in a form,
 * and reach that form's own members through the prototype themselves.
 */
const shadowing = [
  "hasAttribute",
  "getAttribute",
  "closest",
  "matches",
  "querySelector",
  "querySelectorAll",
  "getElementsByTagName",
  "isConnected",
  "contains",
  "remove",
  "append",
  "replaceWith",
  "replaceChildren",
  "children",
  "attributes",
  "focus",
  "style",
  "setAttribute",
  "removeAttribute",
  "toggleAttribute",
  "addEventListener",
  "removeEventListener",
  "reset",
  "parentElement",
  "parentNode",
  "nextSibling",
  "firstChild",
  "firstElementChild",
  "nextElementSibling",
  "localName",
  "nodeName",
  "childNodes",
  "childElementCount",
  "outerHTML",
  "textContent",
  "cloneNode",
  "ownerDocument",
  "tagName",
  "insertBefore",
  "showPopover",
  "scrollWidth",
  "clientWidth",
  "clientLeft",
  "getBoundingClientRect",
  "getClientRects",
  "scrollBy",
  "scrollIntoView",
];
const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(engines);

const failures = [];
let engine = "";
const skipped = [];
const seen = stall(5, () => `[${engine}] still loading:\n${pending().join("\n") || "  nothing"}`);
/** A check this browser cannot make, and why. */
const skip = (/** @type {string} */ name, /** @type {string} */ why) => {
  seen(`[${engine}] ${name}`);
  console.log(`skip [${engine}] ${name} (${why})`);
  skipped.push(`[${engine}] ${name}`);
};
const check = (name, ok, detail = "") => {
  seen(`[${engine}] ${name}`);
  console.log(`${ok ? "ok  " : "FAIL"} [${engine}] ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`[${engine}] ${name}`);
};
/**
 * Watches the element at `selector` for its busy mark: whether it was marked while `<main>` was,
 * and what the page showed when the mark went (read by `busyEnded`). Observed on the element
 * itself, so a mark cleared after a swap removed it is seen too.
 * @param {import("@playwright/test").Page} page @param {string} selector
 */
const watchBusy = (page, selector) =>
  page.evaluate((selector) => {
    const el = /** @type {Element} */ (document.querySelector(selector));
    /** @type {{ with: boolean, then: { path: string, stories: number } | null }} */
    const seen = { with: false, then: null };
    /** @type {any} */ (window).__busy = seen;
    new MutationObserver((_, observer) => {
      if (el.getAttribute("aria-busy") === "true") {
        seen.with ||= !!document.querySelector("main[aria-busy]");
        return;
      }
      seen.then = { path: location.pathname, stories: document.querySelectorAll("#stories > li").length };
      observer.disconnect();
    }).observe(el, { attributes: true, attributeFilter: ["aria-busy"] });
  }, selector);
/**
 * Settles as `work` does, or rejects with `what` once `ms` have passed by the monotonic clock
 * (`performance.now()`, as `steps` counts): `work` that settles after that, though its timer has
 * not yet run (a stalled event loop runs it late), rejects with `what` too, as a late result is no
 * result. `work` is left to end on its own (closing its page ends it); a rejection it brings later
 * is already handled here.
 * @template T @param {number} ms @param {string} what @param {Promise<T>} work @returns {Promise<T>}
 */
const within = (ms, what, work) => {
  const until = performance.now() + ms;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(what)), Math.max(0, ms))));
  const onTime = Promise.resolve(work).then(
    (value) => {
      if (performance.now() >= until) throw new Error(what);
      return value;
    },
    (error) => {
      throw performance.now() >= until ? new Error(what) : error;
    },
  );
  return /** @type {Promise<T>} */ (Promise.race([onTime, late])).finally(() => clearTimeout(timer));
};

/**
 * `work`, a read of the page (an `evaluate` or a locator's), within 5 s, or a rejection saying
 * `what` was not read: a read the browser never answers would otherwise keep a case from its
 * `finally`. @template T @param {string} what @param {Promise<T>} work @returns {Promise<T>}
 */
const readWithin = (what, work) => within(5000, `${what} was not read within 5 s`, work);

/**
 * `work`, a driver action that waits on the page (a click, fill, focus, key press or `goto`),
 * within 30 s, Playwright's own timeout for an action, by the smoke's clock (`within`), or a
 * rejection saying `what` was not done: an action whose answer never comes would otherwise keep a
 * case from its `finally`. @template T @param {string} what @param {Promise<T>} work @returns {Promise<T>}
 */
const actWithin = (what, work) => within(30_000, `${what} was not done within 30 s`, work);

/**
 * Whether `waiting`, a driver's wait on the page (`waitForFunction`, `waitForSelector`,
 * `waitForRequest` and the like), came within `ms` of this call by the smoke's own clock
 * (`within`): the driver's own timeout counts from when it receives the wait, which a delayed
 * dispatch moves later, so one that comes after the `ms`, or never, is false.
 * @param {number} ms @param {Promise<unknown>} waiting @returns {Promise<boolean>}
 */
const cameWithin = (ms, waiting) =>
  within(ms, `not within ${ms} ms`, waiting).then(
    () => true,
    () => false,
  );

/**
 * Waits `ms` by a timer of the smoke's own. A driver command (`page.waitForTimeout`) has no bound
 * on its answer: one whose answer never comes would keep a case from its cleanup.
 * @param {number} ms
 */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Work under one budget of `ms` that stops for good. Each step has what is left of the budget; a
 * step that settles after the budget has ended fails as one that ran out, though its result came
 * (a result that arrives late is no result), and once a step fails or runs out (or `end` is
 * called, or the time is up), no step starts. A step that ran out is left to end on its own, as
 * `within` leaves it. A handle a step returns is read in a step of its own.
 * @param {number} ms @param {string} what
 */
const steps = (ms, what) => {
  const until = performance.now() + ms;
  /** Why the work stopped, never empty once it has: an error without a message stops it too. */
  let over = "";
  /** @param {unknown} why */
  const stop = (why) => (over ||= (why instanceof Error ? why.message.split("\n")[0] : String(why ?? "")) || `${what}: a step failed`);
  /** Whether the work has stopped, marking it stopped once the time is up. */
  const stopped = () => {
    if (!over && performance.now() >= until) over = what;
    return over !== "";
  };
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  const step = async (work) => {
    if (stopped()) throw new Error(over);
    /** @type {T} */
    let value;
    try {
      value = await within(until - performance.now(), what, work());
    } catch (error) {
      stop(error);
      throw error;
    }
    if (stopped()) throw new Error(over);
    return value;
  };
  return {
    /** Why the work stopped, or "" while it goes on. */
    get over() {
      return over;
    },
    /** Stops the work, for `why`, and throws it. @param {string} why @returns {never} */
    end(why) {
      stop(why);
      throw new Error(over);
    },
    step,
    /**
     * Calls `probe` every 50 ms, each call a step, until it returns something other than
     * `undefined` or `false`, and returns that.
     * @template T @param {() => Promise<T | undefined | false>} probe @returns {Promise<T>}
     */
    async poll(probe) {
      for (;;) {
        const got = await step(probe);
        if (got !== undefined && got !== false) return /** @type {T} */ (got);
        await step(() => new Promise((resolve) => setTimeout(resolve, 50)));
      }
    },
  };
};

/**
 * `probe`'s first answer other than `undefined` or `false` within `ms` (see `steps`), or null if
 * none came in time (a late one included) or a probe threw.
 * @template T @param {number} ms @param {() => Promise<T | undefined | false>} probe @returns {Promise<T | null>}
 */
const pollFor = (ms, probe) =>
  steps(ms, `nothing within ${ms} ms`)
    .poll(probe)
    .catch(() => null);

/**
 * Runs each of a case's cleanup steps in turn, the later ones even when one before them rejects,
 * then rejects with the first rejection, if there was one.
 * @param {...(() => unknown)} undo
 */
const cleanUp = async (...undo) => {
  /** @type {unknown[]} */
  const failed = [];
  for (const step of undo) {
    try {
      await step();
    } catch (error) {
      failed.push(error);
    }
  }
  if (failed.length) throw failed[0];
};

/**
 * One exchange of a stand-in's route callback, named `what`: its steps for `route` (fetching the
 * request's answer, reading it, then sending one) each within a bound of its own by the smoke's
 * clock (`within`), so a fetch, read or answer that never settles does not keep the callback going
 * past them. Once a step fails or runs out, nothing more is sent for the request: it is aborted, once
 * (bounded to 5 s), and the step rejects, so the callback's later steps do not run and a fetch that
 * ends late answers nothing. The answer is sent only by `send`, and not once `ended()` says the case
 * is over, as it reads just before a step starts and again just before the answer itself is sent:
 * the request is then given `late()` instead, bounded to 5 s (by default let through as it came,
 * `fallback`, as the callback lets through a request that comes after its case; an abort where the
 * case's context is closing), so a stand-in's answer is never drawn once its case has ended.
 * `fault` is why the exchange did not answer the request as the stand-in meant (a step that failed
 * or ran out, an answer not confirmed in time, or its case's end), "" while it has or may yet, for
 * the check that rests on that answer. A hold the case controls (an answer kept until the case lets
 * it go) is awaited between steps, outside their bounds: the case bounds its own release.
 * @param {import("@playwright/test").Route} route @param {string} what @param {() => boolean} [ended]
 * @param {() => Promise<unknown>} [late]
 */
const exchange = (route, what, ended = () => false, late = () => route.fallback()) => {
  let fault = "";
  /** Set once the request has been answered, aborted or let through: nothing else is sent for it. */
  let sent = false;
  /** @param {string} why */
  const stop = async (why) => {
    fault ||= `${what}: ${why}`;
    if (sent) return;
    sent = true;
    await within(5000, "", route.abort()).catch(() => {});
  };
  /** Why a step named `step` with `ms` failed. @param {string} step @param {number} ms @param {unknown} error */
  const reason = (step, ms, error) => {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return message === `${step} did not settle within ${ms / 1000} s` ? message : `${step} failed: ${message}`;
  };
  return {
    get fault() {
      return fault;
    },
    /**
     * `work()`, the exchange's step named `step`, within `ms`; one that fails or runs out stops the
     * exchange (`stop`) and rejects, as does one started once it has stopped.
     * @template T @param {number} ms @param {string} step @param {() => Promise<T>} work @returns {Promise<T>}
     */
    async step(ms, step, work) {
      if (fault) throw new Error(fault);
      if (ended()) {
        fault = `${what}: its case ended before ${step}, so nothing was sent`;
        if (!sent) {
          sent = true;
          await within(5000, "", Promise.resolve().then(late)).catch(() => {});
        }
        throw new Error(fault);
      }
      try {
        return await within(ms, `${step} did not settle within ${ms / 1000} s`, Promise.resolve().then(work));
      } catch (error) {
        await stop(reason(step, ms, error));
        throw new Error(fault);
      }
    },
    /**
     * Sends the stand-in's answer, `answer()` (a fulfill, or the abort or fallback the stand-in means
     * as its answer), within `ms`, unless the exchange has stopped, which rejects, or its case has
     * ended, when the request is given `late()` instead, the exchange's `fault` says so and this
     * rejects: it resolves only once the answer was sent and confirmed. An answer sent and not
     * confirmed within `ms` cannot be taken back: the exchange's `fault` says it is unconfirmed, and
     * this rejects.
     * @param {number} ms @param {string} step @param {() => Promise<unknown>} answer
     */
    async send(ms, step, answer) {
      if (fault) throw new Error(fault);
      if (sent) throw new Error(`${what}: ${step}: the request was already answered`);
      sent = true;
      // Read where the answer is sent, after the queue it waits in, not where it is asked for.
      let after = false;
      try {
        await within(
          ms,
          `${step} did not settle within ${ms / 1000} s`,
          Promise.resolve().then(() => (ended() ? ((after = true), late()) : answer())),
        );
      } catch (error) {
        if (!after) {
          fault ||= `${what}: ${reason(step, ms, error)}${/did not settle/.test(String(error)) ? ", so whether it answered the request is unconfirmed" : ""}`;
          throw new Error(fault);
        }
      }
      if (after) {
        fault ||= `${what}: its case ended before ${step} was sent, so it was not sent`;
        throw new Error(fault);
      }
    },
  };
};

/**
 * Lets `route`'s request through as it came, bounded to 5 s: a route callback that does not answer
 * a request does not wait on a fallback that never settles.
 * @param {import("@playwright/test").Route} route
 */
const letThrough = (route) => within(5000, "", route.fallback()).catch(() => {});

/**
 * `opening` (a context or page being made), within `ms` (by default 30 s, Playwright's own timeout
 * for an action: a loaded browser can take seconds to start a process for one). One made only after
 * them (by the monotonic clock, as `within` counts, though before its timer ran) is closed as it
 * comes, so a case that gave up on it does not leave it open.
 * @template {{ close: () => Promise<unknown> }} T @param {string} what @param {Promise<T>} opening @param {number} [ms]
 * @returns {Promise<T>}
 */
const opened = (what, opening, ms = 30_000) =>
  within(ms, `${what} was not made within ${ms / 1000} s`, opening).catch((error) => {
    opening.then(
      (made) => made.close().catch(() => {}),
      () => {},
    );
    throw error;
  });

/**
 * Closes `context` within 30 s, Playwright's own timeout for an action: a loaded Firefox has taken
 * over 5 s to close one. If its closing is not confirmed by then, closes each of its pages, each
 * within 30 s, and rejects all the same: a case that cannot confirm its context closed fails, rather
 * than waiting on it.
 * @param {import("@playwright/test").BrowserContext} context @param {string} what
 */
const closeContext = async (context, what) => {
  try {
    await within(30_000, `${what} was not closed within 30 s`, context.close());
  } catch (error) {
    await Promise.allSettled(context.pages().map((p) => within(30_000, `a page of ${what} was not closed within 30 s`, p.close())));
    throw error;
  }
};

/** What `watchBusy` saw, once the mark has gone. @param {import("@playwright/test").Page} page */
const busyEnded = (page) =>
  page
    .waitForFunction(() => /** @type {any} */ (window).__busy.then && /** @type {any} */ (window).__busy, undefined, { timeout: 5000 })
    .then(
      (handle) => handle.jsonValue(),
      () => page.evaluate(() => /** @type {any} */ (window).__busy),
    );

/**
 * Requests the browser's pages have sent and not finished, with when each was sent: printed when
 * a run throws (a page that never fires `load`), so the report says which one hangs (#232, #252).
 * A request leaves when it finishes or fails, or when its page or context closes.
 * @type {Map<import("@playwright/test").Request, { at: number, context: import("@playwright/test").BrowserContext }>}
 */
const inflight = new Map();
/** This run's peak of requests in flight in one context (any origin, fulfilled ones too), how many were streams, and the one that made it (#1149). */
let busiest = { requests: 0, streams: 0, url: "" };
/** The page a request is for, or null for a service worker's, which has no frame. @param {import("@playwright/test").Request} r */
function pageOf(r) {
  try {
    return r.frame().page();
  } catch {
    return null;
  }
}
/** @param {import("@playwright/test").Browser} browser */
function track(browser) {
  /** @param {(r: import("@playwright/test").Request, at: { context: import("@playwright/test").BrowserContext }) => boolean} gone */
  const drop = (gone) => {
    for (const [r, at] of inflight) if (gone(r, at)) inflight.delete(r);
  };
  // `newPage` makes its context through `newContext`, so every context is watched here.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    context.on("request", (r) => {
      inflight.set(r, { at: Date.now(), context });
      const mine = [...inflight].filter(([, at]) => at.context === context).map(([q]) => q);
      const streams = mine.filter((q) => q.resourceType() === "eventsource").length;
      if (mine.length > busiest.requests || (mine.length === busiest.requests && streams > busiest.streams)) {
        busiest = { requests: mine.length, streams, url: r.url() };
      }
    });
    context.on("requestfinished", (r) => inflight.delete(r));
    context.on("requestfailed", (r) => inflight.delete(r));
    context.on("page", (page) => page.on("close", () => drop((r) => pageOf(r) === page)));
    context.on("close", () => drop((_, at) => at.context === context));
    return context;
  };
}
/**
 * The app's pages require Trusted Types, so markup reaches the DOM from a string only through a
 * policy. The runtime has its own; the markup this test writes into a page to set up a case goes
 * through `__html`, a policy named `smoke`, which the watchlist allows when it runs with
 * `SMOKE_TRUSTED_TYPES=1`. A runtime sink that skipped its policy still throws.
 * @param {import("@playwright/test").Browser} browser
 */
function trusting(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.addInitScript(() => {
      /** @type {{ createHTML: (html: string) => unknown } | undefined} */
      let policy;
      Object.defineProperty(window, "__html", { value: (/** @type {string} */ html) => {
        // This init script also runs on redirect destinations where the test writes no markup.
        policy ??= /** @type {any} */ (globalThis).trustedTypes?.createPolicy("smoke", { createHTML: (/** @type {string} */ html) => html });
        return policy ? policy.createHTML(html) : html;
      } });
    });
    return context;
  };
}
/**
 * What is still loading, oldest first, each with its context's and page's number, so a stalled
 * request can be told apart from the open streams that share its connections (#1149).
 */
function pending() {
  const now = Date.now();
  /** @type {Map<import("@playwright/test").BrowserContext, { n: number, pages: Map<import("@playwright/test").Page, number> }>} */
  const contexts = new Map();
  return [...inflight]
    .sort((a, b) => a[1].at - b[1].at)
    .map(([r, { at, context }]) => {
      let c = contexts.get(context);
      if (!c) contexts.set(context, (c = { n: contexts.size + 1, pages: new Map() }));
      const page = pageOf(r);
      if (page && !c.pages.has(page)) c.pages.set(page, c.pages.size + 1);
      return `  ${now - at}ms page ${c.n}.${page ? c.pages.get(page) : "worker"} ${r.method()} ${r.url()} (${r.resourceType()})`;
    });
}

/**
 * Sends each GET still loading (but streams) again from Node, with the browser's headers but its
 * cookies (`headers()` leaves them out, and `allHeaders()` would ask the browser, which may be what
 * is stuck) and a 10 s bound, and says how long the server took: a fast answer here while the browser's waited says the
 * browser held the request, a slow one or none says the server or the machine did (#1149). A
 * request the smoke routed itself goes to the server here.
 */
async function again() {
  /** @type {Map<string, Record<string, string>>} */
  const gets = new Map();
  for (const r of inflight.keys()) {
    if (r.method() !== "GET" || r.resourceType() === "eventsource" || gets.has(r.url())) continue;
    // Headers fetch refuses to send, and ones the connection sets for itself.
    const headers = Object.fromEntries(Object.entries(r.headers()).filter(([name]) => !/^(host|connection|keep-alive|transfer-encoding|upgrade|expect|content-length)$/i.test(name)));
    gets.set(r.url(), headers);
  }
  return Promise.all(
    [...gets].map(async ([url, headers]) => {
      const start = Date.now();
      const outcome = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) }).then(
        async (res) => (await res.arrayBuffer(), String(res.status)),
        (e) => (e instanceof Error ? e.name : String(e)),
      );
      return `  ${Date.now() - start}ms ${outcome} ${url}`;
    }),
  );
}

/** Whether the browser lets a navigation say when its address changes: the Navigation API with `precommitHandler`. */
function precommits() {
  return "navigation" in window && "NavigationPrecommitController" in window;
}

/**
 * Starts recording in `window.__addresses` every address the page has as its history entry
 * changes, the moment it changes (`currententrychange`). Returns how many history entries there
 * are when it starts, for the check to count the ones the navigation adds.
 */
function entriesWhileRecordingAddresses() {
  /** @type {string[]} */
  const addresses = [location.pathname];
  /** @type {any} */ (window).__addresses = addresses;
  const navigation = /** @type {any} */ (window).navigation;
  navigation?.addEventListener("currententrychange", () => addresses.push(location.pathname));
  return navigation?.entries().length ?? 0;
}

/** @param {(browser: import("@playwright/test").Browser) => Promise<void>} run */
export async function runSmoke(run) {
  await validateServer(base);
  engine = "http";
  await httpChecks(base, check);
  for (engine of names) {
    const browser = steady(await engines[engine].launch({ headless: true }), { gateInitialWebKitLoad: true });
    track(browser);
    trusting(browser);
    try {
      await run(browser);
    } catch (error) {
      console.log(`[${engine}] still loading when it failed:\n${pending().join("\n") || "  nothing"}`);
      console.log(`[${engine}] the same requests sent now, outside the browser (#1149):\n${(await again()).join("\n") || "  nothing"}`);
      console.log(`[${engine}] this run's peak of requests in flight in one context: ${busiest.requests} (${busiest.streams} streams), at ${busiest.url}`);
      throw error;
    } finally {
      busiest = { requests: 0, streams: 0, url: "" };
      inflight.clear();
      await browser.close();
    }
  }
  if (skipped.length) console.log(`\n${skipped.length} skipped`);
  console.log(failures.length ? `\n${failures.length} failed:\n${failures.join("\n")}` : "\nall passed");
  process.exit(failures.length ? 1 : 0);
}

export { base, swapped, shadowing, engine, seen, skip, check, watchBusy, busyEnded, precommits, entriesWhileRecordingAddresses, within, readWithin, actWithin, cameWithin, pause, steps, pollFor, cleanUp, exchange, letThrough, opened, closeContext };
