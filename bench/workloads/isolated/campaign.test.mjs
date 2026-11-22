// Test module substitution is confined to this process. Production has no injected
// runners/validators/probes. Real filesystem sealing and real IPC supervision remain.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import * as evidence from "./evidence.mjs";
import * as contracts from "./campaign-contract.mjs";
import { groupNames, nativeArtifactRoot } from "../registry.mjs";
import { fakeChild } from "./test-fixtures/process.mjs";
import * as audit from "./test-fixtures/campaign-audit.mjs";
import * as nativeReplay from "./native-replay.mjs";
import { composePhase } from "./composition.mjs";
import * as actualLifetime from "./host-lifetime.mjs";
import { samplingControl } from "./test-fixtures/host-lifetime-storage.mjs";
import { ioError } from "./test-fixtures/host-durable-writer-control.mjs";
import * as actualHost from "./host-observation.mjs";
import * as controlAdmission from "./control-admission.mjs";
import { guardianSource } from "../cloud-control-runtime.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = mkdtempSync(join(os.tmpdir(), "isolated-campaign-test-"));
let root, mode = "normal", expectedPlan, currentInvocation, calls = [], observations = 0, authorizations = [], release, pendingStarted, abort, auditComplete = true, lifetimeFailure, replayLifetimeFailure;
let lifetimeStartup;
let lifetimeRun;
let admittedHost, admittedApparatus, controlWindows, settleAbort, settleWorkerTicks, settleSurvives;
let liveOutput;
const sourceGit = (cwd, ...args) => childProcess.execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
const sourceStatus = (cwd) => sourceGit(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all");
mock.module("./control-admission.mjs", { exports: { ...controlAdmission,
  beginControlWindow(binding) {
    assert.equal(binding.round, "r21"); controlWindows.push("open");
    return () => { assert.ok(existsSync(join(controlWindows.directory, controlWindows.phase ?? "00-client-heavy-timing", "host-after.json"))); controlWindows.push("close"); };
  },
} });
const cpu = { app: { cpuset: "1", quota: 1 } };
mock.module("./evidence.mjs", { namedExports: { ...evidence,
  physical: (path, ...rest) => evidence.physical(path === "/bench/campaign" ? root : path, ...rest),
  inspectEvidence(binding, path) {
    evidence.tree(path); assert.ok(existsSync(join(path, "summary.json")));
    return { qualification: "blocked", rawCompleteness: "not-established" };
  },
} });
mock.module("./worker.mjs", { namedExports: {
  verifyWorkingSources(binding) {
    assert.ok(isDeepStrictEqual(binding, expectedPlan.bindings[0]), "working source binding differs");
    if (mode === "source-changed") throw new Error("working source differs");
    if (liveOutput) assert.equal(sourceStatus(liveOutput.checkout), "", "binding requires a clean committed checkout, including untracked files");
  },
  matchesWorkingSource: () => true,
} });
function jsonPhase(plan, phase, receiptPath) {
  assert.ok(plan.order.includes("json-api"), "unselected JSON preparation/freshness is forbidden");
  if (receiptPath?.startsWith("/bench/campaign/")) receiptPath = join(root, ...receiptPath.split("/").slice(3));
  const b = structuredClone(plan.bindings.find((b) => b.request.group === "json-api"));
  b.request.round = phase === "prepare" ? "j34" : "j35";
  b.execution.invocation.argv = ["bench/json-api/run.mjs", b.request.round, "--group", "json-api",
    ...(phase === "prepare" ? ["--build", "--check-only"] : ["--receipts", receiptPath])];
  b.validation.artifactRoot = relative(repo, join(temporary, `native-r${round}`, `json-${phase}`)).replaceAll("\\", "/");
  return b;
}
mock.module("./campaign-contract.mjs", { namedExports: { ...contracts,
  validateCampaign(plan) { assert.ok(isDeepStrictEqual(plan, expectedPlan), "campaign plan differs"); }, jsonPhase,
  mixedPhase(plan, id) {
    const b = structuredClone(plan.bindings.find((b) => b.request.group === "mixed-production"));
    b.execution.invocation.argv.push("--native-audits", join(root, id, "mixed-native-audits.json")); return b;
  },
} });
mock.module("./mixed-staging.mjs", { exports: {
  prepareMixedAudit(plan, repo, directory) {
    const sourcesManifest = audit.snapshotSources(plan.bindings[0], repo, directory);
    const body = { schema: "synthetic-mixed-subject", campaignSha256: plan.campaignSha256, commit: plan.commit, sourcesManifest };
    return { ...body, subjectSha256: evidence.digest(JSON.stringify(body)) };
  },
  replayMixedSubject(plan, subject, repo, directory) {
    const { subjectSha256, ...body } = subject; assert.equal(subjectSha256, evidence.digest(JSON.stringify(body)));
    assert.equal(subject.commit, plan.commit); assert.ok(isDeepStrictEqual(subject.sourcesManifest.snapshot, evidence.tree(directory)), "mixed source snapshot differs"); return subject;
  },
  validateMixedDelivery(delivery, subject) {
    assert.ok(isDeepStrictEqual(delivery, mixedDelivery(subject.subjectSha256)), "mixed audit delivery differs"); return delivery;
  },
  validateMixedRun() { return mode === "complete"; },
} });
const host = () => ({ hostname: admittedHost?.hostname ?? "test-host", bootId: admittedHost?.bootId ?? "boot", containers: [], networks: ["bridge"], processes: [],
  ...(admittedApparatus ? { controlApparatus: { registration: structuredClone(admittedApparatus), sample: { host: admittedApparatus.host,
    monoNs: "2000000", members: admittedApparatus.members, listener: admittedApparatus.listener } } } : {}) });
const udevPath = "0::/system.slice/systemd-udevd.service/udev\n";
const udevExecutable = { path: "/usr/lib/systemd/systemd-udevd", device: "2049", inode: "10" };
function rawProcess({ pid, startTicks, cgroup, parentPid }, comm = "ordinary") {
  const fields = Array(49).fill("0"); fields[0] = parentPid; fields[5] = "4194304"; fields[18] = startTicks;
  return { pid, startTicks, cgroup, stat: `${pid} (${comm}) S ${fields.join(" ")}\n` };
}
const udevClock = () => ({ bootId: admittedHost.bootId, uptime: "106.00 1280.00\n", ticksPerSecond: 100, monoNs: "4000000" });
function udevHost(observation) {
  const value = host();
  value.processes = [...admittedApparatus.members, admittedApparatus.listener].map((p) => rawProcess(p));
  value.processes.push({ ...rawProcess({ pid: 846, startTicks: "812", cgroup: udevPath, parentPid: 1 }, "systemd-udevd"), udevExecutable });
  if (observation === 3 || observation === 4 && settleSurvives)
    value.processes.push({ ...rawProcess({ pid: 62274, startTicks: settleWorkerTicks, cgroup: udevPath, parentPid: 846 }, "(udev-worker)"), udevExecutable });
  value.uptime = `${["100.00", "101.00", "106.15", "111.16"][observation - 1]} 1280.13\n`;
  value.controlApparatus.sample.monoNs = ["2000000", "2000000", "5000000", "5015000000"][observation - 1];
  return value;
}
mock.module("./host-observation.mjs", { namedExports: {
  ...actualHost, udevSettleMs: 0,
  observeHost(_apparatus, retainUdev = false) {
    observations++;
    if (mode === "udev-settle") {
      assert.equal(retainUdev, observations > 1);
      if (observations === 3 && settleAbort) queueMicrotask(() => settleAbort.abort(new Error("abort during udev settle")));
      return udevHost(observations);
    }
    const value = host(); if (mode === "leak" && observations > 2) value.containers = ["leak"]; return value;
  },
  verifyHostBoundary(before, after) {
    if (mode === "udev-settle") return actualHost.verifyHostBoundary(before, after);
    assert.deepEqual(after, before, "host cleanup uncertain"); return { cleanup: "observed-boundary-matched", isolation: "unverified" };
  },
} });
mock.module("./host-lifetime.mjs", { exports: {
  beginLifetime(args) {
    if (lifetimeRun) {
      const run = lifetimeRun;
      return actualLifetime.beginLifetime(args).then((observer) => {
        run.observer = observer;
        return run.beforeAttach ? Object.freeze({ ...observer, attach(pid) { run.beforeAttach(); return observer.attach(pid); } }) : observer;
      });
    }
    const { directory, command, startupSignal } = args;
    const startup = lifetimeStartup;
    mkdirSync(directory); writeFileSync(join(directory, "raw.json"), "{}");
    const observer = { attach() { if (startup) startup.attached++; }, dispose() { if (startup) startup.disposed++; }, finish(result, retainTerminalClock) {
      const checks = { accounting: true, terminal: result.terminal, empty: true, observer: true,
        unforced: !result.cancelled && !result.forced, leader: true };
      if (lifetimeFailure?.command === command) Object.assign(checks, lifetimeFailure.checks);
      if (retainTerminalClock) { assert.equal(mode, "udev-settle"); assert.equal(command, 1); assert.equal(observations, 2); }
      writeFileSync(join(directory, "terminal.json"), JSON.stringify({ ...checks, ...(retainTerminalClock ? { terminalClock: udevClock() } : {}) }));
      return evidence.tree(directory);
    } };
    if (!startup) return observer;
    assert.ok(startupSignal instanceof AbortSignal);
    startup.signal = startupSignal; startup.directory = directory; startup.enter();
    return startup.gate.then(() => { if (startup.failure) throw new Error("PRIVATE_SETUP_FAILURE"); return observer; });
  },
  inspectLifetime(binding, invocation, directory, expected) {
    if (lifetimeRun) return actualLifetime.inspectLifetime(binding, invocation, directory, expected);
    const { terminalClock, ...checks } = JSON.parse(readFileSync(join(directory, "terminal.json")));
    if (replayLifetimeFailure === expected.command) checks.accounting = false;
    const complete = Object.values(checks).every(Boolean);
    return { status: complete ? "verified" : "blocked", cleanupComplete: complete, checks,
      context: { bootId: host().bootId }, manifestSha256: evidence.tree(directory).sha256, terminalClock };
  },
  composeHostProof() { return { resources: mode === "complete" ? "verified" : "blocked", cleanupComplete: mode === "complete" }; },
} });
mock.module("./native-replay.mjs", { exports: { ...nativeReplay,
  async inspectNative(binding, native) {
    evidence.tree(native);
    if (mode === "complete") return completeNative(binding);
    return { status: "blocked", attemptComplete: false, cleanupComplete: false, resources: "blocked",
      outcomes: binding.selection.apps.map((app) => ({ app, outcome: "not-run" })), blockers: [] };
  },
} });
function completeNative(binding) {
  const failedLiveApp = liveOutput ? liveOutput.exit === 1 : binding.request.group === "live-delivery";
  return { status: failedLiveApp ? "failed" : "verified",
    attemptComplete: true, cleanupComplete: true, resources: "verified",
    ...(binding.request.group === "hardening" ? { comparisonEligibleApps: [] } : {}),
    outcomes: binding.selection.apps.map((app, i) => ({ app, outcome: failedLiveApp && i === 1 ? "failed" : "passed" })),
    blockers: [], ...(binding.request.group === "fullstack-browser" ? {
      qualificationPassed: true, expectedExitCode: 0, comparisonEligibleApps: [...binding.selection.apps],
    } : {}) };
}
mock.module("./json-staging.mjs", { namedExports: {
  ...audit,
  inspectPreparation: () => ({ summary: { actualBuilt: true }, report: { baseline: false } }),
  imageProof() { if (mode === "image-changed") throw new Error("built image changed"); return [{ imageId: "sha256:actual-mocked-image" }]; },
  validateTimingAudit(...args) {
    if (mode === "audit-mismatch") throw new Error("SYNTHETIC_PRIVATE_SENTINEL");
    if (mode === "complete") return { complete: auditComplete };
    return audit.validateTimingAudit(...args);
  },
} });
mock.method(os, "platform", () => "linux"); mock.method(os, "availableParallelism", () => 8);
mock.method(childProcess, "spawn", (binary, args, options) => {
  assert.equal(binary, process.execPath); assert.equal(options.shell, false);
  assert.equal(options.env.PATH, "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1"); assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
  const invocation = args.slice(1); calls.push(invocation); currentInvocation = invocation;
  assert.ok(!invocation[0].endsWith("report.mjs"), "never run a report against producer tree");
  const child = fakeChild((child) => {
    if (lifetimeRun) { lifetimeRun.started = true; lifetimeRun.start(); return; }
    const native = !invocation[0].endsWith("fixtures.mjs");
    const finish = () => {
      if (native) {
        const group = expectedPlan.bindings.find((b) => b.execution.invocation.argv[0] === invocation[0]).request.group;
        const binding = group === "json-api" ? jsonPhase(expectedPlan, invocation.includes("--check-only") ? "prepare" : "timing", invocation.at(-1))
          : expectedPlan.bindings.find((b) => b.request.group === group);
        const output = join(repo, binding.validation.artifactRoot); mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "raw.log"), "all fake native bytes\n");
        if (mode === "unsafe") linkSync(join(output, "raw.log"), join(output, "summary.json"));
        else writeFileSync(join(output, "summary.json"), "{}");
        if (liveOutput) {
          writeFileSync(join(output, "coverage.json"), JSON.stringify({ passed: liveOutput.exit === 0 }));
          if (liveOutput.dirt) {
            const path = join(liveOutput.checkout, liveOutput.dirt);
            mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "changed source\n");
          }
          liveOutput.generatedStatus = sourceStatus(liveOutput.checkout);
          liveOutput.generatedTree = evidence.tree(output);
        }
      }
      if (mode === "abort-native" && native) abort.abort();
      const group = expectedPlan.bindings.find((b) => b.execution.invocation.argv[0] === invocation[0])?.request.group;
      child.close(invocation.includes("--check-only") ? 1 : mode === "process-fails" && native ? 9
        : liveOutput && native ? liveOutput.exit : mode === "complete" && group === "client-heavy" ? 2 : mode === "complete" && group === "live-delivery" ? 1 : 0);
    };
    if (mode === "pending") { release = finish; pendingStarted(); } else finish();
  });
  if (lifetimeRun) {
    const run = lifetimeRun, send = child.send.bind(child);
    child.pid = 4242; run.child = child;
    child.send = (message, callback) => {
      if (message.type === "cancel") { run.cancels++; run.cancel?.(); callback?.(null); return; }
      return send(message, callback);
    };
  }
  if (lifetimeStartup) {
    lifetimeStartup.child = child;
    const send = child.send.bind(child);
    child.send = (message, callback) => {
      if (message.type === "cancel") { callback?.(null); queueMicrotask(() => child.close(0)); return; }
      return send(message, callback);
    };
  }
  return child;
});
const { createCampaign } = await import("./campaign.mjs");
const { validateCampaign: validateSavedCampaign } = await import("./campaign-verify.mjs");
let round = 100;
function setup(policy = () => true) {
  admittedHost = null; admittedApparatus = null; controlWindows = []; settleAbort = null;
  liveOutput = null;
  round++; mode = "normal"; calls = []; observations = 0; authorizations = []; auditComplete = true; lifetimeFailure = null; replayLifetimeFailure = null; lifetimeStartup = null; lifetimeRun = null;
  root = join(temporary, `state-${round}`); mkdirSync(root, { mode: 0o700 });
  expectedPlan = { round: `r${round}`, commit: "a".repeat(40), campaignSha256: `plan-${round}`, order: [...groupNames],
    bindings: groupNames.map((group) => ({ request: { group, round: `test${round}`, commit: "a".repeat(40) }, selection: { apps: ["corten", "selected-failure"] },
      latestStable: { schema: "benchmark-latest-stable-evaluation/v1", group, valid: true, status: "not-applicable", groupComparisonEligible: null },
      execution: { invocation: { executable: "node", argv: [`bench/${group === "catalog-page" ? "catalog" : group === "localized-marketplace" ? "marketplace" : group}/run.mjs`, `test${round}`] } },
      preparation: { fixtures: [{ executable: "node", argv: ["bench/catalog/fixtures.mjs"] }] }, resources: { requestedCpuEnv: {}, expectedCpus: cpu },
      validation: { artifactRoot: relative(repo, join(temporary, `native-r${round}`, group)).replaceAll("\\", "/") },
      coverage: { cells: [{ parity: "not-run", measurement: "not-run" }] }, status: { blockers: ["native gates unknown"] }, sources: { files: [audit.sourceFile] } })),
  };
  const campaign = createCampaign({ authorize(subject) { authorizations.push(subject); return policy(subject); } });
  return { campaign, plan: expectedPlan };
}
const begin = ({ campaign, plan }) => campaign.begin(plan, { stateRoot: "/bench/campaign" });
function setupGroup(group, policy) {
  const s = setup(policy);
  s.plan.schema = contracts.groupCampaignSchema; s.plan.order = [group];
  s.plan.bindings = s.plan.bindings.filter((b) => b.request.group === group);
  return s;
}
const delivery = (handle) => audit.auditDelivery(JSON.parse(readFileSync(join(handle.directory, "json-audit-subject.json"))).subjectSha256);
const mixedDelivery = (subjectSha256) => ({ schema: "benchmark-mixed-audit-delivery/v1", subjectSha256,
  review: { reviewer: "independent", reviewedAt: "2026-11-13T12:00:00Z", subjectSha256, findings: [], decision: "approved" },
  bundle: { schema: "mixed-native-source-audits/v1", receipts: [] } });
