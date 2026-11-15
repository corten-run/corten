// Synthetic orchestration only: no provider, credentials, SSH or native benchmark.
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { accountId, commit, context, harness } from "./cloud-fixtures.mjs";
import { fleetMain, fleetWorkerPaths, parseFleetArgs, productionChild } from "./fleet.mjs";
import { fleetPlan, reservation } from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";
import { parseProductionArgs, productionMain, productionPlan } from "./cloud-production.mjs";
import { readFleet } from "./fleet-verify.mjs";
import { groupNames } from "./registry.mjs";

// The fake committed tree is fixed for this process, like the captured loader.
// Concurrent worktree edits are not changes to that synthetic Git object.
const committedSources = new Map(fleetWorkerPaths.map((path) => [path, readFileSync(resolve(path), "utf8").replaceAll("\r\n", "\n")]));

function fixture(t, flags = {}) {
  const h = harness(t), output = [], calls = [], children = [], completions = [];
  const args = (mode) => ["r21", "--fleet-root", h.base, mode];
  const prepare = () => [...args("--prepare"), "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  const spawn = (binary, argv) => {
    calls.push([binary, argv]); assert.equal(binary, "git", "synthetic local boundary only");
    if (argv[0] === "show") return { status: 0, stdout: flags.wrongSource ? "wrong" : committedSources.get(argv[1].slice(41)) };
    if (argv[0] === "status" && flags.dirty) return { status: 0, stdout: " M synthetic" };
    if (argv[0] === "fetch" && flags.fetchError) return { status: 1, stdout: "", stderr: "PRIVATE_FETCH_ARGV" };
    return h.run(binary, argv, 60000);
  };
  const deps = { repo: h.repo, spawn, interrupted: () => !!flags.cancelled, write: (value) => output.push(JSON.parse(value)),
    main: async (argv) => {
      const { options, approval } = parseProductionArgs(argv), group = options.group ?? groupNames.find((g) => options.stateDir === join(h.base, g));
      children.push(group); assert.ok(approval);
      if (flags.child) return flags.child({ options, group, approval });
      if (options.detach) seed(group);
      completions.push(group); return 3;
    } };
  function manifest() { return readFleet(h.base, "r21").manifest; }
  function seed(group, change = () => {}) {
    const fleet = manifest(), local = join(h.base, group, "groups-r21"), i = groupNames.indexOf(group);
    mkdirSync(local, { recursive: true });
    const state = { ...reservation({ round: "r21", commit, token: fleet.jobs[i].token, group, fleet }),
      status: "running", createIntentAt: "2026-11-14T01:00:00.000Z", id: String(i + 1), ip: `192.0.2.${i + 1}`,
      provider: fleet.provider, fullGroupQualified: false };
    if (group === fleet.jobs[0].group) state.bootstrapReady = { sha256: "a".repeat(64), observedAt: "2026-11-14T01:01:00.000Z" };
    change(state); writeFileSync(join(local, "state.json"), JSON.stringify(state)); return state;
  }
  async function approve(mode) {
    assert.equal(await fleetMain([...args(mode), "--print-approval"], deps), 3);
    return [...args(mode), "--approve-reviewed-merged-ready", output.at(-1).approvalSha256];
  }
  return { h, flags, args, prepare, deps, output, calls, children, completions, manifest, seed, approve };
}

test("prepare reserves cryptorandom complete fleet once, using only local Git", async (t) => {
  const p = fixture(t);
  assert.equal(await fleetMain(p.prepare(), p.deps), 3);
  const f = p.manifest(); assert.deepEqual(f.jobs.map((j) => j.group), groupNames);
  assert.equal(new Set([f.token, ...f.jobs.map((j) => j.token)]).size, groupNames.length + 1);
  assert.ok(p.calls.every(([binary, argv]) => binary === "git" && argv[0] !== "fetch"));
  assert.deepEqual(p.children, []); assert.ok(!existsSync(join(p.h.base, ".fleet-operation.lock")));
  const bytes = readFileSync(join(p.h.base, "fleet-r21.json"));
  await assert.rejects(fleetMain(p.prepare(), p.deps));
  assert.deepEqual(readFileSync(join(p.h.base, "fleet-r21.json")), bytes);
});

test("preview binds complete exact production subjects without writes or child execution", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps);
  const before = readFileSync(join(p.h.base, "fleet-r21.json"));
  await p.approve("--detach"); const preview = p.output.at(-1);
  assert.equal(preview.subject.jobs.length, groupNames.length);
  for (const job of preview.subject.jobs) {
    assert.equal(job.approvalSha256, digest(JSON.stringify(job.subject)));
    assert.equal(job.subject.stateRoot, join(p.h.base, job.group));
    assert.equal(job.subject.fleetSha256, digest(before));
  }
  assert.equal(new Set(preview.subject.jobs.map((j) => j.subject.stateRoot)).size, groupNames.length);
  assert.deepEqual(readFileSync(join(p.h.base, "fleet-r21.json")), before);
  assert.deepEqual(p.children, []); assert.ok(!existsSync(join(p.h.base, "receipts")));
});

