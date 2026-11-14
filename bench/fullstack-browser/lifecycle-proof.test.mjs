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

test("real no-JS document replacement proves only platform retirement and journals parser failures", { timeout: 30000 }, async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/r1") { res.writeHead(302, { location: "/r2" }); res.end(); }
    else if (req.url === "/r2") { res.writeHead(307, { location: "/before?secret=SECRET" }); res.end(); }
    else if (req.url === "/site.css") { res.setHeader("content-type", "text/css"); res.end("body{color:black}"); }
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
        await journal.recordDocument({ observer: randomUUID(), scope: resources.scope, url: { path: new URL(page.url()).pathname }, native: await page.evaluate(nativeDOM) }, resources);
        return resources;
      };
      await page.goto(base + "/r1"); const before = await observe(), retiredAt = performance.now();
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
      assert.deepEqual(classified.requests.filter((r) => r.terminal?.event === "native-redirect").map((r) => [r.dispatch.path, r.terminal.status]), [["/r1", 302], ["/r2", 307]]);
      assert.ok(classified.requests.some((r) => r.classification === "parser-asset" && r.dispatch.path === "/site.css"));
      assert.ok(classified.requests.some((r) => r.classification === "intentionally-disabled-preload" && r.dispatch.path === "/module.js" && r.terminal.event === "Network.loadingFailed"));
      assert.equal(JSON.stringify(snapshot), original); assert.ok(!original.includes("SECRET"));

      const cssIds = new Set(snapshot.events.filter((e) => e.event === "Network.requestWillBeSent" && e.type === "Stylesheet").map((e) => e.request));
      const deletionProbes = [
        ["orphan-redirect", (j) => { j.events = j.events.filter((e) => !(e.event === "Network.requestWillBeSent" && e.path === "/r1")); }],
        ["missing-middle-redirect", (j) => { j.events = j.events.filter((e) => !(e.event === "Network.requestWillBeSent" && e.path === "/r2")); }],
        ["backwards-native-redirect", (j) => { j.events.find((e) => e.event === "Network.requestWillBeSent" && e.path === "/r2").at = 0; }],
        ["response-after-native-terminal", (j) => {
          const response = j.events.find((e) => e.event === "Network.responseReceived" && e.type === "Stylesheet");
          response.at = j.events.find((e) => e.event === "Network.loadingFinished" && e.request === response.request).at + 100;
        }],
        ["empty-commits", (j) => { j.events = j.events.filter((e) => e.event !== "Page.frameNavigated"); }],
        ["missing-css-dispatches", (j) => { j.events = j.events.filter((e) => !e.event.startsWith("Network.") || !cssIds.has(e.request)); }],
        ["null-document-method", (j) => { j.events.filter((e) => e.event === "Network.requestWillBeSent" && e.type === "Document").forEach((e) => { e.method = null; }); }],
      ].map(([name, mutate]) => {
        const altered = structuredClone(snapshot); mutate(altered);
        return { name, retirement: validatePlatformRetirement(altered, options).outcome, noJS: classifyNoJSRequests(altered).outcome };
      });
      t.diagnostic(JSON.stringify({ intact: { retirement: proof.outcome, noJS: classified.outcome }, deletionProbes }));
      for (const row of deletionProbes) {
        assert.equal(row.retirement, "unknown", row.name);
        assert.equal(row.noJS, "unknown", row.name);
      }
      const missingMiddle = structuredClone(snapshot);
      missingMiddle.events = missingMiddle.events.filter((e) => !(e.event === "Network.requestWillBeSent" && e.path === "/r2"));
      for (const changed of [validatePlatformRetirement(missingMiddle, options), classifyNoJSRequests(missingMiddle)]) {
        assert.equal(changed.requests.find((r) => r.dispatch.path === "/r1").terminal, null, "A missing hop cannot invent the preceding URL's redirect outcome");
      }
      for (const [name, mutate] of [
        ["missing redirect response", (j) => { delete j.events.find((e) => e.path === "/r2").redirectResponse; }],
        ["missing predecessor URL hash", (j) => { delete j.events.find((e) => e.path === "/r1").urlSha256; }],
        ["changed predecessor response URL", (j) => { j.events.find((e) => e.path === "/r2").redirectResponse.urlSha256 = "0".repeat(64); }],
        ["changed predecessor response path", (j) => { j.events.find((e) => e.path === "/r2").redirectResponse.path = "/different"; }],
        ["changed predecessor response status", (j) => { j.events.find((e) => e.path === "/r2").redirectResponse.status = 307; }],
        ["missing redirect timing", (j) => { j.events.find((e) => e.path === "/r2").redirectResponse.timing = null; }],
        ["redirect headers after continuation", (j) => { j.events.find((e) => e.path === "/r2").redirectResponse.timing.receiveHeadersEnd += 100000; }],
        ["response headers after transfer finish", (j) => { j.events.find((e) => e.event === "Network.responseReceived").timing.receiveHeadersEnd += 100000; }],
        ["missing response timing", (j) => { delete j.events.find((e) => e.event === "Network.responseReceived").timing; }],
        ["missing native clock samples", (j) => { j.events = j.events.filter((e) => e.event !== "native-clock-sample"); }],
        ["missing initial native clock", (j) => { j.events = j.events.filter((e) => e.phase !== "initial-native-clock"); }],
        ["missing terminal native clock", (j) => { j.events = j.events.filter((e) => e.phase !== "terminal-native-clock"); }],
        ["invalid native clock", (j) => { j.events.find((e) => e.event === "native-clock-sample").at = null; }],
        ["native finish before dispatch", (j) => { j.events.find((e) => e.event === "Network.loadingFinished").at = 0; }],
      ]) {
        const altered = structuredClone(snapshot); mutate(altered);
        assert.equal(validatePlatformRetirement(altered, options).outcome, "unknown", name);
        assert.equal(classifyNoJSRequests(altered).outcome, "unknown", name);
      }
      for (const field of ["request", "frame", "loader", "type", "method", "scheme", "path", "document", "sameDocumentOrigin", "initiator", "at", "receivedAt", "redirectStatus"]) {
        const altered = structuredClone(snapshot);
        altered.events.find((e) => e.event === "Network.requestWillBeSent")[field] = null;
        // A null redirect status is a real non-redirect receipt; remove it instead.
        if (field === "redirectStatus") delete altered.events.find((e) => e.event === "Network.requestWillBeSent").redirectStatus;
        assert.equal(validatePlatformRetirement(altered, options).outcome, "unknown", `mandatory dispatch ${field}`);
        assert.equal(classifyNoJSRequests(altered).outcome, "unknown", `mandatory parser dispatch ${field}`);
      }
      for (const [event, fields] of [
        ["Network.responseReceived", ["request", "frame", "loader", "type", "status", "at", "receivedAt", "hasCsp", "mime"]],
        ["Network.loadingFinished", ["request", "at", "receivedAt"]],
        ["Network.loadingFailed", ["request", "at", "receivedAt", "canceled", "errorText"]],
        ["Page.frameNavigated", ["frame", "loader", "scheme", "path", "navigationType", "receivedAt"]],
      ]) for (const field of fields) {
        const altered = structuredClone(snapshot); altered.events.find((e) => e.event === event)[field] = null;
        assert.equal(validatePlatformRetirement(altered, options).outcome, "unknown", `${event} ${field}`);
        assert.equal(classifyNoJSRequests(altered).outcome, "unknown", `parser ${event} ${field}`);
      }
      for (const mutate of [
        (j) => { j.documents = []; },
        (j) => { j.documents = {}; },
        (j) => { j.documents[0].assets = [null]; },
        (j) => { j.documents[0].preloads = [null]; },
        (j) => { j.documents[0].observedAt = null; },
        (j) => { j.documents[0].path = "/unobserved"; },
        (j) => { j.events = j.events.filter((e) => !e.event.startsWith("Network.") && e.event !== "Page.frameNavigated"); j.documents = []; },
        (j) => { j.events.find((e) => e.event === "Network.requestWillBeSent" && e.redirectStatus).loader = "unmatched"; },
      ]) {
        const altered = structuredClone(snapshot); mutate(altered);
        assert.equal(validatePlatformRetirement(altered, options).outcome, "unknown");
        assert.equal(classifyNoJSRequests(altered).outcome, "unknown");
      }

      for (const remove of [
        (e) => e.event.startsWith("Network."),
        (e) => e.event === "Network.responseReceived" && e.type !== "Document",
        (e) => e.event.startsWith("Network.") && e.request === snapshot.events.find((r) => r.event === "Network.requestWillBeSent" && r.type === "Document").request,
      ]) {
        const reduced = structuredClone(snapshot); reduced.events = reduced.events.filter((e) => !remove(e));
        assert.equal(validatePlatformRetirement(reduced, options).outcome, "unknown", "Committed HTTP loaders require native network coverage");
        assert.equal(classifyNoJSRequests(reduced).outcome, "unknown", "Missing native request/response coverage cannot classify as empty success");
      }

      // A malformed reduced journal must not classify documents merely because
      // no remaining asset happens to expose their missing response receipts.
      const documentsOnly = structuredClone(snapshot), ids = new Set(snapshot.events.filter((e) => e.event === "Network.requestWillBeSent" && e.type === "Document").map((e) => e.request));
      documentsOnly.events = documentsOnly.events.filter((e) => !e.event.startsWith("Network.") || ids.has(e.request));
      documentsOnly.events = documentsOnly.events.filter((e) => e.event !== "Network.responseReceived");
      const missingResponses = classifyNoJSRequests(documentsOnly);
      assert.equal(missingResponses.outcome, "unknown", "Document success requires its own native response, independent of assets");
      for (const row of missingResponses.requests) assert.equal(row.classification, row.terminal?.event === "native-redirect" ? "document" : "unknown");

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
        (j) => { j.events.find((e) => e.event === "Network.requestWillBeSent" && e.redirectStatus).redirectStatus = 200; },
        (j) => { j.events.find((e) => e.event === "Network.requestWillBeSent").frame = null; },
      ];
      for (const [index, mutate] of mutations.entries()) {
        const altered = structuredClone(snapshot); mutate(altered);
        assert.notEqual(validatePlatformRetirement(altered, options).outcome, "proved", `hostile platform journal ${index}`);
      }
      const live = structuredClone(snapshot); live.events.find((e) => e.event === "unique-context-read-probe").outcome = "still-executable";
      assert.equal(validatePlatformRetirement(live, options).outcome, "failed");
      const parserMutations = [
        (j) => { j.coverage.pageFrames = false; },
        (j) => { j.events = j.events.filter((e) => e.event !== "domain-enabled" || e.domain !== "Network"); },
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

test("same-URL redirect dispatches and query-distinct parser assets retain independent coverage", { timeout: 30000 }, async (t) => {
  let loops = 0, browser;
  const server = createServer((req, res) => {
    if (req.url === "/loop") { res.writeHead(302, { location: ++loops === 1 ? "/loop" : "/before" }); res.end(); return; }
    if (req.url.startsWith("/site.css")) { res.setHeader("content-type", "text/css"); res.end("body{color:black}"); return; }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><head>${req.url.startsWith("/query")
      ? '<link rel="stylesheet" href="/site.css?one=SECRET_ONE"><link rel="stylesheet" href="/site.css?two=SECRET_TWO"><link rel="stylesheet" href="/site.css?one=SECRET_ONE">'
      : '<link rel="stylesheet" href="/site.css">'}</head><body>Observed native document</body></html>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    browser = await chromium.launch({ headless: true });
    const outcomes = [];
    for (const kind of ["same-url-redirect", "query-assets"]) {
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
      let journal;
      try {
        await context.addInitScript(installResourceObserver);
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
        journal = new PlatformLifecycle(cdp, await browser.newBrowserCDPSession(), { javaScriptEnabled: false });
        await journal.enable(); await journal.enableDomains(); await journal.startObservation(); journal.markApplicationStart();
        const audit = new ResourceAudit(page, cdp, false, journal), base = `http://127.0.0.1:${server.address().port}`;
        const observe = async () => {
          const resources = await audit.checkpoint();
          await journal.recordDocument({ observer: randomUUID(), scope: resources.scope, url: { path: new URL(page.url()).pathname }, native: await page.evaluate(nativeDOM) }, resources);
          return resources;
        };
        await page.goto(base + (kind === "same-url-redirect" ? "/loop" : "/query-before"));
        const before = await observe(), retiredAt = performance.now();
        await page.goto(base + (kind === "same-url-redirect" ? "/after" : "/query-after")); await observe();
        await journal.finishObservation({ observationMs: 25, realms: [before.realm] });
        const snapshot = journal.snapshot(), options = { realm: before.realm, retiredAt, observationMs: 25 };
        const intact = { retirement: validatePlatformRetirement(snapshot, options).outcome, noJS: classifyNoJSRequests(snapshot).outcome };
        const reduced = structuredClone(snapshot);
        if (kind === "same-url-redirect") {
          const hops = reduced.events.filter((e) => e.event === "Network.requestWillBeSent" && e.path === "/loop");
          assert.equal(hops.length, 2); assert.equal(hops[0].urlSha256, hops[1].urlSha256);
          reduced.events.splice(reduced.events.indexOf(hops[1]), 1);
          const extra = snapshot.events.filter((e) => e.event === "Network.requestWillBeSentExtraInfo" && e.request === hops[0].request);
          assert.equal(extra.length, 3); assert.equal(new Set(extra.map((e) => e.at)).size, 3);
          for (const mutate of [
            (j) => { j.events = j.events.filter((e) => e.event !== "Network.requestWillBeSentExtraInfo"); },
            (j) => { j.events.find((e) => e.event === "Network.requestWillBeSentExtraInfo").at = null; },
            (j) => { j.events.find((e) => e.event === "Network.requestWillBeSent" && e.redirectStatus).redirectHasExtraInfo = false; },
            (j) => {
              const middle = j.events.filter((e) => e.event === "Network.requestWillBeSent" && e.path === "/loop")[1];
              const connect = j.events.filter((e) => e.event === "Network.requestWillBeSentExtraInfo" && e.request === middle.request)[1];
              j.events = j.events.filter((e) => e !== middle && e !== connect);
            },
          ]) {
            const altered = structuredClone(snapshot); mutate(altered);
            assert.equal(validatePlatformRetirement(altered, options).outcome, "unknown"); assert.equal(classifyNoJSRequests(altered).outcome, "unknown");
          }
          assert.equal(validatePlatformRetirement(reduced, options).requests.find((r) => r.dispatch.path === "/loop").terminal, null, "Ambiguous same-URL hops cannot supply a fabricated predecessor terminal");
        } else {
          const css = reduced.events.filter((e) => e.event === "Network.requestWillBeSent" && e.type === "Stylesheet" && e.loader === reduced.realms.find((r) => r.realm === before.realm).loader);
          assert.equal(css.length, 2); assert.equal(css[0].path, css[1].path); assert.notEqual(css[0].urlSha256, css[1].urlSha256);
          const declarations = snapshot.documents.find((d) => d.realm === before.realm).assets;
          assert.equal(declarations.length, 3); assert.equal(new Set(declarations.map((a) => a.urlSha256)).size, 2, "Only exact-URL duplicate declarations can coalesce");
          reduced.events = reduced.events.filter((e) => !e.event.startsWith("Network.") || e.request !== css[1].request);
        }
        for (const mutate of [
          (j) => { delete j.documents[0].assets[0].urlSha256; },
          (j) => { delete j.documents[0].identityObservation; },
          (j) => {
            j.documents.forEach((d) => { delete d.identityObservation; d.assets.forEach((a) => { delete a.urlSha256; }); });
            j.events.filter((e) => e.event === "Network.requestWillBeSent").forEach((e) => { delete e.document.urlSha256; delete e.initiator.urlSha256; });
          },
          (j) => { j.documents[0].identityObservation.uniqueId = "unmatched-realm"; },
          (j) => { j.documents[0].identityObservation.finishedAt = j.boundaries.endedAt + 1; },
          (j) => { j.realms = {}; },
        ]) {
          const altered = structuredClone(snapshot); mutate(altered);
          assert.equal(validatePlatformRetirement(altered, options).outcome, "unknown"); assert.equal(classifyNoJSRequests(altered).outcome, "unknown");
        }
        const missing = { retirement: validatePlatformRetirement(reduced, options).outcome, noJS: classifyNoJSRequests(reduced).outcome };
        outcomes.push({ kind, intact, missing });
        assert.ok(!JSON.stringify(snapshot).includes("SECRET_"), "Query secrets must never enter retained native observations");
      } finally { if (journal) await journal.close(); await context.close(); }
    }
    t.diagnostic(JSON.stringify(outcomes));
    for (const row of outcomes) { assert.deepEqual(row.intact, { retirement: "proved", noJS: "classified" }); assert.deepEqual(row.missing, { retirement: "unknown", noJS: "unknown" }, row.kind); }
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
