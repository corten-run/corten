import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSavedFixture } from "./saved-fixture.mjs";
import { sourceTree } from "./raw-contract.mjs";
import { stageAggregate } from "./run-contract.mjs";
import { validateSaved } from "./validate.mjs";

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const read = (folder, path) => JSON.parse(readFileSync(join(folder, path), "utf8"));
const write = (folder, path, v) => writeFileSync(join(folder, path), JSON.stringify(v));
function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), "marketplace-accounting-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const summary = writeSavedFixture(folder, commit, sourceTree(commit));
  const args = { folder, round: "r17", commit };
  assert.equal(validateSaved(args).complete, true);
  return { folder, summary, args };
}
function invalidEdit({ folder, args }, path, edit) {
  const original = readFileSync(join(folder, path));
  try {
    const v = JSON.parse(original); edit(v); write(folder, path, v);
    assert.throws(() => validateSaved(args), (e) => e.code === "MARKETPLACE_EVIDENCE_INVALID", path);
  } finally { writeFileSync(join(folder, path), original); }
}
function stoppedFixture(t) {
  const f = fixture(t), { folder, summary } = f, base = "api/corten/p3-neutral-json";
  const path = `${base}/sat64-receipt.json`, raw = read(folder, path);
  raw.app.state = { ...raw.app.state, Running: false, OOMKilled: true, ExitCode: 137, FinishedAt: new Date(Date.parse(raw.seen.phaseStart) + 5000).toISOString() };
  raw.seen.app = raw.app.state; raw.after = {};
  raw.seen.sidecars = [raw.cpu, raw.upstream].map((c) => ({ name: c.name, startedAt: c.state.StartedAt, state: c.state }));
  raw.seen.events = [{ action: "oom", ms: Date.parse(raw.app.state.FinishedAt) }];
  const a = summary.apps.corten, runs = a.runs["api-neutral-json"], run = runs[2];
  run.complete = false; run.stopped = { pass: 3, phase: "sat64", exitCode: 137, oomKilled: true };
  delete run.phases.sat64; delete run.phases.sat256;
  for (const phase of ["fixed", "sat64", "sat256"]) a.phases["api-neutral-json"][phase] = stageAggregate(runs, phase, 3);
  write(folder, path, raw); write(folder, `${base}/sat64-cpu.json`, {}); write(folder, "summary.json", summary);
  assert.equal(validateSaved(f.args).complete, true);
  return { ...f, base, path };
}

test("API load must perform a record read for each successful request, not just one per phase", (t) => {
  const f = fixture(t);
  invalidEdit(f, "api/corten/p1-neutral-json/fixed-receipt.json", (v) => {
    v.upstreamReads.after.answers[200] = v.upstreamReads.before.answers[200] + 1;
    v.upstreamReads.after.requests.item_1 = v.upstreamReads.after.answers[200];
  });
});

test("a stopped app cannot hide an incomplete k6 summary", (t) => {
  const f = stoppedFixture(t);
  invalidEdit(f, `${f.base}/sat64.json`, (v) => { v.metrics = { http_reqs: v.metrics.http_reqs }; delete v.root_group; });
  for (const edit of [
    (v) => { delete v.metrics.http_req_duration; },
    (v) => { delete v.metrics.http_req_failed; },
    (v) => { delete v.metrics.checks; },
    (v) => { delete v.root_group.checks["marketplace status 200"]; },
    (v) => { delete v.root_group.checks["marketplace content type"]; },
    (v) => { v.root_group.checks["marketplace content type"].fails = 1; },
  ]) invalidEdit(f, `${f.base}/sat64.json`, edit);
  // All or some requests may fail before an app stop. The full export is still
  // required, but zero successful traffic is not a reason to discard that stop.
  const k6 = read(f.folder, `${f.base}/sat64.json`), raw = read(f.folder, f.path), requests = k6.metrics.http_reqs.count;
  for (const failed of [requests, requests - 150]) {
    k6.metrics.http_req_failed = { passes: failed, fails: requests - failed, value: failed / requests };
    k6.metrics.checks = { passes: requests * 2 - failed, fails: failed, value: (requests * 2 - failed) / (requests * 2) };
    k6.root_group.checks["marketplace status 200"] = { passes: requests - failed, fails: failed };
    raw.upstreamReads.after.answers[200] = raw.upstreamReads.before.answers[200] + requests - failed;
    raw.upstreamReads.after.requests.item_1 = raw.upstreamReads.after.answers[200];
    write(f.folder, `${f.base}/sat64.json`, k6); write(f.folder, f.path, raw);
    assert.equal(validateSaved(f.args).complete, true);
    if (requests > failed) invalidEdit(f, f.path, (v) => { v.upstreamReads.after.answers[200]--; v.upstreamReads.after.requests.item_1--; });
  }
});

for (const participant of ["app", "upstream"]) test(`cumulative ${participant} CPU counters cannot rewind between serial phases`, (t) => {
  const f = fixture(t);
  const path = participant === "app" ? "api/corten/p1-neutral-json/fixed-receipt.json" : "api/corten/p1-en-US-page/sat256-receipt.json";
  invalidEdit(f, path, (v) => {
    const name = v[participant].name, delta = v.after[name] - v.before[name];
    v.before[name] += 10000000; v.after[name] += 10000000;
    assert.equal(v.after[name] - v.before[name], delta, "hostile edit preserves the local CPU delta and summary aggregates");
  });
});

