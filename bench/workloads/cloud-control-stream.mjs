// One supervised SSH stream. No provider, shell payload, reconnect or status server.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { durable, digest, fileHash, physical, regular, syncDirectory } from "./cloud-local.mjs";
import { streamLimits, verifyApparatus } from "./isolated/control-stream.mjs";
import { auditDelivery } from "./cloud-audit.mjs";
import { deploymentSha256 } from "./deployments.mjs";

function monitorRegistration(local, state) {
  const value = JSON.parse(regular(join(local, "monitor-registration.json"))), monitor = state.control.monitor;
  assert.equal(value.id, monitor.id); assert.equal(digest(JSON.stringify(value)), monitor.registrationSha256);
  assert.deepEqual(value.binding, { round: state.round, commit: state.commit, token: state.token, helperSha256: state.control.helperSha256 });
  verifyApparatus(value.binding, value, { host: value.host, monoNs: value.createdMonoNs, members: value.members, listener: value.listener });
  return value;
}

function auditSubject(local, intent, commit, directory = join(local, "monitor-audit-" + intent.group)) {
  const prefix = intent.group === "json-api" ? "json" : "mixed", path = join(directory, prefix + "-audit-subject.json");
  const subject = JSON.parse(regular(path, streamLimits.deliveryBytes)), { subjectSha256, ...body } = subject;
  assert.equal(subject.schema, "benchmark-" + prefix + "-audit-subject/v1"); assert.equal(subject.commit, commit);
  assert.equal(subjectSha256, intent.subjectSha256); assert.equal(deploymentSha256(body), subjectSha256);
  return subject;
}

// Transfer custody only. This does not approve the subject or attest its builds.
export function verifyAuditInventory(subject, group, files) {
  assert.ok(["json-api", "mixed-production"].includes(group));
  const source = group === "json-api" ? "audit-sources" : "mixed-audit-sources";
  const { sha256, ...manifest } = subject.sourcesManifest;
  assert.equal(deploymentSha256(manifest), sha256, "audit manifest hash differs");
  const { entries } = manifest.snapshot;
  assert.ok(Array.isArray(entries) && entries.length <= streamLimits.auditFiles + 3);
  assert.equal(deploymentSha256(entries), manifest.snapshot.sha256, "audit snapshot hash differs");
  const seen = new Set(), directories = []; let count = 0, total = 0;
  for (const entry of entries) {
    assert.ok(!seen.has(entry.path), "duplicate audit snapshot path"); seen.add(entry.path);
    if (entry.type === "directory") {
      assert.ok(["", "blobs", ...(group === "mixed-production" ? ["contexts"] : [])].includes(entry.path));
      directories.push(entry.path ? source + "/" + entry.path : source);
    } else {
      assert.equal(entry.type, "file");
      assert.match(entry.path, /^(?:blobs\/[a-f0-9]{64}|contexts\/[a-z][a-z0-9-]*\.tar)$/);
      assert.ok(group === "mixed-production" || entry.path.startsWith("blobs/"));
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= streamLimits.auditFileBytes);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      const actual = files.get(source + "/" + entry.path);
      assert.equal(actual?.bytes, entry.bytes, "audit source size/inventory differs");
      assert.equal(actual.sha256, entry.sha256, "audit source hash differs");
      total += entry.bytes; count++;
    }
  }
  assert.ok(seen.has("") && seen.has("blobs"));
  for (const entry of entries.filter((e) => e.type === "file")) assert.ok(seen.has(dirname(entry.path).replaceAll("\\", "/")));
  assert.ok(total <= streamLimits.auditBytes && count < streamLimits.auditFiles);
  assert.equal(files.size, count + 1, "audit export inventory differs");
  return directories.sort((a, b) => a.length - b.length);
}

function auditStat(stat) {
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "audit file alias/type");
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs];
}

function auditDirectory(path) {
  physical(dirname(path));
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) mkdirSync(path, { mode: 0o700 });
  physical(path);
}

