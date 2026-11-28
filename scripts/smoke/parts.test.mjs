// Run in the pinned Playwright image: SMOKE_PARTS_ENGINE=chromium node --test scripts/smoke/parts.test.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium, firefox, webkit } from "@playwright/test";
import { followPicks } from "./parts.mjs";

const rows = '<ul id="picks"><li>One</li><li>Two</li></ul>';
const html = (body) => ({ contentType: "text/html", body });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const answerMs = 4000;
const drawMs = 2000;

test("the failed-part link's smoke checks the first click and its answer", { concurrency: 2 }, async (t) => {
  const engines = { chromium, firefox, webkit };
  const engine = process.env.SMOKE_PARTS_ENGINE ?? "chromium";
  const controls = process.env.SMOKE_PARTS_CONTROLS ?? "all";
  assert.ok(controls === "all" || controls === "browser", `unknown parts controls: ${controls}`);
  const browser = await engines[engine].launch();
  t.after(() => browser.close());
  await Promise.all([
    { name: "one successful click", mode: "good", browserSensitive: true, clicks: 1, requests: ["click"] },
    { name: "a whole document can answer the click", mode: "document", browserSensitive: true, clicks: 1, requests: ["click"] },
    { name: "a corten: page fetch can answer the click", mode: "page", browserSensitive: true, clicks: 1, requests: ["click"] },
    { name: "an answer can finish more than three seconds after the click", mode: "slow", clicks: 1, requests: ["click"] },
    { name: "a missing activation target keeps Playwright's timeout", mode: "missing-at-press", browserSensitive: true, answerMs, failure: /keyboard activation of the link failed.*Timeout/, clicks: 0, requests: [] },
    { name: "a pointer cover does not block keyboard activation", mode: "covered", browserSensitive: true, clicks: 1, requests: ["click"] },
    { name: "keyboard activation fetches the page without triggering hover prefetch", mode: "no-hover", browserSensitive: true, clicks: 1, requests: ["click"] },
    { name: "a swallowed first click is not made again", mode: "swallow", answerMs, failure: /no answer.*0 click requests/, clicks: 1, requests: [] },
    { name: "a hover that draws the right page cannot stand in for a swallowed click", mode: "hover-draw", answerMs, failure: /no answer.*0 click requests/, clicks: 1, requests: ["prefetch"] },
    { name: "an unlabelled hover that draws the right page cannot stand in for a swallowed click", mode: "unlabelled-hover-draw", browserSensitive: true, failure: /no answer.*0 click requests/, clicks: 1, requests: ["hover"] },
    { name: "a delayed hover cannot supply the answer to a swallowed activation", mode: "delayed-hover", browserSensitive: true, answerMs, failure: /no answer.*0 click requests/, clicks: 1, requests: [] },
    { name: "a response delivered before the activation witness is read is accepted", mode: "delayed-witness", browserSensitive: true, clicks: 1, requests: ["click"] },
    { name: "the Watchlist link must have exactly the expected query", mode: "wrong-query", failure: /the waiting part links to .*unexpected=1.*expected .*\?picks=true/, clicks: 0, requests: [] },
    { name: "a failed first navigation is not replaced by a second click", mode: "first-503", failure: /"status":503/, clicks: 1, requests: ["click"] },
    { name: "a good unused prefetch cannot hide the click's 503 and stale picks", mode: "stale", failure: /no answer.*"status":503/, clicks: 1, requests: ["prefetch", "click"] },
    { name: "a held prefetch body does not delay the click's good answer", mode: "held-prefetch", browserSensitive: true, clicks: 1, requests: ["prefetch", "click"] },
    { name: "a held click body is reported as unread", mode: "held-click", browserSensitive: true, answerMs, failure: /body not read in time/, clicks: 1, requests: ["click"] },
    { name: "the answer deadline starts at click invocation, not click settlement", mode: "late-click-body", answerMs, failure: /body not read in time/, clicks: 1, requests: ["click"] },
    { name: "a complete body without the picks is reported as such", mode: "no-picks", failure: /body lacks the picks/, clicks: 1, requests: ["click"] },
    { name: "one pick is not enough", mode: "one-pick", failure: /body lacks the picks.*"items":1/, clicks: 1, requests: ["click"] },
    { name: "two picks plus a read template are not a complete answer", mode: "read-template", failure: /body lacks the picks.*"readNow":true/, clicks: 1, requests: ["click"] },
    { name: "an aborted click request is not a missing body", mode: "abort", browserSensitive: true, failure: /"body":"(?!no response|body not read in time)[^"]+"/, clicks: 1, requests: ["click"] },
    { name: "the right address with different rows is not a draw of the answer", mode: "different-rows", drawMs, failure: /were not drawn.*Stale/, clicks: 1, requests: ["click"] },
    { name: "the right rows at another address are not a draw there", mode: "wrong-address", drawMs, failure: /were not drawn.*\/wrong/, clicks: 1, requests: ["click"] },
    { name: "a part read can have supplied the visible rows", mode: "part-read", drawMs, failure: /were not drawn.*1 part reads/, clicks: 1, requests: ["click", "action"] },
  ].filter(({ browserSensitive }) => controls === "all" || browserSensitive).map(({ name, mode, failure, clicks, requests, answerMs: answerBudget, drawMs: drawBudget }) =>
    t.test(name, { timeout: 30_000 }, async (t) => {
      const asked = [];
      let clickStarted;
      let release;
      // A route can fulfill a whole body, but cannot leave it open. Send headers and the start of
      // an HTML body so Firefox exposes the Response too, then hold its text() open.
      const server = createServer((req, res) => {
        asked.push(req.headers.purpose === "prefetch" ? "prefetch" : "click");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
        res.write(`<!--${" ".repeat(1024)}-->`);
        if (mode === "late-click-body") release = setTimeout(() => res.end(rows), Math.max(0, clickStarted + answerMs + 750 - performance.now()));
      });
      t.after(() => {
        clearTimeout(release);
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${server.address().port}`;
      const page = await browser.newPage();
      t.after(() => page.close());
      if (mode === "delayed-witness") {
        // If attribution uses a console witness, deliver it only after the real response event.
        const emit = page.emit.bind(page);
        let delayed;
        let responded = false;
        page.emit = (event, message, ...args) => {
          if (!responded && event === "console" && message.text().startsWith("picks click ")) {
            delayed = () => emit(event, message, ...args);
            return true;
          }
          const result = emit(event, message, ...args);
          if (event === "response" && message.request().headers().corten === "nav") {
            responded = true;
            delayed?.();
            delayed = undefined;
          }
          return result;
        };
        const press = page.press.bind(page);
        page.press = async (...args) => {
          // Both network events must reach the helper before the press can return and it can
          // read the page witness. Do not delay the request, the response, or the click itself.
          await Promise.all([
            page.waitForResponse((r) => r.request().headers().corten === "nav", { timeout: args[2]?.timeout }),
            press(...args),
          ]);
        };
      }
      if (mode === "missing-at-press") {
        const press = page.press.bind(page);
        page.press = async (...args) => {
          await page.locator("#picks a").evaluate((a) => a.remove());
          await press(...args);
        };
      }
      if (mode === "late-click-body") {
        const press = page.press.bind(page);
        page.press = async (...args) => {
          clickStarted = performance.now();
          await press(...args);
          // Model Playwright waiting after dispatch. The body ends after the click-start deadline,
          // but within a fresh budget started when this call settles.
          await pause(answerMs / 2);
        };
      }
      const cover = mode === "covered" ? '<div style="position:fixed;inset:0"></div>' : "";
      const target = `/?picks=true${mode === "wrong-query" ? "&unexpected=1" : ""}`;
      await page.route(`${base}/`, (route) => route.fulfill(html(`<div id="picks"><a href="${target}">See picks</a></div>${cover}`)));
      await page.route(`${base}/part`, (route) => {
        asked.push("action");
        return route.fulfill(html(rows));
      });
      await page.route(`${base}${target}`, async (route) => {
        const prefetch = route.request().headers().purpose === "prefetch";
        const hover = ["unlabelled-hover-draw", "delayed-hover"].includes(mode);
        if ((prefetch && mode === "held-prefetch") || (!prefetch && ["held-click", "late-click-body"].includes(mode))) return route.fallback();
        asked.push(prefetch ? "prefetch" : hover ? "hover" : "click");
        if (!prefetch && (mode === "stale" || (mode === "first-503" && asked.length === 1))) return route.fulfill({ status: 503, ...html("Unavailable") });
        if (mode === "abort") return route.abort();
        if (mode === "one-pick") return route.fulfill(html('<ul id="picks"><li>One</li></ul>'));
        if (mode === "read-template") return route.fulfill(html(`${rows}<template data-corten-read-now></template>`));
        if (mode === "slow") await pause(3500);
        return route.fulfill(html(mode === "no-picks" ? "No picks" : rows));
      });
      await page.goto(base);
      await page.evaluate(({ mode, rows }) => {
        sessionStorage.clicks = "0";
        sessionStorage.pointerEvents = "0";
        const link = document.querySelector("#picks a");
        for (const type of ["pointerover", "pointerenter"]) {
          link.addEventListener(type, () => { sessionStorage.pointerEvents++; });
        }
        const hoverDraws = ["hover-draw", "unlabelled-hover-draw", "delayed-hover"].includes(mode);
        let prefetched;
        if (hoverDraws || ["stale", "held-prefetch", "no-hover"].includes(mode)) {
          link.addEventListener("pointerover", async () => {
            // These fixtures deliberately fetch on hover even if prefetch is disabled.
            if (mode === "delayed-hover") {
              while (sessionStorage.clicks === "0") await new Promise(requestAnimationFrame);
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            prefetched = fetch(link.href, { headers: ["unlabelled-hover-draw", "delayed-hover"].includes(mode) ? { corten: "nav" } : { corten: "nav", purpose: "prefetch" } });
            if (hoverDraws) {
              void prefetched.then(async (answer) => {
                const body = await answer.text();
                // Let the click land before replacing its target. Only hover fetches and draws.
                while (sessionStorage.clicks === "0") await new Promise(requestAnimationFrame);
                document.querySelector("#picks").outerHTML = body;
                history.pushState(null, "", link.href);
              });
            }
          }, { once: true });
        }
        document.addEventListener("click", async (event) => {
          if (event.target !== link) return;
          const n = ++sessionStorage.clicks;
          if (mode === "document") return;
          event.preventDefault();
          if (n === 1 && (mode === "swallow" || mode === "first-503")) event.stopImmediatePropagation();
          if ((mode === "swallow" && n === 1) || hoverDraws) return;
          if (prefetched) await prefetched; // At least headers, before the click's answer.
          const answer = await fetch(link.href, { headers: { corten: mode === "page" ? "page" : "nav" } }).catch(() => null);
          if (!answer) return;
          if (!answer.ok && mode !== "stale") return;
          const body = mode === "part-read" ? await fetch("/part", { headers: { corten: "action" } }) : answer;
          document.querySelector("#picks").outerHTML = mode === "stale" ? rows : mode === "different-rows" ? rows.replace("One", "Stale") : await body.text();
          history.pushState(null, "", mode === "wrong-address" ? "/wrong" : link.href);
        }, { capture: true });
      }, { mode, rows });
      // Supply overlap explicitly in the existing prefetch controls; followPicks no longer
      // moves the pointer. For the unlabelled one, start it inside the observation window but
      // before the key press, so rejecting it really tests the request-start fence.
      const hovering = () => page.waitForRequest(`${base}${target}`, { timeout: answerMs });
      if (["hover-draw", "stale", "held-prefetch"].includes(mode)) {
        await Promise.all([hovering(), page.hover("#picks a", { timeout: answerMs })]);
      }
      if (mode === "unlabelled-hover-draw") {
        const press = page.press.bind(page);
        page.press = async (...args) => {
          // Dispatch only the fixture event, without Playwright's pointer-action waits.
          await Promise.all([
            hovering(),
            page.evaluate(() => document.querySelector("#picks a").dispatchEvent(new PointerEvent("pointerover"))),
          ]);
          await press(...args);
        };
      }
      const result = await followPicks(page, { answerMs: answerBudget, drawMs: drawBudget });
      const actualClicks = await page.evaluate(() => Number(sessionStorage.clicks));
      t.diagnostic(`${actualClicks} click(s), requests ${JSON.stringify(asked)}, ${result || "accepted"}`);
      if (["hover-draw", "unlabelled-hover-draw"].includes(mode)) {
        assert.equal(page.url(), `${base}${target}`);
        assert.deepEqual(await page.locator("ul#picks li").allTextContents(), ["One", "Two"]);
      }
      if (failure) assert.match(result, failure);
      else assert.equal(result, "");
      assert.equal(actualClicks, clicks);
      assert.deepEqual(asked, requests);
      if (["no-hover", "delayed-hover"].includes(mode)) {
        assert.equal(await page.evaluate(() => Number(sessionStorage.pointerEvents)), 0);
      }
    }),
  ));
});
