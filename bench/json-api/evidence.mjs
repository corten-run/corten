import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { jsonCheckSchema } from "../workloads/json-check.mjs";
import { aggregate, deriveLoad, loadConfig, payloads, phases, route, sha256, upstreamReadDelta, verifyParticipants, verifyRuntime } from "./contract.mjs";

// Replay retained functional observations, not application code. In particular,
// byte forwarding can pass this gate; only a separate native audit can qualify it.
export function verifyFunctional(functional, events, profile, records) {
  return functionalVerifier(profile, records)(functional, events);
}

// Prepare immutable expected bytes once; each application's observations are
// still checked independently. Alternate JSON formatting uses structural replay.
export function functionalVerifier(profile, records) {
  const p = payloads[profile.payload], ids = Object.keys(records), first = ids[0], selected = new Set(ids);
  const recordsSha256 = sha256(JSON.stringify(records));
  const bodies = new Map(ids.map((id) => [id, JSON.stringify(records[id])])), firstRecord = JSON.parse(bodies.get(first));
  return (functional, events) => {
    assert.equal(functional.schema, jsonCheckSchema);
    assert.equal(functional.payload, profile.payload); assert.equal(functional.source, profile.source);
    assert.equal(functional.recordsSha256, recordsSha256);
    assert.equal(functional.jsonRecords, ids.length); assert.equal(functional.missing, true);
    assert.equal(functional.nativeSerializationVerified, false, "functional gate cannot assert native serialization");
    assert.equal(functional.readyForLoad, false, "functional gate cannot assert load readiness");
    assert.ok(Array.isArray(events), "raw JSON observations required");
    let next = 0;
    const take = (kind, method, path) => {
      const event = events[next++];
      assert.ok(event, "missing raw response");
      assert.equal(event.kind, kind); assert.equal(event.method, method); assert.equal(event.path, path);
      return event;
    };
    const jsonType = (e, error = false) => {
      assert.ok((error ? ["application/json", "application/problem+json"] : ["application/json"]).includes(e.type?.split(";")[0].trim().toLowerCase()), "raw response is not JSON");
    };
    const json = (e, error = false) => { jsonType(e, error); return JSON.parse(e.body); };
    const control = (value) => {
      const e = take("control", "POST", `/__${p.path}/control`);
      assert.deepEqual(e.value, value); assert.equal(e.status, 200); JSON.parse(e.body);
    };
    const counters = (requests) => {
      const e = take("control", "GET", `/__${p.path}/control`);
      assert.equal(e.status, 200); assert.deepEqual(JSON.parse(e.body).requests, requests, "raw upstream read counts differ");
    };
    const record = (id, expected = bodies.get(id)) => {
      const e = take("application", "GET", route(profile, id));
      assert.equal(e.status, 200); jsonType(e);
      if (e.body !== expected) assert.deepEqual(JSON.parse(e.body), JSON.parse(expected));
    };
    control({});
    const sweep = new Set();
    for (let i = 0; i < ids.length; i++) {
      const e = events[next], id = e?.path?.slice(`/api/${p.path}/`.length);
      assert.ok(selected.has(id) && !sweep.has(id), "missing, duplicate or wrong sweep record"); sweep.add(id);
      record(id);
    }
    if (profile.source === "api") { counters(Object.fromEntries(ids.map((id) => [id, 1]))); control({}); }
    let absent = `${first.split("_")[0]}_${ids.length + 1}`;
    while (selected.has(absent)) absent += "0";
    const missing = take("application", "GET", route(profile, absent));
    assert.equal(missing.status, 404); json(missing, true);
    if (profile.source === "api") {
      counters({ [absent]: 1 });
      for (const version of [1, 2]) {
        const changed = { ...firstRecord, title: `${firstRecord.title} JSON upstream ${version}` };
        control({ record: changed, pretty: true }); record(first, JSON.stringify(changed)); counters({ [first]: 1 });
      }
      for (const status of p.errors) {
        control({ status });
        const e = take("application", "GET", route(profile, first));
        assert.ok(e.status >= 500 && e.status < 600, "upstream error became JSON success/redirect"); json(e, true); counters({ [first]: 1 });
      }
      control({});
      assert.deepEqual(functional.upstream, { readsPerRequest: 1, completeRecordSweep: true, uncachedJson: true,
        errorStatuses: p.errors, redirectsTested: p.errors.includes(302) });
    } else { counters({}); assert.equal(functional.upstream, null); }
    assert.equal(next, events.length, "extra raw JSON observations");
    return true;
  };
}

export function verifyCold(raw, expected, options, context) {
  assert.deepEqual(raw.identity, expected, "wrong cold identity");
  verifyRuntime(raw.runtime, expected, context);
  verifyParticipants(raw, expected, context, ["upstream", "probe"]);
  const c = raw.result;
  assert.equal(c.status, 200); assert.equal(c.type, "application/json", "cold response must be JSON");
  assert.equal(c.path, route(expected), "cold probe must target the native JSON payload");
  const elapsed = Date.parse(c.first200At) - Date.parse(c.containerStartedAt);
  assert.ok(Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= options.startupTimeout * 1000);
  assert.equal(c.first200MsFromContainerStart, elapsed);
  assert.equal(c.measuredBeforeReadinessOrWarmup, true);
  for (const key of ["attempts", "bytes"]) assert.ok(Number.isSafeInteger(c[key]) && c[key] > 0, `invalid cold ${key}`);
  const reads = upstreamReadDelta(raw.upstreamReads);
  if (expected.source === "fixture") assert.equal(reads, 0, "fixture cold probe must perform zero upstream reads");
  else assert.ok(reads >= 1 && reads <= c.attempts, "cold API reads must correspond to probe attempts");
  assert.ok(Number.isFinite(c.successfulRequestMs) && c.successfulRequestMs >= 0);
  return c;
}

export function verifyRun(run, expected, options, load, tools, context) {
  assert.deepEqual(run.identity, expected, "wrong timing identity");
  assert.equal(run.complete, true, "timing run incomplete"); assert.equal(run.failed, undefined, "timing run failed");
  assert.deepEqual(Object.keys(run.phases ?? {}).sort(), [...phases].sort(), "missing/extra timing phases");
  assert.deepEqual(verifyCold(load(run.cold.raw), expected, options, context), run.cold.result, "cold summary differs from raw evidence");
  for (const phase of ["warmup", ...phases]) {
    const saved = phase === "warmup" ? run.warmup : run.phases[phase];
    assert.ok(saved, "missing timing phase");
    const raw = load(saved.raw);
    assert.deepEqual(raw.config, loadConfig(options, phase));
    assert.deepEqual(deriveLoad(raw, expected, phase, options, tools, context), saved.metrics, `${phase} metrics differ from raw evidence`);
  }
  return true;
}
export function verifyAggregates(saved, runs, asked) {
  assert.deepEqual(Object.keys(saved ?? {}).sort(), [...phases].sort(), "missing/extra aggregates");
  for (const phase of phases) {
    const derived = { ...aggregate(runs.filter((r) => r.phases?.[phase]?.metrics).map((r) => r.phases[phase].metrics)), asked };
    assert.ok(isDeepStrictEqual(saved[phase], derived), `${phase} aggregate differs from individual runs/requested passes`);
  }
}
