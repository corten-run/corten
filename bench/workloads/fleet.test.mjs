// Synthetic orchestration only: no provider, credentials, SSH or native benchmark.
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { accountId, archive, commit, context, harness, syntheticInspection } from "./cloud-fixtures.mjs";
import { fleetMain, fleetWorkerPaths, parseFleetArgs, productionChild, stagedChildIntent, watchSupervisedHost } from "./fleet.mjs";
import { fleetPlan, reservation, savedLoadLayout, tags } from "./cloud-contract.mjs";
import { digest, fileHash, treeHash } from "./cloud-local.mjs";
import { parseProductionArgs, productionMain, productionPlan } from "./cloud-production.mjs";
import { readFleet, verifyCollectedGroup } from "./fleet-verify.mjs";
import { localCompilerMissing } from "./cloud-validation-snapshot.mjs";
import { groupNames } from "./registry.mjs";
import { controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { registration } from "./test-fixtures/control-stream-fixture.mjs";

// The fake committed tree is fixed for this process, like the captured loader.
// Concurrent worktree edits are not changes to that synthetic Git object.
const committedSources = new Map(fleetWorkerPaths.map((path) => [path, readFileSync(resolve(path), "utf8").replaceAll("\r\n", "\n")]));

function fixture(t, flags = {}) {
  const h = harness(t), output = [], calls = [], children = [], completions = [];
  let firstReport, firstJob;
  const args = (mode) => ["r21", "--fleet-root", flags.root ?? h.base, mode];
  const prepare = () => [...args("--prepare"), "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  const spawn = (binary, argv) => {
    calls.push([binary, argv]); assert.equal(binary, "git", "synthetic local boundary only");
    if (argv[0] === "show") return { status: 0, stdout: flags.wrongSource ? "wrong" : committedSources.get(argv[1].slice(41)) };
    if (argv[0] === "status" && flags.dirty) return { status: 0, stdout: " M synthetic" };
    if (argv[0] === "fetch" && flags.fetchError) return { status: 1, stdout: "", stderr: "PRIVATE_FETCH_ARGV" };
    return h.run(binary, argv, 60000);
  };
  const deps = { repo: h.repo, spawn, interrupted: () => !!flags.cancelled, write: (value) => output.push(JSON.parse(value)),
    main: async (argv, { onReady }) => {
      const { options, approval } = parseProductionArgs(argv), group = options.group ?? groupNames.find((g) => options.stateDir === join(h.base, g));
      children.push(group); assert.ok(approval);
      if (flags.child) return flags.child({ options, group, approval, onReady });
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
    if (i > 0 && existsSync(join(h.base, "remaining-intent.json"))) {
      const binding = { round: state.round, commit, token: state.token, helperSha256: guardianSha256 };
      const reg = { ...registration, binding, id: state.token.repeat(2) };
      state.control = { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: ["bootstrap"],
        monitor: { schema: "benchmark-supervised-control/v1", id: reg.id, phase: "closed", registrationSha256: digest(JSON.stringify(reg)) } };
      const start = controlRequest(state, "ssh", [`systemctl start ${state.unit}`], 60000, "bootstrap");
      state.control.ledger.push({ request: start, localTerminal: true, code: 0 });
      state.control.ledger.push({ request: controlRequest(state, "ssh", [":"], 60000, "bootstrap", [start.invocation]), localTerminal: true, code: 0 });
      writeFileSync(join(local, "monitor-registration.json"), JSON.stringify(reg));
      const closedAtMs = Date.now(), terminal = { id: reg.id, binding, nativeTerminal: true, localClosed: true, remoteDrained: false,
        campaign: `r21-${state.token}`, sealSha256: digest("synthetic native seal") };
      writeFileSync(join(local, "monitor-terminal.json"), JSON.stringify(terminal));
      writeFileSync(join(local, "monitor-local-closed.json"), JSON.stringify({ ...terminal, code: 0, signal: null, closedAtMs, recoverAfterMs: closedAtMs + 30000 }));
    }
    change(state); writeFileSync(join(local, "state.json"), JSON.stringify(state)); return state;
  }
  async function approve(mode) {
    assert.equal(await fleetMain([...args(mode), "--print-approval"], deps), 3);
    return [...args(mode), "--approve-reviewed-merged-ready", output.at(-1).approvalSha256];
  }
  // Code-only stand-in for the native replay worker, using the real shared
  // snapshot/provenance checks. These synthetic tests confer no native authority.
  deps.verify = async (fleet, group, { interrupted }) => {
    const proof = await verifyCollectedGroup(fleet, group, { inspect: async () => firstReport, interrupted });
    return { ...proof, evidenceMode: "native-replay" };
  };
  function finishFirst() {
    const group = groupNames[0], state = seed(group), local = join(h.base, group, "groups-r21");
    const evidence = join(local, "evidence-Synthetic"), folder = join(evidence, "campaign"), campaign = `r21-${state.token}`;
    const report = syntheticInspection("verified");
    Object.assign(report, { schema: "benchmark-isolated-group-campaign-inspection/v1", campaign,
      selection: state.selection, groups: report.groups.filter((g) => g.group === group), loadLayout: savedLoadLayout(state) });
    mkdirSync(join(folder, campaign), { recursive: true });
    writeFileSync(join(folder, ".host-attempt.json"), JSON.stringify({ id: campaign, commit, campaignSha256: report.campaignSha256 }));
    report.reservationSha256 = fileHash(join(folder, ".host-attempt.json"));
    writeFileSync(join(folder, campaign, "plan.json"), JSON.stringify({ round: "r21", commit, campaignSha256: report.campaignSha256, sourceSha256: report.sourceSha256 }));
    writeFileSync(join(evidence, "exit-code"), "0\n"); writeFileSync(join(evidence, "host.txt"), "synthetic, not measured\n");
    writeFileSync(join(local, "results.tgz"), archive([{ name: "campaign/" }]));
    Object.assign(state, { status: "collected", collectedAt: "2026-11-14T02:00:00.000Z", deletionIntentAt: "2026-11-14T02:01:00.000Z",
      destroyedAt: "2026-11-14T02:02:00.000Z", archiveSha256: fileHash(join(local, "results.tgz")), evidence: "evidence-Synthetic",
      extractionAttempts: ["evidence-Synthetic"], evidenceSha256: treeHash(evidence), evidenceOutcome: "validated", exitCode: 0,
      validation: { status: "verified", campaign, collectionIntegrity: "manifest-verified" } });
    const path = join(local, "state.json"), save = () => writeFileSync(path, JSON.stringify(state)); save(); firstReport = report;
    firstJob = { state, local, evidence, folder, path, report, save, rehash() { state.evidenceSha256 = treeHash(evidence); save(); } };
    return firstJob;
  }
  async function remaining() {
    await fleetMain(prepare(), deps); await fleetMain(await approve("--detach"), deps); finishFirst();
    children.length = 0; completions.length = 0;
    return approve("--admit-remaining");
  }
  return { h, flags, args, prepare, deps, output, calls, children, completions, manifest, seed, approve, finishFirst, remaining,
    get first() { return firstJob; } };
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

test("historical roster is inspectable but never opens either fleet launch stage", async (t) => {
  const p = fixture(t);
  const { fleet } = JSON.parse(readFileSync(new URL("./test-fixtures/grouped-sfo2-reservation.json", import.meta.url)));
  const { fleetSha256, ...body } = fleet;
  // Match the fake checkout so the launch refusal cannot come from ancestry.
  body.commit = commit;
  const bytes = JSON.stringify({ ...body, fleetSha256: digest(JSON.stringify(body)) });
  const path = join(p.h.base, "fleet-r21.json");
  writeFileSync(path, bytes);
  assert.equal(p.manifest().host.region, "sfo2");
  for (const mode of ["--detach", "--admit-remaining"])
    await assert.rejects(p.approve(mode), /historical fleet cannot authorize launch/);
  assert.deepEqual(p.children, []);
  assert.deepEqual(readdirSync(p.h.base), ["fleet-r21.json"]);
  assert.equal(readFileSync(path, "utf8"), bytes);
});

test("detach launches only the first whole group, even after its bootstrap settles", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps);
  assert.equal(await fleetMain(await p.approve("--detach"), p.deps), 3);
  assert.equal(p.children.length, 1, "bootstrap alone must not allocate the remaining official hosts");
  assert.equal(p.children[0], groupNames[0]);
  assert.equal(p.manifest().jobs.length, groupNames.length);
  assert.ok(groupNames.slice(1).every((g) => !existsSync(join(p.h.base, g))));
});

test("preview binds complete membership but only the first executable subject", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps);
  const before = readFileSync(join(p.h.base, "fleet-r21.json"));
  await p.approve("--detach"); const preview = p.output.at(-1);
  assert.equal(preview.subject.jobs.length, groupNames.length);
  for (const job of preview.subject.jobs.filter((j) => j.outcome === "planned")) {
    assert.equal(job.approvalSha256, digest(JSON.stringify(job.subject)));
    assert.equal(job.subject.stateRoot, join(p.h.base, job.group));
    assert.equal(job.subject.fleetSha256, digest(before));
  }
  assert.equal(preview.subject.jobs.filter((j) => j.outcome === "planned").length, 1);
  assert.ok(preview.subject.jobs.slice(1).every((j) => j.outcome === "deferred" && !j.subject));
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
  assert.equal(JSON.parse(readFileSync(join(p.h.base, "launch-intent.json"))).subject.jobs.length, groupNames.length);
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

test("separately approved remaining admission waits for proof or confirmed settlement, not bare running state", async (t) => {
  const flags = {}, p = fixture(t, flags), pending = [];
  const approved = await p.remaining();
  const preview = p.output.at(-1);
  assert.deepEqual(preview.subject.admission, { mode: "remaining-once", firstGroup: groupNames[0], gate: "collected-verified-deleted", nativeReadiness: false });
  flags.child = ({ group, options, approval }) => new Promise((resolve) => {
    assert.equal(approval, preview.subject.jobs.find((j) => j.group === group).approvalSha256);
    assert.equal(options.stateDir, join(p.h.base, group));
    pending.push({ group, resolve });
  });
  let finished = false;
  const operation = fleetMain(approved, p.deps).then((code) => { finished = true; return code; });
  for (const [i, group] of groupNames.slice(1).entries()) {
    while (pending.length <= i) await turn();
    assert.equal(pending.length, i + 1); assert.equal(pending[i].group, group);
    p.seed(group, (s) => { delete s.control; }); await delay(150);
    assert.equal(pending.length, i + 1, "bare running state is not admission proof");
    assert.equal(finished, false); assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
    p.seed(group); p.completions.push(group); pending[i].resolve(3);
  }
  assert.equal(await operation, 3); assert.deepEqual(p.children, groupNames.slice(1));
  assert.deepEqual(p.completions, groupNames.slice(1));
  assert.equal(p.output.at(-1).groups[0].outcome, "verified");
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "pending"));
  assert.equal(p.output.at(-1).fullGroupQualified, false);
  assert.ok(!existsSync(join(p.h.base, ".fleet-operation.lock")));
});

