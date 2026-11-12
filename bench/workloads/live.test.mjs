import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveWorkload, liveSnapshot, liveStateSchema, liveCaptureSchema, liveContracts, validateLiveCapture,
} from "./live.mjs";

// Synthetic application observations for unit tests, NOT framework adapters or qualification.
const fixture = () => createLiveWorkload({ seed: 17, rowCount: 3, eventCount: 9 });
const settingsFor = (scenario = "normal", group = "recoverable-live", slowOutcome = "resnapshot") => ({
  group, scenario, slowOutcome, queueLimit: 2, historyLimit: 8,
  maxRecoveryMs: 100, maxCleanupMs: 20, cleanupObservationMs: 5, maxSlowMs: 50, maxPublishLagMs: 5,
});

function journey(settings = settingsFor(), strategy = "replay") {
  const workload = fixture(), records = [];
  let at = 0, published = 0, through = 0, queuePeak = 0;
  let rows = new Map(workload.initial.map((r) => [r.id, structuredClone(r)]));
  const effects = [];
  const add = (kind, fields = {}) => { records.push(structuredClone({ kind, at: ++at, ...fields })); };
  const application = () => ({ state: [...rows.values()], effects: [...effects], effectCount: effects.length });
  const resources = (active, queueEvents = 0) => { queuePeak = Math.max(queuePeak, queueEvents); add("resources", {
    subscriptions: Number(active), connections: Number(active), pendingTasks: Number(active),
    queueLimit: settings.queueLimit, queueEvents, queuePeak,
    historyLimit: settings.historyLimit, historyEvents: 0, historyPeak: 0,
  }); };
  const snapshot = (version) => {
    add("snapshot-request");
    // Independent state reduction, not liveSnapshot(), to construct application observations.
    rows = new Map(workload.initial.map((r) => [r.id, structuredClone(r)]));
    for (const e of workload.events.slice(0, version)) {
      if (e.op === "remove") rows.delete(e.key);
      else rows.set(e.key, structuredClone(e.row));
    }
    through = version;
    add("snapshot", { through, rows: [...rows.values()], ...application(), work: { reads: 1, rows: rows.size } });
  };
  const publish = () => {
    published += 1;
    add("publish", { seq: published, scheduledAt: at + 1, startedAt: at + 1 });
  };
  const event = (seq, disposition = "applied") => {
    const e = workload.events[seq - 1];
    if (disposition === "applied") {
      through = seq; effects.push(e.effectId);
      if (e.op === "remove") rows.delete(e.key);
      else rows.set(e.key, structuredClone(e.row));
    }
    add("event", { event: e, disposition, ...application() });
  };
  const state = () => { const a = application(); add("state", { through, rows: a.state, effects: a.effects, effectCount: a.effectCount }); };
  resources(false); add("attach"); resources(true); snapshot(0);
  publish(); event(1);
  const { scenario } = settings;
  if (["disconnect", "missed-updates", "expired-cursor"].includes(scenario)
    || scenario === "slow-reader" && settings.slowOutcome === "disconnect") {
    if (scenario === "slow-reader") {
      add("slow"); while (published < 4) publish();
      resources(true, settings.queueLimit); add("overflow", { outcome: "disconnect" });
    }
    add("disconnect", { reason: scenario === "slow-reader" ? "slow-reader" : "forced" }); resources(false);
    while (published < (scenario === "slow-reader" ? 5 : 4)) publish();
    add("attach"); resources(true);
    add("resume", { from: through, status: scenario === "expired-cursor" ? "expired" : "accepted" });
    if (strategy === "resnapshot" || scenario === "expired-cursor") snapshot(published);
    else {
      event(1, "duplicate");
      while (through < published) event(through + 1);
    }
  } else if (scenario === "gap") {
    while (published < 4) publish();
    event(4, "gap");
    if (strategy === "resnapshot") snapshot(published);
    else while (through < published) event(through + 1);
  } else if (scenario === "slow-reader") {
    add("slow"); while (published < 4) publish();
    resources(true, settings.queueLimit); add("overflow", { outcome: "resnapshot" }); resources(true); snapshot(published);
  }
  while (published < workload.eventCount) { publish(); event(published); }
  event(workload.eventCount, "duplicate"); state(); add("detach"); resources(false);
  add("cleanup-probe", { event: workload.cleanupProbe });
  resources(false); at += settings.cleanupObservationMs; state();
  return { workload, capture: { schema: liveCaptureSchema, contract: liveContracts[settings.group], records }, settings };
}
const validate = ({ workload, capture, settings }, normalize) => validateLiveCapture(workload, capture, settings, normalize);
const find = (j, kind, predicate = () => true) => j.capture.records.find((r) => r.kind === kind && predicate(r));

