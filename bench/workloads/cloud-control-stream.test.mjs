import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { registration, binding } from "./test-fixtures/control-stream-fixture.mjs";
import { livePeerLease, localStreamStatus, queueStreamAudit, requireUnfinishedJournal, streamRecoveryReady, verifyAuditInventory } from "./cloud-control-stream.mjs";
import { shellTransport } from "./cloud-transport.mjs";
import { auditProtocol } from "./cloud-audit.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { digest, fileHash } from "./cloud-local.mjs";
import { leaseState, streamLimits } from "./isolated/control-stream.mjs";

function manifest(entries = [{ path: "", type: "directory" }, { path: "blobs", type: "directory" }]) {
  const body = { files: [], snapshot: { entries, sha256: deploymentSha256(entries) } };
  return { ...body, sha256: deploymentSha256(body) };
}

function fixture(t, { autoClose = true, sealExec, peerLease, initialActive = true, onInput } = {}) {
  const local = mkdtempSync(join(tmpdir(), "corten-control-wire-")), child = new EventEmitter(), input = [], calls = [];
  let sequence = 0, ended = false;
  const close = (code = 0) => { if (!ended) { ended = true; child.emit("close", code, null); } };
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(bytes, encoding, next) {
    for (const line of bytes.toString().trimEnd().split("\n")) {
      const frame = JSON.parse(line); onInput?.(frame, local); input.push(frame);
      if (frame.kind === "close") setImmediate(close);
    }
    next();
  } });
  child.stdin.on("close", () => { if (autoClose && !ended) setImmediate(() => close(254)); });
  const frame = (kind, payload, override = {}) => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1", id: registration.id,
    sequence: ++sequence, kind, payload, ...override }) + "\n");
  const run = shellTransport({ repo: resolve("."), sealExec, spawn() { assert.fail("unexpected synchronous transport"); }, streamSpawn(binary, argv, options) {
    calls.push({ binary, argv, options }); setImmediate(() => { frame("registered", registration); if (initialActive) frame("progress", { state: "active" }); }); return child;
  } });
  const ready = run("ssh", ["-o", "UserKnownHostsFile=" + join(local, "known_hosts").replaceAll("\\", "/"), "root@192.0.2.2"], 30000, false, undefined,
    { stream: true, expected: { binding, id: registration.id }, local, peerLease });
  t.after(() => { close(254); assert.ok(resolve(local).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))); rmSync(local, { recursive: true }); });
  return { local, child, input, calls, ready, frame, close, run };
}

async function waitForCells(local, started) {
  const deadline = performance.now() + 2000;
  do {
    const status = localStreamStatus(local, { includeCells: true });
    if (status.nativeCellProgress?.started === started) return status;
    await delay(10);
  } while (performance.now() < deadline);
  assert.fail("optional cell progress did not publish");
}

test("optional counts belong only to the matching active Hardening campaign", async (t) => {
  const f = fixture(t), result = await f.ready;
  const active = { round: binding.round, campaign: "r21-0123456789abcdef", state: "active", nextGroup: "hardening" };
  const count = (started, status = active) => f.frame("progress", { ...status, nativeCellProgress: { started, total: 108 } });
  const unnamed = { ...active, campaign: undefined };
  f.frame("progress", unnamed);
  count(100, unnamed);
  f.frame("progress", active);
  count(2);
  await waitForCells(f.local, 2);
  assert.equal(localStreamStatus(f.local).nativeCellProgress, undefined);
  count(100, { ...active, campaign: "r21-fedcba9876543210" });
  count(4);
  assert.deepEqual((await waitForCells(f.local, 4)).nativeCellProgress, { started: 4, total: 108 });
  f.frame("progress", { ...active, nextGroup: "mixed-production" });
  count(5);
  assert.equal(localStreamStatus(f.local, { includeCells: true }).nativeCellProgress, undefined);
  f.close(255);
  await result.monitor.done;
});

