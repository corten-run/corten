import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeSamples } from "../catalog/stats.mjs";
import { writeSavedFixture } from "./saved-fixture.mjs";
import { sourceTree } from "./raw-contract.mjs";
import { stageAggregate } from "./run-contract.mjs";
import { validateSaved } from "./validate.mjs";

test("saved resource and execution limits reject coherent impossible evidence", async (t) => {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const folder = mkdtempSync(join(tmpdir(), "marketplace-limits-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeSavedFixture(folder, commit, sourceTree(commit));
  const args = { folder, round: "r17", commit }, originals = new Map();
  assert.equal(validateSaved(args).complete, true);
  const read = (path) => JSON.parse(readFileSync(join(folder, path), "utf8"));
  const write = (path, value) => {
    if (!originals.has(path)) originals.set(path, readFileSync(join(folder, path)));
    writeFileSync(join(folder, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const edit = (path, change) => { const v = read(path); change(v); write(path, v); return v; };
  const summary = (phase, change) => edit("summary.json", (s) => {
    const a = s.apps.corten, runs = a.runs["api-neutral-json"];
    change(runs[2].phases[phase]); a.phases["api-neutral-json"][phase] = stageAggregate(runs, phase, 3);
  });
  const probe = async (label, change, valid = false) => t.test(label, () => {
    try {
      change();
      if (valid) assert.equal(validateSaved(args).complete, true);
      else assert.throws(() => validateSaved(args), (e) => e.code === "MARKETPLACE_EVIDENCE_INVALID");
    } finally { for (const [path, bytes] of originals) writeFileSync(join(folder, path), bytes); originals.clear(); }
  });
  const base = "api/corten/p3-neutral-json";
  await probe("actual producer 2 GiB k6 configuration is replayable", () => {
    assert.match(readFileSync(new URL("./run.mjs", import.meta.url), "utf8"), /await owned\(\["create", "--network", network, \.\.\.cpus.load.args, "--memory", "2g"/);
    for (const e of readdirSync(folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith("-receipt.json"))) {
      edit(join(e.parentPath, e.name).slice(folder.length + 1), (v) => { v.load.memoryBytes = 2 * 2 ** 30; });
    }
  }, true);
  await probe("a downgraded 1 GiB generator receipt is not the native producer configuration", () => {
    edit(`${base}/fixed-receipt.json`, (v) => { v.load.memoryBytes = 2 ** 30; });
  });
  const cpu = (role, usec) => {
    const raw = edit(`${base}/sat256-receipt.json`, (v) => { v.after[v[role].name] = v.before[v[role].name] + usec; });
    edit(`${base}/sat256-cpu.json`, (v) => { v[raw[role].name].usec = usec; });
    summary("sat256", (v) => {
      if (role === "app") { v.cpuUsec = usec; v.perCpuSecond = v.requests / (usec / 1e6); }
      else v.upstream.cpuUsec = usec;
    });
  };
  for (const [role, cores] of [["app", 1], ["upstream", 2]]) {
    await probe(`${role} CPU cannot consume 1e12 usec within its last phase`, () => cpu(role, 1e12));
    await probe(`${role} CPU cannot exceed its phase budget even within the total lifetime budget`, () => cpu(role, cores * 20e6));
    await probe(`${role} genuine near-capacity CPU usage remains valid`, () => cpu(role, cores * 15e6), true);
    await probe(`${role} absolute CPU counters must fit its lifetime even when the local delta is unchanged`, () => {
      edit(`${base}/sat256-receipt.json`, (v) => { v.before[v[role].name] += 1e12; v.after[v[role].name] += 1e12; });
    });
  }
  const memory = (role, amount, display) => {
    const raw = read(`${base}/sat256-receipt.json`), name = raw[role].name;
    const sampled = edit(`${base}/sat256-stats.log.json`, (v) => {
      for (const p of v.samples[name]) p.mem = amount;
      v.summary[name] = summarizeSamples(v.samples[name]);
    });
    const text = readFileSync(join(folder, base, "sat256-stats.log"), "utf8").trim().split("\n").map((line) => {
      const p = JSON.parse(line); if (p.Name === name) p.MemUsage = `${display} / ${role === "app" ? "1GiB" : "512MiB"}`; return JSON.stringify(p);
    }).join("\n") + "\n";
    write(`${base}/sat256-stats.log`, text);
    summary("sat256", (v) => Object.assign(role === "app" ? v : v.upstream, sampled.summary[name]));
  };
  for (const role of ["app", "upstream"]) {
    await probe(`${role} memory cannot exceed the container limit with coherent samples and aggregates`, () => memory(role, 1e9, "1000000000MiB"));
    await probe(`${role} memory exactly at its limit remains valid`, () => memory(role, role === "app" ? 1024 : 512, role === "app" ? "1GiB" : "512MiB"), true);
  }
  await probe("omitted display zeroes do not permit a 1 GiB sample under the upstream 512 MiB limit", () => memory("upstream", 1024, "1GiB"));
  await probe("one billion fixed-rate drops cannot fit the actual execution window", () => {
    const elapsed = read(`${base}/fixed-clock.json`).testRunDurationMs;
    edit(`${base}/fixed.json`, (v) => { v.metrics.dropped_iterations = { count: 1e9, rate: 1e9 / (elapsed / 1000) }; });
    summary("fixed", (v) => { v.dropped = 1e9; v.appOutcome = true; });
  });
  await probe("capacity drops that conserve the schedule remain app outcomes", () => {
    const elapsed = read(`${base}/fixed-clock.json`).testRunDurationMs;
    const k6 = edit(`${base}/fixed.json`, (v) => {
      for (const name of ["http_reqs", "iterations"]) v.metrics[name] = { count: 1500, rate: 1500 / (elapsed / 1000) };
      v.metrics.http_req_failed.fails = 1500; v.metrics.checks.passes = 3000;
      for (const c of Object.values(v.root_group.checks)) c.passes = 1500;
      v.metrics.dropped_iterations = { count: 750, rate: 750 / (elapsed / 1000) };
    });
    summary("fixed", (v) => { v.requests = 1500; v.rps = k6.metrics.http_reqs.rate; v.perCpuSecond = 1500; v.dropped = 750; v.appOutcome = true; });
  }, true);
  for (const [label, trend] of [
    ["mean cannot contradict nonnegative quantiles", { avg: 1, "p(50)": 100, "p(95)": 100, "p(99)": 100, max: 100 }],
    ["latency cannot outlast generator execution", { avg: 1e6, "p(50)": 1, "p(95)": 2, "p(99)": 3, max: 1e9 }],
  ]) await probe(label, () => {
    edit(`${base}/fixed.json`, (v) => { v.metrics.http_req_duration = trend; });
    summary("fixed", (v) => { v.p50 = trend["p(50)"]; v.p95 = trend["p(95)"]; v.p99 = trend["p(99)"]; });
  });
});
