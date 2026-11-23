// Runs alert-probe.mjs against one marketplace image in both sources, laid out like the gate
// (run.mjs): an owned network and upstream, the app on one CPU, and the probe in the checker's
// Playwright image sharing only the app's network namespace.
// usage: node alert-probe-run.mjs IMAGE [ITERATIONS] [RESULTS_DIR] [--budget SECONDS] [--label KEY=VALUE ...]
// --budget bounds each source's probe: it stops between cases once spent and still writes its diagnostics.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeImage } from "./raw-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
export const ownerKey = "run.corten.marketplace.alert-probe";
const commandTimeout = 30_000;

// Every docker command has a deadline. A timed-out client may leave its container running; teardown
// removes that container by ID, so the client is all the deadline needs to stop.
// combined: return stderr after stdout, for a container log, which Docker splits across both.
export const docker = async (args, { timeout = commandTimeout, combined = false } = {}) => {
  const run = spawnSync("docker", args, { encoding: "utf8", timeout, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 64 * 2 ** 20 });
  const what = `docker ${args.slice(0, 2).join(" ")}`;
  if (run.error) throw new Error(`${what}: ${run.error.code === "ETIMEDOUT" ? `timeout after ${timeout} ms` : run.error.message}`);
  if (run.status !== 0) throw Object.assign(new Error(`${what}: exit ${run.status}\n${(run.stderr || run.stdout).slice(-4096)}`), { status: run.status });
  return combined ? run.stdout + run.stderr : run.stdout.trim();
};
const ids = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);