const submitPending = (campaign, handle, status) => status.auditGroup === "mixed-production"
  ? campaign.submitMixedAudit(handle, mixedDelivery(status.mixedAuditSubjectSha256)) : campaign.submitJsonAudit(handle, delivery(handle));

test("v4 live campaign retains actual bootstrap proof before baseline and brackets the original raw phase end", async (t) => {
  t.mock.method(fs, "fsyncSync", () => {}); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = childProcess.spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "bench/workloads/test-fixtures/control-session-kernel.py"],
    { cwd: resolve(repo), input: JSON.stringify({ source: guardianSource, mode: "normal" }), encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout), s = setupGroup("client-heavy"); s.plan.round = "r21"; admittedHost = proof.admission.host;
  const handle = await s.campaign.begin(s.plan, { stateRoot: "/bench/campaign", control: { binding: proof.binding, admission: proof.admission } });
  controlWindows.directory = handle.directory;
  const rows = evidence.tree(handle.directory).entries.filter((e) => /^\d{5}-/.test(e.path)).map((e) => JSON.parse(readFileSync(join(handle.directory, e.path))));
  assert.deepEqual(rows.map((e) => e.kind), ["authorized", "control-admitted", "started"]);
  assert.equal(s.campaign.status(handle).executionVersion, 4);
  assert.deepEqual(JSON.parse(readFileSync(join(handle.directory, "control-bootstrap.json"))), proof.admission);
  const status = await s.campaign.advance(handle); assert.equal(status.state, "finished");
  assert.deepEqual([...controlWindows], ["open", "close"]);
  const originalEnd = JSON.parse(readFileSync(join(handle.directory, "00-client-heavy-timing", "host-after.json")));
  assert.deepEqual(originalEnd, host());
  writeFileSync(join(handle.directory, "collection-manifest.json"), JSON.stringify(s.campaign.collect(handle)));
  const saved = await validateSavedCampaign({ folder: root, round: "r21", commit: s.plan.commit });
  assert.notEqual(saved.status, "invalid", JSON.stringify(saved));
  proof.admission.watchers[0].properties.MainPID = "999";
  const bytes = `${JSON.stringify(proof.admission)}\n`;
  writeFileSync(join(handle.directory, "control-bootstrap.json"), bytes);
  rows[1].sha256 = evidence.digest(bytes);
  writeFileSync(join(handle.directory, "00001-control-admitted.json"), JSON.stringify(rows[1]));
  const collectionPath = join(handle.directory, "collection-manifest.json"), collection = JSON.parse(readFileSync(collectionPath));
  const entries = evidence.tree(handle.directory).entries.filter((e) => e.path !== "collection-manifest.json");
  collection.manifest = { entries, sha256: evidence.digest(JSON.stringify(entries)) };
  writeFileSync(collectionPath, JSON.stringify(collection));
  assert.equal((await validateSavedCampaign({ folder: root, round: "r21", commit: s.plan.commit })).status, "invalid",
    "rehashed journal/collection cannot substitute for watcher termination");
});

