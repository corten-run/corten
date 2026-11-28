import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { regular } from "../cloud-local.mjs";
import { campaignRounds, groupNames, jsonPreparationInvocation, jsonPreparationRound, jsonTimingInvocation, runnerFor } from "../registry.mjs";
import { readApparatus, verifyApparatus } from "./control-stream.mjs";

const udevCgroup = "0::/system.slice/systemd-udevd.service/udev\n";
// Systemd 255 installs systemd-udevd as a symlink to the udevadm executable.
const udevExecutables = new Set(["/usr/lib/systemd/systemd-udevd", "/lib/systemd/systemd-udevd", "/usr/bin/udevadm"]);
export const udevSettleMs = 5000;
export const hostObservationBytes = 256 * 2 ** 20;
export const liveWorkloadEndFile = "live-workload-end.json";
export const liveWorkloadEndSchema = "benchmark-live-workload-end/v2";

export function processIdentity(stat) {
  const match = /^(\d+) \((.*)\) ([A-Za-z]) (.*)$/.exec(stat.trim());
  assert.ok(match); const rest = match[4].split(" ");
  assert.match(rest[18] ?? "", /^\d+$/);
  return { pid: Number(match[1]), startTicks: rest[18], comm: match[2] };
}

export function processRecordKey(p) {
  const identity = { ...processIdentity(p.stat), cgroup: p.cgroup,
    ...(p.executableRef ? { executableRef: p.executableRef, executableIdentity: p.executableIdentity }
      : { executableSha256: p.executableSha256 }), type: p.type };
  return createHash("sha256").update(`${JSON.stringify(identity)}\n`).digest("hex");
}

export function processStat(stat) {
  if (typeof stat !== "string") return null;
  const match = /^([1-9]\d*) \(([\s\S]*)\) ([A-Za-z]) ((?:-?\d+ )*-?\d+)\n?$/.exec(stat);
  if (!match) return null;
  const fields = match[4].split(" "), pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || fields.length < 49 || !/^(0|[1-9]\d*)$/.test(fields[5])
    || !/^(0|[1-9]\d*)$/.test(fields[18])) return null;
  const flags = BigInt(fields[5]);
  if (flags > 0xffffffffn) return null;
  // Linux include/linux/sched.h PF_KTHREAD, exposed in /proc/PID/stat field 9.
  return { pid, parentPid: Number(fields[0]), startTicks: fields[18], kernelThread: (flags & 0x00200000n) !== 0n,
    comm: match[2], state: match[3] };
}

const uptime = () => readFileSync("/proc/uptime", "utf8");
const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
export const sampleAuditClock = () => ({ bootId: bootId(), monoNs: String(process.hrtime.bigint()) });
const t = (value) => {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,12})\.(\d{2}) \d{1,15}\.\d{2}\n$/.exec(value);
  return match && BigInt(match[1] + match[2]);
};
const monotonic = (value) => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) ? BigInt(value) : null;
const boundaryTime = (observation, offline) => monotonic(offline ? observation.offlineMonoNs : observation.controlApparatus?.sample?.monoNs);
const identityOf = (p) => `${p.pid}:${p.startTicks}`;
const sameProcess = (a, b) => a && b && a.pid === b.pid && a.startTicks === b.startTicks;

// No helper process in the live driver's accounting scope. The independent
// sealed terminal clock establishes CLK_TCK for both readings on this boot.
export function liveWorkloadClock() {
  try {
    const boot = bootId(), raw = uptime(), monoNs = String(process.hrtime.bigint());
    return t(raw) !== null ? { bootId: boot, uptime: raw, monoNs } : undefined;
  } catch { return undefined; }
}

