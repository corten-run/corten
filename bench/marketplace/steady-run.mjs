// The convergence and soak runner (#1851) behind steady.mjs, with Docker, git, the clock and the
// stats client passed in so the tests can run it against fakes. It changes no timed phase, warmup,
// rate, droplet job or saved round.
// Resources: every container and network goes through ownedResources (alert-probe-run.mjs), keyed
// by the immutable ID its create returned and confirmed by this pass's owner label before every
// inspect, log read and removal. A create that returned no ID stays on record; teardown looks for it
// by its attempt label and calls its cleanup unconfirmed if nothing appears, so such a pass is never
// complete. Each cell's own containers are removed before the next cell starts; a cell that leaves
// one behind, or whose create was not acknowledged, ends the pass, since its app may still be using
// the host.
// Startup: each app is started the way run.mjs coldStart starts it before a timed warmup (created,
// a sidecar polls the target's path from docker start to its first 200), then the load.
// k6: its version is read from a container this pass creates and removes like any other, and each
// load's engine clock and counters are checked by load-evidence.mjs validateLoadExecution, as a
// timed round's are, before any window is read.
// Saved text: summary.json is an allowlist (steady-contract.mjs savedText): every field is defined
// by the checkout, a validated number, or a value from Docker, k6 or the host that matched its
// pattern (otherwise null, not recorded). A failure is saved as a code from failureCodes, never its
// message. Docker's, k6's and the host's own output stays in the raw files beside the summary
// (host.txt, docker-version.txt, k6.json, images.json, the container receipts) and errors.log; the
// message of each failure goes to errors.log and run.log. cleanup.json keeps the first line this
// runner or its command runner composes for each cleanup failure. Before a pass is saved as
// complete, the same validator a reader runs is run on it, so a complete pass always reads.
// Settings: before a cell's reading is kept, its app's and its load's inspect must show the image,
// CPU quota, CPU pinning, memory limit and load settings the summary records (steady-contract.mjs
// appliedSettings), as must the upstream's before any cell runs; the load's are checked before it
// starts and again once it has run. `docker update` changes a running container's CPU quota,
// pinning and memory without a restart, so the app's are checked again at the launch check and
// after the load, and an API cell's upstream before the cell and after its load. The app is
// rechecked as the instance that served the cold probe immediately before the load starts
// (atLaunch), so a change before the load fails the cell `instance-changed` and is never read as
// one during it; a soak's app whose StartedAt after the load is a later start stamped before the
// load's own (startedBeforeLoad) fails it too, whether or not its event stream reads.
// Interval: inspects show the settings only at their moments, so every cell, of either kind, reads a
// live Docker event stream of its app, its load, its marker and an API cell's upstream from before the
// launch check to after the last inspect (readEvents): an update of the app, the load or the upstream
// (not the marker) the stream delivers fails the cell `settings` even if it was undone before the
// inspect after the load, and a start,
// restart, die, kill or OOM of the upstream, or of a convergence cell's app, fails it
// `instance-changed`. Docker can drop events for a slow subscriber without ending the stream, so this
// detects such an event and cannot show there was none; the pass saves that limit with what it
// checked (steady-contract.mjs containerChecks). A cell whose stream is unavailable keeps no reading
// (`unconfirmed`): it then had no event-stream check at all, and for a soak nothing places a start
// of its app that inspect shows in or before the load.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cpuSettings, imageProvenance, readLoadSummary } from "./run-contract.mjs";
import { admitted, boundedFeatureProfile, boundedQualificationSettings } from "./feature-contract.mjs";
import { validateColdStart, validateSummary } from "./report.mjs";
import { memoryMiB, summarizeSamples } from "../catalog/stats.mjs";
import { containerReceipt, imageReceipt, nodeImage } from "./raw-contract.mjs";
import { retainLoadEvidence, validateLoadExecution } from "./load-evidence.mjs";
import { k6Image, k6Provenance } from "../load-tool.mjs";
import { validateMarketplace } from "./records.mjs";
import { records, writeFixture } from "./fixtures.mjs";
import { locales } from "./contract.mjs";
import { ownedResources, reconcileWindow, runClock } from "./alert-probe-run.mjs";
import { appBefore, appInstance, appliedSettings, atLaunch, checkFixture, containerChecks, convergenceSchema, cpuModelDigest, eventFormat, eventRow, failureCodes, flattenPoint, flattenRule, heldThrough, markerIs, ownerLabelKey, passScope, readDropped, readEvents, readWindows, reconcileCell, loadVus,
  savedOptions, savedValue, servedCold, soakMemoryClock, soakSchema, startedBeforeLoad, summarizeSoak, timedStartup, validateConvergence, validateSoak, verdictText, windowClock } from "./steady-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const fixtureDir = join(here, "fixtures");
const containerId = /^[a-f0-9]{64}$/;
// The load container's memory limit (its --memory 2g).
const loadMemoryBytes = 2 * 2 ** 30;
const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
// The first line of an error, bounded: what cleanup.json and run.log keep.
export const firstLine = (error) => String(error?.message ?? error).split("\n", 1)[0].slice(0, 500);
// A failure's code (failureCodes): the first one given to the error is kept, so the innermost
// step that knows what failed names it.
const coded = (code, error) => {
  if (error !== null && typeof error === "object" && !Object.hasOwn(failureCodes, error.failureCode)) { try { error.failureCode = code; } catch {} }
  return error;
};
const step = async (code, work) => { try { return await work(); } catch (error) { throw coded(code, error); } };
// The metrics window-load.js and k6 itself export. A summary with any other name is refused with a
// count before a validator can quote the name.
const k6Metrics = new Set(["http_reqs", "http_req_duration", "http_req_duration{expected_response:true}", "http_req_blocked", "http_req_connecting", "http_req_tls_handshaking",
  "http_req_sending", "http_req_waiting", "http_req_receiving", "http_req_failed", "iterations", "iteration_duration", "dropped_iterations", "vus", "vus_max", "checks",
  "data_sent", "data_received", "window_tail_requests"]);
export function knownK6Metrics(summary) {
  assert.ok(summary && typeof summary.metrics === "object" && summary.metrics !== null && !Array.isArray(summary.metrics), "the k6 summary export has no metrics");
  const unknown = Object.keys(summary.metrics).filter((name) => !k6Metrics.has(name) && !/^window_(0|[1-9]\d{0,2})_(requests|failed|duration|arrivals)$/.test(name)).length;
  assert.equal(unknown, 0, `the k6 summary export has ${unknown} metric${unknown === 1 ? "" : "s"} this load does not define`);
  return summary;
}

/**
 * What the docker stats and docker events clients may make this runner keep: bytes of output read,
 * bytes in one row (a complete one or the unterminated rest), rows read, and bytes of stderr kept.
 * The first three are counted on the bytes the client wrote, every row counted, blank or not, before
 * anything is stripped from it. Past one of them the observation is unavailable and its client is
 * stopped through its own bounded stop; stderr past its limit is not kept (any stderr, until the
 * client's pipes close or are released, already fails the observation).
 * A soak of at most 62 minutes gets roughly one stats row a second, a few hundred bytes each, and
 * a handful of event rows, so the limits are far above an ordinary pass.
 */
export const clientLimits = Object.freeze({
  stats: Object.freeze({ bytes: 16 * 2 ** 20, line: 64 * 1024, rows: 100_000, stderr: 64 * 1024 }),
  events: Object.freeze({ bytes: 4 * 2 ** 20, line: 16 * 1024, rows: 50_000, stderr: 64 * 1024 }),
});
// A client's stderr, kept to `limit` bytes: add(chunk) and text().
const stderrTail = (limit) => {
  const parts = [];
  let bytes = 0;
  return {
    add(chunk) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); if (bytes < limit) parts.push(data.subarray(0, limit - bytes)); bytes += data.length; },
    text: () => (bytes > limit ? `${Buffer.concat(parts).toString()}\n[stderr past its first ${limit} bytes was not kept]\n` : Buffer.concat(parts).toString()),
  };
};

