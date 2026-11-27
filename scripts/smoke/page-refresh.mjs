import { base, shadowing, skip, check, within, readWithin, actWithin, cameWithin, leftOf, lookUntil, pause, steps, pollAsync, cleanUp, exchange, letThrough } from "./helpers.mjs";

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

/**
 * The read-again tags in each of `answers`, the answer to a runtime read of a page (a whole page,
 * `corten: page`, when `whole`; else a navigation's, `corten: nav`), found where a browser reads
 * them: `page` parses each as the runtime does, a whole page with DOMParser (`swapDocument` in
 * corten.js) and a navigation's answer as a template's `innerHTML` (`parse`), so a tag in a comment
 * or in the text of a raw-text element (a `<script>`, `<style>`, `<textarea>` or `<title>`) is
 * none. The head's tags are the `<noscript data-corten-read-again data-corten-head>` the runtime puts
 * in the head: in a whole page, those in its `<head>`; in a navigation's answer, which has none, its
 * top-level ones, where the server writes its head tags before the page. Each has its wait and the
 * `content` of each `<meta http-equiv="refresh">` in it as a browser without JavaScript reads them,
 * parsed with scripting off (a `<noscript>` the runtime's template parses as text is parsed again
 * so, as a `<noscript>` in a head). These are read first, as the parse gives them; then what the
 * runtime takes out before it draws `<main>` is taken out, in its order: every `<noscript>` is
 * emptied (`parse`, `swapDocument`); a whole page is cut to what a navigation's answer holds, its
 * title, head tags and section stylesheets, the layout elements that are the page's
 * (`data-corten-page`, but for one inside another) and `<main>`'s children (`swapDocument` with its
 * layout not drawn, where those elements are not `<main>`'s); the top-level elements that are the
 * page's are taken out (in a navigation's answer only when its text holds ` data-corten-page`, as
 * `swapPage` checks), then its first `<title>`, then every element marked `data-corten-head`, at any
 * depth, which goes to the document's head. With `part`, the part's tags are the
 * `<template data-corten-read-again data-from>` reading again from `part` in what is left, which the
 * runtime puts in `<main>` and reads there (`readPartsAgain`): one in a `<noscript>` or in an element
 * marked `data-corten-head` is none. Each wait is the attribute's value as the parse gives it, or null.
 * Bounded to 5 s (`readWithin`).
 * @param {import("@playwright/test").Page} page @param {string[]} answers @param {string | undefined} part @param {boolean} whole
 * @returns {Promise<{ head: { wait: string | null, refresh: (string | null)[] }[], parts: { wait: string | null }[] }[]>}
 */