// The owned-resource pattern of bench/catalog/run.mjs and bench/marketplace/run.mjs, keyed by ID:
// a resource is registered only by the immutable ID its create returned, and every inspect, log
// read and removal goes through that ID after confirming this run's owner label. A name is never
// proof of ownership. A removal that fails, or an owner that cannot be confirmed, stays pending,
// is retried once at teardown and fails the teardown; a resource whose create failed after Docker
// made it carries only the label, so teardown recovers it by label-confirmed ID.
export function ownedResources({ docker, runId, labels = [], timeout = commandTimeout }) {
  const owner = ["--label", `${ownerKey}=${runId}`, ...labels];
  const pending = new Map();
  const record = { runId, ownerLabel: `${ownerKey}=${runId}`, created: [], removed: [], recovered: [], failures: [], remaining: null };
  const fail = (resource, error) => record.failures.push({ resource, error: String(error?.message ?? error).slice(0, 2048) });
  const confirm = (kind, info, id) => {
    assert.equal(info?.Id, id, `${kind} ${id}: inspect returned a different object`);
    assert.equal((kind === "container" ? info.Config?.Labels : info.Labels)?.[ownerKey], runId, `refusing unowned ${kind} ${id}`);
    return info;
  };
  const inspect = async (id) => confirm("container", JSON.parse(await docker(["container", "inspect", id], { timeout }))[0], id);
  const register = (kind, id, name) => {
    assert.match(id, /^[0-9a-f]{64}$/, `docker ${kind} create ${name} returned no ID`);
    pending.set(id, { kind, id, name }); record.created.push({ kind, id, name });
    return id;
  };
  async function remove(id, { recovered = false } = {}) {
    const entry = pending.get(id) ?? { kind: "container", id, name: null };
    try {
      if (entry.kind === "network") {
        if (ids(await docker(["network", "ls", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"], { timeout })).includes(id)) {
          confirm("network", JSON.parse(await docker(["network", "inspect", id], { timeout }))[0], id);
          assert.equal(await docker(["network", "rm", id], { timeout }), id, `docker network rm did not confirm ${id}`);
        }
      } else if (ids(await docker(["ps", "-a", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"], { timeout })).includes(id)) {
        await inspect(id);
        assert.equal(await docker(["rm", "-f", "-v", id], { timeout }), id, `docker rm did not confirm ${id}`);
      }
      pending.delete(id);
      (recovered ? record.recovered : record.removed).push(entry);
      return true;
    } catch (error) { fail(`${entry.kind} ${entry.name ?? "unregistered"} ${id}`, error); return false; }
  }
  return {
    record,
    async network(name) { return register("network", await docker(["network", "create", ...owner, name], { timeout }), name); },
    async container(args, name) { return register("container", await docker(["create", "--name", name, ...owner, ...args], { timeout }), name); },
    inspect,
    async start(id) { await inspect(id); assert.equal(await docker(["start", id], { timeout }), id, `docker start did not confirm ${id}`); },
    // Start and attach; the container's own exit status is the command's.
    async attach(id, deadline) { await inspect(id); return docker(["start", "-a", id], { timeout: deadline }); },
    async logs(id) { await inspect(id); return docker(["logs", id], { timeout, combined: true }); },
    remove,
    has: (id) => pending.has(id),
    async teardown() {
      for (const id of [...pending.keys()].reverse()) await remove(id);
      const label = `label=${ownerKey}=${runId}`;
      try {
        for (const id of ids(await docker(["ps", "-a", "--no-trunc", "--filter", label, "--format", "{{.ID}}"], { timeout }))) await remove(id, { recovered: !pending.has(id) });
        for (const id of ids(await docker(["network", "ls", "--no-trunc", "--filter", label, "--format", "{{.ID}}"], { timeout }))) {
          if (!pending.has(id)) pending.set(id, { kind: "network", id, name: null });
          await remove(id, { recovered: !record.created.some((entry) => entry.id === id) });
        }
        record.remaining = { containers: ids(await docker(["ps", "-a", "--no-trunc", "--filter", label, "--format", "{{.ID}}"], { timeout })),
          networks: ids(await docker(["network", "ls", "--no-trunc", "--filter", label, "--format", "{{.ID}}"], { timeout })) };
        assert.deepEqual(record.remaining, { containers: [], networks: [] }, "owned resources survived teardown");
      } catch (error) { fail(`resources labelled ${record.ownerLabel}`, error); }
      record.complete = record.failures.length === 0;
      return record;
    },
  };
}

async function waitReady(url, timeout = 60_000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline; await new Promise((r) => setTimeout(r, 100))) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (response.status === 200) return; } catch {}
  }
  throw new Error(`${url} not ready in ${timeout / 1000}s`);
}

export async function runAlertProbe({ image, iterations = 50, results, budget = 3600, labels = [], runId = `alert-probe-${randomBytes(5).toString("hex")}`,
  docker: run = docker, ready = waitReady, log = console.log, error: report = console.error }) {
  mkdirSync(results, { recursive: true });
  // A run that dies early must not leave an earlier run's files to be read as its own.
  for (const file of ["fixture.json", "api.json", "fixture-app.log", "api-app.log", "cleanup.json"]) rmSync(join(results, file), { force: true });
  const owned = ownedResources({ docker: run, runId, labels });
  const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies["@playwright/test"];
  const checker = `mcr.microsoft.com/playwright:v${version}-noble`;
  const fixtures = join(here, "fixtures");
  const port = async (id) => (await owned.inspect(id)).NetworkSettings.Ports["8080/tcp"][0].HostPort;
  let passed = true, cleanup;
  try {
    try { await run(["image", "inspect", checker], { timeout: commandTimeout }); } catch { await run(["pull", checker], { timeout: 10 * 60_000 }); }
    const network = `${runId}-net`, upstreamName = `${runId}-upstream`;
    await owned.network(network);
    const upstream = await owned.container(["--network", network, "--cpus", "2", "--memory", "512m", "-p", "127.0.0.1::8080",
      "-v", `${join(repo, "bench")}:/bench:ro`, "-v", `${fixtures}:/fixtures:ro`, nodeImage, "node", "/bench/marketplace/upstream.mjs"], upstreamName);
    await owned.start(upstream);
    await ready(`http://127.0.0.1:${await port(upstream)}/health`);
    for (const source of ["fixture", "api"]) {
      const name = `${runId}-${source}`;
      let app, probe;
      try {
        app = await owned.container(["--network", network, "--cpus", "1", "--memory", "1g", "-p", "127.0.0.1::8080",
          "-v", `${fixtures}:/fixtures:ro`, "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
          "-e", `API_BASE=http://${upstreamName}:8080`, "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`, image], name);
        await owned.start(app);
        await ready(`http://127.0.0.1:${await port(app)}/marketplace/en-US/item_1`);
        probe = await owned.container(["--network", `container:${app}`, "--cpus", "4", "--memory", "2g", "--shm-size", "1g",
          "-v", `${repo}:/repo:ro`, "-v", `${resolve(results)}:/results`, "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", checker,
          "node", "/repo/bench/marketplace/alert-probe.mjs", "http://127.0.0.1:8080", source, String(iterations), `/results/${source}.json`, String(budget)], `${name}-probe`);
        // The probe stops itself at its budget; this deadline only covers a probe that cannot.
        let exit = null;
        try { await owned.attach(probe, (budget + 120) * 1000); } catch (e) { exit = e; }
        const output = join(results, `${source}.json`);
        if (!existsSync(output)) throw new Error(`probe wrote no result${exit ? `: ${exit.message}` : ""}`);
        const result = JSON.parse(readFileSync(output, "utf8"));
        log(`${source}: ${result.cases.map((c) => `${JSON.stringify(c.email)}/${JSON.stringify(c.price)} passed ${c.passed} failed ${c.failed} submit ms ${JSON.stringify(c.ms.submitted)}`).join("; ")}${result.stopped ? `; stopped ${JSON.stringify(result.stopped)}` : ""}`);
        if (exit || !result.passed) {
          passed = false;
          report(`${source} probe failed${exit ? ` (${exit.message.split("\n", 1)[0]})` : ""}; diagnostics in ${output}`);
        }
      } catch (e) {
        passed = false;
        report(`${source}: ${e.stack ?? e}`);
      } finally {
        // The app log is the server's side of any stalled submission, read only from the owned ID.
        if (app) {
          let text;
          try { text = await owned.logs(app); } catch (e) { text = `app log unavailable: ${e.message}`; report(`${source}: ${text}`); }
          writeFileSync(join(results, `${source}-app.log`), text.slice(-16384));
        }
        if (probe) await owned.remove(probe);
        if (app) await owned.remove(app);
      }
    }
  } catch (e) {
    passed = false;
    report(e.stack ?? String(e));
  } finally {
    cleanup = await owned.teardown();
    writeFileSync(join(results, "cleanup.json"), JSON.stringify(cleanup, null, 2));
    if (!cleanup.complete) report(`teardown failed: ${JSON.stringify(cleanup.failures)}`);
  }
  return { passed: passed && cleanup.complete, probesPassed: passed, cleanup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), labels = [];
  let budget = 3600;
  for (let i = args.indexOf("--label"); i !== -1; i = args.indexOf("--label")) {
    assert.match(args[i + 1] ?? "", /^[\w.-]+=[\w.:/-]*$/, "--label needs KEY=VALUE");
    labels.push("--label", args[i + 1]); args.splice(i, 2);
  }
  const at = args.indexOf("--budget");
  if (at !== -1) {
    assert.match(args[at + 1] ?? "", /^[1-9]\d*$/, "--budget needs SECONDS");
    budget = Number(args[at + 1]); args.splice(at, 2);
  }
  const [image, iterations = "50", results = join(here, "results", "alert-probe")] = args;
  assert.ok(image && /^[1-9]\d*$/.test(iterations), "usage: node alert-probe-run.mjs IMAGE [ITERATIONS] [RESULTS_DIR] [--budget SECONDS] [--label KEY=VALUE ...]");
  const { passed, probesPassed, cleanup } = await runAlertProbe({ image, iterations: Number(iterations), results, budget, labels });
  if (!passed) {
    console.error(`script-free alert probe ${probesPassed ? "passed but teardown failed" : "failed"}; cleanup ${cleanup.complete ? "complete" : "INCOMPLETE"}`);
    process.exitCode = 1;
  }
}
