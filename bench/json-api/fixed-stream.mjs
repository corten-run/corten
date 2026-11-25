// Full stock k6 JSON output is the authority; reductions are replay results only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, fstatSync, openSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { isDeepStrictEqual } from "node:util";

export const streamLimits = Object.freeze({ bytes: 512 * 2 ** 20, lineBytes: 64 * 2 ** 10, events: 2_000_000, metrics: 128, chunkBytes: 64 * 2 ** 10 });
export const prototypeSchema = "json-api-fixed-prototype/v1";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sameKeys = (value, keys) => assert.ok(Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key)), "event fields differ");

// Parse the exact RFC3339 nanoseconds without passing them through a JS Date double.
export function timestampNs(value) {
  const match = typeof value === "string" && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  assert.ok(match, "RFC3339 nanosecond event timestamp required");
  const calendar = Date.parse(`${match[1]}Z`), ms = Date.parse(`${match[1]}${match[3]}`);
  assert.ok(Number.isFinite(ms) && Number.isFinite(calendar) && new Date(calendar).toISOString().slice(0, 19) === match[1], "invalid calendar timestamp");
  return BigInt(ms) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

function replay(limits) {
  for (const key of Object.keys(streamLimits)) assert.ok(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= streamLimits[key], "invalid stream cap");
  const hash = createHash("sha256"), metrics = new Map(), checks = {}, statusCounts = {}, httpStatusCounts = {};
  let bytes = 0, lines = 0, points = 0, pending = Buffer.alloc(0), first, last;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // A typed vector has a hard 16 MiB final maximum at the event cap. It is not retained
  // in the reduction. k6 TrendSink.P uses (n-1)*p with linear interpolation.
  let latencies, latencyCount = 0;
  const line = (buffer) => {
    assert.ok(buffer.length && buffer.length <= limits.lineBytes, "empty/oversize raw event line");
    assert.ok(++lines <= limits.events, "raw event count cap exceeded");
    const source = decoder.decode(buffer);
    let entry;
    try { entry = JSON.parse(source); }
    catch { throw new SyntaxError("invalid raw event JSON"); }
    assert.ok(object(entry), "invalid event"); sameKeys(entry, ["type", "metric", "data"]);
    assert.match(entry.metric, /^[a-zA-Z_][a-zA-Z_0-9]{0,127}$/);
    assert.ok(object(entry.data), "invalid event data");
    const data = entry.data;
    if (entry.type === "Metric") {
      sameKeys(data, ["name", "type", "contains", "thresholds", "submetrics"]);
      assert.equal(data.name, entry.metric, "metric name differs");
      assert.ok(["counter", "gauge", "rate", "trend"].includes(data.type), "unknown metric kind");
      assert.ok(["default", "time", "data"].includes(data.contains), "unknown metric value type");
      assert.ok(!metrics.has(entry.metric) && metrics.size < limits.metrics, "duplicate/excess metric definitions");
      metrics.set(entry.metric, { type: data.type, points: 0, sum: 0, min: null, max: null, true: 0, false: 0, firstNs: null, lastNs: null });
      return;
    }
    assert.ok(entry.type === "Point", "unknown raw output record");
    sameKeys(data, Object.hasOwn(data, "metadata") ? ["time", "value", "tags", "metadata"] : ["time", "value", "tags"]);
    assert.ok(object(data.tags) && Object.values(data.tags).every((v) => typeof v === "string"), "invalid point tags");
    if (Object.hasOwn(data, "metadata")) assert.ok(object(data.metadata) && Object.values(data.metadata).every((v) => typeof v === "string"), "invalid point metadata");
    const metric = metrics.get(entry.metric);
    assert.ok(metric, "point before metric definition");
    assert.ok(Number.isFinite(data.value), "non-finite point");
    if (metric.type === "counter") assert.ok(Number.isSafeInteger(data.value) && data.value >= 0, "invalid counter increment");
    if (["http_reqs", "iterations", "json_started", "dropped_iterations"].includes(entry.metric)) assert.equal(data.value, 1, "request/offer events must be unit counts");
    if (metric.type === "rate") assert.ok(data.value === 0 || data.value === 1, "invalid rate sample");
    const time = timestampNs(data.time); points++;
    if (entry.metric === "http_req_duration") {
      assert.ok(data.value >= 0, "negative raw latency");
      latencies ??= new Float64Array(Math.min(1024, limits.events));
      if (latencyCount === latencies.length) {
        const grown = new Float64Array(Math.min(limits.events, latencies.length * 2));
        grown.set(latencies); latencies = grown;
      }
      latencies[latencyCount++] = data.value;
    }
    metric.points++; metric.sum += data.value;
    assert.ok(Number.isFinite(metric.sum) && (metric.type !== "counter" || Number.isSafeInteger(metric.sum)), "metric sum overflow");
    metric.min = metric.min === null ? data.value : Math.min(metric.min, data.value);
    metric.max = metric.max === null ? data.value : Math.max(metric.max, data.value);
    metric.true += data.value === 1 ? 1 : 0; metric.false += data.value === 0 ? 1 : 0;
    metric.firstNs = metric.firstNs === null || time < metric.firstNs ? time : metric.firstNs;
    metric.lastNs = metric.lastNs === null || time > metric.lastNs ? time : metric.lastNs;
    first = first === undefined || time < first ? time : first; last = last === undefined || time > last ? time : last;
    if (entry.metric === "checks") {
      assert.ok(["JSON status 200", "JSON content type"].includes(data.tags.check), "unknown JSON check");
      const check = checks[data.tags.check] ??= { passes: 0, fails: 0 };
      check[data.value === 1 ? "passes" : "fails"]++;
    }
    if (entry.metric === "http_reqs") {
      assert.match(data.tags.status ?? "", /^\d{1,3}$/);
      const status = Number(data.tags.status), code = Number(data.tags.error_code ?? 0);
      assert.ok(status === 200 && code === 0 || status === 0 && code === 1050
        || (status === 429 || status >= 500 && status <= 599) && code === 1000 + status, "unclassified native HTTP status/transport code");
      httpStatusCounts[data.tags.status] = (httpStatusCounts[data.tags.status] ?? 0) + 1;
    }
    if (/^json_(ok|timeout|http_error|invalid)$/.test(entry.metric) && data.value) {
      assert.equal(data.value, 1, "classification must count individual responses");
      assert.match(data.tags.status ?? "", /^\d{1,3}$/); assert.match(data.tags.error_code ?? "", /^\d+$/);
      const status = Number(data.tags.status), code = Number(data.tags.error_code);
      if (entry.metric === "json_ok") assert.ok(status === 200 && code === 0, "success classification differs");
      if (entry.metric === "json_timeout") assert.ok(status === 0 && code === 1050, "timeout classification differs");
      if (entry.metric === "json_http_error") assert.ok((status === 429 || status >= 500 && status <= 599) && code === 1000 + status, "HTTP error classification differs");
      statusCounts[data.tags.status] = (statusCounts[data.tags.status] ?? 0) + 1;
    }
  };
  return { push(chunk) {
    bytes += chunk.length; assert.ok(bytes <= limits.bytes, "raw stream grew over byte cap"); hash.update(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset), part = chunk.subarray(offset, end < 0 ? chunk.length : end);
      assert.ok(pending.length + part.length <= limits.lineBytes, "raw event line cap exceeded");
      const joined = pending.length ? Buffer.concat([pending, part]) : part;
      if (end < 0) { pending = Buffer.from(joined); break; }
      line(joined); pending = Buffer.alloc(0); offset = end + 1;
    }
  }, finish(info, expected) {
  assert.equal(pending.length, 0, "raw output missing final newline/truncated event");
  assert.ok(points > 0 && bytes === info.size, "raw output empty/changed during replay");
  const receipt = { encoding: "identity", bytes, sha256: hash.digest("hex"), events: lines, points, metrics: metrics.size,
    firstNs: first.toString(), lastNs: last.toString() };
  if (expected) assert.ok(isDeepStrictEqual(receipt, expected), "full raw stream receipt differs");
  const sorted = latencies?.subarray(0, latencyCount).sort();
  const quantile = (p) => {
    if (!latencyCount) return null;
    const index = (latencyCount - 1) * p, lo = Math.floor(index), hi = Math.ceil(index);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
  };
  return { receipt, latency: { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) }, metrics: Object.fromEntries([...metrics].map(([name, value]) => [name, { ...value,
    firstNs: value.firstNs?.toString() ?? null, lastNs: value.lastNs?.toString() ?? null }])), checks, statusCounts, httpStatusCounts };
  } };
}

