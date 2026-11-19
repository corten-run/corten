import assert from "node:assert/strict";
import test from "node:test";
import { verifyLoadLimits } from "./cgroup.mjs";

const id = "a".repeat(64), expected = { start: 1000, end: 5000, quota: 12, cpuset: "4-15" };
const path = `/tenant/docker/docker-${id}.scope`;
const sample = () => ({
  startedAt: 1100, finishedAt: 1101, path,
  mount: "35 24 0:31 / /sys/fs/cgroup ro - cgroup2 cgroup rw",
  eventsBefore: "populated 1\nfrozen 0\n", eventsAfter: "populated 1\nfrozen 0\n",
  effectiveCpus: "4-15\n",
  quotas: [{ path, cpuMax: "1200000 100000\n" }, { path: "/tenant/docker", cpuMax: "max 100000\n" },
    { path: "/tenant", cpuMax: "max 50000\n" }, { path: "/", cpuMax: null }],
});

test("live exact-container cpuset and full unlimited ancestry establish the configured quota", () => {
  const raw = sample();
  verifyLoadLimits(raw, id, expected);
  raw.effectiveCpus = "15,4-14\n";
  raw.quotas[0].cpuMax = "600000 50000\n";
  verifyLoadLimits(raw, id, expected);
});

test("an unlimited immediate parent cannot conceal a finite grandparent quota", () => {
  for (const limit of ["200000 50000\n", "600000 50000\n"]) {
    const raw = sample();
    raw.quotas[2].cpuMax = limit;
    assert.throws(() => verifyLoadLimits(raw, id, expected), /parent quota restricts bandwidth/);
  }
});

test("missing or malformed quota evidence and a delegated root fail closed", () => {
  const raw = sample();
  assert.throws(() => verifyLoadLimits(undefined, id, expected), /outside active lifetime/);
  assert.throws(() => verifyLoadLimits({ ...raw, quotas: raw.quotas.slice(0, -1) }, id, expected), /quota ancestry/);
  assert.throws(() => verifyLoadLimits({ ...raw, mount: raw.mount.replace(" / /sys", " /tenant /sys") }, id, expected), /not mounted from its root/);
  raw.quotas[2].cpuMax = null;
  assert.throws(() => verifyLoadLimits(raw, id, expected), /cpu.max missing or invalid/);
  raw.quotas[2].cpuMax = "max 50000\n";
  raw.quotas[0].cpuMax = "1199999 100000\n";
  assert.throws(() => verifyLoadLimits(raw, id, expected), /quota differs from configured CPUs/);
});

test("empty, missing or contradictory effective CPU sets are not evidence", () => {
  for (const effectiveCpus of [undefined, "", "\n", "4-14\n", "4-14,16\n", "4-15,4\n", "4-16\n"]) {
    assert.throws(() => verifyLoadLimits({ ...sample(), effectiveCpus }, id, expected), /effective cpuset/);
  }
});

test("a stale window, unpopulated cgroup or another ID cannot qualify the phase", () => {
  const raw = sample();
  assert.throws(() => verifyLoadLimits({ ...raw, startedAt: expected.start - 1 }, id, expected), /outside active lifetime/);
  assert.throws(() => verifyLoadLimits({ ...raw, finishedAt: expected.end }, id, expected), /outside active lifetime/);
  assert.throws(() => verifyLoadLimits({ ...raw, finishedAt: raw.startedAt + 2001 }, id, expected), /outside active lifetime/);
  assert.throws(() => verifyLoadLimits({ ...raw, eventsAfter: "populated 0\n" }, id, expected), /not observed populated/);
  assert.throws(() => verifyLoadLimits(raw, "b".repeat(64), expected), /path differs from container ID/);
});
