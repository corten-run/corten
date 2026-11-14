// Harness unit tests, not application captures or evidence of native parity.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { candidates, emptyCells, parseOptions, publicURL, publicInput, publishPort, transportOf, validateTargets, nativeFailures, alertsFromReadback } from "./contract.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { records } from "../marketplace/fixtures.mjs";
import { createUpstream, upstreamDelta } from "./upstream.mjs";
import { observeNetwork, architecture, classifyDisabledPreloads, observedContext, closeObservedContext, visibleDOM, responseDocument } from "./observe.mjs";
import { readStore, waitForSemanticChange } from "./journey.mjs";
import { imageEvidence, captureLiveInputs } from "./run.mjs";
import { replayLiveInputs, replayPrerequisite, nativeAttemptCells, validateContextReceipts, validateCaseParticipant, validateExecutionSources, replayDOMObservation, nativeToolIdentities, reconcileNativeNetwork } from "./verify.mjs";
import { sha256 } from "./contract.mjs";
import { nativeBuildArgs } from "./build.mjs";
import { navigationDestination, normalizeSvelteKitCase } from "./navigation.mjs";
import { missingAction } from "./probes.mjs";
import { discoverReactEndpoint } from "./bindings.mjs";
import { ExecutionLedger, replayExecution, participantSnapshot } from "./native-execution.mjs";
import { OwnedDocker } from "./run.mjs";
import { NativeNetworkAudit } from "./cancellations.mjs";

