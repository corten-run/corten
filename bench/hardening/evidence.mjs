import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { hardeningCaptureSchema, hardeningContract, validateHardeningOutcome } from "../workloads/hardening.mjs";
import { validateBudget } from "./plan.mjs";
import { validateControl } from "./probe.mjs";
import { assessTimedSource } from "./native.mjs";
import { records } from "../marketplace/fixtures.mjs";
import { validateLegitimate, validateAttack } from "./receipts.mjs";
import { terminalRecovery } from "./lifecycle.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function artifacts(folder) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name); assert.ok(!lstatSync(path).isSymbolicLink(), "artifact symlinks forbidden");
      if (entry.isDirectory()) walk(path);
      else if (!["manifest.json", "capture.json"].includes(entry.name)) {
        const bytes = readFileSync(path); entries.push({ path: relative(folder, path).replaceAll("\\", "/"), bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  };
  walk(folder); return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export function verifyArtifacts(folder, manifest) {
  assert.ok(Array.isArray(manifest) && manifest.length > 0);
  for (const row of manifest) {
    assert.ok(typeof row.path === "string" && !isAbsolute(row.path));
    const rel = relative(resolve(folder), resolve(folder, row.path));
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), "artifact escaped result directory");
  }
  assert.deepEqual(artifacts(folder), manifest, "raw artifact missing, added or modified");
}
const unavailable = (reason) => ({ status: "unavailable", reason });
const percentile = (values, share) => values[Math.min(values.length - 1, Math.ceil(values.length * share) - 1)];

export function verifyParity(parity, source) {
  assert.equal(parity.workload, "marketplace-v2"); assert.equal(parity.source, source);
  assert.equal(parity.jsonRecords, 500); assert.equal(parity.pages, 264); assert.equal(parity.profiles.length, 12);
  const keys = parity.profiles.map((p) => { assert.equal(p.passed, true); return `${p.locale}/${p.javaScriptEnabled}/${p.mobile}`; });
  assert.equal(new Set(keys).size, 12);
  for (const locale of ["en-US", "fr-FR", "de-DE"]) for (const js of [true, false]) for (const mobile of [true, false]) assert.ok(keys.includes(`${locale}/${js}/${mobile}`));
  if (source === "api") assert.deepEqual(parity.upstream, { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true });
}

export function defensiveRejection(phase, row) {
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(row.responsePrefix)?.[1]);
  if (phase === "oversized-requests") return row.variant === "body-size" ? status === 413 : [414, 431].includes(status);
  if (["slow-headers", "slow-bodies", "idle-connections"].includes(phase)) return status === 408 || phase === "slow-bodies" && status === 413;
  return phase === "connection-pressure" && status === 429;
}

export function verifyNativeLimits(settings, lifecycle) {
  const b = validateBudget(JSON.parse(settings.effectiveBudgets)), edge = settings.case === "deployed-edge";
  assert.deepEqual(settings.deployment.processes.map((p) => p.role).sort(), ["application", "upstream", ...(edge ? ["proxy"] : [])].sort(), "native deployment roles were dropped or added outside the exact budget");
  for (const p of settings.deployment.processes) {
    const state = lifecycle[p.id]; assert.ok(state?.before?.HostConfig && state?.after?.HostConfig, "missing actual native limits");
    const limit = p.role === "application" ? b.resources[edge ? "applicationEdge" : "applicationDirect"] : b.resources[p.role];
    const actual = state.before.HostConfig;
    assert.equal(actual.NanoCpus, limit.cpu * 1e9, `${p.id}: actual CPU quota differs from declared budget`);
    assert.equal(actual.Memory, limit.memory, `${p.id}: actual memory limit differs from declared budget`);
    assert.equal(actual.MemorySwap, limit.memory, `${p.id}: undeclared swap allowance`);
    assert.equal(actual.PidsLimit, 512, `${p.id}: actual task limit differs`);
    assert.deepEqual(actual.Ulimits, [{ Name: "nofile", Hard: 65536, Soft: 65536 }], `${p.id}: actual FD limit differs`);
    assert.equal(actual.RestartPolicy.Name, "no", "automatic restart cannot manufacture recovery");
    assert.equal(actual.Privileged, false); assert.deepEqual(actual.PortBindings, {}, "native verification must not publish ports");
    assert.deepEqual(state.after.HostConfig, actual, "native deployment configuration changed during injection");
    assert.ok(!state.events.some((event) => event.Action === "update"), "external configuration intervention invalidates apparatus");
  }
}

