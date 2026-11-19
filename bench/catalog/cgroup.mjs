import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
const root = "/sys/fs/cgroup";
const containerId = /^[a-f0-9]{64}$/;
const isContainer = (name, id) => name === id || name === `docker-${id}.scope`;
const maxDepth = 8, maxEntries = 16384, maxReadMs = 2000;

export function usageUsec(value) {
  const match = /^usage_usec (\d+)$/m.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("cgroup v2 usage_usec missing or invalid");
  return Number(match[1]);
}
function* containerGroups(id, directory, depth, entriesLeft = Infinity) {
  assert.match(id, containerId, "invalid container ID");
  function* search(dir, depth) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      assert.ok(entriesLeft-- > 0, "cgroup search exceeded entry bound");
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (isContainer(entry.name, id)) yield path;
      else if (depth > 1) yield* search(path, depth - 1);
    }
  }
  yield* search(directory, depth);
}
export function readCpu(id, directory = root) {
  const [path] = containerGroups(id, directory, 4);
  if (!path) throw new Error(`cannot find cgroup v2 for ${id}`);
  return usageUsec(readFileSync(join(path, "cpu.stat"), "utf8"));
}

function hierarchy(path, id) {
  assert.ok(typeof path === "string" && path.startsWith("/") && path.length <= 4096, "invalid load cgroup path");
  const parts = path.slice(1).split("/");
  assert.ok(parts.length <= maxDepth && parts.every((part) => part && part !== "." && part !== ".." && !/[\0\r\n]/.test(part))
    && isContainer(parts.at(-1), id) && !parts.slice(0, -1).some((part) => isContainer(part, id)), "load cgroup path differs from container ID");
  return Array.from({ length: parts.length + 1 }, (_, i) => `/${parts.slice(0, parts.length - i).join("/")}`);
}
function mountFields(line) {
  const [left, right] = line.split(" - ");
  const [, , , base, target] = left.split(" ");
  return { base, target, type: right?.split(" ")[0] };
}
function fullMount(line) {
  assert.ok(typeof line === "string" && line.length <= 4096 && !/[\r\n]/.test(line), "load cgroup mount evidence missing");
  assert.deepEqual(mountFields(line), { base: "/", target: root, type: "cgroup2" }, "load cgroup hierarchy is not mounted from its root");
}
function populated(events) {
  return typeof events === "string" && events.length <= 1024 && /^populated 1$/m.test(events)
    && [...events.matchAll(/^populated /gm)].length === 1;
}
function cpuSet(value) {
  assert.ok(typeof value === "string" && value.length <= 20480 && /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*\n?$/.test(value), "load effective cpuset missing or invalid");
  const cpus = new Set();
  for (const part of value.trimEnd().split(",")) {
    const [first, last = first] = part.split("-").map(Number);
    assert.ok(first <= last && last <= 4095, "invalid load effective cpuset range");
    for (let cpu = first; cpu <= last; cpu++) {
      assert.ok(!cpus.has(cpu), "duplicate CPU in load effective cpuset");
      cpus.add(cpu);
    }
  }
  return cpus;
}

export function verifyLoadLimits(raw, id, { start, end, quota, cpuset }) {
  assert.match(id, containerId, "invalid container ID");
  assert.ok(raw && Number.isSafeInteger(raw.startedAt) && Number.isSafeInteger(raw.finishedAt) && raw.startedAt >= start
    && raw.finishedAt < end && raw.finishedAt >= raw.startedAt && raw.finishedAt - raw.startedAt <= maxReadMs, "load cgroup observation outside active lifetime");
  fullMount(raw.mount);
  assert.ok(populated(raw.eventsBefore) && populated(raw.eventsAfter), "load cgroup not observed populated");
  assert.deepEqual(cpuSet(raw.effectiveCpus), cpuSet(cpuset), "load effective cpuset differs from configured CPUs");
  const paths = hierarchy(raw.path, id);
  assert.ok(Array.isArray(raw.quotas) && raw.quotas.length === paths.length && raw.quotas.every((row, i) => row?.path === paths[i]),
    "load cgroup quota ancestry is missing or inconsistent");
  for (const [i, { path, cpuMax }] of raw.quotas.entries()) {
    if (path === "/") {
      assert.equal(cpuMax, null, "load cgroup hierarchy root unexpectedly has cpu.max");
      continue;
    }
    const fields = typeof cpuMax === "string" && /^(max|[1-9]\d{0,19}) ([1-9]\d{0,19})\n?$/.exec(cpuMax);
    assert.ok(fields, `load cgroup cpu.max missing or invalid at ${path}`);
    if (i === 0) {
      assert.ok(fields[1] !== "max" && BigInt(fields[1]) === BigInt(quota) * BigInt(fields[2]), "load cgroup quota differs from configured CPUs");
    } else {
      // An ancestor's finite bandwidth is shared with its other descendants.
      assert.equal(fields[1], "max", `load cgroup parent quota restricts bandwidth at ${path}`);
    }
  }
}

function observeLoadLimits(id) {
  const mount = readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter((line) => mountFields(line).target === root);
  assert.equal(mount.length, 1, "load cgroup mount evidence missing or ambiguous");
  fullMount(mount[0]);
  const groups = [...containerGroups(id, root, maxDepth, maxEntries)];
  assert.equal(groups.length, 1, `load cgroup missing or ambiguous for ${id}`);
  const read = (path, file) => readFileSync(join(root, path.slice(1), file), "utf8");
  const path = "/" + relative(root, groups[0]).split(sep).join("/");
  const startedAt = Date.now(), eventsBefore = read(path, "cgroup.events");
  const effectiveCpus = read(path, "cpuset.cpus.effective");
  const quotas = hierarchy(path, id).map((path) => {
    try { return { path, cpuMax: read(path, "cpu.max") }; }
    catch (e) { if (path === "/" && e.code === "ENOENT") return { path, cpuMax: null }; throw e; }
  });
  const eventsAfter = read(path, "cgroup.events");
  return { startedAt, finishedAt: Date.now(), mount: mount[0], path, eventsBefore, eventsAfter, effectiveCpus, quotas };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  console.log(JSON.stringify(args[0] === "--load-limits" ? observeLoadLimits(args[1]) : Object.fromEntries(args.map((id) => [id, readCpu(id)]))));
}
