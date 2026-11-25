// Synthetic kernel/native records exercise real replay, not actual OS qualification.
import assert from "node:assert/strict";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { test } from "node:test";
import { deploymentSha256 } from "../../deployments.mjs";
import { groupNames, nativeArtifactRoot } from "../../registry.mjs";
import { registration as controlFixture } from "../../test-fixtures/control-stream-fixture.mjs";
import { campaignSchema, groupCampaignSchema } from "../campaign-contract.mjs";
import { tree } from "../evidence.mjs";
import { composePhase } from "../composition.mjs";
import { composeHostProof, inspectLifetime } from "../host-lifetime.mjs";
import { liveCaptureSchema, liveContracts } from "../../live.mjs";
import { inspectSaved as delivery } from "./live-delivery.mjs";
import { inspectSaved as recovery } from "./recoverable-live.mjs";
import { rewriteArtifact, syntheticFixture } from "./live-delivery.test.mjs";

async function fixture(t, group, change = () => {}, dedicated = false) {
  const f = await syntheticFixture(t, group, { allRegistered: true, round: "r17" });
  for (const entry of f.plan.inventory) for (let i = 0; i < f.plan.scenarios.length; i++) await rewriteArtifact(f, entry.app, i, (a) => {
    a.capture = { schema: liveCaptureSchema, contract: liveContracts[group], records: [] };
    a.controls = []; a.failures = []; a.html = "<main>native target unavailable</main>";
    a.network = [{ kind: "request", requestId: "http-1", method: "GET", url: "http://127.0.0.1:12345/" },
      { kind: "response", requestId: "http-1", status: 500, url: "http://127.0.0.1:12345/" }];
  });
  const order = dedicated ? [group] : [...groupNames];
  const campaignRoot = join(f.folder, "r17-0123456789abcdef");
  const phase = join(campaignRoot, `${String(order.indexOf(group)).padStart(2, "0")}-${group}-timing`);
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
  const campaignBody = { schema: dedicated ? groupCampaignSchema : campaignSchema, round: "r17", commit: f.binding.request.commit,
    order, bindings: order.map((name) => name === group ? f.binding : { request: { group: name } }) };
  const campaignPlan = { ...campaignBody, campaignSha256: deploymentSha256(campaignBody) };
  const reservation = { schema: "benchmark-isolated-campaign-reservation/v1", id: campaign,
    commit: campaignPlan.commit, campaignSha256: campaignPlan.campaignSha256 };
  await save(join(campaignRoot, "plan.json"), campaignPlan);
  await save(join(f.folder, ".host-attempt.json"), reservation);
  await save(join(host, "binding.json"), context); await save(join(host, "terminal.json"), terminal);
  await writeFile(join(host, "samples.jsonl"), samples.map((s) => JSON.stringify(s) + "\n").join(""));
  await save(join(phase, "host-before.json"), before); await save(join(phase, "host-after.json"), after);
  await save(join(phase, "native-manifest.json"), tree(native));
  return { ...f, folder: native, phase, host, result, context, terminal, save, campaignPlan, reservation, campaignRoot,
    inspect: () => (group === "live-delivery" ? delivery : recovery)(f.binding, native) };
}

for (const group of ["live-delivery", "recoverable-live"]) test(`${group}: dedicated campaign uses its own bound ordinal`, async (t) => {
  const f = await fixture(t, group, () => {}, true), native = await f.inspect();
  assert.equal(native.resources, "verified"); assert.equal(native.cleanupComplete, true);
  assert.equal(native.attemptComplete, true); assert.equal(native.status, "failed");
});

for (const group of ["live-delivery", "recoverable-live"]) test(`terminal clock: ${group} adapter reads an optional same-boot clock without promoting failures`, async (t) => {
  const f = await fixture(t, group, ({ terminal }) => {
    terminal.terminalClock = { bootId: "boot", uptime: "106.00 1280.00\n", ticksPerSecond: 100, monoNs: "4000000" };
  }, true);
  const native = await f.inspect();
  assert.equal(native.status, "failed");
  assert.equal(native.cleanupComplete, true);
  assert.ok(native.outcomes.every((r) => r.outcome === "failed"));
  f.terminal.terminalClock.bootId = "foreign";
  await f.save(join(f.host, "terminal.json"), f.terminal);
  const wrongBoot = await f.inspect();
  assert.equal(wrongBoot.resources, "invalid");
  assert.equal(wrongBoot.cleanupComplete, false);
});

function offlineFence() {
  const table = { family: "inet", table: "corten_bench_native", chain: "input" };
  const tcp = { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 22 } };
  const syn = { match: { op: "==", left: { "&": [{ payload: { protocol: "tcp", field: "flags" } }, ["fin", "syn", "rst", "ack"]] }, right: "syn" } };
  const zero = { counter: { packets: 0, bytes: 0 } };
  return { nftables: [
    { metainfo: { json_schema_version: 1 } },
    { table: { family: table.family, name: table.table, handle: 1 } },
    { chain: { family: table.family, table: table.table, name: table.chain, handle: 2, type: "filter", hook: "input", prio: 10, policy: "accept" } },
    { rule: { ...table, handle: 3, expr: [tcp, syn, { limit: { rate: 8, burst: 8, per: "minute" } }, zero, { drop: null }] } },
    { rule: { ...table, handle: 4, expr: [tcp, zero, { drop: null }] } },
  ] };
}

