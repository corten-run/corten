import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { accountId, archive, commit, context, harness, metadata, syntheticDelivery, syntheticProviderRequest } from "./cloud-fixtures.mjs";
import { controllerPaths, nativePaths, parseProductionArgs, productionMain, productionPlan } from "./cloud-production.mjs";
import { benchPackagePaths, publicError } from "./droplet.mjs";
import { captureValidation, localCompilerMissing } from "./cloud-validation-snapshot.mjs";
import { createProviderEngine } from "./cloud-engine-test-fixture.mjs";
import { fleetPlan } from "./cloud-contract.mjs";
import { groupNames } from "./registry.mjs";
import { bootstrapReadScript, sourceUrl } from "./cloud-remote.mjs";
import { providerFailure } from "./cloud-options.mjs";
import { registration as streamRegistration } from "./test-fixtures/control-stream-fixture.mjs";
import { controlRegistration, controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { digest } from "./cloud-local.mjs";
import { fleetOperationPlan } from "./fleet.mjs";
import { fixtureGitEnv, withFixtureGitEnv } from "../../scripts/fixture-git.mjs";

function productionHarness(t, flags = {}) {
  const h = harness(t, flags), calls = [], stdout = [];
  const spawn = (binary, argv, options) => {
    calls.push([binary, argv, options]);
    if (binary === "git") {
      if (argv[0] === "-C" && argv[1] === flags.measuredRoot) {
        const stdout = argv.includes("--show-toplevel") ? flags.measuredRoot : argv.includes("HEAD^{commit}") ? flags.measuredHead ?? commit : flags.measuredDirty ?? "";
        return { status: 0, stdout };
      }
      if (argv[0] === "show") {
        const path = argv[1].slice(41);
        return { status: 0, stdout: flags.wrongSource ? "wrong" : readFileSync(resolve(path), "utf8").replaceAll("\r\n", "\n") };
      }
      if (argv[0] === "cat-file" && (flags.missingNative || flags.missingPaths?.includes(argv[2].slice(41)))) return { status: 1, stderr: "private" };
      if (argv[0] === "merge-base" && (flags.unmerged || flags.unrelated && argv.at(-2) === commit)) return { status: 1, stderr: "private" };
      if (argv[0] === "merge-base" && flags.staleTracking && argv.at(-1) === "origin/main") return { status: 1, stderr: "private" };
      if (argv[0] === "fetch" && flags.fetchError) return { status: 1, stderr: "private" };
      if (argv[0] === "fetch" && flags.afterFetch) flags.afterFetch();
      if (argv[0] === "status" && flags.dirty) return { status: 0, stdout: " M private-file" };
      if (argv[0] === "status" && existsSync(join(h.local, "audit-delivery.lock"))) flags.underAuditLock?.();
      return h.run(binary, argv, options.timeout);
    }
    const args = [...argv];
    if (binary === "doctl") args.splice(args.indexOf("--http-retry-max"));
    const request = existsSync(h.statePath) ? h.saved().control?.ledger.at(-1)?.request : undefined;
    const trackedSsh = binary === "ssh" && argv.at(-1) !== "/bin/bash -s";
    if (binary === "ssh") {
      const control = trackedSsh && controlRegistration(request);
      if (control) assert.equal(argv.at(-1), control.command);
      const input = control ? options.input.slice(control.inputPrefix.length) : options.input;
      args[args.length - 1] = input.replace(/^set -euo pipefail\n/, "").replace(/\n$/, "");
    }
    if (binary === "sftp") {
      assert.equal(argv.at(-2), controlRegistration(request).command);
      const batch = /^(get|put) "((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)"\n$/.exec(options.input);
      assert.ok(batch); const a = batch[2].replace(/\\(.)/g, "$1"), b = batch[3].replace(/\\(.)/g, "$1");
      const pair = batch[1] === "get" ? [argv.at(-1) + ":" + a, b] : [a, argv.at(-1) + ":" + b];
      const result = h.run("scp", pair, options.timeout);
      return { ...result, stderr: "CORTEN_CONTROL " + request.invocation.id + " " + "d".repeat(64) + "\nCORTEN_RESULT " + request.invocation.id + " " + result.status + "\n" };
    }
    if (flags.uploadHashError && binary === "ssh" && args.at(-1).includes("sha256sum --check")) return { status: 1, stderr: "private" };
    const result = flags.sealFail && binary === "ssh" && args.at(-1) === ":"
      ? { status: 1, stdout: "", stderr: "" } : h.run(binary, args, options.timeout);
    return trackedSsh ? { ...result, stderr: "CORTEN_CONTROL " + request.invocation.id + " " + "d".repeat(64) + "\nCORTEN_RESULT " + request.invocation.id + " " + result.status + "\n" } : result;
  };
  const deps = { spawn, roleCheck: flags.roleCheck ?? (() => []), providerRequest: syntheticProviderRequest(h, (binary, argv, timeout) => {
    calls.push([binary, argv, { timeout }]); return h.run(binary, argv, timeout, true);
  }), repo: h.repo, inspect: async () => h.report(), sleep: async () => {}, interrupted: () => flags.cancelled, write: (v) => stdout.push(JSON.parse(v)) };
  deps.streamSpawn = (binary, argv) => {
    assert.equal(binary, "ssh"); const child = new EventEmitter(), expected = JSON.parse(Buffer.from(argv.at(-1).split(" ").at(-1), "hex"));
    let sequence = 0, ended = false;
    const frame = (kind, payload) => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1", id: expected.id, sequence: ++sequence, kind, payload }) + "\n");
    const close = (code) => { if (!ended) { ended = true; child.emit("close", code, null); } };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, next) { if (JSON.parse(bytes).kind === "close") setImmediate(() => close(0)); next(); } });
    child.stdin.on("close", () => setImmediate(() => close(255)));
    setImmediate(() => { frame("registered", { ...structuredClone(streamRegistration), binding: expected.binding, id: expected.id }); frame("progress", { state: "active" }); });
    const deadline = Date.now() + 2000, timer = setInterval(() => {
      if (h.saved().control.sealed.includes("bootstrap")) { clearInterval(timer); frame("terminal", { id: expected.id,
        nativeTerminal: true, campaign: "r21-0123456789abcdef", sealSha256: "f".repeat(64) }); }
      else if (Date.now() > deadline) { clearInterval(timer); close(255); }
    }, 5);
    t.after(() => { clearInterval(timer); close(255); }); return child;
  };
  deps.providerFactory = ({ repo, interrupted, createMode }) => Object.assign(createProviderEngine({ repo, interrupted, createMode, spawn, request: deps.providerRequest, sleep: deps.sleep }), { close: async () => {} });
  const args = (mode = "--collect") => ["r21", "--state-dir", h.base, mode, ...(mode === "--detach" ? ["--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context] : [])];
  async function approve(mode) { const values = args(mode); await productionMain([...values, "--print-approval"], deps); return [...values, "--approve-reviewed-merged-ready", stdout.at(-1).approvalSha256]; }
  return { h, calls, stdout, deps, args, approve };
}

async function verifiedDeletionRetry(t, flags = { active: true, reportStatus: "verified" }) {
  const p = productionHarness(t, flags), { h } = p;
  await h.launch().launch();
  const closePath = join(h.local, "monitor-local-closed.json"), closed = JSON.parse(readFileSync(closePath));
  closed.closedAtMs -= 31000; closed.recoverAfterMs -= 31000; writeFileSync(closePath, JSON.stringify(closed));
  Object.assign(flags, { active: false, expired: true, deleteLost: true });
  h.setArchive(archive([...metadata().filter(e => e.name !== "exit-code"), { name: "exit-code", body: "0\n" }, { name: "campaign/" }]));
  await assert.rejects(h.task().collect(), /acknowledgement lost/);
  const before = readFileSync(h.statePath), saved = h.saved();
  assert.equal(saved.validation.status, "verified"); assert.ok(saved.deletionIntentAt && !saved.destroyedAt);
  assert.equal(h.deletes, 1);
  return { p, h, flags, before, saved };
}

const afterExactAbsence = (action) => {
  let read = false;
  return (bin, argv) => {
    if (bin === "doctl" && argv[2] === "get" && argv[1] === "droplet") read = true;
    else if (read && bin === "doctl" && argv[0] === "account") { read = false; action(); }
  };
};

test("a merged successor reconciles only a previously verified, absent host and replays its measured source", async (t) => {
  const head = "b".repeat(40);
  const { p, h, flags, before, saved } = await verifiedDeletionRetry(t);
  Object.assign(flags, { wrongHead: true, remoteHead: head });
  flags.measuredRoot = join(h.temp, "measured"); mkdirSync(flags.measuredRoot);
  p.deps.compiler = root => root === flags.measuredRoot;
  const args = [...p.args(), "--absent-measured-checkout", flags.measuredRoot];
  const preview = () => productionMain([...args, "--print-approval"], p.deps);
  await assert.rejects(productionMain([...p.args(), "--print-approval"], p.deps), /measured integrated checkout/);
  h.change(s => { delete s.deletionIntentAt; });
  await assert.rejects(preview(), /verified older reservation/);
  writeFileSync(h.statePath, before);
  flags.measuredHead = head;
  await assert.rejects(preview(), /original measured checkout/); delete flags.measuredHead;
  flags.measuredDirty = " M bench/source";
  await assert.rejects(preview(), /clean measured checkout/); delete flags.measuredDirty;
  flags.unrelated = true;
  await assert.rejects(preview()); delete flags.unrelated;
  assert.equal(await preview(), 3);
  const plan = p.stdout.at(-1);
  assert.equal(plan.controllerCommit, head);
  assert.equal(plan.recovery.measuredCommit, commit);
  assert.equal(plan.recovery.policy, "collect-verified-absent-host-only");
  const approved = [...args, "--approve-reviewed-merged-ready", plan.approvalSha256];
  assert.ok(p.calls.every(([bin]) => bin === "git"));
  const live = h.host(); h.hosts([live]);
  let replayed = 0;
  const run = (observe) => productionMain(approved, { ...p.deps, inspect: async input => {
    replayed++; assert.equal(input.commit, commit); observe?.(); return h.report();
  } });
  await assert.rejects(run(), /absence|still present/);
  assert.equal(replayed, 0); assert.deepEqual(readFileSync(h.statePath), before);
  h.hosts([]);
  flags.accountId = "00000000-0000-4000-8000-000000000001";
  await assert.rejects(run(), /account identity/); delete flags.accountId;
  assert.equal(replayed, 0); assert.deepEqual(readFileSync(h.statePath), before);
  flags.afterFetch = () => { h.change(s => { delete s.deletionIntentAt; }); };
  const n = p.calls.length;
  await assert.rejects(run(), /verified older reservation/); delete flags.afterFetch;
  assert.ok(p.calls.slice(n).every(([bin]) => bin === "git"));
  writeFileSync(h.statePath, before);
  await assert.rejects(run(() => h.hosts([live])), /absence|still present/);
  assert.equal(replayed, 1); assert.deepEqual(readFileSync(h.statePath), before);
  h.hosts([]);
  const invalid = join(h.local, "monitor-invalid.json");
  await assert.rejects(run(() => writeFileSync(invalid, "{}")));
  unlinkSync(invalid); assert.deepEqual(readFileSync(h.statePath), before);
  const archivePath = join(h.local, "results.tgz"), archiveBytes = readFileSync(archivePath);
  const terminalPath = join(h.local, "monitor-terminal.json"), terminalBytes = readFileSync(terminalPath);
  const operationLock = join(h.local, "operation.lock");
  await assert.rejects(run(() => { flags.hook = afterExactAbsence(() => writeFileSync(archivePath, "changed")); }), /archive changed/);
  delete flags.hook; writeFileSync(archivePath, archiveBytes); assert.deepEqual(readFileSync(h.statePath), before);
  await assert.rejects(run(() => { flags.hook = afterExactAbsence(() => {
    writeFileSync(terminalPath, JSON.stringify({ ...JSON.parse(terminalBytes), campaign: "r21-fedcba9876543210" }));
  }); }), /monitor campaign changed/);
  delete flags.hook; writeFileSync(terminalPath, terminalBytes); assert.deepEqual(readFileSync(h.statePath), before);
  const replacement = "replacement lock\n";
  await assert.rejects(run(() => { flags.hook = afterExactAbsence(() => {
    renameSync(operationLock, operationLock + ".old"); writeFileSync(operationLock, replacement, { flag: "wx" });
  }); }), /operation lock changed/);
  delete flags.hook; assert.equal(readFileSync(operationLock, "utf8"), replacement); unlinkSync(operationLock);
  assert.deepEqual(readFileSync(h.statePath), before);
  const now = performance.now.bind(performance); let elapsed = 0;
  const clock = t.mock.method(performance, "now", () => now() + elapsed);
  await assert.rejects(run(() => { elapsed = 26 * 60_000; }), e => e.controllerStage === "collect-native-replay-deadline");
  assert.equal(replayed, 6); assert.deepEqual(readFileSync(h.statePath), before);
  elapsed = 0;
  assert.equal(await run(() => { elapsed = 16 * 60_000; }), 0); assert.equal(replayed, 7);
  clock.mock.restore();
  const after = h.saved(); assert.ok(after.destroyedAt); delete after.destroyedAt;
  assert.deepEqual(after, saved);
  assert.equal(h.deletes, 1); assert.equal(h.creates, 1);
  for (const [bin, argv] of p.calls) {
    if (bin === "git") continue;
    assert.equal(bin, "doctl");
    assert.ok(argv[0] === "account" && argv[1] === "get" || argv[0] === "auth" && argv[1] === "token"
      || argv[0] === "compute" && argv[1] === "droplet" && argv[2] === "get" && argv[3] === saved.id);
  }
});

test("ordinary absence retry rechecks the saved archive after its final observation", async (t) => {
  const { h, flags, before } = await verifiedDeletionRetry(t);
  const path = join(h.local, "results.tgz"), bytes = readFileSync(path);
  await assert.rejects(h.task({ inspect: async () => {
    flags.hook = afterExactAbsence(() => writeFileSync(path, "changed"));
    return h.report();
  } }).collect(), /archive changed/);
  delete flags.hook; writeFileSync(path, bytes);
  assert.deepEqual(readFileSync(h.statePath), before);
  assert.equal(await h.task().collect(), 0);
  assert.ok(h.saved().destroyedAt); assert.equal(h.deletes, 1);
});

for (const target of ["archive", "extracted member"]) test(`absence retry rejects a changed ${target} during the final extraction scan`, async (t) => {
  const { h, flags, before, saved } = await verifiedDeletionRetry(t);
  const extracted = join(h.local, saved.evidence), last = join(extracted, "run.log");
  const path = target === "archive" ? join(h.local, "results.tgz") : join(extracted, "host.txt");
  const lstat = fs.lstatSync; let armed = false, changed = false;
  const hook = t.mock.method(fs, "lstatSync", (file, ...args) => {
    if (armed && !changed && file === last) { changed = true; writeFileSync(path, "changed after verification"); }
    return lstat(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(h.task({ inspect: async () => {
      flags.hook = afterExactAbsence(() => { armed = true; });
      return h.report();
    } }).collect(), target === "archive" ? /file changed while reading/ : /local handoff custody changed: extraction/);
  } finally { delete flags.hook; hook.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(changed, "changed target during the final extraction scan");
  assert.deepEqual(readFileSync(h.statePath), before); assert.equal(h.deletes, 1);
});

test("ordinary collection of a finalized result keeps the ordinary replay budget", async (t) => {
  const { h } = await verifiedDeletionRetry(t);
  assert.equal(await h.task().collect(), 0);
  const before = readFileSync(h.statePath), now = performance.now.bind(performance);
  let elapsed = 0;
  t.mock.method(performance, "now", () => now() + elapsed);
  await assert.rejects(h.task({ inspect: async () => {
    elapsed = 16 * 60_000;
    return h.report();
  } }).collect(), e => e.controllerStage === "collect-native-replay-deadline");
  assert.deepEqual(readFileSync(h.statePath), before);
  assert.equal(h.deletes, 1);
});

test("approved sealed collection uses the measured replay and does not create or retire an unverified result", async (t) => {
  const flags = { active: true, reportStatus: "verified" };
  const p = productionHarness(t, flags), { h } = p;
  await h.launch().launch();
  const closePath = join(h.local, "monitor-local-closed.json"), closed = JSON.parse(readFileSync(closePath));
  closed.closedAtMs -= 31000; closed.recoverAfterMs -= 31000; writeFileSync(closePath, JSON.stringify(closed));
  Object.assign(flags, { active: false, expired: true });
  h.setArchive(archive([...metadata().filter(e => e.name !== "exit-code"), { name: "exit-code", body: "0\n" }, { name: "campaign/" }]));
  await assert.rejects(h.task({ inspect: async () => { throw new Error("unavailable"); } }).collect(),
    e => e.controllerStage === "collect-native-replay-refused");
  const before = readFileSync(h.statePath), saved = h.saved(), head = "b".repeat(40);
  assert.equal(saved.status, "running"); assert.ok(saved.archiveSha256 && saved.evidenceSha256);
  const measuredRoot = join(h.temp, "measured"); mkdirSync(measuredRoot);
  Object.assign(flags, { wrongHead: true, remoteHead: head, measuredRoot });
  p.deps.compiler = root => root === measuredRoot;
  const args = [...p.args(), "--sealed-measured-checkout", measuredRoot];
  const preview = () => productionMain([...args, "--print-approval"], p.deps);
  flags.measuredDirty = " M bench/source";
  await assert.rejects(preview(), /clean measured checkout/); delete flags.measuredDirty;
  h.change(s => { s.control.monitor.phase = "live"; });
  await assert.rejects(preview(), /sealed recovery requires a saved terminal archive/);
  writeFileSync(h.statePath, before);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", measuredRoot, ...args], { encoding: "utf8", env: fixtureGitEnv(), timeout: 10000 });
    assert.equal(result.status, 0);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=.git/no-hooks", "commit", "-qm", "Measured fixture without replay sources", "--allow-empty");
  flags.measuredHead = git("rev-parse", "HEAD");
  h.change(s => {
    s.commit = flags.measuredHead;
    for (const { request } of s.control.ledger) {
      request.invocation.commit = s.commit;
      for (const item of request.seal ?? []) {
        const { invocation } = s.control.ledger.find(row => row.request.invocation.id === item.id).request;
        item.sha256 = digest(JSON.stringify(invocation));
      }
    }
  });
  await withFixtureGitEnv(() => assert.rejects(preview(), /native campaign validation unavailable or invalid/));
  assert.ok(p.calls.every(([bin]) => bin === "git"));
  writeFileSync(h.statePath, before); delete flags.measuredHead;
  const requireMeasured = (source, { root }) => { assert.equal(source, commit); assert.equal(root, measuredRoot); };
  p.deps.captureReplay = requireMeasured;
  assert.equal(await preview(), 3);
  const plan = p.stdout.at(-1);
  assert.equal(plan.controllerCommit, head);
  assert.equal(plan.recovery.measuredCommit, commit);
  assert.equal(plan.recovery.archiveSha256, saved.archiveSha256);
  assert.equal(plan.recovery.evidenceSha256, saved.evidenceSha256);
  assert.ok(p.calls.every(([bin]) => bin === "git"));
  const approved = [...args, "--approve-reviewed-merged-ready", plan.approvalSha256];
  const terminalPath = join(h.local, "monitor-terminal.json"), terminalBytes = readFileSync(terminalPath);
  const terminal = JSON.parse(terminalBytes);
  writeFileSync(terminalPath, JSON.stringify({ ...terminal, sealSha256: "e".repeat(64) }));
  await assert.rejects(productionMain(approved, p.deps));
  writeFileSync(terminalPath, terminalBytes);
  assert.ok(p.calls.every(([bin]) => bin === "git"));
  const archivePath = join(h.local, "results.tgz"), archiveBytes = readFileSync(archivePath);
  writeFileSync(archivePath, "changed");
  await assert.rejects(productionMain(approved, p.deps), /archive changed/);
  writeFileSync(archivePath, archiveBytes);
  assert.ok(p.calls.every(([bin]) => bin === "git"));
  assert.deepEqual(readFileSync(h.statePath), before);
  const now = performance.now.bind(performance); let elapsed = 0, replayed = 0;
  t.mock.method(performance, "now", () => now() + elapsed);
  const run = () => productionMain(approved, { ...p.deps, inspect: async input => {
    replayed++; assert.equal(input.commit, commit); elapsed += 16 * 60_000; return h.report();
  } });
  flags.reportStatus = "blocked";
  // Run the actual worker with a synthetic stand-in for the measured source.
  // The controller checkout's default capture cannot replay this synthetic commit.
  const installed = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../..", import.meta.url)),
    encoding: "utf8", env: fixtureGitEnv(), timeout: 10000 });
  assert.equal(installed.status, 0);
  const snapshot = withFixtureGitEnv(() => captureValidation(installed.stdout.trim()));
  snapshot.root = pathToFileURL(measuredRoot + "/").href;
  const validator = snapshot.sources.find(row => row.path === "bench/workloads/isolated/campaign-verify.mjs");
  validator.source = `export function validateCampaign() { return ${JSON.stringify(h.report())}; }`;
  validator.sha256 = digest(validator.source);
  p.deps.captureReplay = (...args) => { requireMeasured(...args); return snapshot; };
  await assert.rejects(productionMain(approved, { ...p.deps, inspect: undefined }), e => e.controllerStage === "collect-native-report-refused");
  p.deps.captureReplay = requireMeasured;
  assert.equal(h.deletes, 0); assert.equal(h.creates, 1); assert.equal(replayed, 0);
  // A read-only terminal probe extends the monitor ledger, so print a new approval.
  flags.reportStatus = "verified";
  const markerPath = join(h.local, saved.evidence, "exit-code"), marker = readFileSync(markerPath);
  const operationLock = join(h.local, "operation.lock");
  const changeTerminal = () => writeFileSync(terminalPath, JSON.stringify({ ...terminal, sealSha256: "e".repeat(64) }));
  for (const [change, refusal] of [["terminal", /approved terminal seal|native campaign validation/],
    ["extraction", /evidence changed|extraction/], ["operation lock", /operation\.lock (?:was replaced|changed)/]]) {
    const beforeProbe = readFileSync(h.statePath);
    assert.equal(await preview(), 3); approved[approved.length - 1] = p.stdout.at(-1).approvalSha256;
    let changed = false;
    flags.hook = (bin, args) => {
      if (changed || bin !== "ssh" || !args.at(-1).includes("CORTEN_IDLE") || !args.at(-1).includes("\nsystemctl show")) return;
      changed = true;
      if (change === "extraction") writeFileSync(markerPath, "1\n");
      else if (change === "terminal") changeTerminal();
      else {
        renameSync(operationLock, operationLock + ".original");
        writeFileSync(operationLock, "replacement lock\n", { flag: "wx" });
      }
    };
    await assert.rejects(run(), refusal);
    delete flags.hook;
    assert.ok(changed);
    assert.equal(h.deletes, 0);
    assert.equal(h.saved().deletionIntentAt, undefined);
    if (change === "extraction") writeFileSync(markerPath, marker);
    else if (change === "terminal") writeFileSync(terminalPath, terminalBytes);
    else {
      assert.equal(readFileSync(operationLock, "utf8"), "replacement lock\n");
      unlinkSync(operationLock);
      writeFileSync(h.statePath, beforeProbe); // discard this synthetic command's interrupted receipt
    }
  }
  assert.equal(await preview(), 3); approved[approved.length - 1] = p.stdout.at(-1).approvalSha256;
  const interrupted = p.deps.interrupted;
  let changedAtDispatch = false;
  p.deps.interrupted = () => {
    if (!changedAtDispatch && h.saved().deletionIntentAt) {
      changedAtDispatch = true; changeTerminal();
    }
    return interrupted();
  };
  await assert.rejects(run(), /DELETE not dispatched; fresh collection approval required/);
  assert.ok(changedAtDispatch);
  assert.equal(h.saved().deletionIntentAt, undefined);
  assert.equal(h.deletes, 0);
  p.deps.interrupted = interrupted;
  writeFileSync(terminalPath, terminalBytes);
  assert.equal(await preview(), 3); approved[approved.length - 1] = p.stdout.at(-1).approvalSha256;
  changedAtDispatch = false;
  let renameFailed = false;
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, "renameSync", (from, to) => {
    if (changedAtDispatch && to === h.statePath && !renameFailed) {
      renameFailed = true; throw Object.assign(new Error("injected withdrawal rename failure"), { code: "EIO" });
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  p.deps.interrupted = () => {
    if (!changedAtDispatch && h.saved().deletionIntentAt) {
      changedAtDispatch = true; changeTerminal();
    }
    return interrupted();
  };
  try { await assert.rejects(run(), /injected withdrawal rename failure/); }
  finally {
    fault.mock.restore(); syncBuiltinESMExports(); p.deps.interrupted = interrupted;
    writeFileSync(terminalPath, terminalBytes);
  }
  assert.ok(renameFailed && h.saved().deletionIntentAt);
  assert.equal(h.deletes, 0);
  const intentBytes = readFileSync(h.statePath);
  const proof = join(h.local, `state.json.delete-unsent-${digest(intentBytes)}.tmp`);
  const proofBytes = readFileSync(proof);
  for (const bytes of [proofBytes.subarray(0, 80), Buffer.concat([proofBytes, Buffer.from(" ")])]) {
    writeFileSync(proof, bytes);
    assert.equal(await preview(), 3); approved[approved.length - 1] = p.stdout.at(-1).approvalSha256;
    await assert.rejects(run(), /deletion not confirmed; outcome uncertain/);
    assert.deepEqual(readFileSync(h.statePath), intentBytes);
    assert.equal(h.deletes, 0);
  }
  writeFileSync(proof, proofBytes);
  const beforeDeleteReplays = replayed;
  assert.equal(await preview(), 3); approved[approved.length - 1] = p.stdout.at(-1).approvalSha256;
  const live = h.host();
  flags.deleteLost = true;
  await assert.rejects(run(), /provider control failed/);
  assert.ok(h.saved().deletionIntentAt && !h.saved().destroyedAt);
  assert.equal(h.deletes, 1); assert.equal(replayed, beforeDeleteReplays + 2);
  assert.equal(existsSync(proof), false);
  assert.equal(await preview(), 3); approved[approved.length - 1] = p.stdout.at(-1).approvalSha256;
  const retryStart = p.calls.length;
  await assert.rejects(run(), { code: "EEXIST" });
  assert.ok(p.calls.slice(retryStart).every(([bin]) => bin === "git"));
  // The simulated owner has stopped; emulate the separate retained-lock custody step.
  unlinkSync(join(h.local, "operation.lock"));
  h.hosts([live]);
  await assert.rejects(run(), /deletion not confirmed; outcome uncertain/);
  assert.equal(h.deletes, 1); assert.equal(replayed, beforeDeleteReplays + 2);
  h.hosts([]);
  assert.equal(await run(), 0);
  assert.equal(h.saved().validation.status, "verified"); assert.ok(h.saved().destroyedAt);
  assert.equal(h.deletes, 1); assert.equal(h.creates, 1); assert.equal(replayed, beforeDeleteReplays + 3);
  assert.ok(p.calls.slice(retryStart).every(([bin]) => bin !== "ssh" && bin !== "sftp"));
});

test("contradictory saved verification does not get the extended replay budget", async (t) => {
  const { h } = await verifiedDeletionRetry(t);
  h.change(s => { s.exitCode = 1; });
  const before = readFileSync(h.statePath), now = performance.now.bind(performance);
  let elapsed = 0;
  t.mock.method(performance, "now", () => now() + elapsed);
  await assert.rejects(h.task({ inspect: async () => {
    elapsed = 16 * 60_000;
    return h.report();
  } }).collect(), e => e.controllerStage === "collect-native-replay-deadline");
  assert.deepEqual(readFileSync(h.statePath), before); assert.equal(h.deletes, 1);
});

function unusedBootstrapAttempt(t, flags = {}, script = "true") {
  const p = productionHarness(t, flags);
  p.h.seed();
  p.h.change((s) => {
    s.status = "preparing"; s.commit = "7f8fd11c62b95624a083536ead5630176f826586";
    s.control = { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: [],
      monitor: { schema: "benchmark-supervised-control/v1", id: "f".repeat(32), phase: "pending" } };
    s.control.ledger.push({ request: controlRequest(s, "ssh", [`root@${s.ip}`, script], 30000, "bootstrap"), localTerminal: false });
  });
  return pinnedCollect(p);
}

function pinnedCollect(p) {
  const key = join(p.h.temp, "verified-host-key"), args = [...p.args(), "--unused-bootstrap-known-hosts", key];
  writeFileSync(key, "synthetic operator-verified host key\n");
  async function approve() {
    assert.equal(await productionMain([...args, "--print-approval"], p.deps), 3);
    return [...args, "--approve-reviewed-merged-ready", p.stdout.at(-1).approvalSha256];
  }
  return { ...p, key, approve };
}

test("approved old-source retirement preserves the missing first SSH receipt and only deletes after pinned unused proof", async (t) => {
  const p = unusedBootstrapAttempt(t), state = p.h.saved();
  await assert.rejects(p.h.task().collect(), /monitor not registered/, "stock path originally refuses the saved shape");
  await assert.rejects(productionMain([...p.args(), "--print-approval"], p.deps), /measured integrated checkout/, "ordinary collection must stay exact-source");
  const args = await p.approve();
  assert.deepEqual(p.stdout.at(-1).recovery, { measuredCommit: state.commit, hostId: state.id, ip: state.ip,
    knownHostsSha256: digest(readFileSync(p.key)), policy: "first-ssh-unused-only-no-qualification" });
  assert.match(p.stdout.at(-1).declaration, /local-process-tree-gone/);
  assert.equal(await productionMain(args, p.deps), 1);
  const ssh = p.calls.filter(([binary]) => binary === "ssh"); assert.equal(ssh.length, 1);
  assert.equal(ssh[0][1].at(-1), "/bin/bash -s");
  assert.ok(ssh[0][1].includes("StrictHostKeyChecking=yes") && ssh[0][1].includes("GlobalKnownHostsFile=none"));
  assert.ok(ssh[0][2].input.includes("unexpected bootstrap custody"));
  const end = p.h.saved(); assert.equal(end.commit, state.commit); assert.deepEqual(end.control, state.control);
  assert.equal(end.status, "retired"); assert.equal(end.retirement.kind, "unused"); assert.ok(end.destroyedAt);
  assert.equal(end.validation, undefined); assert.equal(end.archiveSha256, undefined); assert.equal(p.h.creates, 0);
  assert.equal(await productionMain(await p.approve(), p.deps), 1); assert.equal(p.h.deletes, 1);
  assert.equal(p.calls.filter(([binary]) => binary === "ssh").length, 1);
});

test("first SSH recovery does not take over custody, replay mutations or use stale or foreign proofs", async (t) => {
  for (const mode of ["operation.lock", ".groups-launch.lock", "monitor-registration.json", "mutation", "unmerged", "key", "foreign", "ambiguous-proof", "lost-delete"]) {
    const p = unusedBootstrapAttempt(t, mode === "lost-delete" ? { deleteLost: true } : {}, mode === "mutation" ? "mkdir /bench" : "true");
    if (mode === "mutation") { await assert.rejects(p.approve(), /only an unacknowledged first SSH no-op/); continue; }
    const args = await p.approve(), before = readFileSync(p.h.statePath);
    let custody;
    if (mode.endsWith(".lock") || mode.endsWith(".json")) {
      custody = join(mode === ".groups-launch.lock" ? p.h.base : p.h.local, mode);
      writeFileSync(custody, "historical custody", { flag: "wx" });
    }
    if (mode === "unmerged") {
      const spawn = p.deps.spawn;
      p.deps.spawn = (binary, argv, opts) => binary === "git" && argv[0] === "merge-base" ? { status: 1 } : spawn(binary, argv, opts);
    }
    if (mode === "key") writeFileSync(p.key, "different host-key bytes");
    if (mode === "foreign") p.h.hosts([{ id: 123, name: "foreign" }]);
    if (mode === "ambiguous-proof") p.h.flags.unusedProof = { unused: false };
    await assert.rejects(productionMain(args, p.deps));
    if (mode === "lost-delete") {
      assert.equal(p.h.deletes, 1); assert.ok(p.h.saved().deletionIntentAt); assert.equal(p.h.saved().destroyedAt, undefined);
      assert.ok(existsSync(join(p.h.local, "operation.lock")));
      await assert.rejects(productionMain(await p.approve(), p.deps), /EEXIST/); assert.equal(p.h.deletes, 1); continue;
    }
    assert.equal(p.h.deletes, 0); assert.deepEqual(readFileSync(p.h.statePath), before);
    if (custody) assert.equal(readFileSync(custody, "utf8"), "historical custody");
    assert.equal(p.calls.filter(([binary]) => binary === "ssh").length, mode === "ambiguous-proof" ? 1 : 0);
  }
});

test("after readiness exhaustion, refused pinned SSH leaves the empty ledger recoverable", async (t) => {
  const p = pinnedCollect(productionHarness(t, { noSsh: true })), spawn = p.deps.spawn;
  let proofReachable = false;
  p.deps.spawn = (binary, argv, options) => {
    if (binary === "ssh" && options.input.includes("benchmark-unused-host/v1") && !proofReachable)
      return { status: 255, stdout: "", stderr: "" };
    return spawn(binary, argv, options);
  };
  const launchArgs = p.args("--detach");
  await productionMain([...launchArgs, "--print-approval"], p.deps);
  await assert.rejects(productionMain([...launchArgs, "--approve-reviewed-merged-ready", p.stdout.at(-1).approvalSha256], p.deps), /SSH unavailable/);
  assert.equal(p.h.creates, 1); assert.equal(p.calls.filter(([binary]) => binary === "ssh").length, 24);
  const before = readFileSync(p.h.statePath);
  assert.deepEqual(p.h.saved().control.ledger, []);
  await productionMain([...p.args(), "--print-approval"], p.deps);
  await assert.rejects(productionMain([...p.args(), "--approve-reviewed-merged-ready", p.stdout.at(-1).approvalSha256], p.deps),
    /approved pinned observation/);
  assert.equal(p.calls.filter(([binary]) => binary === "ssh").length, 24);
  const approved = await p.approve();
  await assert.rejects(productionMain(approved, p.deps), /control process failed/);
  assert.deepEqual(readFileSync(p.h.statePath), before); assert.equal(p.h.deletes, 0);
  assert.deepEqual(readdirSync(p.h.local), ["state.json"], "settled observation must leave neither lock nor snapshot");
  proofReachable = true;
  assert.equal(await productionMain(approved, p.deps), 1);
  assert.deepEqual(p.h.saved().control.ledger, []);
  assert.ok(p.h.saved().destroyedAt); assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 1);
});

test("pinned retirement shares one local deadline across proof delivery and account preflight", async (t) => {
  for (const [providerDelay, afterIntent] of [[34000, false], [35000, false], [45000, true]]) {
    const p = unusedBootstrapAttempt(t), approved = await p.approve(), spawn = p.deps.spawn, request = p.deps.providerRequest;
    const start = Date.now();
    let now = start, proofDelivered = false, delayed = false, dispatchedExpiry;
    // Only the synthetic SSH and provider advance time. The guest observes
    // unusedness before the 25-second delivery delay.
    p.deps.spawn = (binary, argv, options) => {
      const result = spawn(binary, argv, options);
      if (binary === "ssh") { now += 25000; proofDelivered = true; }
      return result;
    };
    p.deps.providerRequest = (args) => {
      if (!delayed && proofDelivered && args.path === "/v2/account" && !!p.h.saved().deletionIntentAt === afterIntent) {
        delayed = true; now += providerDelay;
      }
      if (args.method === "DELETE") dispatchedExpiry = args.deleteProofExpiresAtMs;
      return request(args);
    };
    t.mock.method(Date, "now", () => now);
    try {
      if (providerDelay === 34000) {
        assert.equal(await productionMain(approved, p.deps), 1);
        assert.equal(p.h.deletes, 1); assert.equal(dispatchedExpiry, start + 60000);
      } else {
        await assert.rejects(productionMain(approved, p.deps), /retirement proof expired/);
        assert.equal(p.h.deletes, 0); assert.equal(!!p.h.saved().deletionIntentAt, afterIntent);
        assert.equal(existsSync(join(p.h.local, "unused-host.json")), afterIntent);
        if (afterIntent) {
          p.h.hosts([]);
          assert.equal(await productionMain(await p.approve(), p.deps), 1);
          assert.equal(p.h.deletes, 0, "after intent only exact absence is checked");
          assert.equal(p.calls.filter(([binary]) => binary === "ssh").length, 1);
        }
      }
      assert.ok(proofDelivered && delayed);
    } finally { t.mock.restoreAll(); }
  }
});

test("SSH uses only the private snapshot of the exact approved host-key bytes", async (t) => {
  for (const mode of ["none", "key", "extra", "uncertain"]) {
    const p = unusedBootstrapAttempt(t), approved = await p.approve(), spawn = p.deps.spawn, bytes = readFileSync(p.key);
    let snapshot;
    p.deps.spawn = (binary, argv, options) => {
      if (binary === "ssh") {
        snapshot = argv.find((arg) => arg.startsWith('UserKnownHostsFile="')).slice('UserKnownHostsFile="'.length, -1);
        assert.notEqual(resolve(snapshot), p.key);
        writeFileSync(p.key, "transient unrelated bytes after locked approval");
        try {
          assert.deepEqual(readFileSync(snapshot), bytes);
          if (mode === "key") writeFileSync(snapshot, "changed snapshot");
          if (mode === "extra") writeFileSync(join(dirname(snapshot), "unknown"), "unidentified sibling");
          if (mode === "uncertain") return { status: null, signal: "SIGTERM" };
          return spawn(binary, argv, options);
        } finally { writeFileSync(p.key, bytes); }
      }
      return spawn(binary, argv, options);
    };
    if (mode !== "none") {
      await assert.rejects(productionMain(approved, p.deps), /private host-key snapshot changed|unexpected private host-key artifacts|control tree uncertain/);
      assert.equal(p.h.deletes, 0); assert.equal(p.h.saved().deletionIntentAt, undefined);
      if (mode === "key") assert.equal(readFileSync(snapshot, "utf8"), "changed snapshot");
      if (mode === "extra") assert.equal(readFileSync(join(dirname(snapshot), "unknown"), "utf8"), "unidentified sibling");
      if (mode === "uncertain") {
        assert.deepEqual(readFileSync(snapshot), bytes);
        assert.ok(existsSync(join(p.h.local, "operation.lock")));
        await assert.rejects(productionMain(approved, p.deps), /EEXIST/);
      }
    } else {
      assert.equal(await productionMain(approved, p.deps), 1);
      assert.equal(p.h.deletes, 1);
      const receipt = JSON.parse(readFileSync(join(p.h.local, "unused-host.json")));
      assert.equal(receipt.knownHostsSha256, digest(bytes));
    }
    assert.ok(snapshot); assert.equal(existsSync(snapshot), mode !== "none");
    assert.equal(dirname(dirname(resolve(snapshot))), p.h.base);
    assert.ok(readdirSync(p.h.local).every((name) => !name.startsWith(".unused-host-key-")));
  }
});

test("pinned collection neither adopts abandoned scratch nor clears unknown reservation artifacts", async (t) => {
  const p = unusedBootstrapAttempt(t), approved = await p.approve(), state = readFileSync(p.h.statePath);
  const orphan = mkdtempSync(join(p.h.base, ".unused-host-key-"));
  const orphanKey = join(orphan, "known_hosts");
  writeFileSync(orphanKey, "abandoned snapshot bytes", { flag: "wx" });
  const old = join(p.h.local, ".unused-host-key-AbC123"), oldKey = join(old, "known_hosts");
  mkdirSync(old); writeFileSync(oldKey, "unidentified reservation artifact", { flag: "wx" });
  await assert.rejects(productionMain(approved, p.deps), /unexpected local bootstrap custody/);
  assert.equal(readFileSync(oldKey, "utf8"), "unidentified reservation artifact");
  assert.deepEqual(readFileSync(p.h.statePath), state);
  assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.deletes, 0);
  // Model an operator archiving this independently identified fixture after
  // settling the original process tree. The collector must not do so itself.
  renameSync(old, join(p.h.temp, "archived-legacy-snapshot"));
  assert.equal(await productionMain(approved, p.deps), 1);
  assert.equal(p.h.deletes, 1);
  assert.equal(readFileSync(orphanKey, "utf8"), "abandoned snapshot bytes");
  assert.equal(readFileSync(join(p.h.temp, "archived-legacy-snapshot", "known_hosts"), "utf8"), "unidentified reservation artifact");
});

const auditStartupMs = 10000;

async function supervisedAudit(t, group, flags = {}, withheldReady) {
  flags.active = true;
  const p = productionHarness(t, flags), prefix = group === "json-api" ? "json" : "mixed", campaign = "r21-0123456789abcdef";
  const delivery = syntheticDelivery(group), identities = delivery.bundle.receipts.map((r) => r.identity);
  if (group === "json-api") delivery.bundle.schema = "json-api-native-audits/v2";
  const entries = [{ path: "", type: "directory" }, { path: "blobs", type: "directory" }];
  const sources = { files: [], snapshot: { entries, sha256: deploymentSha256(entries) } };
  const body = { schema: "benchmark-" + prefix + "-audit-subject/v1", commit, campaignSha256: "f".repeat(64),
    sourcesManifest: { ...sources, sha256: deploymentSha256(sources) },
    ...(group === "json-api" ? { identities } : { requests: identities.map((identity) => ({ identity })) }) };
  const subjectSha256 = deploymentSha256(body), subject = Buffer.from(JSON.stringify({ ...body, subjectSha256 }));
  delivery.subjectSha256 = subjectSha256; delivery.review.subjectSha256 = subjectSha256;
  const path = join(p.h.temp, "approved-delivery.json"); writeFileSync(path, JSON.stringify(delivery));
  const input = []; let finish, stopStream, started = 0;
  p.deps.streamSpawn = (binary, argv) => {
    assert.equal(binary, "ssh"); started++;
    const expected = JSON.parse(Buffer.from(argv.at(-1).split(" ").at(-1), "hex")), child = new EventEmitter();
    let sequence = 0, closed = false;
    const frame = (kind, payload) => {
      if (!closed) child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1", id: expected.id, sequence: ++sequence, kind, payload }) + "\n");
    };
    const close = (code) => { if (!closed) { closed = true; child.emit("close", code, null); } };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, next) {
      const value = JSON.parse(bytes); input.push(value);
      if (value.kind === "close") setImmediate(() => close(0));
      if (value.kind === "delivery-end") frame("delivery-sealed", { group, campaign, subjectSha256 });
      next();
    } });
    child.stdin.on("close", () => setImmediate(() => close(255)));
    setImmediate(() => { frame("registered", { ...structuredClone(streamRegistration), binding: expected.binding, id: expected.id }); frame("progress", { state: "active" }); });
    finish = () => frame("terminal", { id: expected.id, nativeTerminal: true, campaign, sealSha256: "f".repeat(64) });
    const timer = setInterval(() => {
      if (!p.h.saved().control.sealed.includes("bootstrap")) return;
      clearInterval(timer);
      if (withheldReady) { withheldReady.live(p.h); return; }
      frame("audit-begin", { campaign, group, subjectSha256 });
      frame("audit-file", { group, path: prefix + "-audit-subject.json", bytes: subject.length, sha256: digest(subject) });
      frame("audit-data", { offset: 0, data: subject.toString("base64") }); frame("audit-file-end", {}); frame("audit-end", { group, subjectSha256 });
    }, 5);
    stopStream = () => { clearInterval(timer); close(255); };
    t.after(stopStream); return child;
  };
  const approval = await p.approve("--detach");
  if (withheldReady) {
    const factory = p.deps.providerFactory;
    p.deps.providerFactory = (options) => Object.assign(factory(options), { close: withheldReady.settle });
  }
  const pending = productionMain(approval, p.deps);
  withheldReady?.started(pending, () => stopStream?.());
  let launchError;
  pending.then((code) => { launchError = new Error(`audit controller exited before ready (${code})`); },
    (error) => { launchError = error; });
  const wait = async (predicate, timeout = 2000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) { assert.ok(Date.now() < deadline, "bounded audit stream wait"); await new Promise((r) => setTimeout(r, 5)); }
  };
  try {
    const ready = join(p.h.local, "monitor-audit-" + group + "-ready.json");
    await wait(() => {
      if (launchError) throw launchError;
      return existsSync(ready);
    }, auditStartupMs);
  } catch (error) {
    // Do not let the harness remove the directory while launch still owns its locks.
    flags.cancelled = true;
    stopStream?.();
    await pending.catch(() => {});
    throw error;
  }
  const args = ["r21", "--state-dir", p.h.base, "--deliver-audit", path, "--audit-group", group, "--campaign", campaign, "--approve-subject", subjectSha256];
  const approve = async () => {
    await productionMain([...args, "--print-approval"], p.deps);
    return [...args, "--approve-reviewed-merged-ready", p.stdout.at(-1).approvalSha256];
  };
  return { ...p, path, input, wait, approve, started: () => started, finish: async () => { finish(); await pending; } };
}