function* journalFrames(path, requireComplete = false, maxRowBytes = Infinity) {
  const before = lstatSync(path); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd); assert.ok(opened.ino === before.ino && opened.dev === before.dev);
    const size = opened.size; assert.ok(size <= streamLimits.journalBytes);
    const chunkBytes = 2 * streamLimits.frameBytes;
    let complete = false, suffix = Buffer.alloc(0);
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - chunkBytes), bytes = Buffer.alloc(end - start);
      assert.equal(readSync(fd, bytes, 0, bytes.length, start), bytes.length);
      if (requireComplete && end === size) assert.equal(bytes.at(-1), 10, "incomplete monitor journal");
      const chunk = suffix.length ? Buffer.concat([bytes, suffix]) : bytes;
      let right = chunk.length;
      for (let left = chunk.lastIndexOf(10); left >= 0; left = left === 0 ? -1 : chunk.lastIndexOf(10, left - 1)) {
        if (complete) {
          assert.ok(right - left - 1 <= maxRowBytes, "oversized monitor journal record");
          yield JSON.parse(chunk.toString("utf8", left + 1, right));
        }
        complete = true; right = left; // Ignore the possibly partial write at the snapshot's end.
      }
      if (start === 0 && complete) {
        assert.ok(right <= maxRowBytes, "oversized monitor journal record");
        yield JSON.parse(chunk.toString("utf8", 0, right));
      }
      assert.ok(right <= chunkBytes, "oversized monitor journal record");
      suffix = chunk.subarray(0, right); end = start;
    }
  } finally { closeSync(fd); }
}

export function localStreamStatus(local) {
  physical(local);
  for (const kind of ["invalid", "terminal"]) {
    const path = join(local, `monitor-${kind}.json`);
    if (existsSync(path)) return { kind, ...JSON.parse(regular(path)) };
  }
  const path = join(local, "monitor-journal.jsonl");
  if (!existsSync(path)) return { kind: "pending" };
  for (const frame of journalFrames(path)) return { kind: "progress", frame };
  return { kind: "progress", frame: null };
}

export function livePeerLease(local, state) {
  physical(local);
  const ended = () => ["invalid", "terminal", "local-closed"].some((kind) =>
    lstatSync(join(local, `monitor-${kind}.json`), { throwIfNoEntry: false }) !== undefined);
  const path = join(local, "monitor-journal.jsonl"), { id } = state.control.monitor;
  if (ended() || !existsSync(path)) return false;
  for (const frame of journalFrames(path)) {
    if (frame?.id !== id) return false;
    // A complete terminal frame is decisive even before the close sidecar.
    if (["progress", "audit-begin", "audit-end", "delivery-sealed"].includes(frame.kind)) continue;
    if (frame.kind !== "peer-lease" || !Number.isSafeInteger(frame.atMs)) return false;
    const age = Date.now() - frame.atMs;
    return age >= 0 && age < streamLimits.leaseMs && monitorRegistration(local, state).host.hostname === state.name && !ended();
  }
  return false;
}

export function streamRecoveryReady(local, monitor) {
  const status = localStreamStatus(local); assert.ok(["invalid", "terminal"].includes(status.kind));
  assert.equal(status.id, monitor.id);
  const registration = JSON.parse(regular(join(local, "monitor-registration.json")));
  assert.equal(digest(JSON.stringify(registration)), monitor.registrationSha256); assert.equal(registration.id, monitor.id);
  if (!existsSync(join(local, "monitor-local-closed.json"))) return false;
  const closed = JSON.parse(regular(join(local, "monitor-local-closed.json")));
  assert.equal(closed.id, monitor.id); assert.equal(closed.remoteDrained, false);
  assert.deepEqual(closed.binding, registration.binding); assert.deepEqual(status.binding, registration.binding);
  assert.ok(Number.isSafeInteger(closed.closedAtMs) && closed.closedAtMs > 0);
  assert.equal(closed.recoverAfterMs, closed.closedAtMs + 2 * streamLimits.leaseMs);
  return Date.now() >= closed.recoverAfterMs;
}

function requireAcknowledgedStart(state) {
  assert.ok(state.control.sealed.includes("bootstrap") && state.control.ledger.every(r => r.localTerminal));
  const start = digest(`set -euo pipefail\nsystemctl start ${state.unit}\n`);
  assert.ok(state.control.ledger.some(r => r.request.epoch === "bootstrap" && r.code === 0
    && r.request.invocation.channel === "ssh" && r.request.invocation.requestSha256 === start), "acknowledged unit start required");
}

