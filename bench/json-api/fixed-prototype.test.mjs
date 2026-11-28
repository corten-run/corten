import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { classify } from "./load-outcome.js";
import { fixedFixture } from "./fixed-test-fixtures.mjs";
import { prototypeSchema, readFixedStream, streamLimits, timestampNs } from "./fixed-stream.mjs";
import { joinFixedPrototype, prototypeLimits, verifyFixedPrototype, verifyPrototypeLogs } from "./fixed-prototype.mjs";
import { probeFixture } from "./fixed-probe.mjs";
import { inspectJson } from "./report.mjs";
import { fixedPrototypeArgv } from "./fixed-identity.mjs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function files(t) {
  const folder = mkdtempSync(join(tmpdir(), "json-fixed-stream-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  return { folder, file: join(folder, "events.jsonl") };
}
async function replay(file, f) { writeFileSync(file, f.bytes()); return joinFixedPrototype(f, await readFixedStream(file)); }

test("JSON classifications exhaust 200 JSON, timeout1050, 429 and 5xx; everything else invalid", () => {
  const response = (status, error_code = status >= 400 ? 1000 + status : 0, type = "application/json") => ({ status, error_code, headers: { "Content-Type": type } });
  assert.equal(classify(response(200)), "ok"); assert.equal(classify(response(200, 0, "Application/JSON; charset=utf-8")), "ok");
  assert.equal(classify(response(0, 1050)), "timeout"); assert.equal(classify(response(429)), "http_error");
  for (let status = 500; status <= 599; status++) assert.equal(classify(response(status)), "http_error");
  for (const r of [response(200, 0, "text/html"), response(200, 1050), response(503, 1050), response(201), response(204), response(302), response(404), response(499), response(600), response(0, 1212), response(503.5)])
    assert.equal(classify(r), "invalid");
});

test("full raw bytes/hash/events survive streaming; success and classified99 stay explicitly unqualified", async (t) => {
  const { file } = files(t);
  for (const responses of [["ok", "ok", "ok"], ["ok", "http429", "http503"], ["ok", "timeout", "http503"]]) {
    const f = fixedFixture({ responses }); writeFileSync(file, f.bytes());
    const stream = await readFixedStream(file), report = joinFixedPrototype(f, stream);
    assert.equal(stream.receipt.sha256, hash(f.bytes())); assert.equal(stream.receipt.bytes, f.bytes().length);
    assert.equal(stream.receipt.events, f.entries.length);
    assert.equal(report.loadOutcome, responses.every((r) => r === "ok") ? "passed" : "threshold-failed");
    assert.equal(report.attemptComplete, false); assert.equal(report.targetOutcome, null); assert.equal(report.comparisonEligible, null);
    assert.equal(report.scheduling.qualified, false); assert.equal(report.status, "unqualified");
    await readFixedStream(file, stream.receipt, { ...streamLimits, chunkBytes: 7 });
    await assert.rejects(readFixedStream(file, { ...stream.receipt, bytes: stream.receipt.bytes + 1 }), /receipt differs/);
  }
});

test("tail drops are retained but their wall timestamp never becomes a monotonic scheduling proof", async (t) => {
  const { file } = files(t), f = fixedFixture({ responses: ["ok", "ok"], drops: 1 });
  const report = await replay(file, f);
  assert.equal(report.offered, 3); assert.equal(report.dropped, 1); assert.equal(report.loadOutcome, "threshold-failed");
  assert.equal(typeof report.scheduling.dropWallUpperNs, "string"); assert.equal(report.scheduling.qualified, false);
  assert.equal(report.targetOutcome, null); assert.equal(report.attemptComplete, false);
});

test("nominal+one and later source-permitted starts are retained, not rejected by a zero-nanosecond endpoint gate", async (t) => {
  const { file } = files(t);
  for (const count of [4, 5]) {
    const report = await replay(file, fixedFixture({ responses: Array(count).fill("ok") }));
    assert.equal(report.requests, count); assert.equal(report.loadOutcome, "passed");
    assert.equal(report.scheduling.endpointContainedByStartObservations, false);
    assert.equal(report.attemptComplete, false); assert.equal(report.scheduling.qualified, false);
  }
});

test("parent probe defaults to ordinary healthy JSON; optional hostile fixture counts stay separate", async () => {
  for (const mode of ["healthy", "mixed"]) {
    const { server, counts } = probeFixture(mode);
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const status of mode === "healthy" ? [200, 200, 200] : [200, 429, 503]) {
        const response = await fetch(`${base}/api/catalog/record_1`); await response.arrayBuffer(); assert.equal(response.status, status);
      }
      assert.equal(counts.requests, 3);
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }
});