test("v5 browser campaign carries the native roles through streamed bookends and saved drain replay", async (t) => {
  t.mock.method(fs, "fsyncSync", () => {}); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = childProcess.spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "bench/workloads/test-fixtures/control-session-kernel.py"],
    { cwd: resolve(repo), input: JSON.stringify({ source: guardianSource, mode: "normal" }), encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout), s = setupGroup("fullstack-browser"); s.plan.round = "r21"; admittedHost = proof.admission.host;
  const { registration: fixture } = await import("../test-fixtures/control-stream-fixture.mjs");
  const { streamHash } = await import("./control-stream.mjs");
  const { deploymentSha256 } = await import("../deployments.mjs");
  admittedApparatus = { ...structuredClone(fixture), binding: proof.binding, host: proof.admission.host };
  proof.admission.apparatus = admittedApparatus;
  proof.admission.apparatusSample = { host: admittedHost, monoNs: "2000000", members: admittedApparatus.members, listener: admittedApparatus.listener };
  s.plan.bindings[0].resources.browserCpus = { application: "1", upstream: "2-3", browser: "4-7" };
  const calls = [], stream = { registration: admittedApparatus, check() { calls.push("check"); },
    open(cpus, roles) {
      assert.deepEqual(cpus, { application: "1", upstream: "2-3", browser: "4-7" });
      assert.deepEqual(roles, ["application", "upstream", "browser"]); calls.push("open");
    },
    close() { calls.push("close"); }, async seal() {
      calls.push("seal"); return { schema: "benchmark-control-stream-seal/v1", registration: admittedApparatus,
        observations: [{ sequence: 1, monoNs: "2000000", registrationSha256: streamHash(admittedApparatus) }], sealedMonoNs: "3000000",
        lease: { id: admittedApparatus.id, host: admittedHost, expiresMonoNs: "15000000000" } };
    } };
  const handle = await s.campaign.begin(s.plan, { stateRoot: "/bench/campaign", control: { binding: proof.binding, admission: proof.admission, stream } });
  controlWindows.directory = handle.directory; controlWindows.phase = "00-fullstack-browser-timing";
  assert.equal(s.campaign.status(handle).executionVersion, 5);
  assert.equal((await s.campaign.advance(handle)).state, "finished"); assert.ok(calls.indexOf("open") < calls.indexOf("close") && calls.indexOf("close") < calls.indexOf("seal"));
  assert.deepEqual(JSON.parse(readFileSync(join(handle.directory, controlWindows.phase, "host-after.json"))), host());
  const drain = { schema: "benchmark-control-stream-drain/v1", id: admittedApparatus.id, registrationSha256: streamHash(admittedApparatus),
    host: admittedHost, monoNs: "4000000", identitiesAbsent: true, listener: admittedApparatus.listener,
    scopes: [{ path: "/user.slice/session-1.scope", exists: false, members: [], events: null }] };
  writeFileSync(join(handle.directory, "control-stream-drain.json"), JSON.stringify(drain));
  writeFileSync(join(handle.directory, "collection-manifest.json"), JSON.stringify(s.campaign.collect(handle)));
  const request = { folder: root, round: "r21", commit: s.plan.commit };
  const inspected = await validateSavedCampaign(request);
  assert.notEqual(inspected.status, "invalid");
  assert.deepEqual(inspected.supervisedTerminal, { registrationSha256: streamHash(admittedApparatus),
    sealSha256: evidence.digest(readFileSync(join(handle.directory, "control-stream-seal.json"))) });
  drain.identitiesAbsent = false; writeFileSync(join(handle.directory, "control-stream-drain.json"), JSON.stringify(drain));
  const collectionPath = join(handle.directory, "collection-manifest.json"), collection = JSON.parse(readFileSync(collectionPath));
  const entries = evidence.tree(handle.directory).entries.filter((e) => e.path !== "collection-manifest.json");
  collection.manifest = { entries, sha256: deploymentSha256(entries) }; writeFileSync(collectionPath, JSON.stringify(collection));
  assert.equal((await validateSavedCampaign(request)).status, "invalid", "rehashing cannot replace actual apparatus disappearance");
});

for (const [fault, shutdown = "drained"] of [
  ["observation"], ["write"], ["pending-storage"], ["continuity"], ["observation", "forced"], ["observation", "undrained"],
]) test(`actual campaign observer ${fault} fault stops once and awaits ${shutdown} owned shutdown`, { timeout: 15000 }, async (t) => {
  // Cancellation composition, not crash durability: avoid host flush latency in
  // the journal/log writes. Real flush ordering has separate durability controls.
  t.mock.method(fs, "fsyncSync", () => {}); syncBuiltinESMExports();
  const s = setupGroup("client-heavy");
  s.plan.round = "r21";
  const h = await begin(s), parent = new AbortController();
  let clock = Date.now(), tick;
  // Manual sampling must include the seed observer: otherwise its attachment
  // queues real interval samples while storage drains, before this control starts.
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "setInterval", (callback) => { tick = callback; return null; });
  const f = await samplingControl(t);
  const flushed = (step) => step === "sync" ? null : undefined;
  f.before = flushed; await f.finish(); f.removed = false;
  assert.equal(f.samples().length, 3, "seed observer must not accumulate interval samples");
  const run = lifetimeRun = { started: false, cancels: 0 };
  const nativeStarted = new Promise((resolve) => { run.start = resolve; });
  let kills = 0;
  if (shutdown !== "drained") {
    const timeout = globalThis.setTimeout;
    // Only shorten the supervisor's stop/kill deadlines in this fake-process
    // control; leave startup, run, storage and the notification bound unchanged.
    t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => timeout(callback, [120000, 5000].includes(ms) ? 40 : ms, ...args));
    t.mock.method(process, "kill", (pid, signal) => {
      assert.equal(shutdown, "forced"); assert.equal(pid, -4242); assert.equal(signal, "SIGKILL");
      kills++; f.members = []; run.child.close(null, "SIGKILL");
    });
  }
  let settled = false, pause, failing = false;
  const advancing = s.campaign.advance(h, { signal: parent.signal }).then(
    (value) => { settled = true; return { value }; },
    (error) => { settled = true; return { error }; });
  async function until(predicate) {
    const deadline = performance.now() + 1000;
    while (!predicate() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(predicate(), "bounded fixture condition not reached");
  }
  try {
    // Setup uses the test's enclosing deadline, not the fault notification bound.
    await Promise.race([nativeStarted, advancing.then((outcome) => { throw outcome.error ?? new Error("command did not start"); })]);
    assert.equal(run.cancels, 0, "healthy attachment must not cancel");
    if (fault === "write") {
      f.before = (step, path) => { if (step === "write" && path.endsWith("samples.jsonl")) { failing = true; throw ioError(); } return flushed(step); };
      tick(); await until(() => failing && f.live.size === 0);
    } else if (fault === "continuity") {
      clock += 1909;
    } else {
      if (fault === "pending-storage") {
        pause = f.pause("write", (path) => path.endsWith("samples.jsonl"));
        const before = f.before;
        f.before = async (...args) => { await before(...args); return flushed(args[0]); };
        tick(); await pause.entered;
        assert.equal(run.cancels, 0, "held write must not cancel before observation fault injection");
      }
      const read = fs.readFileSync;
      t.mock.method(fs, "readFileSync", (path, ...args) => {
        if (failing && String(path) === "/proc/4242/stat") throw ioError();
        return read(path, ...args);
      });
      syncBuiltinESMExports(); failing = true;
    }
    const started = performance.now(); tick();
    assert.equal(run.cancels, 1, "irrecoverable observer fault must synchronously request cancellation");
    const notificationMs = performance.now() - started;
    assert.ok(notificationMs < 1000, "stop must not wait for the native run deadline or pending disk I/O");
    t.diagnostic(`controlled ${fault} fault: stop request in ${notificationMs.toFixed(3)} ms`);
    tick();
    // A later command-side fault remains separate from the observer diagnostics.
    run.child.stderr.emit("error", new Error("synthetic command output failure"));
    assert.equal(run.cancels, 1); assert.equal(parent.signal.aborted, false);
    assert.equal(settled, false, "cancellation request is not terminal scope proof");
    assert.equal(calls.length, 1);
    assert.throws(() => s.campaign.stop(h), /wait for owned command shutdown/);
    if (pause) {
      assert.ok(f.live.size > 0, "pending write remains owned during cooperative stop");
      assert.equal(existsSync(join(h.directory, "00-client-heavy-timing/command-0-host/terminal.json")), false);
    }
    failing = false; f.before = flushed;
    if (shutdown === "drained") { f.members = []; run.child.close(0); }
    if (shutdown === "undrained") run.child.emit("exit", 0, null);
    if (pause) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(settled, false, "owned terminal storage must join the pending write");
      assert.ok(f.live.size > 0); pause.release();
    }
    const outcome = await advancing;
    assert.ok(outcome.error, "observer failure must not qualify a drained command");
    const state = s.campaign.status(h);
    assert.equal(state.state, "preserved-uncertain"); assert.equal(state.uncollectedNativeRoots.length, 1);
    assert.equal(state.outcomes[0].outcome, "preserved-uncertain");
    assert.equal(existsSync(join(root, ".host-attempt.json")), true);
    const directory = join(h.directory, "00-client-heavy-timing/command-0-host");
    if (fault === "write") {
      assert.match(outcome.error.message, /storage incomplete/);
      assert.equal(outcome.error.code, "EIO");
      assert.equal(existsSync(join(directory, "terminal.json")), false); assert.equal(f.removed, false);
    } else {
      const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
      if (fault === "continuity") {
        assert.equal(terminal.observerError, null); assert.equal(terminal.observerFailures.count, 0);
      } else {
        assert.equal(terminal.observerError, "host-observation-gap");
        assert.equal(terminal.observerFailures.first.code, "EIO"); assert.equal(terminal.observerFailures.last.code, "EIO");
        assert.equal(terminal.observerFailures.first.operation, "process-stat");
        assert.ok(terminal.observerFailures.count >= 2);
      }
      assert.equal(terminal.command.cancelled, true); assert.equal(terminal.command.success, false);
      assert.equal(terminal.command.error, "synthetic command output failure");
      assert.equal(terminal.command.forced, shutdown === "forced");
      assert.equal(terminal.command.terminal, shutdown !== "undrained");
      assert.equal(terminal.empty, shutdown !== "undrained", "faults/leader exit never substitute for an empty final census");
      assert.equal(f.removed, shutdown !== "undrained");
      assert.equal(kills, shutdown === "forced" ? 1 : 0);
      assert.ok(!JSON.stringify(terminal).includes("PRIVATE_STORAGE_DETAIL"));
    }
    await until(() => f.live.size === 0);
    await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, 1); assert.equal(run.cancels, 1);
    assert.throws(() => s.campaign.collect(h), /not finished/);
  } finally {
    failing = false; f.before = () => {}; pause?.release(); f.members = [];
    if (!settled) run.child?.close(0);
    await advancing; lifetimeRun = null;
  }
});

