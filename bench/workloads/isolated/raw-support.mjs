// Diagnostic replay of artifacts the current native HTTP runners actually save.
// This is NOT complete native qualification: HTTP/browser observations, exact-runtime
// provenance and positive cleanup cannot be reconstructed from these formats.
import assert from "node:assert/strict";
import { join } from "node:path";
import { phases, readLoad } from "../../catalog/contract.mjs";
import { readOutcome, timedProfiles } from "../../marketplace/run-contract.mjs";
import { summarizeSamples } from "../../catalog/stats.mjs";
import { readRegular } from "./evidence.mjs";

export function inspectRawSupport(group, summary, root, manifest) {
  assert.ok(["catalog-page", "localized-marketplace"].includes(group));
  const files = new Set(manifest.entries.filter((e) => e.type === "file").map((e) => e.path));
  const required = [], missing = [], replayed = [];
  const requireFile = (path, check) => {
    assert.ok(!required.includes(path), "duplicate required native artifact"); required.push(path);
    if (!files.has(path)) { missing.push(path); return undefined; }
    const bytes = readRegular(join(root, ...path.split("/")));
    if (check) {
      try { check(bytes); replayed.push(path); }
      catch (error) { throw new Error(`${path}: native raw support contradicts summary: ${error.message}`); }
    }
    return bytes;
  };
  const equalJson = (path, expected) => requireFile(path, (b) => assert.deepEqual(JSON.parse(b), expected));
  requireFile("run.log");
  for (const app of summary.options.apps) {
    const entry = summary.apps[app];
    if (summary.options.build) requireFile(`build-${app}.log`);
    for (const source of ["fixture", "api"]) {
      const base = `${source}/${app}`;
      requireFile(`${base}/app.log`);
      if (group === "localized-marketplace") {
        equalJson(`${base}/qualification.json`, entry.qualification[source]);
        requireFile(`${base}/qualification.log`);
      }
      const check = entry.checks[source];
      if (check) {
        const expected = structuredClone(check); delete expected.qualification;
        equalJson(`${base}/checks.json`, expected); requireFile(`${base}/checks.log`);
        if (group === "catalog-page") equalJson(`${base}/qualification.json`, check);
      }
      const profiles = group === "catalog-page" ? [{ source, key: `${source}-page`, target: "page", locale: null }]
        : timedProfiles.filter((p) => p.source === source);
      for (const profile of profiles) for (const run of entry.runs[profile.key] ?? []) {
        const path = group === "catalog-page" ? `${base}/p${run.pass}-${profile.target}`
          : `${base}/p${run.pass}-${profile.locale ?? "neutral"}-${profile.target}`;
        requireFile(`${path}/app.log`); equalJson(`${path}/cold.json`, run.cold);
        requireFile(`${path}/cold.log`, (b) => {
          const cold = JSON.parse(b.toString().split("\n").findLast((s) => s.startsWith("{")));
          for (const [key, value] of Object.entries(cold)) assert.deepEqual(value, run.cold[key]);
          assert.deepEqual(Object.keys(cold).sort(), ["attempts", "bytes", "first200At", "path", "successfulRequestMs"]);
        });
        for (const phase of ["warmup", ...phases]) {
          const metrics = phase === "warmup" ? run.warmup : run.phases[phase];
          // Native stopped outcomes legitimately lack this and later phase summaries.
          // Their stop/state/sidecar evidence is not a replayable record in these formats.
          if (!metrics) continue;
          requireFile(`${path}/${phase}.log`);
          requireFile(`${path}/${phase}.json`, (b) => {
            const derived = (group === "catalog-page" ? readLoad : readOutcome)(JSON.parse(b));
            for (const [key, value] of Object.entries(derived)) assert.deepEqual(metrics[key], value, `load ${key}`);
          });
          let counters;
          requireFile(`${path}/${phase}-cpu.json`, (b) => {
            counters = JSON.parse(b);
            if (phase === "warmup") { assert.deepEqual(counters, {}); return; }
            assert.equal(typeof summary.runId, "string", "missing native run identity");
            const appName = `${summary.runId}-${app}`, upstreamName = `${summary.runId}-upstream`;
            const names = [appName, ...(source === "api" ? [upstreamName] : [])];
            assert.deepEqual(Object.keys(counters).sort(), names.sort());
            assert.deepEqual(counters[appName], { usec: metrics.cpuUsec });
            assert.equal(metrics.perCpuSecond, metrics.requests / (metrics.cpuUsec / 1e6));
            if (source === "api") assert.deepEqual(counters[upstreamName], { usec: metrics.upstream.cpuUsec });
          });
          if (phase !== "warmup") {
            requireFile(`${path}/${phase}-stats.log`);
            requireFile(`${path}/${phase}-stats.log.json`, (b) => {
              const stats = JSON.parse(b), name = `${summary.runId}-${app}`, upstream = `${summary.runId}-upstream`;
              const names = [name, ...(source === "api" ? [upstream] : [])].sort();
              assert.deepEqual(Object.keys(stats.samples).sort(), names); assert.deepEqual(Object.keys(stats.summary).sort(), names);
              for (const n of names) {
                const derived = summarizeSamples(stats.samples[n]); assert.deepEqual(stats.summary[n], derived);
                const recorded = n === name ? metrics : metrics.upstream;
                for (const [key, value] of Object.entries(derived)) assert.deepEqual(recorded[key], value, `stats ${key}`);
              }
            });
          }
        }
      }
    }
  }
  return { state: missing.length ? "missing-native-artifacts" : "present-artifacts-diagnostically-replayed",
    required, missing, replayed, qualification: "blocked",
    limits: "Neither path presence nor this diagnostic replay proves functional HTTP/browser responses, runtime/source/image provenance, stopped-process observations or positive owned cleanup" };
}
