// Fixed production source with synthetic kernel observations only. No host operations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { reservation } from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";
import { controlRequest, guardianSource, guardianSha256 } from "./cloud-control-runtime.mjs";
import { verifyControlSetupQuery } from "./cloud-control-session.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { SetupWatcherProofMissing, setupEvidence, setupWatcherFailures, terminalSetupScript, watcherDeadlineFailure } from "./cloud-retirement.mjs";
import setupDrainSource from "./cloud-setup-drain-source.mjs";

// The guardian records only this line when a watcher misses its drainage deadline.
const deadlineLine = guardianSource.split("\n").indexOf('    raise AssertionError("remote session drainage deadline expired")') + 1;
const deadlineFailure = `{"helperLine":${deadlineLine}}\n`;
const guardianLine = (text) => {
  const lines = guardianSource.split("\n").flatMap((line, i) => (line.includes(text) ? [i + 1] : []));
  assert.equal(lines.length, 1, text); return lines[0];
};
// A synthetic /proc row: stat field 4 is the parent, 9 the flags, 22 the start time.
function procRow(pid, ppid, cgroup, ticks, flags = 0, comm = "synthetic") {
  const fields = Array(49).fill("0"); fields[0] = String(ppid); fields[5] = String(flags); fields[18] = String(ticks);
  return { pid, startTicks: String(ticks), cgroup: `0::${cgroup}\n`, stat: `${pid} (${comm}) S ${fields.join(" ")}\n`,
    executable: { device: "1", inode: String(pid) }, commandSha256: "0".repeat(64) };
}
const noDocker = { "/run/docker.sock": false, "/run/containerd/containerd.sock": false };

// A drain fixture holds the first bootstrap session (and, for a two-session mode, the
// second) open until its watcher fails.
function fixture(mode, { drain = false, code = 0, failedRows = [0] } = {}) {
  const state = { ...reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" }),
    id: "123", ip: "192.0.2.10", status: "running", createIntentAt: new Date().toISOString(),
    evidence: "evidence-fixture", extractionAttempts: ["evidence-fixture"], archiveSha256: "a".repeat(64), evidenceSha256: "b".repeat(64),
    control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: [] } };
  for (const [i, binary] of ["ssh", "scp"].entries()) {
    const request = controlRequest(state, binary, ["root@192.0.2.10", ":"], 1000, "bootstrap");
    request.invocation.id = (i + 1).toString(16).padStart(32, "0");
    if (binary === "scp") request.invocation.requestSha256 = digest("synthetic-sftp-protocol");
    state.control.ledger.push({ request, localTerminal: true, code: 0 });
  }
  if (drain) { for (const i of failedRows) state.control.ledger[i].code = code; state.preBootstrapTerminal = { hostId: state.id, ip: state.ip }; }
  const failures = drain ? failedRows.map((i) => ({ id: state.control.ledger[i].request.invocation.id, failureSha256: digest(deadlineFailure) })) : [];
  const script = terminalSetupScript(state, 1, undefined, failures), files = Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  const expected = { binding: { round: state.round, commit: state.commit, token: state.token, helperSha256: guardianSha256 }, sequence: 2,
    requests: state.control.ledger.map((row) => row.request), queryArgv: ["/usr/bin/python3", "-", state.id, state.unit, JSON.stringify(files), "1"],
    ...(drain ? { watcherFailures: failures.map(({ id, failureSha256 }) => ({ id, code, failureSha256 })) } : {}) };
  const request = controlRequest(state, "ssh", ["root@192.0.2.10", script], 1000, "collection");
  request.invocation.id = "3".padStart(32, "0");
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "bench/workloads/test-fixtures/control-session-kernel.py"],
    { cwd: resolve("."), input: JSON.stringify({ source: guardianSource, mode, expected, queryPayload: `set -euo pipefail\n${script}\n`, querySha256: request.invocation.requestSha256,
      ...(drain ? { drainSource: setupDrainSource } : {}) }),
      encoding: "utf8", timeout: 15000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  state.control.ledger.push({ request, localTerminal: true, code: 0 });
  return { ...JSON.parse(result.stdout), state, script, expected };
}
function custodyFolder(t, f) {
  const local = mkdtempSync(join(tmpdir(), "owned-control-retirement-"));
  t.after(() => { assert.ok(local.startsWith(join(tmpdir(), "owned-control-retirement-"))); rmSync(local, { recursive: true, force: true }); });
  const custody = join(local, f.state.evidence, "control"); mkdirSync(custody, { recursive: true });
  for (const [name, hex] of Object.entries(f.custody)) writeFileSync(join(custody, name), Buffer.from(hex, "hex"));
  return { local, custody };
}