// Explicit local Docker/Chromium integration, separate from portable units.
// A witnessed failed prerequisite is a complete selected attempt, not a pass
// for a marketplace app or for the still-incomplete registry matrix.
test("native caller v2 replays actual failed-start cleanup and rejects missing browser terminal receipts", { skip: !process.env.NATIVE_CALLER_IMAGE, timeout: 180000 }, async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path"), { tmpdir } = await import("node:os"), { randomUUID } = await import("node:crypto");
  const { chromium } = await import("@playwright/test");
  const { command, OwnedDocker } = await import("./run.mjs"), { validateSaved } = await import("./verify.mjs");
  const { EvidenceStore } = await import("./native-evidence.mjs");
  const { captureSource, captureTools } = await import("./native-source.mjs");
  const { ExecutionLedger } = await import("./native-execution.mjs");
  const { captureSources } = await import("../workloads/isolated/contract.mjs");
  const { schema, settings, retainedFamilies } = await import("./contract.mjs");
  const { exportBrowserCaptures } = await import("./capture.mjs");
  const commit = await command("git", ["rev-parse", "HEAD"]), source = captureSources(commit);
  const folder = mkdtempSync(join(tmpdir(), "browser-native-caller-")), task = `browser-${randomUUID().slice(0, 12)}`;
  const startedAt = Date.now(), store = new EvidenceStore(folder), ledger = new ExecutionLedger(store, { task, commit, startedAt }), owned = new OwnedDocker(task, ledger);
  let browser, cleaned = false;
  try {
    const app = "nextjs", profile = plan.cases[0], fixture = records(), image = JSON.parse(await command("docker", ["image", "inspect", process.env.NATIVE_CALLER_IMAGE]))[0];
    const targets = { [app]: { image: image.Id, readback: { path: "/api/alerts" } } };
    const native = { schema: "native-browser-run/v2", source: store.record("source", captureSource(store, commit)), sourceBinding: store.record("source-binding", source),
      inputsBefore: store.record("inputs-before", captureLiveInputs(store, source)), inputsAfter: null, toolsBefore: null, toolsAfter: null,
      execution: null, targets: store.record("targets", targets), contexts: [], browserTerminal: null, manifest: null };
    const summary = { schema, group: "fullstack-browser", startedAt: new Date(startedAt).toISOString(), task, effectivePlan: plan, settings,
      code: { commit, dirty: false, status: "", runnerFiles: Object.fromEntries((await import("node:fs")).readdirSync(new URL("./", import.meta.url)).filter((p) => p.endsWith(".mjs")).sort()
        .map((p) => [p, sha256(readFileSync(new URL(p, import.meta.url)))])), runnerDiffSha256: sha256("") },
      fixtureSha256: sha256(JSON.stringify(fixture)), targetsSha256: sha256(JSON.stringify(targets)),
      host: { hostname: "native-caller-apparatus", platform: process.platform, release: "native-control", node: process.version },
      options: { round: "w1", targets: "targets.json", out: folder, apps: [app], cases: [profile.key], build: false },
      images: { [app]: { ...imageEvidence(image, commit), sourceTreeSha256: sha256(await command("git", ["ls-tree", "-r", "HEAD", "--", "bench/fullstack/apps/nextjs"])) } },
      builds: {}, bindingArtifacts: {}, browser: null, cells: emptyCells(plan), complete: true, qualificationPassed: false, readyForLoad: false, limits: ["Actual prerequisite/cleanup apparatus, not app qualification"],
      retainedFamilies: retainedFamilies.map((f) => ({ ...f, outcome: "not-run", reason: "Retained; not replaced by native browser diagnostics" })), failures: [], cleanupFailures: [], native };
    owned.record({ event: "created", kind: "image", id: image.Id, owned: false });
    await assert.rejects(owned.start(task, ["--cpus", "1", "--memory", "1g", "-e", `MARKETPLACE_SOURCE=${profile.source}`, "--entrypoint", "/native-caller-missing-command"], image.Id, [], { role: "application", app, case: profile.key }));
    assert.equal(owned.containers.size, 1, "Failed start must retain original ID for cleanup");
    Object.assign(summary.cells[app].find((c) => c.case === profile.key), { outcome: "failed", reason: "Native start was rejected", qualificationPassed: false });
    browser = await chromium.launch({ headless: true });
    const executable = chromium.executablePath();
    native.toolsBefore = store.record("tools-before", captureTools(store, { browserExecutable: executable }));
    summary.browser = { engine: "chromium", version: browser.version(), playwright: JSON.parse(readFileSync(new URL("node_modules/@playwright/test/package.json", new URL("../../", import.meta.url)))).version,
      executable, executableSha256: sha256(readFileSync(executable)), launch: { headless: true } };
    native.browserTerminal = { closeStartedAt: Date.now(), contextsBefore: [], disconnectedAt: null, closeCompletedAt: null, connectedAfter: null };
    browser.on("disconnected", () => { native.browserTerminal.disconnectedAt = Date.now(); });
    await browser.close(); native.browserTerminal.closeCompletedAt = Date.now(); native.browserTerminal.connectedAfter = browser.isConnected(); browser = null;
    summary.cleanupFailures.push(...await owned.cleanup());
    assert.deepEqual(summary.cleanupFailures, []);
    cleaned = true;
    native.inputsAfter = store.record("inputs-after", captureLiveInputs(store, source));
    native.toolsAfter = store.record("tools-after", captureTools(store, { browserExecutable: executable }));
    native.execution = ledger.finish({ endedAt: Date.now() }); native.manifest = store.seal();
    const save = () => {
      const exported = exportBrowserCaptures(summary, fixture);
      mkdirSync(join(folder, "captures"), { recursive: true });
      for (const [name, capture] of Object.entries(exported.captures)) writeFileSync(join(folder, `captures/${name}.json`), JSON.stringify(capture, null, 2) + "\n");
      writeFileSync(join(folder, "captures/manifest.json"), JSON.stringify(exported.manifest, null, 2) + "\n");
      summary.strictCaptureExport = { manifest: "captures/manifest.json", functionalPassed: false, readyForLoad: false };
      summary.finishedAt = new Date().toISOString(); writeFileSync(join(folder, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
      writeFileSync(join(folder, "marketplace.json"), JSON.stringify(fixture));
    };
    save(); const result = await validateSaved({ folder, round: "w1", commit });
    assert.deepEqual(result.invalid, []); assert.equal(result.selectedComplete, true, JSON.stringify(result));
    assert.equal(result.cleanupComplete, true); assert.equal(result.attemptComplete, false); assert.equal(result.qualificationPassed, false); assert.equal(result.expectedExitCode, 1);
    assert.deepEqual(result.blocked, ["matrix-incomplete"]); assert.ok(result.hostSubject?.participants.some((p) => p.role === "application" && p.window === null));
    assert.equal(result.hostSubject.toolIdentities.lockSha256, source.files.find((f) => f.path === "package-lock.json").sha256);
    const terminal = native.browserTerminal; native.browserTerminal = { ...terminal, disconnectedAt: null }; save();
    const missing = await validateSaved({ folder, round: "w1", commit });
    assert.equal(missing.selectedComplete, false); assert.equal(missing.cleanupComplete, false); assert.equal(missing.hostSubject, null);
    native.browserTerminal = terminal; save();
    t.diagnostic(JSON.stringify({ selectedComplete: result.selectedComplete, qualificationPassed: result.qualificationPassed, blocked: result.blocked, files: native.manifest.files.length,
      missingTerminalBlocked: missing.blocked }));
  } finally {
    if (browser) await browser.close();
    if (!cleaned) { const errors = await owned.cleanup(); assert.deepEqual(errors, []); }
    rmSync(folder, { recursive: true });
  }
});

const req = (options = {}) => ({ method: () => "GET", headers: () => ({}), isNavigationRequest: () => false,
  url: () => "http://127.0.0.1/marketplace/en-US/item_2", resourceType: () => "fetch", postData: () => "", ...options });
const plan = createBrowserPlan({ records: records() });

test("native host tool identities require complete canonical lock proof", () => {
  const tools = { node: "a".repeat(64), browser: "b".repeat(64), lockSha256: "c".repeat(64) };
  assert.deepEqual(nativeToolIdentities(tools, tools.lockSha256), tools);
  for (const changed of [{ ...tools, lockSha256: undefined }, { ...tools, lockSha256: "d".repeat(64) }, { ...tools, node: null }])
    assert.throws(() => nativeToolIdentities(changed, tools.lockSha256));
});

test("native document origins distinguish identical URL body and Date without Playwright IDs", async () => {
  const cdp = new EventEmitter(), receipts = [], url = "http://127.0.0.1/marketplace/en-US/item_2", body = "document bytes";
  cdp.send = async (method) => { assert.equal(method, "Network.getResponseBody"); return { body, base64Encoded: false }; };
  const audit = new NativeNetworkAudit(cdp, () => null, (r) => receipts.push(r)), origins = [];
  for (let i = 0; i < 2; i++) {
    const date = new Date(100000).toUTCString(), requestId = `native-${i}`;
    cdp.emit("Network.requestWillBeSent", { requestId, frameId: "frame", loaderId: `loader-${i}`, timestamp: 10 + i * 4, wallTime: 100 + i * 4,
      type: "Document", request: { url, method: "GET" } });
    cdp.emit("Network.responseReceived", { requestId, response: { status: 200, headers: { Date: date } } });
    cdp.emit("Network.loadingFinished", { requestId });
    await audit.drain();
    origins.push(audit.originatingDocument({ frame: "frame", loader: `loader-${i}` }));
  }
  assert.notEqual(origins[0].requestId, origins[1].requestId); assert.equal(origins[0].sha256, origins[1].sha256);
  assert.equal(receipts.filter((r) => r.event === "native-document-body").length, 2);
  assert.ok(!JSON.stringify(receipts).includes(body));
  const initial = audit.takeDocumentResponse(origins[0]); assert.equal(initial, null, "Only the bounded latest document bytes remain in memory");
  assert.equal(audit.takeDocumentResponse(origins[1]).body.toString(), body);
  assert.equal(audit.takeDocumentResponse(origins[1]), null, "Parser bytes are consumed once");
});

test("native document origins refuse absent bodies or ambiguous loaders but do not require Date", async (t) => {
  for (const kind of ["missing-body", "missing-date", "duplicate-native"]) await t.test(kind, async () => {
    const cdp = new EventEmitter(), body = "bounded document", url = "http://127.0.0.1/page", date = new Date(100000).toUTCString();
    cdp.send = async () => { if (kind === "missing-body") throw new Error("Unrecorded private diagnostic"); return { body, base64Encoded: false }; };
    const audit = new NativeNetworkAudit(cdp, () => ({ url, startTime: 100005 }));
    for (let i = 0; i < (kind === "duplicate-native" ? 2 : 1); i++) {
      cdp.emit("Network.requestWillBeSent", { requestId: String(i), frameId: "frame", loaderId: "loader", timestamp: i + 1, wallTime: 100 + i,
        type: "Document", request: { url, method: "GET" } });
      cdp.emit("Network.responseReceived", { requestId: String(i), response: { status: 200, headers: kind === "missing-date" ? {} : { date } } });
      cdp.emit("Network.loadingFinished", { requestId: String(i) });
    }
    await audit.drain();
    const origin = audit.originatingDocument({ frame: "frame", loader: "loader" });
    if (kind === "missing-date") assert.equal(origin.sha256, sha256(body)); else assert.equal(origin, null);
  });
});

test("native body observation bounds concurrency bytes and deadline without retaining raw data", async (t) => {
  await t.test("at most four reads active", async () => {
    const cdp = new EventEmitter(), resolves = [], receipts = []; let active = 0, peak = 0;
    cdp.send = () => new Promise((resolve) => { active++; peak = Math.max(peak, active); resolves.push(() => { active--; resolve({ body: "bounded bytes", base64Encoded: false }); }); });
    const audit = new NativeNetworkAudit(cdp, () => null, (r) => receipts.push(r));
    for (let i = 0; i < 5; i++) {
      cdp.emit("Network.requestWillBeSent", { requestId: String(i), frameId: "frame", loaderId: String(i), timestamp: i + 1, wallTime: 100 + i, type: "Document", request: { url: "http://127.0.0.1/page", method: "GET" } });
      cdp.emit("Network.responseReceived", { requestId: String(i), response: { status: 200 } }); cdp.emit("Network.loadingFinished", { requestId: String(i) });
    }
    assert.equal(resolves.length, 4);
    resolves.slice().forEach((resolve) => resolve()); await new Promise(setImmediate);
    assert.equal(resolves.length, 5); resolves[4](); await audit.drain();
    assert.equal(peak, 4); assert.equal(receipts.filter((r) => r.event === "native-document-body").length, 5);
    assert.ok(!JSON.stringify(receipts).includes("bounded bytes"));
  });
  for (const kind of ["oversized", "deadline"]) await t.test(kind, async () => {
    const cdp = new EventEmitter(), receipts = [];
    cdp.send = () => kind === "deadline" ? new Promise(() => {}) : Promise.resolve({ body: "x".repeat(16 * 1024 ** 2 + 1), base64Encoded: false });
    const audit = new NativeNetworkAudit(cdp, () => null, (r) => receipts.push(r));
    cdp.emit("Network.requestWillBeSent", { requestId: "document", frameId: "frame", loaderId: "loader", timestamp: 1, wallTime: 100, type: "Document", request: { url: "http://127.0.0.1/page", method: "GET" } });
    cdp.emit("Network.responseReceived", { requestId: "document", response: { status: 200 } }); cdp.emit("Network.loadingFinished", { requestId: "document" });
    await audit.drain(); assert.equal(audit.originatingDocument({ frame: "frame", loader: "loader" }), null);
    assert.equal(receipts.length, 1, "Only the observer namespace, never partial body proof, is retained");
  });
});

// Actual HTTP/Chromium/CDP plus the real caller and installed leaf. This is
// apparatus wiring, not a native marketplace contender or qualification.
test("native DOM consumer binds actual document scope and interval for page Alice and 404", { timeout: 60000 }, async (t) => {
  const { chromium } = await import("@playwright/test"), { performance } = await import("node:perf_hooks");
  const { PlatformLifecycle } = await import("./lifecycle.mjs"), { installResourceObserver, ResourceAudit } = await import("./resources.mjs");
  const { referenceHtml } = await import("../marketplace/reference.mjs"), { snapshotPage } = await import("../marketplace/check.mjs");
  const profile = plan.cases.find((p) => p.js && p.locale === "en-US" && p.source === "fixture");
  const bodies = new Map(), store = { blob(body) { const ref = { path: `native-evidence/blobs/${sha256(body)}`, sha256: sha256(body), bytes: body.length }; bodies.set(ref.path, Buffer.from(body)); return ref; } };
  const reader = { read: (ref) => bodies.get(ref.path), json: (ref) => JSON.parse(bodies.get(ref.path)) };
  let body = referenceHtml(records().item_1, "en-US"), hasDate = true;
  const server = createServer((req, res) => {
    res.sendDate = false;
    res.writeHead(req.url.includes("item_missing") ? 404 : 200, { "content-type": "text/html", ...(hasDate ? { date: new Date(1700000000000).toUTCString() } : {}) });
    res.end(body.replaceAll("http://localhost", `http://127.0.0.1:${server.address().port}`));
  });
  await listening(server, async (base) => {
    const browser = await chromium.launch({ headless: true });
    let lifecycle, context;
    const observation = { store, app: "nextjs", case: profile.key, source: profile.source, contexts: [], byContext: new WeakMap(), byRequest: new WeakMap() };
    try {
      context = await observedContext(browser, { javaScriptEnabled: true, serviceWorkers: "block" }, observation, "application");
      await context.addInitScript(installResourceObserver);
      const page = await context.newPage(), cdp = await context.newCDPSession(page), network = observeNetwork(page);
      lifecycle = new PlatformLifecycle(cdp, await browser.newBrowserCDPSession(), { javaScriptEnabled: true });
      await lifecycle.enable(); network.attachCDP(cdp, lifecycle); await lifecycle.enableDomains(); await lifecycle.startObservation(); lifecycle.markApplicationStart();
      const resources = new ResourceAudit(page, cdp, true, lifecycle), rows = [];
      for (const kind of ["ordinary", "Alice", "ordinary-repeat", "ordinary-no-date", "missing"]) {
        hasDate = kind !== "ordinary-no-date";
        const action = profile.steps[kind.startsWith("ordinary") ? 0 : kind === "Alice" ? 3 : 9];
        body = kind === "missing" ? '<!doctype html><html lang="en-US"><body><h1>Not found</h1></body></html>' : referenceHtml(records()[action.itemId], "en-US");
        if (kind === "Alice") body = body.replace("seller=&amp;sort=asc", "seller=Alice&amp;sort=desc");
        const url = base + action.path + (kind === "Alice" ? "?seller=Alice&sort=desc" : "");
        const response = await page.goto(url, { waitUntil: "load" });
        await network.settle(0, performance.now() + 15000);
        const row = { action, resourcesAtDOM: await resources.checkpoint(), dom: null, document: null };
        const origin = network.originatingDocument(lifecycle.realms.get(row.resourcesAtDOM.realm)); assert.ok(origin, "Actual document must be unambiguously linked");
        row.dom = await visibleDOM(page, observation, { context: observation.byContext.get(context).id, case: profile.key, action: action.id, scope: row.resourcesAtDOM.scope, originatingResponse: origin });
        assert.equal(row.dom.extractionComplete, true);
        if (kind === "ordinary") row.document = await responseDocument(browser, response, url, observation, network.takeDocumentResponse(origin), action.id);
        if (["ordinary-repeat", "ordinary-no-date"].includes(kind)) { assert.notEqual(origin.requestId, rows[0].dom.originatingResponse.requestId); assert.equal(origin.sha256, rows[0].dom.originatingResponse.sha256); }
        if (kind !== "missing") assert.deepEqual(row.dom.page, await page.evaluate(snapshotPage));
        else { assert.equal(response.status(), 404); assert.equal(row.dom.page, null); assert.equal(row.dom.error, "Not found"); }
        row.resources = await resources.checkpoint(); await lifecycle.recordDocument(row.dom, row.resources); rows.push(row);
        if (kind === "ordinary") {
          await page.locator("article.marketplace h1").evaluate((el) => { el.textContent = "Observed live title"; });
          const live = { action, resourcesAtDOM: await resources.checkpoint(), document: null };
          live.dom = await visibleDOM(page, observation, { context: observation.byContext.get(context).id, case: profile.key, action: action.id, scope: live.resourcesAtDOM.scope,
            originatingResponse: network.originatingDocument(lifecycle.realms.get(live.resourcesAtDOM.realm)) });
          assert.deepEqual(live.dom.originatingResponse, row.dom.originatingResponse); assert.notEqual(live.dom.observer, row.dom.observer);
          assert.equal(live.dom.page.title, "Observed live title"); assert.notEqual(live.dom.page.title, row.dom.page.title);
          live.resources = await resources.checkpoint(); await lifecycle.recordDocument(live.dom, live.resources); rows.push(live);
        }
        if (kind === "missing") {
          await page.locator("h1").evaluate((el) => { el.textContent = "LIVE-DIAGNOSTIC-CANARY"; });
          const incomplete = { action, resourcesAtDOM: await resources.checkpoint(), document: null };
          incomplete.dom = await visibleDOM(page, observation, { context: observation.byContext.get(context).id, case: profile.key, action: action.id, scope: incomplete.resourcesAtDOM.scope,
            originatingResponse: network.originatingDocument(lifecycle.realms.get(incomplete.resourcesAtDOM.realm)) });
          assert.equal(incomplete.dom.extractionComplete, false); assert.equal(incomplete.dom.error, null); assert.equal(incomplete.dom.page, null);
          assert.ok(!bodies.get(incomplete.dom.responseEvidence.body.path).includes(Buffer.from("LIVE-DIAGNOSTIC-CANARY")));
          incomplete.resources = await resources.checkpoint(); await lifecycle.recordDocument(incomplete.dom, incomplete.resources); rows.push(incomplete);
        }
      }
      await t.test("private URL rejection does not retain its diagnostic value", async () => {
        await page.evaluate(() => history.replaceState(null, "", "?token=CALLER-URL-CANARY"));
        const row = rows.at(-1);
        await assert.rejects(visibleDOM(page, observation, { context: observation.byContext.get(context).id, case: profile.key, action: row.action.id, scope: row.dom.scope,
          originatingResponse: row.dom.originatingResponse }), (error) => error.message === "Typed native DOM extraction unavailable");
      });
      await network.drain(); await lifecycle.finishObservation({ observationMs: 5 });
      const journal = lifecycle.snapshot();
      await closeObservedContext(browser, context, observation); context = null;
      network.annotate();
      const evidence = { context: observation.contexts[0].id, clock: { timeOrigin: performance.timeOrigin }, platformLifecycle: journal, requestLedger: structuredClone(network.rows) };
      const coverage = reconcileNativeNetwork(evidence); assert.equal(coverage.outcome, "reconciled", coverage.reasons.join("; "));
      const observers = new Set();
      for (const row of rows) {
        const result = replayDOMObservation(reader, row.dom, row, evidence, observation.contexts[0], profile.key, observers);
        assert.equal(result.extractionComplete, row.dom.extractionComplete);
        if (row.document) assert.equal(replayDOMObservation(reader, row.document, row, evidence, observation.contexts.find((c) => c.id === row.document.context), profile.key, observers, true).extractionComplete, true);
      }
      const original = { row: rows[0], evidence, context: observation.contexts[0] };
      const negative = (mutate) => { const value = structuredClone(original); mutate(value); assert.throws(() => {
        const result = replayDOMObservation(reader, value.row.dom, value.row, value.evidence, value.context, profile.key, new Set()); assert.ok(result);
      }); };
      for (const [key, value] of [["context", "other"], ["action", profile.steps[1].id], ["case", plan.cases.find((p) => p.key !== profile.key).key], ["scope", "other"]])
        await t.test(`rejects transplanted ${key}`, () => negative((v) => { v.row.dom.responseEvidence.identity[key] = value; }));
      await t.test("rejects wrong loader", () => negative((v) => { v.evidence.platformLifecycle.events.find((e) => e.event === "native-document-body").loader = "other"; }));
      await t.test("rejects wrong body", () => negative((v) => { v.row.dom.originatingResponse.sha256 = "f".repeat(64); }));
      await t.test("rejects absent dispatch", () => negative((v) => { v.evidence.platformLifecycle.events = v.evidence.platformLifecycle.events.filter((e) => e.event !== "Network.requestWillBeSent"); }));
      await t.test("rejects outside read interval", () => negative((v) => { v.row.dom.readInterval.startedAt = v.context.createdAt - 1; }));
      await t.test("rejects contradictory model", () => negative((v) => { v.row.dom.page.title = "Changed saved model"; }));
      await t.test("rejects reused observer", () => assert.throws(() => replayDOMObservation(reader, rows[0].dom, rows[0], evidence, observation.contexts[0], profile.key, observers)));
      await t.test("rejects earlier document substituted for a different native realm", () => {
        const row = structuredClone(rows[2]); row.dom.originatingResponse = rows[0].dom.originatingResponse;
        assert.throws(() => replayDOMObservation(reader, row.dom, row, evidence, observation.contexts[0], profile.key, new Set()));
      });
      await t.test("rejects missing native terminal", () => negative((v) => { v.evidence.platformLifecycle.events = v.evidence.platformLifecycle.events.filter((e) => e.event !== "Network.loadingFinished"); }));
      await t.test("rejects missing native body read", () => negative((v) => { v.evidence.platformLifecycle.events = v.evidence.platformLifecycle.events.filter((e) => e.event !== "native-document-body"); }));
      await t.test("rejects altered native response bytes", () => negative((v) => { v.evidence.platformLifecycle.events.find((e) => e.event === "native-document-body").bodySha256 = "f".repeat(64); }));
      await t.test("rejects altered native date identity", () => negative((v) => { v.evidence.platformLifecycle.events.find((e) => e.event === "Network.responseReceived").dateSha256 = "f".repeat(64); }));
      await t.test("rejects duplicated native body receipt", () => negative((v) => { v.evidence.platformLifecycle.events.push(v.evidence.platformLifecycle.events.find((e) => e.event === "native-document-body")); }));
      await t.test("rejects post-DOM native body read", () => negative((v) => { v.evidence.platformLifecycle.events.find((e) => e.event === "native-document-body").receivedAt = v.row.resources.at + 10; }));
      for (const [name, mutate] of [
        ["semantic document omission", (v) => v.evidence.requestLedger.shift()],
        ["semantic document duplication", (v) => v.evidence.requestLedger.push({ ...v.evidence.requestLedger[0], id: "extra-semantic-request" })],
        ["semantic body substitution", (v) => { v.evidence.requestLedger[0].bodySha256 = "f".repeat(64); }],
        ["semantic method substitution", (v) => { v.evidence.requestLedger[0].method = "POST"; }],
        ["semantic status substitution", (v) => { v.evidence.requestLedger[0].status = 404; }],
        ["semantic path substitution", (v) => { v.evidence.requestLedger[0].path = "/other"; }],
        ["observer namespace substitution", (v) => { v.evidence.platformLifecycle.events.find((e) => e.event === "native-network-observer").observerSession = "other-session"; }],
        ["actual native target substitution", (v) => { v.evidence.platformLifecycle.events.find((e) => e.event === "native-network-observer").targetId = "other-target"; }],
        ["namespace claimed as protocol session", (v) => { v.evidence.platformLifecycle.events.find((e) => e.event === "native-network-observer").namespaceKind = "protocol-session"; }],
        ["native hop substitution", (v) => { v.evidence.platformLifecycle.events.find((e) => e.event === "native-document-body").hop++; }],
        ["native origin substitution", (v) => { v.evidence.platformLifecycle.events.find((e) => e.event === "native-document-body").originId = rows[2].dom.originatingResponse.requestId; }],
      ]) await t.test(`rejects ${name}`, () => negative(mutate));
      await t.test("rejects script-enabled independent parser", () => {
        const c = { ...observation.contexts.find((c) => c.id === rows[0].document.context), javaScriptEnabled: true };
        assert.throws(() => replayDOMObservation(reader, rows[0].document, rows[0], evidence, c, profile.key, new Set(), true));
      });
      const missing = structuredClone(original); missing.row.dom.responseEvidence = null;
      assert.equal(replayDOMObservation(reader, missing.row.dom, missing.row, missing.evidence, missing.context, profile.key, new Set()), null);
      await t.test("missing linkage retains byte ownership without attesting the saved DOM", () => {
        const value = structuredClone(original); value.evidence.platformLifecycle.events = value.evidence.platformLifecycle.events.filter((e) => e.event !== "native-network-observer");
        const consumed = [], unqualifiedReader = { read: (ref) => { consumed.push(ref); return reader.read(ref); }, json: () => assert.fail("Unbound DOM must not be replayed as native proof") };
        assert.equal(replayDOMObservation(unqualifiedReader, value.row.dom, value.row, value.evidence, value.context, profile.key, new Set()), null);
        assert.deepEqual(consumed, [value.row.dom.responseEvidence.body]);
      });
    } finally {
      if (context) await closeObservedContext(browser, context, observation);
      await lifecycle?.close(); await browser.close();
    }
  });
});

test("native primary network reconciles actual redirect ID reuse and retains abort/drop coverage", { timeout: 60000 }, async (t) => {
  const { chromium } = await import("@playwright/test"), { performance } = await import("node:perf_hooks");
  const { PlatformLifecycle } = await import("./lifecycle.mjs"), { installResourceObserver, ResourceAudit } = await import("./resources.mjs");
  const { referenceHtml } = await import("../marketplace/reference.mjs"), { reconcileRequests } = await import("./ledger.mjs");
  let pendingSeen; const pending = new Promise((resolve) => { pendingSeen = resolve; });
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/marketplace/en-US/item_1" }); res.end(); return; }
    if (req.url === "/pending") { pendingSeen(); return; }
    if (req.url === "/body") { res.sendDate = false; res.writeHead(200, { "content-type": "application/json" }); res.end('{"value":1}'); return; }
    res.writeHead(200, { "content-type": "text/html" }); res.end(referenceHtml(records().item_1, "en-US").replaceAll("http://localhost", `http://127.0.0.1:${server.address().port}`));
  });
  await listening(server, async (base) => {
    const browser = await chromium.launch({ headless: true }); let context, lifecycle;
    try {
      context = await browser.newContext({ serviceWorkers: "block" }); await context.addInitScript(installResourceObserver);
      const page = await context.newPage(), cdp = await context.newCDPSession(page), network = observeNetwork(page);
      lifecycle = new PlatformLifecycle(cdp, await browser.newBrowserCDPSession(), { javaScriptEnabled: true });
      await lifecycle.enable(); network.attachCDP(cdp, lifecycle); await lifecycle.enableDomains(); await lifecycle.startObservation(); lifecycle.markApplicationStart();
      const resources = new ResourceAudit(page, cdp, true, lifecycle);
      await page.goto(base + "/redirect", { waitUntil: "load" }); await network.settle(0, performance.now() + 15000);
      const sample = await resources.checkpoint(), origin = network.originatingDocument(lifecycle.realms.get(sample.realm)); assert.ok(origin);
      await lifecycle.recordDocument(await visibleDOM(page), sample);
      await page.evaluate(async () => { await (await fetch("/body")).text(); });
      await page.evaluate(() => { globalThis.abortProbe = new AbortController(); void fetch("/pending", { signal: globalThis.abortProbe.signal }).catch(() => {}); });
      let timer;
      try { await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Actual pending request not observed")), 15000); })]); }
      finally { clearTimeout(timer); }
      await page.evaluate(() => globalThis.abortProbe.abort()); await network.settle(0, performance.now() + 15000);
      await lifecycle.finishObservation({ observationMs: 5 }); network.annotate();
      const evidence = { platformLifecycle: lifecycle.snapshot(), requestLedger: structuredClone(network.rows) };
      const result = reconcileNativeNetwork(evidence); assert.equal(result.outcome, "reconciled", result.reasons.join("; "));
      const redirected = result.requests.filter((r) => r.dispatch.type === "Document");
      assert.equal(redirected.length, 2); assert.equal(redirected[0].dispatch.request, redirected[1].dispatch.request);
      assert.equal(redirected[0].hop, 0); assert.equal(redirected[1].hop, 1); assert.equal(redirected[1].body.originId, origin.requestId);
      assert.equal(redirected[0].body, null); assert.equal(result.requests.find((r) => r.dispatch.path === "/body").body.dateSha256, null);
      const aborted = result.requests.find((r) => r.dispatch.path === "/pending"); assert.equal(aborted.terminal.event, "Network.loadingFailed"); assert.equal(aborted.terminal.canceled, true);
      const strict = reconcileRequests({ ...evidence, steps: [], networkFailures: [], runtimeErrors: [] });
      assert.equal(strict.outcome, "unknown", "Conservation never excuses the failed request under strict parity");
      assert.match(strict.reasons.join("; "), /Failed\/unfinished final request/);
      const negative = (mutate) => { const value = structuredClone(evidence); mutate(value); const r = reconcileNativeNetwork(value); assert.equal(r.outcome, "unknown", "Changed evidence must not reconcile"); };
      for (const [name, mutate] of [
        ["deleted redirect predecessor", (v) => { v.platformLifecycle.events = v.platformLifecycle.events.filter((e) => e !== v.platformLifecycle.events.find((e) => e.event === "Network.requestWillBeSent")); }],
        ["redirect hop transplanted", (v) => { v.platformLifecycle.events.find((e) => e.event === "native-document-body").hop = 0; }],
        ["missing redirect semantic row", (v) => { v.requestLedger = v.requestLedger.filter((r) => r.status !== 302); }],
        ["missing fetch semantic row", (v) => { v.requestLedger = v.requestLedger.filter((r) => r.path !== "/body"); }],
        ["missing abort semantic row", (v) => { v.requestLedger = v.requestLedger.filter((r) => !r.failure); }],
        ["aborted request changed to completed", (v) => { const r = v.requestLedger.find((r) => r.failure); r.failure = null; r.completed = true; }],
        ["missing native abort", (v) => { v.platformLifecycle.events = v.platformLifecycle.events.filter((e) => e.event !== "Network.loadingFailed"); }],
        ["duplicated native abort", (v) => { v.platformLifecycle.events.push(v.platformLifecycle.events.find((e) => e.event === "Network.loadingFailed")); }],
        ["unmatched native request", (v) => { v.platformLifecycle.events.push({ ...v.platformLifecycle.events.find((e) => e.event === "Network.requestWillBeSent"), request: "extra-native-request" }); }],
        ["orphan native response body", (v) => { v.platformLifecycle.events.push({ ...v.platformLifecycle.events.find((e) => e.event === "native-response-body"), request: "orphan" }); }],
        ["deleted fetch in both ledgers leaves independent stack receipt", (v) => {
          const id = v.platformLifecycle.events.find((e) => e.event === "Network.requestWillBeSent" && e.path === "/body").request;
          v.platformLifecycle.events = v.platformLifecycle.events.filter((e) => e.request !== id || e.event === "Network.requestWillBeSentExtraInfo");
          v.requestLedger = v.requestLedger.filter((r) => r.path !== "/body");
        }],
        ["deleted network-stack receipt", (v) => { v.platformLifecycle.events = v.platformLifecycle.events.filter((e) => e !== v.platformLifecycle.events.find((e) => e.event === "Network.requestWillBeSentExtraInfo")); }],
        ["duplicated network-stack receipt", (v) => { v.platformLifecycle.events.push(v.platformLifecycle.events.find((e) => e.event === "Network.requestWillBeSentExtraInfo")); }],
        ["future abort network-stack clock", (v) => {
          const id = v.platformLifecycle.events.find((e) => e.event === "Network.loadingFailed").request;
          v.platformLifecycle.events.find((e) => e.event === "Network.requestWillBeSentExtraInfo" && e.request === id).at += 3600;
        }],
      ]) await t.test(name, () => negative(mutate));
    } finally { await lifecycle?.close(); if (context) await context.close(); await browser.close(); }
  });
});

