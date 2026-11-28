// Focused browser controls for the alerts smoke. No running watchlist needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { chromium, firefox } from "@playwright/test";
import { retrying } from "../steady.mjs";
import { alertsReadFixture, askingInPlace, captureAlertsDraw, pageRefresh } from "./page-refresh.mjs";
import { base, within } from "./helpers.mjs";

for (const [name, wrong] of [
  ["an explicit retried alerts load stays pending without counting either document", ""],
  ["a runtime nav read during the recovered alerts load still counts", "nav"],
  ["a real document reload with the explicit Referer during alerts setup still counts", "reload"],
]) test(name, { timeout: 30_000 }, async (t) => {
  const reload = wrong === "reload";
  const browser = await (reload ? firefox : chromium).launch();
  t.after(() => browser.close());
  const runtime = readFileSync(new URL("../../crates/corten/js/dist/corten.js", import.meta.url));
  const runtimeRead = Promise.withResolvers();
  let fixtureReads = 0;
  const server = createServer((req, res) => {
    if (req.url === "/corten.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(runtime);
    if (req.headers.corten === "nav") {
      runtimeRead.resolve();
      return; // Keep the read pending until the page closes, so no later draw changes the evidence.
    }
    const fixture = req.url.startsWith("/smoke/alerts/saving?");
    if (fixture) ++fixtureReads;
    else if (reload && req.url.startsWith("/alerts?")) runtimeRead.resolve();
    res.setHeader("content-type", "text/html");
    const head = wrong ? '<noscript data-corten-read-again="0.1"></noscript><script type="module" src="/corten.js"></script>' : "";
    res.end(fixture ? `<!doctype html><head>${head}</head><main><p>Saving...</p></main>` : "<p>Saved.</p>");
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise((done) => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}/alerts?saved=1`;
  const page = await browser.newPage();
  if (reload) await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined }));
  else retrying(page, "net::ERR_CONNECTION_REFUSED");
  const fixture = alertsReadFixture(url);
  page.on("request", fixture.onPart);
  await page.route(url, fixture.saving);
  if (!reload) await page.route(url, (route) => {
    // Refuse the browser response only after the pending fixture was selected.
    t.mock.method(route, "fulfill", () => route.abort("connectionrefused"));
    return route.fallback();
  }, { times: 1 });
  try {
    await fixture.goto({ goto: async (...args) => {
      const response = await page.goto(...args);
      // Model a delayed goto acknowledgement: the runtime's own read has started before
      // the test receives its response or opens either part gate.
      if (wrong) await within(5000, "runtime did not read the page", runtimeRead.promise);
      return response;
    } });
    if (reload) await page.waitForFunction(() => document.querySelector("p")?.textContent === "Saved.", null, { timeout: 5000 });
    assert.equal(await page.locator("p").textContent(), reload ? "Saved." : "Saving...");
    assert.equal(fixtureReads, reload ? 1 : 2);
    assert.deepEqual([...fixture.whole].map((r) => r.isNavigationRequest() ? "reload" : r.headers().corten), wrong ? [wrong] : []);
    if (reload) assert.equal([...fixture.whole][0].headers().referer, url.replace("/alerts?", "/smoke/alerts/saving?"));
  } finally {
    page.off("request", fixture.onPart);
    await fixture.close(page);
    await page.close();
  }
});

test("a body failure aborts and drains an actual held Firefox alerts read without starting its fixture", { timeout: 30_000 }, async (t) => {
  const browser = await firefox.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(`${base}/start`, (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
  await page.goto(`${base}/start`);
  const reset = createServer((req) => req.socket.destroy());
  await new Promise((ready) => reset.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise((done) => reset.close(done)));
  const held = Promise.withResolvers();
  const primary = new Error("body failed with the first part held");
  const secondary = new Error("abort acknowledgement lost");
  const logged = t.mock.method(console, "error", () => {});
  let fetches = 0, aborts = 0, settled = false, escaped;
  const failingPage = {
    evaluate: async () => "/alerts?saved=1", on: page.on.bind(page), off: page.off.bind(page),
    route: (url, handler) => page.route(url, async (route) => {
      const fetch = route.fetch.bind(route);
      t.mock.method(route, "fetch", () => {
        ++fetches;
        return fetch({ url: `http://127.0.0.1:${reset.address().port}/reset`, timeout: 2000 });
      });
      const abort = route.abort.bind(route);
      t.mock.method(route, "abort", async () => {
        ++aborts;
        await abort();
        throw secondary;
      });
      const work = handler(route);
      held.resolve();
      try { await work; } catch (error) { escaped = error; } finally { settled = true; }
    }),
    unroute: (url) => page.unroute(url),
    goto: async (url) => {
      await page.evaluate((url) => {
        window.heldRead = fetch(url, { headers: { corten: "action" } }).then(() => false, () => true);
      }, url);
      await within(3000, "first Firefox read did not enter its handler", held.promise);
      throw primary;
    },
  };
  await assert.rejects(pageRefresh(failingPage, false, false, [], false), (error) => error === primary);
  assert.equal(fetches, 0, "teardown must not start a fixture fetch");
  assert.equal(aborts, 1);
  assert.ok(logged.mock.calls.some(({ arguments: args }) => args.includes(secondary)));
  assert.equal(settled, true, "case returned before its held callback settled");
  assert.equal(escaped, undefined);
  assert.equal(await within(3000, "browser request still held", page.evaluate(() => window.heldRead)), true);
});

