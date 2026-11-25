import assert from "node:assert/strict";
import test from "node:test";
import { acquireLoadResources, replayLoadResources } from "./load-resource-proof.mjs";

const id = "a".repeat(64), pid = 42, path = `/system.slice/docker-${id}.scope`;
const mount = "36 27 0:29 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw";
const epoch = Date.parse("2026-11-24T23:00:00Z"), stamp = (ms) => new Date(epoch + ms).toISOString();
const stat = (ticks = "1234", state = "S") => `${pid} (a name with ) a paren) ${state} ${Array(18).fill(0).join(" ")} ${ticks} 0\n`;
function capture(sequence, edits = {}) {
  const slot = 100 + sequence * 1000, clocks = [slot + 1, slot + 3], calls = [];
  let member = 0, tick = 0, proc = 0, group = 0, mounted = 0, live = 0, openProc = false, openGroup = false;
  const source = {
    clock() {
      assert.ok(!openProc && !openGroup);
      const n = clocks.shift(); calls.push("clock");
      return { at: epoch + n, monotonic: n + (!clocks.length ? edits.clockStep ?? 0 : 0) };
    },
    withProcess(value, body) {
      assert.equal(value, pid); openProc = true;
      try { return body({
        identity() { return proc++ && edits.processObject || "1:2"; },
        read(name) {
          assert.ok(openProc); calls.push(name);
          if (name === "stat") return tick++ ? edits.statAfter ?? stat() : edits.statBefore ?? stat();
          assert.equal(name, "cgroup");
          return `0::${member++ ? edits.pathAfter ?? path : edits.pathBefore ?? path}\n`;
        },
      }); } finally { openProc = false; }
    },
    withGroup(parts, body) {
      assert.ok(openProc && !openGroup); openGroup = true;
      assert.deepEqual(parts, path.slice(1).split("/"));
      try { return body({
        mount() { return mounted++ ? edits.mountAfter ?? mount : edits.mountBefore ?? mount; },
        identity() { return group++ && edits.groupObject || "3:4"; },
        read(name) {
          assert.ok(openGroup); calls.push(name);
          if (name === "cgroup.events") return live++ ? edits.eventsAfter ?? "populated 1\nfrozen 0\n" : "populated 1\nfrozen 0\n";
          if (name === "cpu.stat") return edits.cpu ?? `usage_usec ${1000 + sequence * 250000}\nuser_usec 10\n`;
          if (name === "memory.current") return edits.memory ?? "10485760\n";
          assert.equal(name, "memory.stat");
          return edits.file ?? "anon 1024\ninactive_file 2097152\n";
        },
      }); } finally { openGroup = false; }
    },
  };
  const row = acquireLoadResources({ id, pid, sequence }, source);
  assert.deepEqual(calls, ["clock", "stat", "cgroup", "cgroup.events", "cpu.stat", "memory.current", "memory.stat", "cgroup.events", "stat", "cgroup", "clock"]);
  return row;
}
function fixture(terminalMs = 3500) {
  return { id, pid, startedAt: stamp(0), finishedAt: stamp(terminalMs), memoryBytes: 32 * 2 ** 20, quota: 4,
    plan: { firstAt: epoch + 100, count: 4 } };
}
const samples = () => Array.from({ length: 4 }, (_, i) => capture(i));

test("delayed transport retains all fully in-lifetime acquisitions, including the CPU anchor's memory", () => {
  const rows = samples(), bounds = fixture(), steady = replayLoadResources(rows, bounds);
  const received = rows.map((row) => ({ deliveredAfterExit: stamp(3620), row: JSON.parse(JSON.stringify(row)) }));
  assert.deepEqual(replayLoadResources(received.map(({ row }) => row), bounds), steady);
  assert.deepEqual(steady, { samples: 4, cpuIntervals: 3, memMaxBytes: 8 * 2 ** 20,
    cpuMaxPctUpper: 250000 / 9970, loadHasHeadroom: true });
  rows[0].memoryCurrent += 2 ** 20;
  assert.equal(replayLoadResources(rows, bounds).memMaxBytes, 9 * 2 ** 20);
  rows[1].usageUsec = rows[0].usageUsec + 4 * 80 * 9970;
  rows[2].usageUsec = rows[3].usageUsec = rows[1].usageUsec;
  assert.equal(replayLoadResources(rows, bounds).cpuMaxPctUpper, 320);
  assert.equal(replayLoadResources(rows, bounds).loadHasHeadroom, false);
  rows.slice(1).forEach((row) => { row.usageUsec--; });
  assert.equal(replayLoadResources(rows, bounds).loadHasHeadroom, true);
});