/**
 * Samples memory of containers by their immutable IDs with docker stats (--no-trunc, so each row's
 * ID is the full one). bench/catalog/stats.mjs sampleStats does the same by name for the timed
 * rounds; it is left as it is, since it is on Catalog's and Marketplace's timed path. Here stop()
 * settles within boundMs whatever the client does: TERM, KILL after graceMs, and at boundMs its
 * pipes are released and the sampler fails, so a process still holding them cannot keep the pass
 * from cleaning up. A second stop() returns the first one's result. `now` stamps each sample.
 * Output past `limits` (clientLimits.stats) fails the sampler at once: what it read is no longer
 * kept, and it stops itself through the same stop(), whose result a later stop() returns.
 * A row's escape sequences (docker stats clears the screen between refreshes) are stripped only
 * after the row has been counted and measured.
 * @returns {{ stop(): Promise<{summary: object, samples: object}> }}
 */
export function memorySampler({ ids, file, seconds, spawn: run = spawn, graceMs = 2000, boundMs = 5000, now = Date.now, limits = clientLimits.stats }) {
  assert.ok(ids.length > 0 && ids.every((id) => containerId.test(id)), "memory is sampled by immutable container IDs");
  const child = run("docker", ["stats", "--no-trunc", "--format", "{{json .}}", ...ids], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const samples = Object.fromEntries(ids.map((id) => [id, []]));
  const errors = [];
  const failed = (message) => errors.push(message);
  // Rows that are not readable or name another container are counted, not quoted; stderr is kept
  // in its own raw file.
  const stderr = stderrTail(limits.stderr);
  let buffer = Buffer.alloc(0), raw = [], bytes = 0, rows = 0, overflowed = false, stderrSeen = false, unreadable = 0, foreign = 0, stopping = false, closed = false, settled, sampler;
  const overflow = (what) => {
    if (overflowed) return;
    overflowed = true; buffer = Buffer.alloc(0);
    failed(`docker stats ${what}, so its memory samples are unavailable`);
    sampler.stop().catch(() => {});
  };
  child.stdout.on("data", (chunk) => {
    if (overflowed) return;
    if ((bytes += chunk.length) > limits.bytes) return overflow(`wrote more than ${limits.bytes} bytes`);
    raw.push(chunk); buffer = Buffer.concat([buffer, chunk]);
    for (let end; (end = buffer.indexOf(0x0a)) >= 0;) {
      if (end > limits.line) return overflow(`wrote a row longer than ${limits.line} bytes`);
      if (++rows > limits.rows) return overflow(`wrote more than ${limits.rows} rows`);
      const line = buffer.subarray(0, end).toString().replace(ansi, "").trim();
      buffer = buffer.subarray(end + 1);
      if (!line) continue;
      try {
        const s = JSON.parse(line);
        if (!Object.hasOwn(samples, s?.ID)) { foreign++; continue; }
        samples[s.ID].push({ t: now(), cpu: parseFloat(s.CPUPerc), mem: memoryMiB(s.MemUsage.split("/")[0]) });
      } catch { unreadable++; }
    }
    if (buffer.length > limits.line) overflow(`wrote a row longer than ${limits.line} bytes`);
  });
  // Until the pipes close or are released, stop() included: an error written after TERM counts.
  child.stderr.on("data", (chunk) => { stderrSeen = true; stderr.add(chunk); });
  child.on("error", (error) => failed(`docker stats could not run (${typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "error"})`));
  const done = new Promise((resolve) => child.on("close", (code) => { closed = true; if (!stopping) failed(`docker stats stopped early: ${code}`); resolve(true); }));
  const signal = (name) => { try { child.kill(name); } catch {} };
  const timer = setTimeout(() => { failed("stats sampler exceeded its deadline"); signal("SIGTERM"); }, seconds * 1000);
  sampler = {
    stop() {
      return settled ??= (async () => {
        stopping = true;
        clearTimeout(timer);
        if (!closed) signal("SIGTERM");
        let kill, bound;
        const ended = await Promise.race([done, new Promise((resolve) => {
          kill = setTimeout(() => signal("SIGKILL"), graceMs);
          bound = setTimeout(() => resolve(false), boundMs);
        })]);
        clearTimeout(kill); clearTimeout(bound);
        if (!ended) {
          // Something still holds the client's pipes after TERM and KILL: release them and fail.
          failed(`docker stats did not settle within ${boundMs} ms of stop; its pipes were released`);
          child.stdout.destroy(); child.stderr.destroy(); child.unref?.();
        }
        writeFileSync(file, Buffer.concat(raw));
        if (stderrSeen) { writeFileSync(`${file}.stderr`, stderr.text()); failed(`docker stats wrote to stderr (kept in ${basename(file)}.stderr)`); }
        if (unreadable) failed(`${unreadable} docker stats row${unreadable === 1 ? " was" : "s were"} not readable`);
        if (foreign) failed(`${foreign} docker stats row${foreign === 1 ? "" : "s"} named a container this pass does not sample`);
        if (buffer.toString().replace(ansi, "").trim().length) failed("stats ended with an incomplete JSON record");
        if (errors.length) throw Object.assign(new Error(errors.join("; ")), { errors });
        const summary = Object.fromEntries(ids.map((id) => [id, summarizeSamples(samples[id])]));
        writeFileSync(`${file}.json`, JSON.stringify({ summary, samples }, null, 2));
        return { summary, samples };
      })();
    },
  };
  return sampler;
}

/**
 * A cell's live Docker event stream for its app, a marker container and `others` (the load and an
 * API cell's upstream), by their immutable IDs (steady-contract.mjs readEvents says why a live stream
 * and what the marker shows). It runs from before the launch check to after the last inspect. marker(n) waits at most markerMs for the stream to show the marker's
 * nth start, and fails at once if the stream has ended; fence() waits the same way for the marker's
 * next row after its second start, and resolves only when that row is the start's own exit (its die)
 * stamped later than the start, so rows the client delivers after that start are read before the
 * stream is stopped. Any other row there (a copy of the start, a die stamped at or before it) fails
 * it at once, as readEvents refuses it. stop() settles within boundMs whatever the
 * client does, as memorySampler's does, keeps what the stream said in `file` (and its stderr in
 * `file`.stderr), and returns that text, or throws if the client could not run, ended before it was
 * stopped, wrote to stderr or held its pipes. A second stop() returns the first one's result.
 * A marker row counts as a start, or as the fence's die, only by readEvents's own tests: the row
 * must read as one (eventRow, so its time is a time) and its action be exactly that word (markerIs).
 * A marker row that does not read starts nothing, so no load starts on a row readEvents would
 * refuse; after the second start it is not the fence.
 * Output past `limits` (clientLimits.events) makes the stream unavailable at once: its waits fail,
 * what it read is no longer kept, and it stops itself through the same stop(). Once the stream has
 * failed in any way, no wait succeeds, not even one a row read before the failure satisfied.
 */
export function eventStream({ app, marker, others = [], file, spawn: run = spawn, graceMs = 2000, boundMs = 5000, markerMs = 10_000, limits = clientLimits.events }) {
  const ids = [app, marker, ...others];
  assert.ok(ids.every((id) => containerId.test(id)) && new Set(ids).size === ids.length, "the event stream follows immutable container IDs");
  const child = run("docker", ["events", "--filter", "type=container", ...ids.flatMap((id) => ["--filter", `container=${id}`]), "--format", eventFormat],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const errors = [], waiting = [];
  const stderr = stderrTail(limits.stderr);
  // second: the second start's nanoseconds (a start counts only when its row reads); fenced: null until the
  // marker's next row after that start decides it, then whether it was that start's later exit.
  // refusal: why a wait fails once the stream has overflowed.
  let chunks = [], buffer = Buffer.alloc(0), bytes = 0, rows = 0, overflowed = false, refusal = null, stderrSeen = false, starts = 0, second = null, fenced = null, stopping = false, closed = false, settled, stream;
  const release = (message) => { for (const w of waiting.splice(0)) { clearTimeout(w.timer); w.reject(new Error(message)); } };
  const overflow = (what) => {
    if (overflowed) return;
    overflowed = true; buffer = Buffer.alloc(0); refusal = `docker events ${what}`;
    errors.push(`docker events ${what}, so the stream is unavailable`);
    release(refusal);
    stream.stop().catch(() => {});
  };
  child.stdout.on("data", (chunk) => {
    if (overflowed) return;
    if ((bytes += chunk.length) > limits.bytes) return overflow(`wrote more than ${limits.bytes} bytes`);
    chunks.push(chunk); buffer = Buffer.concat([buffer, chunk]);
    for (let end; (end = buffer.indexOf(0x0a)) >= 0;) {
      if (end > limits.line) return overflow(`wrote a row longer than ${limits.line} bytes`);
      if (++rows > limits.rows) return overflow(`wrote more than ${limits.rows} rows`);
      const line = buffer.subarray(0, end).toString().replace(/\r$/, "");
      if (line.startsWith(`${marker}|`)) {
        const row = eventRow(line);
        if (starts >= 2) fenced ??= row !== null && markerIs(row.action, "die") && row.at > second;
        else if (row !== null && markerIs(row.action, "start") && ++starts === 2) second = row.at;
      }
      buffer = buffer.subarray(end + 1);
    }
    if (buffer.length > limits.line) return overflow(`wrote a row longer than ${limits.line} bytes`);
    for (const w of [...waiting]) if (w.ready()) { clearTimeout(w.timer); waiting.splice(waiting.indexOf(w), 1); w.resolve(); }
  });
  // Until the pipes close or are released, stop() included: an error written after TERM counts.
  child.stderr.on("data", (chunk) => { stderrSeen = true; stderr.add(chunk); });
  child.on("error", (error) => { errors.push(`docker events could not run (${typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "error"})`); release("docker events could not run"); });
  const done = new Promise((resolve) => child.on("close", (code) => {
    closed = true;
    if (!stopping) { errors.push(`docker events stopped early: ${code}`); release("docker events stopped before it showed the marker"); }
    resolve(true);
  }));
  const signal = (name) => { try { child.kill(name); } catch {} };
  const wait = (ready, what) => {
    // A failed stream (overflowed, could not run, ended early) answers no wait, even a cached one.
    if (errors.length) return Promise.reject(new Error(refusal ?? "docker events stopped before it showed the marker"));
    if (ready()) return Promise.resolve();
    if (closed) return Promise.reject(new Error("docker events stopped before it showed the marker"));
    return new Promise((resolve, reject) => {
      const w = { ready, resolve, reject };
      w.timer = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); reject(new Error(`docker events did not show ${what} within ${markerMs} ms`)); }, markerMs);
      waiting.push(w);
    });
  };
  stream = {
    marker: (n) => wait(() => starts >= n, `the marker's start ${n}`),
    fence: async () => {
      await wait(() => fenced !== null, "the marker's exit after its second start");
      if (!fenced) throw new Error("docker events showed a marker row after its second start that is not that start's exit stamped later than it");
    },
    stop() {
      return settled ??= (async () => {
        stopping = true;
        release("the event stream was stopped");
        if (!closed) signal("SIGTERM");
        let kill, bound;
        const ended = await Promise.race([done, new Promise((resolve) => {
          kill = setTimeout(() => signal("SIGKILL"), graceMs);
          bound = setTimeout(() => resolve(false), boundMs);
        })]);
        clearTimeout(kill); clearTimeout(bound);
        if (!ended) {
          errors.push(`docker events did not settle within ${boundMs} ms of stop; its pipes were released`);
          child.stdout.destroy(); child.stderr.destroy(); child.unref?.();
        }
        const text = Buffer.concat(chunks).toString();
        writeFileSync(file, text);
        if (stderrSeen) { writeFileSync(`${file}.stderr`, stderr.text()); errors.push(`docker events wrote to stderr (kept in ${basename(file)}.stderr)`); }
        if (errors.length) throw Object.assign(new Error(errors.join("; ")), { errors });
        return text;
      })();
    },
  };
  return stream;
}

