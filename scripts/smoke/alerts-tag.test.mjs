// Focused DOM controls for the Firefox alerts smoke. No server needed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { firefox } from "@playwright/test";
import { alertsReadFixture, askingInPlace, captureAlertsDraw, pageRefresh } from "./page-refresh.mjs";
import { base, within } from "./helpers.mjs";

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
    request: () => ({ method: () => "GET", headers: () => ({}), isNavigationRequest: () => true }),
    fetch: () => response.promise, abort: async () => { aborted = true; },
  });
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
