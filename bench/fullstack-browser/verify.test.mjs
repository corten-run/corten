// Synthetic unavailable diagnostics and actual HTTP receipts, never qualification captures.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSaved } from "./verify.mjs";
import { candidates, emptyCells, retainedFamilies, schema, settings, sha256 } from "./contract.mjs";
import { records as fixtureRecords } from "../marketplace/fixtures.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { exportBrowserCaptures } from "./capture.mjs";
import { createUpstream, UpstreamAudit, reconcileUpstream } from "./upstream.mjs";
import { reconcileRequests } from "./ledger.mjs";
import { classifyNoJSRequests, validatePlatformRetirement } from "./lifecycle.mjs";
import { PlatformLifecycle } from "./lifecycle.mjs";
import { installResourceObserver, ResourceAudit } from "./resources.mjs";
import { beginBindingWindow, finishBindingWindow } from "./binding-window.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), script = join(repo, "bench/fullstack-browser/verify.mjs");
const commit = "a".repeat(40), records = fixtureRecords(), plan = createBrowserPlan({ records });
const pretty = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const runnerFiles = Object.fromEntries(readdirSync(dirname(script)).filter((p) => p.endsWith(".mjs")).sort()
  .map((p) => [p, sha256(readFileSync(join(dirname(script), p)))]));

function unavailable() {
  return { schema, group: "fullstack-browser", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", task: "browser-abcdef12",
    effectivePlan: structuredClone(plan), settings: structuredClone(settings), code: { commit, dirty: false, status: "", runnerFiles: structuredClone(runnerFiles), runnerDiffSha256: sha256("") },
    fixtureSha256: sha256(JSON.stringify(records)), targetsSha256: sha256("unbundled apparatus targets"),
    host: { hostname: "synthetic-unavailable", platform: process.platform, release: "apparatus", node: process.version },
    options: { round: "w1", targets: "targets.json", out: "bench/fullstack-browser/work/verify-apparatus", apps: ["nuxt"], cases: null, build: false },
    images: {}, builds: {}, browser: null, cells: emptyCells(plan), complete: false, qualificationPassed: false, readyForLoad: false,
    retainedFamilies: retainedFamilies.map((f) => ({ ...f, outcome: "not-run", reason: "Retained; not replaced by native browser diagnostics" })),
    limits: ["Synthetic unavailable apparatus, not native contender execution"], cleanupFailures: [], failures: ["No native execution attempted"] };
}

function fixture(t, summary = unavailable()) {
  const folder = mkdtempSync(join(tmpdir(), "browser-verify-"));
  const expectedRound = summary.options.round, expectedCommit = summary.code.commit;
  // Only this freshly created absolute directory is removed, never a saved run.
  t.after(() => { assert.equal(dirname(resolve(folder)), resolve(tmpdir())); rmSync(folder, { recursive: true, force: true }); });
  mkdirSync(join(folder, "captures")); writeFileSync(join(folder, "marketplace.json"), JSON.stringify(records));
  const save = (reproject = true) => {
    if (reproject) {
      const exported = exportBrowserCaptures(summary, records);
      for (const app of candidates) pretty(join(folder, `captures/${app}.json`), exported.captures[app]);
      pretty(join(folder, "captures/manifest.json"), exported.manifest);
      summary.strictCaptureExport = { manifest: "captures/manifest.json", functionalPassed: Object.values(exported.manifest.reports).every((r) => r.validation.functionalPassed), readyForLoad: false };
    }
    pretty(join(folder, "summary.json"), summary);
  };
  save(); return { folder, summary, save, check: () => validateSaved({ folder, round: expectedRound, commit: expectedCommit }) };
}
function treeHashes(folder) {
  const values = [];
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name), stat = lstatSync(path);
    values.push([path, stat.isDirectory() ? treeHashes(path) : sha256(readFileSync(path))]);
  }
  return values;
}

