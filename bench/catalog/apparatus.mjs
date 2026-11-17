// Worker-aware evidence is opt-in and never changes legacy v2/v3 interpretation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

export const workerRawSchema = "catalog-saved-evidence/v4";
export const workerPhaseSchema = "catalog-timed-phase/v2";
export const apparatus = Object.freeze({ schema: "node-cluster-2/v1", workers: 2, coordinator: 1,
  quota: 2, memoryBytes: 512 * 2 ** 20, sampleMs: 500, maxGapMs: 2000, processPeakLimitPct: 80, containerPeakLimitPct: 160 });
export const workerCommand = ["node", "--max-old-space-size=64", "/bench/catalog/upstream.mjs", "--fixed-workers"];
export const workerAware = (summary) => summary.savedEvidence?.schema === workerRawSchema;
export const digest = (text) => createHash("sha256").update(text).digest("hex");
const same = (a, b, message) => assert.ok(isDeepStrictEqual(a, b), message);
const count = (n) => Number.isSafeInteger(n) && n >= 0;
// Apparatus closure; application/framework/build input closure remains the campaign source audit.
export const apparatusSources = ["apparatus.mjs", "upstream.mjs", "upstream-workers.mjs", "timed.mjs", "preflight.mjs", "run.mjs",
  "raw.mjs", "verify.mjs", "report.mjs", "group.mjs", "contract.mjs", "fixtures.mjs", "stats.mjs", "output.mjs", "cold.mjs",
  "check.mjs", "check-result.mjs", "record-attempt.mjs", "styles.mjs", "cgroup.mjs", "load.js", "load-outcome.js", "catalog.css"]
  .map((p) => `bench/catalog/${p}`).concat(["bench/load-tool.mjs", "bench/fullstack/apps.mjs", "bench/fullstack/inventory.mjs",
    "bench/fullstack/conformance.mjs", "bench/fullstack/passes.mjs", "bench/workloads/registry.mjs", "bench/marketplace/contract.mjs",
    "scripts/steady.mjs", "bench/fullstack/apps/axum-maud/static/style.css", "bench/fullstack/apps/axum-maud/static/components.css", "package.json", "package-lock.json"]);
