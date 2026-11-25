import { base, shadowing, skip, check, within, steps, pollFor, cleanUp } from "./helpers.mjs";

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
      const url = await pending();
      // The write lands 1.5 s after it is sent and the part is first read 1 s after the page has
      // loaded, so a loaded browser's first read can find it landed, and then no answer asks again
      // (#2035). The first read is then answered as the server answers one while the write lands:
      // its status line saying so, and the tag asking again from the same address. A later read is
      // the server's own.
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
      const partRead = async (/** @type {import("@playwright/test").Route} */ route) => {
        const request = route.request();
        if (over || request.method() !== "GET" || request.headers()["corten"] !== "action") return route.fallback();
        const at = answers.length;
        const asked = new URL(request.url());
        const address = asked.pathname + asked.search;
        answers.push({ url: address, asks: false, standIn: false });
        answered.push(request);
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
          const waiting = await saved();
          await page.fill("input[name=above]", "123.45");
          await within(
            5000,
            "the page was not marked within 5 s",
            page.evaluate(() => ((/** @type {any} */ (window)).__marker = 8)),
          );
          const entries = await page.evaluate(() => history.length);
          // The check that the part stops needs `Saved.` drawn within 5 s from here, the wait below
          // included: by the draw's own time, recorded by the page.
          const savedBy = Date.now() + 5000;
          await savedSoon();
          check(
            "a page's part waiting for a write is read again after a full load, not the page",
            waiting === "Saving..." && (await saved()) === "Saved." && initial !== null && parts().length > 0 && whole().length === 0 && page.url() === url,
            `${waiting} -> ${await saved()} after ${parts().length} part and ${whole().length} page reads${whole().length ? ` (${whole().map((e) => address(e)).join(", ")})` : ""}${prefetches().length ? `, and ${prefetches().length} prefetches not counted (${prefetches().map((e) => address(e)).join(", ")})` : ""}${initial ? "" : " (the document loaded not seen)"}`,
          );
          const kept = await page.evaluate(() => ({
            marker: (/** @type {any} */ (window)).__marker,
            entries: history.length,
            above: /** @type {HTMLInputElement | null} */ (document.querySelector("input[name=above]"))?.value,
          }));
          check("reading a page's part keeps the document, its history entry and the form", kept.marker === 8 && kept.entries === entries && kept.above === "123.45", JSON.stringify(kept));
          // The part's answer that asked again put its tag in the page's tag's place: one tag, the
          // last read's, and not the page's own (whose address is the same here). And the tag on the
          // page is the one its next read is made from: the first drawn answer's, moved to
          // `movedFrom` as it was drawn, sends the read after that answer's to `movedFrom`, where a
          // read made from the answer's own tag, as it came, would go to `from`. The read after is the
          // one the page sent next after that answer's own read, by the log, prefetches aside: a read
          // the stand-in did not answer (another address) comes between them too.
          const tagged = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll("main template[data-corten-read-again][data-from]"));
            const first = (/** @type {any} */ (window)).__pageTag;
            return {
              tags: all.map((t) => new URL(/** @type {string} */ (t.getAttribute("data-from")), location.href).href),
              pageTag: !!first,
              pageTagGone: !!first && !first.isConnected && !all.includes(first),
              moved: /** @type {string | undefined} */ ((/** @type {any} */ (window)).__moved) ?? null,
            };
          });
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
          // after that answer's own read in the log, whatever its address: a read sent between the
          // draw and the check seeing it counts against it, as does one at the end of the 2.2 s. A
          // hover prefetch is no read again, and is named but not counted.
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
                : `${later.length} reads after the read whose answer first drew Saved. (${drawn?.read}), to 2.2 s after that draw: ${later.join(", ") || "none"}${prefetched.length ? `; prefetches not counted: ${prefetched.join(", ")}` : ""}`
              : `no answer that does not ask again was the first to draw Saved., within 5 s (${JSON.stringify({ first, answers })})`,
          );
        } finally {
          over = true;
          await within(5000, "the part route was not removed within 5 s", page.unroute(partReads, partRead));
        }
        if (swaps) {
          const from = parts().length;
          const wholeFrom = whole().length;
          await go(await pending());
          await savedSoon();
          check(
            "a page's part reached by the runtime's navigation is read again, not the page",
            (await saved()) === "Saved." && parts().length > from && whole().length - wholeFrom === 1,
            `${await saved()} after ${parts().length - from} part reads, ${whole().length - wholeFrom} page loads (the navigation's)`,
          );
          // Away before the read: the runtime's navigation leaves the page, and its part is not read.
          await go(await pending());
          const left = parts().length;
          await page.click('header a[href="/news"]');
          await page.waitForFunction(() => document.title === "News | Watchlist");
          await page.waitForTimeout(2200);
          check("navigating away stops a page's part reads", parts().length === left, `${parts().length - left} more reads`);
        } else {
          for (const name of ["a page's part reached by the runtime's navigation is read again, not the page", "navigating away stops a page's part reads"]) skip(name, noSwaps);
        }
      } finally {
        /** Whether the init script's removal was confirmed. */
        let removed = false;
        await cleanUp(
          () => page.off("request", onPart),
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
    const wholeOnly = async (/** @type {import("@playwright/test").Route} */ route) => {
      if (route.request().headers()["corten"] === "action") return route.fallback();
      const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
      const headers = res.headers();
      delete headers["content-encoding"];
      delete headers["content-length"];
      const body = asWhole(await res.text());
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
