import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { records } from "../marketplace/fixtures.mjs";
import { assessBoundedRequests, boundedRecordPath, boundedRequestProfile, boundedStatusPath } from "./bounded-requests.mjs";
import { runBoundedRequests } from "./bounded-requests-probe.mjs";
import { recoveryProfile } from "./dependency-recovery-contract.mjs";

const targetOrigin = "http://localhost:8080", edgeOrigin = "https://localhost:8080";
const upstreamOrigin = "http://hardening-0123456789ab-cell-upstream:8080";
const expected = records().item_1;
const { normalDeadlineMs, clientDeadlineMs, headerValueBytes } = boundedRequestProfile;
const bootId = "11111111-1111-4111-8111-111111111111";
const wallNow = () => "2026-11-20T00:00:00.000Z";
const reply = (status = 200, body = expected) => ({ status, contentType: "application/json",
  bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64"), complete: true, error: null });
const failed = error => ({ status: null, contentType: null, bodyBase64: "", complete: false, error });
const configFor = (phase, source, origin) => ({ phase, source, target: { origin, ...(origin === edgeOrigin ? { caPem: "private fixture CA" } : {}) },
  upstream: upstreamOrigin, expected, budget: { boundedRequests: boundedRequestProfile } });

async function fixture({ phase = "request-limit", source = "api", origin = targetOrigin, outcomes = [], missedSlowRead = false,
  fixtureContactsUpstream = false } = {}) {
  const raw = [], calls = [], config = configFor(phase, source, origin);
  let ms = 0, triggerTime, hit = 0, triggered = 0, active = false;
  const clock = () => ({ monotonicNs: "123000000", bootId });
  const nowNs = () => 123000000n + BigInt(Math.round(ms * 1e6));
  const { delayMs, duringMs } = recoveryProfile;
  const reads = { normal: 27, slow: 0, restored: 0 }, responses200 = { normal: 27, slow: 0, restored: 0 };
  const elapsed = () => triggerTime === undefined ? null : ms - triggerTime;
  const state = () => elapsed() === null ? "normal" : elapsed() < duringMs ? "slow" : "restored";
  const read = async (spec, ca) => {
    assert.equal(active, false, "overlapping requests");
    active = true;
    calls.push({ spec, ca });
    await Promise.resolve();
    try {
      if (spec.url === upstreamOrigin + boundedStatusPath) {
        const body = { phase: state(), elapsedSinceStartMs: elapsed(), delayMs, windowMs: duringMs, reads, responses200 };
        ms += 2;
        return reply(200, body);
      }
      assert.equal(spec.url, origin + boundedRecordPath);
      const received = outcomes[hit++] ?? (source === "api" && state() === "slow" ? failed("deadline") : reply());
      if ((source === "api" || fixtureContactsUpstream) && !(state() === "slow" && missedSlowRead)) {
        reads[state()]++;
        if (received.status === 200 && state() !== "slow") responses200[state()]++;
      }
      ms += received.error === "deadline" ? spec.deadlineMs : 5;
      return received;
    } finally { active = false; }
  };
  await runBoundedRequests(config, { emit: row => raw.push(row), clock, nowNs, wallNow, read,
    trigger: () => { triggered++; triggerTime = ms + 25; }, pause: async duration => { ms += duration; } });
  const input = { raw, phase, source, targetOrigin: origin, upstreamOrigin, expected };
  return { raw, calls, input, triggered, assess: () => assessBoundedRequests(input) };
}

test("one complete bounded header observation per private path, either accept or reject", async () => {
  for (const [origin, status, result, layer] of [
    [targetOrigin, 200, "accepted", "application"], [edgeOrigin, 431, "rejected", "deployed-edge-path"],
    [edgeOrigin, 400, "rejected", "deployed-edge-path"],
  ]) {
    const run = await fixture({ origin, outcomes: [reply(), status === 200 ? reply() : reply(status, {}), reply()] });
    assert.equal(run.triggered, 0);
    assert.deepEqual(run.calls.map(({ spec, ca }) => [spec.method, spec.url, spec.headerValueBytes, spec.deadlineMs, ca]),
      [0, headerValueBytes, 0].map(n => ["GET", origin + boundedRecordPath, n, normalDeadlineMs, origin === edgeOrigin ? "private fixture CA" : undefined]));
    const actual = run.assess();
    assert.equal(actual.status, result);
    assert.equal(actual.healthy && actual.baselineHealthy && actual.followupHealthy, true);
    assert.deepEqual(actual.observation, { kind: "complete-header-request", outcome: result, statusCode: status, error: null,
      elapsedMs: 5, layer, upstreamDelayObserved: null });
  }
});

test("limit unexpectedly failing app responses are retained rather than rejected as invalid evidence", async () => {
  for (const [outcomes, why, observation] of [
    [[reply(200, {}), reply(431, {}), reply()], "baseline-record", "rejected"],
    [[reply(), reply(), failed("ECONNREFUSED")], "followup-record", "accepted"],
    [[reply(), failed("ECONNRESET"), reply()], "boundary-response", "unexpected-response"],
    [[reply(), failed("invalid-http-response"), reply()], "boundary-response", "unexpected-response"],
    [[reply(), reply(200, { id: "item_1" }), reply()], "boundary-response", "unexpected-response"],
    [[reply(), reply(503, {}), reply()], "boundary-response", "unexpected-response"],
  ]) {
    const actual = (await fixture({ outcomes })).assess();
    assert.equal(actual.status, "target-failure");
    assert.equal(actual.healthy, false);
    assert.equal(actual.reason, why);
    assert.equal(actual.observation.outcome, observation);
  }
});

test("deadline checks use a single client deadline with API slow-read proof or an idle fixture control", async () => {
  for (const source of ["api", "fixture"]) {
    const { assess, raw, triggered, calls } = await fixture({ phase: "request-timeout", source });
    assert.equal(triggered, 1);
    const target = i => i === 1 || i === 4 || i === 7;
    assert.deepEqual(calls.map(({ spec }) => [spec.url, spec.deadlineMs, spec.headerValueBytes]), Array.from({ length: 9 }, (_, i) =>
      [target(i) ? targetOrigin + boundedRecordPath : upstreamOrigin + boundedStatusPath, i === 4 ? clientDeadlineMs : normalDeadlineMs, 0]));
    const actual = assess();
    assert.equal(actual.status, source === "api" ? "client-deadline" : "fixture-control");
    assert.equal(actual.healthy, true);
    assert.equal(actual.observation.upstreamDelayObserved, source === "api");
    assert.equal(actual.observation.error, source === "api" ? "deadline" : null);
    assert.equal(actual.completeAtMs, raw[1].upstream.restoredAfter.endMs);
  }
});

test("valid apparatus distinguishes wrong source, early app errors, and failed restoration", async () => {
  for (const [options, why, delay, appStatus] of [
    [{ missedSlowRead: true }, "api-delay-not-observed", false, null],
    [{ outcomes: [reply(), reply(502, {}), reply()] }, "api-client-deadline-not-observed", true, 502],
    [{ outcomes: [reply(), failed("ETIMEDOUT"), reply()] }, "api-client-deadline-not-observed", true, null],
    [{ outcomes: [reply(), failed("ECONNRESET"), failed("ECONNREFUSED")] }, "followup-record", true, null],
    [{ source: "fixture", fixtureContactsUpstream: true }, "fixture-upstream-contact", false, 200],
    [{ source: "fixture", outcomes: [reply(), failed("deadline"), reply()] }, "fixture-control-record", false, null],
  ]) {
    const actual = (await fixture({ phase: "request-timeout", ...options })).assess();
    assert.equal(actual.status, "target-failure");
    assert.equal(actual.reason, why);
    assert.equal(actual.observation.upstreamDelayObserved, delay);
    assert.equal(actual.observation.statusCode, appStatus);
  }
});

test("missing, invented and inconsistent bounded receipts fail offline replay", async () => {
  for (const [mutate, why] of [
    [r => r.samples.pop(), /missing\/extra bounded reads/],
    [r => { r.samples[1].headerValueBytes = headerValueBytes; }, /fixed request/],
    [r => { r.samples[1].url += "?other=1"; }, /fixed request/],
    [r => { r.samples[1].receipt.bodyBase64 = "A="; }, /invalid response bytes/],
    [r => { r.samples[1].receipt = failed("EMFILE"); }, /local probe failure/],
    [r => { r.samples[1].endMs -= 20; }, /before its deadline/],
    [r => { r.samples[1].endMs += 60; r.upstream.slowAfter.startMs += 60; r.upstream.slowAfter.endMs += 60; }, /trigger timing/],
    [r => {
      r.samples[1].endMs += 60;
      const snapshot = r.upstream.slowAfter;
      snapshot.startMs += 60; snapshot.endMs += 60;
      const state = JSON.parse(Buffer.from(snapshot.receipt.bodyBase64, "base64").toString("utf8"));
      snapshot.receipt = reply(200, { ...state, elapsedSinceStartMs: state.elapsedSinceStartMs + 60 });
    }, /client deadline capture missed the upstream delay bound/],
    [r => { r.completeAtMs -= 1; }, /incorrect bounded completion time/],
    [r => { r.upstream.slowBefore.receipt = failed("ECONNREFUSED"); }, /status unavailable/],
    [r => { delete r.upstream.slowAfter; }, /invalid recovery snapshots/],
    [r => { r.upstream.slowBefore.receipt = r.upstream.beforeTrigger.receipt; }, /wrong recovery phase/],
  ]) {
    const run = await fixture({ phase: "request-timeout" });
    mutate(run.raw[1]);
    assert.throws(run.assess, why);
  }
  const run = await fixture();
  assert.throws(() => assessBoundedRequests({ ...run.input, targetOrigin: edgeOrigin }), /identity differs/);
  assert.throws(() => assessBoundedRequests({ ...run.input, source: "fixture" }), /identity differs/);
});

test("a delayed upstream completion must have had time to finish since its read started", async () => {
  const { raw, assess } = await fixture({ phase: "request-timeout" });
  const states = raw[1].upstream;
  // A cancelled slow read may still finish upstream by the restored window.
  const completeOne = row => {
    const state = JSON.parse(Buffer.from(row.receipt.bodyBase64, "base64"));
    state.responses200.slow = 1;
    row.receipt = reply(200, state);
  };
  assert.equal(assess().status, "client-deadline");
  completeOne(states.restoredBefore);
  completeOne(states.restoredAfter);
  assert.equal(assess().status, "client-deadline");
  // At slowBefore no slow read had started. At slowAfter one had started,
  // but less than the private upstream delay had elapsed between snapshots.
  completeOne(states.slowAfter);
  assert.throws(assess, /before the upstream delay/);
});

test("unauthorized configuration fails before clocks, trigger or HTTP", async () => {
  const never = () => assert.fail("invalid config advanced to I/O");
  for (const config of [
    { ...configFor("request-limit", "api", targetOrigin), upstream: "http://example.com:8080" },
    configFor("request-limit", "api", "http://localhost:8181"),
    configFor("request-limit", "api", targetOrigin + "/"),
    configFor("request-timeout", "api", "http://localhost:8080@example.com"),
    { ...configFor("request-limit", "api", edgeOrigin), target: { origin: edgeOrigin } },
    { ...configFor("request-timeout", "api", targetOrigin), budget: { boundedRequests: { ...boundedRequestProfile, clientDeadlineMs: 1000 } } },
    configFor("retired-mode", "api", targetOrigin),
  ]) await assert.rejects(runBoundedRequests(config, { emit: never, trigger: never, clock: never, read: never }), /private benchmark|requires the private CA|budget differs|phase/);
});

test("ordinary HTTP transport sends the whole fixed header once and does not follow redirects", async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push([req.method, req.url, req.headers["user-agent"]?.length ?? 0]);
    if (req.headers["user-agent"]) {
      res.writeHead(302, { Location: "/should-not-request" });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(expected));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address(), get = http.get;
  // Remap only the fixture's authorized address to an ephemeral loopback port.
  t.mock.method(http, "get", (url, options, emit) => {
    assert.equal(url, targetOrigin + boundedRecordPath);
    return get(`http://localhost:${port}${boundedRecordPath}`, options, emit);
  });
  const raw = [], config = configFor("request-limit", "fixture", targetOrigin);
  await runBoundedRequests(config, { emit: row => raw.push(row), clock: () => ({ monotonicNs: String(process.hrtime.bigint()), bootId }), wallNow });
  const actual = assessBoundedRequests({ raw, phase: config.phase, source: config.source, expected, targetOrigin, upstreamOrigin });
  assert.equal(actual.status, "target-failure");
  assert.equal(actual.observation.statusCode, 302);
  assert.deepEqual(seen, [0, headerValueBytes, 0].map(size => ["GET", boundedRecordPath, size]));
});

test("ordinary HTTP transport terminates a delayed read at its own deadline and proceeds once", async t => {
  let visits = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, boundedRecordPath);
    if (++visits === 2) {
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      try { await sleep(normalDeadlineMs + 100, undefined, { signal: abort.signal }); }
      catch (error) { if (error.name === "AbortError") return; throw error; }
    }
    if (res.destroyed) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(expected));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address(), get = http.get;
  t.mock.method(http, "get", (url, options, emit) => {
    assert.equal(url, targetOrigin + boundedRecordPath);
    return get(`http://localhost:${port}${boundedRecordPath}`, options, emit);
  });
  const raw = [], config = configFor("request-limit", "fixture", targetOrigin);
  await runBoundedRequests(config, { emit: row => raw.push(row), clock: () => ({ monotonicNs: String(process.hrtime.bigint()), bootId }), wallNow });
  const actual = assessBoundedRequests({ raw, phase: config.phase, source: config.source, expected, targetOrigin, upstreamOrigin });
  assert.equal(visits, 3);
  assert.equal(actual.status, "target-failure");
  assert.equal(actual.baselineHealthy && actual.followupHealthy, true);
  assert.equal(actual.observation.error, "deadline");
});
