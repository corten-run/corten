// Read-only: never starts a server, Docker, or an external process.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { cpuSettings, descriptor, identity, k6Image, nodeImage, payloads, phases, runtimeContext, schema, sha256, timingPlan, verifyImage, verifyNativeReceipt, verifyParticipants, verifyRuntime } from "./contract.mjs";
import { reader } from "./artifacts.mjs";
import { functionalVerifier, verifyAggregates, verifyRun } from "./evidence.mjs";
import { spread } from "../fullstack/passes.mjs";

export function inspectJson(summary, { load, commit } = {}) {
  assert.equal(summary.schema, schema, "not a json-api result schema");
  assert.deepEqual(summary.group, descriptor(), "JSON group contract/selection differs");
  assert.deepEqual(summary.options?.apps, summary.group.apps, "exact JSON registry selection required");
  assert.equal(summary.options.group, "json-api");
  assert.match(summary.round ?? "", /^j[1-9]\d*$/); assert.equal(summary.options.round, summary.round);
  assert.ok([1, 3, 5].includes(summary.options.passes), "invalid pass count");
  assert.ok(typeof load === "function", "raw evidence reader required");
  const warnings = [], apps = {}, cases = summary.group.cases;
  const problem = (label, error) => warnings.push(`${label}: ${error.message ?? error}`);
  const check = (label, fn) => { try { fn(); return true; } catch (error) { problem(label, error); return false; } };
  check("provenance", () => {
    assert.match(summary.commit ?? "", /^[a-f0-9]{40}$/, "full measured commit missing");
    if (commit !== undefined) assert.equal(summary.commit, commit, "measured commit differs");
    assert.equal(summary.commitAfter, summary.commit, "after-run HEAD missing/changed");
    assert.equal(summary.dirty, false, "tree dirty before run"); assert.equal(summary.dirtyAfter, false, "tree dirty after run");
    assert.ok(Number.isFinite(Date.parse(summary.startedAt)) && Number.isFinite(Date.parse(summary.finishedAt))
      && Date.parse(summary.finishedAt) >= Date.parse(summary.startedAt), "missing/invalid terminal clock");
  });
  check("configuration", () => {
    assert.deepEqual(summary.timingPlan, timingPlan(summary.options), "missing/wrong effective timing plan");
    for (const [key, max] of [["duration", 300], ["warmup", 120], ["rate", 10000], ["startupTimeout", 300]]) {
      assert.ok(Number.isSafeInteger(summary.options[key]) && summary.options[key] >= 1 && summary.options[key] <= max, `invalid ${key}`);
    }
    const cpus = summary.measurement?.cpus;
    const expected = cpuSettings(Object.fromEntries(["app", "load", "api"].map((role) => [`JSON_API_${role.toUpperCase()}_CPUS`, cpus?.[role]?.cpuset])));
    assert.deepEqual(cpus, expected, "missing/wrong CPU quotas or placement");
    assert.deepEqual(summary.measurement, { cpus: expected, encoding: "identity", fixedRate: summary.options.rate,
      appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20, loadMemoryBytes: 2 ** 31,
      nativeProfile: "framework-default", phases: ["warmup", ...phases] }, "measurement settings differ");
    for (const tool of ["node", ...(summary.options.checkOnly ? [] : ["k6"])]) {
      assert.match(summary.tools?.[tool]?.imageId ?? "", /^sha256:[0-9a-f]{64}$/, `missing ${tool} immutable tool image`);
      assert.equal(summary.tools[tool].image, tool === "node" ? nodeImage : k6Image, "wrong tool image reference");
    }
  });
  const fixtures = {}, functionalVerifiers = {};
  check("fixture set", () => assert.deepEqual(Object.keys(summary.fixtures ?? {}).sort(), Object.keys(payloads).sort()));
  for (const [payload, p] of Object.entries(payloads)) check(`${payload} fixture`, () => {
    const fixture = load(summary.fixtures[payload]);
    assert.deepEqual(fixture, p.records(), "fixture differs from canonical payload"); fixtures[payload] = fixture;
    for (const profile of cases.filter((p) => p.payload === payload)) functionalVerifiers[profile.key] = functionalVerifier(profile, fixture);
  });
  check("selected apps", () => assert.deepEqual(Object.keys(summary.apps ?? {}).sort(), [...summary.group.apps].sort(), "missing/extra selected app rows"));
  for (const app of summary.group.apps) {
    const entry = summary.apps?.[app], rows = apps[app] = {};
    check(`${app} images`, () => {
      assert.deepEqual(Object.keys(entry?.images ?? {}).sort(), Object.keys(payloads).sort(), "missing/extra native image payload");
      for (const payload of Object.keys(payloads)) verifyImage(entry.images[payload], summary.commit, app, payload);
    });
    for (const section of ["checks", "runs", "aggregates"]) check(`${app} ${section} matrix`, () => {
      assert.deepEqual(Object.keys(entry?.[section] ?? {}).sort(), cases.map((c) => c.key).sort(), "missing/extra payload/source/target evidence");
    });
    for (const profile of cases) {
      const key = profile.key, row = rows[key] = { functional: false, nativeQualified: false, complete: false, passes: 0, rps: null };
      const expected = entry ? identity(summary, app, profile) : null;
      const checked = entry?.checks?.[key];
      row.functional = check(`${app} ${key} functional`, () => {
        assert.deepEqual(checked?.identity, expected, "missing/wrong functional identity");
        const raw = load(checked.raw); assert.deepEqual(raw.identity, expected, "wrong raw functional identity");
        const context = runtimeContext(summary, profile);
        verifyRuntime(raw.runtime, expected, context); verifyParticipants(raw, expected, context, ["upstream"]);
        functionalVerifiers[key](checked.functional, raw.events);
      });
      row.nativeQualified = check(`${app} ${key} native audit`, () => {
        const native = load(checked?.native);
        verifyNativeReceipt(native.receipt, expected, native.files);
        assert.equal(checked.nativeSerializationVerified, true, "native audit not qualified");
        assert.equal(checked.nativeSourceVerified, true, "native source audit not qualified");
      });
      const runs = entry?.runs?.[key] ?? [];
      const timing = check(`${app} ${key} timing`, () => {
        assert.ok(Array.isArray(runs) && runs.length === summary.options.passes, "missing requested JSON passes");
        const used = new Set();
        for (const run of runs) {
          assert.ok(Number.isInteger(run.pass) && run.pass >= 1 && run.pass <= summary.options.passes && !used.has(run.pass), "duplicate/wrong pass");
          used.add(run.pass); verifyRun(run, { ...expected, pass: run.pass }, summary.options, load, summary.tools, runtimeContext(summary, profile));
          row.passes++;
        }
        verifyAggregates(entry.aggregates[key], runs, summary.options.passes);
      });
      // Partial values are retained and labeled, never zero-filled or a complete comparison.
      const available = Array.isArray(runs) ? runs.filter((r) => r.phases?.sat64?.metrics?.rps > 0) : [];
      if (available.length) {
        const values = available.map((r) => r.phases.sat64.metrics.rps).sort((a, b) => a - b);
        row.rps = { median: values[Math.floor((values.length - 1) / 2)], min: values[0], max: values.at(-1), unverifiedPartial: !timing };
        row.efficiency = Object.fromEntries(["perCpuSecond", "memMaxMiB", "p95", "cpuAvgPct"].map((metric) => [metric, spread(available.map((r) => r.phases.sat64.metrics[metric]))]));
        row.efficiency.upstreamCpuAvgPct = spread(available.map((r) => r.phases.sat64.metrics.upstream?.cpuAvgPct));
      }
      row.complete = row.functional && row.nativeQualified && timing;
      if (row.rps && !row.complete) row.rps.unverifiedPartial = true;
    }
  }
  check("suite outcome", () => {
    assert.equal(summary.complete, true, "runner did not complete a qualified matrix"); assert.equal(summary.checksPassed, true);
    assert.deepEqual(summary.failures, [], "recorded runner failures"); assert.deepEqual(summary.cleanupFailures, [], "recorded cleanup failures");
    assert.notEqual(summary.options.checkOnly, true, "check-only evidence is not a timed baseline");
  });
  const baseline = warnings.length === 0;
  if (!baseline) for (const rows of Object.values(apps)) for (const row of Object.values(rows)) if (row.rps) row.rps.unverifiedPartial = true;
  return { group: summary.group, round: summary.round, commit: summary.commit, baseline, apps, warnings,
    config: { options: summary.options, measurement: summary.measurement, timingPlan: summary.timingPlan, commitAfter: summary.commitAfter, dirty: summary.dirty, dirtyAfter: summary.dirtyAfter },
    status: baseline ? "COMPLETE" : "INCOMPLETE: not a baseline", fixtureHashes: Object.fromEntries(Object.entries(fixtures).map(([p, f]) => [p, sha256(JSON.stringify(f))])) };
}

