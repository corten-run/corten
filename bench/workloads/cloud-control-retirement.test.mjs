// Fixed production source with synthetic kernel observations only. No host operations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { reservation } from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";
import { controlRequest, guardianSource, guardianSha256 } from "./cloud-control-runtime.mjs";
import { verifyControlSetupQuery } from "./cloud-control-session.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { setupEvidence, setupWatcherFailures, terminalSetupScript, watcherDeadlineFailure } from "./cloud-retirement.mjs";
import setupDrainSource from "./cloud-setup-drain-source.mjs";

// The guardian records only this line when a watcher misses its drainage deadline.
const deadlineLine = guardianSource.split("\n").indexOf('    raise AssertionError("remote session drainage deadline expired")') + 1;
const deadlineFailure = `{"helperLine":${deadlineLine}}\n`;
const guardianLine = (text) => {
  const lines = guardianSource.split("\n").flatMap((line, i) => (line.includes(text) ? [i + 1] : []));
  assert.equal(lines.length, 1, text); return lines[0];
};
// A synthetic /proc row: stat field 4 is the parent, 9 the flags, 22 the start time.
function procRow(pid, ppid, cgroup, ticks, flags = 0) {
  const fields = Array(49).fill("0"); fields[0] = String(ppid); fields[5] = String(flags); fields[18] = String(ticks);
  return { pid, startTicks: String(ticks), cgroup: `0::${cgroup}\n`, stat: `${pid} (synthetic) S ${fields.join(" ")}\n`,
    executable: { device: "1", inode: String(pid) }, commandSha256: "0".repeat(64) };
}

// A drain fixture holds the first bootstrap session open until its watcher fails.
function fixture(mode, { drain = false, code = 0 } = {}) {
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
  if (drain) { state.control.ledger[0].code = code; state.preBootstrapTerminal = { hostId: state.id, ip: state.ip }; }
  const failures = drain ? [{ id: state.control.ledger[0].request.invocation.id, failureSha256: digest(deadlineFailure) }] : [];
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
  for (const mutate of [
    (p) => { p.drained[0].watcher.ActiveState = "active"; }, (p) => { p.drained[0].watcher.Job = "42"; },
    (p) => { p.drained[0].watcher.MainPID = String(observer.pid); }, (p) => { p.drained[0].result.code = 1; },
    (p) => { p.drained[0].result.transport = "lost"; }, (p) => { p.drained[0].failureSha256 = "f".repeat(64); },
    (p) => { p.drained[0].scope.members = [999]; }, (p) => { p.drained[0].cgroupEvents = "populated 1\nfrozen 0\n"; },
    (p) => { p.receipts[0] = p.receipts[1]; }, (p) => { p.drained = []; }, (p) => { p.schema = "benchmark-control-setup-query/v1"; },
    (p) => { p.observation.processes.push(structuredClone(drained.registration.first.processes.find((q) => q.pid === chain.at(-1).pid))); },
    (p) => { const row = structuredClone(p.observation.processes.find((q) => q.pid === 1)); row.pid = 999;
      row.stat = row.stat.replace(/^1 \(no-name-authority\) S 0 /, `999 (no-name-authority) S ${chain.at(-1).pid} `); p.observation.processes.push(row); },
  ]) {
    const changed = structuredClone(observation); mutate(changed.control);
    assert.throws(() => setupEvidence(JSON.stringify(changed), f.state, f.script, 1, now - 1, now, local));
  }
  writeFileSync(join(custody, `watch-failure-${failed}.json`), '{"helperLine":1}\n');
  assert.throws(() => setupEvidence(JSON.stringify(observation), f.state, f.script, 1, now - 1, now, local));
});

test("the drain proof refuses residual sessions, live or queued watchers, changed results or failures and extra custody", () => {
  const cases = {
    "setup-drain-scope": /session scope populated/, "setup-drain-chain": /session process remains/,
    "setup-drain-descendant": /session descendant remains/, "setup-drain-active": /watcher unit still active or queued/,
    "setup-drain-queued": /watcher unit still active or queued/, "setup-drain-result": /^KeyError: .*result-/,
    "setup-drain-bytes": /watcher failure differs from the archive/, "setup-drain-extra-record": /unknown control custody member/,
    "setup-drain-stream": /unknown control custody member/, "setup-drain-escaped": /process started during or after a failed session/,
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

test("the drain proof refuses any process that started with or after the failed session, wherever it moved", () => {
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
