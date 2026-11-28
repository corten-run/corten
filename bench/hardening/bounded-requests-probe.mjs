import assert from "node:assert/strict";
import { lookup } from "node:dns";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { nativeClock } from "./clock.mjs";
import { maxRecordBytes, recoveryProfile } from "./dependency-recovery-contract.mjs";
import { assertBoundedScope, assessBoundedRequests, boundedReadPlan, boundedRequestProfile as profile, restoreSettleMs, triggerSettleMs } from "./bounded-requests.mjs";

function privateLookup(hostname, options, done) {
  const address = ip => options.all ? [{ address: ip, family: 4 }] : ip;
  if (hostname === "localhost") return done(null, address("127.0.0.1"), 4);
  lookup(hostname, { family: 4 }, (error, ip) => {
    if (error) return done(error);
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return done(null, address(ip), 4);
    done(new Error("upstream resolved outside the private benchmark network"));
  });
}

const transportFailure = ({ code }) => code?.startsWith("HPE_") ? "invalid-http-response" : code ?? "probe-transport";

// The fixed spec is produced by boundedReadPlan, not by CLI or environment knobs.
function readOnce({ url, deadlineMs, headerValueBytes }, ca) {
  const receipt = { status: null, contentType: null, bodyBase64: "", complete: false, error: null };
  const secure = url.startsWith("https:");
  return new Promise(resolve => {
    const headers = { Accept: "application/json" };
    if (headerValueBytes) headers["User-Agent"] = "a".repeat(headerValueBytes);
    let failure;
    const req = (secure ? https : http).get(url, { agent: false, family: 4, lookup: privateLookup, headers,
      ...(secure ? { ca, rejectUnauthorized: true } : {}) }, res => {
      receipt.status = res.statusCode;
      receipt.contentType = res.headers["content-type"] ?? "";
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > maxRecordBytes) {
          failure ??= "body-too-large";
          req.destroy();
        } else chunks.push(chunk);
      });
      res.once("error", error => { failure ??= transportFailure(error); });
      res.once("end", () => {
        if (!failure && res.complete) {
          receipt.complete = true;
          receipt.bodyBase64 = Buffer.concat(chunks).toString("base64");
        }
      });
    });
    const timer = setTimeout(() => {
      if (!receipt.complete) {
        failure ??= "deadline";
        req.destroy();
      }
    }, deadlineMs);
    req.once("error", error => { failure ??= transportFailure(error); });
    req.once("close", () => {
      clearTimeout(timer);
      if (!receipt.complete) receipt.error = failure ?? "incomplete-response";
      resolve(receipt);
    });
  });
}

export async function runBoundedRequests(config, { emit, trigger, clock = nativeClock, nowNs = process.hrtime.bigint,
  wallNow = () => new Date().toISOString(), pause = sleep, read = readOnce }) {
  const { phase, source, upstream: upstreamOrigin, target, expected } = config;
  const targetOrigin = target?.origin;
  assertBoundedScope({ phase, source, targetOrigin, upstreamOrigin });
  assert.deepEqual(config.budget?.boundedRequests, profile, "bounded request budget differs");
  assert.ok(!targetOrigin.startsWith("https:") || typeof target.caPem === "string" && target.caPem.length > 0 && target.caPem.length <= 8192,
    "deployed-edge probe requires the private CA");
  assert.ok(expected?.id === "item_1", "missing canonical marketplace record");
  const origin = clock(), start = BigInt(origin.monotonicNs);
  const now = () => Number(nowNs() - start) / 1e6;
  emit({ type: "clock", ...origin, wallAtStart: wallNow() });
  const { reads, statusRead } = boundedReadPlan(phase, targetOrigin, upstreamOrigin);
  const timed = async spec => {
    const startMs = now(), receipt = await read(spec, spec.url.startsWith("https:") ? target.caPem : undefined);
    return { ...spec, startMs, endMs: now(), receipt };
  };
  const [baseline, middle, followup] = reads;
  const row = { type: "bounded-requests", version: profile.version, phase, source, targetOrigin, upstreamOrigin, samples: [], upstream: null };
  if (phase === "request-limit") {
    row.samples.push(await timed(baseline), await timed(middle), await timed(followup));
    row.completeAtMs = row.samples[2].endMs;
  } else {
    const state = row.upstream = {};
    state.beforeBaseline = await timed(statusRead);
    row.samples.push(await timed(baseline));
    state.beforeTrigger = await timed(statusRead);
    state.triggerAtMs = now();
    await trigger();
    await pause(triggerSettleMs);
    state.slowBefore = await timed(statusRead);
    row.samples.push(await timed(middle));
    state.slowAfter = await timed(statusRead);
    const restoreAtMs = state.slowBefore.endMs + recoveryProfile.duringMs + restoreSettleMs;
    await pause(Math.max(0, Math.ceil(restoreAtMs - now())));
    state.restoredBefore = await timed(statusRead);
    row.samples.push(await timed(followup));
    state.restoredAfter = await timed(statusRead);
    row.completeAtMs = state.restoredAfter.endMs;
  }
  emit(row);
  return row;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4, "usage: bounded-requests-probe.mjs <configPath> <outRaw>");
  const [file, out] = process.argv.slice(2), config = JSON.parse(readFileSync(file, "utf8"));
  const raw = [];
  try {
    await runBoundedRequests(config, { trigger: () => writeFileSync("/recovery/start", "", { flag: "wx", mode: 0o600 }), emit: row => raw.push(row) });
    assessBoundedRequests({ phase: config.phase, source: config.source, expected: config.expected,
      targetOrigin: config.target.origin, upstreamOrigin: config.upstream, raw });
  } finally {
    if (raw.length) writeFileSync(out, raw.map(row => JSON.stringify(row)).join("\n") + "\n", { flag: "wx" });
  }
}