test("later admission failure preserves running siblings and never admits the remaining roster", async (t) => {
  for (const uncertain of [false, true]) {
    const flags = {}, p = fixture(t, flags);
    const approved = await p.remaining();
    flags.child = ({ group }) => {
      if (group === groupNames[2]) throw Object.assign(new Error("PRIVATE_LATE_CREATE"), { controlUncertain: uncertain });
      p.seed(group); return 3;
    };
    assert.equal(await fleetMain(approved, p.deps), 2);
    assert.deepEqual(p.children, groupNames.slice(1, 3));
    const rows = p.output.at(-1).groups;
    assert.equal(rows[0].outcome, "verified"); assert.equal(rows[1].outcome, "pending");
    assert.equal(rows[2].outcome, "error");
    assert.ok(rows.slice(3).every((row) => row.outcome === "not-admitted"));
    assert.equal(JSON.parse(readFileSync(join(p.h.base, groupNames[1], "groups-r21/state.json"))).status, "running");
    assert.equal(existsSync(join(p.h.base, ".fleet-operation.lock")), uncertain);
  }
});

function heldHost(p, options, onReady) {
  const stop = watchSupervisedHost(options, onReady);
  const local = join(options.stateDir, "groups-r21"), state = p.seed(options.group, (s) => { s.control.monitor.phase = "live"; });
  const locks = [join(local, "operation.lock"), join(options.stateDir, ".groups-launch.lock")];
  for (const lock of locks) writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  for (const name of ["monitor-terminal.json", "monitor-local-closed.json"]) unlinkSync(join(local, name));
  const done = Promise.withResolvers();
  return { done: done.promise, locks, state, close(error) {
    stop();
    if (error) { done.reject(error); return; }
    for (const lock of locks) unlinkSync(lock);
    p.seed(options.group); done.resolve(3);
  } };
}