test("request/rate/check/iteration/drop/exit/clock/classification corruption stays invalid", async (t) => {
  const { file } = files(t), good = fixedFixture({ responses: ["ok", "http429", "http503"] });
  writeFileSync(file, good.bytes()); const stream = await readFixedStream(file);
  for (const [name, mutate] of [
    ["request count", (f) => f.summary.metrics.http_reqs.count++],
    ["rate", (f) => f.summary.metrics.http_reqs.rate++],
    ["iteration", (f) => f.summary.metrics.iterations.count--],
    ["classification", (f) => f.summary.metrics.json_http_error.count--],
    ["drops", (f) => f.summary.metrics.dropped_iterations.count++],
    ["check", (f) => f.summary.root_group.checks["JSON status 200"].passes++],
    ["total checks", (f) => f.summary.metrics.checks.fails--],
    ["failure count", (f) => f.summary.metrics.http_req_failed.passes--],
    ["success exit0", (f) => f.command.exit.code = 0],
    ["expired", (f) => f.command.exit.expired = true],
    ["signal", (f) => f.command.exit.signal = "SIGTERM"],
    ["interrupted", (f) => f.command.exit.interrupted = true],
    ["I/O", (f) => f.command.ioErrors.push("write failure")],
    ["warmup", (f) => f.config.phase = "warmup"],
    ["underload floor", (f) => f.config.rate = 4],
    ["completion", (f) => f.clock.k6DurationMs = 999],
    ["host clock", (f) => f.command.clock.finishedAt-- && (f.command.clock.startedAt = f.command.clock.finishedAt - 5)],
    ["gauge", (f) => f.clock.metrics.json_start_progress_ns.values.max++],
    ["threshold", (f) => f.summary.metrics.http_req_failed.thresholds["rate==0"] = false],
  ]) { const { bytes, ...data } = good; const f = structuredClone(data); mutate(f); assert.throws(() => joinFixedPrototype(f, stream), undefined, name); }
  await assert.rejects(replay(file, fixedFixture({ responses: ["ok", "ok", "invalid"] })), /unclassified|HTTP error|threshold/);
  await assert.rejects(replay(file, fixedFixture({ responses: ["ok", "ok"] })), /below offered-load floor/);
});

test("extra work needs observed starts, not a guessed nominal+N or completion grace", async (t) => {
  const { file } = files(t), f = fixedFixture();
  for (const entry of f.entries) if (entry.type === "Point" && entry.metric === "json_start_after_ms") entry.data.value = 5.000002;
  f.clock.metrics.json_start_after_ms.values.min = 5.000002; f.clock.metrics.json_start_after_ms.values.max = 5.000002;
  await assert.rejects(replay(file, f), /start instance clocks|extra work/);
});

test("bounded replay rejects line/total/event/metric caps, truncation, invalid UTF8 and gzip without decompression", async (t) => {
  const { file } = files(t), f = fixedFixture(), bytes = f.bytes(); writeFileSync(file, bytes);
  for (const limits of [{ lineBytes: 20 }, { bytes: bytes.length - 1 }, { events: 5 }, { metrics: 1 }])
    await assert.rejects(readFixedStream(file, undefined, { ...streamLimits, ...limits }));
  for (const bad of [bytes.subarray(0, -1), Buffer.from([0xff, 10]), Buffer.from([0x1f, 0x8b, 8, 0, 10]), Buffer.from("{}\n"), Buffer.concat([bytes, Buffer.from("\n")])]) {
    writeFileSync(file, bad); await assert.rejects(readFixedStream(file));
  }
  assert.equal(timestampNs("2026-11-17T00:00:00.123456789Z") % 1_000_000_000n, 123456789n);
  assert.equal(timestampNs("2026-11-17T01:00:00.123456789+01:00"), timestampNs("2026-11-17T00:00:00.123456789Z"));
  for (const time of ["2026-02-30T00:00:00Z", "2026-11-17T00:00:00.1234567891Z", "2026-11-17T00:00:00+25:00"]) assert.throws(() => timestampNs(time));
});

