// The idle-close check's own behavior, without Docker: argument checks, the owned-container
// teardown against a fake Docker client, and the whole check against a stand-in app whose pool
// keeps a chosen idle bound. A functional check of the checker, not a measurement.
import assert from "node:assert/strict";
import { createServer, request, Agent } from "node:http";
import test from "node:test";
import { assertPasses, attemptKey, boundMs, checkImage, checkOptions, closingUpstream, marginMs, ownerKey, parseArgs } from "./idle-close.mjs";

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
  const closed = upstream.events.filter((e) => e.kind === "closedIdle");
  assert.equal(closed.length, 1);
  assert.ok(closed[0].idle >= 300);
  assert.equal(closed[0].lastPath, "/a");
  assert.equal(upstream.server.listening, false);
});

// A stand-in for an app image: a server that reads API_BASE through an HTTP agent, so its pool's idle
// bound is chosen by the test. `agent: false` opens a connection per request.
function standInDocker(runId, agentOptions) {
  const containerId = id(9);
  let app, removed = false;
  const docker = fakeDocker(async (args) => {
    if (args[0] === "create") {
      const base = args[args.findIndex((a) => a.startsWith("API_BASE="))].slice("API_BASE=".length).replace("host.docker.internal", "127.0.0.1");
      const agent = agentOptions && new Agent(agentOptions);
      app = createServer((req, res) => {
        const path = { "/catalog/record_1": "/catalog/records/record_1" }[req.url];
        const up = request(base + path, { agent: agent ?? false }, (answer) => {
          const chunks = [];
          answer.on("data", (c) => chunks.push(c));
          answer.on("end", () => { res.writeHead(answer.statusCode === 200 ? 200 : 502, { connection: "close" }); res.end(Buffer.concat(chunks)); });
        });
        up.on("error", () => { res.writeHead(502, { connection: "close" }); res.end(); });
        up.end();
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

test("the whole check passes a pool under the bound and fails one that expires just past it or opens a connection per request", async () => {
  const run = (name, agent) => checkImage("img", { names: ["catalog"], concurrency: 3, docker: standInDocker(name, agent).run, runId: name, window: 50 });
  const [safe, late, unpooled] = await Promise.all([
    run("safe", { keepAlive: true, timeout: 2000 }),
    // Node's agent keeps a connection until the server's keep-alive hint less this buffer: 4.8 s.
    run("late", { keepAlive: true, agentKeepAliveTimeoutBuffer: 200 }),
    run("unpooled", null),
  ]);
  assertPasses(safe);
  assert.ok(safe.reads.catalog.warm.reused > 0);
  assert.ok(safe.idleMs >= boundMs + marginMs && safe.idleMs < 5000, String(safe.idleMs));
  assert.equal(safe.cleanup.complete, true);
  // Expiring at 4.8 s, between the bound and the upstream's close: every read still answers 200 and
  // the upstream closed nothing, but each reused connection had been idle past the bound.
  assert.deepEqual(late.reads.catalog.after.statuses, [200, 200, 200]);
  assert.deepEqual(late.closedIdle, []);
  assert.ok(late.reusedPastBound.length > 0 && late.reusedPastBound.every((e) => e.idle >= boundMs + marginMs - 50), JSON.stringify(late.reusedPastBound));
  assert.throws(() => assertPasses(late), /idle 4000 ms or more was reused/);
  assert.equal(unpooled.reads.catalog.warm.reused, 0);
  assert.throws(() => assertPasses(unpooled), /no upstream connection was reused before the idle/);
  assertPasses(unpooled, { reuse: false });
});

test("the check refuses a result that did not wait past the bound or checked no reads", () => {
  const read = { warm: { statuses: [200, 200], answers: 2, reused: 1 }, after: { statuses: [200], answers: 1, connections: [] } };
  const good = { boundMs, marginMs, idleMs: boundMs + marginMs, reads: { catalog: read }, closedIdle: [], reusedPastBound: [] };
  assertPasses(good);
  assert.throws(() => assertPasses({ ...good, reads: {} }), /no reads were checked/);
  assert.throws(() => assertPasses({ ...good, idleMs: boundMs }), /ended before the bound/);
  assert.throws(() => assertPasses({ ...good, reads: { catalog: { ...read, warm: { ...read.warm, answers: 1 } } } }), /one upstream answer per read before/);
  assert.throws(() => assertPasses({ ...good, reads: { catalog: { ...read, warm: { ...read.warm, statuses: [200, 500] } } } }), /before the idle/);
  assert.throws(() => assertPasses({ ...good, closedIdle: [{ idle: 5000 }] }), /past its keep-alive/);
});
