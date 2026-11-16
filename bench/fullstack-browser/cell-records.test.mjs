// Full official inventory, synthetic failed/unsupported apparatus only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { records } from "../marketplace/fixtures.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { candidates, emptyCells, settings, sha256 } from "./contract.mjs";
import { exportBrowserCaptures } from "./capture.mjs";
import { EvidenceStore, openEvidence } from "./native-evidence.mjs";
import { recordSchema, retainCell, cellReader } from "./cell-records.mjs";
import { UpstreamAudit } from "./upstream.mjs";

test("all 240 cells retain raw data/outcomes and replay the identical strict export and raw hashes", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "browser-record-matrix-")); t.after(() => rmSync(folder, { recursive: true }));
  const fixture = records(), plan = createBrowserPlan({ records: fixture }), store = new EvidenceStore(folder);
  const summary = { schema: recordSchema, effectivePlan: plan, settings, cells: emptyCells(plan), images: {}, code: { apparatus: true }, browser: null };
  for (const app of candidates) for (const [i, cell] of summary.cells[app].entries()) Object.assign(cell, {
    outcome: i % 2 ? "failed" : "unsupported", reason: `observed-${app}-${i}`, qualificationPassed: false,
    evidence: { observer: `${app}-${i}`, failures: ["Actual fixture failure"], gaps: ["Actual fixture gap"],
      steps: plan.cases[i].steps.map((action) => ({ action, observations: [1, 2, 3] })),
      platformLifecycle: { events: [{ event: "native-receipt", at: i }] }, harnessClosedLifecycle: { events: [{ event: "native-receipt", at: i }, { event: "closed", at: i + 1 }] },
      platformRetirementProofs: [{ outcome: "unknown", reason: "No native positive proof supplied" }], upstreamLedger: { phases: [{ before: { events: [] }, after: { events: [] } }] } },
  });
  const before = exportBrowserCaptures(summary, fixture), expectedHashes = Object.fromEntries(candidates.map((app) => [app, sha256(JSON.stringify(summary.cells[app]))]));
  const rawBytes = Buffer.byteLength(JSON.stringify(summary));
  for (const app of candidates) summary.cells[app] = summary.cells[app].map((cell, i) => retainCell(store, app, i, cell));
  const manifest = store.seal(), reader = openEvidence(folder), readCell = cellReader(summary, reader);
  const after = exportBrowserCaptures(summary, fixture, readCell);
  assert.equal(candidates.reduce((count, app) => count + summary.cells[app].length, 0), 240);
  assert.equal(sha256(JSON.stringify(after)), sha256(JSON.stringify(before)));
  for (const app of candidates) assert.equal(after.manifest.reports[app].rawCasesSha256, expectedHashes[app]);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < rawBytes);
  const cell = summary.cells[candidates[0]][0], original = cell.evidence;
  cell.evidence = summary.cells[candidates[0]][1].evidence; assert.throws(() => readCell(cell, candidates[0]), /binding/); cell.evidence = original;
  reader.finish(); assert.equal(Object.keys(manifest.records).length, 240);
});

test("upstream snapshots share only identical receipt versions and never lose pending/terminal observations", async () => {
  const event = { request: "one", id: "item_1", started: 1, completed: null, cancelled: null, status: 200 };
  const raw = { schema: "native-browser-upstream-counters/v1", ledger: "test", events: [event] }, audit = new UpstreamAudit(async () => raw);
  const first = await audit.sample(), same = await audit.sample();
  assert.equal(first.snapshot.events[0], same.snapshot.events[0]);
  event.completed = 2; const terminal = await audit.sample();
  assert.equal(first.snapshot.events[0].completed, null); assert.equal(terminal.snapshot.events[0].completed, 2);
  assert.notEqual(first.snapshot.events[0], terminal.snapshot.events[0]);
});