test("nanosecond lifetime contains the complete acquisition, not merely its start or receipt", () => {
  const rows = samples(), bounds = fixture();
  assert.throws(() => replayLoadResources(rows, { ...bounds, startedAt: stamp(101).replace("Z", "000001Z") }), /outside container lifetime/);
  assert.throws(() => replayLoadResources(rows, { ...bounds, finishedAt: stamp(3103).replace("Z", "999999Z") }), /outside container lifetime/);
  assert.equal(replayLoadResources(rows, { ...bounds, finishedAt: stamp(3104) }).samples, 4);
  const late = samples();
  for (const x of [late[3].begin, late[3].end]) { x.at += 600; x.monotonic += 600; }
  assert.throws(() => replayLoadResources(late, bounds), /outside container lifetime/);
});

test("all scheduled observations and both coverage edges are mandatory", () => {
  const rows = samples(), bounds = fixture();
  assert.throws(() => replayLoadResources(rows.slice(1), bounds), /missing or extra/);
  assert.throws(() => replayLoadResources([rows[0], rows[0], ...rows.slice(2)], bounds), /duplicate, missing or unordered/);
  assert.throws(() => replayLoadResources(rows.toReversed(), bounds), /duplicate, missing or unordered/);
  assert.throws(() => replayLoadResources(rows, { ...bounds, plan: { ...bounds.plan, firstAt: epoch + 110 } }), /outside scheduled slot/);
  assert.throws(() => replayLoadResources(rows, { ...bounds, startedAt: stamp(-4900) }), /uncovered load resource start/);
  assert.throws(() => replayLoadResources(rows, fixture(8102)), /uncovered load resource finish/);
  const overlap = samples();
  overlap[0].end = { at: epoch + 1099, monotonic: 1099 };
  overlap[1].begin = { at: epoch + 1100, monotonic: 1100 };
  assert.throws(() => replayLoadResources(overlap, bounds), /overlapping/);
});

test("missing, zero, at-budget, reset, and inconsistent clock evidence cannot qualify", () => {
  for (const [edits, message] of [
    [{ cpu: "user_usec 10\n" }, /missing\/malformed.*usage_usec/],
    [{ cpu: "usage_usec 1\nusage_usec 2\n" }, /missing\/malformed.*usage_usec/],
    [{ memory: "" }, /missing\/malformed.*memory.current/],
    [{ file: "anon 1024\n" }, /missing\/malformed.*inactive_file/],
    [{ eventsAfter: "populated 1\npopulated 0\n" }, /not populated/],
    [{ clockStep: 20 }, /clock discontinuity/],
  ]) assert.throws(() => capture(0, edits), message);
  const zero = [capture(0, { memory: "0\n" }), ...samples().slice(1)];
  for (const x of [zero[0].begin, zero[0].end]) { x.at += 386; x.monotonic += 386; }
  assert.throws(() => replayLoadResources(zero, fixture()), /memory missing\/at budget/);
  assert.throws(() => replayLoadResources(samples(), { ...fixture(), memoryBytes: 8 * 2 ** 20 }), /memory missing\/at budget/);
  const rows = samples();
  rows[1].usageUsec = 0;
  assert.throws(() => replayLoadResources(rows, fixture()), /reset CPU counter/);
  const idle = samples(); idle.forEach((r) => { r.usageUsec = 1000; });
  assert.equal(replayLoadResources(idle, fixture()).cpuMaxPctUpper, 0, "zero CPU delta is a real idle interval");
});

test("refuses PID reuse, process movement, cgroup replacement and an unrelated container", () => {
  for (const [edits, message] of [
    [{ statAfter: stat("1235") }, /identity or population changed/],
    [{ statBefore: stat("1234", "Z") }, /process identity unavailable/],
    [{ processObject: "1:3" }, /identity or population changed/],
    [{ pathAfter: `/other/${id}` }, /identity or population changed/],
    [{ pathBefore: "/system.slice/" + "b".repeat(64) }, /exact container/],
    [{ pathBefore: `/system.slice/../${id}` }, /invalid load cgroup path/],
    [{ groupObject: "3:5" }, /identity or population changed/],
    [{ mountBefore: mount.replace(" / /sys", " /private /sys") }, /full cgroup v2 mount/],
    [{ mountAfter: mount.replace("36 27", "38 27") }, /identity or population changed/],
  ]) assert.throws(() => capture(0, edits), message);
  assert.throws(() => replayLoadResources(samples(), { ...fixture(), id: "b".repeat(64) }), /exact container/);
  assert.throws(() => replayLoadResources(samples(), { ...fixture(), pid: 43 }), /identity or population missing/);
  const numericTicks = samples();
  numericTicks[0].before.startTicks = numericTicks[0].after.startTicks = 1234;
  assert.throws(() => replayLoadResources(numericTicks, fixture()), /identity or population missing/);
  for (const identity of [{ startTicks: "1235" }, { groupObject: "3:5" }, { path: `/other/${id}` }]) {
    const rows = samples();
    Object.assign(rows[1].before, identity); Object.assign(rows[1].after, identity);
    assert.throws(() => replayLoadResources(rows, fixture()), /changed between acquisitions/);
  }
});
