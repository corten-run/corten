// Runs alert-probe.mjs against one marketplace image in both sources, laid out like the gate
// (run.mjs): an owned network and upstream, the app on one CPU, and the probe in the checker's
// Playwright image sharing only the app's network namespace. Owned resources are removed in finally.
// usage: node alert-probe-run.mjs IMAGE [ITERATIONS] [RESULTS_DIR] [--label KEY=VALUE ...]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeImage } from "./raw-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const args = process.argv.slice(2), labels = [];
for (let i = args.indexOf("--label"); i !== -1; i = args.indexOf("--label")) {
  assert.match(args[i + 1] ?? "", /^[\w.-]+=[\w.:/-]*$/, "--label needs KEY=VALUE");
  labels.push("--label", args[i + 1]); args.splice(i, 2);
}
const [image, iterations = "50", results = join(here, "results", "alert-probe")] = args;
assert.ok(image && /^[1-9]\d*$/.test(iterations), "usage: node alert-probe-run.mjs IMAGE [ITERATIONS] [RESULTS_DIR] [--label KEY=VALUE ...]");
mkdirSync(results, { recursive: true });
const runId = `alert-probe-${randomBytes(4).toString("hex")}`;
const owner = ["--label", `run.corten.marketplace.alert-probe=${runId}`, ...labels];
const docker = (list, timeout = 60_000) => {
  const run = spawnSync("docker", list, { encoding: "utf8", timeout, maxBuffer: 64 * 2 ** 20 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, `docker ${list[0]}: ${run.stderr}`);
  return run.stdout.trim();
};
const port = (name) => JSON.parse(docker(["inspect", name]))[0].NetworkSettings.Ports["8080/tcp"][0].HostPort;
async function ready(url) {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 100))) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (response.status === 200) return; } catch {}
  }
  throw new Error(`${url} not ready in 60s`);
}
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies["@playwright/test"];
const checker = `mcr.microsoft.com/playwright:v${version}-noble`;
const fixtures = join(here, "fixtures");
const network = `${runId}-net`, upstream = `${runId}-upstream`;
const created = [];
let passed = true;
try {
  if (spawnSync("docker", ["image", "inspect", checker], { stdio: "ignore" }).status !== 0) docker(["pull", checker], 10 * 60_000);
  docker(["network", "create", ...owner, network]); created.push(["network", network]);
  // Each name is owned before its run, so a run that fails after creating its container is still removed.
  created.push(["container", upstream]);
  docker(["run", "-d", "--rm", "--name", upstream, ...owner, "--network", network, "--cpus", "2", "--memory", "512m", "-p", "127.0.0.1::8080",
    "-v", `${join(repo, "bench")}:/bench:ro`, "-v", `${fixtures}:/fixtures:ro`, nodeImage, "node", "/bench/marketplace/upstream.mjs"]);
  await ready(`http://127.0.0.1:${port(upstream)}/health`);
  for (const source of ["fixture", "api"]) {
    const app = `${runId}-${source}`;
    // No --rm: a crashed app keeps its log for the diagnostic until finally removes it.
    created.push(["container", app]);
    docker(["run", "-d", "--name", app, ...owner, "--network", network, "--cpus", "1", "--memory", "1g", "-p", "127.0.0.1::8080",
      "-v", `${fixtures}:/fixtures:ro`, "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
      "-e", `API_BASE=http://${upstream}:8080`, "-e", "PORT=8080", "-e", `HOSTS=${app},localhost,127.0.0.1`, image]);
    try {
      await ready(`http://127.0.0.1:${port(app)}/marketplace/en-US/item_1`);
      // A probe that dies before writing must not be read from an earlier run's file.
      rmSync(join(results, `${source}.json`), { force: true });
      created.push(["container", `${app}-probe`]);
      const probe = spawnSync("docker", ["run", "--rm", "--name", `${app}-probe`, ...owner, "--network", `container:${app}`,
        "--cpus", "4", "--memory", "2g", "--shm-size", "1g", "-v", `${repo}:/repo:ro`, "-v", `${resolve(results)}:/results`,
        "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", checker,
        "node", "/repo/bench/marketplace/alert-probe.mjs", "http://127.0.0.1:8080", source, iterations, `/results/${source}.json`],
      { encoding: "utf8", timeout: 60 * 60_000, maxBuffer: 64 * 2 ** 20 });
      assert.ifError(probe.error);
      const result = JSON.parse(readFileSync(join(results, `${source}.json`), "utf8"));
      console.log(`${source}: ${result.cases.map((c) => `${JSON.stringify(c.email)}/${JSON.stringify(c.price)} passed ${c.passed} failed ${c.failed} submit ms ${JSON.stringify(c.ms.submitted)}`).join("; ")}`);
      if (probe.status !== 0 || !result.passed) {
        passed = false;
        console.error(`${source} probe failed (exit ${probe.status}); diagnostics in ${join(results, `${source}.json`)}\n${probe.stderr.slice(-4096)}`);
      }
    } catch (error) {
      passed = false;
      console.error(`${source}: ${error.stack}`);
    } finally {
      // The app log is the server's side of any stalled submission.
      writeFileSync(join(results, `${source}-app.log`), spawnSync("docker", ["logs", app], { encoding: "utf8" }).output.join("").slice(-16384));
      // A timed-out docker client leaves its probe running; --rm alone would not stop it.
      for (const name of [`${app}-probe`, app]) {
        spawnSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore" });
        const owned = created.findIndex(([, entry]) => entry === name);
        if (owned !== -1) created.splice(owned, 1);
      }
    }
  }
} finally {
  for (const [kind, name] of created.reverse()) spawnSync("docker", kind === "network" ? ["network", "rm", name] : ["rm", "-f", "-v", name], { stdio: "ignore" });
}
assert.ok(passed, "script-free alert probe failed");