test("actual campaign attachment gap cancels before native start or interval creation", { timeout: 15000 }, async (t) => {
  t.mock.method(fs, "fsyncSync", () => {}); syncBuiltinESMExports();
  const s = setupGroup("client-heavy"); s.plan.round = "r21";
  const h = await begin(s), parent = new AbortController();
  let clock = 10000, intervals = 0, settled = false;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "setInterval", () => null);
  const f = await samplingControl(t); f.before = (step) => step === "sync" ? null : undefined;
  await f.finish(); f.removed = false;
  assert.equal(f.samples().length, 3, "seed observer must not accumulate interval samples");
  t.mock.method(globalThis, "setInterval", () => { intervals++; return null; });
  const run = lifetimeRun = { started: false, cancels: 0, beforeAttach() { clock += 1909; } };
  const started = new Promise((resolve) => { run.start = resolve; });
  const cancelled = new Promise((resolve) => { run.cancel = resolve; });
  const advancing = s.campaign.advance(h, { signal: parent.signal }).then(
    (value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; });
  try {
    await Promise.race([cancelled, started.then(() => { throw new Error("invalid attachment released native startup"); }),
      advancing.then(() => { throw new Error("startup completed without owned cancellation"); })]);
    assert.equal(run.started, false); assert.equal(run.cancels, 1); assert.equal(intervals, 0);
    assert.equal(parent.signal.aborted, false); assert.equal(settled, false);
    assert.throws(() => s.campaign.stop(h), /wait for owned command shutdown/);
    f.members = []; run.child.close(0);
    assert.ok((await advancing).error); await run.observer.pendingStorage;
    const state = s.campaign.status(h);
    assert.equal(state.state, "preserved-uncertain"); assert.equal(state.uncollectedNativeRoots.length, 1);
    const directory = join(h.directory, "00-client-heavy-timing/command-0-host");
    assert.equal(existsSync(join(directory, "terminal.json")), false); assert.equal(f.removed, false);
    assert.equal(f.live.size, 0); assert.equal(existsSync(join(root, ".host-attempt.json")), true);
    await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, 1);
  } finally {
    f.members = [];
    if (!settled) run.child?.close(0);
    await advancing; await run.observer?.pendingStorage; lifetimeRun = null;
  }
});

for (const stop of ["cancel", "close"]) for (const failure of [false, true]) test(`campaign startup ${stop} disposes late ${failure ? "failed" : "returned"} setup and retains pending native root`, async () => {
  const s = setupGroup("client-heavy"), h = await begin(s), controller = new AbortController();
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const owner = lifetimeStartup = { enter, gate, failure, attached: 0, disposed: 0 };
  let returned = false;
  const advancing = s.campaign.advance(h, { signal: controller.signal });
  const rejected = assert.rejects(advancing, /lifetime or cleanup unproven/).then(() => { returned = true; });
  try {
    await entered;
    if (stop === "cancel") controller.abort(); else owner.child.close(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(returned, false); assert.equal(owner.signal.aborted, true);
    release(); await rejected;
    assert.equal(owner.attached, 0); assert.equal(owner.disposed, failure ? 0 : 1);
    assert.equal(existsSync(join(owner.directory, "terminal.json")), false);
    const status = s.campaign.status(h);
    assert.equal(status.state, "preserved-uncertain"); assert.equal(status.uncollectedNativeRoots.length, 1);
    assert.equal(calls.length, 1);
    await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, 1);
  } finally { release(); await rejected; }
});

for (const group of groupNames) test(`${group}: one complete group runs and replays without inventing other groups`, async () => {
  const s = setupGroup(group), h = await begin(s); mode = "complete";
  assert.deepEqual(authorizations[0].groups, [group]);
  let current = await s.campaign.advance(h);
  if (["json-api", "mixed-production"].includes(group)) {
    assert.equal(current.state, "blocked-review-needed"); assert.equal(current.auditGroup, group);
    assert.equal(calls.length, group === "json-api" ? 2 : 0, "no timing before independent audit");
    assert.equal(existsSync(join(h.directory, "json-native-audits.json")), false);
    assert.equal(existsSync(join(h.directory, "mixed-native-audits.json")), false);
    current = await submitPending(s.campaign, h, current); current = await s.campaign.advance(h);
  }
  assert.equal(current.state, "finished"); assert.deepEqual(current.outcomes.map((r) => r.group), [group]);
  assert.equal(calls.length, group === "json-api" ? 4 : 2);
  assert.ok(calls.every((argv) => argv[0].endsWith("fixtures.mjs") || argv[0] === s.plan.bindings[0].execution.invocation.argv[0]));
  assert.equal(current.outcomes[0].outcome, "native-validated");
  writeFileSync(join(h.directory, "collection-manifest.json"), JSON.stringify(s.campaign.collect(h)));
  const request = { folder: root, round: s.plan.round, commit: s.plan.commit };
  const before = evidence.tree(root), saved = await validateSavedCampaign(request);
  assert.ok(isDeepStrictEqual(evidence.tree(root), before), "inspection is read-only");
  assert.equal(saved.status, "verified", JSON.stringify(saved));
  assert.equal(saved.schema, "benchmark-isolated-group-campaign-inspection/v1");
  assert.deepEqual(saved.selection.groups, [{ group, apps: s.plan.bindings[0].selection.apps, contractSha256: undefined }]);
  assert.deepEqual(saved.groups.map((r) => r.group), [group]); assert.equal(Object.hasOwn(saved, "group"), false);
  if (group === "hardening") assert.deepEqual(saved.groups[0].appOutcomes, s.plan.bindings[0].selection.apps
    .map(app => ({ app, outcome: "passed", comparisonEligible: false })));
  assert.equal(Object.hasOwn(saved, "qualified"), false); assert.equal(Object.hasOwn(saved, "deletionAuthorized"), false);
  assert.equal(saved.collectionIntegrity, "manifest-verified"); assert.equal(saved.commandLifecycle, "observed-terminal");
  assert.deepEqual(saved.uncollectedNativeRoots, []);
  replayLifetimeFailure = 0;
  assert.equal((await validateSavedCampaign(request)).status, "invalid", "group scope cannot waive fixture lifetime proof");
  replayLifetimeFailure = null;
  appendFileSync(join(h.directory, `00-${group}-timing`, "native", "raw.log"), "changed native bytes");
  assert.equal((await validateSavedCampaign(request)).status, "invalid", "group scope cannot waive native seals");
});
for (const group of ["json-api", "mixed-production"]) test(`${group}: single group audit wait still needs separate transport authorization`, async () => {
  const s = setupGroup(group, (subject) => subject.action === "begin-campaign"), h = await begin(s);
  const current = await s.campaign.advance(h), count = calls.length;
  assert.equal(current.state, "blocked-review-needed");
  await assert.rejects(submitPending(s.campaign, h, current), /did not authorize/);
  assert.equal(s.campaign.status(h).state, "preserved-uncertain"); assert.equal(calls.length, count);
  await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, count);
  const saved = await validateSavedCampaign({ folder: root, round: s.plan.round, commit: s.plan.commit });
  assert.equal(saved.status, "blocked", JSON.stringify(saved)); assert.equal(saved.schema, "benchmark-isolated-group-campaign-inspection/v1");
  assert.deepEqual(saved.selection.groups.map((r) => r.group), [group]); assert.equal(saved.qualified, false);
});
for (const boundary of ["unsafe", "leak", "source-changed", "abort-native"]) test(`single-group ${boundary} keeps the original failure boundary`, async () => {
  const s = setupGroup("client-heavy"), h = await begin(s); mode = boundary;
  if (boundary === "abort-native") { abort = new AbortController(); await s.campaign.advance(h, { signal: abort.signal }); }
  else await assert.rejects(s.campaign.advance(h));
  const status = s.campaign.status(h), count = calls.length;
  assert.equal(status.state, "preserved-uncertain"); assert.deepEqual(status.outcomes.map((r) => r.group), ["client-heavy"]);
  assert.notEqual(status.outcomes[0].outcome, "native-validated");
  if (boundary === "unsafe") assert.equal(status.uncollectedNativeRoots.length, 1);
  await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, count);
});