function readAgainTagsIn(page, answers, part, whole) {
  return readWithin(
    "an answer's read-again tags",
    page.evaluate(
      ({ answers, part, whole }) => {
        const w = /** @type {any} */ (window);
        const PART = "template[data-corten-read-again][data-from]";
        // Whether a template's `innerHTML` here parses a <noscript>'s content as elements (scripting
        // off) or as its text (scripting on), as the runtime's `parse` does.
        const probe = document.createElement("template");
        probe.innerHTML = w.__html("<noscript><i></i></noscript>");
        const fragmentElements = !!probe.content.querySelector("noscript i");
        /** @param {Element} noscript @param {boolean} elements whether its content was parsed as elements */
        const refreshes = (noscript, elements) => {
          const host = elements
            ? noscript
            : new DOMParser().parseFromString(w.__html(`<!doctype html><html><head><noscript>${noscript.textContent ?? ""}</noscript></head></html>`), "text/html").head.querySelector("noscript");
          return Array.from(host?.querySelectorAll("meta") ?? [])
            .filter((m) => m.getAttribute("http-equiv")?.toLowerCase() === "refresh")
            .map((m) => m.getAttribute("content"));
        };
        return answers.map((answer) => {
          /** @type {Element[]} */ let heads;
          /** @type {DocumentFragment | null} */ let content = null;
          /** What the runtime has emptied or cut once it has parsed the answer. @type {() => void} */ let cut;
          let elements = true;
          if (whole) {
            const doc = new DOMParser().parseFromString(w.__html(answer), "text/html");
            heads = Array.from(doc.head.querySelectorAll("noscript[data-corten-read-again][data-corten-head]"));
            cut = () => {
              // `swapDocument`: every <noscript> emptied, then what a navigation's answer holds, with
              // the layout not drawn (the elements that are the page's are not <main>'s then).
              for (const noscript of Array.from(doc.querySelectorAll("noscript"))) noscript.replaceChildren();
              const main = doc.querySelector("main");
              if (!main) return;
              const head = [doc.querySelector("title"), ...Array.from(doc.head.querySelectorAll("[data-corten-head], link[data-corten-style]"))].filter(
                (el) => el !== null,
              );
              const marked = Array.from(doc.body.querySelectorAll("[data-corten-page]")).filter(
                (el) => !el.parentElement || !el.parentElement.closest("[data-corten-page]"),
              );
              content = doc.createDocumentFragment();
              content.append(...head, ...marked, ...Array.from(main.childNodes));
            };
          } else {
            const template = document.createElement("template");
            template.innerHTML = w.__html(answer);
            heads = Array.from(template.content.children).filter(
              (el) => el.localName === "noscript" && el.hasAttribute("data-corten-read-again") && el.hasAttribute("data-corten-head"),
            );
            elements = fragmentElements;
            cut = () => {
              // `parse`: every <noscript> emptied.
              for (const noscript of Array.from(template.content.querySelectorAll("noscript"))) noscript.replaceChildren();
              content = template.content;
            };
          }
          // The head's tags as the parse gives them, read before the runtime empties them.
          const head = heads.map((el) => ({ wait: el.getAttribute("data-corten-read-again"), refresh: refreshes(el, elements) }));
          cut();
          /** @type {Element[]} */ let parts = [];
          const left = /** @type {DocumentFragment | null} */ (content);
          if (left) {
            // `swapPage`, in its order: the top-level elements that are the page's, the title, then
            // every head tag at any depth, each out of what goes in <main>.
            if (whole || answer.includes(" data-corten-page")) {
              for (const el of Array.from(left.children)) if (el.hasAttribute("data-corten-page")) el.remove();
            }
            left.querySelector("title")?.remove();
            for (const el of Array.from(left.querySelectorAll("[data-corten-head]"))) el.remove();
            parts = Array.from(left.querySelectorAll(PART));
          }
          return {
            head,
            parts: part === undefined ? [] : parts.filter((el) => el.getAttribute("data-from") === part).map((el) => ({ wait: el.getAttribute("data-corten-read-again") })),
          };
        });
      },
      { answers, part, whole },
    ),
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
        // A full load ends the wait too: its document has no record of this navigation. The wait only
        // ends the look (the page's clock decides), bounded to 15 s as the rest of the plumbing is.
        await within(
          15000,
          "the wait for the navigation's draw was not answered within 15 s",
          page.waitForFunction(
            (token) => {
              const note = (/** @type {any} */ (window)).__smokeGo;
              return note?.token !== token || note.saving === true;
            },
            token,
            { timeout: 5000 },
          ),
        ).catch(() => {});
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
    /**
     * The head's read-again tag of a page as the server writes it (`ReadAgain` in the head), and a
     * part's below: the stand-in takes them out of an answer saying `Saved.` before it puts in its
     * own. The server's tags in an answer saying `Saving...` are found where a browser reads them
     * (`readAgainTags`), never by these.
     */
    const headTag = /<noscript data-corten-read-again="\d+"[^>]*>[\s\S]*?<\/noscript>/g;
    const partTag = /<template data-corten-read-again="\d+"[^>]*><\/template>/g;
    /**
     * The read-again tags in `body`, where a browser reads them (`readAgainTagsIn`): the head's, and
     * with `part` the part's reading again from `part`; `whole` when `body` answers a whole read
     * (`corten: page`) rather than a navigation's (`corten: nav`).
     * @param {string} body @param {string | undefined} part @param {boolean} whole
     */
    const readAgainTags = async (body, part, whole) => (await readAgainTagsIn(page, [body], part, whole))[0];
    /** Each wait of tags `readAgainTags` found, in its order. @param {Awaited<ReturnType<typeof readAgainTags>>} tags */
    const waitsOf = (tags) => [...tags.head.flatMap((t) => [t.wait, ...t.refresh]), ...tags.parts.map((t) => t.wait)];
    /** What tags `readAgainTags` found are, but for their waits. @param {Awaited<ReturnType<typeof readAgainTags>>} tags */
    const shapeOf = (tags) => JSON.stringify([tags.head.map((t) => t.refresh.length), tags.parts.length]);
    /**
     * What is wrong with the read-again tags in `body`, the server's own answer saying `Saving...`,
     * against those the server writes while a write lands (`readAgainTags`): its head's tag, with an
     * actual refresh in it, and with `part` its part's tag reading again from `part` (the page's
     * address), each there and waiting `AGAIN_SECONDS` (the alerts page's own wait). Null when
     * nothing is. @param {string} body @param {string | undefined} part @param {boolean} whole
     */
    const tagFaults = async (body, part, whole) => {
      const { head, parts } = await readAgainTags(body, part, whole);
      const faults = [];
      /** @param {string} what @param {(string | null)[]} waits */
      const judge = (what, waits) => {
        const wrong = waits.map((w) => w ?? "none").filter((v) => !/^\d+$/.test(v) || Number(v) !== AGAIN_SECONDS);
        if (wrong.length) faults.push(`with ${what} waiting ${wrong.join(", ")} s, not ${AGAIN_SECONDS}`);
      };
      if (!head.length) faults.push("without its head's read-again tag");
      else if (head.some((t) => !t.refresh.length)) faults.push("with its head's read-again tag holding no refresh");
      judge("its head's read-again tag", head.flatMap((t) => [t.wait, ...t.refresh]));
      if (part !== undefined) {
        if (!parts.length) faults.push(`without its part's read-again tag from ${part}`);
        judge(`its part's read-again tag from ${part}`, parts.map((t) => t.wait));
      }
      return faults.length ? faults.join(" and ") : null;
    };
    /**
     * `body` with the waits `readAgainTags` finds (with `part`) set to `seconds` and every other byte
     * as it was (`answer`), or why that cannot be done (`refused`). Each wait found is traced to the
     * place in `body` it is written: `body` is parsed again with each quoted `data-corten-read-again`
     * and `content` value written in it replaced by a mark of its own, and that parse must find the
     * same tags, each wait one mark, a different one each, whose place holds that wait as written.
     * Only those places are set, and a parse of the result must find the same tags, each waiting
     * `seconds`. @param {string} body @param {string} part @param {number} seconds @param {boolean} whole
     * @returns {Promise<{ answer: string } | { refused: string }>}
     */
    const setWaits = async (body, part, seconds, whole) => {
      if (body.includes("smoke-wait-")) return { refused: "it already holds the text the marks are made of" };
      const places = [...body.matchAll(/([\s/](?:data-corten-read-again|content)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi)].map((m, i) => {
        const value = m[2] ?? m[3] ?? "";
        const start = /** @type {number} */ (m.index) + m[1].length + 1;
        return { start, end: start + value.length, value, mark: `smoke-wait-${i}` };
      });
      const marked = places.reduceRight((out, p) => `${out.slice(0, p.start)}${p.mark}${out.slice(p.end)}`, body);
      const [found, traced] = await readAgainTagsIn(page, [body, marked], part, whole);
      if (shapeOf(found) !== shapeOf(traced)) return { refused: "its read-again tags are not the same once their waits are marked" };
      const want = waitsOf(found);
      /** @type {Set<(typeof places)[number]>} */
      const chosen = new Set();
      for (const [i, mark] of waitsOf(traced).entries()) {
        const place = places.find((p) => p.mark === mark);
        if (!place || chosen.has(place) || place.value !== want[i]) return { refused: `its wait ${JSON.stringify(want[i])} is not written in one place of its own` };
        chosen.add(place);
      }
      const answer = [...chosen].sort((a, b) => b.start - a.start).reduce((out, p) => `${out.slice(0, p.start)}${seconds}${out.slice(p.end)}`, body);
      const [set] = await readAgainTagsIn(page, [answer], part, whole);
      if (shapeOf(set) !== shapeOf(found) || waitsOf(set).some((w) => w !== String(seconds))) return { refused: `its read-again tags, once set, do not each wait ${seconds} s` };
      return { answer };
    };
    /**
     * Leaves by the header's link to News, the press and the wait for News's title each bounded to
     * 30 s (Playwright's own timeout for an action) by the smoke's clock, so a driver that never
     * answers ends the run with its reason rather than keeping a case from its cleanup.
     */
    const leaveForNews = async () => {
      await within(30_000, "the link to News was not pressed within 30 s", page.click('header a[href="/news"]'));
      await within(30_000, "the News page was not drawn within 30 s", page.waitForFunction(() => document.title === "News | Watchlist"));
    };
    /**
     * Whether the status line said `Saved.` within 6 s of `from` (a `performance.now()` time taken
     * just before the load, press or script that leads to it; the call by default), by the smoke's
     * clock (`cameWithin`, `leftOf`): a wait answered after them, or never, is false, and each check
     * that waits for it requires it. What the page says is read after it too.
     * @param {number} [from]
     */
    const savedSoon = (from = performance.now()) =>
      cameWithin(leftOf(from, 6000), page.waitForFunction(() => document.getElementById("alert-status")?.textContent === "Saved.", null, { timeout: 6000 }));
    /**
     * What `probe`, run in the page, returns once that is truthy, if the wait sees it within `ms` of
     * `from` (a `performance.now()` time taken just before the load or press that leads to it; the
     * call by default) by the smoke's own monotonic clock (`within`), else null. The driver's own
     * timeout counts from when it receives the command, which a delayed dispatch moves later, so it
     * only ends the wait: a value that comes back past the smoke's `ms` is no value. The value is the
     * one the wait observed, read from its handle afterwards (bounded plumbing), not a later look at
     * the page.
     * @template A @param {number} ms @param {string} what @param {(arg: A) => unknown} probe @param {A} arg @param {number} [from]
     * @returns {Promise<unknown>}
     */
    const seenWithin = async (ms, what, probe, arg, from = performance.now()) => {
      const until = from + ms;
      const waiting = page.waitForFunction(probe, arg, { timeout: ms });
      const handle = await within(Math.max(0, until - performance.now()), `${what} was not seen within ${ms} ms`, waiting).catch(() => {
        // A handle the wait brings after the smoke's `ms` is let go unread.
        waiting.then((late) => late.dispose(), () => {}).catch(() => {});
        return null;
      });
      if (handle === null) return null;
      try {
        return await readWithin(`what the wait saw (${what})`, handle.jsonValue());
      } finally {
        handle.dispose().catch(() => {});
      }
    };
    /** @type {string[]} */
    const reads = [];
    /**
     * Every request the page sends while the whole-read cases below listen, in the order the check
     * heard them: a check that requires no read of the alerts page from some request on counts the
     * ones after that request's own place here (`readsAfter`), not from when it looked.
     * @type {import("@playwright/test").Request[]}
     */
    const pageLog = [];
    const onSaved = (/** @type {import("@playwright/test").Request} */ r) => {
      pageLog.push(r);
      if (r.url().includes("/alerts")) reads.push(r.url());
    };
    /**
     * The reads of the alerts page (a GET of `/alerts`, whatever its query or kind) logged after
     * `request` in `pageLog`, each named, the hover prefetches apart (named, not counted); null when
     * `request` is not in the log. @param {import("@playwright/test").Request | undefined} request
     */
    const readsAfter = (request) => {
      const at = request === undefined ? -1 : pageLog.indexOf(request);
      if (at < 0) return null;
      const after = pageLog.slice(at + 1).filter((r) => r.method() === "GET" && new URL(r.url()).pathname === "/alerts");
      const name = (/** @type {import("@playwright/test").Request} */ r) => `${r.isNavigationRequest() ? "load" : `corten: ${r.headers()["corten"] ?? "-"}`} ${new URL(r.url()).pathname}${new URL(r.url()).search}`;
      return { reads: after.filter((r) => !isPrefetch(r)).map(name), prefetches: after.filter(isPrefetch).map(name) };
    };

    // The alerts page asks for its status line and list to be read again (ReadAgain::from in the
    // page): with JavaScript only they are read, from their route as a patch, however the page was
    // reached, and the form beside them stays as the user has it. Its head's ReadAgain is for a
    // browser without JavaScript.
    {
      // One log of the page's reads of the alerts page, started before the page is loaded, in the
      // order the page sent them: every GET of `/alerts`, whatever its query, with when it was sent
      // (the smoke's monotonic clock, `performance.now()`) and its kind: a part read (`corten: action`), a hover prefetch (`purpose:
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
        log.push({ request: r, time: performance.now(), kind });
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
      const named = (e, time) => `${e.kind} ${address(e)} (+${Math.round(e.time - time)} ms)`;
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
      /**
       * Why an exchange of the route below did not answer its request as the stand-in meant (its
       * fetch, its answer's body or its fulfill failing or not settling within 5 s each, or the case
       * ending first, `exchange`): each fails the checks that rest on the stand-in's answers.
       * @type {string[]}
       */
      const partFaults = [];
      const pendingDocument = async (/** @type {import("@playwright/test").Route} */ route) => {
        documentAnswered = true;
        const ex = exchange(route, "the stand-in's answer to the case's document", () => over);
        try {
          const res = await ex.step(5000, "its fetch", () => route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } }));
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const body = await ex.step(5000, "reading its answer", () => res.text());
          documentStandIn = res.ok() && body.includes(savedLine) && !body.includes("data-corten-read-again");
          const answer = documentStandIn
            ? body
                .replace(savedLine, savingLine)
                .replace("</title>", '</title><noscript data-corten-read-again="1" data-corten-head><meta http-equiv="refresh" content="1"></noscript>')
                .replace("</main>", `<template data-corten-read-again="1" data-from="${from}"></template></main>`)
            : body;
          await ex.send(5000, "its fulfill", () => route.fulfill({ status: res.status(), headers, body: answer }));
        } catch {}
        if (ex.fault) partFaults.push(ex.fault);
      };
      const partRead = async (/** @type {import("@playwright/test").Route} */ route) => {
        const request = route.request();
        if (!over && !documentAnswered && request.method() === "GET" && request.isNavigationRequest()) return pendingDocument(route);
        if (over || request.method() !== "GET" || request.headers()["corten"] !== "action") return letThrough(route);
        const at = answers.length;
        const asked = new URL(request.url());
        const address = asked.pathname + asked.search;
        answers.push({ url: address, asks: false, standIn: false });
        answered.push(request);
        if (at === 0) {
          firstWasHeld = !baselined;
          await firstHeld;
          if (over) return letThrough(route);
        }
        // Each step of the answer within 5 s, counted once the hold above is let go, and none sent
        // once the case is over (`exchange`).
        const ex = exchange(route, `the stand-in's answer to part read ${at + 1}`, () => over);
        try {
          // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
          const res = await ex.step(5000, "its fetch", () => route.fetch({ headers: { ...request.headers(), "accept-encoding": "identity" } }));
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const body = await ex.step(5000, "reading its answer", () => res.text());
          const saving = body.replace('<p id="alert-status" role="status">Saved.</p>', '<p id="alert-status" role="status">Saving...</p>');
          const standIn = at === 0 && res.ok() && saving !== body && !body.includes("data-corten-read-again");
          const answer = standIn ? `${saving}<template data-corten-read-again="1" data-from="${from}"></template>` : body;
          const marked = answer.replace('<p id="alert-status"', `<p data-smoke-read="${at}" id="alert-status"`);
          answers[at] = { url: address, asks: answer.includes("data-corten-read-again"), standIn };
          await ex.send(5000, "its fulfill", () => route.fulfill({ status: res.status(), headers, body: marked }));
        } catch {}
        if (ex.fault) partFaults.push(ex.fault);
      };
      // The runtime's navigations below reach a page still saving (#2035). The write lands 1.5 s
      // after it is sent, and a loaded browser's navigation can reach the server after that, when
      // the right answer is `Saved.` with no part to read, so a case waiting for `Saving...` would
      // fail on timing alone. So each one's fetch of the page is answered by the server's own answer,
      // and only when that says `Saved.` does the stand-in answer as the server does while the write
      // lands: its status line saying `Saving...`, its head's tag asking to be read again, and its
      // part's tag asking again from the page's own address after the seconds `seeds` gives it. An
      // answer of the server's that says `Saving...` is passed on as the server wrote it but for the
      // navigation's mark on its status line (`markNav`), and its own read-again tags must be there
      // and wait `AGAIN_SECONDS` (`tagFaults`): one whose tags are missing or wait otherwise is passed
      // on so and fails the case (`seedFaults`), since the stand-in never supplies or repairs the
      // server's tags or waits. The one exception is the leave-before-read case, whose `seeds` wait
      // is longer: the server's waits are set to it (`setWaits`), once they were found to be
      // `AGAIN_SECONDS`, and only where each is traced to one place in the answer: an answer whose
      // waits cannot be traced so is passed on as written and fails the case. Only the navigation's fetch is answered so: every part read after it is the
      // server's, or a case's own route's.
      /** The pages whose navigation is answered so, by address (path and query), each with its part's wait in seconds. @type {Map<string, number>} */
      const seeds = new Map();
      /** What each of those navigations was answered with, by address, for a check's detail. @type {Map<string, string>} */
      const seeded = new Map();
      /** Why a navigation's answer failed its case, by address: the server's `Saving...` whose read-again tags are missing or wait other than `AGAIN_SECONDS`. @type {Map<string, string>} */
      const seedFaults = new Map();
      const seedReads = (/** @type {URL} */ u) => seeds.has(u.pathname + u.search);
      /** Set as the cases below end: the route lets each request through, and an answer under way is not sent. */
      let seedOver = false;
      const seedNavigation = async (/** @type {import("@playwright/test").Route} */ route) => {
        const request = route.request();
        const asked = new URL(request.url());
        const address = asked.pathname + asked.search;
        const seconds = seeds.get(address);
        const mode = request.headers()["corten"];
        // The runtime's navigation alone (`corten: nav`, or `page` for a whole read; a prefetch
        // aside), once a page: the first such request takes the seed and the navigation's token.
        if (seedOver || seconds === undefined || seeded.has(address) || request.method() !== "GET" || (mode !== "nav" && mode !== "page") || isPrefetch(request)) return letThrough(route);
        seeded.set(address, "its fetch did not settle");
        const token = claimNav(address);
        // Each step within 5 s (`exchange`), and no answer sent once the cases are over: one that
        // fails or runs out aborts the navigation's fetch and fails its case (`seedFaults`).
        const ex = exchange(route, `the stand-in's answer to the navigation's fetch of ${address}`, () => seedOver);
        /** Sends `body` as the answer, within 5 s. @param {number} status @param {Record<string, string>} headers @param {string} body */
        const answer = (status, headers, body) => ex.send(5000, "its fulfill", () => route.fulfill({ status, headers, body }));
        try {
          // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
          const res = await ex.step(5000, "its fetch", () => route.fetch({ headers: { ...request.headers(), "accept-encoding": "identity" } }));
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          const body = await ex.step(5000, "reading its answer", () => res.text());
          const shows = body.includes(savedLine) ? "Saved." : body.includes(savingLine) ? "Saving..." : null;
          if (!res.ok() || shows === null) {
            seeded.set(address, `the server's own answer (status ${res.status()}${shows === null ? ", no status line" : ""})`);
            await answer(res.status(), headers, markNav(token, body));
            return;
          }
          if (shows === "Saving...") {
            const wrong = await ex.step(5000, "reading its read-again tags", () => tagFaults(body, address, mode === "page"));
            if (wrong !== null) {
              const fault = `the server's own answer saying Saving... ${wrong}, passed on as the server wrote it`;
              seeded.set(address, fault);
              seedFaults.set(address, fault);
              await answer(res.status(), headers, markNav(token, body));
              return;
            }
            if (seconds === AGAIN_SECONDS) {
              seeded.set(address, "the server's own answer saying Saving..., with its read-again tags as the server wrote them");
              await answer(res.status(), headers, markNav(token, body));
              return;
            }
            // The leave-before-read case's longer wait, set only where `tagFaults` found it: the
            // head's tag, its refresh's content and the part's tag, each waiting `AGAIN_SECONDS`.
            const set = await ex.step(10_000, "setting its waits", () => setWaits(body, address, seconds, mode === "page"));
            if ("refused" in set) {
              const fault = `the server's own answer saying Saving..., with its read-again tags waiting ${AGAIN_SECONDS} s that could not be set to ${seconds} s (${set.refused}), passed on as the server wrote it`;
              seeded.set(address, fault);
              seedFaults.set(address, fault);
              await answer(res.status(), headers, markNav(token, body));
              return;
            }
            seeded.set(address, `the server's own answer saying Saving..., with its read-again tags waiting ${AGAIN_SECONDS} s, set to ${seconds} s`);
            await answer(res.status(), headers, markNav(token, set.answer));
            return;
          }
          // The write has landed: the stand-in answers as the server does while it lands.
          const tags = new RegExp(`${headTag.source}|${partTag.source}`, "g");
          const head = `<noscript data-corten-read-again="${seconds}" data-corten-head><meta http-equiv="refresh" content="${seconds}"></noscript>`;
          const tag = `<template data-corten-read-again="${seconds}" data-from="${address}"></template>`;
          const bare = body.replace(tags, "").replace(savedLine, savingLine);
          const headed = bare.includes("</title>") ? bare.replace("</title>", `</title>${head}`) : `${head}${bare}`;
          const standIn = headed.includes("</main>") ? headed.replace("</main>", `${tag}</main>`) : `${headed}${tag}`;
          seeded.set(address, "the stand-in, the server's saying Saved.");
          await answer(res.status(), headers, markNav(token, standIn));
        } catch {}
        if (ex.fault) {
          seeded.set(address, `failed: ${ex.fault}`);
          seedFaults.set(address, ex.fault);
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
              if (w.__firstSaved === undefined && status.textContent === "Saved.") w.__firstSaved = read;
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
          initial = (await actWithin("the pending write's page load", page.goto(url)))?.request() ?? null;
          const waiting = await readWithin("the status line once the page loaded", saved());
          await actWithin("the form's fill", page.fill("input[name=above]", "123.45"));
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
          const came = await savedSoon();
          // The first answer the page drew `Saved.` from, noted as it drew it: before the wait above
          // saw `Saved.`, so within its 6 s when the wait came in time.
          const first = came
            ? await readWithin("the page's note of what it drew Saved. from", page.evaluate(() => /** @type {string | undefined} */ ((/** @type {any} */ (window)).__firstSaved))).catch(() => undefined)
            : undefined;
          const status = await readWithin("the status line after the wait for Saved.", saved());
          check(
            "a page's part waiting for a write is read again after a full load, not the page",
            waiting === "Saving..." && came && status === "Saved." && initial !== null && parts().length > 0 && whole().length === 0 && page.url() === url && partFaults.length === 0,
            `${partFaults.length ? `${partFaults.join("; ")}; ` : ""}${waiting} -> ${status}${came ? "" : " (Saved. not seen within 6 s)"} after ${parts().length} part and ${whole().length} page reads${whole().length ? ` (${whole().map((e) => address(e)).join(", ")})` : ""}${prefetches().length ? `, and ${prefetches().length} prefetches not counted (${prefetches().map((e) => address(e)).join(", ")})` : ""}${initial ? "" : " (the document loaded not seen)"}${documentStandIn ? " (the document found the write landed, and was answered as while it lands)" : ""}${firstWasHeld ? " (its first part read held until the baseline was read)" : ""}`,
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
            answers.some((a) => a.asks) && tags.length === 1 && tags[0] === lastPart && tagged.pageTag && tagged.pageTagGone && movedRead === movedFrom && partFaults.length === 0,
            `${JSON.stringify({ ...tagged, movedRead, movedFrom, answers, partFaults })} after ${lastPart}`,
          );
          // Quiet only once an answer that does not ask again has drawn `Saved.`, within the 6 s of the
          // wait for it above: reads that stopped after an answer that asked again are not a part that
          // stopped. The answer is the first to draw `Saved.`, noted as it was drawn, not the one drawn
          // when the check looks (a later read that draws `Saved.` again would hide the read before
          // it). No read of the page may come after that answer's own read in the log, whatever its
          // address. The check looks once 2.2 s have passed by the smoke's monotonic clock since it
          // read the note, so at least 2.2 s since the draw, and counts every read in the log by then:
          // a read sent between the draw and the check seeing it counts against it, as does one sent
          // after the 2.2 s that is in the log when the check looks. A hover prefetch is no read
          // again, and is named but not counted.
          const drawn = first ?? null;
          const last = drawn === null ? null : (answers[Number(drawn)] ?? null);
          const quiet = !!last && !last.asks;
          if (quiet) await pause(2200);
          const terminal = quiet ? log.findIndex((e) => e.request === answered[Number(drawn)]) : -1;
          const afterTerminal = terminal < 0 ? [] : log.slice(terminal + 1);
          const later = afterTerminal.filter((e) => e.kind !== "prefetch").map((e) => named(e, log[terminal].time));
          const prefetched = afterTerminal.filter((e) => e.kind === "prefetch").map((e) => named(e, log[terminal].time));
          check(
            "a page's part stops once its patch no longer asks",
            quiet && terminal >= 0 && later.length === 0 && partFaults.length === 0,
            (partFaults.length ? `${partFaults.join("; ")}; ` : "") +
              (quiet
              ? terminal < 0
                ? `the read whose answer first drew Saved. (${drawn}) is not in the page's reads`
                : `${later.length} reads after the read whose answer first drew Saved. (${drawn}), by the check's look at least 2.2 s after that draw: ${later.join(", ") || "none"}${prefetched.length ? `; prefetches not counted: ${prefetched.join(", ")}` : ""}`
              : `no answer that does not ask again was the first to draw Saved., within 6 s (${JSON.stringify({ first: first ?? null, answers })})`),
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
           * whose read-again tags are missing or wait other than `AGAIN_SECONDS` fails it (`seedFaults`).
           * @param {string} to @param {number} [seconds]
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
          /** Why an answer of the route below was not given as meant (`exchange`). @type {string[]} */
          const reachFaults = [];
          /** Set once the check is over: the route lets each read through, whether or not its removal is confirmed. */
          let reachOver = false;
          const reachReads = (/** @type {URL} */ u) => u.pathname + u.search === reachedAt;
          const reachPart = async (/** @type {import("@playwright/test").Route} */ route) => {
            const request = route.request();
            if (reachOver || request.method() !== "GET" || request.headers()["corten"] !== "action") return letThrough(route);
            const at = reachAnswers.length;
            reachAnswers.push(false);
            // Each step within 5 s, and no answer sent once the check is over (`exchange`): one that
            // fails or runs out aborts the read and fails the check (`reachFaults`).
            const ex = exchange(route, `the reached page's part route's answer to its read ${at + 1}`, () => reachOver);
            try {
              // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
              const res = await ex.step(5000, "its fetch", () => route.fetch({ headers: { ...request.headers(), "accept-encoding": "identity" } }));
              const headers = res.headers();
              delete headers["content-encoding"];
              delete headers["content-length"];
              const body = await ex.step(5000, "reading its answer", () => res.text());
              reachAnswers[at] = res.ok() && body.includes(savedLine);
              await ex.send(5000, "its fulfill", () => route.fulfill({ status: res.status(), headers, body: body.replace('<p id="alert-status"', `<p data-smoke-reach="${at}" id="alert-status"`) }));
            } catch {}
            if (ex.fault) {
              reachAnswers[at] = false;
              reachFaults.push(ex.fault);
            }
          };
          try {
            await within(5000, "the reached page's part route was not set within 5 s", page.route(reachReads, reachPart));
            const nav = await goTo(reachedUrl);
            // `Saved.` drawn by an answer to the reached page's own part read, seen within 6 s of the
            // start of the wait by the smoke's clock (`seenWithin`): the part read whose answer drew
            // it is the one the wait saw marked, not one a later look at the page finds. The wait
            // starts once `go` has confirmed the navigation's draw, not before it: `go` keeps its
            // driver plumbing off the page's clock, and so does this.
            const seenRead = await seenWithin(
              6000,
              "Saved. drawn by an answer to the reached page's own part read",
              () => {
                const status = document.getElementById("alert-status");
                return status?.textContent === "Saved." && status.getAttribute("data-smoke-reach");
              },
              null,
            );
            const inTime = typeof seenRead === "string";
            const reached = inTime
              ? { text: "Saved.", read: seenRead }
              : {
                  text: await readWithin(
                    "the status line after the navigation's wait for Saved.",
                    page.evaluate(() => document.getElementById("alert-status")?.textContent ?? null),
                  ),
                  read: null,
                };
            // The same document throughout: the record `go` put on its window is still there, which a
            // full load (a document read, then its part) would have lost.
            const kept = await readWithin(
              "whether the navigation kept the document",
              page.evaluate((token) => (/** @type {any} */ (window)).__smokeGo?.token === token, nav.token),
            );
            const own = parts().slice(from).filter((e) => address(e) === reachedAt);
            const others = parts().slice(from).filter((e) => address(e) !== reachedAt);
            const drewOwn = inTime && reached.text === "Saved." && reached.read !== null && reachAnswers[Number(reached.read)] === true;
            check(
              "a page's part reached by the runtime's navigation is read again, not the page",
              nav.saving && nav.sameDocument && kept && drewOwn && own.length > 0 && whole().length - wholeFrom === 1 && reachFaults.length === 0,
              `${reachFaults.length ? `${reachFaults.join("; ")}; ` : ""}${wentTo(nav)}, then ${reached.text}${reached.read === null ? " (not drawn by an answer to the reached page's own part read within 6 s)" : ` drawn by its part read ${Number(reached.read) + 1}`} after ${own.length} part reads of ${reachedAt}${others.length ? ` and ${others.length} of other addresses (${others.map((e) => address(e)).join(", ")})` : ""}, ${whole().length - wholeFrom} page loads (the navigation's, answered with ${seeded.get(reachedAt) ?? "nothing seen"})${kept ? "" : ", in another document"}`,
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
            if (gone || request.method() !== "GET" || request.headers()["corten"] !== "action") return letThrough(route);
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
            const owes = await pollAsync(5000, async () => owed.length > 0 && { held: owed.length, status: await page.textContent("#alert-status") });
            const left = parts().length;
            await leaveForNews();
            gone = true;
            const released = await letGo();
            const delivered = released.filter((r) => r === null).length;
            const failed = released.flatMap((r, i) => (r === null ? [] : [`held read ${i + 1}: ${r}`]));
            await pause(quietFor);
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
                // Bounded as `leaveForNews` is (30 s each): whether the attempt left in time is the
                // page's own note above, so a slow draw of News only spends time, not the check.
                await within(
                  30_000,
                  "the page's link to the news page was not pressed within 30 s",
                  page.evaluate(() => /** @type {HTMLAnchorElement} */ (document.querySelector('header a[href="/news"]')).click()),
                );
                await within(30_000, "the news page was not drawn within 30 s of the press", page.waitForFunction(() => document.title === "News | Watchlist", null, { timeout: 30_000 }));
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
                past = await pollAsync(pastBy + 5000, () => page.evaluate(() => /** @type {number | null} */ ((/** @type {any} */ (window)).__smokeLeave.past) ?? false));
                await pollAsync(1500, async () => sentTo(leave).length > 0);
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
          () => (seedOver = true),
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
     * whole read; a prefetch aside), and each load of the fragment case's receipt after its first
     * (`placeLoads`, the page reading itself again in a browser without the Navigation API), by
     * address (path and query), in the order it reached the route, with whether it was `go`'s
     * navigation's own fetch, so a check can count the reads after it, whether it was a load, and
     * whether its answer said `Saved.` (null until it is in), and the number the replaced-address
     * case's notes gave the fetch that sent it, as the request itself carries it (`smoke-note`; null
     * for any other request).
     * @type {{ address: string, navigation: boolean, load: boolean, saved: boolean | null, note: number | null }[]}
     */
    const wholeReads = [];
    /**
     * The address whose reads after `go`'s navigation a check follows, while it does: each such
     * read's answer has its status line marked with the read's place in `wholeReads`
     * (`data-smoke-poll`), so the check can tell which read's answer the page drew.
     * @type {string | null}
     */
    let pollTarget = null;
    /**
     * Whether the status line the page shows (`drawn`: its text, its `data-smoke-poll` mark and the
     * page's address then) is `Saved.` drawn by an answer to a read of `address` sent after the
     * navigation's own fetch (its place in `wholeReads`, `navAt`), with the page at `target`.
     * @param {{ text: string | null, poll: string | null, at: string }} drawn @param {string} target @param {string} address @param {number} navAt
     */
    const pollDrewSaved = (drawn, target, address, navAt) => {
      const read = drawn.poll === null ? undefined : wholeReads[Number(drawn.poll)];
      return navAt >= 0 && drawn.text === "Saved." && drawn.at === target && Number(drawn.poll) > navAt && read?.address === address && !read.navigation && read.saved === true;
    };
    /**
     * The fragment case's receipt, while it runs, and how many loads of it (navigation requests) the
     * whole-read route has seen: the first is answered still saving (`stillSaving`), and each later
     * one is a read of the page, as the runtime's own are (`wholeReads`). The replaced-address case
     * uses it too, with the address its script puts in place (`also`), whose every load is a read.
     * @type {{ address: string, count: number, also?: string } | null}
     */
    let placeLoads = null;
    /** What the fragment case's first load was answered with, once it came. @type {{ saving: boolean, what: string } | null} */
    let loadAnswer = null;
    /** What each of `go`'s navigations here was answered with, by address, for a check's detail. @type {Map<string, string>} */
    const wholeSeeded = new Map();
    /** Why a navigation's answer here failed its check, by address: the server's `Saving...` whose head's read-again tag is missing or waits other than `AGAIN_SECONDS`. @type {Map<string, string>} */
    const wholeFaults = new Map();
    /**
     * Why an answer of the whole-read route was not given as meant (its fetch, its body, a read of
     * its tags or its fulfill failing or not settling in time, or the cases ending first,
     * `exchange`), in the order they came: each check here fails on one that came since it began.
     * @type {string[]}
     */
    const wholeAnswerFaults = [];
    /** Set as the cases below end: an answer of the whole-read route under way is not sent. */
    let wholeOver = false;
    /** The whole-read route's faults since `from` (a length of `wholeAnswerFaults`), for a check's detail. @param {number} from */
    const faultsSince = (from) => (wholeAnswerFaults.length > from ? `${wholeAnswerFaults.slice(from).join("; ")}; ` : "");
    /**
     * The full-load case's receipt, while it runs, and each load or read of it the whole-read route
     * answers, in the order they reached it: each answer's status line is marked with its place
     * (`data-smoke-full`), so the case can tell which answer the page first drew `Saved.` from.
     * @type {string | null}
     */
    let fullTarget = null;
    /** @type {import("@playwright/test").Request[]} */
    const fullReads = [];
    /**
     * What the full-load case's first load of its receipt was answered with, once it came: answered
     * still saving (`stillSaving`), as the fragment case's first load is, so that case does not
     * depend on the write landing after the load. @type {{ saving: boolean, what: string } | null}
     */
    let fullLoadAnswer = null;
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
      if (mode === "action") return letThrough(route);
      const asked = new URL(request.url());
      const address = asked.pathname + asked.search;
      // The runtime's reads (`corten: nav`, or `page` for a whole read; a prefetch aside); `go`'s
      // navigation's own fetch is the one that takes its token, as it reaches the route.
      // A load of the fragment case's receipt: its place among those loads (0 for its first), else -1.
      // A load of the replaced address the replaced-address case follows (`placeLoads.also`) is one
      // of its later loads, a read of the page.
      const placeLoad =
        placeLoads === null || !request.isNavigationRequest() ? -1 : address === placeLoads.address ? placeLoads.count++ : address === placeLoads.also ? 1 : -1;
      const read = (request.method() === "GET" && (mode === "nav" || mode === "page") && !isPrefetch(request)) || placeLoad > 0;
      const token = read ? claimNav(address) : undefined;
      const navigation = token !== undefined;
      const at = wholeReads.length;
      const noted = Number(request.headers()["smoke-note"] ?? NaN);
      if (read) wholeReads.push({ address, navigation, load: placeLoad > 0, saved: null, note: Number.isInteger(noted) && noted > 0 ? noted : null });
      // Each step within 5 s, and no answer sent once the cases are over (`exchange`): one that fails
      // or runs out aborts the request and fails the check it belongs to (`wholeAnswerFaults`).
      const ex = exchange(route, `the whole-read route's answer to ${request.method()} ${address}${mode ? ` (corten: ${mode})` : ""}`, () => wholeOver);
      // A load or read of the full-load case's receipt: its place among them (`fullReads`), marked on
      // its answer's status line (`data-smoke-full`), else -1.
      const full = fullTarget !== null && address === fullTarget ? fullReads.push(request) - 1 : -1;
      // The full-load case's first load of its receipt, answered still saving (`fullLoadAnswer`).
      const fullLoad = full >= 0 && request.isNavigationRequest() && !fullReads.slice(0, full).some((r) => r.isNavigationRequest());
      /** Sends `body` as the answer, within 5 s. @param {number} status @param {Record<string, string>} headers @param {string} body */
      const answer = (status, headers, body) =>
        ex.send(5000, "its fulfill", () => route.fulfill({ status, headers, body: full < 0 ? body : body.replace('id="alert-status"', `data-smoke-full="${full}" id="alert-status"`) }));
      try {
        await answerWhole(route, ex, answer, { mode, address, placeLoad, fullLoad, read, token, navigation, at });
      } catch {}
      if (ex.fault) wholeAnswerFaults.push(ex.fault);
    };
    /**
     * `wholeOnly`'s answer to `route`'s request, each step in `ex` and the answer sent by `answer`.
     * @param {import("@playwright/test").Route} route @param {ReturnType<typeof exchange>} ex
     * @param {(status: number, headers: Record<string, string>, body: string) => Promise<void>} answer
     * @param {{ mode: string | undefined, address: string, placeLoad: number, fullLoad: boolean, read: boolean, token: string | undefined, navigation: boolean, at: number }} seen
     */
    const answerWhole = async (route, ex, answer, { mode, address, placeLoad, fullLoad, read, token, navigation, at }) => {
      const request = route.request();
      // The replaced-address case's own mark on a request (`smoke-note`) is the check's, not the server's.
      const sent = { ...request.headers(), "accept-encoding": "identity" };
      delete sent["smoke-note"];
      const res = await ex.step(5000, "its fetch", () => route.fetch({ headers: sent }));
      const headers = res.headers();
      delete headers["content-encoding"];
      delete headers["content-length"];
      const whole = asWhole(await ex.step(5000, "reading its answer", () => res.text()));
      if (read) wholeReads[at].saved = res.ok() && whole.includes(savedLine);
      // The fragment case's and the full-load case's first load of its receipt: answered still saving,
      // as `stillSaving` writes the server's `Saved.` (one saying `Saving...` is passed on as written),
      // so neither case depends on the write landing after the load.
      if (placeLoad === 0 || fullLoad) {
        const loadShows = !res.ok() ? null : whole.includes(savedLine) ? "Saved." : whole.includes(savingLine) ? "Saving..." : null;
        const given =
          loadShows === "Saved."
            ? { saving: true, what: "the stand-in, the server's saying Saved." }
            : loadShows === "Saving..."
              ? { saving: true, what: "the server's own answer saying Saving..." }
              : { saving: false, what: `the server's own answer (status ${res.status()}, no status line)` };
        if (fullLoad) fullLoadAnswer = given;
        else loadAnswer = given;
        return answer(res.status(), headers, loadShows === "Saved." ? stillSaving(whole) : whole);
      }
      if (!navigation) {
        const followed = read && address === pollTarget;
        return answer(res.status(), headers, followed ? whole.replace('<p id="alert-status"', `<p data-smoke-poll="${at}" id="alert-status"`) : whole);
      }
      // The write lands 1.5 s after it is sent, and a loaded browser's navigation can reach the
      // server after that, when the right answer is `Saved.` with nothing to read again, so the
      // navigation's own fetch alone is answered as the server answers it while the write lands
      // (#2035), as `seedNavigation` answers the part cases', but only when the server's answer says
      // `Saved.`: one that says `Saving...` is passed on as every read here is, its part templates
      // taken out (`asWhole`), with the navigation's mark on its status line (`markNav`), and its own
      // head's read-again tag must be there and wait `AGAIN_SECONDS` (`wholeFaults`); the stand-in
      // never supplies or repairs it. Every read after it is the server's.
      const shows = whole.includes(savedLine) ? "Saved." : whole.includes(savingLine) ? "Saving..." : null;
      if (!res.ok() || shows === null) {
        wholeSeeded.set(address, `the server's own answer (status ${res.status()}${shows === null ? ", no status line" : ""})`);
        return answer(res.status(), headers, markNav(token, whole));
      }
      if (shows === "Saving...") {
        const wrong = await ex.step(5000, "reading its read-again tags", () => tagFaults(whole, undefined, mode === "page"));
        if (wrong !== null) wholeFaults.set(address, `the server's own answer saying Saving... ${wrong}`);
        wholeSeeded.set(address, wrong === null ? "the server's own answer saying Saving..., with its head's read-again tag as the server wrote it" : `the server's own answer saying Saving... ${wrong}, passed on as the server wrote it`);
        return answer(res.status(), headers, markNav(token, whole));
      }
      wholeSeeded.set(address, "the stand-in, the server's saying Saved.");
      await answer(res.status(), headers, markNav(token, stillSaving(whole)));
    };
    // The whole-read route and its listener are removed however the cases below end, each within
    // 5 s, so a hung browser fails the run with a reason rather than leaving them in place; the
    // route is set inside the guard, and removing one that was never set does nothing.
    try {
      await within(5000, "the whole-read route was not set within 5 s", page.route("**/alerts?saved=*", wholeOnly));
      page.on("request", onSaved);
      // After a full load: every load or read of the receipt is answered with its place in
      // `fullReads` on its status line, and its first load is answered still saving whatever the
      // store says by then (`fullLoadAnswer`), as the fragment case's is, so a write that landed
      // before the load cannot pass or fail the case. An init script, added before the load, notes in
      // the page's session storage (which a full load keeps) the first status line the page draws
      // (its text and its place in `fullReads`), and the first of those answers the page draws `Saved.`
      // from, each the moment it is drawn: the check that the load drew `Saving...` reads that note,
      // not the page once `goto` returns, by when a read again may have drawn `Saved.`. The check that
      // it stops then requires the note of `Saved.` once the wait for it has seen it within its 6 s,
      // from an answer to a read after the case's load (not the load's own), and no read of the
      // alerts page after that answer's own request in the log, as the log stands once 2.2 s have
      // passed by the smoke's monotonic clock since the check read the note: a read sent between the
      // draw and the check seeing it counts against it, as the part case's check counts one (above).
      // The check that reading again keeps the document requires the load's own document, numbered
      // by an init script added before the load, both once the load returns and after the wait.
      {
        const faultsFrom = wholeAnswerFaults.length;
        const firstKey = `smoke-full-first-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const initialKey = `${firstKey}-initial`;
        fullReads.length = 0;
        fullLoadAnswer = null;
        const noting = page.addInitScript((/** @type {{ key: string, initialKey: string }} */ { key, initialKey }) => {
          if (window !== window.top) return;
          /** Whether the first `Saved.` is noted, noting it (and the first status line drawn) if the page shows it now. */
          const look = () => {
            try {
              const status = document.getElementById("alert-status");
              const read = status?.getAttribute("data-smoke-full");
              const text = status?.textContent;
              if (read != null && (text === "Saving..." || text === "Saved.") && sessionStorage.getItem(initialKey) === null) sessionStorage.setItem(initialKey, JSON.stringify({ text, read }));
              if (sessionStorage.getItem(key) !== null) return true;
              if (read == null || text !== "Saved.") return false;
              sessionStorage.setItem(key, read);
              return true;
            } catch {
              return true;
            }
          };
          const observer = new MutationObserver(() => look() && observer.disconnect());
          observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-smoke-full"] });
        }, { key: firstKey, initialKey });
        noting.catch(() => {});
        /** The `sessionStorage` key of the case's count of documents, its own each run. */
        const documentKey = `${firstKey}-documents`;
        /** The init script that numbers the documents, once it is added. @type {ReturnType<typeof page.addInitScript> | null} */
        let numbering = null;
        /** The number of the page's document, or null for one made before the count started. */
        const documentNumber = () =>
          readWithin("the page's document number", page.evaluate(() => /** @type {number | null} */ ((/** @type {any} */ (window)).__smokeDocument ?? null))).catch(() => null);
        try {
          await within(5000, "the full-load case's note of its first Saved. was not added within 5 s", noting);
          const target = await readWithin("the pending write's page", pending());
          fullTarget = new URL(target).pathname + new URL(target).search;
          // The document the case loads is told, as the place case's is (below), by an init script
          // added before the load that numbers each document the tab makes from then on, in the
          // order they are made (a count in session storage, which a reload keeps): the document
          // once the load returns and once the wait for `Saved.` ends must both be the first, so a
          // read again that loads the page in full, even before `goto` returns, is not taken for
          // the load's own document.
          numbering = page.addInitScript((key) => {
            if (window !== window.top) return;
            try {
              const n = Number(sessionStorage.getItem(key) ?? "0") + 1;
              sessionStorage.setItem(key, String(n));
              /** @type {any} */ (window).__smokeDocument = n;
            } catch {}
          }, documentKey);
          numbering.catch(() => {});
          await within(5000, "the full-load case's count of documents was not set within 5 s", numbering);
          const loadFrom = performance.now();
          const load = (await actWithin("the pending write's page load", page.goto(target)))?.request();
          const loadedAs = await documentNumber();
          const loadAt = load === undefined ? -1 : fullReads.indexOf(load);
          /** The first status line the page drew, as the init script noted it the moment it was drawn. @type {{ text: string, read: string } | null} */
          const initial = await readWithin(
            "the page's note of the first status line it drew",
            page.evaluate((key) => {
              const noted = sessionStorage.getItem(key);
              return noted === null ? null : JSON.parse(noted);
            }, initialKey),
          ).catch(() => null);
          const drewSaving = !!fullLoadAnswer?.saving && initial?.text === "Saving..." && loadAt >= 0 && Number(initial.read) === loadAt;
          const waiting = initial === null ? "no status line noted" : `${initial.text} (drawn from answer ${initial.read}, the load's ${loadAt})`;
          const came = await savedSoon(loadFrom);
          const endedAs = await documentNumber();
          // The first answer the page drew `Saved.` from, noted as it drew it: before the wait above
          // saw `Saved.`, so within its 6 s when the wait came in time.
          const first = came
            ? await readWithin("the page's note of what it drew Saved. from", page.evaluate((key) => sessionStorage.getItem(key), firstKey)).catch(() => null)
            : null;
          const read = await readWithin("the status line after the wait for Saved.", saved());
          check(
            "a page waiting for a write reads itself again after a full load",
            drewSaving && came && read === "Saved." && wholeAnswerFaults.length === faultsFrom,
            `${faultsSince(faultsFrom)}loaded with ${fullLoadAnswer?.what ?? "no load of the receipt seen"}, first drew ${waiting} -> ${read}${came ? "" : " (Saved. not seen within 6 s)"}`,
          );
          if (swaps) check("reading again keeps the document", loadedAs === 1 && endedAs === 1, `document ${loadedAs ?? "unnumbered"} once the load returned and ${endedAs ?? "unnumbered"} after the wait, where the load's own is 1 and stays`);
          else skip("reading again keeps the document", noSwaps);
          const drawn = first !== null && loadAt >= 0 && Number(first) > loadAt ? first : null;
          if (drawn !== null) await pause(2200);
          const terminal = drawn === null ? undefined : fullReads[Number(drawn)];
          const after = readsAfter(terminal);
          check(
            "it stops once the page no longer asks",
            drawn !== null && after !== null && after.reads.length === 0 && wholeAnswerFaults.length === faultsFrom,
            `${faultsSince(faultsFrom)}${
              drawn === null
                ? `no answer to a read of the receipt after its load (${loadAt}) drew Saved. within 6 s (${JSON.stringify(first)})`
                : after === null
                  ? `the request whose answer first drew Saved. (${drawn}) is not in the page's requests`
                  : `${after.reads.length} reads after the one whose answer first drew Saved. (${drawn}), by the check's look at least 2.2 s after that draw: ${after.reads.join(", ") || "none"}${after.prefetches.length ? `; prefetches not counted: ${after.prefetches.join(", ")}` : ""}`
            }`,
          );
        } finally {
          fullTarget = null;
          await cleanUp(
            () => within(5000, "the full-load case's note of its first Saved. was not removed within 5 s", noting.then((s) => s.dispose())),
            () => (numbering === null ? undefined : within(5000, "the full-load case's count of documents was not removed within 5 s", numbering.then((s) => s.dispose()))),
            () =>
              within(
                5000,
                "the full-load case's note was not cleared within 5 s",
                page.evaluate((/** @type {string[]} */ keys) => keys.forEach((key) => sessionStorage.removeItem(key)), [firstKey, initialKey, documentKey]),
              ),
          );
        }
      }
      // At a place on the page (a write redirected to `route.at(..)`): read again all the same. The
      // page's first load of its receipt is answered still saving (`placeLoads`) whatever the store
      // says by then, so a write that landed before the load cannot pass the case; then `Saved.` must
      // be drawn, seen within 6 s by the smoke's clock (`seenWithin`), by the answer to a later read
      // of that receipt (`pollTarget` marks those answers), with the page still at the place. With
      // the Navigation API that read is the runtime's own, in the document the case loaded: an init
      // script, added before the load, numbers each document the tab makes from then on, in the
      // order they are made (a count in `sessionStorage`, which a reload keeps), and both the
      // document read once the load returns and the one read after the wait must be the first, so a
      // full load at any moment after the case's own, even before `goto` returns, fails it. A full
      // load of the receipt is not the page reading itself again in place. Without the Navigation
      // API the page reads itself again by reloading, so that read must be a load of the receipt,
      // drawn in a document the tab made after the case's own (numbered after the first by the same
      // count): `Saved.` a fetch drew in place does not pass for it.
      {
        const target = await readWithin("the pending write's page", pending());
        const address = new URL(target).pathname + new URL(target).search;
        const readFrom = wholeReads.length;
        const faultsFrom = wholeAnswerFaults.length;
        loadAnswer = null;
        placeLoads = { address, count: 0 };
        pollTarget = address;
        /** What the wait saw: the place in `wholeReads` of the read whose answer drew `Saved.`, and the number of the document it was drawn in. @type {unknown} */
        let poll = null;
        /** The `sessionStorage` key of the case's count of documents, its own each run. */
        const documentKey = `smoke-fragment-documents-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        /** The number of the page's document once the load returned, and after the wait: 1 is the load's own. */
        let loadedAs = /** @type {number | null} */ (null);
        let endedAs = /** @type {number | null} */ (null);
        const numbering = page.addInitScript((key) => {
          if (window !== window.top) return;
          try {
            const n = Number(sessionStorage.getItem(key) ?? "0") + 1;
            sessionStorage.setItem(key, String(n));
            /** @type {any} */ (window).__smokeDocument = n;
          } catch {}
        }, documentKey);
        numbering.catch(() => {});
        /** The number of the page's document, or null for one made before the count started. */
        const documentNumber = () =>
          readWithin("the page's document number", page.evaluate(() => /** @type {number | null} */ ((/** @type {any} */ (window)).__smokeDocument ?? null)));
        try {
          await within(5000, "the fragment case's count of documents was not set within 5 s", numbering);
          const loadFrom = performance.now();
          await actWithin("the receipt's load at its place", page.goto(`${target}#alert-status`));
          loadedAs = await documentNumber();
          poll = await seenWithin(
            6000,
            "Saved. drawn at the place by an answer to a later read of the receipt",
            (address) => {
              const status = document.getElementById("alert-status");
              const mark = status?.getAttribute("data-smoke-poll");
              return (
                location.pathname + location.search === address &&
                location.hash === "#alert-status" &&
                status?.textContent === "Saved." &&
                mark && { mark, document: /** @type {number | null} */ ((/** @type {any} */ (window)).__smokeDocument ?? null) }
              );
            },
            address,
            loadFrom,
          );
          endedAs = await documentNumber();
        } finally {
          placeLoads = null;
          pollTarget = null;
          await cleanUp(
            () => within(5000, "the fragment case's count of documents was not removed within 5 s", numbering.then((s) => s.dispose())),
            () => within(5000, "the fragment case's count of documents was not cleared within 5 s", page.evaluate((key) => sessionStorage.removeItem(key), documentKey)),
          );
        }
        const drawn = /** @type {{ mark: string, document: number | null } | null} */ (poll && typeof poll === "object" ? poll : null);
        const by = drawn === null ? undefined : wholeReads[Number(drawn.mark)];
        const laterRead = drawn !== null && by !== undefined && Number(drawn.mark) >= readFrom && by.address === address && !by.navigation && by.saved === true;
        // The read the runtime makes. With the Navigation API: a read in place (not a load), in the
        // document the case loaded, the first the tab made after the count started, with no other
        // made by the end of the wait. Without it: a load of the receipt, drawn in a document made
        // after the case's own.
        const asRuntime = swaps ? laterRead && !by?.load : laterRead && !!by?.load && typeof drawn?.document === "number" && drawn.document > 1;
        const sameDocument = !swaps || (loadedAs === 1 && endedAs === 1);
        const ownRead = laterRead && asRuntime && sameDocument;
        const later = wholeReads.slice(readFrom).filter((r) => r.address === address).length;
        const shown = laterRead
          ? "Saved."
          : await readWithin("the status line after the wait for Saved.", page.evaluate(() => document.getElementById("alert-status")?.textContent ?? null));
        const drawnBy = !laterRead
          ? "not drawn by an answer to a later read of the receipt within 6 s"
          : `drawn by read ${Number(drawn?.mark) - readFrom + 1} of the case${by?.load ? " (a load)" : ""} in document ${drawn?.document ?? "unnumbered"}${
              asRuntime ? "" : swaps ? ", a full load where the Navigation API reads in place" : by?.load ? ", not in a document a load made after the case's own" : ", a fetch in place where without the Navigation API the page reads itself again by reloading"
            }`;
        const documents = sameDocument ? "" : `; document ${loadedAs ?? "unnumbered"} once the load returned and ${endedAs ?? "unnumbered"} after the wait, where the load's own is 1 and stays`;
        check("a page at a place (#id) reads itself again too", !!loadAnswer?.saving && ownRead && wholeAnswerFaults.length === faultsFrom, `${faultsSince(faultsFrom)}${loadAnswer ? `loaded with ${loadAnswer.what}` : "no load of the receipt seen"} -> ${shown} at ${page.url()}, ${drawnBy}; ${later} reads of the receipt after its load${documents}`);
      }
      // A query a script put in the address (corten-ui's rows::sort writes the order it shows) is
      // read again with the page, so the page read again draws what is on screen. The page's load is
      // answered still saving whatever the store says by then (`placeLoads`), as the fragment case's
      // is, so a write that landed before the load cannot leave the page nothing to read again. The
      // reads that count are the ones the page makes after the script's replacement, by the page's
      // own order of events: an init script, added before the load, numbers by one count (in session
      // storage, which a full load keeps) the start of each document the tab makes and each fetch of
      // `/alerts` it starts (the runtime's reads are fetches), and the page task that replaces the
      // address numbers the replacement, with the address it puts in place, on the same count just
      // before it. A read the page started with the old address before the replacement, though the
      // check hears of it after the driver's call returns, is not one after it; one started after it
      // is, and each must be of exactly the address the replacement put in place, the receipt's own,
      // not another with the same query. `Saved.` must be drawn by the answer to one of those reads:
      // each answer the route gives a read of that address has its status line marked with the
      // read's place in `wholeReads` (`pollTarget`), so `Saved.` an older read's answer or anything
      // else drew does not pass for it, and that read must itself be one the page started after the
      // replacement. A fetch carries its own number on the count (`smoke-note`, which the wrapper puts
      // on the request it notes), so the answer is bound to that request, not to any read of the same
      // address: one started before the replacement, though at the replaced address, does not do,
      // however the reads arrive. A load (the page reading itself again without the Navigation API)
      // carries no number: its document notes its own on the count as it starts, with its kind of
      // load, and it must be a reload numbered after the replacement, at the replaced address, as only
      // a reload asked for after the replacement loads that address (one asked for before loads the
      // address the entry had then). Which of the two must have drawn it depends on the browser, as the
      // runtime's read again does: with the Navigation API the page reads in place, so that draw must
      // be a fetch's, in the document the case loaded (a mark the replacement's task leaves on it), with
      // no other document started (the notes); without it the runtime reads the page again by reloading
      // it, so that draw must be a load's, the marked reload of the replaced address, and `Saved.` a
      // fetch drew in place does not pass for it.
      {
        const faultsFrom = wholeAnswerFaults.length;
        const target = await readWithin("the pending write's page", pending());
        loadAnswer = null;
        /** The address the case's script puts in place: the receipt's with `shown` set, as the page task below writes it. */
        const replacedTo = new URL(target);
        replacedTo.searchParams.set("shown", "1");
        const replacedAddress = replacedTo.pathname + replacedTo.search;
        placeLoads = { address: new URL(target).pathname + new URL(target).search, count: 0, also: replacedAddress };
        const readFrom = wholeReads.length;
        pollTarget = replacedAddress;
        /** The `sessionStorage` key of the case's notes, its own each run. */
        const noteKey = `smoke-replaced-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const noting = page.addInitScript((key) => {
          if (window !== window.top) return;
          const w = /** @type {any} */ (window);
          /** Notes `entry` with the next number of the count, and answers that number (false if it was not noted). @param {{ kind: string, url: string, load?: string | null }} entry */
          const note = (entry) => {
            if (w.__smokeReplacedOff) return false;
            try {
              const notes = JSON.parse(sessionStorage.getItem(key) ?? '{"count":0,"notes":[]}');
              const at = ++notes.count;
              notes.notes.push({ at, ...entry });
              sessionStorage.setItem(key, JSON.stringify(notes));
              return at;
            } catch {
              return false;
            }
          };
          w.__smokeReplacedNote = note;
          // The document's own number, with how it was loaded (a reload, or a navigation): from its
          // navigation timing entry, or, where the browser has none yet as the document starts
          // (WebKit), from the older `performance.navigation`, which says a reload as 1.
          const loaded = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType("navigation")[0]);
          const older = /** @type {{ type?: number } | undefined} */ (/** @type {any} */ (performance).navigation)?.type;
          const load = loaded?.type ?? (older === 1 ? "reload" : older === 0 ? "navigate" : older === 2 ? "back_forward" : null);
          w.__smokeReplacedDocumentAt = note({ kind: "document", url: location.href, load });
          const original = window.fetch;
          w.__smokeReplacedFetch = original;
          window.fetch = function (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit | undefined} */ init) {
            try {
              const at = new URL(input instanceof Request ? input.url : String(input), location.href);
              if (at.origin === location.origin && at.pathname === "/alerts") {
                const noted = note({ kind: "fetch", url: at.href });
                // The request carries its own number, so the answer the route marks is bound to it.
                if (typeof noted === "number") {
                  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
                  headers.set("smoke-note", String(noted));
                  return original.call(this, input, { ...init, headers });
                }
              }
            } catch {}
            return original.apply(this, /** @type {any} */ (arguments));
          };
        }, noteKey);
        noting.catch(() => {});
        let replacedIn = false;
        /** What the wait for `Saved.` saw: the mark of the read whose answer drew it, whether it was drawn in the case's document, and that document's number on the count. @type {unknown} */
        let drawnAs = null;
        /** The case's notes, read after the wait. @type {{ count: number, notes: { at: number, kind: string, url: string, load?: string | null }[] } | null} */
        let notes = null;
        try {
          await within(5000, "the replaced-address case's notes were not added within 5 s", noting);
          const loadFrom = performance.now();
          await actWithin("the pending write's page load", page.goto(target));
          replacedIn = await readWithin(
            "the page's replaced address",
            page.evaluate(() => {
              const to = new URL(location.href);
              to.searchParams.set("shown", "1");
              // Numbered in the same task as the replacement, so no read the page starts falls between.
              const noted = typeof (/** @type {any} */ (window).__smokeReplacedNote?.({ kind: "replaced", url: to.href })) === "number";
              // The document the case loaded, marked in the same task.
              /** @type {any} */ (window).__smokeReplacedDocument = true;
              history.replaceState(history.state, "", to);
              return noted;
            }),
          );
          drawnAs = await seenWithin(
            6000,
            "Saved. drawn by an answer to a read of the replaced address",
            (address) => {
              const status = document.getElementById("alert-status");
              const mark = status?.getAttribute("data-smoke-poll");
              const w = /** @type {any} */ (window);
              return location.pathname + location.search === address && status?.textContent === "Saved." && mark && { mark, same: w.__smokeReplacedDocument === true, document: w.__smokeReplacedDocumentAt ?? null };
            },
            replacedAddress,
            loadFrom,
          );
          notes = await readWithin(
            "the page's notes of its replacement and reads",
            page.evaluate((key) => {
              const noted = sessionStorage.getItem(key);
              return noted === null ? null : JSON.parse(noted);
            }, noteKey),
          ).catch(() => null);
        } finally {
          placeLoads = null;
          pollTarget = null;
          await cleanUp(
            () => within(5000, "the replaced-address case's notes were not removed within 5 s", noting.then((s) => s.dispose())),
            () =>
              within(
                5000,
                "the replaced-address case's notes were not cleared within 5 s",
                page.evaluate((key) => {
                  const w = /** @type {any} */ (window);
                  // A fetch the runtime keeps of the wrapper notes nothing more.
                  w.__smokeReplacedOff = true;
                  if (w.__smokeReplacedFetch) window.fetch = w.__smokeReplacedFetch;
                  sessionStorage.removeItem(key);
                }, noteKey),
              ),
          );
        }
        const replacement = notes?.notes.find((n) => n.kind === "replaced") ?? null;
        const replacedAt = replacement?.at ?? null;
        const after = replacedAt === null || notes === null ? [] : notes.notes.filter((n) => n.at > replacedAt && new URL(n.url).pathname === "/alerts");
        const again = after.map((n) => `${n.kind} ${n.url}`);
        // Every read after the replacement is of the address it put in place, that address the one the
        // case meant (`replacedTo`).
        const exact = replacement !== null && replacement.url === replacedTo.href && after.length > 0 && after.every((n) => n.url === replacement.url);
        // With the Navigation API, the one document the tab started is the load's, before the replacement.
        const documents = notes === null ? [] : notes.notes.filter((n) => n.kind === "document");
        const oneDocument = !swaps || (documents.length === 1 && replacedAt !== null && documents[0].at < replacedAt);
        const drawn = /** @type {{ mark: string, same: boolean, document: number | null } | null} */ (drawnAs && typeof drawnAs === "object" ? drawnAs : null);
        const by = drawn === null ? undefined : wholeReads[Number(drawn.mark)];
        /** The note numbered `at`, if the notes have one. @param {number | null | undefined} at */
        const noteAt = (at) => (typeof at === "number" ? (notes?.notes.find((n) => n.at === at) ?? null) : null);
        // The read whose answer drew `Saved.` started after the replacement, at the replaced address:
        // a fetch by the number it carried, a load by its document's own.
        const started = by === undefined ? null : by.load ? noteAt(drawn?.document) : noteAt(by.note);
        const startedAfter =
          started !== null &&
          replacedAt !== null &&
          started.at > replacedAt &&
          started.url === replacedTo.href &&
          (by?.load ? started.kind === "document" && started.load === "reload" : started.kind === "fetch");
        const ownRead = drawn !== null && Number(drawn.mark) >= readFrom && by !== undefined && by.address === replacedAddress && !by.navigation && by.saved === true && startedAfter;
        // The read the runtime makes: a fetch in place with the Navigation API, a reload without it.
        const asRuntime = swaps ? ownRead && !by?.load && drawn.same : ownRead && !!by?.load;
        const replaced = await readWithin("the status line after the wait for Saved.", saved());
        const drawnBy =
          drawn === null
            ? " (Saved. not drawn by an answer to a read of the replaced address within 6 s of the load)"
            : !ownRead
              ? ` (Saved. drawn with mark ${drawn.mark}, not an answer of the case's to a read of ${replacedAddress} that said Saved. and that the page started after the replacement: ${
                  by === undefined ? "no such read" : started === null ? `its ${by.load ? "document" : "request"} carried no note of the case's` : `its ${started.kind} was noted ${started.at} (${started.url}${started.load ? `, a ${started.load}` : ""}), the replacement ${replacedAt ?? "not at all"}`
                })`
              : asRuntime
                ? ""
                : swaps
                  ? ` (Saved. drawn ${drawn.same ? "by a load" : "in another document"}, where the Navigation API reads in place)`
                  : " (Saved. drawn by a fetch in place, where without the Navigation API the page reads itself again by reloading)";
        check(
          "a page reads itself again at the address a script replaced",
          !!loadAnswer?.saving && replacedIn && replacedAt !== null && ownRead && asRuntime && oneDocument && replaced === "Saved." && exact && wholeAnswerFaults.length === faultsFrom,
          `${faultsSince(faultsFrom)}${loadAnswer ? `loaded with ${loadAnswer.what}` : "no load of the receipt seen"} -> ${replaced}${drawnBy}${replacedIn && replacedAt !== null ? "" : " (the replacement was not noted in the load's document)"}${replacement === null || replacement.url === replacedTo.href ? "" : ` (replaced with ${replacement.url}, not ${replacedTo.href})`}${oneDocument ? "" : ` (documents ${documents.map((d) => `${d.at} ${d.url}`).join(", ") || "none"}, replaced at ${replacedAt ?? "none"})`} after the replacement: ${again.join(", ") || "no read"}${exact || after.length === 0 ? "" : `, wanted every one ${replacement?.url ?? replacedTo.href}`}`,
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
        // once a step fails, the case does no more page work. The write and its page's read, the
        // route's setting and its removal are each bounded too, a bound that runs out ending the run
        // with its reason. The hold is let go and the route and listeners removed however the case ends.
        const name = "a read a script's replaceState cancels on its way is made again";
        const faultsFrom = wholeAnswerFaults.length;
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
        /** Why the route's answer to the page's load was not given as meant (`exchange`), once it was not. */
        let loadFault = "";
        const slow = async (/** @type {import("@playwright/test").Route} */ route) => {
          const request = route.request();
          if (!loaded && served && request.isNavigationRequest() && bare(request.url()) === address) {
            loaded = true;
            const ex = exchange(route, "the held-read route's answer to the page's load");
            await ex.send(5000, "its fulfill", () => route.fulfill(/** @type {NonNullable<typeof served>} */ (served))).catch(() => {});
            loadFault = ex.fault;
            return;
          }
          if (heldRead || !isRead(request)) return letThrough(route);
          heldRead = request;
          holding();
          await released;
          // Let through once the hold is let go, bounded as every answer here is.
          await letThrough(route);
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
            const got = await within(15000, "the fixture's write and its page were not read within 15 s", capture());
            const body = got?.status === 200 ? asSaving(got.body) : null;
            if (!got || !body) stopped = `the fixture drew no page for its write: ${got ? `${got.status}` : "no receipt"}`;
            else {
              address = bare(new URL(got.from, base).href);
              const next = new URL(address);
              next.searchParams.set("shown", "2");
              expected = next.href;
              served = { status: got.status, headers: Object.fromEntries(got.headers.filter(([header]) => !/^content-(encoding|length)$/i.test(header))), body };
              await actWithin("the blank page's load", page.goto("about:blank"));
              recording = true;
              await within(5000, "the held-read route was not set within 5 s", page.route(alerts, slow));
              await actWithin("the held page's load", page.goto(address));
              await readWithin("the page's mark", page.evaluate(() => ((/** @type {any} */ (window)).__replayed = 7)));
              waiting = (await readWithin("the status line once the held page loaded", saved())) ?? "";
              const held = await steps(5000, "no read held within 5 s").step(() => isHeld).catch(() => false);
              // The page's event for the read held may come a moment after its route.
              if (held) await pollAsync(1000, async () => polls.length > 0);
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
                else if (!(await pollAsync(5000, async () => failedShut || undefined))) stopped = "the held read did not fail while held within 5 s";
                else if (failedShut !== "after") stopped = "the held read failed before the script replaced the address";
              }
            }
          } finally {
            shut = false;
            release();
            await within(5000, "the held-read route was not removed within 5 s", page.unroute(alerts, slow));
          }
          if (!stopped) {
            const drawn = await pollAsync(6000, () =>
              page.evaluate(() => document.getElementById("alert-status")?.textContent === "Saved." && (/** @type {any} */ (window)).__replayed === 7),
            );
            if (!drawn) stopped = "Saved. not drawn in the same document within 6 s";
            // The answered read's event may come a moment after its page is drawn.
            else if (!(await pollAsync(1000, async () => answered.length > 0))) stopped = "no read of the replaced address finished within 1 s";
            else
              outcome = {
                status: (await readWithin("the status line once Saved. was drawn", saved())) ?? "",
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
            outcome.at === expected &&
            wholeAnswerFaults.length === faultsFrom &&
            !loadFault,
          `${faultsSince(faultsFrom)}${loadFault ? `${loadFault}; ` : ""}${stopped ? `${stopped}; ` : ""}${waiting || "(not loaded)"} -> ${outcome.status || "(not read)"} at ${outcome.at || "(not read)"}; reads after the held one ${outcome.later.join() || "none"}, wanted ${expected || "(none)"}; answered ${outcome.statuses.join() || "none"}`,
        );
      } else {
        skip("a read a script's replaceState cancels on its way is made again", noSwaps);
      }
      if (swaps) {
        await readWithin("the page's mark", page.evaluate(() => ((/** @type {any} */ (window)).__marker = 6)));
        const entries = await readWithin("the page's history length", page.evaluate(() => history.length));
        // `Saving...` as the navigation drew it, recorded by the page (`go`), not looked at once it
        // returns, by when the page may have read itself again and say `Saved.`; then `Saved.` drawn
        // by the answer to one of the page's own reads of its address after the navigation's fetch
        // (`pollTarget` marks those answers, `pollDrewSaved`), at the navigation's address, in the same
        // document: a `Saved.` another receipt's read drew is not this page reading itself again.
        const target = await readWithin("the pending write's page", pending());
        const address = new URL(target).pathname + new URL(target).search;
        const readFrom = wholeReads.length;
        const faultsFrom = wholeAnswerFaults.length;
        pollTarget = address;
        /** @type {{ text: string | null, poll: string | null, at: string }} */
        let drawn;
        /** @type {Awaited<ReturnType<typeof go>>} */
        let nav;
        try {
          nav = await go(target);
          // The read whose answer drew `Saved.` is the one the wait saw marked, within 6 s of its
          // start by the smoke's clock (`seenWithin`), not one a later look at the page finds.
          const poll = await seenWithin(
            6000,
            "Saved. drawn by an answer to the page's own read",
            (target) => {
              const status = document.getElementById("alert-status");
              return location.href === target && status?.textContent === "Saved." && status.getAttribute("data-smoke-poll");
            },
            target,
          );
          drawn =
            typeof poll === "string"
              ? { text: "Saved.", poll, at: target }
              : {
                  ...(await readWithin(
                    "the status line after the wait for Saved.",
                    page.evaluate(() => ({ text: document.getElementById("alert-status")?.textContent ?? null, at: location.href })),
                  )),
                  poll: null,
                };
        } finally {
          pollTarget = null;
        }
        const kept = await readWithin(
          "whether the navigation kept the document",
          page.evaluate((token) => (/** @type {any} */ (window)).__marker === 6 && (/** @type {any} */ (window)).__smokeGo?.token === token, nav.token),
        );
        const navIndex = wholeReads.findIndex((r, i) => i >= readFrom && r.navigation && r.address === address);
        const ownPoll = pollDrewSaved(drawn, target, address, navIndex);
        const drewBy = drawn.poll === null ? "no read of its own after the navigation's, within 6 s" : `read ${Number(drawn.poll) - readFrom + 1} of the case (${wholeReads[Number(drawn.poll)]?.address})`;
        check(
          "a page reached by the runtime's navigation reads itself again in place",
          nav.saving && nav.sameDocument && ownPoll && kept && !wholeFaults.has(address) && wholeAnswerFaults.length === faultsFrom,
          `${faultsSince(faultsFrom)}${wentTo(nav)} (answered with ${wholeSeeded.get(address) ?? "nothing seen"}) -> ${drawn.text} at ${drawn.at}, drawn by ${drewBy}${kept ? "" : ", the document not kept"}`,
        );
        // The history length once the page's own read of its address after the navigation's fetch has
        // drawn `Saved.` (`ownPoll`): without such a read drawn, the length shows only that the
        // navigation added its entry, not what a read does to it.
        const length = await readWithin("the page's history length after the reads", page.evaluate(() => history.length));
        check(
          "each read replaces the history entry",
          ownPoll && length === entries + 1,
          `${entries} -> ${length}, the page saying ${drawn.text} drawn by ${drewBy}${navIndex < 0 ? ", no navigation fetch seen" : ""}`,
        );
        // Away while a write lands: once the page is in and has armed its read again (the head's
        // read-again tag), it is left at once by its header's link, pressed in the page, with no wait
        // for its text. A write that landed before the page came in arms nothing, so another is tried.
        // The check claims only that the page starts no read of the alerts page from its press on,
        // by the page's own order of events: News can come from a prefetch sent while the pointer
        // rested on its link, before the press, so no request marks the moment the page left. The
        // page's notes number the press (a capture listener for a click on the News link) and the
        // start of each fetch of `/alerts` (the runtime's reads are fetches) by one count in the order
        // they happen, so a read started before the press is told from one started after it, however
        // late the check hears either, and one started in the same instant as the press is after it.
        // A load of `/alerts` heard after the press counts too, as does a document that was replaced,
        // which leaves no notes. The notes are installed before any try asks the page to navigate and
        // read 2.2 s after News is drawn.
        let armed = false;
        let leftAs = null;
        /** This run of the check's, so an install of its notes the page runs after their removal does nothing. */
        const leaveToken = `${Date.now()}-${Math.random()}`;
        try {
          // The page's fetch is put back and its press listener removed however the check ends, from
          // the moment the check asks the page to install them (an install the page made but did not
          // acknowledge in time included), and one the page runs only after that removal does
          // nothing; a removal not confirmed within 5 s fails the case rather than leave the shared
          // page instrumented.
          await readWithin(
            "the page's notes of its press and reads",
            page.evaluate((token) => {
              const w = /** @type {any} */ (window);
              if (w.__smokeLeaveRemoved === token) return;
              /** @typedef {{ at: number, url: string, prefetch: boolean }} Read */
              const notes = { count: 0, pressedAt: /** @type {number | null} */ (null), reads: /** @type {Read[]} */ ([]) };
              w.__smokeLeave = notes;
              w.__smokeFetch ??= window.fetch;
              const original = w.__smokeFetch;
              window.fetch = function (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit | undefined} */ init) {
                try {
                  const at = new URL(input instanceof Request ? input.url : String(input), location.href);
                  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
                  if (at.origin === location.origin && at.pathname === "/alerts") notes.reads.push({ at: ++notes.count, url: at.pathname + at.search, prefetch: headers.get("purpose") === "prefetch" });
                } catch {}
                return original.apply(this, /** @type {any} */ (arguments));
              };
              // Kept by name, so the check's cleanup removes it with the wrapper.
              w.__smokeLeaveClick = (/** @type {Event} */ e) => {
                if (notes.pressedAt === null && /** @type {Element} */ (e.target)?.closest?.('a[href="/news"]')) notes.pressedAt = ++notes.count;
              };
              document.addEventListener("click", w.__smokeLeaveClick, true);
            }, leaveToken),
          );
          for (let tries = 0; tries < 3 && !armed; tries++) {
            const leaving = await readWithin("the pending write's page", pending());
            await readWithin("the old status line's mark", page.evaluate(() => document.getElementById("alert-status")?.setAttribute("data-old", "")));
            await within(15000, "the page was not asked to navigate within 15 s", page.evaluate((url) => (/** @type {any} */ (window)).navigation.navigate(url), leaving));
            await within(30_000, "the pending write's page was not drawn within 30 s", page.waitForFunction((url) => location.href === url && !document.querySelector("#alert-status[data-old]"), leaving));
            armed = await readWithin("whether the page armed its read again", page.evaluate(() => !!document.head.querySelector("noscript[data-corten-read-again]")));
          }
          if (armed) {
            const pressFrom = pageLog.length;
            await leaveForNews();
            await pause(2200);
            const notes = await readWithin(
              "the page's notes of its press and reads",
              page.evaluate(() => /** @type {{ pressedAt: number | null, reads: { at: number, url: string, prefetch: boolean }[] } | undefined} */ ((/** @type {any} */ (window)).__smokeLeave)),
            );
            const loads = pageLog.slice(pressFrom).filter((r) => r.isNavigationRequest() && r.method() === "GET" && new URL(r.url()).pathname === "/alerts").map((r) => `load ${new URL(r.url()).pathname}${new URL(r.url()).search}`);
            const pressed = notes?.pressedAt ?? null;
            const after = pressed === null ? [] : (notes?.reads ?? []).filter((r) => r.at > pressed);
            leftAs = {
              ok: !!notes && pressed !== null && loads.length === 0 && after.every((r) => r.prefetch),
              detail: !notes
                ? "the document that pressed was replaced, so its notes are gone"
                : pressed === null
                  ? "the page noted no press of the News link"
                  : `${after.filter((r) => !r.prefetch).length + loads.length} reads started after the press${after.length + loads.length ? ` (${[...after.map((r) => `${r.prefetch ? "prefetch, not counted, " : ""}${r.url}`), ...loads].join(", ")})` : ""}`,
            };
          }
        } finally {
          await cleanUp(() =>
            within(
              5000,
              "the page's fetch was not put back within 5 s",
              page.evaluate((token) => {
                const w = /** @type {any} */ (window);
                w.__smokeLeaveRemoved = token;
                if (w.__smokeFetch) window.fetch = w.__smokeFetch;
                if (w.__smokeLeaveClick) document.removeEventListener("click", w.__smokeLeaveClick, true);
                delete w.__smokeLeaveClick;
                delete w.__smokeLeave;
              }, leaveToken),
            ),
          );
        }
        if (leftAs) check("navigating away stops the reads", leftAs.ok, leftAs.detail);
        else skip("navigating away stops the reads", "each write landed before its page came in");
      } else {
        for (const name of ["a page reached by the runtime's navigation reads itself again in place", "each read replaces the history entry", "navigating away stops the reads"]) skip(name, noSwaps);
      }
    } finally {
      await cleanUp(
        () => page.off("request", onSaved),
        () => (wholeOver = true),
        () => within(5000, "the whole-read route was not removed within 5 s", page.unroute("**/alerts?saved=*", wholeOnly)),
      );
    }

    // A data-patch write answered in place while its read catches up (ReadAgain::from): the
    // status line is patched, then read again from its route (`corten: action`) until the write
    // is in, with no navigation; the button keeps focus, and a navigation away stops the reads.
    /** @type {string[]} */
    const again = [];
    const onAgain = (/** @type {import("@playwright/test").Request} */ r) =>
      r.method() === "GET" && r.url().includes("/alerts?saved=") && r.headers()["corten"] === "action" && again.push(r.url());
    page.on("request", onAgain);
    const save = 'form[action="/alerts"] button';
    /** When `submit` last asked for the key press that sends the alert, by the smoke's clock (`performance.now()`). */
    let pressedAt = 0;
    /**
     * Starts noting whether the status line says `Saving...` in a draw from now on (a mutation the
     * page makes after this, not the line as it is now), the moment it is drawn, so a wait started
     * after the press does not miss a `Saving...` the write's read has already replaced with
     * `Saved.`; `notedSaving` reads the note, the time the page drew it by its own monotonic clock
     * (`performance.now()` there). Armed before the press that draws it.
     */
    const noteSaving = () =>
      page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__smokeSavingSeen?.disconnect();
        w.__smokeSaving = false;
        const seen = new MutationObserver(() => {
          if (document.getElementById("alert-status")?.textContent !== "Saving...") return;
          w.__smokeSaving = performance.now();
          seen.disconnect();
        });
        w.__smokeSavingSeen = seen;
        seen.observe(document, { subtree: true, childList: true, characterData: true });
      });
    /** When the page noted `Saving...` drawn since `noteSaving` (`performance.now()` there), or false. */
    const notedSaving = () => page.evaluate(() => /** @type {number | false} */ ((/** @type {any} */ (window)).__smokeSaving));
    /**
     * Sends the alert from its form, until the page says `Saving...`, all within 30 s by the smoke's
     * clock, noting the moment just before it asks for the key press (`pressedAt`). `Saving...` is
     * noted by the page as it is drawn (`noteSaving`, armed before the press), and the note read
     * within the same budget. The 30 s are one budget (`steps`), checked as each step starts, so no
     * step starts once they have passed.
     */
    const submit = async () => {
      const sending = steps(30_000, "the alert was not sent and drawn saving within 30 s");
      await sending.step(() => page.fill("input[name=above]", "150"));
      await sending.step(() => page.focus(save));
      await sending.step(noteSaving);
      await sending.step(() => {
        pressedAt = performance.now();
        return page.keyboard.press("Enter");
      });
      await sending.poll(notedSaving);
    };
    await actWithin("the alerts page's load", page.goto(`${base}/alerts`));
    // A price the server refuses: the form comes back with the field marked and its message,
    // and focus on it.
    const errorsAtRefusal = errors.length;
    await actWithin("the refused price's fill", page.fill("input[name=above]", "1.234"));
    const refusedAt = performance.now();
    const belowFold = await readWithin("the refused form's press", page.locator(save).evaluate((button) => {
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
    }));
    // The field must be marked within 5 s of the press by the smoke's clock (`leftOf`), and still
    // marked in the sample the check judges, so a page that drew the message and focus without the
    // mark does not pass.
    const marked = await cameWithin(leftOf(refusedAt, 5000), page.waitForSelector('input[name=above][aria-invalid="true"]', { timeout: 5000 }));
    const refused = await readWithin("the refused field", page.evaluate(() => {
      const field = /** @type {HTMLInputElement | null} */ (document.querySelector("input[name=above]"));
      const rect = field?.getBoundingClientRect();
      const result = {
        invalid: field?.getAttribute("aria-invalid") === "true",
        message: document.getElementById("alert-form-above-error")?.textContent,
        focused: document.activeElement === field,
        value: field?.value,
        inView: !!rect && rect.bottom > 0 && rect.top < innerHeight && scrollY > 0,
      };
      document.getElementById("smoke-refusal-spacer")?.remove();
      return result;
    }));
    check(
      "a refused patch field below the fold comes back marked, with its message and focus in view",
      marked && refused.invalid && belowFold && refused.inView && refused.message === "Enter a price in dollars and cents, such as 129.99." && refused.focused && refused.value === "1.234",
      JSON.stringify({ belowFold, marked, ...refused }),
    );
    // The browser logs the 422 as a failed resource; Corten adds nothing.
    const refusedLogs = errors.slice(errorsAtRefusal);
    check("a refused field logs no console error of Corten's", refusedLogs.every((e) => e.includes("422")), refusedLogs.join(" | "));
    errors.splice(errorsAtRefusal);
    // The same refusal from a form with controls named after the members the runtime reads on it
    // (whether it is on the page and holds focus): focus goes from its button to the marked field.
    // Sent by keys: Playwright's own fill and click read the form's getAttribute.
    const errorsAtShadowed = errors.length;
    await readWithin("the shadowed form's controls", page.evaluate((names) => {
      const form = /** @type {Element} */ (document.getElementById("alert-form"));
      form.insertAdjacentHTML("afterbegin", __html(names.map((name) => `<input type="hidden" name="${name}" value="x" disabled>`).join("")));
      /** @type {HTMLInputElement} */ (Element.prototype.querySelector.call(form, "input[name=above]")).value = "1.235";
      /** @type {HTMLElement} */ (Element.prototype.querySelector.call(form, "button")).focus();
    }, shadowing));
    const shadowedAt = performance.now();
    await actWithin("the shadowed form's key press", page.keyboard.press("Enter"));
    const shadowRefused = await cameWithin(
      leftOf(shadowedAt, 5000),
      page.waitForFunction(
        () => {
          const field = document.querySelector('#alert-form input[name=above][aria-invalid="true"]');
          return !!field && document.activeElement === field && !document.querySelector("#alert-form input[name=hasAttribute]");
        },
        null,
        { timeout: 5000 },
      ),
    );
    const shadowLogs = errors.slice(errorsAtShadowed);
    check(
      "a refused field in a form with controls named after the members the runtime reads on it gets focus",
      shadowRefused && shadowLogs.every((e) => e.includes("422")),
      shadowLogs.join(" | "),
    );
    errors.splice(errorsAtShadowed);
    await readWithin("the page's mark", page.evaluate(() => ((/** @type {any} */ (window)).__marker = 7)));
    await submit();
    const patchedSoon = await savedSoon(pressedAt);
    const patchedTo = await readWithin("the status line after the wait for Saved.", saved());
    check(
      "a patch waiting for a write is read again from its route until the write is in",
      patchedSoon && patchedTo === "Saved." && again.length > 0 && page.url() === `${base}/alerts` && (await readWithin("the page's mark", page.evaluate(() => (/** @type {any} */ (window)).__marker === 7))),
      `${patchedTo}${patchedSoon ? "" : " (Saved. not seen within 6 s)"} after ${again.length} reads at ${page.url()}`,
    );
    check("reading a patch again keeps focus", await readWithin("the focused element", page.evaluate(() => document.activeElement?.textContent === "Save alert")));
    // The list read again with the status line shows the alert once it is in; a remove is a write
    // of its own, read again until the list no longer has it. The list is the browser's, kept under
    // its visitor cookie, which this browser does not send over http.
    /** Each alert listed, in order: its id (the remove form's `alert` field) and what it says. */
    const alertsListed = () =>
      readWithin(
        "the alerts listed",
        page.$$eval("#alert-list li", (items) =>
          items.map((li) => ({ id: /** @type {HTMLInputElement | null} */ (li.querySelector('form input[name="alert"]'))?.value ?? null, label: li.querySelector("span")?.textContent ?? null })),
        ),
      );
    if (signsIn) {
      // The writes above saved ACME at $175.00; this one, at $150.00, is the only such alert.
      const listedFirst = await alertsListed();
      const shown = listedFirst.map((a) => a.label);
      check("a saved alert is listed once it lands", shown.filter((s) => s === "ACME above $150.00").length === 1, shown.join(", "));
      // The last alert listed is removed by its own Remove button. `Saving...` noted by the page as it
      // is drawn (`noteSaving`, armed before the press), within 5 s of the press. Judged by the time
      // the page noted `Saving...` as it drew it, against the time the page noted the press as it
      // came, both by the page's monotonic clock (`performance.now()` there, which a step of the wall
      // clock does not move): the draw must come after the press and within 5 s of it. The press is
      // the first `click` on that alert's Remove button (its form's `alert` field is the alert's id),
      // heard by a capturing listener armed before it, ahead of any of the page's own; a click
      // anywhere else is not it. Looked for by that clock until 5 s from the press, each look reading
      // the note and the page's time in one task (`lookUntil`), so neither an arming or a press whose
      // answer comes back late nor a check that looks late fails a draw noted in time, and none noted
      // after the 5 s passes. The listener is removed (bounded) however the case ends, and an install
      // of it the page runs only after that removal does nothing. The alert pressed must be the one
      // that leaves: the list after is the list before without it, in order.
      const removed = listedFirst.at(-1)?.id ?? null;
      /** This run of the case's, so an install of its listener the page runs after its removal does nothing. */
      const pressToken = `${Date.now()}-${Math.random()}`;
      /** @type {number | null} */
      let pressedIn = null;
      /** @type {number | false | undefined} */
      let savingAt;
      let removedSoon = false;
      try {
        await readWithin("the page's note of Saving...", noteSaving());
        await readWithin(
          "the page's note of the press of the alert's Remove button",
          page.evaluate(({ id, token }) => {
            const w = /** @type {any} */ (window);
            if (w.__smokePressedRemoved === token) return;
            if (w.__smokePressedListener) removeEventListener("click", w.__smokePressedListener, { capture: true });
            w.__smokePressed = null;
            w.__smokePressedListener = (/** @type {Event} */ event) => {
              if (w.__smokePressed !== null || !(event.target instanceof Element)) return;
              const button = /** @type {HTMLButtonElement | null} */ (event.target.closest("#alert-list li form button"));
              if (id !== null && /** @type {HTMLInputElement | null} */ (button?.form?.querySelector('input[name="alert"]'))?.value === id) w.__smokePressed = performance.now();
            };
            addEventListener("click", w.__smokePressedListener, { capture: true });
          }, { id: removed, token: pressToken }),
        );
        const removedAt = performance.now();
        await actWithin("the press of the last alert's remove button", page.click("#alert-list li:last-child button"));
        pressedIn = await readWithin("the page's note of the press", page.evaluate(() => /** @type {number | null} */ ((/** @type {any} */ (window)).__smokePressed))).catch(() => null);
        savingAt =
          typeof pressedIn !== "number"
            ? undefined
            : await lookUntil(page, pressedIn + 5000, () => ({ origin: performance.timeOrigin, now: performance.now(), value: /** @type {number | false} */ ((/** @type {any} */ (window)).__smokeSaving) }));
        removedSoon = await savedSoon(removedAt);
      } finally {
        await within(
          5000,
          "the press listener of the removal case was not removed within 5 s",
          page.evaluate((token) => {
            const w = /** @type {any} */ (window);
            w.__smokePressedRemoved = token;
            if (w.__smokePressedListener) removeEventListener("click", w.__smokePressedListener, { capture: true });
            delete w.__smokePressedListener;
          }, pressToken),
        );
      }
      const removing = typeof pressedIn === "number" && typeof savingAt === "number" && savingAt >= pressedIn && savingAt <= pressedIn + 5000;
      const leftAlerts = await alertsListed();
      const left = leftAlerts.map((a) => a.label);
      const expected = listedFirst.filter((a) => a.id !== removed);
      const theOneLeft =
        removed !== null &&
        expected.length === listedFirst.length - 1 &&
        leftAlerts.length === expected.length &&
        leftAlerts.every((a, i) => a.id === expected[i].id && a.label === expected[i].label);
      const removedTo = await readWithin("the status line after the wait for Saved.", saved());
      check(
        "a removed alert leaves the list once the removal lands",
        removing && removedSoon && theOneLeft && removedTo === "Saved.",
        `${shown.length} -> ${left.length}, ${removedTo}${removing ? "" : typeof pressedIn !== "number" ? ` (the page noted no press of alert ${removed ?? "none"}'s Remove button)` : ` (Saving... not seen within 5 s of the press${typeof savingAt === "number" ? `: noted ${Math.abs(Math.round(savingAt - pressedIn))} ms ${savingAt < pressedIn ? "before" : "after"} it` : ""})`}${removedSoon ? "" : " (Saved. not seen within 6 s)"}${theOneLeft ? "" : ` (pressed alert ${removed ?? "none"}; listed before ${listedFirst.map((a) => a.id).join(", ") || "none"}, after ${leftAlerts.map((a) => a.id).join(", ") || "none"})`}`,
      );
    } else {
      for (const name of ["a saved alert is listed once it lands", "a removed alert leaves the list once the removal lands"]) skip(name, "the browser does not send Secure cookies over http");
    }
    // The save after the refusal above answered the whole form, so the field is no longer marked.
    const cleared = await readWithin("the field's error", page.evaluate(() => !document.querySelector("#alert-form [aria-invalid]") && !document.getElementById("alert-form-above-error")));
    check("a save after a refusal clears the field's error", cleared);
    const done = again.length;
    await pause(2200);
    check("it stops once the patch no longer asks", again.length === done, `${again.length - done} more reads`);
    await submit();
    await leaveForNews();
    const away = again.length;
    await pause(2200);
    check("navigating away stops a patch's reads", again.length === away, `${again.length - away} more reads`);
    // A read the server fails (its error page, not a patch) stops the reads without a console
    // error: the server logged the failure, and the part stays as it was. The press's read is the
    // first part read the check hears after the alert's own POST, itself heard from just before the
    // check asks for the key press (the smoke's clock, `pressedAt`) on, so a part read sent while the
    // case fills or focuses the form, before the press, is not taken for it. That read must be sent
    // within 5 s of the press, and its own 502 answer (the status of that request's response)
    // received in full (the browser finished loading that exact request) within 5 s of that read
    // being sent, each by the time the check heard of the event (`performance.now()` in its
    // listener), not when the check looked: an event heard after its 5 s fails the case, however soon
    // the check then sees it. Only then do the 2.2 s with no further read start, so a read still on
    // its way cannot pass for one that failed. The route and listeners are removed however the case
    // ends, each removal tried even if one before it fails.
    const errorsBefore = errors.length;
    /** Why the route's 502 for a read was not given as meant (`exchange`). @type {string[]} */
    const failFaults = [];
    /** Set as the case ends: the route lets each read through, and a 502 under way is not sent. */
    let failOver = false;
    const failRead = async (/** @type {import("@playwright/test").Route} */ route) => {
      if (failOver || route.request().headers()["corten"] !== "action") return letThrough(route);
      const asked = new URL(route.request().url());
      const ex = exchange(route, `the failing read route's 502 for ${asked.pathname}${asked.search}`, () => failOver);
      await ex.send(5000, "its fulfill", () => route.fulfill({ status: 502, contentType: "text/html", body: "<p>Bad gateway</p>" })).catch(() => {});
      if (ex.fault) failFaults.push(ex.fault);
    };
    /**
     * The alert's POSTs and the part reads the page sends while the case listens, in the order the
     * check heard them sent and when (`performance.now()` in the listener); each answer's status and
     * when the check heard it finished loading, by its request.
     * @type {{ request: import("@playwright/test").Request, at: number, post: boolean }[]}
     */
    const heard = [];
    /** @type {Map<import("@playwright/test").Request, number>} */
    const statusOf = new Map();
    /** @type {Map<import("@playwright/test").Request, number>} */
    const doneAt = new Map();
    // Every part read of the alerts page is heard, whatever its query (`?shown=2&saved=..` too), so
    // a read of another receipt, or one sent again at another address, counts against the case.
    const onFailing = (/** @type {import("@playwright/test").Request} */ r) => {
      const at = new URL(r.url());
      const alerts = at.origin === new URL(base).origin && at.pathname === "/alerts";
      const post = alerts && r.method() === "POST";
      const read = alerts && r.method() === "GET" && r.headers()["corten"] === "action";
      if (post || read) heard.push({ request: r, at: performance.now(), post });
    };
    const onFailingAnswer = (/** @type {import("@playwright/test").Response} */ res) => statusOf.has(res.request()) || statusOf.set(res.request(), res.status());
    const onFailingDone = (/** @type {import("@playwright/test").Request} */ r) => doneAt.has(r) || doneAt.set(r, performance.now());
    /** The press's POST: the first heard from `pressedAt` on, or undefined. */
    const pressPost = () => heard.find((h) => h.post && h.at >= pressedAt);
    /** The press's read: the first part read heard after the first POST heard from `pressedAt` on, or null while there is none. */
    const pressRead = () => {
      const post = heard.findIndex((h) => h.post && h.at >= pressedAt);
      return post < 0 ? null : (heard.slice(post + 1).find((h) => !h.post) ?? null);
    };
    /** A heard read's address (path and query). @param {{ request: import("@playwright/test").Request }} h */
    const addressOf = (h) => new URL(h.request.url()).pathname + new URL(h.request.url()).search;
    /**
     * The receipt the press's POST answer asks to be read again from: its read-again template's
     * `data-from`, as a full URL, origin included; null if that answer was not read within 5 s or
     * names none. The answer is the one at the end of the POST's redirects (WebKit over http can be
     * sent on with a 307, whose own body Playwright does not keep), parsed in the page as the runtime
     * parses a patch (a template's `innerHTML`, `readAgainFault` above): the tag is the last top-level
     * element with `data-corten-read-again`, the one the runtime keeps, and its `data-from` is
     * resolved against the document's base URL, as the runtime's `fetch` resolves it, so a tag in a
     * comment is none and a `data-from` of another origin is not this page's receipt.
     * @param {import("@playwright/test").Request | undefined} post
     */
    const receiptOf = async (post) => {
      if (!post) return null;
      const body = await readWithin(
        "the press's POST answer",
        (async () => {
          let request = post;
          for (;;) {
            const res = await request.response();
            const next = request.redirectedTo();
            if (res === null || next === null) return res === null ? null : res.text();
            request = next;
          }
        })(),
      ).catch(() => null);
      if (body === null) return null;
      return readWithin(
        "the press's POST answer's read-again tag",
        page.evaluate((answer) => {
          const template = document.createElement("template");
          template.innerHTML = /** @type {any} */ (window).__html(answer);
          const again = Array.from(template.content.children).filter((el) => el.hasAttribute("data-corten-read-again")).at(-1);
          const from = again?.getAttribute("data-from");
          if (from == null) return null;
          const at = new URL(from, document.baseURI);
          at.hash = "";
          return at.href;
        }, body),
      ).catch(() => null);
    };
    try {
      await within(5000, "the failing read's route was not set within 5 s", page.route("**/alerts?saved=*", failRead));
      await within(30_000, "the alerts page was not loaded within 30 s", page.goto(`${base}/alerts`));
      page.on("request", onFailing);
      page.on("response", onFailingAnswer);
      page.on("requestfinished", onFailingDone);
      await submit();
      const sentBy = pressedAt + 5000;
      if (pressRead() === null) await pollAsync(Math.max(0, sentBy - performance.now()), async () => pressRead() !== null);
      // The read must be of the receipt the press's own POST answer named, so a read of an older
      // receipt (a timer of an earlier write's) answered 502 is not taken for it.
      const receipt = await receiptOf(pressPost()?.request);
      const first = pressRead();
      const read = first !== null && receipt !== null && first.request.url() === receipt ? first : null;
      const failing = read?.request ?? null;
      const failingAt = read?.at ?? 0;
      const sent = read !== null && failingAt > pressedAt && failingAt <= sentBy;
      const finishedBy = failingAt + 5000;
      if (sent && failing !== null && !doneAt.has(failing)) await pollAsync(Math.max(0, finishedBy - performance.now()), async () => doneAt.has(failing));
      const failingDoneAt = failing === null ? null : (doneAt.get(failing) ?? null);
      const failingStatus = failing === null ? null : (statusOf.get(failing) ?? null);
      const finished = sent && failingDoneAt !== null && failingDoneAt <= finishedBy;
      const answered = finished && failingStatus === 502;
      const early = heard.filter((h) => !h.post && h.at < pressedAt).length;
      if (answered) await pause(2200);
      // Every part read of the alerts page heard from the press on, whatever its address, as the log
      // stands once the 2.2 s have passed: the press's read must be the only one (one sent before the
      // press is named apart, `early`).
      const others = heard.filter((h) => !h.post && h.at >= pressedAt && h.request !== failing).map((h) => `${addressOf(h)} (${Math.round(h.at - pressedAt)} ms after the press)`);
      // The browser itself reports the 502 as a failed resource; Corten adds nothing.
      const logged = errors.slice(errorsBefore).filter((e) => !e.includes("502"));
      const late = (/** @type {number} */ at, /** @type {number} */ from) => `${Math.round(at - from)} ms after`;
      const failure =
        receipt === null
          ? `no receipt read from the press's POST answer${pressPost() ? "" : " (no POST heard from the press on)"}`
          : failing === null
          ? first !== null
            ? `the first part read after the press's POST was of ${first.request.url()}, not its receipt ${receipt}`
            : `no part read sent after the press's POST${heard.some((h) => h.post && h.at >= pressedAt) ? "" : " (no POST heard from the press on)"} within 5 s of the press`
          : !sent
            ? `its part read sent ${late(failingAt, pressedAt)} the press, not within 5 s`
            : answered
              ? "its 502 received"
              : failingDoneAt === null
                ? `its answer ${failingStatus === null ? "not come" : `with status ${failingStatus}`}, not finished loading within 5 s of its read`
                : !finished
                  ? `its answer finished loading ${late(failingDoneAt, failingAt)} its read, not within 5 s`
                  : `its answer with status ${failingStatus}, not 502`;
      check(
        "a read the server fails stops the reads, without a console error",
        answered && others.length === 0 && failFaults.length === 0 && (await readWithin("the status line", saved())) === "Saving..." && logged.length === 0,
        `${failFaults.length ? `${failFaults.join("; ")}; ` : ""}${failure}; ${others.length} other part reads${others.length ? ` (${others.join(", ")})` : ""}${early ? `, ${early} sent before the press` : ""}, ${logged.join(" | ")}`,
      );
      errors.splice(errorsBefore);
    } finally {
      failOver = true;
      await cleanUp(
        () => within(5000, "the failing read's route was not removed within 5 s", page.unroute("**/alerts?saved=*", failRead)),
        () => page.off("request", onFailing),
        () => page.off("response", onFailingAnswer),
        () => page.off("requestfinished", onFailingDone),
        () => page.off("request", onAgain),
      );
    }
  }

  // data-reload: the link loads the whole document instead of swapping <main>.
  await readWithin("the reload link's addition", page.evaluate(() => {
    (/** @type {any} */ (window)).__marker = 4;
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<a id="reload-link" href="/" data-reload>Home</a>'));
  }));
  await actWithin("the press of the reload link", page.click("#reload-link"));
  await within(30_000, "the reloaded Stocks page was not drawn within 30 s", page.waitForFunction(() => document.title === "Stocks | Watchlist"));
  check("data-reload loads the whole document", await readWithin("the page's mark", page.evaluate(() => (/** @type {any} */ (window)).__marker === undefined)));
}
