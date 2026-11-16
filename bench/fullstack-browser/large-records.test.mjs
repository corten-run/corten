// Explicit large storage regression, not a native benchmark or qualification.
// One live raw cell at a time; never construct the old inline matrix/string.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { records } from "../marketplace/fixtures.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { candidates, emptyCells, parseOptions, settings, retainedFamilies } from "./contract.mjs";
import { EvidenceStore, openEvidence, sha256 } from "./native-evidence.mjs";
import { recordSchema, retainCell, saveSummary, cellReader } from "./cell-records.mjs";
import { exportBrowserCaptures } from "./capture.mjs";

function observation(app, profile, index, upstream) {
  const context = `${app}/${profile.key}`, events = Array.from({ length: 1024 }, (_, i) => ({
    seq: i, event: "Network.requestWillBeSent", request: `${context}/request-${i}`, loader: `${context}/loader`, frame: `${context}/frame`,
    type: "Document", method: "GET", path: `/marketplace/en-US/item_${i % 3 + 1}`, urlSha256: sha256(`${context}/${i}`),
    timestamp: i + 0.125, receivedAt: i + 0.25, initiator: { type: "other" },
  }));
  const journal = { schema: "native-platform-lifecycle/v1", context, events, realms: [{ realm: context, context: index + 1 }] };
  const sample = (at) => ({ startedAt: at, finishedAt: at + 0.125,
    snapshot: { schema: "native-browser-upstream-counters/v1", ledger: "whole-matrix-upstream", events: upstream }, error: null });
  return { case: profile.key, outcome: index % 2 ? "failed" : "unsupported", qualificationPassed: false, reason: `Observed fixture disposition ${context}`,
    evidence: { context, steps: profile.steps.map((action) => ({ action, lifecycle: journal, failures: ["No native positive proof manufactured"] })),
      upstreamLedger: { schema: "native-browser-upstream-ledger/v1", baseline: sample(0),
        phases: ["initial-store", ...profile.steps.map((s) => s.id), "mutation-probes", "cleanup"].map((phase, i) => ({ phase, before: sample(i * 2 + 1), after: sample(i * 2 + 2) })), terminal: sample(1000) },
      platformLifecycle: journal, platformRetirementProofs: profile.steps.map((action) => ({ action: action.id, journal, outcome: "unknown", reasons: ["Synthetic observation control, not a native proof"] })),
      platformCleanupProof: { journal, outcome: "unknown" }, harnessClosedLifecycle: { ...journal, events: [...events, { event: "context-closed", receivedAt: 2000 }] },
      failures: ["Complete failed/unsupported fixture, not an application success"], gaps: ["External OS and native qualification not supplied"] },
  };
}

