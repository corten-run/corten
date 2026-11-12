// Local qualification and the complete browser gate on a built image, never load evidence.
// node bench/fullstack/apps/django/qualify-production.mjs <output-directory> [image]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qualify } from "../../../marketplace/qualify.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "../../../..");
const output = resolve(process.argv[2] ?? resolve(here, "work/production"));
const image = process.argv[3] ?? "cb-marketplace-django-granian:local";
mkdirSync(output, { recursive: true });
const task = `django-production-${process.pid}-${randomUUID().slice(0, 8)}`;
const labels = ["--label", "agent.owner=codex", "--label", `agent.task=${task}`];
const docker = (...args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
  assert.ok(!r.error && r.status === 0, `docker ${args[0]} failed: ${r.error?.message ?? r.stderr}`);
  return (args[0] === "logs" ? r.stdout + r.stderr : r.stdout).trim();
};
const containers = new Set();
const failures = [];
const cleanupFailures = [];
let primary;
let network = false;
const run = (name, args) => {
  containers.add(name);
  docker("run", "-d", "--name", name, ...labels, "--network", task, ...args);
};
const cleanup = (kind, name) => {
  try {
    // A failed run/create may still have created a resource. Never delete by an ambiguous name.
    const ids = docker(kind, "ls", ...(kind === "container" ? ["--all"] : []),
      "--filter", `name=${name}`, "--no-trunc", "--format", "{{.ID}}").split(/\r?\n/).filter(Boolean);
    for (const id of ids) {
      const info = JSON.parse(docker("inspect", "--type", kind, id))[0];
      if (info.Name !== (kind === "container" ? `/${name}` : name)) continue;
      const owned = kind === "container" ? info.Config.Labels : info.Labels;
      assert.ok(owned?.["agent.owner"] === "codex" && owned?.["agent.task"] === task,
        `ownership mismatch for ${kind} ${name}; refusing removal`);
      if (kind === "container") docker("rm", "-f", "-v", info.Id);
      else docker("network", "rm", info.Id);
    }
    return true;
  } catch (error) {
    cleanupFailures.push({ resource: `${kind} ${name}`, error: error.stack ?? String(error) });
    return false;
  }
};
const removeContainer = (name) => { if (cleanup("container", name)) containers.delete(name); };
const port = (name) => `http://127.0.0.1:${JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports["8080/tcp"][0].HostPort}`;
const ready = async (url) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await r.arrayBuffer();
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("local qualification server did not become ready");
};
try {
  network = true;
  docker("network", "create", ...labels, task);
  const upstream = `${task}-upstream`;
  run(upstream, ["--cpus", "1", "--memory", "1g", "-p", "127.0.0.1::8080",
    "-v", `${resolve(repo, "bench")}:/bench:ro`, "-e", "MARKETPLACE_FIXTURE_PATH=/bench/marketplace/fixtures/marketplace.json",
    "node:24-bookworm-slim", "node", "/bench/marketplace/upstream.mjs"]);
  await ready(`${port(upstream)}/health`);
  for (const source of ["fixture", "api"]) {
    const app = `${task}-${source}`;
    run(app, ["--cpus", "1", "--memory", "1g", "--ulimit", "nofile=65536:65536", "-p", "127.0.0.1::8080",
      "-v", `${resolve(repo, "bench/marketplace/fixtures")}:/fixtures:ro`,
      "-e", "PROFILE=matched", "-e", "MAX_CONNECTIONS=1000", "-e", `HOSTS=${app},localhost,127.0.0.1`,
      "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
      "-e", `API_BASE=http://${upstream}:8080`, image]);
    try {
      await ready(`${port(app)}/marketplace/en-US/item_1`);
      const info = JSON.parse(docker("inspect", app))[0];
      writeFileSync(resolve(output, `${source}-deployment.json`), JSON.stringify({ image: info.Image,
        command: [info.Path, ...info.Args], cpuQuota: info.HostConfig.NanoCpus, memory: info.HostConfig.Memory,
        profile: "matched", requestedMaxConnections: 1000,
        processes: docker("top", app, "-eo", "pid,ppid,nlwp,args"),
        effectiveConfig: docker("exec", app, "cat", "/proc/1/cmdline").split("\0").filter(Boolean),
        upstream: { cpuQuota: 1000000000, memory: 1073741824 }, sourceOverlays: [] }, null, 2));
      const result = await qualify({ base: port(app), source, upstream: port(upstream) });
      writeFileSync(resolve(output, `${source}-qualification.json`), JSON.stringify(result, null, 2));
      console.log(`${source}: ${result.eligible ? "qualified" : `missing ${result.missing.join(", ")}`}`);
      if (!result.eligible) failures.push(`${source}: ${result.missing.join(", ")}`);
      const check = `${app}-browser`;
      containers.add(check);
      const browserLog = docker("run", "--name", check, ...labels, "--network", task, "--cpus", "4", "--memory", "2g",
        "-v", `${repo}:/repo:ro`, "-v", `${output}:/results`, "-w", "/repo",
        "mcr.microsoft.com/playwright:v1.64.1-noble", "node", "bench/marketplace/check.mjs",
        `http://${app}:8080`, source, `http://${upstream}:8080`, `/results/${source}-browser.json`);
      removeContainer(check);
      writeFileSync(resolve(output, `${source}-browser.log`), browserLog);
      console.log(`${source}: complete browser gate passed`);
    } catch (error) {
      failures.push(`${source}: ${error.message}`);
      writeFileSync(resolve(output, `${source}-failure.log`), error.stack ?? String(error));
      console.error(`${source}: FAILED ${error.message}`);
    } finally {
      try {
        writeFileSync(resolve(output, `${source}-server.log`), docker("logs", app));
        const finalInfo = JSON.parse(docker("inspect", app))[0];
        writeFileSync(resolve(output, `${source}-terminal.json`), JSON.stringify({ state: finalInfo.State,
          processes: docker("top", app, "-eo", "pid,ppid,nlwp,args") }, null, 2));
      } catch (error) {
        failures.push(`${source} diagnostics: ${error.stack ?? String(error)}`);
      }
      removeContainer(app);
    }
  }
  assert.deepEqual(failures, [], "qualification/browser failures retained in output directory");
} catch (error) {
  primary = error;
} finally {
  for (const name of [...containers].reverse()) removeContainer(name);
  if (network) cleanup("network", task);
}
if (primary || cleanupFailures.length) {
  writeFileSync(resolve(output, "run-failures.json"), JSON.stringify({
    primary: primary?.stack ?? null, failures, cleanupFailures,
  }, null, 2));
  const errors = [primary, ...cleanupFailures.map((f) => new Error(`${f.resource}: ${f.error}`))].filter(Boolean);
  throw new AggregateError(errors, errors.map((e) => e.message).join("\n"), { cause: primary });
}
