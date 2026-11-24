// The idle-close check's own behavior, without Docker: argument checks, the owned-container
// teardown against a fake Docker client, and the whole check against a stand-in app whose pool
// keeps a chosen idle bound. A functional check of the checker, not a measurement.
import assert from "node:assert/strict";
import { createServer, request, Agent } from "node:http";
import test from "node:test";
import { assertPasses, attemptKey, boundMs, checkImage, checkOptions, closingUpstream, inconclusive, keepAliveMs, marginMs, ownerKey, parseArgs, probeWindow, slackMs, waitUntil } from "./idle-close.mjs";

// Listening servers once the event loop has had a turn to release closed handles.
const listeners = async () => {
  await new Promise((done) => setTimeout(done, 20));
  return process.getActiveResourcesInfo().filter((kind) => kind === "TCPServerWrap").length;
};
const id = (n) => String(n).repeat(64).slice(0, 64);

// A Docker client that records every call and answers from `answer` (args to stdout, or a throw).
function fakeDocker(answer) {
  const calls = [];
  const run = async (args, options) => { calls.push(args); return answer(args, options, calls); };
  return { run, calls };
}
const owned = (runId, extra = {}) => JSON.stringify([{ Id: extra.Id, Config: { Labels: { [ownerKey]: runId } }, ...extra }]);

