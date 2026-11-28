// The idle-close check's own behavior, without Docker: argument checks, the owned-container
// teardown against a fake Docker client, the window, expiry, spread and idle rules on fixed event
// sequences (no timer decides them), and the whole check against stand-in apps whose pools keep a
// chosen idle bound, asserted only in ways a slow runner cannot flip. A functional check of the
// checker, not a measurement.
import assert from "node:assert/strict";
import { createServer, request, Agent } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { assertPasses, attemptKey, boundMs, checkImage, checkOptions, closingUpstream, firstWait, inconclusive, judgeRead, keepAliveMs, marginMs, ownerKey, parseArgs,
  planProbe, probeWindow, slackMs, summary, waitUntil, warmedSet } from "./idle-close.mjs";

const id = (n) => String(n).repeat(64).slice(0, 64);

// A Docker client that records every call and answers from `answer` (args to stdout, or a throw).
// `ports` lists the upstream port each create was given, so a test can follow that one listener.
function fakeDocker(answer) {
  const calls = [], ports = [];
  const run = async (args, options) => {
    calls.push(args);
    const base = args[0] === "create" && args.find((a) => a.startsWith("API_BASE="));
    if (base) ports.push(Number(new URL(base.slice("API_BASE=".length)).port));
    return answer(args, options, calls);
  };
  return { run, calls, ports };
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const owned = (runId, extra = {}) => JSON.stringify([{ Id: extra.Id, Config: { Labels: { [ownerKey]: runId } }, ...extra }]);

// Whether nothing accepts a connection on `port` any more.
const refuses = (port) => new Promise((resolve) => {
  const socket = connect(port, "127.0.0.1");
  socket.on("connect", () => { socket.destroy(); resolve(false); });
  socket.on("error", () => resolve(true));
});
// The upstreams a check opened, through its `onUpstream` seam.
const follow = () => { const seen = []; return { seen, onUpstream: (upstream) => seen.push(upstream) }; };
// The check's own upstream, given to the fake create on `port`, is closed and refuses connections.
async function assertUpstreamClosed({ seen }, docker) {
  assert.equal(seen.length, 1, "one upstream opened");
  assert.equal(seen[0].server.listening, false, "the upstream is still listening");
  assert.equal(docker.ports.length, 1, "the create was given the upstream's port");
  assert.ok(await refuses(docker.ports[0]), `the upstream on port ${docker.ports[0]} still accepts connections`);
}

test("an empty, unknown or repeated read, a reserved label or an unsafe bound is refused before the upstream opens or Docker runs", async () => {
  for (const [options, message] of [
    [{ names: [] }, /no reads selected/], [{ names: ["catalog", "nope"] }, /unknown read "nope"/], [{ names: [""] }, /unknown read ""/],
    [{ names: ["items", "items"] }, /selected twice/], [{ names: ["catalog"], labels: [`${ownerKey}=x`] }, /reserved/],
    [{ names: ["catalog"], labels: [`${attemptKey}=x`] }, /reserved/], [{ names: ["catalog"], labels: ["no-value"] }, /key=value/],
    [{ names: ["catalog"], bound: 4600 }, /must end before/], [{ names: ["catalog"], bound: 0 }, /must end before/],
  ]) {
    const docker = fakeDocker(() => assert.fail("Docker must not run")), upstreams = follow();
    await assert.rejects(checkImage("img", { ...options, docker: docker.run, runId: "r", onUpstream: upstreams.onUpstream }), message);
    assert.deepEqual(docker.calls, []);
    assert.deepEqual(upstreams.seen, [], "no upstream was opened");
  }
  assert.throws(() => parseArgs(["img", "catalog,"]), /unknown read ""/);
  assert.throws(() => parseArgs(["img", "FOO=bar"]), /unknown read "FOO=bar"/);
  assert.throws(() => parseArgs(["img", "--bound=4"]), /unknown option/);
  assert.throws(() => parseArgs(["img", "catalog", "lower=1"]), /NAME=value/);
  assert.deepEqual(parseArgs(["img", "catalog", "A=1", "--bound-ms=1000", "--no-reuse", "--label=agent.owner=codex"]),
    { image: "img", names: ["catalog"], env: ["A=1"], labels: ["agent.owner=codex"], bound: 1000, jsonOnly: false, reuse: false });
  checkOptions({ names: ["catalog", "marketplace", "items"] });
  assert.ok(boundMs + marginMs < 5000);
});

test("a create that fails before any container ID exists settles, closes the upstream and reports its cleanup unconfirmed", async () => {
  const started = Date.now(), upstreams = follow();
  const docker = fakeDocker((args) => {
    if (args[0] === "create") throw new Error("docker create: exit 1\nCannot connect to the Docker daemon");
    if (args[0] === "ps") return "";
    assert.fail(`unexpected ${args.join(" ")}`);
  });
  const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r1", window: 50, onUpstream: upstreams.onUpstream }).then(() => assert.fail("passed"), (e) => e);
  assert.match(error.message, /Cannot connect/);
  assert.equal(error.cleanup.complete, false);
  assert.equal(error.cleanup.created, null);
  assert.equal(error.cleanup.unacknowledged.outcome, "unconfirmed");
  assert.match(error.cleanup.failures[0].error, /cleanup is unconfirmed/);
  await assertUpstreamClosed(upstreams, docker);
  assert.ok(Date.now() - started < 5000);
  const create = docker.calls[0];
  assert.ok(create.includes(`${ownerKey}=r1`) && create.includes(`${attemptKey}=r1`) && create.includes("--pull"));
  // Only label lookups follow: nothing is inspected, read or removed by name.
  assert.ok(docker.calls.slice(1).every((args) => args[0] === "ps"), JSON.stringify(docker.calls));
});

test("a Docker client that cannot start is not an unacknowledged create", async () => {
  const docker = fakeDocker((args) => {
    if (args[0] === "create") throw Object.assign(new Error("docker create: docker not found"), { sent: false });
    if (args[0] === "ps") return "";
    assert.fail(args.join(" "));
  });
  const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r2", window: 50 }).then(() => assert.fail("passed"), (e) => e);
  assert.match(error.message, /docker not found/);
  assert.equal(error.cleanup.unacknowledged, null);
  assert.equal(error.cleanup.complete, true);
});

test("a create acknowledged late is found by its attempt label and removed by its confirmed ID", async () => {
  let looks = 0;
  const late = id(7);
  const docker = fakeDocker((args) => {
    if (args[0] === "create") throw new Error("docker create: timeout after 30000 ms");
    if (args[0] === "ps") {
      const filter = args[args.indexOf("--filter") + 1];
      if (filter === `label=${attemptKey}=r3`) return ++looks < 2 ? "" : late;
      return filter === `id=${late}` || filter === `label=${ownerKey}=r3` ? late : "";
    }
    if (args[0] === "container") return owned("r3", { Id: late });
    if (args[0] === "rm") return args.at(-1);
    assert.fail(args.join(" "));
  });
  const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r3", window: 2000 }).then(() => assert.fail("passed"), (e) => e);
  assert.match(error.message, /timeout/);
  assert.equal(error.cleanup.unacknowledged.outcome, "removed");
  assert.deepEqual(error.cleanup.recovered, [late]);
  assert.equal(error.cleanup.complete, true);
  assert.deepEqual(docker.calls.filter((args) => args[0] === "rm"), [["rm", "-f", "-v", late]]);
});

test("a stalled attempt lookup gets only the time left in the window, none starts after it, and the owner sweep still runs", async () => {
  const window = 400, lookups = [], owner = `label=${ownerKey}=r6`;
  const docker = fakeDocker(async (args, options) => {
    if (args[0] === "create") throw new Error("docker create: timeout after 30000 ms");
    if (args[0] === "ps" && args.includes(`label=${attemptKey}=r6`)) {
      assert.ok(Number.isInteger(options.timeout), "an attempt lookup carries a timeout");
      const begun = performance.now();
      lookups.push({ begun, timeout: options.timeout });
      // A daemon that never answers: the lookup ends only at its own timeout, empty-handed.
      await new Promise((done) => setTimeout(done, options.timeout));
      return "";
    }
    if (args[0] === "ps") { assert.deepEqual(options, {}, "the owner sweep keeps the normal deadline"); return ""; }
    assert.fail(args.join(" "));
  });
  const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r6", window }).then(() => assert.fail("passed"), (e) => e);
  const settled = performance.now();
  assert.ok(lookups.length >= 1, "the attempt was looked for");
  // The window opens just before the first lookup, so no lookup may run past the first's start plus the window.
  const first = lookups[0].begun;
  for (const { begun, timeout } of lookups) assert.ok(begun - first + timeout <= window + 5, JSON.stringify({ begun: begun - first, timeout }));
  assert.ok(lookups.reduce((sum, l) => sum + l.timeout, 0) <= window, JSON.stringify(lookups));
  assert.ok(settled - first < window + 250, `the search and sweep took ${Math.round(settled - first)} ms for a ${window} ms window`);
  const ps = docker.calls.filter((args) => args[0] === "ps");
  assert.equal(ps.at(-1).at(-3), owner, "the owner sweep runs after the search");
  assert.equal(error.cleanup.unacknowledged.outcome, "unconfirmed");
  assert.equal(error.cleanup.complete, false);
});

test("a failed attempt lookup is kept, the owner sweep still runs and removes what it finds by confirmed ID", async () => {
  const late = id(5);
  const docker = fakeDocker((args) => {
    if (args[0] === "create") throw new Error("docker create: timeout after 30000 ms");
    if (args[0] === "ps") {
      const filter = args[args.indexOf("--filter") + 1];
      if (filter === `label=${attemptKey}=r7`) throw new Error("docker ps: exit 1\nCannot connect to the Docker daemon");
      return filter === `label=${ownerKey}=r7` || filter === `id=${late}` ? late : "";
    }
    if (args[0] === "container") return owned("r7", { Id: late });
    if (args[0] === "rm") return args.at(-1);
    assert.fail(args.join(" "));
  });
  const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r7", window: 5000 }).then(() => assert.fail("passed"), (e) => e);
  assert.equal(docker.calls.filter((args) => args.includes(`label=${attemptKey}=r7`)).length, 1, "a failed lookup ends the search");
  assert.deepEqual(error.cleanup.recovered, [late]);
  assert.deepEqual(docker.calls.filter((args) => args[0] === "rm"), [["rm", "-f", "-v", late]]);
  assert.equal(error.cleanup.unacknowledged.outcome, "unconfirmed");
  assert.ok(error.cleanup.failures.some((f) => f.resource.includes(attemptKey) && /Cannot connect/.test(f.error)), JSON.stringify(error.cleanup.failures));
  assert.equal(error.cleanup.complete, false);
});

test("a lookup line that is not a full container ID is a failure and is never inspected or removed", async () => {
  const created = "ab3".repeat(22).slice(0, 64);
  for (const odd of ["abc123", "i1569-name", created.slice(0, 12), created.toUpperCase(), `${created}0`]) {
    let removed = false;
    const docker = fakeDocker((args) => {
      if (args[0] === "create") return created;
      if (args[0] === "container") return owned("r8", { Id: created });
      if (args[0] === "start") throw new Error("docker start: exit 1\nno such image");
      // The sweeps return the odd line beside the real ID; the lookup by ID is clean.
      if (args[0] === "ps") return removed ? "" : args.includes(`id=${created}`) ? created : `${odd}\n${created}`;
      if (args[0] === "rm") { removed = true; return args.at(-1); }
      assert.fail(args.join(" "));
    });
    const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r8", window: 50 }).then(() => assert.fail("passed"), (e) => e);
    for (const args of docker.calls.filter((a) => ["container", "rm", "start", "logs"].includes(a[0]))) assert.equal(args.at(-1), created, odd);
    assert.deepEqual(error.cleanup.removed, [created]);
    assert.ok(error.cleanup.failures.some((f) => /not a full container ID/.test(f.error)), odd);
    assert.equal(error.cleanup.complete, false);
  }
});

test("a lookup by ID that returns a short ID records no removal and runs no rm", async () => {
  const created = id(3);
  for (const out of [created.slice(0, 12), `${created}\n${id(4)}`, "not-an-id"]) {
    const docker = fakeDocker((args) => {
      if (args[0] === "create") return created;
      if (args[0] === "container") return owned("r9", { Id: created });
      if (args[0] === "start") throw new Error("docker start: exit 1\nno such image");
      if (args[0] === "ps") return args.includes(`id=${created}`) ? out : created;
      assert.fail(`must not run docker ${args.join(" ")}`);
    });
    const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r9", window: 50 }).then(() => assert.fail("passed"), (e) => e);
    assert.ok(!docker.calls.some((args) => args[0] === "rm"), out);
    assert.deepEqual(error.cleanup.removed, [], out);
    assert.ok(error.cleanup.failures.some((f) => f.resource === `container ${created}` && /removal is unconfirmed/.test(f.error)), JSON.stringify(error.cleanup.failures));
    assert.equal(error.cleanup.complete, false);
  }
  // A clean empty lookup by ID is a container already gone: recorded, with no rm.
  const gone = fakeDocker((args) => {
    if (args[0] === "create") return created;
    if (args[0] === "container") return owned("r10", { Id: created });
    if (args[0] === "start") throw new Error("docker start: exit 1\nno such image");
    if (args[0] === "ps") return args.includes(`id=${created}`) ? "" : created;
    assert.fail(`must not run docker ${args.join(" ")}`);
  });
  const error = await checkImage("img", { names: ["catalog"], docker: gone.run, runId: "r10", window: 50 }).then(() => assert.fail("passed"), (e) => e);
  assert.deepEqual(error.cleanup.removed, [created]);
  assert.equal(error.cleanup.complete, true);
});

test("a failed start and a failed removal both surface, and only the confirmed ID is ever removed", async () => {
  const created = id(1), upstreams = follow();
  const docker = fakeDocker((args) => {
    if (args[0] === "create") return created;
    if (args[0] === "container") return owned("r4", { Id: created });
    if (args[0] === "start") throw new Error("docker start: exit 1\nport is already allocated");
    if (args[0] === "ps") return created;
    if (args[0] === "rm") throw new Error("docker rm: exit 1\nremoval of container is already in progress");
    assert.fail(args.join(" "));
  });
  const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r4", window: 50, onUpstream: upstreams.onUpstream }).then(() => assert.fail("passed"), (e) => e);
  assert.match(error.message, /port is already allocated/);
  assert.equal(error.cleanup.complete, false);
  assert.deepEqual(error.cleanup.removed, []);
  assert.match(error.cleanup.failures[0].error, /removal of container is already in progress/);
  for (const args of docker.calls.filter((a) => ["start", "rm", "container", "logs"].includes(a[0]))) assert.equal(args.at(-1), created);
  await assertUpstreamClosed(upstreams, docker);
});

test("a container that does not carry this run's owner label is neither started nor removed", async () => {
  const created = id(2);
  const docker = fakeDocker((args) => {
    if (args[0] === "create") return created;
    if (args[0] === "container") return owned("someone-else", { Id: created });
    if (args[0] === "ps") return created;
    assert.fail(`must not run docker ${args[0]}`);
  });
  const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r5", window: 50 }).then(() => assert.fail("passed"), (e) => e);
  assert.match(error.message, /refusing unowned container/);
  assert.match(error.cleanup.failures[0].error, /refusing unowned container/);
  assert.ok(!docker.calls.some((args) => args[0] === "start" || args[0] === "rm"));
});

// One request's outcome, settled however it ends: the status once the body ends, the request's
// error code, or "response:" and the code when the answer breaks off after its head. Bounded at 5 s.
function statusOf(options) {
  return new Promise((resolve) => {
    const req = request({ ...options, signal: AbortSignal.timeout(5000) }, (res) => {
      res.on("error", (e) => resolve(`response:${e.code}`));
      res.on("end", () => resolve(res.statusCode));
      res.resume();
    });
    req.on("error", (e) => resolve(e.code));
    req.end();
  });
}

test("an answer that breaks off after its head settles as a response error, not a status or a hang", async (t) => {
  const server = createServer();
  server.on("connection", (socket) => socket.once("data", () => {
    socket.write("HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc");
    setImmediate(() => socket.destroy());
  }));
  t.after(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  assert.match(String(await statusOf({ port: server.address().port, path: "/", agent: false })), /^response:/);
});

test("the upstream records each request's idle, answers before the close and resets a connection idle past its keep-alive", async (t) => {
  // Advance the upstream's clock between real requests, not by waiting on the scheduler.
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const upstream = closingUpstream({ "/a": { a: 1 } }, 300);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => {
    agent.destroy();
    await upstream.close();
    assert.equal(upstream.server.listening, false);
  });
  await new Promise((done) => upstream.server.listen(0, "127.0.0.1", done));
  const port = upstream.server.address().port;
  const fetchOnce = () => statusOf({ port, path: "/a", agent });
  assert.equal(await fetchOnce(), 200);
  const secondAt = now += 100.25;
  assert.equal(await fetchOnce(), 200);
  now += 350.25;
  assert.equal(await fetchOnce(), "ECONNRESET");
  const answered = upstream.events.filter((e) => e.kind === "answered");
  assert.equal(answered.length, 2);
  assert.equal(answered[0].idle, null);
  assert.equal(answered[1].idle, 100);
  assert.equal(answered[1].connection, answered[0].connection);
  // Each request's arrival is on the monotonic clock, unrounded, and the connection keeps its last answer after it closes.
  assert.equal(answered[1].arrival, secondAt);
  assert.equal(upstream.lastAnswerOf(answered[0].connection), secondAt);
  assert.equal(upstream.lastAnswerOf(99), null);
  const closed = upstream.events.filter((e) => e.kind === "closedIdle");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].connection, answered[0].connection);
  assert.equal(closed[0].idle, 350);
  assert.equal(closed[0].lastPath, "/a");
});