test("complete official matrix exceeds predecessor inline bounds but saves/replays every raw occurrence with bounded records", {
  skip: process.env.BROWSER_RECORD_MATRIX_CONTROL !== "1", timeout: 600000,
}, (t) => {
  const folder = mkdtempSync(join(tmpdir(), "browser-full-record-matrix-"));
  const fixture = records(), plan = createBrowserPlan({ records: fixture }), store = new EvidenceStore(folder);
  const allocation = () => {
    const fs = statfsSync(folder), refs = [...store.files.values()];
    return { files: refs.length, blockSize: fs.bsize, freeBytes: fs.bavail * fs.bsize, freeInodes: fs.ffree,
      // tmpfs charges a full page even for a tiny content-addressed packet.
      minimum4096BytePages: refs.reduce((n, ref) => n + Math.ceil(ref.bytes / 4096) * 4096, 0),
      allocatedBytes: refs.reduce((n, ref) => n + statSync(join(folder, ref.path)).blocks * 512, 0) };
  };
  t.after(() => {
    try { console.log(JSON.stringify({ phase: "storage-terminal", ...allocation() })); }
    finally { rmSync(folder, { recursive: true }); }
  });
  const summary = { schema: recordSchema, group: "fullstack-browser", effectivePlan: plan, settings,
    options: parseOptions(["w21", "--out", folder, "--build"]), code: { control: "synthetic-storage-only" }, images: {}, browser: null,
    cells: emptyCells(plan), complete: false, qualificationPassed: false, readyForLoad: false,
    retainedFamilies: retainedFamilies.map((f) => ({ ...f, outcome: "not-run", reason: "Retained; not replaced by native browser diagnostics" })),
    native: { manifest: null } };
  assert.equal(summary.options.apps.length, 10); assert.equal(summary.options.cases, null);
  const hashes = {}, bytesByApp = {}, counts = { failed: 0, unsupported: 0 }; let legacyInlineBytes = 0, legacyInlineCodeUnits = 0, index = 0;
  let upstream = Array.from({ length: 512 }, (_, i) => ({ request: `source-${i}`, id: `item_${i % 3 + 1}`, started: i, completed: i + 1, cancelled: null, status: 200 }));
  saveSummary(folder, summary);
  for (const app of candidates) {
    const hash = createHash("sha256").update("["); let bytes = 2, codeUnits = 2;
    for (const [i, profile] of plan.cases.entries()) {
      upstream = [...upstream, { request: `source-${512 + index}`, id: "item_1", started: 1024 + index, completed: 1025 + index, cancelled: null, status: 200 }];
      const raw = observation(app, profile, index++, upstream), text = JSON.stringify(raw);
      if (i) { hash.update(","); bytes++; codeUnits++; } hash.update(text); bytes += Buffer.byteLength(text); codeUnits += text.length; counts[raw.outcome]++;
      // The predecessor's exact retained-inline canonical byte count is a safe
      // red preflight: pretty JSON can only be larger. No giant stringify/OOM.
      summary.cells[app][i] = retainCell(store, app, i, raw); saveSummary(folder, summary);
    }
    hashes[app] = hash.update("]").digest("hex"); bytesByApp[app] = bytes; legacyInlineBytes += bytes; legacyInlineCodeUnits += codeUnits;
    console.log(JSON.stringify({ phase: "retained-app", app, cells: index, legacyInlineBytesLowerBound: legacyInlineBytes, storedBytes: store.total, ...allocation() }));
  }
  assert.equal(index, 240); assert.equal(counts.failed, 120); assert.equal(counts.unsupported, 120);
  assert.ok(legacyInlineBytes > 1434848899, `Legacy canonical cell bytes=${legacyInlineBytes}`);
  assert.ok(legacyInlineCodeUnits > 536870888 && legacyInlineBytes > 256 * 1024 ** 2 && legacyInlineBytes > 1024 ** 3);
  summary.complete = true; summary.native.manifest = store.seal(); saveSummary(folder, summary);
  const saved = JSON.parse(readFileSync(join(folder, "summary.json"), "utf8")), reader = openEvidence(folder), readCell = cellReader(saved, reader);
  const exported = exportBrowserCaptures(saved, fixture, readCell); mkdirSync(join(folder, "captures"));
  for (const app of candidates) {
    assert.equal(exported.manifest.reports[app].rawCasesSha256, hashes[app], `Raw occurrence hash changed for ${app}`);
    assert.equal(exported.captures[app].cases.length, 24);
    for (const [i, cell] of exported.captures[app].cases.entries()) assert.equal(cell.outcome, i % 2 ? "failed" : "unsupported");
    writeFileSync(join(folder, `captures/${app}.json`), JSON.stringify(exported.captures[app], null, 2) + "\n");
  }
  reader.finish(); assert.equal(Object.keys(reader.manifest.records).length, 240);
  assert.ok(store.total < 1024 ** 3 && statSync(join(folder, "summary.json")).size < 32 * 1024 ** 2);
  // The production save boundary refuses a retained-inline regression before
  // serialization, even if someone bypasses retainCell in a future caller.
  const first = saved.cells[candidates[0]][0], ref = first.evidence; first.evidence = { steps: [] };
  assert.throws(() => saveSummary(folder, saved), /retained/); first.evidence = ref;
  assert.equal(saved.qualificationPassed, false); assert.equal(saved.readyForLoad, false);
  t.diagnostic(JSON.stringify({ cells: index, outcomes: counts, legacyInlineBytesLowerBound: legacyInlineBytes, legacyInlineCodeUnitsLowerBound: legacyInlineCodeUnits, bytesByApp,
    summaryBytes: statSync(join(folder, "summary.json")).size, storedBytes: store.total, files: reader.manifest.files.length,
    peakRSSKiB: process.resourceUsage().maxRSS, rawHashesVerified: 10 }));
});
