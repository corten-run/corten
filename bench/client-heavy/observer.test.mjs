import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { installObserver } from "./observer.mjs";
import { socketFixture } from "./socket-fixture.mjs";

test("bootstrap source subscriptions and connections are not subtracted from the zero baseline", { timeout: 30000 }, async () => {
  const peer = await socketFixture();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(), sent = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => sent.push(payload)));
    await page.evaluate(installObserver);
    const observed = await page.evaluate(async (url) => {
      const o = window.clientObserver, source = new EventTarget(), receive = () => {};
      source.addEventListener("tick", receive);
      window.clientSource = source;
      const socket = window.reviewSocket = new WebSocket(url);
      await new Promise((ok, reject) => { socket.onopen = ok; socket.onerror = reject; });
      socket.send("bootstrap");
      const baseline = o.begin().owned;
      source.removeEventListener("tick", receive);
      socket.send("operation");
      const beforeClose = o.owned();
      return { baseline, beforeClose, network: o.network };
    }, peer.url);
    await peer.close();
    observed.final = await page.evaluate(async () => {
      const socket = window.reviewSocket;
      if (socket.readyState !== WebSocket.CLOSED) await new Promise((ok) => { socket.onclose = ok; });
      return window.clientObserver.owned();
    });
    assert.equal(observed.baseline.subscriptions, 1);
    assert.equal(observed.baseline.listeners, 1);
    assert.equal(observed.baseline.connections, 1);
    assert.equal(observed.beforeClose.subscriptions, 0);
    assert.equal(observed.beforeClose.connections, 1);
    assert.ok(Object.values(observed.final).every((n) => n === 0), JSON.stringify(observed.final));
    assert.deepEqual(observed.network.map((r) => r.transport), ["WebSocket", "WebSocket.send", "WebSocket.send"]);
    assert.deepEqual(sent.slice(0, 2), ["bootstrap", "operation"]);
    assert.ok(peer.receivedBytes() > 0);
  } finally { try { await browser?.close(); } finally { await peer.close(); } }
});

test("released bootstrap subscriptions leave a real zero baseline; bootstrap EventSource stays owned", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.evaluate(installObserver);
    const observed = await page.evaluate(() => {
      const o = window.clientObserver, source = window.clientSource = new EventTarget(), controller = new AbortController();
      source.addEventListener("tick", () => {}, { signal: controller.signal });
      controller.abort();
      const released = o.owned(), events = new EventSource("http://127.0.0.1:1/events");
      const baseline = o.begin().owned;
      events.close();
      return { released, baseline, final: o.owned(), network: o.network };
    });
    assert.ok(Object.values(observed.released).every((n) => n === 0));
    assert.equal(observed.baseline.subscriptions, 0);
    assert.equal(observed.baseline.connections, 1);
    assert.ok(Object.values(observed.final).every((n) => n === 0));
    assert.deepEqual(observed.network, [{ transport: "EventSource" }]);
  } finally { await browser.close(); }
});

test("global event-handler properties are counted until cleared without changing dispatch", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.evaluate(installObserver);
    const observed = await page.evaluate(() => {
      const o = window.clientObserver;
      document.onchange = () => {};
      const baseline = o.begin().owned;
      let calls = 0;
      document.oninput = () => { calls++; };
      document.dispatchEvent(new Event("input"));
      const documentHandler = o.owned();
      window.onresize = () => { calls++; };
      window.dispatchEvent(new Event("resize"));
      const windowHandler = o.owned();
      document.oninput = null;
      window.onresize = null;
      const cleared = o.owned();
      document.onchange = () => {};
      const replaced = o.owned();
      document.onchange = null;
      return { baseline, documentHandler, windowHandler, cleared, replaced, calls, final: o.owned() };
    });
    assert.equal(observed.baseline.listeners, 0);
    assert.equal(observed.documentHandler.listeners, 1);
    assert.equal(observed.windowHandler.listeners, 2);
    assert.equal(observed.calls, 2);
    assert.equal(observed.cleared.listeners, 0);
    assert.equal(observed.replaced.listeners, 1);
    assert.equal(observed.final.listeners, 0);
  } finally { await browser.close(); }
});

test("body window aliases count once but independent slots using the same callback remain distinct", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.evaluate(installObserver);
    const observed = await page.evaluate(() => {
      const o = window.clientObserver; o.begin();
      let calls = 0;
      const callback = () => { calls++; };
      document.body.onresize = callback;
      window.dispatchEvent(new Event("resize"));
      const alias = o.owned();
      window.onclick = callback;
      document.onclick = callback;
      document.documentElement.onclick = callback;
      document.body.onclick = callback;
      const distinct = o.owned();
      document.body.dispatchEvent(new Event("click", { bubbles: true }));
      document.body.onresize = null;
      window.onclick = document.onclick = document.documentElement.onclick = document.body.onclick = null;
      return { alias, distinct, calls, final: o.owned() };
    });
    assert.equal(observed.alias.listeners, 1);
    assert.equal(observed.distinct.listeners, 5);
    assert.equal(observed.calls, 5);
    assert.equal(observed.final.listeners, 0);
  } finally { await browser.close(); }
});