test("the upstream takes a request's arrival from the read that completed its head, before any answer is prepared", async (t) => {
  // Only the double's response work is slow: a serializer that spins 280 ms.
  let serializing = null;
  const slow = { toJSON() { serializing = performance.now(); while (performance.now() - serializing < 280); return { a: 1 }; } };
  const upstream = closingUpstream({ "/slow": slow });
  t.after(() => upstream.close());
  await new Promise((done) => upstream.server.listen(0, "127.0.0.1", done));
  const port = upstream.server.address().port;
  const status = await statusOf({ port, path: "/slow", agent: false });
  assert.equal(status, 200);
  const [answered] = upstream.events.filter((e) => e.kind === "answered");
  // The arrival precedes the response work; the answer time, kept apart, follows it.
  assert.ok(answered.arrival <= serializing, JSON.stringify({ arrival: answered.arrival, serializing }));
  assert.ok(answered.answeredAt - answered.arrival >= 280, JSON.stringify(answered));
  assert.equal(upstream.lastAnswerOf(answered.connection), answered.answeredAt);
});

// Upstream events as closingUpstream records them, at chosen monotonic times in ms, so the window,
// expiry, spread and idle rules below are decided by event order and these numbers alone.
const T = "/catalog/records/record_1", limits = probeWindow();
const answer = (connection, arrival, { idle = null, took = 1, path = T } = {}) => ({ at: 0, connection, kind: "answered", path, idle, arrival, answeredAt: arrival + took });
const shut = (connection, time) => ({ at: 0, connection, kind: "closed", time });
const isRequest = (e) => e.kind === "answered" && e.path === T;
// Two warm bursts: connection i opens at 900 + i ms, and its reuse in the second burst finishes at lasts[i].
const warmUp = (lasts) => [...lasts.map((_, i) => answer(i, 900 + i)), ...lasts.map((last, i) => answer(i, last - 1, { idle: last - 902 - i }))];
// Probe requests on connections of their own, numbered from `from`.
const fresh = (arrivals, from = 10) => arrivals.map((t, i) => answer(from + i, t));
// One read judged as checkImage judges it: planned at the end of the first wait (or `planAt`) from
// the warm-up's events and the idle's by then, the probe's events kept only if one was made.
function judged({ warm, idle = [], probe = [], planAt }) {
  const conns = warmedSet(warm, T), now = planAt ?? firstWait(conns, limits) ?? 0;
  const plan = planProbe(conns, [...warm, ...idle.filter((e) => (e.time ?? e.arrival) <= now)], now, limits);
  return judgeRead({ target: T, warmStatuses: warm.filter(isRequest).map(() => 200), warmEvents: warm, plan, idleEvents: idle,
    statuses: plan.skipped ? [] : probe.filter(isRequest).map(() => 200), probeEvents: plan.skipped ? [] : probe, sentMs: plan.skipped ? null : 4500, limits, bound: boundMs });
}
// A whole result of judged reads, as checkImage returns it.
const resultOf = (reads) => ({ image: "img", boundMs, marginMs, keepAliveMs, slackMs, window: limits, concurrency: 3,
  reads: Object.fromEntries(Object.entries(reads).map(([name, { warm, after }]) => [name, { warm, after }])),
  closedIdle: Object.values(reads).flatMap((r) => r.closedIdle), reusedPastBound: Object.values(reads).flatMap((r) => r.reusedPastBound), cleanup: { complete: true } });