test("live registration alone cannot advance an unsealed or misbound host", async (t) => {
  const p = fixture(t), approved = await p.remaining(), waiting = Promise.withResolvers();
  const [a, b] = groupNames.slice(1);
  let monitor;
  p.flags.child = ({ group, options, onReady }) => {
    if (group === b) throw new Error("stop after observed admission");
    assert.equal(group, a); monitor = heldHost(p, options, onReady);
    const state = monitor.state, file = join(options.stateDir, "groups-r21/state.json"), save = () => writeFileSync(file, JSON.stringify(state));
    state.control.sealed = []; save(); waiting.resolve(save); return monitor.done;
  };
  const operation = fleetMain(approved, p.deps);
  const save = await waiting.promise, state = monitor.state;
  try {
    await delay(220); assert.deepEqual(p.children, [a]);
    const hash = state.control.monitor.registrationSha256;
    state.control.sealed = ["bootstrap"]; state.control.monitor.registrationSha256 = "0".repeat(64); save();
    await delay(220); assert.deepEqual(p.children, [a]);
    state.control.monitor.registrationSha256 = hash; save();
    const deadline = Date.now() + 3000;
    while (p.children.length < 2) { assert.ok(Date.now() < deadline); await delay(10); }
    assert.deepEqual(p.children, [a, b]); assert.ok(monitor.locks.every(existsSync));
  } finally { monitor.close(); await operation; }
  assert.equal(await operation, 2);
});

