// Stock-k6 instrumentation experiment, deliberately NOT a matrix/native qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { commands } from "./process.mjs";
import { k6Version } from "../load-tool.mjs";
import { prototypeSchema, readFixedStream, streamLimits, verifyStreamReceipt } from "./fixed-stream.mjs";
import { fixedPrototypeArgv, verifyExperimentIdentity } from "./fixed-identity.mjs";

export const prototypeLimits = Object.freeze({ ...streamLimits, logBytes: 4 * 2 ** 20, summaryBytes: 2 * 2 ** 20, clockBytes: 2 * 2 ** 20 });
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const metric = (s, key) => s.metrics?.[key]?.values ?? s.metrics?.[key];
const same = (a, b, message) => assert.ok(isDeepStrictEqual(a, b), message);
const close = (a, b, message) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9), message);
const readBounded = (file, cap) => {
  const fd = openSync(file, "r");
  try {
    const info = fstatSync(fd); assert.ok(info.isFile() && info.size <= cap, "artifact over cap/not a file");
    const buffer = Buffer.alloc(info.size + 1); let length = 0, n;
    while (length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null))) length += n;
    assert.equal(length, info.size, "artifact changed during bounded read"); return buffer.subarray(0, length);
  } finally { closeSync(fd); }
};
const json = (file, cap) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readBounded(file, cap)));
function isRequestTimeout(error) {
  if (error === "request timeout") return true;
  if (typeof error !== "string") return false;
  // Go's URL error wraps the same timeout; do not retain or echo the target.
  const wrapped = /^Get "(https?:\/\/(?![/?#])[^"\\\s\x00-\x1f\x7f]+)": request timeout$/.exec(error);
  return wrapped !== null && !/%(?![0-9a-f]{2})/i.test(wrapped[1]) && URL.canParse(wrapped[1]);
}
export function verifyPrototypeLogs(text, exitCode, { timeouts = 0, dropped = 0 } = {}) {
  assert.ok(Buffer.byteLength(text) <= prototypeLimits.logBytes, "log byte cap exceeded");
  let thresholds = 0, timeoutWarnings = 0;
  for (const line of text.split("\n")) if (line) {
    assert.ok(Buffer.byteLength(line) <= streamLimits.lineBytes, "log line over cap");
    let entry;
    try { entry = JSON.parse(line); }
    catch { throw new Error("malformed k6 log record"); }
    assert.ok(typeof entry?.msg === "string" && ["debug", "info", "warning", "error"].includes(entry.level), "unknown k6 log record");
    if (entry.level === "error") {
      assert.ok(exitCode === 99 && /^thresholds on metrics '(?:checks|http_req_failed|dropped_iterations)(?:, (?:checks|http_req_failed|dropped_iterations))*' have been crossed$/.test(entry.msg),
        "k6 output/marshal/write/runtime error");
      thresholds++;
    }
    if (entry.level === "warning") {
      if (entry.msg === "Request Failed" && isRequestTimeout(entry.error)) timeoutWarnings++;
      else assert.ok(dropped > 0 && /^Insufficient VUs, reached \d+ active VUs and cannot initialize more$/.test(entry.msg), "unclassified k6 warning");
    }
  }
  assert.ok(thresholds <= 1, "duplicate threshold terminal errors");
  assert.ok(timeoutWarnings <= timeouts, "timeout warnings exceed observed timeout responses");
}