test("a pool that closed its warmed connections in time passes without timing them, even when the probe reaches the upstream late", () => {
  const warm = warmUp([1000, 1001, 1002]), idle = [shut(0, 3000), shut(1, 3001), shut(2, 3002)];
  const safe = judged({ warm, idle, probe: fresh([5503, 5504, 5505]) });
  assert.equal(safe.warm.reused, 3);
  assert.equal(safe.warm.open, 0);
  assert.deepEqual(safe.after.probe, { fromMs: null, toMs: null, arrivals: 3, closedInTime: 3, sentMs: 4500 });
  assert.equal(safe.after.inconclusive, false);
  assertPasses(resultOf({ catalog: safe }));
  // Nothing was left to time, so a late arrival does not undo the evidence.
  const late = judged({ warm, idle, probe: fresh([7000, 7001, 7002]) });
  assert.equal(late.after.inconclusive, false);
  assertPasses(resultOf({ catalog: late }));
  // A probe that reached no upstream proves nothing.
  assert.equal(judged({ warm, idle, probe: [] }).after.inconclusive, true);
});

test("a pool that reuses its warmed connections inside the window fails on the reuse, and one met by the upstream's close fails too", () => {
  const warm = warmUp([1000, 1001, 1002]);
  const late = judged({ warm, probe: [answer(0, 5503, { idle: 4503 }), answer(1, 5504, { idle: 4503 }), answer(2, 5505, { idle: 4503 })] });
  assert.equal(late.after.probe.fromMs, 5503 - 1002);
  assert.equal(late.after.probe.toMs, 5505 - 1000);
  assert.equal(late.after.probe.closedInTime, 0);
  assert.equal(late.after.inconclusive, false);
  assert.equal(late.reusedPastBound.length, 3);
  assert.throws(() => assertPasses(resultOf({ catalog: late })), /idle 4000 ms or more was reused/);
  // Closing a warmed connection at 4.8 s idle, past the window, does not count as closed in time.
  const expired = judged({ warm, probe: [shut(0, 5800), shut(1, 5801), shut(2, 5802), ...fresh([5803])] });
  assert.equal(expired.after.probe.closedInTime, 0);
  const reset = judged({ warm, probe: [{ at: 0, connection: 0, kind: "closedIdle", idle: 5001, arrival: 6001, lastPath: T }, ...fresh([5503])] });
  assert.equal(reset.closedIdle.length, 1);
  assert.throws(() => assertPasses(resultOf({ catalog: reset })), /past its keep-alive/);
});