test("normal threshold log is not a waiver for output/marshal/write faults", () => {
  const log = (msg) => JSON.stringify({ level: "error", msg }) + "\n";
  verifyPrototypeLogs(log("thresholds on metrics 'checks, http_req_failed' have been crossed"), 99);
  const timeoutLog = JSON.stringify({ level: "warning", msg: "Request Failed", error: "request timeout" }) + "\n";
  verifyPrototypeLogs(timeoutLog, 99, { timeouts: 1 }); assert.throws(() => verifyPrototypeLogs(timeoutLog, 99));
  for (const msg of ["Sample(s) couldn't be marshalled to JSON", "write /dev/stdout: broken pipe", "thresholds on metrics 'unreviewed' have been crossed"])
    assert.throws(() => verifyPrototypeLogs(log(msg), 99));
  assert.throws(() => verifyPrototypeLogs(log("thresholds on metrics 'checks' have been crossed"), 0));
});

const k6Log = (record) => JSON.stringify(record) + "\n";
const timeoutWarning = (error, fields = {}) => k6Log({ level: "warning", msg: "Request Failed", error, ...fields });
const wrappedTimeout = 'Get "http://127.0.0.1:8080/api/catalog/record_1": request timeout';

test("Go-wrapped timeout warnings replay against five counted timeouts, no drops and exit 99", async (t) => {
  const { file } = files(t), f = fixedFixture({ responses: Array(5).fill("timeout") });
  const warnings = timeoutWarning(wrappedTimeout).repeat(5);
  const threshold = k6Log({ level: "error", msg: "thresholds on metrics 'checks, http_req_failed' have been crossed" });
  f.logs = warnings + threshold;
  const report = await replay(file, f);
  assert.equal(f.command.exit.code, 99); assert.equal(report.dropped, 0);
  assert.equal(report.counts.timeout, 5); assert.equal(report.loadOutcome, "threshold-failed");
  assert.equal(report.status, "unqualified");

  const stream = await readFixedStream(file);
  assert.throws(() => joinFixedPrototype({ ...f, logs: timeoutWarning(wrappedTimeout) + f.logs }, stream),
    { message: "timeout warnings exceed observed timeout responses" });
  assert.throws(() => joinFixedPrototype({ ...f, command: { ...f.command, exit: { ...f.command.exit, code: 0 } } }, stream),
    { message: /^threshold\/normal exit mismatch\b/ });
  assert.throws(() => joinFixedPrototype(f, { ...stream, httpStatusCounts: {} }), { message: "native HTTP/classified status inventory differs" });
  const summary = structuredClone(f.summary);
  summary.metrics.http_req_failed.thresholds["rate==0"] = false;
  assert.throws(() => joinFixedPrototype({ ...f, summary }, stream), { message: "threshold evidence differs" });
});

test("bare and wrapped request timeouts share the same upper bound", () => {
  const logs = timeoutWarning("request timeout") + timeoutWarning('Get "https://[::1]:8080/api/marketplace/item_7": request timeout');
  verifyPrototypeLogs(logs, 99, { timeouts: 2 });
  verifyPrototypeLogs(logs, 99, { timeouts: 3 });
  assert.throws(() => verifyPrototypeLogs(logs, 99, { timeouts: 1, dropped: 5 }),
    { message: "timeout warnings exceed observed timeout responses" });
});