test("stopped-app sidecar observations must be healthy and agree with the runtime receipts", (t) => {
  const f = stoppedFixture(t);
  for (const index of [0, 1]) for (const edit of [
    (state) => { state.OOMKilled = true; },
    (state) => { state.Error = "daemon failure"; },
    (state) => { state.Restarting = true; },
    (state) => { state.ExitCode = 137; },
  ]) invalidEdit(f, f.path, (v) => edit(v.seen.sidecars[index].state));
  for (const [index, role] of [[0, "cpu"], [1, "upstream"]]) invalidEdit(f, f.path, (v) => {
    v[role].state.ExitCode = 137; v.seen.sidecars[index].state.ExitCode = 137;
  });
  // Even healthy states cannot disagree on the container's process identity.
  invalidEdit(f, f.path, (v) => { v.cpu.state.Pid = 41; v.seen.sidecars[0].state.Pid = 42; });
  // Missing post-stop counters do not waive the pre-load observation's chronology.
  invalidEdit(f, f.path, (v) => { v.before[v.app.name] = 0; });
  invalidEdit(f, f.path, (v) => { v.before[v.upstream.name] = 0; });
});

test("qualification and browser gates cannot precede their checked app's lifetime", (t) => {
  const f = fixture(t);
  for (const name of ["check", "qualification"]) invalidEdit(f, `fixture/corten/${name}-container.json`, (v) => {
    v.state.StartedAt = "2026-01-01T00:00:00.100Z"; v.state.FinishedAt = "2026-01-01T00:00:00.200Z";
  });
});

test("review regressions: complete request/check coverage and all latency exports, including stopped apps", (t) => {
  const f = stoppedFixture(t);
  for (const path of ["fixture/corten/p1-en-US-page/fixed.json", `${f.base}/sat64.json`]) {
    for (const edit of [
      (v) => {
        v.metrics.checks = { passes: 1, fails: 0, value: 1 };
        v.root_group.checks["marketplace status 200"] = { passes: 1, fails: 0 };
        v.root_group.checks["marketplace content type"] = { passes: 0, fails: 0 };
      },
      (v) => { v.metrics.checks = { passes: 0, fails: 3000, value: 0 }; },
      (v) => { v.metrics.http_req_duration.avg = 10000; v.metrics.http_req_duration.max = 0; },
      (v) => { v.metrics.iteration_duration["p(95)"] = 0; },
      (v) => { v.metrics.http_req_waiting = { ...v.metrics.http_req_duration, avg: 10000 }; },
      (v) => { v.metrics.iterations.count = v.metrics.http_reqs.count + 1; },
      (v) => { v.metrics.http_req_failed.fails--; },
    ]) invalidEdit(f, path, edit);
  }
});

test("review regressions: shared upstream answer and request counters cannot rewind across phases", (t) => {
  const f = fixture(t), path = "api/corten/p1-neutral-json/fixed-receipt.json";
  for (const field of ["answers", "requests"]) invalidEdit(f, path, (v) => {
    const key = Object.keys(v.upstreamReads.before[field])[0];
    const delta = v.upstreamReads.after[field][key] - v.upstreamReads.before[field][key];
    v.upstreamReads.before[field][key] += 10000000; v.upstreamReads.after[field][key] += 10000000;
    assert.equal(v.upstreamReads.after[field][key] - v.upstreamReads.before[field][key], delta);
  });
  // Coherent local request/answer totals still cannot rewind together.
  invalidEdit(f, path, (v) => {
    for (const field of ["answers", "requests"]) for (const side of ["before", "after"]) {
      for (const key of Object.keys(v.upstreamReads[side][field])) v.upstreamReads[side][field][key] += 10000000;
    }
  });
});

test("review regressions: shared dependencies must exist during their observations", (t) => {
  const f = fixture(t);
  const paths = readdirSync(f.folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(f.folder.length + 1).replaceAll("\\", "/"));
  for (const role of ["cpu", "upstream"]) for (const startedAt of ["2027-01-01T00:00:00Z", "2026-01-01T01:00:00Z"]) {
    const originals = new Map();
    try {
      for (const path of paths.filter((p) => p === `${role}-container.json` || p.endsWith("-receipt.json") && (role === "cpu" || p.startsWith("api/")))) {
        originals.set(path, readFileSync(join(f.folder, path)));
        const v = read(f.folder, path); (v[role] ?? v).state.StartedAt = startedAt; write(f.folder, path, v);
      }
      assert.throws(() => validateSaved(f.args), (e) => e.code === "MARKETPLACE_EVIDENCE_INVALID", role);
    } finally { for (const [path, bytes] of originals) writeFileSync(join(f.folder, path), bytes); }
  }
});

test("review regressions: healthy phases cannot contain stop-only sidecar or event observations", (t) => {
  const f = fixture(t), path = "fixture/corten/p1-en-US-page/fixed-receipt.json";
  for (const edit of [
    (v) => { v.seen.sidecars = [{ name: v.cpu.name, startedAt: v.cpu.state.StartedAt, state: { ...v.cpu.state, Running: false, ExitCode: 137 } }]; v.seen.events = [{ action: "kill", ms: Date.parse(v.seen.phaseStart) + 1000 }]; },
    (v) => { v.seen.sidecars = []; },
    (v) => { v.seen.events = []; },
  ]) invalidEdit(f, path, edit);
});