export function settledMonitor(local, state) {
  const m = state.control.monitor, terminal = localStreamStatus(local);
  assert.ok(m.phase === "closed" && terminal.kind === "terminal" || m.phase === "invalid" && terminal.kind === "invalid",
    "saved monitor is not settled");
  requireAcknowledgedStart(state);
  assert.ok(streamRecoveryReady(local, m), "closed monitor lease required");
  return { registration: monitorRegistration(local, state), terminal };
}

// The workstation stopped before writing a close marker, after an audit delivery.
// This is local custody only. It does not say what happened on the guest.
export function requireOrphanedAuditMonitor(local, state) {
  requireAcknowledgedStart(state);
  const { id, host } = monitorRegistration(local, state), { group, round } = state;
  assert.ok(host.hostname === state.name, "monitor hostname differs");
  const requireJournal = (value) => assert.ok(value, "monitor journal requires reconciliation");
  const now = Date.now(), audit = [];
  let registered = false, leaseNeedsEarlierActive = false, sequence = Infinity, leaseAt = now, lastLease;
  // Journal records are read newest first. Raw audit parts are not journaled.
  for (const frame of journalFrames(join(local, "monitor-journal.jsonl"), true, streamLimits.frameBytes)) {
    requireJournal(!registered && frame?.id === id);
    if (frame.kind === "peer-lease") {
      requireJournal(Number.isSafeInteger(frame.atMs) && frame.atMs > 0 && frame.atMs <= now && frame.atMs <= leaseAt);
      lastLease ??= frame.atMs; leaseAt = frame.atMs; leaseNeedsEarlierActive = true;
      continue;
    }
    const { kind, payload } = frame;
    requireJournal(frame.schema === "benchmark-control-frame/v1" && Number.isSafeInteger(frame.sequence)
      && frame.sequence > 0 && frame.sequence < sequence && payload && typeof payload === "object" && !Array.isArray(payload));
    sequence = frame.sequence;
    if (kind === "registered") {
      requireJournal(sequence === 1 && digest(JSON.stringify(payload)) === state.control.monitor.registrationSha256);
      registered = true;
    } else if (kind === "progress") {
      requireJournal(payload.round === round);
      if (payload.state === "active") leaseNeedsEarlierActive = false;
    } else {
      requireJournal(audit.length < 3 && kind === ["delivery-sealed", "audit-end", "audit-begin"][audit.length]
        && payload.group === group && typeof payload.subjectSha256 === "string" && /^[a-f0-9]{64}$/.test(payload.subjectSha256));
      audit.push(payload);
    }
  }
  requireJournal(registered && !leaseNeedsEarlierActive && audit.length === 3);
  assert.ok(lastLease && now - lastLease >= 2 * streamLimits.leaseMs, "expired peer lease required");
  const [delivery, end, begin] = audit, { campaign, subjectSha256 } = begin;
  requireJournal(typeof campaign === "string" && campaign.startsWith(round + "-") && /^[a-f0-9]{16}$/.test(campaign.slice(round.length + 1))
    && delivery.campaign === campaign && [end, delivery].every((p) => p.subjectSha256 === subjectSha256));
  const queued = regular(join(local, `monitor-delivery-${group}.json`), streamLimits.deliveryBytes);
  assert.ok(delivery.bytes === queued.length && delivery.sha256 === digest(queued), "saved audit delivery differs");
  try { checkedAuditDelivery(local, state, queued, { campaign, auditGroup: group, approveSubject: subjectSha256 }); }
  catch { throw new Error("saved audit delivery differs"); }
}

// A stream can journal a terminal frame before SSH fails and revokes publication.
export function requireUnfinishedJournal(path, monitorId) {
  let registered = false;
  for (const frame of journalFrames(path, true)) {
    assert.ok(frame?.kind === "local-closed" || frame?.id === monitorId
      && ["registered", "progress", "peer-lease"].includes(frame.kind), "monitor journal requires reconciliation");
    if (frame.kind === "registered") registered = true;
  }
  assert.ok(registered, "monitor journal requires reconciliation");
}