test("native v2 malformed namespace is awaitable invalid evidence, never an observed target failure", async (t) => {
  const f = fixture(t); mkdirSync(join(f.folder, "native-evidence"));
  const before = treeHashes(f.folder), result = await f.check();
  assert.equal(result.schema, "native-browser-saved-validation/v2");
  assert.equal(result.status, "invalid"); assert.ok(result.invalid.length);
  assert.equal(result.attemptComplete, false); assert.equal(result.selectedComplete, false);
  assert.equal(result.qualificationPassed, false); assert.equal(result.cleanupComplete, false); assert.equal(result.hostSubject, null);
  assert.equal(result.expectedExitCode, 1); assert.deepEqual(treeHashes(f.folder), before);
  const cli = spawnSync(process.execPath, [script, "--folder", f.folder, "--round", "w1", "--commit", commit], { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(cli.status, 1); assert.equal(cli.signal, null);
  const saved = JSON.parse(cli.stdout); assert.equal(saved.schema, result.schema); assert.equal(saved.status, "invalid"); assert.equal(saved.expectedExitCode, 1);
  assert.deepEqual(treeHashes(f.folder), before);
});
function failedRaw(summary, profile = plan.cases.find((p) => p.source === "api"), app = "nuxt") {
  const cell = summary.cells[app].find((c) => c.case === profile.key);
  Object.assign(cell, { outcome: "failed", reason: "Native apparatus deliberately unavailable", qualificationPassed: false, evidence: {
    environment: { ...structuredClone(settings.profiles[profile.device]), js: profile.js }, architecture: null, clock: { origin: "node.performance.now", startedAt: 0 }, steps: [],
    failures: ["Native apparatus deliberately unavailable"], gaps: ["No native observations"], functionalChecksPassed: false, domChecksPassed: false, nativeCleanup: null,
  } });
  return { cell, e: cell.evidence, profile };
}

test("native binding-clock journal survives saved validation as an honest incomplete diagnostic", { timeout: 60000 }, async (t) => {
  const summary = unavailable(), { e, profile } = failedRaw(summary, plan.cases.find((p) => p.js && p.source === "fixture"), "nextjs");
  summary.options.apps = ["nextjs"];
  e.clock.startedAt = performance.now(); e.bindingInstance = randomUUID();
  const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end('<article class="marketplace"><section class="marketplace__alert"><form></form></section></article>'); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const browser = await chromium.launch({ headless: true }); let lifecycle;
  try {
    const context = await browser.newContext(); await context.addInitScript(installResourceObserver);
    const page = await context.newPage(), cdp = await context.newCDPSession(page);
    lifecycle = new PlatformLifecycle(cdp, await browser.newBrowserCDPSession(), { javaScriptEnabled: true });
    await lifecycle.enable(); await lifecycle.enableDomains(); await lifecycle.startObservation();
    await page.goto("about:blank");
    await page.setContent('<article class="marketplace"><section class="marketplace__alert"><form></form></section></article>');
    const resources = new ResourceAudit(page, cdp, true, lifecycle);
    e.resourceBaseline = await resources.checkpoint(); lifecycle.markApplicationStart();
    const row = { action: structuredClone(profile.steps[0]), at: performance.now() - e.clock.startedAt,
      timing: { dispatchMs: 0, visibleChangeObservedMs: 0, settledObservedMs: 0 }, requests: [], document: null,
      domPassed: false, failures: ["Only native clock observations collected; no marketplace semantic proof"], lifecycleFailures: [], errors: [] };
    e.steps.push(row);
    row.bindingWindow = await beginBindingWindow(cdp, lifecycle, resources, { instance: e.bindingInstance, case: profile.key, action: row.action.id });
    await finishBindingWindow(lifecycle, row.bindingWindow, null);
    row.dispatchStartedAt = performance.now();
    await page.goto(`http://127.0.0.1:${server.address().port}${row.action.path}`);
    row.resourcesAtDOM = await resources.checkpoint();
    row.dom = { observer: randomUUID(), scope: row.resourcesAtDOM.scope, url: { path: row.action.path }, page: null, native: {} };
    await lifecycle.finishObservation({ observationMs: 0 }); e.platformLifecycle = lifecycle.snapshot();
    e.requestLedgerEndedAt = performance.now();
    await context.close(); e.cleanup = { contextClosed: !browser.contexts().includes(context), nativePageScope: null };
    e.harnessClosedLifecycle = lifecycle.snapshot();
    const f = fixture(t, summary), baseline = f.check();
    assert.deepEqual(baseline.invalid, [], baseline.invalid.join("; ")); assert.equal(baseline.outcome, "blocked");
    assert.equal(baseline.qualificationPassed, false); assert.equal(baseline.readyForLoad, false);
    assert.ok(baseline.blocked.length, "Native/source/response/peer limitations remain blocked, not erased");
    const original = structuredClone(e);
    for (const [name, mutate] of [
      ["binding pair at terminal native time", (e) => {
        const at = e.platformLifecycle.events.find((r) => r.phase === "terminal-native-clock").at;
        for (const j of [e.platformLifecycle, e.harnessClosedLifecycle]) j.events.filter((r) => r.phase?.startsWith("binding-")).forEach((r) => { r.at = at; });
      }],
      ["binding pair at initial native time", (e) => {
        const at = e.platformLifecycle.events.find((r) => r.phase === "initial-native-clock").at;
        for (const j of [e.platformLifecycle, e.harnessClosedLifecycle]) j.events.filter((r) => r.phase?.startsWith("binding-")).forEach((r) => { r.at = at; });
      }],
      ["unbound clock", (e) => { e.platformLifecycle.events.find((r) => r.phase?.startsWith("binding-")).phase = "binding-other-before-native-clock"; }],
      ["misbound action", (e) => { e.steps[0].bindingWindow.action = "other"; }],
      ["future sample", (e) => { e.platformLifecycle.events.find((r) => r.phase?.startsWith("binding-")).at += 3600; }],
    ]) await t.test(name, () => {
      Object.keys(e).forEach((k) => delete e[k]); Object.assign(e, structuredClone(original)); mutate(e); f.save();
      assert.equal(f.check().outcome, "invalid", name);
    });
  } finally {
    try { if (lifecycle) await lifecycle.close(); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  }
});

test("standalone saved validator retains all 240 unavailable cells, remains blocked and writes nothing", (t) => {
  const f = fixture(t), before = treeHashes(f.folder), result = f.check();
  assert.equal(result.outcome, "blocked", result.invalid.join("; ")); assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.inventory, { candidates: 10, profiles: 24, cells: 240, captureFiles: 10 });
  assert.equal(result.qualificationPassed, false); assert.equal(result.readyForLoad, false);
  assert.match(result.blocked.join("; "), /isolation.*closed-peer.*worker/);
  assert.deepEqual(treeHashes(f.folder), before);
  for (const input of [undefined, null, [], "folder", {}, { folder: f.folder, round: "w1", commit, waiver: true }]) {
    assert.equal(validateSaved(input).outcome, "invalid", "malformed API options return invalid, not an exception or ignored option");
  }
});

test("strict CLI is cwd-independent, offline, and distinguishes blocked from invalid exit codes", (t) => {
  const f = fixture(t), elsewhere = dirname(repo), folder = relative(repo, f.folder);
  // An absolute local folder is relocatable; a repo-relative folder with traversal is not.
  assert.equal(validateSaved({ folder, round: "w1", commit }).outcome, "invalid");
  const invoke = (extra = []) => spawnSync(process.execPath, [script, "--folder", f.folder, "--round", "w1", "--commit", commit, ...extra], {
    cwd: elsewhere, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_DIR: "nonexistent-hostile-git-dir", GIT_WORK_TREE: "nonexistent-hostile-tree",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: "https://must-not-be-contacted.invalid",
      PATH: process.platform === "win32" ? join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0") : "" }, timeout: 60000,
  });
  const child = invoke(); assert.equal(child.status, 1, child.stderr); assert.equal(JSON.parse(child.stdout).outcome, "blocked");
  const duplicate = invoke(["--round", "w1"]); assert.equal(duplicate.status, 2);
  const invalid = spawnSync(process.execPath, [script, "--folder", f.folder, "--round", "r1", "--commit", commit], { cwd: elsewhere, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stdout).outcome, "invalid");
});

test("current inventory, options, raw hashes, provenance, summaries and retained families cannot be substituted", async (t) => {
  const mutations = [
    ["extra candidate", (s) => { s.cells.unknown = s.cells.nuxt; }],
    ["missing candidate", (s) => { delete s.cells.nuxt; }],
    ["missing profile", (s) => { s.cells.nuxt.pop(); }],
    ["extra profile", (s) => { s.cells.nuxt.push(s.cells.nuxt[0]); }],
    ["duplicate profile", (s) => { s.cells.nuxt[1] = s.cells.nuxt[0]; }],
    ["changed plan", (s) => { s.effectivePlan.cases.pop(); }],
    ["changed setting", (s) => { s.settings.observationMs = 0; }],
    ["unknown option", (s) => { s.options.waiver = true; }],
    ["wrong round", (s) => { s.options.round = "w2"; }],
    ["dirty contradiction", (s) => { s.code.dirty = true; }],
    ["wrong commit", (s) => { s.code.commit = "b".repeat(40); }],
    ["malformed runner source", (s) => { s.code.runnerFiles['lifecycle.mjs'] = "not-a-hash"; }],
    ["runner extra", (s) => { s.code.runnerFiles['missing.mjs'] = "0".repeat(64); }],
    ["fixture hash", (s) => { s.fixtureSha256 = "0".repeat(64); }],
    ["clean diff hash", (s) => { s.code.runnerDiffSha256 = "0".repeat(64); }],
    ["retained family", (s) => { s.retainedFamilies.pop(); }],
    ["group promotion", (s) => { s.qualificationPassed = true; }],
    ["readiness promotion", (s) => { s.readyForLoad = true; }],
    ["cell promotion", (s) => { s.cells.nuxt[0].qualificationPassed = true; }],
    ["unsupported without raw", (s) => { s.cells.nuxt[0].outcome = "unsupported"; }],
    ["capture path traversal", (s) => { s.strictCaptureExport.manifest = "../manifest.json"; }],
  ];
  const f = fixture(t), original = structuredClone(f.summary);
  for (const [name, mutate] of mutations) await t.test(name, () => {
    Object.keys(f.summary).forEach((k) => delete f.summary[k]); Object.assign(f.summary, structuredClone(original)); mutate(f.summary); f.save(false);
    assert.equal(f.check().outcome, "invalid", name);
  });
});

test("missing/extra receipts, malformed JSON, capture and manifest tampering are invalid", async (t) => {
  const f = fixture(t);
  const probes = [
    ["missing capture", () => unlinkSync(join(f.folder, "captures/nuxt.json"))],
    ["missing manifest", () => unlinkSync(join(f.folder, "captures/manifest.json"))],
    ["missing raw summary", () => unlinkSync(join(f.folder, "summary.json"))],
    ["extra app capture", () => pretty(join(f.folder, "captures/unknown.json"), {})],
    ["extra directory", () => mkdirSync(join(f.folder, "extra"))],
    ["non-file receipt", () => { unlinkSync(join(f.folder, "captures/nuxt.json")); mkdirSync(join(f.folder, "captures/nuxt.json")); }],
    ["duplicate JSON key", () => writeFileSync(join(f.folder, "summary.json"), '{"schema":"x","schema":"native-fullstack-browser/v1"}')],
    ["malformed JSON", () => writeFileSync(join(f.folder, "summary.json"), "{")],
    ["capture derived tamper", () => { const p = join(f.folder, "captures/nuxt.json"), v = JSON.parse(readFileSync(p)); v.cases[0].reason = "changed"; pretty(p, v); }],
    ["manifest hash tamper", () => { const p = join(f.folder, "captures/manifest.json"), v = JSON.parse(readFileSync(p)); v.reports.nuxt.captureSha256 = "0".repeat(64); pretty(p, v); }],
    ["fixture bytes", () => writeFileSync(join(f.folder, "marketplace.json"), "{}")],
  ];
  for (const [name, mutate] of probes) await t.test(name, () => {
    f.save(); writeFileSync(join(f.folder, "marketplace.json"), JSON.stringify(records)); mutate();
    assert.equal(f.check().outcome, "invalid", name);
    if (existsSync(join(f.folder, "captures/unknown.json"))) unlinkSync(join(f.folder, "captures/unknown.json"));
    if (lstatSync(join(f.folder, "captures/nuxt.json"), { throwIfNoEntry: false })?.isDirectory()) rmdirSync(join(f.folder, "captures/nuxt.json"));
    if (existsSync(join(f.folder, "extra"))) rmdirSync(join(f.folder, "extra"));
  });
});

test("path traversal, network/device/ADS paths and linked evidence cannot be read as saved proof", async (t) => {
  const f = fixture(t);
  for (const path of ["../outside", "work/../../outside", "\\\\server\\share", "//server/share", "\\\\?\\C:\\evidence", "https://example.invalid", "C:relative", f.folder + ":stream", f.folder + "/tail. ", f.folder + "/NUL"]) {
    assert.equal(validateSaved({ folder: path, round: "w1", commit }).outcome, "invalid", path);
  }
  const target = join(f.folder, "summary.json"), backup = f.folder + "-summary.json";
  renameSync(target, backup); linkSync(backup, target);
  try { assert.equal(f.check().outcome, "invalid", "hard links forbidden even with correct content and exact file inventory"); }
  finally { unlinkSync(target); renameSync(backup, target); }
  const alias = join(f.folder, "alias");
  symlinkSync(join(f.folder, "captures"), alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(f.check().outcome, "invalid", "junction/reparse subtree forbidden");
  assert.equal(validateSaved({ folder: alias, round: "w1", commit }).outcome, "invalid", "linked root forbidden"); unlinkSync(alias);
  const rootLink = f.folder + "-link";
  symlinkSync(dirname(f.folder), rootLink, process.platform === "win32" ? "junction" : "dir");
  try { assert.equal(validateSaved({ folder: join(rootLink, basename(f.folder)), round: "w1", commit }).outcome, "invalid", "linked ancestor of an otherwise valid full inventory forbidden"); }
  finally { unlinkSync(rootLink); }
  symlinkSync(f.folder, rootLink, process.platform === "win32" ? "junction" : "dir");
  try { assert.equal(validateSaved({ folder: rootLink, round: "w1", commit }).outcome, "invalid", "linked root with otherwise valid full inventory forbidden"); }
  finally { unlinkSync(rootLink); }
});

test("missing native proof is blocked; invented zero workers, cleanup, or final reconciliation cannot promote it", (t) => {
  const summary = unavailable(), { e } = failedRaw(summary), f = fixture(t, summary);
  let r = f.check(); assert.equal(r.outcome, "blocked", r.invalid.join("; "));
  assert.match(r.cells.find((c) => c.derived)?.blocked.join("; "), /Final raw browser request ledger unavailable.*Final upstream ledger unavailable.*lifecycle journal unavailable/);
  e.requestReconciliation = { outcome: "reconciled", reasons: [], assignments: [] }; f.save();
  assert.equal(f.check().outcome, "invalid"); delete e.requestReconciliation;
  e.platformLifecycle = { schema: "native-browser-platform-lifetimes/v2", events: [], realms: [], contextConfiguration: { javaScriptEnabled: true }, coverage: { workerNetwork: true, sharedWorkerOwnership: true, serverSocketPeerClosure: true } };
  f.save(); r = f.check(); assert.equal(r.outcome, "blocked", r.invalid.join("; ")); assert.equal(r.qualificationPassed, false);
});

test("well-formed but unauthenticated source hashes and dirty execution stay blocked without network access", (t) => {
  const f = fixture(t), originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Saved validation must not access the network"); };
  try {
    f.summary.code.runnerFiles['lifecycle.mjs'] = "0".repeat(64); f.save();
    let result = f.check(); assert.equal(result.outcome, "blocked", result.invalid.join("; "));
    assert.match(result.blocked.join("; "), /runner hashes differ/);
    f.summary.code.dirty = true; f.summary.code.status = " M bench/fullstack-browser/lifecycle.mjs"; f.save();
    result = f.check(); assert.equal(result.outcome, "blocked", result.invalid.join("; "));
    assert.match(result.blocked.join("; "), /Dirty producer/);
  } finally { globalThis.fetch = originalFetch; }
});

test("coherently reprojected SSR/timing contradictions are invalid, absent receipts stay blocked", async (t) => {
  const summary = unavailable(), { cell, e, profile } = failedRaw(summary);
  // Deliberately failed synthetic metadata, not browser execution or a qualification fixture.
  const request = { id: "synthetic-document", method: "GET", path: profile.steps[0].path, query: {}, resource: "document", transport: "document",
    completed: true, status: 200, failure: null, hasCsp: false, input: null, components: [], bodySha256: sha256("synthetic failed-only body"),
    bytes: { encodedBody: 26, headers: 0, decodedBody: 26 } };
  e.steps = [{ action: structuredClone(profile.steps[0]), at: 10, requests: [request], dom: null, domPassed: false,
    document: { observer: "synthetic-parser", scope: "synthetic-parser-scope", url: { path: request.path, query: {} }, status: 200, responseSha256: request.bodySha256, page: null, native: {} },
    timing: { dispatchMs: 2, visibleChangeObservedMs: 3, settledObservedMs: 4 }, retired: null,
    failures: ["No native page observed"], lifecycleFailures: [], errors: [] }];
  e.readiness = { definition: "Synthetic failed-only apparatus metadata", actionableObservedMs: 5 };
  e.requestLedgerEndedAt = 20;
  const f = fixture(t, summary), original = structuredClone(e), baseline = f.check();
  assert.equal(baseline.outcome, "blocked", baseline.invalid.join("; "));
  const invalid = [
    ["malformed SSR hash", (e) => { e.steps[0].document.responseSha256 = true; }, /SSR response hash/],
    ["conflicting SSR hash", (e) => { e.steps[0].document.responseSha256 = "0".repeat(64); }, /SSR hash contradicts/],
    ["conflicting SSR status", (e) => { e.steps[0].document.status = 404; }, /SSR status contradicts/],
    ["conflicting SSR path", (e) => { e.steps[0].document.url.path = "/unrelated"; }, /SSR response URL contradicts/],
    ["conflicting SSR query", (e) => { e.steps[0].document.url.query = { sort: "price" }; }, /SSR response URL contradicts/],
    ["malformed SSR URL", (e) => { e.steps[0].document.url = false; }, /Malformed SSR response URL/],
    ["malformed SSR status", (e) => { e.steps[0].document.status = "200"; }, /Malformed SSR response status/],
    ["malformed SSR parser", (e) => { e.steps[0].document.observer = false; }, /SSR parser identity/],
    ["negative dispatch duration", (e) => { e.steps[0].timing.dispatchMs = -1; }, /action duration/],
    ["backwards visible duration", (e) => { e.steps[0].timing.visibleChangeObservedMs = 1; }, /action duration/],
    ["backwards settlement duration", (e) => { e.steps[0].timing.settledObservedMs = 2; }, /action duration/],
    ["boolean action duration", (e) => { e.steps[0].timing.dispatchMs = true; }, /action duration/],
    ["malformed timing shape", (e) => { e.steps[0].timing = false; }, /timing shape/],
    ["malformed readiness shape", (e) => { e.readiness = false; }, /readiness shape/],
    ["boolean readiness duration", (e) => { e.readiness.actionableObservedMs = true; }, /readiness duration/],
    ["negative readiness duration", (e) => { e.readiness.actionableObservedMs = -1; }, /readiness duration/],
    ["readiness before settlement", (e) => { e.readiness.actionableObservedMs = 3; }, /Readiness predates/],
    ["final boundary before action", (e) => { e.requestLedgerEndedAt = 0; }, /boundary predates/],
    ["final boundary before settlement", (e) => { delete e.readiness; e.requestLedgerEndedAt = 13; }, /boundary predates/],
    ["final boundary before readiness", (e) => { e.requestLedgerEndedAt = 14; }, /boundary predates/],
    ["overlapping subsequent action", (e) => { e.steps.push({ ...structuredClone(e.steps[0]), action: profile.steps[1], at: 13 }); }, /previous observation/],
  ];
  const missing = [
    ["missing SSR observation", (e) => { delete e.steps[0].document; }],
    ["missing SSR hash", (e) => { delete e.steps[0].document.responseSha256; }],
    ["missing SSR status", (e) => { delete e.steps[0].document.status; }],
    ["missing SSR URL", (e) => { delete e.steps[0].document.url; }],
    ["missing SSR query", (e) => { delete e.steps[0].document.url.query; }],
    ["missing SSR parser identity", (e) => { delete e.steps[0].document.observer; }],
    ["missing browser document", (e) => { e.steps[0].requests = []; }],
    ["ambiguous browser document", (e) => { e.steps[0].requests.push({ ...e.steps[0].requests[0], id: "second-synthetic-document" }); }],
    ["missing timing", (e) => { delete e.steps[0].timing; }],
    ["partial timing", (e) => { e.steps[0].timing.visibleChangeObservedMs = null; }],
    ["missing readiness", (e) => { delete e.readiness; }],
    ["partial readiness", (e) => { e.readiness.actionableObservedMs = null; }],
    ["missing final boundary", (e) => { delete e.requestLedgerEndedAt; }],
    ["null final boundary", (e) => { e.requestLedgerEndedAt = null; }],
  ];
  for (const [name, mutate, message] of [...invalid, ...missing]) await t.test(name, () => {
    cell.evidence = structuredClone(original); mutate(cell.evidence); f.save(); // Regenerate every projection and raw/capture hash.
    const result = f.check();
    assert.equal(result.outcome, message ? "invalid" : "blocked", `${name}: ${result.invalid.join("; ")}`);
    if (message) assert.match(result.invalid.join("; "), message);
    else assert.deepEqual(result.invalid, []);
    assert.equal(result.qualificationPassed, false); assert.equal(result.readyForLoad, false);
  });
});

test("partial failed receipt chronology and readbacks remain diagnostic, not fabricated qualification", async (t) => {
  const summary = unavailable(), { cell, e, profile } = failedRaw(summary), zero = Object.fromEntries(["subscriptions", "connections", "listeners", "timers", "pendingTasks"].map((k) => [k, 0]));
  const resource = (at, realm = "synthetic-live") => ({ observer: `synthetic-resource-${at}`, at, realm, scope: realm, scriptExecutionEnabled: profile.js, scopes: [], unsupported: [], unattributed: { ...zero } });
  const read = (id) => ({ observer: `synthetic-read-${id}`, outcome: "read", via: "independent-read", status: 200, path: "/api/alerts", alerts: [] });
  // Explicitly synthetic FAILED metadata, never a native run or positive qualification fixture.
  e.resourceBaseline = resource(2, "synthetic-blank"); e.storeBefore = read("initial");
  e.steps = [{ action: structuredClone(profile.steps[0]), at: 10, timing: { dispatchMs: 2, visibleChangeObservedMs: 3, settledObservedMs: 4 },
    requests: [], document: null, dom: { observer: "synthetic-dom", scope: "synthetic-live", url: { path: profile.steps[0].path }, page: null, native: {} },
    domPassed: false, resourcesAtDOM: resource(15), resources: resource(20), retired: null, failures: ["No native page executed"], lifecycleFailures: [], errors: [] }];
  e.readiness = { definition: "Synthetic failed-only metadata", actionableObservedMs: 5 };
  e.mutationProbes = { before: read("mutation"), otherContext: { before: read("other-before"), after: read("other-after") }, attempts: [{ readback: read("rejection") }], failures: ["No native mutation execution"] };
  e.nativeCleanup = { outcome: "failed", before: resource(50), navigation: { at: 55 }, after: resource(60), detachedAt: 61, released: resource(62),
    probe: { at: 65, afterAt: 70 }, platformProbe: { receivedAt: 71, finishedAt: 72 }, retired: null, failures: ["No native cleanup executed"] };
  e.cleanup = { contextClosed: false, error: "No browser executed", nativePageScope: structuredClone(e.nativeCleanup) };
  e.platformLifecycle = { schema: "native-browser-platform-lifetimes/v2", contextConfiguration: { javaScriptEnabled: profile.js }, coverage: {},
    target: { target: "synthetic-target", context: "synthetic-context", type: "page" }, boundaries: { startedAt: 1, applicationStartedAt: 3, terminalStartedAt: 80, endedAt: 100 },
    events: [{ event: "native-clock-sample", phase: "initial-native-clock", startedAt: 0.1, receivedAt: 0.2, at: 99999 },
      { event: "Runtime.executionContextCreated", uniqueId: "blank", receivedAt: 0.3 }, { event: "domain-enabled", receivedAt: 0.4 },
      { event: "Target.getTargets", phase: "initial", startedAt: 0.5, receivedAt: 0.6 },
      { event: "Runtime.executionContextCreated", uniqueId: "live", receivedAt: 12 },
      { event: "unique-context-read-probe", receivedAt: 90, finishedAt: 91 },
      { event: "Target.getTargets", phase: "terminal", startedAt: 95, receivedAt: 96 }],
    realms: [{ realm: "synthetic-blank", uniqueId: "blank", observedAt: 1.8 }, { realm: "synthetic-live", uniqueId: "live", observedAt: 14 }],
    documents: [{ observer: "synthetic-dom", realm: "synthetic-live", observedAt: 21, identityObservation: { startedAt: 22, finishedAt: 23 } },
      { observer: "synthetic-terminal", realm: "synthetic-live", observedAt: 75, identityObservation: { startedAt: 76, finishedAt: 77 } }], observationFailures: [] };
  e.harnessClosedLifecycle = structuredClone(e.platformLifecycle);
  e.harnessClosedLifecycle.events.push({ event: "Target.targetDestroyed", receivedAt: 105 });
  e.harnessClosedLifecycle.observationFailures.push({ phase: "page-session-closed", at: 106 });
  e.requestLedgerEndedAt = 102; // Post-harness receipts must NOT be charged to this native boundary.
  const f = fixture(t, summary), original = structuredClone(e), baseline = f.check();
  assert.equal(baseline.outcome, "blocked", baseline.invalid.join("; "));
  const invalid = [
    ["initial read HTTP failure labeled read", (e) => { e.storeBefore.status = 500; }, /HTTP status/],
    ["mutation read HTTP failure labeled read", (e) => { e.mutationProbes.before.status = 500; }, /HTTP status/],
    ["other session read HTTP failure labeled read", (e) => { e.mutationProbes.otherContext.after.status = 500; }, /HTTP status/],
    ["rejection read HTTP failure labeled read", (e) => { e.mutationProbes.attempts[0].readback.status = 500; }, /HTTP status/],
    ["read endpoint changed", (e) => { e.mutationProbes.before.path = "/other-store"; }, /endpoint changed/],
    ["read reused native form response", (e) => { e.storeBefore.path = e.steps[0].action.path; }, /separate native store/],
    ["read source conflicts", (e) => { e.storeBefore.source = profile.source === "api" ? "fixture" : "api"; }, /identity contradicts/],
    ["read round conflicts", (e) => { e.storeBefore.round = "w999"; }, /identity contradicts/],
    ["read case conflicts", (e) => { e.storeBefore.case = "unrelated-case"; }, /identity contradicts/],
    ["read observer reused", (e) => { e.storeBefore.observer = e.steps[0].dom.observer; }, /observer missing\/reused/],
    ["read malformed HTTP status", (e) => { e.storeBefore.status = true; }, /Malformed.*status/],
    ["read malformed contents", (e) => { e.storeBefore.alerts = { alerts: [] }; }, /Malformed.*contents/],
    ["resource baseline overlaps journey", (e) => { e.resourceBaseline.at = 11; }, /baseline\/action/],
    ["cleanup overlaps journey", (e) => { e.nativeCleanup.before.at = 19; }, /Journey\/cleanup/],
    ["pre-baseline receipt before case", (e) => { e.platformLifecycle.events[0].receivedAt = -1; }, /pre-case/],
    ["target request has backwards start", (e) => { e.platformLifecycle.events[3].startedAt = 0.7; }, /receipt.*order/],
    ["realm precedes its native context", (e) => { e.platformLifecycle.realms[1].observedAt = 11; }, /Context\/realm/],
    ["parser precedes dependent resource", (e) => { e.platformLifecycle.documents[0].observedAt = 19; }, /Action\/parser/],
    ["parser identity precedes parser", (e) => { e.platformLifecycle.documents[0].identityObservation.startedAt = 20; }, /Dependent parser/],
    ["parser identity outlives terminal", (e) => { e.platformLifecycle.documents[0].identityObservation.finishedAt = 101; }, /Dependent parser/],
    ["actual receipt outlives declared terminal", (e) => { e.platformLifecycle.events.at(-1).receivedAt = 103; }, /receipt\/terminal/],
    ["probe finish outlives terminal", (e) => { e.platformLifecycle.events[5].finishedAt = 103; }, /completion\/terminal/],
    ["post-cleanup parser precedes cleanup", (e) => { e.platformLifecycle.documents[1].observedAt = 59; }, /Post-cleanup parser/],
    ["post-cleanup parser precedes dependent probe", (e) => { e.platformLifecycle.documents[1].observedAt = 71; }, /Post-cleanup parser/],
    ["malformed harness close duration", (e) => { e.cleanup.closeMs = -1; }, /context-close duration/],
    ["native observer failure outlives boundary", (e) => { e.platformLifecycle.observationFailures.push({ at: 103 }); }, /failure\/terminal/],
    ["post-harness rewrites native prefix", (e) => { e.harnessClosedLifecycle.events[1].receivedAt = 0.31; }, /prefix/],
    ["upstream sample outlives browser boundary", (e) => { e.upstreamLedger = { phases: [], terminal: { startedAt: 104, finishedAt: 105 } }; }, /boundary predates/],
  ];
  const blocked = [
    ["genuine failed read HTTP 500", (e) => { Object.assign(e.storeBefore, { outcome: "failed", status: 500, alerts: null, reason: "Actual HTTP failure retained" }); }],
    ["missing read status", (e) => { delete e.storeBefore.status; }],
    ["missing read endpoint", (e) => { delete e.storeBefore.path; }],
    ["missing read observer", (e) => { delete e.storeBefore.observer; }],
    ["missing read contents", (e) => { delete e.storeBefore.alerts; }],
    ["missing read method", (e) => { delete e.storeBefore.via; }],
    ["missing parser identity", (e) => { delete e.platformLifecycle.documents[0].identityObservation; delete e.harnessClosedLifecycle.documents[0].identityObservation; }],
    ["missing target request start", (e) => { delete e.platformLifecycle.events[3].startedAt; delete e.harnessClosedLifecycle.events[3].startedAt; }],
  ];
  for (const [name, mutate, message] of [...invalid, ...blocked]) await t.test(name, () => {
    cell.evidence = structuredClone(original); mutate(cell.evidence); cell.evidence.cleanup.nativePageScope = structuredClone(cell.evidence.nativeCleanup); f.save();
    const result = f.check(); assert.equal(result.outcome, message ? "invalid" : "blocked", result.invalid.join("; "));
    if (message) assert.match(result.invalid.join("; "), message); else assert.deepEqual(result.invalid, []);
    assert.equal(result.qualificationPassed, false); assert.equal(result.readyForLoad, false);
  });
});

test("readback endpoint is fixed across profiles and honors the default target contract", (t) => {
  const summary = unavailable(), { e, profile } = failedRaw(summary);
  const read = (observer, path) => ({ observer, path, status: 200, outcome: "read", via: "independent-read", alerts: [] });
  e.storeBefore = read("synthetic-first-case", "/api/alerts");
  const second = failedRaw(summary, plan.cases.find((p) => p.source === profile.source && p.key !== profile.key));
  second.e.storeBefore = read("synthetic-second-case", "/other-native-store");
  const f = fixture(t, summary);
  assert.match(f.check().invalid.join("; "), /endpoint changed/);
  second.e.storeBefore = read("synthetic-second-case", "/api/alerts");
  summary.options.targets = null;
  summary.options.build = true;
  summary.targetsSha256 = sha256(JSON.stringify(Object.fromEntries(candidates.map((a) => [a, { image: `cb-marketplace-${a}`, readback: { path: "/api/alerts" } }]))));
  e.storeBefore.path = "/different-default-store"; f.save();
  assert.match(f.check().invalid.join("; "), /endpoint changed/);
});

test("actual HTTP upstream receipts are conserved through probes/cleanup/final, with hostile terminal mutations rejected", async (t) => {
  const summary = unavailable(), { e, profile } = failedRaw(summary), source = createUpstream({ item_1: { value: 1 } });
  source.listen(0, "127.0.0.1"); await once(source, "listening"); const base = `http://127.0.0.1:${source.address().port}`;
  const audit = new UpstreamAudit(async () => (await fetch(base + "/__browser/counters")).json());
  try {
    await audit.start();
    for (const phase of ["initial-store", ...profile.steps.map((s) => s.id), "mutation-probes", "cleanup"]) {
      const row = await audit.begin(phase);
      if (["mutation-probes", "cleanup"].includes(phase)) await (await fetch(base + "/marketplace/records/item_1")).arrayBuffer();
      await audit.end(row);
    }
    const terminalAt = audit.ledger.phases.at(-1).after.finishedAt + settings.observationMs;
    while (performance.now() < terminalAt)
      await new Promise((r) => setTimeout(r, terminalAt - performance.now()));
    await audit.finish();
  } finally { source.closeAllConnections(); await new Promise((r) => source.close(r)); }
  const options = { source: profile.source, actions: profile.steps.map((s) => s.id), observationMs: settings.observationMs };
  e.upstreamLedger = structuredClone(audit.ledger); e.upstreamReconciliation = reconcileUpstream(e.upstreamLedger, options);
  assert.equal(e.upstreamReconciliation.outcome, "reconciled"); const f = fixture(t, summary), original = structuredClone(e.upstreamLedger);
  assert.equal(f.check().outcome, "blocked");
  for (const [name, mutate] of [
    ["missing terminal", (l) => { l.terminal = null; }],
    ["missing mutation phase", (l) => { l.phases.splice(-2, 1); }],
    ["missing cleanup phase", (l) => { l.phases.pop(); }],
    ["truncated final receipts", (l) => { l.terminal.snapshot.events.pop(); }],
    ["replaced source", (l) => { l.terminal.snapshot.ledger = "different"; }],
    ["terminal failure conflict", (l) => { l.terminal.snapshot.events[0].cancelled = l.terminal.snapshot.events[0].started; }],
    ["pending cleanup request", (l) => { l.phases.at(-1).after.snapshot.events.at(-1).completed = null; l.terminal.snapshot.events.at(-1).completed = null; }],
    ["late unexplained request", (l) => { l.terminal.snapshot.events.push({ ...l.terminal.snapshot.events[0], request: "late" }); }],
  ]) await t.test(name, () => {
    e.upstreamLedger = structuredClone(original); mutate(e.upstreamLedger); f.save();
    const r = f.check(); assert.equal(r.outcome, "invalid", `${name}: ${JSON.stringify(r.invalid)}`);
  });
  e.upstreamLedger = structuredClone(original); e.upstreamLedger.terminal = null;
  e.upstreamReconciliation = reconcileUpstream(e.upstreamLedger, options); f.save();
  const missing = f.check(); assert.equal(missing.outcome, "blocked", missing.invalid.join("; "));
  assert.match(missing.cells.find((c) => c.derived).blocked.join("; "), /Final upstream coverage unknown/);
});

test("late failed POST and body capture errors survive full final-request rederivation", (t) => {
  const summary = unavailable(), { e } = failedRaw(summary), f = fixture(t, summary);
  e.requestLedger = []; e.networkFailures = []; e.runtimeErrors = [];
  e.requestReconciliation = reconcileRequests(e); f.save(); assert.equal(f.check().outcome, "blocked");
  e.requestLedger.push({ id: "late-post", method: "POST", path: "/api/alerts", query: {}, resource: "fetch", transport: "fetch", completed: false,
    status: null, failure: "net::ERR_FAILED", captureError: "response body unavailable", hasCsp: false, input: { email: "test@example.test", target_price: "1.25" }, components: [], bodySha256: null, bytes: null });
  f.save(); assert.equal(f.check().outcome, "invalid", "stale derived request proof rejected despite rehashed strict export");
  e.requestReconciliation = reconcileRequests(e); f.save(); const r = f.check(); assert.equal(r.outcome, "blocked", r.invalid.join("; "));
  assert.equal(r.cells.find((c) => c.derived).derived.requestOutcome, "unknown");
});

const retainedFolder = join(repo, "bench/fullstack-browser/work/lifecycle/w28");
test("retained real w28 stays blocked and raw lifecycle/DOM/asset tampering cannot hide behind rehashed projections", { skip: !existsSync(join(retainedFolder, "summary.json")) }, async (t) => {
  const summary = JSON.parse(readFileSync(join(retainedFolder, "summary.json"))), cell = Object.values(summary.cells).flat().find((c) => c.evidence), original = structuredClone(cell.evidence);
  const derive = (e) => {
    e.platformRetirementProofs = e.steps.filter((s) => s.platformRetirement).map((s) => ({ action: s.action.id,
      proof: validatePlatformRetirement(e.platformLifecycle, { ...s.platformRetirement, observationMs: settings.observationMs }) }));
    e.platformCleanupProof = validatePlatformRetirement(e.platformLifecycle, { realm: e.nativeCleanup.before.realm, retiredAt: e.nativeCleanup.navigation.at, observationMs: settings.observationMs });
    e.noJSRequestProof = classifyNoJSRequests(e.platformLifecycle);
  };
  const f = fixture(t, summary);
  for (const app of Object.keys(summary.builds)) writeFileSync(join(f.folder, `build-${app}.log`), readFileSync(join(retainedFolder, `build-${app}.log`)));
  // The historical journal lacks newer identity/clock receipts. Its old positive
  // derived summaries are stale, not evidence that current replay may promote.
  const before = treeHashes(retainedFolder), historical = f.check();
  assert.equal(historical.outcome, "invalid"); assert.equal(historical.qualificationPassed, false);
  original.platformRetirementProofs = original.steps.filter((s) => s.platformRetirement).map((s) => ({ action: s.action.id,
    proof: validatePlatformRetirement(original.platformLifecycle, { ...s.platformRetirement, observationMs: settings.observationMs }) }));
  original.platformCleanupProof = validatePlatformRetirement(original.platformLifecycle, { realm: original.nativeCleanup.before.realm,
    retiredAt: original.nativeCleanup.navigation.at, observationMs: settings.observationMs });
  original.noJSRequestProof = classifyNoJSRequests(original.platformLifecycle);
  cell.evidence = structuredClone(original); f.save();
  const r = f.check(); assert.equal(r.outcome, "blocked", r.invalid.join("; ")); assert.equal(r.qualificationPassed, false);
  assert.equal(r.cells.find((c) => c.derived).derived.noJS, "unknown");
  for (const [name, mutate, rederive] of [
    ["all native commits deleted", (e) => { e.platformLifecycle.events = e.platformLifecycle.events.filter((r) => r.event !== "Page.frameNavigated"); }],
    ["all network receipts deleted", (e) => { e.platformLifecycle.events = e.platformLifecycle.events.filter((r) => !r.event.startsWith("Network.")); }],
    ["asset response deleted", (e) => { e.platformLifecycle.events = e.platformLifecycle.events.filter((r) => !(r.event === "Network.responseReceived" && r.type === "Stylesheet")); }],
    ["document method nulled", (e) => { e.platformLifecycle.events.find((r) => r.event === "Network.requestWillBeSent").method = null; }],
    ["DOM text edited", (e) => { e.steps[0].dom.page.title = "Forged title"; }],
    ["SSR hash malformed", (e) => { e.steps[0].document.responseSha256 = "malformed"; }],
    ["SSR hash conflicts with browser response", (e) => { e.steps[0].document.responseSha256 = "0".repeat(64); }],
    ["SSR status conflicts with browser response", (e) => { e.steps[0].document.status = 404; }],
    ["SSR URL conflicts with browser response", (e) => { e.steps[0].document.url.path = "/unrelated"; }],
    ["negative action duration", (e) => { e.steps[0].timing.dispatchMs = -1; }],
    ["backwards action durations", (e) => { e.steps[0].timing.visibleChangeObservedMs = e.steps[0].timing.settledObservedMs + 1; }],
    ["boolean readiness time", (e) => { e.readiness.actionableObservedMs = true; }],
    ["final boundary before all actions", (e) => { e.requestLedgerEndedAt = e.clock.startedAt; }],
    ["initial independent read HTTP 500", (e) => { e.storeBefore.status = 500; }],
    ["write independent read HTTP 500", (e) => { e.steps.find((r) => r.readback?.outcome === "read").readback.status = 500; }],
    ["independent read from form response", (e) => { const r = e.steps.find((r) => r.readback?.outcome === "read"); r.readback.path = r.action.path; }],
    ["mutation baseline read HTTP 500", (e) => { e.mutationProbes.before.status = 500; }],
    ["other session read HTTP 500", (e) => { e.mutationProbes.otherContext.after.status = 500; }],
    ["rejection read HTTP 500", (e) => { e.mutationProbes.attempts[0].readback.status = 500; }],
    ["baseline after first action", (e) => { e.resourceBaseline.at = e.clock.startedAt + e.steps[1].at; }],
    ["actual lifecycle receipt after final ledger", (e) => { e.requestLedgerEndedAt = e.platformLifecycle.boundaries.endedAt + 1; e.platformLifecycle.events.at(-1).receivedAt = e.requestLedgerEndedAt + 100; }, true],
    ["cleanup before journey", (e) => { const c = e.nativeCleanup, shift = c.before.at - e.clock.startedAt; for (const key of ["before", "navigation", "after"]) c[key].at -= shift; e.cleanup.nativePageScope = structuredClone(c); }, true],
    ["DOM resource JS profile contradiction", (e) => { e.steps[0].resourcesAtDOM.scriptExecutionEnabled = !e.environment.js; }],
    ["pre-baseline target receipt before case", (e) => { e.platformLifecycle.events[0].receivedAt = e.clock.startedAt - 1; }, true],
    ["target request starts after its receipt", (e) => { const r = e.platformLifecycle.events.find((r) => r.event === "Target.getTargets"); r.startedAt = r.receivedAt + 1; }, true],
    ["target inventory after startup boundary", (e) => { e.platformLifecycle.events.find((r) => r.event === "Target.getTargets").receivedAt = e.resourceBaseline.at; }, true],
    ["realm association before native context", (e) => { e.platformLifecycle.realms[0].observedAt = e.clock.startedAt; }, true],
    ["dependent parser before resource capture", (e) => { e.platformLifecycle.documents[0].observedAt = e.resourceBaseline.at; }, true],
    ["parser identity finishes after terminal", (e) => { const d = e.platformLifecycle.documents[0]; d.identityObservation = { startedAt: d.observedAt + 1, finishedAt: e.platformLifecycle.boundaries.endedAt + 1 }; }, true],
    ["lifecycle completion after terminal", (e) => { e.platformLifecycle.events.find((r) => r.event === "unique-context-read-probe").finishedAt = e.platformLifecycle.boundaries.endedAt + 1; }, true],
    ["observer failure after terminal", (e) => { e.platformLifecycle.observationFailures.push({ phase: "observer-failed", at: e.platformLifecycle.boundaries.endedAt + 1 }); }, true],
    ["post-cleanup parser before cleanup", (e) => { e.platformLifecycle.documents.at(-1).observedAt = e.nativeCleanup.before.at - 1; }, true],
    ["retirement probe before action capture", (e) => { const r = e.steps.find((r) => r.platformRetirementProbe); r.platformRetirementProbe.receivedAt = r.resources.at - 1; }, true],
    ["post-harness prefix changed", (e) => { e.harnessClosedLifecycle.events[0].receivedAt += 1; }, true],
    ["DOM resource scope changed", (e) => { e.steps[0].resourcesAtDOM.scope = "unobserved-scope"; }],
    ["initial store changed", (e) => { e.storeBefore.alerts.push({ item_id: "item_2", email: "unexpected@example.test", target_minor: 125 }); }],
    ["mutation store emptied", (e) => { e.mutationProbes.before.alerts = []; }],
    ["fresh worker zeros invented", (e) => { e.nativeCleanup.retired.owned = Object.fromEntries(["subscriptions", "connections", "listeners", "timers", "pendingTasks"].map((k) => [k, 0])); }],
  ]) await t.test(name, () => {
    cell.evidence = structuredClone(original); mutate(cell.evidence); if (rederive) derive(cell.evidence);
    f.save(); assert.equal(f.check().outcome, "invalid", name);
  });
  for (const [name, mutate] of [
    ["absent SSR observation", (e) => { delete e.steps[0].document; }],
    ["absent SSR hash", (e) => { delete e.steps[0].document.responseSha256; }],
    ["absent SSR status", (e) => { delete e.steps[0].document.status; }],
    ["absent SSR URL", (e) => { delete e.steps[0].document.url; }],
    ["absent action timing", (e) => { delete e.steps[0].timing; }],
    ["absent readiness", (e) => { delete e.readiness; }],
  ]) await t.test(name, () => {
    cell.evidence = structuredClone(original); mutate(cell.evidence); f.save();
    const result = f.check(); assert.equal(result.outcome, "blocked", result.invalid.join("; "));
    assert.deepEqual(result.invalid, []); assert.equal(result.qualificationPassed, false);
  });
  cell.evidence = structuredClone(original);
  cell.evidence.platformLifecycle.events = cell.evidence.platformLifecycle.events.filter((r) => r.event !== "Page.frameNavigated");
  cell.evidence.harnessClosedLifecycle.events = cell.evidence.harnessClosedLifecycle.events.filter((r) => r.event !== "Page.frameNavigated");
  const e = cell.evidence;
  e.platformRetirementProofs = e.steps.filter((s) => s.platformRetirement).map((s) => ({ action: s.action.id, proof: validatePlatformRetirement(e.platformLifecycle, { ...s.platformRetirement, observationMs: settings.observationMs }) }));
  e.platformCleanupProof = validatePlatformRetirement(e.platformLifecycle, { realm: e.nativeCleanup.before.realm, retiredAt: e.nativeCleanup.navigation.at, observationMs: settings.observationMs });
  e.noJSRequestProof = classifyNoJSRequests(e.platformLifecycle); f.save();
  const unknown = f.check(); assert.equal(unknown.outcome, "blocked", unknown.invalid.join("; ")); assert.equal(unknown.cells.find((c) => c.derived).derived.noJS, "unknown");
  assert.deepEqual(treeHashes(retainedFolder), before, "historical captures remain byte-identical");
});