for (const [group, offline] of [["live-delivery", false], ["recoverable-live", true]]) test(`sealed settle: ${group} requires eligible and intact first and settled censuses`, async (t) => {
  let before, after, settled;
  const f = await fixture(t, group, (row) => {
    row.binding.validation = { artifactRoot: nativeArtifactRoot(group, "r17") };
    row.context.bindingSha256 = deploymentSha256(row.binding);
    const registration = structuredClone(controlFixture);
    registration.binding.round = "r17"; registration.binding.commit = row.binding.request.commit;
    const proc = (pid, startTicks, name, parentPid, cgroup, extra) => {
      const fields = Array(49).fill("0"); fields[0] = parentPid; fields[5] = "4194304"; fields[18] = startTicks;
      return { pid, startTicks, stat: `${pid} (${name}) S ${fields.join(" ")}\n`, cgroup, ...extra };
    };
    const apparatus = [...registration.members, registration.listener].map((p) => proc(p.pid, p.startTicks, "shell", p.parentPid, p.cgroup));
    const cgroup = "0::/system.slice/systemd-udevd.service/udev\n";
    const udevExecutable = { path: "/usr/lib/systemd/systemd-udevd", device: "2049", inode: "10" };
    const daemon = proc(846, "812", "systemd-udevd", 1, cgroup, { udevExecutable });
    const worker = proc(62274, "10603", "(udev-worker)", 846, cgroup, { udevExecutable });
    const fields = (uptime, monoNs, ...processes) => ({ ...registration.host, uptime, processes: [...(offline ? [] : apparatus), daemon, ...processes],
      ...(offline ? { offlineMonoNs: monoNs } : { controlApparatus: { registration,
        sample: { host: registration.host, monoNs, members: registration.members, listener: registration.listener } } }) });
    const bootId = registration.host.bootId;
    row.context.bootId = row.terminal.bootId = bootId;
    row.terminal.terminalClock = { bootId, uptime: "106.00 1280.00\n", ticksPerSecond: 100, monoNs: "4000000" };
    before = Object.assign(row.before, fields("100.00 1000.00\n", "2000000"));
    after = Object.assign(row.after, fields("106.15 1280.10\n", "5000000", worker), { terminalClock: row.terminal.terminalClock });
    settled = { ...row.after, ...fields("111.16 1330.20\n", "5015000000") };
    delete settled.terminalClock;
  }, true);
  const settledPath = join(f.phase, "host-after-settled.json"), afterPath = join(f.phase, "host-after.json");
  const sealPath = join(f.campaignRoot, "00007-phase-sealed.json");
  const ingressPath = join(f.phase, "control-ingress.json");
  if (offline) await f.save(ingressPath, { before: offlineFence(), after: offlineFence() });
  const seal = () => f.save(sealPath, { schema: "benchmark-isolated-campaign-event/v1", kind: "phase-sealed", sequence: 7,
    campaign: f.context.campaign, round: "r17", campaignSha256: f.campaignPlan.campaignSha256,
    group, phase: "timing", artifactRoot: f.binding.validation.artifactRoot,
    transferDestination: `00-${group}-timing/native`, nativeManifestSha256: tree(f.folder).sha256,
    phaseManifestSha256: tree(f.phase).sha256, status: { executionVersion: offline ? 6 : 5 } });
  const refuse = async (why) => {
    const result = await f.inspect();
    assert.equal(result.resources, "invalid", why);
    assert.equal(result.cleanupComplete, false, why);
  };

  await refuse("no settlement must keep the first census strict");
  await f.save(settledPath, settled);
  await refuse("no phase seal");
  await seal();
  const native = await f.inspect();
  assert.equal(native.status, "failed", "valid settlement, but targets still failed");
  assert.equal(native.resources, "verified");
  assert.equal(native.cleanupComplete, true);
  assert.ok(native.outcomes.every((r) => r.outcome === "failed"));
  if (offline) {
    await f.save(ingressPath, { before: offlineFence(), after: {} });
    await seal();
    await refuse("a resealed but invalid offline fence");
    await f.save(ingressPath, { before: offlineFence(), after: offlineFence() });
    await seal();
  }
  await f.save(settledPath, { ...settled, at: "altered after the phase seal" });
  await refuse("an altered census cannot use the old seal");
  await f.save(settledPath, settled);
  const { terminalClock: _clock, ...withoutClock } = f.terminal;
  const terminalPath = join(f.host, "terminal.json");
  await f.save(terminalPath, withoutClock);
  await seal();
  await refuse("copying a clock into the first census cannot replace lifetime evidence");
  await f.save(terminalPath, f.terminal);
  await f.save(afterPath, { ...after, terminalClock: { ...after.terminalClock, monoNs: "3000000" } });
  await seal();
  await refuse("resealing cannot substitute a different terminal clock");
  await f.save(afterPath, { ...after, processes: before.processes });
  await f.save(settledPath, { ...settled, bootId: "foreign" });
  await seal();
  await refuse("an invalid supplied settlement cannot downgrade to a clean first census");
  await unlink(settledPath);
  const ordinary = await f.inspect();
  assert.equal(ordinary.cleanupComplete, true, "an ordinary clean first census needs no settlement");
});