test("supervised approved audit delivery uses locked production approval and the existing stream for JSON and mixed", async (t) => {
  for (const group of ["json-api", "mixed-production"]) {
    const flags = {}, p = await supervisedAudit(t, group, flags); let checked = 0;
    try {
      const approval = await p.approve(), calls = p.calls.length;
      flags.underAuditLock = () => { checked++; assert.ok(existsSync(join(p.h.local, "operation.lock"))); };
      assert.equal(await productionMain(approval, p.deps), 3); assert.equal(checked, 1);
      await p.wait(() => p.input.some((v) => v.kind === "delivery-end"));
      const frames = p.input.filter((v) => v.kind.startsWith("delivery-"));
      assert.deepEqual(frames.map((v) => v.kind), ["delivery-begin", "delivery-data", "delivery-end"]);
      assert.equal(Buffer.from(frames[1].payload.data, "base64").toString(), readFileSync(p.path, "utf8"));
      assert.equal(p.started(), 1); assert.ok(p.calls.slice(calls).every(([binary]) => binary === "git"));
      assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
      assert.ok(!existsSync(join(p.h.local, "audit-delivery.lock")));
      await assert.rejects(productionMain(approval, p.deps), /already queued/);
      assert.equal(p.input.filter((v) => v.kind === "delivery-begin").length, 1);
    } finally { await p.finish(); }
    assert.ok(!existsSync(join(p.h.local, "operation.lock")));
  }
});

