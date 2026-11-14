import assert from "node:assert/strict";
import { browserCaptureSchema, validateBrowserCapture } from "../workloads/browser.mjs";
import { candidates, sha256 } from "./contract.mjs";
import { navigationDestination, writeDestination } from "./navigation.mjs";
import { reconcileRequests } from "./ledger.mjs";
import { reconcileUpstream } from "./upstream.mjs";
import { replayActionBinding } from "./binding-window.mjs";
import { validateBindingArtifact } from "./binding-artifact.mjs";

const keys = ["subscriptions", "connections", "listeners", "timers", "pendingTasks"];
const owned = (value) => {
  assert.ok(value && keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0), "Fresh complete resource counts required");
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
};
const empty = (value) => { const counts = owned(value); assert.ok(Object.values(counts).every((n) => n === 0), "Native resources remain live"); return counts; };
const unavailable = (cell, outcome, reason) => ({ case: cell.case, outcome, reason, architecture: null, environment: null, baseline: null, steps: null, cleanup: null });
function form(value) {
  assert.ok(value, "Native form observation missing");
  return { method: value.method, action: value.action, fields: structuredClone(value.fields),
    enhancement: value.enhancement ? { path: value.enhancement.path, transport: value.enhancement.transport } : null };
}
function dom(value, status = null) {
  assert.ok(value?.observer && value.scope, "DOM observation lacks actual root identity");
  const error = value.page === null ? { status, text: value.error } : null;
  return { id: value.observer, scope: value.scope, path: value.url.path, page: structuredClone(value.page), error,
    form: value.page === null ? null : form(value.native.form), components: structuredClone(value.native.components) };
}
export function projectRequest(value, environment) {
  assert.ok(value.completed && !value.failure && !value.captureError && Number.isInteger(value.status), "Failed/unfinished native request cannot enter a strict capture");
  let path = value.path;
  if (environment.app === "sveltekit" || environment.app === "react-router") path = value.method === "POST" ? writeDestination(value, environment) : navigationDestination(value, environment);
  return { id: value.id, method: value.method, path, status: value.status, transport: value.transport, input: structuredClone(value.input), components: structuredClone(value.components) };
}
export function oracleSettings(settings) {
  return { profiles: Object.fromEntries(Object.entries(settings.profiles).map(([name, value]) => [name, {
    viewport: structuredClone(value.viewport), network: JSON.stringify({ network: value.network, cpu: value.cpu }), cache: value.cache, serviceWorker: value.serviceWorker,
  }])), maxCleanupMs: settings.maxCleanupMs, cleanupObservationMs: settings.observationMs };
}
export function projectCase(cell, profile, app, settings, bindingArtifact = null) {
  const e = cell.evidence;
  if (app === "nextjs" && profile.js) {
    validateBindingArtifact(bindingArtifact);
    assert.equal(e?.bindingArtifact?.sha256, bindingArtifact.sha256, "Case/code artifact correspondence missing");
    for (const row of e.steps.filter((r) => r.action.input))
      assert.ok(replayActionBinding(row.formBefore?.enhancement, bindingArtifact, e, row, profile.key), "Native Next binding effects do not replay from emitted bytes/action-bound native links");
  }
  const requests = reconcileRequests(e ?? {});
  assert.equal(requests.outcome, "reconciled", requests.reasons.join("; "));
  const upstream = reconcileUpstream(e.upstreamLedger, { source: profile.source, actions: profile.steps.map((s) => s.id),
    steps: profile.steps.map((action) => ({ action, requests: e.steps.find((s) => s.action.id === action.id)?.requests ?? [] })), observationMs: settings.cleanupObservationMs });
  assert.equal(upstream.outcome, "reconciled", upstream.reasons.join("; "));
  for (const row of e.steps) {
    const { phase, ...delta } = upstream.phases.find((p) => p.phase === row.action.id);
    assert.deepEqual(row.upstream, delta, "Step upstream outcome differs from final raw ledger");
  }
  assert.ok(e && e.functionalChecksPassed && Array.isArray(e.failures) && !e.failures.length && Array.isArray(e.gaps) && !e.gaps.length, "Native failures or unresolved evidence gaps remain");
  assert.ok(e.clock?.origin === "node.performance.now" && Number.isFinite(e.clock.startedAt), "Native timestamp origin missing");
  assert.ok(e.provenance?.stillSameProcess, "Native process continuity not observed");
  assert.ok(e.nativeCleanup?.outcome === "observed", "Retired native cleanup/probe not observed");
  const baseline = owned(e.resourceBaseline.unattributed);
  assert.ok(e.resourceBaseline.scopes.length, "Empty baseline ledger is not a resource observation");
  for (const scope of e.resourceBaseline.scopes) { const counts = owned(scope.owned); for (const key of keys) baseline[key] += counts[key]; }
  empty(baseline);
  const steps = e.steps.map((row) => {
    assert.deepEqual(row.failures, []); assert.deepEqual(row.lifecycleFailures, []);
    assert.equal(row.resourcesAtDOM?.scope, row.dom?.scope, "DOM and resource scope differ");
    empty(row.resources.unattributed); assert.deepEqual(row.resources.unsupported, []);
    const env = { app, architecture: e.architecture, js: profile.js, form: row.formBefore };
    let retired = [];
    if (row.retired) { assert.ok(row.retired.probeAvailable, row.retired.reason ?? "Retirement not observed in the same realm"); retired = [{ scope: row.retired.scope, owned: empty(row.retired.owned) }]; }
    const status = row.requests.find((r) => r.path === row.action.path && r.method === "GET" && r.resource === "document")?.status ?? null;
    return { at: e.clock.startedAt + row.at, action: structuredClone(row.action), requests: row.requests.map((r) => projectRequest(r, env)), dom: dom(row.dom, status),
      document: row.document ? dom(row.document, row.document.status) : null,
      readback: row.readback ? { id: row.readback.observer, via: row.readback.via, alerts: structuredClone(row.readback.alerts) } : null,
      retired, upstream: Object.fromEntries(["started", "completed", "cancelled", "pending"].map((key) => [key, row.upstream[key]])), errors: structuredClone(row.errors) };
  });
  const cleanup = e.nativeCleanup, d = cleanup.dom;
  assert.ok(d && !d.enhancementUnavailable, cleanup.domError ?? "Fresh retired DOM/native binding unavailable");
  const detached = empty(cleanup.retired.owned), afterProbe = empty(cleanup.probe.afterResources);
  assert.equal(cleanup.probe.beforeSha256, cleanup.probe.immediateSha256); assert.equal(cleanup.probe.beforeSha256, cleanup.probe.afterSha256);
  assert.deepEqual(cleanup.probe.requests, []); assert.deepEqual(cleanup.probe.errors, []);
  return { case: cell.case, outcome: "captured", reason: null, architecture: e.architecture,
    environment: { ...structuredClone(settings.profiles[profile.device]), js: profile.js, device: profile.device }, baseline, steps,
    cleanup: { detachedAt: cleanup.detachedAt, releasedAt: cleanup.released.at, probeAt: cleanup.probe.at, afterAt: cleanup.probe.afterAt,
      detached, afterProbe, probe: { scope: cleanup.probe.scope, kind: "retired-page-event" },
      dom: { id: d.observer, scope: d.scope, path: d.path, page: structuredClone(d.page), error: d.error, form: structuredClone(d.form), components: structuredClone(d.components) },
      network: structuredClone(cleanup.probe.requests), errors: structuredClone(cleanup.probe.errors) } };
}

