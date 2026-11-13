// Apparatus tests: actual Chromium/CDP receipts, not contender qualification.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once, EventEmitter } from "node:events";
import { chromium } from "@playwright/test";
import { PlatformLifecycle } from "./lifecycle.mjs";
import { installResourceObserver, ResourceAudit } from "./resources.mjs";

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
      await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
      const audit = new ResourceAudit(page, cdp, true, journal), base = `http://127.0.0.1:${server.address().port}`;
      await page.goto(base + "/before?token=SECRET"); const before = await audit.checkpoint();
      assert.equal((await journal.probeRealm(before.realm)).outcome, "still-executable");
      await page.evaluate(() => new Promise((resolve) => { globalThis.worker = new Worker("/worker.js"); worker.onmessage = () => resolve(); }));
      await page.evaluate(() => new Promise((resolve, reject) => {
        const socket = new WebSocket(location.origin.replace("http:", "ws:") + "/socket?token=SECRET");
        socket.onopen = () => socket.close(); socket.onclose = () => resolve(); socket.onerror = reject;
      }));
      await page.goto(base + "/after"); const after = await audit.checkpoint();
      const terminal = await journal.probeRealm(before.realm); assert.equal(terminal.outcome, "context-not-found", JSON.stringify(terminal));
      assert.equal((await journal.probeRealm("unobserved-realm")).outcome, "unavailable");
      const snapshot = journal.snapshot(), old = snapshot.realms.find((r) => r.realm === before.realm), next = snapshot.realms.find((r) => r.realm === after.realm);
      assert.ok(old && next); assert.notEqual(old.uniqueId, next.uniqueId); assert.equal(old.frame, next.frame); assert.notEqual(old.loader, next.loader);
      assert.ok(snapshot.events.some((e) => e.event === "Runtime.executionContextDestroyed" && e.context === old.context
        || e.event === "Runtime.executionContextsCleared" && e.contexts.some((c) => c.uniqueId === old.uniqueId)));
      const created = snapshot.events.find((e) => e.event === "Network.webSocketCreated");
      assert.ok(created); assert.ok(snapshot.events.some((e) => e.event === "Network.webSocketHandshakeResponseReceived" && e.request === created.request && e.status === 101));
      assert.ok(snapshot.events.some((e) => e.event === "Network.webSocketClosed" && e.request === created.request));
      assert.ok(snapshot.events.some((e) => e.event === "Target.targetCreated" && e.type === "worker"));
      assert.equal(snapshot.coverage.sharedWorkerOwnership, false); assert.equal(snapshot.coverage.serverSocketPeerClosure, false);
      assert.ok(!JSON.stringify(snapshot).includes("SECRET"));
      const retired = audit.retired(before, after); assert.equal(retired.owned, null); assert.equal(retired.probeAvailable, false);
      const frozen = snapshot.events.length; await page.reload(); assert.equal(snapshot.events.length, frozen);
    } finally { await context.close(); }
  } finally {
    if (journal) await journal.close(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
