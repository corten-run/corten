import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, posix } from "node:path";
import { durable, readRegular, tree } from "./evidence.mjs";
import { deploymentSha256 } from "../deployments.mjs";
import { executableReference, participantExecutables } from "./participant-executables.mjs";

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
function snapshot(path, executables, pending) {
  const groups = [], processes = [];
  function walk(current) {
    const group = readGroup(current); groups.push(group);
    for (const pid of group.files["cgroup.procs"].trim().split("\n").filter(Boolean)) {
      assert.match(pid, /^[1-9]\d*$/);
      // A racing exit is an observation gap, never silently omitted membership.
      const at = `/proc/${pid}`, stat = readFileSync(`${at}/stat`, "utf8"), identity = processIdentity(stat);
      const executable = pending ? pending.capture(identity.pid) : { executableSha256: executableHash(at, executables) };
      const cgroup = readFileSync(`${at}/cgroup`, "utf8"); assert.equal(groupPath(cgroup), current);
      const type = readFileSync(`${at}/cmdline`).toString().split("\0").find((s) => /^--type=(renderer|utility|zygote|gpu-process)$/.test(s)) ?? null;
      assert.deepEqual(processIdentity(readFileSync(`${at}/stat`, "utf8")), identity);
      pending?.recheck(identity.pid, executable);
      processes.push({ stat, cgroup, ...executable, type }); // No environment or arbitrary arguments.
    }
    for (const entry of readdirSync(join(root, current), { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) walk(posix.join(current, entry.name));
    }
  }
  walk(path);
  return { at: Date.now(), groups, processes };
}

function docker(args) {
  // A fixed local daemon endpoint, not DOCKER_HOST/config supplied by the archive.
  return execFileSync("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
    encoding: "utf8", timeout: maximumSampleGapMs, maxBuffer: 16 * 2 ** 20,
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root", LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  }).trim();
}
const containerId = /^[a-f0-9]{64}$/;
function containerState(info) {
  assert.match(info.Id, containerId); assert.match(info.Image, /^sha256:[a-f0-9]{64}$/);
  return { id: info.Id, imageId: info.Image, restartCount: info.RestartCount,
    state: Object.fromEntries(["Status", "Pid", "Running", "Paused", "Restarting", "OOMKilled", "Dead", "ExitCode", "StartedAt", "FinishedAt"].map((k) => [k, info.State[k]])) };
}
function participantGroup(path, id) {
  assert.equal(posix.normalize(path), path);
  assert.ok(posix.isAbsolute(path) && !path.split("/").includes(".."));
  assert.ok([id, `docker-${id}.scope`].includes(posix.basename(path)), "Docker PID/cgroup namespace correspondence missing");
}

/** Actual read-only Linux snapshot. Never reads a PID/path supplied by saved evidence. */
export function captureBrowserParticipant(id, executables = new Map(), pending) {
  assert.equal(process.platform, "linux"); assert.match(id, containerId);
  const startedAt = Date.now();
  const inspect = () => {
    const infos = JSON.parse(docker(["container", "inspect", id])); assert.equal(infos.length, 1);
    assert.equal(infos[0].Id, id); return containerState(infos[0]);
  };
  const container = inspect();
  if (!container.state.Running) return { startedAt, endedAt: Date.now(), container, kernel: null };
  const pid = container.state.Pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const at = `/proc/${pid}`, stat = readFileSync(`${at}/stat`, "utf8"), identity = processIdentity(stat);
  assert.equal(identity.pid, pid);
  const cgroup = readFileSync(`${at}/cgroup`, "utf8"), path = groupPath(cgroup);
  participantGroup(path, id);
  const ancestors = parents(posix.dirname(path)), observed = snapshot(path, executables, pending);
  assert.ok(observed.processes.some((p) => processIdentity(p.stat).pid === pid));
  assert.deepEqual(processIdentity(readFileSync(`${at}/stat`, "utf8")), identity);
  assert.equal(readFileSync(`${at}/cgroup`, "utf8"), cgroup);
  assert.deepEqual(inspect(), container, "Docker participant changed during kernel observation");
  return { startedAt, endedAt: Date.now(), container,
    kernel: { bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), stat, cgroup, ancestors, ...observed } };
}
function browserDocker(excluded, executables, pending) {
  const inventory = docker(["container", "ls", "-aq", "--no-trunc"]).split("\n").filter(Boolean).sort();
  assert.equal(new Set(inventory).size, inventory.length); inventory.forEach((id) => assert.match(id, containerId));
  const participants = [], gaps = [];
  for (const id of inventory.filter((id) => !excluded.has(id))) {
    try { participants.push(captureBrowserParticipant(id, executables, pending)); }
    catch { gaps.push(id); } // No daemon diagnostics, commands, labels or environment retained.
  }
  return { inventory, participants, gaps };
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
  const browser = binding.request.group === "fullstack-browser";
  const excluded = new Set(browser ? docker(["container", "ls", "-aq", "--no-trunc"]).split("\n").filter(Boolean) : []);
  for (const id of excluded) assert.match(id, containerId);
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
    cpuInfo: readFileSync("/proc/cpuinfo", "utf8"), memoryInfo: readFileSync("/proc/meminfo", "utf8"),
    ...(browser ? { dockerBaseline: [...excluded].sort(), leaderIdentity: processIdentity(readFileSync(`/proc/${pid}/stat`, "utf8")) } : {}) };
    durable(join(directory, "binding.json"), `${JSON.stringify(context, null, 2)}\n`);
    fd = openSync(join(directory, "samples.jsonl"), "wx", 0o600);
  } catch (error) {
    // No bootstrap has been attached yet. Only this exclusively created empty
    // kernel child is removable; retained partial disk evidence is not deleted.
    rmdirSync(join(root, path)); throw error;
  }
  const executables = new Map(), records = new Set(), pending = browser ? participantExecutables() : null;
  let bytes = 0, samples = 0, closed = false, timer, observerError = null, attached = false;
  function sample() {
    let observed;
    for (let attempt = 0; ; attempt++) {
      try { observed = snapshot(path, executables, pending); break; }
      catch (error) { if (attempt >= 2 || !["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    }
    // Keep initial raw PID/start/executable/type observations once. Every live
    // sample independently re-reads those identities and records their references;
    // rapidly changing stat CPU fields are accounted by raw cgroup cpu.stat.
    observed.processes = observed.processes.map((p) => {
      const key = processRecordKey(p);
      if (!records.has(key)) {
        const value = serial(p); bytes += Buffer.byteLength(value);
        assert.ok(bytes <= 256 * 2 ** 20, "host observation byte bound exceeded");
        durable(join(directory, "processes", `${key}.json`), value); records.add(key);
      }
      return key;
    });
    if (browser) observed.docker = browserDocker(excluded, executables, pending);
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
  catch (error) { pending?.close(); closeSync(fd); rmdirSync(join(root, path)); throw error; }
  return Object.freeze({
    attach(pid) {
      assert.equal(attached, false); assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
      assert.equal(pid, context.leaderPid);
      if (browser) assert.deepEqual(processIdentity(readFileSync(`/proc/${pid}/stat`, "utf8")), context.leaderIdentity);
      // Only the just-spawned bootstrap PID from the live supervisor, before its start message.
      writeFileSync(join(root, path, "cgroup.procs"), String(pid)); attached = true; sample();
      timer = setInterval(() => { try { sample(); } catch { observerError = "host-observation-gap"; } }, sampleIntervalMs);
    },
    finish(result) {
      assert.equal(closed, false); closed = true; clearInterval(timer);
      let empty = false;
      try { sample(); empty = readGroup(path).files["cgroup.events"].split("\n").includes("populated 0"); }
      catch { observerError = "host-observation-gap"; }
      if (pending) {
        try { durable(join(directory, "executables.json"), serial(pending.finish())); }
        catch { observerError = "host-executable-proof-incomplete"; }
      }
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const terminal = result.terminal && empty;
      durable(join(directory, "terminal.json"), `${JSON.stringify({ terminal, attached, empty, samples, observerError,
        command: result, bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), ancestors: parents(parent) }, null, 2)}\n`);
      if (empty) rmdirSync(join(root, path)); // Own empty child only; never recursive cleanup.
      return tree(directory);
    },
  });
}

function processRecordKey(p) {
  return sha(serial({ ...processIdentity(p.stat), cgroup: p.cgroup,
    ...(p.executableRef ? { executableRef: p.executableRef, executableIdentity: p.executableIdentity }
      : { executableSha256: p.executableSha256 }), type: p.type }));
}

export function resolveParticipantExecutables(process, proof) {
  if (!Object.hasOwn(process, "executableRef")) return process;
  assert.equal(proof?.schema, "benchmark-participant-executables/v1");
  assert.ok(!Object.hasOwn(process, "executableSha256"));
  assert.equal(process.executableRef, executableReference(process.executableIdentity));
  const matches = proof.executables.filter((e) => e.ref === process.executableRef); assert.equal(matches.length, 1);
  const entry = matches[0];
  assert.deepEqual(Object.keys(entry).sort(), ["identity", "ref", "sha256"]);
  assert.deepEqual(entry.identity, process.executableIdentity); assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  return { ...process, executableSha256: entry.sha256 };
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
  const executableProof = before.entries.some((e) => e.path === "executables.json") ? read("executables.json") : null;
  assert.equal(samples.length, terminal.samples); assert.ok(samples.length >= 3);
  let previous = -1, controlsComplete = true; const identities = new Map(), accounting = new Map(), records = new Map();
  for (const sample of samples) {
    assert.ok(Number.isSafeInteger(sample.at) && sample.at >= previous);
    if (previous >= 0 && sample.at - previous > maximumSampleGapMs) controlsComplete = false;
    previous = sample.at;
    sample.processes = sample.processes.map((p) => {
      if (typeof p !== "string") return p.executableRef ? resolveParticipantExecutables(p, executableProof) : p;
      assert.match(p, /^[a-f0-9]{64}$/);
      if (!records.has(p)) {
        const record = read(`processes/${p}.json`);
        assert.equal(processRecordKey(record), p);
        records.set(p, record.executableRef ? resolveParticipantExecutables(record, executableProof) : record);
      }
      return records.get(p);
    });
    for (const participant of sample.docker?.participants ?? []) if (participant.kernel)
      participant.kernel.processes = participant.kernel.processes.map((p) => resolveParticipantExecutables(p, executableProof));
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

export function inspectBrowserParticipants(subject, observation) {
  assert.equal(subject.schema, "native-browser-host-subject/v2");
  assert.ok(Array.isArray(subject.participants));
  const ids = new Set(), { samples } = observation;
  const baseline = new Set(observation.context.dockerBaseline);
  assert.equal(baseline.size, observation.context.dockerBaseline.length);
  for (const id of baseline) assert.match(id, containerId);
  for (const p of subject.participants) {
    assert.match(p.id, containerId); assert.ok(!ids.has(p.id)); ids.add(p.id);
    assert.ok(!baseline.has(p.id));
  }
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i], d = sample.docker;
    if (!d) return false;
    assert.ok(Number.isSafeInteger(sample.at));
    if (i && (sample.at < samples[i - 1].at || sample.at - samples[i - 1].at > maximumSampleGapMs)) return false;
    assert.ok(Array.isArray(d.inventory) && Array.isArray(d.participants) && Array.isArray(d.gaps));
    const inventory = new Set(d.inventory), captured = new Set(), gaps = new Set(d.gaps);
    assert.equal(inventory.size, d.inventory.length); assert.equal(gaps.size, d.gaps.length);
    for (const id of inventory) {
      assert.match(id, containerId);
      if (!baseline.has(id) && !ids.has(id)) return false;
    }
    for (const r of d.participants) {
      const id = r.container.id; assert.match(id, containerId);
      assert.ok(!captured.has(id) && inventory.has(id) && !baseline.has(id)); captured.add(id);
      if (!ids.has(id)) return false;
      assert.ok(Number.isSafeInteger(r.startedAt) && Number.isSafeInteger(r.endedAt) && r.endedAt >= r.startedAt);
      if (sample.at > r.endedAt || r.startedAt - sample.at > maximumSampleGapMs
        || samples[i + 1] && samples[i + 1].at < r.endedAt) return false;
    }
    for (const id of gaps) { assert.match(id, containerId); assert.ok(inventory.has(id) && !baseline.has(id)); }
    if (gaps.size || [...inventory].some((id) => !baseline.has(id) && !captured.has(id))) return false;
  }
  for (const p of subject.participants) {
    assert.match(p.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.ok(["application", "upstream", "artifact"].includes(p.role));
    assert.equal(p.terminal.id, p.id); assert.equal(p.terminal.imageId, p.imageId);
    assert.equal(p.terminal.restartCount, 0);
    for (const key of ["Paused", "Restarting", "Dead"]) assert.equal(p.terminal.state[key], false);
    if (p.window === null) {
      assert.equal(p.terminal.restartCount, 0);
      assert.equal(p.terminal.state.Status, "created");
      assert.equal(p.terminal.state.Running, false); assert.equal(p.terminal.state.Pid, 0);
      assert.equal(p.terminal.state.ExitCode, 0);
      for (const key of ["Paused", "Restarting", "OOMKilled", "Dead"]) assert.equal(p.terminal.state[key], false);
      for (const key of ["StartedAt", "FinishedAt"]) assert.match(p.terminal.state[key], /^0001-01-01T00:00:00(?:\.0+)?Z$/);
      for (const r of samples.flatMap((s) => s.docker?.participants.filter((r) => r.container.id === p.id) ?? [])) {
        assert.equal(r.kernel, null); assert.equal(r.container.imageId, p.imageId); assert.equal(r.container.restartCount, 0);
        assert.equal(r.container.state.Status, "created"); assert.equal(r.container.state.Running, false); assert.equal(r.container.state.Pid, 0);
        assert.equal(r.container.state.ExitCode, 0);
        for (const key of ["Paused", "Restarting", "OOMKilled", "Dead"]) assert.equal(r.container.state[key], false);
        for (const key of ["StartedAt", "FinishedAt"]) assert.equal(r.container.state[key], p.terminal.state[key]);
      }
      continue; // Replayed stopped extraction or witnessed failed start, not an OS quota claim.
    }
    assert.notEqual(p.role, "artifact");
    const { startedAt, endedAt } = p.window;
    assert.ok(Number.isSafeInteger(startedAt) && Number.isSafeInteger(endedAt) && endedAt >= startedAt);
    assert.ok(startedAt >= subject.executionWindow.startedAt && endedAt <= subject.executionWindow.endedAt);
    if (p.terminal.state.Running) {
      assert.equal(p.terminal.state.Status, "running");
      assert.ok(Number.isSafeInteger(p.terminal.state.Pid) && p.terminal.state.Pid > 0);
    } else {
      assert.equal(p.terminal.state.Status, "exited"); assert.equal(p.terminal.state.Pid, 0);
    }
    const covering = samples.filter((s, i) => s.at >= startedAt && s.at <= endedAt
      || s.at <= startedAt && samples[i + 1]?.at >= startedAt
      || s.at >= endedAt && samples[i - 1]?.at <= endedAt);
    if (covering.length < 2 || covering.some((s) => !s.docker || s.docker.gaps.includes(p.id))) return false;
    const records = samples.flatMap((s) => s.docker.participants.filter((r) => r.container.id === p.id));
    const live = records.filter((r) => r.kernel !== null);
    if (!live.length || !live.some((r) => r.kernel.at >= startedAt && r.kernel.at <= endedAt)
      || live[0].startedAt > startedAt + maximumSampleGapMs
      || live.at(-1).endedAt < endedAt - maximumSampleGapMs) return false;
    for (let i = 1; i < live.length; i++) if (live[i].kernel.at > startedAt && live[i - 1].kernel.at < endedAt
      && live[i].kernel.at - live[i - 1].kernel.at > maximumSampleGapMs) return false;
    for (const s of samples.filter((s) => s.at >= startedAt && s.at <= endedAt))
      if (!s.docker.participants.some((r) => r.container.id === p.id)) return false;
    let identity, previousEnd = -1, phase = 0;
    const accounting = new Map(), ancestorControls = new Map();
    for (const r of records) {
      assert.ok(Number.isSafeInteger(r.startedAt) && Number.isSafeInteger(r.endedAt) && r.endedAt >= r.startedAt
        && r.startedAt >= previousEnd); previousEnd = r.endedAt;
      if (r.endedAt - r.startedAt > maximumSampleGapMs) return false;
      const c = r.container;
      assert.equal(c.imageId, p.imageId); assert.equal(c.restartCount, 0);
      for (const key of ["Paused", "Restarting", "Dead"]) assert.equal(c.state[key], false);
      if (!r.kernel && c.state.Status === "created") {
        if (phase !== 0) return false;
        assert.equal(c.state.Running, false); assert.equal(c.state.Pid, 0); assert.equal(c.state.OOMKilled, false);
        assert.equal(c.state.ExitCode, 0);
        for (const key of ["StartedAt", "FinishedAt"]) assert.match(c.state[key], /^0001-01-01T00:00:00(?:\.0+)?Z$/);
        if (r.startedAt > startedAt + maximumSampleGapMs) return false;
        continue;
      }
      assert.equal(c.state.StartedAt, p.terminal.state.StartedAt);
      if (!r.kernel) {
        assert.equal(c.state.Status, "exited"); assert.equal(c.state.Running, false); assert.equal(c.state.Pid, 0);
        if (phase === 0 || p.terminal.state.Running && r.startedAt <= endedAt) return false;
        phase = 2;
        if (r.endedAt < endedAt - maximumSampleGapMs) return false;
        if (!p.terminal.state.Running) for (const key of ["ExitCode", "OOMKilled", "FinishedAt"])
          assert.equal(c.state[key], p.terminal.state[key]);
        continue;
      }
      if (phase === 2) return false;
      phase = 1;
      assert.equal(c.state.Status, "running"); assert.equal(c.state.Running, true);
      const k = r.kernel, rootIdentity = processIdentity(k.stat), path = groupPath(k.cgroup);
      assert.equal(k.bootId, observation.context.bootId); participantGroup(path, p.id);
      assert.equal(rootIdentity.pid, c.state.Pid);
      if (p.terminal.state.Running) assert.equal(rootIdentity.pid, p.terminal.state.Pid);
      const currentIdentity = `${rootIdentity.pid}:${rootIdentity.startTicks}:${path}`;
      identity ??= currentIdentity; assert.equal(currentIdentity, identity);
      assert.ok(Number.isSafeInteger(k.at) && k.at >= r.startedAt && k.at <= r.endedAt);
      const ancestors = []; for (let at = posix.dirname(path); ; at = posix.dirname(at)) { ancestors.push(at); if (at === "/") break; }
      assert.deepEqual(k.ancestors.map((g) => g.path), ancestors);
      for (const g of k.ancestors) {
        // cgroup v2 exposes no cpu.max/memory.max on its actual root. Their
        // absence there is retained, not interpreted as child defaults or caps.
        if (!effectiveControls(g.files) && (g.path !== "/" || g.files["cpuset.cpus.effective"] === null)) return false;
        const controls = ["cpu.max", "cpuset.cpus.effective", "memory.max"].map((f) => g.files[f]);
        if (ancestorControls.has(g.path)) assert.deepEqual(controls, ancestorControls.get(g.path));
        ancestorControls.set(g.path, controls);
      }
      const groups = new Set(), members = new Map();
      for (const g of k.groups) {
        assert.ok(!groups.has(g.path)); groups.add(g.path);
        assert.ok(g.path === path || g.path.startsWith(`${path}/`)); assert.equal(posix.normalize(g.path), g.path);
        assert.deepEqual(Object.keys(g.files).sort(), [...fields].sort());
        for (const value of Object.values(g.files)) assert.ok(value === null || typeof value === "string");
        if (!effectiveControls(g.files)) return false;
        const cpu = /^usage_usec (\d+)$/m.exec(g.files["cpu.stat"] ?? ""), oom = /^oom_kill (\d+)$/m.exec(g.files["memory.events"] ?? "");
        if (!cpu || !oom || !g.files["memory.current"] || !g.files["memory.peak"]) return false;
        assert.match(g.files["memory.current"], /^\d+\n?$/); assert.match(g.files["memory.peak"], /^\d+\n?$/);
        const values = [BigInt(cpu[1]), BigInt(g.files["memory.peak"].trim()), BigInt(oom[1])];
        assert.ok(values[1] >= BigInt(g.files["memory.current"].trim()));
        const previous = accounting.get(g.path);
        if (previous) { values.forEach((v, i) => assert.ok(v >= previous.values[i]));
          for (const f of ["cpu.max", "cpuset.cpus.effective", "memory.max"]) assert.equal(g.files[f], previous.files[f]); }
        accounting.set(g.path, { values, files: g.files });
        for (const id of g.files["cgroup.procs"].trim().split("\n").filter(Boolean)) {
          assert.match(id, /^[1-9]\d*$/); assert.ok(!members.has(Number(id))); members.set(Number(id), g.path);
        }
      }
      assert.ok(groups.has(path));
      const seen = new Set();
      for (const process of k.processes) {
        const actual = processIdentity(process.stat); assert.ok(!seen.has(actual.pid)); seen.add(actual.pid);
        assert.equal(members.get(actual.pid), groupPath(process.cgroup)); assert.match(process.executableSha256, /^[a-f0-9]{64}$/);
        if (actual.pid === rootIdentity.pid) assert.deepEqual(actual, rootIdentity);
      }
      assert.equal(seen.size, members.size); assert.ok(seen.has(rootIdentity.pid));
      const controls = k.groups.find((g) => g.path === path).files, limits = p.terminal.limits;
      const [quota, period] = controls["cpu.max"].trim().split(" ");
      assert.ok(Number.isSafeInteger(limits.NanoCpus) && limits.NanoCpus > 0);
      assert.notEqual(quota, "max"); assert.equal(BigInt(quota) * 1000000000n, BigInt(limits.NanoCpus) * BigInt(period));
      assert.ok(Number.isSafeInteger(limits.Memory) && limits.Memory > 0);
      assert.equal(controls["memory.max"].trim(), String(limits.Memory));
      if (limits.CpusetCpus) assert.equal(controls["cpuset.cpus.effective"].trim(), limits.CpusetCpus);
    }
  }
  return true;
}

export function composeHostProof(binding, native, observation) {
  const incomplete = { resources: "blocked", cleanupComplete: false, blockers: ["actual-host-subject-proof-incomplete"] };
  if (observation.status !== "verified") return incomplete;
  // No native client OS caps exist. Preserve inherited whole-host controls, rather
  // than inventing a finite quota or requiring an unapproved isolated partition.
  // Exclusive ownership of that host remains the live controller's responsibility.
  const browser = binding.request.group === "fullstack-browser";
  if (binding.request.group !== "client-heavy" && !browser) return { resources: native.resources,
    cleanupComplete: observation.cleanupComplete && native.cleanupComplete,
    blockers: native.resources === "verified" && native.cleanupComplete ? [] : incomplete.blockers,
    observationManifestSha256: observation.manifestSha256 };
  if (!native.hostSubject) return incomplete;
  const subject = native.hostSubject, { samples } = observation;
  assert.ok(Number.isFinite(subject.executionWindow.startedAt) && Number.isFinite(subject.executionWindow.endedAt));
  assert.ok(subject.executionWindow.startedAt <= subject.executionWindow.endedAt);
  assert.ok(samples[0].at <= subject.executionWindow.startedAt && samples.at(-1).at >= subject.executionWindow.endedAt);
  assert.match(subject.subjectSha256, /^[a-f0-9]{64}$/); assert.match(subject.filesSha256, /^[a-f0-9]{64}$/);
  if (browser) {
    assert.equal(subject.schema, "native-browser-host-subject/v2");
    for (const key of ["node", "browser", "lockSha256"]) assert.match(subject.toolIdentities[key], /^[a-f0-9]{64}$/);
    assert.equal(observation.context.leaderIdentity.pid, observation.context.leaderPid);
  }
  assert.ok(Array.isArray(subject.processWindows));
  if (!subject.processWindows.length && (!browser || native.qualificationPassed || native.outcomes.some((r) => r.outcome !== "failed"))) return incomplete;
  if (browser && (!native.cleanupComplete || !Array.isArray(observation.context.dockerBaseline)
    || !inspectBrowserParticipants(subject, observation))) return incomplete;
  for (const window of subject.processWindows) {
    assert.ok((browser ? ["browser"] : ["compiler", "browser"]).includes(window.kind));
    assert.ok(Number.isFinite(window.startedAt) && Number.isFinite(window.endedAt) && window.endedAt >= window.startedAt);
    assert.ok(window.startedAt >= subject.executionWindow.startedAt && window.endedAt <= subject.executionWindow.endedAt);
    const found = samples.some((s) => {
      if (s.at < window.startedAt || s.at > window.endedAt) return false;
      const processes = s.processes.map((p) => ({ ...p, ...processIdentity(p.stat) }));
      const node = processes.some((p) => p.executableSha256 === subject.toolIdentities.node
        && (!browser || p.pid === observation.context.leaderPid && p.startTicks === observation.context.leaderIdentity.startTicks));
      return node && (window.kind === "compiler" ? processes.some((p) => /^rustc/.test(p.comm))
        : processes.some((p) => p.executableSha256 === subject.toolIdentities.browser && p.type === "--type=renderer"));
    });
    if (!found) return incomplete;
  }
  return { resources: "verified", cleanupComplete: true, blockers: [], policy: "actual-inherited-native-host-controls",
    nativeSubjectSha256: subject.subjectSha256, nativeFilesSha256: subject.filesSha256,
    observationManifestSha256: observation.manifestSha256 };
}
