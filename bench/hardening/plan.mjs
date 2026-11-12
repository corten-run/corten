import assert from "node:assert/strict";
import { selectedApps, contractSha256 } from "../workloads/registry.mjs";

export const schema = "native-hardening-run/v1";
export const phases = ["slow-headers", "slow-bodies", "slow-readers", "idle-connections", "connection-pressure", "oversized-requests"];
export const cases = ["direct", "deployed-edge"];
export const sources = ["fixture", "api"];
export const apps = selectedApps("hardening");
export const matrix = () => apps.flatMap((app) => sources.flatMap((source) => cases.flatMap((mode) => phases.map((phase) =>
  ({ key: `${app}/${source}/${mode}/${phase}`, app, source, mode, phase, status: "not-run" })))));
const scheduled = (start, end, step) => Array.from({ length: Math.ceil((end - start) / step) }, (_, i) => start + i * step);

// These are explicit apparatus profiles, not inherited legacy thresholds or defense promises.
export function budgets(profile = "bounded") {
  assert.ok(["bounded", "sustained"].includes(profile), "unknown profile");
  const beforeEnd = 2500, attackEnd = profile === "bounded" ? 8500 : 97500, afterEnd = attackEnd + 5000;
  const count = profile === "bounded" ? 12 : 1200;
  return {
    profile,
    attack: { scheduledAtMs: scheduled(beforeEnd + 100, beforeEnd + 1100, 1000 / count),
      everyMs: 250, pipelined: 512, bodyBytes: 4 * 1024 * 1024, headerBytes: 128 * 1024, headerCount: 200,
      connectTimeoutMs: 2000, releaseAtMs: attackEnd, maxConnections: count, maxWireBytes: count * (5 * 1024 * 1024) },
    legitimate: Object.fromEntries([["before", 0, beforeEnd], ["during", beforeEnd, attackEnd], ["after", attackEnd, afterEnd]].map(([key, startMs, endMs]) =>
      [key, { startMs, endMs, scheduledAtMs: scheduled(startMs + 200, endMs - 800, 400) }])),
    timing: { maxStartLagMs: 200, maxWindowDriftMs: 100 },
    resources: { cpuCoresTotal: 1.5, memoryBytesTotal: 1536 * 2 ** 20, applicationDirect: { cpu: 1, memory: 1024 * 2 ** 20 },
      applicationEdge: { cpu: 0.75, memory: 768 * 2 ** 20 }, proxy: { cpu: 0.25, memory: 256 * 2 ** 20 }, upstream: { cpu: 0.5, memory: 512 * 2 ** 20 },
      apparatus: { cpu: 2, memory: 1024 * 2 ** 20 }, qualification: { cpu: 2, memory: 2 * 2 ** 30 },
      observation: "cgroup-v2 CPU/memory/events/procs and native docker-top process inventories; no peak claim" },
    recovery: { requestTimeoutMs: 600, attempts: "every scheduled after request; no target restart" },
    cleanup: { timeoutMs: 15000, scope: "all owned sockets, timers, command clients, containers including volumes, network" },
  };
}

export function validateBudget(b) {
  assert.deepEqual(b, budgets(b?.profile), "use an exact versioned profile; no unreviewed schedule/budget overrides");
  assert.equal(b.attack.scheduledAtMs.length, b.attack.maxConnections);
  assert.ok(b.attack.scheduledAtMs.every((n) => Number.isFinite(n) && n >= b.legitimate.during.startMs && n < b.legitimate.during.endMs));
  for (const mode of cases) {
    const app = b.resources[mode === "direct" ? "applicationDirect" : "applicationEdge"];
    const roles = [app, b.resources.upstream, ...(mode === "deployed-edge" ? [b.resources.proxy] : [])];
    assert.equal(roles.reduce((n, r) => n + r.cpu, 0), b.resources.cpuCoresTotal);
    assert.equal(roles.reduce((n, r) => n + r.memory, 0), b.resources.memoryBytesTotal);
  }
  return b;
}

export function parseArgs(args) {
  assert.match(args[0] ?? "", /^w[1-9]\d*$/, "explicit local development round wN required");
  const o = { round: args[0], profile: "bounded", review: null, build: false, verify: {}, out: `bench/hardening/results/${args[0]}`, nodeModules: "node_modules" };
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    assert.ok(!seen.has(key), `duplicate option ${key}`); seen.add(key);
    if (key === "--build") { assert.equal(o.build, false, "duplicate --build"); o.build = true; continue; }
    assert.ok(["--out", "--profile", "--review", "--node-modules", "--verify-app", "--verify-source", "--verify-case", "--verify-phase"].includes(key), `unknown argument ${key}`);
    const value = args[++i]; assert.ok(value && !value.startsWith("--"), `${key} needs a value`);
    if (key.startsWith("--verify-")) { const name = key.slice(9); assert.equal(o.verify[name], undefined, "duplicate verification filter"); o.verify[name] = value; }
    else o[key === "--node-modules" ? "nodeModules" : key.slice(2)] = value;
  }
  assert.ok(o.out && o.review?.trim(), "--out and --review are required; review identifies the approved effective profile");
  for (const [key, choices] of Object.entries({ app: apps, source: sources, case: cases, phase: phases })) {
    if (o.verify[key]) assert.ok(choices.includes(o.verify[key]), `unknown ${key}`);
  }
  validateBudget(budgets(o.profile));
  return o;
}
export const selected = (cell, o) => Object.entries(o.verify).every(([key, value]) => cell[key === "case" ? "mode" : key] === value);
export const registryDigest = contractSha256("hardening");

export function groupReady(cells) {
  const expected = matrix();
  assert.deepEqual(cells.map((c) => c.key), expected.map((c) => c.key), "selected group matrix was dropped or reordered");
  return cells.every((c) => c.status === "observed" && c.parity === "passed" && c.apparatusValid === true);
}
