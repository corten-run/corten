import { base, skip, check } from "./helpers.mjs";

/**
 * Settles as `work` does, or rejects with `what` once `ms` have passed. `work` is left to end on
 * its own (closing its page ends it); a rejection it brings later is already handled here.
 * @template T @param {number} ms @param {string} what @param {Promise<T>} work @returns {Promise<T>}
 */
const within = (ms, what, work) => {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(what)), ms)));
  return /** @type {Promise<T>} */ (Promise.race([work, late])).finally(() => clearTimeout(timer));
};

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
  // A navigation into an area while a patch's load of the area's stylesheet is in flight waits for
  // that load too, rather than take the link the patch put in the head for a loaded stylesheet:
  // the news area's Load more patch, sent on the home page, then a link to the news. A probe with
  // the news area's class, outside <main>, shows whether its rules applied when the page swapped.
  // The patch's request for the stylesheet is held until the runtime has read the navigation's
  // answer, so the navigation meets that load still out however slowly each step comes (#2014).
  // The runtime reads the answer with `text()` and looks up its stylesheets in the same task, and
  // the page notes the read a task later, so the lookup has been made once the note is there. The
  // page must not swap while the stylesheet is held, and the browser must request it only once:
  // the navigation shares the patch's load. Every step before the release is bounded, and the
  // stylesheet is released however they end.
  if (swaps) {
    const entered = await browser.newPage();
    entered.on("pageerror", (e) => errors.push(`navigation during a patch's load: ${e.message}`));
    await entered.goto(base);
    /** The section stylesheets the page requested. @type {string[]} */
    const sheets = [];
    let asked = () => {};
    const patchAsked = new Promise((resolve) => (asked = () => resolve(undefined)));
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    await entered.route("**/sections/**", async (route) => {
      sheets.push(new URL(route.request().url()).pathname);
      asked();
      await held;
      // The page may have closed by the time a failed case releases it.
      await route.continue().catch(() => {});
    });
    /** What kept the case from holding the stylesheet until the navigation's answer was read. */
    let stuck = "";
    /** The probe's border if the page swapped while the stylesheet was held. @type {string | null} */
    let early = null;
    try {
      await within(
        15_000,
        "the patch's load or the navigation's read took over 15 s",
        (async () => {
          await entered.evaluate(async () => {
          const { patch } = await import("corten");
          const answer = await fetch("/news?shown=3", { headers: { corten: "action" } }).then((r) => r.text());
          // The elements the patch replaces, outside <main> so the swap leaves them.
          const stories = document.createElement("ul");
          stories.id = "stories";
          const more = document.createElement("form");
          more.id = "load-more";
          const probe = document.createElement("p");
          probe.className = "disclaimer__note";
          document.body.append(stories, more, probe);
          const at = /** @type {any} */ (window);
          at.__entered = null;
          new MutationObserver((_, observer) => {
            if (document.querySelector("main h1")?.textContent !== "Market news") return;
            at.__entered = getComputedStyle(probe).borderInlineStartWidth;
            observer.disconnect();
          }).observe(document.body, { childList: true, subtree: true });
          // Not awaited: the navigation starts while this patch's stylesheet is still loading.
          patch(__html(answer)).catch(() => {});
          });
          await patchAsked;
          await entered.evaluate(() => {
            const at = /** @type {any} */ (window);
            at.__read = false;
            const text = Response.prototype.text;
            Response.prototype.text = function () {
              const read = text.call(this);
              if (new URL(this.url).pathname === "/news") {
                Response.prototype.text = text;
                read.then(() => setTimeout(() => (at.__read = true)), () => {});
              }
              return read;
            };
            /** @type {HTMLAnchorElement} */ (document.querySelector('header a[href="/news"]')).click();
          });
          // Polled on a timer: a loaded browser may not be delivering animation frames.
          await entered.waitForFunction(() => (/** @type {any} */ (window)).__read, undefined, { timeout: 10_000, polling: 50 });
          early = await entered.evaluate(() => (/** @type {any} */ (window)).__entered);
        })(),
      );
    } catch (error) {
      stuck = error instanceof Error ? error.message.split("\n")[0] : String(error);
    } finally {
      release();
    }
    const border = await entered
      .waitForFunction(() => (/** @type {any} */ (window)).__entered, undefined, { timeout: 5000, polling: 50 })
      .then((got) => got.jsonValue(), () => "not swapped");
    const marked = await entered.evaluate(() => document.head.querySelectorAll('link[data-corten-style][href*="/sections/news"]').length);
    check(
      "a navigation into an area while a patch is loading its stylesheet waits for that load",
      !stuck && early === null && border === "4px" && marked === 1 && sheets.length === 1,
      `${stuck ? `${stuck}; ` : ""}${early === null ? "" : `swapped while held: ${early}; `}${border}, ${marked} link; requested: ${sheets.join(" ") || "none"}`,
    );
    await entered.close();
  } else skip("a navigation into an area while a patch is loading its stylesheet waits for that load", noSwaps);
}