test("supervised audit startup surfaces a controller failure before the ready marker", async (t) => {
  await assert.rejects(supervisedAudit(t, "json-api", { bootstrapError: true }), {
    controllerStage: "controller-launch", message: /^common bootstrap marker observation failed/,
  });
});

test("bootstrap marker diagnostic preserves command acknowledgement, polling, and custody", async (t) => {
  for (const [mode, detail, uncertain] of [
    ["lost-completion", "remote-completion-unconfirmed", true],
    ["unacknowledged-pending", "remote-completion-unconfirmed", true],
    ["local-process-error", "local-control-uncertain", true],
    ["acknowledged-refusal", "acknowledged-exit-refused", false],
    ["invalid-marker", "marker-invalid", false],
    ["pending-then-ready", undefined, false],
  ]) await t.test(mode, async (t) => {
    const p = productionHarness(t, { active: true, bootstrapPending: ["pending-then-ready", "unacknowledged-pending"].includes(mode) ? 1 : 0,
      bootstrapError: mode === "acknowledged-refusal" });
    p.deps.compiler = () => true; // Synthetic launch stops at the controller and never loads the compiler.
    const input = `set -euo pipefail\n${bootstrapReadScript}\n`, readDigest = digest(input), readRows = () => p.h.saved().control.ledger
      .filter(({ request }) => request.invocation.requestSha256 === readDigest);
    const locks = [join(p.h.local, "operation.lock"), join(p.h.base, ".groups-launch.lock")];
    const raw = "SYNTHETIC_PRIVATE_BOOTSTRAP_OUTPUT";
    const spawn = p.deps.spawn, streamSpawn = p.deps.streamSpawn;
    let reads = 0, monitors = 0, error;
    p.deps.streamSpawn = (...args) => { monitors++; return streamSpawn(...args); };
    p.deps.spawn = (binary, argv, options) => {
      const result = spawn(binary, argv, options);
      if (binary !== "ssh" || !options.input?.endsWith(input)) return result;
      reads++;
      assert.deepEqual(locks.map(existsSync), [true, true]);
      if (["lost-completion", "unacknowledged-pending"].includes(mode)) {
        assert.equal(result.status, mode === "lost-completion" ? 0 : 3);
        return { ...result, stdout: raw, stderr: result.stderr.split("\n")[0] + "\n" + raw };
      }
      if (mode === "local-process-error") return { ...result, status: null, stdout: raw, error: new Error(raw) };
      return mode === "invalid-marker" ? { ...result, stdout: raw } : result;
    };
    const approval = await p.approve("--detach");
    if (detail) await assert.rejects(productionMain(approval, p.deps), (value) => { error = value; return true; });
    else assert.equal(await productionMain(approval, p.deps), 3);
    assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
    const saved = p.h.saved(), rows = readRows();
    assert.equal(saved.status, "running");
    assert.deepEqual(locks.map(existsSync), [uncertain, uncertain]);
    if (detail) {
      assert.equal(reads, 1); assert.equal(monitors, 0);
      assert.equal(p.calls.at(-1)[0], "ssh");
      assert.ok(p.calls.at(-1)[2].input.endsWith(input), "no request follows the refused marker read");
      assert.deepEqual(saved.control.sealed, []); assert.equal(saved.control.monitor.phase, "pending");
      assert.equal(saved.control.monitor.registrationSha256, undefined);
      assert.deepEqual(rows, saved.control.ledger.slice(-1));
      assert.deepEqual(rows.map(({ localTerminal, code }) => [localTerminal, code]),
        [[!uncertain, uncertain ? undefined : mode === "acknowledged-refusal" ? 1 : 0]]);
      assert.equal(!!error.controlTreeUncertain, uncertain);
      assert.ok(!publicError(error).includes(raw));
      t.diagnostic(publicError(error));
      assert.deepEqual(providerFailure(error), { code: "bootstrap-marker", detail });
      assert.equal(publicError(error), `${publicError()} Controller stage: controller-launch. Bootstrap marker: ${detail}.`);
    } else {
      assert.equal(reads, 2); assert.equal(monitors, 1);
      assert.deepEqual(rows.map(({ localTerminal, code }) => [localTerminal, code]), [[true, 3], [true, 0]]);
      assert.deepEqual(saved.control.sealed, ["bootstrap"]); assert.equal(saved.control.monitor.phase, "closed");
    }
  });
});

