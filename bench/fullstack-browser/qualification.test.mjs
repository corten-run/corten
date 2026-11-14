// Aggregation unit fixtures only, never native observations or oracle captures.
import test from "node:test";
import assert from "node:assert/strict";
import * as runner from "./run.mjs";
import { candidates, emptyCells } from "./contract.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { records } from "../marketplace/fixtures.mjs";

function receipts() {
  const plan = createBrowserPlan({ records: records() });
  const summary = { effectivePlan: plan, cells: emptyCells(plan), complete: true, qualificationPassed: false,
    code: { commit: "unit-commit", dirty: false }, failures: [], cleanupFailures: [], images: {},
    browser: { engine: "chromium", version: "unit-version", playwright: "unit-version", executableSha256: "a".repeat(64) } };
  const reports = {};
  for (const app of candidates) {
    summary.images[app] = { imageSourceVerified: true, builtCommit: summary.code.commit, builtDirty: "false" };
    for (const cell of summary.cells[app]) Object.assign(cell, { outcome: "captured", qualificationPassed: true,
      evidence: { functionalChecksPassed: true, domChecksPassed: true, failures: [], gaps: [],
        nativeCleanup: { outcome: "observed" }, cleanup: { contextClosed: true }, provenance: { stillSameProcess: true } } });
    reports[app] = { diagnostics: [], validation: { app, planSha256: plan.sha256, functionalPassed: true,
      cases: plan.cases.map((p) => ({ case: p.key, outcome: "captured", functionalPassed: true })) } };
  }
  return { summary, reports };
}

test("group qualification recomputes the full matrix after native cleanup and strict validation", () => {
  const { summary, reports } = receipts(), before = JSON.stringify({ summary, reports });
  assert.equal(runner.groupQualificationPassed(summary, reports), true);
  assert.equal(summary.qualificationPassed, false, "aggregation must not trust its previous value");
  assert.equal(JSON.stringify({ summary, reports }), before);
});

test("partial, unknown, failed and unverified native receipts never qualify", () => {
  const changes = [
    ({ summary: s }) => { s.complete = false; },
    ({ summary: s }) => { s.failures.push("interrupted"); },
    ({ summary: s }) => { s.cleanupFailures.push("container cleanup failed"); },
    ({ summary: s }) => { s.code.dirty = true; },
    ({ summary: s }) => { s.browser = null; },
    ({ summary: s }) => { delete s.browser.executableSha256; },
    ({ summary: s }) => { delete s.cells.nuxt; },
    ({ summary: s }) => { s.cells.extra = []; },
    ({ summary: s }) => { s.cells.nuxt.pop(); },
    ({ summary: s }) => { s.cells.nuxt[1] = s.cells.nuxt[0]; },
    ...["failed", "unsupported", "not-run", "unknown"].map((outcome) => ({ summary: s }) => { s.cells.nuxt[0].outcome = outcome; }),
    ({ summary: s }) => { s.cells.nuxt[0].qualificationPassed = false; },
    ({ summary: s }) => { s.cells.nuxt[0].evidence = null; },
    ({ summary: s }) => { s.cells.nuxt[0].evidence.nativeCleanup.outcome = "unsupported"; },
    ({ summary: s }) => { s.cells.nuxt[0].evidence.cleanup.contextClosed = false; },
    ({ summary: s }) => { s.cells.nuxt[0].evidence.provenance.stillSameProcess = false; },
    ({ summary: s }) => { s.cells.nuxt[0].evidence.gaps.push("unattributed listener"); },
    ({ summary: s }) => { s.cells.nuxt[0].evidence.failures.push("native request failed"); },
    ({ summary: s }) => { s.cells.nuxt[0].evidence.functionalChecksPassed = false; },
    ({ summary: s }) => { s.cells.nuxt[0].evidence.domChecksPassed = false; },
    ({ summary: s }) => { s.images.nuxt.imageSourceVerified = false; },
    ({ summary: s }) => { s.images.nuxt.builtCommit = "other"; },
    ({ summary: s }) => { s.images.nuxt.builtDirty = "true"; },
    ({ reports: r }) => { delete r.nuxt; },
    ({ reports: r }) => { r.extra = r.nuxt; },
    ({ reports: r }) => { r.nuxt.diagnostics.push({ error: "oracle rejected cleanup" }); },
    ({ reports: r }) => { r.nuxt.validation.functionalPassed = false; },
    ({ reports: r }) => { r.nuxt.validation.planSha256 = "other"; },
    ({ reports: r }) => { r.nuxt.validation.app = "nextjs"; },
    ({ reports: r }) => { r.nuxt.validation.cases.pop(); },
    ({ reports: r }) => { r.nuxt.validation.cases[1] = r.nuxt.validation.cases[0]; },
    ({ reports: r }) => { r.nuxt.validation.cases[0].outcome = "unsupported"; },
    ({ reports: r }) => { r.nuxt.validation.cases[0].functionalPassed = null; },
  ];
  for (const [index, change] of changes.entries()) {
    const value = receipts(); value.summary.qualificationPassed = true; change(value);
    assert.equal(runner.groupQualificationPassed(value.summary, value.reports), false, `hostile aggregation receipt ${index}`);
  }
  assert.equal(runner.groupQualificationPassed(receipts().summary, undefined), false);
});