export function sealedMonitor(local, state) {
  assert.equal(state.control.monitor.phase, "closed");
  const { registration, terminal } = settledMonitor(local, state);
  const closed = JSON.parse(regular(join(local, "monitor-local-closed.json")));
  assert.ok(closed.code === 0 && closed.signal === null);
  assert.ok(terminal.kind === "terminal" && terminal.nativeTerminal === true && terminal.localClosed === true && terminal.remoteDrained === false);
  assert.match(terminal.sealSha256, /^[a-f0-9]{64}$/);
  return { registration, terminal };
}

function checkedAuditDelivery(local, state, bytes, options) {
  const intent = auditDelivery(bytes, options);
  if (state.group !== undefined) assert.equal(state.group, intent.group);
  const ready = JSON.parse(regular(join(local, "monitor-audit-" + intent.group + "-ready.json")));
  for (const key of ["campaign", "group", "subjectSha256"]) assert.equal(intent[key], ready[key]);
  assert.match(intent.campaign, new RegExp("^" + state.round + "-[a-f0-9]{16}$"));
  const subject = auditSubject(local, intent, state.commit), delivery = JSON.parse(bytes);
  const expected = intent.group === "json-api" ? subject.identities : subject.requests.map((r) => r.identity);
  assert.ok(Array.isArray(expected)); assert.equal(delivery.bundle.receipts.length, expected.length);
  for (const receipt of delivery.bundle.receipts) {
    const wanted = expected.find((value) => value.app === receipt.identity.app && value.key === receipt.identity.key);
    assert.ok(wanted); assert.equal(deploymentSha256(receipt.identity), deploymentSha256(wanted));
  }
  return intent;
}

export function queueStreamAudit(local, state, options, approvedDeliverySha256) {
  assert.ok(state.control.monitor.phase === "live" && existsSync(join(local, "operation.lock")), "foreground monitor required");
  assert.ok(existsSync(join(local, "audit-delivery.lock")), "exclusive audit publisher required");
  monitorRegistration(local, state);
  assert.equal(localStreamStatus(local).kind, "progress");
  const bytes = regular(resolve(options.deliverAudit), streamLimits.deliveryBytes);
  assert.equal(digest(bytes), approvedDeliverySha256, "locked audit delivery changed");
  const intent = checkedAuditDelivery(local, state, bytes, options);
  assert.ok(!existsSync(join(local, "monitor-invalid.json")) && !existsSync(join(local, "monitor-terminal.json")));
  const target = join(local, "monitor-delivery-" + intent.group + ".json"), pending = target + ".pending";
  assert.equal(lstatSync(target, { throwIfNoEntry: false }), undefined, "audit delivery already queued; never repeat");
  durable(pending, bytes);
  durable(target + ".approved-sha256", approvedDeliverySha256 + "\n");
  assert.ok(!existsSync(join(local, "monitor-invalid.json")) && !existsSync(join(local, "monitor-terminal.json")));
  renameSync(pending, target); syncDirectory(local);
}