test("supervised audit startup timeout cancels and joins a registered monitor before fixture cleanup", { timeout: 10000 }, async (t) => {
  const live = Promise.withResolvers(), settling = Promise.withResolvers(), release = Promise.withResolvers();
  const flags = {}; let launch, settled = 0, settledAtReturn;
  // Register before the harness adds its directory removal hook.
  t.after(async () => {
    flags.cancelled = true;
    release.resolve();
    launch?.stop();
    await (launch?.pending ?? audit).catch(() => {});
  });
  const audit = supervisedAudit(t, "json-api", flags, {
    live: live.resolve,
    started(pending, stop) { launch = { pending, stop }; },
    async settle() { settling.resolve(); await release.promise; settled++; },
  }).finally(() => { settledAtReturn = settled; });
  const rejected = assert.rejects(audit, { message: "bounded audit stream wait" });
  const rejectedEarly = rejected.then(() => assert.fail("startup returned before controller settlement"));
  let h;
  try {
    h = await Promise.race([live.promise, rejectedEarly]);
    const ready = join(h.local, "monitor-audit-json-api-ready.json");
    assert.equal(h.saved().control.monitor.phase, "live");
    assert.ok(!existsSync(ready));
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + auditStartupMs + 1 });
    await Promise.race([settling.promise, rejectedEarly]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settledAtReturn, undefined, "startup must wait for settlement");
    assert.equal(flags.cancelled, true);
    assert.equal(JSON.parse(readFileSync(join(h.local, "monitor-local-closed.json"))).code, 255);
    assert.equal(h.saved().control.monitor.phase, "invalid");
    assert.ok(!existsSync(ready));
  } finally { release.resolve(); }
  await rejected;
  assert.equal(settledAtReturn, 2);
  assert.ok(existsSync(h.temp));
  t.after(() => assert.ok(!existsSync(h.temp)));
});