export function joinFixedPrototype({ summary, clock, command, config, logs }, stream) {
  assert.ok(config?.phase === "fixed" && count(config.seconds) && config.seconds >= 1 && config.seconds <= 300
    && count(config.rate) && config.rate >= 1 && config.rate <= 10000, "fixed configuration required");
  const duration = clock?.k6DurationMs, errors = command?.ioErrors;
  assert.equal(clock?.schema, "json-api-fixed-clock/v1"); same(errors, [], "command I/O fault");
  assert.ok(command.exit?.code === 0 || command.exit?.code === 99, "normal native exit0/99 required");
  same(command.exit, { code: command.exit.code, signal: null, expired: false, interrupted: false }, "abnormal native exit");
  const { startedAt: start, finishedAt: end } = command.clock ?? {};
  assert.ok(count(start) && start > 0 && count(end) && end > start, "invalid host command clock");
  assert.ok(Number.isFinite(duration) && duration >= config.seconds * 1000 && duration <= (config.seconds + 10) * 1000,
    "configured duration/drain incomplete");
  assert.ok(end - start + 1 >= duration && end - start <= duration + 10000, "host/k6 clocks disagree");
  assert.ok(BigInt(stream.receipt.firstNs) >= BigInt(start) * 1_000_000n
    && BigInt(stream.receipt.lastNs) < BigInt(end + 1) * 1_000_000n, "point outside host command clock");
  const raw = (name, type) => { const v = stream.metrics[name]; assert.equal(v?.type, type, `raw ${name} kind/missing`); return v; };
  const counter = (name) => {
    const value = raw(name, "counter").sum;
    assert.ok(count(value), `invalid ${name}`); assert.equal(metric(summary, name)?.count, value, `${name} summary/stream differ`);
    close(metric(summary, name)?.rate, value * 1000 / duration, `${name} rate/clock differ`); return value;
  };
  const requests = counter("http_reqs"), iterations = counter("iterations"), started = counter("json_started");
  assert.ok(requests > 0); assert.equal(started, requests, "unfinished started requests"); assert.equal(iterations, requests, "unfinished iterations");
  for (const name of ["http_reqs", "iterations", "json_started"]) assert.equal(raw(name, "counter").points, requests, "non-unit/missing request events");
  const outcomes = Object.fromEntries(["ok", "timeout", "http_error", "invalid"].map((name) => [name, counter(`json_${name}`)]));
  assert.equal(outcomes.invalid, 0, "unclassified/corrupt/redirect response");
  assert.equal(Object.values(outcomes).reduce((a, b) => a + b, 0), requests, "classification coverage differs");
  same(stream.statusCounts, stream.httpStatusCounts, "native HTTP/classified status inventory differs");
  const failed = outcomes.timeout + outcomes.http_error, httpFailed = raw("http_req_failed", "rate");
  assert.equal(httpFailed.points, requests); assert.equal(httpFailed.sum, failed, "HTTP error raw count differs");
  const failedSummary = metric(summary, "http_req_failed");
  assert.equal(failedSummary.passes, failed); assert.equal(failedSummary.fails, outcomes.ok);
  close(failedSummary.rate ?? failedSummary.value, failed / requests, "HTTP error rate differs");
  same(Object.keys(stream.checks).sort(), ["JSON content type", "JSON status 200"], "named check inventory differs");
  for (const name of Object.keys(stream.checks)) {
    const check = stream.checks[name];
    assert.equal(check.passes + check.fails, requests, "named check coverage differs");
    const saved = summary.root_group?.checks?.[name];
    assert.equal(saved?.passes, check.passes); assert.equal(saved?.fails, check.fails);
  }
  same(Object.keys(summary.root_group?.checks ?? {}).sort(), Object.keys(stream.checks).sort(), "summary check inventory differs");
  assert.equal(stream.checks["JSON status 200"].passes, outcomes.ok, "status/outcome differs");
  const types = stream.checks["JSON content type"].passes;
  assert.ok(types >= outcomes.ok && types <= outcomes.ok + outcomes.http_error, "content/outcome differs");
  const checks = raw("checks", "rate"), checksSummary = metric(summary, "checks");
  assert.equal(checks.points, requests * 2); assert.equal(checks.sum, outcomes.ok + types);
  assert.equal(checksSummary?.passes, checks.true); assert.equal(checksSummary?.fails, checks.false);
  close(checksSummary.rate ?? checksSummary.value, checks.sum / checks.points, "total check rate differs");
  const drops = stream.metrics.dropped_iterations?.sum ?? 0;
  assert.ok(count(drops)); if (stream.metrics.dropped_iterations) assert.equal(stream.metrics.dropped_iterations.type, "counter");
  assert.equal(metric(summary, "dropped_iterations")?.count, drops, "drop stream/summary differ");
  close(metric(summary, "dropped_iterations")?.rate, drops * 1000 / duration, "drop rate differs");
  const offered = requests + drops;
  assert.ok(Number.isSafeInteger(offered) && offered >= config.rate * config.seconds, "below offered-load floor");
  for (const [name, rule, crossed] of [["http_req_failed", "rate==0", failed > 0], ["checks", "rate==1", failed > 0], ["dropped_iterations", "count==0", drops > 0]])
    same(summary.metrics[name]?.thresholds, { [rule]: crossed }, "threshold evidence differs");
  assert.equal(command.exit.code, failed || drops ? 99 : 0, "threshold/normal exit mismatch");
  verifyPrototypeLogs(logs, command.exit.code, { timeouts: outcomes.timeout, dropped: drops });
  const latency = raw("http_req_duration", "trend"), trend = metric(summary, "http_req_duration");
  assert.equal(latency.points, requests); assert.ok(latency.min >= 0); assert.equal(trend?.max, latency.max, "latency raw max differs");
  close(trend?.avg, latency.sum / latency.points, "latency average differs from raw sample mean");
  for (const [key, name] of [["p(50)", "p50"], ["p(95)", "p95"], ["p(99)", "p99"]])
    close(trend?.[key], stream.latency?.[name], "latency percentile differs from raw samples");
  assert.ok(["avg", "p(50)", "p(95)", "p(99)", "max"].every((key) => Number.isFinite(trend[key]) && trend[key] >= 0), "invalid latency summary");
  assert.ok(trend.avg <= trend.max && trend["p(50)"] <= trend["p(95)"] && trend["p(95)"] <= trend["p(99)"] && trend["p(99)"] <= trend.max, "latency order differs");
  const capped = counter("json_start_capped"); assert.ok(capped <= requests);
  for (const name of ["before_ms", "after_ms", "progress_ns", "scenario_ms", "origin_lower_ns", "origin_upper_ns"]) {
    const gauge = raw(`json_start_${name}`, "gauge");
    assert.equal(gauge.points, name.startsWith("origin_") ? requests - capped : requests, "clock observation coverage differs");
    const saved = metric(clock, `json_start_${name}`);
    assert.equal(saved?.min, gauge.min); assert.equal(saved?.max, gauge.max);
  }
  const customCounters = ["json_started", "json_ok", "json_timeout", "json_http_error", "json_invalid", "json_start_capped"];
  const customNames = [...customCounters, ...["before_ms", "after_ms", "progress_ns", "scenario_ms", "origin_lower_ns", "origin_upper_ns"].map((name) => `json_start_${name}`)].sort();
  same(Object.keys(clock.metrics ?? {}).sort(), customNames, "custom clock metric inventory differs");
  same(Object.keys(summary.metrics).filter((name) => name.startsWith("json_")).sort(), customNames, "custom summary metric inventory differs");
  for (const name of customCounters) {
    const observed = metric(clock, name), counted = raw(name, "counter").sum;
    assert.equal(observed?.count, counted, "custom clock counter count differs from raw samples");
    close(observed?.rate, counted * 1000 / duration, "custom clock counter rate differs from raw samples/clock");
  }
  const gauges = stream.metrics;
  assert.ok(gauges.json_start_before_ms.min >= 0 && gauges.json_start_before_ms.min <= gauges.json_start_after_ms.min
    && gauges.json_start_before_ms.max <= gauges.json_start_after_ms.max && gauges.json_start_after_ms.max <= duration, "start instance clocks reversed/outside duration");
  const epoch = gauges.json_start_scenario_ms;
  assert.ok(count(epoch.min) && epoch.min > 0 && epoch.min === epoch.max, "scenario epoch changed");
  assert.ok(epoch.min >= start && epoch.min < end, "scenario epoch outside command");
  const progress = gauges.json_start_progress_ns;
  assert.ok(progress.min >= 0 && progress.max <= config.seconds * 1e9, "invalid/capped progress observation");
  assert.equal(progress.max === config.seconds * 1e9, capped > 0, "capped-start clock/count differs");
  const lower = gauges.json_start_origin_lower_ns.max, upper = gauges.json_start_origin_upper_ns.min;
  assert.ok(Number.isFinite(lower) && Number.isFinite(upper) && lower <= upper, "scenario/test clock origin intersection empty");
  const lastStartUpperNs = Math.ceil(gauges.json_start_after_ms.max * 1e6) + 1 - lower;
  const lastStartLowerNs = Math.floor(gauges.json_start_before_ms.max * 1e6) - 1 - upper;
  const periodNs = Math.floor(1e9 / config.rate);
  const candidateCeiling = Math.floor(lastStartUpperNs / periodNs) + 1;
  if (!drops) assert.ok(requests <= candidateCeiling, "extra work unexplained by last-start observation");
  const dropWallUpperNs = drops ? (BigInt(gauges.dropped_iterations.lastNs) - BigInt(epoch.min) * 1_000_000n).toString() : null;
  // Neither wall timestamps nor a summary expose the actual last offered/stop monotonic clock.
  // A coherent capture is useful to the local probe but NEVER upgrades native evidence.
  return { schema: prototypeSchema, status: "unqualified", attemptComplete: false, targetOutcome: null, comparisonEligible: null,
    loadOutcome: failed || drops ? "threshold-failed" : "passed", requests, iterations, started, dropped: drops, offered,
    nominal: { seconds: config.seconds, rate: config.rate, arrivals: config.rate * config.seconds },
    counts: outcomes, statusCounts: stream.statusCounts, raw: stream.receipt,
    scheduling: { periodNs, lastStartLowerNs, lastStartUpperNs, candidateCeiling, cappedStarts: capped, dropWallUpperNs,
      endpointContainedByStartObservations: lastStartUpperNs <= config.seconds * 1e9,
      offeredMinusNominal: offered - config.rate * config.seconds, lastStartMinusNominalLowerNs: lastStartLowerNs - config.seconds * 1e9,
      lastStartMinusNominalUpperNs: lastStartUpperNs - config.seconds * 1e9, endpointEligible: null, qualified: false },
    blockers: ["stock-output-does-not-observe-monotonic-last-drop-or-scheduler-stop", "prototype-generator-io-not-native-headroom-qualified",
      "matrix-runtime-resource-source-functional-cleanup-joins-not-established"] };
}

