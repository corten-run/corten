// Opt-in cached-image Docker control. This is apparatus verification, never
// marketplace parity, a native framework result or campaign qualification.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ownedContainerRecorder, ownedCleanupObservation, verifyOwnedCleanup, ownedResourceCleanup, verifyResourceCleanup, verifyContainerCommands } from "./lifecycle.mjs";
import { budgets } from "./plan.mjs";
import { buildNativeImage, committedInputs, digest, readyScript, savedFiles, verifyOwnedReceipts, verifyContainerLimit } from "./evidence.mjs";
import { nativeBuildContext } from "../mixed-production/build-context.mjs";

test("actual cached Docker build, charged worker lifetime and final cleanup replay", { skip: process.env.HARDENING_OS_PROOF !== "1", timeout: 120000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "hardening-os-proof-")), repository = join(folder, "git"), result = join(folder, "saved");
  const runId = `hardening-proof-${randomBytes(6).toString("hex")}`, tag = `${runId}-corten`, target = `${runId}-control`;
  const summary = { runId, startedAt: new Date().toISOString(), budget: budgets(), originalFolder: result, cleanupFailures: [],
    cells: [{ key: "corten/fixture/direct/slow-headers", app: "corten", source: "fixture", mode: "direct", status: "not-run" }] };
  mkdirSync(repository); mkdirSync(result);
  const execute = (binary, args, options = {}) => {
    const row = spawnSync(binary, args, { cwd: repository, input: options.input, windowsHide: true, timeout: Math.min(options.timeout ?? 20000, 60000),
      maxBuffer: 8 * 1024 ** 2, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } });
    if (options.receipt) Object.assign(options.receipt, { exitCode: row.status, timedOut: row.error?.code === "ETIMEDOUT", interrupted: !!row.signal });
    assert.equal(row.error, undefined, `${binary} command unavailable`);
    if (row.status !== 0) throw Object.assign(new Error(`${binary} ${args.slice(0, 2).join(" ")} failed`), {
      code: row.status, stdout: row.stdout, stderr: row.stderr,
    });
    return row.stdout.toString().trim();
  };
  const docker = async (args, options) => execute("docker", args, options), git = (args) => execute("git", args);
  let targetId, recorder, built = false, networkReserved = false;
  try {
    // No image pull or package install. The control Dockerfile has no RUN and
    // copies exactly one committed marker from the retained archive.
    const base = JSON.parse(await docker(["image", "inspect", "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1"]))[0];
    const dockerfile = "bench/marketplace/corten/Dockerfile"; mkdirSync(join(repository, "bench/marketplace/corten"), { recursive: true });
    writeFileSync(join(repository, "marker.txt"), "committed apparatus build input\n");
    const server = 'require("node:http").createServer((q,s)=>s.end("apparatus only")).listen(8080,"0.0.0.0")';
    writeFileSync(join(repository, dockerfile), `FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1\nCOPY marker.txt /marker.txt\nCMD ${JSON.stringify(["node", "-e", server])}\n`);
    git(["init", "--quiet"]); git(["add", "."]);
    git(["-c", "user.name=Apparatus Test", "-c", "user.email=apparatus@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "apparatus inputs"]);
    const commit = git(["rev-parse", "HEAD"]), files = committedInputs(repository, commit);
    const context = await nativeBuildContext({ command: async (binary, args, options) => execute(binary, args, options) }, result, commit, "corten", files.map(({ path, sha256 }) => ({ path, sha256 })));
    const before = savedFiles(join(result, "corten-build-context")); built = true;
    const build = await buildNativeImage(docker, { context, runId, commit, source: digest(JSON.stringify(files)), tag, files });
    summary.builds = { corten: build }; summary.ownedImages = [tag];
    assert.equal(build.command.inputSha256, digest(readFileSync(join(result, "corten-build-context.tar"))));
    assert.deepEqual(savedFiles(join(result, "corten-build-context")), before);
    assert.equal(JSON.parse(await docker(["image", "inspect", "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1"]))[0].Id, base.Id, "shared base tag changed");
    writeFileSync(join(result, "build.json"), JSON.stringify(build));
    const labels = ["--label", "agent.owner=codex", "--label", `agent.task=${runId}`, "--label", `run.corten.hardening=${runId}`];
    networkReserved = true; summary.ownedNetworks = [`${runId}-net`];
    await docker(["network", "create", ...labels, summary.ownedNetworks[0]]);
    targetId = await docker(["run", "-d", "--name", target, "--network", "none", ...labels, "--cpus", "1", "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "64", build.imageId]);
    const observedTarget = JSON.parse(await docker(["inspect", targetId]))[0];
    assert.equal(observedTarget.Image, build.imageId); assert.equal(observedTarget.State.Running, true);
    assert.equal(await docker(["exec", targetId, "node", "-e", 'process.stdout.write(require("node:fs").readFileSync("/marker.txt","utf8"))']), "committed apparatus build input");
    recorder = ownedContainerRecorder({ folder: result, runId, command: docker, cell: () => summary.cells[0], tools: () => ({ node: base }) });
    const limit = summary.budget.resources.apparatus, name = `${runId}-ready`;
    await recorder.owned(name, ["create", "--network", `container:${targetId}`, "--cpus", String(limit.cpu), "--memory", String(limit.memory), "--memory-swap", String(limit.memory),
      "--pids-limit", "512", "--ulimit", "nofile=65536:65536", base.Id, "node", "--input-type=module", "-e", readyScript]);
    await recorder.docker(["start", "-a", name], { timeout: 55000 }); await recorder.remove(name); recorder.seal();
    summary.tools = { node: base }; summary.finishedAt = new Date().toISOString();
    const sealed = savedFiles(result), r = recorder.records[0]; verifyContainerLimit(r.created, limit);
    assert.equal(verifyOwnedReceipts(recorder.records, summary).get(summary.cells[0].key).length, 1);
    assert.deepEqual(savedFiles(result), sealed, "read-only replay changed saved OS observations");
    const changed = structuredClone(recorder.records); changed[0].absence.stdout = r.created.Id;
    assert.throws(() => verifyOwnedReceipts(changed, summary));
    const failedName = `${runId}-cell-failure-control`;
    await recorder.owned(failedName, ["create", "--network", "none", "--cpus", String(limit.cpu), "--memory", String(limit.memory), "--memory-swap", String(limit.memory),
      "--pids-limit", "512", "--ulimit", "nofile=65536:65536", base.Id, "node", "-e",
      'process.stdout.write("observed failure stdout");process.stderr.write("observed failure stderr");process.exit(23)']);
    await assert.rejects(recorder.docker(["start", "-a", failedName]), (error) => error.code === 23);
    await recorder.remove(failedName); recorder.seal();
    const failed = JSON.parse(readFileSync(join(result, "owned-containers/00000001.json")));
    assert.equal(failed.start.exitCode, 23); assert.equal(failed.start.failed, true);
    assert.equal(failed.terminal.State.ExitCode, 23);
    assert.equal(failed.start.stdout, "observed failure stdout"); assert.equal(failed.start.stderr, "observed failure stderr");
    assert.doesNotThrow(() => verifyContainerCommands(failed, runId), "a known failure must not be mistaken for missing acknowledgement fields");
    // Actual bytes/config are positive apparatus evidence; the selected matrix
    // remains not-run. This control cannot admit any native benchmark group.
  } finally {
    if (recorder) for (const name of [...recorder.active]) await recorder.remove(name);
    if (targetId) {
      const info = JSON.parse(await docker(["inspect", targetId]))[0];
      assert.equal(info.Config.Labels["agent.task"], runId); await docker(["rm", "-f", "-v", targetId]);
      assert.equal(await docker(["ps", "-aq", "--no-trunc", "--filter", `id=${targetId}`]), "");
    }
    const resources = [];
    if (networkReserved) resources.push(await ownedResourceCleanup("network", `${runId}-net`, runId, docker));
    if (built) resources.push(await ownedResourceCleanup("image", tag, runId, docker));
    const cleanup = await ownedCleanupObservation(docker, runId, 0, recorder?.active.size ?? 0); summary.finishedAt = new Date().toISOString();
    verifyResourceCleanup(resources, summary);
    verifyResourceCleanup(resources, { ...summary, builds: {} }); // Materialized reservation, no successful build record.
    assert.equal(verifyOwnedCleanup(cleanup, summary), true);
    console.log(`Cleanup checked: zero owned container/volume/network/image inventory (${runId})`);
    const absolute = resolve(folder); assert.ok(absolute.startsWith(resolve(tmpdir()) + "\\") || absolute.startsWith(resolve(tmpdir()) + "/"));
    rmSync(absolute, { recursive: true, force: true });
  }
  console.log("PASS actual Docker apparatus: retained Git archive build and actual quota/exit/ID-removal/absence read-only replay");
});