test("supervised audit rejects a stale explicit action approval before any publication", async (t) => {
  const p = await supervisedAudit(t, "json-api");
  try {
    const approval = await p.approve(), calls = p.calls.length;
    const value = JSON.parse(readFileSync(p.path)); value.review.reviewer = "replaced reviewer";
    writeFileSync(p.path, JSON.stringify(value));
    await assert.rejects(productionMain(approval, p.deps), /explicit operator-approved exact action/);
    assert.ok(!existsSync(join(p.h.local, "monitor-delivery-json-api.json")));
    assert.ok(p.calls.slice(calls).every(([binary]) => binary === "git"));
    assert.equal(p.input.filter((v) => v.kind.startsWith("delivery-")).length, 0);
  } finally { await p.finish(); }
});

test("supervised audit rechecks replacement delivery and reservation under its exclusive lock", async (t) => {
  for (const group of ["json-api", "mixed-production"]) for (const replaced of ["delivery", "reservation"]) {
    const flags = {}, p = await supervisedAudit(t, group, flags);
    try {
      const approval = await p.approve(), calls = p.calls.length;
      flags.underAuditLock = () => {
        flags.underAuditLock = undefined;
        assert.ok(existsSync(join(p.h.local, "operation.lock")));
        if (replaced === "delivery") {
          const value = JSON.parse(readFileSync(p.path)); value.review.reviewer = "replaced after preflight";
          writeFileSync(p.path, JSON.stringify(value));
        } else p.h.change((s) => { s.auditIntents = {}; });
      };
      await assert.rejects(productionMain(approval, p.deps), /locked action changed after approval/);
      assert.ok(!existsSync(join(p.h.local, "monitor-delivery-" + group + ".json")));
      assert.ok(!existsSync(join(p.h.local, "audit-delivery.lock")));
      assert.ok(existsSync(join(p.h.local, "operation.lock")));
      assert.equal(p.started(), 1); assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
      assert.ok(p.calls.slice(calls).every(([binary]) => binary === "git"));
      assert.equal(p.input.filter((v) => v.kind.startsWith("delivery-")).length, 0);
    } finally { await p.finish(); }
  }
});

test("supervised audit refuses a competing publication lock without touching live monitor custody", async (t) => {
  const p = await supervisedAudit(t, "mixed-production");
  try {
    const approval = await p.approve();
    writeFileSync(join(p.h.local, "audit-delivery.lock"), "competing approved publisher");
    await assert.rejects(productionMain(approval, p.deps), /EEXIST/);
    assert.equal(readFileSync(join(p.h.local, "audit-delivery.lock"), "utf8"), "competing approved publisher");
    assert.ok(existsSync(join(p.h.local, "operation.lock")));
    assert.ok(!existsSync(join(p.h.local, "monitor-delivery-mixed-production.json")));
    assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  } finally { await p.finish(); }
});

test("supervised audit never consumes or replaces an interrupted pending publication", async (t) => {
  const p = await supervisedAudit(t, "mixed-production");
  try {
    const approval = await p.approve(), target = join(p.h.local, "monitor-delivery-mixed-production.json");
    writeFileSync(target + ".pending", "interrupted publisher evidence");
    await assert.rejects(productionMain(approval, p.deps), /EEXIST/);
    assert.ok(!existsSync(target)); assert.equal(readFileSync(target + ".pending", "utf8"), "interrupted publisher evidence");
    assert.ok(!existsSync(join(p.h.local, "audit-delivery.lock"))); assert.ok(existsSync(join(p.h.local, "operation.lock")));
    assert.equal(p.input.filter((v) => v.kind.startsWith("delivery-")).length, 0);
    assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  } finally { await p.finish(); }
});

test("supervised audit settlement uncertainty retains both locks and never repeats a queued delivery", async (t) => {
  const flags = {}, p = await supervisedAudit(t, "json-api", flags), factory = p.deps.providerFactory;
  let fail = false, closed = 0;
  p.deps.providerFactory = (options) => {
    const run = factory(options);
    run.close = async () => { closed++; if (fail) throw Object.assign(new Error("synthetic unsettled control"), { controlTreeUncertain: true, controlUncertain: true }); };
    return run;
  };
  try {
    const approval = await p.approve(); closed = 0;
    flags.underAuditLock = () => { fail = true; };
    await assert.rejects(productionMain(approval, p.deps), (error) => error.controlTreeUncertain && error.controlUncertain && error.controllerStage === "provider-settlement");
    assert.equal(closed, 2); assert.ok(existsSync(join(p.h.local, "audit-delivery.lock")));
    assert.ok(existsSync(join(p.h.local, "operation.lock")));
    assert.ok(existsSync(join(p.h.local, "monitor-delivery-json-api.json")));
    fail = false; flags.underAuditLock = undefined;
    await assert.rejects(productionMain(approval, p.deps), /EEXIST/);
    await p.wait(() => p.input.some((v) => v.kind === "delivery-end"));
    assert.equal(p.input.filter((v) => v.kind === "delivery-begin").length, 1);
    assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  } finally { await p.finish(); }
});

test("production entry forwards source-bound stream registration and settles asynchronous stream failure without dropping custody", async (t) => {
  const p = productionHarness(t, { active: true }); let started = 0, closed = 0;
  const originalFactory = p.deps.providerFactory;
  p.deps.providerFactory = (options) => { const run = originalFactory(options); run.close = async () => { closed++; }; return run; };
  p.deps.streamSpawn = (binary, argv, options) => {
    started++; assert.equal(binary, "ssh"); assert.equal(options.shell, false); assert.equal(options.cwd, p.h.repo);
    const expected = JSON.parse(Buffer.from(argv.at(-1).split(" ").at(-1), "hex"));
    assert.equal(expected.id, p.h.saved().control.monitor.id); assert.equal(expected.binding.helperSha256, p.h.saved().control.helperSha256);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, next) { next(); } });
    child.stdin.on("close", () => setImmediate(() => child.emit("close", 255, null)));
    setImmediate(() => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1", id: expected.id, sequence: 2,
      kind: "registered", payload: { ...structuredClone(streamRegistration), binding: expected.binding, id: expected.id } }) + "\n"));
    return child;
  };
  const approval = await p.approve("--detach"); closed = 0;
  await assert.rejects(productionMain(approval, p.deps), (error) => error.controlTreeUncertain === true && error.controllerStage === "controller-launch");
  assert.equal(started, 1); assert.equal(closed, 2);
  assert.ok(existsSync(join(p.h.local, "operation.lock"))); assert.ok(existsSync(join(p.h.base, ".groups-launch.lock")));
  assert.ok(existsSync(join(p.h.local, "monitor-invalid.json"))); assert.equal(p.h.deletes, 0);
});

for (const acknowledged of [true, false]) test("cancelled unit query records only an acknowledged exit: " + acknowledged, async t => {
  const flags = { active: true }, p = productionHarness(t, flags);
  await p.h.launch().launch(); flags.active = false;
  const closed = JSON.parse(readFileSync(join(p.h.local, "monitor-local-closed.json")));
  t.mock.timers.enable({ apis: ["Date"], now: closed.recoverAfterMs + 1 });
  const spawn = p.deps.spawn;
  p.deps.spawn = (binary, argv, options) => {
    const result = spawn(binary, argv, options);
    if (binary === "ssh" && options.input?.includes("--property=ControlPID")) {
      assert.equal(result.status, 0); flags.cancelled = true;
      if (!acknowledged) return { ...result, stderr: "" };
    }
    return result;
  };
  await assert.rejects(productionMain(await p.approve("--collect"), p.deps),
    e => acknowledged ? /controller cancelled/.test(e.message) : e.controlTreeUncertain === true);
  const row = p.h.saved().control.ledger.at(-1);
  assert.ok(flags.cancelled); assert.equal(p.h.deletes, 0);
  assert.equal(row.localTerminal, acknowledged); assert.equal(row.code, acknowledged ? 0 : undefined);
  assert.equal(existsSync(join(p.h.local, "operation.lock")), !acknowledged);
  if (acknowledged) {
    p.deps.spawn = spawn; flags.cancelled = false;
    assert.equal(await productionMain(await p.approve("--collect"), p.deps), 1); assert.equal(p.h.deletes, 1);
  }
});