test("an empty, unknown or repeated read, a reserved label or an unsafe bound is refused before the upstream opens or Docker runs", async () => {
  const before = await listeners();
  for (const [options, message] of [
    [{ names: [] }, /no reads selected/], [{ names: ["catalog", "nope"] }, /unknown read "nope"/], [{ names: [""] }, /unknown read ""/],
    [{ names: ["items", "items"] }, /selected twice/], [{ names: ["catalog"], labels: [`${ownerKey}=x`] }, /reserved/],
    [{ names: ["catalog"], labels: [`${attemptKey}=x`] }, /reserved/], [{ names: ["catalog"], labels: ["no-value"] }, /key=value/],
    [{ names: ["catalog"], bound: 4600 }, /must end before/], [{ names: ["catalog"], bound: 0 }, /must end before/],
  ]) {
    const docker = fakeDocker(() => assert.fail("Docker must not run"));
    await assert.rejects(checkImage("img", { ...options, docker: docker.run, runId: "r" }), message);
    assert.deepEqual(docker.calls, []);
    assert.equal(await listeners(), before, "no upstream left listening");
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
  const before = await listeners(), started = Date.now();
  const docker = fakeDocker((args) => {
    if (args[0] === "create") throw new Error("docker create: exit 1\nCannot connect to the Docker daemon");
    if (args[0] === "ps") return "";
    assert.fail(`unexpected ${args.join(" ")}`);
  });
  const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r1", window: 50 }).then(() => assert.fail("passed"), (e) => e);
  assert.match(error.message, /Cannot connect/);
  assert.equal(error.cleanup.complete, false);
  assert.equal(error.cleanup.created, null);
  assert.equal(error.cleanup.unacknowledged.outcome, "unconfirmed");
  assert.match(error.cleanup.failures[0].error, /cleanup is unconfirmed/);
  assert.equal(await listeners(), before, "no upstream left listening");
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
  const before = await listeners(), created = id(1);
  const docker = fakeDocker((args) => {
    if (args[0] === "create") return created;
    if (args[0] === "container") return owned("r4", { Id: created });
    if (args[0] === "start") throw new Error("docker start: exit 1\nport is already allocated");
    if (args[0] === "ps") return created;
    if (args[0] === "rm") throw new Error("docker rm: exit 1\nremoval of container is already in progress");
    assert.fail(args.join(" "));
  });
  const error = await checkImage("img", { names: ["catalog"], docker: docker.run, runId: "r4", window: 50 }).then(() => assert.fail("passed"), (e) => e);
  assert.match(error.message, /port is already allocated/);
  assert.equal(error.cleanup.complete, false);
  assert.deepEqual(error.cleanup.removed, []);
  assert.match(error.cleanup.failures[0].error, /removal of container is already in progress/);
  for (const args of docker.calls.filter((a) => ["start", "rm", "container", "logs"].includes(a[0]))) assert.equal(args.at(-1), created);
  assert.equal(await listeners(), before);
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

// A stand-in for an app image: a server that reads API_BASE through an HTTP agent, so its pool's idle
// bound is chosen by the test. `agent: false` opens a connection per request. `expireMs` closes a
// pooled connection idle that long, on a timer of the stand-in's own rather than Node's. For the nth
// request to a path (from 1): `hold(path, n)` ms before it is sent upstream, `delay(path, n)` ms
// after its upstream answer before the reply, and `unpooled(path, n)` sends it on a connection of
// its own.
function standInDocker(runId, agentOptions, { delay = () => 0, hold = () => 0, unpooled = () => false } = {}) {
  const { expireMs, ...options } = agentOptions ?? {};
  const containerId = id(9);
  let app, removed = false;
  const docker = fakeDocker(async (args) => {
    if (args[0] === "create") {
      const base = args[args.findIndex((a) => a.startsWith("API_BASE="))].slice("API_BASE=".length).replace("host.docker.internal", "127.0.0.1");
      const agent = agentOptions && new Agent(options), served = new Map();
      if (expireMs) agent.on("free", (socket) => { clearTimeout(socket.expiry); socket.expiry = setTimeout(() => socket.destroy(), expireMs); });
      app = createServer((req, res) => {
        const path = { "/catalog/record_1": "/catalog/records/record_1", "/api/marketplace/item_1": "/marketplace/records/item_1" }[req.url];
        const n = (served.get(req.url) ?? 0) + 1;
        served.set(req.url, n);
        setTimeout(() => {
          const up = request(base + path, { agent: (!unpooled(req.url, n) && agent) || false }, (answer) => {
            clearTimeout(answer.socket.expiry);
            const chunks = [];
            answer.on("data", (c) => chunks.push(c));
            answer.on("end", () => setTimeout(() => {
              res.writeHead(answer.statusCode === 200 ? 200 : 502, { connection: "close" });
              res.end(Buffer.concat(chunks));
            }, delay(req.url, n)));
          });
          up.on("error", () => { res.writeHead(502, { connection: "close" }); res.end(); });
          up.end();
        }, hold(req.url, n));
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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const inWindow = ({ fromMs, toMs }) => fromMs >= boundMs + marginMs && toMs < keepAliveMs - slackMs;

test("the whole check passes a pool under the bound and fails one still reusing at 4.5 s, one probed late, held, staggered, or opening a connection per request", async () => {
  const run = (name, agent, extra = {}, shape) => checkImage("img", { names: ["catalog"], concurrency: 3, docker: standInDocker(name, agent, shape).run, runId: name, window: 50, ...extra });
  const early = [];
  // A request after readiness (1) and the two warm bursts of three (2 to 7) is a probe request.
  const probing = (path, n) => path === "/catalog/record_1" && n >= 8;
  // A pool whose warmed connections stay open past the window (closed at 4.8 s idle, as `late`'s)
  // while the probe goes out on new connections: the probe neither reuses nor sees them closed, so
  // it is judged by when its requests reached the upstream.
  const open = { keepAlive: true, agentKeepAliveTimeoutBuffer: 200, expireMs: 4800 }, fresh = (path, n) => n >= 8;
  const [safe, frozen, late, slept, woke, unpooled, slow, held, staggered, straggler] = await Promise.all([
    // A 2 s pool: every warmed connection is closed long before the probe.
    run("safe", { keepAlive: true, timeout: 2000 }),
    // Every event stamped 0 ms: readiness and the warm bursts share a timestamp, so only the
    // event order can tell them apart.
    run("frozen", { keepAlive: true, timeout: 2000 }, { stamp: () => 0 }),
    // A pool that drops a connection idle 4.8 s, between the bound and the upstream's close (Node's
    // own expiry, the keep-alive hint less this buffer, is pushed past it).
    run("late", { keepAlive: true, agentKeepAliveTimeoutBuffer: 200, expireMs: 4800 }),
    // The same 4.8 s pool, with an idle timer that fires 700 ms late: the probe comes after the pool
    // has expired, so nothing is reused and only the window shows the probe proves nothing.
    run("slept", { keepAlive: true, agentKeepAliveTimeoutBuffer: 200, expireMs: 4800 }, { idleWait: (ms) => sleep(ms + 700) }),
    // A timer that fires after a third of the time asked: the wait still reaches the window.
    run("woke", open, { idleWait: (ms) => { early.push(ms); return sleep(Math.floor(ms / 3)); } }, { unpooled: fresh }),
    run("unpooled", null),
    // Marketplace first, its probe replies sent 600 ms after their upstream answers, so the last
    // ends with the warmed connections idle over 5 s: the requests reached the upstream inside the
    // window, so it passes, and catalog after it still idles from its own warm answers.
    run("slow", open, { names: ["marketplace", "catalog"] }, { unpooled: fresh, delay: (path, n) => (path === "/api/marketplace/item_1" && n >= 8 ? 600 : 0) }),
    // The probe requests held 400 ms in the app before it sends them upstream: they arrive with the
    // warmed connections (closed at 4.8 s, past the window) idle about 4.9 s, so the probe proves nothing.
    run("held", open, {}, { unpooled: fresh, hold: (path, n) => (probing(path, n) ? 400 : 0) }),
    // The 4.8 s pool with its last warm request sent 400 ms late on a pooled connection: no moment
    // puts every open warmed connection inside the window (a probe timed from the newest answer
    // would come after the older ones expired), so it is not probed and is inconclusive.
    run("staggered", { keepAlive: true, agentKeepAliveTimeoutBuffer: 200, expireMs: 4800 }, {}, { hold: (path, n) => (n === 7 ? 400 : 0) }),
    // The review's case: the same pool with that late warm request on a connection of its own,
    // which closes at once. It cannot be reused, so the probe is timed from the pooled connections
    // and finds them reused past the bound rather than passing after they expired. Two pooled
    // sockets, so both answer in the second burst and their own spread stays small.
    run("straggler", { keepAlive: true, agentKeepAliveTimeoutBuffer: 200, expireMs: 4800, maxSockets: 2 }, {},
      { hold: (path, n) => (n === 7 ? 400 : 0), unpooled: (path, n) => n === 7 }),
  ]);
  assertPasses(safe);
  assert.ok(safe.reads.catalog.warm.reused > 0);
  // Closed under 4.75 s idle and before the probe: counted as closed in time, not timed.
  assert.equal(safe.reads.catalog.after.probe.closedInTime, safe.reads.catalog.warm.connections, JSON.stringify(safe.reads.catalog));
  assert.equal(safe.reads.catalog.after.probe.fromMs, null);
  assert.equal(safe.reads.catalog.after.inconclusive, false);
  assert.deepEqual(safe.window, { fromMs: boundMs + marginMs, belowMs: keepAliveMs - slackMs });
  assert.equal(safe.cleanup.complete, true);
  // The readiness answer is not counted as a warm answer, whatever the stamps say.
  assert.equal(frozen.reads.catalog.warm.answers, 6, JSON.stringify(frozen.reads.catalog.warm));
  assertPasses(frozen);
  // Expiring at 4.8 s, between the bound and the upstream's close: every read still answers 200 and
  // the upstream closed nothing, but each reused connection had been idle past the bound.
  assert.deepEqual(late.reads.catalog.after.statuses, [200, 200, 200]);
  assert.deepEqual(late.closedIdle, []);
  assert.ok(inWindow(late.reads.catalog.after.probe), JSON.stringify(late.reads.catalog.after.probe));
  assert.ok(late.reusedPastBound.length > 0 && late.reusedPastBound.every((e) => e.idle >= boundMs + marginMs - 50), JSON.stringify(late.reusedPastBound));
  assert.throws(() => assertPasses(late), /idle 4000 ms or more was reused/);
  // Probed late, the same pool shows no reuse at all; the window makes that inconclusive, a failure.
  const probe = slept.reads.catalog.after.probe;
  assert.ok(probe.fromMs >= keepAliveMs - slackMs, JSON.stringify(probe));
  assert.equal(slept.reads.catalog.after.inconclusive, true);
  assert.deepEqual(slept.reusedPastBound, []);
  assert.deepEqual(slept.closedIdle, []);
  assert.throws(() => assertPasses(slept), /catalog: inconclusive: probe requests reached the upstream with the warmed connections idle [\d.]+ to [\d.]+ ms/);
  // Only the window catches it: the same result with its probe moved inside passes.
  assertPasses({ ...slept, reads: { catalog: { ...slept.reads.catalog, after: { ...slept.reads.catalog.after, probe: { fromMs: 4500, toMs: 4600 } } } } });
  // Woken early, the wait rechecked the clock and waited again until the window opened.
  assert.ok(early.length > 1, JSON.stringify(early));
  assert.ok(inWindow(woke.reads.catalog.after.probe), JSON.stringify(woke.reads.catalog.after.probe));
  assert.equal(woke.reads.catalog.after.probe.closedInTime, 0);
  assertPasses(woke);
  assert.equal(unpooled.reads.catalog.warm.reused, 0);
  // Every connection of a connection-per-request client closed before the probe: counted, not timed.
  assert.equal(unpooled.reads.catalog.after.probe.closedInTime, unpooled.reads.catalog.warm.connections);
  assert.equal(unpooled.reads.catalog.after.inconclusive, false);
  assert.throws(() => assertPasses(unpooled), /no upstream connection was reused before the idle/);
  assertPasses(unpooled, { reuse: false });
  // A slow reply after an on-time upstream arrival passes, and the next read still probes inside its window.
  assert.ok(inWindow(slow.reads.marketplace.after.probe), JSON.stringify(slow.reads.marketplace.after.probe));
  assert.equal(slow.reads.marketplace.after.probe.closedInTime, 0);
  assert.deepEqual(slow.reads.marketplace.after.statuses, [200, 200, 200]);
  assert.ok(inWindow(slow.reads.catalog.after.probe), JSON.stringify(slow.reads.catalog.after.probe));
  assertPasses(slow);
  // A request the app sent upstream late is inconclusive even though every reply was a 200.
  assert.deepEqual(held.reads.catalog.after.statuses, [200, 200, 200]);
  assert.ok(held.reads.catalog.after.probe.toMs >= keepAliveMs - slackMs, JSON.stringify(held.reads.catalog.after.probe));
  assert.equal(held.reads.catalog.after.inconclusive, true);
  assert.throws(() => assertPasses(held), /catalog: inconclusive: probe requests reached the upstream/);
  // A warm-up spread wider than the window is not probed: inconclusive, not a pass.
  assert.ok(staggered.reads.catalog.warm.spreadMs >= keepAliveMs - slackMs - boundMs - marginMs, JSON.stringify(staggered.reads.catalog.warm));
  assert.equal(staggered.reads.catalog.after.probe.fromMs, null);
  assert.match(staggered.reads.catalog.after.probe.skipped, /warm answers span/);
  assert.deepEqual(staggered.reads.catalog.after.statuses, []);
  assert.throws(() => assertPasses(staggered), /catalog: inconclusive: not probed: the warm answers span/);
  // The review's case fails: the straggler's own connection is counted as closed, and the pooled ones were reused past the bound.
  assert.ok(straggler.reads.catalog.after.probe.closedInTime >= 1, JSON.stringify(straggler.reads.catalog.after.probe));
  assert.ok(straggler.reusedPastBound.length > 0, JSON.stringify(straggler.reads.catalog));
  assert.throws(() => assertPasses(straggler), /inconclusive|idle 4000 ms or more was reused/);
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