test("production transport uses one fixed guardian exec, bounded journal, typed heartbeat and terminal close without remote-empty claims", async (t) => {
  const f = fixture(t), result = await f.ready;
  assert.equal(f.calls.length, 1); const { binary, argv, options } = f.calls[0]; assert.equal(binary, "ssh");
  assert.deepEqual(argv.slice(0, 2), ["-F", "none"]); assert.ok(argv.includes("ControlMaster=no") && argv.includes("ClearAllForwardings=yes"));
  assert.ok(argv.includes('UserKnownHostsFile="' + join(f.local, "known_hosts").replaceAll("\\", "/") + '"'));
  assert.ok(argv.at(-1).startsWith("/usr/bin/python3 -I /run/corten-bench-control-" + binding.token + "/helper.py monitor " + binding.token + " "));
  assert.equal(options.shell, false); assert.equal(options.cwd, resolve("."));
  f.frame("challenge", { sequence: 1, nonce: "e".repeat(32) }); assert.equal(f.input.at(-1).kind, "renew");
  const nativeCellProgress = { started: 19, total: 108 };
  const status = { round: binding.round, campaign: "r21-0123456789abcdef", state: "active", nextGroup: "hardening" };
  f.frame("progress", status);
  f.frame("progress", { ...status, nativeCellProgress });
  const progress = await waitForCells(f.local, nativeCellProgress.started);
  assert.equal(progress.kind, "progress");
  assert.deepEqual(progress.nativeCellProgress, nativeCellProgress);
  assert.equal(existsSync(join(f.local, "monitor-terminal.json")), false);
  f.frame("terminal", { id: registration.id, campaign: "r21-0123456789abcdef", nativeTerminal: true, sealSha256: "f".repeat(64) });
  const done = await result.monitor.done; assert.equal(done.terminal, true); assert.equal(done.remoteDrained, false);
  assert.equal(streamRecoveryReady(f.local, { id: registration.id, registrationSha256: (await import("./cloud-local.mjs")).digest(JSON.stringify(registration)) }), false);
  const journal = readFileSync(join(f.local, "monitor-journal.jsonl"), "utf8"); assert.ok(journal.length < 8192); assert.ok(!journal.includes('"remoteDrained":true'));
});

test("hung optional cell storage cannot consume the peer lease or delay terminal", async (t) => {
  const f = fixture(t, { initialActive: false, peerLease: true }), { monitor } = await f.ready;
  const stage = join(f.local, "monitor-native-cells.json.pending");
  const stalled = Promise.withResolvers(), open = fs.openSync, asyncOpen = fs.promises.open;
  let peerNow = 0n, attempts = 0;
  const peer = leaseState({ now: peerNow }), challenge = peer.challenge(peerNow);
  const sync = t.mock.method(fs, "openSync", (path, ...args) => {
    // Simulate the independent peer clock advancing while a synchronous open blocks.
    if (path === stage) peerNow += BigInt(streamLimits.leaseMs) * 1000000n;
    return open(path, ...args);
  });
  t.mock.method(fs.promises, "open", async (path, ...args) => {
    if (path !== stage) return asyncOpen(path, ...args);
    attempts++;
    await stalled.promise;
    throw new Error("optional storage did not open");
  });
  syncBuiltinESMExports();
  try {
    const status = { round: binding.round, campaign: "r21-0123456789abcdef", state: "active", nextGroup: "hardening" };
    f.frame("progress", status);
    for (const started of [1, 2, 3])
      f.frame("progress", { ...status, nativeCellProgress: { started, total: 108 } });
    f.frame("challenge", challenge);
    assert.deepEqual(f.input.at(-1), { id: registration.id, kind: "renew", payload: challenge });
    peer.renew(f.input.at(-1).payload, peerNow);
    assert.equal(attempts, 1, "only one optional write can be in flight");
    f.frame("terminal", { id: registration.id, nativeTerminal: true, sealSha256: "f".repeat(64) });
    assert.equal((await monitor.done).terminal, true);
    assert.equal(localStreamStatus(f.local).kind, "terminal");
    assert.equal(existsSync(join(f.local, "monitor-invalid.json")), false);
  } finally {
    stalled.resolve();
    sync.mock.restore(); syncBuiltinESMExports();
  }
  await new Promise(setImmediate);
  assert.equal(attempts, 1, "terminal drops waiting optional writes");
});