function setupLiveOutput(group, exit, dirt) {
  const s = setupGroup(group), binding = s.plan.bindings[0];
  mode = "complete";
  const checkout = join(temporary, `live-git-${round}`);
  mkdirSync(checkout);
  sourceGit(checkout, "init", "--quiet");
  sourceGit(checkout, "config", "core.autocrlf", "false");
  writeFileSync(join(checkout, "tracked.mjs"), "export {};\n");
  sourceGit(checkout, "add", "tracked.mjs");
  sourceGit(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "fixture source");
  const artifactRoot = nativeArtifactRoot(group, binding.request.round), original = join(checkout, artifactRoot);
  binding.validation.artifactRoot = relative(repo, original).replaceAll("\\", "/");
  liveOutput = { checkout, exit, dirt };
  return { ...s, original, artifactRoot, checkout };
}

for (const group of ["live-delivery", "recoverable-live"]) for (const exit of [0, 1]) test(`${group}: Git-visible live output seals before source recheck (exit ${exit})`, async () => {
  const s = setupLiveOutput(group, exit), h = await begin(s);
  const status = await s.campaign.advance(h);
  assert.ok(liveOutput.generatedStatus.includes(`?? ${s.artifactRoot}/coverage.json\0`), "real Git saw ordinary results before intake");
  assert.equal(sourceStatus(s.checkout), "");
  assert.equal(existsSync(s.original), false);
  assert.deepEqual(evidence.tree(join(h.directory, `00-${group}-timing`, "native")), liveOutput.generatedTree);
  assert.equal(status.state, "finished"); assert.deepEqual(status.uncollectedNativeRoots, []);
  assert.equal(status.outcomes[0].outcome, "native-validated");
  assert.equal(status.outcomes[0].appOutcomes[1].outcome, exit === 0 ? "passed" : "failed");
  writeFileSync(join(h.directory, "collection-manifest.json"), JSON.stringify(s.campaign.collect(h)));
  const saved = await validateSavedCampaign({ folder: root, round: s.plan.round, commit: s.plan.commit });
  assert.equal(saved.status, "verified", JSON.stringify(saved));
  assert.deepEqual(saved.groups[0].appOutcomes, status.outcomes[0].appOutcomes);
  mkdirSync(s.original);
  assert.throws(() => s.campaign.verify(h), /native output appeared/);
});

for (const dirt of ["tracked.mjs", "untracked.mjs", "bench/live/results/parity/unrelated/keep.json"]) test(`live output intake does not hide unrelated ${dirt}`, async () => {
  const s = setupLiveOutput("live-delivery", 0, dirt), h = await begin(s);
  await assert.rejects(s.campaign.advance(h), /binding requires a clean committed checkout/);
  assert.equal(sourceStatus(s.checkout), `${dirt === "tracked.mjs" ? " M" : "??"} ${dirt}\0`);
  assert.equal(existsSync(s.original), false);
  assert.deepEqual(evidence.tree(join(h.directory, "00-live-delivery-timing", "native")), liveOutput.generatedTree);
  const status = s.campaign.status(h);
  assert.equal(status.state, "preserved-uncertain");
  assert.equal(status.outcomes[0].outcome, "preserved-uncertain");
  assert.deepEqual(status.uncollectedNativeRoots, []);
});

test("live output is not transferred without proven command cleanup", async () => {
  const s = setupLiveOutput("recoverable-live", 0), h = await begin(s);
  lifetimeFailure = { command: 1, checks: { empty: false } };
  await assert.rejects(s.campaign.advance(h), /command lifetime or cleanup unproven/);
  assert.deepEqual(evidence.tree(s.original), liveOutput.generatedTree);
  assert.equal(existsSync(join(h.directory, "00-recoverable-live-timing", "native")), false);
  assert.equal(s.campaign.status(h).uncollectedNativeRoots.length, 1);
});

for (const failure of ["moved bytes", "phase seal"]) test(`live transfer keeps both pending paths after I/O failure reading or sealing ${failure}`, async (t) => {
  const group = "recoverable-live", s = setupLiveOutput(group, 0), h = await begin(s);
  const transferDestination = `00-${group}-timing/native`, native = join(h.directory, transferDestination);
  const expected = [{ group, phase: "timing", artifactRoot: s.plan.bindings[0].validation.artifactRoot, transferDestination }];
  const open = fs.openSync;
  let faulted = false;
  const injected = t.mock.method(fs, "openSync", (path, ...args) => {
    const target = failure === "moved bytes" ? path === join(native, "coverage.json") : String(path).endsWith("-phase-sealed.json");
    if (!faulted && target) {
      faulted = true;
      assert.equal(existsSync(s.original), false);
      assert.equal(existsSync(join(native, "coverage.json")), true);
      throw Object.assign(new Error("injected transfer EIO"), { code: "EIO" });
    }
    return open(path, ...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(s.campaign.advance(h), { code: "EIO", message: "injected transfer EIO" }); }
  finally { injected.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(faulted, true);
  assert.deepEqual(evidence.tree(native), liveOutput.generatedTree);
  const journal = (kind) => join(h.directory, fs.readdirSync(h.directory).find((name) => name.endsWith(`-${kind}.json`)));
  const reservation = JSON.parse(readFileSync(journal("native-output-reserved")));
  assert.deepEqual(reservation.status.uncollectedNativeRoots, expected);
  assert.equal(reservation.transferDestination, transferDestination);
  assert.ok(!fs.readdirSync(h.directory).some((name) => name.endsWith("-phase-sealed.json")));
  const resultPath = join(h.directory, "campaign-result.json"), result = JSON.parse(readFileSync(resultPath));
  assert.equal(result.status.state, "preserved-uncertain");
  assert.deepEqual(result.status.uncollectedNativeRoots, expected);
  assert.deepEqual(s.campaign.status(h).uncollectedNativeRoots, expected);
  const request = { folder: root, round: s.plan.round, commit: s.plan.commit };
  const saved = await validateSavedCampaign(request);
  assert.equal(saved.status, "blocked");
  assert.equal(saved.collectionIntegrity, "unsealed-partial");
  assert.equal(saved.deletionAuthorized, false);
  assert.deepEqual(saved.uncollectedNativeRoots, expected);

  // Editing both terminal copies cannot hide the move or direct recovery elsewhere.
  const haltedPath = journal("halted"), halted = JSON.parse(readFileSync(haltedPath));
  for (const pending of [[], [{ ...expected[0], transferDestination: "wrong/native" }]]) {
    halted.status.uncollectedNativeRoots = pending; result.status.uncollectedNativeRoots = pending;
    writeFileSync(haltedPath, JSON.stringify(halted)); writeFileSync(resultPath, JSON.stringify(result));
    assert.equal((await validateSavedCampaign(request)).status, "invalid");
  }
});

test("one root, opaque handle, all nine fixed native commands and retained failed outcome", async () => {
  const s = setup(), handle = await begin(s), { campaign } = s;
  assert.throws(() => campaign.status({ ...handle }), /not owned/);
  assert.throws(() => createCampaign({ authorize: () => true }).status(handle), /not owned/);
  await assert.rejects(begin(s), /EEXIST/);
  mode = "process-fails"; let status = await campaign.advance(handle);
  assert.equal(status.outcomes[0].outcome, "failed"); mode = "normal";
  status = await campaign.advance(handle); assert.equal(status.state, "blocked-review-needed");
  assert.ok(currentInvocation.includes("--build") && currentInvocation.includes("--check-only"));
  assert.throws(() => campaign.collect(handle), /not finished/);
  status = await campaign.submitJsonAudit(handle, delivery(handle)); assert.equal(status.state, "active");
  status = await campaign.advance(handle);
  assert.ok(!currentInvocation.includes("--build") && currentInvocation.includes("--receipts"), "timing must not rebuild");
  assert.equal(status.outcomes[1].outcome, "blocked", "blocked proof must not promote a zero process");
  while (["active", "blocked-review-needed"].includes(status.state)) status = status.state === "active"
    ? await campaign.advance(handle) : await submitPending(campaign, handle, status);
  assert.equal(status.state, "finished"); assert.deepEqual(status.outcomes.map((r) => r.group), groupNames);
  assert.equal(status.outcomes.filter((r) => r.outcome === "not-run").length, 0);
  assert.equal(calls.length, 20, "every group executes, plus the separate JSON preparation phase");
  const seals = evidence.tree(handle.directory).entries.filter((e) => /^\d{5}-phase-sealed\.json$/.test(e.path))
    .map((e) => JSON.parse(readFileSync(join(handle.directory, e.path))));
  assert.deepEqual(seals.map((e) => `${e.group}/${e.phase}`), groupNames.flatMap((g) => g === "json-api" ? ["json-api/prepare", "json-api/timing"] : [`${g}/timing`]));
  for (const seal of seals) {
    const index = groupNames.indexOf(seal.group), path = `${String(index).padStart(2, "0")}-${seal.group}-${seal.phase}`;
    assert.equal(seal.nativeManifestSha256, JSON.parse(readFileSync(join(handle.directory, path, "native-manifest.json"))).sha256);
  }
  assert.equal(status.controllerReady, false); assert.equal(campaign.collect(handle).deletionAuthorized, false);
  assert.equal(JSON.parse(readFileSync(join(handle.directory, "campaign-result.json"))).status.outcomes[0].outcome, "failed");
  // The API collection is sealed by the fixed entry, not by collect() itself.
  writeFileSync(join(handle.directory, "collection-manifest.json"), JSON.stringify(campaign.collect(handle)));
  const sealed = (await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit }));
  assert.equal(sealed.status, "failed", JSON.stringify(sealed)); assert.equal(sealed.collectionIntegrity, "manifest-verified");
  assert.equal(sealed.qualified, false); assert.equal(sealed.deletionAuthorized, false);
  assert.equal((await validateSavedCampaign({ folder: root, round: "r17/escape", commit: expectedPlan.commit })).status, "invalid");
  const count = calls.length; await assert.rejects(campaign.advance(handle), /not eligible/); assert.equal(calls.length, count);
  assert.ok(existsSync(join(root, ".host-attempt.json")), "reservation retained after finish");
  appendFileSync(join(handle.directory, "00-catalog-page-timing", "native", "raw.log"), "tamper");
  assert.equal((await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit })).status, "invalid");
});
test("overlapping advance and semantic retry are refused", async () => {
  const s = setup(), h = await begin(s); mode = "pending";
  const started = new Promise((resolve) => { pendingStarted = resolve; });
  const pending = s.campaign.advance(h);
  await assert.rejects(s.campaign.advance(h), /already in progress/);
  await started; mode = "normal"; release(); await pending;
  assert.equal(calls.length, 2);
});

