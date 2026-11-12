import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { hardeningCaptureSchema, hardeningContract, validateHardeningOutcome } from "../workloads/hardening.mjs";
import { validateBudget } from "./plan.mjs";
import { validateControl } from "./probe.mjs";

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

export function assemble({ settings, raw, parity, source, cleanup, provenance, lifecycle }) {
  const b = validateBudget(JSON.parse(settings.effectiveBudgets)); verifyParity(parity, source);
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
  const attack = raw.filter((r) => r.type === "attack").sort((a, c) => a.index - c.index);
  assert.deepEqual(attack.map((r) => r.index), b.attack.scheduledAtMs.map((_, i) => i), "attack attempt indices incomplete");
  assert.ok(attack.every((r) => r.phase === settings.phase && r.endedAtMs >= r.startedAtMs));
  assert.ok(attack.reduce((n, r) => n + r.bytesQueued, 0) <= b.attack.maxWireBytes, "injector wire budget exceeded");
  if (settings.phase === "oversized-requests") for (const variant of ["header-count", "header-size", "body-size"]) assert.ok(attack.some((r) => r.variant === variant));
  const legitimate = {}, resources = {};
  for (const [window, w] of Object.entries(b.legitimate)) {
    const boundary = (name) => { const rows = raw.filter((r) => r.type === "window" && r.window === window && r.boundary === name); assert.equal(rows.length, 1); return rows[0].atMs; };
    const startMs = boundary("startMs"), endMs = boundary("endMs");
    const rows = raw.filter((r) => r.type === "legitimate" && r.window === window).sort((a, c) => a.index - c.index);
    assert.deepEqual(rows.map((r) => r.index), w.scheduledAtMs.map((_, i) => i), "legitimate attempt indices incomplete");
    const times = rows.filter((r) => r.ok).map((r) => r.latencyMs).sort((a, c) => a - c);
    legitimate[window] = { startMs, endMs, counts: { sent: rows.length, ok: times.length, errors: rows.length - times.length },
      startedAtMs: rows.map((r) => r.startedAtMs), latency: times.length ? { p50Ms: percentile(times, 0.5), p99Ms: percentile(times, 0.99), maxMs: times.at(-1) } : unavailable("no successful legitimate requests"), evidence: `raw.jsonl#legitimate/${window}` };
    const samples = raw.filter((r) => r.type === "resources" && r.window === window); assert.equal(samples.length, 1);
    const sample = samples[0];
    assert.deepEqual(Object.keys(sample.samples).sort(), settings.deployment.processes.map((p) => p.id).sort());
    resources[window] = settings.deployment.processes.map((p) => {
      const s = sample.samples[p.id], state = lifecycle[p.id]; assert.ok(state, "missing lifecycle evidence");
      const sampleWall = Date.parse(clock.wallAtStart) + sample.atMs;
      assert.equal(state.before.State.Running, true); assert.equal(state.after.Id, state.before.Id); assert.equal(state.after.State.StartedAt, state.before.State.StartedAt, "target restarted");
      assert.ok(!state.after.State.Error, "Docker lifecycle failure");
      assert.ok(!state.events.some((e) => ["kill", "stop", "start", "restart", "pause", "unpause", "destroy"].includes(e.Action)), "external lifecycle intervention invalidates apparatus");
      if (s.unavailable) assert.ok(state.after.State.Running === false && Date.parse(state.after.State.FinishedAt) <= sampleWall, "unexplained missing resource evidence");
      const running = s.unavailable ? false : s.running;
      if (!s.unavailable) {
        assert.equal(s.cpuSeconds, Number(/^usage_usec (\d+)$/m.exec(s.cpu)?.[1]) / 1e6, "CPU differs from raw cgroup counter");
        assert.equal(s.memoryBytes, Number(s.memory), "memory differs from raw cgroup counter");
        assert.equal(s.running, s.procs.length > 0, "running differs from process inventory");
        assert.equal(s.oomKilled, Number(/^oom_kill (\d+)$/m.exec(s.events)?.[1]) > 0, "OOM differs from raw cgroup events");
      }
      const oomKilled = !running && (s.unavailable ? state.after.State.OOMKilled : s.oomKilled);
      return { id: p.id, count: p.count, observedProcessCount: s.procs?.length ?? unavailable("container exited before sample"), atMs: sample.atMs, running, oomKilled,
        cpuSeconds: s.cpuSeconds ?? unavailable(s.unavailable), memoryBytes: s.memoryBytes ?? unavailable(s.unavailable), evidence: `raw.jsonl#resources/${window}/${p.id}` };
    });
  }
  assert.ok(legitimate.before.counts.ok > 0, "no observed baseline service");
  const established = attack.filter((r) => r.established), closed = established.filter((r) => r.targetClosedAtMs !== null);
  const after = raw.filter((r) => r.type === "legitimate" && r.window === "after");
  const recoveryStart = Math.max(b.legitimate.during.endMs, legitimate.during.endMs), recovered = after.filter((r) => r.ok && r.startedAtMs >= recoveryStart).sort((a, c) => a.endedAtMs - c.endedAtMs)[0];
  const runningApps = resources.after.filter((s) => settings.deployment.processes.find((p) => p.id === s.id).role === "application").every((s) => s.running);
  const rejected = established.filter((r) => /^HTTP\/1\.[01] (4\d\d|5\d\d)/.test(r.responsePrefix));
  const missing = ["slow-headers", "slow-bodies", "idle-connections"].includes(settings.phase) && established.length > 0 && closed.length === 0;
  // Closing a slow reader is not proof it reached write backpressure. No generic cap/timeout attribution.
  const protection = rejected.length ? "observed" : missing ? "missing" : "inconclusive";
  const capture = { schema: hardeningCaptureSchema, contract: hardeningContract, case: settings.case, phase: settings.phase,
    deployment: settings.deployment, effectiveBudgets: settings.effectiveBudgets, provenance,
    parity: { status: "passed", contract: "marketplace-v2/native-browser-and-content", evidence: "parity.json" },
    apparatus: { injector: { healthy: true, scheduled: b.attack.scheduledAtMs.length, attempted: attack.length, errors: 0, dropped: 0, evidence: "raw.jsonl#attack" },
      host: { healthy: true, evidence: "raw.jsonl#probe-cleanup" }, controls: { attackValid: true, legitimateValid: true, evidence: "raw.jsonl#control-before,control-after" },
      artifacts: { complete: true, evidence: "manifest.json" }, cleanup: { complete: true, atMs: Math.max(reaped.atMs, legitimate.after.endMs) + cleanup.elapsedAfterProbeMs,
        connections: 0, processes: 0, tasks: 0, evidence: "cleanup.json" } },
    attack: { attempted: attack.length, established: established.length, failed: attack.length - established.length, closed: closed.length, held: established.length - closed.length,
      startedAtMs: attack.map((r) => r.startedAtMs), evidence: "raw.jsonl#attack" }, legitimate, resources,
    recovery: { attempted: true, startMs: recoveryStart, endMs: recovered ? recovered.endedAtMs : legitimate.after.endMs,
      disposition: recovered && runningApps ? "recovered" : runningApps ? "not-recovered" : "stopped", evidence: "raw.jsonl#legitimate/after" },
    defense: { protection, reason: rejected.length ? "native HTTP rejection observed; see exact statuses and incomplete sends" : missing ? "connections retained to the declared release; no closure protection observed within this profile" : "bounded observations do not identify a protection mechanism",
      attribution: [{ layer: "unknown", mechanism: "raw closure/rejection/unread-queue evidence only; no inferred server/proxy mechanism", evidence: "raw.jsonl#attack" }] } };
  return validateHardeningOutcome(capture, settings);
}
