import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { cpuBoundary, participantEvidence, replayCpuBoundary } from "./producer-evidence.mjs";
import { sampleStats, replayStatsClient } from "./stats.mjs";
import { sha256, sleep } from "./capture.mjs";

test("actual OS cgroup boundaries, restart observations and sampler process closure replay", { skip: process.env.MIXED_RESOURCE_OS_PROBE !== "1" }, async () => {
  const folder = process.env.MIXED_RESOURCE_OS_OUTPUT; assert.ok(isAbsolute(folder));
  const docker = async (args) => {
    const answer = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 ** 2 });
    assert.equal(answer.status, 0, "bounded local Docker OS probe failed"); return answer.stdout.trim();
  };
  const runId = `mixed-os-resources-${randomBytes(4).toString("hex")}`, labels = ["--label", "agent.owner=codex", "--label", `agent.task=${runId}`,
    "--label", `run.corten.mixed-production=${runId}`], ids = [], participants = {}, repo = resolve(".");
  const image = JSON.parse(await docker(["image", "inspect", "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1"]))[0].Id;
  const inspect = async (id) => JSON.parse(await docker(["inspect", id]))[0];
  let sampler;
  try {
    for (const [role, cpu, memory] of [["app", "1", "1g"], ["upstream", "2", "512m"], ["load", "4", "2g"]]) {
      const id = await docker(["run", "-d", "--name", `${runId}-${role}`, ...labels, "--network", "none", "--cpus", cpu, "--memory", memory,
        image, "node", "-e", "setInterval(() => {}, 1000)"]); ids.push(id);
      participants[role] = await participantEvidence({ inspect, name: id, imageId: image, role,
        onReceipt: (receipt) => writeFileSync(join(folder, `participant-before-${role}.json`), JSON.stringify(receipt)) });
    }
    const reader = await docker(["run", "-d", "--name", `${runId}-reader`, ...labels, "--network", "none", "--cpus", "1", "--memory", "128m", "--cgroupns=host",
      "-v", "/sys/fs/cgroup:/sys/fs/cgroup:ro", "-v", `${repo}:/src:ro`, image, "node", "-e", "setInterval(() => {}, 1000)"]); ids.push(reader);
    const names = Object.keys(participants).map((role) => `${runId}-${role}`), log = join(folder, "stats.log"); sampler = sampleStats(names, log, 30);
    await sampler.ready;
    const before = await cpuBoundary({ docker, reader, participants, phase: "before", onReceipt: (r) => writeFileSync(join(folder, "cpu-before.json"), JSON.stringify(r)) });
    const startedUnixMs = Date.now();
    await docker(["exec", participants.app.id, "node", "-e", "const until=Date.now()+500; while(Date.now()<until) Math.sqrt(Date.now());"]);
    await sleep(2500); const finishedUnixMs = Date.now();
    const after = await cpuBoundary({ docker, reader, participants, phase: "after", onReceipt: (r) => writeFileSync(join(folder, "cpu-after.json"), JSON.stringify(r)) });
    for (const role of Object.keys(participants)) assert.ok(after[role] >= before[role]); assert.ok(after.app > before.app);
    await sampler.stop(); sampler = null;
    const read = (name) => JSON.parse(readFileSync(join(folder, name)));
    assert.deepEqual(replayCpuBoundary(read("cpu-before.json"), participants, "before"), before);
    assert.deepEqual(replayCpuBoundary(read("cpu-after.json"), participants, "after"), after);
    replayStatsClient(read("stats.log.process.json"), names, sha256(readFileSync(log)), { startedUnixMs, finishedUnixMs });
    writeFileSync(join(folder, "observer-replay.json"), JSON.stringify({ scope: "actual OS resource apparatus only, not native framework or group admission", runId, image,
      readerSourceSha256: sha256(readFileSync(join(repo, "bench/catalog/cgroup.mjs"))), before, after,
      startedUnixMs, finishedUnixMs, participants: Object.fromEntries(Object.entries(participants).map(([role, p]) => [role, { id: p.id, config: p.config }])) }, null, 2));
  } finally {
    if (sampler) await sampler.stop().catch(() => {});
    const removals = [];
    for (const id of ids.reverse()) removals.push({ id, raw: await docker(["rm", "-f", "-v", id]), remaining: await docker(["ps", "-a", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"]) });
    const inventory = await docker(["ps", "-a", "--no-trunc", "--filter", `label=run.corten.mixed-production=${runId}`, "--format", "{{.ID}}"]);
    writeFileSync(join(folder, "cleanup.json"), JSON.stringify({ runId, removals, inventory })); assert.equal(inventory, "");
    for (const item of removals) { assert.equal(item.raw, item.id); assert.equal(item.remaining, ""); }
  }
});