test("a finished child can be collected with its own approval while a sibling keeps monitor custody", async (t) => {
  const p = fixture(t), approved = await p.remaining();
  const [held, finished, refused] = groupNames.slice(1), local = join(p.h.base, finished, "groups-r21");
  const statePath = join(local, "state.json"), saved = () => JSON.parse(readFileSync(statePath));
  let monitor, removed = 0;
  p.flags.child = ({ group, options, onReady }) => {
    if (group === held) { monitor = heldHost(p, options, onReady); return monitor.done; }
    if (group === refused) throw new Error("synthetic later refusal");
    assert.equal(group, finished); p.seed(group); return 3;
  };
  const operation = fleetMain(approved, p.deps);
  try {
    const deadline = Date.now() + 5000;
    while (!p.output.some((row) => row.group === refused && row.outcome === "error")) { assert.ok(Date.now() < deadline); await delay(10); }
    assert.ok(p.output.some((row) => row.group === finished && row.outcome === "pending" && row.collection === "separate-child-approval-required"));
    const collect = ["r21", "--state-dir", dirname(local), "--collect"], state = saved();
    const report = syntheticInspection("verified");
    Object.assign(report, { schema: "benchmark-isolated-group-campaign-inspection/v1", selection: state.selection,
      campaign: `r21-${state.token}`, groups: report.groups.filter((g) => g.group === finished),
      supervisedTerminal: { registrationSha256: state.control.monitor.registrationSha256, sealSha256: digest("synthetic native seal") } });
    const result = (stdout) => ({ status: 0, stdout, stderr: "" });
    const opts = { repo: p.h.repo, write() {}, inspect: async () => report, spawn(binary, args, options) {
      if (binary === "git") return p.deps.spawn(binary, args);
      assert.equal(binary, "ssh");
      const idle = options.input.includes("CORTEN_IDLE");
      assert.ok(idle || options.input.includes("systemctl show " + state.unit));
      const id = saved().control.ledger.at(-1).request.invocation.id;
      return { ...result(idle ? `${state.archiveSha256}  /bench/results.tgz\n`
        : `Id=${state.unit}\nLoadState=loaded\nFragmentPath=/etc/systemd/system/${state.unit}\nRestart=no\nActiveState=inactive\nMainPID=0\nControlPID=0\nJob=\nSubState=dead\nExecMainCode=0\nExecMainStartTimestamp=\n`),
        stderr: `CORTEN_CONTROL ${id} ${"d".repeat(64)}\nCORTEN_RESULT ${id} 0\n` };
    }, providerFactory: () => Object.assign(async (args, timeout) => {
      if (args[2] !== "delete") return p.h.run("doctl", args, timeout);
      assert.equal(args[3], state.id); assert.ok(saved().deletionIntentAt); removed++; p.h.hosts([]); return result("");
    }, { close: async () => {} }) };
    p.h.hosts([{ id: Number(state.id), name: state.name, tags: [...tags, state.tag], size_slug: state.host.size,
      region: { slug: state.host.region }, networks: { v4: [{ type: "public", ip_address: state.ip }] } }]);
    // Fixture resumes from an already downloaded, hashed archive after the
    // standard recovery lease. Production still extracts, validates and deletes.
    const bytes = archive([{ name: "run.log" }, { name: "host.txt" }, { name: "exit-code", body: "0\n" }, { name: "campaign/" }]);
    writeFileSync(join(local, "results.tgz"), bytes); state.archiveSha256 = digest(bytes); writeFileSync(statePath, JSON.stringify(state));
    const closed = join(local, "monitor-local-closed.json"), receipt = JSON.parse(readFileSync(closed));
    receipt.closedAtMs -= 60000; receipt.recoverAfterMs -= 60000; writeFileSync(closed, JSON.stringify(receipt));
    await assert.rejects(productionMain([...collect, "--approve-reviewed-merged-ready", approved.at(-1)], opts), /exact action required/);
    const plan = await productionPlan(parseProductionArgs(collect).options, { repo: p.h.repo, run: p.deps.spawn });
    assert.equal(await productionMain([...collect, "--approve-reviewed-merged-ready", plan.approvalSha256], opts), 0);
    assert.ok(saved().destroyedAt); assert.equal(removed, 1); assert.ok(monitor.locks.every(existsSync));
    assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
  } finally { monitor?.close(); await operation; }
  assert.equal(await operation, 2); assert.deepEqual(p.children, [held, finished, refused]);
  assert.ok(!existsSync(join(p.h.base, ".fleet-operation.lock")));
});

test("late monitor failure or cancellation stops new groups and still settles the second worker", async (t) => {
  for (const cancel of [false, true]) {
    const p = fixture(t), approved = await p.remaining(), second = Promise.withResolvers();
    let monitor, opened = false;
    const [a, b] = groupNames.slice(1);
    p.flags.child = ({ group, options, onReady }) => {
      if (group === a) { monitor = heldHost(p, options, onReady); return monitor.done; }
      assert.equal(group, b); p.seed(b); opened = true; return second.promise;
    };
    const operation = fleetMain(approved, p.deps);
    const outcome = cancel ? assert.rejects(operation, /cancelled/) : operation;
    try {
      const deadline = Date.now() + 5000;
      while (!opened) { assert.ok(Date.now() < deadline); await delay(10); }
      if (cancel) { p.flags.cancelled = true; monitor.close(); }
      else monitor.close(Object.assign(new Error("synthetic stream lost"), { controlTreeUncertain: true }));
      while (!p.output.some((row) => row.group === a && ["pending", "error"].includes(row.outcome))) {
        assert.ok(Date.now() < deadline); await delay(10);
      }
      assert.ok(existsSync(join(p.h.base, ".fleet-operation.lock")));
    } finally { second.resolve(3); }
    const result = await outcome;
    if (!cancel) assert.equal(result, 2);
    assert.deepEqual(p.children, [a, b]);
    assert.ok(p.output.some((row) => row.group === b && row.outcome === "pending"));
    for (const group of groupNames.slice(3)) assert.ok(p.output.some((row) => row.group === group &&
      row.reason === (cancel ? "cancelled" : "prior-admission-failed")));
    assert.equal(existsSync(join(p.h.base, ".fleet-operation.lock")), !cancel);
  }
});