export function sourceProof(commit) {
  return { schema: "catalog-apparatus-source/v1", commit,
    files: Object.fromEntries(apparatusSources.map((path) => [path, digest(readFileSync(new URL(`../../${path}`, import.meta.url)))])) };
}
export function verifySource(summary, reader) {
  same(summary.measurement.apparatus, apparatus, "worker apparatus differs");
  assert.equal(summary.measurement.cpus.api.quota, 2); assert.equal(summary.measurement.upstreamMemoryBytes, apparatus.memoryBytes);
  const raw = reader.readText("apparatus-source.json"), proof = JSON.parse(raw);
  assert.equal(digest(raw), summary.savedEvidence.apparatusSourceSha256, "apparatus source digest differs");
  assert.equal(proof.schema, "catalog-apparatus-source/v1"); assert.equal(proof.commit, summary.commit, "apparatus source commit differs");
  same(Object.keys(proof.files), apparatusSources, "apparatus source inventory differs");
  for (const hash of Object.values(proof.files)) assert.match(hash, /^[a-f0-9]{64}$/);
}
export function verifyControl(control, native = false) {
  assert.ok(count(control.epoch), "worker epoch missing");
  assert.ok([200, 503].includes(control.status), "worker status missing");
  assert.match(control.configuration, /^[a-f0-9]{64}$/, "worker control configuration missing");
  assert.equal(control.workers?.length, 2, "worker acknowledgements missing");
  same(control.workers.map((w) => w.identity.role), ["worker-1", "worker-2"], "worker roles differ");
  const merged = {};
  for (const w of control.workers) {
    assert.equal(w.epoch, control.epoch, "worker epoch acknowledgement differs"); assert.equal(w.status, control.status);
    assert.equal(w.configuration, control.configuration, "worker override/status acknowledgement differs");
    for (const [id, value] of Object.entries(w.requests)) {
      assert.match(id, /^record_[1-9]\d*$/); assert.ok(count(value), "worker request counter invalid");
      merged[id] = (merged[id] ?? 0) + value; assert.ok(count(merged[id]));
    }
  }
  same(control.requests, merged, "worker aggregate counts differ");
  const ids = [control.coordinator, ...control.workers.map((w) => w.identity)];
  assert.equal(new Set(ids.map((id) => id.pid)).size, 3, "worker identities overlap");
  for (const [i, id] of ids.entries()) {
    assert.equal(id.role, ["coordinator", "worker-1", "worker-2"][i]);
    assert.ok(Number.isInteger(id.pid) && id.pid > 0);
    if (native) {
      assert.equal(id.native, true, "portable identity is not native evidence");
      assert.match(id.start, /^[1-9]\d*$/); assert.match(id.boot, /^[a-f0-9-]{36}$/);
      assert.ok(/^0::\//.test(id.cgroup), "worker cgroup v2 identity missing");
      assert.equal(id.boot, ids[0].boot); assert.equal(id.cgroup, ids[0].cgroup);
    }
  }
  return ids;
}
export function verifyWorkers(summary, subject, evidence, { start, end, container, previous } = {}) {
  assert.equal(evidence.schema, "catalog-worker-observations/v1");
  same(evidence.binding, { commit: summary.commit, sourceSha256: summary.savedEvidence.apparatusSourceSha256,
    container: container.id, image: container.image, startedAt: container.state.StartedAt,
    budget: container.budget, app: subject.app, source: subject.source, target: subject.target, phase: subject.phase }, "worker source/container binding differs");
  same(summary.measurement.apparatus, apparatus, "worker topology not admitted");
  assert.equal(evidence.processes?.length, 3, "worker process inventory incomplete");
  const ids = verifyControl(evidence.before, true), afterIds = verifyControl(evidence.after, true);
  same(ids, afterIds, "worker churn during phase"); assert.equal(evidence.before.epoch, evidence.after.epoch, "control epoch changed during phase");
  same(evidence.before.requests, {}, "phase reset was not acknowledged"); assert.equal(evidence.before.status, 200);
  assert.equal(evidence.before.configuration, digest(JSON.stringify({ status: 200, override: null })), "phase override was not reset");
  assert.equal(evidence.after.configuration, evidence.before.configuration, "control configuration changed during phase");
  assert.equal(evidence.after.status, 200);
  assert.equal(new Set(ids.map((id) => id.pid)).size, 3, "worker identities overlap");
  const peaks = {};
  for (let i = 0; i < 3; i++) {
    const process = evidence.processes[i], id = ids[i], rows = process.samples;
    same(process.identity, id, "observed worker identity differs");
    assert.ok(rows?.length >= 2 && rows.length <= 700, "worker samples incomplete");
    let peak = 0;
    for (let n = 0; n < rows.length; n++) {
      const row = rows[n];
      assert.ok(typeof row.beginNs === "string" && /^\d+$/.test(row.beginNs) && typeof row.endNs === "string" && /^\d+$/.test(row.endNs));
      const begin = BigInt(row.beginNs), finish = BigInt(row.endNs);
      assert.ok(finish >= begin && finish - begin <= 100000000n, "worker sample read window invalid");
      assert.ok(count(row.cpuUsec) && count(row.wallMs), "worker counter invalid");
      if (n) {
        const prior = rows[n - 1], delta = begin - BigInt(prior.beginNs);
        assert.ok(delta > 0n && delta <= BigInt(apparatus.maxGapMs) * 1000000n
          && begin >= BigInt(prior.endNs), "worker monotonic sample gap");
        assert.ok(row.cpuUsec >= prior.cpuUsec && row.wallMs >= prior.wallMs && row.wallMs - prior.wallMs <= apparatus.maxGapMs, "worker counter reversed or wall gap");
        const elapsedMs = Number(delta) / 1e6;
        assert.ok(Math.abs(row.wallMs - prior.wallMs - elapsedMs) < 100, "worker clocks contradict");
        peak = Math.max(peak, (row.cpuUsec - prior.cpuUsec) / (Number(delta) / 1e9) / 10000);
      }
    }
    assert.ok(rows[0].wallMs <= start && rows.at(-1).wallMs >= end
      && rows.some((r) => r.wallMs <= start && start - r.wallMs <= apparatus.maxGapMs)
      && rows.some((r) => r.wallMs >= end && r.wallMs - end <= apparatus.maxGapMs), "worker observation window incomplete");
    if (previous) {
      same(previous.processes[i].identity, id, "worker identity changed across round");
      assert.ok(rows[0].cpuUsec >= previous.processes[i].samples.at(-1).cpuUsec
        && BigInt(rows[0].beginNs) >= BigInt(previous.processes[i].samples.at(-1).endNs), "worker round counter/window reversed");
      assert.equal(evidence.before.epoch, previous.after.epoch + 1, "worker epoch reset differs across round");
    }
    peaks[id.role] = peak;
  }
  return peaks;
}
export function workerHeadroom(peaks, containerPeak) {
  assert.ok(Number.isFinite(containerPeak) && containerPeak < 160, "busy upstream container");
  assert.ok(Object.keys(peaks).length === 3 && Object.values(peaks).every((n) => Number.isFinite(n) && n < 80), "busy upstream worker/coordinator");
}
