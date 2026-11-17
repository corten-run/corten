// Replay only. The expected invocation comes from the owning transport, not a receipt.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";
import { processStat, verifyHostBoundary } from "./isolated/host-observation.mjs";

const key = (p) => `${p.pid}:${p.startTicks}`;
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const same = (a, b, message) => assert.ok(isDeepStrictEqual(a, b), message);
function text(value, pattern, message) {
  assert.ok(typeof value === "string" && value.length <= 4096 && pattern.exec(value)?.[0] === value, message);
}
function exact(value, keys) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, "plain control record required");
  same(Object.keys(value).sort(), [...keys].sort(), "unexpected control record fields");
}
function decimal(value) { text(value, /^(?:0|[1-9]\d{0,23})$/, "invalid monotonic counter"); return BigInt(value); }
function identity(value) {
  exact(value, ["pid", "startTicks", "cgroup", "executable", "commandSha256"]);
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0, "invalid control PID");
  decimal(value.startTicks);
  text(value.cgroup, /^0::\/[^\r\n\0]*\n$/, "one unified control cgroup required");
  assert.ok(!value.cgroup.slice(4, -1).split("/").some((s) => s === "." || s === ".."), "nonphysical control cgroup");
  exact(value.executable, ["device", "inode"]);
  decimal(value.executable.device); decimal(value.executable.inode);
  text(value.commandSha256, /^[a-f0-9]{64}$/, "raw control command identity required");
}
export function validateControlInvocation(value) {
  exact(value, ["schema", "round", "commit", "token", "id", "channel", "purpose", "requestSha256", "deadlineMs"]);
  assert.equal(value.schema, "benchmark-control-invocation/v1");
  text(value.round, /^r[1-9]\d{0,8}$/, "invalid control round");
  text(value.commit, /^[a-f0-9]{40}$/, "invalid control source");
  text(value.token, /^[a-f0-9]{16}$/, "invalid control ownership token");
  text(value.id, /^[a-f0-9]{32}$/, "invalid control invocation identity");
  text(value.requestSha256, /^[a-f0-9]{64}$/, "invalid control request digest");
  assert.ok(["ssh", "sftp"].includes(value.channel), "unknown control channel");
  assert.ok(["bootstrap", "audit", "status", "collection"].includes(value.purpose), "unknown control purpose");
  assert.ok(Number.isSafeInteger(value.deadlineMs) && value.deadlineMs > 0 && value.deadlineMs <= 900000, "bounded control deadline required");
  return value;
}
function inventory(observation, host) {
  same({ hostname: observation.hostname, bootId: observation.bootId }, host, "control host or boot changed");
  assert.ok(Array.isArray(observation.processes) && observation.processes.length <= 8192, "bounded control inventory required");
  const map = new Map();
  for (const p of observation.processes) {
    assert.ok(Number.isSafeInteger(p.pid) && p.pid > 0, "invalid inventory PID");
    decimal(p.startTicks);
    text(p.cgroup, /^0::\/[^\r\n\0]*\n$/, "unified inventory cgroup required");
    assert.ok(typeof p.stat === "string" && p.stat.length <= 4096, "raw control stat required");
    const parsed = processStat(p.stat);
    assert.ok(parsed && parsed.pid === p.pid && parsed.startTicks === p.startTicks
      && Number.isSafeInteger(parsed.parentPid) && parsed.parentPid >= 0, "control stat identity differs");
    assert.ok(!map.has(p.pid), "duplicate control PID");
    map.set(p.pid, { ...p, parentPid: parsed.parentPid });
  }
  return map;
}
const present = (map, p) => map.get(p.pid)?.startTicks === p.startTicks;
const inScope = (p, scope) => p.cgroup === `0::${scope}\n` || p.cgroup.startsWith(`0::${scope}/`);
const sameCommand = (a, b) => isDeepStrictEqual(a.executable, b.executable) && a.commandSha256 === b.commandSha256;
const scopeEvents = (events, populated) => ["", "frozen 0\n", "frozen 1\n"].some((suffix) => events === `populated ${populated}\n${suffix}`);
const ip = (value) => {
  assert.ok(isIP(value), "invalid raw connection IP");
  return isIP(value) === 4 ? value : new URL(`http://[${value}]/`).hostname;
};
function kernelAddress(value, byteOrder) {
  text(value, /^(?:[A-Fa-f0-9]{8}|[A-Fa-f0-9]{32})$/, "invalid raw socket address");
  const bytes = Buffer.from(value, "hex");
  if (byteOrder === "little") for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
  if (bytes.length === 4 || bytes.subarray(0, 12).equals(Buffer.from("00000000000000000000ffff", "hex")))
    return [...bytes.subarray(-4)].join(".");
  return ip([...Array(8)].map((_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(":"));
}

/** Validates saved evidence, never authorizes execution, deletion, or a transport retry. */
export function verifyControlSession(expected, receipt) {
  validateControlInvocation(expected);
  const native = receipt.schema === "benchmark-control-session/v2";
  exact(receipt, ["schema", "invocation", "host", "listener", "observer", "session", "samples", "result", ...(native ? ["socket", "window"] : [])]);
  assert.ok(native || receipt.schema === "benchmark-control-session/v1", "unsupported control session schema");
  same(receipt.invocation, expected, "control invocation ownership differs");
  exact(receipt.host, ["hostname", "bootId"]);
  text(receipt.host.hostname, /^[A-Za-z0-9.-]{1,253}$/, "invalid control hostname");
  text(receipt.host.bootId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, "invalid control boot");
  identity(receipt.listener); identity(receipt.observer);
  exact(receipt.session, ["scope", "chain"]);
  const { scope, chain } = receipt.session;
  text(scope, /^\/(?:[A-Za-z0-9_.:@-]+\/)*[A-Za-z0-9_:@-][A-Za-z0-9_.:@-]*\.scope$/, "exclusive session scope required");
  assert.ok(!scope.split("/").some((s) => s === "." || s === ".."), "nonphysical session scope");
  assert.ok(Array.isArray(chain) && chain.length >= 2 && chain.length <= 32, "bounded SSH ancestry required");
  for (const p of chain) identity(p);
  const owned = new Map(chain.map((p) => [key(p), p]));
  assert.equal(owned.size, chain.length, "duplicate session identity");
  assert.ok(!owned.has(key(receipt.listener)) && !owned.has(key(receipt.observer))
    && key(receipt.listener) !== key(receipt.observer), "session cannot own its listener or observer");
  assert.ok(!inScope(receipt.listener, scope) && !inScope(receipt.observer, scope), "observer/listener inside session");
  assert.equal(receipt.observer.cgroup,
    native ? `0::/system.slice/corten-bench-control-${expected.token}-${expected.id}.service\n`
      : `0::/system.slice/corten-bench-groups-${expected.round}-${expected.token}.service/supervisor\n`,
    "observer is not in the independent owned benchmark supervisor");
  assert.ok(inScope(chain.at(-1), scope), "control endpoint outside session scope");
  assert.ok(Array.isArray(receipt.samples) && receipt.samples.length >= 2 && receipt.samples.length <= (native ? 4096 : 128), "bounded host-side observations required");
  if (native) {
    const socket = receipt.socket, fields = socket.connection.split(" ");
    assert.ok(["little", "big"].includes(socket.byteOrder), "socket byte order missing");
    assert.equal(fields.length, 4, "raw SSH connection tuple required");
    for (const port of [fields[1], fields[3]]) assert.ok(/^[1-9]\d{0,4}$/.test(port) && Number(port) < 65536);
    const listening = socket.listener.trim().split(/\s+/), connected = socket.session.trim().split(/\s+/);
    assert.equal(listening[3], "0A"); assert.equal(connected[3], "01");
    assert.ok(chain.some((p) => p.pid === socket.sessionPid), "connection socket outside registered ancestry");
    assert.ok(socket.listenerFds.includes(listening[9]) && socket.sessionFds.includes(connected[9]), "socket ownership differs");
    assert.equal(parseInt(listening[1].split(":")[1], 16), Number(fields[3]));
    assert.equal(parseInt(connected[1].split(":")[1], 16), Number(fields[3]));
    assert.equal(parseInt(connected[2].split(":")[1], 16), Number(fields[1]));
    assert.equal(kernelAddress(connected[1].split(":")[0], socket.byteOrder), ip(fields[2]), "server socket address differs");
    assert.equal(kernelAddress(connected[2].split(":")[0], socket.byteOrder), ip(fields[0]), "client socket address differs");
  }
  const result = receipt.result;
  exact(result, ["transport", "code", "releasedMonoNs", "completedMonoNs"]);
  assert.equal(result.transport, "exited", "uncertain transport cannot be cleared by a later clean probe");
  assert.ok(Number.isInteger(result.code) && result.code >= 0 && result.code <= 255, "remote command result required");
  const released = decimal(result.releasedMonoNs), completed = decimal(result.completedMonoNs);
  assert.ok(completed >= released && completed - released <= BigInt(expected.deadlineMs) * 1000000n, "remote deadline not proved");
  let started = 0n, deadline;
  if (native) {
    exact(receipt.window, ["startedMonoNs", "deadlineMonoNs"]);
    started = decimal(receipt.window.startedMonoNs); deadline = decimal(receipt.window.deadlineMonoNs);
    assert.equal(deadline - started, BigInt(expected.deadlineMs) * 1000000n, "original invocation deadline differs");
    assert.ok(released >= started && completed <= deadline);
  }
  const descendants = new Map(owned);
  let previous = -1n, firstMap, lastMap, rows = 0;
  for (const sample of receipt.samples) {
    exact(sample, ["hostname", "bootId", "monoNs", "processes", "scope"]);
    const at = decimal(sample.monoNs);
    if (native) assert.ok(at >= started && at <= deadline, "observation outside original control deadline");
    assert.ok(at > previous && (previous < 0n || at - previous <= 1000000000n), "control observation order/gap invalid");
    previous = at;
    assert.ok(Array.isArray(sample.processes), "control process inventory required");
    rows += sample.processes.length; assert.ok(rows <= (native ? 65536 : 32768), "aggregate control inventory bound exceeded");
    const map = inventory(sample, receipt.host);
    for (const p of [receipt.observer, receipt.listener])
      assert.ok(present(map, p) && map.get(p.pid).cgroup === p.cgroup
        && (sameCommand(map.get(p.pid), p) || native && firstMap && p === receipt.listener
          && isDeepStrictEqual(map.get(p.pid).executable, p.executable))
        && !processStat(map.get(p.pid).stat).kernelThread, "independent host observer/listener lost");
    const children = new Map();
    for (const p of map.values()) {
      if (!children.has(p.parentPid)) children.set(p.parentPid, []);
      children.get(p.parentPid).push(p);
    }
    const queue = [...descendants.values()].filter((p) => present(map, p));
    for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i].pid) ?? []) {
      if (descendants.has(key(child))) continue;
      assert.ok(descendants.size < 8192, "control descendant bound exceeded");
      descendants.set(key(child), child); queue.push(child);
    }
    assert.ok(!descendants.has(key(receipt.observer)), "host observer is a session descendant");
    exact(sample.scope, ["path", "exists", "events", "members"]);
    assert.equal(sample.scope.path, scope);
    assert.ok(typeof sample.scope.exists === "boolean" && Array.isArray(sample.scope.members)
      && sample.scope.members.length <= 8192, "raw session scope observation required");
    same(sample.scope.members, [...map.values()].filter((p) => inScope(p, scope)).map((p) => p.pid).sort((a, b) => a - b), "session membership differs");
    assert.ok(sample.scope.exists || (sample.scope.events === null && sample.scope.members.length === 0), "absent session scope has members");
    if (sample.scope.exists)
      assert.ok(scopeEvents(sample.scope.events, sample.scope.members.length ? 1 : 0), "session populated/membership proof differs");
    assert.ok(sample.scope.members.every((pid) => descendants.has(key(map.get(pid)))), "unowned session scope member");
    if (!firstMap) {
      firstMap = map;
      assert.ok(at <= released, "identity registration occurred after command release");
      let parent = receipt.listener;
      for (const p of chain) {
        assert.ok(present(map, p) && map.get(p.pid).cgroup === p.cgroup
          && sameCommand(map.get(p.pid), p)
          && !processStat(map.get(p.pid).stat).kernelThread
          && map.get(p.pid).parentPid === parent.pid, "SSH ancestry not bound to actual PID/start/cgroup");
        parent = p;
      }
      assert.ok(sample.scope.exists, "session scope missing at registration");
      assert.ok(sample.scope.members.every((pid) => owned.has(key(map.get(pid)))), "unowned session scope member");
    }
    lastMap = map;
  }
  assert.ok(previous >= completed, "terminal observation precedes remote completion");
  assert.ok(previous - decimal(receipt.samples[0].monoNs) <= BigInt(expected.deadlineMs) * 1000000n, "control drainage deadline expired");
  const terminal = receipt.samples.at(-1).scope;
  assert.ok(terminal.members.length === 0 && (!terminal.exists || scopeEvents(terminal.events, 0)), "remote session scope is not proved empty");
  for (const p of descendants.values()) assert.ok(!present(lastMap, p), "remote SSH ancestor/endpoint/descendant remains");
  return { status: "replayed", remoteDrained: true, invocation: expected.id, host: receipt.host,
    identities: [...owned.values()], receiptSha256: hash(receipt), authority: "none" };
}

