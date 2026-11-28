// Bracket load resource reads and replay them against the exact Docker lifetime.
import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, openSync, readSync, statfsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { timestampNs } from "./fixed-stream.mjs";

const root = "/sys/fs/cgroup", cgroup2 = 0x63677270;
export const loadResourcePeriodMs = 1000;
export const loadResourceCaptureSchema = "json-api-load-resources/v1";
const edgeNs = 5_000_000_000n;
const msNs = (ms) => BigInt(ms) * 1_000_000n;
const natural = (n) => Number.isSafeInteger(n) && n >= 0;
const positive = (n) => natural(n) && n > 0;
const containerId = (id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
const objectId = (id) => typeof id === "string" && /^\d{1,20}:[1-9]\d{0,19}$/.test(id);
const fdPath = (fd) => `/proc/self/fd/${fd}`;
const same = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);
export class LoadResourceLifetimeEnded extends Error {}
export class LoadProcessAbsentBeforeRead extends LoadResourceLifetimeEnded {}
export class LoadProcessExitedBeforeCounters extends LoadResourceLifetimeEnded {
  constructor(processObject, startTicks) {
    super("load process identity unavailable at exit");
    this.processObject = processObject;
    this.startTicks = startTicks;
  }
}

function pathParts(path, id) {
  assert.ok(containerId(id) && typeof path === "string" && path.length <= 4096 && path.startsWith("/"), "invalid load cgroup path");
  const parts = path.slice(1).split("/");
  assert.ok(parts.length <= 8 && parts.every((part) => part && part !== "." && part !== ".." && !/[\0\r\n]/.test(part)),
    "invalid load cgroup path");
  const matches = (name) => name === id || name === `docker-${id}.scope`;
  assert.ok(matches(parts.at(-1)) && !parts.slice(0, -1).some(matches), "load cgroup path does not name the exact container");
  return parts;
}

function fullMount(text) {
  const rows = text.split("\n").filter((line) => line.split(" ")[4] === root);
  const [left, right] = rows[0]?.split(" - ") ?? [];
  assert.ok(rows.length === 1 && rows[0].length <= 4096 && left.split(" ")[3] === "/" && right?.split(" ")[0] === "cgroup2",
    "load sampling requires the full cgroup v2 mount");
  return rows[0];
}

