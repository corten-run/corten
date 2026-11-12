// Synthetic test evidence only. Never imported by the runner or report.
import { aggregate, cpuSettings, descriptor, deriveLoad, identity, imageLabels, k6Image, loadConfig, nodeImage, parseArgs, participantReceipt, payloads, phases, receiptSchema, route, runtimeContext, runtimeReceipt, schema, sha256, timingPlan } from "./contract.mjs";
import { jsonCheckSchema } from "../workloads/json-check.mjs";

export function observations(profile, records) {
  const p = payloads[profile.payload], ids = Object.keys(records), first = ids[0], events = [];
  const app = (id, record, status = 200) => events.push({ kind: "application", method: "GET", path: route(profile, id), status, type: "application/json", body: JSON.stringify(record) });
  const control = (value) => events.push({ kind: "control", method: "POST", path: `/__${p.path}/control`, value, status: 200, body: "{}" });
  const counters = (requests) => events.push({ kind: "control", method: "GET", path: `/__${p.path}/control`, status: 200, type: "application/json", body: JSON.stringify({ requests }) });
  control({});
  for (const id of ids) app(id, records[id]);
  if (profile.source === "api") { counters(Object.fromEntries(ids.map((id) => [id, 1]))); control({}); }
  const absent = `${first.split("_")[0]}_${ids.length + 1}`; app(absent, {}, 404);
  if (profile.source === "api") {
    counters({ [absent]: 1 });
    for (const version of [1, 2]) {
      const record = { ...records[first], title: `${records[first].title} JSON upstream ${version}` };
      control({ record, pretty: true }); app(first, record); counters({ [first]: 1 });
    }
    for (const status of p.errors) { control({ status }); app(first, {}, 502); counters({ [first]: 1 }); }
    control({});
  } else counters({});
  return events;
}
export function functional(profile, records) {
  const p = payloads[profile.payload];
  return { schema: jsonCheckSchema, payload: profile.payload, source: profile.source, recordsSha256: sha256(JSON.stringify(records)),
    jsonRecords: Object.keys(records).length, missing: true, nativeSerializationVerified: false, readyForLoad: false,
    upstream: profile.source === "api" ? { readsPerRequest: 1, completeRecordSweep: true, uncachedJson: true, errorStatuses: p.errors, redirectsTested: p.errors.includes(302) } : null };
}
export function k6Summary(count, seconds) {
  return { root_group: { checks: Object.fromEntries(["JSON status 200", "JSON content type"].map((key) => [key, { passes: count, fails: 0 }])) },
    metrics: { http_reqs: { values: { count, rate: count / seconds } },
    http_req_duration: { values: { avg: 2, "p(50)": 1, "p(95)": 2, "p(99)": 3, max: 4 } },
    http_req_failed: { values: { rate: 0 } }, checks: { values: { passes: count * 2, fails: 0 } }, dropped_iterations: { values: { count: 0 } } } };
}
export function runtimeInfo(expected, context, role = "app") {
  const p = payloads[expected.payload], budget = expected.cpus[role === "app" ? "app" : role === "upstream" ? "api" : "load"];
  const mount = (Source, Destination) => ({ Type: "bind", Source, Destination, RW: false });
  const names = { app: "app", upstream: `${p.path}-api`, load: "k6", probe: "app-probe" };
  return { Id: ({ app: "e", upstream: "f", load: "1", probe: "2" })[role].repeat(64), Name: `/${context.runId}-${names[role]}`,
    Image: role === "app" ? expected.imageId : role === "load" ? context.k6ImageId : context.nodeImageId,
    Config: { Labels: { "run.corten.json-api": context.runId }, Env: role === "app" ? [`${p.path.toUpperCase()}_SOURCE=${expected.source}`,
      `${p.path.toUpperCase()}_FIXTURE_PATH=/fixtures/${p.path}.json`, `API_BASE=${context.apiBase}`, "PROFILE="]
      : role === "load" ? [`BASE=http://${context.runId}-app:8080`, `PAYLOAD=${expected.payload}`, `DURATION=${context.load.seconds}s`,
        `MODE=${context.load.mode}`, `RATE=${context.load.rate}`, `VUS=${context.load.vus}`] : [],
      Cmd: role === "upstream" ? ["node", `/bench/${p.path}/upstream.mjs`] : role === "load" ? ["run", "--quiet", "--summary-export", "/tmp/json-summary.json", "/bench/json-api/load.js"]
        : role === "probe" ? ["node", "/bench/json-api/cold.mjs", `http://${context.runId}-app:8080`, route(expected), String(context.startupTimeout)] : [] },
    NetworkSettings: { Networks: { [context.network]: {} } },
    HostConfig: { Memory: role === "app" ? 2 ** 30 : role === "upstream" ? 512 * 2 ** 20 : role === "probe" ? 256 * 2 ** 20 : 2 ** 31,
      NanoCpus: budget.quota * 1e9, CpusetCpus: budget.cpuset ?? "" },
    Mounts: [...(["app", "upstream"].includes(role) ? [mount(context.fixtureSource, "/fixtures")] : []), ...(role !== "app" ? [mount(`${context.checkout}/bench`, "/bench")] : [])] };
}
export const runtime = (expected, context) => runtimeReceipt(runtimeInfo(expected, context), expected, context);
const participants = (expected, context, roles) => Object.fromEntries(roles.map((role) => [role, participantReceipt(runtimeInfo(expected, context, role), expected, context, role)]));
export function result() {
  const group = descriptor(), options = parseArgs(["j1", "--group", "json-api", "--passes", "1"]), artifacts = new Map();
  let serial = 0;
  const put = (value) => { const path = `test-${serial++}.json`, bytes = JSON.stringify(value); artifacts.set(path, bytes); return { path, sha256: sha256(bytes) }; };
  const load = (ref) => { if (!ref || !artifacts.has(ref.path)) throw new Error("raw artifact missing"); const bytes = artifacts.get(ref.path); if (sha256(bytes) !== ref.sha256) throw new Error("raw digest differs"); return JSON.parse(bytes); };
  const s = { schema, group, options, timingPlan: timingPlan(options), round: "j1", commit: "a".repeat(40), commitAfter: "a".repeat(40), dirty: false, dirtyAfter: false,
    complete: true, checksPassed: true, failures: [], cleanupFailures: [], startedAt: "2026-11-12T10:00:00Z", finishedAt: "2026-11-12T11:00:00Z",
    measurement: { cpus: cpuSettings({}), encoding: "identity", fixedRate: 150, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20,
      loadMemoryBytes: 2 ** 31, nativeProfile: group.nativeProfile, phases: ["warmup", ...phases] },
    runId: "json-api-j1-0123456789", host: { checkout: "/synthetic/checkout" },
    tools: { node: { image: nodeImage, imageId: `sha256:${"c".repeat(64)}` }, k6: { image: k6Image, imageId: `sha256:${"d".repeat(64)}` } }, fixtures: {}, apps: {} };
  const records = Object.fromEntries(Object.entries(payloads).map(([key, p]) => [key, p.records()]));
  const raw = Object.fromEntries(group.cases.map((p) => [p.key, observations(p, records[p.payload])]));
  for (const payload of group.payloads) s.fixtures[payload] = put(records[payload]);
  for (const app of group.apps) {
    const entry = s.apps[app] = { images: {}, checks: {}, runs: {}, aggregates: {} };
    for (const payload of group.payloads) entry.images[payload] = { imageId: `sha256:${sha256(app + payload)}`, labels: imageLabels(s.commit, false, app, payload) };
    for (const profile of group.cases) {
      const prefix = app === "corten" ? `bench/${payloads[profile.payload].path}/corten` : `bench/fullstack/apps/${app}`;
      const expected = identity(s, app, profile), context = runtimeContext(s, profile), files = { [`${prefix}/source.test`]: "synthetic audited test source" };
      const receipt = { schema: receiptSchema, identity: expected, auditor: "test-only independent auditor", auditedAt: s.startedAt, findings: [],
        verified: { typedCompleteRecord: true, nativeSerialization: true, noOutputCache: true, noJsonPassthrough: true,
          fixtureParsedAtStartup: true, requestTimeFetchParse: true, upstreamErrors: true }, sourceFiles: Object.entries(files).map(([path, body]) => ({ path, sha256: sha256(body) })) };
      entry.checks[profile.key] = { identity: expected, functional: functional(profile, records[profile.payload]),
        raw: put({ identity: expected, runtime: runtime(expected, context), participants: participants(expected, context, ["upstream"]), events: raw[profile.key] }), native: put({ receipt, files }), nativeSerializationVerified: true, nativeSourceVerified: true };
      const runExpected = { ...expected, pass: 1 }, cold = { path: route(profile), first200At: "2026-11-12T10:00:00.200Z", containerStartedAt: "2026-11-12T10:00:00.000Z",
        first200MsFromContainerStart: 200, attempts: 2, bytes: 1000, successfulRequestMs: 2, type: "application/json", status: 200, measuredBeforeReadinessOrWarmup: true };
      const run = { pass: 1, identity: runExpected, complete: true, cold: { result: cold, raw: put({ identity: runExpected, runtime: runtime(runExpected, context),
        upstreamReads: { before: {}, after: profile.source === "api" ? { [payloads[profile.payload].first]: 1 } : {} },
        participants: participants(expected, context, ["upstream", "probe"]), result: cold }) }, phases: {} };
      for (const phase of ["warmup", ...phases]) {
        const roles = profile.source === "api" ? ["app", "upstream"] : ["app"];
        const config = loadConfig(options, phase), count = config.seconds * (phase === "fixed" ? options.rate : 100), k6DurationMs = config.seconds * 1000 + 50;
        const start = Date.parse(s.startedAt), end = start + k6DurationMs + 1000;
        const samples = Array.from({ length: config.seconds }, (_, i) => ({ cpu: 99, mem: 8, t: start + i * 1000 + 1000 }));
        const data = { identity: runExpected, runtime: runtime(runExpected, context), participants: participants(expected, { ...context, load: config }, ["upstream", "load"]), tools: { nodeImageId: s.tools.node.imageId, k6ImageId: s.tools.k6.imageId }, phase, config, k6: k6Summary(count, k6DurationMs / 1000),
          clock: { startedAt: s.startedAt, finishedAt: new Date(end).toISOString(), k6DurationMs },
          counters: Object.fromEntries(roles.map((role) => [role, { before: 1000000, after: 6000000 }])),
          samples: Object.fromEntries(roles.map((role) => [role, structuredClone(samples)])),
          upstreamReads: { before: {}, after: profile.source === "api" ? { [payloads[profile.payload].first]: count } : {} } };
        const saved = { metrics: deriveLoad(data, runExpected, phase, options, s.tools, context), raw: put(data) };
        if (phase === "warmup") run.warmup = saved; else run.phases[phase] = saved;
      }
      entry.runs[profile.key] = [run];
      entry.aggregates[profile.key] = Object.fromEntries(phases.map((p) => [p, { ...aggregate([run.phases[p].metrics]), asked: 1 }]));
    }
  }
  return { summary: s, artifacts, load, put };
}