for (const started of [2, 109]) test(`counts-first (${started}/108) cannot establish a peer lease`, async (t) => {
  const f = fixture(t, { initialActive: false, peerLease: true }), { monitor } = await f.ready;
  const state = { ...binding, name: registration.host.hostname, control: { helperSha256: binding.helperSha256,
    monitor: { id: registration.id, registrationSha256: digest(JSON.stringify(registration)) } } };
  const journal = join(f.local, "monitor-journal.jsonl"), registered = readFileSync(journal);
  const payload = { round: binding.round, campaign: "r21-0123456789abcdef", state: "active", nextGroup: "hardening",
    nativeCellProgress: { started, total: 108 } };
  f.frame("progress", payload);
  f.frame("progress", payload);
  f.frame("challenge", { sequence: 1, nonce: "e".repeat(32) });
  assert.equal(f.input.at(-1).kind, "renew");
  assert.equal(livePeerLease(f.local, state), false);
  assert.deepEqual(readFileSync(journal), registered);
  assert.equal(localStreamStatus(f.local, { includeCells: true }).nativeCellProgress, undefined);
  assert.equal(existsSync(join(f.local, "monitor-native-cells.json.pending")), false);
  assert.equal(existsSync(join(f.local, "monitor-native-cells.json")), false);
  f.frame("terminal", { id: registration.id, nativeTerminal: true, sealSha256: "f".repeat(64) });
  assert.equal((await monitor.done).terminal, true);
});

test("a torn workstation cell update leaves custody intact and only the newest waiting count publishes", async (t) => {
  const f = fixture(t, { peerLease: true }), { monitor } = await f.ready;
  const state = { ...binding, name: registration.host.hostname, control: { helperSha256: binding.helperSha256,
    monitor: { id: registration.id, registrationSha256: digest(JSON.stringify(registration)) } } };
  const journal = join(f.local, "monitor-journal.jsonl");
  const status = { round: binding.round, campaign: "r21-0123456789abcdef", state: "active", nextGroup: "hardening" };
  f.frame("progress", status);
  const initial = readFileSync(journal);
  const progress = (started) => f.frame("progress", { ...status, nativeCellProgress: { started, total: 108 } });
  const stage = join(f.local, "monitor-native-cells.json.pending"), open = fs.promises.open;
  const torn = Promise.withResolvers(), resume = Promise.withResolvers(), writes = [];
  t.mock.method(fs.promises, "open", async (path, ...args) => {
    const file = await open(path, ...args);
    if (path !== stage) return file;
    return {
      close: () => file.close(),
      async writeFile(data) {
        const { started } = JSON.parse(data);
        writes.push(started);
        if (started !== 1) return file.writeFile(data);
        await file.write(data.slice(0, 3));
        torn.resolve();
        await resume.promise;
        throw Object.assign(new Error("synthetic telemetry disk failure"), { code: "ENOSPC" });
      }
    };
  });
  try {
    progress(1);
    await torn.promise;
    progress(2); progress(3);
    assert.deepEqual(writes, [1]);
    assert.equal(localStreamStatus(f.local, { includeCells: true }).nativeCellProgress, undefined);
    assert.deepEqual(readFileSync(journal), initial);
    requireUnfinishedJournal(journal, registration.id);
  } finally { resume.resolve(); }
  f.frame("challenge", { sequence: 1, nonce: "e".repeat(32) });
  assert.equal(f.input.at(-1).kind, "renew");
  assert.equal(livePeerLease(f.local, state), true);
  const latest = await waitForCells(f.local, 3);
  assert.deepEqual(writes, [1, 3]);
  assert.equal(existsSync(stage), false);
  assert.equal(latest.frame.kind, "peer-lease");
  assert.deepEqual(latest.nativeCellProgress, { started: 3, total: 108 });
  assert.ok(!readFileSync(journal, "utf8").includes("nativeCellProgress"));
  requireUnfinishedJournal(journal, registration.id);
  f.frame("terminal", { id: registration.id, nativeTerminal: true, sealSha256: "f".repeat(64) });
  assert.equal((await monitor.done).terminal, true);
  assert.equal(existsSync(join(f.local, "monitor-invalid.json")), false);
});