test("first admission failure never invokes another child's create path", async (t) => {
  const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
  const approved = await p.approve("--detach");
  let posts = 0;
  flags.child = ({ group }) => {
    posts++; // The synthetic child stands in for one complete launch/POST path.
    if (group === groupNames[0]) throw new Error("PRIVATE_FIRST_CREATE");
    p.seed(group); return 3;
  };
  assert.equal(await fleetMain(approved, p.deps), 2);
  assert.equal(posts, 1, "stop admitting after the first failed create path");
  assert.deepEqual(p.children, groupNames.slice(0, 1));
  const result = p.output.at(-1);
  assert.equal(result.groups[0].outcome, "error");
  assert.ok(result.groups.slice(1).every((row) => row.outcome === "not-admitted"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE_FIRST_CREATE"));
  for (const row of result.groups.slice(1)) {
    assert.equal(row.reason, "prior-admission-failed");
    assert.ok(!existsSync(join(p.h.base, row.group)), "no reservation for a child that was not admitted");
    const name = readdirSync(join(p.h.base, "receipts")).find((name) => name.endsWith(`-${row.group}.json`));
    assert.ok(isDeepStrictEqual(JSON.parse(readFileSync(join(p.h.base, "receipts", name))), row));
  }
  assert.equal(JSON.parse(readFileSync(join(p.h.base, "launch-intent.json"))).children.length, groupNames.length);
  await assert.rejects(fleetMain(approved, p.deps), /already-attempted/);
  assert.equal(posts, 1);
});

test("a running first group without common-bootstrap proof never opens later admissions", async (t) => {
  const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
  const approved = await p.approve("--detach");
  flags.child = ({ group }) => { p.seed(group, (state) => { delete state.bootstrapReady; }); return 3; };
  assert.equal(await fleetMain(approved, p.deps), 2);
  assert.deepEqual(p.children, groupNames.slice(0, 1));
  assert.equal(p.output.at(-1).groups[0].error, "group-state-invalid");
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "not-admitted"));
});

test("malformed first bootstrap proof refuses before another admission", async (t) => {
  for (const proof of [null, true, {}, { sha256: "a".repeat(63), observedAt: "2026-11-14T01:01:00.000Z" },
    { sha256: "a".repeat(64), observedAt: "invalid" }, { sha256: "a".repeat(64), observedAt: 1 }]) {
    const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
    const approved = await p.approve("--detach");
    flags.child = ({ group }) => { p.seed(group, (state) => { state.bootstrapReady = proof; }); return 3; };
    assert.equal(await fleetMain(approved, p.deps), 2);
    assert.deepEqual(p.children, groupNames.slice(0, 1));
    assert.equal(p.output.at(-1).groups[0].error, "group-state-invalid");
    assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "not-admitted"));
  }
});

test("detach admits the complete official roster serially only after bound running state and child settlement", async (t) => {
  const flags = {}, p = fixture(t, flags), pending = [];
  await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
  const preview = p.output.at(-1);
  assert.deepEqual(preview.subject.admission, { mode: "serial", firstGroup: groupNames[0], gate: "running-bound-host",
    firstGroupGate: "common-bootstrap-marker", nativeReadiness: false });
  flags.child = ({ group, options, approval }) => new Promise((resolve) => {
    assert.equal(approval, preview.subject.jobs.find((j) => j.group === group).approvalSha256);
    assert.equal(options.stateDir, join(p.h.base, group));
    pending.push({ group, resolve });
  });
  let finished = false;
  const operation = fleetMain(approved, p.deps).then((code) => { finished = true; return code; });
  for (const [i, group] of groupNames.entries()) {
    while (pending.length <= i) await turn();
    assert.equal(pending.length, i + 1); assert.equal(pending[i].group, group);
    p.seed(group); await turn(); await turn();
    assert.equal(pending.length, i + 1, "a running state alone is not child/credential-worker settlement");
    assert.equal(finished, false); assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
    p.completions.push(group); pending[i].resolve(3);
  }
  assert.equal(await operation, 3); assert.deepEqual(p.children, groupNames);
  assert.deepEqual(p.completions, groupNames);
  assert.ok(p.output.at(-1).groups.every((row) => row.outcome === "pending"));
  assert.equal(p.output.at(-1).fullGroupQualified, false);
  assert.ok(!existsSync(join(p.h.base, ".fleet-operation.lock")));
});

test("later admission failure preserves running siblings and never admits the remaining roster", async (t) => {
  for (const uncertain of [false, true]) {
    const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
    const approved = await p.approve("--detach");
    flags.child = ({ group }) => {
      if (group === groupNames[2]) throw Object.assign(new Error("PRIVATE_LATE_CREATE"), { controlUncertain: uncertain });
      p.seed(group); return 3;
    };
    assert.equal(await fleetMain(approved, p.deps), 2);
    assert.deepEqual(p.children, groupNames.slice(0, 3));
    const rows = p.output.at(-1).groups;
    assert.ok(rows.slice(0, 2).every((row) => row.outcome === "pending"));
    assert.equal(rows[2].outcome, "error");
    assert.ok(rows.slice(3).every((row) => row.outcome === "not-admitted"));
    for (const group of groupNames.slice(0, 2)) assert.equal(JSON.parse(readFileSync(join(p.h.base, group, "groups-r21/state.json"))).status, "running");
    assert.equal(existsSync(join(p.h.base, ".fleet-operation.lock")), uncertain);
  }
});

