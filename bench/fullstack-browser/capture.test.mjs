// Hostile apparatus tests. No manufactured positive oracle capture is used.
import test from "node:test";
import assert from "node:assert/strict";
import { records } from "../marketplace/fixtures.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { candidates, emptyCells, settings } from "./contract.mjs";
import { exportBrowserCaptures, projectRequest } from "./capture.mjs";

const fixture = records(), plan = createBrowserPlan({ records: fixture });
const summary = () => ({ effectivePlan: plan, settings, cells: emptyCells(plan), images: {}, code: { diagnostic: true }, browser: null });
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
