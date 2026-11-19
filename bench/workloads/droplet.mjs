// Reviewed all-nine lifecycle. Production transport is composed only by the gated CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFleetCensus, ownedDroplet, reservation, tags, terminalUnit, validateLaunchFleet } from "./cloud-contract.mjs";
import { bootstrapMarker, bootstrapReadScript, remoteFiles } from "./cloud-remote.mjs";
import { archiveLimit, archiveMembers, digest, durable, durableCopy, extractArchive, fileHash, physical, regular, resolveStateRoot, syncDirectory, treeHash } from "./cloud-local.mjs";
import { campaignOutcome, controllerFailure, controllerState, full, providerAccount, providerFailure, unitQuery, validateOptions } from "./cloud-options.mjs";
import { auditDelivery, auditProtocol, auditScript } from "./cloud-audit.mjs";
import { inspectCampaign } from "./cloud-validation.mjs";
import { mixedCancelScript, mixedSignalObservation, mixedWait, ownedMixedWait, verifyMixedCancellation, verifyMixedSignal } from "./cloud-cancellation.mjs";
import { failedNativeArchive, failedNativeObservation, failedNativeScript, setupEvidence, terminalSetupScript, unusedBootstrap, unusedEvidence, unusedHostScript,
  verifyFailedNativeCustody, verifyFailedNativeRetirement, verifyUnusedEvidence } from "./cloud-retirement.mjs";