test("detach refuses a return code without valid running unique host state", async (t) => {
  for (const kind of ["missing", "preparing", "locked", "code0", "code1", "duplicate-id", "duplicate-ip"]) {
    const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
    const approved = await p.approve("--detach");
    flags.child = ({ group }) => {
      if (group !== groupNames[1]) { p.seed(group); return 3; }
      if (kind !== "missing") p.seed(group, (s) => {
        if (kind === "preparing") s.status = "preparing";
        if (kind === "duplicate-id") s.id = "1";
        if (kind === "duplicate-ip") s.ip = "192.0.2.1";
      });
      if (kind === "locked") writeFileSync(join(p.h.base, group, "groups-r21/operation.lock"), "synthetic-unsettled");
      return kind === "code0" ? 0 : kind === "code1" ? 1 : 3;
    };
    assert.equal(await fleetMain(approved, p.deps), 2);
    assert.deepEqual(p.children, groupNames.slice(0, 2));
    assert.equal(p.output.at(-1).groups[1].error, "group-state-invalid");
    assert.ok(p.output.at(-1).groups.slice(2).every((row) => row.outcome === "not-admitted"));
  }
});

test("collection children remain concurrent; one rejection never abandons siblings", async (t) => {
  const flags = {}, p = fixture(t, flags), pending = [];
  await fleetMain(p.prepare(), p.deps); for (const group of groupNames) p.seed(group);
  const approved = await p.approve("--collect");
  flags.child = ({ group, options, approval }) => new Promise((resolve, reject) => {
    assert.equal(approval, p.output.at(-1).subject.jobs.find((j) => j.group === group).approvalSha256);
    assert.equal(options.stateDir, join(p.h.base, group));
    pending.push({ group, resolve: () => { p.seed(group); p.completions.push(group); resolve(3); }, reject });
  });
  let finished = false;
  const operation = fleetMain(approved, p.deps).then((v) => { finished = true; return v; });
  while (pending.length !== groupNames.length) await turn();
  assert.equal(pending.length, groupNames.length); assert.equal(finished, false);
  assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  assert.ok(!existsSync(join(p.h.base, "launch-intent.json")));
  pending[0].reject(new Error("PRIVATE_PROVIDER_ARGV")); await turn();
  assert.equal(finished, false); assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  for (const child of pending.slice(1)) child.resolve();
  assert.equal(await operation, 2); assert.equal(p.completions.length, groupNames.length - 1);
  assert.ok(!JSON.stringify(p.output).includes("PRIVATE_PROVIDER_ARGV"));
  assert.ok(!existsSync(join(p.h.base, ".fleet-operation.lock")));
  assert.equal(p.children.length, groupNames.length);
});

test("no approval, stale bytes/source/account, invalid roster or existing child refuse before dispatch", async (t) => {
  for (const kind of ["missing", "wrong", "bytes", "dirty", "source", "account", "roster", "child"]) {
    const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
    let argv = approved;
    if (kind === "missing") argv = p.args("--detach");
    if (kind === "wrong") argv = [...approved.slice(0, -1), "f".repeat(64)];
    if (kind === "bytes") writeFileSync(join(p.h.base, "fleet-r21.json"), `${JSON.stringify(p.manifest())}\n`);
    if (kind === "dirty") flags.dirty = true;
    if (kind === "source") flags.wrongSource = true;
    if (kind === "account") {
      const old = p.manifest(); const f = fleetPlan({ round: old.round, commit, token: old.token, tokens: Object.fromEntries(old.jobs.map((j) => [j.group, j.token])),
        provider: { ...old.provider, accountId: "team:other" }, sshKey: old.sshKey }, old.createdAt);
      writeFileSync(join(p.h.base, "fleet-r21.json"), JSON.stringify(f));
    }
    if (kind === "roster") { const f = p.manifest(); f.jobs.pop(); writeFileSync(join(p.h.base, "fleet-r21.json"), JSON.stringify(f)); }
    if (kind === "child") p.seed(groupNames[0]);
    await assert.rejects(fleetMain(argv, p.deps)); assert.deepEqual(p.children, []);
    assert.ok(!existsSync(join(p.h.base, "launch-intent.json")));
  }
});

test("missing native integration blocks the entire batch", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps);
  p.deps.plan = async (...args) => { const plan = await productionPlan(...args); plan.missing = ["synthetic-missing"]; return plan; };
  await fleetMain([...p.args("--detach"), "--print-approval"], p.deps);
  const hash = p.output.at(-1).approvalSha256;
  await assert.rejects(fleetMain([...p.args("--detach"), "--approve-reviewed-merged-ready", hash], p.deps), /integration-missing/);
  assert.deepEqual(p.children, []);
});

test("lock spans cancellation and every pending settlement; uncertainty leaves durable lock", async (t) => {
  for (const uncertain of [false, true]) {
    const flags = {}, p = fixture(t, flags), pending = []; await fleetMain(p.prepare(), p.deps);
    const approved = await p.approve("--detach");
    flags.child = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
    const result = fleetMain(approved, p.deps); const rejection = assert.rejects(result, /cancelled/);
    while (pending.length < 1) await turn();
    assert.equal(pending.length, 1);
    flags.cancelled = true; await turn(); assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
    if (uncertain) pending[0].reject(Object.assign(new Error("private"), { controlTreeUncertain: true }));
    else pending[0].resolve(3);
    for (const child of pending.slice(1)) child.resolve(3);
    await rejection;
    assert.deepEqual(p.children, groupNames.slice(0, 1));
    const rows = readdirSync(join(p.h.base, "receipts")).map((name) => JSON.parse(readFileSync(join(p.h.base, "receipts", name))));
    assert.equal(rows.filter((row) => row.outcome === "not-admitted" && row.reason === "cancelled").length, groupNames.length - 1);
    assert.equal(existsSync(join(p.h.base, ".fleet-operation.lock")), uncertain);
    flags.cancelled = false;
    if (uncertain) await assert.rejects(fleetMain(await p.approve("--collect"), p.deps), /EEXIST/);
  }
});

