import assert from "node:assert/strict";
import { beginControlWindow, beginOfflineWindow, verifyControlAdmission } from "./control-admission.mjs";
import { isDeepStrictEqual } from "node:util";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { validateCampaign, freeze, jsonPhase, mixedPhase, offlineAuditRemainingMs, verifyOfflineAuditStart } from "./campaign-contract.mjs";
import { verifyWorkingSources } from "./worker.mjs";
import { copyEvidence, digest, durable, inside, phaseSnapshot, physical, publishDurable, readRegular, syncDirectory, transferEvidence, tree } from "./evidence.mjs";
import { startupOutcome, supervise } from "./process.mjs";
import { observeHost, sampleAuditClock, terminalClockPolicy, udevSettleCandidates, udevSettleMs, verifyHostBoundary, verifySettledHostBoundary } from "./host-observation.mjs";
import { auditSubject, imageProof, inspectPreparation, snapshotSources, validateAuditDelivery, validateTimingAudit } from "./json-staging.mjs";
import { inspectNative } from "./native-replay.mjs";
import { beginLifetime, composeHostProof, inspectLifetime } from "./host-lifetime.mjs";
import { hostStorageFailure, trackHostStorageStartup } from "./host-durable-writer.mjs";
import { composePhase } from "./composition.mjs";
import { prepareMixedAudit, replayMixedSubject, validateMixedDelivery, validateMixedRun } from "./mixed-staging.mjs";
import { nativeControlPartition, verifyStreamAudit } from "./control-stream.mjs";
import { liveGroup } from "./native-roles.mjs";
import { reserveCompilerTarget } from "../../client-heavy/compiler.mjs";
import { matrix as hardeningMatrix } from "../../hardening/plan.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function watchHardeningCells(publish) {
  const markers = hardeningMatrix().map(({ key }) => "hardening " + key);
  const line = Buffer.alloc(Math.max(...markers.map((marker) => marker.length)) + 1); // allow CRLF
  let length = 0, started = 0;
  return (bytes) => {
    for (let offset = 0; offset < bytes.length && started < markers.length;) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
      if (length >= 0) {
        if (length + end - offset > line.length) length = -1;
        else { bytes.copy(line, length, offset, end); length += end - offset; }
      }
      if (newline < 0) return;
      if (length >= 0 && line.toString("latin1", 0, length - (line[length - 1] === 13 ? 1 : 0)) === markers[started]) {
        publish({ started: ++started, total: markers.length });
      }
      length = 0; offset = end + 1;
    }
  };
}

function fresh(path) {
  assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, "native output already exists");
  let parent = dirname(path); while (!lstatSync(parent, { throwIfNoEntry: false })) parent = dirname(parent);
  physical(parent);
}

