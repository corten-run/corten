// The runner and bounded fake-operation tests use this same capture/save/join path.
import assert from "node:assert/strict";
import { closeSync, fstatSync, openSync, readSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFixedStreamSync } from "./fixed-stream.mjs";
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
export async function capturePhase({ folder, path, stage, config, expected, options, tools, context, native, priorTailUnobserved = false, io }) {
  const raw = { schema: timedPhaseSchema, identity: expected, phase: stage, config,
    tools: { nodeImageId: tools.node.imageId, k6ImageId: tools.k6.imageId }, captureErrors: [], priorTailUnobserved };
  const prefix = `${path}/${stage}`, output = join(folder, `${prefix}-events.jsonl`), log = join(folder, `${prefix}-stderr.jsonl`);
  let sampler, samples, countersBefore, failure, stream;
  try {
    const free = statfsSync(folder);
    assert.ok(free.bavail * free.bsize >= captureLimits.bytes + 16 * 2 ** 20, "insufficient bounded phase disk reserve");
    writeFileSync(output, "", { flag: "wx" }); writeFileSync(log, "", { flag: "wx" });
    raw.before = await io.observe(); countersBefore = await io.counters();
    sampler = io.sample();
    try { raw.command = await io.execute({ observeExit: true, stdoutFile: output, stderrFile: log,
      maxStdoutBytes: config.mode === "fixed" ? captureLimits.bytes : captureLimits.auxiliaryBytes, maxStderrBytes: captureLimits.stderrBytes,
      timeout: (config.seconds + 25) * 1000 }); }
    catch (error) { failure = error; raw.command = { exit: error.exit ?? null, clock: error.clock ?? null, ioErrors: error.ioErrors ?? [error.message] }; }
    finally { const active = sampler; sampler = undefined; samples = await active.stop(); }
    const countersAfter = await io.counters(); raw.after = await io.observe();
    raw.samples = samples;
    raw.counters = Object.fromEntries(Object.keys(countersBefore).map((role) => [role, { before: countersBefore[role], after: countersAfter[role] }]));
    raw.upstreamReads = { before: raw.before.upstreamReads, after: raw.after.upstreamReads, settled: await io.reads() };
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
    const metrics = deriveProductionPhase(raw, expected, stage, options, tools, context, { stream, native, priorTailUnobserved });
    return { raw: io.write(`${prefix}.json`, raw), metrics };
  } catch (error) {
    // A native command fault is the cause; a capture check it provoked (no closed
    // stdout count, an empty fixed stream) is kept after it, never in its place.
    // Only the command's first line is kept: its stderr is a bounded artifact.
    const cause = failure && `native command: ${String(failure?.message ?? failure).split("\n", 1)[0].slice(0, 512)}`;
    if (cause) raw.captureErrors.push(cause);
    if (error !== failure) raw.captureErrors.push(error.message);
    const thrown = cause ? new Error(cause) : error;
    thrown.phase = { raw: io.write(`${prefix}.json`, raw), metrics: null };
    throw thrown;
  } finally { if (sampler) await sampler.stop(); }
}
