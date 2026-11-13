import assert from "node:assert/strict";
import { memoryMiB } from "../catalog/stats.mjs";

export const resourceCoveragePolicy = Object.freeze({ targetIntervalMs: 500, maximumGapMs: 1500,
  maximumBoundaryGapMs: 1500, maximumClockDriftMs: 100 });

export function coveredSamples(samples, window) {
  const { startedUnixMs: start, finishedUnixMs: end, elapsedMs } = window;
  assert.ok([start, end].every(Number.isSafeInteger) && end > start
    && Math.abs(end - start - elapsedMs) <= resourceCoveragePolicy.maximumClockDriftMs, "resource coverage: invalid window clock boundaries");
  assert.ok(samples?.length >= 2 && samples.every((s, i) => Number.isFinite(s.t)
    && Number.isFinite(s.cpu) && Number.isFinite(s.mem) && s.cpu >= 0 && s.mem >= 0
    && (!i || s.t >= samples[i - 1].t)), "resource coverage: missing/unordered samples");
  let first = samples.findLastIndex((s) => s.t <= start), last = samples.findIndex((s) => s.t >= end);
  assert.ok(first >= 0 && last > first, "resource coverage: samples do not bracket the whole window");
  while (first > 0 && samples[first - 1].t === samples[first].t) first--;
  while (last + 1 < samples.length && samples[last + 1].t === samples[last].t) last++;
  const selected = samples.slice(first, last + 1), leadingMs = start - selected[0].t, trailingMs = selected.at(-1).t - end;
  const maximumGapMs = Math.max(...selected.slice(1).map((s, i) => s.t - selected[i].t));
  assert.ok(leadingMs <= resourceCoveragePolicy.maximumBoundaryGapMs && trailingMs <= resourceCoveragePolicy.maximumBoundaryGapMs
    && maximumGapMs <= resourceCoveragePolicy.maximumGapMs, "resource coverage: boundary or sampling gap exceeds policy");
  return { selected, leadingMs, trailingMs, maximumGapMs };
}

// Use real Docker reads for the two boundary receipts; the shared streaming
// sampler still supplies the intervening samples. No interpolated samples.
export async function resourceBoundary(docker, names) {
  const startedUnixMs = Date.now();
  const raw = await docker(["stats", "--no-stream", "--format", "{{json .}}", ...names], { timeout: 10000 });
  const receivedUnixMs = Date.now(), samples = {};
  for (const line of raw.trim().split(/\r?\n/)) {
    const row = JSON.parse(line);
    assert.ok(names.includes(row.Name) && !Object.hasOwn(samples, row.Name), "unexpected/duplicate resource boundary participant");
    const sample = { t: receivedUnixMs, cpu: parseFloat(row.CPUPerc), mem: memoryMiB(row.MemUsage.split("/")[0]) };
    assert.ok(Number.isFinite(sample.cpu) && Number.isFinite(sample.mem), "invalid resource boundary receipt");
    samples[row.Name] = [sample];
  }
  assert.deepEqual(Object.keys(samples).sort(), [...names].sort(), "missing resource boundary participant");
  return { startedUnixMs, receivedUnixMs, raw, samples };
}