/**
 * The Docker runner steady.mjs gives runSteady, over Catalog's commandRunner `command`. ownedResources
 * asks for a container's log with `combined: true`, since Docker writes a container's stdout and
 * stderr to its own two streams. A pass keeps a log only as a raw file, so a combined call must name
 * that `file`: the runner writes both streams to it as they arrive and nothing is read back
 * (commandRunner returns only stdout, and with `capture: false` none). Every other call, including
 * the cold probe's `combined: false` one that writes the container's stdout alone to its `file`
 * (commandRunner's opt-in `fileStderr: false`), reaches the runner with its options unchanged;
 * commandRunner's defaults are not changed, so no timed command is.
 */
export function combinedRunner(command, binary = "docker") {
  return async (args, { combined = false, ...options } = {}) => {
    if (!combined) return command(binary, args, options);
    assert.ok(typeof options.file === "string", "a combined container log is written to its own file, never read back");
    await command(binary, args, { ...options, capture: false });
    return "";
  };
}

async function waitHealth(url, { timeout = 20_000, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  for (const deadline = now() + timeout; now() < deadline; await sleep(100)) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); await response.text(); if (response.ok) return; } catch {}
  }
  throw new Error("marketplace upstream did not start");
}
/**
 * The cold probe's stdout (bench/catalog/cold.mjs) exactly as it wrote it: nothing until it is
 * ready, then `catalog-probe-ready`, then once it has its first 200 one result line, exactly as
 * JSON.stringify writes first200At, successfulRequestMs, bytes, attempts and the path it polled.
 * Each line ends in one newline, the last perhaps not yet while the probe runs; any other byte (a
 * blank line, padding, a second result) fails it. The runner reads it from a file holding the
 * probe's stdout alone, and never more than coldOutputBytes of it (readBounded); stderr reaches
 * cold.log alone. This is the readiness poll's parser: it returns null until the probe is ready,
 * true once it is ready without a result, or the result. Once the probe has exited, the runner reads
 * its output with coldResult instead.
 */
export const coldOutputBytes = 4096;
export function coldOutput(stdout, path) {
  assert.ok(typeof stdout === "string" && Buffer.byteLength(stdout) <= coldOutputBytes, `the cold probe wrote more than ${coldOutputBytes} bytes to stdout; its output is in cold.log`);
  if (stdout === "") return null;
  const lines = (stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout).split("\n");
  assert.ok(lines[0] === "catalog-probe-ready", "the cold probe's stdout is not its readiness line; its output is in cold.log");
  if (lines.length === 1) return true;
  assert.equal(lines.length, 2, "the cold probe's stdout is not one readiness line and one result line; its output is in cold.log");
  let result;
  try { result = JSON.parse(lines[1]); } catch { assert.fail("the cold probe's result line is not JSON; its output is in cold.log"); }
  const ok = result !== null && typeof result === "object" && !Array.isArray(result) && lines[1] === JSON.stringify(result)
    && Object.keys(result).sort().join() === "attempts,bytes,first200At,path,successfulRequestMs"
    && typeof result.first200At === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.first200At) && Number.isFinite(Date.parse(result.first200At))
    && Number.isFinite(result.successfulRequestMs) && result.successfulRequestMs >= 0
    && Number.isSafeInteger(result.bytes) && result.bytes >= 0 && Number.isSafeInteger(result.attempts) && result.attempts >= 1 && result.path === path;
  assert.ok(ok, "the cold probe's result line is not first200At, successfulRequestMs, bytes, attempts and its path; its output is in cold.log");
  return result;
}
/**
 * The cold probe's output once it has exited: both lines, each ended by its newline, and the
 * result, whose values validateColdStart (report.mjs) then checks as a timed round's. An exited
 * probe whose last line has no newline, that wrote nothing, or that wrote only its readiness line
 * fails here; coldOutput's allowance for a line still being written is for the readiness poll alone.
 */