test("cancellation before first admission or between admissions durably skips every untouched child", async (t) => {
  for (const phase of ["before-first", "between", "sticky"]) {
    const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
    const approved = await p.approve("--detach");
    p.deps.interrupted = () => {
      if (phase === "before-first") return existsSync(join(p.h.base, "launch-intent.json"));
      const value = !!flags.cancelled;
      if (phase === "sticky") flags.cancelled = false;
      return value;
    };
    flags.child = ({ group }) => { p.seed(group); flags.cancelled = true; return 3; };
    await assert.rejects(fleetMain(approved, p.deps), /cancelled/);
    const admitted = phase === "before-first" ? 0 : 1;
    assert.equal(p.children.length, admitted);
    assert.deepEqual(p.children, groupNames.slice(0, admitted));
    const rows = readdirSync(join(p.h.base, "receipts")).map((name) => JSON.parse(readFileSync(join(p.h.base, "receipts", name))));
    assert.equal(rows.length, groupNames.length);
    assert.equal(rows.filter((row) => row.outcome === "not-admitted" && row.reason === "cancelled").length, groupNames.length - admitted);
    assert.ok(!existsSync(join(p.h.base, ".fleet-operation.lock")));
  }
});

test("a failed admission receipt stops dispatch even after a child saved valid running state", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
  const write = p.deps.write;
  p.deps.write = (value) => {
    const row = JSON.parse(value);
    if (row.group === groupNames[0]) throw new Error("PRIVATE_OUTPUT_FAILURE");
    write(value);
  };
  assert.equal(await fleetMain(approved, p.deps), 2);
  assert.deepEqual(p.children, groupNames.slice(0, 1));
  assert.equal(p.output.at(-1).groups[0].error, "group-receipt-failed");
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "not-admitted"));
  assert.equal(JSON.parse(readFileSync(join(p.h.base, groupNames[0], "groups-r21/state.json"))).status, "running");
});

test("partial collection launches no missing/ambiguous/busy job, and does not wait for a live sibling", async (t) => {
  const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
  p.seed(groupNames[0]); p.seed(groupNames[1]);
  p.seed(groupNames[2], (s) => { s.status = "reserved"; delete s.createIntentAt; delete s.id; delete s.ip; });
  p.seed(groupNames[3]); writeFileSync(join(p.h.base, groupNames[3], "groups-r21", "operation.lock"), "synthetic-live");
  flags.child = async ({ group, options }) => { assert.equal(options.collect, true); assert.equal(options.detach, undefined); return group === groupNames[0] ? 3 : 1; };
  const approved = await p.approve("--collect");
  assert.equal(await fleetMain(approved, p.deps), 2);
  assert.deepEqual(p.children, groupNames.slice(0, 2));
  const summary = p.output.at(-1); assert.equal(summary.groups[0].outcome, "pending");
  assert.equal(summary.groups[1].outcome, "error", "an injected terminal return alone cannot prove deletion"); assert.equal(summary.groups[2].outcome, "ambiguous");
  assert.equal(summary.groups[3].outcome, "busy"); assert.ok(summary.groups.slice(4).every((g) => g.outcome === "missing"));
  assert.ok(!existsSync(join(p.h.base, "launch-intent.json")));
});

test("collection reports both retirement kinds as incomplete, never as native qualification", async (t) => {
  for (const kind of ["unused", "setup-failed"]) {
  const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
  for (const group of groupNames) p.seed(group);
  const approved = await p.approve("--collect"), unusedBytes = JSON.stringify({ syntheticUnused: true });
  flags.child = ({ group }) => {
    p.seed(group, (state) => {
      state.status = "retired"; state.retirement = { kind, evidenceSha256: digest(unusedBytes) };
      if (kind === "setup-failed") Object.assign(state, { archiveSha256: "a".repeat(64), evidenceSha256: "b".repeat(64),
        evidence: "evidence-Synthetic", extractionAttempts: ["evidence-Synthetic"] });
      delete state.bootstrapReady;
      state.deletionIntentAt = state.destroyedAt = "2026-11-14T02:00:00.000Z";
    });
    writeFileSync(join(p.h.base, group, `groups-r21/${kind === "unused" ? "unused-host.json" : "failed-setup-host.json"}`), unusedBytes);
    return 1;
  };
  assert.equal(await fleetMain(approved, p.deps), 1);
  assert.ok(p.output.at(-1).groups.every((row) => row.outcome === (kind === "unused" ? "unused-retired" : "setup-failed-retired")));
  assert.equal(p.output.at(-1).fullGroupQualified, false);
  assert.ok(!existsSync(join(p.h.base, "launch-intent.json")));
  }
});

test("a pending collection sibling never delays another host's confirmed unused retirement", async (t) => {
  const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
  for (const group of groupNames) p.seed(group);
  const approved = await p.approve("--collect"); let release, finished = false;
  flags.child = ({ group }) => {
    if (group === groupNames[0]) return new Promise((resolve) => { release = resolve; });
    if (group === groupNames[1]) {
      p.seed(group, (state) => {
        state.status = "retired"; state.retirement = { kind: "unused", evidenceSha256: digest("synthetic-unused") };
        delete state.bootstrapReady;
        state.deletionIntentAt = state.destroyedAt = "2026-11-14T02:00:00.000Z";
      });
      writeFileSync(join(p.h.base, group, "groups-r21/unused-host.json"), "synthetic-unused");
      return 1;
    }
    return 3;
  };
  const operation = fleetMain(approved, p.deps).then((code) => { finished = true; return code; });
  while (!p.output.some((row) => row.group === groupNames[1] && row.outcome === "unused-retired")) await turn();
  assert.equal(finished, false); assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  assert.equal(p.children.length, groupNames.length);
  release(3); assert.equal(await operation, 3);
  assert.equal(p.output.at(-1).groups[1].outcome, "unused-retired");
});