export function renderJson(report) {
  const config = report.config;
  const lines = [`# JSON API ${report.round}`, "", `**${report.status}**`, "", `Measured commit: \`${report.commit ?? "unknown"}\`.`,
    `Registry: \`${report.group.registrySchema}\`; contract SHA-256: \`${report.group.contractSha256}\`.`, "",
    `After-run commit: \`${config.commitAfter ?? "missing"}\`; dirty before/after: ${config.dirty ?? "missing"}/${config.dirtyAfter ?? "missing"}.`,
    `Requested passes: ${config.options.passes}; duration/warmup: ${config.options.duration}/${config.options.warmup} s; fixed rate: ${config.options.rate} req/s; encoding: ${config.measurement?.encoding ?? "missing"}.`,
    "Timing order: pass, registry profile, then rotated app order; rotation offset is floor((pass - 1) * apps / passes). The exact effective schedule is retained in summary.timingPlan, not proof it executed.",
    "Native JSON only: catalog-v1 and marketplace-v2 stay distinct, with fixture/API sources. No HTML, forms or browser qualification.",
    "Functional checks do not prove native serialization. A separate audited native source receipt is required for every app/case.",
    "Throughput is the median [min, max] of sat64 passes, not a claim of CPU saturation. Unverified partial numbers are not comparisons.", "",
    "| App | Payload / source | Functional | Native audit | Verified passes | req/s | req/CPU-s | Peak MiB | p95 ms | App CPU % | Upstream CPU % |", "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const [app, rows] of Object.entries(report.apps)) for (const profile of report.group.cases) {
    const r = rows[profile.key], rate = r.rps ? `${r.rps.median} [${r.rps.min}, ${r.rps.max}]${r.rps.unverifiedPartial ? " (unverified partial)" : ""}` : "pending";
    const metric = (key) => r.efficiency?.[key]?.median ?? "pending";
    lines.push(`| ${app} | ${profile.payload} / ${profile.source} | ${r.functional} | ${r.nativeQualified} | ${r.passes} | ${rate} | ${metric("perCpuSecond")} | ${metric("memMaxMiB")} | ${metric("p95")} | ${metric("cpuAvgPct")} | ${metric("upstreamCpuAvgPct")} |`);
  }
  lines.push("", "| CPU role | Quota, cores | Logical CPU pinning |", "|---|---:|---|");
  for (const role of ["app", "load", "api"]) {
    const budget = config.measurement?.cpus?.[role]; lines.push(`| ${role} | ${budget?.quota ?? "missing"} | ${budget?.cpuset === null ? "unpinned" : budget?.cpuset ?? "missing"} |`);
  }
  lines.push("", "## Limits", "", "CPU is whole-container cgroup usage. The upstream is a single Node process and can limit throughput independently. Cold time is Docker container-start to first complete 200, not process exec. No build, browser, instruction-count or deployment parity claim is made.");
  for (const warning of report.warnings) lines.push(`- ${warning.replace(/[\r\n]+/g, " ")}`);
  return `${lines.join("\n")}\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [file, ...args] = process.argv.slice(2); assert.ok(file, "summary.json required");
    let commit, strict = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--require-complete" && !strict) strict = true;
      else if (args[i] === "--commit" && commit === undefined && /^[0-9a-f]{40}$/.test(args[i + 1] ?? "")) commit = args[++i];
      else throw new Error(`unknown/duplicate report argument ${args[i]}`);
    }
    const report = inspectJson(JSON.parse(readFileSync(file, "utf8")), { load: reader(dirname(file)), commit });
    console.log(renderJson(report)); if (strict && !report.baseline) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