for (const [name, command, checks] of [
  ["fixture descendants remain", 0, { terminal: false, empty: false }],
  ["native descendants remain", 1, { terminal: false, empty: false }],
  ["fixture resource observation incomplete", 0, { accounting: false }],
]) test(`${name}: no later command or qualification can follow an unproven lifetime`, async () => {
  const s = setup(), h = await begin(s); mode = "complete"; lifetimeFailure = { command, checks };
  await assert.rejects(s.campaign.advance(h), /lifetime|cleanup/);
  assert.equal(calls.length, command + 1);
  const status = s.campaign.status(h); assert.equal(status.state, "preserved-uncertain");
  assert.equal(status.outcomes[0].outcome, "preserved-uncertain");
  assert.ok(status.outcomes.every((o) => o.outcome !== "native-validated"));
  assert.equal(status.uncollectedNativeRoots.length, 1);
  assert.equal(existsSync(join(h.directory, "00-catalog-page-timing", "native-manifest.json")), false);
  assert.equal(existsSync(join(repo, expectedPlan.bindings[0].validation.artifactRoot, "raw.log")), command === 1,
    "native originals remain retained when native execution occurred");
  const exits = evidence.tree(h.directory).entries.filter((e) => /^\d{5}-command-exited\.json$/.test(e.path))
    .map((e) => JSON.parse(readFileSync(join(h.directory, e.path))));
  assert.equal(exits.at(-1).success, true, "retain the actual leader exit, not a fabricated failure/terminal claim");
  const saved = await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit });
  assert.equal(saved.status, "blocked", JSON.stringify(saved)); assert.equal(saved.collectionIntegrity, "unsealed-partial");
  await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, command + 1);
});

test("mixed source review waits before any native spawn; only separate operator authorization stages the fixed bundle", async () => {
  const s = setup((subject) => subject.action !== "stage-mixed-audit"), h = await begin(s);
  let current = s.campaign.status(h);
  while (current.nextGroup !== "mixed-production") current = current.state === "active"
    ? await s.campaign.advance(h) : await submitPending(s.campaign, h, current);
  const count = calls.length; current = await s.campaign.advance(h);
  assert.equal(current.state, "blocked-review-needed"); assert.equal(current.auditGroup, "mixed-production"); assert.equal(calls.length, count);
  const d = mixedDelivery(current.mixedAuditSubjectSha256);
  await assert.rejects(s.campaign.submitMixedAudit(h, d), /did not authorize/);
  assert.equal(calls.length, count); assert.equal(s.campaign.status(h).state, "preserved-uncertain");
  assert.ok(existsSync(join(h.directory, "mixed-audit-delivery-retained.json")));
  const saved = await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit });
  assert.ok(["blocked", "failed"].includes(saved.status), JSON.stringify(saved));
});

for (const progress of ["intent", "started", "exited"]) test(`saved pending command ${progress} cannot advance past blocked fixture cleanup`, async () => {
  const s = setup(), h = await begin(s); mode = "complete";
  lifetimeFailure = { command: 0, checks: { terminal: false, empty: false } };
  await assert.rejects(s.campaign.advance(h), /lifetime|cleanup/);
  const input = { folder: root, round: expectedPlan.round, commit: expectedPlan.commit };
  assert.equal((await validateSavedCampaign(input)).status, "blocked", "a halted fixture alone remains an honest partial");
  const files = evidence.tree(h.directory).entries.filter((e) => /^\d{5}-[a-z-]+\.json$/.test(e.path));
  const rows = files.map((e) => JSON.parse(readFileSync(join(h.directory, e.path))));
  const fixtureExit = rows.find((e) => e.kind === "command-exited");
  const metadata = Object.fromEntries(["schema", "campaign", "round", "campaignSha256", "at", "status"]
    .map((key) => [key, structuredClone(fixtureExit[key])]));
  const additional = [{ ...metadata, kind: "command-intent", group: "catalog-page", invocation: expectedPlan.bindings[0].execution.invocation }];
  if (progress !== "intent") additional.push({ ...metadata, kind: "command-started", pid: 1234 });
  if (progress === "exited") additional.push({ ...metadata, kind: "command-exited", terminal: true, code: 0,
    signal: null, success: true, cancelled: false, forced: false, error: null });
  rows.splice(-1, 0, ...additional);
  for (const file of files) rmSync(join(h.directory, file.path));
  const saveRows = () => rows.forEach((row, sequence) => {
    row.sequence = sequence;
    writeFileSync(join(h.directory, `${String(sequence).padStart(5, "0")}-${row.kind}.json`), JSON.stringify(row));
  });
  saveRows(); writeFileSync(join(h.directory, "00-catalog-page-timing", "command-1.log"), "pending native command\n");
  const invalid = await validateSavedCampaign(input);
  assert.equal(invalid.status, "invalid", JSON.stringify(invalid));
  assert.equal(invalid.error, "saved-campaign-invalid");
  if (progress !== "exited") {
    const host = join(h.directory, "00-catalog-page-timing", "command-0-host");
    const terminalPath = join(host, "terminal.json"), checks = JSON.parse(readFileSync(terminalPath));
    checks.terminal = true; checks.empty = true; writeFileSync(terminalPath, JSON.stringify(checks));
    fixtureExit.hostManifestSha256 = evidence.tree(host).sha256; saveRows();
    const validPartial = await validateSavedCampaign(input);
    assert.equal(validPartial.status, "blocked", JSON.stringify(validPartial));
    assert.equal(validPartial.commandLifecycle, "incomplete-preserved");
    assert.equal(validPartial.collectionIntegrity, "unsealed-partial");
    assert.equal(validPartial.qualified, false); assert.equal(validPartial.deletionAuthorized, false);
  }
});

test("synthetic complete browser evidence follows exact qualification and native-exit gates", () => {
  const binding = { request: { group: "fullstack-browser" }, selection: { apps: ["corten", "selected-failure"] },
    preparation: { fixtures: [] }, latestStable: { schema: "benchmark-latest-stable-evaluation/v1", group: "fullstack-browser",
      valid: true, status: "not-applicable", groupComparisonEligible: null } };
  const native = completeNative(binding), host = { resources: "verified", cleanupComplete: true };
  const command = (code) => ({ terminal: true, code, signal: null, cancelled: false, forced: false, error: null, success: code === 0 });
  nativeReplay.validateNativeResult(binding, native);
  assert.equal(composePhase(binding, native, host, [command(0)]).outcome, "native-validated");
  for (const key of ["qualificationPassed", "expectedExitCode"]) {
    const missing = { ...native }; delete missing[key];
    assert.throws(() => nativeReplay.validateNativeResult(binding, missing), key);
    assert.notEqual(composePhase(binding, missing, host, [command(0)]).outcome, "native-validated", key);
  }
  for (const code of [1, 2, 137, null])
    assert.notEqual(composePhase(binding, native, host, [command(code)]).outcome, "native-validated");
  const unsupported = { ...native, qualificationPassed: false, expectedExitCode: 1, comparisonEligibleApps: [],
    outcomes: native.outcomes.map((r) => ({ ...r, outcome: "unsupported" })) };
  nativeReplay.validateNativeResult(binding, unsupported);
  const failedQualification = composePhase(binding, unsupported, host, [command(1)]);
  assert.equal(failedQualification.outcome, "native-validated");
  assert.ok(failedQualification.appOutcomes.every((r) => r.outcome === "unsupported" && !r.comparisonEligible));
  assert.notEqual(composePhase(binding, unsupported, host, [command(0)]).outcome, "native-validated");
});