test("unconfirmed or wrong-code unused retirement cannot masquerade as collection success", async (t) => {
  for (const kind of ["no-absence", "code0", "code3", "wrong-evidence"]) {
    const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
    p.seed(groupNames[0]); const approved = await p.approve("--collect");
    flags.child = ({ group }) => {
      p.seed(group, (state) => {
        state.status = "retired"; state.retirement = { kind: "unused", evidenceSha256: kind === "wrong-evidence" ? "invalid" : "a".repeat(64) };
        delete state.bootstrapReady;
        state.deletionIntentAt = "2026-11-14T02:00:00.000Z";
        if (kind !== "no-absence") state.destroyedAt = state.deletionIntentAt;
      });
      return kind === "code0" ? 0 : kind === "code3" ? 3 : 1;
    };
    assert.equal(await fleetMain(approved, p.deps), 2);
    assert.equal(p.output.at(-1).groups[0].outcome, "error");
    assert.equal(p.output.at(-1).groups[0].error, "group-state-invalid");
  }
});

test("actual productionMain close uncertainty retains the fleet lock after all child worker settlements", async (t) => {
  const flags = {}, p = fixture(t, flags), pending = [];
  await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
  flags.fetchError = true; p.deps.main = productionMain;
  p.deps.providerFactory = () => Object.assign(async () => { assert.fail("no synthetic provider call expected"); }, {
    close: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
  });
  let finished = false;
  const result = fleetMain(approved, p.deps).then((v) => { finished = true; return v; });
  while (pending.length < 1) await turn();
  assert.equal(pending.length, 1); assert.equal(finished, false);
  assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  pending[0].reject(Object.assign(new Error("PRIVATE_WORKER_CLOSE"), { controlUncertain: true, controlTreeUncertain: true }));
  assert.equal(await result, 2); assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  assert.equal(pending.length, 1);
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "not-admitted"));
  assert.ok(!JSON.stringify(p.output).includes("PRIVATE"));
  assert.equal(p.calls.filter(([binary]) => binary !== "git").length, 0);
});

test("real detach workers exit before the next admission without terminating a running remote group", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
  const controls = new SharedArrayBuffer((3 + groupNames.length) * 4), shared = new Int32Array(controls);
  let spawned = 0, active = 0, maximumActive = 0;
  class SyntheticWorker extends Worker {
    constructor(url, options) {
      const slot = spawned++;
      assert.ok(url.href.startsWith("data:text/javascript;base64,"));
      super(new URL("./fleet-worker-fixture.mjs", import.meta.url), { ...options,
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
        workerData: { ...options.workerData, controls, slot, holdExit: slot === 0 } });
      maximumActive = Math.max(maximumActive, ++active);
      this.once("exit", () => { active--; });
    }
  }
  delete p.deps.main; p.deps.WorkerClass = SyntheticWorker;
  const operation = fleetMain(approved, p.deps);
  try {
    const deadline = Date.now() + 15000;
    while (Atomics.load(shared, 0) < 1 && Date.now() < deadline) await turn();
    assert.equal(spawned, 1); assert.equal(Atomics.load(shared, 0), 1);
    Atomics.store(shared, 1, 1); Atomics.notify(shared, 1);
    while (Atomics.load(shared, 3) !== 2 && Date.now() < deadline) await turn();
    assert.equal(Atomics.load(shared, 3), 2); await turn(); await turn();
    assert.equal(spawned, 1, "message/running state is not a settled worker");
    assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  } finally { Atomics.store(shared, 1, 2); Atomics.notify(shared, 1); await operation; }
  assert.equal(await operation, 3); assert.equal(spawned, groupNames.length);
  assert.equal(maximumActive, 1); assert.equal(active, 0);
  assert.ok(p.output.at(-1).groups.every((row) => row.outcome === "pending"));
});

test("real collection worker event loops overlap synchronous blocking tasks and drain before unlocking", async (t) => {
  for (const cancel of [false, true]) {
    const flags = {}, p = fixture(t, flags);
    await fleetMain(p.prepare(), p.deps); for (const group of groupNames) p.seed(group);
    const approved = await p.approve("--collect");
    const controls = new SharedArrayBuffer((3 + groupNames.length) * 4), shared = new Int32Array(controls);
    let spawned = 0;
    class SyntheticWorker extends Worker {
      constructor(url, options) {
        assert.ok(url.href.startsWith("data:text/javascript;base64,"));
        const slot = spawned++;
        super(new URL("./fleet-worker-fixture.mjs", import.meta.url), { ...options,
          resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
          workerData: { ...options.workerData, controls, slot, fleet: p.manifest(), group: groupNames[slot], uncertain: cancel && slot === 0, holdExit: !cancel } });
      }
    }
    delete p.deps.main; p.deps.WorkerClass = SyntheticWorker;
    let finished = false;
    const operation = fleetMain(approved, p.deps).then((code) => { finished = true; return code; });
    const result = cancel ? assert.rejects(operation, /cancelled/) : operation;
    const deadline = Date.now() + 15000;
    while (Atomics.load(shared, 0) < groupNames.length && Date.now() < deadline) await turn();
    assert.equal(Atomics.load(shared, 0), groupNames.length, "every real worker entered before any blocking task was released");
    assert.equal(Atomics.load(shared, 1), 0); assert.equal(finished, false);
    assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
    if (cancel) flags.cancelled = true;
    else {
      Atomics.store(shared, 1, 1); Atomics.notify(shared, 1);
      while (!groupNames.every((_, i) => Atomics.load(shared, 3 + i) === 2)) await turn();
      assert.equal(finished, false, "a result message is not worker settlement");
      assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
      Atomics.store(shared, 1, 2); Atomics.notify(shared, 1);
    }
    if (cancel) await result;
    else assert.equal(await result, 3);
    assert.equal(existsSync(join(p.h.base, ".fleet-operation.lock")), cancel);
    if (cancel) assert.equal(Atomics.load(shared, 2), groupNames.length, "shared cancellation reached every isolated worker");
  }
});

