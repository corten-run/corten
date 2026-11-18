import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { nativeClock } from "./clock.mjs";
import { recoveryProfile as profile, recoverySchedule } from "./dependency-recovery-contract.mjs";
import { cgroupDirectory, resourceAsync } from "./resource-sample.mjs";

const maxBytes = 64 * 1024;
export function validRecord(receipt, expected) {
  if (!receipt || receipt.status !== 200 || receipt.complete !== true || receipt.error !== null ||
      !/^application\/json(?:\s*;|$)/i.test(receipt.contentType) || typeof receipt.bodyBase64 !== "string" ||
      receipt.bodyBase64.length > 4 * Math.ceil(maxBytes / 3)) return false;
  try {
    const body = Buffer.from(receipt.bodyBase64, "base64");
    return body.length <= maxBytes && body.toString("base64") === receipt.bodyBase64 &&
      isDeepStrictEqual(JSON.parse(body.toString("utf8")), expected);
  } catch { return false; }
}

// One ordinary read, no retry or redirect. The deadline covers headers AND body.
export async function readOnce(url, ca) {
  const receipt = { status: null, contentType: null, bodyBase64: "", complete: false, error: null };
  return new Promise(resolve => {
    const req = (url.protocol === "https:" ? https : http).get(url, {
      ca, agent: false, headers: { Accept: "application/json" },
    }, res => {
      receipt.status = res.statusCode; receipt.contentType = res.headers["content-type"] ?? "";
      let size = 0; const chunks = [];
      res.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new Error("body-too-large")); else chunks.push(chunk);
      });
      res.once("error", error => finish(error));
      res.once("end", () => {
        receipt.complete = res.complete; receipt.bodyBase64 = Buffer.concat(chunks).toString("base64"); finish();
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("deadline")), profile.timeoutMs);
    let done = false;
    function finish(error) {
      if (done) return; done = true; clearTimeout(deadline);
      if (error) receipt.error = error.code ?? error.message;
      resolve(receipt);
    }
    req.once("error", finish);
  });
}

export async function runRecovery(config, { trigger, emit, sample, clock = nativeClock }) {
  assert.equal(config.phase, "dependency-recovery");
  assert.deepEqual(config.budget.dependencyRecovery, profile);
  assert.ok(["fixture","api"].includes(config.source));
  const target = new URL("/api/marketplace/item_1", config.target.origin);
  const status = new URL("/__marketplace/dependency-recovery", config.upstream);
  const nowNs = () => process.hrtime.bigint();
  const observe = async () => {
    const receipt = await readOnce(status);
    assert.equal(receipt.status, 200, "recovery upstream unavailable");
    assert.ok(receipt.complete && !receipt.error, "incomplete recovery upstream status");
    return JSON.parse(Buffer.from(receipt.bodyBase64, "base64").toString("utf8"));
  };
  const before = await observe(); assert.equal(before.phase, "normal");
  const origin = clock(); const start = BigInt(origin.monotonicNs);
  const now = () => Number(nowNs() - start) / 1e6;
  emit({ type: "clock", ...origin, wallAtStart: new Date().toISOString() });
  const upstream = { before: { ...before, observedAtMs: 0 } }, samples = [];
  const waitUntil = async ms => { while (now() < ms) await sleep(Math.max(1, ms - now())); };
  const waitPhase = async (phase, limit) => {
    while (now() < limit) {
      const state = await observe(), observedAtMs = now();
      if (state.phase === phase) return { ...state, observedAtMs };
      await sleep(10);
    }
    throw new Error("missing recovery upstream phase: " + phase);
  };
  const restored = profile.beforeMs + profile.duringMs, end = restored + profile.afterMs;
  let pending = 0;
  const jobs = recoverySchedule.map(async scheduledMs => {
    await waitUntil(scheduledMs); const startMs = now();
    assert.ok(startMs - scheduledMs <= 200 && pending < 2, "probe scheduler missed a slot; do not catch up");
    pending++;
    try {
      const receipt = await readOnce(target, config.target.caPem), endMs = now();
      samples.push({ scheduledMs, startMs, endMs, receipt, ok: endMs - startMs <= profile.timeoutMs && validRecord(receipt, config.expected) });
    } finally { pending--; }
  });
  jobs.push((async () => {
    await waitUntil(profile.beforeMs); await trigger();
    upstream.slow = await waitPhase("slow", profile.beforeMs + 500);
    await waitUntil(restored); upstream.restored = await waitPhase("restored", restored + 500);
  })());
  for (const [window, ms] of [["before", profile.beforeMs/2], ["during", profile.beforeMs + profile.duringMs/2], ["after", restored + profile.afterMs/2]]) {
    jobs.push((async () => {
      await waitUntil(ms); const atMs = now(), samples = await sample();
      emit({ type: "resources", window, atMs, collectedAtMs: now(), samples });
    })());
  }
  const settled = await Promise.allSettled(jobs);
  for (const outcome of settled) if (outcome.status === "rejected") throw outcome.reason;
  await waitUntil(end);
  upstream.after = { ...await observe(), observedAtMs: now() };
  const restoredAtMs = upstream.restored.observedAtMs - upstream.restored.elapsedSinceStartMs + profile.duringMs;
  emit({ type: "dependency-recovery", samples: samples.sort((a,b) => a.scheduledMs-b.scheduledMs), restoredAtMs, upstream });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, out] = process.argv.slice(2), config = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(["http://localhost:8080","https://localhost:8080"].includes(config.target.origin));
  assert.match(config.upstream, /^http:\/\/[a-z0-9-]+-cell-upstream:8080$/);
  const paths = config.processes.map(p => [p.id, cgroupDirectory(p.containerId)]);
  const rows = [];
  try {
    await runRecovery(config, { trigger: () => writeFileSync("/recovery/start", "", { flag: "wx", mode: 0o600 }),
      emit: row => rows.push(JSON.stringify(row)),
      sample: async () => Object.fromEntries(await Promise.all(paths.map(async ([id,path]) => [id,await resourceAsync(path)]))) });
  } finally { writeFileSync(out, rows.join("\n") + "\n", { flag: "wx" }); }
}