test("a probe that reached the upstream outside the window is inconclusive, and how soon the app replied does not matter", () => {
  const warm = warmUp([1000, 1001, 1002]), expiry = [shut(0, 5800), shut(1, 5801), shut(2, 5802)];
  // A late timer or an app that holds its requests: the warmed connections, closed at 4.8 s, are timed.
  const slept = judged({ warm, idle: expiry, probe: fresh([5900, 5901, 5902]) });
  assert.equal(slept.after.probe.fromMs, 5900 - 1002);
  assert.equal(slept.after.probe.closedInTime, 0);
  assert.equal(slept.after.inconclusive, true);
  assert.deepEqual(slept.reusedPastBound, []);
  assert.throws(() => assertPasses(resultOf({ catalog: slept })), /catalog: inconclusive: probe requests reached the upstream with the warmed connections idle 4898\.0 to 4902\.0 ms, outside 4500 to below 4750 ms/);
  // One request held past the window is enough.
  assert.equal(judged({ warm, idle: expiry, probe: fresh([5503, 5504, 5760]) }).after.inconclusive, true);
  // Arrivals inside the window pass whatever the answers then took: their reply time is not an input.
  const slow = judged({ warm, idle: expiry, probe: fresh([5503, 5504, 5505]).map((e) => ({ ...e, answeredAt: e.arrival + 600 })) });
  assert.equal(slow.after.probe.toMs, 5505 - 1000);
  assertPasses(resultOf({ catalog: slow }));
});

test("the window and the closed-in-time rule are compared unrounded at their edges", () => {
  const one = (arrival, close) => judged({ warm: warmUp([1000]), probe: [...(close === undefined ? [] : [shut(0, close)]), ...fresh([arrival])] }).after;
  assert.equal(one(5500).probe.fromMs, 4500);
  assert.equal(one(5500).inconclusive, false);
  assert.equal(one(5499.9).inconclusive, true);
  assert.equal(one(5749.99).inconclusive, false);
  assert.equal(one(5750).inconclusive, true);
  // Closed under 4.75 s idle before the first arrival: counted, so a late arrival is not timed.
  assert.deepEqual([one(5760, 5749.9).probe.closedInTime, one(5760, 5749.9).inconclusive], [1, false]);
  // Closed at 4.75 s idle, or only after the first arrival: timed, so the late arrival is inconclusive.
  assert.deepEqual([one(5760, 5750).probe.closedInTime, one(5760, 5750).inconclusive], [0, true]);
  assert.deepEqual([one(5760, 5761).probe.closedInTime, one(5760, 5761).inconclusive], [0, true]);
});