test("standalone active progress establishes custody; valid, invalid and duplicate counts never enter it", async (t) => {
  const f = fixture(t, { peerLease: true, initialActive: false }), { monitor } = await f.ready;
  const state = { ...binding, name: registration.host.hostname, control: { helperSha256: binding.helperSha256,
    monitor: { id: registration.id, registrationSha256: digest(JSON.stringify(registration)) } } };
  const journal = join(f.local, "monitor-journal.jsonl");
  const status = { round: binding.round, campaign: "r21-0123456789abcdef", state: "active", nextGroup: "hardening" };
  f.frame("progress", status);
  const active = readFileSync(journal);
  assert.deepEqual(localStreamStatus(f.local).frame.payload, status);
  for (const [started, total] of [[109, 108], [2, 108], [2, 108], [1, 108], [3, 109]]) {
    f.frame("progress", { ...status, nativeCellProgress: { started, total } });
    assert.deepEqual(readFileSync(journal), active);
    assert.equal(livePeerLease(f.local, state), false);
  }
  f.frame("challenge", { sequence: 1, nonce: "e".repeat(32) });
  assert.equal(livePeerLease(f.local, state), true);
  const latest = await waitForCells(f.local, 2);
  assert.equal(latest.frame.kind, "peer-lease");
  assert.deepEqual(latest.nativeCellProgress, { started: 2, total: 108 });
  assert.deepEqual(readFileSync(journal, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).kind),
    ["registered", "progress", "peer-lease"]);
  requireUnfinishedJournal(journal, registration.id);
  f.close(255);
  assert.equal((await monitor.done).terminal, false);
});

test("continuation peer requires a fresh lease tied to its registered native stream", async (t) => {
  const f = fixture(t, { peerLease: true }), { monitor } = await f.ready;
  const s = { ...binding, name: registration.host.hostname, control: { helperSha256: binding.helperSha256,
    monitor: { id: registration.id, registrationSha256: digest(JSON.stringify(registration)) } } };
  assert.equal(livePeerLease(f.local, s), false);
  f.frame("challenge", { sequence: 1, nonce: "e".repeat(32) });
  assert.equal(livePeerLease(f.local, s), true);
  assert.equal(livePeerLease(f.local, { ...s, name: "other" }), false);
  const stale = { kind: "peer-lease", id: registration.id, atMs: Date.now() - streamLimits.leaseMs };
  const journal = join(f.local, "monitor-journal.jsonl");
  appendFileSync(journal, JSON.stringify(stale));
  assert.equal(livePeerLease(f.local, s), true, "an unterminated write is not a lease record");
  appendFileSync(journal, "\n" + JSON.stringify({ kind: "progress", id: registration.id }) + "\n");
  assert.equal(livePeerLease(f.local, s), false);
  f.close(255);
  assert.equal((await monitor.done).terminal, false);
});