test("all-nine intrinsic completion is reachable without claiming every framework passed or external authority", async () => {
  const s = setup(), h = await begin(s); mode = "complete";
  let current = s.campaign.status(h);
  while (current.state === "active" || current.state === "blocked-review-needed") {
    current = current.state === "active" ? await s.campaign.advance(h) : await submitPending(s.campaign, h, current);
  }
  assert.equal(calls.length, 20); assert.ok(current.outcomes.every((r) => r.outcome === "native-validated"));
  writeFileSync(join(h.directory, "collection-manifest.json"), JSON.stringify(s.campaign.collect(h)));
  const saved = await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit });
  assert.equal(saved.status, "verified", JSON.stringify(saved)); assert.equal(saved.scope, "intrinsic-evidence");
  assert.equal(saved.groups.length, 9); assert.equal(Object.hasOwn(saved, "qualified"), false);
  replayLifetimeFailure = 0;
  assert.equal((await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit })).status, "invalid",
    "a valid last command proof cannot excuse an unproven earlier fixture");
  replayLifetimeFailure = null;
  assert.equal((await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit })).status, "verified");
  const live = saved.groups.find((g) => g.group === "live-delivery");
  assert.deepEqual(live.appOutcomes[1], { app: "selected-failure", outcome: "failed", comparisonEligible: false });
  const browser = saved.groups.find((g) => g.group === "fullstack-browser");
  assert.deepEqual(browser.appOutcomes, expectedPlan.bindings.find((b) => b.request.group === "fullstack-browser").selection.apps
    .map((app) => ({ app, outcome: "passed", comparisonEligible: true })));
  for (const target of ["00-catalog-page-timing/host-before.json", "00-catalog-page-timing/command-0-host/raw.json",
    "mixed-audit-subject.json", "mixed-audit-delivery-retained.json", "mixed-native-audits.json",
    `mixed-audit-sources/blobs/${audit.sourceFile.sha256}`]) {
    const path = join(h.directory, target), original = readFileSync(path); writeFileSync(path, '{"changed":true}');
    const entries = evidence.tree(h.directory).entries.filter((e) => e.path !== "collection-manifest.json");
    const collection = JSON.parse(readFileSync(join(h.directory, "collection-manifest.json")));
    collection.manifest = { entries, sha256: (await import("../deployments.mjs")).deploymentSha256(entries) };
    writeFileSync(join(h.directory, "collection-manifest.json"), JSON.stringify(collection));
    const inspection = await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit });
    assert.equal(inspection.status, "invalid", target);
    assert.ok(!JSON.stringify(inspection).includes('"changed"'));
    writeFileSync(path, original);
  }
});
test("a drained cancellation latches the public API even without the original signal", async () => {
  const s = setup(), h = await begin(s); abort = new AbortController(); mode = "abort-native";
  const status = await s.campaign.advance(h, { signal: abort.signal });
  assert.equal(status.state, "preserved-uncertain"); assert.equal(status.outcomes.length, 9);
  assert.equal(status.outcomes[0].outcome, "preserved-uncertain");
  assert.equal(status.outcomes.slice(1).every((r) => r.outcome === "not-run"), true);
  assert.equal(status.uncollectedNativeRoots.length, 0, "drained cancelled evidence is still collected");
  assert.equal(calls.length, 2); mode = "normal";
  await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, 2);
  assert.ok(existsSync(join(h.directory, "00-catalog-page-timing", "native", "raw.log")));
  const saved = (await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit }));
  assert.equal(saved.status, "failed"); assert.equal(saved.qualified, false);
});

test("incomplete timing audit stays blocked in live and saved composition despite complete native flags", async () => {
  const s = setup(); mode = "complete"; const h = await begin(s);
  await s.campaign.advance(h); await s.campaign.advance(h);
  await s.campaign.submitJsonAudit(h, delivery(h)); auditComplete = false;
  const status = await s.campaign.advance(h);
  assert.equal(status.outcomes[1].outcome, "blocked");
  assert.equal(status.outcomes[1].appOutcomes.every((r) => !r.comparisonEligible), true);
  s.campaign.stop(h);
  const saved = await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit });
  assert.equal(saved.status, "blocked"); assert.equal(saved.qualified, false);
});
for (const boundary of ["abort-native", "leak"]) test(`${boundary}: a halted collected phase cannot be replaced by rehashing adjacent manifests`, async () => {
  const s = setup(), h = await begin(s); mode = boundary; abort = new AbortController();
  if (boundary === "abort-native") await s.campaign.advance(h, { signal: abort.signal });
  else await assert.rejects(s.campaign.advance(h));
  const request = { folder: root, round: expectedPlan.round, commit: expectedPlan.commit };
  const original = (await validateSavedCampaign(request)); assert.ok(["failed", "blocked"].includes(original.status), JSON.stringify(original));
  const phase = join(h.directory, "00-catalog-page-timing"), native = join(phase, "native");
  appendFileSync(join(native, "raw.log"), "REPLACED NATIVE BYTES\n");
  writeFileSync(join(phase, "native-manifest.json"), JSON.stringify(evidence.tree(native)));
  const status = JSON.parse(readFileSync(join(h.directory, "campaign-result.json"))).status;
  writeFileSync(join(h.directory, "collection-manifest.json"), JSON.stringify({ status, manifest: evidence.tree(h.directory) }));
  assert.equal((await validateSavedCampaign(request)).status, "invalid");
});
for (const bad of ["unsafe", "leak", "source-changed"]) test(`${bad} halts with all group outcomes and no further execution`, async () => {
  const s = setup(), h = await begin(s); mode = bad;
  await assert.rejects(s.campaign.advance(h));
  const status = s.campaign.status(h); assert.equal(status.state, "preserved-uncertain"); assert.equal(status.outcomes.length, 9);
  assert.equal(status.outcomes[0].outcome, bad === "source-changed" ? "not-run" : "preserved-uncertain");
  if (bad === "unsafe") assert.equal(status.uncollectedNativeRoots.length, 1, "unsafe original requires host retention");
  if (bad === "leak") {
    assert.equal(status.uncollectedNativeRoots.length, 0);
    assert.ok(existsSync(join(h.directory, "00-catalog-page-timing", "native", "raw.log")), "cleanup failure still seals terminal producer evidence");
  }
  const count = calls.length; await assert.rejects(s.campaign.advance(h)); assert.equal(calls.length, count);
  assert.ok(existsSync(join(h.directory, "campaign-result.json")));
});
test("audit authority is separate; receipt approval cannot authorize itself", async () => {
  const s = setup((subject) => subject.action === "begin-campaign"), h = await begin(s);
  await s.campaign.advance(h); await s.campaign.advance(h);
  await assert.rejects(s.campaign.submitJsonAudit(h, delivery(h)), /did not authorize/);
  assert.equal(s.campaign.status(h).state, "preserved-uncertain"); assert.equal(calls.length, 4);
  assert.ok(existsSync(join(h.directory, "json-audit-delivery-retained.json")));
  const saved = (await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit }));
  assert.equal(saved.status, "blocked", JSON.stringify(saved)); assert.equal(saved.qualified, false);
});
test("audit wait mutation and image replacement halt before timing", async () => {
  for (const bad of ["image-changed", "mutated-copy"]) {
    const s = setup(), h = await begin(s); await s.campaign.advance(h); await s.campaign.advance(h);
    if (bad === "image-changed") mode = bad;
    else appendFileSync(join(h.directory, "01-json-api-prepare", "native", "raw.log"), "mutation");
    await assert.rejects(s.campaign.submitJsonAudit(h, delivery(h))); assert.equal(calls.length, 4);
  }
});