test("a warm-up spread as wide as the window is not probed, and a straggler closed at once does not widen it", () => {
  const narrow = judged({ warm: warmUp([1000, 1249]), probe: fresh([5749]) });
  assert.equal(narrow.warm.spreadMs, 249);
  assert.deepEqual([narrow.after.probe.fromMs, narrow.after.probe.toMs, narrow.after.inconclusive], [4500, 4749, false]);
  const wide = judged({ warm: warmUp([1000, 1250]), probe: fresh([5750]) });
  assert.equal(wide.after.probe.skipped, "the warm answers span 250.0 ms, not less than the window's 250 ms");
  assert.deepEqual(wide.after.statuses, []);
  assert.throws(() => assertPasses(resultOf({ catalog: wide })), /catalog: inconclusive: not probed: the warm answers span 250\.0 ms/);
  // The 4.8 s pool with its last warm request 400 ms late on a pooled connection: no single moment.
  const staggered = judged({ warm: warmUp([1000, 1001, 1400]) });
  assert.match(staggered.after.probe.skipped, /span 400\.0 ms/);
  // The same request on a connection of its own, closed at once: counted, and the pooled ones are
  // timed and found reused past the bound.
  const straggler = judged({ warm: warmUp([1000, 1001, 1400]), idle: [shut(2, 1401)], probe: [answer(0, 5502, { idle: 4502 }), answer(1, 5503, { idle: 4502 })] });
  assert.equal(straggler.warm.open, 2);
  assert.deepEqual([straggler.after.probe.closedInTime, straggler.after.probe.fromMs], [1, 5502 - 1001]);
  assert.throws(() => assertPasses(resultOf({ catalog: straggler })), /idle 4000 ms or more was reused/);
  // No warm answer, no probe.
  assert.equal(judged({ warm: [] }).after.probe.skipped, "no upstream answer in the warm-up");
});

test("a warmed connection closed during the warm-up is counted closed in time, not taken as open", () => {
  // The review's sequence: warm answers 300 ms apart on connections of their own, the first closed
  // 1 ms after its answer, inside the warm-up, so only the second is open and timed.
  const warm = [answer(0, 1000), shut(0, 1002), answer(1, 1300)];
  const read = judged({ warm, probe: fresh([5802, 5803]) });
  assert.deepEqual([read.warm.connections, read.warm.open, read.warm.spreadMs], [2, 1, 0]);
  assert.equal(read.after.probe.skipped, undefined);
  assert.deepEqual([read.after.probe.fromMs, read.after.probe.toMs, read.after.probe.closedInTime], [5802 - 1301, 5803 - 1301, 1]);
  assert.equal(read.after.inconclusive, false);
  // The warm-up's requests are not traffic during the idle.
  assert.equal(read.after.probe.interrupted, undefined);
  assertPasses(resultOf({ catalog: read }), { reuse: false });
  // Six connections of their own, two bursts 400 ms apart, every one closed inside the warm-up: none
  // is open, so the spread does not apply and the probe is made; all six are counted.
  const six = [0, 1, 2, 3, 4, 5].flatMap((i) => { const t = (i < 3 ? 1000 : 1400) + i; return [answer(i, t), shut(i, t + 2)]; });
  const unpooled = judged({ warm: six, probe: fresh([5904, 5905, 5906]) });
  assert.deepEqual([unpooled.warm.open, unpooled.after.probe.skipped, unpooled.after.probe.closedInTime, unpooled.after.inconclusive], [0, undefined, 6, false]);
  assertPasses(resultOf({ catalog: unpooled }), { reuse: false });
  // A connection that closed in the warm-up only after idling past the window is still timed.
  const held = judged({ warm: [answer(0, 1000), answer(1, 1001), shut(0, 5800)], planAt: 5800, probe: fresh([5900]) });
  assert.equal(held.after.probe.closedInTime, 0);
  assert.equal(held.after.inconclusive, true);
});

test("any upstream request between the warm-up and the probe makes the read inconclusive", () => {
  const warm = warmUp([1000, 1001]), probe = [answer(0, 5502, { idle: 2001 }), answer(1, 5503, { idle: 2001 })];
  // The review's control: two ordinary GETs 2.5 s into the wait refresh both warmed connections. Judged
  // from the warm answers alone, the probe looks inside the window and nothing was reused past the bound.
  const unrecorded = judged({ warm, probe });
  assert.deepEqual([unrecorded.after.inconclusive, unrecorded.reusedPastBound.length], [false, 0]);
  assertPasses(resultOf({ catalog: unrecorded }));
  // Recorded, the idle was not one.
  const between = judged({ warm, idle: [answer(0, 3500, { idle: 2499 }), answer(1, 3501, { idle: 2499 })], probe });
  assert.deepEqual(between.after.probe.interrupted, { requests: 2, onWarmed: 2 });
  assert.equal(between.after.inconclusive, true);
  assert.throws(() => assertPasses(resultOf({ catalog: between })),
    /catalog: inconclusive: 2 upstream request\(s\) arrived between the warm-up and the probe \(2 on warmed connections\), so the warmed connections were not idle/);
  // On a connection of its own, too; and a reset during the idle is also a reuse past the keep-alive.
  assert.deepEqual(judged({ warm, idle: [answer(7, 3500)], probe }).after.probe.interrupted, { requests: 1, onWarmed: 0 });
  const reset = judged({ warm, idle: [{ at: 0, connection: 8, kind: "closedIdle", idle: 5001, arrival: 3500, lastPath: T }], probe });
  assert.equal(reset.after.inconclusive, true);
  assert.equal(reset.closedIdle.length, 1);
  // Connection lifecycle events are not requests.
  assert.equal(judged({ warm, idle: [{ at: 0, connection: 9, kind: "accepted", time: 3000 }, shut(9, 3001)], probe }).after.probe.interrupted, undefined);
});

