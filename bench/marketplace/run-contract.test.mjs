import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appStop, cpuSettings, imageProvenance, inventory, parseArgs, profileStop, readOutcome, resultSchema, roundIdentity, stageAggregate, timedProfiles, upstreamErrors } from "./run-contract.mjs";
test("versioned round namespace and safe defaults", () => {
  assert.match(inventory.nextjs.label, /Pages Router/);
  assert.doesNotMatch(inventory.phoenix.label, /LiveView/);
  assert.doesNotMatch(inventory.laravel.label, /Livewire/);
  assert.deepEqual(parseArgs(["w1"], { corten: {} }).apps, ["corten"]);
  assert.equal(parseArgs(["w1"], {}).passes, 3);
  assert.equal(parseArgs(["r17"], inventory).apps.length, 20);
  assert.equal(parseArgs(["r18", "--build"], inventory).round, "r18");
  assert.throws(() => parseArgs(["r17"], { corten: {} }));
  assert.deepEqual(roundIdentity("r999"), { kind: "official", number: 999 });
  for (const round of [undefined, "r1", "r16", "r0", "r017", "r17x", "r17.0", "r17\n", "r17 ", "r-17", "r9007199254740992", "w9007199254740992", "c1", "m1", "w0", "w01"]) assert.throws(() => parseArgs([round], {}));
  for (const flags of [["--apps", "corten"], ["--passes", "1"], ["--passes", "5"], ["--check-only"]]) assert.throws(() => parseArgs(["r17", ...flags], inventory));
  assert.equal(parseArgs(["w1", "--apps", "corten", "--passes", "1", "--check-only"], inventory).checkOnly, true);
  assert.throws(() => parseArgs(["w1", "--apps", "absent"], { corten: {} }));
});

test("timed schema has six localized pages and exactly two locale-neutral JSON profiles", () => {
  assert.equal(resultSchema, "marketplace-results/v4");
  assert.equal(timedProfiles.length, 8);
  assert.equal(new Set(timedProfiles.map((p) => p.key)).size, 8);
  for (const source of ["fixture", "api"]) {
    assert.deepEqual(timedProfiles.filter((p) => p.source === source && p.target === "page").map((p) => p.locale), ["en-US", "fr-FR", "de-DE"]);
    assert.deepEqual(timedProfiles.filter((p) => p.source === source && p.target === "json"), [{ key: `${source}-neutral-json`, source, locale: null, target: "json" }]);
  }
});
test("v2 CPU placement ignores catalog environment and rejects overlapping roles", () => {
  assert.equal(cpuSettings({ CATALOG_APP_CPUS: "0" }).app.cpuset, null);
  assert.equal(cpuSettings({ MARKETPLACE_APP_CPUS: "0" }).app.cpuset, "0");
  assert.throws(() => cpuSettings({ MARKETPLACE_APP_CPUS: "0", MARKETPLACE_LOAD_CPUS: "0-3" }));
});

