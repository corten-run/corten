import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function cgroupDirectory(id, root = "/sys/fs/cgroup") {
  assert.match(id, /^[a-f0-9]{64}$/);
  const search = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === id || entry.name === `docker-${id}.scope`) return path;
      if (depth > 0) { const found = search(path, depth - 1); if (found) return found; }
    }
  };
  const path = search(root, 3); assert.ok(path, `missing native cgroup ${id}`); return path;
}
const counters = (body) => Object.fromEntries(body.trim().split("\n").map((line) => { const [k, v] = line.split(/\s+/); return [k, Number(v)]; }));
export function resource(path) {
  try {
    const cpu = readFileSync(join(path, "cpu.stat"), "utf8"), memory = readFileSync(join(path, "memory.current"), "utf8"), events = readFileSync(join(path, "memory.events"), "utf8");
    const procs = readFileSync(join(path, "cgroup.procs"), "utf8").trim().split("\n").filter(Boolean);
    assert.ok(Number.isFinite(counters(cpu).usage_usec) && Number.isFinite(Number(memory)));
    return { cpu, memory, events, procs, cpuSeconds: counters(cpu).usage_usec / 1e6, memoryBytes: Number(memory), running: procs.length > 0, oomKilled: counters(events).oom_kill > 0 };
  } catch (error) { return { unavailable: error.message }; }
}

// cgroup files may block on a busy virtualized host. Never read them on the
// socket scheduler's event loop during a measured window.
export async function resourceAsync(path) {
  const startedNs = process.hrtime.bigint();
  try {
    const [cpu, memory, events, tasks] = await Promise.all(["cpu.stat", "memory.current", "memory.events", "cgroup.procs"].map((file) => readFile(join(path, file), "utf8")));
    const procs = tasks.trim().split("\n").filter(Boolean);
    assert.ok(Number.isFinite(counters(cpu).usage_usec) && Number.isFinite(Number(memory)));
    return { cpu, memory, events, procs, cpuSeconds: counters(cpu).usage_usec / 1e6, memoryBytes: Number(memory), running: procs.length > 0,
      oomKilled: counters(events).oom_kill > 0, startedNs: String(startedNs), endedNs: String(process.hrtime.bigint()) };
  } catch (error) { return { unavailable: error.message, startedNs: String(startedNs), endedNs: String(process.hrtime.bigint()) }; }
}
