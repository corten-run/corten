// Browser smoke test of every runtime behavior, against the watchlist example, in Chromium, Firefox
// and WebKit (Playwright's builds: `npx playwright install chromium firefox webkit`).
// Usage: node scripts/smoke.mjs [http://localhost:18480] [chromium|firefox|webkit ...]
import { chromium, firefox, webkit } from "@playwright/test";
import { retrying, steady } from "./steady.mjs";
import http from "node:http";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { stall } from "./stall.mjs";
import { browserBug } from "./browser-bugs.mjs";

const base = process.argv[2] ?? "http://localhost:18480";
const engines = { chromium, firefox, webkit };
/**
 * The runtime swaps this request's answer into the page (`corten: nav` or `action`); the page it
 * fetches whole after a write asks with `corten: page` and is drawn as a full load's.
 * @param {import("@playwright/test").Request} r
 */
const swapped = (r) => ["nav", "action"].includes(r.headers()["corten"] ?? "");
const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(engines);
// The markup this test writes into pages goes through a policy of its own, which the watchlist
// allows only when run with SMOKE_TRUSTED_TYPES=1 (CONTRIBUTING): without it, say so here rather
// than fail at each case it sets up.
{
  const csp = (await fetch(base)).headers.get("content-security-policy") ?? "";
  if (!/trusted-types corten smoke\b/.test(csp)) {
    console.error(`The watchlist at ${base} does not allow the test's Trusted Types policy: run it with -e SMOKE_TRUSTED_TYPES=1.\n${csp}`);
    process.exit(1);
  }
}
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
/** What `watchBusy` saw, once the mark has gone. @param {import("@playwright/test").Page} page */
const busyEnded = (page) =>
  page
    .waitForFunction(() => /** @type {any} */ (window).__busy.then && /** @type {any} */ (window).__busy, undefined, { timeout: 5000 })
    .then(
      (handle) => handle.jsonValue(),
      () => page.evaluate(() => /** @type {any} */ (window).__busy),
    );

// A live stream is compressed for clients that accept it and flushed after each event: the
// first event decodes while the stream is still open.
engine = "http";
/** @param {string} accept @returns {Promise<{ coding: string | undefined, first: string }>} */
const liveEvent = (accept) =>
  new Promise((resolve, reject) => {
    const req = http.get(`${base}/live/trades`, { headers: { "accept-encoding": accept } }, (res) => {
      const coding = res.headers["content-encoding"];
      const body = coding === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
      let text = "";
      const timer = setTimeout(() => (req.destroy(), resolve({ coding, first: text })), 5000);
      body.on("data", (chunk) => {
        text += chunk.toString();
        if (text.includes("event: patch")) {
          clearTimeout(timer);
          req.destroy();
          resolve({ coding, first: text });
        }
      });
      body.on("error", () => {});
    });
    req.on("error", (e) => (e.message.includes("socket hang up") ? undefined : reject(e)));
  });
{
  const zstd = await liveEvent("gzip, deflate, br, zstd");
  check("a live stream is zstd for a client that accepts it", zstd.coding === "zstd", String(zstd.coding));
  const br = await liveEvent("gzip, br");
  check("a live stream's first event decodes before the stream ends (brotli, flushed per event)", br.coding === "br" && br.first.includes("Last trade"), `${br.coding}: ${br.first.slice(0, 60)}`);
  const plain = await liveEvent("gzip");
  check("a gzip-only client gets the stream as it is", plain.coding === undefined && plain.first.includes("event: patch"), String(plain.coding));
}

// A DNS-rebound page reaches the server under a name the app is not: 421, and nothing of the app.
{
  /** @param {string} host @returns {Promise<[number | undefined, string]>} */
  const get = (host) =>
    new Promise((resolve, reject) => {
      const req = http.get(base, { headers: { host } }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve([res.statusCode, text]));
      });
      req.on("error", reject);
    });
  const port = new URL(base).port;
  const [rebound, body] = await get(`rebound.attacker.example:${port}`);
  check("a request for another host (DNS rebinding) is misdirected", rebound === 421 && !body.includes("<html"), `${rebound} ${body.slice(0, 40)}`);
  const [local] = await get(`localhost:${port}`);
  check("localhost is answered", local === 200, String(local));
}

/**
 * Requests the browser's pages have sent and not finished, with when each was sent: printed when
 * a run throws (a page that never fires `load`), so the report says which one hangs (#232, #252).
 * A request leaves when it finishes or fails, or when its page or context closes.
 * @type {Map<import("@playwright/test").Request, { at: number, context: import("@playwright/test").BrowserContext }>}
 */
const inflight = new Map();
/** @param {import("@playwright/test").Browser} browser */
function track(browser) {
  /** @param {(r: import("@playwright/test").Request, at: { context: import("@playwright/test").BrowserContext }) => boolean} gone */
  const drop = (gone) => {
    for (const [r, at] of inflight) if (gone(r, at)) inflight.delete(r);
  };
  /** @param {import("@playwright/test").Request} r */
  const pageOf = (r) => {
    try {
      return r.frame().page();
    } catch {
      return null; // a service worker's request has no frame
    }
  };
  // `newPage` makes its context through `newContext`, so every context is watched here.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    context.on("request", (r) => inflight.set(r, { at: Date.now(), context }));
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
      try {
        policy = /** @type {any} */ (globalThis).trustedTypes?.createPolicy("smoke", { createHTML: (/** @type {string} */ html) => html });
      } catch {
        // A page whose policy does not name it (another app's): the test writes no markup there.
      }
      Object.defineProperty(window, "__html", { value: (/** @type {string} */ html) => (policy ? policy.createHTML(html) : html) });
    });
    return context;
  };
}
/** What is still loading, oldest first. */
function pending() {
  const now = Date.now();
  return [...inflight].sort((a, b) => a[1].at - b[1].at).map(([r, { at }]) => `  ${now - at}ms ${r.method()} ${r.url()} (${r.resourceType()})`);
}

for (engine of names) {
  const browser = steady(await engines[engine].launch({ headless: true }));
  track(browser);
  trusting(browser);
  try {
    await run(browser);
  } catch (error) {
    console.log(`[${engine}] still loading when it failed:\n${pending().join("\n") || "  nothing"}`);
    throw error;
  } finally {
    inflight.clear();
    await browser.close();
  }
}
if (skipped.length) console.log(`\n${skipped.length} skipped`);
console.log(failures.length ? `\n${failures.length} failed:\n${failures.join("\n")}` : "\nall passed");
process.exit(failures.length ? 1 : 0);

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

