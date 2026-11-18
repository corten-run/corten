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
import { setupEvidence, terminalSetupScript } from "./cloud-retirement.mjs";

function fixture(mode) {
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
  const script = terminalSetupScript(state, 1), files = Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  const expected = { binding: { round: state.round, commit: state.commit, token: state.token, helperSha256: guardianSha256 }, sequence: 2,
    requests: state.control.ledger.map((row) => row.request), queryArgv: ["/usr/bin/python3", "-", state.id, state.unit, JSON.stringify(files), "1"] };
  const request = controlRequest(state, "ssh", ["root@192.0.2.10", script], 1000, "collection");
  request.invocation.id = "3".padStart(32, "0");
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "bench/workloads/test-fixtures/control-session-kernel.py"],
    { cwd: resolve("."), input: JSON.stringify({ source: guardianSource, mode, expected, queryPayload: `set -euo pipefail\n${script}\n`, querySha256: request.invocation.requestSha256 }),
      encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  state.control.ledger.push({ request, localTerminal: true, code: 0 });
  return { ...JSON.parse(result.stdout), state, script, expected };
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
