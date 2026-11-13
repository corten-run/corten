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
import { readLoadSummary, readOutcome } from "./run-contract.mjs";

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
    const counter = (count) => ({ count, rate: count / (nanoseconds / 1e9) });
    const legacy = { metrics: { http_reqs: counter(count), iterations: counter(count - 1), dropped_iterations: counter(0), data_received: counter(12345), data_sent: counter(6789) } };
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
    for (const name of ["iterations", "dropped_iterations", "data_received", "data_sent"]) {
      const original = summary.metrics[name];
      for (const bad of [{ ...original, rate: 1e9 }, { ...original, count: -1 }, { rate: original.rate }]) {
        summary.metrics[name] = bad; assert.throws(() => validateLoadExecution(evidence), /counter|count\/rate/, name);
      }
      summary.metrics[name] = original;
    }
    for (const bad of [14997, elapsed + 2000, "15000", null, Infinity]) assert.throws(() => validateLoadExecution({ ...evidence, clock: { testRunDurationMs: bad } }));
    assert.throws(() => validateLoadExecution({ ...evidence, clock: {} }));
  }
  await assert.rejects(retainLoadEvidence(async (args) => { if (args[1].includes("clock")) throw new Error("missing raw clock"); }, "native-k6", folder, "fixed"), /missing raw clock/);
});

// Opt-in local producer integration, never part of offline saved validation.
test("execution bounds conserve arrival slots and latency work without rejecting valid drops or cutoff work", () => {
  const elapsed = 15137.123456, counter = (count) => ({ count, rate: count / (elapsed / 1000) });
  const original = {
    load: { env: { MODE: "fixed", RATE: "150", VUS: "64" }, state: { Running: false, OOMKilled: false, ExitCode: 0,
      StartedAt: "2026-01-01T00:00:00.100Z", FinishedAt: "2026-01-01T00:00:16Z" } },
    summary: { metrics: { http_reqs: counter(2250), iterations: counter(2250), vus_max: { max: 200 },
      http_req_duration: { avg: 1, max: 4 }, iteration_duration: { avg: 1, max: 4 } } },
    clock: { testRunDurationMs: elapsed }, start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-01-01T00:00:17Z"), seconds: 15,
  };
  validateLoadExecution(original);
  for (const edit of [
    (v) => { v.summary.metrics.dropped_iterations = counter(1e9); },
    (v) => { v.summary.metrics.http_reqs = counter(1e9); v.summary.metrics.iterations = counter(1e9); },
    (v) => { v.summary.metrics.http_req_duration.max = 1e9; },
    (v) => { v.summary.metrics.iteration_duration.max = 1e9; },
    (v) => { v.summary.metrics.http_req_waiting = { avg: 1, max: 1e9 }; },
    (v) => { v.summary.metrics["http_req_duration{expected_response:true}"] = { avg: 1, max: 1e9 }; },
    (v) => { v.summary.metrics.http_req_duration = { avg: 2000, max: 2000 }; },
    (v) => { v.summary.metrics.iteration_duration = { avg: 2000, max: 2000 }; },
    (v) => { v.summary.metrics.http_req_duration.avg = 2; },
    (v) => { v.summary.metrics.http_req_duration.max = 5; },
  ]) { const v = structuredClone(original); edit(v); assert.throws(() => validateLoadExecution(v), /capacity|elapsed|iteration/); }
  const capacity = structuredClone(original);
  capacity.summary.metrics.http_reqs = counter(1500); capacity.summary.metrics.iterations = counter(1500);
  capacity.summary.metrics.dropped_iterations = counter(750); validateLoadExecution(capacity);
  const cutoff = structuredClone(original);
  cutoff.summary.metrics.iterations = counter(2249); cutoff.summary.metrics.http_req_duration.avg = 1.001;
  validateLoadExecution(cutoff);
  // Boundary slots use the executor's integer-nanosecond tick, not an arbitrary
  // percentage, and allow slot zero plus 1 ns clock conversion rounding.
  const tick = Math.floor(1e9 / 150), slots = Math.floor(Math.ceil(elapsed * 1e6 + 1) / tick) + 1;
  const edge = structuredClone(original); edge.summary.metrics.dropped_iterations = counter(slots - 2250);
  validateLoadExecution(edge); edge.summary.metrics.dropped_iterations = counter(slots - 2249);
  assert.throws(() => validateLoadExecution(edge), /schedule capacity/);
});

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
    "require('http').createServer((q,r)=>setTimeout(()=>{r.statusCode=q.url.startsWith('/marketplace/fr-FR/')?503:200;r.setHeader('Content-Type','text/html');r.end('<html>mock</html>')},200)).listen(8080,'127.0.0.1')"]);
  await docker(["start", mock]);
  await docker(["exec", mock, "node", "-e", "fetch('http://127.0.0.1:8080').then(r=>{if(!r.ok)process.exit(1)})"]);
  for (const [phase, locale] of [["served", "en-US"], ["failed", "fr-FR"]]) {
    const start = Date.now();
    const load = await create(`${prefix}-k6-${phase}`, ["--network", `container:${mock}`, "--cpus", "4", "--memory", "2g", "-v", `${resolve("bench")}:/bench:ro`,
      ...Object.entries({ TARGET: "page", MODE: "fixed", BASE: "http://127.0.0.1:8080", LOCALE: locale, RATE: "150", VUS: "64", DURATION: "15s" }).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      k6Image, "run", "--quiet", "--summary-export", "/tmp/marketplace-summary.json", "/bench/marketplace/load.js"]);
    await docker(["start", "-a", load]);
    const summary = await retainLoadEvidence(docker, load, folder, phase);
    const clock = JSON.parse(readFileSync(join(folder, `${phase}-clock.json`)));
    const receipt = containerReceipt(JSON.parse(await docker(["inspect", load]))[0]);
    validateLoadExecution({ load: receipt, summary, clock, start, end: Date.now(), seconds: 15 });
    const traffic = readLoadSummary(summary);
    assert.equal(traffic.failed, phase === "failed" ? traffic.requests : 0);
    if (phase === "failed") assert.throws(() => readOutcome(summary), /no request succeeded/);
    else assert.equal(readOutcome(summary).failed, 0);
    assert.ok(clock.testRunDurationMs > 15000, "mock's in-flight requests should require real graceful completion");
    t.diagnostic(`measured ${phase} mock only: count=${summary.metrics.http_reqs.count}, iterations=${summary.metrics.iterations.count}, VUsMax=${summary.metrics.vus_max.max}, failureSamples=${JSON.stringify(summary.metrics.http_req_failed)}, checkSamples=${JSON.stringify(summary.metrics.checks)}, rate=${summary.metrics.http_reqs.rate}, engineMs=${clock.testRunDurationMs}, dockerMs=${Date.parse(receipt.state.FinishedAt) - Date.parse(receipt.state.StartedAt)}`);
  }
});