for (const phase of ["pending", "live"]) test("wire registration survives launch cancellation while " + phase, async (t) => {
  const p = productionHarness(t, { active: true }), local = p.h.local, registration = join(local, "monitor-registration.json");
  let atCancel;
  p.deps.interrupted = () => {
    if (atCancel === undefined && existsSync(registration) && p.h.saved().control.monitor.phase === phase) atCancel = p.calls.length;
    return atCancel !== undefined;
  };
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps), (e) => e.controlTreeUncertain === true && e.controllerStage === "controller-launch");
  assert.equal(p.calls.length, atCancel, "no transport command after cancellation");
  const { control } = p.h.saved(), reg = JSON.parse(readFileSync(registration));
  assert.equal(control.monitor.phase, "invalid"); assert.equal(control.monitor.id, reg.id);
  assert.equal(control.monitor.registrationSha256, digest(JSON.stringify(reg)));
  assert.deepEqual(control.sealed, []); assert.ok(!control.ledger.some((r) => r.request.seal));
  assert.ok(existsSync(join(local, "operation.lock")) && existsSync(join(p.h.base, ".groups-launch.lock")));
  const close = JSON.parse(readFileSync(join(local, "monitor-local-closed.json")));
  assert.equal(close.id, reg.id); assert.equal(close.remoteDrained, false); assert.ok(existsSync(join(local, "monitor-invalid.json")));

  // Fresh approval, after actual local closure and the unchanged embargo.
  t.mock.timers.enable({ apis: ["Date"], now: close.recoverAfterMs + 1 });
  p.deps.interrupted = () => false;
  assert.equal(await productionMain(await p.approve("--collect"), p.deps), 3);
  assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  assert.ok(existsSync(join(local, "operation.lock")) && existsSync(join(p.h.base, ".groups-launch.lock")));
});

test("production entry keeps the single stream alive through bootstrap seal and awaits local close before teardown", async (t) => {
  const p = productionHarness(t, { active: true }); let started = 0, streamClosed = false, providerClosed = 0;
  p.deps.streamSpawn = (binary, argv) => {
    started++; assert.equal(binary, "ssh");
    const expected = JSON.parse(Buffer.from(argv.at(-1).split(" ").at(-1), "hex")), child = new EventEmitter(); let sequence = 0;
    const frame = (kind, payload) => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1", id: expected.id, sequence: ++sequence, kind, payload }) + "\n");
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, next) {
      if (JSON.parse(bytes).kind === "close") setImmediate(() => { streamClosed = true; child.emit("close", 0, null); }); next();
    } });
    setImmediate(() => { frame("registered", { ...structuredClone(streamRegistration), binding: expected.binding, id: expected.id }); frame("progress", { state: "active" }); });
    const deadline = Date.now() + 1500, timer = setInterval(() => {
      if (p.h.saved().control.sealed.includes("bootstrap")) {
        clearInterval(timer); frame("terminal", { id: expected.id, nativeTerminal: true, campaign: "r21-0123456789abcdef", sealSha256: "f".repeat(64) });
      } else if (Date.now() > deadline) { clearInterval(timer); child.emit("close", 255, null); }
    }, 5);
    t.after(() => clearInterval(timer)); return child;
  };
  const approval = await p.approve("--detach"), factory = p.deps.providerFactory;
  p.deps.providerFactory = (options) => { const run = factory(options); run.close = async () => { assert.equal(streamClosed, true); providerClosed++; }; return run; };
  assert.equal(await productionMain(approval, p.deps), 3); assert.equal(started, 1); assert.equal(providerClosed, 2);
  assert.equal(p.h.saved().control.monitor.phase, "closed"); assert.deepEqual(p.h.saved().control.sealed, ["bootstrap"]);
  assert.ok(p.h.saved().control.ledger.every((row) => row.localTerminal)); assert.ok(!existsSync(join(p.h.local, "operation.lock")));
  const terminal = JSON.parse(readFileSync(join(p.h.local, "monitor-terminal.json"))); assert.equal(terminal.remoteDrained, false);
  assert.equal(p.h.deletes, 0);
});

test("production failed bootstrap seal settles its already-ready stream and retains custody", async (t) => {
  const p = productionHarness(t, { active: true, sealFail: true }), start = p.deps.streamSpawn;
  let child, closed = false;
  p.deps.streamSpawn = (...args) => { child = start(...args); child.once("close", () => { closed = true; }); return child; };
  try {
    await assert.rejects(productionMain(await p.approve("--detach"), p.deps), (error) => error.controlTreeUncertain === true);
    assert.equal(closed, true); assert.ok(existsSync(join(p.h.local, "monitor-invalid.json")));
    assert.ok(existsSync(join(p.h.local, "operation.lock"))); assert.ok(existsSync(join(p.h.base, ".groups-launch.lock")));
    assert.equal(p.h.deletes, 0);
  } finally {
    if (child && !closed) { const done = new Promise((resolve) => child.once("close", resolve)); child.stdin.destroy(); await done; }
  }
});

test("preview is local/read-only, missing isolated integration is explicit and cannot allocate", async (t) => {
  const p = productionHarness(t, { missingNative: true });
  assert.equal(await productionMain([...p.args("--detach"), "--print-approval"], p.deps), 2);
  assert.deepEqual(p.stdout[0].missing, [...nativePaths, ...benchPackagePaths]); assert.equal(p.stdout[0].fullGroupQualified, false);
  assert.ok(p.calls.every(([b, a]) => b === "git" && a[0] !== "fetch")); assert.ok(!existsSync(p.h.local));
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps), /integration missing/); assert.equal(p.h.creates, 0);
});

test("detach preview requires both committed bench package files before any reservation", async (t) => {
  for (const absent of [benchPackagePaths, [benchPackagePaths[0]], [benchPackagePaths[1]]]) {
    const p = productionHarness(t, { missingPaths: absent });
    assert.equal(await productionMain([...p.args("--detach"), "--print-approval"], p.deps), 2);
    assert.deepEqual(p.stdout[0].missing, absent);
    await assert.rejects(productionMain(await p.approve("--detach"), p.deps), /integration missing/);
    assert.ok(p.calls.every(([b, a]) => b === "git" && a[0] !== "fetch")); assert.equal(p.h.creates, 0); assert.ok(!existsSync(p.h.local));
  }
  // Collection keeps its saved reservation; only a new launch installs the bench package.
  const p = productionHarness(t, { missingPaths: benchPackagePaths }); p.h.seed();
  assert.equal(await productionMain([...p.args(), "--print-approval"], p.deps), 3); assert.deepEqual(p.stdout[0].missing, []);
});

test("detach and native collection previews name a missing local bench install before allocation or collection", async (t) => {
  const launch = productionHarness(t); launch.deps.compiler = () => false;
  assert.equal(await productionMain([...launch.args("--detach"), "--print-approval"], launch.deps), 2);
  assert.deepEqual(launch.stdout[0].missing, [localCompilerMissing]); assert.match(localCompilerMissing, /run npm --prefix bench ci/);
  await assert.rejects(productionMain(await launch.approve("--detach"), launch.deps), /integration missing/);
  assert.ok(launch.calls.every(([b, a]) => b === "git" && a[0] !== "fetch")); assert.equal(launch.h.creates, 0); assert.ok(!existsSync(launch.h.local));
  const collect = productionHarness(t); collect.h.seed(); collect.deps.compiler = () => false;
  const saved = readFileSync(collect.h.statePath);
  assert.equal(await productionMain([...collect.args(), "--print-approval"], collect.deps), 2);
  assert.deepEqual(collect.stdout[0].missing, [localCompilerMissing]);
  await assert.rejects(productionMain(await collect.approve(), collect.deps), /integration missing/);
  assert.ok(collect.calls.every(([b, a]) => b === "git" && a[0] !== "fetch")); assert.ok(readFileSync(collect.h.statePath).equals(saved));
  assert.equal(collect.h.deletes, 0);
  // Unused-host retirement replays no native evidence, so it does not need the install.
  const unused = unusedBootstrapAttempt(t); unused.deps.compiler = () => false;
  await unused.approve(); assert.deepEqual(unused.stdout.at(-1).missing, []);
});

// The approval hash excludes missing inputs, so the locked plan must check them itself.
test("a bench install lost after the source recheck stops launch and collection at the locked plan, before provider access", async (t) => {
  for (const mode of ["--detach", undefined]) {
    const p = productionHarness(t); if (!mode) p.h.seed();
    const approved = await p.approve(mode), calls = p.calls.length;
    let checks = 0; p.deps.compiler = () => ++checks < 3; // Approved plan and source recheck ready, locked plan missing.
    await assert.rejects(productionMain(approved, p.deps), /integration missing/);
    assert.equal(checks, 3, "the third check is the locked plan's");
    assert.ok(p.calls.slice(calls).every(([binary]) => binary === "git"), "no provider or host access");
    assert.equal(p.h.creates, 0); assert.equal(p.h.deletes, 0);
  }
});
test("state aliases with resolved SSH expansion characters refuse preview and approved launch before provider access", async (t) => {
  for (const approved of [false, true]) {
    for (const nested of [false, true]) {
      const p = productionHarness(t);
      const values = p.args("--detach");
      if (nested) values[values.indexOf("--state-dir") + 1] = join(p.h.base, "new", "state");
      await productionMain([...values, "--print-approval"], p.deps);
      const args = approved ? [...values, "--approve-reviewed-merged-ready", p.stdout.at(-1).approvalSha256] : [...values, "--print-approval"];
      const target = `${p.h.base}$physical`;
      renameSync(p.h.base, target); symlinkSync(target, p.h.base, process.platform === "win32" ? "junction" : "dir");
      p.calls.length = 0; p.stdout.length = 0;
      await assert.rejects(productionMain(args, p.deps), /SSH config expansion/);
      assert.equal(p.h.creates, 0); assert.equal(p.h.deletes, 0);
      assert.deepEqual(p.calls, []); assert.deepEqual(p.stdout, []); assert.ok(!existsSync(p.h.local));
      if (nested) assert.ok(!existsSync(join(target, "new")));
    }
  }
});

test("ordinary state alias preserves preview and approved composed launch", async (t) => {
  const p = productionHarness(t, { active: true }), target = `${p.h.base} ordinary 'physical'`;
  renameSync(p.h.base, target); symlinkSync(target, p.h.base, process.platform === "win32" ? "junction" : "dir");
  const approval = await p.approve("--detach");
  assert.ok(!existsSync(p.h.local));
  assert.equal(await productionMain(approval, p.deps), 3);
  assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0); assert.equal(p.h.saved().status, "running");
  assert.equal(p.calls.filter(([b, , o]) => b === "ssh" && o.input.includes("systemctl start")).length, 1);
  assert.equal(await productionMain(await p.approve(), p.deps), 3);
  assert.equal(p.h.units, 2); assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
});

test("missing or inaccessible physical roots reject before child timeout and any process call", (t) => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"]) {
    const h = harness(t);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("cloud-path-fixture.mjs", import.meta.url)), code, h.temp],
      { encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { code, calls: 0, bounded: true });
  }
});

test("nonexistent Windows drive rejects before child timeout", { skip: process.platform !== "win32" }, (t) => {
  const drive = [..."ZYXWVUTSRQPONMLKJIHGFED"].find((letter) => !existsSync(`${letter}:\\`));
  if (!drive) { t.skip("no missing local drive available"); return; }
  const h = harness(t);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("cloud-path-fixture.mjs", import.meta.url)), "windows", h.temp, `${drive}:\\state`],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { code: "windows", calls: 0, bounded: true });
});

test("normal new state directories preview without writes and create a bounded core root", async (t) => {
  const p = productionHarness(t), stateDir = join(p.h.base, "new", "state"), values = p.args("--detach");
  values[values.indexOf("--state-dir") + 1] = stateDir;
  assert.equal(await productionMain([...values, "--print-approval"], p.deps), 3);
  assert.ok(!existsSync(join(p.h.base, "new"))); assert.ok(p.calls.every(([b]) => b === "git"));
  const { controller } = await import("./droplet.mjs");
  controller({ round: "r21", stateDir, detach: true, commit, sshKey: "42", accountId, context }, { repo: p.h.repo, run() { assert.fail("unexpected process"); } });
  assert.ok(existsSync(stateDir)); assert.ok(!existsSync(join(stateDir, "groups-r21"))); assert.equal(p.h.creates, 0);
});

