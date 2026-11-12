import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { reader, writer } from "./artifacts.mjs";
import { descriptor, sha256 } from "./contract.mjs";
import { inspectJson, renderJson } from "./report.mjs";
import { result } from "./test-fixtures.mjs";

const base = result(), key = descriptor().cases[0].key, api = descriptor().cases[1].key;
const copy = () => structuredClone(base.summary);
const inspect = (s) => inspectJson(s, { load: base.load, commit: "a".repeat(40) });

test("strict complete JSON baseline requires all 36 functional, audit and raw timing cells", () => {
  const report = inspect(copy()); assert.equal(report.baseline, true, report.warnings.join("\n"));
  assert.equal(Object.keys(report.apps).length, 9);
  assert.ok(Object.values(report.apps).every((rows) => Object.keys(rows).length === 4 && Object.values(rows).every((r) => r.complete)));
  const markdown = renderJson(report); assert.match(markdown, /aspnet-aot/); assert.match(markdown, /catalog-v1/); assert.match(markdown, /marketplace-v2/);
  assert.match(markdown, /Functional checks do not prove native serialization/);
});

test("a missing, reordered, duplicate or wrong-profile effective schedule cannot certify a baseline", () => {
  for (const mutate of [
    (s) => { delete s.timingPlan; },
    (s) => { [s.timingPlan[0], s.timingPlan[1]] = [s.timingPlan[1], s.timingPlan[0]]; },
    (s) => { s.timingPlan[1] = structuredClone(s.timingPlan[0]); },
    (s) => { s.timingPlan[0].profile.target = "page"; },
  ]) {
    const s = copy(); mutate(s); const report = inspect(s);
    assert.equal(report.baseline, false);
    assert.ok(report.warnings.some((warning) => warning.includes("missing/wrong effective timing plan")));
  }
});

test("missing native audit never becomes qualification from functional success", () => {
  const s = copy(); delete s.apps.corten.checks[key].native; s.apps.corten.checks[key].nativeSerializationVerified = true;
  const report = inspect(s); assert.equal(report.baseline, false);
  assert.equal(report.apps.corten[key].functional, true); assert.equal(report.apps.corten[key].nativeQualified, false);
});

test("missing/extra app/source/payload/target evidence cannot form a baseline", () => {
  for (const change of [
    (s) => { delete s.apps["aspnet-aot"]; }, (s) => { s.apps.other = s.apps.corten; },
    (s) => { delete s.apps.gin.checks[api]; }, (s) => { delete s.apps.corten.images["marketplace-v2"]; },
    (s) => { s.apps.corten.checks["catalog-v1-fixture-neutral-page"] = s.apps.corten.checks[key]; },
    (s) => { s.apps.corten.checks[key].identity.source = "api"; },
    (s) => { s.apps.corten.checks[key].identity.payload = "marketplace-v2"; },
    (s) => { s.apps.corten.runs[key][0].identity.target = "page"; },
    (s) => { s.apps.corten.runs[key].push(structuredClone(s.apps.corten.runs[key][0])); },
  ]) { const s = copy(); change(s); assert.equal(inspect(s).baseline, false); }
  const s = copy(); s.options.apps.pop(); assert.throws(() => inspect(s), /selection/);
});

test("duplicate pass numbers are rejected even with the requested number of entries", () => {
  const s = copy(), run = s.apps.corten.runs[key][0]; s.options.passes = 3;
  s.apps.corten.runs[key] = [run, structuredClone(run), structuredClone(run)];
  const report = inspect(s); assert.equal(report.baseline, false);
  assert.ok(report.warnings.some((message) => message.includes(`corten ${key} timing`) && message.includes("duplicate/wrong pass")));
});

test("wrong/dirty/changed commit, image, tools or CPU configuration are never complete", () => {
  for (const change of [
    (s) => { s.commitAfter = "b".repeat(40); }, (s) => { delete s.commitAfter; }, (s) => { s.dirtyAfter = true; },
    (s) => { s.dirty = true; }, (s) => { s.commit = "b".repeat(40); },
    (s) => { s.apps.aspnet.images["catalog-v1"] = s.apps["aspnet-aot"].images["catalog-v1"]; },
    (s) => { s.apps.corten.images["catalog-v1"].labels["run.corten.json-api.dirty"] = "true"; },
    (s) => { delete s.tools.k6; }, (s) => { s.measurement.cpus.app.quota = 2; },
    (s) => { s.measurement.encoding = "gzip"; }, (s) => { s.finishedAt = "invalid"; },
  ]) { const s = copy(); change(s); assert.equal(inspect(s).baseline, false); }
});

test("missing/corrupted/extra fixed and efficiency aggregates or individual runs cannot be trusted", () => {
  for (const change of [
    (s) => { delete s.apps.corten.aggregates[key]; }, (s) => { delete s.apps.corten.aggregates[key].fixed; },
    (s) => { s.apps.corten.aggregates[key].fixed.perCpuSecond.median = 99999; },
    (s) => { s.apps.corten.aggregates[key].sat256.asked = 3; }, (s) => { s.apps.corten.aggregates[key].fixed.passes = 3; },
    (s) => { s.apps.corten.aggregates[key].extra = {}; }, (s) => { s.apps.corten.aggregates[key].fixed.extra = 1; },
    (s) => { s.apps.corten.runs[key][0].phases.fixed.metrics.cpuUsec *= 2; },
    (s) => { delete s.apps.corten.runs[key][0].warmup; }, (s) => { s.apps.corten.runs[key][0].pass = 2; },
  ]) { const s = copy(); change(s); assert.equal(inspect(s).baseline, false); }
});

