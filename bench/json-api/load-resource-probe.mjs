// Read-only, stand-alone Linux probe against one already-running synthetic container.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireLoadResources, loadResourcePeriodMs, replayLoadResources } from "./load-resource-proof.mjs";

const [id, ...extra] = process.argv.slice(2);
assert.equal(process.platform, "linux", "run on the host of the local Linux Docker daemon");
assert.ok(/^[a-f0-9]{64}$/.test(id) && !extra.length, "pass the exact synthetic container ID");
const memoryBytes = 128 * 2 ** 20, quota = 1;
const docker = (args, timeout = 3000) => execFileSync("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
  encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
  stdio: ["ignore", "pipe", "ignore"],
}).trim();
function inspect(status) {
  const rows = JSON.parse(docker(["container", "inspect", id]));
  assert.equal(rows.length, 1);
  const info = rows[0], { State: state, Config: config, HostConfig: host } = info;
  assert.ok(info.Id === id && config.Labels?.["corten.json.resource-probe"] === "1" && info.RestartCount === 0
    && host.RestartPolicy.Name === "no" && host.Memory === memoryBytes && host.NanoCpus === quota * 1e9
    && host.NetworkMode === "none", "expected only the dedicated synthetic probe container");
  assert.ok(state.Status === status && state.Running === (status === "running")
    && !state.OOMKilled && !state.Dead && !state.Restarting && !state.Paused && !state.Error, "probe container is not in the required state");
  return state;
}
const live = inspect("running"), pid = live.Pid;
const plan = { firstAt: Date.now() + 250, count: 6 }, rows = [];
for (let sequence = 0; sequence < plan.count; sequence++) {
  const slot = plan.firstAt + sequence * loadResourcePeriodMs;
  let wait;
  while ((wait = slot - Date.now()) > 0) await sleep(wait);
  assert.ok(Date.now() < slot + loadResourcePeriodMs, "missed synthetic acquisition slot");
  rows.push(acquireLoadResources({ id, pid, sequence }));
}
assert.equal(docker(["container", "wait", id], 15000), "0");
const terminal = inspect("exited");
assert.ok(terminal.StartedAt === live.StartedAt && terminal.Pid === 0 && terminal.ExitCode === 0, "probe lifecycle changed");
// Simulate late receipt for every row. Replay receives only the saved acquisition proof.
await sleep(120);
const result = replayLoadResources(JSON.parse(JSON.stringify(rows)), {
  id, pid, startedAt: live.StartedAt, finishedAt: terminal.FinishedAt, memoryBytes, quota, plan,
});
assert.ok(result.cpuMaxPctUpper > 0 && result.loadHasHeadroom, "synthetic probe needs observable CPU below its headroom threshold");
console.log(JSON.stringify({ scope: "synthetic-load-acquisition-only", result }));