// Captured in the sealed lifetime terminal record, after the final kernel sample.
// Unsupported or unreadable clocks disable settling, not strict cleanup.
export function hostTerminalClock() {
  try {
    const hz = execFileSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1000, maxBuffer: 256,
      env: { LANG: "C" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (hz !== "100") return undefined;
    const clock = liveWorkloadClock();
    return clock && { bootId: clock.bootId, uptime: clock.uptime, ticksPerSecond: 100, monoNs: clock.monoNs };
  } catch { return undefined; }
}

function udevExecutable(pid, identity) {
  try {
    const path = `/proc/${pid}`, executable = readlinkSync(`${path}/exe`);
    if (!udevExecutables.has(executable)) return undefined;
    const { dev, ino } = statSync(`${path}/exe`, { bigint: true });
    if (!sameProcess(identity, processStat(readFileSync(`${path}/stat`, "utf8")))
      || readFileSync(`${path}/cgroup`, "utf8") !== udevCgroup) return undefined;
    return { path: executable, device: String(dev), inode: String(ino) };
  } catch (error) {
    if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
    return undefined;
  }
}

// Fixed read-only probes. No provider access, cleanup, commands from metadata or caller hooks.
export function dockerRead(args) {
  assert.ok(Array.isArray(args) && args.every((a) => typeof a === "string"));
  assert.ok(JSON.stringify(args) === JSON.stringify(["ps", "-aq", "--no-trunc"])
    || JSON.stringify(args) === JSON.stringify(["network", "ls", "--no-trunc", "--format", "{{.ID}}"])
    || (args.length === 3 && args[0] === "image" && args[1] === "inspect" && /^sha256:[a-f0-9]{64}$/.test(args[2])),
  "only fixed read-only host/image probes are allowed");
  return execFileSync("docker", args, { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    windowsHide: true, env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: os.homedir(),
      LANG: "C.UTF-8", TZ: "UTC", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function observeHost(apparatus, retainUdev = false, offline = false) {
  assert.equal(os.platform(), "linux");
  const processes = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), identity = processStat(stat);
      assert.ok(identity && identity.pid === Number(pid), "invalid host process stat");
      const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8");
      const executable = retainUdev && cgroup === udevCgroup && ["systemd-udevd", "(udev-worker)"].includes(identity.comm)
        ? udevExecutable(pid, identity) : undefined;
      processes.push({ pid: identity.pid, startTicks: identity.startTicks, stat, cgroup,
        ...(executable ? { udevExecutable: executable } : {}) });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
  let controlApparatus;
  if (apparatus) {
    try { controlApparatus = { registration: apparatus, sample: readApparatus(apparatus) }; }
    catch { controlApparatus = { registration: apparatus, error: "apparatus observation unavailable" }; }
  }
  return { at: new Date().toISOString(), hostname: os.hostname(), bootId: bootId(),
    availableCpus: os.availableParallelism(), cpuInfo: readFileSync("/proc/cpuinfo", "utf8"),
    memoryInfo: readFileSync("/proc/meminfo", "utf8"), pressure: readFileSync("/proc/pressure/cpu", "utf8"),
    cgroupControllers: readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8"),
    containers: dockerRead(["ps", "-aq", "--no-trunc"]).split("\n").filter(Boolean).sort(),
    networks: dockerRead(["network", "ls", "--no-trunc", "--format", "{{.ID}}"]).split("\n").filter(Boolean).sort(),
    processes: processes.sort((a, b) => a.pid - b.pid), isolation: "unverified",
    ...(apparatus ? { controlApparatus } : {}),
    ...(retainUdev ? { uptime: uptime(), ...(offline ? { offlineMonoNs: String(process.hrtime.bigint()) } : {}) } : {}) };
}
function newHostProcesses(before, after) {
  assert.equal(!!before.controlApparatus, !!after.controlApparatus, "apparatus appeared/disappeared across boundary");
  if (before.controlApparatus) {
    assert.deepEqual(after.controlApparatus.registration, before.controlApparatus.registration);
    const { registration } = before.controlApparatus;
    for (const observation of [before, after]) {
      verifyApparatus(registration.binding, registration, observation.controlApparatus.sample);
      assert.deepEqual(observation.controlApparatus.sample.host, { hostname: observation.hostname, bootId: observation.bootId });
      for (const member of [...registration.members, registration.listener]) {
        const raw = observation.processes.find((p) => p.pid === member.pid);
        assert.ok(raw && raw.startTicks === member.startTicks && raw.cgroup === member.cgroup, "declared apparatus missing from raw inventory");
        assert.equal(processStat(raw.stat)?.parentPid, member.parentPid);
      }
      const declared = new Set([...registration.members, registration.listener].map((p) => p.pid));
      for (const raw of observation.processes) if (!declared.has(raw.pid)) {
        const identity = processStat(raw.stat); assert.ok(identity, "apparatus boundary lacks raw process ancestry");
        assert.ok(identity.parentPid !== registration.listener.pid && !registration.members.some((p) => p.pid === identity.parentPid)
          && raw.cgroup !== registration.listener.cgroup && !raw.cgroup.startsWith("0::/user.slice/")
          && !/\/session-[^/]+\.scope(?:\/|\n)/.test(raw.cgroup), "undeclared SSH/login participant cannot enter baseline");
      }
    }
  }
  assert.equal(after.bootId, before.bootId, "host rebooted");
  assert.equal(after.hostname, before.hostname, "host changed");
  assert.deepEqual(after.containers, before.containers, "native containers remain or baseline changed");
  assert.deepEqual(after.networks, before.networks, "native networks remain or baseline changed");
  const previous = new Set(before.processes.map(identityOf));
  return after.processes.filter((p) => {
    if (previous.has(identityOf(p))) return false;
    const proof = processStat(p.stat);
    return !(proof?.kernelThread && proof.pid === p.pid && proof.startTicks === p.startTicks);
  });
}

export function verifyHostBoundary(before, after) {
  const remaining = newHostProcesses(before, after).length;
  assert.equal(remaining, 0, `new persistent host processes remain: ${remaining}`);
  return { cleanup: "observed-boundary-matched", isolation: "unverified" };
}

function processInventory(observation) {
  const rows = new Map();
  for (const p of observation.processes) {
    const raw = processStat(p.stat);
    assert.ok(sameProcess(p, raw) && !rows.has(p.pid), "invalid process identity at udev boundary");
    rows.set(p.pid, { ...p, ...raw });
  }
  return rows;
}

const executableOf = (p) => {
  const e = p?.udevExecutable;
  return e && udevExecutables.has(e.path) && typeof e.device === "string" && /^\d+$/.test(e.device)
    && typeof e.inode === "string" && /^[1-9]\d*$/.test(e.inode)
    ? `${e.path}:${e.device}:${e.inode}` : undefined;
};
const isUdevDaemon = (p) => p && !p.kernelThread && p.comm === "systemd-udevd" && p.parentPid === 1 && p.cgroup === udevCgroup;

export function udevSettlePolicy(group, phase) {
  if (group === "json-api" && phase === "prepare") return "preparation";
  if (phase === "timing" && groupNames.includes(group)) return "post-terminal";
  return null;
}

// The caller admits the binding before running or replaying the phase. A clock
// belongs to its exact native command, never to another command in that phase.
export function terminalClockPolicy(binding, invocation, campaignRound, phase) {
  const { group, round } = binding.request, policy = udevSettlePolicy(group, phase);
  if (!policy || !invocation || !isDeepStrictEqual(invocation, binding.execution?.invocation)) return null;
  const timingRound = campaignRounds(campaignRound)[group];
  if (policy === "preparation") return round === jsonPreparationRound(campaignRound)
    && isDeepStrictEqual(invocation, jsonPreparationInvocation(campaignRound)) ? policy : null;
  if (round !== timingRound || invocation.executable !== "node" || !Array.isArray(invocation.argv)) return null;
  if (group === "json-api") {
    const receipt = invocation.argv.at(-1);
    return typeof receipt === "string" && receipt && isDeepStrictEqual(invocation, jsonTimingInvocation(round, receipt)) ? policy : null;
  }
  const { entry, selection } = runnerFor(group), prefix = [entry, round, ...selection];
  return isDeepStrictEqual(invocation.argv.slice(0, prefix.length), prefix) ? policy : null;
}

// This record is usable only from the successful, bound, isolated Live Delivery
// measurement command. The native reader also replays the measured actor ends.
export function readLiveWorkloadEnd({ binding, invocation, round, phase, result, folder }) {
  const { request, execution } = binding;
  if (request.group !== "live-delivery" || phase !== "timing" || !execution.effectiveOptions?.isolated
    || !execution.effectiveOptions.measure || !execution.effectiveOptions.build
    || !terminalClockPolicy(binding, invocation, round, phase) || result?.success !== true || result.code !== 0
    || result.terminal !== true || result.cancelled || result.forced || result.signal !== null || result.error !== null) return;
  let bytes;
  try { bytes = regular(join(folder, liveWorkloadEndFile), 1024); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  let record;
  try { record = JSON.parse(bytes); }
  catch { assert.fail("invalid live workload end record"); }
  const clock = record?.clock, { pid } = result;
  assert.ok(Number.isSafeInteger(pid) && pid > 1, "live workload end lacks a bound command PID");
  assert.ok(isDeepStrictEqual(record, { schema: liveWorkloadEndSchema, round: request.round, commit: request.commit, pid, clock }),
    "live workload end differs from native invocation");
  assert.ok(clock && isDeepStrictEqual(Object.keys(clock).sort(), ["bootId", "monoNs", "uptime"]), "invalid live workload clock");
  return clock;
}

export function verifyLiveWorkloadWindows(before, offline, end, ends, count) {
  let previousMono = boundaryTime(before, offline), previousBoot = t(before.uptime);
  const cutoffMono = monotonic(end.monoNs), cutoffBoot = t(end.uptime);
  assert.ok(count > 0 && ends.length === count && previousMono !== null && previousBoot !== null
    && cutoffMono !== null && cutoffBoot !== null && end.bootId === before.bootId,
    "live workload end lacks its measured actor windows");
  for (const clock of ends) {
    const mono = monotonic(clock?.monoNs), boot = t(clock?.uptime);
    // Linux prints both /proc/uptime and process start time in truncated
    // boot-time ticks at USER_HZ=100. Do not convert CLOCK_MONOTONIC to that
    // domain: it excludes time spent suspended. Equal boot buckets here are
    // fine; every worker must start in a strictly later bucket than the end.
    assert.ok(clock?.bootId === end.bootId && mono !== null && previousMono < mono && mono < cutoffMono
      && boot !== null && previousBoot <= boot && boot <= cutoffBoot, "measured actor window outside live workload boundary");
    previousMono = mono; previousBoot = boot;
  }
}

// Only a cohort entirely attributable to the existing daemon earns another
// read. Timing uses terminal unless the specific Live Delivery proof is needed.
export function udevSettleCandidates(before, after, terminal, policy = "post-terminal", offline = false, readWorkloadEnd) {
  assert.ok(policy === "post-terminal" || policy === "preparation");
  const remaining = newHostProcesses(before, after);
  if (!remaining.length || !terminal || terminal.bootId !== before.bootId || terminal.ticksPerSecond !== 100) return null;
  const start = t(before.uptime), end = t(terminal.uptime), first = t(after.uptime);
  if (start === null || end === null || first === null || !(start < end && end < first)) return null;
  const startMono = boundaryTime(before, offline), endMono = monotonic(terminal.monoNs), firstMono = boundaryTime(after, offline);
  if (startMono === null || endMono === null || firstMono === null || !(startMono < endMono && endMono < firstMono)) return null;
  const baseline = processInventory(before), observed = processInventory(after), workers = remaining.map((p) => observed.get(p.pid));
  const daemon = observed.get(workers[0].parentPid), original = baseline.get(daemon?.pid);
  const exe = executableOf(daemon);
  if (!isUdevDaemon(original) || !isUdevDaemon(daemon) || !sameProcess(original, daemon) || !exe || executableOf(original) !== exe) return null;
  if (!workers.every((p) => !p.kernelThread && p.parentPid === daemon.pid && p.comm === "(udev-worker)" && p.state === "S"
    && p.cgroup === udevCgroup && executableOf(p) === exe && BigInt(p.startTicks) > start && BigInt(p.startTicks) <= first)) return null;
  if (policy === "post-terminal" && workers.some((p) => BigInt(p.startTicks) <= end)) {
    // A worker in the baseline is not part of a proved post-workload cohort.
    if ([...baseline.values()].some((p) => p.comm === "(udev-worker)" || p.parentPid === daemon.pid)) return null;
    const workload = readWorkloadEnd?.();
    if (!workload || workload.bootId !== before.bootId) return null;
    const work = t(workload.uptime), workMono = monotonic(workload.monoNs);
    if (work === null || workMono === null || !(start < work && work < end && startMono < workMono && workMono < endMono)
      || workers.some((p) => BigInt(p.startTicks) <= work)) return null;
  }
  return { daemon, workers };
}

export function verifySettledHostBoundary(before, after, settled, terminal, policy, offline = false, readWorkloadEnd) {
  assert.deepEqual(after.terminalClock, terminal, "terminal clock differs from the sealed first boundary");
  const candidates = udevSettleCandidates(before, after, terminal, policy, offline, readWorkloadEnd);
  assert.ok(candidates, "initial host boundary is not eligible for udev settling");
  const first = t(after.uptime), last = t(settled.uptime);
  // Allow the procfs clock's 10 ms rounding at the lower edge, but no second retry.
  assert.ok(last !== null && last - first >= BigInt(udevSettleMs / 10 - 1) && last - first <= 1000n,
    "settled host observation outside the bounded interval");
  const settledMono = boundaryTime(settled, offline), firstMono = boundaryTime(after, offline);
  const wait = BigInt(udevSettleMs) * 1000000n;
  assert.ok(settledMono !== null && settledMono - firstMono >= wait && settledMono - firstMono <= 10000000000n,
    "settled host observation outside the bounded monotonic interval");
  const clean = verifyHostBoundary(before, settled);
  const final = processInventory(settled), daemon = final.get(candidates.daemon.pid);
  assert.ok(isUdevDaemon(daemon) && sameProcess(candidates.daemon, daemon) && executableOf(candidates.daemon) === executableOf(daemon),
    "udev daemon changed across host settle");
  assert.ok(candidates.workers.every((p) => !sameProcess(p, final.get(p.pid))), "udev worker identity still present");
  return { ...clean, settledUdevWorkers: candidates.workers.map(({ pid, startTicks }) => ({ pid, startTicks })) };
}

export function verifyLifetimeSettledBoundary({ binding, invocation, round, phase, lifetime, before, after, settled, offline, liveWorkloadEnd }) {
  const policy = terminalClockPolicy(binding, invocation, round, phase);
  assert.ok(policy && lifetime?.status === "verified" && lifetime.cleanupComplete && lifetime.terminalClock,
    "udev settle lacks an eligible sealed terminal lifetime");
  return verifySettledHostBoundary(before, after, settled, lifetime.terminalClock, policy, offline, liveWorkloadEnd);
}