/** @param {import("@playwright/test").Browser} browser */
async function run(browser) {
  // A console error the browser logs for its own bug (scripts/browser-bugs.mjs) is not the page's.
  const bug = browserBug(browser);
  // A navigation Chromium aborts gives way to its error page, which would interrupt a retry made at
  // once (#839). The smoke's retry is for ERR_NETWORK_CHANGED, which a test cannot make; an abort it
  // can make (a refused connection, once) takes the same path.
  if (engine === "chromium") {
    for (const from of ["a page", "an error page"]) {
      const aborted = retrying(await (await browser.newContext()).newPage(), "net::ERR_CONNECTION_REFUSED");
      if (from === "an error page") {
        // A failure the retry is not for, its error page shown and loaded before the check.
        await aborted.route(`${base}/?e`, (route) => route.abort("addressunreachable"));
        const shown = aborted.waitForEvent("framenavigated", {
          predicate: (frame) => frame === aborted.mainFrame() && frame.url().startsWith("chrome-error://"),
        });
        await aborted.goto(`${base}/?e`).catch(() => {});
        await shown;
        await aborted.waitForLoadState("load");
      }
      const start = aborted.url();
      let first = true;
      await aborted.route(`${base}/`, (route) => {
        if (!first) return route.continue();
        first = false;
        return route.abort("connectionrefused");
      });
      const outcome = await aborted.goto(`${base}/`).then(
        (res) => String(res?.status()),
        (e) => String(e.message).split("\n")[0],
      );
      const fromErrorPage = start.startsWith("chrome-error://");
      check(
        `a navigation Chromium aborted is tried again after its error page, not interrupted by it, from ${from}`,
        outcome === "200" && !first && fromErrorPage === (from === "an error page"),
        `${outcome} from ${start}${first ? ", never aborted" : ""}`,
      );
      await aborted.context().close();
    }
  }
  const page = await browser.newPage();
  const errors = [];
  // Firefox logs an open stream that a full page load cuts (data-reload, an error page, a section
  // stylesheet that failed), and the stream the status check drops on purpose, as an error, in one
  // of two wordings.
  const cut = /was interrupted while the page was loading|can.t establish a connection to the server at \S+\/live\/(trades|flaky)/;
  // While `located` is set, each error is named with where it came from (Chromium and WebKit
  // give a failed resource's URL only there): the feed checks below tell their own errors apart.
  let located = false;
  page.on("console", (m) => {
    const text = m.type() === "error" ? m.text() : "";
    if (!text || bug(text) || cut.test(text)) return;
    const at = located ? m.location()?.url : "";
    errors.push(at ? `${text} at ${at}` : text);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  // Every EventSource the page opens, to see which are still open.
  await page.addInitScript(() => {
    const sources = ((/** @type {any} */ (window)).__sources = /** @type {EventSource[]} */ ([]));
    window.EventSource = class extends EventSource {
      /** @param {ConstructorParameters<typeof EventSource>} args */
      constructor(...args) {
        super(...args);
        sources.push(this);
      }
    };
  });
  /** @param {string} part */
  const openStreams = (part) =>
    page.evaluate((p) => (/** @type {any} */ (window)).__sources.filter((/** @type {EventSource} */ s) => s.url.includes(p) && s.readyState !== EventSource.CLOSED).length, part);
  const openFeeds = () => openStreams("/feed/");
  /** Every feed source the page has opened, oldest first: true while open. */
  const feedSources = () =>
    page.evaluate(() => (/** @type {any} */ (window)).__sources.filter((/** @type {EventSource} */ s) => s.url.includes("/feed/")).map((/** @type {EventSource} */ s) => s.readyState !== EventSource.CLOSED));
  // The next /watch post waits this long before reaching the server, or fails as if offline.
  let delayWatch = 0;
  let failWatch = false;
  /** @type {string[]} */
  const abandoned = [];
  /** The requests failed on purpose, which are not abandoned. */
  const offline = new Set();
  await page.route("**/watch", async (route) => {
    const wait = delayWatch;
    delayWatch = 0;
    if (failWatch) {
      failWatch = false;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      offline.add(route.request());
      return route.abort("internetdisconnected");
    }
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    await route.continue().catch(() => {});
  });
  // Navigation requests the runtime sends (`corten: nav`), prefetches included.
  /** @type {string[]} */
  const navRequests = [];
  page.on("request", (request) => request.headers()["corten"] === "nav" && navRequests.push(`${request.url()}${request.headers()["purpose"] === "prefetch" ? " (prefetch)" : ""}`));
  page.on("requestfailed", (request) => {
    const error = request.failure()?.errorText ?? "";
    if (request.url().endsWith("/watch") && !offline.has(request)) abandoned.push(error);
  });

  // Playwright's WebKit with the Navigation API (its Linux build) loses track of the page once the
  // runtime intercepts a navigation: every later action waits for a navigation that never ends.
  // WebKit's swaps are checked from inside the page here; the rest of the run hides the API, so
  // its navigations are full page loads, the documented fallback.
  if (engine === "webkit") {
    const probe = await browser.newPage();
    await probe.goto(base);
    if (await probe.evaluate(() => "navigation" in window)) {
      const seen = await probe.evaluate(async () => {
        const until = async (/** @type {() => boolean} */ done) => {
          for (let i = 0; i < 100 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
          return done();
        };
        (/** @type {any} */ (window)).__marker = 1;
        /** @type {HTMLAnchorElement} */ (document.querySelector('header a[href="/news"]')).click();
        const news = await until(() => document.title === "News | Watchlist");
        const note = document.querySelector(".disclaimer__note");
        const border = note ? getComputedStyle(note).borderInlineStartWidth : "";
        history.back();
        const back = await until(() => document.title === "Stocks | Watchlist");
        return { news, border, back, kept: (/** @type {any} */ (window)).__marker === 1, path: location.pathname };
      });
      check(
        "WebKit swaps a page in with its section stylesheet loaded, and back restores the last one",
        seen.news && seen.border === "4px" && seen.back && seen.kept && seen.path === "/",
        JSON.stringify(seen),
      );
    }
    await probe.close();
    await page.addInitScript(() => {
      delete (/** @type {any} */ (Window.prototype)).navigation;
      delete (/** @type {any} */ (window)).navigation;
    });
  }

  await page.goto(base);
  // Without the Navigation API every navigation is a full page load, the documented fallback: the
  // checks of what a swap keeps check that instead, or are skipped.
  const swaps = await page.evaluate(() => "navigation" in window);
  const noSwaps = "no Navigation API: navigations are full page loads";
  // Playwright's WebKit stores a Secure cookie from http://localhost but never sends it back.
  const signsIn = engine !== "webkit";
  const live = "[data-scope=live-prices]";
  await page.waitForSelector(`${live}[data-status="live"]`, { timeout: 5000 }).catch(() => {});
  check("on:connect runs the script's watch(), which subscribes to the feed", (await page.getAttribute(live, "data-status")) === "live");
  // The optional views helper, using its actual built bytes under the watchlist's CSP. This
  // fixture needs no app view class: the nested deck-builder smoke also uses generated classes.
  await page.route("**/smoke-views.js", (route) => route.fulfill({ contentType: "text/javascript", body:
    readFileSync(new URL("../crates/corten/js/dist/view.js", import.meta.url), "utf8") + "\nexport { view };\n",
  }));
  const branches = await page.evaluate(async () => {
    const { view } = await import("/smoke-views.js");
    class View { constructor(el) { this.el = el; } }
    const host = document.createElement("div");
    host.innerHTML = __html('<section id="smoke-branch-a"><label for="smoke-note">Note</label><input id="smoke-note" value="server"></section>');
    document.body.append(host);
    const template = document.createElement("template");
    template.innerHTML = __html(host.innerHTML);
    const ssr = host.firstElementChild;
    const input = host.querySelector("input");
    input.value = "draft";
    input.focus();
    const adopted = view(host, View, template).el === ssr && input.value === "draft" && document.activeElement === input;
    template.innerHTML = __html('<article id="smoke-branch-b" data-vars="--smoke-width:13px"><label for="smoke-export">Export</label><textarea id="smoke-export">text</textarea></article>');
    const branch = view(host, View, template).el;
    const copied = branch.id === "smoke-branch-b" && branch.querySelector("label").control === branch.querySelector("textarea") && branch.style.getPropertyValue("--smoke-width") === "13px";
    const external = branch.cloneNode(true);
    branch.replaceWith(external);
    const follows = view(host, View, template).el === external;
    const outside = document.createElement("div");
    outside.id = "smoke-outside";
    document.body.append(outside);
    let refused = 0;
    for (const html of [
      '<section id="smoke-new"><input id="smoke-outside"></section>',
      '<section id="smoke-new"><input id="smoke-twice"><input id="smoke-twice"></section>',
      '<section>no id</section>',
      '<section id="smoke-new"></section><p>extra root</p>',
      '<section id="smoke-new"><script></script></section>',
    ]) {
      template.innerHTML = __html(html);
      try { view(host, View, template); } catch { if (host.firstElementChild === external) refused++; }
    }
    outside.id = "smoke-export";
    template.innerHTML = __html('<section id="smoke-new"><input id="smoke-export"></section>');
    let rejectsHiddenCollision = false;
    try { view(host, View, template); } catch { rejectsHiddenCollision = host.firstElementChild === external; }
    host.remove(); outside.remove();
    return { adopted, copied, follows, refused, rejectsHiddenCollision };
  });
  check("view adopts SSR without replacing local state, focus or identity", branches.adopted);
  check("view clones a branch with intact label IDs and CSP-safe custom properties", branches.copied);
  check("view follows external replacement rather than a detached cache", branches.follows);
  check("view refuses ID collisions, malformed templates and scripts before removing the active tree", branches.refused === 5, JSON.stringify(branches));
  check("view refuses an outside ID even when the outgoing tree has the first match", branches.rejectsHiddenCollision);
  // A module the network drops twice (the page's module script, then the runtime's import of it)
  // is imported again, so on:connect still runs its handler rather than never.
  {
    const dropped = await browser.newPage();
    let tries = 0;
    let status = null;
    // What happened when, said only when the check fails, so a failure names its cause (#1053).
    /** @type {string[]} */
    const seen = [];
    const started = Date.now();
    dropped.on("console", (m) => m.type() === "error" && seen.push(`${Date.now() - started} ms: ${m.text().slice(0, 200)}`));
    try {
      await dropped.route(
        (url) => url.pathname.endsWith("/scripts/live_prices.js"),
        (route) => {
          tries += 1;
          seen.push(`${Date.now() - started} ms: request ${tries} (${route.request().resourceType()})`);
          return tries <= 2 ? route.abort("internetdisconnected") : route.continue();
        },
      );
      await dropped.goto(base);
      // The script tag fails, then the runtime's import; it is tried again 0.5 s after the import fails.
      await dropped.waitForSelector(`${live}[data-status="live"]`, { timeout: 15_000 }).catch(() => {});
      status = await dropped.getAttribute(live, "data-status");
    } finally {
      await dropped.close();
    }
    const imported = status === "live" && tries > 2;
    check("a script module whose first two requests fail is imported again, and its on:connect handler runs", imported, `${status}, ${tries} requests${imported ? "" : `: ${seen.join("; ")}`}`);
  }

  const prices = () => page.$$eval('[data-ref="price"]', (cells) => cells.map((c) => c.textContent));
  const before = await prices();
  await page.waitForFunction((b) => JSON.stringify([...document.querySelectorAll('[data-ref="price"]')].map((c) => c.textContent)) !== b, JSON.stringify(before), { timeout: 4000 }).catch(() => {});
  check("live patches update prices", JSON.stringify(await prices()) !== JSON.stringify(before), `${before.join(", ")} -> ${(await prices()).join(", ")}`);
  // Text a script computes, from the catalog: on:connect={js::watch(.., updates, t.js().prices_updates())},
  // a plural message whose form the browser picks by the count (1 price update, 2 price updates).
  const counted = await page.textContent(`${live} [data-ref="updates"]`);
  check(
    "a script fills in a plural message of the page's locale, in the count's form",
    /^(1 price update|([2-9]|[1-9][\d,]+) price updates)$/.test(counted ?? ""),
    String(counted),
  );

  // A handler with per-component state (keep()): on:click={js::pause(target, price, change)}.
  check("the script reveals its controls", await page.isVisible(`${live} button`));
  await page.click(`${live} button`);
  const paused = await prices();
  await page.waitForTimeout(2500);
  check(
    "a handler changes the component's state (pause holds the prices)",
    (await page.getAttribute(`${live} button`, "aria-pressed")) === "true" && JSON.stringify(await prices()) === JSON.stringify(paused),
  );
  await page.click(`${live} button`);
  // keep() is a handler's: called outside one it throws rather than pick a component.
  const outside = await page.evaluate(async () => {
    const corten = /** @type {{ keep: (init: () => unknown) => unknown }} */ (await import(/** @type {string} */ ("corten")));
    try {
      corten.keep(() => ({}));
      return "no error";
    } catch (error) {
      return String(error);
    }
  });
  check("keep() outside a handler throws", outside.includes("keep() outside a handler"), outside);
  // keep() is each instance's, and a parent's handler on a child's element (written
  // `/live-prices`, as the server writes it) keeps its own component's: two copies of the
  // component's markup, pressed in turn. One state for all would give true,false,true; a handler
  // keyed on the child's root, true,true,true.
  const states = await page.evaluate(() => {
    const host = document.createElement("div");
    host.hidden = true;
    const on = "click:live_prices.pause($t,#price,#change)";
    host.innerHTML = __html(`<div data-scope="live-prices"><button data-on="${on}"></button></div><div data-scope="live-prices"><div data-scope="child"><button data-on="${on}/live-prices"></button></div><button data-on="${on}"></button></div>`);
    document.body.append(host);
    const buttons = Array.from(host.querySelectorAll("button"));
    for (const button of buttons) button.click();
    host.remove();
    return buttons.map((b) => b.getAttribute("aria-pressed")).join(",");
  });
  check("keep() is each instance's, and a parent's handler in a child keeps the parent's", states === "true,true,false", states);
  // The page's prices by stock id, written by the script with the page's money format
  // (t.js().money(USD)), and the feed's, which the server wrote.
  // Today's change too: its trend, and its text.
  const shown = () =>
    page.$$eval('[data-ref="price"]', (cells) =>
      JSON.stringify(
        cells
          .map((c) => {
            const id = c.getAttribute("data-key");
            const change = document.querySelector(`[data-ref="change"][data-key="${id}"]`);
            return [id, c.textContent, change?.getAttribute("data-trend")];
          })
          .sort(),
      ),
    );
  // The feed has the whole market; the page, the stocks on the list.
  const latest = async () => {
    const ids = await page.$$eval('[data-ref="price"]', (cells) => cells.map((c) => c.getAttribute("data-key")));
    const snap = await (await fetch(`${base}/feed/stocks`, { headers: { accept: "application/json" } })).json();
    /** @param {number} bp */
    const trend = (bp) => (bp > 0 ? "up" : bp < 0 ? "down" : "flat");
    return JSON.stringify(
      snap.rows
        .filter((/** @type {{ id: string }} */ r) => ids.includes(r.id))
        .map((/** @type {{ id: string, price: string, change_bp: number }} */ r) => [r.id, r.price, trend(r.change_bp)])
        .sort(),
    );
  };
  let resumed = false;
  for (let i = 0; i < 20 && !resumed; i += 1) {
    resumed = (await shown()) === (await latest());
    if (!resumed) await page.waitForTimeout(150);
  }
  check("resuming shows the latest prices and changes", resumed && (await page.getAttribute(`${live} button`, "aria-pressed")) === "false", `${await shown()} vs ${await latest()}`);
  // on:document:keydown={js::pauseKey(..)}: a component's handler for a key pressed anywhere on
  // the page, while the component is on it. "p" pauses whatever has focus, and again resumes.
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press("p");
  const pressedByKey = await page.getAttribute(`${live} button`, "aria-pressed");
  await page.keyboard.press("p");
  check(
    "a key pressed anywhere on the page runs a component's handler for it, once",
    pressedByKey === "true" && (await page.getAttribute(`${live} button`, "aria-pressed")) === "false",
    String(pressedByKey),
  );
  // An element with a page-wide handler stops getting events when it leaves the page. The key is
  // not cancelable, so the page's own button pausing first (preventDefault) does not hide it.
  const leaves = await page.evaluate(async () => {
    const host = document.createElement("div");
    host.hidden = true;
    host.innerHTML = __html('<div data-scope="live-prices"><button data-on="document.keydown:live_prices.pauseKey($e,$t,#price,#change)"></button></div>');
    document.body.append(host);
    await new Promise((resolve) => setTimeout(resolve));
    const button = /** @type {HTMLButtonElement} */ (host.querySelector("button"));
    const press = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: false }));
    press();
    const on = button.getAttribute("aria-pressed");
    host.remove();
    await new Promise((resolve) => setTimeout(resolve));
    press();
    // The page's own button hears both presses, so it is back where it was.
    return `${on},${button.getAttribute("aria-pressed")}`;
  });
  check("a page-wide handler does not run once its element has left the page", leaves === "true,true", leaves);
  // shortcut(event) from corten/keys: pauseKey takes "p" only when the key is the page's. Pressed
  // for real: a ticked checkbox takes no letters, so "p" pauses from it; a text field and a modal
  // dialog keep it.
  const pressed = () => page.getAttribute(`${live} button`, "aria-pressed");
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "shortcut-host";
    host.innerHTML = __html(
      '<input type="checkbox" id="shortcut-box"><input id="shortcut-text"><dialog id="shortcut-dialog"><button type="button" id="shortcut-in">In</button></dialog>',
    );
    document.body.append(host);
  });
  await page.focus("#shortcut-box");
  await page.keyboard.press("p");
  const fromBox = await pressed();
  await page.keyboard.press("p");
  check("a shortcut's key pressed on a checkbox is the page's", fromBox === "true" && (await pressed()) === "false", String(fromBox));
  await page.focus("#shortcut-text");
  await page.keyboard.press("p");
  const typed = await page.inputValue("#shortcut-text");
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("shortcut-dialog")).showModal());
  await page.focus("#shortcut-in");
  await page.keyboard.press("p");
  const inDialog = await pressed();
  // A patch removes the focused button: focus falls to <body>, and the modal still holds the page.
  await page.evaluate(() => document.getElementById("shortcut-in")?.remove());
  await page.keyboard.press("p");
  const behindModal = await pressed();
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("shortcut-dialog")).close());
  // Fullscreen is :modal too, and is not a dialog: the page's shortcuts still work in it.
  await page.evaluate(() => {
    const go = document.createElement("button");
    go.id = "shortcut-full";
    go.textContent = "Full";
    go.addEventListener("click", () => document.documentElement.requestFullscreen().catch(() => {}));
    document.getElementById("shortcut-host")?.append(go);
  });
  await page.click("#shortcut-full");
  await page.waitForFunction(() => document.fullscreenElement !== null, null, { timeout: 2000 }).catch(() => {});
  if (await page.evaluate(() => document.fullscreenElement === null)) skip("a shortcut works in fullscreen", "the browser did not go fullscreen");
  else {
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    await page.keyboard.press("p");
    const full = await pressed();
    await page.keyboard.press("p");
    await page.evaluate(() => document.exitFullscreen());
    check("a shortcut works in fullscreen", full === "true" && (await pressed()) === "false", String(full));
  }
  check(
    "a shortcut's key typed in a field, pressed in a modal dialog or with focus fallen to <body> behind one is not the page's",
    typed === "p" && inDialog === "false" && behindModal === "false",
    `${typed} ${inDialog} ${behindModal}`,
  );
  // Each rule, with the key it gives, from events dispatched where the rule applies.
  const shortcuts = await page.evaluate(async () => {
    const { shortcut } = await import("corten/keys");
    const host = /** @type {HTMLElement} */ (document.getElementById("shortcut-host"));
    host.insertAdjacentHTML(
      "beforeend",
      __html(`<div id="sk-scope"><button id="sk-button">B</button><input type="checkbox" id="sk-check"><input type="radio" id="sk-radio"><input type="range" id="sk-range"><span role="switch" tabindex="0" id="sk-switch">S</span><ul role="listbox"><li role="option" id="sk-option">O</li></ul><div role="tablist"><span role="tab" tabindex="0" id="sk-tab">T</span></div><div role="radiogroup"><span role="radio" tabindex="0" id="sk-aria-radio">R</span></div><div role="grid"><div role="row"><span role="gridcell" tabindex="0" id="sk-cell">C</span></div></div><span role="slider" tabindex="0" id="sk-slider">S</span><select id="sk-select"><option>a</option></select><span role="combobox" tabindex="0" id="sk-combo"></span><span role="searchbox" tabindex="0" id="sk-search"></span><span role="spinbutton" tabindex="0" id="sk-spin"></span><a href="#" id="sk-link">L</a><span role="link" tabindex="0" id="sk-aria-link">L</span><details><summary id="sk-summary">S</summary></details><div role="alertdialog" id="sk-alert"><button id="sk-in-alert">A</button></div><textarea id="sk-area"></textarea><div contenteditable id="sk-edit"></div><span role="textbox" id="sk-textbox"></span><div popover id="sk-pop"><button id="sk-in-pop">P</button></div><div role="dialog" id="sk-aria-dialog"><button id="sk-in-aria">D</button></div><dialog id="sk-dialog"><div id="sk-dialog-scope"><button id="sk-in-dialog">D</button></div></dialog></div><button id="sk-outside">Out</button><span id="sk-shadow"></span>`),
    );
    const shadow = /** @type {HTMLElement} */ (document.getElementById("sk-shadow")).attachShadow({ mode: "open" });
    shadow.innerHTML = __html("<input>");
    const at = (/** @type {string} */ id) => /** @type {Element} */ (document.getElementById(id));
    /** @param {KeyboardEventInit & { prevent?: boolean }} init @param {Element} [on] @param {Element} [scope] */
    const of = ({ prevent, ...init }, on = document.body, scope) => {
      /** @type {string | null | undefined} */
      let got;
      if (prevent) on.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
      document.addEventListener("keydown", (e) => (got = shortcut(e, scope)), { once: true });
      on.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, ...init }));
      return `${init.key}=${got}`;
    };
    const k = { key: "k" };
    const rows = [
      of({ key: "P", shiftKey: true }),
      of({ key: "K" }),
      of({ key: "s", ctrlKey: true, shiftKey: true }),
      of({ key: " " }),
      of({ key: " ", shiftKey: true }),
      of({ key: "+" }),
      of({ key: "?", shiftKey: true }),
      of({ key: "Enter" }),
      of({ ...k, prevent: true }),
      of({ ...k, isComposing: true }),
      of({ ...k, keyCode: 229 }),
      of({ key: "@", ctrlKey: true, altKey: true, modifierAltGraph: true }),
      of({ key: "s", metaKey: true }, at("shortcut-text")),
      of({ key: "s" }, at("shortcut-text")),
      of({ key: "ArrowLeft", ctrlKey: true }, at("shortcut-text")),
      of({ key: "Backspace", metaKey: true }, at("sk-area")),
      of(k, at("sk-edit")),
      of(k, at("sk-textbox")),
      of(k, /** @type {Element} */ (shadow.querySelector("input"))),
      of(k, at("sk-select")),
      of(k, at("sk-combo")),
      of(k, at("sk-search")),
      of(k, at("sk-spin")),
      of(k, at("sk-range")),
      of({ key: " " }, at("sk-button")),
      of({ key: "Enter" }, at("sk-check")),
      of({ key: " " }, at("sk-switch")),
      of({ key: "Enter" }, at("sk-link")),
      of({ key: "Enter" }, at("sk-aria-link")),
      of({ key: " " }, at("sk-summary")),
      of({ key: " " }, at("sk-tab")),
      of(k, at("sk-button")),
      of({ key: "ArrowLeft" }, at("sk-radio")),
      of({ key: "End" }, at("sk-range")),
      of({ key: "PageUp" }, at("sk-slider")),
      of({ key: "ArrowLeft" }, at("sk-check")),
      of(k, at("sk-option")),
      of({ ...k, ctrlKey: true }, at("sk-option")),
      of({ key: "ArrowDown" }, at("sk-option")),
      of(k, at("sk-tab")),
      of({ key: "ArrowRight" }, at("sk-tab")),
      of(k, at("sk-aria-radio")),
      of({ key: "ArrowDown" }, at("sk-aria-radio")),
      of(k, at("sk-cell")),
      of({ key: "Home" }, at("sk-cell")),
      of(k, at("sk-in-pop")),
      of(k, at("sk-in-aria")),
      of(k, at("sk-in-alert")),
      of(k, at("sk-in-dialog")),
      of(k, at("sk-in-dialog"), at("sk-dialog-scope")),
      of(k, at("sk-outside"), at("sk-scope")),
      of(k, at("sk-button"), at("sk-scope")),
      of(k, document.body, at("sk-scope")),
    ];
    /** @type {HTMLDialogElement} */ (at("sk-dialog")).showModal();
    rows.push(of(k), of(k, document.body, at("sk-dialog-scope")));
    /** @type {HTMLDialogElement} */ (at("sk-dialog")).close();
    // WebKit 27.2 reports its own style on the <select> later; removed first, the report would
    // name the document rather than the select it filters on (scripts/browser-bugs.mjs).
    await new Promise((resolve) => setTimeout(resolve, 100));
    host.remove();
    return rows.join(" ");
  });
  const expected = [
    "P=Shift+P K=k s=Control+Shift+S  =Space  =Shift+Space +=Plus ?=? Enter=Enter k=null k=null k=null @=null",
    "s=Meta+s s=null ArrowLeft=null Backspace=null k=null k=null k=null k=null k=null k=null k=null k=k",
    " =null Enter=null  =null Enter=null Enter=null  =null  =null k=k",
    "ArrowLeft=null End=null PageUp=null ArrowLeft=ArrowLeft",
    "k=null k=Control+k ArrowDown=null k=k ArrowRight=null k=k ArrowDown=null k=k Home=null",
    "k=null k=null k=null k=null k=k k=null k=k k=k k=null k=k",
  ].join(" ");
  check("shortcut() gives each key with its modifiers, and null for each key something else has", shortcuts === expected, shortcuts);
  // A change's text is the move in money since the open, signed (t.js().signed_money(USD), as the
  // server's t.signed_money), then a percent whose sign is its trend's.
  const changes = await page.$$eval('[data-ref="change"]', (cells) => cells.map((c) => [c.textContent ?? "", c.getAttribute("data-trend")]));
  check(
    "today's move in money is signed: a plus sign up, a minus down, none when flat",
    changes.length > 0 &&
      changes.every(([text, trend]) => {
        const moved = text.split(" ")[0];
        // The percent is rounded to basis points, so a cent's move may still be flat there.
        const zero = !/[1-9]/.test(moved);
        return /^[-+]?\$\d+\.\d{2}$/.test(moved) && (zero ? trend === "flat" && /^\$/.test(moved) : moved.startsWith("+") ? trend !== "down" : moved.startsWith("-") && trend !== "up");
      }),
    JSON.stringify(changes),
  );
  check(
    "today's change is a percent with its trend",
    changes.length > 0 &&
      changes.every(([text, trend]) => {
        // The trend follows the percent (the last word), not the money before it: a cent's move
        // can round to 0.00% and be flat. The percent has a sign exactly when it is not zero
        // (signDisplay "exceptZero"): a plus up, a minus down.
        const percent = text.split(" ").at(-1) ?? "";
        const sign = percent[0] === "+" ? "up" : /^[-\u2212]/.test(percent) ? "down" : "flat";
        return /%$/.test(percent) && (sign === "flat") === !/[1-9]/.test(percent) && trend === sign;
      }),
    JSON.stringify(changes),
  );

  // Many rows joining at once are scanned for ref names one query per name: a name that only the
  // last of them has still refreshes the refs the component has cached (pause just resolved them).
  await page.click(`${live} button`);
  await page.evaluate((live) => {
    const body = /** @type {HTMLTableSectionElement} */ (document.querySelector(`${live} tbody`));
    const old = /** @type {HTMLElement} */ (body.querySelector('[data-ref="price"][data-key="ACME"]'));
    old.removeAttribute("data-ref");
    old.id = "old-s1";
    const rows = document.createDocumentFragment();
    for (let i = 0; i < 20; i += 1) {
      const tr = document.createElement("tr");
      tr.className = "wide";
      tr.innerHTML = __html(i < 19 ? '<td data-ref="note">n</td>' : '<td data-ref="price" data-key="ACME" id="new-s1">-</td>');
      rows.append(tr);
    }
    body.append(rows);
  }, live);
  await page.click(`${live} button`);
  const repainted = await page.textContent("#new-s1");
  check("a ref name only the last row of a 20-row insert has is found", repainted !== "-", String(repainted));
  await page.evaluate(() => {
    for (const tr of Array.from(document.querySelectorAll("tr.wide"))) tr.remove();
    const old = /** @type {HTMLElement} */ (document.getElementById("old-s1"));
    old.setAttribute("data-ref", "price");
    old.removeAttribute("id");
  });

  // A marker on window survives client navigations and patches, and disappears on a full load.
  await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 1));
  const sourcesBefore = await feedSources();
  await page.selectOption("select[name=id]", "HLTH");
  await page.click("#watch-form button");
  await page.waitForFunction(() => document.getElementById("watch-message")?.textContent?.startsWith("Watching Halcyon Health"));
  check("form patch replaces the message by id", true);
  check("watching a stock adds its row, and the form no longer offers it", (await page.$('[data-ref="price"][data-key="HLTH"]')) !== null && (await page.$('select[name=id] option[value="HLTH"]')) === null);
  await page.waitForSelector(`${live}[data-status="live"]`, { timeout: 5000 }).catch(() => {});
  const sources = await feedSources();
  check(
    "the list a patch put in subscribes again, and the one it replaced closes its stream",
    sources.length === sourcesBefore.length + 1 && sources.at(-1) === true && sources.slice(0, -1).every((open) => !open),
    `${JSON.stringify(sourcesBefore)} -> ${JSON.stringify(sources)}`,
  );
  // The list is kept on the server, under the browser's cookie: the page read again shows it.
  if (signsIn) {
    const kept = await page.evaluate(async () => (await (await fetch("/")).text()).includes('data-ref="price" class="live-prices__amount" data-key="HLTH"'));
    check("the list is the same after a reload", kept);
  } else skip("the list is the same after a reload", "Playwright's WebKit never sends a Secure cookie back over http");
  check("form patch keeps the page", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1));
  // A row's Remove button submits the watch form to /unwatch.
  await page.click('button[formaction="/unwatch"][value="HLTH"]');
  await page.waitForFunction(() => document.getElementById("watch-message")?.textContent === "Stopped watching Halcyon Health.", null, { timeout: 4000 }).catch(() => {});
  check(
    "unwatching a stock takes its row away and offers it again",
    (await page.$('[data-ref="price"][data-key="HLTH"]')) === null && (await page.$('select[name=id] option[value="HLTH"]')) !== null,
    String(await page.textContent("#watch-message")),
  );

  // <corten-live src>: the server streams fragments and the runtime swaps them in by id.
  const firstTrade = await page.textContent("#last-trade");
  await page.waitForFunction((t) => document.getElementById("last-trade")?.textContent !== t, firstTrade, { timeout: 4000 }).catch(() => {});
  // A trade a second: one drawn in four seconds is a fragment the runtime applied.
  const nextTrade = (await page.textContent("#last-trade")) ?? "";
  check("<corten-live> swaps in the fragments the server streams", nextTrade.startsWith("Last trade: ") && nextTrade !== firstTrade, `${firstTrade} -> ${nextTrade}`);

  // Only what the page's own origin answered goes through the runtime's policy: not another
  // origin's answer (one connect-src allows), a Response a script made, or an event a script
  // dispatched. On a page of its own, whose CSP lets it reach the other origin.
  {
    const csp = (await page.request.get(base)).headers()["content-security-policy"] ?? "";
    check("pages require Trusted Types and allow the runtime's, the app's and the script loader's policies", /; require-trusted-types-for 'script'; trusted-types corten smoke default$/.test(csp), csp);
    const other = "http://other.test";
    const probe = await browser.newPage();
    /** @type {string[]} */
    const said = [];
    probe.on("console", (m) => m.type() === "error" && said.push(m.text()));
    let opened = false;
    await probe.route(`${base}/`, async (route) => {
      // Unencoded: Playwright does not decode Firefox's zstd for a fulfilled body.
      const response = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
      const headers = response.headers();
      const csp = headers["content-security-policy"] ?? "";
      headers["content-security-policy"] = csp.replace("connect-src 'self'", `connect-src 'self' ${other}`);
      opened ||= headers["content-security-policy"] !== csp;
      await route.fulfill({ response, headers });
    });
    await probe.route(`${other}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: { "access-control-allow-origin": new URL(base).origin, "access-control-allow-headers": "*", "access-control-expose-headers": "corten-patch", "corten-patch": "1" },
        body: '<p id="watch-message">From another origin</p>',
      }),
    );
    await probe.goto(`${base}/`);
    // The stream need not be open (a third stream to this host can wait in Firefox): the checks
    // need only the element's EventSource.
    await probe.waitForFunction(() => /** @type {any} */ (document.querySelector("corten-live"))?.source);
    const logged = probe.waitForEvent("console", { predicate: (m) => m.text().includes("an event a script dispatched"), timeout: 3000 }).catch(() => {});
    const [cross, made, dispatched] = await probe.evaluate(async (other) => {
      const message = () => document.getElementById("watch-message")?.textContent ?? "";
      /** A data-patch form posting to `action`: whether the runtime said it drew nothing, and the message after. @param {string} action */
      const submit = async (action) => {
        const form = document.createElement("form");
        form.method = "post";
        form.action = action;
        form.setAttribute("data-patch", "");
        const button = document.createElement("button");
        form.append(button);
        /** @type {HTMLElement} */ (document.querySelector("main")).append(form);
        // The answer came (200) and was not drawn; a fetch that failed would say status 0.
        const refused = new Promise((resolve) => form.addEventListener("corten:error", (e) => resolve(/** @type {CustomEvent} */ (e).detail.status), { once: true }));
        button.click();
        const said = await Promise.race([refused, new Promise((resolve) => setTimeout(() => resolve("none"), 5000))]);
        form.remove();
        return [said, message()].join(" / ");
      };
      const cross = await submit(`${other}/watch`);
      const fetch = window.fetch;
      window.fetch = async () => new Response('<p id="watch-message">Made by a script</p>', { headers: { "corten-patch": "1" } });
      const made = await submit("/watch");
      window.fetch = fetch;
      const live = /** @type {any} */ (document.querySelector("corten-live"));
      live.source.dispatchEvent(new MessageEvent("patch", { data: '<p id="last-trade">Dispatched</p>', origin: location.origin }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return [cross, made, document.getElementById("last-trade")?.textContent ?? ""];
    }, other);
    await logged;
    check("another origin's data-patch answer is not drawn", opened && cross.startsWith("200 / ") && !cross.includes("From another origin"), `${opened ? "" : "CSP not opened; "}${cross}`);
    check("a Response a script made is not drawn", made.startsWith("200 / ") && !made.includes("Made by a script"), made);
    check("an event a script dispatches on <corten-live> is not drawn", dispatched !== "Dispatched" && said.some((s) => s.includes("an event a script dispatched")), `${dispatched}; ${said.join(" | ")}`);
    await probe.close();
  }
  // An origin the page's script-src lists (the app's, under this test) is one a script loads from the usual way,
  // `script.src = ..`, through the `default` policy `<Corten />` makes, and so is a part the loaded
  // script loads itself (an SDK's). The policy passes nothing else: a URL on this origin or a
  // `data:` one, or markup from a string, is still refused, and an origin the page does not list
  // is blocked by the CSP.
  {
    const loader = await browser.newPage();
    await loader.route("http://scripts.test/**", (route) => {
      const body = route.request().url().endsWith("/sdk.js")
        ? 'window.smokeSdk = "loaded"; const part = document.createElement("script"); part.src = "http://scripts.test/part.js"; document.head.append(part);'
        : 'window.smokePart = "loaded";';
      return route.fulfill({ contentType: "text/javascript", body });
    });
    await loader.goto(`${base}/`);
    const loads = await loader.evaluate(async () => {
      const w = /** @type {any} */ (window);
      /** @param {() => void} set */
      const outcome = (set) => {
        try {
          set();
          return "set";
        } catch (e) {
          return e instanceof TypeError ? "refused" : String(e);
        }
      };
      const sdk = document.createElement("script");
      const other = outcome(() => (sdk.src = "http://scripts.test/sdk.js"));
      document.head.append(sdk);
      const deadline = Date.now() + 5000;
      while (!(w.smokeSdk && w.smokePart) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const own = outcome(() => (document.createElement("script").src = "/assets/nothing.js"));
      const data = outcome(() => (document.createElement("script").src = "data:text/javascript,1"));
      const unlisted = await new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = "http://unlisted.test/x.js";
        script.onload = () => resolve("loaded");
        script.onerror = () => resolve("blocked");
        document.head.append(script);
      });
      const markup = outcome(() => (document.createElement("div").innerHTML = "<b>x</b>"));
      return { other, sdk: w.smokeSdk ?? "", part: w.smokePart ?? "", own, data, unlisted, markup };
    });
    await loader.close();
    check(
      "a script loads from an origin the page's script-src lists, and so do the parts it loads; a URL on this origin, a data: URL and markup stay refused, and an unlisted origin is blocked",
      loads.other === "set" && loads.sdk === "loaded" && loads.part === "loaded" && loads.own === "refused" && loads.data === "refused" && loads.unlisted === "blocked" && loads.markup === "refused",
      JSON.stringify(loads),
    );
    // The policy is there before a script after `<Corten />` runs: a listed-host `<script src>` the
    // parser meets next sets a script's `src` as it runs, before the page is parsed. One before
    // `<Corten />` that makes `default` itself is named in the console.
    const tag = "<script>self.trustedTypes&&(";
    /** @param {(html: string) => string} edit */
    const edited = async (edit) => {
      const early = await browser.newPage();
      /** @type {string[]} */
      const said = [];
      early.on("console", (m) => said.push(m.text()));
      await early.route("http://scripts.test/**", (route) => {
        const url = route.request().url();
        const body = url.endsWith("/early.js")
          ? 'try { document.createElement("script").src = "http://scripts.test/later.js"; window.smokeEarly = document.readyState; } catch (e) { window.smokeEarly = String(e); }'
          : 'trustedTypes.createPolicy("default", { createScriptURL: (u) => u }); window.smokeFirst = "made";';
        return route.fulfill({ contentType: "text/javascript", body });
      });
      await early.route(`${base}/`, async (route) => {
        // Uncompressed, since Playwright's Firefox hands a zstd body over undecoded.
        const response = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        return route.fulfill({ response, body: edit(await response.text()) });
      });
      await early.goto(`${base}/`);
      const seen = await early.evaluate(() => ({ early: /** @type {any} */ (window).smokeEarly ?? "", first: /** @type {any} */ (window).smokeFirst ?? "" }));
      await early.close();
      return { ...seen, told: said.some((s) => s.includes("a script before <Corten /> made the default Trusted Types policy")) };
    };
    const after = await edited((html) => {
      const at = html.indexOf("</script>", html.indexOf(tag)) + "</script>".length;
      return `${html.slice(0, at)}<script src="http://scripts.test/early.js"></script>${html.slice(at)}`;
    });
    check("a script right after <Corten /> sets a script's src while the page is parsed", after.early === "loading" && !after.told, JSON.stringify(after));
    const before = await edited((html) => html.replace(tag, `<script src="http://scripts.test/first.js"></script>${tag}`));
    check("a script before <Corten /> that makes the default policy is named in the console", before.first === "made" && before.told, JSON.stringify(before));
  }

  // A submit the network fails: the form stays, and the page hears about it.
  const failed = page.evaluate(
    () =>
      new Promise((resolve) =>
        document.addEventListener("corten:error", (e) => resolve([/** @type {CustomEvent} */ (e).detail.status, e.cancelable]), { once: true }),
      ),
  );
  failWatch = true;
  const messageBefore = await page.textContent("#watch-message");
  await page.click("#watch-form button");
  check("a submit the network fails dispatches corten:error with status 0, cancelable", JSON.stringify(await failed) === "[0,true]");
  check(
    "a failed submit leaves the page and the form as they were",
    (await page.textContent("#watch-message")) === messageBefore && (await page.getAttribute("#watch-form", "aria-busy")) === null,
  );
  // The form's on:corten:error runs (the runtime's event, on the form): it says the change failed.
  const told = await page.waitForSelector("#watch-form [role=alert]", { state: "visible", timeout: 5000 }).then(() => true, () => false);
  check("a form's on:corten:error handler runs for a submit the network fails", told);
  // A form with controls named hasAttribute and getAttribute still runs its handlers, as the
  // runtime reads its attributes through Element's own methods: the form the page loaded with,
  // hearing an event that bubbles, and copies put in after load, bound to an event no element
  // listened for until they joined (so only the runtime's scan of them can hear it), one hearing
  // it bubble and one not.
  const shadowed = await page.evaluate(async () => {
    const names = ["hasAttribute", "getAttribute"];
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
    try {
      return {
        loaded: heard("watch-form", "corten:error", true),
        added: heard("smoke-1-watch-form", "smoke-shadowed-1", true),
        notBubbling: heard("smoke-2-watch-form", "smoke-shadowed-2", false),
        closest: closest(),
      };
    } finally {
      for (const n of [1, 2]) document.getElementById(`smoke-${n}-watch-form`)?.remove();
      for (const name of names) document.querySelector(`#watch-form > input[name="${name}"]`)?.remove();
    }
  });
  check(
    "a form with controls named hasAttribute and getAttribute runs its handlers, loaded with the page or added after, for events that bubble or not",
    shadowed.loaded && shadowed.added && shadowed.notBubbling && shadowed.closest,
    JSON.stringify(shadowed),
  );
  // A newer submit that waited for a write the network failed is not sent: it would fail the
  // same way, and the user sends it again.
  let afterFailure = 0;
  /** @param {import("@playwright/test").Request} r */
  const onRetry = (r) => r.method() === "POST" && r.url().endsWith("/watch") && (afterFailure += 1);
  const failedAgain = page.evaluate(() => new Promise((resolve) => document.addEventListener("corten:error", resolve, { once: true })));
  page.on("request", onRetry);
  delayWatch = 600;
  failWatch = true;
  await page.click("#watch-form button");
  // Another stock the form still offers, so the newer submit differs from the one it waits for.
  const other = await page.$eval("select[name=id]", (s) =>
    [.../** @type {HTMLSelectElement} */ (s).options].map((o) => o.value).find((v) => v && v !== /** @type {HTMLSelectElement} */ (s).value),
  );
  check("the form offers another stock to send", other !== undefined);
  if (other) await page.selectOption("select[name=id]", other);
  await page.click("#watch-form button");
  await failedAgain;
  await page.waitForTimeout(500);
  page.off("request", onRetry);
  check("a submit that waited for a write the network failed is not sent", afterFailure === 1, `posts: ${afterFailure}`);

  // A submit key (SubmitKey::field) is sent again until the submission has an answer, then renewed
  // as another UUID v4.
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
  page.on("request", keyOf);
  const keyedFailed = page.evaluate(() => new Promise((resolve) => document.addEventListener("corten:error", resolve, { once: true })));
  failWatch = true;
  await page.click("#keyed button");
  await keyedFailed;
  const kept = await page.inputValue("#keyed [name=submit]");
  await page.click("#keyed button");
  await page.waitForFunction((zero) => /** @type {HTMLInputElement | null} */ (document.querySelector("#keyed [name=submit]"))?.value !== zero, zero, { timeout: 5000 }).catch(() => {});
  const renewed = await page.inputValue("#keyed [name=submit]");
  page.off("request", keyOf);
  check(
    "a submit key is sent again after a failed submit and renewed once the submit is answered",
    kept === zero && keys.length === 2 && keys.every((k) => k === zero) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(renewed) && renewed !== zero,
    `${keys.join(", ")} -> ${renewed}`,
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
  await page.click("#keyed button");
  await page.waitForSelector("#upstream-said");
  const afterUpstream = await page.inputValue("#keyed [name=submit]");
  await page.click("#keyed button");
  await page.waitForFunction(() => document.querySelector("#upstream-said")?.textContent === "Watching.", null, { timeout: 5000 }).catch(() => {});
  const afterAnswer = await page.inputValue("#keyed [name=submit]");
  check(
    "a 5xx patch keeps the form's submit key, and the retry sends it",
    afterUpstream === zero && upstreamKeys.length === 2 && upstreamKeys.every((k) => k === zero) && afterAnswer !== zero && afterAnswer !== "11111111-1111-4111-8111-111111111111",
    `${upstreamKeys.join(", ")}: after 502 ${afterUpstream}, after 200 ${afterAnswer}`,
  );
  await page.unroute("**/watch-upstream");
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
    await new Promise((resolve) => cutServer.listen(0, "127.0.0.1", () => resolve(undefined)));
    const cutPort = /** @type {import("node:net").AddressInfo} */ (cutServer.address()).port;
    await page.route("**/watch-cut*", (route) => route.continue({ url: `http://127.0.0.1:${cutPort}${new URL(route.request().url()).pathname}` }));
    const cutLogged = errors.length;
    /** @type {string[]} */
    const cutSeen = [];
    for (const action of ["/watch-cut", "/watch-cut-plain"]) {
      await page.evaluate(
        ([zero, action]) =>
          document.querySelector("main")?.insertAdjacentHTML(
            "beforeend",
            __html(`<form id="cut" method="post" action="${action}" data-patch><input type="hidden" name="submit" data-submit value="${zero}"><button>Watch</button></form>`),
          ),
        [zero, action],
      );
      const cutFailed = page.evaluate(() => new Promise((resolve) => document.addEventListener("corten:error", (e) => resolve(/** @type {CustomEvent} */ (e).detail.status), { once: true })));
      await page.click("#cut button");
      const cutStatus = await cutFailed;
      const cutKey = await page.inputValue("#cut [name=submit]");
      cutSeen.push(`${action}: status ${cutStatus}, key ${cutKey === zero ? "kept" : cutKey}`);
      await page.evaluate(() => document.querySelector("#cut")?.remove());
    }
    check(cutName, cutSeen.every((seen) => seen.endsWith("status 0, key kept")), cutSeen.join("; "));
    await page.unroute("**/watch-cut*");
    cutServer.close();
    // The browser logs the answer it could not read.
    errors.splice(cutLogged, errors.length, ...errors.slice(cutLogged).filter((e) => !/Failed to load resource|ERR_|NetworkError|network connection was lost/i.test(e)));
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
  // counts the posts it sees (#161).
  const viaButton = page
    .waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/watch", { timeout: 4000 })
    .then(async (r) => (await r.finished(), r.status()))
    .catch(() => 0);
  await page.click("#via-button button");
  const viaButtonStatus = await viaButton;
  await page.waitForFunction(() => document.getElementById("watch-message")?.textContent?.startsWith("Watching Acme Corp"), null, { timeout: 4000 }).catch(() => {});
  check(
    "a submit button's formaction and formmethod are used",
    viaButtonStatus === 200 && ((await page.textContent("#watch-message")) ?? "").startsWith("Watching Acme Corp"),
    String(viaButtonStatus),
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
  // The answer draws the watch form again: one with controls named hasAttribute and getAttribute
  // is replaced as any other, and no corten:error says the write failed.
  await page.evaluate(() => {
    document
      .getElementById("watch-form")
      ?.insertAdjacentHTML("afterbegin", __html('<input type="hidden" name="hasAttribute" value="x"><input type="hidden" name="getAttribute" value="x">'));
    /** @type {any} */ (window).__shadowedErrors = 0;
    document.addEventListener("corten:error", () => (/** @type {any} */ (window).__shadowedErrors += 1));
  });
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
  const carried = await page.evaluate(async () => {
    const { patch } = await import("corten");
    const form = /** @type {HTMLFormElement} */ (document.getElementById("watch-form"));
    const inputs = '<input type="hidden" name="hasAttribute" value="x"><input type="hidden" name="getAttribute" value="x">';
    const fresh = form.outerHTML.replace(/^<form[^>]*>/, (open) => open + inputs);
    /** @type {unknown} */
    let failed = null;
    try {
      await patch(__html(fresh));
    } catch (error) {
      failed = String(error);
    }
    const now = document.getElementById("watch-form");
    const drawn = now !== form && !!now?.querySelector("input[name=hasAttribute]");
    for (const input of Array.from(now?.querySelectorAll("input[name=hasAttribute], input[name=getAttribute]") ?? [])) input.remove();
    return { drawn, failed };
  });
  check(
    "a patch draws again a form with controls named hasAttribute and getAttribute, and says no write failed",
    redrawn.replaced && redrawn.errors === 0 && carried.drawn && carried.failed === null,
    JSON.stringify({ ...redrawn, ...carried }),
  );
  await page.evaluate(() => document.getElementById("shadowed")?.remove());

  // The latest submit wins, but a pending write is not abandoned (the server may have applied
  // it): the newer submit waits for its answer and goes out after it, from the form as the answer
  // left it.
  delayWatch = 1200;
  /** @type {string[]} */
  const writes = [];
  /** @param {import("@playwright/test").Request} r */
  const onWrite = (r) => r.method() === "POST" && r.url().endsWith("/watch") && writes.push(`sent ${new URLSearchParams(r.postData() ?? "").get("id")}`);
  /** @param {import("@playwright/test").Response} r */
  const onAnswer = (r) => r.request().method() === "POST" && r.url().endsWith("/watch") && writes.push(`answered ${new URLSearchParams(r.request().postData() ?? "").get("id")}`);
  page.on("request", onWrite);
  page.on("response", onAnswer);
  await page.selectOption("select[name=id]", "PNTR");
  await page.click("#watch-form button");
  // The same press again sends nothing, and two newer ones are one submit of where the form ended.
  await page.click("#watch-form button");
  await page.selectOption("select[name=id]", "NRTH");
  await page.click("#watch-form button");
  await page.selectOption("select[name=id]", "VTGO");
  await page.click("#watch-form button");
  const busyWhileWriting = await page.getAttribute("#watch-form", "aria-busy");
  await page.waitForFunction(() => document.getElementById("watch-message")?.textContent?.startsWith("Watching Vertigo Robotics"), null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(300);
  page.off("request", onWrite);
  page.off("response", onAnswer);
  check(
    "a newer submit waits for a pending write, which is answered, and then goes out",
    ((await page.textContent("#watch-message")) ?? "").startsWith("Watching Vertigo Robotics") &&
      busyWhileWriting === "true" &&
      abandoned.length === 0 &&
      writes.join() === "sent PNTR,answered PNTR,sent VTGO,answered VTGO",
    `${await page.textContent("#watch-message")}; busy: ${busyWhileWriting}; ${writes.join()}; abandoned: ${abandoned.join()}`,
  );
  check("the form is not left busy", (await page.getAttribute("#watch-form", "aria-busy")) === null);

  // The queue's other answers, against a form of the smoke's own whose answers it writes: each
  // case presses once, changes the field and presses again while the first is out.
  /** @type {{ status: number, headers?: Record<string, string>, body: string }} */
  let queueAnswer = { status: 200, body: "" };
  /** @type {string[]} */
  let queueSent = [];
  await page.route("**/queue*", async (route) => {
    const request = route.request();
    const fields = request.method() === "GET" ? new URL(request.url()).searchParams : new URLSearchParams(request.postData() ?? "");
    queueSent.push(`${request.method()} ${fields.get("n")}${fields.has("submit") ? ` ${fields.get("submit")}` : ""}`);
    const answer = queueAnswer;
    // The first of two reads answers last, so a read that was not aborted would draw over the newer.
    const late = request.method() === "GET" && fields.get("n") === "1";
    await new Promise((resolve) => setTimeout(resolve, late ? 1200 : 400));
    const body = answer.body.replace("{n}", fields.get("n") ?? "");
    await route.fulfill({ status: answer.status, headers: { "content-type": "text/html; charset=utf-8", ...answer.headers }, body }).catch(() => {});
  });
  /** Puts the form (in a box a patch can redraw), presses, sets n to 2, presses, and waits. @param {string} form */
  const queueCase = async (form) => {
    queueSent = [];
    await page.evaluate((form) => {
      document.getElementById("queue-box")?.remove();
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<div id="queue-box">${form}<p id="queue-out"></p></div>`));
    }, form);
    const error = page.evaluate(
      () => new Promise((resolve) => {
        document.addEventListener("corten:error", (e) => resolve(/** @type {CustomEvent} */ (e).detail.status), { once: true });
        setTimeout(() => resolve(null), 2500);
      }),
    );
    await page.click("#queue-box button");
    await page.fill("#queue-box [name=n]", "2");
    // Still out when the second press lands, so the check is of the queue and not of two sends.
    const busy = await page.getAttribute("#queue-box form", "aria-busy");
    await page.click("#queue-box button");
    const status = await error;
    await page.waitForTimeout(700);
    return { sent: queueSent.join(), status, busy };
  };
  const queueLogged = errors.length;
  const patchHeaders = { "corten-patch": "1" };
  const queueForm = (/** @type {string} */ method, /** @type {string} */ extra = "") =>
    `<form id="queue" method="${method}" action="/queue" data-patch><input name="n" value="1">${extra}<button>Go</button></form>`;

  // A newer GET aborts the older one, whose answer is worth nothing now: the first answers last,
  // and the page keeps the newer's.
  queueAnswer = { status: 200, headers: patchHeaders, body: '<p id="queue-out">read {n}</p>' };
  const read = await queueCase(queueForm("get"));
  await page.waitForTimeout(800);
  check("a newer GET submit aborts the older one", read.sent === "GET 1,GET 2" && (await page.textContent("#queue-out")) === "read 2", `${read.sent}; ${await page.textContent("#queue-out")}`);

  // An answer the runtime does not draw (a proxy's 503) drops the submit that waited.
  queueAnswer = { status: 503, body: "Service Unavailable" };
  const undrawn = await queueCase(queueForm("post"));
  check("a submit that waited for an answer the runtime does not draw is not sent", undrawn.sent === "POST 1" && undrawn.status === 503, `${undrawn.sent}; ${undrawn.status}`);

  // A 5xx patch is drawn, but the write may or may not have applied: the waiting submit drops.
  queueAnswer = { status: 500, headers: patchHeaders, body: '<p id="queue-out">failed</p>' };
  const failedPatch = await queueCase(queueForm("post"));
  check(
    "a submit that waited for a 5xx is not sent, and the 5xx's patch is drawn",
    failedPatch.sent === "POST 1" && (await page.textContent("#queue-out")) === "failed",
    `${failedPatch.sent}; ${await page.textContent("#queue-out")}`,
  );

  // A refusal of the state the write was made against (Errors::refuse, 409) is drawn and drops
  // the waiting submit: the user reads it before anything else goes.
  queueAnswer = { status: 409, headers: patchHeaders, body: '<p id="queue-out">stale</p>' };
  const stale = await queueCase(queueForm("post"));
  check(
    "a submit that waited is not sent after a 409 refusal, which is drawn",
    stale.sent === "POST 1" && (await page.textContent("#queue-out")) === "stale",
    `${stale.sent}; ${await page.textContent("#queue-out")}`,
  );

  // An answer that removes the form drops it.
  queueAnswer = { status: 200, headers: patchHeaders, body: '<template id="queue" data-remove></template>' };
  const removed = await queueCase(queueForm("post"));
  check("a submit that waited is not sent when the answer removes its form", removed.sent === "POST 1" && (await page.$("#queue")) === null, removed.sent);

  // A form without an id that the answer took off the page is not found again: its values are
  // the ones from before the answer.
  queueAnswer = { status: 200, headers: patchHeaders, body: '<div id="queue-box"><form method="post" action="/queue" data-patch><input name="n" value="1"><button>Go</button></form></div>' };
  const noId = await queueCase('<form method="post" action="/queue" data-patch><input name="n" value="1"><button>Go</button></form>');
  check("a submit that waited is not sent when its form without an id left the page", noId.sent === "POST 1", noId.sent);

  // The submit that waited goes under the form's new key: the write's answer renewed it.
  queueAnswer = { status: 200, headers: patchHeaders, body: '<p id="queue-out">saved</p>' };
  const keyed = await queueCase(queueForm("post", `<input type="hidden" name="submit" data-submit value="${zero}">`));
  const [firstKey, secondKey] = keyed.sent.split(",").map((s) => s.split(" ")[2]);
  check(
    "a submit that waited goes out after the write's answer, under the key the answer renewed",
    keyed.busy === "true" && keyed.sent.startsWith("POST 1 ") && keyed.sent.includes(",POST 2 ") && firstKey === zero && /^[0-9a-f-]{36}$/.test(secondKey ?? "") && secondKey !== zero,
    keyed.sent,
  );
  await page.unroute("**/queue*");
  await page.evaluate(() => document.getElementById("queue-box")?.remove());
  // The browser logs the 503, 500 and 409 the smoke answered; nothing else is expected.
  errors.splice(queueLogged, errors.length, ...errors.slice(queueLogged).filter((e) => !/Failed to load resource/.test(e)));

  // A data-patch form's submit marks the button that sent it busy with the form, one outside the
  // form (`form=`) too, until the answer is drawn; a newer submit by another button takes the
  // marks, and the first button's goes (#1063).
  await page.route("**/busy-read*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const by = new URL(route.request().url()).searchParams.get("by");
    await route.fulfill({ headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body: `<p id="busy-said">read ${by}</p>` }).catch(() => {});
  });
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      __html('<form id="busy-form" method="get" action="/busy-read" data-patch></form><p id="busy-said"></p><button id="busy-a" form="busy-form" name="by" value="a">A</button><button id="busy-b" form="busy-form" name="by" value="b">B</button>'),
    ),
  );
  const busyMarks = () => page.evaluate(() => ["busy-form", "busy-a", "busy-b"].map((id) => document.getElementById(id)?.getAttribute("aria-busy") ?? "-").join());
  await page.click("#busy-a");
  const whileA = await busyMarks();
  await page.click("#busy-b");
  const whileB = await busyMarks();
  await page.waitForFunction(() => document.querySelector("#busy-said")?.textContent === "read b", null, { timeout: 5000 }).catch(() => {});
  const busyAfter = await busyMarks();
  check(
    "a data-patch form's submit marks the button that sent it, one outside the form too, until its answer is drawn",
    whileA === "true,true,-" && whileB === "true,-,true" && busyAfter === "-,-,-",
    `${whileA} | ${whileB} | ${busyAfter}`,
  );
  await page.unroute("**/busy-read*");
  await page.evaluate(() => ["busy-form", "busy-said", "busy-a", "busy-b"].forEach((id) => document.getElementById(id)?.remove()));

  // A write is not cut short by another button: the one pressed while it is on its way is marked
  // beside it and sends once its answer is drawn. A write whose answer sends the browser to
  // another page keeps its button marked until that page is in, and then clears it, a button in
  // the header (outside what the page swaps) included (#1063).
  await page.route("**/busy-write*", async (route) => {
    const by = new URLSearchParams(route.request().postData() ?? "").get("by");
    await new Promise((resolve) => setTimeout(resolve, by === "b" ? 0 : 600));
    const headers = by === "go" ? { "corten-location": "/" } : { "content-type": "text/html; charset=utf-8", "corten-patch": "1" };
    await route.fulfill({ headers, body: by === "go" ? "" : `<p id="busy-w-said">wrote ${by}</p>` }).catch(() => {});
  });
  await page.evaluate(() => {
    document
      .querySelector("main")
      ?.insertAdjacentHTML(
        "beforeend",
        __html('<form id="busy-w" method="post" action="/busy-write" data-patch></form><p id="busy-w-said"></p><button id="busy-wa" form="busy-w" name="by" value="a">A</button><button id="busy-wb" form="busy-w" name="by" value="b">B</button>'),
      );
    document.querySelector("header")?.insertAdjacentHTML("beforeend", __html('<button id="busy-wgo" form="busy-w" name="by" value="go">Go</button>'));
    const held = /** @type {HTMLElement} */ (document.getElementById("busy-wgo"));
    /** @type {any} */ (window).__goHeld = held;
    // Whether the page the write sent the browser to was in (the form gone) when the mark went.
    new MutationObserver((_, observer) => {
      if (held.getAttribute("aria-busy") === "true") return;
      /** @type {any} */ (window).__goCleared = { pageIn: !document.getElementById("busy-w") };
      observer.disconnect();
    }).observe(held, { attributes: true, attributeFilter: ["aria-busy"] });
  });
  const writeMarks = () => page.evaluate(() => ["busy-w", "busy-wa", "busy-wb"].map((id) => document.getElementById(id)?.getAttribute("aria-busy") ?? "-").join());
  await page.click("#busy-wa");
  await page.click("#busy-wb");
  const whileWrite = await writeMarks();
  await page.waitForFunction(() => document.querySelector("#busy-w-said")?.textContent === "wrote b" && !document.querySelector("#busy-w[aria-busy]"), null, { timeout: 5000 }).catch(() => {});
  const afterWrites = await writeMarks();
  check(
    "a button pressed while a write is on its way is marked beside it and sends after its answer",
    whileWrite === "true,true,true" && afterWrites === "-,-,-",
    `${whileWrite} | ${afterWrites}`,
  );
  const redirectName = "a write that sends the browser to another page keeps its button busy until that page is in";
  if (!(await page.evaluate(() => "navigation" in window))) skip(redirectName, "without the Navigation API the browser loads that page in full");
  else {
    await page.click("#busy-wgo");
    const goBusy = await page.evaluate(() => /** @type {any} */ (window).__goHeld.getAttribute("aria-busy"));
    await page
      .waitForFunction(() => !document.getElementById("busy-w") && /** @type {any} */ (window).__goHeld.getAttribute("aria-busy") !== "true" && !document.querySelector("main[aria-busy]"), null, { timeout: 5000 })
      .catch(() => {});
    const goAfter = await page.evaluate(() => ({
      held: /** @type {any} */ (window).__goHeld.getAttribute("aria-busy"),
      cleared: /** @type {any} */ (window).__goCleared ?? null,
      path: location.pathname,
      form: !!document.getElementById("busy-w"),
    }));
    check(redirectName, goBusy === "true" && goAfter.held === null && goAfter.cleared?.pageIn === true && goAfter.path === "/" && !goAfter.form, JSON.stringify({ goBusy, goAfter }));
  }
  await page.unroute("**/busy-write*");
  await page.evaluate(() => ["busy-w", "busy-w-said", "busy-wa", "busy-wb", "busy-wgo"].forEach((id) => document.getElementById(id)?.remove()));

  const current = () => page.$$eval("a[data-nav][aria-current=page]", (links) => links.map((l) => l.getAttribute("href")).join());
  check("the shell marks the current link", (await current()) === "/");
  // The sector links beside <main> are marked `page`: each navigation brings the page's.
  const sectors = () => page.$$eval("#sector-nav a", (links) => links.length);
  check("a layout element marked page is the page's: no sector links outside the news", (await sectors()) === 0);
  check("one feed stream while the component is on the page", (await openFeeds()) === 1);
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
  // newer submit that waited for it.
  delayWatch = 1200;
  let posted = 0;
  /** @param {import("@playwright/test").Request} r */
  const onPost = (r) => r.method() === "POST" && r.url().endsWith("/watch") && (posted += 1);
  page.on("request", onPost);
  await page.click("#watch-form button");
  await page.selectOption("select[name=id]", "NRTH");
  await page.click("#watch-form button");
  await page.click('header a[href="/news"]');
  await page.waitForFunction(() => document.title === "News | Watchlist");
  await page.waitForTimeout(1600);
  page.off("request", onPost);
  check("navigating away abandons a pending submit and the one that waited", abandoned.length === 1 && posted === 1, `${abandoned.join()}; posts: ${posted}`);
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
      // whole page held back (`slow`).
      let [late, readAgain, slow] = [false, false, false];
      // The page's notice marked as not drawn, so the runtime dispatches it (`undrawn`).
      let undrawn = false;
      // The brand the write's page draws in the header.
      let brandNow = "Watchlist, again";
      const readAgainTag = '<noscript data-corten-read-again="1" data-corten-head><meta http-equiv="refresh" content="1"></noscript>';
      // A module preload in the head of the page the write sends the browser to, as the server
      // writes for a handler module's imports: the runtime fetches it when it swaps the page in.
      /** @type {string[]} */
      const probed = [];
      page.on("request", (r) => r.url().endsWith("?swap-preload") && probed.push(r.url()));
      await page.route(news, async (route) => {
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
          if (slow) await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        await route.fulfill({ status: res.status(), headers, body }).catch(() => {});
      });
      // Something a script put beside <main> is not the layout's, and stays.
      await page.evaluate(() => document.body.append(Object.assign(document.createElement("div"), { id: "extension" })));
      await thank();
      const first = await back();
      check("a redirect to a place keeps its #id and scrolls to it", first && loads === 1, `${await page.evaluate(() => [location.href, scrollY])} loads ${loads}`);
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
      check("both kept the document", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1));
      check("a layout element the write did not change stays the same element", await page.evaluate(() => (/** @type {any} */ (document.querySelector("header"))).__same === 1));
      // A patch inside the header (a cart count) changes it from what the server drew, so the next
      // write's page draws it again even when that page's header is the one drawn before.
      await page.evaluate(async () => {
        scrollTo(0, 0);
        const brand = /** @type {HTMLElement} */ (document.querySelector("header span"));
        brand.id = "smoke-brand";
        const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
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
            const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
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
      // the write changed in the layout is drawn there too.
      {
        /** @type {string[]} */
        const asked = [];
        const onStocks = (/** @type {import("@playwright/test").Request} */ r) => r.method() === "GET" && new URL(r.url()).pathname === "/" && asked.push(swapped(r) ? r.headers()["corten"] : "whole");
        slow = true;
        await page.evaluate(() => scrollTo(0, 0));
        const held = page.waitForRequest((r) => news(new URL(r.url())) && !swapped(r), { timeout: 5000 });
        await thank();
        await held;
        page.on("request", onStocks);
        await page.evaluate(() => /** @type {HTMLAnchorElement} */ (document.querySelector('header a[href="/"]')).click());
        await page.waitForFunction(() => document.title === "Stocks | Watchlist", null, { timeout: 5000 }).catch(() => {});
        page.off("request", onStocks);
        slow = false;
        check("a navigation started before a write's page comes reads the whole page", asked[0] === "whole" && (await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1)), asked.join());
        await page.evaluate(() => /** @type {HTMLAnchorElement} */ (document.querySelector('header a[href="/news"]')).click());
        await page.waitForFunction(() => document.title === "News | Watchlist" && document.getElementById("briefing"), null, { timeout: 5000 });
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
      page.off("request", onNews);
      await page.unroute(news);
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
  // Load more (view::Append): the answer adds only the new rows; the ones the page has stay. In a
  // page of its own, so it runs in every engine and leaves this page's history as it is.
  {
    const more = await browser.newPage();
    const moreNavs = [];
    more.on("request", (request) => request.headers()["corten"] === "nav" && moreNavs.push(request.url()));
    await more.goto(`${base}/news`);
    await more.waitForFunction(() => document.querySelectorAll("#stories > li").length === 3);
    await more.evaluate(() => ((/** @type {any} */ (document.querySelector("#stories > li"))).__kept = true));
    await more.click("#load-more button");
    await more.waitForFunction(() => document.querySelectorAll("#stories > li").length === 6);
    const grown = await more.evaluate(() => ({
      rows: Array.from(document.querySelectorAll("#stories h3"), (h) => h.textContent).join("|"),
      kept: (/** @type {any} */ (document.querySelector("#stories > li"))).__kept === true,
      search: location.search,
    }));
    check(
      "Load more appends the next rows in order",
      grown.rows ===
        "Acme Corp raises its full-year outlook|Globex wins approval for its northern pipeline|Initech moves its reporting software to subscriptions|Halcyon Health's flu vaccine enters its final trial|Pantry & Co recalls one batch of cereal over a labeling error|Vertigo Robotics signs a warehouse automation deal",
      grown.rows,
    );
    check("the rows the page had are the same elements", grown.kept);
    check("Load more is a patch, not a navigation", moreNavs.length === 0 && grown.search === "", `${moreNavs.length} nav(s), ${grown.search}`);
    await more.click("#load-more button");
    await more.waitForFunction(() => document.querySelectorAll("#stories > li").length === 9);
    check("the last page hides the button", await more.locator("#load-more button").isHidden());
    // A sector's box: the stories of that sector alone, three of the nine. (A navigation the
    // runtime intercepts stalls Playwright's WebKit, above.)
    if (swaps) {
      // The box is in a closed group of the rail; clicked from the page. The form that starts the
      // navigation is busy with main until the page is swapped in: when its mark goes, the
      // sector's stories are already shown.
      await watchBusy(more, "main form[data-keep-place]");
      await more.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("main input[name=sector][value=energy]")).click());
      await more.waitForFunction(() => location.search === "?sector=energy" && !document.querySelector("main[aria-busy]"));
      const formBusy = await busyEnded(more);
      check("the GET form that starts a navigation is busy with main until its page is in", formBusy.with && formBusy.then?.stories === 3, JSON.stringify(formBusy));
      const energy = await more.$$eval("#stories > li", (items) => items.map((li) => li.querySelector("p:last-child a")?.textContent));
      check("a sector's box lists only its stories", energy.join() === "Energy,Energy,Energy" && (await more.locator("#load-more button").isHidden()), energy.join());
      // The same for a link: the header's, which the swap keeps.
      await watchBusy(more, 'header a[href="/"]');
      await more.click('header a[href="/"]');
      await more.waitForFunction(() => location.pathname === "/" && !document.querySelector("main[aria-busy]"));
      const linkBusy = await busyEnded(more);
      check(
        "the link that starts a navigation is busy with main until its page is in",
        linkBusy.with && linkBusy.then?.path === "/" && linkBusy.then.stories === 0 && !(await more.$("[aria-busy]")),
        JSON.stringify(linkBusy),
      );
      // And a button outside its GET form (`form=`), in the header the swap keeps: it is busy
      // with main too, as the form is, and cleared when the page is in (#1063).
      await more.evaluate(() => {
        document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<form id="nav-busy" method="get" action="/news"></form>'));
        document.querySelector("header")?.insertAdjacentHTML("beforeend", __html('<button id="nav-busy-go" form="nav-busy">News</button>'));
      });
      await watchBusy(more, "#nav-busy-go");
      await more.click("#nav-busy-go");
      await more.waitForFunction(() => location.pathname === "/news" && !document.querySelector("main[aria-busy]"));
      const buttonBusy = await busyEnded(more);
      check("a button outside its GET form is busy with main until the page it started is in", buttonBusy.with && buttonBusy.then?.path === "/news", JSON.stringify(buttonBusy));
      await more.evaluate(() => document.getElementById("nav-busy-go")?.remove());
      await more.click('header a[href="/"]');
      await more.waitForFunction(() => location.pathname === "/" && !document.querySelector("main[aria-busy]"));
      // Where the browser lets a navigation say when its address changes (precommitHandler), a
      // slow page's address changes when its answer is in, as a full load's does, not at the click
      // while the old page is still on screen (#992). Read every frame: how long the old page was
      // shown busy at the old address, and how long the new address showed the old page (the body
      // read and the swap after the answer's headers).
      if (await more.evaluate(precommits)) {
        /** @param {URL} url */
        const news = (url) => url.pathname === "/news" && url.search === "";
        await more.route(news, async (route) => {
          if (route.request().headers().corten === "nav") await new Promise((resolve) => setTimeout(resolve, 800));
          await route.continue().catch(() => {});
        });
        await more.evaluate(() => {
          /** @type {[number, string, number, boolean][]} */
          const frames = [];
          /** @type {any} */ (window).__frames = frames;
          const read = (/** @type {number} */ at) => {
            const stories = document.querySelectorAll("#stories > li").length;
            frames.push([at, location.pathname, stories, !!document.querySelector("main[aria-busy]")]);
            if (frames.length < 5000 && !(location.pathname === "/news" && stories > 0)) requestAnimationFrame(read);
          };
          requestAnimationFrame(read);
        });
        await more.click('header a[href="/news"]');
        await more.waitForFunction(() => location.pathname === "/news" && document.querySelectorAll("#stories > li").length > 0 && !document.querySelector("main[aria-busy]"), null, { timeout: 5000 });
        /** @type {[number, string, number, boolean][]} */
        const frames = await more.evaluate(() => /** @type {any} */ (window).__frames);
        /** @param {(frame: [number, string, number, boolean]) => boolean} which */
        const span = (which) => {
          const times = frames.filter(which).map(([at]) => at);
          return times.length ? Math.round(times.at(-1) - times[0]) : 0;
        };
        const waited = span(([, path, , busy]) => path === "/" && busy);
        const ahead = span(([, path, stories]) => path === "/news" && stories === 0);
        check(
          "a slow page's address changes with its content, not before",
          waited >= 500 && ahead < 200,
          `busy at the old address ${waited} ms, the new address on the old page ${ahead} ms`,
        );
        await more.unroute(news);
      } else skip("a slow page's address changes with its content, not before", "no precommitHandler: the address changes at the click");
      // A GET form whose controls are named like the methods that mark it still navigates.
      await more.evaluate(() =>
        document
          .querySelector("main")
          ?.insertAdjacentHTML(
            "beforeend",
            __html('<form id="clobbered" method="get" action="/news"><input type="hidden" name="setAttribute" value="1"><input type="hidden" name="removeAttribute" value="1"><button>Go</button></form>'),
          ),
      );
      const clobberedErrors = [];
      const onError = (/** @type {Error} */ e) => clobberedErrors.push(e.message);
      more.on("pageerror", onError);
      await watchBusy(more, "#clobbered");
      await more.click("#clobbered button");
      const clobbered = await busyEnded(more);
      more.off("pageerror", onError);
      check(
        "a GET form with a control named setAttribute navigates and is not left busy",
        clobbered.with && clobbered.then?.path === "/news" && clobberedErrors.length === 0,
        JSON.stringify({ ...clobbered, errors: clobberedErrors }),
      );
      // A link whose prefetched answer is held is clicked, then another navigation replaces its
      // own: the link is not left busy waiting for the answer no one will use.
      let letPrefetch = () => {};
      const prefetchHeld = new Promise((resolve) => (letPrefetch = () => resolve(undefined)));
      /** @param {URL} url */
      const home = (url) => url.pathname === "/";
      await more.route(home, async (route) => {
        await prefetchHeld;
        await route.continue().catch(() => {});
      });
      const prefetching = more.waitForRequest((r) => new URL(r.url()).pathname === "/" && r.headers().corten === "nav");
      await more.hover('header a[href="/"]');
      await prefetching;
      await more.click('header a[href="/"]');
      await more.waitForSelector('header a[href="/"][aria-busy=true]');
      await more.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("main input[name=sector][value=energy]")).click());
      await more.waitForFunction(() => location.search === "?sector=energy" && document.querySelectorAll("#stories > li").length === 3 && !document.querySelector("main[aria-busy]"));
      check("a link whose navigation another replaced is not left busy", !(await more.$('header a[href="/"][aria-busy]')));
      letPrefetch();
      await more.unroute(home);
    } else {
      skip("the GET form that starts a navigation is busy with main until its page is in", noSwaps);
      skip("a sector's box lists only its stories", noSwaps);
      skip("the link that starts a navigation is busy with main until its page is in", noSwaps);
      skip("a button outside its GET form is busy with main until the page it started is in", noSwaps);
      skip("a GET form with a control named setAttribute navigates and is not left busy", noSwaps);
      skip("a link whose navigation another replaced is not left busy", noSwaps);
    }
    await more.close();
  }
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
  // Back to a page the runtime swapped in puts back what the user typed or chose there, as the
  // browser does without the script; the page is still drawn again from the server.
  if (swaps) {
    const typedPage = await (await browser.newContext()).newPage();
    await typedPage.goto(`${base}/alerts`);
    const drawn = await typedPage.inputValue("#alert-form select");
    await typedPage.selectOption("#alert-form select", "SOLR");
    await typedPage.fill("#alert-form input[name=above]", "123.45");
    let documents = 0;
    let reads = 0;
    typedPage.on("request", (r) => r.resourceType() === "document" && documents++);
    // The page is read again from the server, not kept.
    typedPage.on("request", (r) => new URL(r.url()).pathname === "/alerts" && r.headers()["corten"] === "nav" && reads++);
    await typedPage.click('header nav a[href="/news"]');
    await typedPage.waitForFunction(() => document.title === "News | Watchlist");
    await typedPage.goBack();
    await typedPage.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"), null, { timeout: 5000 }).catch(() => {});
    const back = {
      id: await typedPage.inputValue("#alert-form select"),
      above: await typedPage.inputValue("#alert-form input[name=above]"),
      documents,
      reads,
    };
    check(
      "back to a page the runtime swapped in puts back what the user typed and chose there",
      drawn !== "SOLR" && back.id === "SOLR" && back.above === "123.45" && back.documents === 0 && back.reads === 1,
      JSON.stringify({ drawn, ...back }),
    );
    await typedPage.context().close();
    /**
     * A page whose /alerts answers are changed on their way from the server, by request count.
     * @param {(body: string, nth: number) => string} change
     */
    const changed = async (change) => {
      const p = await (await browser.newContext()).newPage();
      let nth = 0;
      await p.route(
        (url) => url.pathname === "/alerts",
        async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          await route.fulfill({ status: res.status(), headers, body: change(await res.text(), nth++) });
        },
      );
      await p.goto(`${base}/alerts`);
      return p;
    };
    /** Types in the alert form, goes to the news page and back, and reads the form. @param {import("@playwright/test").Page} p */
    const typeAndBack = async (p) => {
      await p.selectOption("#alert-form select", "SOLR");
      await p.fill("#alert-form input[name=above]", "123.45");
      await p.click('header nav a[href="/news"]');
      await p.waitForFunction(() => document.title === "News | Watchlist");
      await p.goBack();
      await p.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"), null, { timeout: 5000 }).catch(() => {});
      return { id: await p.inputValue("#alert-form select"), above: await p.inputValue("#alert-form input[name=above]") };
    };
    // A field marked autocomplete="off" is drawn as the server draws it, as the browser does; the
    // form's other field is put back.
    const offPage = await changed((body) => body.replace('name="above"', 'name="above" autocomplete="off"'));
    const off = await offPage.evaluate(() => document.querySelector("#alert-form input[name=above]")?.getAttribute("autocomplete"));
    const offBack = await typeAndBack(offPage);
    check('back to a page puts back its fields but one autocomplete="off" marks', off === "off" && offBack.id === "SOLR" && offBack.above === "", JSON.stringify({ off, ...offBack }));
    await offPage.context().close();
    // A field the server now draws otherwise (its value, here) keeps what the server draws; the
    // others are put back.
    const otherPage = await changed((body, nth) => (nth ? body.replace(/(name="above"[^>]*?value=")[^"]*"/, '$199"') : body));
    const otherBack = await typeAndBack(otherPage);
    check("back to a page leaves a field the server now draws otherwise as the server draws it", otherBack.id === "SOLR" && otherBack.above === "99", JSON.stringify(otherBack));
    await otherPage.context().close();
    // As the browser does: a form marked autocomplete="off" keeps none of its fields, and a
    // password is never put back, even one drawn the same.
    const offFormPage = await changed((body) => body.replace('<form id="alert-form"', '<form id="alert-form" autocomplete="off"'));
    const offForm = await offFormPage.evaluate(() => document.querySelector("#alert-form")?.getAttribute("autocomplete"));
    const offFormBack = await typeAndBack(offFormPage);
    check('back to a page puts back no field of a form marked autocomplete="off"', offForm === "off" && offFormBack.id !== "SOLR" && offFormBack.above === "", JSON.stringify({ offForm, ...offFormBack }));
    await offFormPage.context().close();
    const passwordPage = await changed((body) => body.replace(/<input type="text"([^>]*?name="above")/, '<input type="password"$1'));
    const password = await passwordPage.evaluate(() => document.querySelector("#alert-form input[name=above]")?.getAttribute("type"));
    const passwordBack = await typeAndBack(passwordPage);
    check("back to a page puts back its fields but a password", password === "password" && passwordBack.id === "SOLR" && passwordBack.above === "", JSON.stringify({ password, ...passwordBack }));
    await passwordPage.context().close();
    // A checkbox and a radio the user changed are put back; a select whose options the server
    // changed keeps what the server draws, and the other fields are put back.
    // A checkbox the server draws with another value is left as drawn too (one with an id, so it is
    // found by the id whatever its value and only how it was drawn tells the two apart).
    const choices = '<input type="checkbox" name="notify" value="email"><input type="checkbox" id="digest" name="digest" value="daily"><input type="radio" name="tone" value="calm" checked><input type="radio" name="tone" value="loud">';
    const choicePage = await changed((body, nth) => {
      const page = body.replace('<button id="save-alert">', `${choices}<button id="save-alert">`);
      return nth ? page.replace('<option value="VTGO">Vertigo Robotics (VTGO)</option>', "").replace('id="digest" name="digest" value="daily"', 'id="digest" name="digest" value="weekly"') : page;
    });
    await choicePage.check("#alert-form [name=notify]");
    await choicePage.check("#alert-form [name=digest]");
    await choicePage.check("#alert-form [name=tone][value=loud]");
    const choiceBack = await typeAndBack(choicePage);
    const choice = await choicePage.evaluate(() => ({
      notify: /** @type {HTMLInputElement | null} */ (document.querySelector("#alert-form [name=notify]"))?.checked,
      digest: /** @type {HTMLInputElement | null} */ (document.querySelector("#alert-form [name=digest]"))?.checked,
      tone: /** @type {HTMLInputElement | null} */ (document.querySelector("#alert-form [name=tone]:checked"))?.value,
      options: document.querySelectorAll("#alert-form select option").length,
    }));
    check(
      "back to a page puts back a checkbox and a radio, and leaves a select whose options changed and a checkbox whose value changed as the server draws them",
      choice.notify === true && choice.digest === false && choice.tone === "loud" && choice.options === 7 && choiceBack.id === "ACME" && choiceBack.above === "123.45",
      JSON.stringify({ ...choice, ...choiceBack }),
    );
    await choicePage.context().close();
    // A file chosen is never put back, as the browser does; the page's other fields are, and the
    // fields are in place before the page's own elements connect (one here reads a field as it does).
    const filePage = await changed((body) => body.replace('<button id="save-alert">', '<input type="file" name="doc"><read-field></read-field><button id="save-alert">'));
    await filePage.addInitScript(() =>
      customElements.define(
        "read-field",
        class extends HTMLElement {
          connectedCallback() {
            (/** @type {any} */ (window)).__readAtConnect = /** @type {HTMLInputElement | null} */ (this.closest("form")?.querySelector("[name=above]"))?.value;
          }
        },
      ),
    );
    await filePage.reload();
    /** @type {string[]} */
    const fileErrors = [];
    filePage.on("pageerror", (e) => fileErrors.push(e.message));
    await filePage.setInputFiles("#alert-form [name=doc]", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("note") });
    const fileBack = await typeAndBack(filePage);
    const fileAfter = await filePage.evaluate(() => ({
      files: /** @type {HTMLInputElement | null} */ (document.querySelector("#alert-form [name=doc]"))?.files?.length,
      atConnect: (/** @type {any} */ (window)).__readAtConnect,
      main: location.pathname === "/alerts" && !!document.querySelector("main #alert-form"),
    }));
    check(
      "back to a page puts back no file, the other fields before the page's elements connect",
      fileAfter.main && fileAfter.files === 0 && fileAfter.atConnect === "123.45" && fileBack.above === "123.45" && !fileErrors.length,
      JSON.stringify({ ...fileAfter, ...fileBack, fileErrors }),
    );
    await filePage.context().close();
    // A value a script set, with no input or change event, is not put back; what the user chose is.
    const scriptPage = await changed((body) => body);
    await scriptPage.selectOption("#alert-form select", "SOLR");
    await scriptPage.evaluate(() => {
      /** @type {HTMLInputElement} */ (document.querySelector("#alert-form input[name=above]")).value = "5";
    });
    await scriptPage.click('header nav a[href="/news"]');
    await scriptPage.waitForFunction(() => document.title === "News | Watchlist");
    await scriptPage.goBack();
    await scriptPage.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"), null, { timeout: 5000 }).catch(() => {});
    const scripted = { id: await scriptPage.inputValue("#alert-form select"), above: await scriptPage.inputValue("#alert-form input[name=above]") };
    check("back to a page puts back what the user chose and not a value a script set", scripted.id === "SOLR" && scripted.above === "", JSON.stringify(scripted));
    await scriptPage.context().close();
    // A form with a control named like one of a form's own methods is still read by the form's:
    // leaving it swaps the page in and Back puts back what was typed. (Playwright's own select
    // and checks call getAttribute on the form, so only the text field is typed in, by keys.)
    const shadowPage = await changed((body) => body.replace(/(<form id="alert-form"[^>]*>)/, '$1<input type="hidden" name="getAttribute" value="x">'));
    /** @type {string[]} */
    const shadowErrors = [];
    shadowPage.on("pageerror", (e) => shadowErrors.push(e.message));
    await shadowPage.focus("#alert-form input[name=above]");
    await shadowPage.keyboard.press("ControlOrMeta+a");
    await shadowPage.keyboard.type("123.45");
    await shadowPage.click('header nav a[href="/news"]');
    const shadowLeft = await shadowPage.waitForFunction(() => document.title === "News | Watchlist" && !document.querySelector("#alert-form"), null, { timeout: 5000 }).then(() => true, () => false);
    await shadowPage.goBack();
    await shadowPage.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"), null, { timeout: 5000 }).catch(() => {});
    const shadowAbove = await shadowPage.evaluate(() => /** @type {HTMLInputElement | null} */ (document.querySelector("#alert-form input[name=above]"))?.value);
    check("back to a page puts back what was typed in a form with a control named getAttribute", shadowLeft && shadowAbove === "123.45" && !shadowErrors.length, JSON.stringify({ shadowLeft, shadowAbove, shadowErrors }));
    await shadowPage.context().close();
    // More fields typed in than the runtime looks up one by one (it walks the page's fields once):
    // each is found again, by id or by name and place among fields of one name.
    const manyPage = await changed((body) =>
      body.replace(
        '<button id="save-alert">',
        Array.from({ length: 70 }, (_, i) => `<input id="many-${i}" name="m${i}">`).join("") + '<input name="many">'.repeat(20) + '<button id="save-alert">',
      ),
    );
    await manyPage.evaluate(() => {
      const typed = [...document.querySelectorAll('#alert-form [id^="many-"]'), ...[...document.querySelectorAll('#alert-form [name="many"]')].filter((_, i) => i % 2)];
      for (const f of /** @type {HTMLInputElement[]} */ (typed)) {
        f.value = `typed ${f.id || [...document.querySelectorAll('[name="many"]')].indexOf(f)}`;
        f.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await manyPage.click('header nav a[href="/news"]');
    await manyPage.waitForFunction(() => document.title === "News | Watchlist");
    await manyPage.goBack();
    await manyPage.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#many-69"), null, { timeout: 5000 }).catch(() => {});
    const many = await manyPage.evaluate(() => {
      const ids = [...document.querySelectorAll('#alert-form [id^="many-"]')].filter((f) => /** @type {HTMLInputElement} */ (f).value !== `typed ${f.id}`).length;
      const named = [...document.querySelectorAll('#alert-form [name="many"]')].filter((f, i) => /** @type {HTMLInputElement} */ (f).value !== (i % 2 ? `typed ${i}` : "")).length;
      return { ids: document.querySelectorAll('[id^="many-"]').length, idsWrong: ids, namedWrong: named };
    });
    check("back to a page puts back what was typed in more fields than are looked up one by one", many.ids === 70 && !many.idsWrong && !many.namedWrong, JSON.stringify(many));
    await manyPage.context().close();
    /**
     * Types in the alert form, leaves the page as `leave` does, presses Back `backs` times and
     * reads the form. A read of /news (other than /news?r=...) is answered as `news` answers it.
     * @param {(route: import("@playwright/test").Route) => Promise<void>} news
     * @param {(p: import("@playwright/test").Page) => Promise<unknown>} leave
     */
    const typedThrough = async (news, leave, backs = 1) => {
      const p = await (await browser.newContext()).newPage();
      await p.route((url) => url.pathname === "/news" && !url.searchParams.has("r"), news);
      await p.goto(`${base}/alerts`);
      await p.selectOption("#alert-form select", "SOLR");
      await p.fill("#alert-form input[name=above]", "123.45");
      await leave(p);
      for (let i = 0; i < backs; i++) await p.goBack();
      await p.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"), null, { timeout: 5000 }).catch(() => {});
      const read = { id: await p.inputValue("#alert-form select"), above: await p.inputValue("#alert-form input[name=above]") };
      await p.context().close();
      return read;
    };
    /** @param {import("@playwright/test").Page} p */
    const toNewsPlain = async (p) => {
      await p.click('header nav a[href="/news"]');
      await p.waitForFunction(() => document.title === "News | Watchlist");
    };
    /** @param {import("@playwright/test").Page} p */
    const toNews = async (p) => {
      await p.click('header nav a[href="/news"]');
      await p.waitForFunction(() => location.search.startsWith("?r=") && document.title === "News | Watchlist");
    };
    // The page left is recorded under its own entry, not the one a link pushed and its redirect
    // replaced: by the server naming the place (corten-location) or by an HTTP redirect.
    const named = await typedThrough(
      (route) => (route.request().headers()["corten"] ? route.fulfill({ status: 200, headers: { "corten-location": "/news?r=1" }, body: "" }) : route.fallback()),
      toNews,
    );
    check("back to a page puts back what was typed there after a link the server sent elsewhere", named.id === "SOLR" && named.above === "123.45", JSON.stringify(named));
    const redirected = await typedThrough((route) => route.fulfill({ status: 303, headers: { location: "/news?r=2" } }), toNews);
    check("back to a page puts back what was typed there after a link that redirected", redirected.id === "SOLR" && redirected.above === "123.45", JSON.stringify(redirected));
    // A second link followed before the first one's page arrives: the page left is recorded under
    // its own entry, not the one the first link pushed.
    const hurried = await typedThrough(
      async (route) => {
        await new Promise((done) => setTimeout(done, 1500));
        await route.fallback().catch(() => {});
      },
      async (p) => {
        await p.click('header nav a[href="/news"]');
        await p.waitForFunction(() => location.pathname === "/news");
        await p.click('header nav a[href="/"]');
        await p.waitForFunction(() => location.pathname === "/" && !document.querySelector("#alert-form"));
      },
      2,
    );
    check("back to a page puts back what was typed there after a second link followed before the first page arrived", hurried.id === "SOLR" && hurried.above === "123.45", JSON.stringify(hurried));
    // Forward and Back again: the page is recorded again as it is left by a traverse, with what was
    // typed after the first Back.
    const again = await typedThrough(
      (route) => route.fallback(),
      async (p) => {
        await p.click('header nav a[href="/news"]');
        await p.waitForFunction(() => document.title === "News | Watchlist");
        await p.goBack();
        await p.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"));
        await p.fill("#alert-form input[name=above]", "77.5");
        await p.goForward();
        await p.waitForFunction(() => document.title === "News | Watchlist");
      },
    );
    check("back to a page after forward and back again puts back what was typed there", again.id === "SOLR" && again.above === "77.5", JSON.stringify(again));
    // An entry the runtime did not make (a link to a place on the page) shows the same page, so
    // what was typed is recorded under it when a link leaves it.
    const placed = await typedThrough(
      (route) => route.fallback(),
      async (p) => {
        await p.evaluate(() => {
          const to = document.createElement("a");
          to.id = "to-form";
          to.href = "#alert-form";
          to.textContent = "To the form";
          /** @type {Element} */ (document.querySelector("main")).append(to);
        });
        await p.click("#to-form");
        await p.waitForFunction(() => location.hash === "#alert-form");
        await toNewsPlain(p);
      },
    );
    check("back to a place on a page after a link puts back what was typed there", placed.id === "SOLR" && placed.above === "123.45", JSON.stringify(placed));
    // Back while a link's page is on its way redraws the page on screen with what was typed.
    const early = await typedThrough(
      async (route) => {
        await new Promise((done) => setTimeout(done, 1500));
        await route.fallback().catch(() => {});
      },
      async (p) => {
        await p.click('header nav a[href="/news"]');
        await p.waitForFunction(() => location.pathname === "/news");
      },
    );
    check("back before a link's page arrives keeps what was typed", early.id === "SOLR" && early.above === "123.45", JSON.stringify(early));
    // A field the server now draws as another kind (a password) is not given what was typed.
    const kindPage = await changed((body, nth) => (nth ? body.replace(/(name="above"[^>]*?)type="text"|type="text"([^>]*?name="above")/, (m) => m.replace('type="text"', 'type="password"')) : body));
    /** @type {string[]} */
    const kindErrors = [];
    kindPage.on("pageerror", (e) => kindErrors.push(e.message));
    const kindBack = await typeAndBack(kindPage);
    const kind = await kindPage.evaluate(() => document.querySelector("#alert-form input[name=above]")?.getAttribute("type"));
    check("back to a page leaves a field the server now draws as another kind empty", kind === "password" && kindBack.id === "SOLR" && kindBack.above === "" && !kindErrors.length, JSON.stringify({ kind, ...kindBack, kindErrors }));
    await kindPage.context().close();
  } else {
    for (const name of [
      "back to a page the runtime swapped in puts back what the user typed and chose there",
      'back to a page puts back its fields but one autocomplete="off" marks',
      "back to a page leaves a field the server now draws otherwise as the server draws it",
      'back to a page puts back no field of a form marked autocomplete="off"',
      "back to a page puts back its fields but a password",
      "back to a page puts back a checkbox and a radio, and leaves a select whose options changed and a checkbox whose value changed as the server draws them",
      "back to a page puts back no file, the other fields before the page's elements connect",
      "back to a page puts back what the user chose and not a value a script set",
      "back to a page puts back what was typed in a form with a control named getAttribute",
      "back to a page puts back what was typed in more fields than are looked up one by one",
      "back to a page puts back what was typed there after a link the server sent elsewhere",
      "back to a page puts back what was typed there after a link that redirected",
      "back to a page puts back what was typed there after a second link followed before the first page arrived",
      "back to a page after forward and back again puts back what was typed there",
      "back to a place on a page after a link puts back what was typed there",
      "back before a link's page arrives keeps what was typed",
      "back to a page leaves a field the server now draws as another kind empty",
    ])
      skip(name, noSwaps);
  }
  // The submit failed on purpose above; the browser logs that request.
  const unexpected = errors.filter((e) => !e.includes("ERR_INTERNET_DISCONNECTED"));
  check("no console errors", unexpected.length === 0, unexpected.join(" | "));
  errors.length = 0;

  // /account is guarded (Area::guard): signed out, a navigation there follows the redirect to the
  // watchlist, where the sign-in button is.
  await page.goto(`${base}/news`);
  // The formatter is a module of its own: the news page's handlers take no format, so it is not loaded.
  const formatLoaded = () => page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/corten-format.js")));
  check("a page whose handlers take no format does not load the format module", !(await formatLoaded()));
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
        const corten = /** @type {{ patch: (html: string) => Promise<void> }} */ (await import(/** @type {string} */ ("corten")));
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

  // A <corten-live> whose stream finishes (here one fragment, then `end`) applies it and stays
  // closed: no reconnect after the browser's retry delay (about 3 s in Chromium). Without the
  // Navigation API the page above was a full load, whose title is in before <main> is.
  await page.waitForLoadState("domcontentloaded");
  let onceRequests = 0;
  await page.route("**/live/once", (route) => {
    onceRequests += 1;
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: 'event: patch\ndata: <p id="once">Ready</p>\n\nevent: end\ndata: end\n\n',
    });
  });
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<corten-live id="once-live" src="/live/once"><p id="once">Waiting</p></corten-live>')),
  );
  await page.waitForFunction(() => document.querySelector("#once")?.textContent === "Ready", null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(4500);
  check(
    "a <corten-live> stream that ends is applied once and not reopened",
    (await page.textContent("#once")) === "Ready" && onceRequests === 1 && (await openStreams("/live/once")) === 0 && (await page.getAttribute("#once-live", "status")) === "ended",
    `${await page.textContent("#once")}, ${onceRequests} requests`,
  );
  await page.evaluate(() => document.querySelector("#once-live")?.remove());

  // <corten-live> shows its connection: connecting, live once open, reconnecting (with when it
  // dropped) when the stream breaks, closed when the server answers it with no stream.
  let flaky = 0;
  await page.route("**/live/flaky", (route) =>
    (flaky += 1) === 1
      ? route.fulfill({ status: 200, contentType: "text/event-stream", body: 'retry: 300\nevent: patch\ndata: <p id="flaky">One</p>\n\n' })
      : route.fulfill({ status: 204, body: "" }),
  );
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__liveStates = [];
    w.__statusEvents = [];
    // Each change also dispatches a bubbling corten-status, which a handler takes with on:corten-status.
    document.addEventListener("corten-status", (event) => {
      const live = /** @type {Element} */ (event.target);
      if (live.id === "flaky-live") w.__statusEvents.push(`${live.getAttribute("status")}${live.hasAttribute("stale-since") ? "+stale" : ""}`);
    });
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<corten-live id="flaky-live" src="/live/flaky"><p id="flaky">Waiting</p></corten-live>'));
    const el = /** @type {Element} */ (document.querySelector("#flaky-live"));
    const record = () => w.__liveStates.push(`${el.getAttribute("status")}${el.hasAttribute("stale-since") ? "+stale" : ""}`);
    record();
    new MutationObserver(record).observe(el, { attributes: true, attributeFilter: ["status"] });
  });
  await page.waitForFunction(() => document.querySelector("#flaky-live")?.getAttribute("status") === "closed", null, { timeout: 5000 }).catch(() => {});
  const liveStates = await page.evaluate(() => (/** @type {any} */ (window)).__liveStates.join(" "));
  const staleSince = await page.getAttribute("#flaky-live", "stale-since");
  check(
    "<corten-live> shows connecting, live, reconnecting since it dropped, then closed",
    liveStates === "connecting live reconnecting+stale closed+stale" && !Number.isNaN(Date.parse(staleSince ?? "")) && (await page.textContent("#flaky")) === "One",
    `${liveStates}; stale since ${staleSince}`,
  );
  const statusEvents = await page.evaluate(() => (/** @type {any} */ (window)).__statusEvents.join(" "));
  check("each status change dispatches a bubbling corten-status", statusEvents === liveStates, `${statusEvents} against ${liveStates}`);
  await page.evaluate(() => document.querySelector("#flaky-live")?.remove());
  await page.unroute("**/live/flaky");

  // A <corten-live since> sends the page's cursor on its first connection; a fragment's id is the
  // cursor a reconnect sends back as Last-Event-ID, so the stream resumes there.
  /** @type {{ since: string | null, last: string | null }[]} */
  const resumes = [];
  await page.route("**/live/resume*", async (route) => {
    const req = route.request();
    resumes.push({ since: new URL(req.url()).searchParams.get("since"), last: (await req.allHeaders())["last-event-id"] ?? null });
    // The first answer ends without `end`, as a server that shuts down does: the browser reconnects.
    const body =
      resumes.length === 1
        ? 'retry: 100\n\nevent: patch\nid: c8\ndata: <p id="resume">At 8</p>\n\n'
        : 'event: patch\nid: c9\ndata: <p id="resume">At 9</p>\n\nevent: end\ndata: end\n\n';
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<corten-live id="resume-live" src="/live/resume" since="c7"><p id="resume">At 7</p></corten-live>')),
  );
  await page.waitForFunction(() => document.querySelector("#resume")?.textContent === "At 9", null, { timeout: 8000 }).catch(() => {});
  // Chromium adds Last-Event-ID below what Playwright's routing sees (a real server gets it, the
  // same as from the other two), so there the check is that the stream reconnected and went on.
  const headerSeen = engine !== "chromium";
  check(
    "<corten-live since> starts from the page's cursor and resumes from the last fragment's",
    (await page.textContent("#resume")) === "At 9" &&
      resumes.length === 2 &&
      resumes[0].since === "c7" &&
      resumes[0].last === null &&
      (!headerSeen || resumes[1].last === "c8"),
    JSON.stringify(resumes),
  );
  await page.evaluate(() => document.querySelector("#resume-live")?.remove());

  // A feed whose stream refuses the cursor its own snapshot gives as it opens (here every stream
  // is `sync`, as when one URL serves more than one feed) loads the snapshot again after a backoff
  // that doubles (1 s, then 2 s), not straight away in a loop, and stops when its signal aborts
  // (#1067). A `sync` that comes later on a stream (a server restarted, its cursor gone) loads the
  // snapshot at once.
  /**
   * Subscribes to a feed of the smoke's own at `/feed/{name}` and counts what it asks for: the
   * `n`th stream is answered `stream(n)` (a body, or a status with no stream), or sent to
   * `forward`, and the `n`th snapshot `snapshot(n)`'s status (200: epoch `a`, seq 1, no rows).
   * @param {string} name @param {(n: number) => string | { status: number }} stream
   * @param {{ forward?: string, snapshot?: (n: number) => number }} [options]
   */
  const feedTimes = async (name, stream, { forward, snapshot } = {}) => {
    const times = { snapshots: /** @type {number[]} */ ([]), streams: 0, streamsAt: /** @type {number[]} */ ([]), since: /** @type {(string | null)[]} */ ([]) };
    await page.route(`**/feed/${name}`, (route) => {
      times.snapshots.push(Date.now());
      const status = snapshot?.(times.snapshots.length) ?? 200;
      return route.fulfill({ status, contentType: "application/json", body: status === 200 ? '{"epoch":"a","seq":1,"rows":[]}' : "{}" });
    });
    await page.route(`**/feed/${name}/live*`, (route) => {
      times.streams += 1;
      times.streamsAt.push(Date.now());
      times.since.push(new URL(route.request().url()).searchParams.get("since"));
      if (forward) return route.continue({ url: forward });
      const answer = stream(times.streams);
      if (typeof answer !== "string") return route.fulfill({ status: answer.status, body: "" });
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: answer });
    });
    await page.evaluate(async (name) => {
      const { subscribe } = /** @type {any} */ (await import(/** @type {string} */ ("corten")));
      const w = /** @type {any} */ (window);
      w.__feeds ??= {};
      const stop = new AbortController();
      const feed = (w.__feeds[name] = { stop, states: /** @type {string[]} */ ([]), patches: /** @type {number[]} */ ([]) });
      subscribe(
        `/feed/${name}`,
        { snapshot() {}, patch: (/** @type {unknown} */ _, /** @type {number} */ seq) => feed.patches.push(seq), status: (/** @type {string} */ s) => feed.states.push(s) },
        { signal: stop.signal },
      );
    }, name);
    return times;
  };
  /** Aborts the subscription and gives its status calls. @param {string} name */
  const stopFeed = (name) =>
    page.evaluate((name) => {
      const feed = (/** @type {any} */ (window)).__feeds[name];
      feed.stop.abort();
      return /** @type {string} */ (feed.states.join(" "));
    }, name);
  /** The seqs the subscription handed to `patch`. @param {string} name */
  const feedPatches = (name) => page.evaluate((name) => /** @type {number[]} */ ((/** @type {any} */ (window)).__feeds[name].patches), name);
  /** Waits until the subscription has gone live `times` times. @param {string} name @param {number} times */
  const feedLive = (name, times, timeout = 5000) =>
    page
      .waitForFunction(
        ([name, times]) => (/** @type {any} */ (window)).__feeds[name].states.filter((/** @type {string} */ s) => s === "live").length >= times,
        /** @type {[string, number]} */ ([name, times]),
        { timeout },
      )
      .catch(() => {});
  /** @param {string} name */
  const unrouteFeed = async (name) => {
    await page.unroute(`**/feed/${name}`);
    await page.unroute(`**/feed/${name}/live*`);
  };
  const refusedFeed = await feedTimes("refused", () => 'event: sync\ndata: {"reason":"cursor-expired"}\n\n');
  for (const end = Date.now() + 6000; refusedFeed.snapshots.length < 3 && Date.now() < end; ) await page.waitForTimeout(50);
  const refusedAt = refusedFeed.snapshots.slice(0, 3);
  const refusedStates = await stopFeed("refused");
  // The next snapshot was due 4 s after the third: wait past it with the routes still counting.
  await page.waitForTimeout(5000);
  await unrouteFeed("refused");
  const gaps = refusedAt.slice(1).map((at, i) => at - refusedAt[i]);
  check(
    "a feed whose stream refuses its own snapshot's cursor backs off 1 s then 2 s, and stops when its signal aborts",
    gaps.length === 2 && gaps[0] >= 900 && gaps[0] < 1700 && gaps[1] >= 1900 && gaps[1] < 2800 && refusedFeed.snapshots.length === 3 && !refusedStates.includes("syncing syncing"),
    `snapshots ${gaps.map((g) => `+${g} ms`).join(", ")}, ${refusedFeed.snapshots.length - refusedAt.length} in the 5 s after the abort; ${refusedStates}`,
  );
  // The first stream is accepted and ends; the browser reconnects 400 ms later, and that stream
  // answers `sync` (a feed reset while the page was away); later streams are accepted.
  const quietFeed = await feedTimes("quiet", (n) => (n === 1 ? "retry: 400\n\n" : n === 2 ? 'event: sync\ndata: {"reason":"cursor-expired"}\n\n' : "retry: 60000\n\n"));
  await page.waitForTimeout(2000);
  await stopFeed("quiet");
  await unrouteFeed("quiet");
  const quietGap = quietFeed.snapshots.length === 2 ? quietFeed.snapshots[1] - quietFeed.snapshots[0] : NaN;
  check(
    "a sync on a stream the browser reconnected loads the snapshot at once, not after a backoff",
    quietFeed.snapshots.length === 2 && quietFeed.streams >= 2 && quietGap < 900,
    `${quietFeed.snapshots.length} snapshots, ${quietFeed.streams} streams, the second snapshot +${quietGap} ms after the first`,
  );
  // A feed reset while its stream is open: the first connection stays open, and 1.5 s after it
  // opened the server sends `sync`. A server of the smoke's own holds the stream (a route cannot
  // answer in two parts); later streams are held open with nothing on them.
  const resetName = "a sync on a stream open longer than its first moments loads the snapshot at once";
  if (engine === "webkit") skip(resetName, "a routed request is cross-origin there");
  else {
    /** @type {number[]} */
    const syncsSent = [];
    /** @type {import("node:http").ServerResponse[]} */
    const held = [];
    const resetServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write("retry: 60000\n\n");
      held.push(res);
      if (held.length === 1)
        setTimeout(() => {
          syncsSent.push(Date.now());
          res.end('event: sync\ndata: {"reason":"cursor-expired"}\n\n');
        }, 1500);
    });
    await new Promise((resolve) => resetServer.listen(0, "127.0.0.1", () => resolve(undefined)));
    const resetPort = /** @type {import("node:net").AddressInfo} */ (resetServer.address()).port;
    /** @type {Awaited<ReturnType<typeof feedTimes>>} */
    let resetFeed = { snapshots: [], streams: 0, streamsAt: [], since: [] };
    try {
      resetFeed = await feedTimes("reset", () => "", { forward: `http://127.0.0.1:${resetPort}/live` });
      for (const end = Date.now() + 5000; resetFeed.snapshots.length < 2 && Date.now() < end; ) await page.waitForTimeout(50);
      await stopFeed("reset");
    } finally {
      await unrouteFeed("reset");
      for (const res of held) res.destroy();
      resetServer.close();
    }
    const resetGap = resetFeed.snapshots.length === 2 && syncsSent.length ? resetFeed.snapshots[1] - syncsSent[0] : NaN;
    check(resetName, resetFeed.snapshots.length === 2 && resetGap < 500, `${resetFeed.snapshots.length} snapshots, the second ${resetGap} ms after the sync was sent`);
  }

  // subscribe()'s other recovery paths (#1068). A patch already applied is dropped, and one that
  // skips a seq loads a new snapshot: seq 2, 2 again, 3, then 5.
  const feedsLogged = errors.length;
  located = true;
  /** @param {number} seq */
  const patchEvent = (seq) => `event: patch\nid: a-${seq}\ndata: {"seq":${seq},"changes":[]}\n\n`;
  const gapFeed = await feedTimes("gap", (n) => (n === 1 ? `${patchEvent(2)}${patchEvent(2)}${patchEvent(3)}${patchEvent(5)}` : "retry: 60000\n\n"));
  await feedLive("gap", 2);
  const gapPatches = await feedPatches("gap");
  const gapStates = await stopFeed("gap");
  await unrouteFeed("gap");
  check(
    "a patch that skips a seq loads a new snapshot, and a patch already applied is dropped",
    gapFeed.snapshots.length === 2 && gapFeed.streams === 2 && gapPatches.join() === "2,3" && gapFeed.since[1] === "a-1" && gapStates.startsWith("syncing live syncing live"),
    `${gapFeed.snapshots.length} snapshots, patches ${gapPatches.join(",")}, second stream since ${gapFeed.since[1]}; ${gapStates}`,
  );
  // A stream answered with an HTTP error ends EventSource for good: subscribe() listens again from
  // the last patch's cursor, with no snapshot, waiting longer after each error in a row (1 s, 2 s),
  // and a stream that opens starts the count again (1 s). The first stream sends seq 2 and ends;
  // the browser reconnects (after 100 ms) to a 503, then subscribe() twice more, to a 503 and a
  // stream that ends; the browser reconnects to a 503, and subscribe() to a stream.
  const failedFeed = await feedTimes("failed", (n) =>
    n === 1 ? `retry: 100\n\n${patchEvent(2)}` : n === 4 ? "retry: 100\n\n" : n <= 5 ? { status: 503 } : "retry: 60000\n\n",
  );
  await feedLive("failed", 3, 10000);
  const failedStates = await stopFeed("failed");
  await unrouteFeed("failed");
  const failedGaps = [2, 3, 5].map((i) => failedFeed.streamsAt[i] - failedFeed.streamsAt[i - 1]);
  check(
    "a stream answered with an error is listened to again from the last patch, after 1 s then 2 s, and 1 s again after a stream opened, with no snapshot",
    failedFeed.snapshots.length === 1 &&
      failedFeed.streams === 6 &&
      failedFeed.since.slice(2).every((since) => since === "a-2") &&
      failedGaps[0] >= 900 &&
      failedGaps[0] < 1900 &&
      failedGaps[1] >= 1900 &&
      failedGaps[1] < 3500 &&
      failedGaps[2] >= 900 &&
      failedGaps[2] < 1900 &&
      failedStates.includes("reconnecting live"),
    `${failedFeed.snapshots.length} snapshots, ${failedFeed.streams} streams since ${failedFeed.since.join(" ")}, ${failedGaps.map((g) => `+${g} ms`).join(", ")}; ${failedStates}`,
  );
  // A snapshot that fails is fetched again after 1 s, and the feed goes live once one arrives.
  const retriedFeed = await feedTimes("retried", () => "retry: 60000\n\n", { snapshot: (n) => (n === 1 ? 500 : 200) });
  await feedLive("retried", 1);
  const retriedStates = await stopFeed("retried");
  await unrouteFeed("retried");
  const retriedGap = retriedFeed.snapshots.length === 2 ? retriedFeed.snapshots[1] - retriedFeed.snapshots[0] : NaN;
  check(
    "a snapshot that fails is fetched again after 1 s, and the feed goes live",
    retriedFeed.snapshots.length === 2 && retriedGap >= 900 && retriedGap < 1900 && retriedFeed.streams === 1 && retriedStates.startsWith("syncing live"),
    `${retriedFeed.snapshots.length} snapshots, +${retriedGap} ms, ${retriedFeed.streams} streams; ${retriedStates}`,
  );
  // The browsers' own errors for the 503 streams and the 500 snapshot are the point of these
  // checks, not faults, and the runtime logs the failed snapshot once (Firefox gives the logged
  // error's text as `Error`, so there it is known by coming from the runtime).
  located = false;
  const feedErrors = errors.slice(feedsLogged).filter((e) => !/(can.t establish a connection to the server at|Failed to load resource: .* at) \S+\/feed\/(failed|retried)\b/.test(e));
  const snapshotLogged = feedErrors.filter((e) => /^(Error: )?corten: feed \/feed\/retried answered 500\b|^Error at \S+\/corten\.js$/.test(e));
  check("a snapshot that fails is logged once", snapshotLogged.length === 1, feedErrors.join(" | ") || "nothing logged");
  const feedOthers = feedErrors.filter((e) => !snapshotLogged.includes(e));
  // Checked here, while their text names where each came from, and not again at the end.
  check("the feed checks log no other console error", feedOthers.length === 0, feedOthers.join(" | "));
  errors.splice(feedsLogged);

  // A patch replaces markup but keeps what the user is doing: edited fields keep their state,
  // untouched ones take the server's, and focus and caret stay put (here a <corten-live> style
  // patch, with no form sent).
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      __html('<form id="kept"><input name="q" value="a"><input name="r" value="a"><input type="checkbox" name="c" value="1"><select name="s"><option value="1">1</option><option value="2">2</option></select><select name="t"><option value="1">1</option><option value="2">2</option></select><select name="m" multiple><option value="1">1</option><option value="2">2</option><option value="3">3</option></select><p><button type="button">Go</button></p></form>'),
    ),
  );
  await page.selectOption("#kept [name=m]", ["1", "3"]);
  await page.fill("#kept [name=q]", "typed");
  await page.check("#kept [name=c]");
  await page.selectOption("#kept [name=s]", "2");
  await page.focus("#kept [name=q]");
  await page.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("#kept [name=q]")).setSelectionRange(1, 3));
  const fresh =
    '<form id="kept" class="new"><input name="q" value="b"><input name="r" value="b"><input type="checkbox" name="c" value="1"><select name="s"><option value="1">1</option><option value="2">2</option></select><select name="t"><option value="1">1</option><option value="2" selected>2</option></select><select name="m" multiple><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option></select><p><button type="button">Go</button></p></form>';
  const afterLive = await page.evaluate(async (html) => {
    const { patch } = await import("corten");
    await patch(__html(html));
    const q = /** @type {HTMLInputElement} */ (document.querySelector("#kept [name=q]"));
    return {
      server: document.querySelector("#kept")?.className,
      q: q.value,
      r: /** @type {HTMLInputElement} */ (document.querySelector("#kept [name=r]")).value,
      c: /** @type {HTMLInputElement} */ (document.querySelector("#kept [name=c]")).checked,
      s: /** @type {HTMLSelectElement} */ (document.querySelector("#kept [name=s]")).value,
      t: /** @type {HTMLSelectElement} */ (document.querySelector("#kept [name=t]")).value,
      m: Array.from(/** @type {HTMLSelectElement} */ (document.querySelector("#kept [name=m]")).selectedOptions, (o) => o.value).join(),
      focused: document.activeElement === q,
      selection: [q.selectionStart, q.selectionEnd],
    };
  }, fresh);
  check(
    "a patch keeps edited fields, focus and selection, and applies the rest",
    afterLive.server === "new" && afterLive.q === "typed" && afterLive.r === "b" && afterLive.c && afterLive.s === "2" && afterLive.t === "2" && afterLive.m === "1,3" && afterLive.focused && afterLive.selection.join() === "1,3",
    JSON.stringify(afterLive),
  );

  // What the user opened stays open across a patch (a modal dialog modal), and what the server
  // sent open and then closes closes.
  const block = (/** @type {number} */ n, /** @type {string} */ extra) =>
    `<section id="opened"><p>${n}</p><dialog id="opened-modal"><button type="button" id="opened-in">In</button></dialog><dialog id="opened-plain"></dialog><details id="opened-more"><summary>More</summary><p>Folded</p></details><div id="opened-pop" popover>Pop</div><dialog id="opened-served"${extra}></dialog></section>`;
  await page.evaluate((html) => document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(html)), block(1, " open"));
  const openedState = await page.evaluate(async ([first, second]) => {
    const { patch } = await import("corten");
    const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
    // Markup a patch put in is what the server sent: open the served one, then the user's.
    await patch(__html(first));
    $("opened-modal").showModal();
    $("opened-plain").show();
    $("opened-more").open = true;
    $("opened-pop").showPopover();
    // Last: opening a dialog moves focus.
    $("opened-in").focus();
    await patch(__html(second));
    return {
      count: document.querySelector("#opened p")?.textContent,
      modal: $("opened-modal").matches(":modal"),
      plain: $("opened-plain").open && !$("opened-plain").matches(":modal"),
      more: $("opened-more").open,
      pop: $("opened-pop").matches(":popover-open"),
      served: $("opened-served").open,
      focused: document.activeElement?.id,
    };
  }, [block(2, " open"), block(3, "")]);
  await page.evaluate(() => {
    for (const d of Array.from(document.querySelectorAll("#opened dialog"))) /** @type {HTMLDialogElement} */ (d).close();
    document.querySelector("#opened")?.remove();
  });
  check(
    "a patch keeps a dialog, details and popover the user opened, and closes one the server closes",
    openedState.count === "3" && openedState.modal && openedState.plain && openedState.more && openedState.pop && openedState.served === false && openedState.focused === "opened-in",
    JSON.stringify(openedState),
  );
  // A table with a menu on every row: a patch of it keeps the one details (found by its place in
  // its row) and the one popover (by id) the user opened, and the rest stay as the server sent them.
  const menus = await page.evaluate(async () => {
    const { patch } = await import("corten");
    const table = (/** @type {number} */ n) =>
      `<table id="menus"><tbody>${Array.from({ length: 300 }, (_, i) => `<tr id="menus-r${i}"><td>${n}</td><td><details><summary>More</summary><p>${i}</p></details><div popover id="menus-m${i}">Edit</div></td></tr>`).join("")}</tbody></table>`;
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<table id="menus"></table>'));
    await patch(__html(table(1)));
    /** @type {HTMLDetailsElement} */ (document.querySelector("#menus-r7 details")).open = true;
    /** @type {HTMLElement} */ (document.getElementById("menus-m9")).showPopover();
    await patch(__html(table(2)));
    const got = {
      count: document.querySelector("#menus-r0 td")?.textContent,
      details: /** @type {HTMLDetailsElement} */ (document.querySelector("#menus-r7 details")).open,
      open: document.querySelectorAll("#menus details[open]").length,
      pop: document.querySelectorAll("#menus :popover-open").length === 1 && document.getElementById("menus-m9")?.matches(":popover-open"),
    };
    /** @type {HTMLElement} */ (document.getElementById("menus-m9")).hidePopover();
    document.getElementById("menus")?.remove();
    return got;
  });
  check("a patch of rows with a menu each keeps the details and popover the user opened", menus.count === "2" && menus.details && menus.open === 1 && menus.pop, JSON.stringify(menus));
  await page.focus("#kept button");
  const buttonFocus = await page.evaluate(async (html) => {
    const { patch } = await import("corten");
    await patch(__html(html));
    return document.activeElement === document.querySelector("#kept button");
  }, fresh);
  check("a patch keeps focus on an element without an id or name (by its place)", buttonFocus);
  await page.evaluate(() => document.querySelector("#kept")?.remove());

  // A patch that takes the focused element away leaves focus near it, not on the body (#267): the
  // counterpart of its nearest ancestor that has one, focusable for the move only.
  await page.evaluate(() =>
    document
      .querySelector("main")
      ?.insertAdjacentHTML("beforeend", __html('<section id="rows-gone"><ul><li id="row-a"><button>Remove A</button></li><li id="row-b"><button>Remove B</button></li></ul></section><ul id="list-gone"><li id="item-a"><button>Remove</button></li></ul>')),
  );
  await page.focus("#row-b button");
  const lostRow = await page.evaluate(async () => {
    const { patch } = await import("corten");
    await patch(__html('<section id="rows-gone"><ul><li id="row-a"><button>Remove A</button></li></ul></section>'));
    const at = document.activeElement;
    const list = document.querySelector("#rows-gone ul");
    const was = at?.getAttribute("tabindex");
    /** @type {HTMLElement} */ (document.querySelector("#row-a button")).focus();
    return { onList: at === list, was, after: list?.getAttribute("tabindex") ?? null };
  });
  check("a patch that replaces the focused row leaves focus on its list, focusable only until it leaves", lostRow.onList && lostRow.was === "-1" && lostRow.after === null, JSON.stringify(lostRow));
  // The same patch again (a live stream, a read again) keeps focus there, not one level up each time.
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector("#rows-gone ul")).focus());
  const again = await page.evaluate(async () => {
    const { patch } = await import("corten");
    // The list is focused (made focusable for the move above, as the runtime would).
    const list = /** @type {HTMLElement} */ (document.querySelector("#rows-gone ul"));
    list.tabIndex = -1;
    list.focus();
    const html = '<section id="rows-gone"><ul><li id="row-a"><button>Remove A</button></li></ul></section>';
    await patch(__html(html));
    await patch(__html(html));
    return document.activeElement === document.querySelector("#rows-gone ul");
  });
  check("the same patch twice leaves focus on the list", again);
  // The patched element had focus and its replacement cannot take it: the element around it.
  await page.evaluate(() => document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="follow-around"><button id="follow">Follow</button></div>')));
  await page.focus("#follow");
  const disabled = await page.evaluate(async () => {
    const { patch } = await import("corten");
    await patch(__html('<button id="follow" disabled>Following</button>'));
    const at = document.activeElement?.id;
    document.querySelector("#follow-around")?.remove();
    return at;
  });
  check("a focused element patched into one that cannot take focus leaves focus around it", disabled === "follow-around", disabled);
  await page.focus("#item-a button");
  const lostItem = await page.evaluate(async () => {
    const { patch } = await import("corten");
    await patch(__html('<template id="item-a" data-remove></template>'));
    return document.activeElement?.id;
  });
  check("a patch that removes the focused element leaves focus on its parent", lostItem === "list-gone", lostItem);
  await page.evaluate(() => ["#rows-gone", "#list-gone"].forEach((s) => document.querySelector(s)?.remove()));

  // A form with a control named id (`form.id` is that control): its patch still finds it, and in
  // a patched block an edited field inside it keeps the user's text.
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<form id="named-id"><input name="id" value="7"><p>old</p></form><div id="holds-named"><form><input name="id"><input name="q" value="a"></form></div>')),
  );
  await page.fill("#holds-named [name=q]", "typed");
  const namedId = await page.evaluate(async () => {
    const { patch } = await import("corten");
    await patch(__html('<form id="named-id"><input name="id" value="7"><p>new</p></form><div id="holds-named" class="new"><form><input name="id"><input name="q" value="b"></form></div>'));
    return {
      form: document.querySelector("#named-id p")?.textContent,
      block: document.querySelector("#holds-named")?.className,
      q: /** @type {HTMLInputElement} */ (document.querySelector("#holds-named [name=q]")).value,
    };
  });
  check("a form with a control named id is patched, and keeps what the user typed", namedId.form === "new" && namedId.block === "new" && namedId.q === "typed", JSON.stringify(namedId));
  await page.evaluate(() => {
    document.querySelector("#named-id")?.remove();
    document.querySelector("#holds-named")?.remove();
  });

  // A file input keeps the files the user chose across a patch, which markup cannot give back: a
  // refusal redraws it marked invalid with the file still chosen, a live patch keeps it, and only
  // the answer that took those files clears them.
  const part = (/** @type {string} */ extra) => `<div id="upload-part"${extra}><input type="file" name="photo"${extra.includes("refused") ? ' aria-invalid="true"' : ""}></div>`;
  await page.evaluate(
    (html) => document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<form id="upload" method="post" action="/upload-test" enctype="multipart/form-data" data-patch>${html}<button>Send</button></form>`)),
    part(""),
  );
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
  const errorsBeforeUpload = errors.length;
  let uploadStatus = 422;
  await page.route("**/upload-test", (route) =>
    route.fulfill({ status: uploadStatus, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body: part(uploadStatus === 422 ? ' class="refused"' : ' class="taken"') }),
  );
  await page.setInputFiles("#upload [name=photo]", { name: "card.png", mimeType: "image/png", buffer: Buffer.from("png") });
  const chosenFiles = () => page.evaluate(() => Array.from(/** @type {HTMLInputElement} */ (document.querySelector("#upload [name=photo]")).files ?? [], (f) => f.name).join());
  await page.click("#upload button");
  await page.waitForSelector("#upload-part.refused", { timeout: 4000 }).catch(() => {});
  const refusedFiles = await chosenFiles();
  const markedInvalid = await page.getAttribute("#upload [name=photo]", "aria-invalid");
  await page.evaluate(async (html) => {
    const { patch } = await import("corten");
    await patch(__html(html));
  }, part(' class="live"'));
  const liveFiles = await chosenFiles();
  uploadStatus = 200;
  await page.click("#upload button");
  await page.waitForSelector("#upload-part.taken", { timeout: 4000 }).catch(() => {});
  const takenFiles = await chosenFiles();
  await page.unroute("**/upload-test");
  await page.evaluate(() => document.querySelector("#upload")?.remove());
  // The refusal is a 422 on purpose; the browser logs that as a failed resource.
  errors.splice(errorsBeforeUpload, Infinity, ...errors.slice(errorsBeforeUpload).filter((e) => !e.includes("422")));
  check(
    "a patch keeps a file input's chosen files until the answer that took them",
    refusedFiles === "card.png" && markedInvalid === "true" && liveFiles === "card.png" && takenFiles === "",
    JSON.stringify({ refusedFiles, markedInvalid, liveFiles, takenFiles }),
  );

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

  // Swaps only: these links live in the shell, which a full page load replaces.
  if (swaps) {
    // data-nav="section": current on its page and every page under it. Of the links of one
    // data-nav-group (Req::nav_of), only the deepest that holds the page is current, wherever
    // they are: group "a" is split between a <nav> and an <aside>; group "b" is another nav.
    await page.evaluate(() => {
      document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a id="section-link" href="/" data-nav="section">All</a>'));
      document.querySelector("header")?.insertAdjacentHTML(
        "beforeend",
        __html('<nav><a id="group-all" href="/" data-nav="section" data-nav-group="a">All</a></nav>' +
          '<aside><a id="group-news" href="/news" data-nav data-nav-group="a">News</a></aside>' +
          '<nav><a id="other-all" href="/" data-nav="section" data-nav-group="b">All</a></nav>'),
      );
    });
    await page.click('header a[href="/"]:not(#section-link, #group-all, #other-all)');
    await page.waitForFunction(() => document.title === "Stocks | Watchlist");
    await page.click('header nav a[href="/news"]');
    await page.waitForFunction(() => document.title === "News | Watchlist");
    const marks = await page.evaluate(() =>
      ["section-link", "group-all", "group-news", "other-all"].map((id) => document.getElementById(id)?.getAttribute("aria-current") ?? "-").join(" "),
    );
    check(
      'data-nav="section" marks the link on pages under it',
      marks.startsWith("page ") && (await page.getAttribute('header a[href="/"]:not(#section-link, #group-all, #other-all)', "aria-current")) === null,
      marks,
    );
    check("in one data-nav-group only the deepest link that holds the page is current", marks === "page - page page", marks);
    await page.evaluate(() => {
      document.getElementById("section-link")?.remove();
      for (const id of ["group-all", "group-news", "other-all"]) document.getElementById(id)?.parentElement?.remove();
    });

    // data-no-prefetch: hovering does not fetch; an ordinary link does (the control).
    await page.evaluate(() =>
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<p><a id="no-prefetch" href="/" data-no-prefetch>Home</a> <a id="prefetch" href="/?from=hover">Home</a></p>')),
    );
    // Each count is read once the request it counts has been seen, not after a pause (#1053). A
    // request may be a prefetch (true), a visit (false) or either (undefined).
    /** @param {string} search @param {boolean} [prefetch] */
    const navTo = (search, prefetch) =>
      page
        .waitForRequest(
          (request) =>
            request.headers()["corten"] === "nav" &&
            new URL(request.url()).search === search &&
            (prefetch === undefined || (request.headers()["purpose"] === "prefetch") === prefetch),
          { timeout: 15_000 },
        )
        .catch(() => null);
    navRequests.length = 0;
    await page.hover("#no-prefetch");
    // Nothing to wait for: the check is that no request comes. The pause is the page's own timer,
    // set after the hover's dwell timer, so it ends after the dwell would have fetched.
    await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
    const afterOptOut = navRequests.length;
    const control = navTo("?from=hover", true);
    await page.hover("#prefetch");
    const controlSeen = (await control) !== null;
    check("data-no-prefetch: hovering the link fetches nothing", afterOptOut === 0 && controlSeen && navRequests.length === 1, `${afterOptOut} then ${navRequests.join()}`);

    // The prefetch cache keeps the 8 newest pages: after hovering 9 links, following the oldest of
    // the 8 kept and the newest reuses their prefetches, so a cache of fewer than 8 fails here, and
    // following the oldest fetches it again, so one of more than 8 fails. The links sit in the
    // shell, which navigation keeps.
    await page.evaluate(() =>
      document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html(Array.from({ length: 9 }, (_, i) => `<a class="hovered" href="/news?p=${i}">${i}</a>`).join(" "))),
    );
    let p1Prefetched = 0;
    for (let i = 0; i < 9; i += 1) {
      const prefetched = navTo(`?p=${i}`, true);
      await page.hover(`header a.hovered[href="/news?p=${i}"]`);
      await prefetched;
      if (i === 1) p1Prefetched = Date.now();
    }
    const hoveredCount = navRequests.length;
    // A prefetch older than the runtime's 10 s is not reused, so a slow run is told apart from a
    // cache that keeps too few. The age runs from when the prefetch was seen, so it reads low.
    const p1Age = Date.now() - p1Prefetched;
    await page.click('header a.hovered[href="/news?p=1"]');
    await page.waitForFunction(() => location.search === "?p=1");
    await page.click('header a.hovered[href="/news?p=8"]');
    await page.waitForFunction(() => location.search === "?p=8");
    // The oldest is fetched again by its click, or by its hover's dwell when that ends first.
    const fetchedAgain = navTo("?p=0");
    await page.click('header a.hovered[href="/news?p=0"]');
    await page.waitForFunction(() => location.search === "?p=0");
    // Playwright can report the request after the address changes.
    const oldestFetched = (await fetchedAgain) !== null;
    // The oldest kept and the newest were reused: no visit fetched either, however late its
    // request was reported.
    const keptFetched = ["/news?p=1", "/news?p=8"].filter((path) => navRequests.includes(new URL(path, base).href));
    check(
      "prefetch keeps the 8 newest pages: the oldest kept and the newest are reused, the oldest is fetched again",
      hoveredCount === 10 && keptFetched.length === 0 && oldestFetched && navRequests.length === 11,
      `${hoveredCount}, ${oldestFetched ? "" : "the oldest not fetched again, "}${keptFetched.length ? `fetched ${keptFetched.join(" ")}` : "both reused"} (p1 prefetch seen about ${p1Age} ms before its click), ${navRequests.length}: ${navRequests.map((u) => u.replace(base, "")).join(" ")}`,
    );

    // The page a visit is fetching is not prefetched as well, by the dwell the click cut short or
    // by the pointer leaving its link and coming back: the address stays this page's until that
    // page is in, so the prefetch would fetch it a second time (#1053). Its answer is held until
    // both dwells have ended, however long the hover takes: once the address changes, a dwell
    // finds its link is this page and fetches nothing, so the check would pass untested. A
    // prefetch is held too: one sent before the click, when a slow click lets the first dwell end,
    // is the fetch the visit reuses, and still counts once.
    if (await page.evaluate(precommits)) {
      await page.evaluate(() => document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a class="hovered" href="/news?p=held">held</a>')));
      /** @param {URL} url */
      const heldPage = (url) => url.pathname === "/news" && url.searchParams.get("p") === "held";
      /** @type {() => void} */
      let releaseHeld = () => {};
      const heldReleased = new Promise((resolve) => (releaseHeld = () => resolve(undefined)));
      await page.route(heldPage, async (route) => {
        await heldReleased;
        await route.continue().catch(() => {});
      });
      navRequests.length = 0;
      await page.click('header a.hovered[href="/news?p=held"]');
      await page.mouse.move(0, 0);
      await page.hover('header a.hovered[href="/news?p=held"]');
      // The page's own timer, set after the hover's dwell timer, ends after the dwell would have
      // fetched; only then is the answer let through.
      await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
      const heldSearch = await page.evaluate(() => location.search);
      releaseHeld();
      await page.waitForFunction(() => location.search === "?p=held");
      check(
        "a link followed during its hover's dwell is fetched once, with no prefetch of its page",
        heldSearch !== "?p=held" && navRequests.length === 1,
        `${heldSearch === "?p=held" ? "the address changed before the dwell ended: not tested; " : ""}${navRequests.map((u) => u.replace(base, "")).join(" ") || "none"}`,
      );
      await page.unroute(heldPage);
    } else {
      skip("a link followed during its hover's dwell is fetched once, with no prefetch of its page", "no precommitHandler: the address changes at the click");
    }
    await page.evaluate(() => document.querySelectorAll("header a.hovered").forEach((a) => a.remove()));

    // A prefetch pushed out while its answer is still coming is aborted, so the server sees the
    // client go: the oldest of 9 hovered links is held until it is dropped.
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    await page.route("**/news?q=0", async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    const aborted = page.waitForEvent("requestfailed", { predicate: (r) => r.url().endsWith("/news?q=0"), timeout: 5000 }).then(
      () => true,
      () => false,
    );
    await page.evaluate(() =>
      document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html(Array.from({ length: 9 }, (_, i) => `<a class="hovered" href="/news?q=${i}">${i}</a>`).join(" "))),
    );
    for (let i = 0; i < 9; i += 1) {
      await page.hover(`header a.hovered[href="/news?q=${i}"]`);
      await page.waitForTimeout(150);
    }
    check("a prefetch dropped before it answers is aborted", await aborted);
    release();
    await page.unroute("**/news?q=0");
    await page.evaluate(() => document.querySelectorAll("header a.hovered").forEach((a) => a.remove()));

    // A hover's request says it is a prefetch (`purpose: prefetch`), so a debug build can name a
    // page too costly to fetch on a hover; the click it is used for is a swap.
    /** @type {string[]} */
    const purposes = [];
    await page.route("**/news?r=1", async (route) => {
      purposes.push(route.request().headers()["purpose"] ?? "");
      await route.continue().catch(() => {});
    });
    await page.evaluate(() => document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a class="hovered" href="/news?r=1">r</a>')));
    await page.hover('header a.hovered[href="/news?r=1"]');
    for (let waited = 0; purposes.length < 1 && waited < 2000; waited += 50) await page.waitForTimeout(50);
    await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 6));
    await page.click('header a.hovered[href="/news?r=1"]');
    await page.waitForFunction(() => document.title === "News | Watchlist" && location.search === "?r=1");
    const swappedAfterPrefetch = await page.evaluate(() => (/** @type {any} */ (window)).__marker === 6);
    check(
      "a hover's prefetch says so (purpose: prefetch), and the click uses it",
      purposes.join() === "prefetch" && swappedAfterPrefetch,
      `${purposes.join()} ${swappedAfterPrefetch}`,
    );
    await page.unroute("**/news?r=1");
    await page.evaluate(() => document.querySelectorAll("header a.hovered").forEach((a) => a.remove()));

    // A prefetch answered with something that is not a page (a proxy's 204) is not handed to the
    // click: it fetches the page again and swaps it in, rather than load the document in full.
    /** @type {string[]} */
    const asked = [];
    await page.route("**/news?r=2", async (route) => {
      const purpose = route.request().headers()["purpose"] ?? "";
      asked.push(purpose || "click");
      if (purpose === "prefetch") return route.fulfill({ status: 204 });
      await route.continue().catch(() => {});
    });
    await page.evaluate(() => document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a class="hovered" href="/news?r=2">r</a>')));
    await page.hover('header a.hovered[href="/news?r=2"]');
    for (let waited = 0; asked.length < 1 && waited < 2000; waited += 50) await page.waitForTimeout(50);
    // Hovered again within the prefetch's 10 s, the refused answer is not asked for again.
    await page.hover('header a[href="/news"]');
    await page.waitForTimeout(150);
    await page.hover('header a.hovered[href="/news?r=2"]');
    await page.waitForTimeout(300);
    const askedOnce = asked.join();
    await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 7));
    await page.click('header a.hovered[href="/news?r=2"]');
    await page.waitForFunction(() => document.title === "News | Watchlist" && location.search === "?r=2");
    const swappedAfterNotAPage = await page.evaluate(() => (/** @type {any} */ (window)).__marker === 7);
    check(
      "a prefetch answered with no page is not asked for again on a hover, is fetched again on the click, and swapped in",
      askedOnce === "prefetch" && asked.join() === "prefetch,click" && swappedAfterNotAPage,
      `${askedOnce} then ${asked.join()} ${swappedAfterNotAPage}`,
    );
    await page.unroute("**/news?r=2");
    await page.evaluate(() => document.querySelectorAll("header a.hovered").forEach((a) => a.remove()));

    // A prefetch answered with Corten's own redirect (`corten-location`, a route to a place on a
    // page or another origin) is the visit: the click follows it with no further request.
    /** @type {string[]} */
    const sent = [];
    await page.route("**/news?r=3", async (route) => {
      sent.push(route.request().headers()["purpose"] || "click");
      return route.fulfill({ status: 204, headers: { "corten-location": "/news?r=4" } });
    });
    await page.evaluate(() => document.querySelector("header nav")?.insertAdjacentHTML("beforeend", __html('<a class="hovered" href="/news?r=3">r</a>')));
    await page.hover('header a.hovered[href="/news?r=3"]');
    for (let waited = 0; sent.length < 1 && waited < 2000; waited += 50) await page.waitForTimeout(50);
    await page.click('header a.hovered[href="/news?r=3"]');
    await page.waitForFunction(() => document.title === "News | Watchlist" && location.search === "?r=4");
    check("a prefetch answered with Corten's redirect is followed on the click with no further request", sent.join() === "prefetch", sent.join());
    await page.unroute("**/news?r=3");

    // A section stylesheet that fails to load: the runtime loads the page in full instead of
    // showing it unstyled. A fresh document, so the stylesheet is not already in it.
    await page.goto(base);
    let failStyle = true;
    await page.route("**/sections/**", (route) => {
      if (!failStyle) return route.continue();
      failStyle = false;
      return route.abort("internetdisconnected");
    });
    const logged = errors.length;
    await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 5));
    await page.click('header a[href="/news"]');
    await page.waitForFunction(() => document.title === "News | Watchlist" && document.readyState === "complete");
    check(
      "a section stylesheet that fails to load makes the page load in full",
      !failStyle && (await page.evaluate(() => (/** @type {any} */ (window)).__marker === undefined)) && (await noteBorder()) === "4px",
    );
    await page.unroute("**/sections/**");
    // The browser logs the stylesheet it could not load.
    errors.splice(logged, errors.length, ...errors.slice(logged).filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e)));
  } else {
    for (const name of [
      'data-nav="section" marks the link on pages under it',
      "data-no-prefetch: hovering the link fetches nothing",
      "prefetch keeps the 8 newest pages",
      "a link followed during its hover's dwell is fetched once, with no prefetch of its page",
      "a prefetch dropped before it answers is aborted",
      "a hover's prefetch says so (purpose: prefetch), and the click uses it",
      "a prefetch answered with no page is not asked for again on a hover, is fetched again on the click, and swapped in",
      "a prefetch answered with Corten's redirect is followed on the click with no further request",
      "a section stylesheet that fails to load makes the page load in full",
    ])
      skip(name, noSwaps);
  }

  // With the browser's data saver on, hovering fetches nothing.
  const saver = await browser.newContext();
  await saver.addInitScript(() => Object.defineProperty(Navigator.prototype, "connection", { get: () => ({ saveData: true }) }));
  const saving = await saver.newPage();
  /** @type {string[]} */
  const savingRequests = [];
  saving.on("request", (request) => request.headers()["corten"] === "nav" && savingRequests.push(request.url()));
  await saving.goto(`${base}/news`);
  await saving.hover('header a[href="/"]');
  await saving.waitForTimeout(300);
  check("data saver: hovering a link fetches nothing", savingRequests.length === 0, savingRequests.join());
  await saver.close();

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
    // read; the next is still made, so the page does not stop short of the write.
    if (swaps) {
      // The page must come in still saving, or it starts no read to cancel; a write that landed
      // first is tried again.
      let waiting = false;
      for (let tries = 0; tries < 3 && !waiting; tries++) {
        await page.goto(await pending());
        waiting = (await saved()) === "Saving...";
      }
      const slow = async (/** @type {import("@playwright/test").Route} */ route) => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        await route.fallback().catch(() => {});
      };
      await page.route("**/alerts?saved=*", slow);
      let cancelled = 0;
      const onFailed = (/** @type {import("@playwright/test").Request} */ r) => void (r.url().includes("/alerts?saved=") && cancelled++);
      page.on("requestfailed", onFailed);
      const from = reads.length;
      for (let waited = 0; reads.length === from && waited < 5000; waited += 50) await page.waitForTimeout(50);
      await page.evaluate(() => {
        const to = new URL(location.href);
        to.searchParams.set("shown", "2");
        history.replaceState(history.state, "", to);
      });
      await page.unroute("**/alerts?saved=*", slow);
      await savedSoon();
      page.off("requestfailed", onFailed);
      if (waiting)
        check(
          "a read a script's replaceState cancels on its way is made again",
          (await saved()) === "Saved." && cancelled > 0 && reads.length > from + 1,
          `${await saved()} after ${reads.length - from} reads, ${cancelled} cancelled`,
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
    await page.click(save);
    await page.waitForSelector('input[name=above][aria-invalid="true"]', { timeout: 5000 }).catch(() => {});
    const refused = await page.evaluate(() => ({
      message: document.getElementById("alert-form-above-error")?.textContent,
      focused: document.activeElement?.getAttribute("name"),
      value: /** @type {HTMLInputElement | null} */ (document.querySelector("input[name=above]"))?.value,
    }));
    check(
      "a refused field comes back marked, with its message and focus",
      refused.message === "Enter a price in dollars and cents, such as 129.99." && refused.focused === "above" && refused.value === "1.234",
      JSON.stringify(refused),
    );
    // The browser logs the 422 as a failed resource; Corten adds nothing.
    const refusedLogs = errors.slice(errorsAtRefusal);
    check("a refused field logs no console error of Corten's", refusedLogs.every((e) => e.includes("422")), refusedLogs.join(" | "));
    errors.splice(errorsAtRefusal);
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

  // A multipart form is sent as FormData. /watch reads a URL-encoded form, so axum rejects it with
  // plain text, which a browser never sees: it gets the app's error page.
  await page.waitForSelector(`${live}[data-status="live"]`, { timeout: 5000 }).catch(() => {});
  /** @type {string[]} */
  const types = [];
  const onRequest = (/** @type {import("@playwright/test").Request} */ r) => r.url().endsWith("/watch") && types.push(r.headers()["content-type"] ?? "");
  page.on("request", onRequest);
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      __html('<form id="multipart" method="post" action="/watch" enctype="multipart/form-data" data-patch><input type="hidden" name="id" value="ACME"><button>Watch</button></form>'),
    ),
  );
  await page.click("#multipart button");
  await page.waitForFunction(() => document.title !== "Stocks | Watchlist", null, { timeout: 4000 }).catch(() => {});
  page.off("request", onRequest);
  check("a multipart form is posted as multipart/form-data", types.length === 1 && types[0].startsWith("multipart/form-data"), types.join());
  check("a request the server rejects shows the app's error page, in its layout", (await page.textContent("main h1")) === "Something went wrong" && (await page.title()) === "Something went wrong | Watchlist", await page.title());

  // A form with a file, read as it arrives in each engine's multipart body: the account page's
  // picture. Its type is read from its bytes, and the answer shows it in the header and on the
  // page, from a URL every cache keeps. WebKit does not send its sign-in's Secure cookie back over
  // http, so it signs in through the API and is given the session's token in a cookie it does.
  const errorsBefore = errors.length;
  if (!signsIn) {
    const signedIn = await page.request.post(`${base}/sign-in`, { headers: { origin: base }, maxRedirects: 0 });
    const token = /^session=([0-9a-f]{32});/.exec(signedIn.headers()["set-cookie"] ?? "")?.[1] ?? "";
    check("WebKit signs in through the route", token.length === 32, String(signedIn.status()));
    await page.context().addCookies([{ name: "session", value: token, url: base }]);
  }
  await page.goto(`${base}/account`);
  /** Uploads one file with the account page's form and gives the status line's text. @param {{ name: string, mimeType: string, buffer: Buffer }} file */
  const upload = async (file) => {
    await page.evaluate(() => {
      const result = document.querySelector("#avatar-result");
      if (result) result.textContent = "";
    });
    await page.setInputFiles("main input[type=file]", [file]);
    await page.click("main form[enctype] button");
    await page.waitForFunction(() => document.querySelector("#avatar-result")?.textContent, null, { timeout: 8000 }).catch(() => {});
    return (await page.textContent("#avatar-result")) ?? "";
  };
  // A 1x1 PNG, then a line that looks like a multipart boundary, which a picture may hold.
  const png = Buffer.concat([
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
    Buffer.from("\r\n--png\r\n"),
  ]);
  const uploaded = await upload({ name: "card.png", mimeType: "image/png", buffer: png });
  const pictureUrl = await page
    .waitForFunction(
      () => {
        const img = document.querySelector("#viewer-badge img");
        const big = document.querySelector("#account-picture img");
        return img instanceof HTMLImageElement && img.complete && img.naturalWidth === 1 && big?.getAttribute("src") === img.getAttribute("src") ? img.getAttribute("src") : null;
      },
      null,
      { timeout: 5000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  check("an uploaded picture is read as it arrives and shown in the header and on the page", uploaded === "Saved card.png as your picture." && /^\/pictures\/[0-9a-f]{32}$/.test(pictureUrl ?? ""), `${uploaded}, ${pictureUrl}`);
  const served = await fetch(new URL(pictureUrl ?? "/pictures/none", base));
  check(
    "a picture is served as its type, at a URL every cache keeps",
    served.headers.get("content-type") === "image/png" && served.headers.get("cache-control") === "public, max-age=31536000, immutable",
    `${served.status} ${served.headers.get("content-type")} ${served.headers.get("cache-control")}`,
  );
  const page_ = await upload({ name: "page.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script>") });
  check("a file that is not a picture is refused, whatever type it says", page_.startsWith("That file is not a picture"), page_);
  const big = await upload({ name: "big.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(70 << 10, 0xff) });
  check("a picture over its limit is refused", big === "The picture is over 64 KB. Choose a smaller one.", big);
  // A picture far over its own limit, and three times the form's (1 MiB): the rest is read past and
  // not kept, so it is the picture's message, not the body's, and the browser, which sends the
  // whole picture, shows it instead of a network error.
  const over = await upload({ name: "huge.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(3 << 20, 7) });
  check("a picture far over its limit and the form's is answered with the picture's message", over === "The picture is over 64 KB. Choose a smaller one.", over);
  // A field that keeps the form over its 1 MiB, with 3 MiB more after the limit, more than a
  // socket buffers: read past, answered 413 in the form, not as a network error.
  await page.evaluate(() => {
    const note = document.createElement("input");
    note.type = "hidden";
    note.name = "note";
    note.id = "smoke-note";
    note.value = "a".repeat(4 << 20);
    document.querySelector("main form[enctype]")?.prepend(note);
  });
  const overForm = await upload({ name: "card.png", mimeType: "image/png", buffer: png });
  await page.evaluate(() => document.getElementById("smoke-note")?.remove());
  check("a form that keeps more than its limit is answered in the form", overForm === "The form is over 1 MB.", overForm);

  // The picture's form hears its upload's progress (`on:corten:progress`), so its multipart
  // writes go by XMLHttpRequest: the uploads above were answered through it. Each event is the
  // browser's ProgressEvent for the whole body, while the form is busy; the bar shows only then,
  // and the component's handler (this listener runs after it) has set its value to the share sent,
  // with none once all of it is.
  await page.evaluate(() => {
    const form = document.querySelector("main form[enctype]");
    /** @type {any} */ (window).__progress = [];
    form?.addEventListener("corten:progress", (e) => {
      const p = /** @type {ProgressEvent} */ (e);
      const bar = /** @type {HTMLProgressElement | null} */ (form.querySelector("progress"));
      const seen = {
        loaded: p.loaded,
        total: p.total,
        computable: p.lengthComputable,
        busy: form.getAttribute("aria-busy"),
        shown: bar ? getComputedStyle(bar).display !== "none" : false,
      };
      /** @type {any} */ (window).__progress.push(seen);
    });
    // What the component's handler, which runs once its module's import resolves, sets the bar to.
    /** @type {any} */ (window).__barValues = [];
    const bar = form?.querySelector("progress");
    if (bar) {
      // A batch of changes gives each value set by the change after it (its old value), then the bar's.
      new MutationObserver((records) => {
        for (const record of records.slice(1)) /** @type {any} */ (window).__barValues.push(record.oldValue);
        /** @type {any} */ (window).__barValues.push(bar.getAttribute("value"));
      }).observe(bar, { attributes: true, attributeFilter: ["value"], attributeOldValue: true });
    }
  });
  // Chromium sends it slowly (2 MB/s up), so the bar is seen part way; the other engines have no
  // throttle a script can set, and send it at localhost's speed.
  const throttle = engine === "chromium" ? await page.context().newCDPSession(page) : null;
  await throttle?.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 2 << 20 });
  const progressed = await upload({ name: "slow.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(600 << 10, 7) });
  await throttle?.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await throttle?.detach();
  /** @type {{ loaded: number, total: number, computable: boolean, busy: string | null, shown: boolean }[]} */
  const events = await page.evaluate(() => /** @type {any} */ (window).__progress);
  /** @type {(string | null)[]} */
  const barValues = await page.evaluate(() => /** @type {any} */ (window).__barValues);
  const last = events.at(-1);
  check(
    "a form's on:corten:progress hears its whole body sent, while it is busy and its bar shows",
    !!last && last.computable && last.loaded === last.total && last.total > 600 << 10 && events.every((e) => e.busy === "true" && e.shown) && progressed.startsWith("The picture is over 64 KB"),
    `${events.length} events, last ${JSON.stringify(last)}, ${progressed}`,
  );
  check(
    "the handler the form names fills the bar with the share sent, and leaves it indeterminate once all is",
    // Firefox reports only the last step of a body sent at localhost's speed: the bar is never
    // given a value then.
    (barValues.length === 0 || barValues.at(-1) === null) &&
      events.some((e) => e.computable && e.loaded === e.total) &&
      events
        .filter((e) => e.computable && e.loaded < e.total)
        .every((e) => barValues.some((v) => v !== null && Math.abs(Number(v) - e.loaded / e.total) < 0.001)) &&
      (engine !== "chromium" || events.some((e) => e.computable && e.loaded > 0 && e.loaded < e.total)),
    JSON.stringify({ events: events.map((e) => [e.loaded, e.total]), bar: barValues }),
  );
  const barAfter = await page.evaluate(() => {
    const form = document.querySelector("main form[enctype]");
    const bar = form?.querySelector("progress");
    return [form?.getAttribute("aria-busy") ?? null, bar ? getComputedStyle(bar).display : "none"];
  });
  check("once the answer is drawn the form is not busy and the bar is hidden", barAfter[0] === null && barAfter[1] === "none", JSON.stringify(barAfter));
  // A network failure reaches the form as corten:error, as a fetch's does. The browser logs the
  // request it fails on purpose (Chromium's net::ERR_FAILED), and the one a navigation abandons.
  const failedOnPurpose = errors.length;
  await page.route("**/avatar", (route) => route.abort());
  const uploadFailed = page.evaluate(
    () =>
      new Promise((resolve) => {
        document.querySelector("main form[enctype]")?.addEventListener("corten:error", (e) => resolve(/** @type {CustomEvent} */ (e).detail.status), { once: true });
        setTimeout(() => resolve("none"), 8000);
      }),
  );
  await page.setInputFiles("main input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
  await page.click("main form[enctype] button");
  check("an upload the network fails dispatches corten:error with status 0", (await uploadFailed) === 0, String(await uploadFailed));
  await page.unroute("**/avatar");
  // A followed redirect on the progress path: the answer the upload module hands the runtime has
  // the redirect's URL (`responseURL`), as fetch's has, which the runtime reads to know the answer
  // is this origin's before it draws it. The module is called as the runtime calls it, and its
  // POST answered with a 303 to the news page. Playwright's WebKit cannot answer a request with a
  // redirect.
  if (engine === "webkit") skip("an upload's answer after a followed redirect has the redirect's URL, as fetch's does", "Playwright cannot fulfill a redirect in WebKit");
  else {
    const redirectContext = await /** @type {import("playwright").Browser} */ (page.context().browser()).newContext();
    await redirectContext.addCookies(await page.context().cookies());
    const redirected = await redirectContext.newPage();
    await redirected.route("**/avatar", (route) => route.fulfill({ status: 303, headers: { location: "/news" } }));
    await redirected.goto(`${base}/account`);
    const answered = await redirected.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .find((name) => /\/corten-upload\.js(\?|$)/.test(name));
      if (!url) return { url: "", status: 0, path: "no module loaded" };
      /** @type {typeof import("../crates/corten/js/upload.js")} */
      const module = await import(url);
      const body = new FormData(/** @type {HTMLFormElement} */ (document.querySelector("main form[enctype]")));
      const res = await module.upload(new URL("/avatar", location.href), "POST", body, new AbortController().signal, () => {});
      return { url: res.url, status: res.status, path: new URL(res.url, location.href).pathname };
    });
    await redirectContext.close();
    check(
      "an upload's answer after a followed redirect has the redirect's URL, as fetch's does",
      answered.status === 200 && answered.path === "/news" && answered.url.startsWith(base),
      JSON.stringify(answered),
    );
  }
  // A navigation abandons an upload still waiting for its answer: no progress reaches the form after
  // it, nor its answer the page. In a context of its own (with the session's cookie), closed after,
  // since a request Playwright held and answered after the page let it go leaves the context's
  // next request to the same path unanswered.
  const leaveContext = await /** @type {import("playwright").Browser} */ (page.context().browser()).newContext();
  await leaveContext.addCookies(await page.context().cookies());
  const leave = await leaveContext.newPage();
  await leave.goto(`${base}/account`);
  await leave.evaluate(() => {
    /** @type {any} */ (window).__progress = 0;
    document.querySelector("main form[enctype]")?.addEventListener("corten:progress", () => (/** @type {any} */ (window).__progress += 1));
  });
  /** @type {import("playwright").Route[]} */
  const heldUploads = [];
  await leave.route("**/avatar", (route) => {
    heldUploads.push(route);
  });
  await leave.setInputFiles("main input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
  await leave.click("main form[enctype] button");
  const wasBusy = await leave
    .waitForFunction(() => document.querySelector("main form[enctype]")?.getAttribute("aria-busy") === "true", null, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  const beforeLeaving = await leave.evaluate(() => /** @type {any} */ (window).__progress);
  await leave.click('header a[href="/"]');
  await leave.waitForFunction(() => !document.querySelector("main form[enctype]"), null, { timeout: 5000 }).catch(() => {});
  // The held upload then answers, sending the page elsewhere: an upload still listened to would
  // take the page there.
  for (const route of heldUploads) await route.fulfill({ status: 204, headers: { "corten-location": "/news" } }).catch(() => {});
  await leave.waitForTimeout(500);
  const afterLeaving = await leave.evaluate(() => /** @type {any} */ (window).__progress);
  const leftFor = await leave.evaluate(() => location.pathname);
  const formLeft = !!(await leave.$("main form[enctype]"));
  await leaveContext.close();
  check(
    "a navigation abandons a waiting upload, its progress and its answer",
    wasBusy && heldUploads.length === 1 && afterLeaving === beforeLeaving && leftFor === "/" && !formLeft,
    `busy ${wasBusy}, ${heldUploads.length} held, ${beforeLeaving} then ${afterLeaving} events, at ${leftFor}`,
  );
  // A navigation while the upload module is still loading: the upload is never sent, as a fetch
  // is never sent with an aborted signal, and its answer cannot take the page.
  // In a context of its own (with the session's cookie), closed after, so nothing it holds reaches
  // the pages after it.
  const raceContext = await /** @type {import("playwright").Browser} */ (page.context().browser()).newContext();
  await raceContext.addCookies(await page.context().cookies());
  const race = await raceContext.newPage();
  /** @type {import("playwright").Route[]} */
  const heldModules = [];
  await race.route("**/corten-upload*", (route) => {
    heldModules.push(route);
  });
  let sentUploads = 0;
  /** @param {import("playwright").Request} request */
  const countUpload = (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/avatar") sentUploads += 1;
  };
  race.on("request", countUpload);
  // The form is put on a page that did not load the module (as a script or a patch may add one),
  // so its first submit waits for the module to load.
  const accountPage = await (await race.request.get(`${base}/account`)).text();
  const pictureForm = /<form[^>]*enctype="multipart\/form-data"[\s\S]*?<\/form>/.exec(accountPage)?.[0] ?? "";
  await race.goto(`${base}/`);
  await race.evaluate((html) => {
    const holder = document.createElement("div");
    holder.id = "smoke-upload-race";
    holder.innerHTML = /** @type {any} */ (/** @type {any} */ (window).__html(html));
    document.querySelector("main")?.append(holder);
  }, pictureForm);
  await race.waitForTimeout(100);
  await race.setInputFiles("#smoke-upload-race input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
  await race.click("#smoke-upload-race button");
  await race.waitForTimeout(200);
  await race.click('header a[href="/news"]');
  await race.waitForFunction(() => location.pathname === "/news" && !document.querySelector("#smoke-upload-race"), null, { timeout: 5000 }).catch(() => {});
  const moduleHeld = heldModules.length;
  // Answered from a request of the test's own, so the held request ends here whatever the page did.
  for (const route of heldModules) {
    const module = await race.request.get(route.request().url());
    await route.fulfill({ response: module }).catch(() => {});
  }
  await race.unroute("**/corten-upload*", { behavior: "ignoreErrors" });
  await race.waitForTimeout(500);
  race.off("request", countUpload);
  const landed = await race.evaluate(() => location.pathname);
  await raceContext.close();
  check("an upload left while its module loads is never sent", moduleHeld > 0 && sentUploads === 0 && landed === "/news", `${moduleHeld} module requests held, ${sentUploads} uploads sent, at ${landed}`);
  await page.goto(`${base}/account`);
  // A multipart form with no progress handler and a control named getAttribute is still sent (by
  // fetch): the submit's check for a progress handler reads the form through Element's methods.
  await page.setInputFiles("main input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
  const ordinary = await page.evaluate(async () => {
    const form = /** @type {HTMLFormElement} */ (document.querySelector("main form[enctype]"));
    form.removeAttribute("data-on");
    const shadow = document.createElement("input");
    shadow.type = "hidden";
    shadow.name = "getAttribute";
    form.prepend(shadow);
    const result = document.querySelector("#avatar-result");
    if (result) result.textContent = "";
    /** @type {string[]} */
    const failed = [];
    form.addEventListener("corten:error", (e) => failed.push(String(/** @type {CustomEvent} */ (e).detail?.status)), { once: true });
    HTMLFormElement.prototype.requestSubmit.call(form);
    for (let i = 0; i < 80 && !document.querySelector("#avatar-result")?.textContent && !failed.length; i++) await new Promise((r) => setTimeout(r, 100));
    return { answer: document.querySelector("#avatar-result")?.textContent ?? "", failed, busy: Element.prototype.getAttribute.call(form, "aria-busy"), files: /** @type {HTMLInputElement | null} */ (form.querySelector("input[type=file]"))?.files?.length ?? -1 };
  });
  check("a multipart form without a progress handler, with a control named getAttribute, is still sent", ordinary.answer !== "" && !ordinary.failed.length, JSON.stringify(ordinary));
  errors.splice(failedOnPurpose, errors.length, ...errors.slice(failedOnPurpose).filter((e) => !/ERR_FAILED|ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(e)));
  if (!signsIn) await page.context().clearCookies({ name: "session" });

  // The posts answered 415, and the uploads 422 and 413 (the form over its limit), on purpose; the
  // browser logs those as failed resources.
  const unplanned = errors.filter((e, i) => !(e.includes("415") || (i >= errorsBefore && (e.includes("422") || e.includes("413")))));
  check("no console errors after the injected forms", unplanned.length === 0, unplanned.join(" | "));

  // Without the page's cookie: the three stocks a first visit watches.
  const json = await (await fetch(base, { headers: { accept: "application/json" } })).json();
  check("same URL as JSON for data clients", json.title === "Stocks | Watchlist" && json.data.stocks.length === 3, JSON.stringify(json.data.stocks.map((/** @type {{ id: string }} */ s) => s.id)));

  // A WebSocket (GET /quotes): the page's own origin opens it, names a stock and is sent its row.
  // Another site's page cannot, though the browser would send the user's cookies with its handshake.
  const talk = (/** @type {string} */ url) =>
    new Promise((resolve) => {
      const socket = new WebSocket(url);
      socket.onopen = () => socket.send("ACME");
      socket.onmessage = (e) => {
        resolve(e.data);
        socket.close();
      };
      socket.onerror = () => resolve("refused");
      setTimeout(() => resolve("no answer"), 4000);
    });
  const quotesUrl = `${base.replace(/^http/, "ws")}/quotes`;
  const quoted = String(await page.evaluate(talk, quotesUrl));
  check("a WebSocket from the page's own origin is sent the stock it names", quoted.startsWith("{") && JSON.parse(quoted).id === "ACME", quoted);
  const elsewhere = await browser.newPage();
  await elsewhere.route("http://other.test/", (route) => route.fulfill({ contentType: "text/html", body: "<title>Other</title>" }));
  await elsewhere.goto("http://other.test/");
  const crossed = await elsewhere.evaluate(talk, quotesUrl);
  check("another site's page cannot open it", crossed === "refused", String(crossed));
  // CI's Firefox once stopped between that check and the next for an hour (#317), not seen
  // locally: its route is let go before its context closes, and each step is named to the
  // watchdog, so a stall says which one.
  seen(`[${engine}] (step) closing the other site's page`);
  await elsewhere.unrouteAll({ behavior: "ignoreErrors" });
  await elsewhere.context().close();

  seen(`[${engine}] (step) opening a context without JavaScript`);
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const plain = await noJs.newPage();
  seen(`[${engine}] (step) loading the page without JavaScript`);
  await plain.goto(base);
  check("without JavaScript prices are server-rendered", (await plain.$$('[data-ref="price"]')).length === 3);
  await plain.selectOption("select[name=id]", "SOLR");
  await Promise.all([plain.waitForNavigation(), plain.click("#watch-form button")]);
  check("without JavaScript the form posts and renders the page", ((await plain.textContent("#watch-message")) ?? "").startsWith("Watching Sunreach Solar"));
  check("without JavaScript the visitor's time zone is not known", !((await plain.textContent("#watch-message")) ?? "").includes("Alerts follow"));
  check("the page it renders has the stock on the list", (await plain.$('[data-ref="price"][data-key="SOLR"]')) !== null);
  await noJs.close();

  // Req::resend_to: a browser's first alert names it (a 307 that sets its cookie) and the same
  // form goes on to /alerts/first, sent again by the runtime's fetch for a data-patch form and by
  // the browser without JavaScript, so the alert is written under the id the browser presents.
  for (const js of [true, false]) {
    const name = js ? "a data-patch form" : "without JavaScript, a form";
    seen(`[${engine}] (step) ${name} sent on`);
    const fresh = await browser.newContext({ javaScriptEnabled: js });
    const first = await fresh.newPage();
    /** @type {import("@playwright/test").Request[]} */
    const sentOn = [];
    first.on("request", (r) => r.method() === "POST" && new URL(r.url()).pathname === "/alerts/first" && sentOn.push(r));
    await first.goto(`${base}/alerts`);
    await first.selectOption("#alert-form select", "SOLR");
    await first.fill("#alert-form input[name=above]", "42");
    if (js) {
      await first.click("#alert-form button");
      await first.waitForFunction(() => document.getElementById("alert-status")?.textContent === "Saving...", null, { timeout: 5000 }).catch(() => {});
    } else {
      await Promise.all([first.waitForURL(/\/alerts\?saved=\d+$/, { timeout: 5000 }).catch(() => {}), first.click("#alert-form button")]);
    }
    const body = new URLSearchParams(sentOn[0]?.postData() ?? "");
    check(`${name} sent on by resend_to goes with the same fields`, sentOn.length === 1 && body.get("id") === "SOLR" && body.get("above") === "42", `${sentOn.length} sent: ${body}`);
    const cookie = (await sentOn[0]?.allHeaders())?.cookie ?? "";
    if (signsIn) check(`${name} sent on presents the cookie its 307 set`, /(^|; )visitor=[0-9a-f]{32}($|;)/.test(cookie), cookie);
    else skip(`${name} sent on presents the cookie its 307 set`, "the browser does not send Secure cookies over http");
    const answered = js ? (await first.textContent("#alert-status")) === "Saving..." && first.url() === `${base}/alerts` : /\/alerts\?saved=\d+$/.test(first.url());
    check(`${name} sent on is answered as the write's own`, answered, first.url());
    await fresh.close();
  }

  // App::client_zone: the runtime keeps the browser's time zone in a cookie once a page has
  // loaded, so the next request (a form's post) tells the server where the visitor is.
  const abroad = await browser.newContext({ timezoneId: "Pacific/Auckland" });
  const kiwi = await abroad.newPage();
  await kiwi.goto(base);
  await kiwi.waitForFunction(() => document.cookie.includes("corten-zone="), null, { timeout: 4000 }).catch(() => {});
  await kiwi.selectOption("select[name=id]", "SOLR");
  await kiwi.click("#watch-form button");
  await kiwi.waitForFunction(() => document.getElementById("watch-message")?.textContent?.startsWith("Watching Sunreach Solar"), null, { timeout: 4000 }).catch(() => {});
  const zoned = (await kiwi.textContent("#watch-message")) ?? "";
  check("a post after the first page knows the visitor's time zone", zoned.includes("Alerts follow Pacific/Auckland time."), zoned);
  await abroad.close();

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
