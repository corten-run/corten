// Apparatus tests: actual Chromium/CDP receipts, not contender qualification.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once, EventEmitter } from "node:events";
import { chromium } from "@playwright/test";
import { PlatformLifecycle, validatePlatformRetirement } from "./lifecycle.mjs";
import { performance } from "node:perf_hooks";
import { installResourceObserver, ResourceAudit } from "./resources.mjs";

test("target discovery records only its acknowledged native command boundary", async () => {
  const page = new EventEmitter(), targets = new EventEmitter(), calls = [];
  page.send = async () => ({ targetInfo: { targetId: "page", browserContextId: "context", type: "page" } });
  targets.send = async (method, params) => { calls.push({ method, params }); return {}; };
  const journal = new PlatformLifecycle(page, targets);
  const before = performance.now(); await journal.enable(); const after = performance.now();
  const receipts = journal.snapshot().events.filter((e) => e.event === "Target.setDiscoverTargets");
  assert.equal(receipts.length, 1);
  assert.deepEqual(calls, [{ method: "Target.setDiscoverTargets", params: { discover: true } }]);
  assert.deepEqual(receipts[0].params, { discover: true }); assert.deepEqual(receipts[0].result, {});
  assert.ok(before <= receipts[0].startedAt && receipts[0].startedAt <= receipts[0].receivedAt && receipts[0].receivedAt <= after);
  assert.equal(journal.snapshot().coverage.browserTargetDiscovery, true);
  targets.send = async () => { throw new Error("native discovery failed"); };
  const failed = new PlatformLifecycle(page, targets);
  await assert.rejects(failed.enable(), /native discovery failed/);
  assert.equal(failed.snapshot().coverage.browserTargetDiscovery, false);
  assert.equal(failed.snapshot().events.some((e) => e.event === "Target.setDiscoverTargets"), false);
  assert.equal(failed.snapshot().observationFailures.at(-1)?.phase, "target-discovery");
});

test("only the specific unique-context protocol rejection is terminal evidence", async () => {
  for (const [message, expected] of [["cdpSession.send: Protocol error (Runtime.evaluate): uniqueContextId not found", "context-not-found"],
    ["cdpSession.send: Protocol error (Runtime.evaluate): Cannot find context with specified id", "context-not-found"],
    ["Session closed", "probe-failed"], ["Target closed", "probe-failed"], ["uniqueContextId not found", "probe-failed"], ["Execution context was destroyed", "probe-failed"]]) {
    const cdp = new EventEmitter(); cdp.send = async () => { throw new Error(message); };
    const journal = new PlatformLifecycle(cdp); journal.realms.set("old", { uniqueId: "observed-native-unique-id" });
    assert.equal((await journal.probeRealm("old")).outcome, expected);
  }
  const cdp = new EventEmitter(); cdp.send = async () => new Promise(() => {});
  const journal = new PlatformLifecycle(cdp); journal.realms.set("old", { uniqueId: "observed-native-unique-id" });
  assert.equal((await journal.probeRealm("old", 5)).outcome, "probe-timeout");
});

