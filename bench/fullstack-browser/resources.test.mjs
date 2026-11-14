// Browser-primitive apparatus tests only, never native contender captures.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "@playwright/test";
import { installResourceObserver, ResourceAudit } from "./resources.mjs";
import { observeNetwork } from "./observe.mjs";

test("cleanup snapshots the retired scope after observing native detachment", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(); await context.addInitScript(installResourceObserver);
    const page = await context.newPage(), network = observeNetwork(page);
    await page.goto(`data:text/html,<header><a href="/">Away</a></header><article class="marketplace"></article><script>
      document.querySelector('a').addEventListener('click', e => e.preventDefault(), { once: true });
    </script>`);
    const resources = new ResourceAudit(page, await context.newCDPSession(page), true);
    const checkpoint = resources.checkpoint.bind(resources); let samples = 0;
    resources.checkpoint = async () => {
      const snapshot = await checkpoint();
      // Native detachment falls between the snapshot and the separate handle read.
      if (++samples === 2) await page.evaluate(() => document.querySelector('article').remove());
      return snapshot;
    };
    const cleanup = await resources.cleanup({ timeoutMs: 5000, observationMs: 25, network, runtimeErrors: [] });
    assert.equal(cleanup.outcome, "observed", JSON.stringify(cleanup));
    assert.notEqual(cleanup.before.scope, cleanup.after.scope);
    assert.equal(cleanup.after.scopes.find((s) => s.scope === cleanup.before.scope).connected, false);
    await context.close();
  } finally { await browser.close(); }
});

test("early root retirement cannot hide an unowned in-flight cleanup fetch", { timeout: 30000 }, async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url === "/cleanup") { await pending; res.end("Away"); return; }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><header><a href="/">Away</a></header><article class="marketplace"></article><script>
      document.querySelector('header a').addEventListener('click', event => {
        event.preventDefault(); document.querySelector('article').remove(); fetch('/cleanup');
      }, { once: true });
    </script>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(); await context.addInitScript(installResourceObserver);
    const page = await context.newPage(), network = observeNetwork(page);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const resources = new ResourceAudit(page, await context.newCDPSession(page), true);
    // Release only after a snapshot actually observes detachment and pending work.
    // A later completion must not erase that first complete retirement receipt.
    const checkpoint = resources.checkpoint.bind(resources);
    resources.checkpoint = async () => {
      const snapshot = await checkpoint();
      if (snapshot.scopes.some((s) => !s.connected)) release();
      return snapshot;
    };
    const cleanup = await resources.cleanup({ timeoutMs: 5000, observationMs: 25, network, runtimeErrors: [] });
    assert.equal(cleanup.outcome, "failed", JSON.stringify(cleanup));
    assert.equal(cleanup.after.unattributed.pendingTasks, 1, JSON.stringify(cleanup));
    assert.match(cleanup.failures.join("; "), /Unattributed native resources/);
    assert.ok(cleanup.after.unattributedDetails.some((e) => e.kind === "pendingTasks" && e.source.some((s) => s.includes("fetch"))));
    await context.close();
  } finally {
    release(); if (browser) await browser.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});

test("obsolete AbortSignal registrations cannot erase a replacement listener binding", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(); await context.addInitScript(installResourceObserver);
    try {
      const page = await context.newPage(); await page.goto('data:text/html,<article class="marketplace"><button>Probe</button></article>');
      for (const replacement of ["plain", "signal", "once"]) for (const capture of [false, true]) {
      const result = await page.evaluate(({ replacement, capture }) => {
        const button = document.querySelector("button"), signal = new AbortController(); let calls = 0;
        const next = new AbortController();
        const callback = () => { calls++; };
        button.addEventListener("probe", callback, { signal: signal.signal, capture });
        button.removeEventListener("probe", callback, capture);
        button.addEventListener("probe", callback, { capture, ...(replacement === "signal" ? { signal: next.signal } : {}), once: replacement === "once" });
        signal.abort(); button.removeEventListener("probe", callback, capture);
        button.dispatchEvent(new Event("probe"));
        const snapshot = __fullstackBrowserAudit.checkpoint();
        return { calls, owned: snapshot.scopes.find((s) => s.scope === snapshot.scope).owned };
      }, { replacement, capture });
      assert.equal(result.calls, 0); assert.equal(result.owned.listeners, 0);
      }
    } finally { await context.close(); }
  } finally { await browser.close(); }
});

test("observer subscriptions retain every native target and follow unobserve/disconnect exactly", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(); await context.addInitScript(installResourceObserver);
    try {
      const page = await context.newPage();
      await page.goto('data:text/html,<article class="marketplace" id="a"></article><article class="marketplace" id="b"></article>');
      for (const kind of ["ResizeObserver", "IntersectionObserver", "MutationObserver"]) {
        assert.equal(await page.evaluate((kind) => { try { new globalThis[kind](null); return null; } catch (error) { return error.name; } }, kind), "TypeError");
        await page.evaluate((kind) => {
          const a = document.getElementById("a"), b = document.getElementById("b");
          globalThis.nativeObserver = new globalThis[kind](() => {});
          for (const target of [a, b, a]) nativeObserver.observe(target, kind === "MutationObserver" ? { attributes: true } : {});
        }, kind);
        const counts = () => page.evaluate(() => __fullstackBrowserAudit.checkpoint().scopes.filter((s) => s.connected).map((s) => s.owned.subscriptions));
        assert.deepEqual(await counts(), [1, 1], kind);
        if (kind !== "MutationObserver") {
          await page.evaluate(() => nativeObserver.unobserve(document.getElementById("b")));
          assert.deepEqual(await counts(), [1, 0], kind);
          await page.evaluate(() => nativeObserver.unobserve(document.getElementById("a")));
          assert.deepEqual(await counts(), [0, 0], kind);
          await page.evaluate(() => nativeObserver.observe(document.getElementById("a")));
          assert.deepEqual(await counts(), [1, 0], kind);
        }
        await page.evaluate(() => nativeObserver.disconnect()); assert.deepEqual(await counts(), [0, 0], kind);
      }
      for (const mixed of [false, true]) {
        await page.evaluate((mixed) => new Promise((resolve) => {
          const a = document.getElementById("a"), b = document.getElementById("b");
          globalThis.nativeObserver = new MutationObserver(() => {
            globalThis.callbackTimer = setInterval(() => {}, 10000); resolve();
          });
          nativeObserver.observe(a, { attributes: true }); nativeObserver.observe(b, { attributes: true });
          a.setAttribute("data-probe", String(mixed));
          if (mixed) b.setAttribute("data-probe", String(mixed));
        }), mixed);
        const snapshot = await page.evaluate(() => __fullstackBrowserAudit.checkpoint());
        assert.deepEqual(snapshot.scopes.filter((s) => s.connected).map((s) => s.owned.timers), mixed ? [0, 0] : [1, 0]);
        assert.equal(snapshot.unattributed.timers, mixed ? 1 : 0);
        await page.evaluate(() => { clearInterval(callbackTimer); nativeObserver.disconnect(); });
      }
    } finally { await context.close(); }
  } finally { await browser.close(); }
});
