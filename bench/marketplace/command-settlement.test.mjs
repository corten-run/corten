import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { commandRunner, releaseMs } from "../catalog/output.mjs";

test("Marketplace SIGTERM releases held pipes before the command deadline and permits only owned cleanup", async (t) => {
  // Run the CLI's signal and final cleanup code without starting the CLI or Docker.
  const source = readFileSync(new URL("./run.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const wiring = source.match(/^let interrupted = false;\n[\s\S]*?^const inspect = .*;$/m);
  const removal = source.match(/^async function remove\(name\) \{\n[\s\S]*?^\}/m);
  const cleanup = source.match(/^finally \{\n  const cleanupStartedAt =[\s\S]*?^\}/m);
  assert.ok(wiring && removal && cleanup, "Marketplace command wiring and final cleanup must be exercised");
  const process = new EventEmitter(), active = new Set(["owned", "foreign"]), removed = [], created = [];
  const summary = { complete: true, cleanupFailures: [] };
  const folder = ".", network = "test-net", evidenceVersion = 1;
  const repo = ".", label = "run.corten.marketplace", runId = "this-run", ownedId = "a".repeat(64), foreignId = "b".repeat(64);
  const docker = new Map([
    ["ps -a --filter name=^/owned$ --format {{.ID}}", ownedId],
    ["ps -a --filter name=^/foreign$ --format {{.ID}}", foreignId],
    ["inspect owned", JSON.stringify([{ Id: ownedId, Config: { Labels: { [label]: runId } }, Mounts: [] }])],
    ["inspect foreign", JSON.stringify([{ Id: foreignId, Config: { Labels: { [label]: "another-run" } }, Mounts: [] }])],
    [`rm -f -v ${ownedId}`, ownedId],
    ["network ls --filter name=^test-net$ --format {{.ID}}", ""],
    [`ps -a --filter label=${label}=${runId} --format {{.ID}}`, ""],
    [`network ls --filter label=${label}=${runId} --format {{.ID}}`, ""],
  ]);
  const argsSeen = [], heldPipes = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const spawn = childProcess.spawn;
  childProcess.spawn = (bin, args) => {
    assert.equal(bin, "docker");
    const key = args.join(" ");
    argsSeen.push(key);
    const child = new EventEmitter();
    Object.assign(child, { exitCode: 0, signalCode: null });
    for (const pipeName of ["stdout", "stderr"]) {
      const pipe = child[pipeName] = new EventEmitter();
      pipe.destroy = () => heldPipes.push(pipeName);
    }
    if (key !== "start -a held") {
      assert.ok(docker.has(key), `unexpected Docker command: ${key}`);
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(docker.get(key)));
        child.emit("close", 0, null);
      });
    }
    // The held client has exited, but its descendant never closes the pipes.
    return child;
  };
  syncBuiltinESMExports();
  try {
    const run = runInNewContext(`${wiring[0]}\n${removal[0]}\n(async () => {
      try { await docker(["start", "-a", "held"], { timeout: 15 * 60_000 }); }
      ${cleanup[0]}
    });`, {
      assert, process, active, removed, created, commandRunner, repo, label, runId, summary, folder, network, evidenceVersion,
      join: (...parts) => parts.join("/"), retain: () => {}, save: () => {},
    });
    const failed = assert.rejects(run(),
      (error) => error.exit?.interrupted && !error.exit.expired && /pipes were released/.test(error.message));
    process.emit("SIGTERM");
    t.mock.timers.tick(releaseMs);
    assert.deepEqual(heldPipes, ["stdout", "stderr"]);
    await failed;
    assert.deepEqual(argsSeen.filter((args) => args.startsWith("rm ")), [`rm -f -v ${ownedId}`]);
    assert.equal(removed[0].id, ownedId);
    assert.deepEqual([...active], ["foreign"]);
    assert.equal(summary.complete, false);
    assert.equal(summary.cleanupFailures.length, 1);
    assert.match(summary.cleanupFailures[0].error, /refusing cleanup of unowned foreign/);
  } finally {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
  }
});