test("role preflight blocks preview and rechecks before the first provider operation under the launch lock", async (t) => {
  const denied = "hardening: isolated benign service/recovery actor proof unavailable; connection-flood resistance not measured";
  const blocked = productionHarness(t, { roleCheck: () => [denied] });
  assert.equal(await productionMain([...blocked.args("--detach"), "--print-approval"], blocked.deps), 2);
  assert.deepEqual(blocked.stdout.at(-1).missing, [denied]);
  assert.ok(blocked.calls.every(([binary]) => binary === "git"));
  assert.ok(!existsSync(blocked.h.local));

  let checks = 0;
  const locked = productionHarness(t, { roleCheck: ({ commit: measured, group, mode }) => {
    assert.equal(measured, commit); assert.equal(group, undefined); assert.equal(mode, undefined);
    return ++checks === 4 ? [denied] : [];
  } });
  const approved = await locked.approve("--detach");
  await assert.rejects(productionMain(approved, locked.deps), /integration missing/);
  assert.equal(checks, 4); assert.equal(locked.h.creates, 0);
  assert.ok(locked.calls.every(([binary]) => binary === "git"));
});

test("no/mismatched approval, dirty/mismatched source, unmerged head and fetch failure make no cloud calls", async (t) => {
  for (const flags of [{}, { dirty: true }, { wrongSource: true }, { unmerged: true }, { fetchError: true }]) {
    const p = productionHarness(t, flags);
    await assert.rejects(productionMain(p.args("--detach"), p.deps));
    if (!flags.dirty && !flags.wrongSource) {
      await assert.rejects(productionMain([...p.args("--detach"), "--approve-reviewed-merged-ready", "f".repeat(64)], p.deps));
      if (flags.unmerged || flags.fetchError) await assert.rejects(productionMain(await p.approve("--detach"), p.deps));
    }
    assert.ok(p.calls.every(([binary]) => binary === "git")); assert.ok(!existsSync(p.h.local));
  }
});

test("pre-reservation failures retain their closed controller stage without cloud calls", async (t) => {
  for (const [flags, stage] of [[{ fetchError: true }, "remote-main-fetch"], [{ unmerged: true }, "remote-main-ancestry"]]) {
    const p = productionHarness(t, flags), approval = await p.approve("--detach");
    await assert.rejects(productionMain(approval, p.deps), (error) => {
      assert.equal(error.controllerStage, stage); return true;
    });
    assert.ok(p.calls.every(([binary]) => binary === "git"));
    assert.ok(!existsSync(p.h.local)); assert.equal(p.h.creates, 0);
  }
});

test("frozen settlement failures retain their stronger uncertainty and stage", async (t) => {
  const p = productionHarness(t, { fetchError: true }), approval = await p.approve("--detach");
  const factory = p.deps.providerFactory;
  p.deps.providerFactory = (options) => {
    const provider = factory(options);
    provider.close = async () => { throw Object.freeze(Object.assign(new Error("PRIVATE_CLOSE"), {
      controlTreeUncertain: true, controlUncertain: true, providerDiagnostic: { code: "get-http", httpStatus: 503 },
    })); };
    return provider;
  };
  await assert.rejects(productionMain(approval, p.deps), (error) => {
    assert.equal(error.controllerStage, "provider-settlement");
    assert.equal(error.controlTreeUncertain, true); assert.equal(error.controlUncertain, true);
    assert.deepEqual(error.providerDiagnostic, { code: "get-http", httpStatus: 503 }); return true;
  });
  assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.creates, 0);
});

test("approved composed transport provisions fixed files and starts exactly once", async (t) => {
  const p = productionHarness(t, { active: true }), approval = await p.approve("--detach");
  assert.equal(await productionMain(approval, p.deps), 3); assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  assert.equal(p.calls.filter(([b, , o]) => b === "ssh" && o.input.includes("systemctl start")).length, 1);
  assert.equal(p.calls.filter(([b, , o]) => b === "ssh" && o.input.includes("sha256sum --check")).length, 3);
  assert.equal(p.h.saved().fullGroupQualified, false);
  assert.ok(readFileSync(join(p.h.local, "job.sh"), "utf8").includes("git merge-base --is-ancestor"));
  await assert.rejects(productionMain(approval, p.deps), /reserved/); assert.equal(p.h.creates, 1);
});

test("production timed-out create retains uncertainty and both locks instead of treating an unsettled request as absent", async (t) => {
  const p = productionHarness(t, { createLost: true });
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps), (error) => error.controlUncertain === true);
  assert.equal(p.h.creates, 1); assert.equal(p.h.saved().status, "creating"); assert.equal(p.h.deletes, 0);
  assert.ok(existsSync(join(p.h.local, "operation.lock"))); assert.ok(existsSync(join(p.h.base, ".groups-launch.lock")));
  await assert.rejects(productionMain(await p.approve(), p.deps)); assert.equal(p.h.creates, 1);
});

test("failed upload verification never starts or deletes the owned host", async (t) => {
  const p = productionHarness(t, { uploadHashError: true });
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps));
  assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  assert.ok(!p.calls.some(([b, , o]) => b === "ssh" && o.input.includes("systemctl start")));
  assert.ok(existsSync(join(p.h.local, "job.sh"))); assert.equal(p.h.saved().status, "preparing");
});

test("approved running collect observes once; terminal blocked collect retains evidence before one delete", async (t) => {
  for (const active of [true, false]) {
    const p = productionHarness(t, { active }); p.h.seed();
    assert.equal(await productionMain(await p.approve(), p.deps), active ? 3 : 1);
    assert.equal(p.h.deletes, active ? 0 : 1); assert.equal(p.h.saved().fullGroupQualified, false);
    if (active) assert.equal(p.h.units, 1);
    else { assert.ok(p.h.saved().destroyedAt); assert.ok(existsSync(join(p.h.local, "results.tgz"))); }
  }
});

test("production collect preserves closed replay stages but not private inspector evidence", async (t) => {
  const privateText = "SYNTHETIC_PRIVATE_REPLAY";
  for (const [stage, inspect] of [
    ["collect-native-replay-start", () => { throw new Error(privateText); }],
    ["collect-native-replay-refused", async () => { throw new Error(privateText); }],
    ["collect-native-report-refused", async () => ({ invalidReport: privateText })],
  ]) await t.test(stage, async (child) => {
    const p = productionHarness(child, { active: false }); p.h.seed();
    p.deps.inspect = inspect;
    const approval = await p.approve();
    await assert.rejects(productionMain(approval, p.deps), (error) =>
      error.controllerStage === stage && publicError(error) === `${publicError()} Controller stage: ${stage}.`);
    assert.equal(p.h.deletes, 0);
    assert.ok(existsSync(join(p.h.local, "results.tgz")));
  });
});

test("approval binds saved identity and detects state changes during merge verification", async (t) => {
  const flags = {}, p = productionHarness(t, flags); p.h.seed(); const approval = await p.approve();
  flags.afterFetch = () => p.h.change((s) => { s.token = "f".repeat(16); });
  await assert.rejects(productionMain(approval, p.deps)); assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.deletes, 0);
});

test("production deletion uncertainty is retained and a new approved collection never repeats delete", async (t) => {
  for (const flags of [{ deleteLost: true }, { deleteUnconfirmed: true }, { deleteRejected: true }]) {
    const p = productionHarness(t, flags); p.h.seed();
    await assert.rejects(productionMain(await p.approve(), p.deps));
    assert.equal(p.h.deletes, 1); assert.ok(p.h.saved().deletionIntentAt); assert.ok(!p.h.saved().destroyedAt);
    assert.ok(existsSync(join(p.h.local, "results.tgz")));
    if (flags.deleteRejected) assert.equal(await productionMain(await p.approve(), p.deps), 1);
    else await assert.rejects(productionMain(await p.approve(), p.deps), flags.deleteLost ? /EEXIST/ : /uncertain/);
    if (flags.deleteLost) assert.ok(existsSync(join(p.h.local, "operation.lock")));
    assert.equal(p.h.deletes, 1);
  }
});

test("production foreign identity and cancellation before provider access preserve resources", async (t) => {
  const p = productionHarness(t); p.h.seed(); p.h.hosts([]);
  await assert.rejects(productionMain(await p.approve(), p.deps)); assert.equal(p.h.deletes, 0);
  assert.ok(p.calls.every(([binary]) => !["ssh", "scp"].includes(binary)));
  const flags = {}, cancelled = productionHarness(t, flags); const approval = await cancelled.approve("--detach"); flags.cancelled = true;
  await assert.rejects(productionMain(approval, cancelled.deps)); assert.equal(cancelled.h.creates, 0); assert.ok(!existsSync(cancelled.h.local));
});

test("account changes cannot turn uncertain deletion into confirmed absence", async (t) => {
  const flags = { deleteUnconfirmed: true }, p = productionHarness(t, flags); p.h.seed();
  await assert.rejects(productionMain(await p.approve(), p.deps));
  assert.equal(p.h.deletes, 1); assert.ok(p.h.saved().deletionIntentAt);
  flags.accountId = "00000000-0000-4000-8000-000000000002"; p.h.hosts([]);
  await assert.rejects(productionMain(await p.approve(), p.deps), /account identity/);
  assert.ok(!p.h.saved().destroyedAt); assert.equal(p.h.deletes, 1);
});

test("account changes during the absence query also preserve deletion uncertainty", async (t) => {
  const flags = { deleteUnconfirmed: true }, p = productionHarness(t, flags); p.h.seed();
  await assert.rejects(productionMain(await p.approve(), p.deps));
  flags.hook = (binary, args) => {
    if (binary === "doctl" && args[2] === "get") { flags.accountId = "00000000-0000-4000-8000-000000000002"; p.h.hosts([]); }
  };
  await assert.rejects(productionMain(await p.approve(), p.deps), /account identity/);
  assert.ok(!p.h.saved().destroyedAt); assert.equal(p.h.deletes, 1);
});

test("approval binds account and context; legacy identity is never inferred", async (t) => {
  const p = productionHarness(t), approval = await p.approve("--detach");
  for (const [flag, value] of [["--account-id", "user:synthetic-other-user"], ["--context", "synthetic-other-context"]]) {
    const changed = [...approval]; changed[changed.indexOf(flag) + 1] = value;
    await assert.rejects(productionMain(changed, p.deps), /exact action/);
  }
  assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.creates, 0);
  p.h.seed(); p.h.change((s) => { delete s.provider; }); p.calls.length = 0;
  await assert.rejects(productionMain([...p.args(), "--print-approval"], p.deps), /saved provider identity/);
  assert.ok(p.calls.every(([binary]) => binary === "git"));
});

test("account mismatch prevents allocation and every provider call pins the saved context", async (t) => {
  const p = productionHarness(t, { accountId: "00000000-0000-4000-8000-000000000002" });
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps), /account identity/);
  assert.equal(p.h.creates, 0); assert.equal(p.h.deletes, 0); assert.deepEqual(p.h.saved().provider, { accountId, context });
  for (const [, args] of p.calls.filter(([binary]) => binary === "doctl")) assert.equal(args[args.indexOf("--context") + 1], context);
});

test("team changes under the same user cannot confirm account-scoped absence", async (t) => {
  const flags = { deleteUnconfirmed: true, teamId: "synthetic-team-a" }, p = productionHarness(t, flags); p.h.seed();
  p.h.change((s) => { s.provider.accountId = "team:synthetic-team-a"; });
  await assert.rejects(productionMain(await p.approve(), p.deps), /deletion not confirmed/);
  flags.teamId = "synthetic-team-b"; p.h.hosts([]);
  await assert.rejects(productionMain(await p.approve(), p.deps), /account identity/);
  assert.ok(!p.h.saved().destroyedAt); assert.equal(p.h.deletes, 1);
});

