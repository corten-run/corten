import assert from "node:assert/strict";

export const liveStateSchema = "live-keyed-state/v1";
export const liveCaptureSchema = "live-application-capture/v1";
export const liveContracts = Object.freeze({
  "live-delivery": "live-delivery/v1",
  "recoverable-live": "recoverable-live/v1",
});

const integer = (n, name, min = 0) => assert.ok(Number.isSafeInteger(n) && n >= min, `${name}: invalid integer`);
const duration = (n, name) => assert.ok(Number.isFinite(n) && n > 0, `${name}: positive finite duration required`);
const row = (seed, key, version) => ({
  id: `listing-${key}`, version,
  priceCents: 100 + ((seed + Math.imul(version + key, 1664525)) >>> 0) % 100000,
  quantity: ((seed + version + key) >>> 0) % 31,
});
const eventAt = ({ seed, rowCount }, seq) => {
  const key = Math.floor((seq - 1) / 3) % rowCount;
  return {
    seq, effectId: `live-${seed}-${seq}`, key: `listing-${key}`,
    ...(seq % 3 === 2 ? { op: "remove" } : { op: "upsert", row: row(seed, key, seq) }),
  };
};
const keyed = (rows) => {
  assert.ok(Array.isArray(rows), "keyed rows required");
  const ids = new Set();
  for (const r of rows) {
    assert.ok(r && typeof r.id === "string" && !ids.has(r.id), "missing or duplicate row key");
    ids.add(r.id);
  }
  return [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};

// This is an application fixture, not a transport protocol. No load, window or client defaults.
export function createLiveWorkload({ seed, rowCount, eventCount }) {
  integer(seed, "seed"); assert.ok(seed <= 0xffffffff, "seed must be uint32");
  integer(rowCount, "rowCount", 1); integer(eventCount, "eventCount", 1);
  const spec = { schema: liveStateSchema, seed, rowCount, eventCount };
  return {
    ...spec, initial: Array.from({ length: rowCount }, (_, key) => row(seed, key, 0)),
    events: Array.from({ length: eventCount }, (_, i) => eventAt(spec, i + 1)),
    cleanupProbe: eventAt(spec, eventCount + 1),
  };
}

export function liveSnapshot(workload, through) {
  integer(through, "snapshot through"); assert.ok(through <= workload.eventCount, "snapshot beyond workload");
  const state = new Map(workload.initial.map((r) => [r.id, r]));
  for (const e of workload.events.slice(0, through)) {
    if (e.op === "remove") state.delete(e.key);
    else state.set(e.key, e.row);
  }
  return { through, rows: structuredClone(keyed([...state.values()])) };
}

/**
 * Validate ONE instrumented application-client journey, not adapter qualification or a load run.
 * The caller supplies reviewed group/scenario, bounds and timing tolerances separately from captures.
 * normalize(raw, index) maps native adapter captures to the records below; no SSE/WS envelope,
 * epoch or cursor spelling is imposed. It must retain receive dispositions and actual application
 * rows, cumulative effect IDs AND effectCount, snapshot read/materialization work, publication
 * acknowledgements, and instrumented resource counters/peaks. Do not derive observations with
 * liveSnapshot or synthesize missing evidence. Tests use synthetic traces, not operational adapters.
 *
 * Every record has monotonic `at` in one clock domain. `publish` has seq, scheduledAt, startedAt;
 * `snapshot-request` fences an authoritative read; `snapshot` has through, rows (response),
 * state (application), effects, effectCount, work:{reads,rows}. `event` has event, disposition
 * (applied/duplicate/gap), state, effects, effectCount. `state` has through, rows, effects,
 * effectCount. Snapshots REPLACE state and cover updates, but do not invoke per-event effects.
 * `resume` has from and status (accepted/expired). `disconnect` has reason (forced/slow-reader).
 * `slow` then `overflow` names the reviewed disconnect/resnapshot outcome, not silent loss.
 * `resources` has subscriptions, connections, pendingTasks, queueLimit/Events/Peak and
 * historyLimit/Events/Peak, attributable to the journey; peaks are cumulative instrumentation,
 * not merely sampled maxima. A slow overflow needs an observed saturated queue while the
 * reader is held. Shared retained history may remain bounded after detach.
 * `detach`, then `cleanup-probe` (acknowledged workload.cleanupProbe), zero owned resources and
 * an unchanged `state` after cleanupObservationMs prove quiescence. `cleanup:true` proves nothing.
 * Cleanup must complete within maxCleanupMs and stay zero until an explicit reattach.
 * Delivery and final live state require a currently observed subscription and connection.
 *
 * Runner hooks still own browser execution, complete buffer/store/process inventory, continuous
 * peak instrumentation, provenance and measured CPU/memory/bytes/latency/setup/recovery costs.
 * This contract makes no auth, multi-node or process-restart durability claim.
 */
export function validateLiveCapture(workload, capture, settings, normalize = (record) => record) {
  assert.deepEqual(workload, createLiveWorkload(workload), "workload must match versioned deterministic fixture");
  const { group, scenario } = settings;
  assert.ok(Object.hasOwn(liveContracts, group), "unknown live group");
  const scenarios = group === "live-delivery" ? ["normal", "slow-reader"]
    : ["normal", "disconnect", "missed-updates", "expired-cursor", "gap", "slow-reader"];
  assert.ok(scenarios.includes(scenario), "unknown live scenario");
  integer(settings.queueLimit, "queueLimit"); integer(settings.historyLimit, "historyLimit");
  for (const k of ["maxRecoveryMs", "maxCleanupMs", "cleanupObservationMs", "maxSlowMs", "maxPublishLagMs"]) duration(settings[k], k);
  if (scenario === "slow-reader") assert.ok(["disconnect", "resnapshot"].includes(settings.slowOutcome), "explicit slow-client outcome required");
  assert.equal(capture.schema, liveCaptureSchema); assert.equal(capture.contract, liveContracts[group]);
  assert.ok(Array.isArray(capture.records) && capture.records.length > 0, "capture records required");
  assert.equal(typeof normalize, "function");

  let published = 0, through = 0, attached = false, initialized = false, detached = false;
  let lastAt = -1, request = null, recovery = null, mustSnapshot = false, release = null;
  let resources = null, resourceAt = -1, queuePeak = 0, historyPeak = 0;
  let initialStartedAt = null, initialFinishedAt = null, finalAt = null, probeAt = null;
  let slow = null, overflows = 0, disconnects = 0, resumes = 0, expired = 0, missed = 0;
  let snapshots = 0, covered = 0, duplicates = 0, gaps = 0, checkedFinal = false, quiescent = false;
  const effects = [], strategies = new Set(), recoveryMs = [];
  let expectedState = new Map(workload.initial.map((r) => [r.id, r]));
  const state = () => keyed([...expectedState.values()]);
  const application = (r, rows = r.state) => {
    assert.deepEqual(keyed(rows), state(), "wrong application keyed state (snapshot must replace, not merge)");
    assert.deepEqual(r.effects, effects, "duplicate, missing or out-of-order application effects");
    assert.equal(r.effectCount, effects.length, "wrong application effect count");
  };
  const released = () => resources && resources.subscriptions === 0 && resources.connections === 0
    && resources.pendingTasks === 0 && resources.queueEvents === 0;
  const cleanupComplete = () => !release || release.complete;
  const liveResources = () => attached && resources?.subscriptions === 1 && resources.connections > 0;
  const recovered = (at, strategy) => {
    if (recovery && through === published && through > recovery.from && !mustSnapshot) {
      assert.ok(at - recovery.at <= settings.maxRecoveryMs, "recovery exceeded bound");
      recoveryMs.push(at - recovery.at); strategies.add(strategy); recovery = null;
    }
  };
  const startRecovery = (at) => { recovery ??= { at, from: through }; };

  for (const [index, raw] of capture.records.entries()) {
    // A normalizer receives a copy, never the saved raw evidence or the reference fixture.
    const r = normalize(structuredClone(raw), index);
    assert.ok(r && typeof r === "object" && !Array.isArray(r), "normalizer must return a record, not skip evidence");
    assert.ok(Number.isFinite(r.at) && r.at >= 0 && r.at >= lastAt, "invalid capture clock/order");
    lastAt = r.at;
    if (!cleanupComplete()) assert.ok(r.at - release.at <= settings.maxCleanupMs, "cleanup exceeded bound");
    if (index === 0) assert.equal(r.kind, "resources", "baseline resources required");
    switch (r.kind) {
      case "resources": {
        for (const k of ["subscriptions", "connections", "pendingTasks", "queueEvents", "queuePeak", "historyEvents", "historyPeak"]) integer(r[k], k);
        assert.equal(r.queueLimit, settings.queueLimit, "queue must have reviewed finite bound");
        assert.equal(r.historyLimit, settings.historyLimit, "history must have reviewed finite bound");
        assert.ok(r.queueEvents <= r.queuePeak && r.queuePeak <= r.queueLimit && r.queuePeak >= queuePeak, "unbounded queue or invalid peak");
        assert.ok(r.historyEvents <= r.historyPeak && r.historyPeak <= r.historyLimit && r.historyPeak >= historyPeak, "unbounded history or invalid peak");
        assert.ok(r.subscriptions <= 1, "one application journey must own exactly one subscription");
        resources = r; resourceAt = r.at; queuePeak = r.queuePeak; historyPeak = r.historyPeak;
        if (index === 0) assert.ok(released(), "nonzero owned baseline resources");
        if (release?.complete) assert.ok(released(), "resource resurrection after completed cleanup");
        if (release && released()) release.complete = true;
        break;
      }
      case "attach":
        assert.ok(!attached && !detached && cleanupComplete() && released(), "old subscription not cleaned before attach");
        attached = true; release = null;
        break;
      case "snapshot-request":
        assert.ok(attached && !request && !detached && (!initialized || recovery), "unexpected snapshot read");
        request = { at: r.at, fence: published };
        initialStartedAt ??= r.at;
        break;
      case "snapshot": {
        assert.ok(attached && request && !detached, "snapshot without active read");
        integer(r.through, "snapshot through");
        assert.ok(r.through >= request.fence && r.through >= through && r.through <= published, "stale or future snapshot");
        if (!initialized) assert.equal(r.through, 0, "wrong initial state/version");
        const expected = liveSnapshot(workload, r.through);
        assert.deepEqual(keyed(r.rows), expected.rows, "wrong authoritative snapshot");
        assert.deepEqual(r.work, { reads: 1, rows: expected.rows.length }, "wrong initial/recovery snapshot work");
        covered += r.through - through; through = r.through; snapshots += 1; mustSnapshot = false;
        expectedState = new Map(expected.rows.map((r) => [r.id, r]));
        application(r); request = null;
        if (!initialized) { initialized = true; initialFinishedAt = r.at; }
        else strategies.add("resnapshot");
        recovered(r.at, "resnapshot");
        break;
      }
      case "publish":
        assert.ok(initialized && !detached && published < workload.eventCount, "publication outside steady-state work");
        assert.equal(r.seq, published + 1, "missing, duplicated or unordered publication");
        assert.ok(Number.isFinite(r.scheduledAt) && Number.isFinite(r.startedAt) && r.scheduledAt >= initialFinishedAt
          && r.startedAt >= r.scheduledAt && r.at >= r.startedAt && r.at - r.scheduledAt <= settings.maxPublishLagMs,
        "publisher/load generator overloaded or invalid timing");
        published += 1; if (!attached) missed += 1;
        break;
      case "event": {
        assert.ok(initialized && liveResources() && !detached && !request && resumes === disconnects, "event outside active/resumed subscription");
        integer(r.event?.seq, "event seq", 1);
        assert.ok(r.event.seq <= published, "event precedes publication");
        assert.deepEqual(r.event, workload.events[r.event.seq - 1], "wrong normalized application event");
        if (r.event.seq <= through) {
          assert.equal(r.disposition, "duplicate", "duplicate event must not apply an effect"); duplicates += 1;
        } else if (r.event.seq > through + 1) {
          assert.equal(r.disposition, "gap", "undetected application sequence gap"); gaps += 1; startRecovery(r.at);
        } else {
          assert.ok(!mustSnapshot, "expired cursor/overflow requires authoritative resnapshot");
          assert.equal(r.disposition, "applied", "silently skipped event");
          through += 1; effects.push(r.event.effectId);
          if (r.event.op === "remove") expectedState.delete(r.event.key);
          else expectedState.set(r.event.key, r.event.row);
          recovered(r.at, "replay");
        }
        application(r);
        break;
      }
      case "disconnect":
        assert.ok(initialized && attached && !detached && !request && scenario !== "normal", "unexpected disconnect");
        assert.ok(["forced", "slow-reader"].includes(r.reason), "disconnect reason required");
        if (r.reason === "slow-reader") assert.ok(overflows > 0 && settings.slowOutcome === "disconnect", "missing slow-client outcome");
        if (slow && overflows && settings.slowOutcome === "disconnect") assert.equal(r.reason, "slow-reader", "overflow must cause observed slow-reader disconnect");
        attached = false; disconnects += 1; release = { at: r.at, complete: false }; startRecovery(r.at);
        break;
      case "resume":
        assert.ok(attached && recovery && disconnects > resumes, "resume without disconnect/reconnect");
        assert.equal(r.from, through, "resume must use last application version");
        assert.ok(["accepted", "expired"].includes(r.status), "cursor result required");
        resumes += 1; if (r.status === "expired") { mustSnapshot = true; expired += 1; }
        break;
      case "slow":
        assert.ok(scenario === "slow-reader" && initialized && attached && !slow, "unexpected slow-reader probe");
        slow = { at: r.at, published };
        break;
      case "overflow":
        assert.ok(slow && !overflows && attached && published > slow.published, "slow reader not exercised");
        assert.equal(r.outcome, settings.slowOutcome, "wrong bounded slow-client outcome");
        assert.ok(r.at - slow.at <= settings.maxSlowMs, "unbounded slow-reader wait");
        assert.ok(resourceAt >= slow.at && resources.queueEvents === settings.queueLimit
          && resources.subscriptions === 1 && resources.connections > 0, "overflow needs observed queue saturation, not a label");
        overflows += 1; startRecovery(slow.at);
        mustSnapshot = r.outcome === "resnapshot";
        break;
      case "state":
        assert.ok(initialized && !request, "state without completed snapshot");
        assert.equal(r.through, through, "wrong visible application version"); application(r, r.rows);
        if (!detached) {
          assert.ok(liveResources() && resumes === disconnects && !recovery
            && through === workload.eventCount && published === through, "missing final updates/recovery");
          checkedFinal = true; finalAt = r.at;
        } else {
          assert.ok(probeAt !== null && r.at - probeAt >= settings.cleanupObservationMs, "missing post-detach observation window");
          assert.ok(cleanupComplete() && released() && resourceAt >= probeAt, "fake cleanup: missing zero resource evidence after probe");
          quiescent = true;
        }
        break;
      case "detach":
        assert.ok(checkedFinal && attached && !detached && !request && !recovery, "detach before final state");
        detached = true; attached = false; release = { at: r.at, complete: false };
        break;
      case "cleanup-probe":
        assert.ok(detached && probeAt === null, "cleanup probe must follow final detach");
        assert.deepEqual(r.event, workload.cleanupProbe, "wrong acknowledged cleanup publication");
        probeAt = r.at;
        break;
      default: assert.fail(`unknown capture record: ${r.kind}`);
    }
  }
  assert.ok(initialized && checkedFinal && quiescent && detached && cleanupComplete() && released(), "incomplete live journey or cleanup");
  assert.ok(!request && !recovery && !mustSnapshot, "unfinished recovery");
  if (["disconnect", "missed-updates", "expired-cursor"].includes(scenario)) {
    assert.ok(disconnects > 0 && resumes === disconnects && missed > 0, "missing disconnect, missed updates or reconnect evidence");
  }
  if (scenario === "expired-cursor") assert.ok(expired > 0 && strategies.has("resnapshot") && snapshots > 1, "expired cursor requires resnapshot");
  if (scenario === "gap") assert.ok(gaps > 0, "gap scenario did not exercise detection");
  if (scenario === "normal") {
    assert.equal(snapshots, 1, "normal delivery must not hide loss with snapshots");
    assert.equal(gaps, 0, "normal delivery must preserve application-visible order");
  }
  if (scenario === "slow-reader") {
    assert.equal(overflows, 1, "explicit bounded slow-client outcome missing");
    if (settings.slowOutcome === "disconnect") assert.ok(disconnects > 0 && resumes === disconnects, "overflow did not disconnect and reconnect");
  }
  return {
    schema: liveCaptureSchema, contract: liveContracts[group], scenario,
    published, through, initialWork: { reads: 1, rows: workload.rowCount },
    appliedEffects: effects.length, coveredBySnapshot: covered, duplicatesSuppressed: duplicates,
    detectedGaps: gaps, snapshots, recoveryStrategies: [...strategies].sort(), recoveryMs,
    queuePeak, historyPeak, initialStateMs: initialFinishedAt - initialStartedAt,
    steadyStateMs: finalAt - initialFinishedAt,
  };
}