for (const [group, scenario] of [
  ["localized-marketplace", "settles"], ["localized-marketplace", "aborts"],
  ["json-api", "settles"], ["json-api", "aborts"], ["json-api", "worker survives"],
]) test(`v5 ${group} udev settlement: ${scenario}`, async (t) => {
  t.mock.method(fs, "fsyncSync", () => {}); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = childProcess.spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "bench/workloads/test-fixtures/control-session-kernel.py"],
    { cwd: resolve(repo), input: JSON.stringify({ source: guardianSource, mode: "normal" }), encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout), s = setupGroup(group); s.plan.round = "r21"; admittedHost = proof.admission.host;
  const jsonPreparation = group === "json-api";
  settleWorkerTicks = jsonPreparation ? "10400" : "10601";
  settleSurvives = scenario === "worker survives";
  mode = "udev-settle";
  const { registration: fixture } = await import("../test-fixtures/control-stream-fixture.mjs");
  const { streamHash } = await import("./control-stream.mjs");
  const { deploymentSha256 } = await import("../deployments.mjs");
  admittedApparatus = { ...structuredClone(fixture), binding: proof.binding, host: proof.admission.host };
  proof.admission.apparatus = admittedApparatus;
  proof.admission.apparatusSample = { host: admittedHost, monoNs: "2000000", members: admittedApparatus.members, listener: admittedApparatus.listener };
  s.plan.bindings[0].resources.expectedCpus = { app: { cpuset: "1" }, api: { cpuset: "2-3" }, load: { cpuset: "4-7" } };
  const calls = [], stream = { registration: admittedApparatus, check() { calls.push("check"); },
    open(cpus) { assert.deepEqual(cpus, { app: "1", api: "2-3", load: "4-7" }); calls.push("open"); },
    close() { calls.push("close"); }, async seal() {
      calls.push("seal"); return { schema: "benchmark-control-stream-seal/v1", registration: admittedApparatus,
        observations: Array.from({ length: 21 }, (_, i) => ({ sequence: i + 1,
          monoNs: String(2000000 + i * 250500000), registrationSha256: streamHash(admittedApparatus) })),
        sealedMonoNs: "5016000000",
        lease: { id: admittedApparatus.id, host: admittedHost, expiresMonoNs: "15000000000" } };
    } };
  const handle = await s.campaign.begin(s.plan, { stateRoot: "/bench/campaign", control: { binding: proof.binding, admission: proof.admission, stream } });
  controlWindows.directory = handle.directory; controlWindows.phase = `00-${group}-${jsonPreparation ? "prepare" : "timing"}`;
  if (scenario === "aborts") settleAbort = new AbortController();
  const advanced = await s.campaign.advance(handle, { signal: settleAbort?.signal }).catch((error) => error);
  const phase = join(handle.directory, controlWindows.phase), first = JSON.parse(readFileSync(join(phase, "host-after.json")));
  if (scenario === "aborts") {
    assert.equal(observations, 3, "abort must not run the settled process or Docker census");
    assert.equal(existsSync(join(phase, "host-after-settled.json")), false);
    assert.ok(existsSync(join(phase, "native-manifest.json")), "first boundary and native evidence were sealed");
    assert.ok(existsSync(join(handle.directory, "campaign-result.json")));
    assert.equal(advanced.name, "AbortError");
    assert.ok(!calls.includes("seal"));
    assert.equal(existsSync(join(handle.directory, "json-audit-subject.json")), false);
    return;
  }
  const status = advanced;
  assert.equal(observations, 4);
  assert.deepEqual(first, { ...udevHost(3), terminalClock: udevClock() });
  assert.deepEqual(JSON.parse(readFileSync(join(phase, "command-1-host", "terminal.json"))).terminalClock, first.terminalClock);
  assert.deepEqual(JSON.parse(readFileSync(join(phase, "host-after-settled.json"))), udevHost(4));
  const request = { folder: root, round: "r21", commit: s.plan.commit };
  if (settleSurvives) {
    assert.match(advanced.message, /new persistent host processes remain: 1/);
    assert.equal(s.campaign.status(handle).state, "preserved-uncertain");
    assert.equal(existsSync(join(handle.directory, "json-audit-subject.json")), false);
    assert.ok((await validateSavedCampaign(request)).blockers.includes("json-api/prepare: host boundary uncertain"));
    return;
  }
  if (jsonPreparation) {
    assert.equal(status.state, "blocked-review-needed");
    assert.ok(calls.indexOf("open") < calls.indexOf("close") && !calls.includes("seal"));
    const reviewPath = join(handle.directory, fs.readdirSync(handle.directory).find((name) => name.endsWith("-review-needed.json")));
    const review = JSON.parse(readFileSync(reviewPath));
    assert.deepEqual(review.cleanup.settledUdevWorkers, [{ pid: 62274, startTicks: settleWorkerTicks }]);
    s.campaign.stop(handle); // Retain preparation evidence without delivering an audit or running timing.
    const inspected = await validateSavedCampaign(request);
    assert.equal(inspected.status, "blocked", JSON.stringify(inspected));
    assert.ok(!inspected.blockers.includes("json-api/prepare: host boundary uncertain"));
    const settled = udevHost(4);
    settled.processes.push(first.processes.at(-1));
    writeFileSync(join(phase, "host-after-settled.json"), JSON.stringify(settled));
    const phasePath = join(handle.directory, fs.readdirSync(handle.directory).find((name) => name.endsWith("-phase-sealed.json")));
    const seal = JSON.parse(readFileSync(phasePath));
    writeFileSync(phasePath, JSON.stringify({ ...seal, phaseManifestSha256: evidence.phaseSnapshot(phase, true).sha256 }));
    assert.equal((await validateSavedCampaign(request)).status, "invalid", "rehashed surviving worker cannot support recorded audit readiness");
    return;
  }
  assert.equal(status.state, "finished"); assert.ok(calls.indexOf("open") < calls.indexOf("close") && calls.indexOf("close") < calls.indexOf("seal"));
  assert.deepEqual(status.outcomes[0].cleanup.settledUdevWorkers, [{ pid: 62274, startTicks: settleWorkerTicks }]);
  const drain = { schema: "benchmark-control-stream-drain/v1", id: admittedApparatus.id, registrationSha256: streamHash(admittedApparatus),
    host: admittedHost, monoNs: "5017000000", identitiesAbsent: true, listener: admittedApparatus.listener,
    scopes: [{ path: "/user.slice/session-1.scope", exists: false, members: [], events: null }] };
  writeFileSync(join(handle.directory, "control-stream-drain.json"), JSON.stringify(drain));
  writeFileSync(join(handle.directory, "collection-manifest.json"), JSON.stringify(s.campaign.collect(handle)));
  const inspected = await validateSavedCampaign(request);
  assert.notEqual(inspected.status, "invalid");
  assert.deepEqual(inspected.supervisedTerminal, { registrationSha256: streamHash(admittedApparatus),
    sealSha256: evidence.digest(readFileSync(join(handle.directory, "control-stream-seal.json"))) });
  const receipt = join(phase, "host-after-settled.json");
  const collection = join(handle.directory, "collection-manifest.json"), previous = JSON.parse(readFileSync(collection));
  const resealCollection = () => {
    const entries = evidence.tree(handle.directory).entries.filter((e) => e.path !== "collection-manifest.json");
    writeFileSync(collection, JSON.stringify({ ...previous, manifest: { entries, sha256: deploymentSha256(entries) } }));
  };
  const phaseEventPath = join(handle.directory, fs.readdirSync(handle.directory).find((name) => name.endsWith("-phase-sealed.json")));
  const phaseEvent = JSON.parse(readFileSync(phaseEventPath));
  const resealPhase = () => {
    writeFileSync(phaseEventPath, JSON.stringify({ ...phaseEvent, phaseManifestSha256: evidence.phaseSnapshot(phase).sha256 }));
    resealCollection();
  };
  const settled = udevHost(4);
  settled.controlApparatus.sample.monoNs = String(BigInt(first.controlApparatus.sample.monoNs) + 1n);
  writeFileSync(receipt, JSON.stringify(settled));
  resealPhase();
  assert.equal((await validateSavedCampaign(request)).status, "invalid", "5.01s uptime cannot substitute for a 1ns monotonic wait");

  writeFileSync(receipt, JSON.stringify(udevHost(4)));
  const firstPath = join(phase, "host-after.json");
  const cutoff = { ...first.terminalClock, uptime: "105.99 1280.00\n" };
  const exitPath = join(handle.directory, fs.readdirSync(handle.directory).filter((name) => name.endsWith("-command-exited.json")).sort().at(-1));
  const exit = JSON.parse(readFileSync(exitPath));
  writeFileSync(exitPath, JSON.stringify({ ...exit, hostTerminalClock: cutoff }));
  writeFileSync(firstPath, JSON.stringify({ ...first, terminalClock: cutoff }));
  resealPhase();
  assert.equal((await validateSavedCampaign(request)).status, "invalid", "matching boundary and exit clocks cannot replace the sealed terminal lifetime cutoff");

  writeFileSync(exitPath, JSON.stringify(exit));
  writeFileSync(firstPath, JSON.stringify(first));
  resealPhase();
  assert.notEqual((await validateSavedCampaign(request)).status, "invalid");
  writeFileSync(receipt, JSON.stringify(first));
  resealCollection();
  assert.equal((await validateSavedCampaign(request)).status, "invalid", "an outer rehash cannot change the sealed first or settled boundary");
});

test("a timing audit mismatch halts after sealed collection without leaking native diagnostics", async () => {
  const s = setup(), h = await begin(s); await s.campaign.advance(h); await s.campaign.advance(h);
  await s.campaign.submitJsonAudit(h, delivery(h)); mode = "audit-mismatch";
  await assert.rejects(s.campaign.advance(h), { message: "timing-audit-does-not-match-accepted-subject" });
  const status = s.campaign.status(h); assert.equal(status.state, "preserved-uncertain"); assert.equal(calls.length, 6);
  assert.deepEqual(status.uncollectedNativeRoots, []);
  assert.ok(!JSON.stringify(status).includes("SYNTHETIC_PRIVATE_SENTINEL"));
  assert.ok(evidence.tree(h.directory).entries.some((e) => e.path.endsWith("-phase-sealed.json")
    && JSON.parse(readFileSync(join(h.directory, e.path))).phase === "timing"
    && JSON.parse(readFileSync(join(h.directory, e.path))).group === "json-api"));
});
test("cancellation while awaiting review retains all groups, no new timing or unlock", async () => {
  const s = setup(), h = await begin(s); await s.campaign.advance(h); await s.campaign.advance(h);
  const status = s.campaign.stop(h, "operator cancelled audit wait");
  assert.equal(status.state, "preserved-uncertain"); assert.equal(status.outcomes[1].outcome, "preserved-uncertain");
  assert.equal(status.outcomes.length, 9); assert.equal(calls.length, 4);
  const saved = (await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: expectedPlan.commit }));
  assert.equal(saved.status, "blocked", JSON.stringify(saved)); assert.equal(saved.collectionIntegrity, "unsealed-partial");
  assert.equal(saved.qualified, false); assert.equal(saved.deletionAuthorized, false);
  assert.equal((await validateSavedCampaign({ folder: root, round: expectedPlan.round, commit: "b".repeat(40) })).status, "invalid");
});
test.after(() => {
  assert.ok(evidence.inside(resolve(os.tmpdir()), resolve(temporary))); rmSync(temporary, { recursive: true, force: true });
});
