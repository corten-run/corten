import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Keep the legacy metric export and the engine's own denominator, not a duration
// inferred from those metrics or the configured scenario duration.
export async function retainLoadEvidence(docker, container, folder, phase) {
  for (const [remote, local] of [["summary", `${phase}.json`], ["clock", `${phase}-clock.json`]]) {
    await docker(["cp", `${container}:/tmp/marketplace-${remote}.json`, join(folder, local)]);
  }
  return JSON.parse(readFileSync(join(folder, `${phase}.json`), "utf8"));
}

export function validateLoadExecution({ load, summary, clock, start, end, seconds }) {
  assert.equal(load.state.Running, false); assert.equal(load.state.OOMKilled, false); assert.equal(load.state.ExitCode, 0);
  const began = Date.parse(load.state.StartedAt), finished = Date.parse(load.state.FinishedAt);
  assert.ok(began >= start && finished <= end && finished >= began, "k6 execution outside phase window");
  assert.deepEqual(Object.keys(clock), ["testRunDurationMs"]);
  const elapsed = clock.testRunDurationMs;
  // Date.parse truncates Docker's sub-ms timestamps. The engine clock includes
  // graceful completion, but excludes Docker startup/teardown. Never use the
  // configured duration as the counter rate's denominator.
  assert.ok(Number.isFinite(elapsed) && elapsed >= seconds * 1000 - 1e-6 && elapsed <= finished - began + 2, "k6 engine duration truncated/outside container window");
  const metrics = summary.metrics;
  const requests = metrics?.http_reqs?.values ?? metrics?.http_reqs;
  assert.ok(requests?.count > 0, "invalid k6 request counter/rate");
  // Both exports use k6 TestRunDuration. Only float64 division/JSON rounding
  // differs, not scheduling jitter (which is already in the engine clock).
  for (const [name, raw] of Object.entries(metrics)) {
    const counter = raw?.values ?? raw;
    if (counter?.count === undefined) {
      assert.ok(raw?.type !== "counter" && !["http_reqs", "iterations", "dropped_iterations", "data_sent", "data_received"].includes(name), `missing k6 ${name} counter`);
      continue;
    }
    assert.ok(Number.isSafeInteger(counter.count) && counter.count >= 0 && Number.isFinite(counter.rate) && counter.rate >= 0, `invalid k6 ${name} counter/rate`);
    const expected = counter.count / (elapsed / 1000);
    assert.ok(Math.abs(counter.rate - expected) <= Math.max(expected, counter.rate) * 1e-12, `k6 ${name} count/rate differs from engine elapsed clock`);
  }
  const metric = (name) => metrics[name]?.values ?? metrics[name];
  const maximum = metric("vus_max"), iterations = metric("iterations");
  for (const name of Object.keys(metrics).filter((n) => n === "iteration_duration" || n.startsWith("http_req_") && n !== "http_req_failed")) {
    const trend = metric(name);
    // Durations are measured within engine execution, including graceful stop.
    assert.ok(Number.isFinite(trend?.max) && trend.max <= elapsed + Math.max(1e-6, elapsed * 1e-12), `k6 ${name} latency exceeds engine elapsed`);
    if (maximum && !name.includes("{")) {
      const count = name === "iteration_duration" ? iterations?.count : requests.count;
      assert.ok(Number.isFinite(trend.avg) && count * trend.avg <= maximum.max * elapsed * (1 + 1e-12), `k6 ${name} duration work exceeds VU execution capacity`);
    }
  }
  if (metric("http_req_duration") && metric("iteration_duration") && iterations) {
    const http = metric("http_req_duration"), iteration = metric("iteration_duration");
    const unfinished = requests.count - iterations.count;
    assert.ok(http.avg * requests.count <= (iteration.avg * iterations.count + unfinished * http.max) * (1 + 1e-12), "HTTP duration work exceeds completed/unfinished iteration work");
    if (unfinished === 0) assert.ok(http.max <= iteration.max + Math.max(1e-6, iteration.max * 1e-12), "HTTP maximum exceeds completed iteration maximum");
  }
  if (load.env) {
    assert.ok(maximum?.max <= (load.env.MODE === "fixed" ? 1000 : Number(load.env.VUS)), "k6 VUs exceed native scenario limit");
    const dropped = metric("dropped_iterations")?.count ?? 0;
    if (load.env.MODE !== "fixed") assert.equal(dropped, 0, "closed VU scenario cannot drop scheduled iterations");
    else {
      // The executor truncates 1s/rate to whole nanoseconds, starts at slot 0,
      // and cannot schedule beyond the engine's total elapsed window. Using
      // that wider window (not just the configured duration) allows real jitter.
      const tick = Math.floor(1e9 / Number(load.env.RATE));
      assert.ok(Number.isSafeInteger(tick) && tick > 0, "invalid native arrival-rate tick");
      const slots = Math.floor(Math.ceil(elapsed * 1e6 + 1) / tick) + 1;
      assert.ok(Number.isSafeInteger(requests.count + dropped) && requests.count + dropped <= slots, "k6 requests/drops exceed execution schedule capacity");
    }
  }
}