export async function verifyFixedPrototype(folder, expectedIdentity) {
  folder = realpathSync(folder);
  for (const name of ["capture.json", "events.jsonl", "summary.json", "clock.json", "stderr.jsonl"]) {
    const rel = relative(folder, realpathSync(join(folder, name)));
    assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "artifact escapes prototype folder");
  }
  const capture = json(join(folder, "capture.json"), prototypeLimits.summaryBytes);
  assert.equal(capture.schema, prototypeSchema); same(capture.errors, [], "capture apparatus failure");
  verifyExperimentIdentity(capture, expectedIdentity);
  same(capture.limits, prototypeLimits, "capture safeguards changed");
  same(capture.instrumentation, { output: "stock-json-stdout", script: "fixed-prototype-load.js", changedGeneratorIO: true, gzip: false, nativeQualified: false }, "prototype I/O provenance differs");
  same(Object.keys(capture.files ?? {}).sort(), ["clock.json", "stderr.jsonl", "summary.json"], "artifact inventory differs");
  for (const [name, cap] of [["summary.json", prototypeLimits.summaryBytes], ["clock.json", prototypeLimits.clockBytes], ["stderr.jsonl", prototypeLimits.logBytes]]) {
    assert.ok(statSync(join(folder, name)).size <= cap, "artifact over cap");
    same(capture.files?.[name], { bytes: statSync(join(folder, name)).size, sha256: await digest(join(folder, name), cap) }, "artifact length/hash differs");
  }
  verifyStreamReceipt(capture.raw);
  const stream = await readFixedStream(join(folder, "events.jsonl"), capture.raw);
  assert.equal(capture.command?.stdoutBytes, stream.receipt.bytes, "stdout/retained raw byte counts differ");
  assert.equal(capture.command?.stderrBytes, capture.files["stderr.jsonl"].bytes, "stderr/retained log byte counts differ");
  const summary = json(join(folder, "summary.json"), prototypeLimits.summaryBytes), clock = json(join(folder, "clock.json"), prototypeLimits.clockBytes);
  const logFile = join(folder, "stderr.jsonl"); assert.ok(statSync(logFile).size <= prototypeLimits.logBytes);
  return joinFixedPrototype({ summary, clock, command: capture.command, config: capture.config,
    logs: new TextDecoder("utf-8", { fatal: true }).decode(readBounded(logFile, prototypeLimits.logBytes)) }, stream);
}

