// Bounded regression probes, not a candidate qualification or performance matrix.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { build, docker, ownedInspector, root, sha256 } from "./build.mjs";
import { options, captureLogs } from "./run.mjs";
import { upstream, checkHttp, waitFor } from "./checks.mjs";
import { checkPages } from "./pages.mjs";
import { records as catalogRecords } from "../../catalog/fixtures.mjs";
import { records as marketplaceRecords } from "../../marketplace/fixtures.mjs";

const config = options(process.argv.slice(2)); mkdirSync(dirname(config.out), { recursive: true }); mkdirSync(config.out);
const task = `express-bun-fixes-${process.pid}-${randomBytes(4).toString("hex")}`;
const result = { scope: "bounded P2 regressions only", task, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  readyForMeasurement: false, readyForLoad: false, probes: [], cleanupFailures: [] };
const observe = (entry) => appendFileSync(join(config.out, "raw.ndjson"), JSON.stringify(entry) + "\n");
let browser, api, current;
const remove = async () => { if (current) { const name = current; await docker(["rm", "-f", "-v", name]); current = null; } };
const probe = async (name, action) => {
  try { const evidence = await action(); result.probes.push({ name, outcome: "passed", evidence }); }
  catch (error) { result.probes.push({ name, outcome: "failed", reason: error.stack }); }
};
try {
  const image = await build(config.out, task); result.build = image;
  await probe("inspector-timeout-removes-container", async () => {
    const pending = ownedInspector([image.image, "node", "-e", "setInterval(()=>{},1000)"], task, { timeoutMs: 20000 });
    // Attach the rejection immediately while observing the live owned container.
    const outcome = pending.then(() => null, (error) => error);
    let id, inspect, error;
    try {
      await waitFor(async () => { id = await docker(["ps", "-q", "--filter", `label=agent.task=${task}`]); return !!id; }, "inspector did not start", 15000);
      inspect = JSON.parse(await docker(["inspect", id]))[0];
      assert.ok(inspect.Name.includes("-inspector-"));
    } finally { error = await outcome; }
    assert.match(error?.message ?? "", /timed out/);
    assert.equal(await docker(["ps", "-aq", "--filter", `label=agent.task=${task}`]), "");
    return { container: id, name: inspect.Name, timeoutMs: 20000, remaining: [] };
  });
  await probe("docker-logs-retains-both-streams", async () => {
    const name = `${task}-logs`; current = name;
    const stdout = "native stdout\n" + "o".repeat(32768) + "\n\n", stderr = "native stderr\n" + "e".repeat(32768) + "\n\n";
    try {
      await docker(["run", "-d", "--name", name, "--network", "none", "--cpus", "1", "--memory", "512m", "--pids-limit", "128",
        "--label", "agent.owner=codex", "--label", `agent.task=${task}`, image.image, "node", "-e", 'process.stdout.write("native stdout\\n"+"o".repeat(32768)+"\\n\\n");process.stderr.write("native stderr\\n"+"e".repeat(32768)+"\\n\\n");process.exitCode=7']);
      assert.equal(await docker(["wait", name]), "7");
      await captureLogs(name, config.out, "two-streams");
      const actualOut = readFileSync(join(config.out, "two-streams.stdout.log")), actualErr = readFileSync(join(config.out, "two-streams.stderr.log"));
      assert.equal(actualOut.toString(), stdout); assert.equal(actualErr.toString(), stderr);
      const combined = readFileSync(join(config.out, "two-streams.log"), "utf8");
      assert.equal(Buffer.byteLength(combined), actualOut.length + actualErr.length);
      assert.ok(combined.includes("native stdout\n") && combined.includes("native stderr\n"));
      return { stdoutBytes: actualOut.length, stderrBytes: actualErr.length, stdoutSha256: sha256(actualOut), stderrSha256: sha256(actualErr), exitCode: 7 };
    } finally { await remove(); }
  });
  const records = { catalog: catalogRecords(), marketplace: marketplaceRecords() }, fixtures = join(config.out, "fixtures"); mkdirSync(fixtures);
  for (const [kind, value] of Object.entries(records)) writeFileSync(join(fixtures, `${kind}.json`), JSON.stringify(value));
  api = await upstream(records, observe);
  const { chromium } = createRequire(join(config.depsRoot, "package.json"))("playwright");
  browser = await chromium.launch({ headless: true, args: ["--renderer-process-limit=1"] }); result.browser = browser.version();
  for (const runtime of ["node", "bun"]) for (const actualSource of ["fixture", "api"]) await probe(`${runtime}-${actualSource}-fixture-claims`, async () => {
    const name = `${task}-${runtime}-${actualSource}`, outcomes = [], out = join(config.out, `${runtime}-${actualSource}`); mkdirSync(out); current = name;
    api.unavailable(actualSource === "fixture");
    const before = api.requests();
    const timer = setTimeout(() => docker(["kill", name]).catch(() => {}), 120000);
    try {
      await docker(["run", "-d", "--name", name, "--label", "agent.owner=codex", "--label", `agent.task=${task}`,
        "--cpus", "1", "--memory", "512m", "--pids-limit", "128", "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080",
        "-v", `${fixtures}:/fixtures:ro`, "-e", "NODE_ENV=production", "-e", `CATALOG_SOURCE=${actualSource}`, "-e", `MARKETPLACE_SOURCE=${actualSource}`,
        "-e", "CATALOG_FIXTURE_PATH=/fixtures/catalog.json", "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
        "-e", `API_BASE=http://host.docker.internal:${api.port}`, image.image, runtime, "server.mjs"]);
      const port = (await docker(["port", name, "8080/tcp"])).split(":").at(-1), base = `http://127.0.0.1:${port}`;
      await waitFor(async () => { try { const r = await fetch(base + "/api/catalog/record_1", { signal: AbortSignal.timeout(1000) }); await r.arrayBuffer(); return r.status === 200; } catch { return false; } }, "native readiness failed", 15000);
      const test = async (name, action) => {
        if (!name.endsWith("/all-500-json-and-source") && !["catalog/browser-js-false", "marketplace/en-US/browser-js-false"].includes(name)) return;
        try { await action(); outcomes.push({ name, outcome: "passed" }); }
        catch (error) { outcomes.push({ name, outcome: "failed", reason: error.message, stack: error.stack, cause: error.cause?.stack }); }
      };
      await checkHttp({ base, source: "fixture", profile: "default", records, upstream: api, observe, test });
      await checkPages({ base, source: "fixture", records, upstream: api, browser, observe, test, out });
      assert.equal(outcomes.length, 4);
      if (actualSource === "fixture") { assert.ok(outcomes.every((test) => test.outcome === "passed"), JSON.stringify(outcomes)); assert.equal(api.requests() - before, 0); }
      else assert.ok(outcomes.every((test) => test.outcome === "failed" && /fixture.*upstream/i.test(test.reason)), JSON.stringify(outcomes));
      return { actualSource, claimedSource: "fixture", outcomes, upstreamAttemptsIncludingReadiness: api.requests() - before };
    } finally { clearTimeout(timer); api.unavailable(false); try { await captureLogs(name, config.out, `${runtime}-${actualSource}`); } finally { await remove(); } }
  });
} catch (error) { result.failure = error.stack; }
finally {
  for (const [name, action] of [["container", remove], ["browser", () => browser?.close()], ["upstream", () => api?.close()],
    ["image", async () => { if (existsSync(join(config.out, "image.id"))) await docker(["image", "rm", `corten-express-bun:${task}`]); }]]) {
    try { await action(); } catch (error) { result.cleanupFailures.push({ name, reason: error.message }); }
  }
  result.remainingContainers = await docker(["ps", "-aq", "--filter", `label=agent.task=${task}`]);
  result.remainingImages = await docker(["image", "ls", "-q", "--filter", `label=agent.task=${task}`]);
  result.passed = !result.failure && !result.cleanupFailures.length && !result.remainingContainers && !result.remainingImages && result.probes.length === 6 && result.probes.every((probe) => probe.outcome === "passed");
  writeFileSync(join(config.out, "regressions.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ passed: result.passed, probes: result.probes.map(({ name, outcome }) => ({ name, outcome })), cleanupFailures: result.cleanupFailures, remainingContainers: result.remainingContainers, remainingImages: result.remainingImages }));
  process.exitCode = result.passed ? 0 : 1;
}
