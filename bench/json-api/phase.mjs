// The runner and bounded fake-operation tests use this same capture/save/join path.
import assert from "node:assert/strict";
import { closeSync, fstatSync, openSync, readSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFixedStreamSync } from "./fixed-stream.mjs";
import { finalizeLoadResourceCapture } from "./load-resource-capture.mjs";
import { captureLimits, deriveProductionPhase } from "./production.mjs";
import { timedPhaseSchema } from "./timed-outcomes.mjs";
import { sha256 } from "./contract.mjs";

function bounded(file, cap) {
  const fd = openSync(file, "r");
  try {
    const info = fstatSync(fd); assert.ok(info.isFile() && info.size <= cap, "native auxiliary artifact over cap");
    const bytes = Buffer.alloc(info.size + 1); let length = 0, n;
    while (length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null))) length += n;
    assert.equal(length, info.size, "native auxiliary artifact changed during read");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
export async function withPhaseCleanup(run, cleanup, recordCleanupFailure) {
  let failed = false;
  try { return await run(); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await cleanup(); }
    catch (error) {
      recordCleanupFailure(error);
      if (!failed) throw error;
    }
  }
}

export async function capturePhase({ folder, path, stage, config, expected, options, tools, context, native, priorTailUnobserved = false, io }) {
  const raw = { schema: timedPhaseSchema, identity: expected, phase: stage, config,
    tools: { nodeImageId: tools.node.imageId, k6ImageId: tools.k6.imageId }, captureErrors: [], priorTailUnobserved };
  const prefix = `${path}/${stage}`, output = join(folder, `${prefix}-events.jsonl`), log = join(folder, `${prefix}-stderr.jsonl`);
  let sampler, loadSampler, loadResult, loadEnding, countersBefore, failure, sampleFailure, stream;
  const sampleErrors = [];
  const firstLine = (error) => String(error?.message ?? error).split("\n", 1)[0].slice(0, 512);
  async function joinSamplers() {
    const active = [sampler, loadSampler]; sampler = loadSampler = undefined;
    const results = await Promise.allSettled(active.map(async (s) => s?.stop()));
    if (active[0] && results[0].status === "fulfilled") raw.samples = results[0].value;
    if (active[1] && results[1].status === "fulfilled") {
      loadResult = results[1].value;
      raw.loadResources = loadResult.capture;
      if (loadResult.error) sampleErrors.push(firstLine(loadResult.error));
      loadEnding = loadResult.missed?.error;
    }
    for (const result of results) if (result.status === "rejected") sampleErrors.push(firstLine(result.reason));
  }
  try {
    const free = statfsSync(folder);
    assert.ok(free.bavail * free.bsize >= captureLimits.bytes + 16 * 2 ** 20, "insufficient bounded phase disk reserve");
    writeFileSync(output, "", { flag: "wx" }); writeFileSync(log, "", { flag: "wx" });
    raw.before = await io.observe(); countersBefore = await io.counters();
    sampler = io.sample();
    try {
      loadSampler = io.sampleLoad?.(raw.before.participants.load.containerId);
      raw.command = await io.execute({ observeExit: true, onExit: () => loadSampler?.requestStop?.(), stdoutFile: output, stderrFile: log,
        maxStdoutBytes: config.mode === "fixed" ? captureLimits.bytes : captureLimits.auxiliaryBytes, maxStderrBytes: captureLimits.stderrBytes,
        timeout: (config.seconds + 25) * 1000 });
    }
    catch (error) { failure = error; raw.command = { exit: error.exit ?? null, clock: error.clock ?? null, ioErrors: error.ioErrors ?? [error.message] }; }
    // The attached command has already settled. Request sampler shutdown now,
    // but snapshot CPU before waiting for sampler terminal reads or pipe drains.
    const joining = joinSamplers();
    let countersAfter;
    try { countersAfter = await io.counters(); }
    finally { await joining; }
    raw.after = await io.observe();
    if (loadResult && !loadResult.error) {
      try { raw.loadResources = finalizeLoadResourceCapture(loadResult, raw.after.liveness?.load); }
      catch (error) {
        if (loadEnding && loadEnding !== error) sampleErrors.push(firstLine(loadEnding));
        sampleErrors.push(firstLine(error));
      } finally { loadEnding = undefined; }
    }
    raw.counters = Object.fromEntries(Object.keys(countersBefore).map((role) => [role, { before: countersBefore[role], after: countersAfter[role] }]));
    const settled = await io.reads();
    raw.upstreamReads = { before: raw.before.upstreamReads, after: raw.after.upstreamReads, settled: settled.upstreamReads };
    raw.settledResponses = settled.upstreamResponses;
    raw.settledAt = io.now ? io.now() : Date.now();
    const logBytes = bounded(log, captureLimits.stderrBytes), decode = (bytes) => new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
    raw.logs = decode(logBytes);
    const summaryFile = join(folder, `${prefix}-k6.json`), clockFile = join(folder, `${prefix}-clock.json`);
    await io.copy("/tmp/json-summary.json", summaryFile);
    await io.copy(config.mode === "fixed" ? "/tmp/clock.json" : "/tmp/json-clock.json", clockFile);
    const summaryBytes = bounded(summaryFile, captureLimits.auxiliaryBytes), clockBytes = bounded(clockFile, captureLimits.auxiliaryBytes);
    raw.k6 = JSON.parse(decode(summaryBytes)); raw.clock = JSON.parse(decode(clockBytes));
    raw.files = Object.fromEntries([["stderr", `${prefix}-stderr.jsonl`, logBytes], ["summary", `${prefix}-k6.json`, summaryBytes], ["clock", `${prefix}-clock.json`, clockBytes]]
      .map(([name, path, bytes]) => [name, { path, bytes: bytes.length, sha256: sha256(bytes) }]));
    if (config.mode === "fixed") {
      stream = readFixedStreamSync(output); raw.events = stream.receipt;
      raw.eventStream = { path: `${prefix}-events.jsonl`, receipt: stream.receipt };
    } else {
      assert.equal(raw.command.stdoutBytes, 0, "unexpected closed native stdout");
      const bytes = bounded(output, captureLimits.auxiliaryBytes);
      assert.equal(bytes.length, 0, "unexpected retained closed native stdout");
      raw.files.stdout = { path: `${prefix}-events.jsonl`, bytes: 0, sha256: sha256(bytes) };
    }
    if (failure) throw failure;
    if (sampleErrors.length) {
      sampleFailure = new Error(sampleErrors[0]);
      throw sampleFailure;
    }
    const metrics = deriveProductionPhase(raw, expected, stage, options, tools, context, { stream, native, priorTailUnobserved });
    return { raw: io.write(`${prefix}.json`, raw), metrics };
  } catch (error) {
    // A native command fault is the cause; a capture check it provoked (no closed
    // stdout count, an empty fixed stream) is kept after it, never in its place.
    // Only the command's first line is kept: its stderr is a bounded artifact.
    const cause = failure && `native command: ${firstLine(failure)}`;
    if (cause) raw.captureErrors.push(cause);
    if (loadEnding) sampleErrors.push(firstLine(loadEnding));
    raw.captureErrors.push(...sampleErrors);
    if (error !== failure && error !== sampleFailure) raw.captureErrors.push(firstLine(error));
    const thrown = cause ? new Error(cause) : error;
    try { thrown.phase = { raw: io.write(`${prefix}.json`, raw), metrics: null }; }
    catch (writeError) {
      throw new AggregateError([thrown, writeError],
        [...raw.captureErrors, `phase receipt write: ${firstLine(writeError)}`].join("; "), { cause: thrown });
    }
    throw thrown;
  } finally { if (sampler || loadSampler) await joinSamplers(); }
}