test("CDP correlates real realms/frames/worker targets and WebSocket closure without claiming cleanup", { timeout: 30000 }, async () => {
  const server = createServer((req, res) => {
    if (req.url === "/worker.js") { res.setHeader("content-type", "text/javascript"); res.end('postMessage("ready");setInterval(()=>{},1000)'); }
    else { res.setHeader("content-type", "text/html"); res.end('<!doctype html><article class="marketplace"><h1>Native document</h1></article>'); }
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once("data", () => socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]))); socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let browser, journal;
  try {
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext(); await context.addInitScript(installResourceObserver);
    try {
      const page = await context.newPage(), cdp = await context.newCDPSession(page);
      journal = new PlatformLifecycle(cdp, await browser.newBrowserCDPSession()); await journal.enable();
      await journal.enableDomains();
      await journal.startObservation(); journal.markApplicationStart();
      const audit = new ResourceAudit(page, cdp, true, journal), base = `http://127.0.0.1:${server.address().port}`;
      await page.goto(base + "/before?token=SECRET"); const before = await audit.checkpoint();
      assert.equal((await journal.probeRealm(before.realm)).outcome, "still-executable");
      await page.evaluate(() => new Promise((resolve) => { globalThis.worker = new Worker("/worker.js"); worker.onmessage = () => resolve(); }));
      await page.evaluate(() => new Promise((resolve, reject) => {
        const socket = new WebSocket(location.origin.replace("http:", "ws:") + "/socket?token=SECRET");
        socket.onopen = () => socket.close(); socket.onclose = () => resolve(); socket.onerror = reject;
      }));
      const retiredAt = performance.now(); await page.goto(base + "/after"); const after = await audit.checkpoint();
      const terminal = await journal.probeRealm(before.realm); assert.equal(terminal.outcome, "context-not-found", JSON.stringify(terminal));
      assert.equal((await journal.probeRealm("unobserved-realm")).outcome, "unavailable");
      await journal.finishObservation({ observationMs: 25, realms: [before.realm] });
      const snapshot = journal.snapshot(), old = snapshot.realms.find((r) => r.realm === before.realm), next = snapshot.realms.find((r) => r.realm === after.realm);
      const discovery = snapshot.events.filter((e) => e.event === "Target.setDiscoverTargets");
      assert.equal(discovery.length, 1); assert.deepEqual(discovery[0].params, { discover: true }); assert.deepEqual(discovery[0].result, {});
      assert.ok(discovery[0].startedAt <= discovery[0].receivedAt && discovery[0].receivedAt <= snapshot.events.find((e) => e.event === "Target.getTargets" && e.phase === "initial").startedAt);
      assert.ok(old && next); assert.notEqual(old.uniqueId, next.uniqueId); assert.equal(old.frame, next.frame); assert.notEqual(old.loader, next.loader);
      assert.ok(snapshot.events.some((e) => e.event === "Runtime.executionContextDestroyed" && e.context === old.context
        || e.event === "Runtime.executionContextsCleared" && e.contexts.some((c) => c.uniqueId === old.uniqueId)));
      const created = snapshot.events.find((e) => e.event === "Network.webSocketCreated");
      assert.ok(created); assert.ok(snapshot.events.some((e) => e.event === "Network.webSocketHandshakeResponseReceived" && e.request === created.request && e.status === 101));
      assert.ok(snapshot.events.some((e) => e.event === "Network.webSocketClosed" && e.request === created.request));
      assert.ok(snapshot.events.some((e) => e.event === "Target.targetCreated" && e.type === "worker"));
      const proof = validatePlatformRetirement(snapshot, { realm: before.realm, retiredAt, observationMs: 25 });
      assert.equal(proof.outcome, "unknown"); assert.ok(proof.reasons.some((r) => r.includes("worker")));
      assert.ok(proof.sockets.some((s) => s.closed), "Native closed socket remains in terminal ledger even when worker coverage blocks proof");
      const unclosed = structuredClone(snapshot); unclosed.events = unclosed.events.filter((e) => e.event !== "Network.webSocketClosed");
      assert.ok(validatePlatformRetirement(unclosed, { realm: before.realm, retiredAt, observationMs: 25 }).reasons.some((r) => r.includes("no native close receipt")));
      assert.equal(snapshot.coverage.sharedWorkerOwnership, false); assert.equal(snapshot.coverage.serverSocketPeerClosure, false);
      assert.ok(!JSON.stringify(snapshot).includes("SECRET"));
      const retired = audit.retired(before, after); assert.equal(retired.owned, null); assert.equal(retired.probeAvailable, false);
      const frozen = snapshot.events.length; await page.reload(); assert.equal(snapshot.events.length, frozen);
    } finally { await context.close(); }
  } finally {
    if (journal) await journal.close(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
