import { base, shadowing, skip, check, within, readWithin, steps, pollFor, cleanUp } from "./helpers.mjs";

/**
 * The seconds the watchlist's alerts part waits before it reads itself again while a write lands
 * (`ReadAgain { after: Duration::from_secs(1) }.from` in examples/watchlist/src/alerts.rs), which
 * the leaving case's stand-in writes too. That case's check that no part read comes after its
 * release watches for longer than this (`quietFor`).
 */
const AGAIN_SECONDS = 1;

/**
 * The seconds the leave-before-read case's page waits before its part's first read: the wait its
 * navigation's stand-in answer asks for (`seeds` in `pageRefresh`), longer than the part's own so
 * that a loaded browser still leaves before the read is due, which the case confirms by the page's
 * own clock.
 */
const LEAVE_SECONDS = 4;

/**
 * How long before the read is due the page must have left for an attempt of that case to count.
 * The runtime starts the read's timer as it draws the part's tag, in the same task, and the case
 * notes the draw in a mutation callback just after that task: this covers the rest of the task.
 */
const LEAVE_MARGIN_MS = 500;

/**
 * Why `answer`, the answer to a part read of `address` (its URL), is not a patch that asks to be
 * read again from that same address after `AGAIN_SECONDS` with `status` drawn, or null when it is.
 * `page` parses it as the runtime parses a patch (`parse` in corten.js: a template's `innerHTML`)
 * and reads its top-level elements as `apply` does: `status` is one of them, and the last with
 * `data-corten-read-again` (the one the runtime keeps) is `ReadAgain::from`'s `<template>`, asking
 * again after `AGAIN_SECONDS` from `data-from` resolved against the document's base URL as the
 * page has it now, which is what the runtime's `fetch(from)` resolves it against.
 * @param {import("@playwright/test").Page} page @param {string} answer @param {string} address @param {string} status
 */
