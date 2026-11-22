import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createLiveWorkload } from "../workloads/live.mjs";
import { portFor, settingsFor } from "./native.mjs";
import { browserJourney, openAdapterBrowser } from "./parity.mjs";
import { wireEvents } from "./wire.mjs";

const group = "live-delivery", workload = createLiveWorkload({ seed: 17, rowCount: 2, eventCount: 1 });
const settings = settingsFor(group, "normal");
const pages = {
  express: '<title>Express fixture</title><table><tbody id="rows"></tbody></table><output id="effects">0</output><script src="/client.js"></script>',
  aspnet: await readFile(new URL("./apps/aspnet/wwwroot/index.html", import.meta.url), "utf8"),
};

// The real adapter clients receive one normal update on loopback. This stub
// does not start application images, collect timings, or qualify either port.
async function fixture(t, app) {
  const client = await readFile(new URL(`./apps/${app}/${app === "aspnet" ? "wwwroot/" : ""}client.js`, import.meta.url));
  let stream, last;
  const resources = () => {
    const attached = Number(!!stream);
    return { subscriptions: attached, connections: attached, pendingTasks: attached, queueEvents: 0, queuePeak: 0,
      historyEvents: Number(!!last), historyPeak: Number(!!last), queueLimit: settings.queueLimit, historyLimit: settings.historyLimit };
  };
  const send = (kind, data) => stream?.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  const server = createServer(async (req, res) => {
    const body = async () => JSON.parse(Buffer.concat(await Array.fromAsync(req)));
    const json = (value, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    try {
      if (req.url === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end(pages[app]);
      if (req.url === "/client.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(client);
      if (req.url === "/parity/configure") {
        assert.deepEqual((await body()).initial, workload.initial);
        return json({ configured: true, framework: app });
      }
      if (req.url === "/parity/resources") return json(resources());
      if (req.url === "/parity/snapshot") {
        assert.ok(stream && !last);
        return json({ through: 0, rows: workload.initial, work: { reads: 1, rows: workload.rowCount } });
      }
      if (req.url === "/parity/events?from=0") {
        assert.equal(stream, undefined);
        stream = res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.on("close", () => { stream = undefined; });
        send("ready", { from: 0, status: "accepted", resources: resources() });
        return;
      }
      if (req.url === "/parity/publish") {
        const request = await body(), { event } = request;
        if (!last && isDeepStrictEqual(request, { event: workload.events[0] })) {
          last = event; send("update", event);
        } else if (isDeepStrictEqual(request, { event: workload.cleanupProbe })) {
          assert.equal(stream, undefined);
        } else return json({}, 400);
        return json({ seq: event.seq, resources: resources() });
      }
      if (req.url === "/parity/control") {
        assert.deepEqual(await body(), { action: "duplicate" });
        assert.ok(last && stream); send("update", last); return json({});
      }
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500).end(error.message);
    }
  });
  server.listen(0, "127.0.0.1");
  t.after(async () => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; });
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}

test("live runner uses a fresh Chromium for the next adapter after a real disconnect", { timeout: 90000 }, async t => {
  // Existing hosted native-workload step sets this flag in the Playwright image.
  const hosted = process.env.MIXED_BROWSER_TESTS === "1";
  if (!hosted && !existsSync(new URL("../../node_modules/playwright/package.json", import.meta.url))) return t.skip("Playwright is not installed");
  const { chromium } = await import("playwright");
  if (!hosted && !existsSync(chromium.executablePath())) return t.skip("bundled Chromium is not installed");
  const stop = new AbortController();
  const signal = AbortSignal.any([t.signal, stop.signal]);
  let first;
  for (const app of ["aspnet", "express"]) {
    const scope = await openAdapterBrowser(chromium, signal), port = portFor(app);
    try {
      const base = await fixture(t, app);
      const result = await browserJourney(scope.browser, base, workload, settings, port);
      assert.notEqual(scope.browser, first);
      assert.equal(result.configuration.framework, app);
      assert.equal(result.summary.appliedEffects, 1);
      assert.ok(wireEvents(result.network, port.wire).some(event => event.seq === 1));
      if (app === "aspnet") {
        first = scope.browser;
        await first.close();
        // This is the old shared-handle failure, without assuming the
        // historical process exit itself came from browser.close().
        await assert.rejects(browserJourney(first, base, workload, settings, port), error => {
          assert.match(error.message, /browser.newContext: Target page, context or browser has been closed/);
          assert.deepEqual(error.evidence.browserFailure, { stage: "new-context", disconnected: true });
          return true;
        });
      }
    } finally { await scope.close(); }
    assert.equal(scope.browser.isConnected(), false);
  }
  stop.abort(new Error("aborted between adapters"));
  await assert.rejects(openAdapterBrowser({ launch: () => assert.fail("cancelled runner launched another browser") }, signal), /aborted between adapters/);
});

test("cancellation during Chromium launch closes the returned browser exactly once", async () => {
  const stop = new AbortController();
  let closed = 0;
  const scope = await openAdapterBrowser({ async launch() {
    stop.abort(new Error("aborted during launch"));
    return { async close() { closed++; } };
  } }, stop.signal);
  await scope.close();
  assert.equal(closed, 1);
  assert.throws(() => stop.signal.throwIfAborted(), /aborted during launch/);
});
