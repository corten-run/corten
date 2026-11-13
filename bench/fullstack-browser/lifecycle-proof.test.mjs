// Actual Chromium apparatus receipts, never a contender or fabricated oracle capture.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { PlatformLifecycle, validatePlatformRetirement, classifyNoJSRequests } from "./lifecycle.mjs";
import { ResourceAudit, installResourceObserver } from "./resources.mjs";
import { nativeDOM } from "./observe.mjs";

test("real no-JS document replacement proves only platform retirement and journals parser failures", { timeout: 30000 }, async () => {
  const server = createServer((req, res) => {
    if (req.url === "/site.css") { res.setHeader("content-type", "text/css"); res.end("body{color:black}"); }
    else if (req.url === "/module.js") { res.setHeader("content-type", "text/javascript"); res.end('throw new Error("must not execute")'); }
    else { res.setHeader("content-type", "text/html"); res.end('<!doctype html><html lang="en-US"><head><link rel="stylesheet" href="/site.css"><link rel="modulepreload" href="/module.js"></head><body>Actual native document</body></html>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let browser, journal;
  try {
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    await context.addInitScript(installResourceObserver);
    try {
      const page = await context.newPage(), cdp = await context.newCDPSession(page);
      journal = new PlatformLifecycle(cdp, await browser.newBrowserCDPSession(), { javaScriptEnabled: false });
      await journal.enable(); await journal.enableDomains(); await journal.startObservation();
      journal.markApplicationStart();
      const audit = new ResourceAudit(page, cdp, false, journal), base = `http://127.0.0.1:${server.address().port}`;
      const observe = async () => {
        const resources = await audit.checkpoint();
        journal.recordDocument({ observer: randomUUID(), scope: resources.scope, url: { path: new URL(page.url()).pathname }, native: await page.evaluate(nativeDOM) }, resources);
        return resources;
      };
      await page.goto(base + "/before?secret=SECRET"); const before = await observe(), retiredAt = performance.now();
      await page.goto(base + "/after"); await observe();
      await journal.finishObservation({ observationMs: 25, realms: [before.realm] });
      const snapshot = journal.snapshot(), options = { realm: before.realm, retiredAt, observationMs: 25 }, original = JSON.stringify(snapshot);
      const proof = validatePlatformRetirement(snapshot, options);
      assert.equal(proof.outcome, "proved", JSON.stringify(proof.reasons));
      assert.equal(proof.binding.realm, before.realm); assert.notEqual(proof.binding.loader, proof.replacement.binding.loader);
      assert.ok(proof.nativeFailures.length > 0, "Native blocked preloads stay failed receipts");
      assert.ok(proof.requests.some((r) => r.terminal.event === "Network.loadingFailed"));
      assert.equal(Object.hasOwn(proof, "owned"), false); assert.equal(Object.hasOwn(proof, "dom"), false);
      const classified = classifyNoJSRequests(snapshot);
      assert.equal(classified.outcome, "classified", JSON.stringify(classified));
      assert.ok(classified.requests.some((r) => r.classification === "parser-asset" && r.dispatch.path === "/site.css"));
      assert.ok(classified.requests.some((r) => r.classification === "intentionally-disabled-preload" && r.dispatch.path === "/module.js" && r.terminal.event === "Network.loadingFailed"));
      assert.equal(JSON.stringify(snapshot), original); assert.ok(!original.includes("SECRET"));

      // A malformed reduced journal must not classify documents merely because
      // no remaining asset happens to expose their missing response receipts.
      const documentsOnly = structuredClone(snapshot), ids = new Set(snapshot.events.filter((e) => e.event === "Network.requestWillBeSent" && e.type === "Document").map((e) => e.request));
      documentsOnly.events = documentsOnly.events.filter((e) => !e.event.startsWith("Network.") || ids.has(e.request));
      documentsOnly.events = documentsOnly.events.filter((e) => e.event !== "Network.responseReceived");
      const missingResponses = classifyNoJSRequests(documentsOnly);
      assert.equal(missingResponses.outcome, "unknown", "Document success requires its own native response, independent of assets");
      assert.ok(missingResponses.requests.every((r) => r.classification === "unknown"));

      const mutations = [
        (j) => { j.schema = "native-browser-platform-lifetimes/v1"; },
        (j) => { j.target.context = null; },
        (j) => { j.coverage.runtime = false; },
        (j) => { j.coverage.pageNetwork = false; },
        (j) => { j.coverage.browserTargetDiscovery = false; },
        (j) => { j.observationFailures.push({ phase: "targets-session-closed" }); },
        (j) => { j.boundaries.startedAt = j.boundaries.applicationStartedAt + 1; },
        (j) => { j.boundaries.terminalStartedAt = j.boundaries.endedAt; },
        (j) => { j.events = j.events.filter((e) => e.phase !== "initial"); },
        (j) => { j.events = j.events.filter((e) => e.phase !== "terminal"); },
        (j) => { j.events.find((e) => e.phase === "initial").observedContexts = []; },
        (j) => { j.events.find((e) => e.phase === "terminal").observedContexts = []; },
        (j) => { j.events = j.events.filter((e) => e.event !== "domain-enabled"); },
        (j) => { j.events.find((e) => e.phase === "terminal").targets = []; },
        ...["worker", "shared_worker", "service_worker"].map((type) => (j) => { j.events.find((e) => e.phase === "initial").targets.push({ target: "unowned-worker", context: j.target.context, type }); }),
        (j) => { j.events.find((e) => e.phase === "initial").targets.push({ target: "unknown-service-worker", context: null, type: "service_worker" }); },
        (j) => { j.events.find((e) => e.phase === "initial").targets.push({ target: "other-page", context: j.target.context, type: "page" }); },
        (j) => { j.realms = j.realms.filter((r) => r.realm !== before.realm); },
        (j) => { j.realms.push(j.realms.find((r) => r.realm === before.realm)); },
        (j) => { j.realms.find((r) => r.realm === before.realm).uniqueId = "not-observed"; },
        (j) => { j.events = j.events.filter((e) => !["Runtime.executionContextDestroyed", "Runtime.executionContextsCleared"].includes(e.event)); },
        (j) => { j.events.filter((e) => e.event === "Page.frameNavigated").forEach((e) => { e.navigationType = "BackForwardCacheRestore"; }); },
        (j) => { j.events.find((e) => e.event === "unique-context-read-probe").error = "Session closed"; },
        (j) => { j.events.find((e) => e.event === "unique-context-read-probe").finishedAt = j.boundaries.endedAt + 1; },
        (j) => { j.events.find((e) => e.event === "unique-context-read-probe").timeoutMs = 1001; },
        (j) => { j.events = j.events.filter((e) => e.event !== "Network.loadingFinished"); },
        (j) => { j.events = j.events.filter((e) => e.event !== "Network.loadingFailed"); },
        (j) => { j.events.find((e) => e.event === "Network.requestWillBeSent").frame = null; },
      ];
      for (const [index, mutate] of mutations.entries()) {
        const altered = structuredClone(snapshot); mutate(altered);
        assert.notEqual(validatePlatformRetirement(altered, options).outcome, "proved", `hostile platform journal ${index}`);
      }
      const live = structuredClone(snapshot); live.events.find((e) => e.event === "unique-context-read-probe").outcome = "still-executable";
      assert.equal(validatePlatformRetirement(live, options).outcome, "failed");
      const parserMutations = [
        (j) => { j.contextConfiguration.javaScriptEnabled = true; },
        (j) => { j.documents = []; },
        (j) => { j.documents.forEach((d) => { d.preloads = []; }); },
        (j) => { j.documents.forEach((d) => { d.hasMetaCsp = true; }); },
        (j) => { j.events.filter((e) => e.event === "Network.responseReceived").forEach((e) => { e.hasCsp = true; }); },
        (j) => { j.events.filter((e) => e.event === "Network.responseReceived" && e.type === "Document").forEach((e) => { e.frame = "unmatched-frame"; }); },
        (j) => { j.events.filter((e) => e.event === "Network.responseReceived" && e.type === "Document").forEach((e) => { e.status = null; }); },
        (j) => { j.events.filter((e) => e.event === "Network.requestWillBeSent" && e.type !== "Document").forEach((e) => { e.initiator.type = "script"; }); },
        (j) => { j.events.filter((e) => e.event === "Network.requestWillBeSent" && e.type !== "Document").forEach((e) => { e.sameDocumentOrigin = false; }); },
        (j) => { j.events.filter((e) => e.event === "Network.loadingFailed").forEach((e) => { e.blockedReason = null; e.errorText = "net::ERR_ABORTED"; }); },
      ];
      for (const [index, mutate] of parserMutations.entries()) {
        const altered = structuredClone(snapshot); mutate(altered);
        assert.equal(classifyNoJSRequests(altered).outcome, "unknown", `hostile parser journal ${index}`);
      }
      await context.close();
      assert.equal(validatePlatformRetirement(journal.snapshot(), options).outcome, "unknown", "Harness closure cannot supply platform retirement proof");
    } finally { await context.close(); }
  } finally {
    if (journal) await journal.close(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