test("detach refuses a return code without valid running unique host state", async (t) => {
  for (const kind of ["missing", "preparing", "locked", "code0", "code1", "duplicate-id", "duplicate-ip", "no-seal", "registration", "revoked"]) {
    const flags = {}, p = fixture(t, flags);
    const approved = await p.remaining();
    flags.child = ({ group }) => {
      if (group !== groupNames[1]) { p.seed(group); return 3; }
      if (kind !== "missing") p.seed(group, (s) => {
        if (kind === "preparing") s.status = "preparing";
        if (kind === "duplicate-id") s.id = "1";
        if (kind === "duplicate-ip") s.ip = "192.0.2.1";
        if (kind === "no-seal") s.control.sealed = [];
        if (kind === "registration") s.control.monitor.registrationSha256 = "0".repeat(64);
      });
      if (kind === "locked") writeFileSync(join(p.h.base, group, "groups-r21/operation.lock"), "synthetic-unsettled");
      if (kind === "revoked") writeFileSync(join(p.h.base, group, "groups-r21/monitor-invalid.json"), "{}");
      return kind === "code0" ? 0 : kind === "code1" ? 1 : 3;
    };
    assert.equal(await fleetMain(approved, p.deps), 2);
    assert.deepEqual(p.children, groupNames.slice(1, 2));
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

test("first-stage collection keeps untouched groups visibly deferred, not failed or qualified", async (t) => {
  const p = fixture(t); await fleetMain(p.prepare(), p.deps);
  await fleetMain(await p.approve("--detach"), p.deps); p.finishFirst(); p.children.length = 0;
  const approved = await p.approve("--collect"), preview = p.output.at(-1);
  assert.equal(preview.subject.jobs.length, groupNames.length);
  assert.ok(preview.subject.jobs.slice(1).every((job) => job.outcome === "deferred" && !job.options));
  p.flags.child = async () => 0;
  assert.equal(await fleetMain(approved, p.deps), 3);
  assert.deepEqual(p.children, [groupNames[0]]);
  assert.equal(p.output.at(-1).groups[0].outcome, "collected");
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "deferred" && !row.error));
  assert.equal(p.output.at(-1).fullGroupQualified, false);
});

test("bootstrap or a legacy consumed launch can never authorize remaining allocation", async (t) => {
  for (const legacy of [false, true]) {
    const p = fixture(t); await fleetMain(p.prepare(), p.deps);
    await fleetMain(await p.approve("--detach"), p.deps);
    if (legacy) {
      p.finishFirst();
      const intent = join(p.h.base, "launch-intent.json");
      writeFileSync(intent, JSON.stringify({ schema: "benchmark-group-fleet-launch-intent/v1", children: groupNames }));
    }
    await assert.rejects(p.approve("--admit-remaining"));
    assert.equal(p.children.length, 1); assert.ok(!existsSync(join(p.h.base, "remaining-intent.json")));
    // Historical manifests/intents do not lose collection support.
    assert.equal(await fleetMain([...p.args("--collect"), "--print-approval"], p.deps), 3);
  }
});

test("junction-root remaining admission binds physical identity through either path and remains once-only", async (t) => {
  for (const canonical of [false, true]) {
    const p = fixture(t), alias = join(p.h.temp, "fleet-alias");
    symlinkSync(p.h.base, alias, process.platform === "win32" ? "junction" : "dir"); p.flags.root = alias;
    assert.equal(realpathSync(alias), p.h.base);
    await fleetMain(p.prepare(), p.deps);
    const initial = await p.approve("--detach"), subject = p.output.at(-1).subject;
    assert.equal(subject.requestedRoot, alias); assert.equal(subject.stateRoot, p.h.base);
    assert.equal(await fleetMain(initial, p.deps), 3); assert.deepEqual(p.children, [groupNames[0]]);
    p.finishFirst(); p.children.length = 0;
    const intentPath = join(p.h.base, "launch-intent.json"), intent = readFileSync(intentPath, "utf8");
    const aliasApproval = await p.approve("--admit-remaining");
    p.flags.root = p.h.base; const physicalApproval = await p.approve("--admit-remaining");
    assert.notEqual(aliasApproval.at(-1), physicalApproval.at(-1), "each invocation retains its exact requested path binding");
    await assert.rejects(fleetMain([...physicalApproval.slice(0, -1), aliasApproval.at(-1)], p.deps), /fleet-exact-approval-required/);
    assert.equal(p.children.length, 0); assert.ok(!existsSync(join(p.h.base, "remaining-intent.json")));
    assert.equal(await fleetMain(canonical ? physicalApproval : aliasApproval, p.deps), 3);
    assert.deepEqual(p.children, groupNames.slice(1));
    for (const root of [alias, p.h.base]) {
      p.flags.root = root;
      await assert.rejects(p.approve("--admit-remaining"), /remaining-already-attempted/);
    }
    assert.equal(readFileSync(intentPath, "utf8"), intent, "consumed initial intent is not rewritten");
    assert.equal(p.children.length, groupNames.length - 1);
  }
});

test("junction-root first-stage collection keeps untouched children deferred via alias or physical path", async (t) => {
  const p = fixture(t), alias = join(p.h.temp, "fleet-alias");
  symlinkSync(p.h.base, alias, process.platform === "win32" ? "junction" : "dir"); p.flags.root = alias;
  await fleetMain(p.prepare(), p.deps); await fleetMain(await p.approve("--detach"), p.deps); p.finishFirst();
  const intentPath = join(p.h.base, "launch-intent.json"), intent = readFileSync(intentPath, "utf8");
  for (const root of [alias, p.h.base]) {
    p.flags.root = root; const approved = await p.approve("--collect"), preview = p.output.at(-1);
    assert.equal(preview.subject.stateRoot, p.h.base); assert.equal(preview.subject.requestedRoot, root);
    assert.ok(preview.subject.jobs.slice(1).every((job) => job.outcome === "deferred" && !job.options));
    p.children.length = 0; p.flags.child = async () => 0;
    assert.equal(await fleetMain(approved, p.deps), 3); assert.deepEqual(p.children, [groupNames[0]]);
    assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "deferred" && !row.error));
  }
  assert.equal(readFileSync(intentPath, "utf8"), intent);
});

