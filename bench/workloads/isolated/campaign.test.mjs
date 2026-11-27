// Test module substitution is confined to this process. Production has no injected
// runners/validators/probes. Real filesystem sealing and real IPC supervision remain.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import * as evidence from "./evidence.mjs";
import * as contracts from "./campaign-contract.mjs";
import { campaignRounds, groupNames, jsonPreparationRound, nativeArtifactRoot, runnerFor, selectedApps } from "../registry.mjs";
import { fakeChild } from "./test-fixtures/process.mjs";
import * as audit from "./test-fixtures/campaign-audit.mjs";
import * as nativeReplay from "./native-replay.mjs";
import { composePhase } from "./composition.mjs";
import * as actualLifetime from "./host-lifetime.mjs";
import { reserveCompilerTarget } from "../../client-heavy/compiler.mjs";
import { samplingControl } from "./test-fixtures/host-lifetime-storage.mjs";
import { ioError } from "./test-fixtures/host-durable-writer-control.mjs";
import * as actualHost from "./host-observation.mjs";
import { liveActorCpus, liveApplication } from "./native-roles.mjs";
import * as controlAdmission from "./control-admission.mjs";
import { guardianSource } from "../cloud-control-runtime.mjs";
import { fixtureGitEnv } from "../../../scripts/fixture-git.mjs";
import { deploymentSha256 } from "../deployments.mjs";
import { isolatedLiveCapture, isolatedLiveLifetime, isolatedLiveSuccess } from "./test-fixtures/live-campaign.mjs";
import { registration as controlRegistration } from "../test-fixtures/control-stream-fixture.mjs";
import { streamHash } from "./control-stream.mjs";
import { limits, supervise } from "./process.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = mkdtempSync(join(os.tmpdir(), "isolated-campaign-test-"));
let root, mode = "normal", expectedPlan, currentInvocation, calls = [], observations = 0, authorizations = [], release, pendingStarted, abort, auditComplete = true, lifetimeFailure, replayLifetimeFailure;
let lifetimeStartup;
let lifetimeRun;
let admittedHost, admittedApparatus, controlWindows, settleAbort, settleWorkerTicks, settleSecondWorker, settleSurvives, settleNativeFails;
let liveOutput, liveRoundTrip, compilerScratch;
let auditClock, offlinePrep;
const liveFixturePid = 42042;
let liveFixtureSignals;
const osKill = process.kill.bind(process);
mock.method(process, "kill", (pid, signal) => {
  // Keep the fake PID fenced even if a test ends before a pending timer fires.
  if (!liveFixtureSignals && pid !== liveFixturePid && pid !== -liveFixturePid) return osKill(pid, signal);
  liveFixtureSignals?.push({ pid, signal });
  throw new Error("synthetic Live fixture cannot signal an OS process");
});

function forbidLiveSignals(t) {
  assert.equal(liveFixtureSignals, undefined);
  const signals = liveFixtureSignals = [];
  t.after(() => {
    liveFixtureSignals = undefined;
    assert.deepEqual(signals, [], "synthetic Live fixture attempted OS signaling");
  });
  return signals;
}

function liveFixtureChild(run) {
  let cancelled = false;
  const child = fakeChild((fake) => { if (!cancelled) run(fake); });
  child.pid = liveFixturePid;
  const send = child.send.bind(child);
  child.send = (message, callback) => {
    if (message.type !== "cancel") return send(message, callback);
    if (!cancelled) {
      cancelled = true;
      queueMicrotask(() => child.close(null, message.signal));
    }
    callback?.(null);
  };
  return child;
}

