import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { fanoutJourney, waitForFanoutDrain } from "./fanout.mjs";
import { portFor, settingsFor, workloadFor } from "./native.mjs";
import { browserJourney, runLiveAdapters } from "./parity.mjs";
import { verifyRound } from "./verify.mjs";

const group = "live-delivery", workload = workloadFor();
const settings = settingsFor(group, "normal");
const pages = {
  express: '<title>Express fixture</title><table><tbody id="rows"></tbody></table><output id="effects">0</output><script src="/client.js"></script>',
  aspnet: await readFile(new URL("./apps/aspnet/wwwroot/index.html", import.meta.url), "utf8"),
};

// Serve the checked-in clients and their bounded normal correctness journey.
// The stub implements neither slow-reader recovery nor timing.
async function fixture(t, app) {
  const client = await readFile(new URL(`./apps/${app}/${app === "aspnet" ? "wwwroot/" : ""}client.js`, import.meta.url));
  let stream, last;
  const resources = () => {
    const attached = Number(!!stream);
    return { subscriptions: attached, connections: attached, pendingTasks: attached, queueEvents: 0, queuePeak: 0,
      historyEvents: Math.min(last?.seq ?? 0, settings.historyLimit), historyPeak: Math.min(last?.seq ?? 0, settings.historyLimit),
      queueLimit: settings.queueLimit, historyLimit: settings.historyLimit };
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
        assert.equal(stream, undefined);
        last = undefined;
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
        if (workload.events[last?.seq ?? 0] && isDeepStrictEqual(request, { event: workload.events[last?.seq ?? 0] })) {
          last = event; send("update", event);
        } else if (isDeepStrictEqual(request, { event: workload.cleanupProbe })) {
          assert.equal(stream, undefined);
        } else return json({}, 400);
        return json({ seq: event.seq, resources: resources() });
      }
      if (req.url === "/parity/control") {
        if (!isDeepStrictEqual(await body(), { action: "duplicate" })) return json({}, 501);
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

const apps = "aspnet,express", options = { group, requested: apps, profile: "bounded" };
async function runnerFixture(t, measured) {
  const scratch = await mkdtemp(join(tmpdir(), "live-browser-lifetime-")), out = join(scratch, "evidence");
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(scratch)); assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`));
    await rm(scratch, { recursive: true, force: true });
  });
  const images = new Map(), containers = new Map(), history = [];
  for (const [i, app] of apps.split(",").entries()) {
    const index = String(i + 1), id = index.repeat(64), image = `sha256:${id}`;
    const native = measured?.app === app ? measured : undefined;
    images.set(portFor(app).image, native ? { app, id: native.provenance.containerId, image: native.provenance.imageId,
      port: new URL(native.host.base).port, top: native.provenance.processInventory }
      : { app, image, id, port: new URL(await fixture(t, app)).port });
  }
  const ok = (stdout = "") => ({ status: 0, stdout });
  return { out, history, spawn(program, args) {
    assert.equal(program, "docker");
    if (args[0] === "build") {
      const entry = images.get(args[args.indexOf("-t") + 1]);
      entry.source = args.find((s) => s.startsWith("bench.live.source-sha256=")).split("=")[1]; return ok();
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const { image, source } = images.get(args[2]);
      return source ? ok(JSON.stringify([{ Id: image, Config: { Labels: { "bench.live.source-sha256": source } } }])) : { status: 1 };
    }
    if (args[0] === "run") {
      const entry = [...images.values()].find((e) => e.image === args.at(-1));
      assert.equal(containers.size, 0, "previous owned container not removed");
      containers.set(entry.id, entry); history.push(`start:${entry.app}`); return ok(entry.id);
    }
    const entry = containers.get(args[0] === "rm" ? args.at(-1) : args[1]);
    assert.ok(entry, "unexpected or unowned Docker ID");
    if (args[0] === "inspect") return ok(JSON.stringify([{ Id: entry.id, Image: entry.image,
      Config: { Labels: { "agent.owner": "codex", "agent.task": "bench-parity-live" } },
      NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: entry.port }] } },
      HostConfig: { NanoCpus: 1e9, Memory: 2 ** 30, MemorySwap: 2 ** 30 } }]));
    if (args[0] === "top") return ok(entry.top ?? "PID PPID COMMAND\n1001 1 fixture\n");
    if (args[0] === "rm") {
      assert.deepEqual(args, ["rm", "-f", "-v", entry.id]);
      history.push(`remove:${entry.app}`); containers.delete(entry.id); return ok();
    }
    assert.fail(`unexpected Docker command: ${args[0]}`);
  } };
}
const readArtifact = async (out, name) => JSON.parse(gunzipSync(await readFile(join(out, name))));
const savedExpress = async (name) => JSON.parse(gunzipSync(await readFile(new URL(
  `./evidence/review-v3-express/express-${name}.json.gz`, import.meta.url))));

test("live runner uses a fresh Chromium for the next adapter after a real disconnect", { timeout: 90000 }, async t => {
  // Existing hosted native-workload step sets this flag in the Playwright image.
  const hosted = process.env.MIXED_BROWSER_TESTS === "1";
  if (!hosted && !existsSync(new URL("../../node_modules/playwright/package.json", import.meta.url))) return t.skip("Playwright is not installed");
  const { chromium } = await import("playwright");
  if (!hosted && !existsSync(chromium.executablePath())) return t.skip("bundled Chromium is not installed");
  const { out, history, spawn } = await runnerFixture(t);
  const browsers = [], attempted = [];
  assert.equal(await runLiveAdapters({ ...options, out }, { spawn, signal: t.signal, chromium: { async launch(options) {
    assert.ok(browsers.every((b) => !b.isConnected()), "previous adapter retained its browser");
    const browser = await chromium.launch(options); browsers.push(browser); return browser;
  } }, async journey(browser, base, input, settings, port) {
    attempted.push(`${port.directory}:${settings.scenario}`);
    const result = await browserJourney(browser, base, input, settings, port);
    if (port.directory === "aspnet" && settings.scenario === "normal") await browser.close();
    return result;
  } }), false);
  assert.deepEqual(attempted, ["aspnet:normal", "aspnet:slow-reader", "express:normal", "express:slow-reader"]);
  assert.deepEqual(history, ["start:aspnet", "remove:aspnet", "start:express", "remove:express"]);
  assert.equal(browsers.length, 2); assert.ok(browsers.every((b) => !b.isConnected()));
  for (const app of apps.split(",")) {
    const a = await readArtifact(out, `${app}-normal.json.gz`);
    assert.equal(a.schema, "native-live-evidence/v1"); assert.equal(a.summary.appliedEffects, workload.eventCount);
  }
  const failure = await readArtifact(out, "aspnet-slow-reader.json.gz");
  assert.equal(failure.schema, "native-live-failure/v1");
  assert.deepEqual(failure.browserFailure, { stage: "new-context", disconnected: true });
  const replay = await verifyRound(out);
  assert.equal(replay.readyForLoad, false);
  assert.equal(replay.inspected.length, 4); assert.deepEqual(replay.unqualified, []);
});

test("native fanout drain aborts a stalled fetch at its deadline without retrying", async (t) => {
  let calls = 0, aborted = false;
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    calls++;
    return new Promise((_, reject) => {
      const watchdog = setTimeout(() => reject(new Error("probe did not abort")), 1500);
      signal.addEventListener("abort", () => {
        aborted = true; clearTimeout(watchdog); reject(signal.reason);
      }, { once: true });
    });
  });
  const run = new AbortController();
  assert.equal(await waitForFanoutDrain("http://127.0.0.1:1", 100, run.signal), "timeout");
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal(run.signal.aborted, false);
});

for (const mode of ["drained", "close-reject", "shared-budget", "timeout", "late-zero", "fetch", "body-fetch", "malformed",
  "invalid-json", "unavailable", "redirect"]) {
  test(`failed native fanout teardown: ${mode}`, async (t) => {
    const { app, group, provenance, qualification, schema, profile, ...measured } = await savedExpress("fanout-1");
    const { out, history, spawn } = await runnerFixture(t, { app, provenance, host: measured.host });
    const events = [], attached = { connections: 2, subscriptions: 2, pendingTasks: 2, queueEvents: 0,
      queuePeak: 0, historyEvents: 0, historyPeak: 0, queueLimit: settings.queueLimit, historyLimit: settings.historyLimit };
    let current, active = false, closed = 0, polls = 0, offset = 0;
    let contextId = 0, closing = 0, teardownNow;
    const sibling = Promise.withResolvers();
    const now = performance.now.bind(performance);
    t.mock.method(performance, "now", () => teardownNow ?? now() + offset);
    t.mock.method(globalThis, "fetch", async (target, options) => {
      const path = new URL(target).pathname;
      if (path === "/parity/configure") {
        events.push(`configure:${current}:${active ? 400 : 200}`);
        return Response.json({}, { status: active ? 400 : 200 });
      }
      assert.equal(path, "/parity/resources");
      if (!current) return Response.json({}); // Startup.
      if (mode === "close-reject" && closing) {
        events.push("drain:premature");
        active = false;
        sibling.resolve();
        return Response.json({ connections: 0, subscriptions: 0 });
      }
      if (closed !== 2) {
        events.push(`attach:${current}`);
        return Response.json(attached);
      }
      events.push(`drain:${++polls}`);
      assert.equal(options.redirect, "manual");
      if (mode === "fetch") throw new Error("unsaved fixture fetch details");
      if (mode === "body-fetch") return new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError("unsaved fixture body details")); },
      }));
      if (mode === "malformed") return Response.json({ connections: 0, subscriptions: "0" });
      if (mode === "invalid-json") return new Response('{"connections":0,"subscriptions":');
      if (mode === "unavailable") return Response.json({}, { status: 503 });
      if (mode === "redirect") return Response.redirect("http://127.0.0.1:1/not-resources");
      if (mode === "timeout" || mode === "late-zero") offset = settings.maxCleanupMs + 1;
      if (mode === "shared-budget") teardownNow += 1001;
      if (mode === "late-zero" || mode === "shared-budget" || (mode === "drained" && polls === 3)) {
        active = false;
        return Response.json({ connections: 0, subscriptions: 0 });
      }
      if (mode === "drained") return Response.json({ connections: polls === 1 ? 0 : 1, subscriptions: polls === 1 ? 1 : 0 });
      return Response.json(attached);
    });
    let launched = true;
    const browser = { isConnected: () => launched, async close() { launched = false; }, async newContext() {
      const id = ++contextId, page = new EventEmitter();
      Object.assign(page, { setDefaultTimeout() {}, async content() { return ""; }, async waitForFunction() {},
        async goto() { if (current === 4) throw new Error("fixture ended final cell"); },
        async evaluate(_fn, arg) {
          if (arg?.seq) {
            if (mode === "shared-budget") teardownNow = now();
            if (mode !== "close-reject") throw new Error("fixture publisher failed");
            assert.equal(arg.seq, 1);
            offset = 650; // Next offered event is refused at the real lag gate.
          }
          if (arg?.queueLimit) active = true;
          return [];
        } });
      return { async newPage() { return page; }, async close() {
        if (current === 2 && mode === "close-reject") {
          closing++;
          events.push(`close:${id}`);
          if (id === 1) throw new Error("unsaved context close details");
          await sibling.promise;
          events.push("sibling:closed");
          return;
        }
        if (current === 2 && ++closed === 2) {
          if (mode === "shared-budget") teardownNow += settings.maxCleanupMs - 1000;
          events.push("closed:2");
        }
      }, async newCDPSession() {
        return { on() {}, async send() { return { targetInfo: { targetId: "fixture", browserContextId: "fixture" } }; } };
      } };
    } };
    const run = runLiveAdapters({ ...options, requested: "express", out, measure: true }, {
      spawn, chromium: { async launch() { return browser; } },
      async journey(_browser, _base, _input, { scenario }) {
        const { app, group, scenario: _name, provenance, workload, settings, schema, profile, ...observed } = await savedExpress(scenario);
        return observed;
      },
      fanout(browser, base, settings, clients, port, _kernel, renderer, teardown) {
        current = clients; events.push(`attempt:${clients}`);
        if (clients === 1) return measured;
        return fanoutJourney(browser, base, settings, clients, port, () => ({ receipt: { startedAt: now() } }), renderer, teardown);
      },
    });
    if (mode === "close-reject") {
      // The second close remains pending after the first rejects. Allow it to
      // finish only if the probe was wrongly called, or on test teardown.
      t.after(() => sibling.resolve());
    }
    if (mode === "drained") assert.equal(await run, false);
    else await assert.rejects(run, /native fanout teardown refused/);
    assert.deepEqual(history, ["start:express", "remove:express"]);
    assert.equal(launched, false);
    assert.deepEqual(events, ["attempt:1", "attempt:2", "configure:2:200", "attach:2",
      ...(mode === "close-reject" ? ["close:1", "close:2"] : ["closed:2", "drain:1"]),
      ...(mode === "drained" ? ["drain:2", "drain:3", "attempt:4", "configure:4:200"] : [])]);
    assert.equal((await readArtifact(out, "express-fanout-1.json.gz")).schema, "native-live-fanout/v3");
    const failed = await readArtifact(out, "express-fanout-2.json.gz");
    assert.equal(failed.error, mode === "close-reject" ? "native publisher behind offered rate" : "fixture publisher failed");
    assert.equal(failed.schema, "native-live-fanout-failure/v1");
    assert.ok(!Object.hasOwn(failed, "summary"));
    const replay = await verifyRound(out);
    assert.equal(replay.readyForLoad, false);
    assert.deepEqual(replay.passed, ["express"]);
    assert.deepEqual(replay.measured, []);
    assert.deepEqual(replay.unqualified, []);
    if (mode === "close-reject") {
      assert.equal(failed.publisherLag.sequence, 2);
      assert.ok(failed.publisherLag.lagMs > 500);
      assert.equal(failed.browsers.length, 2);
      assert.doesNotMatch(JSON.stringify(failed), /unsaved context close details/);
    }
    if (mode === "drained") {
      assert.equal(failed.teardownFailure, undefined);
      assert.equal((await readArtifact(out, "express-fanout-4.json.gz")).error, "fixture ended final cell");
    } else {
      assert.equal(failed.teardownFailure, { "close-reject": "context-close", "shared-budget": "timeout", "late-zero": "timeout", "body-fetch": "fetch",
        "invalid-json": "malformed", redirect: "unavailable" }[mode] ?? mode);
      assert.equal(replay.cancelled, true);
      assert.deepEqual(replay.notAttempted.express, { scenarios: [], clients: [4] });
      assert.equal(existsSync(join(out, "express-fanout-4.json.gz")), false);
    }
  });
}

for (const [name, clients, cancelled, refusal] of [
  ["later retained cell", 2, true, /fanout evidence follows teardown refusal/],
  ["uncancelled terminal cell", 4, false, /fanout teardown refusal requires cancellation/],
]) test(`saved fanout teardown refuses ${name}`, async (t) => {
  const { app, provenance, host } = await savedExpress("fanout-1");
  const { out, spawn } = await runnerFixture(t, { app, provenance, host });
  t.mock.method(globalThis, "fetch", async () => Response.json({ connections: 0, subscriptions: 0 }));
  const browser = { isConnected: () => true, async close() {} };
  await runLiveAdapters({ ...options, requested: "express", out, measure: true }, {
    spawn, chromium: { async launch() { return browser; } },
    async journey(_browser, _base, _input, { scenario }) {
      const { app, group, scenario: _name, provenance, workload, settings, schema, profile, ...observed } = await savedExpress(scenario);
      return observed;
    },
    async fanout() { throw new Error("fixture publisher failed"); },
  });
  assert.equal((await verifyRound(out)).readyForLoad, false);
  const manifestPath = join(out, "express-measurements.json"), coveragePath = join(out, "coverage.json");
  const manifest = JSON.parse(await readFile(manifestPath)), ledger = JSON.parse(await readFile(coveragePath));
  const file = manifest.files.find(({ file }) => file === `express-fanout-${clients}.json.gz`);
  const artifact = await readArtifact(out, file.file);
  const bytes = gzipSync(JSON.stringify({ ...artifact, teardownFailure: "context-close" }));
  await writeFile(join(out, file.file), bytes);
  file.sha256 = createHash("sha256").update(bytes).digest("hex");
  if (cancelled) ledger.cancelled = true;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(coveragePath, JSON.stringify(ledger));
  await assert.rejects(verifyRound(out), refusal);
  if (!cancelled) {
    await writeFile(coveragePath, JSON.stringify({ ...ledger, cancelled: true }));
    const stopped = await verifyRound(out);
    assert.equal(stopped.cancelled, true);
    assert.equal(stopped.readyForLoad, false);
    assert.deepEqual(stopped.measured, []);
  }
});

test("production cancellation of the last readiness probe is not a startup failure", { timeout: 10000 }, async (t) => {
  const { out, history, spawn } = await runnerFixture(t);
  const stop = new AbortController(), reason = new Error("aborted during last readiness probe");
  let probes = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    assert.equal(new URL(url).pathname, "/parity/resources");
    setImmediate(() => t.mock.timers.tick(100)); // Release the wait after the probe.
    if (++probes < 150) return { ok: false };
    stop.abort(reason);
    signal.throwIfAborted();
  });
  await assert.rejects(runLiveAdapters({ ...options, out }, { spawn, signal: stop.signal,
    chromium: { launch: () => assert.fail("cancelled runner launched Chromium") } }), (error) => error === reason);
  assert.equal(probes, 150);
  assert.deepEqual(history, ["start:aspnet", "remove:aspnet"]);
  await assert.rejects(readFile(join(out, "aspnet-failure.json")), { code: "ENOENT" });
  const replay = await verifyRound(out);
  assert.equal(replay.cancelled, true); assert.equal(replay.readyForLoad, false);
  assert.deepEqual(replay.notAttempted.aspnet, { scenarios: ["normal", "slow-reader"], clients: [] });
});

test("production cancellation during launch closes the browser and removes its owned container once", async (t) => {
  const { out, history, spawn } = await runnerFixture(t);
  const stop = new AbortController();
  let closed = 0;
  await assert.rejects(runLiveAdapters({ ...options, out }, { spawn, signal: stop.signal, chromium: { async launch() {
    stop.abort(new Error("aborted during launch"));
    return { async close() { closed++; } };
  } }, journey: () => assert.fail("cancelled runner started a scenario") }), /aborted during launch/);
  assert.equal(closed, 1);
  assert.deepEqual(history, ["start:aspnet", "remove:aspnet"]);
  const replay = await verifyRound(out);
  assert.equal(replay.cancelled, true); assert.equal(replay.readyForLoad, false);
  assert.deepEqual(replay.notAttempted.aspnet, { scenarios: ["normal", "slow-reader"], clients: [] });
});

for (const stage of ["scenario", "fanout", "fanout-lag"]) test(`production cancellation retains completed ${stage} prefix and never retries`, async (t) => {
  const { out, history, spawn } = await runnerFixture(t);
  const stop = new AbortController(), attempts = [];
  const publisherLag = { sequence: 2, lagMs: 500.25, previousSendMs: 500.25 };
  let closed = 0;
  await assert.rejects(runLiveAdapters({ ...options, out, measure: stage !== "scenario" }, {
    spawn, signal: stop.signal, chromium: { async launch() { return { async close() { closed++; }, isConnected: () => closed === 0 }; } },
    async journey(_browser, _base, _input, settings, port) {
      assert.equal(port.directory, "aspnet");
      attempts.push(settings.scenario);
      const bytes = await readFile(new URL(`./evidence/native-delivery/aspnet-${settings.scenario}.json.gz`, import.meta.url));
      const { schema, profile, app, group, scenario, provenance, workload, settings: savedSettings, ...observed } = JSON.parse(gunzipSync(bytes));
      if (stage === "scenario") stop.abort(new Error("controlled stop"));
      return observed;
    },
    fanout(_browser, _base, _settings, clients) {
      attempts.push(clients);
      stop.abort(new Error("controlled stop"));
      if (stage === "fanout-lag") throw Object.assign(new Error("native publisher behind offered rate"), { evidence: { publisherLag } });
      throw new Error("synthetic in-flight fanout failed");
    },
  }), /controlled stop/);
  assert.deepEqual(history, ["start:aspnet", "remove:aspnet"]); assert.equal(closed, 1);
  assert.deepEqual(attempts, stage === "scenario" ? ["normal"] : ["normal", "slow-reader", 1]);
  const replay = await verifyRound(out);
  assert.equal(replay.cancelled, true); assert.equal(replay.readyForLoad, false);
  assert.deepEqual(replay.unqualified, []);
  assert.deepEqual(replay.notAttempted.express, { scenarios: ["normal", "slow-reader"], clients: [] });
  assert.equal((await readArtifact(out, "aspnet-normal.json.gz")).schema, "native-live-evidence/v1");
  if (stage === "scenario") {
    assert.deepEqual(replay.inspected, ["aspnet-normal.json.gz"]);
    assert.deepEqual(replay.notAttempted.aspnet, { scenarios: ["slow-reader"], clients: [] });
  } else {
    const failed = await readArtifact(out, "aspnet-fanout-1.json.gz");
    assert.equal(failed.schema, "native-live-fanout-failure/v1");
    assert.ok(!Object.hasOwn(failed, "summary"));
    assert.deepEqual(replay.measured, []);
    if (stage === "fanout-lag") {
      assert.equal(failed.error, "native publisher behind offered rate");
      assert.deepEqual(failed.publisherLag, publisherLag);
    } else assert.ok(!Object.hasOwn(failed, "publisherLag"));
    assert.deepEqual(replay.notAttempted.aspnet, { scenarios: [], clients: [2, 4] });
    assert.equal(replay.inspected.length, 3);
  }
});