test("saved junction identity cannot be removed, retargeted or substituted after remaining approval", async (t) => {
  for (const kind of ["missing", "retarget", "inside-repo", "substitute-argv"]) {
    const p = fixture(t), alias = join(p.h.temp, "fleet-alias"), other = join(p.h.temp, "other-fleet");
    symlinkSync(p.h.base, alias, process.platform === "win32" ? "junction" : "dir"); p.flags.root = alias;
    await fleetMain(p.prepare(), p.deps); await fleetMain(await p.approve("--detach"), p.deps); p.finishFirst();
    const approved = await p.approve("--admit-remaining"), intentPath = join(p.h.base, "launch-intent.json");
    const intent = readFileSync(intentPath, "utf8"); p.children.length = 0;
    mkdirSync(other); writeFileSync(join(other, "fleet-r21.json"), readFileSync(join(p.h.base, "fleet-r21.json")));
    if (kind === "substitute-argv") approved[approved.indexOf("--fleet-root") + 1] = other;
    else {
      unlinkSync(alias);
      if (kind !== "missing") symlinkSync(kind === "inside-repo" ? p.h.repo : other, alias, process.platform === "win32" ? "junction" : "dir");
      // Even using the unchanged physical root must not reinterpret a saved
      // requested path that no longer resolves to its approved physical fleet.
      approved[approved.indexOf("--fleet-root") + 1] = p.h.base;
    }
    await assert.rejects(fleetMain(approved, p.deps), undefined, kind);
    assert.equal(p.children.length, 0, kind); assert.ok(!existsSync(join(p.h.base, "remaining-intent.json")), kind);
    assert.equal(readFileSync(intentPath, "utf8"), intent);
  }
});

test("remaining admission binds exact approval and immutable first evidence, never cached status", async (t) => {
  for (const kind of ["missing", "cleanup", "failed", "unsupported", "archive", "tree", "source", "state", "dirty", "wrong-approval", "future-child"]) {
    const p = fixture(t); const approved = await p.remaining(), j = p.first;
    if (kind === "missing") renameSync(j.path, `${j.path}.retained`);
    if (kind === "cleanup") { delete j.state.destroyedAt; j.save(); }
    if (kind === "failed") { j.state.validation.status = "failed"; j.state.evidenceOutcome = "failed"; j.save(); }
    if (kind === "unsupported") j.report.status = "unsupported";
    if (kind === "archive") writeFileSync(join(j.local, "results.tgz"), "tampered");
    if (kind === "tree") writeFileSync(join(j.evidence, "host.txt"), "tampered");
    if (kind === "source") {
      const path = join(j.folder, j.report.campaign, "plan.json"), plan = JSON.parse(readFileSync(path));
      plan.sourceSha256 = "f".repeat(64); writeFileSync(path, JSON.stringify(plan)); j.rehash();
    }
    if (kind === "state") { j.state.destroyedAt = "2026-11-14T02:03:00.000Z"; j.save(); }
    if (kind === "dirty") p.flags.dirty = true;
    if (kind === "future-child") p.seed(groupNames[1]);
    const args = kind === "wrong-approval" ? [...approved.slice(0, -1), "f".repeat(64)] : approved;
    await assert.rejects(fleetMain(args, p.deps), undefined, kind);
    assert.equal(p.children.length, 0, kind); assert.ok(!existsSync(join(p.h.base, "remaining-intent.json")), kind);
  }
});