// Every candidate/profile survives export. Rejected projection keeps its raw
// evidence in summary.json; the strict schema prohibits partial invented cells.
export function exportBrowserCaptures(summary, records) {
  const plan = summary.effectivePlan, settings = oracleSettings(summary.settings), captures = {}, reports = {};
  for (const app of candidates) {
    const raw = summary.cells[app]; assert.ok(Array.isArray(raw) && raw.length === plan.cases.length, "Raw profile matrix incomplete");
    const capture = { schema: browserCaptureSchema, app, effectivePlan: structuredClone(plan), cases: plan.cases.map((profile) => unavailable({ case: profile.key }, "not-run", "Native profile not executed")) };
    const diagnostics = [];
    for (const profile of plan.cases) {
      const matches = raw.filter((cell) => cell.case === profile.key); assert.equal(matches.length, 1, "Missing/duplicate raw case");
      const cell = matches[0], index = capture.cases.findIndex((c) => c.case === cell.case);
      if (cell.outcome !== "captured") {
        assert.ok(["failed", "unsupported", "not-run"].includes(cell.outcome), "Unknown raw outcome");
        capture.cases[index] = unavailable(cell, cell.outcome, cell.reason ?? cell.evidence?.failures?.[0] ?? "Native evidence unavailable"); continue;
      }
      try {
        assert.ok(summary.images[app]?.imageSourceVerified, "Exact clean native image source correspondence not verified");
        if (app === "nextjs" && profile.js) {
          assert.equal(summary.bindingArtifacts?.[app]?.imageId, summary.images[app].id, "Binding artifact is from another image");
          assert.equal(summary.bindingArtifacts[app].sourceCommit, summary.code.commit, "Binding artifact is from another source commit");
        }
        capture.cases[index] = projectCase(cell, profile, app, settings, summary.bindingArtifacts?.[app]);
      } catch (error) {
        capture.cases[index] = unavailable(cell, "unsupported", error.message); diagnostics.push({ case: cell.case, stage: "projection", error: error.message }); continue;
      }
      try { validateBrowserCapture(plan, capture, records, settings); }
      catch (error) {
        capture.cases[index] = unavailable(cell, "failed", error.message); diagnostics.push({ case: cell.case, stage: "oracle", error: error.message });
      }
    }
    const validation = validateBrowserCapture(plan, capture, records, settings);
    captures[app] = capture; reports[app] = { validation, diagnostics, rawCasesSha256: sha256(JSON.stringify(raw)), captureSha256: sha256(JSON.stringify(capture)) };
  }
  return { captures, manifest: { schema: "native-browser-strict-export/v1", settings, reports, code: structuredClone(summary.code), images: structuredClone(summary.images), browser: structuredClone(summary.browser),
    scope: "Offline strict semantic captures, not native qualification, comparative measurements or load readiness. Partial evidence remains in summary.json." } };
}