function readAgainFault(page, answer, address, status) {
  return page.evaluate(
    ({ answer, address, status, seconds }) => {
      const template = document.createElement("template");
      template.innerHTML = /** @type {any} */ (window).__html(answer);
      const top = Array.from(template.content.children);
      if (!top.some((el) => el.outerHTML === status)) return `its answer draws no ${status} as one of its elements`;
      const again = top.filter((el) => el.hasAttribute("data-corten-read-again")).at(-1);
      if (!again) return "its answer has no read-again tag among its elements";
      const from = again.getAttribute("data-from");
      if (again.localName !== "template" || from === null) return `its answer's read-again tag is a <${again.localName}>${from === null ? " without data-from" : ""}, not ReadAgain::from's template`;
      const wait = again.getAttribute("data-corten-read-again");
      if (wait !== String(seconds)) return `its answer's read-again tag waits ${JSON.stringify(wait)} seconds, not the part's ${seconds}`;
      const held = new URL(address);
      const target = new URL(from, document.baseURI);
      held.hash = target.hash = "";
      if (target.href !== held.href) return `its answer asks again from ${target.pathname}${target.search} (data-from ${JSON.stringify(from)} on ${location.pathname}), not the held read's ${held.pathname}${held.search}`;
      return null;
    },
    { answer, address, status, seconds: AGAIN_SECONDS },
  );
}

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
    /**
     * The token each of `go`'s navigations gives the answer to its own fetch of the page, by the
     * page's address (path and query). The route that answers that fetch (`seedNavigation`,
     * `wholeOnly`) takes it as the request reaches the route (`claimNav`), the first request there
     * only, and puts it on the status line that request's answer draws (`markNav`), so `go` can tell
     * the navigation's own draw from the page it left, which may say `Saving...` at the same moment,
     * and from a later read, even one whose answer is ready first.
     * @type {Map<string, string>}
     */
    const navTokens = new Map();
    /**
     * The token `go` gave its navigation to `address`, taken by the request that reaches the route
     * first, the moment it does: no other request at `address` gets it, whichever answer is ready
     * first. Undefined when none is waiting. @param {string} address
     */
    const claimNav = (address) => {
      const token = navTokens.get(address);
      navTokens.delete(address);
      return token;
    };
    /**
     * `body`, the answer to the request that took `token` (`claimNav`), with it on its status line
     * (`data-smoke-nav`); `body` as it is without one. @param {string | undefined} token @param {string} body
     */
    const markNav = (token, body) => (token === undefined ? body : body.replace('<p id="alert-status"', `<p data-smoke-nav="${token}" id="alert-status"`));
    /**
     * Whether `request` is the runtime's prefetch of a link under the pointer (`purpose: prefetch`),
     * which reads nothing and is no navigation's fetch. @param {import("@playwright/test").Request} request
     */
    const isPrefetch = (request) => request.headers()["purpose"] === "prefetch" || !!request.headers()["sec-purpose"]?.includes("prefetch");
    /**
     * Navigates the runtime's way to `url`, and says whether that navigation drew its own page there
     * still saving, in the same document. The page records it from before the navigation starts, the
     * moment it is drawn, so a waiter that starts late does not miss a `Saving...` its first part read
     * has already replaced: a status line saying `Saving...` counts only with the token the answer to
     * this navigation's own fetch carries (`markNav`), at `url`, and only while the document is the
     * one `go` started in (the record is on its window, which a full load loses). A page left that
     * says `Saving...` too, a page drawn by another read, or a full load is not this navigation's
     * draw. Waits up to 5 s for it, then reads the record (`saving`, `sameDocument`), with where the
     * page is and its status line, for a check's details. The draw counts only if the page drew it
     * within 5 s of starting the navigation, by the page's own clock (`performance.now()`), noted the
     * moment it was drawn: one drawn after them, before the record is read, does not (`lateBy`, how
     * long after). That clock alone decides: asking the page to navigate and reading the record are
     * driver plumbing, bounded to 15 s each, so a draw in time is not failed because the record came
     * back late.
     * @param {string} url
     * @returns {Promise<{ token: string, saving: boolean, lateBy: number | null, sameDocument: boolean, at: string, status: string | null }>}
     */
    const go = async (url) => {
      const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const address = new URL(url).pathname + new URL(url).search;
      navTokens.set(address, token);
      try {
        await within(
          15000,
          "the page was not asked to navigate within 15 s",
          page.evaluate(
            ({ url, token }) => {
              const w = /** @type {any} */ (window);
              /** @type {{ token: string, saving: boolean, drawnAt: number | null, by: number, stop: () => void }} */
              const note = { token, saving: false, drawnAt: null, by: performance.now() + 5000, stop: () => seen.disconnect() };
              w.__smokeGo = note;
              const look = () => {
                const status = document.getElementById("alert-status");
                if (location.href === url && status?.getAttribute("data-smoke-nav") === token && status.textContent === "Saving...") {
                  note.drawnAt = performance.now();
                  note.saving = true;
                  seen.disconnect();
                }
              };
              const seen = new MutationObserver(look);
              seen.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-smoke-nav"] });
              w.navigation.navigate(url);
            },
            { url, token },
          ),
        );
        // A full load ends the wait too: its document has no record of this navigation.
        await page
          .waitForFunction(
            (token) => {
              const note = (/** @type {any} */ (window)).__smokeGo;
              return note?.token !== token || note.saving === true;
            },
            token,
            { timeout: 5000 },
          )
          .catch(() => {});
        return await within(
          15000,
          "the navigation's record was not read within 15 s",
          page.evaluate((token) => {
            const note = (/** @type {any} */ (window)).__smokeGo;
            const sameDocument = note?.token === token;
            if (sameDocument) note.stop();
            const drawn = sameDocument && note.saving === true && typeof note.drawnAt === "number";
            const saving = drawn && note.drawnAt <= note.by;
            const lateBy = drawn && !saving ? Math.round(note.drawnAt - note.by) : null;
            return { token, saving, lateBy, sameDocument, at: location.href, status: document.getElementById("alert-status")?.textContent ?? null };
          }, token),
        );
      } finally {
        navTokens.delete(address);
      }
    };
    /**
     * What `go` saw, for a check's details. @param {{ saving: boolean, lateBy: number | null, sameDocument: boolean, at: string, status: string | null }} nav
     */
    const wentTo = (nav) =>
      nav.saving
        ? "Saving... drawn by the navigation"
        : nav.lateBy !== null
          ? `Saving... drawn by the navigation ${nav.lateBy} ms after its 5 s (the page at ${nav.at} says ${nav.status})`
          : nav.sameDocument ? `no Saving... drawn by the navigation (the page at ${nav.at} says ${nav.status})` : `a new document loaded (at ${nav.at}, saying ${nav.status})`;
    const saved = () => page.textContent("#alert-status");
    /** The alerts page's status line once its write is in, and while it lands, as the server writes them. */
    const savedLine = '<p id="alert-status" role="status">Saved.</p>';
    const savingLine = '<p id="alert-status" role="status">Saving...</p>';
    /** The head's read-again tag of a page as the server writes it (`ReadAgain` in the head). */
    const headTag = /<noscript data-corten-read-again="\d+"[^>]*>[\s\S]*?<\/noscript>/g;
    /** A part's read-again tag as the server writes it (`ReadAgain::from`). */
    const partTag = /<template data-corten-read-again="\d+"[^>]*><\/template>/g;
    /** The address a part's read-again tag reads from (`data-from`), as written. @param {string} tag */
    const tagFrom = (tag) => /data-from="([^"]*)"/.exec(tag)?.[1]?.replaceAll("&amp;", "&") ?? null;
    /**
     * What `body`, the server's own answer saying `Saving...`, lacks of the read-again tags the
     * server writes while a write lands: its head's tag, and with `part` its part's tag reading again
     * from `part` (the page's address). Null when it has them. @param {string} body @param {string} [part]
     */
    const missingTags = (body, part) => {
      const missing = [];
      if (!(body.match(headTag) ?? []).length) missing.push("its head's read-again tag");
      if (part !== undefined && !(body.match(partTag) ?? []).some((t) => tagFrom(t) === part)) missing.push(`its part's read-again tag from ${part}`);
      return missing.length ? missing.join(" and ") : null;
    };
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
      // One log of the page's reads of the alerts page, started before the page is loaded, in the
      // order the page sent them: every GET of `/alerts`, whatever its query, with when it was sent
      // (`Date.now()`) and its kind: a part read (`corten: action`), a hover prefetch (`purpose:
      // prefetch`, the runtime's fetch of a link under the pointer, which reads nothing again and is
      // named in the details but counted by no check), or a read of the page itself (any other). The
      // document the case loads is told from them by its own request, and only what came after it
      // counts, so a read sent before that load ends counts too.
      /** @typedef {{ request: import("@playwright/test").Request, time: number, kind: "part" | "prefetch" | "page" }} Read */
      /** @type {Read[]} */
      const log = [];
      const onPart = (/** @type {import("@playwright/test").Request} */ r) => {
        if (r.method() !== "GET" || new URL(r.url()).pathname !== "/alerts") return;
        const headers = r.headers();
        const kind = headers["corten"] === "action" ? "part" : headers["purpose"] === "prefetch" || headers["sec-purpose"]?.includes("prefetch") ? "prefetch" : "page";
        log.push({ request: r, time: Date.now(), kind });
      };
      /** The document the case loaded, once it has. @type {import("@playwright/test").Request | null} */
      let initial = null;
      /** The log from after the document the case loaded (all of it if that was not seen). */
      const since = () => log.slice(log.findIndex((e) => e.request === initial) + 1);
      const parts = () => since().filter((e) => e.kind === "part");
      const whole = () => since().filter((e) => e.kind === "page");
      const prefetches = () => since().filter((e) => e.kind === "prefetch");
      /** A logged read's address. @param {Read} e */
      const address = (e) => new URL(e.request.url()).pathname + new URL(e.request.url()).search;
      /** A logged read, named for a check's detail, with when it was sent from `time`. @param {Read} e @param {number} time */
      const named = (e, time) => `${e.kind} ${address(e)} (+${e.time - time} ms)`;
      /** The read the page sent next after `request`, prefetches aside, if any. @param {import("@playwright/test").Request | undefined} request */
      const after = (request) => {
        const at = request === undefined ? -1 : log.findIndex((e) => e.request === request);
        return at < 0 ? undefined : log.slice(at + 1).find((e) => e.kind !== "prefetch");
      };
      const url = await readWithin("the pending write's page", pending());
      // The write lands 1.5 s after it is sent and the part is first read 1 s after the page has
      // loaded, so a loaded browser's first read can find it landed, and then no answer asks again
      // (#2035). The first read is then answered as the server answers one while the write lands:
      // its status line saying so, and the tag asking again from the same address. A later read is
      // the server's own. Setting the case up and loading the page can take longer than 1.5 s too,
      // and a document that says `Saved.` asks for no part at all, so the document the case loads
      // is answered the same way if it finds the write landed: its status line saying so, its head
      // asking to be read again and the tag asking again from the same address, as the server writes
      // them while the write lands.
      const from = new URL(url).pathname + new URL(url).search;
      // The address the tag the first drawn answer put on the page is moved to (`moved` below).
      const movedFrom = `${from}&smoke-moved=1`;
      // Each part read takes its place in `answers` (its ordinal) the moment it reaches the stand-in,
      // and its answer's status line is marked with it (`data-smoke-read`), so the check can tell
      // which read's answer the page drew last, and which reads came after it.
      /** Each part read in the order it came (its address), then its answer: whether it asked again, and whether the stand-in gave it. @type {{ url: string, asks: boolean, standIn: boolean }[]} */
      const answers = [];
      /** Each of those reads' request, by the same place. @type {import("@playwright/test").Request[]} */
      const answered = [];
      const partReads = (/** @type {URL} */ u) => u.pathname + u.search === from || u.pathname + u.search === movedFrom;
      /** Set once the case is over: the route lets each read through, whether or not its removal is confirmed. */
      let over = false;
      // The first part read's answer is held until the case has its baseline (the status line, the
      // form filled, the document marked and the history length read), so no answer draws before
      // it: the page asks for its first read a second after it loads, and a loaded browser can take
      // longer than that to give the baseline. Let go however the case ends.
      /** @type {() => void} */
      let releaseFirst = () => {};
      const firstHeld = new Promise((resolve) => (releaseFirst = () => resolve(undefined)));
      /** Whether the first part read came before the case had its baseline, and so was held. */
      let firstWasHeld = false;
      /** Whether the route has answered the case's document, and whether as the server answers it while the write lands. */
      let documentAnswered = false;
      /** Whether the case has its baseline, and has let the first part read go. */
      let baselined = false;
      let documentStandIn = false;
      const pendingDocument = async (/** @type {import("@playwright/test").Route} */ route) => {
        documentAnswered = true;
        const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        const headers = res.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        const body = await res.text();
        documentStandIn = res.ok() && body.includes(savedLine) && !body.includes("data-corten-read-again");
        const answer = documentStandIn
          ? body
              .replace(savedLine, savingLine)
              .replace("</title>", '</title><noscript data-corten-read-again="1" data-corten-head><meta http-equiv="refresh" content="1"></noscript>')
              .replace("</main>", `<template data-corten-read-again="1" data-from="${from}"></template></main>`)
          : body;
        await route.fulfill({ status: res.status(), headers, body: answer });
      };
      const partRead = async (/** @type {import("@playwright/test").Route} */ route) => {
        const request = route.request();
        if (!over && !documentAnswered && request.method() === "GET" && request.isNavigationRequest()) return pendingDocument(route);
        if (over || request.method() !== "GET" || request.headers()["corten"] !== "action") return route.fallback();
        const at = answers.length;
        const asked = new URL(request.url());
        const address = asked.pathname + asked.search;
        answers.push({ url: address, asks: false, standIn: false });
        answered.push(request);
        if (at === 0) {
          firstWasHeld = !baselined;
          await firstHeld;
          if (over) return route.fallback();
        }
        // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
        const res = await route.fetch({ headers: { ...request.headers(), "accept-encoding": "identity" } });
        const headers = res.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        const body = await res.text();
        const saving = body.replace('<p id="alert-status" role="status">Saved.</p>', '<p id="alert-status" role="status">Saving...</p>');
        const standIn = at === 0 && res.ok() && saving !== body && !body.includes("data-corten-read-again");
        const answer = standIn ? `${saving}<template data-corten-read-again="1" data-from="${from}"></template>` : body;
        const marked = answer.replace('<p id="alert-status"', `<p data-smoke-read="${at}" id="alert-status"`);
        answers[at] = { url: address, asks: answer.includes("data-corten-read-again"), standIn };
        await route.fulfill({ status: res.status(), headers, body: marked });
      };
      // The runtime's navigations below reach a page still saving (#2035). The write lands 1.5 s
      // after it is sent, and a loaded browser's navigation can reach the server after that, when
      // the right answer is `Saved.` with no part to read, so a case waiting for `Saving...` would
      // fail on timing alone. So each one's fetch of the page is answered by the server's own answer,
      // and only when that says `Saved.` does the stand-in answer as the server does while the write
      // lands: its status line saying `Saving...`, its head's tag asking to be read again, and its
      // part's tag asking again from the page's own address after the seconds `seeds` gives it. An
      // answer of the server's that says `Saving...` is passed through with its own read-again tags,
      // which must be there (`missingTags`): one without them is passed through as it came and fails
      // the case (`seedFaults`), since the stand-in must not supply a tag the server dropped. Only
      // the tags' wait is set to the seconds `seeds` gives, where those differ from the server's (the
      // leave-before-read case's longer wait). Only the navigation's fetch is answered so: every part
      // read after it is the server's, or a case's own route's.
      /** The pages whose navigation is answered so, by address (path and query), each with its part's wait in seconds. @type {Map<string, number>} */
      const seeds = new Map();
      /** What each of those navigations was answered with, by address, for a check's detail. @type {Map<string, string>} */
      const seeded = new Map();
      /** Why a navigation's answer failed its case, by address: the server's `Saving...` without its read-again tags. @type {Map<string, string>} */
      const seedFaults = new Map();
      const seedReads = (/** @type {URL} */ u) => seeds.has(u.pathname + u.search);
      const seedNavigation = async (/** @type {import("@playwright/test").Route} */ route) => {
        const request = route.request();
        const asked = new URL(request.url());
        const address = asked.pathname + asked.search;
        const seconds = seeds.get(address);
        const mode = request.headers()["corten"];
        // The runtime's navigation alone (`corten: nav`, or `page` for a whole read; a prefetch
        // aside), once a page: the first such request takes the seed and the navigation's token.
        if (seconds === undefined || seeded.has(address) || request.method() !== "GET" || (mode !== "nav" && mode !== "page") || isPrefetch(request)) return route.fallback();
        seeded.set(address, "its fetch did not settle");
        const token = claimNav(address);
        try {
          // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
          const res = await route.fetch({ headers: { ...request.headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const body = await res.text();
          const shows = body.includes(savedLine) ? "Saved." : body.includes(savingLine) ? "Saving..." : null;
          if (!res.ok() || shows === null) {
            seeded.set(address, `the server's own answer (status ${res.status()}${shows === null ? ", no status line" : ""})`);
            await route.fulfill({ status: res.status(), headers, body: markNav(token, body) });
            return;
          }
          if (shows === "Saving...") {
            const missing = missingTags(body, address);
            if (missing !== null) {
              const fault = `the server's own answer saying Saving... without ${missing}, passed through as it came`;
              seeded.set(address, fault);
              seedFaults.set(address, fault);
              await route.fulfill({ status: res.status(), headers, body: markNav(token, body) });
              return;
            }
            const wait = (/** @type {string} */ t) => t.replace(/data-corten-read-again="\d+"/, `data-corten-read-again="${seconds}"`).replace(/content="\d+"/, `content="${seconds}"`);
            const answer = body.replace(headTag, wait).replace(partTag, (t) => (tagFrom(t) === address ? wait(t) : t));
            seeded.set(address, `the server's own answer saying Saving..., with its read-again tags${answer === body ? "" : `, their wait set to ${seconds} s`}`);
            await route.fulfill({ status: res.status(), headers, body: markNav(token, answer) });
            return;
          }
          // The write has landed: the stand-in answers as the server does while it lands.
          const tags = new RegExp(`${headTag.source}|${partTag.source}`, "g");
          const head = `<noscript data-corten-read-again="${seconds}" data-corten-head><meta http-equiv="refresh" content="${seconds}"></noscript>`;
          const tag = `<template data-corten-read-again="${seconds}" data-from="${address}"></template>`;
          const bare = body.replace(tags, "").replace(savedLine, savingLine);
          const headed = bare.includes("</title>") ? bare.replace("</title>", `</title>${head}`) : `${head}${bare}`;
          const answer = headed.includes("</main>") ? headed.replace("</main>", `${tag}</main>`) : `${headed}${tag}`;
          seeded.set(address, "the stand-in, the server's saying Saved.");
          await route.fulfill({ status: res.status(), headers, body: markNav(token, answer) });
        } catch (error) {
          seeded.set(address, `failed: ${String(/** @type {Error} */ (error)?.message ?? error).split("\n")[0]}`);
          await route.abort().catch(() => {});
        }
      };
      /** The init script below being added, removed with the route and listener. @type {Promise<import("@playwright/test").Disposable> | undefined} */
      let script;
      /**
       * The key in the page's `sessionStorage` that turns the init script off in every document it
       * runs in from then on: set as the case ends, so the script does nothing even if its removal
       * is not confirmed, and cleared once it is.
       */
      const offKey = "smoke-part-reads-off";
      // The route, the listener, the init script and its observer on the shared page are removed
      // however the case ends, each bounded to 5 s, as adding them is.
      try {
        // The page's own tag, as the server drew it, so the check below can tell it from the one an
        // answer put in its place. The first answer the page draws whose tag asks again has that tag
        // moved to `movedFrom` the moment it is drawn, so the check can tell the tag on the page,
        // which a script may change, from the answer's. And the first answer whose status line the
        // page draws as `Saved.`, noted the moment it is drawn with the time it was drawn (its
        // `data-smoke-read`, below), so a later answer that draws `Saved.` again before the check
        // looks is not taken for it. Once the case ends (`__smokeOff`) the script does nothing in
        // the document it ran in, and nothing in a later one (`offKey`).
        script = page.addInitScript(
          ({ movedFrom, offKey }) => {
            try {
              if (sessionStorage.getItem(offKey)) return;
            } catch {
              return;
            }
            const w = /** @type {any} */ (window);
            document.addEventListener(
              "DOMContentLoaded",
              () => {
                if (!w.__smokeOff) w.__pageTag = document.querySelector("main template[data-corten-read-again][data-from]");
              },
              { once: true },
            );
            if (location.pathname !== "/alerts") return;
            const observer = new MutationObserver(() => {
              const status = document.getElementById("alert-status");
              const read = status?.getAttribute("data-smoke-read");
              if (w.__smokeOff || !status || read == null) return;
              if (w.__moved === undefined) {
                const tag = document.querySelector("main template[data-corten-read-again][data-from]");
                if (tag && tag !== w.__pageTag) {
                  tag.setAttribute("data-from", movedFrom);
                  w.__moved = read;
                }
              }
              if (w.__firstSaved === undefined && status.textContent === "Saved.") w.__firstSaved = { read, time: Date.now() };
              if (w.__moved !== undefined && w.__firstSaved !== undefined) observer.disconnect();
            });
            w.__smokeObserver = observer;
            observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-smoke-read"] });
          },
          { movedFrom, offKey },
        );
        script.catch(() => {});
        await within(5000, "the case's init script was not added within 5 s", script);
        try {
          // Inside the guard: Playwright registers the handler before it awaits the browser's setup.
          // Bounded, as its removal below is.
          await within(5000, "the part route was not set within 5 s", page.route(partReads, partRead));
          page.on("request", onPart);
          initial = (await page.goto(url))?.request() ?? null;
          const waiting = await readWithin("the status line once the page loaded", saved());
          await page.fill("input[name=above]", "123.45");
          await within(
            5000,
            "the page was not marked within 5 s",
            page.evaluate(() => ((/** @type {any} */ (window)).__marker = 8)),
          );
          const entries = await readWithin(
            "the page's history length",
            page.evaluate(() => history.length),
          );
          baselined = true;
          releaseFirst();
          // The check that the part stops needs `Saved.` drawn within 5 s from here, the wait below
          // included: by the draw's own time, recorded by the page.
          const savedBy = Date.now() + 5000;
          await savedSoon();
          const status = await readWithin("the status line after the wait for Saved.", saved());
          check(
            "a page's part waiting for a write is read again after a full load, not the page",
            waiting === "Saving..." && status === "Saved." && initial !== null && parts().length > 0 && whole().length === 0 && page.url() === url,
            `${waiting} -> ${status} after ${parts().length} part and ${whole().length} page reads${whole().length ? ` (${whole().map((e) => address(e)).join(", ")})` : ""}${prefetches().length ? `, and ${prefetches().length} prefetches not counted (${prefetches().map((e) => address(e)).join(", ")})` : ""}${initial ? "" : " (the document loaded not seen)"}${documentStandIn ? " (the document found the write landed, and was answered as while it lands)" : ""}${firstWasHeld ? " (its first part read held until the baseline was read)" : ""}`,
          );
          const kept = await readWithin(
            "what the page kept",
            page.evaluate(() => ({
              marker: (/** @type {any} */ (window)).__marker,
              entries: history.length,
              above: /** @type {HTMLInputElement | null} */ (document.querySelector("input[name=above]"))?.value,
            })),
          );
          check("reading a page's part keeps the document, its history entry and the form", kept.marker === 8 && kept.entries === entries && kept.above === "123.45", JSON.stringify(kept));
          // The part's answer that asked again put its tag in the page's tag's place: one tag, the
          // last read's, and not the page's own (whose address is the same here). And the tag on the
          // page is the one its next read is made from: the first drawn answer's, moved to
          // `movedFrom` as it was drawn, sends the read after that answer's to `movedFrom`, where a
          // read made from the answer's own tag, as it came, would go to `from`. The read after is the
          // one the page sent next after that answer's own read, by the log, prefetches aside: a read
          // the stand-in did not answer (another address) comes between them too.
          const tagged = await readWithin(
            "the page's read-again tags",
            page.evaluate(() => {
              const all = Array.from(document.querySelectorAll("main template[data-corten-read-again][data-from]"));
              const first = (/** @type {any} */ (window)).__pageTag;
              return {
                tags: all.map((t) => new URL(/** @type {string} */ (t.getAttribute("data-from")), location.href).href),
                pageTag: !!first,
                pageTagGone: !!first && !first.isConnected && !all.includes(first),
                moved: /** @type {string | undefined} */ ((/** @type {any} */ (window)).__moved) ?? null,
              };
            }),
          );
          const tags = tagged.tags;
          const next = tagged.moved === null ? undefined : after(answered[Number(tagged.moved)]);
          const movedRead = next === undefined ? null : `${next.kind === "part" ? "" : `${next.kind} `}${address(next)}`;
          const lastPart = parts().at(-1)?.request.url();
          check(
            "a page part's answer that asks again takes the place of the tag that asked",
            answers.some((a) => a.asks) && tags.length === 1 && tags[0] === lastPart && tagged.pageTag && tagged.pageTagGone && movedRead === movedFrom,
            `${JSON.stringify({ ...tagged, movedRead, movedFrom, answers })} after ${lastPart}`,
          );
          // Quiet only once an answer that does not ask again has drawn `Saved.`, within 5 s from
          // before the wait for it above, by the time the page recorded as it drew it: reads that
          // stopped after an answer that asked again are not a part that stopped. The answer is the
          // first to draw `Saved.`, noted as it was drawn, not the one drawn when the check looks (a
          // later read that draws `Saved.` again would hide the read before it). The 2.2 s are
          // counted from that draw, not from when the check saw it, and no read of the page may come
          // after that answer's own read in the log, whatever its address. The check looks once 2.2 s
          // have passed since that draw and counts every read in the log by then: a read sent between
          // the draw and the check seeing it counts against it, as does one at the end of the 2.2 s,
          // and one sent after them that is in the log when the check looks. The log has a read's
          // time as the check heard of it, after the page sent it, so it is not cut at the 2.2 s: that
          // could drop a read sent within them. A hover prefetch is no read again, and is named but
          // not counted.
          const look = () =>
            page.evaluate(() => /** @type {{ read: string, time: number } | undefined} */ ((/** @type {any} */ (window)).__firstSaved));
          const first =
            (await pollFor(Math.max(0, savedBy - Date.now()), look)) ?? (await within(5000, "the page did not say what it drew within 5 s", look()).catch(() => undefined));
          const drawn = first && first.time <= savedBy ? first : null;
          const last = drawn === null ? null : (answers[Number(drawn.read)] ?? null);
          const quiet = !!last && !last.asks;
          if (quiet && drawn) await page.waitForTimeout(Math.max(0, drawn.time + 2200 - Date.now()));
          const terminal = quiet && drawn ? log.findIndex((e) => e.request === answered[Number(drawn.read)]) : -1;
          const afterTerminal = terminal < 0 || !drawn ? [] : log.slice(terminal + 1);
          const later = afterTerminal.filter((e) => e.kind !== "prefetch").map((e) => named(e, /** @type {{ time: number }} */ (drawn).time));
          const prefetched = afterTerminal.filter((e) => e.kind === "prefetch").map((e) => named(e, /** @type {{ time: number }} */ (drawn).time));
          check(
            "a page's part stops once its patch no longer asks",
            quiet && terminal >= 0 && later.length === 0,
            quiet
              ? terminal < 0
                ? `the read whose answer first drew Saved. (${drawn?.read}) is not in the page's reads`
                : `${later.length} reads after the read whose answer first drew Saved. (${drawn?.read}), by the check's look at least 2.2 s after that draw: ${later.join(", ") || "none"}${prefetched.length ? `; prefetches not counted: ${prefetched.join(", ")}` : ""}`
              : `no answer that does not ask again was the first to draw Saved., within 5 s (${JSON.stringify({ first, answers })})`,
          );
        } finally {
          over = true;
          releaseFirst();
          await within(5000, "the part route was not removed within 5 s", page.unroute(partReads, partRead));
        }
        if (swaps) {
          // Inside the guard, which removes it (bounded): Playwright registers the handler before it
          // awaits the browser's setup.
          await within(5000, "the navigations' stand-in route was not set within 5 s", page.route(seedReads, seedNavigation));
          const from = parts().length;
          const wholeFrom = whole().length;
          /**
           * `go` to `to`, its navigation answered as still saving, with its part read again after
           * `seconds` (`seeds`): its `Saving...` must be drawn within 5 s by the page's clock, which
           * `go` alone decides, with no outer bound of driver time on top, and a server's `Saving...`
           * without its read-again tags fails it (`seedFaults`). @param {string} to @param {number} [seconds]
           */
          const goTo = async (to, seconds = AGAIN_SECONDS) => {
            const at = new URL(to).pathname + new URL(to).search;
            seeds.set(at, seconds);
            const nav = await go(to);
            const fault = seedFaults.get(at);
            if (!nav.saving || fault !== undefined) throw new Error(`the runtime's navigation to ${at}: ${fault ?? wentTo(nav)}`);
            return nav;
          };
          const reachedUrl = await readWithin("the pending write's page", pending());
          // The page reached, by its address: its own part reads are the ones that count. Each takes
          // its place among `reachAnswers` as it reaches the route, which notes whether its answer
          // draws `Saved.` and marks that answer's status line with the place (`data-smoke-reach`),
          // so the `Saved.` the check sees is tied to an answer to the reached page's own read, not
          // to a read of another address (an earlier receipt's), whose answer draws the same text in
          // the same status line.
          const reachedAt = new URL(reachedUrl).pathname + new URL(reachedUrl).search;
          /** Whether each part read of the reached page drew `Saved.`, by the order it came. @type {boolean[]} */
          const reachAnswers = [];
          /** Set once the check is over: the route lets each read through, whether or not its removal is confirmed. */
          let reachOver = false;
          const reachReads = (/** @type {URL} */ u) => u.pathname + u.search === reachedAt;
          const reachPart = async (/** @type {import("@playwright/test").Route} */ route) => {
            const request = route.request();
            if (reachOver || request.method() !== "GET" || request.headers()["corten"] !== "action") return route.fallback();
            const at = reachAnswers.length;
            reachAnswers.push(false);
            try {
              // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
              const res = await route.fetch({ headers: { ...request.headers(), "accept-encoding": "identity" } });
              const headers = res.headers();
              delete headers["content-encoding"];
              delete headers["content-length"];
              const body = await res.text();
              reachAnswers[at] = res.ok() && body.includes(savedLine);
              await route.fulfill({ status: res.status(), headers, body: body.replace('<p id="alert-status"', `<p data-smoke-reach="${at}" id="alert-status"`) });
            } catch {
              reachAnswers[at] = false;
              await route.abort().catch(() => {});
            }
          };
          try {
            await within(5000, "the reached page's part route was not set within 5 s", page.route(reachReads, reachPart));
            const nav = await goTo(reachedUrl);
            // `Saved.` drawn by an answer to the reached page's own part read, within 6 s.
            await page
              .waitForFunction(
                () => {
                  const status = document.getElementById("alert-status");
                  return status?.textContent === "Saved." && status.hasAttribute("data-smoke-reach");
                },
                null,
                { timeout: 6000 },
              )
              .catch(() => {});
            const reached = await readWithin(
              "the status line after the navigation's wait for Saved.",
              page.evaluate(() => {
                const status = document.getElementById("alert-status");
                return { text: status?.textContent ?? null, read: status?.getAttribute("data-smoke-reach") ?? null };
              }),
            );
            // The same document throughout: the record `go` put on its window is still there, which a
            // full load (a document read, then its part) would have lost.
            const kept = await readWithin(
              "whether the navigation kept the document",
              page.evaluate((token) => (/** @type {any} */ (window)).__smokeGo?.token === token, nav.token),
            );
            const own = parts().slice(from).filter((e) => address(e) === reachedAt);
            const others = parts().slice(from).filter((e) => address(e) !== reachedAt);
            const drewOwn = reached.text === "Saved." && reached.read !== null && reachAnswers[Number(reached.read)] === true;
            check(
              "a page's part reached by the runtime's navigation is read again, not the page",
              nav.saving && nav.sameDocument && kept && drewOwn && own.length > 0 && whole().length - wholeFrom === 1,
              `${wentTo(nav)}, then ${reached.text}${reached.read === null ? " (not drawn by an answer to the reached page's own part read)" : ` drawn by its part read ${Number(reached.read) + 1}`} after ${own.length} part reads of ${reachedAt}${others.length ? ` and ${others.length} of other addresses (${others.map((e) => address(e)).join(", ")})` : ""}, ${whole().length - wholeFrom} page loads (the navigation's, answered with ${seeded.get(reachedAt) ?? "nothing seen"})${kept ? "" : ", in another document"}`,
            );
          } finally {
            reachOver = true;
            await cleanUp(() => within(5000, "the reached page's part route was not removed within 5 s", page.unroute(reachReads, reachPart)));
          }
          // Away while the part still owes a read: the runtime's navigation reaches a page still
          // saving, whose part reads are each held unanswered from then on, so the part cannot draw
          // its last answer (`Saved.`) and stop on its own before the page leaves. The navigation's
          // answer is the stand-in's (`seeds`), still saving whenever it reaches the server, and the
          // route holds every part read after it. Once the route holds a read
          // with the page still saying `Saving...` (within 5 s), the page leaves by a link; then each
          // held read is answered as one that asks again (the server's answer while the write lands),
          // and no part read may come in the `quietFor` after that (the part's `AGAIN_SECONDS` and 1.2 s
          // more). The check needs at least one held read answered so, and every held read let go
          // that way within 5 s of its release by the monotonic clock (`performance.now()`): a read
          // counts as answered only once the browser has finished loading that exact request with
          // the answer its fulfill sent (its `requestfinished`, with the answer's own `smoke-held`
          // mark), since a fulfill that resolves need not have answered it (Playwright's Firefox
          // drops the browser's refusal of one). A read whose fetch or fulfill fails, whose answer
          // the browser fails or does not finish with that mark, whose answer is no patch drawing
          // `Saving...` with a ReadAgain::from template among its elements that asks again after
          // `AGAIN_SECONDS` from the held read's own address (parsed by the page as the runtime parses
          // a patch, resolved against the page it is delivered to, `readAgainFault`), or whose
          // release does not settle fails it, saying which. The 5 s are checked by that clock once
          // the answer is fetched and again just before the fulfill is sent, not by whether a timer
          // has run: a release past them before its fulfill is sent aborts its read (and nothing
          // answers it after). Once the fulfill is sent, the time the check heard the browser finish
          // the read (its `requestfinished`, timestamped as it is heard) decides: one finished past
          // the 5 s fails as late, and reading the finished answer's mark after that is the check's
          // own work, which does not make a finish in time late. A release whose 5 s timer runs
          // before its fulfill is sent aborts the read and settles its route callback then; one whose
          // fulfill was sent waits 10 s more for the browser's end of the read and its mark, then
          // says the read's outcome is unconfirmed, which fails the check too. Without a held read
          // it fails too, since a part that has stopped says nothing about leaving it.
          /** How long no part read may come after the held reads are let go: longer than the part waits to read again. */
          const quietFor = AGAIN_SECONDS * 1000 + 1200;
          /** The address of the page the case leaves, once its write is sent: the route takes no read before. @type {string | null} */
          let awayFrom = null;
          const awayReads = (/** @type {URL} */ u) => awayFrom !== null && u.pathname + u.search === awayFrom;
          /**
           * Lets go of each part read the route holds, answering it as one that asks again, within
           * 5 s: null once the browser has finished that read with that answer in time, else what
           * went wrong (the read is then aborted, unless its fulfill was already sent). Its route
           * callback has settled when this has.
           * @type {{ release: () => Promise<string | null> }[]}
           */
          const owed = [];
          /** Set once the page has left, or the case ends: the route lets each read through at once. */
          let gone = false;
          const holdPart = (/** @type {import("@playwright/test").Route} */ route) => {
            const request = route.request();
            if (gone || request.method() !== "GET" || request.headers()["corten"] !== "action") return route.fallback();
            // How the browser ends this read, heard from the moment it is held so its end cannot come
            // before the check listens: when it finished loading an answer, by the monotonic clock
            // read as the check hears of it (`requestfinished`), else the browser's reason it failed.
            /** @type {() => void} */
            let unlisten = () => {};
            /** @type {Promise<{ finishedAt: number } | string>} */
            const ended = new Promise((resolve) => {
              const finished = (/** @type {import("@playwright/test").Request} */ r) => {
                if (r !== request) return;
                const finishedAt = performance.now();
                unlisten();
                resolve({ finishedAt });
              };
              const failed = (/** @type {import("@playwright/test").Request} */ r) => {
                if (r !== request) return;
                unlisten();
                resolve(r.failure()?.errorText ?? "no reason given");
              };
              page.on("requestfinished", finished);
              page.on("requestfailed", failed);
              unlisten = () => {
                page.off("requestfinished", finished);
                page.off("requestfailed", failed);
              };
            });
            return new Promise((settle) =>
              owed.push({
                release: () => {
                  /** The release's 5 s, by the monotonic clock: a timer that runs late does not stretch them. */
                  const deadline = performance.now() + 5000;
                  const late = () => performance.now() >= deadline;
                  /** Set once the release's timer has run or it has its outcome: from then on nothing touches the route. */
                  let over = false;
                  /** Set once its fulfill is sent: from then on an abort cannot take the answer back. */
                  let sent = false;
                  /** Set once the read is aborted, so it is aborted once. */
                  let aborted = false;
                  const abort = async () => {
                    if (aborted) return;
                    aborted = true;
                    await route.abort().catch(() => {});
                  };
                  // The answer's own mark, so the answer the browser finishes the read with is known
                  // to be this release's.
                  const marker = crypto.randomUUID();
                  const reply = async () => {
                    let step = "its fetch";
                    try {
                      // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
                      const res = await route.fetch({ headers: { ...request.headers(), "accept-encoding": "identity" } });
                      step = "reading its answer";
                      const headers = res.headers();
                      delete headers["content-encoding"];
                      delete headers["content-length"];
                      const body = await res.text();
                      const landed = body.includes(savedLine) && !body.includes("data-corten-read-again");
                      // Out of time: the read is aborted, and a late answer is no answer.
                      if (over || late()) {
                        await abort();
                        return "its 5 s ran out before its fulfill was sent, so its read was aborted";
                      }
                      const answer = landed ? `${body.replace(savedLine, savingLine)}<template data-corten-read-again="${AGAIN_SECONDS}" data-from="${awayFrom}"></template>` : body;
                      step = "reading its answer in the page";
                      const fault = !res.ok() || !("corten-patch" in headers) ? `its answer was no patch (status ${res.status()}${"corten-patch" in headers ? "" : ", no corten-patch header"})` : await readAgainFault(page, answer, request.url(), savingLine);
                      // The last look before the fulfill is sent: past it, the read is answered or not
                      // by what the browser does.
                      if (over || late()) {
                        await abort();
                        return "its 5 s ran out before its fulfill was sent, so its read was aborted";
                      }
                      step = "its fulfill";
                      sent = true;
                      await route.fulfill({ status: res.status(), headers: { ...headers, "smoke-held": marker }, body: answer });
                      // A fulfill that resolves need not have answered the read: the browser must
                      // finish this request, with this answer.
                      step = "the browser's end of its read";
                      const end = await ended;
                      if (typeof end === "string") return `its fulfill was sent but the browser failed the read (${end}), so it was not answered`;
                      // Late or not is decided by when the read finished, not by when its answer's
                      // mark is read below, which is the check's own plumbing.
                      if (end.finishedAt >= deadline) return `the browser finished the read ${Math.round(end.finishedAt - deadline)} ms after its 5 s, too late to count as answered`;
                      step = "reading the mark of the answer the browser finished it with";
                      const mark = (await request.response())?.headers()["smoke-held"];
                      if (mark !== marker) return `the browser finished the read with an answer ${mark === undefined ? "without" : "with another"} smoke-held mark, not its fulfill's`;
                      return fault;
                    } catch (error) {
                      // The page that sent it has left, or the read was cancelled: it is aborted, and
                      // not counted as answered.
                      if (!over) await abort();
                      return `${step} failed: ${String(/** @type {Error} */ (error)?.message ?? error).split("\n")[0]}`;
                    }
                  };
                  // The timer is armed before `reply` starts, with what is left of the same 5 s, so a slow
                  // start of its fetch does not stretch them.
                  const replied = Promise.resolve().then(reply);
                  return within(Math.max(0, deadline - performance.now()), "its release did not settle within 5 s", replied)
                    .catch((/** @type {Error} */ error) => {
                      over = true;
                      // Its fulfill was sent: an abort now is refused, and `reply` decides by when the
                      // browser finished the read (a finish heard after the 5 s fails as late there), so
                      // its outcome is waited for, 10 s more of plumbing. Not settled by then: whether the
                      // fulfill answered the read is not known.
                      if (sent)
                        return within(10000, "", replied).catch(
                          () => "its fulfill was sent but neither the browser's end of the read nor its answer's mark was heard within 10 s after its 5 s: whether it answered the read is unconfirmed",
                        );
                      // Its fetch or answer never settled: the read is aborted and its callback
                      // settles now, not when (if ever) that work ends.
                      abort();
                      return error.message;
                    })
                    .finally(() => {
                      over = true;
                      unlisten();
                      settle(undefined);
                    });
                },
              }),
            );
          };
          /**
           * Lets go of every read held so far, each within 5 s: what became of each (null: answered
           * as one that asks again). A read whose release does not settle is aborted, and its route
           * callback settles then all the same.
           */
          const letGo = () => Promise.all(owed.splice(0).map(({ release }) => release()));
          // The held reads are let go and the route removed (bounded) however the case ends.
          try {
            await within(5000, "the leaving case's part route was not set within 5 s", page.route(awayReads, holdPart));
            const awayUrl = await readWithin("the pending write's page", pending());
            awayFrom = new URL(awayUrl).pathname + new URL(awayUrl).search;
            await goTo(awayUrl);
            /** The held reads and the status line, once the route holds one. */
            const owes = await pollFor(5000, async () => owed.length > 0 && { held: owed.length, status: await page.textContent("#alert-status") });
            const left = parts().length;
            await page.click('header a[href="/news"]');
            await page.waitForFunction(() => document.title === "News | Watchlist");
            gone = true;
            const released = await letGo();
            const delivered = released.filter((r) => r === null).length;
            const failed = released.flatMap((r, i) => (r === null ? [] : [`held read ${i + 1}: ${r}`]));
            await page.waitForTimeout(quietFor);
            check(
              "navigating away stops a page's part reads",
              !!owes && owes.status === "Saving..." && delivered > 0 && failed.length === 0 && parts().length === left,
              `${owes ? `${owes.held} part read held unanswered, the page saying ${owes.status}, as it left` : "no part read held within 5 s of reaching the page"}; ${delivered} of ${released.length} held reads answered as ones that ask again${failed.length ? ` (${failed.join("; ")})` : ""}; ${parts().length - left} more reads in the ${quietFor} ms after`,
            );
          } finally {
            gone = true;
            await cleanUp(
              () => letGo(),
              () => within(5000, "the leaving case's part route was not removed within 5 s", page.unroute(awayReads, holdPart)),
            );
          }
          // Away before the read: the runtime's navigation reaches a page still saving whose part is
          // to be read `LEAVE_SECONDS` after its tag is drawn (the stand-in's answer, `seeds`), and
          // the page leaves by its header's link, pressed in the page, before that read is due. No
          // part read of the alerts page may be sent from when that attempt began, then or later, of
          // that page's address or any other (a timer left to run asks with its own receipt, which
          // need not be that page's): leaving cancels a read the page has
          // only scheduled, as well as the answer of one on its way (the check above). The page's
          // own clock (`performance.now()`) gives the order: a mutation observer notes the moment the
          // part's tag is drawn and the moment it leaves the page (the next page's `<main>` taking
          // its place). The runtime starts the read's timer as it draws the tag, in the same task, so
          // an attempt counts only if the page left `LEAVE_MARGIN_MS` before the read was due by that
          // note; a loaded browser that leaves later is tried again, three attempts in all, each with
          // a write of its own. Then the check waits for a timer the page sets as the tag leaves,
          // `LEAVE_SECONDS` and 1.2 s long: started after the part's and no shorter, it runs only
          // after the part's has (HTML's timer order). It waits for that within its length and 5 s
          // more, then 1.5 s for a read sent by then to reach the log. Without an attempt that
          // counts, or with the page's timer not run, the check fails, saying which.
          {
            /** One attempt: its page's address, where the log stood as it began, and how it went. @typedef {{ address: string, logFrom: number, said: string }} Leave */
            /** @type {Leave[]} */
            const attempts = [];
            /** The attempt that counted. @type {Leave | undefined} */
            let counted;
            /** When the page's timer ran, by its clock, or null if it did not in time. @type {number | null} */
            let past = null;
            /** How long the page's timer is: the part's wait and 1.2 s. */
            const pastBy = LEAVE_SECONDS * 1000 + 1200;
            /** The part reads of the alerts page, at any address, sent since an attempt began. @param {Leave} attempt */
            const sentTo = (attempt) => log.slice(attempt.logFrom).filter((e) => e.kind === "part");
            try {
              for (let tries = 0; tries < 3 && !counted; tries++) {
                const to = await readWithin("the pending write's page", pending());
                /** @type {Leave} */
                const attempt = { address: new URL(to).pathname + new URL(to).search, logFrom: log.length, said: "" };
                attempts.push(attempt);
                await readWithin(
                  "the page's note of its part's tag",
                  page.evaluate(
                    ({ address, pastBy }) => {
                      const w = /** @type {any} */ (window);
                      w.__smokeLeave?.observer?.disconnect();
                      /** @type {{ drawn: number | null, left: number | null, past: number | null, observer: MutationObserver | null }} */
                      const note = { drawn: null, left: null, past: null, observer: null };
                      /** The part's tag of the page at `address`, once drawn. @type {Element | null} */
                      let tag = null;
                      const ours = (/** @type {Element} */ t) => {
                        const from = t.getAttribute("data-from");
                        if (from === null) return false;
                        const u = new URL(from, document.baseURI);
                        return u.pathname + u.search === address;
                      };
                      const observer = new MutationObserver(() => {
                        if (!tag) {
                          tag = Array.from(document.querySelectorAll("main template[data-corten-read-again][data-from]")).find(ours) ?? null;
                          if (tag) note.drawn = performance.now();
                        }
                        if (tag && !tag.isConnected) {
                          note.left = performance.now();
                          observer.disconnect();
                          setTimeout(() => (note.past = performance.now()), pastBy);
                        }
                      });
                      note.observer = observer;
                      observer.observe(document, { childList: true, subtree: true });
                      w.__smokeLeave = note;
                    },
                    { address: attempt.address, pastBy },
                  ),
                );
                await goTo(to, LEAVE_SECONDS);
                await within(
                  5000,
                  "the page's link to the news page was not pressed within 5 s",
                  page.evaluate(() => /** @type {HTMLAnchorElement} */ (document.querySelector('header a[href="/news"]')).click()),
                );
                await within(5000, "the news page was not drawn within 5 s of the press", page.waitForFunction(() => document.title === "News | Watchlist", null, { timeout: 5000 }));
                const times = await readWithin(
                  "when the page's part tag was drawn and left",
                  page.evaluate(() => {
                    const note = (/** @type {any} */ (window)).__smokeLeave;
                    return { drawn: /** @type {number | null} */ (note.drawn), left: /** @type {number | null} */ (note.left) };
                  }),
                );
                if (times.drawn === null || times.left === null) attempt.said = `its part's tag was ${times.drawn === null ? "not seen drawn" : "not seen leaving the page"}`;
                else {
                  const ahead = times.drawn + LEAVE_SECONDS * 1000 - times.left;
                  attempt.said = `left ${Math.round(times.left - times.drawn)} ms after its part's tag was drawn, ${Math.round(ahead)} ms before its read was due`;
                  if (ahead > LEAVE_MARGIN_MS) counted = attempt;
                }
              }
              const leave = counted;
              if (leave) {
                past = await pollFor(pastBy + 5000, () => page.evaluate(() => /** @type {number | null} */ ((/** @type {any} */ (window)).__smokeLeave.past) ?? false));
                await pollFor(1500, async () => sentTo(leave).length > 0);
              }
              const sent = leave ? sentTo(leave) : [];
              const tried = attempts.map((a) => `${a.address} ${a.said || "(not reached)"}`).join("; ");
              check(
                "navigating away before a page's part is read sends no read",
                !!leave && past !== null && sent.length === 0,
                leave
                  ? `the page at ${leave.address} (its navigation answered with ${seeded.get(leave.address) ?? "nothing seen"}) ${leave.said}${past === null ? `; the page's timer ${pastBy} ms after its tag left did not run within 5 s more` : ""}; ${sent.length} part reads of the alerts page sent after${sent.length ? ` (${sent.map((e) => address(e)).join(", ")})` : ""}${attempts.length > 1 ? `; attempts: ${tried}` : ""}`
                  : `no attempt left its page ${LEAVE_MARGIN_MS} ms before its part's read was due: ${tried}`,
              );
            } finally {
              await cleanUp(() =>
                within(
                  5000,
                  "the page's note of its part's tag was not stopped within 5 s",
                  page.evaluate(() => (/** @type {any} */ (window)).__smokeLeave?.observer?.disconnect()),
                ),
              );
            }
          }
        } else {
          for (const name of [
            "a page's part reached by the runtime's navigation is read again, not the page",
            "navigating away stops a page's part reads",
            "navigating away before a page's part is read sends no read",
          ])
            skip(name, noSwaps);
        }
      } finally {
        /** Whether the init script's removal was confirmed. */
        let removed = false;
        await cleanUp(
          () => page.off("request", onPart),
          () => within(5000, "the navigations' stand-in route was not removed within 5 s", page.unroute(seedReads, seedNavigation)),
          () =>
            within(
              5000,
              "the case's observer was not disconnected within 5 s",
              page.evaluate((offKey) => {
                const w = /** @type {any} */ (window);
                w.__smokeOff = true;
                w.__smokeObserver?.disconnect();
                sessionStorage.setItem(offKey, "1");
              }, offKey),
            ),
          async () => {
            if (!script) return;
            await within(
              5000,
              "the case's init script was not removed within 5 s",
              script.then((s) => s.dispose()),
            );
            removed = true;
          },
          () => removed && within(5000, "the case's off switch was not cleared within 5 s", page.evaluate((offKey) => sessionStorage.removeItem(offKey), offKey)),
        );
      }
    }

    // The rest reads the page whole: the page as one that asks only that (its head's ReadAgain,
    // without the part's tag). Fetched uncompressed: Playwright does not decode zstd, which
    // Firefox asks for.
    /** A page's markup without its parts' read-again tags, so it asks to be read whole. @param {string} body */
    const asWhole = (body) => body.replace(/<template data-corten-read-again[^>]*><\/template>/g, "");
    /**
     * Each read of a page these cases read whole by the runtime (`corten: nav`, or `page` for a
     * whole read; a prefetch aside), by address (path and query), in the order it reached the route,
     * with whether it was `go`'s navigation's own fetch, so a check can count the reads after it.
     * @type {{ address: string, navigation: boolean }[]}
     */
    const wholeReads = [];
    /** What each of `go`'s navigations here was answered with, by address, for a check's detail. @type {Map<string, string>} */
    const wholeSeeded = new Map();
    /** Why a navigation's answer here failed its check, by address: the server's `Saving...` without its head's read-again tag. @type {Map<string, string>} */
    const wholeFaults = new Map();
    /**
     * `body`, a whole page's answer, as the server writes it while its write lands: its status line
     * saying `Saving...` and its head asking to be read again after `AGAIN_SECONDS` (the alerts
     * page's own wait), for an answer the server gave once the write had landed. @param {string} body
     */
    const stillSaving = (body) => {
      const head = `<noscript data-corten-read-again="${AGAIN_SECONDS}" data-corten-head><meta http-equiv="refresh" content="${AGAIN_SECONDS}"></noscript>`;
      const bare = body.replace(/<noscript data-corten-read-again[^>]*>[\s\S]*?<\/noscript>/g, "").replace(savedLine, savingLine);
      return bare.includes("</title>") ? bare.replace("</title>", `</title>${head}`) : `${head}${bare}`;
    };
    const wholeOnly = async (/** @type {import("@playwright/test").Route} */ route) => {
      const request = route.request();
      const mode = request.headers()["corten"];
      if (mode === "action") return route.fallback();
      const asked = new URL(request.url());
      const address = asked.pathname + asked.search;
      // The runtime's reads (`corten: nav`, or `page` for a whole read; a prefetch aside); `go`'s
      // navigation's own fetch is the one that takes its token, as it reaches the route.
      const read = request.method() === "GET" && (mode === "nav" || mode === "page") && !isPrefetch(request);
      const token = read ? claimNav(address) : undefined;
      const navigation = token !== undefined;
      if (read) wholeReads.push({ address, navigation });
      const res = await route.fetch({ headers: { ...request.headers(), "accept-encoding": "identity" } });
      const headers = res.headers();
      delete headers["content-encoding"];
      delete headers["content-length"];
      const whole = asWhole(await res.text());
      if (!navigation) return route.fulfill({ status: res.status(), headers, body: whole });
      // The write lands 1.5 s after it is sent, and a loaded browser's navigation can reach the
      // server after that, when the right answer is `Saved.` with nothing to read again, so the
      // navigation's own fetch alone is answered as the server answers it while the write lands
      // (#2035), as `seedNavigation` answers the part cases', but only when the server's answer says
      // `Saved.`: one that says `Saving...` is passed through with its own head's read-again tag,
      // which must be there (`wholeFaults`), never one the stand-in supplies. Every read after it is
      // the server's.
      const shows = whole.includes(savedLine) ? "Saved." : whole.includes(savingLine) ? "Saving..." : null;
      if (!res.ok() || shows === null) {
        wholeSeeded.set(address, `the server's own answer (status ${res.status()}${shows === null ? ", no status line" : ""})`);
        return route.fulfill({ status: res.status(), headers, body: markNav(token, whole) });
      }
      if (shows === "Saving...") {
        const missing = missingTags(whole);
        if (missing !== null) wholeFaults.set(address, `the server's own answer saying Saving... without ${missing}`);
        wholeSeeded.set(address, missing === null ? "the server's own answer saying Saving..., with its head's read-again tag" : `the server's own answer saying Saving... without ${missing}, passed through as it came`);
        return route.fulfill({ status: res.status(), headers, body: markNav(token, whole) });
      }
      wholeSeeded.set(address, "the stand-in, the server's saying Saved.");
      await route.fulfill({ status: res.status(), headers, body: markNav(token, stillSaving(whole)) });
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
      // The page's load is given a document still saving for a write's receipt whatever the store
      // says by then (#2014): the page the server draws for that receipt, with its status line and
      // its head's read-again tag as the server draws them while the write has not landed. The
      // store's reads see a write 1.5 s after it, and the round trip between the write and the read
      // of its page can take longer on a loaded machine, so the case does not depend on it. The
      // runtime's reads of a page (a `corten: nav` or `page` request that is not a prefetch) are
      // recorded from the start of that document whatever their address, which is loaded after a
      // blank one so no read of an earlier document counts, and its first read of the alerts page is
      // held from before the load, so the read held is the first however soon it comes; it must be
      // the document's first read, of the receipt's address. The case requires that read still on its
      // way when the script replaces the address (the navigation reading it not yet ended), that
      // navigation cancelled by the replaceState, and the read failing after it while it is still
      // held (not once it is let go); then every later read made at its address with only `shown`
      // changed, one of them answered with success, `Saved.` drawn in the same document, and the
      // page left at that address. Each wait has its own bound, and a result after it fails the case;
      // once a step fails, the case does no more page work. The hold is let go and the route and
      // listeners removed however the case ends.
      const name = "a read a script's replaceState cancels on its way is made again";
      /** A write, and the page the server draws for its receipt's address. */
      const capture = () =>
        page.evaluate(async () => {
          const res = await fetch("/alerts", { method: "POST", headers: { corten: "action", "content-type": "application/x-www-form-urlencoded" }, body: "id=ACME&above=175" });
          const from = /data-from="([^"]+)"/.exec(await res.text())?.[1];
          if (!from) return null;
          // Drawn as the page a write's redirect brings (`corten: page`), a full load's.
          const doc = await fetch(from, { headers: { corten: "page" }, cache: "no-store" });
          return { from, status: doc.status, headers: [...doc.headers], body: await doc.text() };
        });
      const statusLine = /<p id="alert-status" role="status">(?:Saving\.\.\.|Saved\.)<\/p>/;
      /** The head's read-again tag the server draws (`ReadAgain`, one of the page's own head tags) while a write has not landed. */
      const readAgainTag = '<noscript data-corten-read-again="1" data-corten-head><meta http-equiv="refresh" content="1"></noscript>';
      /**
       * The receipt's page as the server draws it while the write has not landed, read whole, or
       * null for a page that is not the receipt's: the same document whether the store had the
       * write by the time of the read or not, as its status line and its head's read-again tag are
       * put in place of whatever the server drew for them.
       * @param {string} body
       */
      const asSaving = (body) => {
        if (!statusLine.test(body) || !body.includes("</title>")) return null;
        const untagged = body.replace(/<noscript data-corten-read-again[^>]*>[\s\S]*?<\/noscript>/g, "");
        return asWhole(untagged.replace(statusLine, '<p id="alert-status" role="status">Saving...</p>').replace("</title>", `</title>${readAgainTag}`));
      };
      /** The address without its fragment, which a request does not carry. @param {string} url */
      const bare = (url) => {
        const at = new URL(url);
        at.hash = "";
        return at.href;
      };
      /** The alerts page and its reads. @param {URL} url */
      const alerts = (url) => url.pathname === "/alerts";
      /**
       * Whether `request` is the runtime's read of a page (not a load, and not a prefetch), whatever
       * its address. @param {import("@playwright/test").Request} request
       */
      const isRead = (request) =>
        !request.isNavigationRequest() && request.method() === "GET" && ["nav", "page"].includes(request.headers()["corten"] ?? "") && request.headers()["purpose"] !== "prefetch";
      /** The document the page's load is given. @type {{ status: number, headers: Record<string, string>, body: string } | null} */
      let served = null;
      /** The receipt's address, and the one every read after the held one must be of. */
      let address = "";
      let expected = "";
      /** The page's reads of itself, from the start of the replayed document. @type {import("@playwright/test").Request[]} */
      const polls = [];
      let recording = false;
      /** The read held, once there is one, and whether it failed while the hold was still on. @type {import("@playwright/test").Request | null} */
      let heldRead = null;
      let shut = true;
      /** Set as the script's replaceState is about to run. */
      let mutating = false;
      /** When the held read failed while still held: before the replaceState or after it. @type {"" | "before" | "after"} */
      let failedShut = "";
      let release = () => {};
      const released = new Promise((resolve) => (release = () => resolve(undefined)));
      let holding = () => {};
      const isHeld = new Promise((resolve) => (holding = () => resolve(true)));
      let loaded = false;
      const slow = async (/** @type {import("@playwright/test").Route} */ route) => {
        const request = route.request();
        if (!loaded && served && request.isNavigationRequest() && bare(request.url()) === address) {
          loaded = true;
          return route.fulfill(served);
        }
        if (heldRead || !isRead(request)) return route.fallback();
        heldRead = request;
        holding();
        await released;
        await route.fallback().catch(() => {});
      };
      /** The status of each finished read of the address the next must read. @type {Promise<number>[]} */
      const answered = [];
      const onRequest = (/** @type {import("@playwright/test").Request} */ r) => void (recording && isRead(r) && polls.push(r));
      const onFailed = (/** @type {import("@playwright/test").Request} */ r) => void (r === heldRead && shut && !failedShut && (failedShut = mutating ? "after" : "before"));
      const onFinished = (/** @type {import("@playwright/test").Request} */ r) =>
        void (expected && isRead(r) && bare(r.url()) === expected && answered.push(r.response().then((res) => res?.status() ?? 0, () => 0)));
      /** Where the case stopped, if it did. */
      let stopped = "";
      let waiting = "";
      /** The case's outcome, read before its teardown. */
      let outcome = { status: "", at: "", later: /** @type {string[]} */ ([]), statuses: /** @type {number[]} */ ([]) };
      page.on("request", onRequest);
      page.on("requestfailed", onFailed);
      page.on("requestfinished", onFinished);
      try {
        // Armed inside the guard: the read the route holds is let go however the steps end.
        try {
          const got = await capture();
          const body = got?.status === 200 ? asSaving(got.body) : null;
          if (!got || !body) stopped = `the fixture drew no page for its write: ${got ? `${got.status}` : "no receipt"}`;
          else {
            address = bare(new URL(got.from, base).href);
            const next = new URL(address);
            next.searchParams.set("shown", "2");
            expected = next.href;
            served = { status: got.status, headers: Object.fromEntries(got.headers.filter(([header]) => !/^content-(encoding|length)$/i.test(header))), body };
            await page.goto("about:blank");
            recording = true;
            await page.route(alerts, slow);
            await page.goto(address);
            await page.evaluate(() => ((/** @type {any} */ (window)).__replayed = 7));
            waiting = (await saved()) ?? "";
            const held = await steps(5000, "no read held within 5 s").step(() => isHeld).catch(() => false);
            // The page's event for the read held may come a moment after its route.
            if (held) await pollFor(1000, async () => polls.length > 0);
            if (!held) stopped = "no read held within 5 s";
            else if (polls[0] !== heldRead || bare(/** @type {import("@playwright/test").Request} */ (heldRead).url()) !== address)
              stopped = `the document's first read was ${polls[0]?.url() ?? "none"}, not ${address}`;
            else if (failedShut) stopped = "the held read failed before the script replaced the address";
            else {
              // In one task: whether the runtime's navigation reading the page is still on its way (a
              // navigation that ended is no longer `navigation.transition`), then the replaceState,
              // and how that navigation ends. Its read is the one held: the document's first read, and
              // still held.
              mutating = true;
              const cancelled = await within(
                5000,
                "the navigation reading the page did not end within 5 s of the replaceState",
                page.evaluate(
                  () =>
                    new Promise((resolve) => {
                      const on = /** @type {any} */ (window).navigation?.transition;
                      if (!on) return resolve("no navigation reading the page was on its way at the replaceState");
                      on.finished.then(
                        () => resolve("the navigation reading the page finished after the replaceState"),
                        (/** @type {unknown} */ e) => resolve(e instanceof DOMException && e.name === "AbortError" ? "" : `the navigation reading the page failed with ${String(e)}`),
                      );
                      const to = new URL(location.href);
                      to.searchParams.set("shown", "2");
                      history.replaceState(history.state, "", to);
                    }),
                ),
              ).catch((/** @type {unknown} */ e) => (e instanceof Error ? e.message.split("\n")[0] : String(e)));
              if (cancelled) stopped = cancelled;
              // Its failure's event may come a moment after the navigation ends; "" is no answer yet.
              else if (!(await pollFor(5000, async () => failedShut || undefined))) stopped = "the held read did not fail while held within 5 s";
              else if (failedShut !== "after") stopped = "the held read failed before the script replaced the address";
            }
          }
        } finally {
          shut = false;
          release();
          await page.unroute(alerts, slow);
        }
        if (!stopped) {
          const drawn = await pollFor(6000, () =>
            page.evaluate(() => document.getElementById("alert-status")?.textContent === "Saved." && (/** @type {any} */ (window)).__replayed === 7),
          );
          if (!drawn) stopped = "Saved. not drawn in the same document within 6 s";
          // The answered read's event may come a moment after its page is drawn.
          else if (!(await pollFor(1000, async () => answered.length > 0))) stopped = "no read of the replaced address finished within 1 s";
          else
            outcome = {
              status: (await saved()) ?? "",
              at: page.url(),
              later: polls.slice(1).map((r) => r.url()),
              statuses: await steps(1000, "the reads' answers not read within 1 s").step(() => Promise.all(answered)).catch(() => []),
            };
        }
      } finally {
        page.off("request", onRequest);
        page.off("requestfailed", onFailed);
        page.off("requestfinished", onFinished);
      }
      check(
        name,
        !stopped &&
          waiting === "Saving..." &&
          outcome.status === "Saved." &&
          outcome.later.length > 0 &&
          outcome.later.every((url) => bare(url) === expected) &&
          outcome.statuses.some((code) => code >= 200 && code < 300) &&
          outcome.at === expected,
        `${stopped ? `${stopped}; ` : ""}${waiting || "(not loaded)"} -> ${outcome.status || "(not read)"} at ${outcome.at || "(not read)"}; reads after the held one ${outcome.later.join() || "none"}, wanted ${expected || "(none)"}; answered ${outcome.statuses.join() || "none"}`,
      );
    } else {
      skip("a read a script's replaceState cancels on its way is made again", noSwaps);
    }
    if (swaps) {
      await page.evaluate(() => (/** @type {any} */ (window)).__marker = 6);
      const entries = await page.evaluate(() => history.length);
      // `Saving...` as the navigation drew it, recorded by the page (`go`), not looked at once it
      // returns, by when the page may have read itself again and say `Saved.`; `Saved.` once the
      // page has read itself again, in the same document.
      const target = await pending();
      const address = new URL(target).pathname + new URL(target).search;
      const readFrom = wholeReads.length;
      const nav = await go(target);
      await savedSoon();
      const status = await saved();
      const kept = await page.evaluate((token) => (/** @type {any} */ (window)).__marker === 6 && (/** @type {any} */ (window)).__smokeGo?.token === token, nav.token);
      check(
        "a page reached by the runtime's navigation reads itself again in place",
        nav.saving && nav.sameDocument && status === "Saved." && kept && !wholeFaults.has(address),
        `${wentTo(nav)} (answered with ${wholeSeeded.get(address) ?? "nothing seen"}) -> ${status}${kept ? "" : ", the document not kept"}`,
      );
      // The page's reads of its own address after the navigation's fetch: with none, the history
      // length shows only that the navigation added its entry, not what a read does to it. The
      // navigation's answer says `Saving...`, so `Saved.` on the page is a read's answer drawn.
      const since = wholeReads.slice(readFrom);
      const navAt = since.findIndex((r) => r.navigation && r.address === address);
      const polls = navAt < 0 ? 0 : since.slice(navAt + 1).filter((r) => r.address === address).length;
      const length = await page.evaluate(() => history.length);
      check(
        "each read replaces the history entry",
        polls > 0 && status === "Saved." && length === entries + 1,
        `${entries} -> ${length} after ${navAt < 0 ? "no navigation fetch seen and " : ""}${polls} reads of ${address} after the navigation's, the page saying ${status}`,
      );
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