test("verified campaigns retain failed and unsupported app outcomes without an extra performance gate", async (t) => {
  const p = fixture(t); await p.remaining();
  const apps = p.first.report.groups[0].appOutcomes;
  Object.assign(apps[0], { outcome: "failed", comparisonEligible: false });
  Object.assign(apps[1], { outcome: "unsupported", comparisonEligible: false });
  const approved = await p.approve("--admit-remaining"), subject = p.output.at(-1).subject;
  assert.equal(subject.firstGroup.row.appOutcomes.length, p.manifest().selection.groups[0].apps.length);
  assert.equal(subject.firstGroup.row.appOutcomes[0].outcome, "failed");
  assert.equal(subject.firstGroup.row.appOutcomes[1].outcome, "unsupported");
  assert.equal(await fleetMain(approved, p.deps), 3);
  assert.equal(p.children.length, groupNames.length - 1);
  await assert.rejects(fleetMain(approved, p.deps), /remaining-already-attempted/);
});

test("synthetic inspection cannot be selected as admission's native authority", async (t) => {
  const p = fixture(t); await p.remaining();
  delete p.deps.verify; p.deps.inspect = async () => p.first.report;
  await assert.rejects(p.approve("--admit-remaining"), /native-first-group-replay-required/);
  delete p.deps.inspect;
  // The default bounded native worker must reject these deliberately synthetic
  // artifacts; no summary, receipt or cached verified state can replace it.
  await assert.rejects(p.approve("--admit-remaining"));
  assert.equal(p.children.length, 0);
});

test("remaining admission names a missing bench install before native replay of the first group", async (t) => {
  const p = fixture(t); await p.remaining();
  const verify = p.deps.verify; let replays = 0;
  p.deps.verify = (...args) => { replays++; return verify(...args); };
  p.deps.compiler = () => false;
  assert.equal(await fleetMain([...p.args("--admit-remaining"), "--print-approval"], p.deps), 2);
  const { subject, approvalSha256 } = p.output.at(-1);
  assert.deepEqual(subject.jobs[0], { group: groupNames[0], outcome: "replay-blocked", missing: [localCompilerMissing] });
  assert.equal(subject.firstGroup, undefined); assert.equal(replays, 0, "replay is not entered");
  await assert.rejects(fleetMain([...p.args("--admit-remaining"), "--approve-reviewed-merged-ready", approvalSha256], p.deps), /fleet-integration-missing/);
  assert.equal(replays, 0); assert.equal(p.children.length, 0); assert.ok(!existsSync(join(p.h.base, "remaining-intent.json")));
  // Control: the same preview with the install present replays the first group.
  p.deps.compiler = () => true;
  assert.equal(await fleetMain([...p.args("--admit-remaining"), "--print-approval"], p.deps), 3);
  assert.equal(replays, 1); assert.equal(p.output.at(-1).subject.jobs[0].outcome, "verified");
});
test("remaining intent is consumed before cancellation or uncertain child admission; it is never replayed", async (t) => {
  for (const uncertain of [false, true]) {
    const p = fixture(t); const approved = await p.remaining();
    p.flags.child = ({ group }) => {
      if (uncertain) throw Object.assign(new Error("synthetic uncertainty"), { controlUncertain: true });
      p.seed(group); p.flags.cancelled = true; return 3;
    };
    if (uncertain) assert.equal(await fleetMain(approved, p.deps), 2);
    else await assert.rejects(fleetMain(approved, p.deps), /cancelled/);
    assert.equal(p.children.length, 1); assert.ok(existsSync(join(p.h.base, "remaining-intent.json")));
    p.flags.cancelled = false;
    await assert.rejects(fleetMain(approved, p.deps), /remaining-already-attempted/);
    assert.equal(p.children.length, 1);
    assert.equal(existsSync(join(p.h.base, ".fleet-operation.lock")), uncertain);
  }
});

test("single-child recovery requires its original staged root, roster and consumed child intent", async (t) => {
  const p = fixture(t), approved = await p.remaining(), [first, second] = groupNames;
  const intent = (group, saved) => stagedChildIntent(join(p.h.base, group), saved);
  const saved = { round: "r21", group: second, commit, fleet: p.manifest() };
  const launch = intent(first, p.first.state).launch;
  assert.throws(() => intent(second, saved)); // Not admitted yet.
  assert.throws(() => intent(second, p.first.state));
  assert.throws(() => intent(first, { ...p.first.state, fleet: {} }));
  await fleetMain(approved, p.deps);
  const path = join(p.h.base, "remaining-intent.json"), bytes = readFileSync(path);
  assert.deepEqual(intent(second, saved), { launch, remaining: digest(bytes) });
  const bad = JSON.parse(bytes); bad.subject.jobs[1].options = bad.subject.jobs[2].options;
  bad.approvalSha256 = digest(JSON.stringify(bad.subject)); writeFileSync(path, JSON.stringify(bad));
  assert.throws(() => intent(second, saved));
});

