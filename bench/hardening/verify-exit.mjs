// Opt-in natural-exit/observer-start race. No framework qualification or published ports.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { terminalRecovery, collectTerminalHealth } from "./lifecycle.mjs";
import { targetOutcome } from "./evidence.mjs";

const exec = promisify(execFile), task = `hardening-exit-${randomBytes(6).toString("hex")}`, name = `${task}-target`, observer = `${task}-observer`;
const docker = async (args) => (await exec("docker", args, { timeout: 15000, windowsHide: true, maxBuffer: 2 ** 20 })).stdout.trim();
const inspect = async () => JSON.parse(await docker(["inspect", name]))[0];
const labels = ["--label", "agent.owner=codex", "--label", `agent.task=${task}`, "--label", `run.corten.hardening=${task}`];
const limits = ["--cpus", "1", "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "64"];
const waitForExit = async () => {
  const end = Date.now() + 15000;
  while (true) {
    const info = await inspect();
    if (!info.State.Running) return info;
    assert.ok(Date.now() < end, "target did not exit naturally");
    await new Promise((r) => setTimeout(r, 100));
  }
};
try {
  await docker(["run", "-d", "--name", name, "--network", "none", ...labels, ...limits, "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1", "node", "--input-type=module", "-e",
    'import {createServer} from "node:http";const server=createServer((req,res)=>{res.end("alive");if(req.url==="/exit")setTimeout(()=>{server.close();server.closeAllConnections();},250);});server.listen(8080,"127.0.0.1");']);
  await docker(["exec", name, "node", "-e", 'fetch("http://127.0.0.1:8080/health").then(r=>r.arrayBuffer())']);
  const before = await inspect(), since = new Date().toISOString();
  assert.equal(before.State.Running, true);
  const result = await collectTerminalHealth({ role: "application", source: "api", path: "/health", inspect, observe: async () => {
    await docker(["exec", name, "node", "-e", 'fetch("http://127.0.0.1:8080/exit").then(r=>r.arrayBuffer()).then(()=>process.exit(0))']);
    await waitForExit();
    await docker(["create", "--name", observer, "--network", `container:${name}`, ...labels, ...limits, "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1", "node", "-e", "process.exit(0)"]);
    try { await docker(["start", "-a", observer]); }
    catch (error) { assert.match(error.stderr, /cannot join network namespace of a non running container/); throw error; }
    assert.fail("Docker unexpectedly joined an exited target");
  } });
  assert.equal(result.after.State.Running, false); assert.equal(result.after.State.ExitCode, 0);
  assert.match(result.health.observerError, /cannot join network namespace/);
  const text = await docker(["events", "--since", since, "--until", new Date().toISOString(), "--filter", `container=${before.Id}`, "--format", "{{json .}}"]);
  const events = text ? text.split("\n").map(JSON.parse) : [];
  assert.ok(!events.some((e) => ["kill", "stop", "start", "restart", "destroy"].includes(e.Action)));
  const recovery = terminalRecovery(true, [{ id: "application", role: "application" }], [{ id: "application", running: true }],
    { application: { before, ...result, events } }, "api", { application: "/health" });
  const capture = { recovery, measurement: "complete", legitimate: Object.fromEntries(["before", "during", "after"].map((window) => [window, { counts: { sent: 1, ok: 1, errors: 0 } }])) };
  const outcome = targetOutcome(capture, { productionQualified: true }, { state: "observed" });
  assert.equal(outcome.classification, "target-capacity-failure"); assert.equal(outcome.numericComparisonQualified, false);
  console.log("PASS real Docker natural exit between Running check and observer start: retained target-capacity-failure, not apparatus-invalid");
} finally {
  for (const owned of [observer, name]) {
    const ids = await docker(["ps", "-aq", "--filter", `name=^/${owned}$`]);
    if (!ids) continue;
    const info = JSON.parse(await docker(["inspect", owned]))[0];
    assert.equal(info.Config.Labels["agent.owner"], "codex"); assert.equal(info.Config.Labels["agent.task"], task);
    await docker(["rm", "-f", "-v", info.Id]);
  }
  assert.equal(await docker(["ps", "-aq", "--filter", `label=agent.task=${task}`]), "");
  assert.equal(await docker(["volume", "ls", "-q", "--filter", `label=agent.task=${task}`]), "");
  console.log("PASS natural-exit control cleanup: zero containers or volumes");
}