import { controlRequest, controlRegistration, guardianSha256 } from "./cloud-control-runtime.mjs";
import { controlCheckpoint } from "./cloud-transport.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function command(binary, args, timeout = 60000, allowFail = false) {
  assert.equal(binary, "git", "provisional controller: real cloud transport disabled until full readiness/review");
  const r = spawnSync(binary, args, { cwd: checkout, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 16 * 1024 ** 2,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } });
  if (!allowFail && (r.error || r.status !== 0)) throw new Error(`${binary}: ${r.error?.code ?? r.status}`);
  return r;
}
const outside = (root, path) => { const r = relative(root, path); return isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`); };
export function controller(input, { run = command, repo = checkout, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  inspect, interrupted = () => false, settle = async () => {}, mergedHead = "origin/main", now = () => Date.now(), recoveryApproval, authorizeAudit, unusedBootstrapApproval, approvedFleetSha256 } = {}) {
  const options = validateOptions(input); repo = realpathSync(repo);
  if (mergedHead !== "origin/main") full(mergedHead, /[a-f0-9]{40}/, "exact observed main commit required");
  const fleetBytes = options.group === undefined ? undefined : regular(options.fleet, 1024 * 1024);
  if (approvedFleetSha256 !== undefined) assert.equal(digest(fleetBytes), approvedFleetSha256, "approved fleet bytes changed");
  const fleet = fleetBytes && validateLaunchFleet(JSON.parse(fleetBytes));
  if (fleet) {
    assert.equal(fleet.round, options.round); assert.equal(fleet.commit, options.commit); assert.equal(fleet.sshKey, options.sshKey);
    assert.deepEqual(fleet.provider, { accountId: options.accountId, context: options.context });
  }
  const requested = resolve(options.stateDir), physicalRequest = resolveStateRoot(requested);
  assert.ok(outside(repo, physicalRequest) && outside(physicalRequest, repo), "state and checkout must be disjoint");
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const base = realpathSync(requested); physical(base);
  const local = join(base, `groups-${options.round}`), statePath = join(local, "state.json"), archive = join(local, "results.tgz");
  let state, preserveOperationLock = false, controlEpoch = "collection", sealing, monitor;
  const boundary = (path = local) => { physical(base); physical(path); assert.equal(dirname(path), base, "reservation left root"); };
  const check = () => { assert.ok(!interrupted(), "controller cancelled; preserve reservation/host"); boundary(); };
  const read = (path = local, round = options.round) => { boundary(path); return controllerState(JSON.parse(regular(join(path, "state.json"), 1024 * 1024)), round); };
  const writeState = (value) => {
    controllerState(value, options.round);
    durable(`${statePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(`${statePath}.tmp`, statePath); syncDirectory(local);
  };
  const save = () => { check(); writeState(state); };
  // Cancellation forbids further work, not recording how the owned monitor ended.
  // Record only the ending and, if cancellation beat the live-state write,
  // the registration already received from this stream. Never adopt a file alone.
  const recordMonitorEnd = (phase) => {
    const alreadyUncertain = preserveOperationLock;
    preserveOperationLock = true;
    const saved = read();
    assert.equal(saved.token, state.token);
    assert.equal(saved.control.monitor.id, state.control.monitor.id);
    if (saved.control.monitor.phase === "pending") {
      assert.equal(phase, "invalid");
      assert.equal(saved.control.monitor.registrationSha256, undefined);
      const registered = JSON.parse(regular(join(local, "monitor-registration.json")));
      assert.deepEqual(registered, monitor.registration);
      assert.equal(registered.id, saved.control.monitor.id);
      assert.deepEqual(registered.binding, { round: saved.round, commit: saved.commit, token: saved.token, helperSha256: saved.control.helperSha256 });
      saved.control.monitor.registrationSha256 = digest(JSON.stringify(registered));
    } else {
      assert.equal(saved.control.monitor.registrationSha256, state.control.monitor.registrationSha256);
      assert.equal(saved.control.monitor.phase, "live");
    }
    saved.control.monitor.phase = phase; writeState(saved); state = saved;
    if (phase === "closed") preserveOperationLock = alreadyUncertain;
  };
  async function execute(binary, args, timeout = 60000, allowFail = false, deleteProofExpiresAtMs, remaining, registration) {
    if (deleteProofExpiresAtMs !== undefined) {
      assert.equal(binary, "doctl"); assert.equal(args[2], "delete");
      assert.ok(Number.isSafeInteger(deleteProofExpiresAtMs));
    }
    const invoke = async (argv, permittedFailure = false, expiry) => {
      check();
      if (expiry !== undefined) {
        const current = Date.now();
        assert.ok(current < expiry && expiry - current <= 60000, "current retirement proof expired");
      }
      let r;
      const limit = remaining ? Math.min(timeout, remaining()) : timeout;
      try { r = await run(binary, argv, limit, permittedFailure, expiry, registration); }
      catch (error) { if (error.controlTreeUncertain || error.controlUncertain) preserveOperationLock = true; throw error; }
      if (registration?.stream && r.monitor) {
        monitor = r.monitor;
        assert.equal(monitor.registration.id, registration.expected.id);
        assert.deepEqual(monitor.registration.binding, registration.expected.binding);
        await controlCheckpoint(interrupted);
      }
      if (r.controlTreeUncertain || r.controlUncertain) { preserveOperationLock = true; throw new Error("control uncertain; preserve locks"); }
      check();
      if (remaining) remaining();
      if (!permittedFailure) assert.ok(!r.error && r.status === 0, "control process failed; host preserved");
      return r;
    };
    if (binary !== "doctl") return invoke(args, allowFail);
    const scoped = (argv) => [...argv, "--context", state.provider.context];
    const account = async () => {
      const value = JSON.parse((await invoke(scoped(["account", "get", "--output", "json"]))).stdout);
      assert.equal(providerAccount(value), state.provider.accountId, "provider account identity changed; preserve uncertainty");
    };
    await account();
    const result = await invoke(scoped(args), allowFail, deleteProofExpiresAtMs);
    await account(); // A changed context cannot supply absence/deletion authority.
    return result;
  }
  const list = async () => { const d = JSON.parse((await execute("doctl", ["compute", "droplet", "list", "--output", "json"])).stdout); assert.ok(Array.isArray(d)); return d; };
  const exactHost = async (remaining) => {
    const result = await execute("doctl", ["compute", "droplet", "get", state.id, "--output", "json"], 60000, true, undefined, remaining);
    if (result.status === 1 && providerFailure(result)?.code === "get-http" && providerFailure(result)?.httpStatus === 404) return undefined;
    assert.equal(result.status, 0, "exact host observation failed; preserve state");
    const rows = JSON.parse(result.stdout);
    assert.ok(Array.isArray(rows) && rows.length === 1 && String(rows[0]?.id) === state.id, "exact host identity differs");
    return rows[0];
  };
  const confirmDeleted = async () => {
    assert.ok(state.deletionIntentAt, "deletion intent required before absence confirmation");
    let previous = now(); const deadline = previous + 120000;
    const uncertain = "deletion not confirmed; outcome uncertain; no automatic repeated deletion; preserve intent without another DELETE";
    const remaining = () => {
      check(); const current = now();
      assert.ok(Number.isFinite(current) && Number.isFinite(deadline) && current >= previous && current < deadline, uncertain);
      previous = current; return Math.max(1, Math.floor(deadline - current));
    };
    // The attempt cap also bounds synthetic/stalled clocks. Every account/GET/account
    // call shares the same deadline; an accepted DELETE is never repeated.
    for (let attempt = 0; attempt < 121; attempt++) {
      remaining();
      if (await exactHost(remaining) === undefined) return;
      await sleep(Math.min(1000, remaining()));
    }
    assert.fail(uncertain);
  };
  const own = async (remaining) => {
    const found = state.id ? await exactHost(remaining) : undefined;
    const d = ownedDroplet(state.id ? found ? [found] : [] : await list(), state), ips = d.networks?.v4?.filter((n) => n.type === "public");
    assert.equal(ips?.length, 1, "ambiguous public host address");
    if (state.ip) assert.equal(ips[0].ip_address, state.ip);
    return d;
  };
  const bind = (d) => {
    assert.ok(!state.id || state.id === String(d.id), "host ID changed");
    state.id = String(d.id); state.ip = d.networks.v4.find((n) => n.type === "public").ip_address;
    state.status = state.status === "creating" ? "preparing" : state.status; save();
  };
  const sshLimits = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
  const sshOptions = ["-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(local, "known_hosts").replaceAll("\\", "/")}`, ...sshLimits];
  const transport = async (binary, args, timeout, allowFail) => {
    await own(); assert.ok(state.id && state.ip, "bound host required");
    const mixedRecovery = state.group === "mixed-production" && (options.cancelMixedWait || options.retireFailedNative);
    if (mixedRecovery) assert.equal(fileHash(join(local, "known_hosts")), mixedWait.knownHostsSha256, "native host keys changed");
    if (existsSync(join(local, "known_hosts"))) regular(join(local, "known_hosts"), 1024 * 1024);
    let registration, intent;
    if (state.control) {
      assert.equal(state.control.helperSha256, guardianSha256, "control source changed; preserve host");
      assert.ok(!state.control.sealed.includes(controlEpoch), "control epoch already sealed");
      intent = controlRequest(state, binary, args, timeout ?? 60000, controlEpoch, sealing);
      state.control.ledger.push({ request: intent, localTerminal: false }); save();
      registration = controlRegistration(intent);
    }
    const result = await execute(binary, [...(mixedRecovery ? ["-o", "StrictHostKeyChecking=yes"] : []), ...sshOptions, ...args], timeout, allowFail, undefined, undefined, registration);
    if (intent) { const row = state.control.ledger.at(-1); row.localTerminal = true; row.code = result.status; save(); }
    if (mixedRecovery) assert.equal(fileHash(join(local, "known_hosts")), mixedWait.knownHostsSha256, "native host keys changed during transport");
    return result;
  };
  const ssh = (script, timeout = 60000, allowFail = false) => transport("ssh", [`root@${state.ip}`, script], timeout, allowFail);
  const scp = (from, to) => transport("scp", ["-q", from, to], 15 * 60000);
  async function waitForSsh() {
    const windowMs = 120000, spacingMs = 5000, attempts = windowMs / spacingMs;
    let previous = now(); const deadline = previous + windowMs;
    const remaining = () => {
      check(); const current = now();
      assert.ok(Number.isFinite(current) && Number.isFinite(deadline) && current >= previous && current < deadline, "SSH unavailable within readiness budget");
      previous = current; return Math.max(1, Math.floor(deadline - current));
    };
    for (let attempt = 0; attempt < attempts; attempt++) {
      await own(remaining);
      const known = join(local, "known_hosts");
      if (lstatSync(known, { throwIfNoEntry: false })) regular(known, 1024 * 1024);
      // No guardian or other remote write is dispatched by this probe. Only a
      // settled SSH client failure can advance to another identical no-op.
      const result = await execute("ssh", [...sshOptions, `root@${state.ip}`, "true"], 20000, true, undefined, remaining);
      if (result.status === 0 && !result.error && !result.signal) return;
      assert.equal(result.status, 255, "SSH unavailable; readiness did not return an SSH transport status");
      if (attempt + 1 < attempts) await sleep(Math.min(spacingMs, remaining()));
    }
    assert.fail("SSH unavailable within readiness budget");
  }
  const unit = async () => terminalUnit((await ssh(unitQuery(state))).stdout, state);
  const requireActiveStartup = async (message) => {
    const { stdout } = await ssh(unitQuery(state));
    if (!terminalUnit(stdout, state)) return;
    // An acknowledged start and positive terminal observation, not an SSH
    // failure or missing monitor. Keep the original output and its ledger row.
    state.preBootstrapTerminal = { hostId: state.id, ip: state.ip, monitorId: state.control.monitor.id,
      invocation: state.control.ledger.at(-1).request.invocation.id, stdout };
    state.status = "starting"; save(); assert.fail(message);
  };
  async function sealControl(epoch) {
    if (!state.control) return;
    assert.equal(controlEpoch, epoch);
    const rows = state.control.ledger.filter((r) => r.request.epoch === epoch);
    assert.ok(rows.length > 0 && rows.every((r) => r.localTerminal), "unsettled local control ledger");
    sealing = rows.map((r) => r.request.invocation);
    try { await ssh(":"); } finally { sealing = undefined; }
    state.control.sealed.push(epoch); save(); controlEpoch = "collection";
  }
  async function commonBootstrap() {
    const deadline = now() + 45 * 60000; let previous = deadline - 45 * 60000;
    const remaining = () => {
      const current = now();
      assert.ok(Number.isFinite(current) && Number.isFinite(deadline) && current >= previous && current < deadline, "common bootstrap observation expired; preserve running host");
      previous = current; check(); return deadline - current;
    };
    for (;;) {
      remaining();
      await requireActiveStartup("first group ended before common bootstrap admission; collect its evidence");
      const result = await ssh(bootstrapReadScript, Math.min(30000, remaining()), true);
      remaining();
      if (result.status === 0 && !result.error) {
        assert.ok(Buffer.byteLength(result.stdout) <= 1024, "bounded bootstrap marker required");
        assert.deepEqual(JSON.parse(result.stdout), bootstrapMarker(state), "common bootstrap identity differs");
        if (state.group !== undefined && state.group === state.fleet.jobs[0].group) {
          state.bootstrapReady = { sha256: digest(result.stdout), observedAt: new Date().toISOString() }; save();
        }
        if (state.control?.monitor) {
          assert.equal(state.control.monitor.phase, "pending");
          const expected = { id: state.control.monitor.id, binding: { round: state.round, commit: state.commit,
            token: state.token, helperSha256: state.control.helperSha256 } };
          await execute("ssh", [...sshOptions, 'root@' + state.ip], 30000, false, undefined, undefined,
            { stream: true, expected, local, interrupted });
          assert.ok(monitor);
          state.control.monitor.registrationSha256 = digest(JSON.stringify(monitor.registration));
          state.control.monitor.phase = "live"; save();
        }
        await sealControl("bootstrap"); return;
      }
      assert.equal(result.status, 3, "common bootstrap marker observation failed");
      await sleep(Math.min(30000, remaining()));
    }
  }
  async function locked(fn, recovery = false, name = recovery ? "stream-recovery.lock" : "operation.lock") {
    boundary(); const lock = join(local, name);
    if (recovery) assert.ok(existsSync(join(local, "operation.lock")), "original uncertain monitor custody required");
    durable(lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    preserveOperationLock = false;
    try {
      state = read(); check();
      if (recovery) assert.equal(state.control?.monitor?.phase, "invalid", "only irrevocably failed monitoring can recover");
      return await fn();
    }
    finally {
      try { await settle(); }
      catch (error) {
        preserveOperationLock = true;
        const diagnostic = providerFailure(error);
        throw Object.assign(new Error("control teardown uncertain; preserve locks/state/evidence/host"), { controlTreeUncertain: true, controlUncertain: true },
          diagnostic ? { providerDiagnostic: diagnostic } : {});
      }
      finally { if (!preserveOperationLock) { unlinkSync(lock); syncDirectory(local); } }
    }
  }
  const verifyArchive = () => {
    assert.equal(fileHash(archive), state.archiveSha256, "archive changed; preserve host");
  };
  async function validateEvidence() {
    state.fullGroupQualified = false;
    const extracted = join(local, state.evidence); physical(extracted);
    assert.equal(treeHash(extracted), state.evidenceSha256, "evidence changed; preserve host");
    const markerBytes = regular(join(extracted, "exit-code"), 16);
    assert.ok(markerBytes.every((b) => b < 128), "invalid exit marker bytes");
    const marker = markerBytes.toString("ascii");
    full(marker, /(?:0|[1-9]\d{0,2})\n/, "invalid exit marker");
    const exitCode = Number(marker.trim()); assert.ok(exitCode <= 255);
    let report;
    let outcome;
    try {
      report = await inspectCampaign(Object.freeze({ folder: join(extracted, "campaign"), round: state.round, commit: state.commit }), {
        inspect, interrupted, preserveLock: () => { preserveOperationLock = true; },
      });
      check();
      assert.ok(state.control?.monitor?.phase !== "invalid" || report.status !== "verified", "lost monitor cannot qualify");
      outcome = campaignOutcome(report, state, exitCode);
      if (state.control?.monitor?.phase === "closed") {
        const terminal = JSON.parse(regular(join(local, "monitor-terminal.json")));
        assert.equal(terminal.id, state.control.monitor.id);
        assert.equal(terminal.nativeTerminal, true); assert.equal(terminal.campaign, report.campaign);
        assert.equal(terminal.sealSha256, report.supervisedTerminal.sealSha256);
      }
    } catch { throw new Error("native campaign validation unavailable or invalid; evidence/host preserved"); }
    // Never retain/print native assertion messages: they may contain private raw values.
    assert.equal(treeHash(extracted), state.evidenceSha256, "validator mutated evidence"); verifyArchive();
    Object.assign(state, outcome, { exitCode, validation: { status: report.status, campaign: report.campaign, collectionIntegrity: report.collectionIntegrity } });
  }
  const deletedCode = () => state.validation.status === "verified" && state.exitCode === 0 ? 0 : 1; // Intrinsic evidence only, never readiness.
  const setupExit = () => {
    verifyArchive(); const extracted = join(local, state.evidence); physical(extracted);
    assert.equal(treeHash(extracted), state.evidenceSha256, "failed setup archive extraction changed");
    const campaign = join(extracted, "campaign");
    if (existsSync(campaign)) { physical(campaign); assert.deepEqual(readdirSync(campaign), [], "native data cannot use setup retirement"); }
    const marker = regular(join(extracted, "exit-code"), 16).toString("utf8");
    full(marker, /[1-9]\d{0,2}\n/, "nonzero setup exit required");
    const exit = Number(marker.trim()); assert.ok(exit <= 255); return exit;
  };
  const retirementFile = (kind) => kind === "setup-failed" ? "failed-setup-host.json" : "unused-host.json";
  const verifyRetirementRecord = (bytes, kind) => {
    const setup = kind === "setup-failed";
    const record = JSON.parse(bytes), raw = JSON.stringify(record.observation);
    if (!setup) return verifyUnusedEvidence(record, state);
    const expected = setupEvidence(raw, state, terminalSetupScript(state, setupExit(), state.control ? record.observation.control.requests.length - 1 : undefined), setupExit(), record.startedAtMs, record.finishedAtMs, local);
    assert.deepEqual(record, expected, "retirement evidence differs");
  };
  const verifyRetirement = () => {
    if (state.retirement.kind === "native-failed") return verifyFailedNativeRetirement(local, state);
    const bytes = regular(join(local, retirementFile(state.retirement.kind)), state.control && state.retirement.kind === "setup-failed" ? 8 * 1024 * 1024 : 4096);
    assert.equal(digest(bytes), state.retirement.evidenceSha256, "retirement evidence changed");
    verifyRetirementRecord(bytes, state.retirement.kind);
  };
  const requireUnusedBootstrapCustody = () => {
    assert.ok(unusedBootstrapApproval && unusedBootstrap(state), "exact approved unused bootstrap required");
    assert.equal(digest(regular(statePath, 1024 * 1024)), unusedBootstrapApproval.reservationSha256, "locked unused bootstrap reservation changed");
    const present = (path) => lstatSync(path, { throwIfNoEntry: false });
    assert.ok(!present(join(base, ".groups-launch.lock")) && (!state.group || !present(join(dirname(base), ".fleet-operation.lock"))),
      "original launch custody remains; preserve locks and host");
    assert.ok(readdirSync(local).every((name) => ["state.json", "operation.lock", "known_hosts", "unused-host.json"].includes(name)
      || /^unused-host\.interrupted-[a-f0-9]{64}\.json$/.test(name)), "unexpected local bootstrap custody; preserve host");
  };
  const retire = async (kind, evidence, finishedAtMs) => {
    const pinned = options.unusedBootstrapKnownHosts !== undefined;
    const deleteProofExpiresAtMs = pinned ? evidence.startedAtMs + 60000 : undefined;
    const requireFreshProof = () => {
      const current = Date.now();
      assert.ok(current >= finishedAtMs && (pinned ? current < deleteProofExpiresAtMs : current - finishedAtMs <= 60000),
        "retirement proof expired before deletion");
    };
    await own(); check();
    if (pinned) requireUnusedBootstrapCustody();
    requireFreshProof();
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
    assert.ok(Buffer.byteLength(bytes) <= (state.control && kind === "setup-failed" ? 8 * 1024 * 1024 : 4096), "bounded retirement record required");
    const path = join(local, retirementFile(kind));
    if (existsSync(path)) {
      // A crash between receipt and state writes is recoverable. Preserve the
      // exact old record, but only this operation's fresh probe authorizes intent.
      assert.ok(!state.deletionIntentAt && !state.retirement, "existing retirement intent cannot be repeated");
      const limit = state.control && kind === "setup-failed" ? 8 * 1024 * 1024 : 4096;
      const prior = regular(path, limit), hash = digest(prior); verifyRetirementRecord(prior, kind);
      const retained = join(local, `${retirementFile(kind).slice(0, -5)}.interrupted-${hash}.json`);
      if (existsSync(retained)) assert.equal(digest(regular(retained, 4096)), hash, "interrupted retirement history differs");
      else durable(retained, prior);
      assert.equal(digest(regular(path, limit)), hash, "interrupted retirement receipt changed");
      unlinkSync(path); syncDirectory(local);
    }
    durable(path, bytes);
    if (pinned) requireFreshProof();
    Object.assign(state, { status: "retired", retirement: { kind, evidenceSha256: digest(bytes) }, deletionIntentAt: new Date().toISOString() }); save();
    verifyRetirement();
    await execute("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000, false, deleteProofExpiresAtMs);
    await confirmDeleted();
    state.destroyedAt = new Date().toISOString(); save(); return 1;
  };
  const retireUnused = async () => {
    assert.equal(state.status, "preparing", "only a never-started allocation can be retired as unused");
    const bootstrap = options.unusedBootstrapKnownHosts !== undefined, script = unusedHostScript(state, { bootstrap });
    let raw, startedAtMs, knownHostsSha256;
    if (!bootstrap) {
      assert.ok(!state.control?.monitor || state.control.ledger.length > 0, "unused bootstrap requires an approved pinned observation");
      startedAtMs = Date.now(); raw = (await ssh(script, 30000)).stdout;
    } else {
      await own();
      const key = regular(options.unusedBootstrapKnownHosts, 1024 * 1024);
      knownHostsSha256 = digest(key);
      assert.equal(knownHostsSha256, unusedBootstrapApproval.knownHostsSha256, "approved host-key file changed");
      // Stay under the private state root, but outside the durable reservation.
      const dir = mkdtempSync(join(base, ".unused-host-key-")), path = join(dir, "known_hosts"), identity = lstatSync(dir, { bigint: true });
      let fileIdentity;
      try {
        durable(path, key);
        fileIdentity = lstatSync(path, { bigint: true });
        const pinned = ["-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=none", "-o", "UpdateHostKeys=no",
          "-o", `UserKnownHostsFile=${process.platform === "win32" ? path.replaceAll("\\", "/") : path}`];
        // Do not install a guardian or turn a missing acknowledgement into a receipt.
        startedAtMs = Date.now();
        raw = (await execute("ssh", [...pinned, ...sshLimits, `root@${state.ip}`, script], 30000)).stdout;
        assert.equal(digest(regular(path, 1024 * 1024)), knownHostsSha256, "private host-key snapshot changed");
      } finally {
        if (!preserveOperationLock) {
          physical(dir);
          const current = lstatSync(dir, { bigint: true });
          assert.ok(current.dev === identity.dev && current.ino === identity.ino, "private host-key directory changed");
          const files = readdirSync(dir);
          if (files.length) {
            assert.deepEqual(files, ["known_hosts"], "unexpected private host-key artifacts; preserve");
            const file = lstatSync(path, { bigint: true });
            assert.ok(fileIdentity && file.dev === fileIdentity.dev && file.ino === fileIdentity.ino
              && digest(regular(path, 1024 * 1024)) === knownHostsSha256, "private host-key snapshot changed; preserve");
            unlinkSync(path);
          }
          rmdirSync(dir);
        }
      }
    }
    const finishedAtMs = Date.now();
    const evidence = unusedEvidence(raw, state, script, startedAtMs, finishedAtMs, knownHostsSha256);
    return retire("unused", evidence, finishedAtMs);
  };
  const retireFailedSetup = async () => {
    assert.ok(["starting", "running"].includes(state.status) && !preserveOperationLock, "uncertain work cannot use setup retirement");
    const exit = setupExit(), script = terminalSetupScript(state, exit), startedAtMs = Date.now();
    const raw = (await ssh(script, 30000)).stdout, finishedAtMs = Date.now();
    const evidence = setupEvidence(raw, state, script, exit, startedAtMs, finishedAtMs, local);
    return retire("setup-failed", evidence, finishedAtMs);
  };
  return {
    get state() { return state ? structuredClone(state) : undefined; }, local,
    async cancelMixedWait() {
      assert.equal(options.cancelMixedWait, true, "explicit mixed cancellation required");
      return locked(async () => {
        ownedMixedWait(state);
        assert.ok(recoveryApproval, "exact merged-source cancellation approval required");
        full(recoveryApproval.controllerCommit, /[a-f0-9]{40}/, "merged cancellation controller source required");
        assert.notEqual(recoveryApproval.controllerCommit, state.commit);
        assert.equal(digest(regular(statePath)), recoveryApproval.reservationSha256, "locked cancellation reservation changed");
        assert.equal(state.status, "running");
        for (const key of ["mixedCancellation", "archiveSha256", "evidence", "deletionIntentAt", "collectedAt"]) assert.equal(state[key], undefined);
        assert.ok(Date.now() < Date.parse(mixedWait.deadline), "original mixed wait deadline expired");
        assert.equal(fileHash(join(local, "known_hosts")), mixedWait.knownHostsSha256, "saved native host key view changed");
        for (const name of ["mixed-cancel-reservation.json", "mixed-cancel-intent.json", "mixed-cancel-signal.json"])
          assert.ok(!existsSync(join(local, name)), "single cancellation attempt already reserved; never signal again");
        await own(); // Fresh saved-context account/exact-ID/account before intent.
        const script = mixedCancelScript(state), original = regular(statePath);
        assert.equal(digest(original), recoveryApproval.reservationSha256, "reservation changed during ownership proof");
        const bytes = `${JSON.stringify({ schema: "benchmark-mixed-cancel-intent/v1", wait: mixedWait,
          controllerCommit: recoveryApproval.controllerCommit, reservationSha256: digest(original), scriptSha256: digest(script) }, null, 2)}\n`;
        durable(join(local, "mixed-cancel-reservation.json"), original);
        durable(join(local, "mixed-cancel-intent.json"), bytes);
        // From here even a refusal or lost response retains the operation lock.
        preserveOperationLock = true;
        state.mixedCancellation = { controllerCommit: recoveryApproval.controllerCommit,
          reservationSha256: digest(original), intentSha256: digest(bytes) }; save();
        verifyMixedCancellation(local, state);
        assert.equal(digest(regular(statePath)), digest(`${JSON.stringify(state, null, 2)}\n`), "cancellation state changed before dispatch");
        const startedAtMs = Date.now(), raw = (await ssh(script, 50000)).stdout, finishedAtMs = Date.now();
        const observation = mixedSignalObservation(raw, state, startedAtMs, finishedAtMs);
        const signalBytes = `${JSON.stringify({ observation, startedAtMs, finishedAtMs }, null, 2)}\n`;
        durable(join(local, "mixed-cancel-signal.json"), signalBytes);
        verifyMixedCancellation(local, state);
        assert.equal(digest(regular(statePath)), digest(`${JSON.stringify(state, null, 2)}\n`), "cancellation state changed during dispatch");
        state.mixedCancellation.signalSha256 = digest(signalBytes); save();
        verifyMixedSignal(local, state);
        preserveOperationLock = false;
        return 3; // Signal acknowledgement is neither terminal proof nor deletion.
      });
    },
    async launch() {
      assert.ok(options.detach, "detach options required");
      const launchLock = join(base, ".groups-launch.lock");
      durable(launchLock, `${JSON.stringify({ pid: process.pid, round: options.round })}\n`);
      try {
        assert.ok(!existsSync(local), "round already reserved; never relaunch");
        for (const entry of readdirSync(base)) if (entry.startsWith("groups-")) {
          const match = /^groups-(r[1-9]\d{0,8})$/.exec(entry); assert.ok(match, "unknown reservation");
          assert.ok(read(join(base, entry), match[1]).destroyedAt, "unresolved reservation blocks launch");
        }
        mkdirSync(local, { mode: 0o700 }); syncDirectory(base);
        state = { ...reservation({ round: options.round, commit: options.commit,
          token: fleet ? fleet.jobs.find((row) => row.group === options.group).token : randomBytes(8).toString("hex"),
          ...(fleet ? { group: options.group, fleet } : {}) }),
          provider: { accountId: options.accountId, context: options.context }, fullGroupQualified: false,
          control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: [],
            monitor: { schema: "benchmark-supervised-control/v1", id: randomBytes(16).toString("hex"), phase: "pending" } } };
        controlEpoch = "bootstrap";
        durable(statePath, `${JSON.stringify(state, null, 2)}\n`);
        return await locked(async () => {
          assert.equal(realpathSync((await execute("git", ["rev-parse", "--show-toplevel"])).stdout.trim()), repo);
          assert.equal((await execute("git", ["rev-parse", "HEAD"])).stdout.trim(), state.commit, "measured HEAD differs");
          assert.equal((await execute("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim(), "", "clean committed source required");
          await execute("git", ["merge-base", "--is-ancestor", state.commit, mergedHead]);
          for (const path of ["bench/workloads/droplet.mjs", "bench/workloads/cloud-contract.mjs", "bench/workloads/isolated/campaign-entry.mjs", "bench/workloads/isolated/campaign-verify.mjs"])
            await execute("git", ["cat-file", "-e", `${state.commit}:${path}`]);
          const existing = await list();
          if (fleet) assertFleetCensus(existing, fleet);
          else assert.ok(!existing.some((d) => d.name?.startsWith("corten-bench-groups-") || d.tags?.includes(tags[0])), "benchmark host already exists");
          assert.ok(!existing.some((d) => d.name === state.name || d.tags?.includes(state.tag)), "this host already exists; never adopt/relaunch");
          const account = JSON.parse((await execute("doctl", ["account", "get", "--output", "json"])).stdout);
          assert.equal(providerAccount(account), state.provider.accountId, "provider account identity changed; preserve uncertainty");
          const limit = (Array.isArray(account) ? account[0] : account)?.droplet_limit;
          assert.ok(Number.isSafeInteger(limit) && existing.length < limit, "account capacity unavailable");
          if (fleet) {
            const present = existing.filter((d) => fleet.jobs.some((row) => row.name === d.name)).length;
            assert.ok(existing.length + fleet.jobs.length - present <= limit, "account capacity cannot cover the reserved fleet");
          }
          state.status = "creating"; state.createIntentAt = new Date().toISOString(); save();
          const created = await execute("doctl", ["compute", "droplet", "create", state.name, "--size", state.host.size, "--region", state.host.region, "--image", state.host.image,
            "--ssh-keys", options.sshKey, "--tag-names", [...tags, state.tag].join(","), "--wait", "--output", "json"], 10 * 60000, true);
          // Lost acknowledgement permits only identity reconciliation, never another create.
          try { bind(await own()); }
          catch (error) {
            const diagnostic = providerFailure(created);
            if (diagnostic && !providerFailure(error)) error.providerDiagnostic = diagnostic;
            throw error;
          }
          if (created.error || created.status !== 0) {
            const diagnostic = providerFailure(created);
            throw Object.assign(new Error("create completion was not proved; allocation retained for recovery"), diagnostic ? { providerDiagnostic: diagnostic } : {});
          }
          const completed = JSON.parse(created.stdout);
          assert.ok(Array.isArray(completed) && completed.length === 1 && Number.isSafeInteger(completed[0]?.id)
            && completed[0].id > 0 && String(completed[0].id) === state.id,
          "completed create and owned host differ; preserve reservation without provisioning");
          await waitForSsh();
          assert.equal((await ssh("true", 30000, true)).status, 0, "SSH unavailable; never retry or relaunch");
          await ssh("mkdir -m 700 /bench && touch /bench/run.log");
          for (const [name, content] of Object.entries(remoteFiles(state))) {
            durable(join(local, name), content); await scp(join(local, name), `root@${state.ip}:/bench/${name}`);
            await ssh(`printf '%s  %s\\n' '${digest(content)}' '/bench/${name}' | sha256sum --check --status`);
          }
          await ssh(`bash -n /bench/job.sh && bash -n /bench/pack.sh && install -m 644 /bench/${state.unit} /etc/systemd/system/${state.unit} && systemd-analyze verify /etc/systemd/system/${state.unit} && systemctl daemon-reload`);
          state.status = "starting"; save(); await ssh(`systemctl start ${state.unit}`);
          await requireActiveStartup("group ended before running admission; collect its evidence");
          state.status = "running"; save();
          try { await commonBootstrap(); }
          catch (error) {
            if (!monitor) throw error;
            preserveOperationLock = true; monitor.cancel();
            try { await monitor.done; } catch { /* Unsettled transport retains custody. */ }
            recordMonitorEnd("invalid");
            throw Object.assign(new Error("bootstrap seal failed after monitor registration; preserve host and custody"), { controlTreeUncertain: true });
          }
          if (monitor) {
            let result;
            try { result = await monitor.done; }
            catch (error) { recordMonitorEnd("invalid"); throw error; }
            recordMonitorEnd(result.terminal ? "closed" : "invalid");
            if (!result.terminal) {
              throw Object.assign(new Error("supervised monitor lost before terminal proof; retain host and custody"), { controlTreeUncertain: true });
            }
            check();
          }
          return structuredClone(state);
        });
      } finally { if (!preserveOperationLock) { unlinkSync(launchLock); syncDirectory(base); } }
    },
    async collect() {
      assert.ok(options.collect, "collect options required");
      if (options.unusedBootstrapKnownHosts !== undefined) return locked(async () => {
        requireUnusedBootstrapCustody();
        if (state.status === "preparing") return retireUnused();
        verifyRetirement(); await confirmDeleted();
        state.destroyedAt ??= new Date().toISOString(); save(); return 1;
      });
      const observed = read();
      let failedMonitorRecovery = false;
      const neverProvisioned = (s) => s.control?.monitor?.phase === "pending" && !s.control.monitor.registrationSha256
        && s.id && s.ip && s.createIntentAt && !s.control.sealed.length
        && s.control.ledger.every((row) => row.request.epoch === "collection" && row.localTerminal)
        && (s.status === "preparing" || s.status === "retired" && s.retirement?.kind === "unused")
        && !readdirSync(local).some((name) => name.startsWith("monitor-"));
      // A settled create can leave an identified host before the first SSH operation.
      // No monitor exists then. The ordinary exclusive lock and fresh unused-host
      // proof still apply; neither a pending registration nor local state permits deletion.
      const unusedCandidate = neverProvisioned(observed);
      const beforeRegistration = (s) => s.preBootstrapTerminal && s.control.ledger.every((row) => row.localTerminal)
        && !existsSync(join(base, ".groups-launch.lock")) && !readdirSync(local).some((name) => name.startsWith("monitor-"));
      const setupCandidate = !!observed.preBootstrapTerminal;
      if (setupCandidate) assert.ok(beforeRegistration(observed), "ambiguous pre-bootstrap custody; preserve host");
      if (observed.control?.monitor && !unusedCandidate && !setupCandidate) {
        const { localStreamStatus, streamRecoveryReady } = await import("./cloud-control-stream.mjs");
        const status = localStreamStatus(local);
        if (["pending", "progress"].includes(status.kind)) {
          if (status.kind === "pending") assert.equal(observed.status, "running", "monitor not registered; preserve pending reservation");
          assert.ok(existsSync(join(local, "operation.lock")), "monitor absent or orphaned; preserve host"); return 3;
        }
        if (!streamRecoveryReady(local, observed.control.monitor)) return 3;
        failedMonitorRecovery = status.kind === "invalid";
        if (failedMonitorRecovery) assert.equal(observed.control.monitor.phase, "invalid", "foreground monitor has not settled");
      }
      return locked(async () => {
        if (unusedCandidate) assert.ok(neverProvisioned(state), "unused allocation changed; preserve host");
        assert.ok(!(state.status === "preparing" && state.control?.monitor?.phase === "pending"
          && state.control.ledger.length === 0), "unused bootstrap requires an approved pinned observation");
        assert.equal(!!state.preBootstrapTerminal, setupCandidate, "pre-bootstrap reservation changed; preserve host");
        if (setupCandidate) assert.ok(beforeRegistration(state), "ambiguous pre-bootstrap custody; preserve host");
        if (state.status === "retired") {
          verifyRetirement();
          await confirmDeleted();
          state.destroyedAt ??= new Date().toISOString(); save(); return 1;
        }
        if (state.deletionIntentAt) {
          verifyArchive(); await validateEvidence();
          await confirmDeleted();
          state.destroyedAt ??= new Date().toISOString(); save(); return deletedCode();
        }
        assert.ok(state.control?.monitor || !state.control?.sealed.includes("bootstrap"),
          "terminal status unavailable without SSH intrusion; preserve host; registered native collection needs an approved observation protocol");
        assert.ok(state.createIntentAt, "no create intent; reservation requires operator inspection");
        bind(await own());
        if (state.status === "preparing") return retireUnused();
        if (setupCandidate) {
          const { stdout } = await ssh(unitQuery(state) + `\njob=$(systemctl show ${state.unit} --all --property=Job); test "$job" = 'Job='`);
          assert.ok(terminalUnit(stdout, state) && stdout === state.preBootstrapTerminal.stdout, "startup unit no longer identically terminal");
        } else if (!await unit()) return 3; // Exactly one look, never waits for a live campaign.
        if (!state.archiveSha256) {
          assert.ok(!existsSync(archive) && !existsSync(`${archive}.download`), "unrecorded download/archive retained; inspect before retry");
          // pack.sh copies current control custody before its archive-exists
          // check. Never change the snapshot beside a pre-existing exit archive.
          const pack = "timeout 600 /bin/bash /bench/pack.sh";
          await ssh(setupCandidate ? `if test -e /bench/results.tgz || test -L /bench/results.tgz; then
test -f /bench/results.tgz && test ! -L /bench/results.tgz && test "$(stat -c '%s' -- /bench/results.tgz)" -le ${archiveLimit}
else ${pack}; fi` : pack, 11 * 60000);
          const hashLine = (await ssh("sha256sum /bench/results.tgz")).stdout;
          full(hashLine, /[a-f0-9]{64}  \/bench\/results\.tgz\n/, "invalid remote archive hash");
          const hash = hashLine.slice(0, 64), download = `${archive}.download`;
          // Reserve the destination before SCP, so a crash cannot make it look retryable.
          durable(download, ""); await scp(`root@${state.ip}:/bench/results.tgz`, download);
          // Re-write through a synced exclusive file; never replace unexplained evidence.
          durableCopy(download, `${archive}.synced`, hash); renameSync(`${archive}.synced`, archive); syncDirectory(local);
          state.archiveSha256 = hash; save();
        }
        verifyArchive(); await archiveMembers(archive, state.archiveSha256); check();
        if (!state.evidence) {
          const extracted = mkdtempSync(join(local, "evidence-"));
          (state.extractionAttempts ??= []).push(basename(extracted)); save();
          const hash = await extractArchive(archive, extracted, state.archiveSha256); check();
          state.evidence = basename(extracted); state.evidenceSha256 = hash; save();
        }
        if (setupCandidate) return retireFailedSetup(); // Never inspect/publish native evidence without supervision.
        try { await validateEvidence(); }
        catch (error) {
          // No native report can exist before entry. Only a separate fresh,
          // terminal pre-entry proof permits failed-setup cleanup, never success.
          try { setupExit(); } catch { throw error; }
          return retireFailedSetup();
        }
        if (failedMonitorRecovery) {
          save(); return 1; // Failed evidence custody only; keep original lock and require the existing explicit retirement gates.
        }
        state.collectedAt ??= new Date().toISOString(); state.status = "collected"; save();
        verifyArchive(); await validateEvidence();
        assert.ok(await unit(), "unit became active; preserve host"); await own(); check();
        state.deletionIntentAt = new Date().toISOString(); save();
        await execute("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000);
        await confirmDeleted();
        verifyArchive(); await validateEvidence(); state.destroyedAt = new Date().toISOString(); save(); return deletedCode();
      }, failedMonitorRecovery);
    },
    async retireFailedNative() {
      assert.equal(options.retireFailedNative, true, "explicit failed-native action required");
      return locked(async () => {
        assert.ok(recoveryApproval, "source-bound production recovery approval required");
        full(recoveryApproval.controllerCommit, /[a-f0-9]{40}/, "merged repair source required");
        assert.notEqual(recoveryApproval.controllerCommit, state.commit, "repair source must be distinct from measured source");
        assert.equal(digest(regular(statePath, 1024 * 1024)), recoveryApproval.reservationSha256, "locked recovery reservation changed");
        if (state.status === "retired") {
          assert.equal(state.retirement.kind, "native-failed");
          verifyFailedNativeRetirement(local, state);
          await confirmDeleted();
          state.destroyedAt ??= new Date().toISOString(); save(); return 1;
        }
        assert.ok(["starting", "running"].includes(state.status) && !state.deletionIntentAt && !state.collectedAt
          && !state.validation && !state.evidenceOutcome && state.createIntentAt, "only an unqualified failed native reservation can recover");
        if (state.group === "mixed-production") {
          verifyMixedSignal(local, state);
          assert.equal(fileHash(join(local, "known_hosts")), mixedWait.knownHostsSha256, "saved native host key view changed");
          if (!await unit()) return 3; // Observe once, never stop or repack the unit.
          if (!state.archiveSha256) {
            assert.ok(!existsSync(archive) && !existsSync(`${archive}.download`), "unrecorded wrapper archive retained");
            const line = (await ssh("sha256sum /bench/results.tgz")).stdout;
            full(line, /[a-f0-9]{64}  \/bench\/results\.tgz\n/, "wrapper archive hash required");
            const hash = line.slice(0, 64), download = `${archive}.download`;
            durable(download, ""); await scp(`root@${state.ip}:/bench/results.tgz`, download);
            durableCopy(download, `${archive}.synced`, hash); renameSync(`${archive}.synced`, archive); syncDirectory(local);
            state.archiveSha256 = hash; save();
          }
          verifyArchive(); await archiveMembers(archive, state.archiveSha256); check();
          if (!state.evidence) {
            const extracted = mkdtempSync(join(local, "evidence-"));
            (state.extractionAttempts ??= []).push(basename(extracted)); save();
            const hash = await extractArchive(archive, extracted, state.archiveSha256); check();
            state.evidence = basename(extracted); state.evidenceSha256 = hash; save();
          }
        }
        failedNativeArchive(local, state);
        const original = regular(statePath, 1024 * 1024), originalPath = join(local, "failed-native-reservation.json");
        if (existsSync(originalPath)) assert.equal(digest(regular(originalPath, 1024 * 1024)), digest(original), "original reservation differs");
        else durable(originalPath, original);
        const capturePath = join(local, "failed-native-capture.json"), custodyArchive = join(local, "failed-native-results.tgz");
        let capture;
        if (existsSync(capturePath)) {
          capture = verifyFailedNativeCustody(local, state, JSON.parse(regular(capturePath)));
          assert.equal(capture.controllerCommit, recoveryApproval.controllerCommit, "custody controller source changed");
        } else {
          assert.ok(!existsSync(custodyArchive) && !existsSync(`${custodyArchive}.download`), "unrecorded custody retained; no automatic adoption");
          const script = failedNativeScript(state), startedAtMs = Date.now();
          const raw = (await ssh(script, 11 * 60000)).stdout, finishedAtMs = Date.now();
          const observation = failedNativeObservation(raw, state, startedAtMs, finishedAtMs);
          const download = `${custodyArchive}.download`; durable(download, "");
          await scp(`root@${state.ip}:/bench/failed-native-custody.tgz`, download);
          durableCopy(download, `${custodyArchive}.synced`, observation.archiveSha256);
          renameSync(`${custodyArchive}.synced`, custodyArchive); syncDirectory(local);
          const extracted = mkdtempSync(join(local, "custody-"));
          const hash = await extractArchive(custodyArchive, extracted, observation.archiveSha256); check();
          capture = { schema: "benchmark-failed-native-custody/v1", measuredCommit: state.commit, controllerCommit: recoveryApproval.controllerCommit,
            reservationSha256: digest(original), scriptSha256: digest(script), observation, startedAtMs, finishedAtMs,
            evidence: basename(extracted), evidenceSha256: hash };
          verifyFailedNativeCustody(local, state, capture); durable(capturePath, `${JSON.stringify(capture, null, 2)}\n`);
        }
        // Local custody verification precedes a fresh, full remote rehash and
        // current-quiescence proof. Neither is historical native qualification.
        verifyFailedNativeCustody(local, state, capture); check();
        const rehashScript = failedNativeScript(state, capture.observation.snapshotSha256), rehashStarted = Date.now();
        const rehashRaw = (await ssh(rehashScript, 11 * 60000)).stdout, rehashFinished = Date.now();
        const rehashObservation = failedNativeObservation(rehashRaw, state, rehashStarted, rehashFinished);
        const withoutTime = ({ observedAtMs, ...rest }) => rest;
        assert.deepEqual(withoutTime(rehashObservation), withoutTime(capture.observation), "predelete custody differs");
        verifyFailedNativeCustody(local, state, capture);
        const receiptPath = join(local, "failed-native-host.json");
        let interruptedReceipt;
        if (existsSync(receiptPath)) {
          const prior = regular(receiptPath), hash = digest(prior);
          // Verify against the actual measured state, without adopting an intent.
          verifyFailedNativeRetirement(local, state, hash);
          const history = join(local, `failed-native-host.interrupted-${hash}.json`);
          if (existsSync(history)) assert.equal(digest(regular(history)), hash); else durable(history, prior);
          interruptedReceipt = hash;
        }
        // Full local verification can be expensive. Renew only the current host
        // proof afterwards, while checking all remote metadata is still exactly
        // the previously hashed inventory and the custody archive is unchanged.
        const script = failedNativeScript(state, capture.observation.snapshotSha256, capture.observation), startedAtMs = Date.now();
        const raw = (await ssh(script, 11 * 60000)).stdout, finishedAtMs = Date.now();
        const confirmation = failedNativeObservation(raw, state, startedAtMs, finishedAtMs);
        assert.deepEqual(withoutTime(confirmation), withoutTime(capture.observation), "final custody fence differs");
        await own(); check();
        // Bound the whole local fence operation, including SSH response delivery.
        // Its start precedes the observation without relying on remote clock skew.
        const deleteProofExpiresAtMs = startedAtMs + 60000;
        assert.ok(Date.now() >= finishedAtMs && Date.now() < deleteProofExpiresAtMs, "current retirement proof expired");
        const receipt = { schema: "benchmark-failed-native-retirement/v1", capture, confirmation, scriptSha256: digest(script), startedAtMs, finishedAtMs,
          rehash: { observation: rehashObservation, scriptSha256: digest(rehashScript), startedAtMs: rehashStarted, finishedAtMs: rehashFinished } };
        const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
        if (interruptedReceipt !== undefined) {
          // Only this invocation's fresh proof can replace an interrupted receipt.
          assert.equal(digest(regular(receiptPath)), interruptedReceipt); unlinkSync(receiptPath); syncDirectory(local);
        }
        durable(receiptPath, bytes);
        Object.assign(state, { status: "retired", retirement: { kind: "native-failed", evidenceSha256: digest(bytes) }, deletionIntentAt: new Date().toISOString() }); save();
        await execute("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000, false, deleteProofExpiresAtMs);
        await confirmDeleted();
        state.destroyedAt = new Date().toISOString(); save(); return 1;
      });
    },
    async deliverAudit() {
      assert.ok(options.deliverAudit, "audit delivery options required");
      const observed = read();
      if (observed.control?.monitor) {
        assert.equal(typeof authorizeAudit, "function", "supervised audit publication requires the locked approval checkpoint");
        return locked(async () => {
          const { queueStreamAudit } = await import("./cloud-control-stream.mjs");
          const approved = await authorizeAudit(); check();
          const bytes = regular(statePath, 1024 * 1024);
          assert.equal(digest(bytes), approved.reservationSha256, "locked audit reservation changed");
          state = controllerState(JSON.parse(bytes), options.round);
          assert.ok(state.id && state.ip && !state.deletionIntentAt && !state.collectedAt && ["starting", "running"].includes(state.status), "live owned campaign required");
          queueStreamAudit(local, state, options, approved.deliverySha256);
          return 3; // Pending publication only; remote sealed admission is observed on the existing stream.
        }, false, "audit-delivery.lock");
      }
      return locked(async () => {
        assert.ok(state.id && state.ip && !state.deletionIntentAt && !state.collectedAt && ["starting", "running"].includes(state.status), "live owned campaign required");
        const { group, prefix } = auditProtocol(options.auditGroup);
        controlEpoch = `audit-${group}`;
        if (state.group !== undefined) assert.equal(group, state.group, "audit delivery belongs to a different group host");
        assert.ok(!state.auditIntents?.[group] && !(group === "json-api" && state.auditIntent), "audit delivery already attempted; inspect, never repeat");
        const bytes = regular(resolve(options.deliverAudit), 16 * 1024 ** 2), intent = auditDelivery(bytes, options);
        assert.equal(await unit(), false, "terminal campaign cannot accept delivery");
        assert.equal((await ssh(auditScript(state, intent))).stdout.trim(), intent.subjectSha256);
        durable(join(local, `${prefix}-audit-delivery.json`), bytes);
        (state.auditIntents ??= {})[group] = intent; save();
        const stage = `/bench/cloud-${prefix}-audit-${state.token}.json`;
        await ssh(`test ! -e ${stage} && test ! -L ${stage} && install -m 600 /dev/null ${stage}`);
        await scp(join(local, `${prefix}-audit-delivery.json`), `root@${state.ip}:${stage}`);
        assert.equal(await unit(), false, "campaign ended during audit transfer");
        assert.equal((await ssh(auditScript(state, intent, true))).stdout.trim(), intent.subjectSha256);
        await sealControl(controlEpoch);
        return 3;
      });
    },
  };
}

// Never print exception messages/stacks or provider output: assertions may echo raw evidence.
export function publicError(error) {
  const diagnostic = providerFailure(error), stage = controllerFailure(error);
  const detail = diagnostic?.httpStatus !== undefined ? ` (HTTP ${diagnostic.httpStatus})`
    : diagnostic?.detail !== undefined ? ` (${diagnostic.detail})` : "";
  return "Controller stopped; retained state/evidence requires inspection. Host/deletion state may be uncertain. Never relaunch."
    + (stage ? ` Controller stage: ${stage}.` : "")
    + (diagnostic ? ` Provider failure: ${diagnostic.code}${detail}.` : "");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  import("./cloud-production.mjs").then((native) => native.productionCli(process.argv.slice(2)))
    .then((code) => { process.exitCode = code; }, (error) => { console.error(publicError(error)); process.exitCode = 2; });
}