/** Live-process authority only. No provider, deletion, arbitrary validator or restart API. */
export function createCampaign({ authorize }) {
  assert.equal(typeof authorize, "function", "explicit parent authorization policy required");
  const owned = new WeakMap();
  function own(handle) {
    const c = owned.get(handle); assert.ok(c, "campaign is not owned by this live job");
    physical(c.root); physical(c.directory);
    assert.equal(digest(readRegular(join(c.root, ".host-attempt.json"))), c.lockHash, "campaign reservation changed");
    const stat = lstatSync(c.directory); assert.equal(stat.ino, c.inode); assert.equal(stat.dev, c.device);
    for (const file of c.files) assert.equal(digest(readRegular(join(c.directory, file.path))), file.sha256, "campaign record/log mutated");
    return c;
  }
  function save(c, path, value, write = durable) {
    own(c.handle); const bytes = json(value); write(join(c.directory, path), bytes);
    c.files.push({ path, sha256: digest(bytes) });
  }
  function event(c, kind, data = {}) {
    const value = { schema: "benchmark-isolated-campaign-event/v1", sequence: c.sequence, campaign: c.handle.id,
      round: c.plan.round, campaignSha256: c.plan.campaignSha256, at: new Date().toISOString(), kind, ...data, status: status(c) };
    save(c, `${String(value.sequence).padStart(5, "0")}-${kind}.json`, value,
      kind === "phase-sealed" && data.transferDestination ? publishDurable : durable);
    c.sequence++;
    return value;
  }
  function waitForAudit(c, kind, data, preparation) {
    const auditClock = c.offlineHandoff ? sampleAuditClock() : undefined;
    if (c.offlineHandoff) {
      assert.equal(!!preparation, kind === "review-needed", "offline audit preparation boundary missing or unexpected");
      verifyOfflineAuditStart(auditClock, c.offlineBootstrap, preparation);
    }
    c.state = "blocked-review-needed";
    c.reviewWait = event(c, kind, { ...data, ...(auditClock ? { auditClock } : {}) });
  }
  function remainingAuditMs(c, now) {
    assert.ok(c?.offlineHandoff && !c.busy && c.state === "blocked-review-needed" && c.reviewWait);
    return offlineAuditRemainingMs(c.reviewWait.auditClock, now, c.offlineBootstrap.host.bootId);
  }
  function verifyPhases(c) {
    own(c.handle);
    for (const p of c.phases) {
      assert.ok(isDeepStrictEqual(tree(p.native), p.manifest), "sealed native evidence mutated");
      if (p.retainsOriginal) assert.ok(isDeepStrictEqual(tree(p.original), p.manifest), "original native evidence mutated");
      else assert.equal(lstatSync(p.original, { throwIfNoEntry: false }), undefined, "native output appeared after collection or failure");
    }
    if (c.audit) assert.ok(isDeepStrictEqual(tree(c.audit.sourceRoot), c.audit.subject.sourcesManifest.snapshot), "sealed source snapshot mutated");
    if (c.mixedAudit) assert.ok(isDeepStrictEqual(tree(c.mixedAudit.sourceRoot), c.mixedAudit.subject.sourcesManifest.snapshot), "sealed mixed source/context snapshot mutated");
  }
  function status(c) {
    own(c.handle);
    return freeze({ schema: "benchmark-isolated-campaign-status/v1", campaign: c.handle.id, round: c.plan.round,
      campaignSha256: c.plan.campaignSha256, state: c.state, nextGroup: c.plan.order[c.index] ?? null,
      executionVersion: c.offlineHandoff ? 6 : c.stream ? 5 : c.control ? 4 : 3,
      outcomes: structuredClone(c.outcomes), auditSubjectSha256: c.audit?.subject.subjectSha256 ?? null,
      uncollectedNativeRoots: structuredClone(c.pendingNative),
      mixedAuditSubjectSha256: c.mixedAudit?.subject.subjectSha256 ?? null,
      auditGroup: c.state === "blocked-review-needed" ? c.plan.order[c.index] : null,
      auditInbox: c.state === "blocked-review-needed" ? `${c.handle.id}/${c.plan.order[c.index] === "mixed-production" ? "mixed" : "json"}-audit-delivery.json` : null,
      controllerReady: false, isolation: "unverified", executionAuthorized: "separate-parent-policy",
      reservation: "retained-no-release-or-restart" });
  }
  function halt(c, error, expiry) {
    c.state = "preserved-uncertain";
    for (const binding of c.plan.bindings.slice(c.index)) {
      if (!c.outcomes.some((r) => r.group === binding.request.group)) c.outcomes.push({ group: binding.request.group,
        outcome: c.attempted.has(binding.request.group) ? "preserved-uncertain" : "not-run", coverage: binding.coverage,
        blockers: ["campaign halted; no retry or assumed cleanup", error.message] });
    }
    if (expiry) event(c, "offline-audit-expired", expiry);
    else {
      const storage = c.startupStorageFailure ?? hostStorageFailure(error)
        ?? hostStorageFailure(Object.getOwnPropertyDescriptor(error, "cause")?.value);
      event(c, "halted", { error: error.message, ...(storage ? { hostStorageFailure: storage } : {}) });
    }
    save(c, "campaign-result.json", { status: status(c), wholeHostTerminal: "parent-must-observe", deletionAuthorized: false });
  }
  async function exclusive(handle, fn) {
    const c = own(handle); assert.equal(c.busy, false, "campaign operation already in progress"); c.busy = true;
    try { verifyPhases(c); return await fn(c); }
    catch (error) {
      if (!["finished", "preserved-uncertain"].includes(c.state)) halt(c, error);
      throw error;
    } finally { c.busy = false; }
  }
  async function command(c, binding, invocation, directory, phase, signal, retainTerminalClock, compilerTarget) {
    c.stream?.check();
    own(c.handle); verifyWorkingSources(c.plan.bindings[0]);
    const observerStop = new AbortController();
    const commandSignal = signal ? AbortSignal.any([signal, observerStop.signal]) : observerStop.signal;
    const number = c.commandIndex++, path = `${directory}/command-${number}.log`, fd = openSync(join(c.directory, path), "wx", 0o600);
    const hostDirectory = join(c.directory, directory, `command-${number}-host`);
    let startupDiagnostic = trackHostStorageStartup(hostDirectory);
    let result, observer, hostManifestSha256, pid, attachmentComplete = false;
    function disposeObserver() {
      const rejected = observer; observer = undefined;
      rejected?.dispose();
    }
    function captureStartupDiagnostic(timedOut) {
      const storage = startupDiagnostic?.(timedOut); startupDiagnostic = undefined;
      if (storage && startupOutcome(result) !== "accepted") c.startupStorageFailure = storage;
    }
    try {
      event(c, "command-intent", { group: binding.request.group, invocation });
      if (compilerTarget) compilerTarget.settled = false;
      let nativeProgress;
      if (c.stream && binding.request.group === "hardening" && invocation === binding.execution.invocation) {
        const active = status(c);
        nativeProgress = watchHardeningCells((nativeCellProgress) => c.stream.cellProgress({ ...active, nativeCellProgress }));
      }
      result = await supervise({ ...invocation, shell: false }, { cwd: repo,
        env: { PATH: "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: os.homedir(), LANG: "C.UTF-8", TZ: "UTC",
          GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", ...binding.resources.requestedCpuEnv, ...compilerTarget?.env }, signal: commandSignal,
        log(bytes, channel) {
          let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); assert.ok(n > 0); offset += n; }
          if (channel === "stdout" && !commandSignal.aborted) nativeProgress?.(bytes);
        },
        onStartupRejected(outcome) {
          try { disposeObserver(); }
          finally { if (outcome === "deadline") captureStartupDiagnostic(true); }
        },
        async onStart(value, startupSignal, checkStartup) {
          pid = value; event(c, "command-started", { pid });
          try {
            checkStartup();
            observer = await beginLifetime({ campaign: c.handle.id, binding, invocation,
              directory: hostDirectory, command: number, pid, signal: commandSignal, startupSignal,
              onFault() { observerStop.abort(); } });
            checkStartup();
            await observer.attach(pid);
            checkStartup();
            attachmentComplete = true;
          } catch (error) {
            disposeObserver(); throw error;
          }
        },
      });
    } finally {
      try { captureStartupDiagnostic(false); }
      finally { try { fsyncSync(fd); } finally { closeSync(fd); } }
    }
    c.files.push({ path, sha256: digest(readRegular(join(c.directory, path))) });
    const settled = compilerTarget ? () => { compilerTarget.settled = true; } : undefined;
    if (startupOutcome(result) === "accepted") {
      const manifest = await observer.finish(result, retainTerminalClock, settled); hostManifestSha256 = manifest.sha256;
      for (const file of manifest.entries.filter((e) => e.type === "file")) c.files.push({
        path: `${directory}/command-${number}-host/${file.path}`, sha256: file.sha256 });
    } else if (result.terminal && !attachmentComplete) settled?.(); // No completed attachment owns setup.
    event(c, "command-exited", { ...result, ...(hostManifestSha256 ? { hostManifestSha256 } : {}) });
    assert.equal(result.terminal, true, "native process is not observed terminal");
    const lifetime = hostManifestSha256 ? inspectLifetime(binding, invocation,
      join(c.directory, directory, `command-${number}-host`), { campaign: c.handle.id, command: number, pid, result, phase }) : null;
    if (lifetime) assert.equal(lifetime.manifestSha256, hostManifestSha256, "command lifetime seal differs");
    // A drained cancellation may be collected, never advanced or qualified. All
    // other commands require complete actual lifetime proof before another spawn.
    const drainedCancellation = (signal?.aborted || result.cancelled || result.forced) && lifetime
      && ["accounting", "terminal", "empty", "observer", "leader"].every((key) => lifetime.checks?.[key] === true);
    assert.ok((lifetime?.status === "verified" && lifetime.cleanupComplete === true) || drainedCancellation,
      "command lifetime or cleanup unproven; retain pending native root");
    return { ...result, number, pid, hostManifestSha256, terminalClock: lifetime?.terminalClock };
  }
  async function phase(c, binding, phaseName, signal) {
    verifyWorkingSources(c.plan.bindings[0]);
    const original = join(repo, ...binding.validation.artifactRoot.split("/")); fresh(original);
    const relative = `${String(c.index).padStart(2, "0")}-${binding.request.group}-${phaseName}`;
    const directory = join(c.directory, relative); mkdirSync(directory, { mode: 0o700 }); syncDirectory(c.directory);
    c.attempted.add(binding.request.group);
    const transfer = liveGroup(binding.request.group);
    const pending = { group: binding.request.group, phase: phaseName, artifactRoot: binding.validation.artifactRoot,
      ...(transfer ? { transferDestination: `${relative}/native` } : {}) };
    c.pendingNative.push(pending); event(c, "native-output-reserved", pending);
    if (c.stream || c.offlineHandoff) {
      const { cpus, roles } = nativeControlPartition(binding);
      c.stream?.open(cpus, roles);
    }
    const closeControlWindow = c.offlineHandoff ? beginOfflineWindow(c.control) : c.control ? beginControlWindow(c.control) : null;
    const settlePolicy = c.stream || c.offlineHandoff
      ? terminalClockPolicy(binding, binding.execution.invocation, c.plan.round, phaseName) : null;
    const retainUdev = settlePolicy !== null;
    const before = observeHost(c.stream?.registration, retainUdev, c.offlineHandoff); save(c, `${relative}/host-before.json`, before);
    if (c.stream || c.offlineHandoff) verifyHostBoundary(before, before);
    const commands = [];
    for (const invocation of [...binding.preparation.fixtures, binding.execution.invocation]) {
      if (signal?.aborted) throw new Error("campaign cancelled");
      const native = invocation === binding.execution.invocation;
      if (native) fresh(original);
      let compilerTarget, result, problem;
      if (native && binding.request.group === "client-heavy") {
        const target = `${original}.compiler`;
        mkdirSync(dirname(target), { recursive: true }); physical(dirname(target));
        compilerTarget = { ...reserveCompilerTarget(target), settled: true };
      }
      try { result = await command(c, binding, invocation, relative, phaseName, signal, retainUdev && native, compilerTarget); }
      catch (error) { problem = error; throw error; }
      finally {
        try { if (compilerTarget) await compilerTarget.close(compilerTarget.settled); }
        catch (error) {
          if (!problem) throw error;
          throw new Error(`${problem.message}; compiler target cleanup failed`, { cause: problem });
        }
      }
      commands.push(result);
      if (!result.success) break;
    }
    let after, settled, boundaryError;
    const terminalClock = commands.at(-1)?.terminalClock;
    try {
      if (!transfer) verifyWorkingSources(c.plan.bindings[0]);
      after = observeHost(c.stream?.registration, retainUdev, c.offlineHandoff);
      if (terminalClock) after.terminalClock = terminalClock;
      save(c, `${relative}/host-after.json`, after);
      if (retainUdev && terminalClock && !signal?.aborted && udevSettleCandidates(before, after, terminalClock, settlePolicy, c.offlineHandoff)) {
        await delay(udevSettleMs, undefined, { signal });
        c.stream?.check();
        signal?.throwIfAborted();
        settled = observeHost(c.stream?.registration, true, c.offlineHandoff);
        save(c, `${relative}/host-after-settled.json`, settled);
      }
    } catch (error) { boundaryError = error; }
    const native = join(directory, "native"), present = !!lstatSync(original, { throwIfNoEntry: false });
    let manifest;
    if (present) manifest = transfer ? transferEvidence(original, native) : copyEvidence(original, native);
    else { assert.ok(commands.some((r) => !r.success), "native output missing"); mkdirSync(native, { mode: 0o700 }); manifest = tree(native); }
    const p = { relative, native, original, manifest, retainsOriginal: present && !transfer, commands, cleanup: null };
    save(c, `${relative}/native-manifest.json`, manifest);
    if (c.offlineHandoff) {
      if (boundaryError) throw boundaryError;
      const { proof, ingress } = closeControlWindow();
      p.offlineIngress = ingress;
      save(c, `${relative}/control-ingress.json`, proof);
    }
    event(c, "phase-sealed", { ...pending, nativeManifestSha256: manifest.sha256,
      phaseManifestSha256: phaseSnapshot(directory, binding.request.group === "json-api" && phaseName === "prepare").sha256 });
    c.phases.push(p);
    c.pendingNative.splice(c.pendingNative.indexOf(pending), 1);
    if (boundaryError) throw boundaryError;
    // The live runners write Git-visible result trees. Recheck every source
    // only after the exact reserved tree is in external phase custody.
    if (transfer) verifyWorkingSources(c.plan.bindings[0]);
    if (!c.offlineHandoff) closeControlWindow?.();
    c.stream?.close();
    p.cleanup = settled ? verifySettledHostBoundary(before, after, settled, terminalClock, settlePolicy, c.offlineHandoff)
      : verifyHostBoundary(before, after);
    if (c.offlineHandoff && phaseName === "prepare") p.offlinePreparation = { before, after, settled, terminalClock };
    return p;
  }
  function cancelled(c, phase, signal) {
    if (!signal?.aborted && !phase.commands.some((r) => r.cancelled || r.forced)) return false;
    halt(c, new Error("campaign cancelled; no further advancement"));
    return true;
  }
  return Object.freeze({
    async begin(plan, { stateRoot, signal, control } = {}) {
      plan = freeze(structuredClone(plan)); validateCampaign(plan);
      assert.equal(os.platform(), "linux"); assert.ok(os.availableParallelism() >= 8);
      assert.ok(Number(process.versions.node.split(".")[0]) >= 24); assert.ok(!signal?.aborted);
      verifyWorkingSources(plan.bindings[0]);
      assert.equal(stateRoot, "/bench/campaign", "one fixed host reservation root required");
      const root = physical(stateRoot); assert.ok(!inside(repo, root) && !inside(root, repo));
      const stat = lstatSync(root);
      if (process.platform === "linux") { assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o077, 0); }
      const subject = freeze({ action: "begin-campaign", campaignSha256: plan.campaignSha256, commit: plan.commit,
        round: plan.round, stateRoot: root, host: os.hostname(), groups: plan.order });
      assert.equal(await authorize(subject), true, "parent did not authorize this exact campaign");
      assert.ok(!signal?.aborted); verifyWorkingSources(plan.bindings[0]);
      for (const b of plan.bindings) fresh(join(repo, ...b.validation.artifactRoot.split("/")));
      if (plan.order.includes("json-api")) fresh(join(repo, ...jsonPhase(plan, "prepare").validation.artifactRoot.split("/")));
      const id = `${plan.round}-${randomBytes(8).toString("hex")}`;
      const lock = json({ schema: "benchmark-isolated-campaign-reservation/v1", id, campaignSha256: plan.campaignSha256,
        commit: plan.commit, pid: process.pid, createdAt: new Date().toISOString() });
      durable(join(root, ".host-attempt.json"), lock);
      const directory = join(root, id); mkdirSync(directory, { mode: 0o700 }); syncDirectory(root);
      const info = lstatSync(directory), handle = Object.freeze({ id, directory });
      const c = { handle, root, directory, inode: info.ino, device: info.dev, lockHash: digest(lock), plan,
        control: control ? freeze(structuredClone(control.binding)) : null, controlEpochs: new Set(), stream: control?.stream ?? null,
        offlineHandoff: control?.offlineHandoff === true,
        files: [], sequence: 0, commandIndex: 0, busy: false, index: 0, phases: [], outcomes: [], attempted: new Set(), pendingNative: [], state: "active", audit: null, mixedAudit: null };
      owned.set(handle, c); save(c, "plan.json", plan); event(c, "authorized", { subject, trustBoundary: "explicit trusted parent policy, not review data" });
      try {
        if (control) {
          if (c.offlineHandoff) assert.ok(plan.order.length === 1 && !control.admission.apparatus && !c.stream,
            "offline handoff requires one group without a stream");
          assert.equal(control.binding.commit, plan.commit); assert.equal(control.binding.round, plan.round);
          verifyControlAdmission(control.binding, "bootstrap", control.admission);
          c.control = freeze(structuredClone(control.binding));
          save(c, "control-bootstrap.json", control.admission);
          event(c, "control-admitted", { epoch: "bootstrap", path: "control-bootstrap.json", sha256: digest(json(control.admission)), binding: c.control });
          c.controlEpochs.add("bootstrap");
        }
        if (control?.admission.apparatus) assert.ok(c.stream, "presealed apparatus requires independent lease enforcement");
        const observed = observeHost(c.stream?.registration); save(c, "host-initial.json", observed);
        if (control) for (const field of ["hostname", "bootId"]) assert.equal(observed[field], control.admission.host[field]);
        if (c.offlineHandoff) c.offlineBootstrap = control.admission;
        assert.deepEqual(observed.containers, [], "fresh campaign host has preexisting containers");
        event(c, "started"); return handle;
      } catch (error) { halt(c, error); throw error; }
    },
    recordControlAdmission(handle, admission) {
      const c = own(handle); assert.equal(c.busy, false); assert.ok(c.control);
      assert.equal(c.state, "blocked-review-needed");
      const group = c.plan.order[c.index], epoch = `audit-${group}`;
      verifyControlAdmission(c.control, epoch, admission);
      const path = `control-audit-${group}.json`;
      save(c, path, admission); event(c, "control-admitted", { epoch, path, sha256: digest(json(admission)), binding: c.control });
      c.controlEpochs.add(epoch);
    },
    recordStreamAudit(handle, proof) {
      const c = own(handle); assert.ok(c.stream && !c.busy && c.state === "blocked-review-needed"); c.stream.check();
      const group = c.plan.order[c.index], epoch = `audit-${group}`;
      const subject = group === "mixed-production" ? c.mixedAudit.subject.subjectSha256 : c.audit.subject.subjectSha256;
      verifyStreamAudit(c.control, c.stream.registration, proof, group, subject);
      const path = `control-${epoch}.json`; save(c, path, proof);
      event(c, "control-admitted", { epoch, path, channel: "stream", sha256: digest(json(proof)), binding: c.control }); c.controlEpochs.add(epoch);
    },
    async advance(handle, { signal } = {}) {
      return exclusive(handle, async (c) => {
        c.stream?.check();
        assert.equal(c.state, "active", "campaign is not eligible to advance");
        assert.ok(!signal?.aborted, "campaign cancelled");
        const binding = c.plan.bindings[c.index]; assert.ok(binding, "campaign already exhausted");
        const group = binding.request.group;
        if (group === "mixed-production" && !c.mixedAudit) {
          const sourceRoot = join(c.directory, "mixed-audit-sources"), subject = await prepareMixedAudit(c.plan, repo, sourceRoot);
          verifyWorkingSources(c.plan.bindings[0]);
          c.mixedAudit = { sourceRoot, subject, accepted: false }; save(c, "mixed-audit-subject.json", subject);
          waitForAudit(c, "mixed-review-needed", { subjectSha256: subject.subjectSha256 });
          return status(c);
        }
        if (group === "json-api" && !c.audit) {
          const prepBinding = jsonPhase(c.plan, "prepare"); const p = await phase(c, prepBinding, "prepare", signal);
          if (cancelled(c, p, signal)) return status(c);
          let prepared;
          try {
            assert.ok(p.commands.slice(0, -1).every((r) => r.success));
            const last = p.commands.at(-1); assert.equal(p.commands.length, prepBinding.preparation.fixtures.length + 1);
            assert.equal(last.code, 1); assert.equal(last.error, null); assert.equal(last.cancelled, false); assert.equal(last.forced, false);
            prepared = inspectPreparation(prepBinding, p.native);
          } catch (error) {
            c.outcomes.push({ group, outcome: "failed", phase: "prepare", error: error.message, manifest: p.manifest.sha256 });
          }
          if (prepared) {
            const images = imageProof(prepared.summary); save(c, `${p.relative}/images.json`, images);
            const sourceRoot = join(c.directory, "audit-sources");
            const sources = snapshotSources(c.plan.bindings[0], repo, sourceRoot);
            const subject = auditSubject(c.plan, prepared, p.manifest, sources, images);
            c.audit = { subject, sourceRoot, prepared, accepted: false, phase: p };
            save(c, "json-audit-subject.json", subject);
            waitForAudit(c, "review-needed", { subjectSha256: subject.subjectSha256, nativeExit: 1, qualification: "blocked", cleanup: p.cleanup },
              p.offlinePreparation);
            return status(c);
          }
        } else {
          const effective = group === "json-api" ? jsonPhase(c.plan, "timing", join(c.directory, "json-native-audits.json"))
            : group === "mixed-production" ? mixedPhase(c.plan, c.handle.id) : binding;
          if (group === "mixed-production") assert.equal(c.mixedAudit.accepted, true);
          if (group === "json-api") {
            assert.equal(c.audit.accepted, true);
            assert.deepEqual(imageProof(c.audit.prepared.summary), c.audit.subject.images, "audited built images changed");
          }
          const p = await phase(c, effective, "timing", signal);
          if (cancelled(c, p, signal)) return status(c);
          if (group === "json-api") assert.deepEqual(imageProof(c.audit.prepared.summary), c.audit.subject.images, "audited images changed during timing");
          let timingAudit;
          if (group === "mixed-production") timingAudit = { complete: validateMixedRun(effective, p.native, c.mixedAudit.subject, c.mixedAudit.bundle) };
          if (group === "json-api") {
            try { timingAudit = validateTimingAudit(effective, p.native, c.audit.subject, c.audit.bundle, c.audit.sourceRoot); }
            catch { throw new Error("timing-audit-does-not-match-accepted-subject"); }
          }
          const native = await inspectNative(effective, p.native);
          const last = p.commands.at(-1), { number, pid, hostManifestSha256, terminalClock: _clock, ...result } = last;
          let host = { resources: "blocked", cleanupComplete: false };
          if (hostManifestSha256) {
            const invocation = [...effective.preparation.fixtures, effective.execution.invocation][p.commands.length - 1];
            const observation = inspectLifetime(effective, invocation,
              join(c.directory, p.relative, `command-${number}-host`), { campaign: c.handle.id, command: number, pid, result, phase: "timing" });
            assert.equal(observation.manifestSha256, hostManifestSha256);
            host = composeHostProof(effective, native, observation);
          }
          const auditedTiming = !["json-api", "mixed-production"].includes(group) || timingAudit.complete;
          c.outcomes.push({ group, ...composePhase(effective, native, host, p.commands, auditedTiming, p.offlineIngress?.packets), host,
            nativeManifestSha256: p.manifest.sha256, cleanup: p.cleanup, isolation: "external-exclusive-host-policy" });
        }
        c.index++; event(c, "group-finished", c.outcomes.at(-1));
        if (c.index === c.plan.order.length) {
          if (c.stream) {
            const proof = await c.stream.seal(); save(c, "control-stream-seal.json", proof);
            event(c, "stream-sealed", { path: "control-stream-seal.json", sha256: digest(json(proof)), binding: c.control });
          }
          c.state = "finished"; event(c, "finished", { controllerReady: false });
          save(c, "campaign-result.json", { status: status(c), wholeHostTerminal: "parent-must-observe", deletionAuthorized: false });
        }
        verifyPhases(c); return status(c);
      });
    },
    async submitJsonAudit(handle, delivery) {
      return exclusive(handle, async (c) => {
        if (c.control) assert.ok(c.controlEpochs.has("audit-json-api"), "live audit control admission missing");
        assert.equal(c.state, "blocked-review-needed"); assert.ok(c.audit && !c.audit.accepted);
        assert.ok(Buffer.byteLength(JSON.stringify(delivery)) <= 16 * 1024 * 1024, "audit delivery too large");
        delivery = freeze(structuredClone(delivery)); save(c, "json-audit-delivery-retained.json", delivery);
        const inbox = join(c.directory, "json-audit-delivery.json");
        if (lstatSync(inbox, { throwIfNoEntry: false })) {
          const stat = lstatSync(inbox);
          if (process.platform === "linux") { assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o077, 0); }
          const bytes = readRegular(inbox); assert.ok(isDeepStrictEqual(JSON.parse(bytes), delivery), "audit transport changed");
          c.files.push({ path: "json-audit-delivery.json", sha256: digest(bytes) });
        }
        const subject = freeze({ action: "stage-json-audit", campaignSha256: c.plan.campaignSha256,
          auditSubjectSha256: c.audit.subject.subjectSha256, deliverySha256: digest(json(delivery)), review: delivery.review });
        assert.equal(await authorize(subject), true, "parent transport/operator did not authorize this audit delivery");
        const checked = validateAuditDelivery(delivery, c.audit.subject, c.audit.sourceRoot);
        verifyWorkingSources(c.plan.bindings[0]); verifyPhases(c);
        assert.deepEqual(imageProof(c.audit.prepared.summary), c.audit.subject.images, "built images changed during review");
        save(c, "json-native-audits.json", checked.bundle);
        c.audit.bundle = checked.bundle; c.audit.accepted = true; c.state = "active";
        event(c, "audit-staged", { subject, trustBoundary: "operator-authorized transport and independent human audit; unsigned data is not self-approval" });
        return status(c);
      });
    },
    async submitMixedAudit(handle, delivery) {
      return exclusive(handle, async (c) => {
        if (c.control) assert.ok(c.controlEpochs.has("audit-mixed-production"), "live mixed audit control admission missing");
        assert.equal(c.state, "blocked-review-needed"); assert.equal(c.plan.order[c.index], "mixed-production");
        assert.ok(c.mixedAudit && !c.mixedAudit.accepted);
        assert.ok(Buffer.byteLength(JSON.stringify(delivery)) <= 16 * 1024 * 1024);
        delivery = freeze(structuredClone(delivery)); save(c, "mixed-audit-delivery-retained.json", delivery);
        const inbox = join(c.directory, "mixed-audit-delivery.json");
        if (lstatSync(inbox, { throwIfNoEntry: false })) {
          const stat = lstatSync(inbox);
          if (process.platform === "linux") { assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o077, 0); }
          const bytes = readRegular(inbox); assert.ok(isDeepStrictEqual(JSON.parse(bytes), delivery), "mixed audit transport changed");
          c.files.push({ path: "mixed-audit-delivery.json", sha256: digest(bytes) });
        }
        const subject = freeze({ action: "stage-mixed-audit", campaignSha256: c.plan.campaignSha256,
          auditSubjectSha256: c.mixedAudit.subject.subjectSha256, deliverySha256: digest(json(delivery)), review: delivery.review });
        assert.equal(await authorize(subject), true, "parent transport/operator did not authorize this mixed delivery");
        await replayMixedSubject(c.plan, c.mixedAudit.subject, repo, c.mixedAudit.sourceRoot);
        const checked = validateMixedDelivery(delivery, c.mixedAudit.subject, c.mixedAudit.sourceRoot);
        verifyWorkingSources(c.plan.bindings[0]); verifyPhases(c);
        save(c, "mixed-native-audits.json", checked.bundle);
        c.mixedAudit.bundle = checked.bundle; c.mixedAudit.accepted = true; c.state = "active";
        event(c, "mixed-audit-staged", { subject, trustBoundary: "operator-authorized delivery; independent source/context review, not image or OS authority" });
        return status(c);
      });
    },
    status(handle) { return status(own(handle)); },
    stop(handle, reason = "campaign job cancelled or audit deadline expired") {
      const c = own(handle); assert.equal(c.busy, false, "wait for owned command shutdown before stopping");
      if (!["finished", "preserved-uncertain"].includes(c.state)) halt(c, new Error(reason));
      return status(c);
    },
    verify(handle) { const c = own(handle); verifyPhases(c); return status(c); },
    offlineAuditRemainingMs(handle) { return remainingAuditMs(owned.get(handle), sampleAuditClock()); },
    expireOfflineAudit(handle) {
      const c = own(handle), group = c.plan.order[c.index];
      assert.ok(c.offlineHandoff && !c.busy && c.state === "blocked-review-needed" && !c.pendingNative.length);
      assert.ok(["json-api", "mixed-production"].includes(group) && c.reviewWait?.status.auditGroup === group);
      const auditClock = sampleAuditClock();
      assert.equal(remainingAuditMs(c, auditClock), 0, "offline audit deadline has not expired");
      assert.deepEqual([...c.controlEpochs], ["bootstrap"], "audit control already admitted");
      const prefix = group === "json-api" ? "json" : "mixed";
      for (const suffix of ["", "-pending", "-retained"])
        assert.equal(lstatSync(join(c.directory, `${prefix}-audit-delivery${suffix}.json`), { throwIfNoEntry: false }), undefined,
          "audit delivery may have started; preserve uncertainty");
      verifyPhases(c);
      halt(c, new Error("independent audit expired before timing"), { group, subjectSha256: c.reviewWait.subjectSha256, auditClock });
      return freeze({ status: status(c), manifest: tree(c.directory), wholeHostTerminal: "parent-must-observe", deletionAuthorized: false });
    },
    collect(handle) {
      const c = own(handle); assert.equal(c.busy, false); assert.equal(c.state, "finished", "whole campaign is not finished");
      verifyPhases(c); return freeze({ status: status(c), manifest: tree(c.directory), wholeHostTerminal: "parent-must-observe", deletionAuthorized: false });
    },
  });
}