test("raw checker observations, load summaries and native source snapshots are required and identity-bound", () => {
  for (const [kind, mutate] of [
    ["check", (raw) => { raw.events.pop(); }], ["check", (raw) => { raw.events[1] = raw.events[0]; }],
    ["check", (raw) => { raw.identity.app = "aspnet-aot"; }],
    ["audit", (raw) => { raw.receipt.verified.nativeSerialization = false; }],
    ["audit", (raw) => { raw.files[Object.keys(raw.files)[0]] += "edited"; }],
    ["load", (raw) => { raw.identity.source = "fixture"; }], ["load", (raw) => { raw.k6.metrics.checks.values.fails = 1; }],
    ["load", (raw) => { raw.upstreamReads.after = {}; }], ["load", (raw) => { raw.samples.app = []; }],
    ["load", (raw) => { raw.counters.app.after = raw.counters.app.before; }], ["load", (raw) => { raw.config.mode = "fixed"; }],
  ]) {
    const s = copy(), checked = s.apps.corten.checks[api], run = s.apps.corten.runs[api][0];
    const ref = kind === "check" ? checked.raw : kind === "audit" ? checked.native : run.phases.sat64.raw;
    const raw = base.load(ref); mutate(raw); const changed = base.put(raw);
    if (kind === "check") checked.raw = changed; else if (kind === "audit") checked.native = changed; else run.phases.sat64.raw = changed;
    assert.equal(inspect(s).baseline, false);
  }
  const s = copy(); s.apps.corten.checks[key].raw.sha256 = "0".repeat(64); assert.equal(inspect(s).baseline, false);
});

test("read-only incomplete report preserves every selected member and labels partial evidence", () => {
  const s = copy(); delete s.apps["aspnet-aot"]; s.apps.corten.runs[key][0].complete = false;
  const report = inspect(s), markdown = renderJson(report);
  assert.equal(report.baseline, false); assert.equal(Object.keys(report.apps).length, 9);
  assert.match(markdown, /INCOMPLETE: not a baseline/); assert.match(markdown, /unverified partial/); assert.match(markdown, /pending/);
});

test("rehashing raw fixture reads, runtime budgets or phase clocks cannot bypass strict report replay", () => {
  for (const [kind, mutate] of [
    ["check", (raw) => { raw.events.at(-1).body = JSON.stringify({ requests: { record_1: 501 } }); }],
    ["check", (raw) => { raw.runtime.configuration.env.PROFILE = "matched"; }],
    ["check", (raw) => { raw.runtime.configuration.mounts.push({ type: "bind", source: "/unrelated", destination: "/app", writable: true }); }],
    ["load", (raw) => { delete raw.clock; }],
    ["load", (raw) => { raw.upstreamReads.after = { record_1: 1 }; }],
    ["load", (raw) => { delete raw.participants.load; }],
    ["load", (raw) => { raw.participants.upstream.memoryBytes *= 2; }],
  ]) {
    const s = copy(), checked = s.apps.corten.checks[key], phase = s.apps.corten.runs[key][0].phases.fixed;
    const raw = base.load(kind === "check" ? checked.raw : phase.raw); mutate(raw);
    const ref = base.put(raw); if (kind === "check") checked.raw = ref; else phase.raw = ref;
    assert.equal(inspect(s).baseline, false);
  }
});

test("portable report reads hash-bound artifacts, rejects unsafe paths and strictly fails incomplete evidence", () => {
  const folder = mkdtempSync(join(tmpdir(), "json-api-report-")), here = dirname(fileURLToPath(import.meta.url));
  try {
    for (const [path, bytes] of base.artifacts) writeFileSync(join(folder, path), bytes);
    const file = join(folder, "summary.json"); writeFileSync(file, JSON.stringify(base.summary));
    const run = () => {
      const child = spawnSync(process.execPath, [join(here, "report.mjs"), file, "--require-complete"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
      assert.ifError(child.error);
      assert.equal(child.signal, null, `report child terminated by ${child.signal}: ${child.stderr}`);
      return child;
    };
    const good = run(); assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /COMPLETE/);
    // Full-matrix rejection mutations are replayed above. The CLI also needs to
    // handle genuinely partial evidence without a second full successful replay.
    const s = copy(); s.dirtyAfter = true; s.apps = {}; writeFileSync(file, JSON.stringify(s));
    const partial = run(); assert.equal(partial.status, 1, partial.stderr);
    assert.match(partial.stdout, /INCOMPLETE: not a baseline/);
    assert.match(partial.stdout, /provenance: tree dirty after run/);
    assert.ok(descriptor().apps.every((app) => partial.stdout.includes(`| ${app} |`)), "partial CLI report retains every selected app");
    const load = reader(folder);
    for (const path of ["../summary.json", "a/../../summary.json", "D:/secret", "a\\b.json", "/absolute"]) assert.throws(() => load({ path, sha256: "0".repeat(64) }));
    mkdirSync(join(folder, "nested")); const put = writer(folder), ref = put("nested/test.json", { ok: true });
    assert.deepEqual(load(ref), { ok: true }); writeFileSync(join(folder, ref.path), "{}"); assert.throws(() => load(ref), /digest/);
    assert.equal(sha256(readFileSync(file)), sha256(JSON.stringify(s)), "report is read-only");
  } finally { assert.equal(dirname(folder), join(tmpdir(), ".")); rmSync(folder, { recursive: true, force: true }); }
});