const hourNs = 3600n * 1000000000n;
const sourceGit = (cwd, ...args) => childProcess.execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: fixtureGitEnv() });
const sourceStatus = (cwd) => sourceGit(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all");
mock.module("./control-admission.mjs", { exports: { ...controlAdmission,
  beginControlWindow(binding) {
    assert.equal(binding.round, "r21"); controlWindows.push("open");
    liveRoundTrip?.events.push("window-open");
    return () => {
      assert.ok(existsSync(join(controlWindows.directory, controlWindows.phase ?? "00-client-heavy-timing", "host-after.json")));
      controlWindows.push("close"); liveRoundTrip?.events.push("window-close");
    };
  },
} });
const cpu = { app: { cpuset: "1", quota: 1 } };
mock.module("./evidence.mjs", { namedExports: { ...evidence,
  physical: (path, ...rest) => evidence.physical(path === "/bench/campaign" ? root : path, ...rest),
  transferEvidence(source, destination) {
    if (liveRoundTrip?.mutateTransfer) {
      const marker = join(source, actualHost.liveWorkloadEndFile), record = JSON.parse(readFileSync(marker));
      record.clock.uptime = "141.23 31337.22\n";
      writeFileSync(marker, JSON.stringify(record));
    }
    return evidence.transferEvidence(source, destination);
  },
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
  b.request.round = phase === "prepare" ? jsonPreparationRound(plan.round) : campaignRounds(plan.round)["json-api"];
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
const udevWorkers = () => [{ pid: 62274, startTicks: settleWorkerTicks }, ...(settleSecondWorker ? [{ pid: 62275, startTicks: "10603" }] : [])];
function udevHost(observation, retainUdev = true) {
  const value = host();
  value.processes = admittedApparatus ? [...admittedApparatus.members, admittedApparatus.listener].map((p) => rawProcess(p)) : [];
  const provenance = retainUdev ? { udevExecutable } : {};
  value.processes.push({ ...rawProcess({ pid: 846, startTicks: "812", cgroup: udevPath, parentPid: 1 }, "systemd-udevd"), ...provenance });
  if (observation === 3 || observation === 4 && settleSurvives) for (const worker of udevWorkers())
    value.processes.push({ ...rawProcess({ ...worker, cgroup: udevPath, parentPid: 846 }, "(udev-worker)"), ...provenance });
  if (retainUdev) value.uptime = `${["100.00", "101.00", "106.15", "111.16"][observation - 1]} 1280.13\n`;
  if (admittedApparatus) value.controlApparatus.sample.monoNs = ["2000000", "2000000", "5000000", "5015000000"][observation - 1];
  return value;
}
mock.module("./host-observation.mjs", { namedExports: {
  ...actualHost, udevSettleMs: 0,
  sampleAuditClock: () => ({ ...auditClock }),
  observeHost(_apparatus, retainUdev = false) {
    observations++;
    if (liveRoundTrip) {
      const value = udevHost(observations, retainUdev), { capture, offlineClock } = liveRoundTrip;
      value.at = new Date(observations < 3 ? capture.start - 10 : capture.end + (observations === 4 ? 5010 : 5)).toISOString();
      if (retainUdev && offlineClock) value.offlineMonoNs = offlineClock[observations];
      if (retainUdev && liveRoundTrip.clockAt) value.uptime = liveRoundTrip.clockAt([0, 0, 0, 45000, 50010][observations]).uptime;
      if (observations === 4) liveRoundTrip.events.push("settled-census");
      return value;
    }
    if (offlinePrep && retainUdev) {
      const value = offlinePrep.settled ? udevHost(observations) : host();
      return { ...value, offlineMonoNs: offlinePrep[["", "before", "after", "settled"][observations - 1]] };
    }
    if (mode === "udev-settle") {
      if (observations === 3 && settleAbort) queueMicrotask(() => settleAbort.abort(new Error("abort during udev settle")));
      return udevHost(observations, retainUdev);
    }
    const value = host(); if (mode === "leak" && observations > 2) value.containers = ["leak"]; return value;
  },
  verifyHostBoundary(before, after) {
    if (mode === "udev-settle" || offlinePrep) return actualHost.verifyHostBoundary(before, after);
    assert.deepEqual(after, before, "host cleanup uncertain"); return { cleanup: "observed-boundary-matched", isolation: "unverified" };
  },
} });
mock.module("./host-lifetime.mjs", { exports: {
  ...actualLifetime,
  beginLifetime(args) {
    if (liveRoundTrip) return isolatedLiveLifetime(liveRoundTrip.capture, args, liveRoundTrip.clock);
    if (lifetimeRun) {
      const run = lifetimeRun;
      return run.setup = actualLifetime.beginLifetime(args).then((observer) => {
        run.observer = observer;
        return run.beforeAttach ? Object.freeze({ ...observer, attach(pid) { run.beforeAttach(); return observer.attach(pid); } }) : observer;
      });
    }
    const { directory, command, startupSignal } = args;
    const startup = lifetimeStartup;
    mkdirSync(directory); writeFileSync(join(directory, "raw.json"), "{}");
    const observer = { attach() { if (startup) { startup.attached++; startup.onAttach?.(); } }, dispose() { if (startup) startup.disposed++; }, finish(result, retainTerminalClock, settled) {
      const checks = { accounting: true, terminal: result.terminal, empty: true, observer: true,
        unforced: !result.cancelled && !result.forced, leader: true };
      if (lifetimeFailure?.command === command) Object.assign(checks, lifetimeFailure.checks);
      const proveUdevTerminal = retainTerminalClock && mode === "udev-settle";
      if (proveUdevTerminal) { assert.equal(command, 1); assert.equal(observations, 2); }
      if (compilerScratch && command === 1) assert.ok(existsSync(join(compilerScratch.target, "scratch")), "target must exist during descriptor sealing");
      const terminalClock = retainTerminalClock && (offlinePrep?.terminal
        ? { ...udevClock(), monoNs: offlinePrep.terminal } : proveUdevTerminal ? udevClock() : undefined);
      writeFileSync(join(directory, "terminal.json"), JSON.stringify({ ...checks, ...(terminalClock ? { terminalClock } : {}) }));
      if (checks.terminal && checks.empty) settled?.();
      return evidence.tree(directory);
    } };
    if (!startup) return observer;
    assert.ok(startupSignal instanceof AbortSignal);
    startup.signal = startupSignal; startup.directory = directory; startup.enter();
    return startup.gate.then(() => {
      if (startup.failure) throw Object.assign(new Error("PRIVATE_SETUP_FAILURE"), { operation: "sample-open", code: "EIO" });
      return observer;
    });
  },
  inspectLifetime(binding, invocation, directory, expected) {
    if (lifetimeRun || liveRoundTrip) return actualLifetime.inspectLifetime(binding, invocation, directory, expected);
    const { terminalClock, ...checks } = JSON.parse(readFileSync(join(directory, "terminal.json")));
    if (replayLifetimeFailure === expected.command) checks.accounting = false;
    const complete = Object.values(checks).every(Boolean);
    return { status: complete ? "verified" : "blocked", cleanupComplete: complete, checks,
      context: { bootId: host().bootId }, manifestSha256: evidence.tree(directory).sha256, terminalClock };
  },
  composeHostProof(...args) {
    if (liveRoundTrip) return actualLifetime.composeHostProof(...args);
    return { resources: mode === "complete" ? "verified" : "blocked", cleanupComplete: mode === "complete" };
  },
} });
mock.module("./native-replay.mjs", { exports: { ...nativeReplay,
  async inspectNative(binding, native) {
    if (liveRoundTrip) {
      if (!liveRoundTrip.nativeReads.length) {
        const events = fs.readdirSync(dirname(dirname(native))).filter((name) => /^\d{5}-/.test(name)).sort();
        assert.match(events.at(-1), /-phase-sealed\.json$/, "live inspection must run on the writer's phase-sealed prefix");
      }
      const result = await nativeReplay.inspectNative(binding, native);
      liveRoundTrip.nativeReads.push(result);
      return result;
    }
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
  if (liveRoundTrip) return liveFixtureChild((child) => {
    const { capture, output, workloadEnd } = liveRoundTrip;
    assert.deepEqual(invocation, capture.binding.execution.invocation.argv);
    mkdirSync(dirname(output), { recursive: true }); renameSync(capture.folder, output);
    if (workloadEnd) writeFileSync(join(output, actualHost.liveWorkloadEndFile), JSON.stringify({
      schema: actualHost.liveWorkloadEndSchema, round: capture.binding.request.round, commit: capture.binding.request.commit,
      pid: liveFixturePid, clock: workloadEnd,
    }));
    child.close(workloadEnd ? 0 : 1);
  });
  const child = fakeChild((child) => {
    if (lifetimeRun) { lifetimeRun.started = true; lifetimeRun.start(); return; }
    const native = !invocation[0].endsWith("fixtures.mjs");
    const finish = () => {
      if (compilerScratch) {
        const id = options.env.CORTEN_ISOLATED_COMPILER_TARGET_ID;
        if (native) {
          const { target, scenario } = compilerScratch, stat = fs.lstatSync(target, { bigint: true });
          assert.equal(id, `${stat.dev}:${stat.ino}`);
          if (scenario === "substituted") { renameSync(target, `${target}.original`); mkdirSync(target); }
          writeFileSync(join(target, "scratch"), "not native output");
        } else assert.equal(id, undefined);
      }
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
        : mode === "udev-settle" && settleNativeFails && native ? 1
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
    const startup = lifetimeStartup;
    startup.child = child;
    const send = child.send.bind(child);
    child.send = (message, callback) => {
      if (message.type === "cancel") {
        callback?.(null);
        if (startup.onCancel) startup.onCancel(); else queueMicrotask(() => child.close(0));
        return;
      }
      return send(message, callback);
    };
  }
  return child;
});
const { createCampaign } = await import("./campaign.mjs");
const { validateCampaign: validateSavedCampaign } = await import("./campaign-verify.mjs");
const { replaySealedPhase } = await import("./campaign-journal.mjs");
let round = 100;
function setup(policy = () => true) {
  admittedHost = null; admittedApparatus = null; controlWindows = []; settleAbort = null; settleSecondWorker = false;
  liveOutput = null; liveRoundTrip = null; compilerScratch = null; offlinePrep = null;
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
function controlledRound(plan) {
  plan.round = "r21";
  for (const binding of plan.bindings) {
    const { group } = binding.request, { entry, selection } = runnerFor(group);
    binding.request.round = campaignRounds(plan.round)[group];
    binding.execution.invocation.argv = [entry, binding.request.round, ...selection];
  }
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

function syntheticBootstrap(t) {
  t.mock.method(fs, "fsyncSync", () => {}); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = childProcess.spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "bench/workloads/test-fixtures/control-session-kernel.py"],
    { cwd: resolve(repo), input: JSON.stringify({ source: guardianSource, mode: "normal" }), encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function monitoredSettlementControl(proof, cpus, events) {
  const { binding, admission } = proof;
  admittedApparatus = { ...structuredClone(controlRegistration), binding, host: admission.host };
  admission.apparatus = admittedApparatus;
  admission.apparatusSample = { host: admission.host, monoNs: "2000000", members: admittedApparatus.members, listener: admittedApparatus.listener };
  const stream = { registration: admittedApparatus, check() { events.push("check"); },
    open(observed) { assert.deepEqual(observed, cpus); events.push("open"); },
    close() { events.push("close"); }, async seal() {
      events.push("seal"); return { schema: "benchmark-control-stream-seal/v1", registration: admittedApparatus,
        observations: Array.from({ length: 21 }, (_, i) => ({ sequence: i + 1,
          monoNs: String(2000000 + i * 250500000), registrationSha256: streamHash(admittedApparatus) })),
        sealedMonoNs: "5016000000",
        lease: { id: admittedApparatus.id, host: admission.host, expiresMonoNs: "15000000000" } };
    } };
  return { binding, admission, stream };
}

function writeSettlementDrain(handle) {
  const drain = { schema: "benchmark-control-stream-drain/v1", id: admittedApparatus.id, registrationSha256: streamHash(admittedApparatus),
    host: admittedHost, monoNs: "5017000000", identitiesAbsent: true, listener: admittedApparatus.listener,
    scopes: [{ path: "/user.slice/session-1.scope", exists: false, members: [], events: null }] };
  writeFileSync(join(handle.directory, "control-stream-drain.json"), JSON.stringify(drain));
}

function fakeOfflineFenceCommands(t, binding, packets, commandCount = 2) {
  const table = "corten_bench_native", tcpMatch = { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 22 } };
  const policy = { nftables: [
    { metainfo: { json_schema_version: 1 } },
    { table: { handle: 1, family: "inet", name: table } },
    { chain: { handle: 2, family: "inet", table, name: "input", type: "filter", hook: "input", prio: 10, policy: "accept" } },
    { rule: { handle: 3, family: "inet", table, chain: "input", expr: [
      tcpMatch, { match: { op: "==", left: { "&": [{ payload: { protocol: "tcp", field: "flags" } }, ["fin", "syn", "rst", "ack"]] }, right: "syn" } },
      { limit: { rate: 8, burst: 8, per: "minute" } }, { counter: { packets: 0, bytes: 0 } }, { drop: null },
    ] } },
    { rule: { handle: 4, family: "inet", table, chain: "input", expr: [tcpMatch, { counter: { packets: 0, bytes: 0 } }, { drop: null }] } },
  ] };
  const events = [];
  t.mock.method(childProcess, "spawnSync", (program, args, opts) => {
    if (program === "/usr/bin/python3") {
      const op = args.at(-2);
      assert.ok(["window-open", "window-close"].includes(op));
      assert.equal(calls.length, op === "window-open" ? 0 : commandCount);
      assert.equal(args.at(-1), binding.token);
      events.push(op);
    } else {
      assert.equal(program, "/usr/bin/taskset");
      assert.deepEqual(args.slice(0, 3), ["-c", "0", "/usr/sbin/nft"]);
      // The fence installs as one argv batch with no stdin input.
      const install = args.length === 4 && args[3] === controlAdmission.offlineFenceRules;
      events.push(install ? "install" : args[3]);
      if (install) assert.equal(opts.input, "");
      else assert.deepEqual(args.slice(-3), ["table", "inet", table]);
      if (args[3] === "-j" && events.includes("window-close"))
        policy.nftables[3].rule.expr[3].counter = { packets, bytes: 60 * packets };
    }
    return { status: 0, stdout: JSON.stringify(policy) };
  });
  syncBuiltinESMExports();
  return events;
}

async function offlineCampaign(t, group, packets = 2, settle = false) {
  const { binding, admission } = syntheticBootstrap(t), s = setupGroup(group);
  controlledRound(s.plan); admittedHost = admission.host;
  const closed = BigInt(admission.closedMonoNs), after = closed + 6n * hourNs;
  if (group === "json-api") {
    offlinePrep = { before: String(closed + 5n * hourNs), after: String(after),
      ...(settle ? { terminal: String(after - 1n), settled: String(after + BigInt(actualHost.udevSettleMs) * 1000000n) } : {}) };
    settleWorkerTicks = "10400"; settleSurvives = false;
  }
  auditClock = { bootId: admittedHost.bootId, monoNs: offlinePrep?.settled ?? offlinePrep?.after ?? admission.closedMonoNs };
  s.plan.bindings[0].resources.expectedCpus = { app: { cpuset: "1" }, api: { cpuset: "2" }, load: { cpuset: "3-7" } };
  const events = fakeOfflineFenceCommands(t, binding, packets);
  const handle = await s.campaign.begin(s.plan, { stateRoot: "/bench/campaign", control: { binding, admission, offlineHandoff: true } });
  return { ...s, binding, admission, events, handle, collection: join(handle.directory, "collection-manifest.json"),
    validate: () => validateSavedCampaign({ folder: root, round: "r21", commit: s.plan.commit }) };
}

test("offline timed probe hits preserve evidence but disqualify an otherwise verified native phase", async (t) => {
  const s = await offlineCampaign(t, "localized-marketplace");
  const { handle, binding, admission, events, collection, validate } = s;
  mode = "complete";
  assert.equal(s.campaign.status(handle).executionVersion, 6);
  const status = await s.campaign.advance(handle);
  assert.equal(status.state, "finished");
  assert.equal(status.outcomes[0].outcome, "blocked");
  assert.equal(status.outcomes[0].nativeStatus, "verified");
  assert.ok(status.outcomes[0].appOutcomes.every(({ comparisonEligible }) => !comparisonEligible));
  assert.deepEqual(events, ["install", "-j", "window-open", "window-close", "-j", "delete"]);
  writeFileSync(collection, JSON.stringify(s.campaign.collect(handle)));
  const saved = await validate();
  assert.equal(saved.status, "blocked", JSON.stringify(saved));
  assert.deepEqual(saved.offlineIngress, [{ group: "localized-marketplace", phase: "timing", packets: 2, bytes: 120 }]);
  assert.ok(saved.blockers.includes("localized-marketplace/timing: denied pre-login probe traffic"));
  assert.deepEqual(saved.offlineTerminal, { ...admission.host, token: binding.token,
    bootstrapSealSha256: evidence.digest(JSON.stringify(admission.seal.ledger)) });
  const phase = "00-localized-marketplace-timing", raw = join(handle.directory, phase, "control-ingress.json");
  const changed = JSON.parse(readFileSync(raw));
  assert.deepEqual(changed.after.nftables[3].rule.expr[3].counter, { packets: 2, bytes: 120 });
  assert.deepEqual(controlAdmission.verifyOfflineWindow(changed), { packets: 2, bytes: 120 });
  for (const mutate of [
    ({ before }) => { before.nftables[3].rule.expr[3].counter = { packets: 3, bytes: 180 }; },
    ({ after }) => { after.nftables[3].rule.handle++; },
    ({ after }) => { after.nftables[3].rule.expr[1].match.right = "ack"; },
    ({ after }) => { after.nftables[3].rule.expr[2].limit.burst++; },
  ]) {
    const wrong = structuredClone(changed); mutate(wrong);
    assert.throws(() => controlAdmission.verifyOfflineWindow(wrong));
  }
  changed.after.nftables[4].rule.expr[1].counter = { packets: 1, bytes: 60 };
  assert.throws(() => controlAdmission.verifyOfflineWindow(changed));
  // Matching hashes cannot repair a bad fence observation.
  writeFileSync(raw, JSON.stringify(changed));
  const phaseSeal = evidence.tree(handle.directory).entries.find(({ path }) => /^\d{5}-phase-sealed\.json$/.test(path));
  const sealPath = join(handle.directory, phaseSeal.path), event = JSON.parse(readFileSync(sealPath));
  event.phaseManifestSha256 = evidence.phaseSnapshot(join(handle.directory, phase)).sha256;
  writeFileSync(sealPath, JSON.stringify(event));
  const retained = JSON.parse(readFileSync(collection)), entries = evidence.tree(handle.directory).entries.filter(({ path }) => path !== "collection-manifest.json");
  writeFileSync(collection, JSON.stringify({ ...retained, manifest: { entries, sha256: evidence.digest(JSON.stringify(entries)) } }));
  assert.equal((await validate()).status, "invalid");
});

test("offline timed phase with zero denied probes remains eligible for ordinary replay", async (t) => {
  const { campaign, handle, collection, validate } = await offlineCampaign(t, "localized-marketplace", 0);
  mode = "complete";
  const status = await campaign.advance(handle);
  assert.equal(status.outcomes[0].outcome, "native-validated");
  writeFileSync(collection, JSON.stringify(campaign.collect(handle)));
  const saved = await validate();
  assert.equal(saved.status, "verified", JSON.stringify(saved));
  assert.deepEqual(saved.offlineIngress, [{ group: "localized-marketplace", phase: "timing", packets: 0, bytes: 0 }]);
});

test("isolated Live fixture drains a setup fault without OS signaling", { timeout: 3000 }, async (t) => {
  const signals = forbidLiveSignals(t);
  t.mock.property(process, "platform", "linux");
  const start = t.mock.fn(), child = liveFixtureChild(start);
  const ipc = t.mock.method(child, "send"), force = t.mock.method(child, "kill");
  t.mock.method(childProcess, "spawn", () => child);
  let attachedPid;
  const result = await supervise({ executable: "node", argv: ["synthetic-live"], shell: false }, {
    cwd: repo, env: {}, log() {},
    onStart(pid) { attachedPid = pid; throw new Error("synthetic observer attach fault"); },
  }, { readyMs: 1000, runMs: 1000, stopMs: 10, killMs: 10 });
  assert.equal(attachedPid, liveFixturePid);
  assert.equal(start.mock.callCount(), 0);
  assert.deepEqual(ipc.mock.calls.map(({ arguments: [message] }) => message), [{ type: "cancel", signal: "SIGTERM" }]);
  assert.deepEqual(signals, [], "synthetic Live fixture attempted OS signaling");
  assert.equal(force.mock.callCount(), 0);
  assert.deepEqual(result, { terminal: true, code: null, signal: "SIGTERM", cancelled: true, forced: false,
    error: "native host observation setup failed", success: false });
});

for (const [group, offline, early = false] of [["live-delivery", false], ["live-delivery", true],
  ["recoverable-live", false], ["recoverable-live", true], ["live-delivery", true, true]]) {
  test(`isolated Live round trip: ${group} ${offline ? "offline" : "monitored"}${early ? " refuses unproved early settle" : ""}`, async (t) => {
    forbidLiveSignals(t);
    const { campaign, plan } = setupGroup(group), proof = syntheticBootstrap(t);
    plan.round = proof.binding.round;
    const capture = await isolatedLiveCapture(t, group, campaignRounds(plan.round)[group]);
    const output = join(temporary, `native-r${round}`, group);
    capture.binding.validation = { artifactRoot: relative(repo, output).replaceAll("\\", "/") };
    capture.binding.latestStable = plan.bindings[0].latestStable;
    plan.bindings[0] = capture.binding;
    delete plan.campaignSha256; plan.campaignSha256 = deploymentSha256(plan);
    admittedHost = proof.admission.host;
    settleWorkerTicks = early ? "10304" : "10601"; settleSurvives = false;
    const boot = offline ? BigInt(proof.admission.closedMonoNs) : 0n;
    const clock = { ...udevClock(), monoNs: String(boot + 4000000n) };
    const events = offline ? fakeOfflineFenceCommands(t, proof.binding, 0, 1) : [];
    const control = offline ? { ...proof, offlineHandoff: true } : monitoredSettlementControl(proof, liveActorCpus, events);
    const offlineClock = offline ? [0n, 0n, 2000000n, 5000000n, 5015000000n].map((offset) => String(boot + offset)) : null;
    const workloadEnd = early ? { bootId: clock.bootId, uptime: "103.03 1277.00\n", monoNs: String(boot + 3500000n) } : undefined;
    liveRoundTrip = { capture, output, clock, workloadEnd, offlineClock, events, nativeReads: [] };
    const handle = await campaign.begin(plan, { stateRoot: "/bench/campaign", control });
    controlWindows.directory = handle.directory; controlWindows.phase = `00-${group}-timing`;
    if (early) {
      // Exit zero and a sealed marker are not substitutes for successful native actor windows.
      await assert.rejects(campaign.advance(handle), /early udev settlement requires verified live workload evidence/);
      assert.ok(events.includes("settled-census"));
      assert.deepEqual(liveRoundTrip.nativeReads.map(({ status, cleanupComplete }) => [status, cleanupComplete]), [["invalid", false]]);
      assert.equal(campaign.status(handle).state, "preserved-uncertain");
      assert.ok(!readdirSync(handle.directory).some((name) => name.endsWith("-group-finished.json")));
      return;
    }
    const status = await campaign.advance(handle);
    assert.equal(status.state, "finished"); assert.equal(status.executionVersion, offline ? 6 : 5);
    assert.deepEqual(events.filter((kind) => kind !== "check"), offline
      ? ["install", "-j", "window-open", "settled-census", "window-close", "-j", "delete"]
      : ["open", "window-open", "settled-census", "window-close", "close", "seal"], "control window must cover the settled census");
    assert.deepEqual(status.outcomes[0].cleanup.settledUdevWorkers, [{ pid: 62274, startTicks: "10601" }]);
    assert.deepEqual(liveRoundTrip.nativeReads.map(({ status, resources, cleanupComplete }) => [status, resources, cleanupComplete]),
      [["failed", "verified", true]], "synthetic target failures must not prevent a complete, isolated cleanup proof");
    assert.equal(status.outcomes[0].outcome, "native-validated");
    if (!offline) writeSettlementDrain(handle);
    writeFileSync(join(handle.directory, "collection-manifest.json"), JSON.stringify(campaign.collect(handle)));
    const saved = await validateSavedCampaign({ folder: root, round: plan.round, commit: plan.commit });
    assert.equal(saved.status, "verified", JSON.stringify(saved));
    assert.equal(saved.collectionIntegrity, "manifest-verified");
    assert.deepEqual(saved.groups[0].appOutcomes, status.outcomes[0].appOutcomes);
    assert.ok(saved.groups[0].appOutcomes.every(({ outcome, comparisonEligible }) => outcome === "failed" && !comparisonEligible));
    assert.deepEqual(liveRoundTrip.nativeReads.map(({ resources, cleanupComplete }) => [resources, cleanupComplete]),
      [["verified", true], ["verified", true]], "both live prefix and saved archive must use real isolated replay");
    if (offline) assert.deepEqual(saved.offlineIngress, [{ group, phase: "timing", packets: 0, bytes: 0 }]);
  });
}

const successfulLive = "isolated Live successful early settlement and clock-only mutations";
test(successfulLive, { timeout: 125000 }, async (t) => {
  const group = "live-delivery";
  if (selectedApps(group).length !== 1) {
    // Start a test-only single-app registry before loading the production
    // readers. Keep all of their checks, including verifyRound and fan-out.
    for (const variant of ["replay", "changed-transfer"]) {
      const run = childProcess.execFileSync(process.execPath, ["--experimental-test-module-mocks", "--test-name-pattern", successfulLive,
        "--input-type=module", "-", variant], { cwd: repo, encoding: "utf8", timeout: 60000, input: `
        import { mock } from "node:test";
        const registry = new URL("../registry.mjs", ${JSON.stringify(import.meta.url)});
        const actual = await import(registry);
        mock.module(registry, { exports: { ...actual, selectedApps: (group) => group === "live-delivery" ? ["express"] : actual.selectedApps(group) } });
        await import(${JSON.stringify(import.meta.url)});
      ` });
      assert.match(run, /pass 1/);
    }
    return;
  }
  forbidLiveSignals(t);
  const { campaign, plan } = setupGroup(group), proof = syntheticBootstrap(t);
  plan.round = proof.binding.round;
  const clockAt = (ms) => ({ bootId: proof.admission.host.bootId, uptime: `${((100000 + ms) / 1000).toFixed(2)} 0.00\n`,
    monoNs: String(BigInt(proof.admission.closedMonoNs) + BigInt(ms + 100000) * 1000000n) });
  const capture = await isolatedLiveSuccess(t, campaignRounds(plan.round)[group], clockAt);
  const output = join(temporary, `native-r${round}`, "success");
  capture.binding.validation = { artifactRoot: relative(repo, output).replaceAll("\\", "/") };
  capture.binding.latestStable = plan.bindings[0].latestStable;
  plan.bindings[0] = capture.binding;
  delete plan.campaignSha256; plan.campaignSha256 = deploymentSha256(plan);
  admittedHost = proof.admission.host; settleWorkerTicks = "14100";
  const events = fakeOfflineFenceCommands(t, proof.binding, 0, 1);
  const clock = { ...clockAt(44000), ticksPerSecond: 100 };
  liveRoundTrip = { capture, output, clock, clockAt, workloadEnd: clockAt(40000), events, nativeReads: [],
    offlineClock: [0, 0, 0, 45000, 50010].map((ms) => clockAt(ms).monoNs),
    mutateTransfer: process.argv.includes("changed-transfer") };
  const handle = await campaign.begin(plan, { stateRoot: "/bench/campaign", control: { ...proof, offlineHandoff: true } });
  const phase = join(handle.directory, "00-live-delivery-timing"), native = join(phase, "native");
  if (liveRoundTrip.mutateTransfer) {
    await assert.rejects(campaign.advance(handle), { message: "live workload end changed during collection" });
    const halt = readdirSync(handle.directory).find((name) => name.endsWith("-halted.json"));
    assert.ok(halt);
    const bytes = readFileSync(join(handle.directory, halt), "utf8");
    assert.match(bytes, /live workload end changed during collection/);
    assert.doesNotMatch(bytes, /31337\.22/);
    return;
  }
  const status = await campaign.advance(handle);
  assert.equal(status.outcomes[0].outcome, "native-validated", JSON.stringify(liveRoundTrip.nativeReads));
  assert.deepEqual(status.outcomes[0].cleanup.settledUdevWorkers, [{ pid: 62274, startTicks: "14100" }]);
  const collection = join(handle.directory, "collection-manifest.json");
  writeFileSync(collection, JSON.stringify(campaign.collect(handle)));
  const saved = await validateSavedCampaign({ folder: root, round: plan.round, commit: plan.commit });
  assert.equal(saved.status, "verified", JSON.stringify(saved));
  assert.deepEqual(liveRoundTrip.nativeReads.map(({ status, resources, cleanupComplete }) => [status, resources, cleanupComplete]),
    [["verified", "verified", true], ["verified", "verified", true]]);

  const marker = join(native, actualHost.liveWorkloadEndFile), record = JSON.parse(readFileSync(marker));
  const sealPath = join(handle.directory, readdirSync(handle.directory).find((name) => name.endsWith("-phase-sealed.json")));
  const seal = JSON.parse(readFileSync(sealPath));
  // Rebind the native and phase seals so the independent native reader has
  // to judge the clock itself, not a stale hash or a different command exit.
  record.clock.uptime = clockAt(1000).uptime;
  writeFileSync(marker, JSON.stringify(record));
  const manifest = evidence.tree(native);
  writeFileSync(join(phase, "native-manifest.json"), JSON.stringify(manifest));
  writeFileSync(sealPath, JSON.stringify({ ...seal, nativeManifestSha256: manifest.sha256, phaseManifestSha256: evidence.phaseSnapshot(phase).sha256 }));
  const refused = await nativeReplay.inspectNative(capture.binding, native);
  assert.deepEqual(refused.outcomes, [{ app: "express", outcome: "passed" }], "native v3 measurements must still pass");
  assert.equal(refused.status, "invalid");
  assert.equal(refused.resources, "invalid");
  assert.equal(refused.cleanupComplete, false);
});

test("offline audit cannot start before the guest has closed bootstrap", async (t) => {
  const { campaign, handle, admission } = await offlineCampaign(t, "mixed-production");
  auditClock.monoNs = String(BigInt(admission.closedMonoNs) - 1n);
  await assert.rejects(campaign.advance(handle), /audit wait predates bootstrap closure/);
  assert.equal(campaign.status(handle).state, "preserved-uncertain");
});

for (const settle of [false, true]) test("offline JSON wait cannot start before " + (settle ? "settled" : "first") + " preparation boundary", async (t) => {
  const { campaign, handle, admission } = await offlineCampaign(t, "json-api", 2, settle);
  auditClock.monoNs = settle ? offlinePrep.after : String(BigInt(admission.closedMonoNs) + hourNs);
  await assert.rejects(campaign.advance(handle), /audit wait predates preparation completion/);
  assert.equal(campaign.status(handle).state, "preserved-uncertain");
});

for (const [group, settle] of [["json-api", false], ["json-api", true], ["mixed-production", false]]) test(
  "offline audit expiry seals only the pre-timing evidence: " + group + (settle ? " settled" : ""), async (t) => {
  const { campaign, handle, collection, validate, admission } = await offlineCampaign(t, group, 2, settle);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-22T00:00:00Z") });
  const waiting = await campaign.advance(handle);
  assert.equal(waiting.state, "blocked-review-needed", "untimed preparation may see denied probes");
  assert.throws(() => campaign.expireOfflineAudit(handle), /deadline has not expired/);
  t.mock.timers.tick(contracts.auditWaitMs * 2);
  assert.throws(() => campaign.expireOfflineAudit(handle), /deadline has not expired/, "a forward wall step must not expire the wait");
  const bootId = auditClock.bootId;
  auditClock = { bootId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    monoNs: String(BigInt(auditClock.monoNs) + BigInt(contracts.auditWaitMs) * 1000000n) };
  assert.throws(() => campaign.expireOfflineAudit(handle), /audit clock boot differs/);
  auditClock.bootId = bootId;
  const completeNs = BigInt(auditClock.monoNs);
  auditClock.monoNs = String(completeNs - 1n);
  assert.equal(campaign.offlineAuditRemainingMs(handle), 1);
  assert.throws(() => campaign.expireOfflineAudit(handle), /deadline has not expired/);
  auditClock.monoNs = String(completeNs);
  t.mock.timers.setTime(new Date("2026-11-21T00:00:00Z").valueOf());
  const prefix = group === "json-api" ? "json" : "mixed", inbox = join(handle.directory, prefix + "-audit-delivery-pending.json");
  writeFileSync(inbox, "{}");
  assert.throws(() => campaign.expireOfflineAudit(handle), /delivery may have started/);
  fs.unlinkSync(inbox);
  writeFileSync(collection, JSON.stringify(campaign.expireOfflineAudit(handle)));
  const result = await validate();
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.deepEqual(result.groups, []);
  assert.equal(result.collectionIntegrity, "manifest-verified");
  assert.equal(result.commandLifecycle, "observed-terminal");
  assert.deepEqual(result.offlineAuditExpired, { group, subjectSha256: group === "json-api" ? waiting.auditSubjectSha256 : waiting.mixedAuditSubjectSha256 });
  assert.deepEqual(result.offlineIngress, group === "json-api" ? [{ group, phase: "prepare", packets: 2, bytes: 120 }] : []);
  const retained = JSON.parse(readFileSync(collection));
  const { deploymentSha256 } = await import("../deployments.mjs");
  const reseal = () => {
    const entries = evidence.tree(handle.directory).entries.filter(({ path }) => path !== "collection-manifest.json");
    writeFileSync(collection, JSON.stringify({ ...retained, manifest: { entries, sha256: deploymentSha256(entries) } }));
  };
  reseal(); assert.equal((await validate()).status, "blocked", "control: an unchanged archive survives resealing");
  writeFileSync(inbox, "{}"); reseal();
  assert.equal((await validate()).status, "invalid", "rehashing cannot excuse an unsettled audit delivery");
  fs.unlinkSync(inbox);
  const expiry = retained.manifest.entries.find(({ path }) => /^\d{5}-offline-audit-expired\.json$/.test(path));
  const expiryPath = join(handle.directory, expiry.path), terminal = JSON.parse(readFileSync(expiryPath));
  const goodClock = { ...terminal.auditClock };
  terminal.auditClock.monoNs = String(BigInt(goodClock.monoNs) - 1n);
  writeFileSync(expiryPath, JSON.stringify(terminal)); reseal();
  assert.equal((await validate()).status, "invalid", "rehashing cannot authorize an early expiry");
  terminal.auditClock = { ...goodClock, bootId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" };
  writeFileSync(expiryPath, JSON.stringify(terminal)); reseal();
  assert.equal((await validate()).status, "invalid", "rehashing cannot join samples from different boots");
  const waitingEvent = retained.manifest.entries.find(({ path }) => /^\d{5}-(?:mixed-)?review-needed\.json$/.test(path));
  const waitPath = join(handle.directory, waitingEvent.path), wait = JSON.parse(readFileSync(waitPath));
  const savedWaitClock = { ...wait.auditClock };
  wait.auditClock.bootId = terminal.auditClock.bootId;
  writeFileSync(waitPath, JSON.stringify(wait));
  reseal();
  assert.equal((await validate()).status, "invalid", "two samples on a different boot cannot qualify the admitted host");
  const beforeBootstrap = BigInt(admission.closedMonoNs) - 1n;
  wait.auditClock = { bootId, monoNs: String(beforeBootstrap) };
  terminal.auditClock = { bootId, monoNs: String(beforeBootstrap + BigInt(contracts.auditWaitMs) * 1000000n) };
  writeFileSync(waitPath, JSON.stringify(wait)); writeFileSync(expiryPath, JSON.stringify(terminal)); reseal();
  assert.equal((await validate()).status, "invalid", "the full wait must begin after bootstrap has closed");
  if (group === "json-api") {
    const early = settle ? BigInt(offlinePrep.after) : BigInt(admission.closedMonoNs) + hourNs;
    wait.auditClock = { bootId, monoNs: String(early) };
    terminal.auditClock = { bootId, monoNs: String(early + BigInt(contracts.auditWaitMs) * 1000000n) };
    writeFileSync(waitPath, JSON.stringify(wait)); writeFileSync(expiryPath, JSON.stringify(terminal)); reseal();
    assert.equal((await validate()).status, "invalid", "a canonically resealed wait cannot borrow time from preparation");
    if (!settle) {
      wait.auditClock = savedWaitClock; terminal.auditClock = goodClock;
      writeFileSync(waitPath, JSON.stringify(wait)); writeFileSync(expiryPath, JSON.stringify(terminal));
      const phase = join(handle.directory, "00-json-api-prepare");
      const seal = retained.manifest.entries.find(({ path }) => /^\d{5}-phase-sealed\.json$/.test(path));
      const sealPath = join(handle.directory, seal.path), sealEvent = JSON.parse(readFileSync(sealPath));
      const afterPath = join(phase, "host-after.json"), after = JSON.parse(readFileSync(afterPath));
      for (const [badClock, reason] of [[undefined, "missing"], [String(BigInt(offlinePrep.before) - 1n), "regressing"]]) {
        writeFileSync(afterPath, JSON.stringify({ ...after, offlineMonoNs: badClock }));
        sealEvent.phaseManifestSha256 = evidence.phaseSnapshot(phase, true).sha256;
        writeFileSync(sealPath, JSON.stringify(sealEvent)); reseal();
        assert.equal((await validate()).status, "invalid", `resealing cannot excuse a ${reason} preparation end clock`);
      }
    }
  }
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
    const halted = readdirSync(h.directory).find((name) => /^\d+-halted\.json$/.test(name));
    const savedHalt = readFileSync(join(h.directory, halted), "utf8");
    if (fault === "write") {
      assert.match(outcome.error.message, /storage incomplete/);
      assert.equal(outcome.error.code, "EIO");
      assert.equal(existsSync(join(directory, "terminal.json")), false); assert.equal(f.removed, false);
      assert.deepEqual(JSON.parse(savedHalt).hostStorageFailure, { operation: "sample-write", code: "EIO" });
      assert.ok(!savedHalt.includes("PRIVATE_STORAGE_DETAIL"));
    } else {
      assert.equal(JSON.parse(savedHalt).hostStorageFailure, undefined);
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

for (const kind of ["fault", "fault then cleanup failure", "cancel", "cancel then fault", "deadline", "cancel through deadline",
  "deadline then cancel", "deadline then fault", "exit through deadline", "attachment deadline"])
test(`actual campaign startup storage: ${kind} preserves only a real writer diagnostic`, { timeout: 15000 }, async (t) => {
  t.mock.method(fs, "fsyncSync", () => {}); syncBuiltinESMExports();
  const s = setupGroup("client-heavy"); s.plan.round = "r21";
  const h = await begin(s), parent = new AbortController();
  t.mock.method(globalThis, "setInterval", () => null);
  const f = await samplingControl(t);
  f.before = (step) => step === "sync" ? null : undefined;
  await f.finish(); f.removed = false;
  const run = lifetimeRun = { started: false, cancels: 0 };
  const cancelled = new Promise((resolve) => { run.cancel = resolve; });
  run.start = () => run.child.close(0);
  let openFaults = 0, cleanupFaults = 0, settled = false;
  const directory = join(h.directory, "00-client-heavy-timing"), host = join(directory, "command-0-host");
  const sample = join(host, "samples.jsonl");
  const held = !kind.startsWith("fault");
  const attaching = kind === "attachment deadline", earlyExit = kind === "exit through deadline";
  const pause = attaching ? f.pause("sync", (path) => path.startsWith(join(host, "processes")) && path.endsWith(".json"))
    : held ? f.pause("open", (path) => path === sample) : null;
  const before = f.before;
  const deadline = kind.includes("deadline"), earlyCancel = kind.startsWith("cancel"), lateCancel = kind === "deadline then cancel";
  const lateFault = kind === "deadline then fault";
  if (deadline) t.mock.timers.enable({ apis: ["setTimeout"] });
  if (kind === "fault then cleanup failure") {
    const rmdir = fs.rmdirSync;
    t.mock.method(fs, "rmdirSync", (path, ...args) => {
      if (String(path).replaceAll("\\", "/").startsWith("/sys/fs/cgroup/")) {
        cleanupFaults++;
        throw Object.assign(new Error("PRIVATE_CLEANUP_DETAIL"), { code: "EBUSY" });
      }
      return rmdir(path, ...args);
    });
    syncBuiltinESMExports();
  }
  f.before = async (step, path) => {
    await before(step, path);
    if (step === "open" && path === sample && (!held || kind === "cancel then fault" || lateFault)) { openFaults++; throw ioError(); }
  };
  const advancing = s.campaign.advance(h, { signal: parent.signal }).then(
    () => { settled = true; }, (error) => { settled = true; return error; });
  try {
    if (pause) await pause.entered;
    if (earlyCancel) parent.abort();
    if (earlyExit) run.child.emit("exit", 0, null);
    if (deadline) t.mock.timers.tick(30000);
    if (lateCancel) parent.abort();
    await Promise.race([cancelled, advancing.then(() => { throw new Error("startup did not request owned cancellation"); })]);
    assert.equal(run.started, false); assert.equal(run.cancels, 1);
    assert.equal(parent.signal.aborted, earlyCancel || lateCancel); assert.equal(settled, false);
    assert.throws(() => s.campaign.stop(h), /wait for owned command shutdown/);
    if (!deadline || lateFault) pause?.release();
    if (lateFault) await new Promise((resolve) => setImmediate(resolve));
    run.child.close(0);
    const error = await advancing;
    const files = readdirSync(h.directory);
    const exitFile = files.find((name) => name.endsWith("-command-exited.json"));
    assert.ok(exitFile, "supervisor outcome must be journaled before halt, while attachment I/O is still held");
    const exited = JSON.parse(readFileSync(join(h.directory, exitFile)));
    assert.match(error?.message, /lifetime or cleanup unproven/);
    if (!held) assert.equal(exited.error, "native host observation setup failed");
    if (deadline) assert.equal(exited.error, "native host observation setup incomplete");
    assert.equal(exited.cancelled, true); assert.equal(exited.success, false);
    assert.equal(exited.hostManifestSha256, undefined);
    const halted = readFileSync(join(h.directory, files.find((name) => name.endsWith("-halted.json"))), "utf8");
    const halt = JSON.parse(halted);
    assert.ok(exited.sequence < halt.sequence, "the observed command exit precedes the halt");
    const code = deadline && !earlyCancel && !earlyExit ? "ETIMEDOUT" : kind.includes("fault") ? "EIO" : undefined;
    assert.deepEqual(halt.hostStorageFailure,
      code ? { operation: attaching ? "process-record-sync" : "sample-open", code } : undefined);
    if (attaching) {
      assert.ok(f.live.size > 0, "the writer still owns the held fsync");
      assert.equal(f.removed, false);
    }
    assert.equal(openFaults, code === "EIO" || lateFault ? 1 : 0);
    assert.equal(cleanupFaults, kind === "fault then cleanup failure" ? 1 : 0);
    if (cleanupFaults) assert.equal(f.removed, false);
    assert.ok(!/PRIVATE_(?:STORAGE|CLEANUP)_DETAIL/.test(halted));
    assert.equal(existsSync(join(host, "terminal.json")), false);
    assert.equal(existsSync(join(root, ".host-attempt.json")), true);
    assert.equal(s.campaign.status(h).uncollectedNativeRoots.length, 1);
    await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, 1);
  } finally {
    pause?.release();
    if (!settled) run.child?.close(0);
    await advancing; await run.setup?.catch(() => {});
    lifetimeRun = null;
  }
});

test("actual campaign compiler cleanup preserves its wrapped writer fault", { timeout: 15000 }, async (t) => {
  t.mock.method(fs, "fsyncSync", () => {}); syncBuiltinESMExports();
  const s = setupGroup("client-heavy"); s.plan.round = "r21";
  s.plan.bindings[0].preparation.fixtures = [];
  const h = await begin(s);
  t.mock.method(globalThis, "setInterval", () => null);
  const windows = process.platform === "win32";
  const f = await samplingControl(t);
  f.before = (step) => step === "sync" ? null : undefined;
  await f.finish(); f.removed = false;
  const target = `${join(repo, s.plan.bindings[0].validation.artifactRoot)}.compiler`;
  if (windows) {
    const exec = childProcess.execFileSync;
    t.mock.method(childProcess, "execFileSync", (file, args, ...rest) => {
      if (file !== "/bin/mv") return exec(file, args, ...rest);
      assert.equal(args[0], "-n"); assert.equal(args[2], fs.realpathSync(dirname(target)));
      renameSync(args[1], target);
    });
  }
  let cleanupFaults = 0;
  const rmdir = fs.rmdirSync;
  t.mock.method(fs, "rmdirSync", (path, ...args) => {
    if (String(path).startsWith(join(fs.realpathSync(dirname(target)), ".compiler-owner-"))) {
      cleanupFaults++; throw new Error("PRIVATE_COMPILER_CLEANUP");
    }
    return rmdir(path, ...args);
  });
  syncBuiltinESMExports();
  const host = join(h.directory, "00-client-heavy-timing/command-0-host");
  f.before = (step, path) => { if (step === "sync" && path === join(host, "samples.jsonl")) throw ioError(); };
  const run = lifetimeRun = { started: false, cancels: 0, start() { f.members = []; run.child.close(0); } };
  try {
    await assert.rejects(s.campaign.advance(h), (error) => /compiler target cleanup failed/.test(error.message) && error.cause?.code === "EIO");
    const halted = readdirSync(h.directory).find((name) => name.endsWith("-halted.json"));
    const saved = readFileSync(join(h.directory, halted), "utf8");
    assert.deepEqual(JSON.parse(saved).hostStorageFailure, { operation: "sample-sync", code: "EIO" });
    assert.ok(!/PRIVATE_(?:COMPILER|STORAGE)/.test(saved));
    assert.equal(run.started, true); assert.equal(cleanupFaults, 1);
    assert.equal(existsSync(target), true); assert.equal(existsSync(join(host, "terminal.json")), false);
    assert.equal(s.campaign.status(h).state, "preserved-uncertain");
  } finally { lifetimeRun = null; }
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
    const halted = readdirSync(h.directory).find((name) => name.endsWith("-halted.json"));
    const saved = readFileSync(join(h.directory, halted), "utf8");
    assert.equal(JSON.parse(saved).hostStorageFailure, undefined);
    assert.ok(!saved.includes("PRIVATE_SETUP_FAILURE"));
    const status = s.campaign.status(h);
    assert.equal(status.state, "preserved-uncertain"); assert.equal(status.uncollectedNativeRoots.length, 1);
    assert.equal(calls.length, 1);
    await assert.rejects(s.campaign.advance(h), /not eligible/); assert.equal(calls.length, 1);
  } finally { release(); await rejected; }
});

for (const crossed of [false, true]) test(`command-started journal ${crossed ? "crosses" : "stays within"} the observation startup cutoff`, async (t) => {
  const s = setupGroup("catalog-page"); s.plan.bindings[0].preparation.fixtures = [];
  const h = await begin(s);
  let now = 100, journalFd, journalSyncs = 0, setups = 0;
  const open = fs.openSync, sync = fs.fsyncSync;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(fs, "openSync", (path, ...args) => {
    const fd = open(path, ...args);
    if (args[0] === "wx" && typeof path === "string" && path.endsWith("-command-started.json")) journalFd = fd;
    return fd;
  });
  t.mock.method(fs, "fsyncSync", (fd) => {
    sync(fd);
    if (fd === journalFd) {
      journalFd = undefined; journalSyncs++;
      now += limits.readyMs + (crossed ? 1 : -1);
    }
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const owner = lifetimeStartup = { enter() { setups++; }, gate: Promise.resolve(), attached: 0, disposed: 0 };
  if (crossed) await assert.rejects(s.campaign.advance(h), /lifetime or cleanup unproven/);
  else assert.equal((await s.campaign.advance(h)).state, "finished");

  const files = readdirSync(h.directory);
  const receipt = (kind) => JSON.parse(readFileSync(join(h.directory, files.find((name) => name.endsWith(`-${kind}.json`))), "utf8"));
  const started = receipt("command-started"), exited = receipt("command-exited");
  assert.equal(journalSyncs, 1);
  assert.equal(started.kind, "command-started");
  assert.ok(started.sequence < exited.sequence);
  assert.equal(exited.success, !crossed);
  assert.equal(exited.cancelled, crossed);
  assert.equal(exited.error, crossed ? "native host observation setup incomplete" : null);
  assert.equal(setups, crossed ? 0 : 1);
  assert.equal(owner.attached, crossed ? 0 : 1);
  const host = join(h.directory, "00-catalog-page-timing", "command-0-host");
  assert.equal(existsSync(host), !crossed);
  assert.equal(existsSync(join(host, "terminal.json")), !crossed);
});

for (const boundary of ["before attach", "after attach", "after attachment check"]) {
  test(`campaign startup cutoff without dispatching timers: ${boundary}`, { timeout: 10000 }, async (t) => {
    const s = setupGroup("client-heavy"), h = await begin(s);
    let elapsed = 100, readsUntilCutoff = Infinity, enter, release, onCancel;
    t.mock.method(performance, "now", () => elapsed + (readsUntilCutoff-- <= 0 ? 30000 : 0));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = new Promise((resolve) => { enter = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const cancelled = new Promise((resolve) => { onCancel = resolve; });
    const expire = () => { elapsed += 30000; };
    const owner = lifetimeStartup = { enter, gate, onCancel, attached: 0, disposed: 0, onAttach() {
      if (boundary === "after attach") expire();
      if (boundary === "after attachment check") readsUntilCutoff = 1;
    } };
    let returned = false;
    const advancing = s.campaign.advance(h).then(() => null, (error) => error).finally(() => { returned = true; });
    let closed = false;
    function close() { if (!closed && owner.child) { closed = true; owner.child.close(0); } }
    try {
      await entered;
      if (boundary === "before attach") expire();
      release();
      await cancelled;
      assert.equal(returned, false, "the child has not drained");
      assert.equal(owner.disposed, 1, "rejection disposes before child shutdown");
      assert.equal(existsSync(join(owner.directory, "terminal.json")), false);
      close();
      assert.match((await advancing)?.message ?? "", /lifetime or cleanup unproven/);
      assert.equal(owner.attached, boundary === "before attach" ? 0 : 1);
      assert.equal(owner.disposed, 1);
      assert.equal(existsSync(join(owner.directory, "terminal.json")), false);
      const exit = readdirSync(h.directory).find((name) => name.endsWith("-command-exited.json"));
      const result = JSON.parse(readFileSync(join(h.directory, exit), "utf8"));
      assert.equal(result.error, "native host observation setup incomplete");
      assert.equal(result.success, false);
      assert.equal(result.hostManifestSha256, undefined);
      const state = s.campaign.status(h);
      assert.equal(state.state, "preserved-uncertain");
      assert.equal(state.uncollectedNativeRoots.length, 1);
      assert.equal(calls.length, 1);
    } finally { release(); close(); await advancing; }
  });
}

for (const cancelled of [false, true]) test(`campaign admitted startup seals ${cancelled ? "drained cancellation" : "healthy exit"}`, async () => {
  const s = setupGroup("catalog-page"); s.plan.bindings[0].preparation.fixtures = [];
  const h = await begin(s);
  abort = new AbortController();
  if (cancelled) mode = "abort-native";
  const owner = lifetimeStartup = { enter() {}, gate: Promise.resolve(), attached: 0, disposed: 0, onCancel() {} };
  const status = await s.campaign.advance(h, { signal: abort.signal });
  assert.equal(owner.attached, 1);
  assert.equal(owner.disposed, 0, "an accepted attachment is not disposed during runtime cancellation or exit");
  const seal = JSON.parse(readFileSync(join(owner.directory, "terminal.json"), "utf8"));
  assert.equal(seal.unforced, !cancelled);
  const exit = readdirSync(h.directory).find((name) => name.endsWith("-command-exited.json"));
  const result = JSON.parse(readFileSync(join(h.directory, exit), "utf8"));
  assert.equal(result.success, !cancelled);
  assert.equal(result.cancelled, cancelled);
  assert.match(result.hostManifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(status.state, cancelled ? "preserved-uncertain" : "finished");
  assert.equal(status.uncollectedNativeRoots.length, 0);
  assert.equal(calls.length, 1);
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

for (const [label, status, collision] of [["collision exit 0", 0, true], ["collision exit 1", 1, true],
  ["move failure without collision", 1, false], ["launch failure with existing target", null, true]]) {
  test(`client-heavy compiler target: mv -n ${label}`, { skip: process.platform === "win32" }, (t) => {
    const root = mkdtempSync(join(temporary, "mv-status-")), target = join(root, "build.compiler");
    const failure = Object.assign(new Error("move failed"), { status, signal: null, ...(status === null ? { code: "EACCES" } : {}) });
    let foreign;
    const hook = t.mock.method(childProcess, "execFileSync", (file, [option, staged, parent]) => {
      assert.equal(file, "/bin/mv"); assert.equal(option, "-n"); assert.equal(parent, root); assert.ok(existsSync(staged));
      if (collision) {
        mkdirSync(target); writeFileSync(join(target, "keep"), "foreign");
        foreign = fs.lstatSync(target, { bigint: true }).ino;
      }
      if (status !== 0) throw failure;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => reserveCompilerTarget(target), collision && status !== null
        ? { message: "compiler target already exists" } : (error) => error === failure);
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(fs.readdirSync(root), collision ? ["build.compiler"] : []);
    if (collision) {
      assert.equal(fs.lstatSync(target, { bigint: true }).ino, foreign);
      assert.equal(readFileSync(join(target, "keep"), "utf8"), "foreign");
    }
  });
}

test("client-heavy compiler target: public replacement before pin is never adopted or removed", async (t) => {
  const root = mkdtempSync(join(temporary, "pre-pin-")), target = join(root, "build.compiler");
  const open = fs.openSync;
  let foreign;
  const hook = t.mock.method(fs, "openSync", (path, ...args) => {
    if (foreign === undefined) {
      if (existsSync(target)) renameSync(target, join(root, "displaced"));
      mkdirSync(target); // Even an empty foreign directory must survive.
      foreign = fs.lstatSync(target, { bigint: true }).ino;
    }
    return open(path, ...args);
  });
  syncBuiltinESMExports();
  let reservation;
  try {
    assert.throws(() => { reservation = reserveCompilerTarget(target); }, /already exists|EEXIST/);
  } finally {
    hook.mock.restore(); syncBuiltinESMExports(); await reservation?.close(true);
  }
  assert.equal(fs.lstatSync(target, { bigint: true }).ino, foreign);
  assert.deepEqual(fs.readdirSync(root), ["build.compiler"]);
});

for (const scenario of ["success", "native failure", "incomplete proof", "not drained", "substituted", "raced", "preexisting"]) test(`client-heavy compiler target: ${scenario}`, async (t) => {
  const s = setupGroup("client-heavy"), h = await begin(s);
  const target = `${join(repo, s.plan.bindings[0].validation.artifactRoot)}.compiler`;
  compilerScratch = { target, scenario };
  if (scenario === "native failure") mode = "process-fails";
  if (scenario === "incomplete proof") lifetimeFailure = { command: 1, checks: { observer: false } };
  if (scenario === "not drained") lifetimeFailure = { command: 1, checks: { empty: false } };
  if (scenario === "preexisting") { mkdirSync(target, { recursive: true }); writeFileSync(join(target, "scratch"), "foreign"); }
  let moved;
  if (scenario === "raced") {
    const rename = fs.renameSync;
    const hook = t.mock.method(fs, "renameSync", (from, to) => {
      if (from === target) {
        rename(target, `${target}.original`); mkdirSync(target);
        writeFileSync(join(target, "scratch"), "foreign"); moved = to;
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => { hook.mock.restore(); syncBuiltinESMExports(); });
  }
  if (scenario === "success" || scenario === "native failure") {
    const status = await s.campaign.advance(h);
    assert.equal(status.state, "finished");
    const paths = evidence.tree(h.directory).entries.map(({ path }) => path);
    assert.ok(paths.includes("00-client-heavy-timing/native/raw.log"));
    assert.ok(!paths.some((path) => path.includes("scratch") || path.includes(".compiler")));
  } else {
    await assert.rejects(s.campaign.advance(h), scenario === "preexisting" ? /compiler target already exists/ : ["substituted", "raced"].includes(scenario)
      ? /compiler target replaced/ : /command lifetime or cleanup unproven/);
    assert.equal(s.campaign.status(h).state, "preserved-uncertain");
  }
  if (["not drained", "substituted", "preexisting"].includes(scenario)) {
    assert.equal(readFileSync(join(target, "scratch"), "utf8"), scenario === "preexisting" ? "foreign" : "not native output");
    if (scenario === "substituted") assert.ok(existsSync(`${target}.original`));
  } else assert.equal(existsSync(target), false);
  if (scenario === "raced") {
    assert.equal(readFileSync(join(moved, "scratch"), "utf8"), "foreign");
    assert.equal(readFileSync(join(`${target}.original`, "scratch"), "utf8"), "not native output");
  }
});

for (const failure of ["moved bytes", "seal open", "seal file sync", "seal directory sync"]) test(`live transfer keeps both pending paths after I/O failure: ${failure}`,
  { skip: failure === "seal directory sync" && process.platform === "win32" }, async (t) => {
  const group = "recoverable-live", s = setupLiveOutput(group, 0), h = await begin(s);
  const transferDestination = `00-${group}-timing/native`, native = join(h.directory, transferDestination);
  const expected = [{ group, phase: "timing", artifactRoot: s.plan.bindings[0].validation.artifactRoot, transferDestination }];
  const open = fs.openSync, fsync = fs.fsyncSync;
  let faulted = false;
  let sealPath, targetFd;
  const fail = () => {
    faulted = true;
    assert.equal(existsSync(s.original), false);
    assert.equal(existsSync(join(native, "coverage.json")), true);
    throw Object.assign(new Error("injected transfer EIO"), { code: "EIO" });
  };
  const injectedOpen = t.mock.method(fs, "openSync", (path, ...args) => {
    if (!faulted && failure === "moved bytes" && path === join(native, "coverage.json")) fail();
    const seal = /-phase-sealed\.json(?:\.pending)?$/.test(path);
    if (seal && !faulted) {
      sealPath = path;
      if (failure === "seal open") fail();
    }
    const fd = open(path, ...args);
    if ((failure === "seal file sync" && seal)
      || (failure === "seal directory sync" && path === h.directory && sealPath && existsSync(sealPath.replace(/\.pending$/, ""))))
      targetFd = fd;
    return fd;
  });
  const injectedSync = t.mock.method(fs, "fsyncSync", (fd) => {
    if (!faulted && fd === targetFd) {
      const writtenSeal = failure === "seal file sync" ? sealPath : sealPath.replace(/\.pending$/, "");
      assert.equal(JSON.parse(readFileSync(writtenSeal)).kind, "phase-sealed");
      fail();
    }
    return fsync(fd);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(s.campaign.advance(h), { code: "EIO", message: "injected transfer EIO" }); }
  finally { injectedOpen.mock.restore(); injectedSync.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(faulted, true);
  assert.deepEqual(evidence.tree(native), liveOutput.generatedTree);
  const journal = (kind) => join(h.directory, fs.readdirSync(h.directory).find((name) => name.endsWith(`-${kind}.json`)));
  const reservation = JSON.parse(readFileSync(journal("native-output-reserved")));
  assert.deepEqual(reservation.status.uncollectedNativeRoots, expected);
  assert.equal(reservation.transferDestination, transferDestination);
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
  assert.ok(!fs.readdirSync(h.directory).some((name) => name.endsWith("-phase-sealed.json")));

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
    if (["live-delivery", "recoverable-live"].includes(seal.group)) {
      const prefix = replaySealedPhase(handle.directory, s.plan, handle.id, seal.group, path);
      assert.equal(prefix.version, 3);
      assert.equal(prefix.phase.phaseManifestSha256, evidence.phaseSnapshot(join(handle.directory, path)).sha256);
      assert.deepEqual(prefix.phase.binding, s.plan.bindings[index]);
    }
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
  ["localized-marketplace", "settles"], ["localized-marketplace", "aborts"], ["localized-marketplace", "native failure"],
  ["json-api", "settles"], ["json-api", "aborts"], ["json-api", "worker survives"],
  ["live-delivery", "settles"], ["live-delivery", "worker survives"], ["live-delivery", "worker born during timing"],
]) test(`v5 ${group} udev settlement: ${scenario}`, async (t) => {
  const proof = syntheticBootstrap(t), s = setupGroup(group); controlledRound(s.plan); admittedHost = proof.admission.host;
  const jsonPreparation = group === "json-api";
  const live = group === "live-delivery";
  const bornDuringTiming = scenario === "worker born during timing";
  settleWorkerTicks = jsonPreparation || bornDuringTiming ? "10400" : "10601";
  settleSecondWorker = live;
  settleSurvives = scenario === "worker survives";
  settleNativeFails = scenario === "native failure";
  mode = "udev-settle";
  const binding = s.plan.bindings[0];
  const cpus = live ? liveActorCpus : { app: "1", api: "2-3", load: "4-7" };
  if (live) {
    Object.assign(binding.resources, { actorCpus: liveActorCpus, app: liveApplication });
    binding.execution.effectiveOptions = { isolated: true };
  } else binding.resources.expectedCpus = Object.fromEntries(Object.entries(cpus).map(([role, cpuset]) => [role, { cpuset }]));
  const calls = [], control = monitoredSettlementControl(proof, cpus, calls);
  const handle = await s.campaign.begin(s.plan, { stateRoot: "/bench/campaign", control });
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
  const request = { folder: root, round: "r21", commit: s.plan.commit };
  if (bornDuringTiming) {
    assert.equal(observations, 3, "one in-window worker disqualifies the entire cohort before any second census");
    assert.deepEqual(first, { ...udevHost(3), terminalClock: udevClock() });
    assert.equal(existsSync(join(phase, "host-after-settled.json")), false);
    assert.match(advanced.message, /new persistent host processes remain: 2/);
    assert.equal(s.campaign.status(handle).state, "preserved-uncertain");
    assert.ok((await validateSavedCampaign(request)).blockers.includes("live-delivery/timing: host boundary uncertain"));
    return;
  }
  const status = advanced;
  assert.equal(observations, 4);
  assert.deepEqual(first, { ...udevHost(3), terminalClock: udevClock() });
  assert.deepEqual(JSON.parse(readFileSync(join(phase, "command-1-host", "terminal.json"))).terminalClock, first.terminalClock);
  assert.deepEqual(JSON.parse(readFileSync(join(phase, "host-after-settled.json"))), udevHost(4));
  if (settleSurvives) {
    assert.match(advanced.message, new RegExp(`new persistent host processes remain: ${udevWorkers().length}`));
    assert.equal(s.campaign.status(handle).state, "preserved-uncertain");
    assert.equal(existsSync(join(handle.directory, "json-audit-subject.json")), false);
    assert.ok((await validateSavedCampaign(request)).blockers.includes(`${group}/${jsonPreparation ? "prepare" : "timing"}: host boundary uncertain`));
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
  if (live) {
    const prefix = replaySealedPhase(handle.directory, s.plan, handle.id, group, controlWindows.phase);
    assert.equal(prefix.version, 5);
    assert.equal(prefix.phase.phaseManifestSha256, evidence.phaseSnapshot(phase).sha256);
    assert.equal(prefix.phase.results.at(-1).hostManifestSha256, evidence.tree(join(phase, "command-1-host")).sha256);
  }
  if (settleNativeFails) {
    assert.equal(status.outcomes[0].outcome, "failed");
    const events = fs.readdirSync(handle.directory).filter((name) => /^\d{5}-/.test(name)).sort()
      .map((name) => JSON.parse(readFileSync(join(handle.directory, name))).kind);
    assert.deepEqual(events.slice(-3), ["group-finished", "stream-sealed", "finished"]);
    assert.ok(!events.includes("review-needed") && existsSync(join(handle.directory, "control-stream-seal.json")));
  }
  assert.deepEqual(status.outcomes[0].cleanup.settledUdevWorkers, udevWorkers());
  writeSettlementDrain(handle);
  writeFileSync(join(handle.directory, "collection-manifest.json"), JSON.stringify(s.campaign.collect(handle)));
  const inspected = await validateSavedCampaign(request);
  assert.notEqual(inspected.status, "invalid");
  assert.ok(!inspected.blockers.includes(`${group}/timing: host boundary uncertain`));
  if (settleNativeFails) {
    assert.equal(inspected.status, "failed");
    assert.equal(inspected.collectionIntegrity, "manifest-verified");
    assert.equal(inspected.commandLifecycle, "observed-terminal");
    assert.deepEqual(inspected.uncollectedNativeRoots, []);
  }
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
  if (live) {
    fs.unlinkSync(receipt);
    resealPhase();
    assert.equal((await validateSavedCampaign(request)).status, "invalid", "a live cohort without a settled census cannot qualify");
  }
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