async function digest(file, cap = 256 * 2 ** 20) {
  let length = 0; const hash = createHash("sha256");
  for await (const bytes of createReadStream(file, { highWaterMark: streamLimits.chunkBytes })) {
    length += bytes.length; assert.ok(length <= cap, "digest input over cap"); hash.update(bytes);
  }
  return hash.digest("hex");
}

// Parent-operated local probe only. Does not provision, download or launch Docker.
export async function captureFixedPrototype({ binary, folder, base, payload = "catalog-v1", seconds = 60, rate = 150 }) {
  assert.ok(isAbsolute(binary) && statSync(binary).isFile(), "explicit local k6 binary required");
  const url = new URL(base);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash, "probe needs a loopback HTTP fixture");
  assert.ok(["catalog-v1", "marketplace-v2"].includes(payload));
  assert.ok(Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 300 && Number.isSafeInteger(rate) && rate >= 1 && rate <= 10000);
  const output = resolve(folder); mkdirSync(output); // Never overwrite a capture.
  const free = statfsSync(output); assert.ok(free.bavail * free.bsize >= streamLimits.bytes + 16 * 2 ** 20, "insufficient bounded capture disk reserve");
  const cwd = dirname(fileURLToPath(import.meta.url));
  const capture = { schema: prototypeSchema, config: { phase: "fixed", seconds, rate, payload, base: url.origin }, limits: prototypeLimits,
    instrumentation: { output: "stock-json-stdout", script: "fixed-prototype-load.js", changedGeneratorIO: true, gzip: false, nativeQualified: false },
    executable: { path: realpathSync(binary), sha256: await digest(binary), version: null }, errors: [], command: null, raw: null };
  const io = commands(cwd);
  try {
    capture.sources = Object.fromEntries(["fixed-prototype-load.js", "load.js", "load-outcome.js"].map((name) => [name, createHash("sha256").update(readFileSync(join(cwd, name))).digest("hex")]));
    const version = await io.command(binary, ["version"], { timeout: 10000, maxStdoutBytes: streamLimits.lineBytes, maxStderrBytes: streamLimits.lineBytes });
    assert.match(version, new RegExp(`^k6 v${k6Version.replaceAll(".", "\\.")}(?:\\s|$)`)); capture.executable.version = version;
    for (const path of ["events.jsonl", "stderr.jsonl"]) writeFileSync(join(output, path), "", { flag: "wx" });
    const args = fixedPrototypeArgv(capture.config, join(output, "summary.json"), join(cwd, "fixed-prototype-load.js"), output);
    capture.argv = args;
    try {
      capture.command = await io.command(binary, args, { observeExit: true, timeout: (seconds + 25) * 1000,
        stdoutFile: join(output, "events.jsonl"), stderrFile: join(output, "stderr.jsonl"), maxStdoutBytes: streamLimits.bytes, maxStderrBytes: prototypeLimits.logBytes });
    } catch (error) { capture.command = { exit: error.exit ?? null, clock: error.clock ?? null, ioErrors: error.ioErrors ?? [error.message] }; throw error; }
    capture.raw = (await readFixedStream(join(output, "events.jsonl"))).receipt;
    capture.files = {};
    for (const [name, cap] of [["summary.json", prototypeLimits.summaryBytes], ["clock.json", prototypeLimits.clockBytes], ["stderr.jsonl", prototypeLimits.logBytes]])
      capture.files[name] = { bytes: statSync(join(output, name)).size, sha256: await digest(join(output, name), cap) };
    writeFileSync(join(output, "capture.json"), JSON.stringify(capture, null, 2), { flag: "wx" });
    const replay = await verifyFixedPrototype(output);
    writeFileSync(join(output, "replay.json"), JSON.stringify(replay, null, 2), { flag: "wx" }); return replay;
  } catch (error) {
    capture.errors.push(error.message); capture.retained = {};
    for (const [name, cap] of [["events.jsonl", streamLimits.bytes], ["stderr.jsonl", prototypeLimits.logBytes], ["summary.json", prototypeLimits.summaryBytes], ["clock.json", prototypeLimits.clockBytes]]) {
      const file = join(output, name);
      if (existsSync(file)) {
        const bytes = statSync(file).size;
        capture.retained[name] = { bytes, sha256: bytes <= cap ? await digest(file, cap) : null, complete: false };
      }
    }
    writeFileSync(join(output, "capture.json"), JSON.stringify(capture, null, 2)); throw error;
  } finally { io.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    let replay;
    if (mode === "verify") { assert.equal(args.length, 1); replay = await verifyFixedPrototype(resolve(args[0])); }
    else {
      assert.equal(mode, "capture", "use capture K6_BINARY NEW_FOLDER LOOPBACK_BASE [SECONDS RATE], or verify FOLDER");
      assert.ok(args.length === 3 || args.length === 5);
      replay = await captureFixedPrototype({ binary: args[0], folder: args[1], base: args[2], ...(args.length === 5 ? { seconds: Number(args[3]), rate: Number(args[4]) } : {}) });
    }
    console.log(JSON.stringify(replay));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