export function assemble({ settings, raw, parity, source, cleanup, provenance, lifecycle }) {
  const b = validateBudget(JSON.parse(settings.effectiveBudgets)); verifyParity(parity, source);
  verifyNativeLimits(settings, lifecycle);
  const expected = records().item_1;
  for (const row of raw.filter((r) => r.type === "legitimate")) validateLegitimate(row, expected);
  if (settings.nativeSource === "api") { assert.equal(source, "api"); assessTimedSource(raw); }
  const one = (type) => { const rows = raw.filter((r) => r.type === type); assert.equal(rows.length, 1, `missing/duplicate ${type}`); return rows[0]; };
  for (const type of ["control-before", "control-after"]) {
    const control = one(type); validateControl(control); assert.equal(control.phase, settings.phase);
  }
  const reaped = one("probe-cleanup");
  assert.equal(reaped.connections, 0); assert.equal(reaped.tasks, 0); assert.deepEqual(reaped.errors, []); assert.deepEqual(reaped.failures, []);
  assert.ok(reaped.eventLoopMaxMs <= b.timing.maxStartLagMs, "injector event loop stalled");
  assert.equal(cleanup.complete, true); assert.equal(cleanup.containers.length, 0); assert.equal(cleanup.volumes.length, 0);
  assert.equal(cleanup.commandClients, 0);
  const clock = one("clock");
  assert.equal(cleanup.nativeClock?.bootId, clock.bootId, "cleanup and injector clocks are not from the same kernel boot");
  assert.match(clock.monotonicNs, /^\d+$/); assert.match(cleanup.nativeClock.monotonicNs, /^\d+$/);
  const cleanupAtMs = Number(BigInt(cleanup.nativeClock.monotonicNs) - BigInt(clock.monotonicNs)) / 1e6;
  assert.ok(cleanupAtMs >= reaped.atMs, "cleanup clock preceded injector cleanup");
  const attack = raw.filter((r) => r.type === "attack").sort((a, c) => a.index - c.index);
  assert.deepEqual(attack.map((r) => r.index), b.attack.scheduledAtMs.map((_, i) => i), "attack attempt indices incomplete");
  assert.ok(Array.isArray(settings.emissionPlan) && settings.emissionPlan.length === attack.length, "missing exact native emission plan; historical evidence cannot establish current semantic qualification");
  for (const row of attack) validateAttack(row, settings.emissionPlan[row.index], b);
  assert.ok(attack.every((r) => r.phase === settings.phase && r.endedAtMs >= r.startedAtMs));
  assert.ok(attack.reduce((n, r) => n + r.bytesQueued, 0) <= b.attack.maxWireBytes, "injector wire budget exceeded");
  if (settings.phase === "oversized-requests") for (const variant of ["header-count", "header-size", "body-size"]) assert.ok(attack.some((r) => r.variant === variant));
  const legitimate = {}, resources = {};
  for (const [window, w] of Object.entries(b.legitimate)) {
    const boundary = (name) => { const rows = raw.filter((r) => r.type === "window" && r.window === window && r.boundary === name); assert.equal(rows.length, 1); return rows[0].atMs; };
    const startMs = boundary("startMs"), endMs = boundary("endMs");
    const rows = raw.filter((r) => r.type === "legitimate" && r.window === window).sort((a, c) => a.index - c.index);
    assert.deepEqual(rows.map((r) => r.index), w.scheduledAtMs.map((_, i) => i), "legitimate attempt indices incomplete");
    const paths = ["/marketplace/en-US/item_1", "/marketplace/fr-FR/item_1", "/marketplace/de-DE/item_1", "/api/marketplace/item_1"];
    for (const row of rows) assert.equal(row.path, paths[row.index % paths.length], "scheduled native request path was substituted");
    const times = rows.filter((r) => r.ok).map((r) => r.latencyMs).sort((a, c) => a - c);
    legitimate[window] = { startMs, endMs, counts: { sent: rows.length, ok: times.length, errors: rows.length - times.length },
      startedAtMs: rows.map((r) => r.startedAtMs), latency: times.length ? { p50Ms: percentile(times, 0.5), p99Ms: percentile(times, 0.99), maxMs: times.at(-1) } : unavailable("no successful legitimate requests"), evidence: `raw.jsonl#legitimate/${window}` };
    const samples = raw.filter((r) => r.type === "resources" && r.window === window); assert.equal(samples.length, 1);
    const sample = samples[0];
    if (sample.collectedAtMs !== undefined) assert.ok(sample.atMs >= startMs && sample.collectedAtMs >= sample.atMs && sample.collectedAtMs <= endMs, "resource collection escaped observation window");
    assert.deepEqual(Object.keys(sample.samples).sort(), settings.deployment.processes.map((p) => p.id).sort());
    resources[window] = settings.deployment.processes.map((p) => {
      const s = sample.samples[p.id], state = lifecycle[p.id]; assert.ok(state, "missing lifecycle evidence");
      const sampleWall = Date.parse(clock.wallAtStart) + (sample.collectedAtMs ?? sample.atMs);
      assert.equal(state.before.State.Running, true); assert.equal(state.after.Id, state.before.Id); assert.equal(state.after.State.StartedAt, state.before.State.StartedAt, "target restarted");
      assert.ok(!state.after.State.Error, "Docker lifecycle failure");
      assert.ok(!state.events.some((e) => ["kill", "stop", "start", "restart", "pause", "unpause", "destroy"].includes(e.Action)), "external lifecycle intervention invalidates apparatus");
      if (s.unavailable) assert.ok(state.after.State.Running === false && Date.parse(state.after.State.FinishedAt) <= sampleWall, "unexplained missing resource evidence");
      const running = s.unavailable ? false : s.running;
      if (!s.unavailable) {
        if (s.startedNs !== undefined) {
          const began = Number(BigInt(s.startedNs) - BigInt(clock.monotonicNs)) / 1e6, ended = Number(BigInt(s.endedNs) - BigInt(clock.monotonicNs)) / 1e6;
          assert.ok(began >= sample.atMs && ended >= began && ended <= sample.collectedAtMs, "resource counter timestamp differs from collection interval");
          assert.ok(s.procs.every((pid) => /^[1-9]\d*$/.test(pid)), "native PID inventory hidden by observer namespace");
        }
        assert.equal(s.cpuSeconds, Number(/^usage_usec (\d+)$/m.exec(s.cpu)?.[1]) / 1e6, "CPU differs from raw cgroup counter");
        assert.equal(s.memoryBytes, Number(s.memory), "memory differs from raw cgroup counter");
        assert.equal(s.running, s.procs.length > 0, "running differs from process inventory");
        assert.equal(s.oomKilled, Number(/^oom_kill (\d+)$/m.exec(s.events)?.[1]) > 0, "OOM differs from raw cgroup events");
      }
      const oomKilled = !running && (s.unavailable ? state.after.State.OOMKilled : s.oomKilled);
      return { id: p.id, count: p.count, observedProcessCount: s.procs?.length ?? unavailable("container exited before sample"), atMs: s.unavailable ? sample.collectedAtMs ?? sample.atMs : sample.atMs, running, oomKilled,
        cpuSeconds: s.cpuSeconds ?? unavailable(s.unavailable), memoryBytes: s.memoryBytes ?? unavailable(s.unavailable), evidence: `raw.jsonl#resources/${window}/${p.id}` };
    });
  }
  const established = attack.filter((r) => r.established), closed = established.filter((r) => r.targetClosedAtMs !== null);
  const after = raw.filter((r) => r.type === "legitimate" && r.window === "after");
  const recoveryStart = Math.max(b.legitimate.during.endMs, legitimate.during.endMs), recovered = after.filter((r) => r.ok && r.startedAtMs >= recoveryStart).sort((a, c) => a.endedAtMs - c.endedAtMs)[0];
  const terminal = terminalRecovery(recovered, settings.deployment.processes, resources.after, lifecycle);
  const rejected = established.filter((r) => defensiveRejection(settings.phase, r));
  const missing = ["slow-headers", "slow-bodies", "idle-connections"].includes(settings.phase) && established.length > 0 && closed.length === 0;
  // Closing a slow reader is not proof it reached write backpressure. No generic cap/timeout attribution.
  const protection = rejected.length ? "observed" : missing ? "missing" : "inconclusive";
  const capture = { schema: hardeningCaptureSchema, contract: hardeningContract, case: settings.case, phase: settings.phase,
    deployment: settings.deployment, effectiveBudgets: settings.effectiveBudgets, provenance,
    parity: { status: "passed", contract: "marketplace-v2/native-browser-and-content", evidence: "parity.json" },
    apparatus: { injector: { healthy: true, scheduled: b.attack.scheduledAtMs.length, attempted: attack.length, errors: 0, dropped: 0, evidence: "raw.jsonl#attack" },
      host: { healthy: true, evidence: "raw.jsonl#probe-cleanup" }, controls: { attackValid: true, legitimateValid: true, evidence: "raw.jsonl#control-before,control-after" },
      artifacts: { complete: true, evidence: "manifest.json" }, cleanup: { complete: true, atMs: cleanupAtMs,
        connections: 0, processes: 0, tasks: 0, evidence: "cleanup.json" } },
    attack: { attempted: attack.length, established: established.length, failed: attack.length - established.length, closed: closed.length, held: established.length - closed.length,
      startedAtMs: attack.map((r) => r.startedAtMs), evidence: "raw.jsonl#attack" }, legitimate, resources,
    recovery: { attempted: true, startMs: recoveryStart, endMs: terminal.disposition === "recovered" ? recovered.endedAtMs : legitimate.after.endMs,
      ...terminal, evidence: "raw.jsonl#legitimate/after and native application lifecycle after snapshots" },
    defense: { protection, reason: rejected.length ? "native HTTP rejection observed; see exact statuses and incomplete sends" : missing ? "connections retained to the declared release; no closure protection observed within this profile" : "bounded observations do not identify a protection mechanism",
      attribution: [{ layer: "unknown", mechanism: "raw closure/rejection/unread-queue evidence only; no inferred server/proxy mechanism", evidence: "raw.jsonl#attack" }] } };
  return validateHardeningOutcome(capture, settings);
}

export function targetOutcome(capture, assessment, sourceObservation) {
  const service = Object.fromEntries(Object.entries(capture.legitimate).map(([key, value]) => [key, value.counts]));
  return { classification: Object.values(service).some((counts) => counts.errors > 0) || capture.recovery.disposition !== "recovered"
    ? "target-capacity-failure" : "service-preserved", service, recovery: capture.recovery.disposition,
    measurement: capture.measurement, numericComparisonQualified: capture.measurement === "complete" && capture.recovery.disposition === "recovered"
      && Object.values(service).every((counts) => counts.errors === 0) && assessment?.productionQualified === true
      && (!sourceObservation || sourceObservation.state === "observed") };
}