test("continuation peer keeps its lease across nonterminal journal records but not a terminal frame", async (t) => {
  const f = fixture(t, { peerLease: true }), { monitor } = await f.ready;
  const s = { ...binding, name: registration.host.hostname, control: { helperSha256: binding.helperSha256,
    monitor: { id: registration.id, registrationSha256: digest(JSON.stringify(registration)) } } };
  f.frame("challenge", { sequence: 1, nonce: "e".repeat(32) });
  f.frame("progress", { state: "active" });
  assert.equal(livePeerLease(f.local, s), true, "a progress record is not lease loss");
  for (let i = 0; i < 3; i++) f.frame("progress", { state: "active", details: "x".repeat(50000) });
  f.frame("delivery-sealed", { campaign: "r21-0123456789abcdef" });
  assert.equal(livePeerLease(f.local, s), true, "look past nonterminal records even across the tail read boundary");
  for (const kind of ["invalid", "local-closed"]) {
    const marker = join(f.local, `monitor-${kind}.json`);
    writeFileSync(marker, "{}", { flag: "wx" });
    try { assert.equal(livePeerLease(f.local, s), false, `a fresh lease does not override ${kind}`); }
    finally { rmSync(marker); }
  }
  f.frame("terminal", { id: registration.id, campaign: "r21-0123456789abcdef", nativeTerminal: true, sealSha256: "f".repeat(64) });
  assert.equal(existsSync(join(f.local, "monitor-terminal.json")), false, "local stream has not closed");
  assert.equal(livePeerLease(f.local, s), false);
  assert.equal((await monitor.done).terminal, true);
  assert.equal(livePeerLease(f.local, s), false);
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

test("the live stream answers a lease challenge while its seal SSH is outstanding", async (t) => {
  let finish;
  const f = fixture(t, { sealExec(_exe, _argv, _options, cb) { finish = cb; return { stdin: new PassThrough() }; } });
  const { monitor } = await f.ready, id = registration.id;
  const pending = f.run("ssh", ["root@192.0.2.2", ":"], 60000, false, undefined, {
    command: "fixed guardian", request: { invocation: { id }, seal: [{ id }] } });
  const challenge = { sequence: 1, nonce: "c".repeat(32) };
  await new Promise((resolve) => setImmediate(() => { f.frame("challenge", challenge); resolve(); }));
  assert.deepEqual(f.input.at(-1), { id, kind: "renew", payload: challenge });
  finish(null, "", "CORTEN_CONTROL " + id + " " + "b".repeat(64) + "\nCORTEN_RESULT " + id + " 0\n");
  assert.equal((await pending).status, 0); f.close(255); await monitor.done;
});

test("late close is actual local evidence even after the foreground lost the lease", async (t) => {
  const f = fixture(t, { autoClose: false }), { monitor } = await f.ready;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  monitor.cancel(); t.mock.timers.tick(15001);
  await assert.rejects(monitor.done, (error) => error.controlTreeUncertain === true);
  const path = join(f.local, "monitor-local-closed.json");
  assert.equal(existsSync(path), false);
  f.child.stderr.write("do not retain raw ssh diagnostics\nCORTEN_MONITOR_");
  f.child.stderr.write("FAULT " + registration.id + " 251\n");
  f.close(255);
  const record = JSON.parse(readFileSync(path));
  assert.equal(record.helperLine, 251); assert.ok(!JSON.stringify(record).includes("do not retain"));
  assert.equal(record.code, 255); assert.equal(record.signal, null);
  assert.equal(record.remoteDrained, false); assert.equal(record.recoverAfterMs - record.closedAtMs, 30000);
  assert.equal(localStreamStatus(f.local).kind, "invalid");
  assert.equal(existsSync(join(f.local, "monitor-terminal.json")), false);
  const saved = { id: registration.id, registrationSha256: digest(JSON.stringify(registration)) };
  assert.equal(streamRecoveryReady(f.local, saved), false);
  t.mock.timers.tick(30000); assert.equal(streamRecoveryReady(f.local, saved), true);
});

async function queuedAudit(t, onInput, group = "json-api") {
  const f = fixture(t, { onInput }), result = await f.ready, campaign = "r21-0123456789abcdef", protocol = auditProtocol(group);
  const mixed = group === "mixed-production";
  const body = { schema: `benchmark-${protocol.prefix}-audit-subject/v1`, commit: binding.commit, campaignSha256: "f".repeat(64),
    ...(mixed ? { requests: protocol.members.map((identity) => ({ identity })) } : { identities: protocol.members }), sourcesManifest: manifest() };
  const subjectSha256 = deploymentSha256(body), bytes = Buffer.from(JSON.stringify({ ...body, subjectSha256 }));
  f.frame("audit-begin", { campaign, group, subjectSha256 });
  f.frame("audit-file", { group, path: `${protocol.prefix}-audit-subject.json`, bytes: bytes.length, sha256: digest(bytes) });
  f.frame("audit-data", { offset: 0, data: bytes.toString("base64") }); f.frame("audit-file-end", {}); f.frame("audit-end", { group, subjectSha256 });
  writeFileSync(join(f.local, "operation.lock"), "test monitor custody");
  writeFileSync(join(f.local, "audit-delivery.lock"), "test approved publisher custody");
  const delivery = { schema: protocol.schema, subjectSha256,
    review: { subjectSha256, decision: "approved", findings: [], reviewer: "test reviewer", reviewedAt: "2026-11-17T12:00:00.000Z" },
    bundle: { schema: mixed ? "mixed-native-source-audits/v1" : "json-api-native-audits/v2", receipts: protocol.members.map((identity) => ({ identity })) } };
  const path = join(f.local, "approval.json"); writeFileSync(path, JSON.stringify(delivery));
  const state = { round: binding.round, commit: binding.commit, token: binding.token,
    control: { helperSha256: binding.helperSha256, monitor: { id: registration.id, registrationSha256: digest(JSON.stringify(registration)), phase: "live" } } };
  queueStreamAudit(f.local, state, { deliverAudit: path, campaign, auditGroup: group, approveSubject: subjectSha256 }, digest(readFileSync(path)));
  const queued = join(f.local, `monitor-delivery-${group}.json`);
  assert.ok(!existsSync(queued + ".pending"));
  assert.equal(digest(readFileSync(queued)), digest(readFileSync(path)));
  return { f, result, group, campaign, subjectSha256, state, path, queued, delivery };
}

for (const group of ["json-api", "mixed-production"]) {
  test(`${group} audit custody never reads the optional Hardening status file`, async (t) => {
    const stat = fs.lstatSync;
    let sidecarReads = 0;
    const hook = t.mock.method(fs, "lstatSync", (path, ...args) => {
      if (String(path).endsWith("monitor-native-cells.json")) { sidecarReads++; throw new Error("optional storage unavailable"); }
      return stat(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      const { f, result, path } = await queuedAudit(t, undefined, group);
      const deadline = performance.now() + 2000;
      while (!f.input.some(({ kind }) => kind === "delivery-end") && performance.now() < deadline) await delay(10);
      assert.equal(f.input.filter(({ kind }) => kind === "delivery-begin").length, 1);
      assert.deepEqual(Buffer.concat(f.input.filter(({ kind }) => kind === "delivery-data")
        .map(({ payload }) => Buffer.from(payload.data, "base64"))), readFileSync(path));
      f.close(255); await result.monitor.done;
      assert.equal(sidecarReads, 0);
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
  });
}

test("paused audit material and approved delivery use the same existing stream, never another process or channel", async (t) => {
  let approvalPresentAtBegin;
  const { f, result, group, campaign, subjectSha256, state, path } = await queuedAudit(t, (frame, local) => {
    if (frame.kind === "delivery-begin") approvalPresentAtBegin = existsSync(join(local, "monitor-delivery-json-api.json.approved-sha256"));
  });
  await new Promise((resolve, reject) => { const deadline = Date.now() + 1000; const timer = setInterval(() => {
    if (f.input.some((v) => v.kind === "delivery-end")) { clearInterval(timer); resolve(); }
    else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error("bounded delivery missing")); }
  }, 10); });
  assert.deepEqual(f.input.filter((v) => v.kind.startsWith("delivery-")).map((v) => v.kind), ["delivery-begin", "delivery-data", "delivery-end"]);
  assert.equal(f.input.find(({ kind }) => kind === "delivery-begin").payload.sha256, digest(readFileSync(path)));
  assert.equal(approvalPresentAtBegin, false, "sealed orphan recovery keeps the original file set");
  assert.equal(f.calls.length, 1); assert.throws(() => queueStreamAudit(f.local, state, { deliverAudit: path, campaign, auditGroup: group, approveSubject: subjectSha256 }, digest(readFileSync(path))));
  f.close(255); await result.monitor.done;
});

for (const mode of ["changed delivery", "changed approval", "missing approval"]) {
  test(`the live monitor never begins sending an audit with ${mode}`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { f, result, queued, delivery } = await queuedAudit(t);
    if (mode === "changed delivery") writeFileSync(queued, JSON.stringify({ ...delivery, review: { ...delivery.review, reviewer: "changed review" } }));
    else if (mode === "changed approval") writeFileSync(queued + ".approved-sha256", "0".repeat(64) + "\n");
    else rmSync(queued + ".approved-sha256");
    t.mock.timers.tick(25);
    assert.ok(!f.input.some(({ kind }) => kind.startsWith("delivery-")));
    assert.equal(localStreamStatus(f.local).kind, "invalid");
    f.close(255);
    assert.equal((await result.monitor.done).publicationRevoked, true);
  });
}

function packet(f, content = Buffer.from("source"), count = 1) {
  const group = "mixed-production", campaign = "r21-0123456789abcdef", path = "mixed-audit-sources/contexts/corten.tar";
  const hash = createHash("sha256"); for (let i = 0; i < count; i++) hash.update(content);
  const row = { path: "contexts/corten.tar", type: "file", bytes: content.length * count, sha256: hash.digest("hex") };
  const body = { schema: "benchmark-mixed-audit-subject/v1", commit: binding.commit,
    sourcesManifest: manifest([{ path: "", type: "directory" }, { path: "blobs", type: "directory" }, { path: "contexts", type: "directory" }, row]) };
  const subjectSha256 = deploymentSha256(body), subject = Buffer.from(JSON.stringify({ ...body, subjectSha256 }));
  const intent = { group, campaign, subjectSha256 };
  const header = { group, path, bytes: row.bytes, sha256: row.sha256 };
  const sendFile = (header, value, count = 1) => {
    f.frame("audit-file", header);
    for (let i = 0; i < count; i++) f.frame("audit-data", { offset: i * value.length, data: value.toString("base64") });
    f.frame("audit-file-end", {});
  };
  const begin = () => { f.frame("audit-begin", intent); sendFile({ group, path: "mixed-audit-subject.json", bytes: subject.length, sha256: digest(subject) }, subject); };
  return { intent, header, begin, sendFile, finish: () => f.frame("audit-end", { group, subjectSha256 }) };
}

test("audit receiver streams a 32MiB context beyond the original 24MiB gate and atomically publishes complete custody", async (t) => {
  const f = fixture(t), result = await f.ready, block = Buffer.alloc(streamLimits.auditChunkBytes, 97), count = 1024;
  const p = packet(f, block, count), ready = join(f.local, "monitor-audit-mixed-production-ready.json");
  p.begin(); assert.equal(existsSync(ready), false); p.sendFile(p.header, block, count);
  assert.equal(existsSync(ready), false); assert.equal(existsSync(join(f.local, "monitor-audit-mixed-production")), false);
  p.finish(); assert.ok(existsSync(ready)); assert.equal(existsSync(join(f.local, "monitor-audit-mixed-production.partial")), false);
  assert.equal(fileHash(join(f.local, "monitor-audit-mixed-production", p.header.path), p.header.bytes), p.header.sha256);
  assert.equal(f.calls.length, 1); f.close(255); await result.monitor.done;
});

test("audit inventory rejects aggregate and file-count bounds without allocating the declared content", () => {
  for (const mode of ["aggregate", "count"]) {
    const rows = Array.from({ length: mode === "aggregate" ? 3 : streamLimits.auditFiles }, (_, i) => ({
      path: "contexts/app-" + i + ".tar", type: "file", bytes: mode === "aggregate" ? streamLimits.auditFileBytes : 0, sha256: "a".repeat(64) }));
    const subject = { sourcesManifest: manifest([{ path: "", type: "directory" }, { path: "blobs", type: "directory" }, { path: "contexts", type: "directory" }, ...rows]) };
    const files = new Map(rows.map((row) => ["mixed-audit-sources/" + row.path, row])); files.set("mixed-audit-subject.json", {});
    assert.throws(() => verifyAuditInventory(subject, "mixed-production", files));
  }
});

test("audit ready requires the staged file digest, not just the incoming frames", async (t) => {
  const f = fixture(t), { monitor } = await f.ready, value = Buffer.from("source"), p = packet(f, value);
  p.begin(); f.frame("audit-file", p.header); f.frame("audit-data", { offset: 0, data: value.toString("base64") });
  writeFileSync(join(f.local, "monitor-audit-mixed-production.partial", p.header.path), "broken");
  f.frame("audit-file-end", {}); p.finish();
  try { assert.equal(existsSync(join(f.local, "monitor-audit-mixed-production-ready.json")), false); }
  finally { f.close(255); }
  assert.equal((await monitor.done).terminal, false);
  assert.equal(existsSync(join(f.local, "monitor-audit-mixed-production")), false);
});

for (const mode of ["disconnect", "terminal", "truncated", "hash", "missing", "extra", "oversize", "chunk", "duplicate", "replaced", "hardlink", "alias", "partial"]) {
  test("audit payload intentional negative: " + mode, async (t) => {
    const f = fixture(t), result = await f.ready, value = Buffer.from("source"), p = packet(f, value);
    const stage = join(f.local, "monitor-audit-mixed-production.partial"), target = join(stage, p.header.path);
    if (mode === "partial") mkdirSync(stage);
    p.begin();
    if (mode === "disconnect") { f.frame("audit-file", p.header); f.frame("audit-data", { offset: 0, data: "cw==" }); f.close(255); }
    else if (mode === "terminal") f.frame("terminal", { id: registration.id, nativeTerminal: true, sealSha256: "f".repeat(64) });
    else if (mode === "truncated") { f.frame("audit-file", p.header); f.frame("audit-file-end", {}); }
    else if (mode === "hash") p.sendFile({ ...p.header, sha256: "0".repeat(64) }, value);
    else if (mode === "missing") p.finish();
    else if (mode === "extra") { p.sendFile(p.header, value); p.sendFile({ ...p.header, path: "mixed-audit-sources/contexts/extra.tar" }, value); p.finish(); }
    else if (mode === "oversize") f.frame("audit-file", { ...p.header, bytes: streamLimits.auditFileBytes + 1 });
    else if (mode === "chunk") { f.frame("audit-file", { ...p.header, bytes: 65536 }); f.frame("audit-data", { offset: 0, data: Buffer.alloc(32769).toString("base64") }); }
    else if (mode === "duplicate") { p.sendFile(p.header, value); f.frame("audit-file", p.header); }
    else if (mode === "replaced" || mode === "hardlink") {
      p.sendFile(p.header, value);
      if (mode === "hardlink") linkSync(target, join(f.local, "second-link")); else writeFileSync(target, "tamper");
      p.finish();
    } else if (mode === "alias") {
      const outside = join(f.local, "outside"); mkdirSync(outside); mkdirSync(join(stage, "mixed-audit-sources"));
      symlinkSync(outside, join(stage, "mixed-audit-sources/contexts"), process.platform === "win32" ? "junction" : "dir");
      f.frame("audit-file", p.header);
    }
    const done = await result.monitor.done;
    assert.equal(done.terminal, false); assert.equal(done.publicationRevoked, true);
    assert.equal(existsSync(join(f.local, "monitor-audit-mixed-production-ready.json")), false);
    assert.equal(existsSync(join(f.local, "monitor-audit-mixed-production")), false);
  });
}