test("load rejects dirty-built or unproven images even at the same HEAD", () => {
  const commit = "a".repeat(40), labels = { "run.corten.marketplace.commit": commit, "run.corten.marketplace.dirty": "false" };
  assert.deepEqual(imageProvenance(labels, commit, false), { builtCommit: commit, builtDirty: false });
  for (const dirty of ["true", undefined]) assert.throws(() => imageProvenance({ ...labels, "run.corten.marketplace.dirty": dirty }, commit, false));
  assert.throws(() => imageProvenance(labels, "b".repeat(40), false));
  assert.equal(imageProvenance({}, commit, true).builtDirty, true);
});
test("legacy selection cannot silently reduce the twenty-app default", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { inventory, parseArgs } from ${JSON.stringify(new URL("./run-contract.mjs", import.meta.url).href)}; console.log(parseArgs(['w1'], inventory).apps.length);`], { env: { ...process.env, BENCH_APPS: "corten", BENCH_TIER: "matched" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "20");
});

function k6(metrics = {}, { status = [100, 0], kind = [100, 0] } = {}) {
  const check = ([passes, fails]) => ({ passes, fails });
  return { metrics: { http_reqs: { count: 100, rate: 10 }, http_req_duration: { avg: 1, "p(50)": 1, "p(95)": 2, "p(99)": 3, max: 4 }, http_req_failed: { value: 0 }, checks: { passes: 200, fails: 0 }, ...metrics },
    root_group: { checks: { "marketplace status 200": check(status), "marketplace content type": check(kind) } } };
}
test("what an app fails to serve is its outcome; a summary that is not a measurement still fails (#1128)", () => {
  assert.deepEqual(readOutcome(k6()), { requests: 100, rps: 10, p50: 1, p95: 2, p99: 3, failed: 0, failedRate: 0, dropped: 0, checksFailed: 0, appOutcome: false });
  const modern = { ...k6(), metrics: Object.fromEntries(Object.entries(k6().metrics).map(([key, values]) => [key, { values }])) };
  assert.equal(readOutcome(modern).requests, 100);
  const timedOut = readOutcome(k6({ http_req_failed: { value: 0.25 }, checks: { passes: 175, fails: 25 } }, { status: [75, 25] }));
  assert.equal(timedOut.failed, 25); assert.equal(timedOut.checksFailed, 25); assert.equal(timedOut.appOutcome, true);
  // a request cut off at the phase's end may have its failure and not its check
  assert.equal(readOutcome(k6({ http_req_failed: { value: 0.25 } }, { status: [76, 24] })).checksFailed, 24);
  const behind = readOutcome(k6({ dropped_iterations: { count: 40 } }));
  assert.equal(behind.dropped, 40); assert.equal(behind.appOutcome, true);
  for (const s of [null, {}, k6({ http_reqs: { count: 0, rate: 0 } }), k6({ http_req_duration: { avg: 1, "p(50)": 1, "p(95)": 2, "p(99)": null, max: 4 } }),
    k6({ http_req_failed: {} }), k6({ checks: undefined }), k6({ http_req_failed: { value: 1 }, checks: { passes: 100, fails: 100 } }, { status: [0, 100] }), k6({ dropped_iterations: { count: -1 } }),
    // a 200 of the wrong kind is a parity failure; the status check must agree with the failures
    k6({ checks: { passes: 190, fails: 10 } }, { kind: [90, 10] }), k6({}, { status: [99, 1] }), k6({ http_req_failed: { value: 0.1 } }, { status: [100, 0] }), { ...k6(), root_group: undefined }]) assert.throws(() => readOutcome(s));
});
test("the load script has no thresholds, so a phase an app cannot serve does not stop the later ones (#1128)", () => {
  const script = readFileSync(new URL("./load.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /^\s*thresholds\s*:/m);
  assert.match(script, /http\.setResponseCallback\(http\.expectedStatuses\(200\)\)/);
});
test("an upstream error answer during a phase is counted, so the run fails on it", () => {
  assert.equal(upstreamErrors({ answers: { 200: 10 } }, { answers: { 200: 50 } }), 0);
  assert.equal(upstreamErrors({ answers: { 200: 10, 503: 1 } }, { answers: { 200: 50, 503: 3, 404: 1 } }), 3);
  for (const [a, b] of [[{ answers: { 200: 10 } }, { answers: { 200: 9 } }], [{}, { answers: {} }], [{ answers: { 200: -1 } }, { answers: { 200: 1 } }]]) assert.throws(() => upstreamErrors(a, b));
});
test("an app container that exits or is OOM-killed during a load phase is a recorded stop, with why (#1128)", () => {
  assert.equal(appStop({ Running: true, OOMKilled: false, ExitCode: 0 }, 1, "sat64"), null);
  assert.deepEqual(appStop({ Running: false, OOMKilled: true, ExitCode: 137 }, 2, "sat256"), { pass: 2, phase: "sat256", exitCode: 137, oomKilled: true });
  assert.deepEqual(appStop({ Running: false, OOMKilled: false, ExitCode: 1 }, 1, "warmup"), { pass: 1, phase: "warmup", exitCode: 1, oomKilled: false });
  // a process killed at the limit while the container keeps running is a stop too
  assert.deepEqual(appStop({ Running: true, OOMKilled: true, ExitCode: 0 }, 3, "fixed"), { pass: 3, phase: "fixed", exitCode: null, oomKilled: true });
  for (const [state, pass, phase] of [[undefined, 1, "fixed"], [{ Running: "false", OOMKilled: false, ExitCode: 1 }, 1, "fixed"], [{ Running: false, OOMKilled: false }, 1, "fixed"],
    [{ Running: false, OOMKilled: false, ExitCode: 1 }, 1, "cold"], [{ Running: false, OOMKilled: false, ExitCode: 1 }, 0, "fixed"]]) assert.throws(() => appStop(state, pass, phase));
});
test("a stop ends its profile: each stage that lost a pass to it carries the stop, the others do not (#1128)", () => {
  const m = { requests: 10, rps: 10, p50: 1, p95: 1, p99: 1, cpuUsec: 1e6, perCpuSecond: 10, memAvgMiB: 1, memMaxMiB: 1, cpuAvgPct: 100, cpuMaxPct: 100, failedRate: 0, dropped: 0, appOutcome: false };
  const full = (pass) => ({ pass, phases: { fixed: m, sat64: m, sat256: m } });
  const stopped = (pass, phase, ran) => ({ pass, phases: Object.fromEntries(ran.map((p) => [p, m])), stopped: { pass, phase, exitCode: 137, oomKilled: true } });
  const view = (runs) => Object.fromEntries(["fixed", "sat64", "sat256"].map((p) => { const a = stageAggregate(runs, p, 3); return [p, [a.passes, a.stopped?.phase ?? null]]; }));
  assert.deepEqual(view([full(1), full(2), full(3)]), { fixed: [3, null], sat64: [3, null], sat256: [3, null] });
  assert.deepEqual(view([full(1), full(2), stopped(3, "sat256", ["fixed", "sat64"])]), { fixed: [3, null], sat64: [3, null], sat256: [2, "sat256"] });
  assert.deepEqual(view([full(1), stopped(2, "sat64", ["fixed"])]), { fixed: [2, "sat64"], sat64: [1, "sat64"], sat256: [1, "sat64"] });
  assert.deepEqual(view([stopped(1, "warmup", [])]), { fixed: [0, "warmup"], sat64: [0, "warmup"], sat256: [0, "warmup"] });
  assert.equal(stageAggregate([stopped(1, "warmup", [])], "fixed", 3).rps, null, "a stage with no measured pass has no number");
  assert.equal(profileStop([full(1)]), null);
  assert.deepEqual(profileStop([full(1), stopped(2, "fixed", [])]), { pass: 2, phase: "fixed", exitCode: 137, oomKilled: true });
});
