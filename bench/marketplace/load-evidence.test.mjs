import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { retainLoadEvidence, validateLoadExecution } from "./load-evidence.mjs";
import { containerReceipt, k6Image, nodeImage } from "./raw-contract.mjs";

// Execute the producer's actual k6 callback, mocking only the k6 runtime imports
// and Docker transport. Do not substitute the synthetic saved-folder generator.
function producerCallback() {
  const source = readFileSync(new URL("./load.js", import.meta.url), "utf8")
    .replace('import http from "k6/http";', "").replace('import { check } from "k6";', "")
    .replace("export const options", "const options").replace("export function handleSummary", "function handleSummary")
    .replace("export default function ()", "function iteration()");
  return runInNewContext(`${source}\nhandleSummary;`, {
    __ENV: { TARGET: "page", MODE: "fixed", RATE: "150", DURATION: "15s", VUS: "64" },
    http: { expectedStatuses: () => {}, setResponseCallback: () => {} },
  });
}

test("real producer callback and copy path retain k6 engine elapsed, including graceful completion and sub-ms clocks", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "marketplace-load-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const handleSummary = producerCallback(), count = 1500;
  for (const nanoseconds of [14999999999, 15000000001, 15137123456, 24999999999]) {
    // k6's CounterSink.Format uses duration.Seconds(); handleSummary exports
    // float64(duration)/float64(time.Millisecond). Keep their independent math.
    const elapsed = nanoseconds / 1e6;
    const legacy = { metrics: { http_reqs: { count, rate: count / (nanoseconds / 1e9) } } };
    const outputs = { "/tmp/marketplace-summary.json": JSON.stringify(legacy), ...handleSummary({ state: { testRunDurationMs: elapsed } }) };
    const calls = [];
    const docker = async (args) => {
      calls.push(args);
      assert.equal(args[0], "cp"); assert.ok(args[1].startsWith("native-k6:"));
      const content = outputs[args[1].slice("native-k6:".length)]; assert.equal(typeof content, "string"); writeFileSync(args[2], content);
    };
    const summary = await retainLoadEvidence(docker, "native-k6", folder, "fixed");
    assert.deepEqual(calls, [
      ["cp", "native-k6:/tmp/marketplace-summary.json", join(folder, "fixed.json")],
      ["cp", "native-k6:/tmp/marketplace-clock.json", join(folder, "fixed-clock.json")],
    ]);
    const clock = JSON.parse(readFileSync(join(folder, "fixed-clock.json")));
    assert.deepEqual(clock, { testRunDurationMs: elapsed }); assert.deepEqual(summary, legacy);
    const start = Date.parse("2026-01-01T00:00:00.000Z"), end = start + Math.ceil(elapsed) + 1500;
    const load = { state: { Running: false, OOMKilled: false, ExitCode: 0,
      StartedAt: "2026-01-01T00:00:00.123456789Z", FinishedAt: new Date(start + Math.ceil(elapsed) + 777).toISOString() } };
    const evidence = { load, summary, clock, start, end, seconds: 15 };
    validateLoadExecution(evidence);
    const rate = summary.metrics.http_reqs.rate;
    summary.metrics.http_reqs.rate = 1e9; assert.throws(() => validateLoadExecution(evidence), /count\/rate/); summary.metrics.http_reqs.rate = rate;
    for (const bad of [14997, elapsed + 2000, "15000", null, Infinity]) assert.throws(() => validateLoadExecution({ ...evidence, clock: { testRunDurationMs: bad } }));
    assert.throws(() => validateLoadExecution({ ...evidence, clock: {} }));
  }
  await assert.rejects(retainLoadEvidence(async (args) => { if (args[1].includes("clock")) throw new Error("missing raw clock"); }, "native-k6", folder, "fixed"), /missing raw clock/);
});

// Opt-in local producer integration, never part of offline saved validation.
// Both images must already be cached; no pulls, external networking or ports.
test("pinned real k6 producer exports replayable elapsed against an isolated HTTP mock", { skip: process.env.MARKETPLACE_PRODUCER_MOCK !== "1" }, async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "marketplace-k6-mock-"));
  const prefix = `marketplace-producer-mock-${randomBytes(5).toString("hex")}`, created = [];
  const docker = async (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 40000, maxBuffer: 2 ** 20, windowsHide: true }).trim();
  t.after(async () => {
    try {
      const errors = [];
      for (const name of created.reverse()) try { await docker(["rm", "-f", "-v", name]); } catch (e) { errors.push(e); }
      assert.equal(errors.length, 0, errors.map((e) => e.message).join("\n"));
    }
    finally { rmSync(folder, { recursive: true, force: true }); }
  });
  const create = async (name, args) => {
    const id = await docker(["create", "--pull=never", "--name", name, "--label", "agent.owner=codex", "--label", "agent.task=corten-bench-marketplace-raw-proof", ...args]);
    created.push(id); return id;
  };
  const mock = await create(`${prefix}-http`, ["--network", "none", "--cpus", "1", "--memory", "128m", nodeImage, "node", "-e",
    "require('http').createServer((q,r)=>setTimeout(()=>{r.setHeader('Content-Type','text/html');r.end('<html>mock</html>')},200)).listen(8080,'127.0.0.1')"]);
  await docker(["start", mock]);
  await docker(["exec", mock, "node", "-e", "fetch('http://127.0.0.1:8080').then(r=>{if(!r.ok)process.exit(1)})"]);
  const start = Date.now();
  const load = await create(`${prefix}-k6`, ["--network", `container:${mock}`, "--cpus", "4", "--memory", "2g", "-v", `${resolve("bench")}:/bench:ro`,
    ...Object.entries({ TARGET: "page", MODE: "fixed", BASE: "http://127.0.0.1:8080", LOCALE: "en-US", RATE: "150", VUS: "64", DURATION: "15s" }).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    k6Image, "run", "--quiet", "--summary-export", "/tmp/marketplace-summary.json", "/bench/marketplace/load.js"]);
  await docker(["start", "-a", load]);
  const summary = await retainLoadEvidence(docker, load, folder, "fixed");
  const clock = JSON.parse(readFileSync(join(folder, "fixed-clock.json")));
  const receipt = containerReceipt(JSON.parse(await docker(["inspect", load]))[0]);
  validateLoadExecution({ load: receipt, summary, clock, start, end: Date.now(), seconds: 15 });
  assert.ok(clock.testRunDurationMs > 15000, "mock's in-flight requests should require real graceful completion");
  t.diagnostic(`measured mock only: count=${summary.metrics.http_reqs.count}, rate=${summary.metrics.http_reqs.rate}, engineMs=${clock.testRunDurationMs}, dockerMs=${Date.parse(receipt.state.FinishedAt) - Date.parse(receipt.state.StartedAt)}`);
});
