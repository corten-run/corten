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
  if (load.env) {
    const maximum = metrics.vus_max?.values ?? metrics.vus_max;
    assert.ok(maximum?.max <= (load.env.MODE === "fixed" ? 1000 : Number(load.env.VUS)), "k6 VUs exceed native scenario limit");
    const dropped = (metrics.dropped_iterations?.values ?? metrics.dropped_iterations)?.count ?? 0;
    if (load.env.MODE !== "fixed") assert.equal(dropped, 0, "closed VU scenario cannot drop scheduled iterations");
  }
}
