// One supervised SSH stream. No provider, shell payload, reconnect or status server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { durable, digest, physical, regular, syncDirectory } from "./cloud-local.mjs";
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

function auditSubject(local, intent, commit) {
  const prefix = intent.group === "json-api" ? "json" : "mixed", path = join(local, "monitor-audit-" + intent.group, prefix + "-audit-subject.json");
  const subject = JSON.parse(regular(path, streamLimits.deliveryBytes)), { subjectSha256, ...body } = subject;
  assert.equal(subject.schema, "benchmark-" + prefix + "-audit-subject/v1"); assert.equal(subject.commit, commit);
  assert.equal(subjectSha256, intent.subjectSha256); assert.equal(deploymentSha256(body), subjectSha256);
  return subject;
}

export function localStreamStatus(local) {
  physical(local);
  for (const kind of ["invalid", "terminal"]) {
    const path = join(local, `monitor-${kind}.json`);
    if (existsSync(path)) return { kind, ...JSON.parse(regular(path)) };
  }
  const path = join(local, "monitor-journal.jsonl");
  if (!existsSync(path)) return { kind: "pending" };
  const before = lstatSync(path); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd); assert.ok(opened.ino === before.ino && opened.dev === before.dev);
    const size = opened.size; assert.ok(size <= streamLimits.journalBytes);
    const length = Math.min(size, 131072), bytes = Buffer.alloc(length);
    assert.equal(readSync(fd, bytes, 0, length, size - length), length);
    const lines = bytes.toString("utf8").split("\n"); lines.pop(); if (size > length) lines.shift();
    return { kind: "progress", frame: lines.length ? JSON.parse(lines.at(-1)) : null };
  } finally { closeSync(fd); }
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

export function queueStreamAudit(local, state, options, approvedDeliverySha256) {
  assert.ok(state.control.monitor.phase === "live" && existsSync(join(local, "operation.lock")), "foreground monitor required");
  assert.ok(existsSync(join(local, "audit-delivery.lock")), "exclusive audit publisher required");
  monitorRegistration(local, state);
  assert.equal(localStreamStatus(local).kind, "progress");
  const bytes = regular(resolve(options.deliverAudit), streamLimits.deliveryBytes);
  assert.equal(digest(bytes), approvedDeliverySha256, "locked audit delivery changed");
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
  assert.ok(!existsSync(join(local, "monitor-invalid.json")) && !existsSync(join(local, "monitor-terminal.json")));
  const target = join(local, "monitor-delivery-" + intent.group + ".json"), pending = target + ".pending";
  assert.equal(lstatSync(target, { throwIfNoEntry: false }), undefined, "audit delivery already queued; never repeat");
  durable(pending, bytes);
  assert.ok(!existsSync(join(local, "monitor-invalid.json")) && !existsSync(join(local, "monitor-terminal.json")));
  renameSync(pending, target); syncDirectory(local);
}

export function openControlStream({ repo, argv, env, expected, local, launch = spawn, interrupted = () => false }) {
  physical(local); assert.ok(!existsSync(join(local, "monitor-journal.jsonl")), "monitor cannot restart/adopt a stream");
  const fd = openSync(join(local, "monitor-journal.jsonl"), "wx", 0o600);
  let bytes = 0, sequence = 0, buffer = Buffer.alloc(0), registration, terminal, child, timer, file, audit, auditBytes = 0;
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
      } else if (kind === "progress") replaceProgress(frame);
      else if (kind === "audit-begin") {
        assert.equal(audit, undefined); assert.ok(["json-api", "mixed-production"].includes(payload.group));
        assert.match(payload.campaign, /^r[1-9]\d*-[a-f0-9]{16}$/); assert.match(payload.subjectSha256, /^[a-f0-9]{64}$/);
        audit = payload; auditBytes = 0; append(frame);
      } else if (kind === "audit-file") {
        assert.ok(audit && !file && payload.group === audit.group);
        const prefix = audit.group === "json-api" ? "json" : "mixed", source = prefix === "json" ? "audit-sources" : "mixed-audit-sources";
        assert.ok(payload.path === `${prefix}-audit-subject.json` || payload.path.startsWith(`${source}/`));
        assert.ok(payload.path.split("/").every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && ![".", ".."].includes(p)));
        assert.ok(Number.isSafeInteger(payload.bytes) && payload.bytes >= 0 && payload.bytes <= streamLimits.auditBytes); assert.match(payload.sha256, /^[a-f0-9]{64}$/);
        file = { ...payload, blocks: [], size: 0 };
      } else if (kind === "audit-data") {
        assert.ok(file && payload.offset === file.size); assert.match(payload.data, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
        const data = Buffer.from(payload.data, "base64"); file.size += data.length; auditBytes += data.length;
        assert.ok(file.size <= file.bytes && auditBytes <= streamLimits.auditBytes); file.blocks.push(data);
      } else if (kind === "audit-file-end") {
        assert.ok(file && file.size === file.bytes); const data = Buffer.concat(file.blocks); assert.equal(digest(data), file.sha256);
        const root = join(local, `monitor-audit-${audit.group}`), path = resolve(root, file.path);
        assert.ok(!relative(root, path).startsWith("..")); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); physical(dirname(path)); durable(path, data); file = undefined;
      } else if (kind === "audit-end") {
        assert.ok(audit && !file && payload.group === audit.group && payload.subjectSha256 === audit.subjectSha256);
        auditSubject(local, audit, expected.binding.commit);
        durable(join(local, `monitor-audit-${audit.group}-ready.json`), JSON.stringify(audit)); append(frame); audit = undefined;
      } else if (kind === "delivery-sealed") append(frame);
      else if (kind === "terminal") {
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
    let stderr = 0; child.stderr.on("data", (data) => { stderr += data.length; if (stderr > 8192) fail(); });
    child.once("close", (code, signal) => {
      const late = settled;
      clearInterval(timer); clearTimeout(timer); settled = true;
      try {
        const closedAtMs = Date.now();
        durable(join(local, "monitor-local-closed.json"), JSON.stringify({ id: expected.id, binding: expected.binding,
          code, signal, remoteDrained: false, closedAtMs, recoverAfterMs: closedAtMs + 2 * streamLimits.leaseMs }));
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
            const bytes = regular(path, streamLimits.deliveryBytes), value = JSON.parse(bytes), ready = JSON.parse(regular(join(local, `monitor-audit-${group}-ready.json`)));
            assert.equal(value.subjectSha256, ready.subjectSha256);
            delivery = { group, bytes, offset: 0 }; delivered.add(group);
            send("delivery-begin", { ...ready, sha256: digest(bytes), bytes: bytes.length }); break;
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
