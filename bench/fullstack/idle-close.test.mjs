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

test("the upstream records each request's idle, answers before the close and resets a connection idle past its keep-alive", async () => {
  const upstream = closingUpstream({ "/a": { a: 1 } }, 300);
  await new Promise((done) => upstream.server.listen(0, "127.0.0.1", done));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const port = upstream.server.address().port;
  const fetchOnce = () => new Promise((resolve) => {
    const req = request({ port, path: "/a", agent }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", (e) => resolve(e.code));
    req.end();
  });
  assert.equal(await fetchOnce(), 200);
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(await fetchOnce(), 200);
  await new Promise((done) => setTimeout(done, 350));
  assert.notEqual(await fetchOnce(), 200);
  agent.destroy();
  await upstream.close();
  const answered = upstream.events.filter((e) => e.kind === "answered");
  assert.equal(answered.length, 2);
  assert.equal(answered[0].idle, null);
  assert.ok(answered[1].idle >= 90 && answered[1].idle < 300 && answered[1].connection === answered[0].connection, JSON.stringify(answered));
  // Each request's arrival is on the monotonic clock, unrounded, and the connection keeps its last answer after it closes.
  assert.ok(answered[1].arrival > answered[0].arrival && upstream.lastAnswerOf(answered[0].connection) >= answered[1].arrival, JSON.stringify(answered));
  assert.equal(upstream.lastAnswerOf(99), null);
  const closed = upstream.events.filter((e) => e.kind === "closedIdle");
  assert.equal(closed.length, 1);
  assert.ok(closed[0].idle >= 300);
  assert.equal(closed[0].lastPath, "/a");
  assert.equal(upstream.server.listening, false);
});

test("the upstream takes a request's arrival from the read that completed its head, before any answer is prepared", async () => {
  // Only the double's response work is slow: a serializer that spins 280 ms.
  let serializing = null;
  const slow = { toJSON() { serializing = performance.now(); while (performance.now() - serializing < 280); return { a: 1 }; } };
  const upstream = closingUpstream({ "/slow": slow });
  await new Promise((done) => upstream.server.listen(0, "127.0.0.1", done));
  const port = upstream.server.address().port;
  const status = await new Promise((resolve) => {
    const req = request({ port, path: "/slow", agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", (e) => resolve(e.code));
    req.end();
  });
  await upstream.close();
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
// the idle's events by then, the probe's events kept only if one was made.
function judged({ warm, idle = [], probe = [], planAt }) {
  const conns = warmedSet(warm, T), now = planAt ?? firstWait(conns, limits) ?? 0;
  const plan = planProbe(conns, idle.filter((e) => (e.time ?? e.arrival) <= now), now, limits);
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
// bound is chosen by the test. `agent: false` opens a connection per request. `expireMs` closes a
// pooled connection idle that long, on a timer of the stand-in's own rather than Node's.
// `intervene: { after, inMs, count, sent }` sends `count` upstream GETs on the pool `inMs` after the
// app's `after`th request (from 1) is answered, pushing each to `sent`.
function standInDocker(runId, agentOptions, { intervene } = {}) {
  const { expireMs, ...options } = agentOptions ?? {};
  const containerId = id(9);
  let app, removed = false;
  const docker = fakeDocker(async (args) => {
    if (args[0] === "create") {
      const base = args[args.findIndex((a) => a.startsWith("API_BASE="))].slice("API_BASE=".length).replace("host.docker.internal", "127.0.0.1");
      const agent = agentOptions && new Agent(options);
      if (expireMs) agent.on("free", (socket) => { clearTimeout(socket.expiry); socket.expiry = setTimeout(() => socket.destroy(), expireMs); });
      const upstream = (path) => new Promise((resolve) => {
        const up = request(base + path, { agent: agent || false }, (answer) => {
          clearTimeout(answer.socket.expiry);
          const chunks = [];
          answer.on("data", (c) => chunks.push(c));
          answer.on("end", () => resolve({ status: answer.statusCode, body: Buffer.concat(chunks) }));
        });
        up.on("error", () => resolve({ status: 502, body: Buffer.alloc(0) }));
        up.end();
      });
      let served = 0;
      app = createServer(async (req, res) => {
        const n = ++served;
        const { status, body } = await upstream({ "/catalog/record_1": "/catalog/records/record_1", "/api/marketplace/item_1": "/marketplace/records/item_1" }[req.url]);
        res.writeHead(status === 200 ? 200 : 502, { connection: "close" });
        res.end(body);
        if (intervene && n === intervene.after) {
          setTimeout(() => { for (let i = 0; i < intervene.count; i++) { intervene.sent.push(performance.now()); upstream("/catalog/records/record_1"); } }, intervene.inMs);
        }
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
  return docker;
}

test("against stand-in apps on real sockets, a healthy pool never fails and a stale or interrupted one never passes, however the runner is timed", async () => {
  // Real timers on a shared runner can put any probe outside its window; that is inconclusive, so
  // these assertions accept it, and assert only what a slow runner cannot flip.
  const run = (name, agent, extra = {}, shape) => checkImage("img", { names: ["catalog"], concurrency: 3, docker: standInDocker(name, agent, shape).run, runId: name, window: 50, ...extra });
  const stale = { keepAlive: true, agentKeepAliveTimeoutBuffer: 200, expireMs: 4800 }, sent = [];
  const [healthy, frozen, unpooled, late, interrupted] = await Promise.all([
    // A 2 s pool: every warmed connection is closed long before the probe.
    run("healthy", { keepAlive: true, timeout: 2000 }),
    // Every event stamped 0 ms: only the event order tells readiness from the warm bursts.
    run("frozen", { keepAlive: true, timeout: 2000 }, { stamp: () => 0 }),
    run("unpooled", null),
    // A pool that drops a connection idle 4.8 s, between the bound and the upstream's close.
    run("late", stale),
    // The review's control on two pooled sockets: readiness is the app's first request and the two
    // warm bursts of three the next six, so two ordinary GETs go upstream 2.5 s into the idle.
    run("interrupted", { ...stale, maxSockets: 2 }, {}, { intervene: { after: 7, inMs: 2500, count: 2, sent } }),
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
  // Inside the window the stale pool is a failure on the reuse; outside it, inconclusive.
  assert.notEqual(verdict(late), "pass");
  if (!late.reads.catalog.after.inconclusive) assert.match(verdict(late), /idle 4000 ms or more was reused/);
  assert.notEqual(verdict(interrupted), "pass");
  assert.equal(sent.length, 2);
  if (!interrupted.reads.catalog.after.probe.skipped) assert.ok(interrupted.reads.catalog.after.probe.interrupted, JSON.stringify(interrupted.reads.catalog.after));
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