test("saved state changes invalidate collection approval before any child", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps); p.seed(groupNames[0]);
  const approved = await p.approve("--collect"); p.seed(groupNames[0], (s) => { s.id = "999"; });
  await assert.rejects(fleetMain(approved, p.deps)); assert.deepEqual(p.children, []);
});

test("physical aliases, links, hardlinks and overlap fail closed", async (t) => {
  for (const kind of ["manifest-hardlink", "child-alias", "root-retarget", "inside-repo", "live-lock"]) {
    const p = fixture(t); await fleetMain(p.prepare(), p.deps); const approved = await p.approve("--detach");
    if (kind === "manifest-hardlink") linkSync(join(p.h.base, "fleet-r21.json"), join(p.h.temp, "linked"));
    if (kind === "child-alias") symlinkSync(p.h.repo, join(p.h.base, groupNames[0]), process.platform === "win32" ? "junction" : "dir");
    if (kind === "root-retarget") { renameSync(p.h.base, `${p.h.base}-old`); symlinkSync(p.h.repo, p.h.base, process.platform === "win32" ? "junction" : "dir"); }
    if (kind === "inside-repo") approved[approved.indexOf("--fleet-root") + 1] = join(p.h.repo, "nested");
    if (kind === "live-lock") writeFileSync(join(p.h.base, ".fleet-operation.lock"), "synthetic-live");
    await assert.rejects(fleetMain(approved, p.deps)); assert.deepEqual(p.children, []);
  }
});

test("CLI cannot select groups, apps, commands, delivery, timing, tokens or child adapters", () => {
  const args = ["r21", "--fleet-root", resolve("outside"), "--collect"];
  for (const extra of [["--group", "json-api"], ["--apps", "corten"], ["--main", "evil"], ["--duration", "1"], ["--token", "f".repeat(16)],
    ["--deliver-audit", resolve("evil")], ["--detach"], ["--collect"], ["--commit", commit]]) assert.throws(() => parseFleetArgs([...args, ...extra]));
});

test("fixed worker rejects malformed messages/startup uncertainty without exposing raw errors", async () => {
  // This invokes only the fixed worker's argument guard, before productionMain.
  await assert.rejects(productionChild(["PRIVATE_ARGV_PROVIDER"], { cancellation: new SharedArrayBuffer(4) }), (error) => {
    assert.equal(error.message, "group-operation-failed"); assert.equal(error.controlUncertain, undefined); return true;
  });
  class BrokenWorker { constructor() { throw new Error("PRIVATE_ARGV_PROVIDER"); } }
  await assert.rejects(productionChild([], { cancellation: new SharedArrayBuffer(4), WorkerClass: BrokenWorker }), (error) => {
    assert.equal(error.message, "group-control-uncertain"); assert.equal(error.controlUncertain, true); return true;
  });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fleet.mjs", import.meta.url)), "PRIVATE_ARGV_PROVIDER"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.equal(result.stderr.trim(), "fleet-operation-failed");
});