function withFd(path, flags, fn) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | flags);
  try { return fn(fd); } finally { closeSync(fd); }
}
const withDir = (path, fn) => withFd(path, constants.O_DIRECTORY, fn);
const inode = (fd) => {
  const { dev, ino } = fstatSync(fd, { bigint: true });
  return `${dev}:${ino}`;
};
function readSmall(path, cap = 16384) {
  return withFd(path, 0, (fd) => {
    const bytes = Buffer.alloc(cap + 1);
    let size = 0, count;
    while (size <= cap && (count = readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    assert.ok(size <= cap, "load kernel file exceeds bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  });
}
function samePath(path, fd) {
  assert.equal(withDir(path, inode), inode(fd), "load kernel path was replaced during acquisition");
}
function withParts(fd, parts, index, fn) {
  if (index === parts.length) return fn(fd);
  return withDir(`${fdPath(fd)}/${parts[index]}`, (next) => withParts(next, parts, index + 1, fn));
}

const linux = {
  clock: () => ({ at: Date.now(), monotonic: performance.now() }),
  withProcess(pid, fn) {
    assert.equal(process.platform, "linux", "load sampler requires the Docker host's Linux PID namespace");
    const path = `/proc/${pid}`;
    let opened = false;
    try {
      return withDir(path, (fd) => {
        opened = true;
        return fn({ identity() { samePath(path, fd); return inode(fd); }, read: (name) => readSmall(`${fdPath(fd)}/${name}`) });
      });
    } catch (error) {
      // Only the first PID-directory open can prove no acquisition began.
      if (!opened && error?.code === "ENOENT") throw new LoadProcessAbsentBeforeRead("load PID absent before opening its process directory", { cause: error });
      throw error;
    }
  },
  withGroup(parts, fn) {
    return withDir(root, (base) => {
      // statfs follows /proc/self/fd/N to the open directory, not an untrusted path.
      assert.equal(statfsSync(fdPath(base)).type, cgroup2, "load path is not on cgroup v2");
      return withParts(base, parts, 0, (fd) => fn({
        mount: () => readSmall("/proc/self/mountinfo", 2 ** 20),
        identity() {
          samePath(root, base);
          assert.equal(withParts(base, parts, 0, inode), inode(fd), "load cgroup path was replaced during acquisition");
          return inode(fd);
        },
        read: (name) => readSmall(`${fdPath(fd)}/${name}`),
      }));
    });
  },
};

const lines = (text, field) => text.split("\n").filter((line) => line.startsWith(field + " "));
function readCount(text, field) {
  const rows = lines(text, field), value = rows[0]?.slice(field.length + 1);
  assert.ok(rows.length === 1 && /^\d{1,16}$/.test(value) && natural(Number(value)), `missing/malformed load kernel counter ${field}`);
  return Number(value);
}
function processSnapshot(proc, pid, opening = false) {
  const processObject = proc.identity(), stat = proc.read("stat"), close = stat.lastIndexOf(")");
  // /proc/PID/stat's comm may contain spaces and parentheses; starttime is field 22.
  const fields = stat.slice(close + 2).trimEnd().split(" ");
  assert.ok(stat.startsWith(`${pid} (`) && close > 0 && stat[close + 1] === " "
    && /^[1-9]\d{0,19}$/.test(fields[19] ?? ""), "load process identity unavailable");
  if (/^[ZXx]$/.test(fields[0])) {
    if (opening) throw new LoadProcessExitedBeforeCounters(processObject, fields[19]);
    throw new LoadResourceLifetimeEnded("load process identity unavailable at exit");
  }
  assert.ok(/^[RSDTtIWPK]$/.test(fields[0]), "load process identity unavailable");
  const path = /^0::(\/[^\n]+)\n$/.exec(proc.read("cgroup"))?.[1];
  return { pid, processObject, startTicks: fields[19], path };
}
function groupSnapshot(group) {
  const mount = fullMount(group.mount()), groupObject = group.identity(), populated = lines(group.read("cgroup.events"), "populated");
  if (populated.length === 1 && populated[0] === "populated 0") throw new LoadResourceLifetimeEnded("load cgroup not populated at exit");
  assert.deepEqual(populated, ["populated 1"], "load cgroup not populated");
  return { mount, groupObject, populated: true };
}

export function acquireLoadResources({ id, pid, sequence }, source = linux) {
  assert.ok(containerId(id) && positive(pid) && natural(sequence), "exact load container, live PID and sequence required");
  const begin = source.clock();
  const raw = source.withProcess(pid, (proc) => {
    const processBefore = processSnapshot(proc, pid, true);
    return source.withGroup(pathParts(processBefore.path, id), (group) => {
      const before = { ...processBefore, ...groupSnapshot(group) };
      const usageUsec = readCount(group.read("cpu.stat"), "usage_usec");
      const memory = group.read("memory.current"), inactiveFile = readCount(group.read("memory.stat"), "inactive_file");
      assert.ok(/^\d{1,16}\n$/.test(memory) && natural(Number(memory)), "missing/malformed load memory.current");
      const groupAfter = groupSnapshot(group), after = { ...processSnapshot(proc, pid), ...groupAfter };
      return { before, after, usageUsec, memoryCurrent: Number(memory), inactiveFile };
    });
  });
  const end = source.clock();
  const row = { sequence, begin, end, ...raw };
  validateRow(row, id, pid);
  return row;
}

export function clockDelta(a, b) {
  for (const clock of [a, b]) assert.ok(natural(clock?.at) && Number.isFinite(clock.monotonic) && clock.monotonic >= 0, "load acquisition clock missing");
  const wall = b.at - a.at, monotonic = b.monotonic - a.monotonic;
  // Checks clock consistency, not lifetime or coverage tolerance. Date.now floors to milliseconds.
  assert.ok(wall >= 0 && monotonic >= 0 && Math.abs(wall - monotonic) <= 2, "load acquisition clock discontinuity");
  return msNs(b.at + 1) - msNs(a.at);
}
function validateRow(row, id, pid) {
  const { before, after } = row;
  assert.ok(before?.pid === pid && before.populated === true && objectId(before.processObject) && objectId(before.groupObject)
    && typeof before.startTicks === "string" && /^[1-9]\d{0,19}$/.test(before.startTicks), "load process/cgroup identity or population missing");
  assert.ok(typeof before.mount === "string" && before.mount.length <= 4096 && !/[\r\n]/.test(before.mount), "load mount identity missing");
  fullMount(before.mount);
  pathParts(before.path, id);
  same(after, before, "load process/cgroup identity or population changed during acquisition");
  assert.ok(clockDelta(row.begin, row.end) <= msNs(loadResourcePeriodMs), "load acquisition exceeded bound");
  assert.ok([row.usageUsec, row.memoryCurrent, row.inactiveFile].every(natural), "load CPU/memory evidence missing or malformed");
}

export function loadResourceInterval(previous, row) {
  same(row.before, previous.before, "load process/cgroup identity changed between acquisitions");
  assert.ok(clockDelta(previous.begin, row.end) <= edgeNs, "gap in load resource coverage");
  const elapsedMin = Math.min(row.begin.at - previous.end.at - 1, row.begin.monotonic - previous.end.monotonic);
  const delta = row.usageUsec - previous.usageUsec;
  assert.ok(elapsedMin > 0 && delta >= 0, "overlapping load acquisitions or reset CPU counter");
  return { elapsedMin, delta };
}

// The plan and terminal Docker lifetime are caller inputs, not inferred from submitted rows.
export function replayLoadResources(rows, { id, pid, startedAt, finishedAt, memoryBytes, quota, plan }) {
  assert.ok(containerId(id) && positive(pid) && positive(memoryBytes) && positive(quota), "exact load identity and resource budget required");
  assert.ok(positive(plan?.firstAt) && positive(plan.count) && plan.count >= 2 && plan.count <= 360
    && natural(plan.firstAt + plan.count * loadResourcePeriodMs), "invalid load acquisition schedule");
  assert.ok(Array.isArray(rows) && rows.length === plan.count, "missing or extra scheduled load acquisition");
  const born = timestampNs(startedAt), exited = timestampNs(finishedAt);
  assert.ok(exited > born, "invalid load lifetime");
  let previous, cpuMaxPctUpper = 0, memMaxBytes = 0;
  for (const [sequence, row] of rows.entries()) {
    assert.ok(row?.sequence === sequence, "duplicate, missing or unordered load acquisition");
    validateRow(row, id, pid);
    const lower = msNs(row.begin.at), upper = msNs(row.end.at + 1);
    assert.ok(lower >= born && upper <= exited, "load acquisition outside container lifetime");
    const slot = plan.firstAt + sequence * loadResourcePeriodMs;
    assert.ok(row.begin.at >= slot && row.end.at < slot + loadResourcePeriodMs, "load acquisition outside scheduled slot");
    const memory = row.memoryCurrent - (row.inactiveFile < row.memoryCurrent ? row.inactiveFile : 0);
    assert.ok(memory > 0 && memory < memoryBytes, "load memory missing/at budget");
    memMaxBytes = Math.max(memMaxBytes, memory);
    if (previous) {
      const { elapsedMin, delta } = loadResourceInterval(previous, row);
      cpuMaxPctUpper = Math.max(cpuMaxPctUpper, delta / (elapsedMin * 10));
    } else assert.ok(upper - born <= edgeNs, "uncovered load resource start");
    previous = row;
  }
  assert.ok(exited - msNs(previous.begin.at) <= edgeNs, "uncovered load resource finish");
  return { samples: rows.length, cpuIntervals: rows.length - 1, memMaxBytes, cpuMaxPctUpper,
    loadHasHeadroom: cpuMaxPctUpper < quota * 80 };
}

// Give the created participant one period to initialize. The live observation
// and terminal replay use the same schedule anchored to Docker's start clock.
export function loadResourceFirstSlot(startedAt) {
  const firstAt = Number((timestampNs(startedAt) + 999_999n) / 1_000_000n) + loadResourcePeriodMs;
  assert.ok(positive(firstAt), "invalid load acquisition start slot");
  return firstAt;
}

export function replayScheduledLoadResources(capture, life, { memoryBytes, quota }) {
  assert.ok(capture?.schema === loadResourceCaptureSchema, "missing scheduled load resource evidence");
  same(Object.keys(capture).sort(), ["live", "rows", "schema"], "invalid scheduled load resource fields");
  const { live, rows } = capture;
  assert.ok(live?.id === life.containerId && live.startedAt === life.startedAt && positive(live.pid),
    "live resource observation differs from terminal Docker lifetime");
  same(Object.keys(live).sort(), ["id", "pid", "startedAt"], "invalid live resource observation fields");
  const firstAt = loadResourceFirstSlot(life.startedAt), finished = timestampNs(life.finishedAt);
  const span = finished - msNs(firstAt), period = msNs(loadResourcePeriodMs);
  assert.ok(span >= 0n, "load stopped before the first resource slot");
  const full = Number(span / period), partial = span % period !== 0n;
  // The producer cannot choose how many full slots to retain. It may also
  // retain a sample from the last partial slot; its brackets still have to
  // fit the exact lifetime and every earlier slot still has to be present.
  assert.ok(Array.isArray(rows) && (rows.length === full || partial && rows.length === full + 1),
    "scheduled load resource coverage differs from terminal Docker lifetime");
  return replayLoadResources(rows, { id: live.id, pid: live.pid, startedAt: life.startedAt,
    finishedAt: life.finishedAt, memoryBytes, quota, plan: { firstAt, count: rows.length } });
}
