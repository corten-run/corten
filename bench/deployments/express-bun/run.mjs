import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { records as catalogRecords } from "../../catalog/fixtures.mjs";
import { records as marketplaceRecords } from "../../marketplace/fixtures.mjs";
import { build, docker, here, root, sha256 } from "./build.mjs";
import { upstream, checkHttp, waitFor } from "./checks.mjs";
import { checkPages } from "./pages.mjs";
import { checkAlerts } from "./alerts.mjs";

export const schema = "express-bun-qualification/v1";
export function options(args) {
  const [round, ...rest] = args;
  assert.match(round ?? "", /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/, "explicit safe round required");
  const values = { out: join(here, "work", round), "deps-root": root }, seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    assert.ok(rest[i].startsWith("--") && Object.hasOwn(values, key) && rest[i + 1] && !seen.has(key), "unknown, duplicate or missing option");
    seen.add(key); values[key] = rest[i + 1];
  }
  return { round, out: resolve(values.out), depsRoot: resolve(values["deps-root"]) };
}
export const cellKeys = () => ["node", "bun"].flatMap((runtime) => ["fixture", "api"].flatMap((source) => ["default", "matched"].map((profile) => `${runtime}-${source}-${profile}`)));
export function expectedChecks(source) {
  const names = ["native-form-cross-site-and-errors", "production-profile-cache-security-compression", "persisted-alerts/http-session-and-rejections"];
  for (const kind of ["catalog", "marketplace"]) {
    names.push(`${kind}/all-500-json-and-source`, `${kind}/headers-head-method-errors`);
    if (source === "api") {
      for (const name of ["malformed", "incomplete", "wrong-id", "unknown-key", "wrong-type", "lone-surrogate", ...(kind === "marketplace" ? ["rating-out-of-range", "negative-count", "duplicate-row-id"] : [])]) names.push(`${kind}/reject-${name}`);
      for (const status of [302, 503]) names.push(`${kind}/page-json-upstream-${status}`);
      for (const phase of ["headers", "body"]) for (const mode of ["caller-disconnect", "whole-read-deadline"]) names.push(`${kind}/${phase}/${mode}`);
      names.push(`${kind}/recovery`, `${kind}/fresh-page-source`);
    }
  }
  for (const js of [false, true]) {
    names.push(`catalog/browser-js-${js}`);
    for (const locale of ["en-US", "fr-FR", "de-DE"]) names.push(`marketplace/${locale}/browser-js-${js}`);
  }
  return names.sort();
}
export function summarize(cells) {
  const passed = (key) => {
    const cell = cells[key], expected = expectedChecks(key.split("-")[1]);
    return cell?.outcome === "passed" && cell.tests?.length === expected.length && cell.tests.every((test) => test.outcome === "passed")
      && JSON.stringify(cell.tests.map((test) => test.name).sort()) === JSON.stringify(expected);
  };
  const complete = cellKeys().every(passed);
  const pairs = Object.fromEntries(["fixture", "api"].flatMap((source) => ["default", "matched"].map((profile) => {
    const keys = ["node", "bun"].map((runtime) => `${runtime}-${source}-${profile}`);
    return [`${source}-${profile}`, { independentChecksPassed: keys.every(passed), cells: keys }];
  })));
  return { functionalPassed: complete, pairs, readyForMeasurement: false, readyForLoad: false,
    gaps: ["Independent native source/serializer audit is not supplied by this runner.", "Mobile, dark-mode, complete style parity and production capability gates are not run.",
      "Bun documents Node HTTP compatibility differences; complete connection/header/deadline/cancellation policy qualification remains separate.",
      "No load, startup, memory, bytecode, standalone or machine-AOT comparison was made."] };
}
export async function run(args) {
  const config = options(args); mkdirSync(dirname(config.out), { recursive: true }); mkdirSync(config.out);
  const task = `express-bun-${process.pid}-${randomBytes(4).toString("hex")}`;
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const tracked = git("ls-files", "bench/fullstack/apps/express", "bench/catalog", "bench/marketplace", "bench/workloads", "scripts/steady.mjs").split("\n").filter(Boolean);
  const harness = ["Dockerfile", "Dockerfile.dockerignore", "pins.json", "identity.mjs", "build.mjs", "checks.mjs", "pages.mjs", "alerts.mjs", "run.mjs"];
  const files = [...tracked, ...harness.map((name) => `bench/deployments/express-bun/${name}`)];
  const hashes = () => Object.fromEntries(files.sort().map((path) => [path, sha256(readFileSync(join(root, path)))]));
  const result = { schema, round: config.round, candidate: "express-bun-normal", baseline: "express-node-normal",
    provenance: { commit: git("rev-parse", "HEAD"), dirty: !!git("status", "--porcelain"), sources: hashes(), harnessNode: process.version,
      execution: "ordinary runtime, unchanged shared Express source", build: null, browser: null },
    controls: { appCpus: 1, appMemory: "512m", pidsLimit: 128, requestedMaxConnections: 256, perCellMs: 180000, browserInstances: 1, concurrentPages: 1, rendererProcessLimit: 1, jsonConcurrency: 8, measuredThroughput: false },
    cases: { fixture: expectedChecks("fixture"), api: expectedChecks("api") },
    cells: Object.fromEntries(cellKeys().map((key) => [key, { outcome: "not-run", reason: "not-yet-executed", tests: [] }])), cleanupFailures: [] };
  let image, browser, api, current, interruptCleanup, interrupted = false;
  const interrupt = () => {
    interrupted = true;
    interruptCleanup ??= current ? docker(["kill", current.name]).catch(() => {}) : Promise.resolve();
  };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const observe = (entry) => appendFileSync(join(config.out, "raw.ndjson"), JSON.stringify({ cell: current?.key ?? null, ...entry }) + "\n");
  const cleanup = async (name, action) => { try { await action(); } catch (error) { result.cleanupFailures.push({ name, message: error.message }); } };
  const stop = async () => {
    if (!current) return;
    const { name, key } = current;
    await cleanup(`logs-${key}`, async () => writeFileSync(join(config.out, `${key}.log`), await docker(["logs", name])));
    await cleanup(`container-${key}`, () => docker(["rm", "-f", "-v", name])); current = null;
  };
  try {
    // A supplied image can forge its own inspector and receipt. Only build from
    // this checkout; never promote caller-provided metadata into native evidence.
    image = await build(config.out, task);
    result.provenance.build = image;
    if (interrupted) throw new Error("interrupted before native checks");
    const records = { catalog: catalogRecords(), marketplace: marketplaceRecords() }, fixtures = join(config.out, "fixtures"); mkdirSync(fixtures);
    for (const [kind, value] of Object.entries(records)) writeFileSync(join(fixtures, `${kind}.json`), JSON.stringify(value));
    result.provenance.fixtures = Object.fromEntries(Object.entries(records).map(([kind, value]) => [kind, sha256(JSON.stringify(value))]));
    api = await upstream(records, observe);
    const { chromium } = createRequire(join(config.depsRoot, "package.json"))("playwright");
    browser = await chromium.launch({ headless: true, args: ["--renderer-process-limit=1"] }); result.provenance.browser = browser.version();
    for (const key of cellKeys()) {
      if (interrupted) { result.cells[key].reason = "interrupted"; continue; }
      const [runtime, source, profile] = key.split("-"), name = `${task}-${key}`, cell = result.cells[key];
      current = { name, key }; let expired = false, timer, deadlineKill;
      const test = async (name, action) => {
        if (expired || interrupted) { cell.tests.push({ name, outcome: "not-run", reason: interrupted ? "interrupted" : "cell-deadline" }); return; }
        try { const evidence = await action(); cell.tests.push({ name, outcome: "passed", evidence: evidence ?? null }); }
        catch (error) { cell.tests.push({ name, outcome: "failed", reason: error.message }); }
        observe({ kind: "test", ...cell.tests.at(-1) });
      };
      try {
        cell.options = { runtime, source, profile, command: [runtime, "server.mjs"], env: { NODE_ENV: "production", PROFILE: profile === "matched" ? "matched" : "", MAX_CONNECTIONS: "256", CATALOG_SOURCE: source, MARKETPLACE_SOURCE: source } };
        await docker(["run", "-d", "--name", name, "--label", "agent.owner=codex", "--label", `agent.task=${task}`, "--cpus", "1", "--memory", "512m", "--pids-limit", "128",
          "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-v", `${fixtures}:/fixtures:ro`,
          ...Object.entries(cell.options.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), "-e", `API_BASE=http://host.docker.internal:${api.port}`,
          "-e", "CATALOG_FIXTURE_PATH=/fixtures/catalog.json", "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json", image.image, runtime, "server.mjs"]);
        timer = setTimeout(() => { expired = true; deadlineKill = docker(["kill", name]).catch(() => {}); }, result.controls.perCellMs);
        const port = (await docker(["port", name, "8080/tcp"])).split(":").at(-1), base = `http://127.0.0.1:${port}`;
        await waitFor(async () => { try { const r = await fetch(`${base}/api/catalog/record_1`, { signal: AbortSignal.timeout(1000) }); await r.arrayBuffer(); return r.status === 200; } catch { return false; } }, "native startup readiness failed", 30000);
        cell.readiness = { outcome: "ready", image: image.image, port: Number(port) };
        cell.runtime = JSON.parse(await docker(["exec", name, runtime, "-e", "console.log(JSON.stringify({versions:process.versions,executable:process.execPath}))"]));
        const out = join(config.out, key); mkdirSync(out);
        await checkHttp({ base, source, profile, records, upstream: api, observe, test });
        await checkAlerts({ base, source, upstream: api, observe, test });
        await checkPages({ base, source, records, upstream: api, browser, observe, test, out });
        cell.outcome = !expired && cell.tests.length > 0 && cell.tests.every((test) => test.outcome === "passed") ? "passed" : "failed";
      } catch (error) { cell.outcome = "failed"; cell.reason = error.message; }
      finally { clearTimeout(timer); await deadlineKill; api.fault(null); await stop(); }
      console.log(`${key}: ${cell.outcome}; ${cell.tests.filter((t) => t.outcome === "passed").length}/${cell.tests.length} checks passed`);
      writeFileSync(join(config.out, `${key}.json`), JSON.stringify(cell, null, 2) + "\n");
    }
    assert.deepEqual(hashes(), result.provenance.sources, "source changed during native checks");
  } catch (error) { result.failure = { reason: error.message }; }
  finally {
    await interruptCleanup;
    await stop(); await cleanup("browser", async () => browser?.close()); await cleanup("upstream", async () => api?.close());
    const iid = join(config.out, "image.id");
    if (existsSync(iid)) await cleanup("owned-image", () => docker(["image", "rm", `corten-express-bun:${task}`]));
    Object.assign(result, summarize(result.cells));
    if (interrupted) result.failure = { reason: "interrupted" };
    if (result.failure || result.cleanupFailures.length) result.functionalPassed = false;
    writeFileSync(join(config.out, "result.json"), JSON.stringify(result, null, 2) + "\n");
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await run(process.argv.slice(2)); process.exitCode = result.functionalPassed ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
