// Hostile apparatus tests. No manufactured positive oracle capture is used.
import test from "node:test";
import assert from "node:assert/strict";
import { records } from "../marketplace/fixtures.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { candidates, emptyCells, settings } from "./contract.mjs";
import { exportBrowserCaptures, projectRequest, projectCase } from "./capture.mjs";
import { createBindingArtifact } from "./binding-artifact.mjs";

const fixture = records(), plan = createBrowserPlan({ records: fixture });
const summary = () => ({ effectivePlan: plan, settings, cells: emptyCells(plan), images: {}, code: { diagnostic: true }, browser: null });

// Projection-only scaffolding, deliberately not a valid journey/oracle capture.
function projectionEvidence() {
  const zero = { subscriptions: 0, connections: 0, listeners: 0, timers: 0, pendingTasks: 0 };
  let at = 0;
  const sample = () => ({ startedAt: ++at, finishedAt: at, error: null, snapshot: { schema: "native-browser-upstream-counters/v1", ledger: "unit-only", events: [] } });
  const upstreamLedger = { schema: "native-browser-upstream-ledger/v1", baseline: sample(),
    phases: ["initial-store", ...plan.cases[0].steps.map((s) => s.id), "mutation-probes", "cleanup"].map((phase) => ({ phase, before: sample(), after: sample() })) };
  at += 1000; upstreamLedger.terminal = sample();
  return { functionalChecksPassed: true, failures: [], gaps: [], clock: { origin: "node.performance.now", startedAt: 1 },
    provenance: { stillSameProcess: true }, resourceBaseline: { unattributed: zero, scopes: [{ owned: zero }] }, steps: [], requestLedger: [], networkFailures: [], runtimeErrors: [], upstreamLedger,
    nativeCleanup: { outcome: "observed", requests: [], dom: {}, retired: { owned: zero }, released: {},
      probe: { beforeSha256: "same", immediateSha256: "same", afterSha256: "same", requests: [], errors: [], afterResources: zero } } };
}
test("final raw requests cannot disappear behind a positive projection", () => {
  const evidence = projectionEvidence(), project = () => projectCase({ evidence }, plan.cases[0], "nuxt", settings);
  project();
  evidence.requestLedger.push({ id: "unassigned-late-post", method: "POST", path: "/api/marketplace/item_1", status: null,
    completed: false, failure: "net::ERR_ABORTED", captureError: "body unavailable" });
  assert.throws(project, /request|ledger/i);
});
test("projection recomputes final upstream coverage rather than trusting an earlier pass", () => {
  const evidence = projectionEvidence();
  evidence.upstreamReconciliation = { outcome: "reconciled" };
  evidence.upstreamLedger.terminal.snapshot.events.push({ request: "late", id: "item_1", status: 200, started: 1, completed: null, cancelled: null });
  assert.throws(() => projectCase({ evidence }, plan.cases[0], "nuxt", settings), /upstream/i);
});

test("Next projection cannot borrow a positive endpoint without linked emitted effects", () => {
  const profile = plan.cases.find((p) => p.js), evidence = projectionEvidence();
  const artifact = createBindingArtifact({ imageId: `sha256:${"1".repeat(64)}`, sourceCommit: "2".repeat(40), scripts: [] });
  evidence.bindingArtifact = { sha256: artifact.sha256, imageId: artifact.imageId, sourceCommit: artifact.sourceCommit };
  evidence.steps = [{ action: profile.steps.find((s) => s.input), formBefore: { enhancement: { path: "/api/marketplace/item_2", transport: "fetch", bindingProof: { outcome: "proved" } } } }];
  assert.throws(() => projectCase({ evidence }, profile, "nextjs", settings, artifact), /binding effects/);
  const changed = structuredClone(artifact); changed.imageId = `sha256:${"3".repeat(64)}`;
  assert.throws(() => projectCase({ evidence }, profile, "nextjs", settings, changed), /artifact|differ/i);
});
test("strict export retains every candidate/profile and unavailable evidence stays outside strict cells", () => {
  const raw = summary(), cell = raw.cells.nuxt[0]; cell.outcome = "failed"; cell.reason = "observed native request failed";
  cell.evidence = { requests: [{ failure: "net::ERR_ABORTED", bytes: null }], functionalChecksPassed: true };
  const before = JSON.stringify(raw), result = exportBrowserCaptures(raw, fixture);
  assert.deepEqual(Object.keys(result.captures), candidates); assert.equal(JSON.stringify(raw), before);
  for (const app of candidates) {
    assert.equal(result.captures[app].cases.length, plan.cases.length); assert.equal(result.manifest.reports[app].validation.functionalPassed, false);
    assert.equal(result.manifest.reports[app].validation.readyForLoad, false);
  }
  const failed = result.captures.nuxt.cases[0]; assert.equal(failed.outcome, "failed"); assert.equal(failed.reason, cell.reason);
  assert.equal(failed.steps, null); assert.equal(failed.cleanup, null); assert.equal(failed.architecture, null);
  assert.equal(result.manifest.reports.nuxt.rawCasesSha256.length, 64);
});
test("self-reported captured/ready/zero resources cannot supply missing native proof", () => {
  const raw = summary(); raw.cells.nuxt[0] = { ...raw.cells.nuxt[0], outcome: "captured", qualificationPassed: true, evidence: { functionalChecksPassed: true, cleanup: { owned: 0 }, ready: true } };
  let result = exportBrowserCaptures(raw, fixture); assert.equal(result.captures.nuxt.cases[0].outcome, "unsupported");
  assert.match(result.captures.nuxt.cases[0].reason, /image source/);
  raw.images.nuxt = { imageSourceVerified: true };
  result = exportBrowserCaptures(raw, fixture); assert.equal(result.captures.nuxt.cases[0].outcome, "unsupported");
  assert.equal(result.captures.nuxt.cases[0].steps, null); assert.equal(result.manifest.reports.nuxt.validation.functionalPassed, false);
});
test("missing, duplicated and unknown raw cells cannot disappear in strict export", () => {
  const missing = summary(); missing.cells.nuxt.pop(); assert.throws(() => exportBrowserCaptures(missing, fixture), /matrix incomplete/);
  const duplicate = summary(); duplicate.cells.nuxt[1] = duplicate.cells.nuxt[0]; assert.throws(() => exportBrowserCaptures(duplicate, fixture), /Missing\/duplicate/);
  const unknown = summary(); unknown.cells.nuxt[0].outcome = "ready"; assert.throws(() => exportBrowserCaptures(unknown, fixture), /Unknown raw outcome/);
});
test("strict request projection preserves all native requests and rejects failed bytes/capture evidence", () => {
  const request = { id: "observed-request", method: "GET", path: "/asset.css", status: 200, transport: "fetch", input: null, components: [], completed: true, failure: null };
  const projected = projectRequest(request, { app: "nuxt", architecture: "nuxt", js: true });
  assert.equal(projected.path, "/asset.css"); assert.equal(projected.transport, "fetch");
  for (const change of [{ failure: "net::ERR_ABORTED" }, { completed: false }, { captureError: "body unavailable" }, { status: null }, { intentionallyDisabledPreload: true, failure: "blocked" }]) {
    assert.throws(() => projectRequest({ ...request, ...change }, { app: "nuxt", architecture: "nuxt", js: false }), /Failed\/unfinished/);
  }
});