// Real browser API probes, deliberately not framework qualification evidence.
test("an obsolete abort signal cannot forget a re-registered callback", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.evaluate(installObserver);
    const observed = await page.evaluate(() => {
      const o = window.clientObserver, source = window.clientSource = new EventTarget();
      o.begin();
      return ["remove", "once"].map((mode) => {
        let calls = 0;
        const fn = () => { calls++; }, previous = new AbortController();
        source.addEventListener("tick", fn, { signal: previous.signal, once: mode === "once" });
        if (mode === "once") source.dispatchEvent(new Event("tick"));
        else source.removeEventListener("tick", fn);
        source.addEventListener("tick", fn);
        previous.abort();
        const active = o.owned();
        source.dispatchEvent(new Event("tick"));
        source.removeEventListener("tick", fn);
        source.dispatchEvent(new Event("tick"));
        return { mode, calls, active, final: o.owned() };
      });
    });
    for (const result of observed) {
      assert.equal(result.calls, result.mode === "once" ? 2 : 1);
      assert.equal(result.active.subscriptions, 1);
      assert.equal(result.active.listeners, 1);
      assert.ok(Object.values(result.final).every((value) => value === 0), JSON.stringify(result));
    }
  } finally { await browser.close(); }
});

test("observer detects and releases listeners, abort/once, timers and queued work", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.evaluate(installObserver);
    assert.deepEqual(await page.evaluate(() => window.clientObserver.begin().owned), { subscriptions: 0, connections: 0, listeners: 0, timers: 0, pendingTasks: 0 });
    const observed = await page.evaluate(async () => {
      const o = window.clientObserver, s = window.clientSource = new EventTarget(), c = new AbortController();
      const fn = () => {};
      s.addEventListener("tick", fn, { signal: c.signal });
      s.addEventListener("tick", fn); // Duplicate registration is still one.
      const active = o.owned();
      c.abort();
      const aborted = o.owned();
      s.addEventListener("tick", fn, { once: true }); s.dispatchEvent(new Event("tick"));
      const once = o.owned();
      const timer = setInterval(fn, 60000), task = requestAnimationFrame(fn);
      const leaked = o.owned();
      clearInterval(timer); cancelAnimationFrame(task);
      queueMicrotask(fn);
      const queued = o.owned();
      await o.settle();
      const channel = new MessageChannel();
      channel.port1.postMessage("pending");
      const messagePending = o.owned();
      channel.port2.onmessage = () => {};
      await o.wait(50);
      channel.port1.close(); channel.port2.close();
      const abort = new AbortController();
      const taskPromise = scheduler.postTask(() => {}, { delay: 60000, signal: abort.signal }).catch(() => {});
      const scheduled = o.owned(); abort.abort(); await taskPromise;
      const idle = requestIdleCallback(fn);
      const idlePending = o.owned(); cancelIdleCallback(idle);
      return { active, aborted, once, leaked, queued, messagePending, scheduled, idlePending, final: o.owned() };
    });
    assert.equal(observed.active.subscriptions, 1); assert.equal(observed.active.listeners, 1);
    assert.equal(observed.aborted.subscriptions, 0); assert.equal(observed.once.listeners, 0);
    assert.equal(observed.leaked.timers, 1); assert.equal(observed.leaked.pendingTasks, 1);
    assert.equal(observed.queued.pendingTasks, 1);
    assert.equal(observed.messagePending.pendingTasks, 1); assert.equal(observed.scheduled.pendingTasks, 1); assert.equal(observed.idlePending.pendingTasks, 1);
    assert.ok(Object.values(observed.final).every((n) => n === 0));
  } finally { await browser.close(); }
});

test("failed HTTP, beacon, WebSocket and EventSource attempts cannot hide", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.evaluate(installObserver);
    const observed = await page.evaluate(async () => {
      const o = window.clientObserver; o.begin();
      await fetch("http://127.0.0.1:1/fail").catch(() => {});
      navigator.sendBeacon("http://127.0.0.1:1/beacon");
      const ws = new WebSocket("ws://127.0.0.1:1/socket"), es = new EventSource("http://127.0.0.1:1/events");
      let sendError;
      try { ws.send("not-open"); } catch (error) { sendError = error.name; }
      const active = o.owned(); ws.close(); es.close(); await o.wait(100);
      return { active, final: o.owned(), network: o.network, sendError };
    });
    assert.equal(observed.active.connections, 2);
    assert.equal(observed.final.connections, 0);
    assert.equal(observed.sendError, "InvalidStateError");
    assert.deepEqual(observed.network.map((r) => r.transport), ["fetch", "beacon", "WebSocket", "EventSource", "WebSocket.send"]);
  } finally { await browser.close(); }
});