test("pre-entry source query proves earlier drainage and the exact live query watcher without claiming remote empty", (t) => {
  const f = fixture("setup-normal"); assert.equal(f.rejected, false);
  const checked = verifyControlSetupQuery(f.expected, f.proof);
  assert.equal(checked.remoteDrained, false); assert.equal(checked.sequence, 2);
  const local = mkdtempSync(join(tmpdir(), "owned-control-retirement-"));
  t.after(() => { assert.ok(local.startsWith(join(tmpdir(), "owned-control-retirement-"))); rmSync(local, { recursive: true, force: true }); });
  const custody = join(local, f.state.evidence, "control"); mkdirSync(custody, { recursive: true });
  for (const [name, hex] of Object.entries(f.custody)) writeFileSync(join(custody, name), Buffer.from(hex, "hex"));
  const now = Date.now(), observation = { schema: "benchmark-failed-setup-host/v2", hostId: f.state.id, unit: f.state.unit,
    setupFailed: true, exitCode: 1, observedAtMs: now, control: f.proof };
  const evidence = setupEvidence(JSON.stringify(observation), f.state, f.script, 1, now - 1, now, local);
  assert.equal(evidence.schema, "benchmark-failed-setup-retirement/v2");
  for (const mutate of [
    (p) => { p.binding.helperSha256 = "f".repeat(64); }, (p) => { p.requests.pop(); },
    (p) => { p.registration.host.bootId = "ffffffff-ffff-ffff-ffff-ffffffffffff"; },
    (p) => { p.watchers[0].properties.MainPID = "200"; }, (p) => { p.watcher.Restart = "always"; },
    (p) => { p.query.startTicks = "1"; }, (p) => { p.query.cgroup = "0::/foreign.scope\n"; },
    (p) => { p.query.commandSha256 = "f".repeat(64); }, (p) => { p.custody[0].sha256 = "f".repeat(64); },
    (p) => { const row = structuredClone(p.registration.first.processes[0]); row.pid = 999; row.stat = row.stat.replace(/^\d+ /, "999 "); p.registration.first.processes.push(row); },
    (p) => { p.observation.processes.push({ ...p.observation.processes.find((p) => p.pid === 1), pid: 999 }); },
  ]) {
    const changed = structuredClone(observation); mutate(changed.control);
    assert.throws(() => setupEvidence(JSON.stringify(changed), f.state, f.script, 1, now - 1, now, local));
  }
  writeFileSync(join(custody, "helper.py"), "changed");
  assert.throws(() => setupEvidence(JSON.stringify(observation), f.state, f.script, 1, now - 1, now, local));
  const sealed = structuredClone(f.state), final = sealed.control.ledger.at(-1).request;
  final.epoch = "bootstrap"; final.invocation.purpose = "bootstrap";
  final.seal = sealed.control.ledger.map((row) => ({ id: row.request.invocation.id, sha256: digest(JSON.stringify(row.request.invocation)) }));
  sealed.control.sealed.push("bootstrap");
  assert.throws(() => terminalSetupScript(sealed, 1), /sealed\/native/);
});

test("source retirement rejects unknown descendants, login managers, live earlier watchers, sealed entry and changed custody", () => {
  for (const mode of ["setup-unknown", "setup-user-manager", "setup-unknown-unit", "setup-watcher", "setup-watcher-command", "setup-watcher-cgroup", "setup-sealed", "setup-extra-record", "setup-custody", "setup-source"])
    assert.equal(fixture(mode).rejected, true, mode);
});