test("production snapshot bootstrap executes captured entry/closure bytes and denies unlisted imports before evaluation", async (t) => {
  for (const change of ["positive", "entry", "production-dependency", "unlisted", "url-mismatch"]) {
    const p = fixture(t); await fleetMain(p.prepare(), p.deps);
    const root = join(p.h.temp, "snapshot"), marker = join(p.h.temp, "PRIVATE_MARKER");
    const module = `import {parseDropletArgs} from './cloud-options.mjs';
      export function parseProductionArgs(args) { const at=args.indexOf('--approve-reviewed-merged-ready');
        return {options:parseDropletArgs(args.slice(0,at)),approval:args[at+1],preview:false}; }
      export async function productionMain() { return 3; }`;
    const sources = fleetWorkerPaths.map((path) => {
      const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
      const source = path === "bench/workloads/cloud-production.mjs" ? module : readFileSync(resolve(path), "utf8");
      writeFileSync(target, source);
      return { path, url: pathToFileURL(target).href, sha256: digest(source), source };
    });
    if (change === "unlisted") {
      const dependency = sources.find((s) => s.path === "bench/workloads/cloud-production.mjs");
      dependency.source = `import './unlisted.mjs';\n${dependency.source}`; dependency.sha256 = digest(dependency.source);
      writeFileSync(join(root, "bench/workloads/unlisted.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'unsafe');`);
    }
    if (change === "url-mismatch") sources.find((s) => s.path === "bench/workloads/cloud-production.mjs").url = pathToFileURL(join(root, "foreign.mjs")).href;
    class ReplaceAfterCapture extends Worker {
      constructor(bootstrap, options) {
        assert.ok(bootstrap.href.startsWith("data:text/javascript;base64,"));
        if (["entry", "production-dependency"].includes(change)) {
          const path = join(root, "bench/workloads", change === "entry" ? "fleet-worker.mjs" : "cloud-production.mjs");
          writeFileSync(path, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'unsafe'); throw new Error('PRIVATE');`);
        }
        super(bootstrap, options);
      }
    }
    const group = groupNames[0], args = ["r21", "--state-dir", join(p.h.base, group), "--detach", "--commit", commit, "--ssh-key", "42",
      "--account-id", accountId, "--context", context, "--group", group, "--fleet", join(p.h.base, "fleet-r21.json"), "--approve-reviewed-merged-ready", "f".repeat(64)];
    const operation = productionChild(args, { cancellation: new SharedArrayBuffer(4), sources, WorkerClass: ReplaceAfterCapture });
    if (change === "unlisted") await assert.rejects(operation, /group-bootstrap-invalid/);
    else if (change === "url-mismatch") await assert.rejects(operation, /group-control-uncertain/);
    else assert.equal(await operation, 3);
    assert.ok(!existsSync(marker), `${change}: mutable source must never evaluate`);
  }
});

function capturedFailure(t, body, WorkerClass = Worker) {
  const h = harness(t), root = join(h.temp, "failure-snapshot");
  const module = `import {parseDropletArgs} from './cloud-options.mjs';
    export function parseProductionArgs(args) { const at=args.indexOf('--approve-reviewed-merged-ready');
      return {options:parseDropletArgs(args.slice(0,at)),approval:args[at+1],preview:false}; }
    export async function productionMain() { ${body} }`;
  const sources = fleetWorkerPaths.map((path) => {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
    const source = path === "bench/workloads/cloud-production.mjs" ? module : readFileSync(resolve(path), "utf8");
    writeFileSync(target, source);
    return { path, url: pathToFileURL(target).href, sha256: digest(source), source };
  });
  class BoundedWorker extends WorkerClass {
    constructor(entry, options) {
      super(entry, { ...options, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
    }
  }
  const group = groupNames[0], args = ["r21", "--state-dir", join(h.base, group), "--detach", "--commit", commit, "--ssh-key", "42",
    "--account-id", accountId, "--context", context, "--group", group, "--fleet", join(h.base, "fleet-r21.json"), "--approve-reviewed-merged-ready", "f".repeat(64)];
  return productionChild(args, { cancellation: new SharedArrayBuffer(4), sources, WorkerClass: BoundedWorker });
}

test("captured worker preserves only sanitized provider diagnostics and explicit uncertainty", async (t) => {
  for (const diagnostic of [{ code: "list-http", httpStatus: 429 },
    ...["shape", "total", "id", "duplicate", "links", "pages", "next", "count", "bounds"].map((predicate) => ({ code: `list-response-${predicate}` })),
    ...["shape", "count", "id", "rel", "href"].map((predicate) => ({ code: `create-link-${predicate}` }))]) {
    for (const uncertain of [false, true]) {
      await assert.rejects(capturedFailure(t, `throw Object.assign(new Error('PRIVATE_MESSAGE_TOKEN'), {
        providerDiagnostic:${JSON.stringify(diagnostic)}, controlUncertain:${uncertain}});`), (error) => {
        assert.deepEqual(error.providerDiagnostic, diagnostic, "captured provider diagnostic must survive");
        assert.equal(error.controlUncertain === true, uncertain);
        assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes("PRIVATE_MESSAGE_TOKEN"));
        return true;
      });
    }
  }
});

test("captured worker omits malformed diagnostics and never invokes diagnostic accessors", async (t) => {
  for (const field of ["{code:'PRIVATE_CODE'}", "{code:'list-http',httpStatus:418}", "{code:'list-http',httpStatus:429,raw:'PRIVATE_RAW'}"]) {
    await assert.rejects(capturedFailure(t, `throw Object.assign(new Error('PRIVATE_MESSAGE'),{providerDiagnostic:${field}});`), (error) => {
      assert.equal(error.message, "group-operation-failed"); assert.equal(error.providerDiagnostic, undefined);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes("PRIVATE")); return true;
    });
  }
  await assert.rejects(capturedFailure(t, `const error=new Error('PRIVATE_MESSAGE');
    Object.defineProperty(error,'providerDiagnostic',{get(){throw new Error('PRIVATE_GETTER');}}); throw error;`), (error) => {
    assert.equal(error.message, "group-operation-failed"); assert.equal(error.providerDiagnostic, undefined); return true;
  });
});

test("worker protocol rejects malformed diagnostics, unexpected fields and unsettled results", async (t) => {
  const base = { schema: "benchmark-group-fleet-worker-result/v1", error: "group-operation-failed", uncertain: false };
  for (const [message, exit, count] of [
    [{ ...base, providerDiagnostic: { code: "PRIVATE_CODE" } }, 0, 1],
    [{ ...base, providerDiagnostic: { code: "list-http", httpStatus: 429, raw: "PRIVATE" } }, 0, 1],
    [{ ...base, extra: "PRIVATE" }, 0, 1],
    [{ schema: base.schema, code: 3, providerDiagnostic: { code: "list-http", httpStatus: 429 } }, 0, 1],
    [{ ...base, providerDiagnostic: { code: "list-http", httpStatus: 429 } }, 1, 1],
    [{ ...base, providerDiagnostic: { code: "list-http", httpStatus: 429 } }, 0, 2],
  ]) {
    class ProtocolWorker extends EventEmitter {
      constructor() {
        super(); this.stdout = this.stderr = { resume() {} };
        queueMicrotask(() => { for (let i = 0; i < count; i++) this.emit("message", message); this.emit("exit", exit); });
      }
    }
    await assert.rejects(capturedFailure(t, "return 3;", ProtocolWorker), (error) => {
      assert.equal(error.message, "group-control-uncertain"); assert.equal(error.controlUncertain, true);
      assert.equal(error.providerDiagnostic, undefined); return true;
    });
  }
});

test("fleet receipts retain sanitized provider failure and uncertainty without replay", async (t) => {
  const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
  for (const group of groupNames) p.seed(group); const approved = await p.approve("--collect");
  const codes = ["create-request", ...["shape", "count", "id", "rel", "href"].map((predicate) => `create-link-${predicate}`)];
  flags.child = ({ group }) => { throw Object.assign(new Error("PRIVATE_PROVIDER_TOKEN"), {
    controlTreeUncertain: true, providerDiagnostic: { code: codes[groupNames.indexOf(group) % codes.length] } }); };
  assert.equal(await fleetMain(approved, p.deps), 2);
  const result = p.output.at(-1);
  assert.equal(result.fullGroupQualified, false); assert.equal(result.groups.length, groupNames.length);
  for (const row of result.groups) {
    assert.equal(row.outcome, "error"); assert.equal(row.error, "group-operation-failed");
    assert.equal(row.uncertain, true, "fleet receipt must retain uncertainty");
    assert.equal(row.providerDiagnostic?.code, codes[groupNames.indexOf(row.group) % codes.length]); assert.equal(row.id, String(groupNames.indexOf(row.group) + 1));
    const name = readdirSync(join(p.h.base, "receipts")).find((name) => name.endsWith(`-${row.group}.json`));
    assert.ok(isDeepStrictEqual(JSON.parse(readFileSync(join(p.h.base, "receipts", name), "utf8")), row), "saved receipt must match public row");
  }
  assert.ok(!JSON.stringify(p.output).includes("PRIVATE_PROVIDER_TOKEN"));
  assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  await assert.rejects(fleetMain(approved, p.deps), /fleet-exact-approval-required/);
  await assert.rejects(fleetMain(await p.approve("--collect"), p.deps), /EEXIST/);
});

test("fleet receipts retain all closed census predicates without replay", async (t) => {
  const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
  for (const group of groupNames) p.seed(group); const approved = await p.approve("--collect");
  const codes = ["shape", "total", "id", "duplicate", "links", "pages", "next", "count", "bounds"].map((predicate) => `list-response-${predicate}`);
  flags.child = ({ group }) => { throw Object.assign(new Error("PRIVATE_PROVIDER_TOKEN"), {
    controlTreeUncertain: true, providerDiagnostic: { code: codes[groupNames.indexOf(group) % codes.length] } }); };
  assert.equal(await fleetMain(approved, p.deps), 2);
  const result = p.output.at(-1); assert.equal(result.fullGroupQualified, false); assert.equal(result.groups.length, groupNames.length);
  for (const row of result.groups) {
    assert.equal(row.error, "group-operation-failed"); assert.equal(row.outcome, "error"); assert.equal(row.uncertain, true);
    assert.deepEqual(row.providerDiagnostic, { code: codes[groupNames.indexOf(row.group) % codes.length] }); assert.equal(row.id, String(groupNames.indexOf(row.group) + 1));
    const name = readdirSync(join(p.h.base, "receipts")).find((name) => name.endsWith(`-${row.group}.json`));
    assert.ok(isDeepStrictEqual(JSON.parse(readFileSync(join(p.h.base, "receipts", name), "utf8")), row));
  }
  assert.ok(!JSON.stringify(p.output).includes("PRIVATE_PROVIDER_TOKEN")); assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  await assert.rejects(fleetMain(approved, p.deps), /fleet-exact-approval-required/);
  await assert.rejects(fleetMain(await p.approve("--collect"), p.deps), /EEXIST/);
});

test("fleet receipt sanitizer rejects raw fields and accessors without changing failure outcomes", async (t) => {
  const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
  for (const group of groupNames) p.seed(group); const approved = await p.approve("--collect");
  const diagnostics = [{ code: "account-http", httpStatus: 403 }, { code: "PRIVATE_CODE" },
    { code: "list-http", httpStatus: 418 }, { code: "list-request", raw: "PRIVATE_RAW" }, undefined];
  flags.child = ({ group }) => {
    const i = groupNames.indexOf(group), error = Object.assign(new Error("PRIVATE_MESSAGE"), { providerDiagnostic: diagnostics[i % diagnostics.length] });
    if (i === 5) Object.defineProperty(error, "providerDiagnostic", { get() { throw new Error("PRIVATE_GETTER"); } });
    throw error;
  };
  assert.equal(await fleetMain(approved, p.deps), 2);
  for (const [i, row] of p.output.at(-1).groups.entries()) {
    assert.equal(row.error, "group-operation-failed"); assert.equal(row.outcome, "error"); assert.equal(row.uncertain, false);
    if (i === 0) { assert.equal(row.providerDiagnostic?.code, "account-http"); assert.equal(row.providerDiagnostic?.httpStatus, 403); }
    else assert.equal(row.providerDiagnostic, undefined);
  }
  assert.ok(!JSON.stringify(p.output).includes("PRIVATE"));
  assert.ok(!existsSync(join(p.h.base, ".fleet-operation.lock")));
  await assert.rejects(fleetMain(approved, p.deps), /fleet-exact-approval-required/);
});