test("a client that opens a connection per request is counted closed in time and fails only the reuse requirement", () => {
  const warm = [0, 1, 2, 3, 4, 5].map((i) => answer(i, 900 + i)), idle = [0, 1, 2, 3, 4, 5].map((i) => shut(i, 902 + i));
  const unpooled = judged({ warm, idle, probe: fresh([5407, 5408, 5409], 20) });
  assert.equal(unpooled.warm.reused, 0);
  assert.equal(unpooled.after.probe.closedInTime, 6);
  assert.equal(unpooled.after.inconclusive, false);
  assert.throws(() => assertPasses(resultOf({ catalog: unpooled })), /no upstream connection was reused before the idle/);
  assertPasses(resultOf({ catalog: unpooled }), { reuse: false });
});

test("the success line ranges over timed probes only and says when nothing needed timing", () => {
  const warm = warmUp([1000, 1001, 1002]);
  const closed = judged({ warm, idle: [shut(0, 3000), shut(1, 3001), shut(2, 3002)], probe: fresh([5503]) });
  const timed = judged({ warm, idle: [shut(0, 5800), shut(1, 5801), shut(2, 5802)], probe: fresh([5503, 5505]) });
  const allClosed = summary(resultOf({ catalog: closed, marketplace: closed }), "img");
  assert.equal(allClosed, "img: no upstream connection reused when probed: 6 warmed connections closed in time before the probe, so no connection needed timing " +
    "(window 4500 to below 4750 ms, bound 4000 ms, upstream close 5000 ms)");
  assert.doesNotMatch(allClosed, /0\.0/);
  assert.equal(summary(resultOf({ catalog: closed, items: timed }), "img"), "img: no upstream connection reused when probed with the timed warmed connections idle " +
    "4501.0 to 4505.0 ms (3 warmed connections closed in time before the probe, not timed) (window 4500 to below 4750 ms, bound 4000 ms, upstream close 5000 ms)");
  assert.match(summary(resultOf({ items: timed }), "img"), /idle 4501\.0 to 4505\.0 ms \(window/);
});

// A stand-in for an app image: a server that reads API_BASE through an HTTP agent, so its pool's idle
// bound is chosen by the test. `agent: false` opens a connection per request. `expireMs` is the
// pool's idle bound, on the upstream's own clock: a connection's idle is the time since the upstream
// wrote its last answer on it (`lastAnswerOf`, read through the check's `onUpstream` seam, which the
// returned client supplies as `onUpstream`), the record the check judges reuse by. When a request
// takes a connection from the pool, every free connection idle `expireMs` or longer is closed and
// never handed out, however late any timer runs; a timer also closes one once it is idle `expireMs`,
// rechecking that idle when it fires, as a real pool's would. So a pause anywhere (before or after the
// upstream answers, or before the stand-in reads the answer) cannot make the pool hand out a
// connection idle `expireMs` or more, nor close one idle less. `pool.reused` lists the idle, at that
// decision, of each pooled connection handed out, and `pool.expired` that of each one closed.
// `delayMs(n)` holds the app's `n`th request (from 1) before it goes upstream, and `holdMs` holds
// every reply after the upstream answered, so the stand-in's own upstream connection closes first.
// The returned client's `intervene(count)` sends `count` upstream GETs on the pool at once.
// The expiry itself is `standInExpiry`, below, so a test can decide it on fixed timestamps.
function standInDocker(runId, agentOptions, { delayMs, holdMs = 0 } = {}) {
  const { expireMs, ...options } = agentOptions ?? {};
  const containerId = id(9);
  const pool = { reused: [], expired: [] }, connectionByPort = new Map();
  let app, upstream, recorder, removed = false;
  // The upstream records a connection's `accepted` event in its own listener, which runs before this
  // one, so the last event is this connection's; its port on this side is the client's local port.
  const onUpstream = (seen) => {
    recorder = seen;
    seen.server.on("connection", (socket) => {
      const accepted = seen.events.at(-1);
      assert.equal(accepted.kind, "accepted");
      connectionByPort.set(socket.remotePort, accepted.connection);
    });
  };
  const expiryOf = (socket) => {
    socket.upstreamConnection ??= connectionByPort.get(socket.localPort);
    return standInExpiry(socket, (connection) => recorder?.lastAnswerOf(connection), performance.now(), expireMs);
  };
  const docker = fakeDocker(async (args) => {
    if (args[0] === "create") {
      const base = args[args.findIndex((a) => a.startsWith("API_BASE="))].slice("API_BASE=".length).replace("host.docker.internal", "127.0.0.1");
      const agent = agentOptions && new Agent(options);
      // The timer: close a free connection once the upstream has seen it idle `expireMs`, and if it
      // fires before that (it counts from when the stand-in read the answer), wait out the rest.
      const due = (socket) => {
        if (socket.destroyed) return;
        const { idle, expired } = expiryOf(socket);
        if (!expired) { socket.expiry = setTimeout(due, expireMs - idle, socket); return; }
        pool.expired.push(Math.round(idle));
        socket.destroy();
      };
      if (expireMs) {
        agent.on("free", (socket) => {
          clearTimeout(socket.expiry);
          socket.expiry = setTimeout(due, expireMs, socket);
        });
      }
      // The pool's expiry at checkout: drop every free connection idle `expireMs` or longer before
      // the agent picks one, so a stale connection is never reused even if its timer has not fired,
      // and note the idle of each one left, the idle at which the agent may hand it out.
      const expire = () => {
        for (const [name, free] of Object.entries(agent.freeSockets)) {
          for (const socket of [...free]) {
            // A connection closed but not yet removed by the agent is removed now and never handed out.
            const decision = socket.destroyed ? null : expiryOf(socket);
            if (decision && !decision.expired) { socket.idleAtCheckout = decision.idle; continue; }
            free.splice(free.indexOf(socket), 1);
            if (!decision) continue;
            pool.expired.push(Math.round(decision.idle));
            socket.destroy();
          }
          if (!free.length) delete agent.freeSockets[name];
        }
      };
      upstream = (path) => new Promise((resolve) => {
        if (expireMs) expire();
        const up = request(base + path, { agent: agent || false }, (answer) => {
          clearTimeout(answer.socket.expiry);
          const chunks = [];
          answer.on("data", (c) => chunks.push(c));
          answer.on("end", () => resolve({ status: answer.statusCode, body: Buffer.concat(chunks) }));
        });
        up.once("socket", (socket) => {
          clearTimeout(socket.expiry);
          if (expireMs && up.reusedSocket) pool.reused.push(Math.round(socket.idleAtCheckout));
        });
        up.on("error", () => resolve({ status: 502, body: Buffer.alloc(0) }));
        up.end();
      });
      let served = 0;
      app = createServer(async (req, res) => {
        const n = ++served, delay = delayMs?.(n) ?? 0;
        if (delay) await sleep(delay);
        const { status, body } = await upstream({ "/catalog/record_1": "/catalog/records/record_1", "/api/marketplace/item_1": "/marketplace/records/item_1" }[req.url]);
        if (holdMs) await sleep(holdMs);
        res.writeHead(status === 200 ? 200 : 502, { connection: "close" });
        res.end(body);
      });
      app.agent = agent;
      await new Promise((done) => app.listen(0, "127.0.0.1", done));
      return containerId;
    }
    if (args[0] === "container") return owned(runId, { Id: containerId, NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: String(app.address().port) }] } } });
    if (args[0] === "start") return containerId;
    if (args[0] === "ps") return removed ? "" : containerId;
    if (args[0] === "rm") { removed = true; app.agent?.destroy(); app.closeAllConnections(); await new Promise((done) => app.close(done)); return containerId; }
    assert.fail(args.join(" "));
  });
  docker.intervene = (count) => Array.from({ length: count }, () => upstream("/catalog/records/record_1"));
  Object.assign(docker, { pool, onUpstream });
  return docker;
}