test("versioned deterministic keyed fixture includes deletion, reinsertion, versions and an independent probe", () => {
  const w = fixture();
  assert.deepEqual(w, fixture()); assert.equal(w.schema, liveStateSchema);
  assert.notDeepEqual(w, createLiveWorkload({ ...w, seed: 18 }));
  assert.deepEqual(w.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(new Set(w.events.map((e) => e.effectId)).size, 9);
  assert.equal(w.events[1].op, "remove"); assert.equal(w.events[2].row.version, 3);
  assert.equal(liveSnapshot(w, 2).rows.some((r) => r.id === "listing-0"), false);
  assert.equal(liveSnapshot(w, 3).rows.find((r) => r.id === "listing-0").version, 3);
  assert.equal(w.cleanupProbe.seq, 10);
  const snapshot = liveSnapshot(w, 0); snapshot.rows[0].priceCents = -1;
  assert.notEqual(w.initial[0].priceCents, -1, "snapshots do not mutate workload");
});

test("normal delivery requires equal initial work, all visible effects and observed cleanup in both groups", () => {
  for (const group of Object.keys(liveContracts)) {
    const j = journey(settingsFor("normal", group)), before = structuredClone(j);
    const result = validate(j);
    assert.equal(result.through, 9); assert.equal(result.appliedEffects, 9);
    assert.equal(result.coveredBySnapshot, 0); assert.equal(result.duplicatesSuppressed, 1);
    assert.deepEqual(result.initialWork, { reads: 1, rows: 3 }); assert.deepEqual(j, before);
    assert.ok(result.initialStateMs >= 0 && result.steadyStateMs > 0);
  }
});

for (const scenario of ["disconnect", "missed-updates", "gap"]) {
  test(`${scenario}: replay and equivalent authoritative resnapshot reach the same keyed state`, () => {
    const replay = journey(settingsFor(scenario)), resnapshot = journey(settingsFor(scenario), "resnapshot");
    const a = validate(replay), b = validate(resnapshot);
    assert.equal(a.through, b.through); assert.equal(a.appliedEffects, 9);
    assert.equal(b.appliedEffects + b.coveredBySnapshot, 9);
    assert.deepEqual(a.recoveryStrategies, ["replay"]); assert.deepEqual(b.recoveryStrategies, ["resnapshot"]);
    assert.deepEqual(find(replay, "state").rows, find(resnapshot, "state").rows);
    assert.ok(a.recoveryMs.length > 0 && b.recoveryMs.length > 0);
  });
}

test("expired cursor resnapshots and both explicit bounded slow-reader outcomes recover", () => {
  assert.deepEqual(validate(journey(settingsFor("expired-cursor"))).recoveryStrategies, ["resnapshot"]);
  for (const group of Object.keys(liveContracts)) for (const outcome of ["disconnect", "resnapshot"]) {
    const result = validate(journey(settingsFor("slow-reader", group, outcome)));
    assert.equal(result.through, 9); assert.equal(result.appliedEffects + result.coveredBySnapshot, 9);
  }
});

test("adapter normalization accepts native envelopes without Corten cursors or regex parsing", () => {
  const j = journey(settingsFor("disconnect"));
  j.capture.records = j.capture.records.map((r) => ["channel:listing", { nativePayload: JSON.stringify(r) }]);
  const before = structuredClone(j);
  const result = validate(j, (raw) => { const r = JSON.parse(raw[1].nativePayload); raw.length = 0; return r; });
  assert.equal(result.appliedEffects, 9); assert.deepEqual(j, before);
  assert.throws(() => validate(j, () => null), /not skip evidence/);
});

const badNormal = [
  ["missing initial snapshot", (j) => { j.capture.records = j.capture.records.filter((r) => r.kind !== "snapshot"); }],
  ["wrong initial rows", (j) => { find(j, "snapshot").rows.pop(); }],
  ["wrong initial materialization work", (j) => { find(j, "snapshot").work.rows = 0; }],
  ["uncharged snapshot read", (j) => { find(j, "snapshot").work.reads = 0; }],
  ["hidden extra snapshot read", (j) => { find(j, "snapshot").work.reads = 2; }],
  ["precomputed snapshot without read", (j) => { j.capture.records = j.capture.records.filter((r) => r.kind !== "snapshot-request"); }],
  ["publication before initial state", (j) => { const p = find(j, "publish"); p.at = find(j, "snapshot").at; j.capture.records.splice(j.capture.records.indexOf(p), 1); j.capture.records.splice(4, 0, p); }],
  ["duplicate application effect despite correct keyed state", (j) => { find(j, "event", (r) => r.disposition === "duplicate").effects.push("live-17-9"); }],
  ["deduplicated IDs hiding repeated effect", (j) => { find(j, "event", (r) => r.disposition === "duplicate").effectCount += 1; }],
  ["incorrect visible row", (j) => { find(j, "event").state[0].quantity += 1; }],
  ["wrong event payload", (j) => { find(j, "event").event.row.priceCents += 1; }],
  ["silently skipped event", (j) => { find(j, "event").disposition = "duplicate"; }],
  ["dropped final update", (j) => { j.capture.records = j.capture.records.filter((r) => r.kind !== "event" || r.event.seq !== 9); }],
  ["unordered application effects", (j) => { find(j, "state").effects.reverse(); }],
  ["missing publication", (j) => { j.capture.records = j.capture.records.filter((r) => r.kind !== "publish" || r.seq !== 2); }],
  ["overloaded publisher", (j) => { find(j, "publish").scheduledAt -= 100; }],
  ["unbounded queue", (j) => { find(j, "resources").queueLimit = Infinity; }],
  ["queue peak exceeds bound between samples", (j) => { find(j, "resources").queuePeak = 5; }],
  ["unbounded history", (j) => { find(j, "resources").historyLimit = null; }],
  ["history peak exceeds bound", (j) => { find(j, "resources").historyPeak = 9; }],
  ["fake cleanup flag", (j) => { const end = j.capture.records.findIndex((r) => r.kind === "detach"); j.capture.records.splice(end + 1, 0, { kind: "cleanup", at: j.capture.records[end].at, cleanedUp: true }); }],
  ["leaked subscription", (j) => { for (const r of j.capture.records.filter((r) => r.kind === "resources").slice(2)) r.subscriptions = 1; }],
  ["leaked connection", (j) => { for (const r of j.capture.records.filter((r) => r.kind === "resources").slice(2)) r.connections = 1; }],
  ["leaked lasting task", (j) => { for (const r of j.capture.records.filter((r) => r.kind === "resources").slice(2)) r.pendingTasks = 1; }],
  ["no live resource evidence", (j) => { find(j, "resources", (r) => r.connections === 1).connections = 0; }],
  ["unequal subscription work", (j) => { find(j, "resources", (r) => r.subscriptions === 1).subscriptions = 2; }],
  ["duplicate initial keys", (j) => { find(j, "snapshot").rows.push(find(j, "snapshot").rows[0]); }],
  ["missing post-detach probe", (j) => { j.capture.records = j.capture.records.filter((r) => r.kind !== "cleanup-probe"); }],
  ["too short quiescence window", (j) => { j.settings.cleanupObservationMs = 1000; }],
  ["post-detach effect", (j) => { j.capture.records.at(-1).effects.push(j.workload.cleanupProbe.effectId); }],
  ["post-detach update", (j) => { j.capture.records.at(-1).rows[0].version += 1; }],
  ["no resource observation after probe", (j) => { const probe = find(j, "cleanup-probe").at; j.capture.records = j.capture.records.filter((r) => r.kind !== "resources" || r.at < probe); }],
  ["unknown record silently ignored", (j) => { find(j, "publish").kind = "heartbeat"; }],
  ["clock reversal", (j) => { j.capture.records.at(-1).at = 0; }],
];
for (const [name, mutate] of badNormal) test(`rejects ${name}`, () => {
  const j = journey(); mutate(j); assert.throws(() => validate(j));
});

for (const delay of [0, 1000]) test(`rejects post-detach resource resurrection followed by zero ${delay}ms later`, () => {
  for (const field of ["subscriptions", "connections", "pendingTasks", "queueEvents"]) {
    const j = journey(), records = j.capture.records;
    const probeIndex = records.findIndex((r) => r.kind === "cleanup-probe");
    const resurrected = structuredClone(records[probeIndex - 1]);
    resurrected.at = records[probeIndex].at; resurrected[field] = 1;
    if (field === "queueEvents") {
      resurrected.queuePeak = 1;
      for (const r of records.slice(probeIndex)) if (r.kind === "resources") r.queuePeak = 1;
    }
    for (const r of records.slice(probeIndex)) r.at += delay;
    records.splice(probeIndex, 0, resurrected);
    assert.throws(() => validate(j), /resource resurrection/, `${field}, delayed ${delay}ms`);
  }
});

test("cleanup deadline bounds the first zero observation, not the later quiescence window", () => {
  const j = journey(), records = j.capture.records;
  const detachAt = find(j, "detach").at;
  const firstZeroIndex = records.findIndex((r) => r.kind === "resources" && r.at > detachAt);
  const shift = detachAt + j.settings.maxCleanupMs - records[firstZeroIndex].at;
  for (const r of records.slice(firstZeroIndex)) r.at += shift;
  const draining = structuredClone(find(j, "resources", (r) => r.subscriptions === 1));
  draining.at = detachAt + 1; records.splice(firstZeroIndex, 0, draining);
  const probeIndex = records.findIndex((r) => r.kind === "cleanup-probe");
  for (const r of records.slice(probeIndex)) r.at += 1000;
  assert.doesNotThrow(() => validate(j), "cleanup may drain up to its deadline and remain zero during later observation");
  for (const r of records.slice(firstZeroIndex + 1)) r.at += 1;
  assert.throws(() => validate(j), /cleanup exceeded bound/, "first zero one millisecond late must fail");
});

test("rejects delivery after current subscription or connection resources disappear", () => {
  for (const field of ["all", "subscriptions", "connections"]) {
    const j = journey(), records = j.capture.records;
    const firstEventIndex = records.findIndex((r) => r.kind === "event");
    const current = structuredClone(find(j, "resources", (r) => r.subscriptions === 1));
    current.at = records[firstEventIndex].at;
    if (field === "all") for (const k of ["subscriptions", "connections", "pendingTasks", "queueEvents"]) current[k] = 0;
    else current[field] = 0;
    records.splice(firstEventIndex, 0, current);
    assert.throws(() => validate(j), /active\/resumed subscription/, field);
  }
});

test("rejects final live state after resources disappear, not merely missing initial resource evidence", () => {
  const j = journey(), records = j.capture.records;
  const finalIndex = records.findIndex((r) => r.kind === "state");
  records.splice(finalIndex, 0, { ...structuredClone(records[0]), at: records[finalIndex].at });
  assert.throws(() => validate(j), /missing final updates\/recovery/);
});

test("rejects gaps presented as applied events, even if a later resnapshot could repair state", () => {
  const j = journey(settingsFor("gap"), "resnapshot"); find(j, "event", (r) => r.disposition === "gap").disposition = "applied";
  assert.throws(() => validate(j), /undetected.*gap/);
});

test("resnapshot is authoritative, not a merge; stale versions, wrong rows and duplicate effects fail", () => {
  for (const mutate of [
    (j, r) => { r.through = 0; },
    (j, r) => { r.rows[0].priceCents += 1; },
    (j, r) => { r.state.push({ id: "deleted-but-retained", version: 0 }); },
    (j, r) => { r.effects.push(j.workload.events[0].effectId); },
    (j, r) => { r.work.rows += 1; },
  ]) {
    const j = journey(settingsFor("disconnect"), "resnapshot");
    mutate(j, find(j, "snapshot", (r) => r.through > 0)); assert.throws(() => validate(j));
  }
  const j = journey(settingsFor("disconnect"), "resnapshot");
  const snapshot = find(j, "snapshot", (r) => r.through > 0);
  Object.assign(snapshot, liveSnapshot(j.workload, 1), { state: liveSnapshot(j.workload, 1).rows, work: { reads: 1, rows: 3 } });
  assert.throws(() => validate(j), /stale/);
});

test("scenario labels cannot claim recovery work never exercised", () => {
  for (const scenario of ["disconnect", "missed-updates", "expired-cursor", "gap", "slow-reader"]) {
    const j = journey(); j.settings.scenario = scenario; assert.throws(() => validate(j));
  }
  const j = journey(settingsFor("disconnect"), "resnapshot"); j.settings.scenario = "expired-cursor";
  assert.throws(() => validate(j), /expired cursor/);
  const gap = journey(settingsFor("gap")); gap.settings.scenario = "normal";
  assert.throws(() => validate(gap), /application-visible order/);
});

test("reconnect needs actual old-subscription cleanup and resume before receiving events", () => {
  for (const mutate of [
    (j) => { j.capture.records = j.capture.records.filter((r) => r.kind !== "resources" || r.at !== find(j, "disconnect").at + 1); },
    (j) => { j.capture.records = j.capture.records.filter((r) => r.kind !== "resume"); },
    (j) => { const at = find(j, "resume").at - 1; j.capture.records = j.capture.records.filter((r) => r.at !== at); },
    (j) => { find(j, "resume").from = 0; },
    (j) => { find(j, "resume").status = "expired"; },
    (j) => { j.settings.maxRecoveryMs = 1; },
    (j) => { j.settings.maxCleanupMs = 0.5; },
  ]) {
    const j = journey(settingsFor("disconnect")); mutate(j); assert.throws(() => validate(j));
  }
});

test("slow-reader outcome, bounded wait and replacement/reconnect cannot be omitted", () => {
  for (const mutate of [
    (j) => { delete j.settings.slowOutcome; },
    (j) => { find(j, "overflow").outcome = "drop"; },
    (j) => { j.settings.maxSlowMs = 1; },
    (j) => { j.capture.records = j.capture.records.filter((r) => r.kind !== "overflow"); },
    (j) => { const r = find(j, "resources", (r) => r.queueEvents > 0); r.queueEvents = 0; },
    (j) => { j.capture.records = j.capture.records.filter((r) => r.kind !== "snapshot" || r.through === 0); },
  ]) {
    const j = journey(settingsFor("slow-reader")); mutate(j); assert.throws(() => validate(j));
  }
});

test("invalid versions, missing reviewed settings and mutated fixtures fail closed", () => {
  for (const mutate of [
    (j) => { j.workload.schema = "live-keyed-state/v0"; },
    (j) => { j.workload.events[0].row.quantity += 1; },
    (j) => { j.capture.schema = "old-transport-messages"; },
    (j) => { j.capture.contract = liveContracts["live-delivery"]; },
    (j) => { j.settings.group = "distributed-durability"; },
    (j) => { j.settings.scenario = "process-restart"; },
    (j) => { delete j.settings.historyLimit; },
    (j) => { j.settings.maxRecoveryMs = Infinity; },
    (j) => { j.settings.queueLimit = "4"; },
  ]) {
    const j = journey(); mutate(j); assert.throws(() => validate(j));
  }
  for (const args of [{}, { seed: -1, rowCount: 3, eventCount: 9 }, { seed: 1, rowCount: 0, eventCount: 9 }, { seed: 1, rowCount: 1, eventCount: 1.5 }]) {
    assert.throws(() => createLiveWorkload(args));
  }
});