test("an in-flight fixture failure fails clean teardown, not Playwright's detached callback", async () => {
  const url = `${base}/alerts?saved=1`;
  const fixture = alertsReadFixture(url);
  const reset = new Error("ECONNRESET during fixture fetch");
  const response = Promise.withResolvers();
  const fetching = Promise.withResolvers();
  let aborts = 0;
  const work = fixture.saving({
    request: () => ({ method: () => "GET", headers: () => ({ corten: "action" }) }),
    fetch: () => { fetching.resolve(); return response.promise; }, abort: async () => { ++aborts; },
  });
  fixture.first.resolve();
  await fetching.promise;
  const closing = fixture.close({ unroute: async () => {} });
  // Reset only after unroute and entry into the drain; do not rely on a pre-existing error.
  await new Promise((done) => setImmediate(done));
  response.reject(reset);
  await assert.rejects(closing, (error) => error === reset);
  await work;
  assert.equal(aborts, 1);
});

test("a stalled fixture has a bounded drain and a late rejection remains handled", { timeout: 10_000 }, async () => {
  const fixture = alertsReadFixture(`${base}/alerts?saved=1`);
  const response = Promise.withResolvers();
  let aborted = false;
  const work = fixture.saving({
    request: () => ({ method: () => "GET", headers: () => ({ corten: "action" }) }),
    fetch: () => response.promise, abort: async () => { aborted = true; },
  });
  fixture.first.resolve();
  await new Promise((done) => setImmediate(done));
  await assert.rejects(fixture.close({ unroute: async () => {} }), /drain the alerts route callbacks/);
  response.reject(new Error("socket closed after the case ended"));
  await work;
  assert.equal(aborted, true);
});

test("a cleanup failure does not replace the original alerts failure", async (t) => {
  const first = new Error("navigation failed");
  const cleanup = new Error("unroute failed");
  const logged = t.mock.method(console, "error", () => {});
  const page = {
    evaluate: async () => "/alerts?saved=1", on() {}, off() {}, route() {},
    goto: async () => { throw first; }, unroute: async () => { throw cleanup; },
  };
  await assert.rejects(pageRefresh(page, false, false, [], false), (error) => error === first);
  assert.ok(logged.mock.calls.some(({ arguments: args }) => args.includes(cleanup)));
});

test("only the asking tag drawn into the original slot counts", { timeout: 30_000 }, async (t) => {
  const browser = await firefox.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const url = "http://localhost/alerts?saved=1";
  for (const where of ["slot", "wrong-parent", "wrong-sibling", "missing"]) {
    await page.setContent(`<main><p id="alert-status">Saving...</p><div><i></i><template data-corten-read-again="1" data-from="${url}"></template></div></main>`);
    const read = await page.evaluateHandle(captureAlertsDraw);
    try {
      const draw = await page.evaluate(({ read, where }) => {
        const status = document.querySelector("p");
        status.replaceWith(status.cloneNode(true));
        const tag = document.querySelector("template");
        const replacement = tag.cloneNode(true);
        tag.replaceWith(replacement);
        if (where === "wrong-parent") document.querySelector("main").append(replacement);
        if (where === "wrong-sibling") document.querySelector("div").prepend(replacement);
        if (where === "missing") replacement.parentNode.removeChild(replacement);
        return read();
      }, { read, where });
      assert.ok(draw && draw.pageTagGone);
      assert.equal(draw.status, "Saving...");
      assert.deepEqual(draw.tags, where === "missing" ? [] : [url]);
      assert.equal(askingInPlace(draw, url), where === "slot", where);
    } finally {
      await read.dispose();
    }
  }
});
