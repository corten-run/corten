import { retrying } from "../steady.mjs";
import { browserBug } from "../browser-bugs.mjs";
import { base, engine, check } from "./helpers.mjs";

export async function openWatchlist(browser) {
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
  const located = { value: false };
  page.on("console", (m) => {
    const text = m.type() === "error" ? m.text() : "";
    if (!text || bug(text) || cut.test(text)) return;
    const at = located.value ? m.location()?.url : "";
    errors.push(at ? `${text} at ${at}` : text);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  // Every EventSource the page opens, to see which are still open, with when it opened and when
  // an error closed it for good, on the page's own clock (`openedAt`, `closedAt`), and each timer
  // of half a second or more the page sets, so a wait the runtime asks for is read as asked, not
  // only as a loaded browser ran it: `nextTimer` is the index of the first one set after the close.
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    const timers = (w.__timers = /** @type {number[]} */ ([]));
    // The index of the recorded timer whose callback is running, so a source knows which opened it.
    let running = -1;
    // The same, for a request a check records itself (a feed's snapshot, say).
    w.__timerRunning = () => running;
    const setTimer = window.setTimeout;
    window.setTimeout = /** @type {typeof setTimeout} */ (
      (/** @type {TimerHandler} */ handler, /** @type {number | undefined} */ delay, /** @type {unknown[]} */ ...rest) => {
        if ((delay ?? 0) < 500 || typeof handler !== "function") return setTimer.call(window, handler, delay, ...rest);
        const index = timers.push(delay ?? 0) - 1;
        const fire = (/** @type {unknown[]} */ ...args) => {
          const outer = running;
          running = index;
          try {
            handler(...args);
          } finally {
            running = outer;
          }
        };
        return setTimer.call(window, fire, delay, ...rest);
      }
    );
    const sources = (w.__sources = /** @type {EventSource[]} */ ([]));
    window.EventSource = class extends EventSource {
      /** @param {ConstructorParameters<typeof EventSource>} args */
      constructor(...args) {
        super(...args);
        sources.push(this);
        const self = /** @type {any} */ (this);
        self.openedAt = performance.now();
        self.openedBy = running;
        this.addEventListener("error", () => {
          if (this.readyState !== EventSource.CLOSED || self.closedAt !== undefined) return;
          self.closedAt = performance.now();
          self.nextTimer = timers.length;
        });
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
  // The next /watch post waits for `holdWatch` to settle before reaching the server, or fails as
  // if offline.
  /** @type {{ value: Promise<unknown> | null }} */
  const holdWatch = { value: null };
  const failWatch = { value: false };
  /** @type {string[]} */
  const abandoned = [];
  /** The requests failed on purpose, which are not abandoned. */
  const offline = new Set();
  await page.route("**/watch", async (route) => {
    const hold = holdWatch.value;
    holdWatch.value = null;
    if (failWatch.value) {
      failWatch.value = false;
      await hold;
      offline.add(route.request());
      return route.abort("internetdisconnected");
    }
    await hold;
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
  {
    const scoped = await browser.newPage();
    await scoped.goto(`${base}/smoke/scoped`);
    await scoped.waitForFunction(() => document.querySelector("output")?.value === "CSS1Compat");
    check(
      "a scoped document keeps its doctype, standards mode and working refs under html",
      await scoped.evaluate(() => document.doctype?.name === "html" && document.documentElement.getAttribute("data-scope") === "scoped-page" && document.querySelector("output")?.closest("[data-scope]") === document.documentElement),
    );
    const roots = await scoped.evaluate(async () => {
      const { patch, patchRoots } = await import("corten");
      const [patchRoot, drawnOpen] = patchRoots();
      const __html = /** @type {any} */ (window).__html;
      const out = /** @type {HTMLOutputElement} */ (document.querySelector("output"));
      const wrapper = document.createElement("section");
      wrapper.id = "smoke-patch-root";
      out.before(wrapper);
      wrapper.append(out);
      await patch(__html('<section id="smoke-patch-root"><dialog id="smoke-patch-dialog" open></dialog></section>'));
      const replaced = out.dataset.patchRoot;
      const expired = patchRoot(out) === undefined;
      const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("smoke-patch-dialog"));
      dialog.removeAttribute("open");
      const drawn = drawnOpen(dialog);
      document.getElementById("smoke-patch-root")?.remove();
      delete out.dataset.patchRoot;
      document.querySelector("main")?.append(wrapper);
      await Promise.resolve();
      await patch(__html('<template id="smoke-patch-root" data-remove></template>'));
      const removed = out.dataset.patchRoot;
      delete out.dataset.patchRoot;
      document.querySelector("main")?.append(wrapper);
      await Promise.resolve();
      wrapper.remove();
      await Promise.resolve();
      return { replaced, expired, drawn, removed, script: out.dataset.patchRoot };
    });
    check("abort sees the patch's replacement or removal, not a script's removal, and drawn open survives script edits",
      roots.replaced === "smoke-patch-root" && roots.expired && roots.drawn && roots.removed === "removed" && roots.script === "none",
      JSON.stringify(roots));
    await scoped.route("**/patch-order.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
      export const seen = { heard: 0 };
      let old;
      export function watch(signal) {
        old = signal;
        document.addEventListener("smoke-patch-connect", () => { seen.heard += 1; }, { signal });
      }
      export function focus(refs) { seen.ref = refs.map((ref) => ref.textContent); }
      export function connect(el, refs) {
        seen.connectRefs = refs.map((ref) => ref.textContent);
        seen.aborted = old.aborted;
        seen.vars = getComputedStyle(el).getPropertyValue("--smoke-state").trim();
        seen.current = el.querySelector("a").getAttribute("aria-current");
        document.dispatchEvent(new Event("smoke-patch-connect"));
      }
    ` }));
    const order = await scoped.evaluate(async () => {
      const { patch } = await import("corten");
      const __html = /** @type {any} */ (window).__html;
      const main = document.querySelector("main");
      main?.insertAdjacentHTML("beforeend", __html('<section id="smoke-order"></section>'));
      const first = '<div id="smoke-first" tabindex="0" data-on="focus:patch-order.focus(*part)';
      await patch(__html(`<section id="smoke-order" data-scope="smoke-order"><span data-ref="part">kept</span>${first} connect:patch-order.watch($s)"></div><div id="smoke-later"></div></section>`));
      // Warm the cache with a ref that stays attached, then add a ref in the replacement.
      document.getElementById("smoke-first")?.focus();
      await patch(__html(`${first}"><span data-ref="part">new</span></div><nav id="smoke-later" data-vars="--smoke-state:ready" data-on="connect:patch-order.connect($t,*part)"><a data-nav href="/smoke/scoped">Here</a></nav>`));
      const scripts = document.querySelector('meta[name="corten-scripts"]')?.getAttribute("content");
      const { seen } = await import(new URL(`${scripts}patch-order.js`, location.href).href);
      return seen;
    });
    check("a ref-taking focus handler sees the first replacement before the patch ends", order.ref?.join() === "kept,new", JSON.stringify(order));
    check("a later patch connect sees the surviving and added refs", order.connectRefs?.join() === "kept,new", JSON.stringify(order));
    check("a removed component is aborted before a later patch connect dispatches an event",
      order.aborted && order.heard === 0, JSON.stringify(order));
    check("a later patch connect sees the applied CSS variables and current nav link",
      order.vars === "ready" && order.current === "page", JSON.stringify(order));
    await scoped.close();
  }
  // Without the Navigation API every navigation is a full page load, the documented fallback: the
  // checks of what a swap keeps check that instead, or are skipped.
  const swaps = await page.evaluate(() => "navigation" in window);
  const noSwaps = "no Navigation API: navigations are full page loads";
  // Playwright's WebKit stores a Secure cookie from http://localhost but never sends it back.
  const signsIn = engine !== "webkit";
  const live = "[data-scope=live-prices]";
  await page.waitForSelector(`${live}[data-status="live"]`, { timeout: 5000 }).catch(() => {});
  check("on:connect runs the script's watch(), which subscribes to the feed", (await page.getAttribute(live, "data-status")) === "live");
  {
    const shared = await browser.newPage();
    await shared.goto(`${base}/smoke/shared-refs`);
    const owners = shared.locator('section[data-scope="shared-refs-page"]');
    const first = owners.nth(0);
    const second = owners.nth(1);
    const firstPart = first.locator("#shared-ref-part-1");
    const secondPart = second.locator('[data-scope="part-boundary"] #shared-ref-part-2');
    const untouched = await firstPart.elementHandle();
    const directRef = await firstPart.getAttribute("data-ref");
    const ref = await secondPart.getAttribute("data-ref");
    const readPart = async (/** @type {import('@playwright/test').Locator} */ owner, /** @type {string} */ expected) => {
      const out = owner.locator("output");
      await out.evaluate((node) => { /** @type {HTMLOutputElement} */ (node).value = ""; });
      await owner.getByRole("button", { name: "Read part" }).click();
      await owner.getByText(expected, { exact: true }).and(out).waitFor();
    };
    await readPart(first, "Original 1");
    await readPart(second, "Original 2");
    await second.getByRole("textbox", { name: "Check shared handler scope" }).dispatchEvent("change");
    await second.and(shared.locator('[title="Shared handler ran"]')).waitFor();
    check("a shared handler passed through a scoped child receives the exporting parent's root",
      (await first.getAttribute("title")) === null && (await second.locator('[data-scope="part-boundary"]').getAttribute("title")) === null);
    const replace = () => Promise.all([
      shared.waitForResponse((r) => new URL(r.url()).pathname === "/smoke/shared-refs/2/replace"),
      second.getByRole("button", { name: "Replace part" }).click(),
    ]);
    const [patch] = await replace();
    const body = await patch.text();
    await secondPart.and(second.getByText("Replacement 2", { exact: true })).waitFor();
    await readPart(second, "Replacement 2");
    await readPart(first, "Original 1");
    check(
      "a standalone patch keeps its ref across a nested scope and only replaces the targeted owner instance",
      ref === "shared-refs-page/part" && directRef === ref && patch.headers()["corten-patch"] === "1" && body.includes(`data-ref="${ref}"`) &&
        !body.includes("data-scope=") && (await secondPart.getAttribute("data-ref")) === ref &&
        (await untouched.evaluate((node) => node.isConnected && node.textContent === "Original 1")),
      body,
    );
    await secondPart.evaluate((node) => node.remove());
    const diagnostic = shared.waitForEvent("console", (m) =>
      m.type() === "error" && m.text().includes("corten: patch element <p> needs an id that exists on the page"),
    );
    await replace();
    await diagnostic;
    await readPart(first, "Original 1");
    check("a standalone patch with a missing target reports it without inserting the part", (await shared.locator("#shared-ref-part-2").count()) === 0);
    await shared.close();
  }
  return { page, errors, swaps, noSwaps, live, feedSources, signsIn, failWatch, openFeeds, holdWatch, bug, cut, abandoned, openStreams, located, navRequests };
}