test("new emitted pre-entry query compiles; the legacy script keeps its original exact bytes", () => {
  const f = fixture("setup-normal"), body = f.script.split("<<'CORTEN_FAILED_SETUP_HOST'\n")[1].split("\nCORTEN_FAILED_SETUP_HOST")[0];
  const parsed = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-c", "import ast,json,sys; ast.parse(json.load(sys.stdin)); print('parsed')"],
    { cwd: resolve("."), input: JSON.stringify(body), encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(parsed.error, undefined); assert.equal(parsed.status, 0, parsed.stderr);
  assert.ok(body.includes("control_namespace['setup_query']")); assert.ok(body.includes("benchmark-failed-setup-host/v2"));
  const legacy = { ...reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" }), id: "123", ip: "192.0.2.10",
    status: "running", createIntentAt: "2026-11-17T00:00:00.000Z" };
  // Observed byte-for-byte against the assigned 6f2d source generator.
  assert.equal(digest(terminalSetupScript(legacy, 1)), "3e53685d2b597f7629797a2c635b08d978ee5b04d0620c3fa631ca03185c370c");
});

test("a query with no failed watcher keeps the base generator's exact bytes and no drain source", () => {
  const f = fixture("setup-normal");
  // Observed byte-for-byte against babd52d28's generator for this two-row ledger.
  assert.equal(digest(terminalSetupScript({ ...f.state, control: { ...f.state.control, ledger: f.state.control.ledger.slice(0, 2) } }, 1)),
    "9cc7b02fe6f4e77034de0e043f246ddad6bc2e295a12c11630ec53a13a7481ce");
  assert.equal(f.script, terminalSetupScript(f.state, 1, 2, []));
  for (const marker of ["watcherFailures", "setup_drain_query", "<fixed-setup-drain-source>", "benchmark-failed-setup-host/v3"]) assert.ok(!f.script.includes(marker), marker);
  assert.equal(f.proof.schema, "benchmark-control-setup-query/v1"); assert.equal(Object.hasOwn(f.proof, "drained"), false);
});

test("a failed bootstrap watcher retires only on a fresh drain proof of its exact session, unit and archived failure", (t) => {
  const f = fixture("setup-drain-normal", { drain: true });
  assert.equal(f.rejected, false, f.reason);
  assert.equal(f.proof.schema, "benchmark-control-setup-query/v2");
  const failed = f.expected.watcherFailures[0].id;
  assert.equal(Buffer.from(f.custody[`watch-failure-${failed}.json`], "hex").toString(), deadlineFailure);
  assert.equal(f.custody[`receipt-${failed}.json`], undefined);
  assert.deepEqual([f.proof.receipts[0], f.proof.watchers[0]], [null, null]); assert.ok(f.proof.receipts[1]);
  const drained = f.proof.drained[0];
  assert.deepEqual(drained.watcher, { Id: `corten-bench-control-${f.state.token}-${failed}.service`, LoadState: "loaded", ActiveState: "failed",
    MainPID: "0", ControlPID: "0", Job: "" });
  assert.deepEqual(drained.scope.members, []); assert.equal(drained.result.code, 0);
  assert.deepEqual(f.proof.dockerSockets, noDocker);
  const checked = verifyControlSetupQuery(f.expected, f.proof);
  assert.equal(checked.remoteDrained, false);
  const { local, custody } = custodyFolder(t, f);
  assert.deepEqual(setupWatcherFailures(f.state, local), [{ id: failed, failureSha256: digest(deadlineFailure) }]);
  const now = Date.now(), observation = { schema: "benchmark-failed-setup-host/v3", hostId: f.state.id, unit: f.state.unit,
    setupFailed: true, exitCode: 1, observedAtMs: now, control: f.proof };
  const evidence = setupEvidence(JSON.stringify(observation), f.state, f.script, 1, now - 1, now, local);
  assert.equal(evidence.schema, "benchmark-failed-setup-retirement/v3");
  assert.ok(f.script.includes("control_namespace['setup_drain_query']") && f.script.includes("<fixed-setup-drain-source>"));
  const body = f.script.split("<<'CORTEN_FAILED_SETUP_HOST'\n")[1].split("\nCORTEN_FAILED_SETUP_HOST")[0];
  const parsed = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-c", "import ast,json,sys; ast.parse(json.load(sys.stdin)); print('parsed')"],
    { cwd: resolve("."), input: JSON.stringify(body), encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(parsed.status, 0, parsed.stderr);
  // A v2 script or schema, or a script without the failure, cannot stand in for the drain proof.
  assert.throws(() => setupEvidence(JSON.stringify({ ...observation, schema: "benchmark-failed-setup-host/v2" }), f.state, f.script, 1, now - 1, now, local));
  assert.throws(() => setupEvidence(JSON.stringify(observation), f.state, terminalSetupScript(f.state, 1, 2), 1, now - 1, now, local));
  const observer = drained.registration.observer, chain = drained.registration.session.chain;
  // A row with a failed session's identity, moved out of its scope and reparented to PID 1, so only
  // the identity check and the start-time fence see it; the descendant row predates the fence.
  const moved = (pid) => { const row = structuredClone(drained.registration.first.processes.find((q) => q.pid === pid));
    row.cgroup = "0::/system.slice/cron.service\n"; row.stat = row.stat.replace(/\) S \d+ /, ") S 1 "); return row; };
  for (const [mutate, pattern] of [
    [(p) => { p.drained[0].watcher.ActiveState = "active"; }, /failed watcher still active or queued/],
    [(p) => { p.drained[0].watcher.Job = "42"; }, /failed watcher still active or queued/],
    [(p) => { p.drained[0].watcher.MainPID = String(observer.pid); }, /failed watcher still active or queued/],
    [(p) => { p.drained[0].result.code = 1; }, /drained result differs from the ledger/],
    [(p) => { p.drained[0].result.transport = "lost"; }, /uncertain transport cannot be drained/],
    [(p) => { p.drained[0].failureSha256 = "f".repeat(64); }, /drained watcher differs/],
    [(p) => { p.drained[0].scope.members = [999]; }, /drained session scope populated/],
    [(p) => { p.drained[0].cgroupEvents = "populated 1\nfrozen 0\n"; }, /failed watcher cgroup populated/],
    [(p) => { p.receipts[0] = p.receipts[1]; }, /failed watcher cannot carry a receipt/],
    [(p) => { p.drained = []; }, /drained watcher proof required/],
    [(p) => { p.schema = "benchmark-control-setup-query/v1"; }, /benchmark-control-setup-query\/v2/],
    [(p) => { p.observation.processes.push(moved(chain.at(-1).pid)); }, /drained session process or descendant remains/],
    [(p) => { p.observation.processes.push(moved(observer.pid)); }, /failed watcher process remains/],
    [(p) => { const row = structuredClone(p.observation.processes.find((q) => q.pid === 1)); row.pid = 999;
      row.stat = row.stat.replace(/^1 \(no-name-authority\) S 0 /, `999 (no-name-authority) S ${chain.at(-1).pid} `); p.observation.processes.push(row); },
    /drained session process or descendant remains/],
  ]) {
    const changed = structuredClone(observation); mutate(changed.control);
    assert.throws(() => setupEvidence(JSON.stringify(changed), f.state, f.script, 1, now - 1, now, local), pattern, String(pattern));
  }
  writeFileSync(join(custody, `watch-failure-${failed}.json`), '{"helperLine":1}\n');
  assert.throws(() => setupEvidence(JSON.stringify(observation), f.state, f.script, 1, now - 1, now, local));
});

test("the drain proof refuses residual sessions, live or queued watchers, changed results or failures and extra custody", () => {
  // An unloaded watcher unit (not-found, inactive) is settled like a failed one.
  const unloaded = fixture("setup-drain-unloaded", { drain: true });
  assert.equal(unloaded.rejected, false, unloaded.reason); verifyControlSetupQuery(unloaded.expected, unloaded.proof);
  assert.deepEqual([unloaded.proof.drained[0].watcher.LoadState, unloaded.proof.drained[0].watcher.ActiveState], ["not-found", "inactive"]);
  const cases = {
    "setup-drain-scope": /session scope populated/, "setup-drain-chain": /session process remains/,
    "setup-drain-descendant": /session descendant remains/, "setup-drain-active": /watcher unit still active or queued/,
    "setup-drain-queued": /watcher unit still active or queued/, "setup-drain-result": /^KeyError: .*result-/,
    "setup-drain-bytes": /watcher failure differs from the archive/, "setup-drain-extra-record": /unknown control custody member/,
    "setup-drain-stream": /unknown control custody member/, "setup-drain-escaped": /process started during or after a failed session/,
    "setup-drain-window": /watcher window still open/, "setup-drain-controlpid": /watcher unit still active or queued/,
    "setup-drain-loaded-inactive": /watcher unit still active or queued/, "setup-drain-notfound-failed": /watcher unit still active or queued/,
    // The query's listener is exempt from the start-time fence: a restarted one (same PID, later
    // start) or a different, older one did not serve the failed session and refuses.
    "setup-drain-listener-restarted": /listener differs from a failed session/, "setup-drain-listener-replaced": /listener differs from a failed session/,
    // The failed watcher's process still in /proc while systemd reports its unit failed, and
    // another process left in that unit's cgroup.
    "setup-drain-observer-alive": /watcher process remains/, "setup-drain-cgroup-populated": /watcher cgroup populated/,
    // A result that is not an observed exit, and a registration for another invocation or boot.
    "setup-drain-transport": /command result differs from the ledger/, "setup-drain-registration": /failed session registration differs/,
    "setup-drain-boot": /failed session boot differs/,
  };
  for (const [mode, reason] of Object.entries(cases)) {
    const f = fixture(mode, { drain: true });
    assert.equal(f.rejected, true, mode); assert.match(f.reason, reason, mode);
  }
  const mismatch = fixture("setup-drain-code", { drain: true, code: 1 });
  assert.equal(mismatch.rejected, true); assert.match(mismatch.reason, /command result differs from the ledger/);
  // Without the archived failure the ordinary query still needs every receipt.
  const legacy = fixture("setup-drain-legacy");
  assert.equal(legacy.rejected, true); assert.match(legacy.reason, /^KeyError: .*receipt-/);
});

test("the drain proof refuses a non-kernel process outside the query's set that started with or after the failed session, wherever it moved", () => {
  // The kernel fixture gives each process startTicks = pid * 100. The failed session's first
  // process is PID 100, so the fence is 10000.
  for (const mode of ["setup-drain-older", "setup-drain-kthread"]) {
    const f = fixture(mode, { drain: true });
    assert.equal(f.rejected, false, f.reason); verifyControlSetupQuery(f.expected, f.proof);
    assert.ok(f.proof.observation.processes.some((p) => p.pid === (mode === "setup-drain-older" ? 5 : 998)), mode);
  }
  const f = fixture("setup-drain-normal", { drain: true }), chain = f.proof.drained[0].registration.session.chain;
  assert.equal(chain.map((p) => BigInt(p.startTicks)).reduce((a, b) => (b < a ? b : a)), 10000n);
  const accepts = (row) => { const p = structuredClone(f.proof); p.observation.processes.push(row); verifyControlSetupQuery(f.expected, p); };
  const refuses = (row) => assert.throws(() => accepts(row), /process started during or after a failed session/, row.cgroup);
  // The escaped grandchild: its own transient scope, reparented to PID 1, outside the empty session scope.
  refuses(procRow(999, 1, "/system.slice/run-u7.scope", 99900));
  refuses(procRow(7, 1, "/system.slice/cron.service", 10000));
  // A kernel-thread flag counts only under kthreadd in the root cgroup.
  refuses(procRow(997, 1, "/", 99700, 0x00200000)); refuses(procRow(997, 2, "/system.slice/x.service", 99700, 0x00200000));
  refuses(procRow(997, 2, "/", 99700));
  accepts(procRow(5, 1, "/system.slice/cron.service", 9999)); accepts(procRow(997, 2, "/", 99700, 0x00200000));
});

test("only the guardian's exact drainage deadline record selects the drain proof; every other watcher failure keeps refusing", (t) => {
  assert.equal(watcherDeadlineFailure, deadlineFailure);
  const f = fixture("setup-drain-normal", { drain: true }), failed = f.expected.watcherFailures[0].id;
  const { local, custody } = custodyFolder(t, f), path = join(custody, `watch-failure-${failed}.json`);
  assert.deepEqual(setupWatcherFailures(f.state, local), [{ id: failed, failureSha256: digest(deadlineFailure) }]);
  const other = {
    "unowned scope participant": guardianLine('"unowned scope participant"'),
    "listener identity": guardianLine('assert all(actual_identity[field] == p[field] for field in ("pid", "startTicks", "cgroup", "executable"))'),
    "observer identity": guardianLine("                assert actual_identity == p"),
    "sample or row cap": guardianLine("assert len(samples) <= 4096 and rows_count <= 65536"),
    "known process cap": guardianLine("        assert len(known) <= 8192"),
    "launcher timing": guardianLine('"watcher launcher did not settle"'),
    "observation timing": guardianLine('"control observation exceeded original deadline"'),
  };
  const bytes = { ...Object.fromEntries(Object.entries(other).map(([name, line]) => [name, `{"helperLine":${line}}\n`])),
    "unknown line": '{"helperLine":0}\n', "spaced": `{"helperLine": ${deadlineLine}}\n`, "no newline": `{"helperLine":${deadlineLine}}`,
    "extra field": `{"helperLine":${deadlineLine},"reason":"x"}\n` };
  for (const [name, body] of Object.entries(bytes)) {
    writeFileSync(path, body);
    assert.throws(() => setupWatcherFailures(f.state, local), /not a drainage deadline expiry/, name);
  }
  writeFileSync(path, deadlineFailure);
  // After registration, the drain receipt is never accepted.
  const now = Date.now(), observation = { schema: "benchmark-failed-setup-host/v3", hostId: f.state.id, unit: f.state.unit,
    setupFailed: true, exitCode: 1, observedAtMs: now, control: f.proof };
  assert.equal(setupEvidence(JSON.stringify(observation), f.state, f.script, 1, now - 1, now, local).schema, "benchmark-failed-setup-retirement/v3");
  const registered = { ...f.state }; delete registered.preBootstrapTerminal;
  assert.throws(() => setupEvidence(JSON.stringify(observation), registered, f.script, 1, now - 1, now, local), /pre-registration custody/);
});

test("a drain proof binds every record of the failed row to the host entries and the copied custody, with exact keys", () => {
  const f = fixture("setup-drain-normal", { drain: true }), failed = f.expected.watcherFailures[0].id;
  verifyControlSetupQuery(f.expected, f.proof);
  const refuses = (mutate, pattern) => { const p = structuredClone(f.proof); mutate(p); assert.throws(() => verifyControlSetupQuery(f.expected, p), pattern); };
  refuses((p) => { p.drained[0].registration.first.monoNs = String(BigInt(p.drained[0].registration.first.monoNs) + 1n); }, /drained registration differs/);
  for (const name of ["request", "start", "launcher", "registration", "result", "watch-failure"])
    refuses((p) => { p.custody = p.custody.filter((entry) => entry.name !== `${name}-${failed}.json`); }, /failed watcher record missing from custody/);
  refuses((p) => { p.drained[0].cgroupEvents = ["populated 0\n"]; }, /failed watcher cgroup populated/);
  refuses((p) => { p.drained[0].scope = { ...p.drained[0].scope, exists: true, events: ["populated 0\n"] }; }, /drained session scope populated/);
  refuses((p) => { p.extra = true; }, /unexpected control record fields/);
  refuses((p) => { delete p.executables; }, /unexpected control record fields/);
});

test("a drained session must fit its original window, a settled unit and the listener that served it", () => {
  const f = fixture("setup-drain-normal", { drain: true });
  const check = (mutate) => { const p = structuredClone(f.proof); mutate(p); return verifyControlSetupQuery(f.expected, p); };
  const refuses = (mutate, pattern) => assert.throws(() => check(mutate), pattern, String(pattern));
  const deadline = BigInt(f.proof.drained[0].start.deadlineMonoNs), span = BigInt(f.proof.drained[0].registration.invocation.deadlineMs) * 1000000n;
  refuses((p) => { p.drained[0].result.completedMonoNs = String(deadline + 1n); }, /drained session outside its original window/);
  refuses((p) => { p.drained[0].result.releasedMonoNs = String(deadline - span - 1n); }, /drained session outside its original window/);
  for (const watcher of [{ ControlPID: "77" }, { LoadState: "loaded", ActiveState: "inactive" }, { LoadState: "not-found", ActiveState: "failed" }])
    refuses((p) => { Object.assign(p.drained[0].watcher, watcher); }, /failed watcher still active or queued/);
  check((p) => { Object.assign(p.drained[0].watcher, { LoadState: "not-found", ActiveState: "inactive" }); });
  // The live listener is exempt from the start-time fence, so a restarted or different one refuses.
  const listener = f.proof.registration.listener;
  const restart = (p, ticks) => {
    p.registration.listener.startTicks = ticks;
    for (const rows of [p.registration.first.processes, p.observation.processes]) {
      const row = rows.find((q) => q.pid === listener.pid), [head, tail] = row.stat.split(") "), fields = tail.split(" ");
      fields[19] = ticks; Object.assign(row, { startTicks: ticks, stat: `${head}) ${fields.join(" ")}` });
    }
  };
  assert.ok(BigInt(listener.startTicks) < 10000n);
  check((p) => restart(p, listener.startTicks));
  refuses((p) => restart(p, "20000"), /listener differs from a failed session/);
  refuses((p) => restart(p, "900"), /listener differs from a failed session/);
});

test("the drain verifier refuses another boot, a query inside the failed window, an extra drained field and a live scope member", () => {
  const f = fixture("setup-drain-normal", { drain: true });
  const refuses = (mutate, pattern) => { const p = structuredClone(f.proof); mutate(p); assert.throws(() => verifyControlSetupQuery(f.expected, p), pattern, String(pattern)); };
  const other = "fedcba98-7654-3210-fedc-ba9876543210";
  refuses((p) => { p.drained[0].registration.host.bootId = other; p.drained[0].registration.first.bootId = other; }, /drained session boot differs/);
  // A failed window that, with its result, still closes after the query's observation.
  const now = BigInt(f.proof.observation.monoNs);
  refuses((p) => { Object.assign(p.drained[0].start, { deadlineMonoNs: String(now + 1n) });
    Object.assign(p.drained[0].result, { releasedMonoNs: String(now), completedMonoNs: String(now) }); }, /drained session outside its original window/);
  refuses((p) => { p.drained[0].extra = true; }, /unexpected control record fields/);
  // A process older than the fence, parented by PID 1, still in the failed session's scope.
  const scope = f.proof.drained[0].registration.session.scope;
  refuses((p) => { p.observation.processes.push(procRow(989, 1, scope, 9999)); }, /drained session scope member remains/);
  refuses((p) => { p.observation.processes.push(procRow(989, 1, `${scope}/child`, 9999)); }, /drained session scope member remains/);
});

test("the drain proof refuses a Docker or containerd socket or daemon, even one older than the failed session", () => {
  // A dangling symlink at a socket path does not exist but is a symlink; it refuses as well.
  for (const mode of ["setup-drain-docker-socket", "setup-drain-containerd-socket", "setup-drain-docker-symlink", "setup-drain-containerd-symlink",
    "setup-drain-dockerd", "setup-drain-containerd", "setup-drain-containerd-shim"]) {
    const f = fixture(mode, { drain: true });
    assert.equal(f.rejected, true, mode); assert.match(f.reason, /^AssertionError: Docker or containerd present$/, mode);
  }
  const f = fixture("setup-drain-normal", { drain: true });
  const check = (mutate) => { const p = structuredClone(f.proof); mutate(p); return verifyControlSetupQuery(f.expected, p); };
  const refuses = (mutate, pattern = /Docker or containerd present/) => assert.throws(() => check(mutate), pattern, String(pattern));
  for (const path of Object.keys(noDocker)) refuses((p) => { p.dockerSockets[path] = true; });
  refuses((p) => { delete p.dockerSockets; }, /unexpected control record fields/);
  refuses((p) => { p.dockerSockets.extra = false; });
  // Each daemon starts before the fence (10000), so only this check sees it.
  for (const comm of ["dockerd", "containerd", "containerd-shim"]) refuses((p) => { p.observation.processes.push(procRow(6, 1, `/system.slice/${comm}.service`, 600, 0, comm)); });
  // One started after the fence is refused first by the start-time check.
  for (const comm of ["dockerd", "containerd"]) refuses((p) => { p.observation.processes.push(procRow(6, 1, `/system.slice/${comm}.service`, 10500, 0, comm)); },
    /process started during or after a failed session/);
  check((p) => { p.observation.processes.push(procRow(6, 1, "/system.slice/cron.service", 600, 0, "cron")); });
});

test("two failed bootstrap sessions drain in ledger order, fenced by the earlier session's first process", () => {
  const f = fixture("setup-drain-two", { drain: true, failedRows: [0, 1] });
  assert.equal(f.rejected, false, f.reason); verifyControlSetupQuery(f.expected, f.proof);
  assert.deepEqual(f.proof.drained.map((entry) => entry.id), f.expected.watcherFailures.map((failure) => failure.id));
  assert.deepEqual([f.proof.receipts, f.proof.watchers], [[null, null], [null, null]]);
  const first = (entry) => entry.registration.session.chain.map((p) => BigInt(p.startTicks)).reduce((a, b) => (b < a ? b : a));
  assert.deepEqual(f.proof.drained.map(first), [10000n, 11000n]);
  // Failures and drained entries out of ledger order, even when they still pair up, refuse.
  const expected = structuredClone(f.expected), reordered = structuredClone(f.proof);
  expected.watcherFailures.reverse(); reordered.drained.reverse();
  assert.throws(() => verifyControlSetupQuery(expected, reordered), /drained watchers out of ledger order/);
  // A process that started after the first failed session but before the second refuses.
  const accepts = (row) => { const p = structuredClone(f.proof); p.observation.processes.push(row); verifyControlSetupQuery(f.expected, p); };
  assert.throws(() => accepts(procRow(990, 1, "/system.slice/cron.service", 10500)), /process started during or after a failed session/);
  accepts(procRow(990, 1, "/system.slice/cron.service", 9999));
  const between = fixture("setup-drain-two-between", { drain: true, failedRows: [0, 1] });
  assert.equal(between.rejected, true); assert.match(between.reason, /process started during or after a failed session/);
});

// The drain query is a hand copy of the guardian's setup_query. Derive it from the current
// guardian function plus only the known drain insertions, so a change to either side fails here.
const pythonFunction = (source, name) => {
  const lines = source.split("\n"), start = lines.indexOf(`def ${name}(root, expected):`);
  assert.ok(start >= 0 && lines.lastIndexOf(`def ${name}(root, expected):`) === start, name);
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || lines[end].startsWith(" "))) end++;
  while (lines[end - 1] === "") end--;
  return lines.slice(start, end).join("\n") + "\n";
};
const drainEdits = [
  // Drain insertions: the expected failures, a drained entry per failed row, and none left over.
  ["def setup_query(root, expected):\n", `def setup_drain_query(root, expected):
    # setup_query, except that each expected failed watcher gets setup_drained_session
    # instead of its missing receipt. Every other check and the order stay the same.
    failures = expected["watcherFailures"]
    assert isinstance(failures, list) and 0 < len(failures) <= len(expected["requests"])
    failed = {failure["id"]: failure for failure in failures}
    assert len(failed) == len(failures)
`],
  ["    receipts, watchers = [], []\n", "    receipts, watchers, drained = [], [], []\n"],
  [`        names = ("request", "start", "launcher", "registration") + (() if sequence == len(requests) else ("result", "receipt"))
`, `        failure = failed.pop(invocation["id"], None)
        assert failure is None or (sequence < len(requests) and request["epoch"] == "bootstrap"), "drain expectation differs"
        names = ("request", "start", "launcher", "registration") + (() if sequence == len(requests)
                                                                    else ("result", "watch-failure") if failure else ("result", "receipt"))
`],
  ["        if sequence < len(requests):\n", `        if failure:
            receipts.append(None)
            watchers.append(None)
            drained.append(setup_drained_session(root, request, failure))
        elif sequence < len(requests):
`],
  ["            watchers.append(terminal)\n", `            watchers.append(terminal)
    assert not failed, "drain expectation differs"
`],
  // Start-time check: nothing outside the live query's set started with or after a failed session.
  ["    entries, total = [], 0\n", `    # A failed session's process can leave both its scope and its parent (systemd-run --scope,
    # then reparenting to PID 1), so neither cgroup nor parentage finds it. Every process outside
    # the live query's own set must have started before the earliest failed session's first
    # process. Later unrelated processes refuse too; that is accepted. The live query's SSH
    # listener is exempt below, so it must be the listener (PID and start time) that served
    # every failed session, which therefore predates it.
    for entry in drained:
        assert key(entry["registration"]["listener"]) == key(registration["listener"]), "listener differs from a failed session"
    fence = min(int(p["startTicks"]) for entry in drained for p in entry["registration"]["session"]["chain"])
    for row in rows.values():
        if row["pid"] not in allowed and not kernel_thread(row):
            assert int(row["startTicks"]) < fence, "process started during or after a failed session"
    sockets = docker_runtime(rows)
    entries, total = [], 0
`],
  // Six-record custody check for every failed row.
  [`    assert {p["name"] for p in copied} >= {"helper.py", "binding.json"}
`, `    assert {p["name"] for p in copied} >= {"helper.py", "binding.json"}
    assert {name + "-" + failure["id"] + ".json" for failure in failures for name in DRAINED_RECORDS} <= {p["name"] for p in copied}, "failed watcher record missing from custody"
`],
  // v2 schema with the drained entries.
  [`"benchmark-control-setup-query/v1"`, `"benchmark-control-setup-query/v2"`],
  [`"receipts": receipts, "watchers": watchers, "registration"`, `"receipts": receipts, "watchers": watchers, "drained": drained, "registration"`],
  // Docker socket observation, refused unless every path is absent.
  [`"entries": entries, "custody": copied}`, `"entries": entries, "custody": copied, "dockerSockets": sockets}`],
];