test("missing or malformed provider identity is never absence authority", async (t) => {
  for (const response of [[], [{ uuid: "synthetic-a" }, { uuid: "synthetic-b" }], {}, { uuid: "synthetic-a", team: {} }, { uuid: "synthetic-a", team: null }]) {
    const p = productionHarness(t); p.h.seed(); const request = p.deps.providerRequest;
    p.deps.providerRequest = (options) => options.path === "/v2/account" ? { status: 200, value: { account: response } } : request(options);
    await assert.rejects(productionMain(await p.approve(), p.deps), /account identity/);
    assert.equal(p.h.deletes, 0); assert.ok(!p.h.saved().destroyedAt);
  }
});

test("retargeting an ordinary alias invalidates the approved physical root before allocation", async (t) => {
  const p = productionHarness(t), approval = await p.approve("--detach"), target = `${p.h.base}-moved`;
  renameSync(p.h.base, target); symlinkSync(p.h.repo, p.h.base, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(productionMain(approval, p.deps), /exact action/);
  assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.creates, 0);
});

test("production grammar permits authorization only, never arbitrary settings/adapters", () => {
  assert.equal(controllerPaths.length, 38);
  for (const path of ["plan.mjs", "bounded-requests.mjs", "dependency-recovery-contract.mjs"])
    assert.ok(controllerPaths.includes(`bench/hardening/${path}`), `missing pinned fleet dependency: ${path}`);
  assert.ok(controllerPaths.includes("bench/workloads/cloud-sealed-collection.mjs"));
  assert.ok(controllerPaths.includes("bench/workloads/cloud-cancellation.mjs"));
  assert.ok(controllerPaths.includes("bench/workloads/cloud-retirement.mjs"));
  assert.ok(controllerPaths.includes("bench/workloads/cloud-setup-drain-source.mjs"));
  assert.ok(controllerPaths.includes("bench/workloads/cloud-validation-snapshot.mjs"));
  for (const path of ["fleet.mjs", "fleet-verify.mjs", "fleet-worker.mjs", "cloud-control-stream.mjs", "isolated/control-stream-source.mjs"])
    assert.ok(controllerPaths.includes(`bench/workloads/${path}`));
  const args = ["r21", "--collect", "--state-dir", resolve("outside")];
  const pin = ["--r21-measured-checkout", resolve("measured")], sha = ["--exit-archive-sha256", "a".repeat(64)];
  for (const suffix of [pin, sha, [...pin, ...sha, "--unused-bootstrap-known-hosts", resolve("verified")]])
    assert.throws(() => parseProductionArgs([...args, ...suffix]));
  assert.equal(parseProductionArgs([...args, ...pin, ...sha]).options.exitArchiveSha256, sha[1]);
  for (const suffix of [["--adapter", "evil"], ["--duration", "1"], ["--print-approval", "--print-approval"], ["--approve-reviewed-merged-ready", "not-a-hash"]])
    assert.throws(() => parseProductionArgs([...args, ...suffix]));
});

test("current saved-verifier checkout requirement fails before any provider access", async (t) => {
  const p = productionHarness(t); p.h.seed(); p.h.change((s) => { s.commit = "b".repeat(40); });
  await assert.rejects(productionMain([...p.args(), "--print-approval"], p.deps), /measured integrated checkout/);
  assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.deletes, 0);
});

function groupProduction(t, flags = {}) {
  flags.fleetGroup = groupNames[0];
  const p = productionHarness(t, flags), root = dirname(p.h.base), path = join(root, "fleet-r21.json");
  const fleet = fleetPlan({ round: "r21", commit, token: "f".repeat(16), sshKey: "42", provider: { accountId, context },
    tokens: Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")])) },
    undefined, undefined, { stagedPlacement: true });
  writeFileSync(path, JSON.stringify(fleet));
  const values = [...p.args("--detach"), "--group", groupNames[0], "--fleet", path];
  return { p, path, fleet, values, async approval() {
    assert.equal(await productionMain([...values, "--print-approval"], p.deps), 3);
    const { subject, approvalSha256 } = await fleetOperationPlan({ root, round: "r21", detach: true }, { repo: p.h.repo,
      plan: (options, deps) => productionPlan(options, { ...deps, roleCheck: p.deps.roleCheck }),
      run: (binary, argv, timeout = 60000) => p.deps.spawn(binary, argv, { timeout }) });
    const childApproval = p.stdout.at(-1).approvalSha256;
    assert.equal(subject.jobs[0].approvalSha256, childApproval);
    writeFileSync(join(root, "launch-intent.json"), JSON.stringify({ schema: "benchmark-group-fleet-staged-launch-intent/v1",
      approvalSha256, subject }));
    writeFileSync(join(root, ".fleet-operation.lock"), JSON.stringify({ pid: process.pid, approvalSha256 }));
    return [...values, "--approve-reviewed-merged-ready", childApproval];
  } };
}

test("v5 child CLI cannot launch without staged fleet admission or override its region", async (t) => {
  const g = groupProduction(t);
  assert.equal(await productionMain([...g.values, "--print-approval"], g.p.deps), 3);
  const firstApproval = g.p.stdout.at(-1).approvalSha256;
  await assert.rejects(productionMain([...g.values, "--approve-reviewed-merged-ready", firstApproval], g.p.deps), /launch-intent/);
  const approved = await g.approval();
  const lock = join(dirname(g.p.h.base), ".fleet-operation.lock");
  const savedLock = JSON.parse(readFileSync(lock));
  writeFileSync(lock, JSON.stringify({ ...savedLock, approvalSha256: "7".repeat(64) }));
  await assert.rejects(productionMain(approved, g.p.deps), /active batch lock/);
  const second = [...g.values];
  second[second.indexOf("--group") + 1] = groupNames[1];
  second[second.indexOf("--state-dir") + 1] = join(dirname(g.p.h.base), groupNames[1]);
  await assert.rejects(productionMain([...second, "--print-approval"], g.p.deps), /only fleet admission/);
  await assert.rejects(productionMain([...second, "--placement", "dedicated-lon1", "--print-approval"], g.p.deps), /unknown option/);
  assert.equal(g.p.h.creates, 0);
  assert.ok(g.p.calls.every(([binary]) => binary === "git"));
});

test("group production approval binds complete fleet bytes before any provider access", async (t) => {
  for (const mutate of [(g) => g.fleet.jobs.pop(), (g) => g.fleet.provider.context = "other",
    (g) => g.fleet.selection.groups[0].apps.pop(), (g) => g.fleet.sshKey = "99",
    (g) => g.fleet.jobs.reverse(), () => {}]) {
    const g = groupProduction(t), args = await g.approval(); mutate(g);
    // Even semantically identical bytes have a new explicit approval identity.
    writeFileSync(g.path, `${JSON.stringify(g.fleet, null, 2)}\n`);
    await assert.rejects(productionMain(args, g.p.deps));
    assert.equal(g.p.h.creates, 0); assert.equal(g.p.h.deletes, 0);
    assert.ok(g.p.calls.every(([binary]) => binary === "git"));
  }
});

test("approved group composition runs only its native group and collection cannot relabel it", async (t) => {
  const g = groupProduction(t, { active: true });
  assert.equal(await productionMain(await g.approval(), g.p.deps), 3);
  assert.equal(g.p.h.creates, 1); assert.equal(g.p.h.deletes, 0);
  assert.equal(g.p.h.saved().group, groupNames[0]);
  const known = join(g.p.h.local, "known_hosts"), launchKey = readFileSync(known);
  assert.equal(g.p.h.saved().launchHostKeySha256, digest(launchKey));
  const ssh = g.p.calls.filter(([binary]) => binary === "ssh").map(([, argv]) => argv);
  assert.ok(ssh[0].includes("StrictHostKeyChecking=accept-new") && ssh[0].includes("GlobalKnownHostsFile=none"));
  assert.ok(ssh.slice(1).every(argv => argv.includes("StrictHostKeyChecking=yes") && argv.some(arg => arg.includes(".launch-host-key-"))));
  assert.deepEqual(g.p.h.saved().selection.groups.map((row) => row.group), [groupNames[0]]);
  assert.ok(readFileSync(join(g.p.h.local, "job.sh"), "utf8").includes(`--group '${groupNames[0]}'`));
  const values = g.p.args();
  assert.equal(await productionMain([...values, "--print-approval"], g.p.deps), 3);
  assert.equal(g.p.stdout.at(-1).launchHostKeySha256, digest(launchKey));
  assert.equal(await productionMain([...values, "--approve-reviewed-merged-ready", g.p.stdout.at(-1).approvalSha256], g.p.deps), 3);
  assert.equal(g.p.h.creates, 1); assert.equal(g.p.h.deletes, 0);
  await assert.rejects(productionMain([...values, "--group", groupNames[1], "--fleet", g.path, "--print-approval"], g.p.deps));
});

test("replacing the launch host key after collection approval refuses before provider access", async (t) => {
  const flags = { active: true }, g = groupProduction(t, flags);
  assert.equal(await productionMain(await g.approval(), g.p.deps), 3);
  const approved = await g.p.approve(), before = g.p.calls.length, known = join(g.p.h.local, "known_hosts");
  flags.afterFetch = () => writeFileSync(known, "synthetic replacement\n");
  await assert.rejects(productionMain(approved, g.p.deps), /saved host key differs from launch/);
  await assert.rejects(productionMain([...g.p.args(), "--print-approval"], g.p.deps), /saved host key differs from launch/);
  assert.ok(g.p.calls.slice(before).every(([binary]) => binary === "git"));
  assert.equal(g.p.h.deletes, 0);
});

test("changing the fleet between preview and merged-source gate refuses allocation", async (t) => {
  const flags = {}, g = groupProduction(t, flags), args = await g.approval();
  flags.afterFetch = () => writeFileSync(g.path, `${JSON.stringify(g.fleet)}\n`);
  await assert.rejects(productionMain(args, g.p.deps));
  assert.equal(g.p.h.creates, 0); assert.ok(g.p.calls.every(([binary]) => binary === "git"));
});

test("fresh remote proof fetches only advertised objects without a shared reference or FETCH_HEAD write", async (t) => {
  const remoteHead = "b".repeat(40), p = productionHarness(t, { remoteHead, active: true });
  assert.equal(await productionMain(await p.approve("--detach"), p.deps), 3);
  const git = p.calls.filter(([binary]) => binary === "git").map(([, argv]) => argv);
  assert.deepEqual(git.filter((argv) => argv[0] === "ls-remote"),
    [["ls-remote", "--exit-code", "--refs", sourceUrl, "refs/heads/main"]]);
  assert.deepEqual(git.filter((argv) => argv[0] === "fetch"),
    [["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", sourceUrl, remoteHead]]);
  assert.ok(git.some((argv) => JSON.stringify(argv) === JSON.stringify(["merge-base", "--is-ancestor", commit, remoteHead])));
  assert.ok(!git.some((argv) => argv.some((arg) => arg.includes(":refs/") || arg === "FETCH_HEAD")));
});

test("missing, malformed or ambiguous remote main advertisements refuse before cloud access", async (t) => {
  for (const remoteLine of ["", `${commit}\trefs/heads/other\n`, `${commit}\trefs/heads/main\n${commit}\trefs/heads/main\n`,
    `${commit.slice(1)}\trefs/heads/main\n`, `${commit}\trefs/heads/main\nPRIVATE`]) {
    const p = productionHarness(t, { remoteLine });
    await assert.rejects(productionMain(await p.approve("--detach"), p.deps), /remote main advertisement/);
    assert.equal(p.h.creates, 0); assert.ok(p.calls.every(([binary]) => binary === "git"));
    assert.ok(!p.calls.some(([binary, argv]) => binary === "git" && argv[0] === "fetch"));
  }
});

test("locked launch rechecks the observed remote SHA rather than stale shared tracking refs", async (t) => {
  const remoteHead = "b".repeat(40), p = productionHarness(t, { remoteHead, staleTracking: true, active: true });
  assert.equal(await productionMain(await p.approve("--detach"), p.deps), 3);
  const ancestry = p.calls.filter(([binary, argv]) => binary === "git" && argv[0] === "merge-base");
  assert.equal(ancestry.length, 2);
  for (const [, argv] of ancestry) assert.deepEqual(argv, ["merge-base", "--is-ancestor", commit, remoteHead]);
  assert.equal(p.h.creates, 1); assert.equal(p.h.saved().status, "running");
});