test("wrapped timeouts reject unexpected errors and malformed warnings without echoing targets", () => {
  const url = "http://private-target.invalid/path";
  for (const error of [
    'Post "' + url + '": request timeout',
    'Get "' + url + '": dial tcp: request timeout',
    'Get "' + url + '": request timeout while connecting',
    'Get "' + url + '": request timeout\n',
    "Get " + url + ": request timeout",
    'Get "' + url + '":  request timeout',
    'Get "' + url + '/with space": request timeout',
    'Get "' + url + '/%ZZ": request timeout',
    'Get "' + url + '/"extra": request timeout',
    'Get "http:///private-target.invalid/path": request timeout',
    'Get "http://private-target.invalid:99999/path": request timeout',
    'Get "ftp://private-target.invalid/path": request timeout',
    'Get "private-target.invalid/path": request timeout',
    'Get "": request timeout',
    { message: 'Get "' + url + '": request timeout' },
    null, undefined, 1050,
  ]) assert.throws(() => verifyPrototypeLogs(timeoutWarning(error), 99, { timeouts: 1, dropped: 1 }),
    { message: "unclassified k6 warning" });
  assert.throws(() => verifyPrototypeLogs(timeoutWarning(wrappedTimeout, { msg: "Other warning" }), 99, { timeouts: 1 }),
    { message: "unclassified k6 warning" });
  assert.throws(() => verifyPrototypeLogs(timeoutWarning(wrappedTimeout, { level: "error" }), 99, { timeouts: 1 }),
    { message: "k6 output/marshal/write/runtime error" });
  assert.throws(() => verifyPrototypeLogs(url + "\n", 99), { message: "malformed k6 log record" });
});

test("portable replay requires full raw plus exact independent summary/clock/log hashes", async (t) => {
  assert.throws(() => inspectJson({ schema: prototypeSchema }, { load: () => {} }), /not a json-api result schema/);
  const { file, folder } = files(t), f = fixedFixture(); writeFileSync(file, f.bytes());
  writeFileSync(join(folder, "summary.json"), JSON.stringify(f.summary)); writeFileSync(join(folder, "clock.json"), JSON.stringify(f.clock)); writeFileSync(join(folder, "stderr.jsonl"), "");
  const capture = { schema: prototypeSchema, config: f.config, command: f.command, errors: [], limits: prototypeLimits,
    instrumentation: { output: "stock-json-stdout", script: "fixed-prototype-load.js", changedGeneratorIO: true, gzip: false, nativeQualified: false },
    raw: (await readFixedStream(file)).receipt, files: Object.fromEntries(["summary.json", "clock.json", "stderr.jsonl"].map((name) => {
      const bytes = readFileSync(join(folder, name)); return [name, { bytes: bytes.length, sha256: hash(bytes) }];
    })) };
  const here = dirname(fileURLToPath(import.meta.url));
  capture.config = { ...capture.config, payload: "catalog-v1", base: "http://127.0.0.1:8080" };
  capture.executable = { path: "/synthetic/k6", sha256: "a".repeat(64), version: "k6 v2.4.0 (synthetic; not native qualification)" };
  capture.sources = Object.fromEntries(["fixed-prototype-load.js", "load.js", "load-outcome.js"].map((name) => [name, hash(readFileSync(join(here, name)))]));
  capture.argv = fixedPrototypeArgv(capture.config, join(folder, "summary.json"), join(here, "fixed-prototype-load.js"), folder);
  capture.command.stdoutBytes = f.bytes().length; capture.command.stderrBytes = 0;
  writeFileSync(join(folder, "capture.json"), JSON.stringify(capture));
  assert.equal((await verifyFixedPrototype(folder)).status, "unqualified");
  writeFileSync(join(folder, "summary.json"), JSON.stringify({ ...f.summary, forged: true }));
  await assert.rejects(verifyFixedPrototype(folder), /length\/hash differs/);
  writeFileSync(join(folder, "summary.json"), JSON.stringify(f.summary));
  const changed = Buffer.from(f.bytes()); changed[20] ^= 1; writeFileSync(file, changed);
  await assert.rejects(verifyFixedPrototype(folder));
});