test("first evidence changed after locked replay stops subsequent remaining children without reopening intent", async (t) => {
  const p = fixture(t); const approved = await p.remaining();
  p.flags.child = ({ group }) => { p.seed(group); writeFileSync(join(p.first.evidence, "host.txt"), "changed after admission"); return 3; };
  assert.equal(await fleetMain(approved, p.deps), 2);
  assert.equal(p.children.length, 1);
  assert.ok(p.output.at(-1).groups.slice(2).every((r) => r.outcome === "not-admitted" && r.reason === "first-group-evidence-changed"));
  await assert.rejects(p.approve("--admit-remaining"), /remaining-already-attempted/);
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
  assert.equal(await operation, 3); assert.equal(spawned, 1);
  assert.equal(maximumActive, 1); assert.equal(active, 0);
  assert.equal(p.output.at(-1).groups[0].outcome, "pending");
  assert.ok(p.output.at(-1).groups.slice(1).every((row) => row.outcome === "deferred"));
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

test("captured worker retains only closed controller stages alongside provider diagnostics", async (t) => {
  for (const stage of ["source-plan", "remote-main-advertisement", "remote-main-fetch", "remote-main-ancestry", "controller-construction", "controller-launch", "provider-settlement"]) {
    await assert.rejects(capturedFailure(t, `throw Object.assign(new Error('PRIVATE_MESSAGE'), {controllerStage:${JSON.stringify(stage)}});`), (error) => {
      assert.equal(error.controllerStage, stage);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes("PRIVATE_MESSAGE")); return true;
    });
  }
  for (const body of [
    `throw Object.assign(new Error('PRIVATE_MESSAGE'),{controllerStage:'PRIVATE_STAGE'});`,
    `const error=new Error('PRIVATE_MESSAGE'); Object.defineProperty(error,'controllerStage',{get(){throw new Error('PRIVATE_GETTER');}}); throw error;`,
  ]) await assert.rejects(capturedFailure(t, body), (error) => {
    assert.equal(error.controllerStage, undefined); assert.equal(error.message, "group-operation-failed"); return true;
  });
});

test("worker protocol rejects malformed diagnostics, unexpected fields and unsettled results", async (t) => {
  const base = { schema: "benchmark-group-fleet-worker-result/v1", error: "group-operation-failed", uncertain: false };
  for (const [message, exit, count] of [
    [{ ...base, providerDiagnostic: { code: "PRIVATE_CODE" } }, 0, 1],
    [{ ...base, providerDiagnostic: { code: "list-http", httpStatus: 429, raw: "PRIVATE" } }, 0, 1],
    [{ ...base, controllerStage: "PRIVATE_STAGE" }, 0, 1],
    [{ ...base, controllerStage: { raw: "PRIVATE_STAGE" } }, 0, 1],
    [{ ...base, extra: "PRIVATE" }, 0, 1],
    [{ schema: base.schema, code: 3, providerDiagnostic: { code: "list-http", httpStatus: 429 } }, 0, 1],
    [{ schema: base.schema, code: 3, controllerStage: "controller-launch" }, 0, 1],
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

test("a ready notification is optional, one-shot, exact and never worker settlement", async () => {
  const ready = { schema: "benchmark-group-fleet-worker-ready/v1", id: "123", ip: "192.0.2.1", registration: "f".repeat(64) };
  const result = { schema: "benchmark-group-fleet-worker-result/v1", code: 3 };
  for (const [messages, admitted, fails] of [
    [[ready, result], 1, false], [[result], 0, false], [[ready], 1, true], [[ready, ready, result], 1, true],
    [[result, ready], 0, true], [[{ ...ready, ip: "foreign" }, result], 0, true],
    [[{ ...ready, extra: true }, result], 0, true], [[{ ...ready, registration: "bad" }, result], 0, true],
  ]) {
    let worker, count = 0, settled = false, flagged = false;
    class Held extends EventEmitter {
      constructor() { super(); this.stdout = this.stderr = { resume() {} }; worker = this; }
    }
    const task = productionChild([], { cancellation: new SharedArrayBuffer(4), WorkerClass: Held,
      onReady: () => count++, onFailure: () => { flagged = true; } }).finally(() => { settled = true; });
    for (const message of messages) worker.emit("message", message);
    await turn();
    assert.equal(settled, false); assert.equal(count, admitted);
    if (fails && messages.length > 1) assert.ok(flagged);
    worker.emit("exit", 0);
    if (fails) await assert.rejects(task, (e) => e.controlTreeUncertain === true);
    else assert.equal(await task, 3);
  }
});

test("fleet receipts retain sanitized provider failure and uncertainty without replay", async (t) => {
  const flags = {}, p = fixture(t, flags); await fleetMain(p.prepare(), p.deps);
  for (const group of groupNames) p.seed(group); const approved = await p.approve("--collect");
  const codes = ["create-request", ...["shape", "count", "id", "rel", "href"].map((predicate) => `create-link-${predicate}`)];
  flags.child = ({ group }) => { throw Object.assign(new Error("PRIVATE_PROVIDER_TOKEN"), {
    controlTreeUncertain: true, controllerStage: "controller-launch", providerDiagnostic: { code: codes[groupNames.indexOf(group) % codes.length] } }); };
  assert.equal(await fleetMain(approved, p.deps), 2);
  const result = p.output.at(-1);
  assert.equal(result.fullGroupQualified, false); assert.equal(result.groups.length, groupNames.length);
  for (const row of result.groups) {
    assert.equal(row.outcome, "error"); assert.equal(row.error, "group-operation-failed");
    assert.equal(row.uncertain, true, "fleet receipt must retain uncertainty");
    assert.equal(row.controllerStage, "controller-launch");
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