test("setup_drain_query is the guardian's setup_query with only the known drain insertions", () => {
  let derived = pythonFunction(guardianSource, "setup_query");
  for (const [before, after] of drainEdits) {
    assert.equal(derived.split(before).length, 2, `setup_query no longer has exactly one: ${before.trim().slice(0, 80)}`);
    derived = derived.replace(before, () => after);
  }
  assert.equal(pythonFunction(setupDrainSource, "setup_drain_query"), derived, "setup_drain_query drifted from setup_query");
  // The guardian itself stays the hashed, unchanged source, and the drain source shadows none of
  // its definitions: every top-level name the drain source defines is new to the namespace.
  const topLevel = setupDrainSource.split("\n").filter((line) => line !== "" && !/^[\s#]/.test(line));
  const defined = topLevel.map((line) => /^(?:(?:def|class) )?([A-Za-z_]\w*)\s*(?:\(|=(?!=))/.exec(line)?.[1]);
  assert.ok(defined.every(Boolean), "unrecognized top-level drain statement");
  assert.ok(defined.includes("setup_drain_query") && defined.includes("setup_drained_session"));
  for (const name of defined) {
    assert.ok(!guardianSource.includes(name), name);
    assert.doesNotMatch(guardianSource, new RegExp(`^\\s*(?:(?:async\\s+)?def|class)\\s+${name}\\b|^\\s*${name}\\s*(?::[^=\\n]*)?=(?!=)`, "m"), name);
  }
});

test("only a watcher record that cannot select the drain proof is a missing proof; a custody read failure keeps its own error", (t) => {
  const f = fixture("setup-drain-normal", { drain: true }), failed = f.expected.watcherFailures[0].id;
  const { local, custody } = custodyFolder(t, f), path = join(custody, `watch-failure-${failed}.json`);
  const missing = (state, pattern) => assert.throws(() => setupWatcherFailures(state, local),
    (error) => error instanceof SetupWatcherProofMissing && pattern.test(error.message));
  const unreadable = (state, at, pattern) => assert.throws(() => setupWatcherFailures(state, at),
    (error) => !(error instanceof SetupWatcherProofMissing) && pattern.test(error.message));
  writeFileSync(path, '{"helperLine":0}\n'); missing(f.state, /not a drainage deadline expiry/);
  writeFileSync(path, Buffer.alloc(5000, 0x20)); missing(f.state, /not a drainage deadline expiry/);
  writeFileSync(path, deadlineFailure);
  const receipt = join(custody, `receipt-${failed}.json`);
  writeFileSync(receipt, "{}\n"); missing(f.state, /beside its receipt/); unlinkSync(receipt);
  const unknown = structuredClone(f.state); unknown.control.ledger[0].request.invocation.id = "e".repeat(32);
  missing(unknown, /outside the settled bootstrap ledger/);
  // An unsettled row, or one whose code is not an integer, is not a settled bootstrap row either.
  for (const change of [{ localTerminal: false }, { code: "0" }, { code: 0.5 }]) {
    const row = structuredClone(f.state); Object.assign(row.control.ledger[0], change); missing(row, /outside the settled bootstrap ledger/);
  }
  const ledgerless = structuredClone(f.state); delete ledgerless.control; missing(ledgerless, /without a control ledger/);
  assert.deepEqual(setupWatcherFailures(f.state, local), [{ id: failed, failureSha256: digest(deadlineFailure) }]);
  // A second link makes the bounded read of the record refuse.
  const link = join(local, "linked-watch-failure.json"); linkSync(path, link);
  unreadable(f.state, local, /bounded regular unlinked file required/); unlinkSync(link);
  // A non-physical custody path refuses with no watcher failure to read.
  const other = mkdtempSync(join(tmpdir(), "owned-control-retirement-"));
  t.after(() => { assert.ok(other.startsWith(join(tmpdir(), "owned-control-retirement-"))); rmSync(other, { recursive: true, force: true }); });
  mkdirSync(join(other, f.state.evidence)); writeFileSync(join(other, f.state.evidence, "control"), "not a folder\n");
  unreadable(f.state, other, /physical directory required/);
});
