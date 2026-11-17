import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { registration, binding } from "./test-fixtures/control-stream-fixture.mjs";
import { localStreamStatus, queueStreamAudit, streamRecoveryReady } from "./cloud-control-stream.mjs";
import { shellTransport } from "./cloud-transport.mjs";
import { auditProtocol } from "./cloud-audit.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { digest } from "./cloud-local.mjs";

function fixture(t) {
  const local = mkdtempSync(join(tmpdir(), "corten-control-wire-")), child = new EventEmitter(), input = [], calls = [];
  let sequence = 0, ended = false;
  const close = (code = 0) => { if (!ended) { ended = true; child.emit("close", code, null); } };
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(bytes, encoding, next) {
    for (const line of bytes.toString().trimEnd().split("\n")) { const frame = JSON.parse(line); input.push(frame); if (frame.kind === "close") setImmediate(close); }
    next();
  } });
  child.stdin.on("close", () => { if (!ended) setImmediate(() => close(254)); });
  const frame = (kind, payload, override = {}) => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1", id: registration.id,
    sequence: ++sequence, kind, payload, ...override }) + "\n");
  const run = shellTransport({ repo: resolve("."), streamSpawn(binary, argv, options) {
    calls.push({ binary, argv, options }); setImmediate(() => { frame("registered", registration); frame("progress", { state: "active" }); }); return child;
  } });
  const ready = run("ssh", ["-o", "UserKnownHostsFile=" + join(local, "known_hosts").replaceAll("\\", "/"), "root@192.0.2.2"], 30000, false, undefined,
    { stream: true, expected: { binding, id: registration.id }, local });
  t.after(() => { close(254); assert.ok(resolve(local).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))); rmSync(local, { recursive: true }); });
  return { local, child, input, calls, ready, frame, close };
}

test("production transport uses one fixed guardian exec, bounded journal, typed heartbeat and terminal close without remote-empty claims", async (t) => {
  const f = fixture(t), result = await f.ready;
  assert.equal(f.calls.length, 1); const { binary, argv, options } = f.calls[0]; assert.equal(binary, "ssh");
  assert.deepEqual(argv.slice(0, 2), ["-F", "none"]); assert.ok(argv.includes("ControlMaster=no") && argv.includes("ClearAllForwardings=yes"));
  assert.ok(argv.includes('UserKnownHostsFile="' + join(f.local, "known_hosts").replaceAll("\\", "/") + '"'));
  assert.ok(argv.at(-1).startsWith("/usr/bin/python3 -I /run/corten-bench-control-" + binding.token + "/helper.py monitor " + binding.token + " "));
  assert.equal(options.shell, false); assert.equal(options.cwd, resolve("."));
  f.frame("challenge", { sequence: 1, nonce: "e".repeat(32) }); assert.equal(f.input.at(-1).kind, "renew");
  assert.equal(localStreamStatus(f.local).kind, "progress");
  f.frame("terminal", { id: registration.id, campaign: "r21-0123456789abcdef", nativeTerminal: true, sealSha256: "f".repeat(64) });
  const done = await result.monitor.done; assert.equal(done.terminal, true); assert.equal(done.remoteDrained, false);
  assert.equal(streamRecoveryReady(f.local, { id: registration.id, registrationSha256: (await import("./cloud-local.mjs")).digest(JSON.stringify(registration)) }), false);
  const journal = readFileSync(join(f.local, "monitor-journal.jsonl"), "utf8"); assert.ok(journal.length < 8192); assert.ok(!journal.includes('"remoteDrained":true'));
});

test("disconnect, wrong sequence and unknown input are separate intentional negatives and retain invalidation", async (t) => {
  for (const mode of ["disconnect", "sequence", "unknown"]) {
    const f = fixture(t), result = await f.ready;
    if (mode === "disconnect") f.close(255);
    else f.frame(mode === "unknown" ? "untyped" : "progress", {}, mode === "sequence" ? { sequence: 999 } : {});
    const done = await result.monitor.done; assert.equal(done.terminal, false); assert.equal(done.publicationRevoked, true);
    assert.equal(localStreamStatus(f.local).kind, "invalid"); assert.ok(existsSync(join(f.local, "monitor-local-closed.json")));
    assert.equal(JSON.parse(readFileSync(join(f.local, "monitor-invalid.json"))).remoteTerminal, false);
  }
});

test("paused audit material and approved delivery use the same existing stream, never another process or channel", async (t) => {
  const f = fixture(t), result = await f.ready, group = "json-api", campaign = "r21-0123456789abcdef", protocol = auditProtocol(group);
  const body = { schema: "benchmark-json-audit-subject/v1", commit: binding.commit, campaignSha256: "f".repeat(64), identities: protocol.members };
  const subjectSha256 = deploymentSha256(body), bytes = Buffer.from(JSON.stringify({ ...body, subjectSha256 }));
  f.frame("audit-begin", { campaign, group, subjectSha256 });
  f.frame("audit-file", { group, path: "json-audit-subject.json", bytes: bytes.length, sha256: digest(bytes) });
  f.frame("audit-data", { offset: 0, data: bytes.toString("base64") }); f.frame("audit-file-end", {}); f.frame("audit-end", { group, subjectSha256 });
  writeFileSync(join(f.local, "operation.lock"), "test monitor custody");
  const delivery = { schema: protocol.schema, subjectSha256,
    review: { subjectSha256, decision: "approved", findings: [], reviewer: "test reviewer", reviewedAt: "2026-11-17T12:00:00.000Z" },
    bundle: { schema: protocol.bundleSchema, receipts: protocol.members.map((identity) => ({ identity })) } };
  const path = join(f.local, "approval.json"); writeFileSync(path, JSON.stringify(delivery));
  const state = { round: binding.round, commit: binding.commit, token: binding.token,
    control: { helperSha256: binding.helperSha256, monitor: { id: registration.id, registrationSha256: digest(JSON.stringify(registration)), phase: "live" } } };
  queueStreamAudit(f.local, state, { deliverAudit: path, campaign, auditGroup: group, approveSubject: subjectSha256 });
  await new Promise((resolve, reject) => { const deadline = Date.now() + 1000; const timer = setInterval(() => {
    if (f.input.some((v) => v.kind === "delivery-end")) { clearInterval(timer); resolve(); }
    else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error("bounded delivery missing")); }
  }, 10); });
  assert.deepEqual(f.input.filter((v) => v.kind.startsWith("delivery-")).map((v) => v.kind), ["delivery-begin", "delivery-data", "delivery-end"]);
  assert.equal(f.calls.length, 1); assert.throws(() => queueStreamAudit(f.local, state, { deliverAudit: path, campaign, auditGroup: group, approveSubject: subjectSha256 }));
  f.close(255); await result.monitor.done;
});
