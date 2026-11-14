import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";

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
export function observeHost() {
  assert.equal(os.platform(), "linux");
  const processes = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), parts = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      processes.push({ pid: Number(pid), startTicks: parts[19], cgroup: readFileSync(`/proc/${pid}/cgroup`, "utf8") });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
  return { at: new Date().toISOString(), hostname: os.hostname(), bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    availableCpus: os.availableParallelism(), cpuInfo: readFileSync("/proc/cpuinfo", "utf8"),
    memoryInfo: readFileSync("/proc/meminfo", "utf8"), pressure: readFileSync("/proc/pressure/cpu", "utf8"),
    cgroupControllers: readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8"),
    containers: dockerRead(["ps", "-aq", "--no-trunc"]).split("\n").filter(Boolean).sort(),
    networks: dockerRead(["network", "ls", "--no-trunc", "--format", "{{.ID}}"]).split("\n").filter(Boolean).sort(),
    processes: processes.sort((a, b) => a.pid - b.pid), isolation: "unverified" };
}
export function verifyHostBoundary(before, after) {
  assert.equal(after.bootId, before.bootId, "host rebooted");
  assert.equal(after.hostname, before.hostname, "host changed");
  assert.deepEqual(after.containers, before.containers, "native containers remain or baseline changed");
  assert.deepEqual(after.networks, before.networks, "native networks remain or baseline changed");
  const previous = new Set(before.processes.map((p) => `${p.pid}:${p.startTicks}`));
  assert.deepEqual(after.processes.filter((p) => !previous.has(`${p.pid}:${p.startTicks}`)), [], "new persistent host processes remain");
  return { cleanup: "observed-boundary-matched", isolation: "unverified" };
}