// The stand-in pool's expiry decision for a free connection at `now`: its idle is the time since the
// upstream wrote its last answer on it (`lastAnswerOf`), the clock the check judges reuse by, not the
// time since the stand-in assigned it to a request, which precedes that answer by however long the
// request took; it expires once that idle reaches `expireMs`.
function standInExpiry(socket, lastAnswerOf, now, expireMs) {
  const last = lastAnswerOf(socket.upstreamConnection);
  assert.ok(last != null, `no upstream answer recorded for the pooled connection on port ${socket.localPort}`);
  const idle = now - last;
  return { idle, expired: idle >= expireMs };
}

test("the stand-in pool times a connection's idle from the upstream's last answer, not from when a request was assigned it", () => {
  // A request was assigned its connection at 1000 ms (`usedAt`, where the stand-in once counted idle
  // from) and the upstream answered it 600 ms later, at 1600 ms.
  const socket = { upstreamConnection: 3, localPort: 40000, usedAt: 1000 }, answeredAt = 1600;
  const lastAnswerOf = (connection) => (connection === 3 ? answeredAt : null), expireMs = 4800;
  // Probed with the upstream's idle 4600 ms, inside the window, the stale 4.8 s pool must keep it, to
  // be handed out past the bound; idle counted from assignment (5200 ms) would close it first, and the
  // stale stand-in would drift healthy.
  const probe = answeredAt + 4600;
  assert.ok(probe - answeredAt >= limits.fromMs && probe - answeredAt < limits.belowMs && probe - answeredAt >= boundMs);
  assert.ok(probe - socket.usedAt >= expireMs);
  assert.deepEqual(standInExpiry(socket, lastAnswerOf, probe, expireMs), { idle: 4600, expired: false });
  // On the upstream's clock it expires at the pool's bound, and not a moment before.
  assert.deepEqual(standInExpiry(socket, lastAnswerOf, answeredAt + expireMs - 0.5, expireMs), { idle: expireMs - 0.5, expired: false });
  assert.deepEqual(standInExpiry(socket, lastAnswerOf, answeredAt + expireMs, expireMs), { idle: expireMs, expired: true });
  // A connection the upstream never answered on is a fixture fault, not a decision.
  assert.throws(() => standInExpiry({ upstreamConnection: 4, localPort: 40001 }, lastAnswerOf, probe, expireMs), /no upstream answer recorded for the pooled connection on port 40001/);
});

test("against stand-in apps on real sockets, a healthy pool never fails and a stale or interrupted one never passes, however the runner is timed", async () => {
  // Real timers on a shared runner can put any probe outside its window; that is inconclusive, so
  // these assertions accept it, and assert only what a slow runner cannot flip.
  const run = (name, agent, extra = {}, docker = standInDocker(name, agent)) =>
    checkImage("img", { names: ["catalog"], concurrency: 3, docker: docker.run, runId: name, window: 50, onUpstream: docker.onUpstream, ...extra });
  const stale = { keepAlive: true, agentKeepAliveTimeoutBuffer: 200, expireMs: 4800 }, sent = [];
  // The review's control on two pooled sockets: two ordinary GETs go upstream 2.5 s into the first
  // idle wait, sent from the wait itself, which returns only once the upstream has recorded both, so
  // they fall in the idle however the runner is timed (the upstream records a request before it answers).
  const meddler = standInDocker("interrupted", { ...stale, maxSockets: 2 });
  const meddle = async (ms) => {
    if (sent.length) return sleep(ms);
    await sleep(Math.min(ms, 2500));
    sent.push(...meddler.intervene(2));
    await Promise.all(sent);
  };
  const lateDocker = standInDocker("late", stale);
  const [healthy, frozen, unpooled, late, interrupted] = await Promise.all([
    // A 2 s pool: no warmed connection idle 2 s is reused, and on time each is closed long before the probe.
    run("healthy", { keepAlive: true, expireMs: 2000 }),
    // Every event stamped 0 ms: only the event order tells readiness from the warm bursts.
    run("frozen", { keepAlive: true, expireMs: 2000 }, { stamp: () => 0 }),
    run("unpooled", null),
    // A pool that drops a connection idle 4.8 s, between the bound and the upstream's close.
    run("late", stale, {}, lateDocker),
    run("interrupted", null, { idleWait: meddle }, meddler),
  ]);
  const verdict = (result, options) => { try { assertPasses(result, options); return "pass"; } catch (error) { return error.message; } };
  for (const [result, options] of [[healthy], [frozen], [unpooled, { reuse: false }]]) {
    const outcome = verdict(result, options);
    assert.ok(outcome === "pass" || /^catalog: inconclusive: /.test(outcome), outcome);
    assert.deepEqual(result.reads.catalog.warm.statuses, Array(6).fill(200));
    assert.deepEqual(result.reusedPastBound, []);
    assert.deepEqual(result.closedIdle, []);
    assert.equal(result.cleanup.complete, true);
  }
  assert.ok(healthy.reads.catalog.warm.reused > 0);
  assert.equal(frozen.reads.catalog.warm.answers, 6, JSON.stringify(frozen.reads.catalog.warm));
  assert.equal(unpooled.reads.catalog.warm.reused, 0);
  assert.notEqual(verdict(unpooled), "pass");
  // Inside the window the stale pool is a failure on the reuse; outside it, inconclusive. It stays
  // stale wherever a pause lands: whenever its probe was inside the window, it handed out a warmed
  // connection the upstream had seen idle the bound or longer, so a fixture that drifted healthy
  // (closing its connections before the probe) fails here rather than passing for the wrong reason.
  if (!late.reads.catalog.after.inconclusive) {
    assert.ok(lateDocker.pool.reused.some((idle) => idle >= boundMs), `the stale pool reused no connection idle ${boundMs} ms or more: ${JSON.stringify(lateDocker.pool)}`);
    assert.notDeepEqual(late.reusedPastBound, []);
    assert.match(verdict(late), /idle 4000 ms or more was reused/);
  }
  assert.notEqual(verdict(late), "pass");
  assert.notEqual(verdict(interrupted), "pass");
  assert.equal(sent.length, 2);
  assert.deepEqual((await Promise.all(sent)).map((r) => r.status), [200, 200]);
  if (!interrupted.reads.catalog.after.probe.skipped) assert.ok(interrupted.reads.catalog.after.probe.interrupted, JSON.stringify(interrupted.reads.catalog.after));
});

