import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { readApparatus, verifyApparatus } from "./control-stream.mjs";

export function processStat(stat) {
  if (typeof stat !== "string") return null;
  const match = /^([1-9]\d*) \([\s\S]*\) [A-Za-z] ((?:-?\d+ )*-?\d+)\n?$/.exec(stat);
  if (!match) return null;
  const fields = match[2].split(" "), pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || fields.length < 49 || !/^(0|[1-9]\d*)$/.test(fields[5])
    || !/^(0|[1-9]\d*)$/.test(fields[18])) return null;
  const flags = BigInt(fields[5]);
  if (flags > 0xffffffffn) return null;
  // Linux include/linux/sched.h PF_KTHREAD, exposed in /proc/PID/stat field 9.
  return { pid, parentPid: Number(fields[0]), startTicks: fields[18], kernelThread: (flags & 0x00200000n) !== 0n };
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
export function observeHost(apparatus) {
  assert.equal(os.platform(), "linux");
  const processes = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), identity = processStat(stat);
      assert.ok(identity && identity.pid === Number(pid), "invalid host process stat");
      processes.push({ pid: identity.pid, startTicks: identity.startTicks, stat, cgroup: readFileSync(`/proc/${pid}/cgroup`, "utf8") });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
  let controlApparatus;
  if (apparatus) {
    try { controlApparatus = { registration: apparatus, sample: readApparatus(apparatus) }; }
    catch { controlApparatus = { registration: apparatus, error: "apparatus observation unavailable" }; }
  }
  return { at: new Date().toISOString(), hostname: os.hostname(), bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    availableCpus: os.availableParallelism(), cpuInfo: readFileSync("/proc/cpuinfo", "utf8"),
    memoryInfo: readFileSync("/proc/meminfo", "utf8"), pressure: readFileSync("/proc/pressure/cpu", "utf8"),
    cgroupControllers: readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8"),
    containers: dockerRead(["ps", "-aq", "--no-trunc"]).split("\n").filter(Boolean).sort(),
    networks: dockerRead(["network", "ls", "--no-trunc", "--format", "{{.ID}}"]).split("\n").filter(Boolean).sort(),
    processes: processes.sort((a, b) => a.pid - b.pid), isolation: "unverified",
    ...(apparatus ? { controlApparatus } : {}) };
}
export function verifyHostBoundary(before, after) {
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
  const previous = new Set(before.processes.map((p) => `${p.pid}:${p.startTicks}`));
  const remaining = after.processes.filter((p) => {
    if (previous.has(`${p.pid}:${p.startTicks}`)) return false;
    const proof = processStat(p.stat);
    return !(proof?.kernelThread && proof.pid === p.pid && proof.startTicks === p.startTicks);
  });
  assert.equal(remaining.length, 0, `new persistent host processes remain: ${remaining.length}`);
  return { cleanup: "observed-boundary-matched", isolation: "unverified" };
}
