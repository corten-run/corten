import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, posix } from "node:path";
import { durable, readRegular, tree } from "./evidence.mjs";
import { deploymentSha256 } from "../deployments.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const serial = (v) => `${JSON.stringify(v)}\n`;
const fields = ["cgroup.procs", "cgroup.events", "cpu.stat", "cpu.max", "cpuset.cpus.effective", "memory.current", "memory.peak", "memory.max", "memory.events"];
const root = "/sys/fs/cgroup";
const sampleIntervalMs = 100, maximumSampleGapMs = 1000;
export function processIdentity(stat) {
  const match = /^(\d+) \((.*)\) ([A-Za-z]) (.*)$/.exec(stat.trim());
  assert.ok(match); const rest = match[4].split(" ");
  assert.match(rest[18] ?? "", /^\d+$/);
  return { pid: Number(match[1]), startTicks: rest[18], comm: match[2] };
}
function groupPath(text) {
  const path = /^0::([^\n]+)\n?$/.exec(text)?.[1];
  assert.ok(path && posix.isAbsolute(path) && !path.split("/").includes("..")); return path;
}
function readGroup(path) {
  const actual = join(root, path);
  assert.ok(!lstatSync(actual).isSymbolicLink());
  return { path, files: Object.fromEntries(fields.map((key) => {
    try { return [key, readFileSync(join(actual, key), "utf8")]; }
    catch (error) { if (error.code === "ENOENT") return [key, null]; throw error; }
  })) };
}
function parents(path) {
  const values = [];
  for (;;) { values.push(readGroup(path)); if (path === "/") return values; path = posix.dirname(path); }
}
function effectiveControls(files) {
  const cpu = files["cpu.max"], cpus = files["cpuset.cpus.effective"], memory = files["memory.max"];
  if (cpu !== null) assert.match(cpu, /^(max|[1-9]\d*) [1-9]\d*\n?$/);
  if (memory !== null) assert.match(memory, /^(max|0|[1-9]\d*)\n?$/);
  if (cpus !== null) {
    assert.match(cpus, /^(0|[1-9]\d*)(?:-(0|[1-9]\d*))?(?:,(0|[1-9]\d*)(?:-(0|[1-9]\d*))?)*\n?$/);
    let previous = -1;
    for (const range of cpus.trim().split(",")) {
      const [start, end = start] = range.split("-").map(Number);
      assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > previous && end >= start);
      previous = end;
    }
  }
  return cpu !== null && cpus !== null && memory !== null;
}
function executableHash(at, executables) {
  const executable = readlinkSync(`${at}/exe`), inode = statSync(`${at}/exe`);
  const key = `${executable}:${inode.dev}:${inode.ino}:${inode.size}:${inode.mtimeMs}:${inode.ctimeMs}`;
  let hash = executables.get(key);
  if (!hash) { hash = sha(readFileSync(`${at}/exe`)); executables.set(key, hash); }
  return hash;
}
function snapshot(path, executables) {
  const groups = [], processes = [];
  function walk(current) {
    const group = readGroup(current); groups.push(group);
    for (const pid of group.files["cgroup.procs"].trim().split("\n").filter(Boolean)) {
      assert.match(pid, /^[1-9]\d*$/);
      // A racing exit is an observation gap, never silently omitted membership.
      const at = `/proc/${pid}`, stat = readFileSync(`${at}/stat`, "utf8"), identity = processIdentity(stat);
      const executableSha256 = executableHash(at, executables);
      const cgroup = readFileSync(`${at}/cgroup`, "utf8"); assert.equal(groupPath(cgroup), current);
      const type = readFileSync(`${at}/cmdline`).toString().split("\0").find((s) => /^--type=(renderer|utility|zygote|gpu-process)$/.test(s)) ?? null;
      assert.deepEqual(processIdentity(readFileSync(`${at}/stat`, "utf8")), identity);
      processes.push({ stat, cgroup, executableSha256, type }); // No environment or arbitrary arguments.
    }
    for (const entry of readdirSync(join(root, current), { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) walk(posix.join(current, entry.name));
    }
  }
  walk(path);
  return { at: Date.now(), groups, processes };
}

/** Own one fresh delegated child cgroup. No budgets, pinning or parent controls are changed. */
export function beginLifetime({ campaign, binding, invocation, directory, command, pid }) {
  assert.equal(process.platform, "linux"); assert.match(campaign, /^r[1-9]\d*-[a-f0-9]{16}$/);
  assert.ok(Number.isSafeInteger(command) && command >= 0);
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  const own = groupPath(readFileSync("/proc/self/cgroup", "utf8"));
  assert.equal(posix.basename(own), "supervisor", "owned unit must provide DelegateSubgroup=supervisor");
  const parent = posix.dirname(own);
  const round = campaign.slice(0, campaign.lastIndexOf("-"));
  assert.match(parent, new RegExp(`/corten-bench-groups-${round}-[a-f0-9]{16}\\.service$`), "worker must be in its owned delegated unit");
  assert.equal(readFileSync(join(root, parent, "cgroup.procs"), "utf8").trim(), "", "delegated unit root must have no internal processes");
  const controllers = readFileSync(join(root, parent, "cgroup.subtree_control"), "utf8").trim().split(/\s+/);
  assert.ok(["cpu", "cpuset", "memory"].every((key) => controllers.includes(key)), "required accounting controllers must be delegated and enabled");
  const path = `${parent}/native-${command}-${randomBytes(8).toString("hex")}`;
  mkdirSync(join(root, path)); // Exclusive creation. Never adopt a saved or existing cgroup.
  let context, fd;
  try {
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(join(directory, "processes"), { mode: 0o700 });
    context = { schema: "benchmark-isolated-host-lifetime/v1", campaign, group: binding.request.group,
    round: binding.request.round, commit: binding.request.commit, bindingSha256: deploymentSha256(binding), invocation,
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), parent, path, command, leaderPid: pid,
    policy: "observed-inherited-native-defaults; external exclusive-host ownership is separate", ancestors: parents(parent),
    cpuInfo: readFileSync("/proc/cpuinfo", "utf8"), memoryInfo: readFileSync("/proc/meminfo", "utf8") };
    durable(join(directory, "binding.json"), `${JSON.stringify(context, null, 2)}\n`);
    fd = openSync(join(directory, "samples.jsonl"), "wx", 0o600);
  } catch (error) {
    // No bootstrap has been attached yet. Only this exclusively created empty
    // kernel child is removable; retained partial disk evidence is not deleted.
    rmdirSync(join(root, path)); throw error;
  }
  const executables = new Map(), records = new Set();
  let bytes = 0, samples = 0, closed = false, timer, observerError = null, attached = false;
  function sample() {
    let observed;
    for (let attempt = 0; ; attempt++) {
      try { observed = snapshot(path, executables); break; }
      catch (error) { if (attempt >= 2 || !["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    }
    // Keep initial raw PID/start/executable/type observations once. Every live
    // sample independently re-reads those identities and records their references;
    // rapidly changing stat CPU fields are accounted by raw cgroup cpu.stat.
    observed.processes = observed.processes.map((p) => {
      const key = sha(serial({ ...processIdentity(p.stat), cgroup: p.cgroup, executableSha256: p.executableSha256, type: p.type }));
      if (!records.has(key)) {
        const value = serial(p); bytes += Buffer.byteLength(value);
        assert.ok(bytes <= 256 * 2 ** 20, "host observation byte bound exceeded");
        durable(join(directory, "processes", `${key}.json`), value); records.add(key);
      }
      return key;
    });
    const value = serial(observed); bytes += Buffer.byteLength(value);
    assert.ok(bytes <= 256 * 2 ** 20, "host observation byte bound exceeded");
    const data = Buffer.from(value); let offset = 0;
    while (offset < data.length) { const n = writeSync(fd, data, offset); assert.ok(n > 0); offset += n; }
    samples++;
  }
  // The fresh bootstrap still waits for IPC outside this empty command scope.
  // Hash its actual executable before sampling starts, not across the empty-to-
  // attached boundary. Attach independently rechecks the executable cache key.
  try { executableHash(`/proc/${pid}`, executables); sample(); }
  catch (error) { closeSync(fd); rmdirSync(join(root, path)); throw error; }
  return Object.freeze({
    attach(pid) {
      assert.equal(attached, false); assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
      assert.equal(pid, context.leaderPid);
      // Only the just-spawned bootstrap PID from the live supervisor, before its start message.
      writeFileSync(join(root, path, "cgroup.procs"), String(pid)); attached = true; sample();
      timer = setInterval(() => { try { sample(); } catch { observerError = "host-observation-gap"; } }, sampleIntervalMs);
    },
    finish(result) {
      assert.equal(closed, false); closed = true; clearInterval(timer);
      let empty = false;
      try { sample(); empty = readGroup(path).files["cgroup.events"].split("\n").includes("populated 0"); }
      catch { observerError = "host-observation-gap"; }
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const terminal = result.terminal && empty;
      durable(join(directory, "terminal.json"), `${JSON.stringify({ terminal, attached, empty, samples, observerError,
        command: result, bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), ancestors: parents(parent) }, null, 2)}\n`);
      if (empty) rmdirSync(join(root, path)); // Own empty child only; never recursive cleanup.
      return tree(directory);
    },
  });
}

/** Intrinsic replay of actual retained observations, not authentication of their origin. */
export function inspectLifetime(binding, invocation, directory, expected) {
  const before = tree(directory), read = (name) => JSON.parse(readRegular(join(directory, name)));
  const context = read("binding.json"), terminal = read("terminal.json");
  assert.equal(context.schema, "benchmark-isolated-host-lifetime/v1");
  assert.equal(context.bindingSha256, deploymentSha256(binding)); assert.deepEqual(context.invocation, invocation);
  for (const key of ["campaign", "command"]) assert.equal(context[key], expected[key]);
  assert.equal(context.leaderPid, expected.pid);
  assert.match(context.campaign, /^r[1-9]\d*-[a-f0-9]{16}$/);
  const round = context.campaign.slice(0, context.campaign.lastIndexOf("-"));
  assert.equal(posix.normalize(context.parent), context.parent);
  assert.ok(posix.isAbsolute(context.parent));
  assert.match(context.parent, new RegExp(`/corten-bench-groups-${round}-[a-f0-9]{16}\\.service$`));
  assert.match(context.path, new RegExp(`^${context.parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/native-${expected.command}-[a-f0-9]{16}$`));
  assert.equal(context.group, binding.request.group); assert.equal(context.round, binding.request.round); assert.equal(context.commit, binding.request.commit);
  assert.equal(terminal.bootId, context.bootId); assert.equal(terminal.attached, true);
  assert.deepEqual(terminal.command, expected.result);
  const ancestorPaths = [];
  for (let p = context.parent; ; p = posix.dirname(p)) { ancestorPaths.push(p); if (p === "/") break; }
  assert.deepEqual(context.ancestors.map((g) => g.path), ancestorPaths);
  assert.deepEqual(terminal.ancestors.map((g) => g.path), ancestorPaths);
  for (let i = 0; i < ancestorPaths.length; i++) for (const field of ["cpu.max", "cpuset.cpus.effective", "memory.max"])
    assert.equal(terminal.ancestors[i].files[field], context.ancestors[i].files[field], "inherited resource controls changed");
  const samples = readRegular(join(directory, "samples.jsonl")).toString().trimEnd().split("\n").map((s) => JSON.parse(s));
  assert.equal(samples.length, terminal.samples); assert.ok(samples.length >= 3);
  let previous = -1, controlsComplete = true; const identities = new Map(), accounting = new Map(), records = new Map();
  for (const sample of samples) {
    assert.ok(Number.isSafeInteger(sample.at) && sample.at >= previous);
    if (previous >= 0 && sample.at - previous > maximumSampleGapMs) controlsComplete = false;
    previous = sample.at;
    sample.processes = sample.processes.map((p) => {
      if (typeof p !== "string") return p; // Full raw observations are also replayable.
      assert.match(p, /^[a-f0-9]{64}$/);
      if (!records.has(p)) {
        const record = read(`processes/${p}.json`);
        assert.equal(sha(serial({ ...processIdentity(record.stat), cgroup: record.cgroup,
          executableSha256: record.executableSha256, type: record.type })), p);
        records.set(p, record);
      }
      return records.get(p);
    });
    const members = new Map(), groups = new Set();
    for (const group of sample.groups) {
      assert.ok(!groups.has(group.path)); groups.add(group.path);
      assert.ok(group.path === context.path || group.path.startsWith(context.path + "/"));
      assert.ok(!group.path.split("/").includes(".."));
      assert.deepEqual(Object.keys(group.files).sort(), [...fields].sort());
      for (const field of fields) assert.ok(group.files[field] === null || typeof group.files[field] === "string");
      if (!effectiveControls(group.files)) controlsComplete = false;
      if (!group.files["cpu.stat"] || !group.files["memory.current"] || !group.files["memory.peak"] || !group.files["memory.events"]) controlsComplete = false;
      else {
        assert.match(group.files["memory.current"], /^\d+\n?$/); assert.match(group.files["memory.peak"], /^\d+\n?$/);
        assert.ok(BigInt(group.files["memory.peak"].trim()) >= BigInt(group.files["memory.current"].trim()));
        const usage = /^usage_usec (\d+)$/m.exec(group.files["cpu.stat"]), oom = /^oom_kill (\d+)$/m.exec(group.files["memory.events"]);
        assert.ok(usage && oom);
        const last = accounting.get(group.path);
        if (last) {
          assert.ok(BigInt(usage[1]) >= last.cpu && BigInt(group.files["memory.peak"].trim()) >= last.peak);
          for (const field of ["cpu.max", "cpuset.cpus.effective", "memory.max"]) assert.equal(group.files[field], last.files[field]);
          if (oom[1] !== last.oom) controlsComplete = false;
        }
        accounting.set(group.path, { cpu: BigInt(usage[1]), peak: BigInt(group.files["memory.peak"].trim()), oom: oom[1], files: group.files });
      }
      for (const pid of group.files["cgroup.procs"].trim().split("\n").filter(Boolean)) {
        assert.match(pid, /^[1-9]\d*$/); assert.ok(!members.has(Number(pid))); members.set(Number(pid), group.path);
      }
    }
    assert.ok(sample.groups.some((g) => g.path === context.path));
    const seen = new Set();
    for (const p of sample.processes) {
      const identity = processIdentity(p.stat); assert.ok(!seen.has(identity.pid)); seen.add(identity.pid);
      assert.equal(members.get(identity.pid), groupPath(p.cgroup)); assert.match(p.executableSha256, /^[a-f0-9]{64}$/);
      const key = `${identity.pid}:${identity.startTicks}`;
      identities.set(key, { ...identity, executableSha256: p.executableSha256, type: p.type });
    }
    assert.equal(seen.size, members.size);
  }
  assert.deepEqual(samples[0].processes, []);
  assert.deepEqual(tree(directory), before);
  const empty = (sample) => sample.processes.length === 0 && sample.groups.every((g) =>
    g.files["cgroup.procs"].trim() === "" && (g.files["cgroup.events"] ?? "").split("\n").filter((s) => s.startsWith("populated ")).join("\n") === "populated 0");
  const checks = { accounting: controlsComplete, terminal: terminal.terminal === true && terminal.command.terminal === true,
    empty: terminal.empty === true && empty(samples[0]) && empty(samples.at(-1)), observer: terminal.observerError === null,
    unforced: !terminal.command.cancelled && !terminal.command.forced,
    leader: [...identities.values()].some((p) => p.pid === context.leaderPid) };
  const complete = Object.values(checks).every(Boolean);
  return { status: complete ? "verified" : "blocked", cleanupComplete: complete, context,
    samples, identities: [...identities.values()], manifestSha256: before.sha256, checks };
}

export function composeHostProof(binding, native, observation) {
  const incomplete = { resources: "blocked", cleanupComplete: false, blockers: ["actual-host-subject-proof-incomplete"] };
  if (observation.status !== "verified") return incomplete;
  // No native client OS caps exist. Preserve inherited whole-host controls, rather
  // than inventing a finite quota or requiring an unapproved isolated partition.
  // Exclusive ownership of that host remains the live controller's responsibility.
  if (binding.request.group !== "client-heavy") return { resources: native.resources,
    cleanupComplete: observation.cleanupComplete && native.cleanupComplete,
    blockers: native.resources === "verified" && native.cleanupComplete ? [] : incomplete.blockers,
    observationManifestSha256: observation.manifestSha256 };
  if (!native.hostSubject) return incomplete;
  const subject = native.hostSubject, { samples } = observation;
  assert.ok(Number.isFinite(subject.executionWindow.startedAt) && Number.isFinite(subject.executionWindow.endedAt));
  assert.ok(subject.executionWindow.startedAt <= subject.executionWindow.endedAt);
  assert.ok(samples[0].at <= subject.executionWindow.startedAt && samples.at(-1).at >= subject.executionWindow.endedAt);
  assert.match(subject.subjectSha256, /^[a-f0-9]{64}$/); assert.match(subject.filesSha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(subject.processWindows) && subject.processWindows.length > 0);
  for (const window of subject.processWindows) {
    assert.ok(["compiler", "browser"].includes(window.kind));
    assert.ok(Number.isFinite(window.startedAt) && Number.isFinite(window.endedAt) && window.endedAt >= window.startedAt);
    const found = samples.some((s) => {
      if (s.at < window.startedAt || s.at > window.endedAt) return false;
      const processes = s.processes.map((p) => ({ ...p, ...processIdentity(p.stat) }));
      const node = processes.some((p) => p.executableSha256 === subject.toolIdentities.node);
      return node && (window.kind === "compiler" ? processes.some((p) => /^rustc/.test(p.comm))
        : processes.some((p) => p.executableSha256 === subject.toolIdentities.browser && p.type === "--type=renderer"));
    });
    if (!found) return incomplete;
  }
  return { resources: "verified", cleanupComplete: true, blockers: [], policy: "actual-inherited-native-host-controls",
    nativeSubjectSha256: subject.subjectSha256, nativeFilesSha256: subject.filesSha256,
    observationManifestSha256: observation.manifestSha256 };
}