/** A later sample may remove only pre-registered control identities, never native leaks. */
export function verifyControlDrainBoundary({ before, originalAfter, settledAfter, invocations, receipts }) {
  assert.ok(Array.isArray(invocations) && invocations.length > 0 && invocations.length <= 64
    && Array.isArray(receipts) && receipts.length === invocations.length, "complete bounded control ledger required");
  const ids = new Set(), scopes = new Set(), identities = new Map();
  const start = decimal(before.monoNs), end = decimal(originalAfter.monoNs), settled = decimal(settledAfter.monoNs);
  assert.ok(start < end && end <= settled, "original/settled host observations are not ordered");
  for (let i = 0; i < invocations.length; i++) {
    const proof = verifyControlSession(invocations[i], receipts[i]);
    assert.ok(!ids.has(proof.invocation), "duplicate control invocation"); ids.add(proof.invocation);
    assert.ok(!scopes.has(receipts[i].session.scope), "session scope reused across invocations"); scopes.add(receipts[i].session.scope);
    same(proof.host, { hostname: before.hostname, bootId: before.bootId }, "control proof belongs to another host");
    // A native baseline must not quietly inherit an earlier SSH/PAM survivor.
    const baseline = inventory(before, proof.host), listener = receipts[i].listener;
    for (const p of baseline.values()) {
      assert.ok(key(p) === key(listener) || (p.cgroup !== listener.cgroup
        && !p.cgroup.startsWith(`${listener.cgroup.trimEnd()}/`) && p.parentPid !== listener.pid), "unowned SSH baseline member");
      assert.ok(!/\/session-[^/\n]+\.scope(?:\/|\n)/.test(p.cgroup), "unsettled login session in baseline");
    }
    for (const field of ["round", "commit", "token"])
      assert.equal(invocations[i][field], invocations[0][field], "mixed control ownership/source");
    assert.ok(decimal(receipts[i].samples[0].monoNs) >= start
      && decimal(receipts[i].result.completedMonoNs) <= end
      && decimal(receipts[i].samples.at(-1).monoNs) <= settled, "control proof outside original host boundary");
    for (const p of proof.identities) {
      assert.ok(!identities.has(key(p)), "session identity reused across invocations"); identities.set(key(p), p);
    }
  }
  assert.ok(!before.processes.some((p) => identities.has(key(p))), "control session absorbed into baseline");
  const processes = originalAfter.processes.filter((p) => {
    const owned = identities.get(key(p));
    if (!owned) return true;
    assert.equal(p.cgroup, owned.cgroup, "control cgroup changed at original boundary");
    assert.ok(sameCommand(p, owned), "control executable/command changed at original boundary");
    const parsed = processStat(p.stat);
    assert.ok(parsed && parsed.pid === p.pid && parsed.startTicks === p.startTicks && !parsed.kernelThread, "original control identity not proved");
    return false;
  });
  verifyHostBoundary(before, { ...originalAfter, processes });
  verifyHostBoundary(before, settledAfter);
  // Both originals stay in custody. This is an additional proof, not a rewritten bookend.
  return { status: "replayed", originalAfterSha256: hash(originalAfter), settledAfterSha256: hash(settledAfter),
    receiptSha256: receipts.map(hash), authority: "none", isolation: "unverified" };
}
