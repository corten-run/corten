// This checks composition, NOT the authority of the caller. The worker supplies
// these OS observations through its trusted channel, never from the native tree.
import { createHash } from "node:crypto";
import { need, keys, finite, digest } from "./replay-v2.mjs";
const hash = (v) => createHash("sha256").update(JSON.stringify(v, null, 2) + "\n").digest("hex");
const cpus = (text) => {
  need(typeof text === "string" && /^(?:\d+(?:-\d+)?)(?:,\d+(?:-\d+)?)*$/.test(text.trim()), "invalid-observed-cpuset");
  const values = new Set();
  for (const part of text.trim().split(",")) {
    const [lo, hi = lo] = part.split("-").map(Number);
    need(hi >= lo && hi < 65536, "invalid-observed-cpuset");
    for (let n = lo; n <= hi; n++) { need(!values.has(n), "duplicate-observed-cpu"); values.add(n); }
  }
  return [...values].sort((a, b) => a - b).join(",");
};
const events = (text) => {
  const result = new Map();
  for (const line of text.trim().split("\n")) {
    const match = /^(\w+) (\d+)$/.exec(line); need(match && !result.has(match[1]), "invalid-memory-events");
    result.set(match[1], BigInt(match[2]));
  }
  need(["max", "oom", "oom_kill"].every((k) => result.has(k)), "missing-memory-events"); return result;
};

export function verifyHostProof(replay, context, proof) {
  keys(proof, ["schema", "commit", "round", "subjectSha256", "filesSha256", "bootId", "unitPath", "observerId", "coverageReceiptSha256", "samples"]);
  need(proof.schema === "client-heavy-host-proof/v1" && proof.commit === replay.commit && proof.round === replay.round
    && proof.subjectSha256 === replay.subjectSha256 && proof.filesSha256 === hash(replay.files)
    && proof.observerId === context.observerId && digest(proof.coverageReceiptSha256)
    && typeof proof.bootId === "string" && proof.bootId.length > 0 && proof.bootId === context.bootId && proof.unitPath === context.unitPath
    && /^\/[A-Za-z0-9_./-]+$/.test(proof.unitPath) && !proof.unitPath.split("/").includes("..") && proof.unitPath !== "/", "host-proof-binding-differs");
  need(Array.isArray(proof.samples) && proof.samples.length >= 3 && proof.samples.length <= 100000, "missing-host-lifetime-observations");
  const samples = [], identities = new Map(); let previous = -1, initialEvents;
  for (const s of proof.samples) {
    keys(s, ["at", "groups", "processes"]);
    need(finite(s.at) && s.at >= previous && Array.isArray(s.groups) && s.groups.length > 0 && Array.isArray(s.processes), "invalid-host-sample"); previous = s.at;
    const groups = new Map(), members = new Set();
    for (const g of s.groups) {
      keys(g, ["path", "procs", "cpuSet", "cpuMax", "cpuExclusive", "cpuPartition", "memoryMax", "memoryEvents"]);
      need((g.path === proof.unitPath || g.path.startsWith(proof.unitPath + "/")) && !g.path.split("/").includes("..") && !groups.has(g.path), "escaped-or-duplicate-cgroup");
      need(cpus(g.cpuSet) === cpus(context.cpuSet), "actual-cpuset-differs");
      const quota = /^(\d+) (\d+)\s*$/.exec(g.cpuMax);
      need(quota && Number(quota[1]) > 0 && Number(quota[2]) > 0 && g.cpuMax.trim() === context.cpuMax
        && Number(quota[1]) / Number(quota[2]) <= cpus(context.cpuSet).split(",").length, "actual-cpu-quota-differs");
      need(/^\d+\s*$/.test(g.memoryMax) && BigInt(g.memoryMax.trim()) === BigInt(context.memoryMaxBytes), "actual-memory-limit-differs");
      const counters = events(g.memoryEvents);
      if (g.path === proof.unitPath) {
        need(g.cpuPartition.trim() === "isolated" && cpus(g.cpuExclusive) === cpus(context.cpuSet), "unit-cpus-not-observed-exclusive");
        initialEvents ??= counters;
        need(["max", "oom", "oom_kill"].every((k) => counters.get(k) === initialEvents.get(k)), "unit-memory-limit-hit");
      }
      need(typeof g.procs === "string" && /^(?:\d+\n)*$/.test(g.procs), "invalid-cgroup-procs");
      for (const pid of g.procs.trim().split("\n").filter(Boolean).map(Number)) {
        need(pid > 0 && !members.has(pid), "duplicate-cgroup-pid"); members.add(pid);
      }
      groups.set(g.path, g);
    }
    need(groups.has(proof.unitPath), "missing-unit-root-observation");
    const seen = new Set(), roles = new Set();
    for (const p of s.processes) {
      keys(p, ["stat", "cgroup", "comm", "role", "executableSha256"]);
      const match = /^(\d+) \((.*)\) ([A-Za-z]) (.*)$/.exec(p.stat.trim());
      need(match && digest(p.executableSha256) && ["node", "compiler", "browser", "renderer", "helper"].includes(p.role), "invalid-process-observation");
      const pid = Number(match[1]), fields = match[4].split(" "), startTicks = fields[18];
      need(/^\d+$/.test(startTicks) && match[2] === p.comm.trim() && !seen.has(pid) && members.has(pid), "process-identity-or-membership-differs");
      const group = /^0::([^\n]+)\n?$/.exec(p.cgroup)?.[1];
      need(groups.has(group) && groups.get(group).procs.split("\n").includes(String(pid)), "process-outside-observed-unit");
      const identity = `${pid}:${startTicks}`;
      if (p.role === "compiler") need(/^rustc/.test(p.comm.trim()), "compiler-role-not-rustc");
      // exec can legitimately change an executable without changing PID/start.
      if (!identities.has(identity)) identities.set(identity, new Set());
      identities.get(identity).add(p.executableSha256); seen.add(pid); roles.add(p.role);
      if (["node", "browser", "renderer"].includes(p.role)) need(p.executableSha256 === replay.toolIdentities[p.role === "node" ? "node" : "browser"], "process-executable-differs-from-native");
    }
    need(seen.size === members.size, "incomplete-unit-process-inventory"); samples.push({ at: s.at, members, roles });
  }
  need(samples[0].members.size === 0 && samples[0].at <= replay.executionWindow.startedAt
    && samples.at(-1).members.size === 0 && samples.at(-1).at >= replay.executionWindow.endedAt, "unit-lifetime-not-bracketed-or-not-empty");
  for (const window of replay.processWindows) need(samples.some((s) => s.at >= window.startedAt && s.at <= window.endedAt
    && s.roles.has("node") && (window.kind === "compiler" ? s.roles.has("compiler") : s.roles.has("browser") && s.roles.has("renderer"))), "missing-live-native-process-observation");
  return { resources: "observed", cleanup: "observed-unit-empty", bootId: proof.bootId, unitPath: proof.unitPath,
    identities: identities.size, coverageReceiptSha256: proof.coverageReceiptSha256 };
}