// Synthetic subprocess/ledger regressions. No actual Docker/browser or target
// qualification is inferred from these controls.
test("failed native create preserves returned original IDs and cannot attest their absence", async (t) => {
  for (const returned of ["a".repeat(64), ""]) await t.test(returned ? "known ID remains owned and blocks unreconciled cleanup" : "genuine no-ID rejection remains a negative prerequisite", async () => {
    const task = "browser-abcdef", commit = "a".repeat(40), app = "nextjs", profile = plan.cases[0];
    const ledger = new ExecutionLedger({ record: (_name, value) => value }, { task, commit, startedAt: Date.now() });
    const owned = new OwnedDocker(task, ledger);
    const replacement = mock.method(childProcess, "spawn", (binary, args) => {
      assert.equal(binary, "docker"); assert.equal(args[0], "create");
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
      process.nextTick(() => { child.stdout.end(returned + "\n"); child.stderr.end("Synthetic create rejection"); child.emit("close", 1, null); });
      return child;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(owned.create(task, [], "sha256:" + "b".repeat(64), [], { role: "application", app, case: profile.key }), (error) => error.receipt.code === 1);
    } finally { replacement.mock.restore(); syncBuiltinESMExports(); }
    const event = ledger.value.events[0];
    const events = [event];
    for (const kind of ["container", "network", "image", "volume"]) for (const scope of ["all", "owned"])
      events.push({ event: "inventory", at: event.at + 1, kind, scope, code: 0, ids: kind === "container" && scope === "all" && returned ? [returned] : [] });
    events.forEach((e, seq) => { e.seq = seq; });
    const execution = replayExecution({ json: () => ({ ...ledger.value, startedAt: event.at, endedAt: event.at + 2, events }) }, null);
    const cell = { case: profile.key, outcome: "failed", qualificationPassed: false, evidence: null, reason: "Synthetic failed create" };
    const summary = { options: { apps: [app], cases: [profile.key], build: false }, builds: {}, images: {}, cells: { [app]: [cell] } };
    const derived = replayPrerequisite(cell, app, summary, execution, new Set());
    const disposition = nativeAttemptCells([{ app, case: cell.case, outcome: cell.outcome, derived, blocked: execution.blocked }], summary)[0];
    t.diagnostic(JSON.stringify({ returned: Boolean(returned), recordedId: event.id, cleanupOwnsId: owned.containers.has(returned), cleanupComplete: execution.cleanupComplete, disposition: disposition.disposition }));
    assert.equal(event.id, returned || null); assert.equal(event.code, 1);
    assert.equal(owned.containers.has(returned), Boolean(returned));
    assert.equal(execution.cleanupComplete, !returned);
    assert.equal(disposition.attemptComplete, !returned);
    if (returned) { assert.equal(execution.participants[0].id, returned); assert.equal(owned.participants.get(returned).case, profile.key); }
  });
});

test("failed native create IDs still receive removal after lost inspect or interruption", async (t) => {
  for (const signal of [null, "SIGTERM"]) await t.test(signal ?? "nonzero exit", async () => {
    const id = "a".repeat(64), task = "browser-abcdef", calls = [], owned = new OwnedDocker(task);
    const replacement = mock.method(childProcess, "spawn", (binary, args) => {
      assert.equal(binary, "docker"); calls.push(args);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
      process.nextTick(() => {
        child.stdout.end(args[0] === "create" ? id + "\n" : ""); child.stderr.end("Synthetic command result");
        child.emit("close", args[0] === "create" ? signal ? null : 1 : args[0] === "inspect" ? 1 : 0, args[0] === "create" ? signal : null);
      });
      return child;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(owned.create(task, [], "sha256:" + "b".repeat(64)), (error) => error.receipt.signal === signal);
      assert.ok(owned.containers.has(id));
      await assert.rejects(owned.remove(id), /docker inspect: exit 1/);
      assert.deepEqual(calls.at(-1), ["rm", "-f", "-v", id]);
      assert.equal(owned.containers.has(id), false);
    } finally { replacement.mock.restore(); syncBuiltinESMExports(); }
  });
});

test("native workload source is fixed by case, not agreement between saved claims", async (t) => {
  const task = "browser-abcdef", commit = "a".repeat(40), id = "a".repeat(64), imageId = "sha256:" + "b".repeat(64), app = "nextjs";
  for (const source of ["fixture", "api"]) {
    const profile = plan.cases.find((p) => p.source === source), opposite = source === "fixture" ? "api" : "fixture";
    for (const mode of ["matched", "opposite environment", "missing environment", "duplicate environment", "opposite created source", "opposite running source", "opposite provenance", "opposite context", "missing context source"]) await t.test(`${source}: ${mode}`, () => {
      const provenance = { containerId: id, imageId, startedAt: "2026-11-13T01:00:00Z", stillSameProcess: true, source: mode === "opposite provenance" ? opposite : source };
      const image = { Id: imageId, Config: { Entrypoint: ["node"], Cmd: ["server.mjs"] } };
      const info = { Id: id, Name: "/synthetic-source", Image: imageId, Config: { ...image.Config,
        Env: mode === "missing environment" ? [] : [`MARKETPLACE_SOURCE=${mode === "opposite environment" ? opposite : source}`], Labels: { "agent.owner": "codex", "agent.task": task } }, RestartCount: 0,
      State: { Status: "created", Running: false, Paused: false, Restarting: false, OOMKilled: false, Dead: false, Pid: 0, ExitCode: 0, StartedAt: "", FinishedAt: "" },
      HostConfig: { NanoCpus: 1000000000, CpuQuota: 0, CpuPeriod: 0, CpusetCpus: "", Memory: 1024 ** 3, MemorySwap: 2 * 1024 ** 3, ShmSize: 64 * 1024 ** 2, PidsLimit: null, NetworkMode: "bridge" }, Mounts: [] };
      const created = participantSnapshot(info, image); info.State = { ...info.State, Status: "running", Running: true, Pid: 123, StartedAt: provenance.startedAt };
      const terminal = participantSnapshot(info, image), meta = { role: "application", app, case: profile.key };
      const events = [{ event: "command", operation: "create", ...meta, at: 2, id, code: 0 },
        { event: "participant", phase: "created", ...meta, at: 2, snapshot: created }, { event: "command", operation: "start", ...meta, at: 3, id, code: 0 },
        { event: "participant", phase: "running", ...meta, at: 4, snapshot: terminal }, { event: "browser-window", app, case: profile.key, startedAt: 5, endedAt: 14, at: 14 },
        { event: "participant", phase: "terminal", ...meta, at: 15, snapshot: terminal }, { event: "remove", kind: "container", id, code: 0, at: 16 },
        { event: "inventory", kind: "container", scope: "all", code: 0, ids: [], at: 17 },
        ...["container", "network", "image", "volume"].map((kind) => ({ event: "inventory", kind, scope: "owned", code: 0, ids: [], at: 18 }))];
      events.forEach((e, seq) => { e.seq = seq; });
      if (mode === "duplicate environment") for (const e of events.filter((e) => e.event === "participant")) e.snapshot = { ...e.snapshot, env: [["MARKETPLACE_SOURCE", source], ["MARKETPLACE_SOURCE", source]] };
      if (mode === "opposite created source" || mode === "opposite running source") {
        const e = events.find((e) => e.event === "participant" && e.phase === mode.split(" ")[1]);
        e.snapshot = { ...e.snapshot, env: [["MARKETPLACE_SOURCE", opposite]] };
      }
      if (mode === "duplicate environment") {
        assert.throws(() => replayExecution({ json: () => ({ schema: "native-browser-execution/v2", task, commit, startedAt: 1, endedAt: 20, events }) }, null));
        assert.throws(() => validateExecutionSources(events), /source/i);
        return;
      }
      const execution = replayExecution({ json: () => ({ schema: "native-browser-execution/v2", task, commit, startedAt: 1, endedAt: 20, events }) }, null);
      assert.deepEqual(execution.blocked, []); assert.equal(execution.cleanupComplete, true);
      if (["opposite created source", "opposite running source"].includes(mode)) {
        assert.throws(() => validateExecutionSources(events), /source/i);
      } else if (mode.includes("context")) {
        for (const role of ["application", "ssr-parser", "mutation-other"]) {
          const context = { id: "source-context", role, app, case: profile.key, source: mode === "missing context source" ? null : opposite,
            javaScriptEnabled: role === "application" ? profile.js : false,
            createStartedAt: 6, createdAt: 7, closeStartedAt: 10, closeEventAt: 11, closeCompletedAt: 12, absentAfter: true };
          const browserTerminal = { closeStartedAt: 16, disconnectedAt: 17, closeCompletedAt: 18, connectedAfter: false, contextsBefore: [] };
          if (mode === "missing context source") assert.equal(validateContextReceipts([context], browserTerminal, execution), false);
          else assert.throws(() => validateContextReceipts([context], browserTerminal, execution), /source/i);
        }
      } else if (mode === "missing environment") {
        assert.equal(validateExecutionSources(events), false);
        assert.equal(validateCaseParticipant(app, profile.key, { provenance }, execution), false);
      } else if (mode === "matched") {
        assert.equal(validateExecutionSources(events), true);
        assert.equal(validateCaseParticipant(app, profile.key, { provenance }, execution), true);
      }
      else assert.throws(() => validateCaseParticipant(app, profile.key, { provenance }, execution), /source/i);
    });
  }
});

test("native prerequisite dispositions require exact bounded command and terminal witnesses", () => {
  const app = "nextjs", key = plan.cases[0].key, id = "a".repeat(64);
  const cell = { case: key, outcome: "failed", qualificationPassed: false, evidence: null, reason: "not authority" };
  const summary = { options: { build: true }, builds: { [app]: { passed: false } }, images: { [app]: { id: "sha256:" + "b".repeat(64) } } };
  const build = { seq: 0, operation: "build", role: "artifact", app, case: null, id: null, code: 1 };
  const execution = { commands: [build], participants: [] };
  assert.deepEqual(replayPrerequisite(cell, app, summary, execution, new Set([app])), { prerequisite: "native-build-rejected", command: 0 });
  for (const changed of [{ ...build, code: 0 }, { ...build, app: "nuxt" }, { ...build, role: "application" }, { ...build, case: key }])
    assert.equal(replayPrerequisite(cell, app, summary, { ...execution, commands: [changed] }, new Set([app])), null);
  assert.equal(replayPrerequisite(cell, app, summary, execution, new Set()), null);
  assert.equal(replayPrerequisite({ ...cell, outcome: "unsupported" }, app, summary, execution, new Set([app])), null);
  const create = { seq: 1, operation: "create", role: "application", app, case: key, id: null, code: 1 };
  assert.equal(replayPrerequisite(cell, app, summary, { ...execution, commands: [create] }, new Set()).prerequisite, "native-create-rejected");
  const start = { ...create, seq: 2, operation: "start", id }, participant = { id, role: "application", app, case: key, imageId: summary.images[app].id, window: null, terminal: { state: { Status: "created" }, env: [["MARKETPLACE_SOURCE", plan.cases[0].source]] } };
  const failedStart = { commands: [{ ...create, code: 0, id }, start], participants: [participant] };
  assert.equal(replayPrerequisite(cell, app, summary, failedStart, new Set()).prerequisite, "native-start-rejected");
  for (const changed of [{ ...failedStart, commands: failedStart.commands.slice(1) }, { ...failedStart, commands: [...failedStart.commands, start] },
    { ...failedStart, participants: [] }, { ...failedStart, participants: [{ ...participant, window: { startedAt: 1, endedAt: 2 } }] },
    { ...failedStart, participants: [{ ...participant, terminal: null }] }, { ...failedStart, participants: [{ ...participant, terminal: { ...participant.terminal, env: [] } }] }])
    assert.equal(replayPrerequisite(cell, app, summary, changed, new Set()), null);
});

test("native selected completeness never substitutes for whole matrix or missing proof", () => {
  const app = "nextjs", key = plan.cases[0].key;
  const summary = { options: { apps: [app], cases: [key] }, cells: { [app]: [{ case: key, qualificationPassed: false }] } };
  const row = { app, case: key, outcome: "failed", blocked: [], derived: { prerequisite: "native-start-rejected", command: 2 } };
  assert.deepEqual(nativeAttemptCells([row], summary)[0], { ...row, selected: true, attemptComplete: true, qualificationPassed: false, disposition: "observed-prerequisite-failure" });
  for (const changed of [{ ...row, derived: null }, { ...row, blocked: ["missing-proof"] }])
    assert.equal(nativeAttemptCells([changed], summary)[0].disposition, "proof-missing");
  assert.equal(nativeAttemptCells([{ ...row, app: "nuxt" }], summary)[0].disposition, "not-selected");
});

test("native context terminal observations require unique context and actual close chronology", () => {
  const execution = { executionWindow: { startedAt: 1, endedAt: 20 }, processWindows: [{ app: "nextjs", case: plan.cases[0].key, startedAt: 2, endedAt: 15 }] };
  const context = { id: "own-context", role: "application", app: "nextjs", case: plan.cases[0].key, source: "fixture", createStartedAt: 3, createdAt: 4,
    javaScriptEnabled: plan.cases[0].js,
    closeStartedAt: 10, closeEventAt: 11, closeCompletedAt: 12, absentAfter: true };
  const terminal = { closeStartedAt: 16, disconnectedAt: 17, closeCompletedAt: 18, connectedAfter: false, contextsBefore: [] };
  assert.equal(validateContextReceipts([context], terminal, execution), true);
  assert.throws(() => validateContextReceipts([context, context], terminal, execution));
  for (const changed of [{ ...context, absentAfter: false }, { ...context, closeEventAt: null }, { ...context, createdAt: 1 }, { ...context, closeCompletedAt: 16 }])
    assert.equal(validateContextReceipts([changed], terminal, execution), false);
  assert.equal(validateContextReceipts([context], { ...terminal, contextsBefore: [context.id] }, execution), false);
});

test("native journey identity must match its original execution participant and process window", () => {
  const app = "nextjs", key = plan.cases[0].key;
  const p = { containerId: "a".repeat(64), imageId: "sha256:" + "b".repeat(64), startedAt: "native-start", stillSameProcess: true, source: plan.cases[0].source };
  const participant = { id: p.containerId, imageId: p.imageId, role: "application", app, case: key, window: { startedAt: 1, endedAt: 10 },
    terminal: { state: { Running: true, StartedAt: p.startedAt }, restartCount: 0, env: [["MARKETPLACE_SOURCE", p.source]] } };
  const execution = { participants: [participant], processWindows: [{ app, case: key, startedAt: 2, endedAt: 9 }] };
  assert.equal(validateCaseParticipant(app, key, { provenance: p }, execution), true);
  for (const changed of [{ ...p, containerId: "c".repeat(64) }, { ...p, imageId: "sha256:" + "c".repeat(64) }, { ...p, startedAt: "transplanted" }])
    assert.throws(() => validateCaseParticipant(app, key, { provenance: changed }, execution));
  assert.equal(validateCaseParticipant(app, key, { provenance: p }, { ...execution, participants: [] }), false);
  assert.equal(validateCaseParticipant(app, key, { provenance: p }, { ...execution, participants: [{ ...participant, terminal: null }] }), false);
  for (const changed of [{ ...execution, participants: [participant, participant] },
    { ...execution, processWindows: [{ app, case: key, startedAt: 0, endedAt: 9 }] },
    { ...execution, participants: [{ ...participant, terminal: { ...participant.terminal, restartCount: 1 } }] }])
    assert.throws(() => validateCaseParticipant(app, key, { provenance: p }, changed));
});
test("native caller retains all bound inputs including imported helpers and non-module files", () => {
  const paths = ["bench/mixed-production/immutable-git.mjs", "bench/workloads/isolated/evidence.mjs", "scripts/steady.mjs", "README.md"];
  const files = paths.map((path) => ({ path, sha256: sha256(readFileSync(new URL(`../../${path}`, import.meta.url))) }));
  const bodies = new Map(), store = { blob(body) {
    const ref = { path: `native-evidence/blobs/${sha256(body)}`, bytes: body.length, sha256: sha256(body) };
    bodies.set(ref.path, Buffer.from(body)); return ref;
  } };
  const rows = captureLiveInputs(store, { files }), reader = { json: () => rows, read: (ref) => bodies.get(ref.path) };
  assert.deepEqual(rows.map((r) => r.path), paths, "Imported/non-.mjs sources must not disappear behind runnerFiles");
  assert.deepEqual(replayLiveInputs(reader, null, { files }), rows);
  for (const mutate of [
    (r) => r.pop(), (r) => r.reverse(), (r) => { r[0].canonicalSha256 = "0".repeat(64); },
    (r) => { r[0].body = store.blob(Buffer.from("substituted helper")); }, (r) => { r[0].extra = true; },
  ]) {
    const changed = structuredClone(rows); mutate(changed);
    assert.throws(() => replayLiveInputs({ ...reader, json: () => changed }, null, { files }));
  }
  const normalized = files.map((f) => ({ ...f, sha256: sha256(bodies.get(rows.find((r) => r.path === f.path).body.path).toString("utf8").replaceAll("\r\n", "\n")) }));
  const crlf = rows.map((r) => ({ ...r, canonicalSha256: normalized.find((f) => f.path === r.path).sha256,
    body: store.blob(Buffer.from(bodies.get(r.body.path).toString("utf8").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"))) }));
  assert.deepEqual(replayLiveInputs({ ...reader, json: () => crlf }, null, { files: normalized }), crlf);
});
test("React endpoint syntax controls are independent and fail closed", () => {
  const handlerSource = 'async e=>{e.preventDefault();await fetch("/api/marketplace/"+encodeURIComponent(r.id)+"?locale="+l,{method:"POST",body:"safe"});}';
  const observed = { handlerSource, componentSource: `function M({record:r,locale:l}){const submit=${handlerSource};return null}`,
    recordId: "item_2", locale: "fr-FR", action: "http://local/marketplace/fr-FR/item_2", base: "http://local/marketplace/fr-FR/item_2", basis: "mounted-react-onSubmit-and-owning-fiber-props" };
  const result = discoverReactEndpoint([observed]);
  assert.equal(result.path, "/api/marketplace/item_2"); assert.equal(result.locale, "fr-FR"); assert.equal(result.handlerSha256.length, 64);
  for (const source of [handlerSource.replace("POST", "GET"), handlerSource.replace('body:"safe"', 'body:e'), handlerSource.replace("r.id", '"item_1"'),
    handlerSource.replace("/api/marketplace/", "https://attacker.invalid/api/marketplace/"),
    'e=>fetch(unknown(r.id),{method:"POST"})', 'e=>{const r={id:"item_2"};fetch("/api/marketplace/"+r.id+"?locale="+l,{method:"POST"});}']) {
    assert.equal(discoverReactEndpoint([{ ...observed, handlerSource: source, componentSource: `function M({record:r,locale:l}){const submit=${source};return null}` }]), null);
  }
  assert.equal(discoverReactEndpoint([{ ...observed, action: "http://local/marketplace/en-US/item_2" }]), null);
  assert.equal(discoverReactEndpoint([{ ...observed, componentSource: "function M({record:r,locale:l}){return null}" }]), null);
  const nativeCatch = handlerSource.replace('e.preventDefault();await', 'e.preventDefault();try{await').replace(';}', ';}catch(r){console.error(r)}}');
  assert.equal(discoverReactEndpoint([{ ...observed, handlerSource: nativeCatch, componentSource: `function M({record:r,locale:l}){const submit=${nativeCatch};return null}` }]).path, "/api/marketplace/item_2");
});
test("Livewire public input uses independently captured named field models and component identity", () => {
  const request = req({ method: () => "POST", headers: () => ({ "x-livewire": "", "content-type": "application/json" }),
    postData: () => JSON.stringify({ components: [{ snapshot: JSON.stringify({ memo: { id: "actual" }, data: { email: "before@example.test", target: "0", token: "SECRET" } }), updates: { email: "native@example.test", target: "1,25" } }] }) });
  const form = { component: "actual", models: { email: "email", target_price: "target" } };
  assert.deepEqual(publicInput(request, form), { input: { email: "native@example.test", target_price: "1,25" }, components: ["actual"] });
  assert.equal(publicInput(request).input.target_price, null);
  assert.deepEqual(publicInput(request, { ...form, component: "different" }).input, { email: null, target_price: null });
  assert.ok(!JSON.stringify(publicInput(request, form)).includes("SECRET"));
});
test("SvelteKit native data normalization requires successful physical framework payload and transport", () => {
  const request = { id: "observed", method: "GET", path: "/marketplace/fr-FR/item_2/__data.json", status: 200, transport: "router", input: null, components: [],
    resource: "fetch", type: "application/json", nativeData: { framework: "sveltekit", type: "data", nodes: [null, "data"] } };
  const env = { app: "sveltekit", architecture: "sveltekit", js: true };
  assert.equal(navigationDestination(request, env), "/marketplace/fr-FR/item_2");
  for (const change of [{ status: 404 }, { failure: "aborted" }, { transport: "document" }, { resource: "script" }, { type: "text/html" }, { nativeData: null }, { nativeData: { framework: "sveltekit", type: "redirect", nodes: ["data"] } }]) {
    assert.equal(navigationDestination({ ...request, ...change }, env), request.path);
  }
  assert.equal(navigationDestination(request, { ...env, js: false }), request.path);
  assert.equal(navigationDestination(request, { ...env, app: "nextjs" }), request.path);
  const raw = { architecture: "sveltekit", environment: { js: true }, steps: [{ requests: [request] }] };
  const normalized = normalizeSvelteKitCase(structuredClone(raw));
  assert.equal(normalized.steps[0].requests[0].path, "/marketplace/fr-FR/item_2");
  assert.equal(raw.steps[0].requests[0].path, "/marketplace/fr-FR/item_2/__data.json");
  assert.deepEqual(Object.keys(normalized.steps[0].requests[0]).sort(), ["id", "method", "path", "status", "transport", "input", "components"].sort());
  assert.equal(missingAction("/api/marketplace/item_2", "item_2"), "/api/marketplace/item_missing");
  assert.equal(missingAction("/marketplace/fr-FR/item_1", "item_1"), "/marketplace/fr-FR/item_missing");
  assert.throws(() => missingAction("/unrelated/item_2", "item_2"));
});
test("semantic observer preserves document replacement and does not swallow other errors", async () => {
  const transitions = []; let samples = 0;
  await waitForSemanticChange({ evaluate: async () => {
    if (samples++ === 0) throw new Error("Execution context was destroyed, most likely because of a navigation");
    return "new native document";
  } }, "old native document", transitions);
  assert.equal(samples, 2); assert.equal(transitions.length, 1);
  assert.match(transitions[0].error, /Execution context was destroyed/);
  await assert.rejects(waitForSemanticChange({ evaluate: async () => { throw new Error("actual observer failure"); } }, "before"), /actual observer failure/);
});
test("full registry matrix and retained contenders, independent of selected targets", () => {
  const cells = emptyCells(plan);
  assert.equal(candidates.length, 10); assert.equal(plan.cases.length, 24);
  assert.equal(Object.values(cells).flat().length, 240);
  for (const app of ["laravel", "rails", "react-router", "leptos"]) assert.equal(cells[app].length, 24);
  assert.ok(Object.values(cells).flat().every((v) => v.outcome === "not-run" && v.evidence === null && v.qualificationPassed === false));
});
test("explicit round/options fail closed without dropping candidates", () => {
  const options = parseOptions(["w1", "--targets", "targets.json", "--out", "work/w1", "--apps", "nextjs,laravel"]);
  assert.equal(options.round, "w1"); assert.deepEqual(options.apps, ["nextjs", "laravel"]);
  assert.equal(parseOptions(["w2", "--build", "--out", "work/w2"]).build, true);
  for (const args of [["r20"], [], ["w1", "--targets", "a", "--targets", "b"], ["w1", "--targets", "a", "--out", "b", "--apps", "phoenix"]]) assert.throws(() => parseOptions(args));
});
test("build workflow uses all approved native Dockerfiles and honest source labels", () => {
  for (const app of candidates) {
    const build = nativeBuildArgs({ app, repo: "/checkout", task: "browser-abcd", commit: "commit", dirty: true, snapshot: "digest" });
    assert.equal(build.tag, `browser-abcd-${app}`);
    assert.ok(build.args.includes("agent.owner=codex"));
    assert.ok(build.args.includes("run.corten.browser.dirty=true"));
    if (app === "corten") assert.equal(build.context, "/checkout");
    if (app === "sveltekit") assert.match(build.dockerfile, /Dockerfile.marketplace$/);
    assert.ok(!build.args.includes("PROFILE=matched"), "do not silently substitute architecture/profile");
  }
  assert.equal(publishPort("sveltekit"), "127.0.0.1:8080:8080");
  assert.equal(publishPort("nextjs"), "127.0.0.1::8080");
});
test("target manifest cannot substitute endpoints or arbitrary environment", () => {
  const manifest = { schema: "native-fullstack-browser-targets/v1", targets: { nextjs: { image: "cb-marketplace-nextjs" } } };
  assert.equal(validateTargets(manifest).nextjs.image, "cb-marketplace-nextjs");
  for (const readback of [{ path: "//remote/store" }, { path: "/marketplace/en-US/item_1" }, { path: "/store?token=secret" }]) assert.throws(() => validateTargets({ ...manifest, targets: { nextjs: { ...manifest.targets.nextjs, readback } } }));
  assert.throws(() => validateTargets({ ...manifest, targets: { nextjs: { ...manifest.targets.nextjs, environment: {} } } }));
});
test("public ledger strips tokens, request headers, and unknown query fields", () => {
  assert.deepEqual(publicURL("http://local/marketplace/en-US/item_1?seller=Alice&token=SECRET&sort=desc"), { path: "/marketplace/en-US/item_1", query: { seller: "Alice", sort: "desc" } });
  const r = req({ method: () => "POST", headers: () => ({ "content-type": "application/x-www-form-urlencoded", cookie: "SECRET" }), postData: () => "email=a%40b.test&target_price=1.25&_token=SECRET" });
  assert.deepEqual(publicInput(r), { input: { email: "a@b.test", target_price: "1.25" }, components: [] });
  assert.ok(!JSON.stringify(publicInput(r)).includes("SECRET"));
});
test("native transport uses observed request signals, never the framework label", () => {
  assert.equal(transportOf(req({ isNavigationRequest: () => true })), "document");
  assert.equal(transportOf(req({ headers: () => ({ "x-livewire": "" }) })), "livewire");
  assert.equal(transportOf(req({ headers: () => ({ "x-turbo-request-id": "abc" }) })), "turbo");
  assert.equal(transportOf(req({ url: () => "http://local/_next/data/build/marketplace/en-US/item_2.json" })), "router");
  const input = publicInput(req({ method: () => "POST", headers: () => ({ "x-livewire": "", "content-type": "application/json" }),
    postData: () => JSON.stringify({ components: [{ snapshot: JSON.stringify({ memo: { id: "component-a" }, data: { email: "a@b.test", target_price: "1.25", token: "SECRET" } }), updates: { target_price: "0" } }] }) }));
  assert.deepEqual(input, { input: { email: "a@b.test", target_price: "0" }, components: ["component-a"] });
});
test("Blade and controller substitutions cannot qualify Livewire/Hotwire", () => {
  const steps = [{ dom: { native: { components: [], form: { binding: null }, turbo: false } }, action: { kind: "initial" }, requests: [] },
    { action: { kind: "accepted-write", input: {} }, requests: [{ method: "POST", transport: "document", components: [] }] }];
  assert.match(nativeFailures("laravel", { js: true }, steps).join(" "), /Blade is not Livewire/);
  assert.match(nativeFailures("rails", { js: true }, steps).join(" "), /controller document fallback/);
  assert.equal(architecture("laravel", steps[0].dom.native), "blade");
  assert.equal(architecture("rails", steps[0].dom.native), "rails-controller");
  steps[0].dom.native.turbo = true; steps[0].dom.native.turboDisabled = true;
  assert.equal(architecture("rails", steps[0].dom.native), "rails-controller");
  steps[1].requests.push({ method: "POST", transport: "turbo", path: "/unrelated", status: 200 });
  assert.match(nativeFailures("rails", { js: true }, steps).join(" "), /controller document fallback/);
});
test("source commit is not guessed from an image tag or current checkout", () => {
  const image = { Id: "sha256:immutable", RepoDigests: [], Config: { Labels: {} } };
  assert.equal(imageEvidence(image, "commit").imageSourceVerified, false);
  assert.equal(imageEvidence(image, "commit").builtCommit, null);
  image.Config.Labels = { "run.corten.marketplace.commit": "commit", "run.corten.marketplace.dirty": "false" };
  assert.equal(imageEvidence(image, "commit").imageSourceVerified, true);
  assert.equal(imageEvidence(image, "different").imageSourceVerified, false);
});
test("network observer saves measured encoded/decoded bytes and sanitized native inputs", async () => {
  const page = new EventEmitter(), ledger = observeNetwork(page);
  const response = { status: () => 200, headers: () => ({ "content-type": "text/html", "content-encoding": "gzip", "set-cookie": "SECRET" }), body: async () => Buffer.from("actual response") };
  const r = req({ method: () => "POST", isNavigationRequest: () => true,
    headers: () => ({ "content-type": "application/x-www-form-urlencoded" }), postData: () => "email=a%40b.test&target_price=1.25&csrf=SECRET",
    response: async () => response, sizes: async () => ({ responseBodySize: 12, responseHeadersSize: 80 }) });
  response.request = () => r;
  page.emit("request", r); page.emit("response", response); page.emit("requestfinished", r); await ledger.drain();
  assert.deepEqual(ledger.rows[0].bytes, { encodedBody: 12, headers: 80, decodedBody: 15 });
  assert.equal(ledger.rows[0].status, 200); assert.deepEqual(ledger.failures, []);
  assert.ok(!JSON.stringify(ledger.rows).includes("SECRET"));
});
test("uses existing strict no-JS preload classification, retaining CSP/request evidence", () => {
  const rows = [{ path: "/page", resource: "document", hasCsp: false }, { path: "/entry.js", resource: "script", failure: "csp", status: null }];
  const dom = { native: { hasMetaCsp: false, preloads: [{ path: "/entry.js", rel: "modulepreload", as: "" }] } };
  classifyDisabledPreloads(rows, dom, false); assert.equal(rows[1].intentionallyDisabledPreload, true);
  assert.equal(rows[1].failure, "csp"); assert.equal(rows[1].status, null);
  classifyDisabledPreloads(rows, dom, true); assert.equal(rows[1].intentionallyDisabledPreload, false);
  rows[0].hasCsp = true;
  classifyDisabledPreloads(rows, dom, false); assert.equal(rows[1].intentionallyDisabledPreload, false);
});
test("multipart native input is parsed without exposing hidden tokens", async () => {
  const page = new EventEmitter(), ledger = observeNetwork(page);
  const f = new FormData(); f.set("email", "a@b.test"); f.set("target_price", "1,25"); f.set("csrf", "SECRET");
  const wire = new Request("http://local/", { method: "POST", body: f }); const body = Buffer.from(await wire.arrayBuffer());
  page.emit("request", req({ method: () => "POST", headers: () => ({ "content-type": wire.headers.get("content-type") }), postDataBuffer: () => body }));
  await ledger.drain(); assert.deepEqual(ledger.rows[0].input, { email: "a@b.test", target_price: "1,25" });
  assert.ok(!JSON.stringify(ledger.rows).includes("SECRET"));
});
async function listening(server, work) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { return await work(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}
test("independent upstream counts actual completed reads including 404s", async () => {
  await listening(createUpstream({ item_1: { id: "item_1", numeric: 125 } }), async (base) => {
    const counters = async () => (await fetch(base + "/__browser/counters")).json(); const before = await counters();
    assert.deepEqual(await (await fetch(base + "/marketplace/records/item_1")).json(), { id: "item_1", numeric: 125 });
    assert.equal((await fetch(base + "/marketplace/records/item_missing")).status, 404);
    const delta = upstreamDelta(before, await counters()); assert.equal(delta.started, 2); assert.equal(delta.completed, 2); assert.equal(delta.pending, 0);
  });
});
test("readback reads an independent store and refuses message-shaped success", async () => {
  let store = [];
  const server = createServer((_, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ alerts: store })); });
  const api = { get: async (url) => { const r = await fetch(url); return { status: () => r.status, headers: () => Object.fromEntries(r.headers), json: () => r.json() }; } };
  await listening(server, async (base) => {
    assert.deepEqual((await readStore(base, { path: "/store" }, api)).alerts, []);
    store = [{ item_id: "item_2", email: "a@b.test", target_minor: 125 }];
    assert.deepEqual((await readStore(base, { path: "/store" }, api)).alerts, store);
  });
  assert.equal((await readStore("http://127.0.0.1", null)).outcome, "unsupported");
  assert.throws(() => alertsFromReadback({ message: "Alert set" }));
  assert.deepEqual(alertsFromReadback(store), store);
  await assert.rejects(readStore("http://127.0.0.1", { path: "/store" }), /cookie jar/);
  assert.throws(() => alertsFromReadback({ alerts: [{ item_id: "item_2", email: "a@b.test", target_minor: 125, csrf: "SECRET" }] }));
});