export function openControlStream({ repo, argv, env, expected, local, launch = spawn, interrupted = () => false, peerLease = false }) {
  physical(local); assert.ok(!existsSync(join(local, "monitor-journal.jsonl")), "monitor cannot restart/adopt a stream");
  const fd = openSync(join(local, "monitor-journal.jsonl"), "wx", 0o600);
  let bytes = 0, sequence = 0, buffer = Buffer.alloc(0), registration, terminal, child, timer, file, audit, auditBytes = 0;
  let nativeEntered = false, lastPeerLease = 0;
  let readyResolve, readyReject, doneResolve, doneReject, settled = false, closing = false, last = Date.now(), deadline = last + streamLimits.maximumMs;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  // The caller awaits done after bootstrap seal. A startup rejection must not leak
  // an unhandled rejection from that second promise.
  done.catch(() => {});
  const uncertain = () => Object.assign(new Error("supervised stream uncertain; preserve locks/state/evidence/host"), { controlTreeUncertain: true });
  const append = (value) => {
    const data = Buffer.from(`${JSON.stringify(value)}\n`); bytes += data.length;
    assert.ok(bytes <= streamLimits.journalBytes);
    let offset = 0; while (offset < data.length) offset += writeSync(fd, data, offset);
    fsyncSync(fd);
  };
  const send = (kind, payload) => {
    const data = `${JSON.stringify({ id: expected.id, kind, payload })}\n`;
    assert.ok(Buffer.byteLength(data) <= streamLimits.frameBytes && child.stdin.writableLength < 131072, "bounded stream backpressure");
    child.stdin.write(data);
  };
  function revoke() {
    if (!existsSync(join(local, "monitor-invalid.json"))) durable(join(local, "monitor-invalid.json"), JSON.stringify({
      id: expected.id, binding: expected.binding, at: new Date().toISOString(), recoverAfterMs: Date.now() + 2 * streamLimits.leaseMs,
      publicationRevoked: true, remoteTerminal: false }));
  }
  function fail() {
    if (settled || closing) return;
    if (file) { closeSync(file.fd); file = undefined; }
    closing = true; revoke(); clearInterval(timer); child?.stdin.destroy();
    // Closing input requests cooperative EOF only. No guessed remote/local kill.
    readyReject(uncertain());
    timer = setTimeout(() => { if (!settled) { closeSync(fd); settled = true; doneReject(uncertain()); } }, streamLimits.leaseMs);
  }
  const replaceProgress = (frame) => {
    // Progress is append-only in the journal; a separate exclusive latest frame
    // is not used, avoiding mutable snapshots racing independent collectors.
    append(frame);
  };
  function accept(frame) {
    assert.deepEqual(Object.keys(frame).sort(), ["id", "kind", "payload", "schema", "sequence"]);
    assert.equal(frame.schema, "benchmark-control-frame/v1"); assert.equal(frame.id, expected.id);
    assert.equal(frame.sequence, ++sequence); assert.ok(sequence <= 1000000);
    const { kind, payload } = frame;
    if (kind === "registered") {
      assert.equal(registration, undefined); verifyApparatus(expected.binding, payload, { host: payload.host, monoNs: payload.createdMonoNs, members: payload.members, listener: payload.listener });
      assert.equal(payload.id, expected.id); registration = payload;
      durable(join(local, "monitor-registration.json"), JSON.stringify(registration)); append(frame);
      readyResolve({ status: 0, stdout: "", stderr: "", monitor: { done, registration, cancel: fail }, remoteDrained: false });
    } else {
      assert.ok(registration && !terminal);
      if (kind === "challenge") {
        assert.match(payload.nonce, /^[a-f0-9]{32}$/); assert.ok(Number.isSafeInteger(payload.sequence) && payload.sequence > 0);
        send("renew", payload); last = Date.now();
        // A fresh challenge from the existing stream, after native entry.
        // This is local custody evidence, not a new remote probe or timing.
        if (peerLease && nativeEntered && last - lastPeerLease >= streamLimits.challengeMs) {
          append({ kind: "peer-lease", id: expected.id, atMs: last });
          lastPeerLease = last;
        }
      } else if (kind === "progress") {
        if (payload.state === "active") nativeEntered = true;
        replaceProgress(frame);
      }
      else if (kind === "audit-begin") {
        assert.equal(audit, undefined); assert.ok(["json-api", "mixed-production"].includes(payload.group));
        assert.match(payload.campaign, /^r[1-9]\d*-[a-f0-9]{16}$/); assert.match(payload.subjectSha256, /^[a-f0-9]{64}$/);
        const root = join(local, "monitor-audit-" + payload.group), stage = root + ".partial";
        assert.equal(lstatSync(root, { throwIfNoEntry: false }), undefined, "audit export already exists");
        mkdirSync(stage, { mode: 0o700 }); physical(stage);
        audit = { ...payload, root, stage, files: new Map() }; auditBytes = 0; append(frame);
      } else if (kind === "audit-file") {
        assert.ok(audit && !file && payload.group === audit.group);
        const prefix = audit.group === "json-api" ? "json" : "mixed", source = prefix === "json" ? "audit-sources" : "mixed-audit-sources";
        const subject = payload.path === prefix + "-audit-subject.json";
        assert.ok(subject || payload.path.startsWith(source + "/") && /^(?:blobs\/[a-f0-9]{64}|contexts\/[a-z][a-z0-9-]*\.tar)$/.test(payload.path.slice(source.length + 1)));
        assert.ok(audit.files.size < streamLimits.auditFiles && !audit.files.has(payload.path), "duplicate/excess audit file");
        assert.ok(Number.isSafeInteger(payload.bytes) && payload.bytes >= 0 && payload.bytes <= (subject ? streamLimits.deliveryBytes : streamLimits.auditFileBytes));
        assert.match(payload.sha256, /^[a-f0-9]{64}$/);
        auditBytes += payload.bytes; assert.ok(auditBytes <= streamLimits.auditBytes, "audit byte limit");
        const path = join(audit.stage, payload.path);
        if (!subject) { auditDirectory(join(audit.stage, source)); auditDirectory(dirname(path)); }
        physical(dirname(path));
        const out = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        file = { ...payload, path, fd: out, hash: createHash("sha256"), size: 0 };
      } else if (kind === "audit-data") {
        assert.ok(file && payload.offset === file.size); assert.match(payload.data, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
        const data = Buffer.from(payload.data, "base64");
        assert.ok(data.length > 0 && data.length <= streamLimits.auditChunkBytes && data.toString("base64") === payload.data);
        file.size += data.length; assert.ok(file.size <= file.bytes);
        let offset = 0; while (offset < data.length) { const n = writeSync(file.fd, data, offset); assert.ok(n > 0); offset += n; }
        file.hash.update(data);
      } else if (kind === "audit-file-end") {
        assert.ok(file && file.size === file.bytes); assert.equal(file.hash.digest("hex"), file.sha256);
        fsyncSync(file.fd); physical(dirname(file.path));
        const identity = auditStat(fstatSync(file.fd)); assert.deepEqual(auditStat(lstatSync(file.path)), identity);
        assert.equal(identity[4], file.bytes);
        // Verify the bytes on disk at each file boundary, not the entire packet at audit-end.
        assert.equal(fileHash(file.path, file.bytes), file.sha256, "staged audit digest differs");
        assert.deepEqual(auditStat(lstatSync(file.path)), identity, "staged audit file changed");
        audit.files.set(relative(audit.stage, file.path).replaceAll("\\", "/"), { bytes: file.bytes, sha256: file.sha256, identity });
        closeSync(file.fd); file = undefined;
      } else if (kind === "audit-end") {
        assert.ok(audit && !file && payload.group === audit.group && payload.subjectSha256 === audit.subjectSha256);
        const subject = auditSubject(local, audit, expected.binding.commit, audit.stage);
        const directories = verifyAuditInventory(subject, audit.group, audit.files);
        for (const name of directories) auditDirectory(join(audit.stage, name));
        const present = new Set();
        function inventory(path, key = "") {
          physical(path); const dir = opendirSync(path);
          try {
            let entry; while ((entry = dir.readSync())) {
              const name = key ? key + "/" + entry.name : entry.name, target = join(path, entry.name);
              if (directories.includes(name)) inventory(target, name);
              else {
                assert.ok(audit.files.has(name), "unexpected audit export member");
                assert.deepEqual(auditStat(lstatSync(target)), audit.files.get(name).identity, "audit export changed");
                present.add(name);
              }
            }
          } finally { dir.closeSync(); }
          syncDirectory(path);
        }
        inventory(audit.stage);
        assert.equal(present.size, audit.files.size, "audit export member disappeared");
        assert.equal(lstatSync(audit.root, { throwIfNoEntry: false }), undefined);
        append(frame);
        renameSync(audit.stage, audit.root); syncDirectory(local);
        const { campaign, group, subjectSha256 } = audit;
        durable(join(local, `monitor-audit-${audit.group}-ready.json`), JSON.stringify({ campaign, group, subjectSha256 })); audit = undefined;
      } else if (kind === "delivery-sealed") append(frame);
      else if (kind === "terminal") {
        assert.equal(audit, undefined, "terminal with incomplete audit export");
        assert.equal(payload.id, expected.id); assert.equal(payload.nativeTerminal, true); assert.match(payload.sealSha256, /^[a-f0-9]{64}$/);
        terminal = payload; append(frame); send("close", {}); child.stdin.end();
      } else assert.fail("unknown control stream frame");
    }
  }
  try {
    child = launch("ssh", argv, { cwd: repo, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", fail); child.stdin.on("error", fail);
    child.stdout.on("data", (data) => {
      try {
        assert.ok(!closing); buffer = Buffer.concat([buffer, data]); assert.ok(buffer.length <= 131072);
        let at; while ((at = buffer.indexOf(10)) >= 0) { assert.ok(at <= streamLimits.frameBytes); accept(JSON.parse(buffer.subarray(0, at))); buffer = buffer.subarray(at + 1); }
      } catch { fail(); }
    });
    let stderr = Buffer.alloc(0), excess = false;
    child.stderr.on("data", (data) => {
      if (excess) return;
      if (stderr.length + data.length > 8192) { excess = true; stderr = Buffer.alloc(0); fail(); }
      else stderr = Buffer.concat([stderr, data]);
    });
    child.once("close", (code, signal) => {
      const late = settled;
      clearInterval(timer); clearTimeout(timer); settled = true;
      try {
        if (file) { closeSync(file.fd); file = undefined; }
        const closedAtMs = Date.now();
        const reported = Array.from(stderr.toString("latin1").matchAll(/^CORTEN_MONITOR_FAULT ([0-9a-f]{32}) ([1-9][0-9]{0,4})\n/gm));
        const helperLine = code !== 0 && registration && reported.length === 1 && reported[0][1] === expected.id ? Number(reported[0][2]) : null;
        durable(join(local, "monitor-local-closed.json"), JSON.stringify({ id: expected.id, binding: expected.binding,
          code, signal, remoteDrained: false, closedAtMs, recoverAfterMs: closedAtMs + 2 * streamLimits.leaseMs,
          ...(helperLine !== null ? { helperLine } : {}) }));
        if (late) return; // Uncertain result and closed journal stand; only add the actual local observation.
        if (!terminal || closing || code !== 0 || signal !== null || buffer.length) {
          revoke(); append({ kind: "local-closed", code, signal, remoteTerminal: false });
          readyReject(uncertain()); doneResolve({ terminal: false, remoteDrained: false, publicationRevoked: true });
        } else {
          durable(join(local, "monitor-terminal.json"), JSON.stringify({ binding: expected.binding, ...terminal, localClosed: true, remoteDrained: false }));
          doneResolve({ terminal: true, ...terminal, remoteDrained: false });
        }
      } catch { doneReject(uncertain()); } finally { if (!late) closeSync(fd); }
    });
    let delivered = new Set(), delivery;
    timer = setInterval(() => {
      try {
        assert.ok(!interrupted() && Date.now() < deadline && Date.now() - last < streamLimits.leaseMs, "monitor lease lost");
        if (terminal || closing || child.stdin.writableLength > 65536) return;
        if (!delivery) for (const group of ["json-api", "mixed-production"]) {
          const path = join(local, `monitor-delivery-${group}.json`);
          if (!delivered.has(group) && existsSync(path)) {
            const approval = path + ".approved-sha256", bytes = regular(path, streamLimits.deliveryBytes), sha256 = digest(bytes);
            assert.ok(regular(approval, 65).toString("utf8") === sha256 + "\n", "queued audit differs from approval");
            const value = JSON.parse(bytes), ready = JSON.parse(regular(join(local, `monitor-audit-${group}-ready.json`)));
            assert.equal(value.subjectSha256, ready.subjectSha256);
            // Consume the one-shot marker before sending; sealed orphan recovery keeps the original file set.
            unlinkSync(approval); syncDirectory(local);
            delivery = { group, bytes, offset: 0 }; delivered.add(group);
            send("delivery-begin", { ...ready, sha256, bytes: bytes.length }); break;
          }
        }
        if (delivery) {
          if (delivery.offset < delivery.bytes.length) {
            const data = delivery.bytes.subarray(delivery.offset, delivery.offset + 32768);
            send("delivery-data", { offset: delivery.offset, data: data.toString("base64") }); delivery.offset += data.length;
          } else { send("delivery-end", {}); delivery = undefined; }
        }
      } catch { fail(); }
    }, 25);
  } catch { fail(); if (!child) { clearTimeout(timer); closeSync(fd); settled = true; doneReject(uncertain()); } }
  return ready;
}
