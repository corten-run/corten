// Opt-in real Docker health control, not a native framework qualification.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { terminalRecovery } from "./lifecycle.mjs";
import { targetOutcome } from "./evidence.mjs";

const exec = promisify(execFile), task = `hardening-health-${randomBytes(6).toString("hex")}`, name = task;
const repo = fileURLToPath(new URL("../../", import.meta.url));
const docker = async (args) => (await exec("docker", args, { timeout: 15000, windowsHide: true, maxBuffer: 2 ** 20 })).stdout.trim();
const inspect = async () => JSON.parse(await docker(["inspect", name]))[0];
const clock = async () => JSON.parse(await docker(["exec", name, "node", "/repo/bench/hardening/clock.mjs"]));
const health = async () => JSON.parse(await docker(["exec", name, "node", "/repo/bench/hardening/lifecycle.mjs", "http://127.0.0.1:8080", "/health", "600"]));
const waitFor = async (status) => {
  const end = Date.now() + 15000;
  while (true) {
    const info = await inspect();
    if (info.State.Health.Status === status) return info;
    assert.ok(Date.now() < end, `Docker health did not become ${status}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
let created = false;
try {
  // Reserve the exact name before creation, including failed daemon acknowledgement.
  created = true;
  await docker(["run", "-d", "--name", name, "--network", "none", "--cpus", "1", "--memory", "128m", "--memory-swap", "128m",
    "--pids-limit", "64", "--label", "agent.owner=codex", "--label", `agent.task=${task}`, "--label", `run.corten.hardening=${task}`,
    "-v", `${resolve(repo)}:/repo:ro`, "--health-interval", "1s", "--health-timeout", "2s", "--health-retries", "1",
    "--health-cmd", 'node -e "fetch(\'http://127.0.0.1:8080/health\').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"',
    "node:24-bookworm-slim", "node", "--input-type=module", "-e",
    'import {createServer} from "node:http";let failed=false;createServer((req,res)=>{if(req.url==="/fail")failed=true;res.writeHead(req.url==="/health"&&failed?503:200);res.end("native health control");}).listen(8080,"127.0.0.1");']);
  const before = await waitFor("healthy"), start = await clock(), good = await health();
  assert.equal(good.response.status, 200);
  await docker(["exec", name, "node", "-e", 'fetch("http://127.0.0.1:8080/fail").then(r=>r.arrayBuffer())']);
  const failed = await health(), after = await waitFor("unhealthy"), end = await clock(), observation = { start, end };
  assert.equal(after.State.Running, true); assert.equal(after.State.StartedAt, before.State.StartedAt);
  assert.equal(failed.response.status, 503); assert.equal(failed.response.complete, true);
  for (const role of ["application", "proxy", "upstream"]) {
    const processes = [{ id: role, role }], resources = [{ id: role, running: true }], paths = { [role]: "/health" }, endpoints = { [role]: "http://127.0.0.1:8080/health" };
    assert.equal(terminalRecovery(true, processes, resources, { [role]: { after: before, health: good, observation } }, "api", paths, endpoints).disposition, "recovered");
    for (const [snapshot, receipt] of [[after, good], [before, failed], [after, failed]]) {
      const recovery = terminalRecovery(true, processes, resources, { [role]: { after: snapshot, health: receipt, observation } }, "api", paths, endpoints);
      const capture = { recovery, measurement: "complete", legitimate: Object.fromEntries(["before", "during", "after"].map((window) => [window, { counts: { sent: 1, ok: 1, errors: 0 } }])) };
      const outcome = targetOutcome(capture, { productionQualified: true }, { state: "observed" });
      assert.equal(recovery.disposition, "not-recovered"); assert.equal(outcome.classification, "target-capacity-failure"); assert.equal(outcome.numericComparisonQualified, false);
    }
  }
  console.log("PASS real Docker: running/unhealthy and completed terminal 503 independently revoke recovery for application/proxy/API upstream; no numeric qualification");
} finally {
  if (created) {
    const ids = await docker(["ps", "-aq", "--filter", `name=^/${name}$`]);
    if (ids) {
      const info = await inspect();
      assert.equal(info.Config.Labels["agent.owner"], "codex"); assert.equal(info.Config.Labels["agent.task"], task);
      await docker(["rm", "-f", "-v", info.Id]);
    }
    assert.equal(await docker(["ps", "-aq", "--filter", `label=agent.task=${task}`]), "");
    assert.equal(await docker(["volume", "ls", "-q", "--filter", `label=agent.task=${task}`]), "");
    console.log("PASS owned Docker health control cleanup: zero containers or volumes");
  }
}