test("on real sockets, a client that opens a connection per request and closes each during a staggered warm-up is probed and passes without reuse", async () => {
  // Readiness is request 1 and the warm bursts of three are 2 to 4 and 5 to 7. The second burst is
  // held 300 ms before going upstream, so the warm answers span over the window's 250 ms, and every
  // reply waits 50 ms after its upstream answer, so each upstream connection is seen closed inside
  // the warm-up. None is open: the probe is made and all six are counted closed in time.
  const docker = standInDocker("staggered", null, { delayMs: (n) => (n >= 5 && n <= 7 ? 300 : 0), holdMs: 50 });
  const result = await checkImage("img", { names: ["catalog"], concurrency: 3, docker: docker.run, runId: "staggered", window: 50 });
  const { warm, after } = result.reads.catalog;
  assert.deepEqual(warm.statuses, Array(6).fill(200));
  assert.equal(warm.reused, 0);
  assert.ok(warm.spreadMs === 0 && warm.open === 0, JSON.stringify(warm));
  assert.equal(after.probe.skipped, undefined, JSON.stringify(after.probe));
  assert.deepEqual([after.probe.closedInTime, after.probe.arrivals, after.inconclusive], [6, 3, false], JSON.stringify(after.probe));
  assertPasses(result, { reuse: false });
  assert.throws(() => assertPasses(result), /no upstream connection was reused before the idle/);
});

test("the idle wait rechecks the clock after an early wake and returns at once when the target has passed", async () => {
  let clock = 0;
  const asked = [];
  // A timer that advances the clock by only half of what was asked.
  const waits = await waitUntil(1000, { now: () => clock, wait: async (ms) => { asked.push(ms); clock += ms / 2; } });
  assert.ok(clock >= 1000, String(clock));
  assert.equal(waits, asked.length);
  assert.ok(asked.length > 1 && asked.every((ms) => Number.isInteger(ms) && ms >= 1), JSON.stringify(asked));
  // A fractional remainder is rounded up, never down to a zero-length wait that returns early.
  clock = 0;
  const fractions = [];
  await waitUntil(0.4, { now: () => clock, wait: async (ms) => { fractions.push(ms); clock += ms; } });
  assert.deepEqual(fractions, [1]);
  assert.equal(await waitUntil(5, { now: () => 10, wait: () => assert.fail("no wait once the target has passed") }), 0);
});

test("the check refuses a result probed outside its window or that checked no reads", () => {
  const window = probeWindow(boundMs);
  const read = (probe) => ({ warm: { statuses: [200, 200], answers: 2, reused: 1 }, after: { statuses: [200], answers: 1, connections: [], probe } });
  const good = { boundMs, marginMs, window, reads: { catalog: read({ fromMs: 4500, toMs: 4749 }) }, closedIdle: [], reusedPastBound: [] };
  assertPasses(good);
  assert.throws(() => assertPasses({ ...good, reads: {} }), /no reads were checked/);
  assert.throws(() => assertPasses({ ...good, reads: { catalog: read({ fromMs: 4499, toMs: 4600 }) } }), /catalog: inconclusive/);
  assert.throws(() => assertPasses({ ...good, reads: { catalog: read({ fromMs: 4500, toMs: 4750 }) } }), /catalog: inconclusive/);
  assert.throws(() => assertPasses({ ...good, reads: { catalog: read({ fromMs: 4500, toMs: 4600 }), items: read({ fromMs: 5158, toMs: 5170 }) } }), /items: inconclusive/);
  // Compared unrounded: just under the opening, or at the close, is outside.
  assert.throws(() => assertPasses({ ...good, reads: { catalog: read({ fromMs: 4499.9, toMs: 4600 }) } }), /catalog: inconclusive/);
  assertPasses({ ...good, reads: { catalog: read({ fromMs: 4500, toMs: 4749.99 }) } });
  assert.equal(inconclusive({ fromMs: 4500, toMs: 4749.99 }, window), false);
  assert.equal(inconclusive({ fromMs: 4500, toMs: 4750 }, window), true);
  assert.equal(inconclusive({ fromMs: null, toMs: null }, window), true);
  // Nothing timed proves the window only when every warmed connection closed in time and a request arrived.
  assert.equal(inconclusive({ fromMs: null, toMs: null, arrivals: 3, closedInTime: 6 }, window), false);
  assert.equal(inconclusive({ fromMs: null, toMs: null, arrivals: 0, closedInTime: 6 }, window), true);
  assert.equal(inconclusive({ fromMs: 4500, toMs: 4600, arrivals: 0 }, window), true);
  assert.throws(() => assertPasses({ ...good, reads: { catalog: read({ fromMs: null, toMs: null, skipped: "the warm answers span 300.0 ms" }) } }), /catalog: inconclusive: not probed: the warm answers span/);
  assert.throws(() => assertPasses({ ...good, window: { fromMs: 0, belowMs: Infinity } }), /window is not the bound's/);
  const { after } = good.reads.catalog;
  assert.throws(() => assertPasses({ ...good, reads: { catalog: { ...good.reads.catalog, warm: { ...good.reads.catalog.warm, answers: 1 } } } }), /one upstream answer per read before/);
  assert.throws(() => assertPasses({ ...good, reads: { catalog: { warm: { ...good.reads.catalog.warm, statuses: [200, 500] }, after } } }), /before the idle/);
  assert.throws(() => assertPasses({ ...good, closedIdle: [{ idle: 5000 }] }), /past its keep-alive/);
});
