// Synthetic kernel/native records exercise real replay, not actual OS qualification.
import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { test } from "node:test";
import { deploymentSha256 } from "../../deployments.mjs";
import { tree } from "../evidence.mjs";
import { composePhase } from "../composition.mjs";
import { composeHostProof, inspectLifetime } from "../host-lifetime.mjs";
import { inspectSaved as delivery } from "./live-delivery.mjs";
import { inspectSaved as recovery } from "./recoverable-live.mjs";
import { syntheticFixture } from "./live-delivery.test.mjs";

async function fixture(t, group, change = () => {}) {
  const f = await syntheticFixture(t, group, { allRegistered: true, round: "r17" });
  const phase = join(f.folder, "r17-0123456789abcdef", `${group === "live-delivery" ? "06" : "07"}-${group}-timing`);
  await mkdir(phase, { recursive: true });
  const native = join(phase, "native");
  for (const name of ["plan.json", "coverage.json", "source.diff.gz", ...f.plan.inventory.flatMap((entry) =>
    [`${entry.app}-artifacts.json`, ...f.plan.scenarios.map((s) => `${entry.app}-${s}.json.gz`)])]) await rename(join(f.folder, name), join(phase, name));
  await mkdir(native);
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(phase)) if (name !== "native") await rename(join(phase, name), join(native, name));
  const campaign = "r17-0123456789abcdef", command = 12, pid = 100;
  const parent = `/system.slice/corten-bench-groups-${campaign}.service`, path = `${parent}/native-${command}-0123456789abcdef`;
  const groupRecord = (path, ids = []) => ({ path, files: { "cgroup.procs": ids.join("\n"), "cgroup.events": `populated ${ids.length ? 1 : 0}\n`,
    "cpu.stat": "usage_usec 10\n", "cpu.max": "max 100000\n", "cpuset.cpus.effective": "0-7\n", "memory.current": "10\n",
    "memory.peak": "20\n", "memory.max": "max\n", "memory.events": "oom 0\noom_kill 0\n" } });
  const ancestors = []; for (let at = parent;; at = posix.dirname(at)) { ancestors.push(groupRecord(at)); if (at === "/") break; }
  const at = Date.parse(f.plan.startedAt), before = { at: new Date(at - 200).toISOString(), hostname: "host", bootId: "boot", containers: [], networks: ["bridge"], processes: [] };
  const after = { ...before, at: new Date(at + 200).toISOString() };
  const stat = (id, name) => `${id} (${name}) S ${[1, ...Array(17).fill(0), id * 10, 0].join(" ")}`;
  const processes = [[pid, "node", null], [101, "chrome", "--type=renderer"]].map(([id, name, type]) =>
    ({ stat: stat(id, name), cgroup: `0::${path}\n`, executableSha256: "b".repeat(64), type }));
  const samples = [{ at: at - 100, groups: [groupRecord(path)], processes: [] }, { at, groups: [groupRecord(path, [100, 101])], processes },
    { at: at + 100, groups: [groupRecord(path)], processes: [] }];
  const result = { terminal: true, code: 1, signal: null, cancelled: false, forced: false, error: null, success: false };
  const context = { schema: "benchmark-isolated-host-lifetime/v1", ...f.binding.request, campaign, command, leaderPid: pid, parent, path,
    bindingSha256: deploymentSha256(f.binding), invocation: f.binding.execution.invocation, bootId: "boot", ancestors };
  const terminal = { terminal: true, attached: true, empty: true, samples: 3, observerError: null, command: result, bootId: "boot", ancestors };
  change({ context, terminal, samples, before, after, binding: f.binding });
  const host = join(phase, `command-${command}-host`); await mkdir(host);
  const save = (file, value) => writeFile(file, JSON.stringify(value));
  await save(join(host, "binding.json"), context); await save(join(host, "terminal.json"), terminal);
  await writeFile(join(host, "samples.jsonl"), samples.map((s) => JSON.stringify(s) + "\n").join(""));
  await save(join(phase, "host-before.json"), before); await save(join(phase, "host-after.json"), after);
  await save(join(phase, "native-manifest.json"), tree(native));
  return { ...f, folder: native, phase, host, result, context, terminal, save, inspect: () => (group === "live-delivery" ? delivery : recovery)(f.binding, native) };
}

for (const group of ["live-delivery", "recoverable-live"]) test(`${group}: exact core phase proof closes native lifecycle without promoting target failures`, async (t) => {
  const f = await fixture(t, group), native = await f.inspect();
  assert.equal(native.status, "failed"); assert.equal(native.attemptComplete, true);
  assert.equal(native.cleanupComplete, true); assert.equal(native.resources, "verified");
  assert.ok(native.outcomes.every((r) => r.outcome === "failed"));
  const observation = inspectLifetime(f.binding, f.binding.execution.invocation, f.host,
    { campaign: f.context.campaign, command: f.context.command, pid: f.context.leaderPid, result: f.result });
  const binding = { ...f.binding, preparation: { fixtures: [] } };
  const composed = composePhase(binding, native, composeHostProof(f.binding, native, observation), [f.result]);
  assert.equal(composed.outcome, "native-validated"); assert.ok(composed.appOutcomes.every((r) => !r.comparisonEligible));
});

for (const [name, change, expected] of [
  ["terminal empty false", (f) => { f.terminal.empty = false; }, "blocked"],
  ["observer error", (f) => { f.terminal.observerError = "gap"; }, "blocked"],
  ["cancelled", (f) => { f.terminal.command.cancelled = true; }, "blocked"],
  ["wrong command", (f) => { f.context.invocation = { executable: "node", argv: ["other.mjs"] }; }, "invalid"],
  ["wrong commit", (f) => { f.context.commit = "c".repeat(40); }, "invalid"],
  ["wrong boot", (f) => { f.after.bootId = "other"; }, "invalid"],
  ["remaining container", (f) => { f.after.containers = ["c".repeat(64)]; }, "invalid"],
  ["remaining host process", (f) => { f.after.processes = [{ pid: 101, startTicks: "1010" }]; }, "invalid"],
  ["absent controls", (f) => { for (const s of f.samples) s.groups[0].files["cpu.max"] = null; }, "blocked"],
  ["missing browser", (f) => { f.samples[1].processes.pop(); f.samples[1].groups[0].files["cgroup.procs"] = "100"; }, "blocked"],
]) test(`live external ${name} cannot clear cleanup`, async (t) => {
  const f = await fixture(t, "live-delivery", change), result = await f.inspect();
  assert.equal(result.cleanupComplete, false); assert.equal(result.status, expected);
});

test("native tree seal and external host evidence are mandatory, never plan receipt flags", async (t) => {
  const f = await fixture(t, "live-delivery");
  await f.save(join(f.phase, "native-manifest.json"), { sha256: "c".repeat(64) });
  assert.equal((await f.inspect()).status, "invalid");
  await f.save(join(f.phase, "native-manifest.json"), tree(f.folder));
  const { unlink } = await import("node:fs/promises"); await unlink(join(f.phase, "host-after.json"));
  const r = await f.inspect(); assert.equal(r.cleanupComplete, false); assert.equal(r.resources, "blocked");
  assert.ok(!JSON.stringify(r).includes("SYNTHETIC_PRIVATE_SENTINEL"));
});