for (const [name, mutate] of [
  ["wrong group", (p) => { p.order = ["catalog-page"]; }],
  ["arbitrary subset", (p) => { p.order.push("catalog-page"); p.bindings.push({ request: { group: "catalog-page" } }); }],
  ["wrong scope", (p) => { p.schema = campaignSchema; }],
  ["unknown scope", (p) => { p.schema = "unknown"; }],
  ["wrong commit", (p) => { p.commit = "c".repeat(40); }],
  ["wrong round", (p) => { p.round = "r18"; }],
  ["changed selected binding", (p) => { p.bindings[0].request.recipe = "other"; }],
]) test(`dedicated phase refuses ${name} even when rehashed`, async (t) => {
  const f = await fixture(t, "live-delivery", () => {}, true);
  const { campaignSha256: ignored, ...body } = structuredClone(f.campaignPlan); mutate(body);
  const plan = { ...body, campaignSha256: deploymentSha256(body) };
  await f.save(join(f.campaignRoot, "plan.json"), plan);
  await f.save(join(f.campaignRoot, "..", ".host-attempt.json"), { ...f.reservation, campaignSha256: plan.campaignSha256 });
  const result = await f.inspect(); assert.equal(result.resources, "invalid"); assert.equal(result.cleanupComplete, false);
});

for (const group of ["live-delivery", "recoverable-live"]) test(`${group}: registry ordinal cannot stand in for a dedicated ordinal`, async (t) => {
  const f = await fixture(t, group, () => {}, true);
  const wrong = join(f.campaignRoot, `${String(groupNames.indexOf(group)).padStart(2, "0")}-${group}-timing`);
  await rename(f.phase, wrong);
  const result = await (group === "live-delivery" ? delivery : recovery)(f.binding, join(wrong, "native"));
  assert.equal(result.resources, "invalid"); assert.equal(result.cleanupComplete, false);
});

for (const field of ["id", "commit", "campaignSha256"]) test(`live phase requires matching reservation ${field}`, async (t) => {
  const f = await fixture(t, "live-delivery", () => {}, true);
  await f.save(join(f.campaignRoot, "..", ".host-attempt.json"), { ...f.reservation, [field]: "other" });
  const result = await f.inspect(); assert.equal(result.resources, "invalid"); assert.equal(result.cleanupComplete, false);
});

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
  ["unexplained native exit", (f) => { f.terminal.command.code = 99; }, "invalid"],
]) test(`live external ${name} cannot clear cleanup`, async (t) => {
  const f = await fixture(t, "live-delivery", change), result = await f.inspect();
  assert.equal(result.cleanupComplete, false); assert.equal(result.status, expected);
  if (expected === "blocked") {
    assert.equal(result.resources, "blocked");
    assert.ok(result.outcomes.every((row) => row.outcome === "failed"), "retain the recorded app dispositions as diagnostics");
  }
});

test("a source-bound harness error without target observations is retained but cannot qualify", async (t) => {
  const f = await fixture(t, "live-delivery");
  await rewriteArtifact({ ...f, compressed: async (file, value) => {
    const { gzipSync } = await import("node:zlib"), { digest } = await import("../evidence.mjs");
    const bytes = gzipSync(JSON.stringify(value)); await writeFile(join(f.folder, file), bytes); return { file, sha256: digest(bytes) };
  }, json: (file, value) => f.save(join(f.folder, file), value) }, "aspnet", 0, (a) => { delete a.capture; delete a.network; });
  await f.save(join(f.phase, "native-manifest.json"), tree(f.folder));
  const result = await f.inspect(); assert.equal(result.status, "blocked"); assert.equal(result.attemptComplete, false);
  assert.equal(result.outcomes[0].outcome, "failed"); assert.equal(result.cleanupComplete, true);
});

test("native tree seal and external host evidence are mandatory, never plan receipt flags", async (t) => {
  const f = await fixture(t, "live-delivery");
  await f.save(join(f.phase, "native-manifest.json"), { sha256: "c".repeat(64) });
  assert.equal((await f.inspect()).status, "invalid");
  await f.save(join(f.phase, "native-manifest.json"), tree(f.folder));
  const { unlink } = await import("node:fs/promises"); await unlink(join(f.phase, "host-after.json"));
  const r = await f.inspect(); assert.equal(r.cleanupComplete, false); assert.equal(r.resources, "blocked");
  assert.equal(r.status, "blocked");
  assert.ok(r.outcomes.every(({ outcome }) => outcome === "failed"));
  assert.ok(!JSON.stringify(r).includes("SYNTHETIC_PRIVATE_SENTINEL"));
});
