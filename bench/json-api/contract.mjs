import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { allApps } from "../fullstack/inventory.mjs";
import { contractSha256, definition, registrySchema, selectedApps } from "../workloads/registry.mjs";
import { aggregate, cpuSettings as catalogCpus, phases, readLoad } from "../catalog/contract.mjs";
import { records as catalogRecords } from "../catalog/fixtures.mjs";
import { records as marketplaceRecords } from "../marketplace/fixtures.mjs";
import { summarizeSamples } from "../catalog/stats.mjs";

export { aggregate, phases };
export const schema = "json-api-results/v1";
export const receiptSchema = "json-api-native-audit/v1";
export const nodeImage = "node:24-bookworm-slim";
export const k6Image = "grafana/k6@sha256:3e4186aea62e11a45560bfc51e19eeafe82fc07ce069c78aff44b7ff893d9a5e";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const payloads = Object.freeze({
  "catalog-v1": { path: "catalog", first: "record_1", fixture: "bench/catalog/fixtures/catalog.json", records: catalogRecords, errors: [503] },
  "marketplace-v2": { path: "marketplace", first: "item_1", fixture: "bench/marketplace/fixtures/marketplace.json", records: marketplaceRecords, errors: [302, 503] },
});
export function descriptor() {
  const group = "json-api";
  return { schema: "json-api-group/v1", registrySchema, group, contractSha256: contractSha256(group),
    apps: selectedApps(group), cases: structuredClone(definition(group).cases), targets: ["json"],
    payloads: Object.keys(payloads), sources: ["fixture", "api"], nativeProfile: "framework-default", encoding: "identity" };
}
export function parseArgs(args) {
  const [round, ...rest] = args;
  assert.match(round ?? "", /^j[1-9]\d*$/, "JSON rounds must be jN, without padding");
  const options = { round, group: null, apps: descriptor().apps, build: false, checkOnly: false, receipts: null,
    passes: 3, duration: 60, warmup: 30, rate: 150, startupTimeout: 120 };
  const numeric = { "--passes": ["passes", 1, 5], "--duration": ["duration", 1, 300], "--warmup": ["warmup", 1, 120],
    "--rate": ["rate", 1, 10000], "--startup-timeout": ["startupTimeout", 1, 300] };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]; assert.ok(!seen.has(flag), `duplicate option ${flag}`); seen.add(flag);
    if (flag === "--build") options.build = true;
    else if (flag === "--check-only") options.checkOnly = true;
    else if (flag === "--group") { options.group = rest[++i]; assert.equal(options.group, "json-api", "only --group json-api is supported"); }
    else if (flag === "--receipts") { options.receipts = rest[++i]; assert.ok(options.receipts && !options.receipts.startsWith("--"), "--receipts needs an audited receipt bundle path"); }
    else if (numeric[flag]) {
      const [key, min, max] = numeric[flag], value = rest[++i], n = Number(value);
      assert.ok(/^\d+$/.test(value ?? "") && Number.isSafeInteger(n) && n >= min && n <= max, `${flag} must be ${min}..${max}`);
      options[key] = n;
    } else throw new Error(`unknown option ${flag}; app subsets/substitutions are not supported`);
  }
  assert.equal(options.group, "json-api", "explicit --group json-api is required");
  assert.ok(options.passes % 2 === 1, "--passes must be 1, 3 or 5");
  assert.ok(options.apps.every((app) => Object.hasOwn(allApps, app)), "every registry member needs its own native inventory entry");
  return options;
}
export function cpuSettings(env) {
  return catalogCpus(Object.fromEntries(["APP", "LOAD", "API"].map((role) => [`CATALOG_${role}_CPUS`, env[`JSON_API_${role}_CPUS`]])));
}
export const route = (profile, id = payloads[profile.payload].first) => `/api/${payloads[profile.payload].path}/${id}`;
export function timingPlan(options) {
  assert.deepEqual(options.apps, descriptor().apps, "exact registry selection required");
  assert.ok([1, 3, 5].includes(options.passes), "invalid timing pass count");
  // Same across-pass rotation as the native marketplace pass plan. Profiles stay
  // explicit and in registry order; only the app order within each pass rotates.
  return Array.from({ length: options.passes }, (_, i) => i + 1).flatMap((pass) => {
    const offset = Math.floor((pass - 1) * options.apps.length / options.passes);
    const apps = options.apps.slice(offset).concat(options.apps.slice(0, offset));
    return descriptor().cases.flatMap((profile) => apps.map((app) => ({ app, pass, profile, stages: ["cold", "warmup", ...phases] })));
  });
}
export function identity(summary, app, profile) {
  return { app, ...profile, commit: summary.commit, imageId: summary.apps[app].images[profile.payload]?.imageId ?? null,
    contractSha256: summary.group.contractSha256, cpus: summary.measurement.cpus, nativeProfile: summary.group.nativeProfile };
}
export function buildPlan(app, payload) {
  assert.ok(descriptor().apps.includes(app) && Object.hasOwn(payloads, payload), "unknown native build");
  const context = app === "corten" ? "." : `bench/fullstack/apps/${app}`;
  return { context, dockerfile: app === "corten" ? `bench/${payloads[payload].path}/corten/Dockerfile` : `${context}/Dockerfile`,
    image: `cb-json-api-${payload}-${app}`, app, payload };
}
export function imageLabels(commit, dirty, app, payload) {
  return { "run.corten.json-api.commit": commit, "run.corten.json-api.dirty": String(dirty),
    "run.corten.json-api.contract": descriptor().contractSha256, "run.corten.json-api.app": app,
    "run.corten.json-api.payload": payload, "run.corten.json-api.profile": descriptor().nativeProfile };
}
export function verifyImage(image, commit, app, payload) {
  assert.match(image?.imageId ?? "", /^sha256:[0-9a-f]{64}$/, "missing immutable native image identity");
  assert.deepEqual(image.labels, imageLabels(commit, false, app, payload), "native image build provenance differs or is dirty");
}
export function appArgs({ name, profile, imageId, network, upstream, fixtures, cpus }) {
  const p = payloads[profile.payload], prefix = p.path.toUpperCase();
  return ["--network", network, ...cpus.app.args, "--memory", "1g", "-p", "127.0.0.1::8080",
    "-v", `${fixtures}:/fixtures:ro`, "-e", `${prefix}_SOURCE=${profile.source}`, "-e", `${prefix}_FIXTURE_PATH=/fixtures/${p.path}.json`,
    "-e", `API_BASE=${upstream}`, "-e", "PROFILE=", "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`, imageId];
}
export function runtimeContext(summary, profile) {
  const checkout = summary.host?.checkout;
  assert.ok(typeof checkout === "string" && /^(?:\/|[A-Za-z]:\/)/.test(checkout) && !checkout.endsWith("/"), "missing absolute runtime checkout");
  assert.match(summary.runId ?? "", new RegExp(`^json-api-${summary.round}-[a-f0-9]{10}$`), "missing runtime run identity");
  const p = payloads[profile.payload];
  return { checkout, runId: summary.runId, network: `${summary.runId}-net`, fixtureSource: `${checkout}/${p.fixture.slice(0, p.fixture.lastIndexOf("/"))}`,
    apiBase: `http://${summary.runId}-${p.path}-api:8080`, startupTimeout: summary.options.startupTimeout,
    nodeImageId: summary.tools?.node?.imageId, k6ImageId: summary.tools?.k6?.imageId };
}
function observedConfiguration(info, expected, context, role) {
  assert.ok(context?.fixtureSource && context?.apiBase && context?.network, "owned runtime context required");
  const env = {};
  for (const item of info.Config?.Env ?? []) {
    const at = item.indexOf("="), key = item.slice(0, at);
    const keys = role === "load" ? ["BASE", "PAYLOAD", "DURATION", "MODE", "RATE", "VUS"]
      : [`${payloads[expected.payload].path.toUpperCase()}_SOURCE`, `${payloads[expected.payload].path.toUpperCase()}_FIXTURE_PATH`, "API_BASE", "PROFILE"];
    if (keys.includes(key)) {
      assert.ok(!Object.hasOwn(env, key), "duplicate runtime environment key"); env[key] = item.slice(at + 1);
    }
  }
  const mounts = (info.Mounts ?? []).map((m) => ({ type: m.Type, source: m.Source?.replaceAll("\\", "/"), destination: m.Destination, writable: m.RW }))
    .sort((a, b) => a.destination.localeCompare(b.destination));
  return { name: info.Name, network: Object.keys(info.NetworkSettings?.Networks ?? {}).sort(),
    owner: info.Config?.Labels?.["run.corten.json-api"], mounts, ...(["app", "load"].includes(role) ? { env } : {}),
    ...(role !== "app" ? { command: info.Config?.Cmd } : {}) };
}
function expectedConfiguration(expected, context, role) {
  assert.ok(context?.fixtureSource && context?.apiBase && context?.network, "owned runtime context required");
  const p = payloads[expected.payload], prefix = p.path.toUpperCase();
  const mount = (source, destination) => ({ type: "bind", source, destination, writable: false });
  const names = { app: `${context.runId}-app`, upstream: `${context.runId}-${p.path}-api`, load: `${context.runId}-k6`, probe: `${context.runId}-app-probe` };
  return { name: `/${names[role]}`, network: [context.network], owner: context.runId,
    mounts: role === "app" ? [mount(context.fixtureSource, "/fixtures")]
      : [...(role === "upstream" ? [mount(context.fixtureSource, "/fixtures")] : []), mount(`${context.checkout}/bench`, "/bench")].sort((a, b) => a.destination.localeCompare(b.destination)),
    ...(role === "app" ? { env: { [`${prefix}_SOURCE`]: expected.source, [`${prefix}_FIXTURE_PATH`]: `/fixtures/${p.path}.json`, API_BASE: context.apiBase, PROFILE: "" } }
      : role === "load" ? { env: { BASE: `http://${context.runId}-app:8080`, PAYLOAD: expected.payload, DURATION: `${context.load.seconds}s`,
        MODE: context.load.mode, RATE: String(context.load.rate), VUS: String(context.load.vus) } } : {}),
    ...(role === "upstream" ? { command: ["node", `/bench/${p.path}/upstream.mjs`] }
      : role === "probe" ? { command: ["node", "/bench/json-api/cold.mjs", `http://${context.runId}-app:8080`, route(expected), String(context.startupTimeout)] }
      : role === "load" ? { command: ["run", "--quiet", "--summary-export", "/tmp/json-summary.json", "/bench/json-api/load.js"] } : {}) };
}
export function runtimeReceipt(info, expected, context) {
  const observed = { containerId: info.Id, imageId: info.Image, source: expected.source, payload: expected.payload,
    memoryBytes: info.HostConfig?.Memory, quota: info.HostConfig?.NanoCpus / 1e9, cpuset: info.HostConfig?.CpusetCpus || null,
    configuration: observedConfiguration(info, expected, context, "app") };
  verifyRuntime(observed, expected, context); return observed;
}
export function verifyRuntime(observed, expected, context) {
  assert.match(observed?.containerId ?? "", /^[0-9a-f]{64}$/, "missing runtime container identity");
  assert.deepEqual(observed, { containerId: observed.containerId, imageId: expected.imageId, source: expected.source, payload: expected.payload,
    memoryBytes: 2 ** 30, quota: expected.cpus.app.quota, cpuset: expected.cpus.app.cpuset,
    configuration: expectedConfiguration(expected, context, "app") }, "runtime source/image/CPU/memory/mount/profile/routing differs");
}
export function participantReceipt(info, expected, context, role) {
  const observed = { role, containerId: info.Id, imageId: info.Image, memoryBytes: info.HostConfig?.Memory,
    quota: info.HostConfig?.NanoCpus / 1e9, cpuset: info.HostConfig?.CpusetCpus || null, configuration: observedConfiguration(info, expected, context, role) };
  verifyParticipant(observed, expected, context, role); return observed;
}
function verifyParticipant(observed, expected, context, role) {
  assert.ok(["upstream", "load", "probe"].includes(role), "unknown participating runtime role");
  assert.match(observed?.containerId ?? "", /^[a-f0-9]{64}$/, "missing participating container identity");
  const budget = expected.cpus[role === "upstream" ? "api" : "load"];
  assert.deepEqual(observed, { role, containerId: observed.containerId, imageId: role === "load" ? context.k6ImageId : context.nodeImageId,
    memoryBytes: role === "upstream" ? 512 * 2 ** 20 : role === "probe" ? 256 * 2 ** 20 : 2 ** 31,
    quota: budget.quota, cpuset: budget.cpuset, configuration: expectedConfiguration(expected, context, role) }, "participating runtime image/CPU/memory/ownership differs");
}
export function verifyParticipants(raw, expected, context, roles) {
  assert.deepEqual(Object.keys(raw.participants ?? {}).sort(), [...roles].sort(), "missing/extra participating runtime receipts");
  for (const role of roles) verifyParticipant(raw.participants[role], expected, context, role);
  const ids = [raw.runtime.containerId, ...roles.map((role) => raw.participants[role].containerId)];
  assert.equal(new Set(ids).size, ids.length, "participating containers must be distinct");
}
export function loadConfig(options, phase) {
  assert.ok(["warmup", ...phases].includes(phase), "unknown load phase");
  return { seconds: phase === "warmup" ? options.warmup : options.duration, mode: phase === "fixed" ? "fixed" : "closed",
    rate: options.rate, vus: phase === "sat256" ? 256 : phase === "warmup" ? 32 : 64, encoding: "identity" };
}
export function upstreamReadDelta(counts) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  assert.ok(counts && object(counts.before) && object(counts.after), "missing upstream read counters");
  let delta = 0;
  for (const id of new Set([...Object.keys(counts.before), ...Object.keys(counts.after)])) {
    const a = counts.before[id] ?? 0, b = counts.after[id] ?? 0;
    assert.ok(Number.isSafeInteger(a) && a >= 0 && Number.isSafeInteger(b) && b >= a, "invalid upstream read counter"); delta += b - a;
  }
  assert.ok(Number.isSafeInteger(delta), "upstream read delta overflow"); return delta;
}
export function deriveLoad(raw, expected, phase, options, tools, context) {
  context = { ...context, load: loadConfig(options, phase) };
  assert.deepEqual(raw.identity, expected, "wrong raw load identity");
  verifyRuntime(raw.runtime, expected, context);
  verifyParticipants(raw, expected, context, ["upstream", "load"]);
  assert.deepEqual(raw.tools, { nodeImageId: tools.node.imageId, k6ImageId: tools.k6.imageId }, "raw load tool identity differs");
  assert.equal(raw.phase, phase, "wrong raw phase");
  assert.deepEqual(raw.config, loadConfig(options, phase), "wrong raw load configuration");
  const metrics = readLoad(raw.k6);
  assert.ok(Number.isSafeInteger(metrics.requests) && metrics.requests > 0, "invalid request count");
  const clock = raw.clock, start = Date.parse(clock?.startedAt), end = Date.parse(clock?.finishedAt), elapsed = end - start;
  const duration = clock?.k6DurationMs, requested = raw.config.seconds * 1000;
  assert.ok(Number.isFinite(start) && start > 0 && Number.isFinite(end) && elapsed >= duration && elapsed <= duration + 10000, "missing/inconsistent phase clock");
  assert.ok(Number.isFinite(duration) && duration >= requested && duration <= requested + 10000, "phase did not run its configured duration/grace");
  const rate = metrics.requests * 1000 / duration;
  assert.ok(Math.abs(metrics.rps - rate) <= Math.max(1e-9, rate * 1e-9), "request count/rate/phase duration differ");
  if (phase === "fixed") assert.equal(metrics.requests, options.rate * options.duration, "fixed phase must complete all offered requests");
  const named = raw.k6.root_group?.checks;
  assert.deepEqual(Object.keys(named ?? {}).sort(), ["JSON content type", "JSON status 200"], "wrong/missing JSON load checks");
  for (const check of Object.values(named)) { assert.equal(check.passes, metrics.requests); assert.equal(check.fails, 0); }
  const checks = raw.k6.metrics.checks.values ?? raw.k6.metrics.checks;
  assert.equal(checks.passes, metrics.requests * 2, "JSON status/type checks must cover every request");
  const roles = expected.source === "api" ? ["app", "upstream"] : ["app"];
  assert.deepEqual(Object.keys(raw.counters).sort(), [...roles].sort(), "wrong CPU counter roles");
  assert.deepEqual(Object.keys(raw.samples).sort(), [...roles].sort(), "wrong stats roles");
  for (const role of roles) {
    const counter = raw.counters[role];
    assert.ok(Number.isSafeInteger(counter.before) && counter.before >= 0 && Number.isSafeInteger(counter.after) && counter.after > counter.before, "invalid CPU counters");
    assert.ok(Array.isArray(raw.samples[role]) && raw.samples[role].length > 0, "missing raw stats");
    const samples = raw.samples[role];
    for (const [i, s] of samples.entries()) {
      assert.ok(Number.isFinite(s.cpu) && s.cpu >= 0 && Number.isFinite(s.mem) && s.mem > 0
        && Number.isFinite(s.t) && s.t >= start && s.t <= end, "invalid/out-of-window raw CPU/memory sample");
      if (i) assert.ok(s.t > samples[i - 1].t && s.t - samples[i - 1].t <= 5000, "stats sample order/gap differs");
    }
    assert.ok(samples[0].t - start <= 5000 && end - samples.at(-1).t <= 5000, "stats samples do not cover phase window");
  }
  const stats = summarizeSamples(raw.samples.app), cpuUsec = raw.counters.app.after - raw.counters.app.before;
  const upstream = expected.source === "api" ? { ...summarizeSamples(raw.samples.upstream),
    cpuUsec: raw.counters.upstream.after - raw.counters.upstream.before } : null;
  {
    const delta = upstreamReadDelta(raw.upstreamReads);
    assert.equal(delta, upstream ? metrics.requests : 0, upstream ? "load requires exactly one upstream read per JSON request" : "fixture timing must perform zero upstream reads");
  }
  return { ...metrics, ...stats, cpuUsec, perCpuSecond: metrics.requests / (cpuUsec / 1e6), upstream };
}

