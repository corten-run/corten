// Stand-alone Linux probe against one pre-created, network-disabled synthetic container.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { startLoadResourceCapture } from "./load-resource-capture.mjs";
import { replayScheduledLoadResources } from "./load-resource-proof.mjs";

const [id, ...extra] = process.argv.slice(2);
assert.equal(process.platform, "linux", "run on the host of the local Linux Docker daemon");
assert.ok(/^[a-f0-9]{64}$/.test(id) && !extra.length, "pass the exact synthetic container ID");
const memoryBytes = 128 * 2 ** 20, quota = 1;
const exec = promisify(execFile);
const docker = (args, timeout = 3000) => exec("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
  encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
}).then(({ stdout }) => stdout.trim());
async function inspect(exact) {
  assert.equal(exact, id);
  const rows = JSON.parse(await docker(["container", "inspect", id]));
  assert.equal(rows.length, 1);
  const info = rows[0], { State: state, Config: config, HostConfig: host } = info;
  assert.ok(info.Id === id && config.Labels?.["corten.json.resource-probe"] === "1" && info.RestartCount === 0
    && host.RestartPolicy.Name === "no" && host.Memory === memoryBytes && host.NanoCpus === quota * 1e9
    && host.NetworkMode === "none", "expected only the dedicated synthetic probe container");
  assert.ok(!state.OOMKilled && !state.Dead && !state.Restarting && !state.Paused && !state.Error, "probe container is not in the required state");
  return info;
}
assert.equal((await inspect(id)).State.Status, "created");
const sampler = startLoadResourceCapture({ id, inspect });
let capture;
try { await docker(["container", "start", "--attach", id], 15000); }
finally {
  capture = await sampler.stop();
}
const terminal = (await inspect(id)).State;
assert.ok(terminal.Status === "exited" && terminal.Pid === 0 && terminal.ExitCode === 0, "probe lifecycle changed");
// Simulate late receipt for every row. Replay receives only the saved acquisition proof.
await sleep(120);
const result = replayScheduledLoadResources(JSON.parse(JSON.stringify(capture)), {
  containerId: id, startedAt: terminal.StartedAt, finishedAt: terminal.FinishedAt,
}, { memoryBytes, quota });
assert.ok(result.cpuMaxPctUpper > 0 && result.loadHasHeadroom, "synthetic probe needs observable CPU below its headroom threshold");
console.log(JSON.stringify({ scope: "synthetic-production-load-sampler", result }));
