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
export function socketProof(socket, chain) {
  const fields = socket.connection.split(" ");
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

export function verifyControlRegistration(expected, registration) {
  validateControlInvocation(expected);
  exact(registration, ["invocation", "host", "listener", "observer", "session", "socket", "first"]);
  same(registration.invocation, expected, "query invocation differs");
  exact(registration.host, ["hostname", "bootId"]);
  text(registration.host.hostname, /^[A-Za-z0-9.-]{1,253}$/, "invalid query hostname");
  text(registration.host.bootId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, "invalid query boot");
  identity(registration.listener); identity(registration.observer);
  exact(registration.session, ["chain", "scope"]);
  const { chain, scope } = registration.session;
  assert.ok(Array.isArray(chain) && chain.length >= 2 && chain.length <= 32);
  text(scope, /^\/(?:[A-Za-z0-9_.:@-]+\/)*[A-Za-z0-9_:@-][A-Za-z0-9_.:@-]*\.scope$/, "query session scope required");
  assert.ok(!scope.split("/").some((p) => p === "." || p === ".."));
  assert.equal(registration.observer.cgroup, `0::/system.slice/corten-bench-control-${expected.token}-${expected.id}.service\n`);
  const first = registration.first, map = inventory(first, registration.host);
  exact(first, ["hostname", "bootId", "monoNs", "processes", "scope"]);
  exact(first.scope, ["path", "exists", "events", "members"]);
  decimal(first.monoNs);
  let parent = registration.listener;
  const ids = new Set([parent.pid, registration.observer.pid]); assert.equal(ids.size, 2);
  for (const p of chain) {
    identity(p); assert.ok(!ids.has(p.pid)); ids.add(p.pid);
    assert.ok(present(map, p) && sameCommand(map.get(p.pid), p) && map.get(p.pid).cgroup === p.cgroup
      && map.get(p.pid).parentPid === parent.pid, "query registration ancestry differs");
    parent = p;
  }
  for (const p of [registration.listener, registration.observer])
    assert.ok(present(map, p) && sameCommand(map.get(p.pid), p) && map.get(p.pid).cgroup === p.cgroup && !inScope(p, scope));
  assert.equal(map.size, ids.size, "unregistered process in original query registration");
  assert.ok(inScope(chain.at(-1), scope));
  assert.equal(first.scope.path, scope); assert.equal(first.scope.exists, true); assert.ok(scopeEvents(first.scope.events, 1));
  same(first.scope.members, [...map.values()].filter((p) => inScope(p, scope)).map((p) => p.pid).sort((a, b) => a - b), "query registration scope differs");
  assert.ok(first.scope.members.every((pid) => chain.some((p) => p.pid === pid)));
  socketProof(registration.socket, chain);
  return registration;
}

const settledEvents = (events) => events === null || typeof events === "string" && scopeEvents(events, 0);
// The guardian writes records with Python's ensure_ascii JSON. Match those bytes exactly.
const asciiDigest = (value) => createHash("sha256").update(JSON.stringify(value)
  .replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n").digest("hex");
const drainedRecords = ["request", "start", "launcher", "registration", "result", "watch-failure"];
const drainProofKeys = ["schema", "binding", "requests", "receipts", "watchers", "drained", "registration", "start", "launcher", "watcher",
  "query", "timeout", "executables", "observation", "entries", "custody", "dockerSockets"];
// docker-install leaves dockerd and containerd running before any later bootstrap poll, so
// they would predate the fence; the proof cannot see work a daemon holds for a session.
const dockerRuntime = "Docker or containerd present";
const dockerSockets = { "/run/docker.sock": false, "/run/containerd/containerd.sock": false };
const dockerCommand = (comm) => comm === "dockerd" || comm === "containerd" || comm.startsWith("containerd-");
// A failed watcher has no receipt. Its replacement is a later positive observation:
// the exact recorded result, an inactive watcher unit and no observed process of the
// session. It is a process observation only (see CLOUD.md for what it cannot see).
function verifyDrainedSession(invocation, failure, entry, host, listener, map, now) {
  exact(entry, ["id", "failureSha256", "result", "start", "launcher", "registration", "watcher", "cgroupEvents", "scope"]);
  same([entry.id, entry.failureSha256], [failure.id, failure.failureSha256], "drained watcher differs");
  assert.equal(entry.id, invocation.id);
  exact(entry.result, ["transport", "code", "releasedMonoNs", "completedMonoNs"]);
  assert.equal(entry.result.transport, "exited", "uncertain transport cannot be drained");
  assert.equal(entry.result.code, failure.code, "drained result differs from the ledger");
  const unit = `corten-bench-control-${invocation.token}-${invocation.id}.service`;
  same(entry.launcher, { unit, code: 0 }, "drained launcher differs");
  exact(entry.start, ["guardian", "child", "unit", "connection", "deadlineMonoNs"]);
  assert.equal(entry.start.unit, unit);
  const registration = verifyControlRegistration(invocation, entry.registration), { chain, scope } = registration.session;
  same(registration.host, host, "drained session boot differs");
  // The live query's listener is exempt from the start-time check, so it must be the one that
  // served this failed session (same PID and start time), which therefore predates it.
  assert.equal(key(registration.listener), key(listener), "listener differs from a failed session");
  assert.equal(entry.start.child, chain.at(-1).pid); assert.equal(entry.start.guardian, chain.at(-2).pid);
  assert.equal(entry.start.connection, registration.socket.connection);
  const deadline = decimal(entry.start.deadlineMonoNs), released = decimal(entry.result.releasedMonoNs), completed = decimal(entry.result.completedMonoNs);
  assert.ok(released >= deadline - BigInt(invocation.deadlineMs) * 1000000n && completed >= released && completed <= deadline
    && now >= deadline, "drained session outside its original window");
  same(Object.keys(entry.watcher).sort(), ["ActiveState", "ControlPID", "Id", "Job", "LoadState", "MainPID"], "drained watcher properties differ");
  const w = entry.watcher;
  assert.ok(w.Id === unit && (w.LoadState === "loaded" && w.ActiveState === "failed" || w.LoadState === "not-found" && w.ActiveState === "inactive")
    && w.MainPID === "0" && w.ControlPID === "0" && w.Job === "", "failed watcher still active or queued");
  assert.ok(settledEvents(entry.cgroupEvents), "failed watcher cgroup populated");
  exact(entry.scope, ["path", "exists", "events", "members"]);
  assert.ok(entry.scope.path === scope && isDeepStrictEqual(entry.scope.members, [])
    && (entry.scope.exists === true ? entry.scope.events !== null && settledEvents(entry.scope.events) : entry.scope.exists === false && entry.scope.events === null),
  "drained session scope populated");
  // The query's own later inventory must still show nothing of that session.
  for (const p of map.values()) assert.ok(!inScope(p, scope), "drained session scope member remains");
  const keys = new Set(chain.map(key)), pids = new Set(chain.map((p) => p.pid));
  for (const p of map.values()) assert.ok(!keys.has(key(p)) && !pids.has(p.parentPid), "drained session process or descendant remains");
  assert.ok(!present(map, registration.observer), "failed watcher process remains");
}

export function verifyControlSetupQuery(expected, proof) {
  assert.ok(Number.isSafeInteger(expected.sequence) && expected.sequence > 0 && expected.sequence < 4096);
  const drain = Object.hasOwn(expected, "watcherFailures"), failures = drain ? expected.watcherFailures : [];
  assert.ok(!drain || Array.isArray(failures) && failures.length > 0 && failures.length < expected.sequence + 1, "drain expectation required");
  assert.equal(proof.schema, drain ? "benchmark-control-setup-query/v2" : "benchmark-control-setup-query/v1");
  const failed = new Map(failures.map((failure, index) => [failure.id, index]));
  assert.equal(failed.size, failures.length, "duplicate drain expectation");
  if (drain) {
    exact(proof, drainProofKeys);
    assert.ok(Array.isArray(proof.drained) && proof.drained.length === failures.length, "drained watcher proof required");
  }
  same(proof.binding, expected.binding, "setup control source/owner differs");
  assert.equal(proof.requests.length, expected.sequence + 1);
  same(proof.requests.slice(0, -1), expected.requests, "setup control sequence differs");
  assert.equal(proof.receipts.length, expected.sequence); assert.equal(proof.watchers.length, expected.sequence);
  const request = proof.requests.at(-1), invocation = request.invocation;
  assert.equal(request.sequence, expected.sequence); assert.equal(request.epoch, "collection");
  assert.equal(invocation.channel, "ssh"); assert.equal(invocation.purpose, "collection");
  assert.equal(request.seal, undefined);
  const ids = new Set();
  for (const [i, row] of proof.requests.entries()) {
    assert.equal(row.sequence, i); assert.ok(!ids.has(row.invocation.id)); ids.add(row.invocation.id);
    assert.ok(["bootstrap", "collection"].includes(row.epoch)); assert.equal(row.seal, undefined);
    assert.equal(row.helperSha256, expected.binding.helperSha256);
    for (const field of ["round", "commit", "token"]) assert.equal(row.invocation[field], expected.binding[field]);
    if (i < expected.sequence && failed.has(row.invocation.id)) {
      assert.ok(row.epoch === "bootstrap" && proof.receipts[i] === null && proof.watchers[i] === null, "failed watcher cannot carry a receipt");
    } else if (i < expected.sequence) {
      verifyControlSession(row.invocation, proof.receipts[i]); same(proof.receipts[i].host, proof.registration.host, "setup receipt boot differs");
    }
  }
  assert.ok([...failed.keys()].every((id) => proof.requests.slice(0, -1).some((row) => row.invocation.id === id)), "drain expectation outside the ledger");
  const registration = verifyControlRegistration(invocation, proof.registration), host = registration.host;
  const { chain, scope } = registration.session, unit = `corten-bench-control-${invocation.token}-${invocation.id}.service`;
  assert.equal(proof.start.unit, unit); assert.equal(proof.start.child, chain.at(-1).pid);
  assert.equal(proof.start.guardian, chain.at(-2).pid);
  assert.equal(proof.start.connection, registration.socket.connection);
  same(proof.launcher, { unit, code: 0 }, "query launcher differs");
  const observer = registration.observer;
  same(proof.watcher, { Id: unit, LoadState: "loaded", ActiveState: "active", MainPID: String(observer.pid),
    Restart: "no", FragmentPath: `/run/systemd/transient/${unit}`, ControlGroup: `/system.slice/${unit}` }, "query watcher source/unit differs");
  const map = inventory(proof.observation, host), now = decimal(proof.observation.monoNs), deadline = decimal(proof.start.deadlineMonoNs);
  assert.ok(now >= decimal(registration.first.monoNs) && now < deadline && decimal(registration.first.monoNs) >= deadline - BigInt(invocation.deadlineMs) * 1000000n
    && now >= deadline - BigInt(invocation.deadlineMs) * 1000000n, "query observation outside original deadline");
  // Requests are in sequence order, and so are the expected failures and drained entries.
  let drainedIndex = 0;
  for (const row of proof.requests.slice(0, -1)) if (failed.has(row.invocation.id)) {
    const index = failed.get(row.invocation.id);
    assert.equal(index, drainedIndex++, "drained watchers out of ledger order");
    verifyDrainedSession(row.invocation, failures[index], proof.drained[index], host, registration.listener, map, now);
  }
  const command = (args) => createHash("sha256").update(args.join("\0") + "\0").digest("hex");
  const query = proof.query, timeout = proof.timeout;
  for (const p of [query, timeout, observer]) {
    identity(p); assert.ok(present(map, p)); same(identityFields(map.get(p.pid)), p, "live query identity differs");
  }
  same(query.executable, proof.executables.python, "query executable differs"); same(observer.executable, proof.executables.python, "watcher executable differs");
  same(timeout.executable, proof.executables.timeout, "timeout executable differs");
  assert.equal(query.commandSha256, command(expected.queryArgv));
  assert.equal(timeout.commandSha256, command(["/usr/bin/timeout", "25", ...expected.queryArgv]));
  assert.equal(observer.commandSha256, command(["/usr/bin/python3", "-I", `/run/corten-bench-control-${invocation.token}/helper.py`, "watch", invocation.token, invocation.id]));
  assert.equal(map.get(query.pid).parentPid, timeout.pid);
  assert.ok([proof.start.child, proof.start.guardian].includes(map.get(timeout.pid).parentPid) && timeout.pid !== proof.start.guardian);
  assert.ok(inScope(query, scope) && inScope(timeout, scope));
  const allowed = new Set([...chain.map((p) => p.pid), registration.listener.pid, observer.pid, query.pid, timeout.pid]);
  assert.ok(allowed.size >= chain.length + 3);
  for (const p of [...chain, registration.listener]) {
    assert.ok(present(map, p) && map.get(p.pid).cgroup === p.cgroup, "query ancestor identity/cgroup differs");
    if (p.pid !== timeout.pid && p.pid !== registration.listener.pid) same(identityFields(map.get(p.pid)), p);
    else if (p.pid === registration.listener.pid) same(map.get(p.pid).executable, p.executable);
  }
  for (const p of map.values()) if (!allowed.has(p.pid)) {
    assert.ok(!allowed.has(p.parentPid), "unknown query descendant");
    assert.ok(!p.cgroup.startsWith("0::/user.slice/") && !/\/session-[^/\n]+\.scope(?:\/|\n)/.test(p.cgroup), "unknown login survivor");
    assert.ok(!p.cgroup.startsWith("0::/system.slice/corten-bench"), "unknown owned-unit participant");
    assert.ok(p.cgroup !== registration.listener.cgroup && !p.cgroup.startsWith(registration.listener.cgroup.trimEnd() + "/"), "unknown listener participant");
  }
  if (drain) {
    // A failed session's process can leave its scope and its parent (systemd-run --scope,
    // then reparenting to PID 1). Outside the live query's own set, only processes that
    // started before the earliest failed session's first process, or kernel threads, remain.
    const fence = proof.drained.flatMap((entry) => entry.registration.session.chain).map((p) => BigInt(p.startTicks)).reduce((a, b) => (b < a ? b : a));
    for (const p of map.values()) if (!allowed.has(p.pid)) {
      const kernel = processStat(p.stat).kernelThread && p.parentPid === 2 && p.cgroup === "0::/\n";
      assert.ok(kernel || BigInt(p.startTicks) < fence, "process started during or after a failed session");
    }
    same(proof.dockerSockets, dockerSockets, dockerRuntime);
    for (const p of map.values()) assert.ok(!dockerCommand(processStat(p.stat).comm), dockerRuntime);
  }
  assert.ok(Array.isArray(proof.entries) && proof.entries.length <= 32768 && Array.isArray(proof.custody));
  const names = new Set(["helper.py", "binding.json", "mutex"]), entries = new Map();
  for (const [i, row] of proof.requests.entries()) for (const name of ["request", "start", "launcher", "registration",
    ...(i < expected.sequence ? ["result", failed.has(row.invocation.id) ? "watch-failure" : "receipt"] : [])])
    names.add(`${name}-${row.invocation.id}.json`);
  let total = 0;
  for (const entry of proof.entries) {
    exact(entry, ["name", "bytes", "sha256"]); assert.ok(names.has(entry.name) && !entries.has(entry.name));
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= 8 * 1024 * 1024);
    text(entry.sha256, /^[a-f0-9]{64}$/, "invalid custody digest"); total += entry.bytes; assert.ok(total <= 64 * 1024 * 1024);
    entries.set(entry.name, entry);
  }
  assert.equal(entries.size, names.size); assert.equal(entries.get("helper.py").sha256, expected.binding.helperSha256);
  const rawDigest = (value) => createHash("sha256").update(JSON.stringify(value) + "\n").digest("hex");
  assert.equal(entries.get("binding.json").sha256, rawDigest(expected.binding));
  for (const row of proof.requests) assert.equal(entries.get(`request-${row.invocation.id}.json`).sha256, rawDigest(row));
  for (const [index, failure] of failures.entries()) {
    const entry = proof.drained[index], id = failure.id;
    assert.equal(entries.get(`watch-failure-${id}.json`).sha256, failure.failureSha256, "watcher failure differs from the archive");
    for (const name of ["result", "start", "launcher"]) assert.equal(entries.get(`${name}-${id}.json`).sha256, rawDigest(entry[name]), "drained control record differs");
    assert.equal(entries.get(`registration-${id}.json`).sha256, asciiDigest(entry.registration), "drained registration differs");
  }
  const copied = new Set();
  for (const entry of proof.custody) { same(entry, entries.get(entry.name), "control custody differs"); assert.ok(!copied.has(entry.name)); copied.add(entry.name); }
  assert.ok(copied.has("helper.py") && copied.has("binding.json"));
  // Every record of a failed row is copied, so retirement compares each with the archive.
  assert.ok(failures.every((failure) => drainedRecords.every((name) => copied.has(`${name}-${failure.id}.json`))), "failed watcher record missing from custody");
  return { allowedPids: [...allowed], host, sequence: expected.sequence, remoteDrained: false };
}
const identityFields = (p) => Object.fromEntries(["pid", "startTicks", "cgroup", "executable", "commandSha256"].map((field) => [field, p[field]]));

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
    socketProof(receipt.socket, chain);
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
    const bracketed = Object.hasOwn(sample.scope, "eventsBeforeInventory");
    exact(sample.scope, ["path", "exists", "events", "members", ...(bracketed ? ["eventsBeforeInventory"] : [])]);
    assert.equal(sample.scope.path, scope);
    assert.ok(typeof sample.scope.exists === "boolean" && Array.isArray(sample.scope.members)
      && sample.scope.members.length <= 8192, "raw session scope observation required");
    same(sample.scope.members, [...map.values()].filter((p) => inScope(p, scope)).map((p) => p.pid).sort((a, b) => a - b), "session membership differs");
    const intermediateMembers = native && firstMap && sample !== receipt.samples.at(-1) && sample.scope.members.length > 0;
    const exitingOnly = intermediateMembers && sample.scope.members.every((pid) => {
      const p = map.get(pid), fields = p.stat.slice(p.stat.lastIndexOf(") ") + 2).split(" ");
      return p.executable === null && (["Z", "X"].includes(fields[0]) || (BigInt(fields[6]) & 4n) !== 0n);
    });
    if (bracketed) {
      assert.ok(intermediateMembers && (scopeEvents(sample.scope.eventsBeforeInventory, 1)
        || !sample.scope.exists && exitingOnly && scopeEvents(sample.scope.eventsBeforeInventory, 0))
        && (sample.scope.exists ? scopeEvents(sample.scope.events, 0) : sample.scope.events === null),
      "invalid intermediate scope exit observation");
    }
    assert.ok(sample.scope.exists || (sample.scope.events === null && (bracketed || sample.scope.members.length === 0)), "absent session scope has members");
    if (sample.scope.exists) {
      // cgroup.events counts live processes. Keep exit-only members in the
      // ancestry checks, and still require their absence from the final sample.
      assert.ok(bracketed || exitingOnly && scopeEvents(sample.scope.events, 0)
        || scopeEvents(sample.scope.events, sample.scope.members.length ? 1 : 0), "session populated/membership proof differs");
    }
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