// Receipts attest source inspection, not wire formatting. The operator supplies an
// independently audited receipt; this harness never creates a positive audit.
export function verifyNativeReceipt(receipt, expected, files) {
  assert.equal(receipt?.schema, receiptSchema, "audited native receipt required");
  assert.deepEqual(receipt.identity, expected, "native audit identity differs");
  assert.ok(typeof receipt.auditor === "string" && receipt.auditor.trim().length > 0 && Number.isFinite(Date.parse(receipt.auditedAt)), "named/date-stamped independent audit required");
  assert.deepEqual(receipt.findings, [], "unresolved native source findings");
  assert.deepEqual(receipt.verified, { typedCompleteRecord: true, nativeSerialization: true, noOutputCache: true,
    noJsonPassthrough: true, fixtureParsedAtStartup: true, requestTimeFetchParse: true, upstreamErrors: true }, "native source guarantees not audited");
  assert.ok(Array.isArray(receipt.sourceFiles) && receipt.sourceFiles.length > 0, "audited source files required");
  assert.deepEqual(Object.keys(files).sort(), receipt.sourceFiles.map((f) => f.path).sort(), "source snapshot set differs");
  assert.equal(new Set(receipt.sourceFiles.map((f) => f.path)).size, receipt.sourceFiles.length, "duplicate source file");
  const prefix = expected.app === "corten" ? `bench/${payloads[expected.payload].path}/corten/` : `bench/fullstack/apps/${expected.app}/`;
  assert.ok(receipt.sourceFiles.some((f) => f.path.startsWith(prefix)), "audit must include this native adapter's source");
  for (const file of receipt.sourceFiles) {
    assert.ok(/^(bench|crates)\/[^\\:]+$/.test(file.path) && file.path.split("/").every((part) => part && part !== "." && part !== ".."), "audit source path must stay in bench/crates");
    assert.equal(sha256(files[file.path]), file.sha256, "audited source snapshot hash differs");
  }
  return true;
}