export function coldResult(stdout, path) {
  const result = coldOutput(stdout, path);
  assert.ok(result !== null && result !== true, "the cold probe exited 0 without a result line; its output is in cold.log");
  assert.ok(stdout.endsWith("\n"), "the cold probe exited without a newline after its result line; its output is in cold.log");
  return result;
}
/** A file's text, read only up to `limit` bytes: a longer file fails with `message`, with no more than limit + 1 bytes read. */
export function readBounded(file, limit, message) {
  const data = Buffer.alloc(limit + 1), fd = openSync(file, "r");
  let n = 0;
  try { for (let r = 1; n < data.length && r > 0; n += r) r = readSync(fd, data, n, data.length - n, n); } finally { closeSync(fd); }
  assert.ok(n <= limit, message);
  return data.subarray(0, n).toString("utf8");
}
// The fixture's bytes checked as run.mjs checks them before a timed round, and their SHA-256.
const currentFixture = (bytes) => checkFixture(bytes, records(), validateMarketplace);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Runs one convergence or soak pass and returns its summary, also saved as summary.json in folder
 * (which must not exist yet: an earlier pass is never overwritten).
 * The fixture is read once from `fixtureFile` (the checkout's Git-ignored fixtures/marketplace.json)
 * into a copy in this pass's own folder (mounted-fixture); `fixture(bytes)` checks that copy's bytes
 * and gives their hash, and the upstream and every app mount the copy read-only, never the original,
 * so an edit to the original during the pass cannot change what a later cell serves. The copy is
 * hashed again at the end (a pass whose copy changed fails), and removed at teardown once every
 * container is confirmed removed (`removeCopy`; a copy it fails to remove fails the pass).
 * @param {object} p
 * @param {object} p.options parseSteadyArgs output
 * @param {(args: string[], options?: object) => Promise<string>} p.docker bounded docker runner (commandRunner)
 * @param {(args: string[]) => Promise<string>} p.git
 */
/**
 * The run ID steady.mjs gives a pass: its kind, its descriptive name and a random suffix. It is what
 * summary.json keeps and the value of the owner label on every resource; it is never a Docker name
 * (containerBase).
 */
export const passRunId = (kind, name, suffix = randomBytes(5).toString("hex")) => `marketplace-${kind}-${name}-${suffix}`;
// RFC 1035 label: at most 63 lowercase letters, digits and dashes, with no dash at either end.
const dnsLabel = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/**
 * The prefix of every container and network name a pass gives Docker. Its containers reach one
 * another by name on the pass's network, so each name must be a DNS label, and a run ID made from a
 * long pass name is not one (a 41-character name gives an 85-character probe hostname). The prefix
 * is fixed text and the first 12 hex digits of the run ID's SHA-256, 16 characters, so it is as
 * unique per run as the run ID's random suffix. Nothing is found by these names: every resource is
 * read and removed by its ID, or found by the owner or attempt label, which carry the run ID.
 * @param {string} runId
 */
export const containerBase = (runId) => `mkt-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;

export async function runSteady({ options, folder, runId, docker, git, interrupted = () => false, env = process.env, clock = runClock(), window = reconcileWindow,
  fixture = currentFixture, fixtureFile = join(fixtureDir, "marketplace.json"), removeCopy = (path) => rmSync(path, { recursive: true, force: true }), upstreamReady = waitHealth, spawnStats = spawn, statsBounds = {}, spawnEvents = spawn, eventBounds = {}, print = console.log }) {
  const convergence = options.kind === "convergence";
  const seconds = options.minutes * 60;
  const cpus = cpuSettings(env);
  mkdirSync(dirname(folder), { recursive: true });
  mkdirSync(folder);
  assert.ok(savedValue("runId", runId) === runId, "a pass's run ID is lowercase letters, digits and dashes");
  // Every field summary.json may hold, set from the checkout or through savedValue; nothing else is
  // added to it. The host's name is not kept.
  const summary = { schema: convergence ? convergenceSchema : soakSchema, name: options.name, runId, options: savedOptions(options), ...(convergence ? { rule: flattenRule } : {}),
    startedAt: new Date().toISOString(), finishedAt: null, complete: false, failures: [], cleanup: null, cells: [], admission: null, startup: timedStartup,
    host: { platform: savedValue("platform", platform()), release: savedValue("kernel", release()), node: savedValue("node", process.version), docker: null, kernel: null, cpuModelSha256: null, onlineCpus: null },
    scope: passScope[options.kind],
    measurement: { cpus, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20, encoding: "identity", clock: windowClock, containerChecks, ...(convergence ? {} : { memoryClock: soakMemoryClock }) },
    commit: null, finishedCommit: null, dirty: null, fixtureSha256: null, images: {}, tools: null };
  const save = () => { writeFileSync(join(folder, "summary.json.tmp"), JSON.stringify(summary, null, 2)); renameSync(join(folder, "summary.json.tmp"), join(folder, "summary.json")); };
  const log = (message) => { const line = `${new Date().toISOString()} ${message}`; print(line); appendFileSync(join(folder, "run.log"), `${line}\n`); };
  const retain = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
  // The full text of an error (a command's stderr, a validator's detail) goes here, raw, never to
  // summary.json or cleanup.json.
  const keep = (where, error) => appendFileSync(join(folder, "errors.log"), `${new Date().toISOString()} ${where}: ${error?.stack ?? error}\n`);
  // Every Docker command's error is reduced to its first line, which the command runner composes
  // from this pass's own arguments and the exit; the rest (Docker's own output) stays in errors.log.
  const ownDocker = async (args, opts) => {
    try { return await docker(args, opts); } catch (error) {
      if (error && typeof error === "object") {
        keep(`docker ${args.slice(0, 2).join(" ")}`, error);
        try { error.message = firstLine(error); error.stack = `${error.name ?? "Error"}: ${error.message}`; } catch {}
      }
      throw error;
    }
  };
  // Parsing an answer: a JSON.parse message quotes the input, so it and the answer (bounded) are
  // kept in errors.log only.
  const parsed = (text, what) => {
    try { return JSON.parse(text); } catch (error) { keep(what, `${error.message}\n${String(text).slice(0, 4096)}`); throw new Error(`${what} is not JSON`); }
  };
  // A failure's code for summary.json; its message goes to errors.log (here) and run.log (the caller).
  const codeOf = (where, error) => {
    keep(where, error);
    return interrupted() ? "interrupted" : Object.hasOwn(failureCodes, error?.failureCode) ? error.failureCode : "error";
  };
  // A value from Docker, k6 or the host that must match its saved pattern; otherwise the step fails
  // with a fixed message (the value itself is in a raw file).
  const pinned = (kind, value, what) => { const saved = savedValue(kind, value); assert.ok(saved !== null && saved === value, `${what} is not a value a pass saves`); return saved; };
  const callerLabels = options.labels.flatMap((l) => ["--label", l]);
  const owned = ownedResources({ docker: ownDocker, runId, labels: callerLabels, clock, window, owner: ownerLabelKey, describe: firstLine });
  const mount = ["-v", `${join(repo, "bench")}:/bench:ro`];
  // The private copy of the verified fixture that every container mounts (see runSteady above).
  const fixtureCopy = join(folder, "mounted-fixture");
  const fixtureMount = ["-v", `${fixtureCopy}:/fixtures:ro`];
  let fixtureCopySha256 = null;
  // Each Docker name: the run's prefix and a role or adapter, refused unless it is a DNS label.
  const base = containerBase(runId);
  const named = (name) => { assert.match(name, dnsLabel, "a container name is not a DNS label"); return name; };
  const dockerName = (suffix) => named(`${base}-${suffix}`);
  const upstreamName = dockerName("upstream");
  // The upstream's container ID and the settings the summary records for it, once it is created.
  let network, upstreamId, upstreamSettings;
  const port = async (id) => {
    const hostPort = (await owned.inspect(id)).NetworkSettings?.Ports?.["8080/tcp"]?.[0]?.HostPort;
    assert.ok(hostPort, `${id}: no private host port`);
    return `http://127.0.0.1:${hostPort}`;
  };
  // The container run.mjs starts for a timed round (appArgs there), so a pass measures the same app.
  const appArgs = (name, source, image) => ["--network", network, ...cpus.app.args, "--memory", "1g", "-p", "127.0.0.1::8080",
    ...fixtureMount, "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
    "-e", `API_BASE=http://${upstreamName}:8080`, "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`,
    ...(options.group ? ["--ulimit", "nofile=65536:65536", "-e", `PROFILE=${boundedQualificationSettings.nativeProfile}`, "-e", `MAX_CONNECTIONS=${boundedQualificationSettings.maxConnections}`] : []), image];
  // Removes each of a cell's containers, every one attempted; one not removed is kept in `left`.
  const settle = async (ids, left) => { for (const id of ids) if (id && !(await owned.remove(id))) left.push(id); };
  // The app's inspect as a raw snapshot: the container receipt and its RestartCount, which the
  // receipt does not keep and a pass compares.
  const snapshot = (info) => ({ ...containerReceipt(info), restartCount: info.RestartCount ?? null });
  // run.mjs coldStart: the app is created, a sidecar waits for it, then the app starts and the
  // sidecar polls the target's own path until its first 200. Returns the instance that served the
  // probe, as Docker reported it then: its container ID, StartedAt and RestartCount (servedCold).
  async function coldStart(app, name, target, raw, left) {
    const path = target === "json" ? "/api/marketplace/item_1" : `/marketplace/${locales[0]}/item_1`;
    const stdoutFile = join(raw, "cold-stdout.log");
    let probe, logged = false;
    // Both of the probe's streams, written straight to cold.log and never read back, at most once.
    const collect = async () => { logged = true; await owned.logs(probe, { file: join(raw, "cold.log") }); };
    try {
      probe = await owned.container(["--network", network, ...cpus.load.args, "--memory", "256m", ...mount, nodeImage, "node", "/bench/catalog/cold.mjs", `http://${name}:8080`, path, String(options.startupTimeout)], named(`${name}-probe`));
      await owned.start(probe);
      retain(join(raw, "probe-container.json"), containerReceipt(await owned.inspect(probe)));
      // Readiness and the result come from the probe's stdout alone: written afresh to
      // cold-stdout.log each time, with no stderr, and read back only up to coldOutputBytes. The
      // readiness poll parses it with coldOutput; the exited probe's output with coldResult.
      const stdout = async () => {
        rmSync(stdoutFile, { force: true });
        await owned.logs(probe, { combined: false, file: stdoutFile, fileStderr: false, capture: false });
        return readBounded(stdoutFile, coldOutputBytes, `the cold probe wrote more than ${coldOutputBytes} bytes to stdout; its output is in cold.log`);
      };
      const deadline = clock.now() + 10_000;
      while (coldOutput(await stdout(), path) === null) {
        if (interrupted()) throw new Error("interrupted");
        if (clock.now() > deadline) throw new Error("cold sidecar did not become ready");
        await clock.sleep(50);
      }
      await owned.start(app);
      const exit = await owned.docker(["wait", probe], { timeout: (options.startupTimeout + 5) * 1000 });
      await collect();
      // The record says only whether it exited 0.
      assert.ok(exit === "0", `cold probe ${/^\d{1,3}$/.test(exit) ? `exited ${exit}` : "returned no exit status"}; its output is in cold.log`);
      const result = coldResult(await stdout(), path);
      const info = await owned.inspect(app);
      // The instance that served the probe, as Docker reported it once the probe had its first 200.
      const served = { id: info.Id, startedAt: info.State?.StartedAt, restartCount: info.RestartCount };
      const cold = { ...result, first200MsFromContainerStart: Date.parse(result.first200At) - Date.parse(info.State.StartedAt), containerStartedAt: info.State.StartedAt };
      // The timed validator's own cold-start rules; its detail goes to errors.log only.
      try { validateColdStart(cold, path, options.startupTimeout); } catch (error) {
        keep("cold start", error);
        throw new Error("the cold probe's result is not a cold start a timed round accepts (validateColdStart); its output is in cold.log");
      }
      retain(join(raw, "cold.json"), cold);
      return served;
    } catch (error) {
      // A failure before the probe's log was collected still collects it, through the same bounded
      // command, so cold.log exists; the original failure stands whatever that collection does.
      if (probe !== undefined && !logged) { try { await collect(); } catch (e) { keep("cold.log", e); } }
      throw error;
    } finally { await settle([probe], left); }
  }
  // One adapter, source and target: a fresh container, the cold start, one long k6 pass. Before it
  // returns or throws, every container it made has been removed or is listed in `left`.
  async function pass(cell, imageId, raw, left) {
    const name = dockerName(cell.app);
    let sampler, app, k6, marker, stream;
    // An API cell's load reaches the upstream, so its settings are checked before the cell, at the
    // launch check and after the load, like the app's: `docker update` can change them without a
    // restart. A change undone between those checks is seen only if the event stream delivers it.
    const upstreamHeld = async (when) => {
      if (cell.source !== "api") return;
      const info = await step("container", () => owned.inspect(upstreamId));
      retain(join(raw, `upstream-container-${when}.json`), containerReceipt(info));
      await step("settings", () => appliedSettings(info, upstreamSettings));
    };
    try {
      await upstreamHeld("before");
      app = await step("container", () => owned.container(appArgs(name, cell.source, imageId), name));
      const served = await step("cold-start", () => coldStart(app, name, cell.target, raw, left));
      if (left.length) throw coded("unsettled", new Error("the cold sidecar was not removed"));
      const before = await step("container", () => owned.inspect(app));
      retain(join(raw, "app-container.json"), snapshot(before));
      // Its ID, StartedAt, RestartCount and states in their forms, and running, before anything is compared.
      const instance = await step("container", () => appInstance(before, "before"));
      // The instance the load will measure is the one that served the cold probe; otherwise no load starts.
      await step("instance-changed", () => servedCold(served, instance));
      await step("cold-start", () => appBefore(before));
      // The app the summary describes: its image, CPU quota and pinning, memory and source. Checked
      // here, at the launch check and after the load, since `docker update` changes the quota,
      // pinning and memory of a running container without a restart.
      const appSettings = { role: "app", image: imageId, quota: cpus.app.quota, cpuset: cpus.app.cpuset, memoryBytes: summary.measurement.appMemoryBytes,
        env: { MARKETPLACE_SOURCE: cell.source, ...(options.group ? { PROFILE: boundedQualificationSettings.nativeProfile, MAX_CONNECTIONS: String(boundedQualificationSettings.maxConnections) } : {}) } };
      await step("settings", () => appliedSettings(before, appSettings));
      // What window-load.js reads (__ENV), each as this pass requests it; null is a setting it does not give.
      const loadEnv = { BASE: `http://${name}:8080`, TARGET: cell.target, LOCALE: cell.target === "page" ? "rotating" : null, MODE: convergence ? "closed" : "fixed",
        WINDOWS: String(options.windows), WINDOW_SECONDS: String(options.windowSeconds), VUS: convergence ? String(options.vus) : null, RATE: convergence ? null : String(options.rate) };
      const k6Env = Object.entries(loadEnv).flatMap(([key, value]) => (value === null ? [] : ["-e", `${key}=${value}`]));
      const loadSettings = { role: "load", image: summary.tools.k6.imageId, quota: cpus.load.quota, cpuset: cpus.load.cpuset, memoryBytes: loadMemoryBytes, env: loadEnv };
      // The load's receipt, with the window settings containerReceipt does not keep: as this pass
      // requested them, and every value Docker's inspect reports for each (none, one or more).
      const windowKeys = ["WINDOWS", "WINDOW_SECONDS"];
      // An inspect without the shape containerReceipt reads (an Env that is not a list of strings, no
      // Config or HostConfig) keeps a fixed note, the load's ID when it is one and the window settings
      // instead, never its malformed values, so writing the receipt cannot replace the settings
      // check that follows it: that check still refuses such an inspect, `settings`.
      const loadReceipt = (info) => {
        let receipt;
        try { receipt = containerReceipt(info); } catch {
          receipt = { unreadable: "Docker's inspect of the load does not have the shape of a container receipt", id: typeof info?.Id === "string" && /^[a-f0-9]{64}$/.test(info.Id) ? info.Id : null };
        }
        return { ...receipt, windowEnv: { requested: Object.fromEntries(windowKeys.map((key) => [key, loadEnv[key]])),
          observed: Object.fromEntries(windowKeys.map((key) => [key, (Array.isArray(info?.Config?.Env) ? info.Config.Env : []).filter((e) => typeof e === "string" && e.startsWith(`${key}=`)).map((e) => e.slice(key.length + 1))])) } };
      };
      k6 = await step("container", () => owned.container(["--network", network, ...cpus.load.args, "--memory", "2g", "--sysctl", "net.ipv4.ip_local_port_range=1024 65535", "--sysctl", "net.ipv4.tcp_tw_reuse=1", ...mount, ...k6Env,
        k6Image, "run", "--quiet", "--summary-export", "/tmp/marketplace-summary.json", "/bench/marketplace/window-load.js"], dockerName("k6")));
      // The live event stream of the app, the load and an API cell's upstream, listening before the
      // launch check: the marker's first start shows it is. Without it the cell would have no
      // event-stream check of an update or restart during the load, so no load starts.
      marker = await step("container", () => owned.container(["--network", "none", ...cpus.load.args, "--memory", "64m", nodeImage, "true"], named(`${name}-marker`)));
      stream = eventStream({ app, marker, others: [k6, ...(cell.source === "api" ? [upstreamId] : [])], file: join(raw, "events.log"), spawn: spawnEvents, ...eventBounds });
      await step("container", () => owned.start(marker));
      await step("unconfirmed", () => stream.marker(1));
      const phaseStartMs = clock.now();
      if (!convergence) sampler = memorySampler({ ids: [app], file: join(raw, "stats.log"), seconds: seconds + 120, spawn: spawnStats, now: clock.now, ...statsBounds });
      // The load's settings as Docker applied them, before it starts. Its receipt is kept before
      // they are checked, so a refused load's shows what Docker had.
      const created = await step("container", () => owned.inspect(k6));
      retain(join(raw, "load-container-before.json"), loadReceipt(created));
      await step("settings", () => appliedSettings(created, loadSettings));
      // The last answer before the load starts: the app is still the instance that served the cold
      // probe. A change found here was before the load, so no load starts.
      const launch = await step("container", () => owned.inspect(app));
      retain(join(raw, "app-container-launch.json"), snapshot(launch));
      const launched = await step("instance-changed", () => atLaunch(served, launch));
      await step("settings", () => appliedSettings(launch, appSettings));
      await upstreamHeld("launch");
      // The memory samples' origin, on the same workstation clock as their own stamps (soakMemoryClock).
      const memoryOriginMs = clock.now();
      await step("load-exit", () => owned.docker(["start", "-a", k6], { timeout: (seconds + 60) * 1000, file: join(raw, "load.log") }));
      let stats, statsError;
      if (sampler) { try { stats = await sampler.stop(); } catch (e) { statsError = e; } }
      const loadInfo = await step("container", () => owned.inspect(k6));
      retain(join(raw, "load-container.json"), loadReceipt(loadInfo));
      // The settings the load ran with, which validateLoadExecution reads (its VUs, mode and rate) as requested.
      await step("settings", () => appliedSettings(loadInfo, loadSettings));
      if (loadInfo.State.ExitCode !== 0) throw coded("load-exit", new Error("k6 exited with an error"));
      const evidence = await step("load-evidence", async () => {
        let k6Summary;
        try { k6Summary = await retainLoadEvidence(owned.docker, k6, raw, "load"); } catch (error) {
          keep("retaining the k6 summary export", error); throw new Error("the k6 summary export could not be retained or is not JSON");
        }
        // Only names window-load.js and k6 define, before any validator can quote one.
        knownK6Metrics(k6Summary);
        // The engine clock must cover the pass inside the container's own run, and every counter's
        // rate must be its count over that clock, as validate.mjs requires of a timed phase.
        validateLoadExecution({ load: containerReceipt(loadInfo), summary: k6Summary, clock: parsed(readFileSync(join(raw, "load-clock.json"), "utf8"), "the k6 engine clock export"), start: phaseStartMs, end: clock.now(), seconds });
        // k6's aggregate: every request, including those answered during the graceful stop.
        return { k6Summary, load: readLoadSummary(k6Summary), ...readWindows(k6Summary, { windows: options.windows, windowSeconds: options.windowSeconds, arrivals: !convergence }) };
      });
      const { k6Summary, load, windows, tail, unrecorded, requests, iterations, latencyMaxMs, arrivals } = evidence;
      const after = await step("container", () => owned.inspect(app));
      retain(join(raw, "app-container-after.json"), snapshot(after));
      // The settings at the last inspect: the app's, and an API cell's upstream's. A change undone
      // before it is the event stream's to detect, below, if the stream delivers it.
      await step("settings", () => appliedSettings(after, appSettings));
      await upstreamHeld("after");
      // What Docker's inspect alone shows, which needs no event stream and so is kept whatever the
      // stream does: a convergence cell's app that is not the same running instance (heldThrough),
      // and a soak's app that started again before the load began (startedBeforeLoad).
      if (convergence) await step("instance-changed", () => heldThrough(before, after));
      const end = await step("container", () => appInstance(after, "after"));
      await step("instance-changed", () => startedBeforeLoad(launched, end, loadInfo.State.StartedAt));
      // A start of the app the inspect shows after the launch check (another ID, StartedAt or
      // RestartCount at the end): a restart, which only the event stream can place in or before the load.
      const restartedSinceLaunch = [end.id !== launched.id && "container ID", end.startedAt !== launched.startedAt && "StartedAt", end.restartCount !== launched.restartCount && "RestartCount"].filter(Boolean);
      // The marker's second start, after the last inspect, shows the stream was still running then;
      // the fence, its exit, that what the client handed over after that start is read too. Neither
      // shows that Docker delivered every event between them (it can drop one for a slow subscriber).
      // Docker's event times and the load's StartedAt and FinishedAt are all the daemon's clock, read
      // to the nanosecond; readEvents requires the two marker starts to bracket the load.
      // A stream that failed, did not show both marker starts and the fence, or has a row that is not
      // this cell's app, load, upstream or marker, an action and a time, is unavailable.
      let read = null, streamError;
      try {
        await owned.start(marker); await stream.marker(2); await stream.fence();
        const text = await stream.stop();
        read = readEvents(text, { app, marker, load: k6, upstream: cell.source === "api" ? upstreamId : null, startedAt: loadInfo.State.StartedAt, finishedAt: loadInfo.State.FinishedAt });
      } catch (e) { streamError = e; }
      retain(join(raw, "events.json"), { stream: read === null ? "unavailable" : "read", ...(read ?? {}), restartedSinceLaunch });
      if (streamError) {
        keep("docker events", streamError);
        throw coded("unconfirmed", new Error(`Docker's event stream is unavailable (${firstLine(streamError)}), so the cell has no event-stream check for an update or restart of its containers around the load${restartedSinceLaunch.length
          ? `; the app's inspect after the load shows another ${restartedSinceLaunch.join(" and ")} than at the launch check, a restart the stream alone could place in or before the load` : ""}`));
      }
      // Any update of the cell's containers the stream delivered: a setting may have changed during
      // the load and been undone before the inspect after it.
      if (read.updates.length) {
        const roles = [...new Set(read.updates.map((u) => u.role))].join(", ");
        throw coded("settings", new Error(`Docker's event stream shows ${read.updates.length} update${read.updates.length === 1 ? "" : "s"} of the cell's containers (${roles}) from before its launch check to after its last inspect`));
      }
      if (read.upstream.length) throw coded("instance-changed", new Error(`Docker's event stream shows ${read.upstream.length} start, restart, die, kill or OOM event${read.upstream.length === 1 ? "" : "s"} of the upstream during the cell`));
      // An app event stamped before the load started happened after the launch check and before the
      // load: the load may not have run against the instance that served the cold probe.
      if (read.events.some((e) => e.atSeconds < 0)) throw coded("instance-changed", new Error("the app had a start, restart, die, kill or OOM event stamped before the load started"));
      if (convergence) {
        // A convergence cell's app must be undisturbed through its load: even a signal is not warming.
        if (read.events.length) throw coded("instance-changed", new Error(`the app had ${read.events.length} start, restart, die, kill or OOM event${read.events.length === 1 ? "" : "s"} during the load`));
        // A failed answer can be faster than a served one, so throughput with failures says nothing
        // about warming: a failure anywhere, in a window or in the graceful stop, means no verdict.
        const inWindows = windows.reduce((sum, w) => sum + w.failed, 0);
        if (inWindows) throw coded("failed-requests", new Error(`${inWindows} requests failed in the pass's windows; no verdict`));
        if (load.failed) throw coded("failed-requests", new Error(`${load.failed} requests failed in k6's aggregate, which includes the graceful stop; no verdict`));
        Object.assign(cell, { windows, tail, unrecorded, requests, iterations, latencyMaxMs, failedRequests: load.failed });
        await step("load-evidence", () => reconcileCell(cell, loadVus(options)));
        return Object.assign(cell, { verdict: flattenPoint(windows) });
      }
      // A memory sampling failure makes only the memory reading unavailable (summarizeSoak); the
      // restart, stop and OOM observations do not depend on it.
      if (statsError) { keep("memory samples", statsError); log(`${cell.app} ${cell.source} ${cell.target}: memory samples failed: ${firstLine(statsError)}`); }
      const samples = statsError ? null : (stats?.samples?.[app] ?? []).map((s) => ({ atSeconds: (s.t - memoryOriginMs) / 1000, mib: s.mem }));
      Object.assign(cell, await step("load-evidence", () => summarizeSoak({ windows, tail, unrecorded, requests, iterations, latencyMaxMs, memory: samples, before: appBefore(before), after: end, events: read.events, rate: options.rate,
        droppedIterations: readDropped(k6Summary), failedRequests: load.failed, arrivals })));
      await step("load-evidence", () => reconcileCell(cell, loadVus(options)));
      return cell;
    } finally {
      if (sampler) { try { await sampler.stop(); } catch {} }
      if (stream) { try { await stream.stop(); } catch {} }
      if (app) { try { await owned.logs(app, { file: join(raw, "app.log") }); } catch (e) { log(`${cell.app} ${cell.source} ${cell.target}: app log unavailable: ${e.message}`); } }
      await settle([k6, marker, app], left);
    }
  }
  // The pinned k6 image's provenance (load-tool.mjs k6Provenance): its version is read from a
  // container created, attached and removed through ownedResources, so it is owned and accounted
  // for like every other.
  async function k6Tool() {
    let image;
    try { image = parsed(await owned.docker(["image", "inspect", k6Image]), "docker image inspect of k6")[0]; } catch {
      await owned.docker(["pull", k6Image], { timeout: 5 * 60 * 1000, file: join(folder, "pull-k6.log") });
      image = parsed(await owned.docker(["image", "inspect", k6Image]), "docker image inspect of k6")[0];
    }
    assert.match(image?.Id ?? "", /^sha256:[a-f0-9]{64}$/, "missing k6 image ID");
    let probe, output;
    try {
      probe = await owned.container(["--network", "none", image.Id, "version"], dockerName("k6-version"));
      output = await owned.attach(probe, 60_000);
    } finally { if (probe) assert.ok(await owned.remove(probe), "the k6 version probe was not removed"); }
    // The whole provenance, with k6's own version output, is raw; summary.json keeps its image ID
    // and the version k6Provenance matched against the pin.
    const provenance = k6Provenance(image, output);
    retain(join(folder, "k6.json"), provenance);
    return { imageId: pinned("imageId", provenance.imageId, "the k6 image ID"), version: pinned("k6Version", provenance.version, "the k6 version") };
  }

  try {
    save();
    await step("checkout", async () => {
      summary.commit = pinned("commit", await git(["rev-parse", "HEAD"]), "the measured commit");
      summary.dirty = (await git(["status", "--porcelain", "--untracked-files=normal"])).length > 0;
      assert.ok(!summary.dirty, "a convergence or soak pass requires a clean committed checkout");
    });
    // The fixture every container mounts: read once, copied into this pass's folder, and that copy
    // checked as run.mjs checks the fixture before a timed round and hashed.
    summary.fixtureSha256 = await step("fixture", () => {
      let bytes = null;
      try { bytes = readFileSync(fixtureFile); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (bytes !== null) {
        // A fresh directory (mkdirSync refuses one that exists), published as the other runners
        // publish theirs (writeFixture): under a umask such as 077 a plain copy would be 0700/0600,
        // which the read-only mount keeps, so an adapter running as another user could not read it.
        mkdirSync(fixtureCopy);
        writeFixture(join(fixtureCopy, "marketplace.json"), bytes);
        bytes = readFileSync(join(fixtureCopy, "marketplace.json"));
        fixtureCopySha256 = sha256(bytes);
      }
      return pinned("sha256", fixture(bytes), "the fixture hash");
    });
    await step("host", async () => {
      // Docker's and the probe's own text is kept raw; summary.json keeps each value only if it
      // matches its pattern (savedValue), otherwise null: not recorded.
      const dockerVersion = await owned.docker(["version", "--format", "{{.Server.Version}}"]);
      writeFileSync(join(folder, "docker-version.txt"), `${dockerVersion}\n`);
      summary.host.docker = savedValue("docker", dockerVersion);
      let hostText, hostProbe;
      try {
        hostProbe = await owned.container(["--network", "none", nodeImage, "sh", "-c", "uname -r; grep -m1 'model name' /proc/cpuinfo; cat /sys/devices/system/cpu/online"], dockerName("host"));
        hostText = await owned.attach(hostProbe, 60_000);
      } finally { if (hostProbe) assert.ok(await owned.remove(hostProbe), "the host probe was not removed"); }
      writeFileSync(join(folder, "host.txt"), hostText + "\n");
      const hostLines = hostText.trim().split("\n").map((line) => line.trim());
      // The kernel the containers run on: run.mjs records the droplet's os.release(), the same kernel.
      summary.host.kernel = savedValue("kernel", hostLines[0]);
      // The CPU model only as its digest (cpuModelDigest): its text stays in host.txt.
      summary.host.cpuModelSha256 = cpuModelDigest(hostLines.find((line) => line.startsWith("model name"))?.split(":").slice(1).join(":"));
      summary.host.onlineCpus = savedValue("onlineCpus", hostLines.at(-1));
    });
    if (options.admittedFrom) await step("admission", () => {
      // Only the adapters a saved timed round admitted: its feature qualification decides, not this pass.
      // Reading, parsing and validating it can quote the file (a JSON.parse fragment, a saved value
      // in a validator's message): that detail goes to errors.log only, and the step fails with a
      // fixed refusal, as report.mjs --convergence does.
      let bytes, round;
      try { bytes = readFileSync(options.admittedFrom); round = validateSummary(JSON.parse(bytes)); } catch (error) {
        keep("the round given to --admitted-from", error);
        throw new Error("the round given to --admitted-from could not be read or did not validate as a timed round (the reason is in errors.log)");
      }
      const admittedApps = Object.keys(round.apps).filter((a) => !round.options.group || admitted(round.apps[a]));
      // The path only when it is inside the checkout and plain; the operator's own paths are not kept.
      summary.admission = { round: pinned("round", round.round, "the admitting round"), commit: pinned("commit", round.commit, "the admitting round's commit"),
        summarySha256: createHash("sha256").update(bytes).digest("hex"), path: savedValue("path", relative(repo, options.admittedFrom).replaceAll("\\", "/")),
        selected: options.apps.map((a) => pinned("name", a, "an adapter")), admitted: admittedApps.map((a) => pinned("name", a, "an admitted adapter")) };
      options.apps = options.apps.filter((a) => admittedApps.includes(a));
      summary.options.apps = [...options.apps];
      assert.ok(options.apps.length > 0, "no selected adapter was admitted by that round");
    });
    const images = {};
    await step("image", async () => { for (const app of options.apps) {
      const image = `cb-marketplace-${options.group ? "production-" : ""}${app}`;
      if (options.build) {
        log(`building ${app}`);
        const context = app === "corten" ? repo : join(repo, "bench/fullstack/apps", app);
        const dockerfile = app === "corten" ? join(here, "corten/Dockerfile") : join(context, app === "sveltekit" ? "Dockerfile.marketplace" : "Dockerfile");
        await owned.docker(["build", "--label", `run.corten.marketplace.commit=${summary.commit}`, "--label", "run.corten.marketplace.dirty=false",
          ...(options.group ? ["--label", `run.corten.marketplace.profile=${boundedFeatureProfile}`, "--build-arg", `PROFILE=${boundedQualificationSettings.nativeProfile}`] : []),
          "-t", image, "-f", dockerfile, context], { timeout: 60 * 60 * 1000, file: join(folder, `build-${app}.log`) });
        assert.equal(await git(["rev-parse", "HEAD"]), summary.commit, "HEAD changed during image build");
        assert.equal(await git(["status", "--porcelain"]), "", "checkout changed during image build");
      }
      const info = parsed(await owned.docker(["image", "inspect", image]), `docker image inspect of ${image}`)[0];
      imageProvenance(info.Config.Labels, summary.commit, false);
      if (options.group) assert.equal(info.Config.Labels["run.corten.marketplace.profile"], boundedFeatureProfile, "image lacks the required feature profile; rebuild with --build");
      images[app] = imageReceipt(info);
    }
    retain(join(folder, "images.json"), images);
    // The image IDs a timed round records too (summary.apps[app].imageId): report.mjs compares them.
    // The receipts stay raw in images.json; only an ID of the saved form goes to summary.json.
    summary.images = Object.fromEntries(options.apps.map((app) => [app, pinned("imageId", images[app].id, "an adapter image ID")]));
    });
    save();
    summary.tools = { k6: await step("tools", () => k6Tool()), upstream: null };
    network = await step("container", () => owned.network(dockerName("net")));
    const upstreamInfo = await step("container", async () => {
      upstreamId = await owned.container(["--network", network, ...cpus.api.args, "--memory", "512m", "-p", "127.0.0.1::8080", ...mount,
        ...fixtureMount, nodeImage, "node", "/bench/marketplace/upstream.mjs"], upstreamName);
      await owned.start(upstreamId);
      return owned.inspect(upstreamId);
    });
    retain(join(folder, "upstream-container.json"), containerReceipt(upstreamInfo));
    summary.tools.upstream = { imageId: await step("tools", () => pinned("imageId", upstreamInfo.Image, "the upstream image ID")) };
    upstreamSettings = { role: "upstream", image: summary.tools.upstream.imageId, quota: cpus.api.quota, cpuset: cpus.api.cpuset, memoryBytes: summary.measurement.upstreamMemoryBytes };
    await step("settings", () => appliedSettings(upstreamInfo, upstreamSettings));
    await step("upstream", async () => upstreamReady(`${await port(upstreamInfo.Id)}/health`));
    save();
    for (const source of options.sources) for (const app of options.apps) for (const target of options.targets) {
      const cell = { app, source, target };
      summary.cells.push(cell);
      const raw = join(folder, source, app, target);
      mkdirSync(raw, { recursive: true });
      log(`${options.kind} ${app} ${source} ${target}: cold start, then ${options.minutes} min in ${options.windowSeconds}s windows`);
      const left = [], unacknowledged = owned.record.unacknowledged.length;
      try {
        if (interrupted()) throw coded("interrupted", new Error("interrupted"));
        await pass(cell, images[app].id, raw, left);
        if (convergence) log(`${app} ${source} ${target}: ${verdictText(cell.verdict)}`);
      } catch (e) {
        // This cell has no verdict; the pass goes on to the next one if its containers are gone. The
        // summary keeps the failure's code; its message is in errors.log and run.log.
        for (const key of Object.keys(cell)) if (!["app", "source", "target"].includes(key)) delete cell[key];
        cell.failure = codeOf(`${app} ${source} ${target}`, e);
        if (convergence) cell.verdict = null;
        log(`${app} ${source} ${target} FAILED (${cell.failure}): ${firstLine(e)}`);
      }
      save();
      const unsettled = [...left.map((id) => `container ${id} was not removed`),
        ...owned.record.unacknowledged.slice(unacknowledged).map((a) => `the create of ${a.name} was not acknowledged`)];
      if (unsettled.length) throw coded("unsettled", new Error(`${app} ${source} ${target} did not settle (${unsettled.join("; ")}), so no further cell is measured`));
    }
    await step("checkout", async () => {
      summary.finishedCommit = savedValue("commit", await git(["rev-parse", "HEAD"]));
      assert.equal(summary.finishedCommit, summary.commit, "checkout moved during the pass");
      assert.equal(await git(["status", "--porcelain"]), "", "checkout changed during the pass");
    });
    // What every cell mounted is still the copy that was hashed.
    await step("fixture", () => assert.equal(sha256(readFileSync(join(fixtureCopy, "marketplace.json"))), fixtureCopySha256, "the mounted fixture copy changed during the pass"));
    summary.complete = !interrupted();
  } catch (e) {
    const code = codeOf("suite", e);
    summary.failures.push({ stage: "suite", code });
    log(`suite FAILED (${code}): ${firstLine(e)} (detail in errors.log)`);
  } finally {
    let cleanup;
    try { cleanup = await owned.teardown(); } catch (e) { keep("teardown", e); cleanup = { ...owned.record, complete: false, failures: [...owned.record.failures, { resource: runId, error: firstLine(e) }] }; }
    retain(join(folder, "cleanup.json"), cleanup);
    // What a saved reader checks before it counts the pass (steady-contract.mjs passEvidence): counts,
    // and the names and labels this pass gave its own creates. cleanup.json keeps the whole record,
    // which counts what survived teardown rather than listing it (ownedResources).
    const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
    // Complete only when every acknowledged create is among the resources confirmed removed by its
    // ID, whatever the record's own flag says (a create Docker did not acknowledge is recovered by
    // its label instead; passEvidence checks the counts of both).
    const gone = new Set((cleanup.removed ?? []).map((entry) => entry?.id));
    const accounted = Array.isArray(cleanup.created) && cleanup.created.every((entry) => gone.has(entry?.id));
    if (cleanup.complete === true && !accounted) log("cleanup not confirmed: an acknowledged create is not among the resources removed (cleanup.json)");
    // And every create Docker did not acknowledge was found and each thing it made removed, or
    // confirmed absent, by its own ID (ownedResources teardown): otherwise a container may still mount the copy.
    const attempts = Array.isArray(cleanup.unacknowledged) && cleanup.unacknowledged.every((a) => a?.outcome === "removed");
    if (cleanup.complete === true && !attempts) log("cleanup not confirmed: a create Docker did not acknowledge was not confirmed removed (cleanup.json)");
    summary.cleanup = { complete: cleanup.complete === true && accounted && attempts, remaining: cleanup.remaining ? { containers: count(cleanup.remaining.containers), networks: count(cleanup.remaining.networks) } : null,
      created: cleanup.created.length, removed: cleanup.removed.length, recovered: cleanup.recovered.length, failures: cleanup.failures.length,
      unacknowledged: cleanup.unacknowledged.map((a) => ({ name: savedValue("runId", a.name), label: savedValue("attemptLabel", a.label), outcome: ["removed", "not removed"].includes(a.outcome) ? a.outcome : "unconfirmed" })) };
    // The fixture copy is removed only once every container that may mount it is confirmed removed;
    // otherwise it is kept for whatever still mounts it. A copy that was not removed fails the pass.
    if (!summary.cleanup.complete) log("the mounted fixture copy is kept, since a container of this pass may still mount it");
    else {
      try { removeCopy(fixtureCopy); } catch (e) {
        keep("removing the mounted fixture copy", e);
        summary.failures.push({ stage: "teardown", code: "error" });
        log("teardown FAILED (error): the mounted fixture copy was not removed (detail in errors.log)");
      }
    }
    summary.finishedAt = new Date().toISOString();
    summary.complete &&= !interrupted() && summary.failures.length === 0 && summary.cleanup.complete;
    if (summary.complete) {
      // A complete pass must read: the same validator a reader runs, on what is about to be saved.
      try { (convergence ? validateConvergence : validateSoak)(structuredClone(summary)); } catch (e) {
        keep("summary", e);
        summary.failures.push({ stage: "suite", code: "summary-invalid" });
        summary.complete = false;
        log(`summary FAILED (summary-invalid): ${firstLine(e)}`);
      }
    }
    save();
  }
  log(`marketplace ${options.kind} ${options.name}: ${summary.complete ? "COMPLETE" : "INCOMPLETE"}${summary.cleanup.failures ? `; cleanup not confirmed (${summary.cleanup.failures} failure${summary.cleanup.failures === 1 ? "" : "s"}, in cleanup.json)` : ""}; ${join(folder, "summary.json")}`);
  return summary;
}