export function verifyStreamReceipt(receipt) {
  assert.ok(object(receipt), "complete raw stream receipt required");
  sameKeys(receipt, ["encoding", "bytes", "sha256", "events", "points", "metrics", "firstNs", "lastNs"]);
  assert.ok(receipt.encoding === "identity", "raw stream receipt encoding differs");
  for (const key of ["bytes", "events", "points", "metrics"])
    assert.ok(Number.isSafeInteger(receipt[key]) && receipt[key] > 0, "invalid raw stream receipt counts");
  assert.ok(typeof receipt.sha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.sha256), "raw stream receipt hash required");
  for (const key of ["firstNs", "lastNs"])
    assert.ok(typeof receipt[key] === "string" && /^\d+$/.test(receipt[key]), "raw stream receipt timestamps required");
  assert.ok(BigInt(receipt.firstNs) <= BigInt(receipt.lastNs), "raw stream receipt timestamps reversed");
}

export async function readFixedStream(file, expected, limits = streamLimits) {
  const parser = replay(limits), info = await stat(file);
  assert.ok(info.isFile() && info.size > 0 && info.size <= limits.bytes, "raw stream empty/over byte cap");
  for await (const chunk of createReadStream(file, { highWaterMark: limits.chunkBytes })) parser.push(chunk);
  return parser.finish(info, expected);
}

export function readFixedStreamSync(file, expected, limits = streamLimits) {
  const parser = replay(limits), fd = openSync(file, "r");
  try {
    const info = fstatSync(fd);
    assert.ok(info.isFile() && info.size > 0 && info.size <= limits.bytes, "raw stream empty/over byte cap");
    const buffer = Buffer.alloc(limits.chunkBytes); let length;
    while ((length = readSync(fd, buffer, 0, buffer.length, null))) parser.push(buffer.subarray(0, length));
    return parser.finish(info, expected);
  } finally { closeSync(fd); }
}
