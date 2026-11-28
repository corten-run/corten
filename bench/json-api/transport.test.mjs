import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { localEngine, pairedDeltas, sample, summarize } from "./transport.mjs";

test("generator loopback cannot measure a remote Docker engine", () => {
  for (const endpoint of ["unix:///var/run/docker.sock", "npipe:////./pipe/dockerDesktopLinuxEngine"]) assert.ok(localEngine(endpoint));
  for (const endpoint of ["tcp://127.0.0.1:2375", "ssh://remote", "npipe:////remote/pipe/docker", "unix:////remote/share"]) assert.equal(localEngine(endpoint), false);
});

test("one fixture workload distinguishes body coding from actual connection turnover", async (t) => {
  const cases = [1, 2, 3].map((id) => ({ path: "/" + id, record: { id, title: "record " + id } }));
  const connections = new Map();
  let mode = "normal", cpu = 0;
  const server = createServer((req, res) => {
    connections.set(req.socket, (connections.get(req.socket) ?? 0) + 1);
    const body = JSON.stringify(mode.startsWith("bad-data") ? {} : cases.find((c) => c.path === req.url).record);
    res.setHeader("content-type", "Application/JSON; charset=utf-8");
    if (mode === "close") res.setHeader("connection", "close");
    if (req.headers["accept-encoding"] === "gzip" && !mode.endsWith("no-gzip")) {
      res.setHeader("content-encoding", "GZip"); res.end(gzipSync(body));
    } else res.end(body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const run = async (arm, perLane = 21) => {
    connections.clear(); const row = await sample({ base: "http://127.0.0.1:" + server.address().port,
      arm, lanes: 1, rate: 10, perLane, cases, counter: () => cpu += perLane });
    assert.deepEqual(row.requestsPerConnection, [...connections.values()].sort((a, b) => a - b));
    return row;
  };
  for (const arm of ["identity", "gzip", "reconnect-10"]) {
    const row = await run(arm);
    assert.equal(row.status, "observed", JSON.stringify(row)); assert.equal(row.completed, 21);
    assert.deepEqual(row.requestsPerConnection, arm === "reconnect-10" ? [1, 10, 10] : [21]);
    assert.equal(row.closed, row.opened); assert.equal(row.appCpuUsecPerSuccess, 1);
    const bytes = cases.reduce((sum, c) => sum + (arm === "gzip" ? gzipSync(JSON.stringify(c.record)).length : Buffer.byteLength(JSON.stringify(c.record))), 0);
    assert.equal(row.encodedBodyBytes, 7 * bytes);
  }
  mode = "no-gzip"; assert.equal((await run("gzip", 3)).status, "unsupported");
  mode = "bad-data-no-gzip"; assert.equal((await run("gzip", 3)).status, "incomplete");
  mode = "bad-data"; assert.equal((await run("identity", 3)).completed, 0);
  mode = "close"; assert.equal((await run("identity", 3)).connectionPattern, false);
});

test("ranges and paired differences require three complete passes with generator headroom", () => {
  const rows = [1, 2, 3].flatMap((pass) => ["identity", "gzip", "reconnect-10"].map((arm) => ({
    pass, arm, status: "observed", bytesPerSuccess: arm === "gzip" ? 40 : 100,
    appCpuUsecPerSuccess: pass + (arm === "gzip" ? 2 : 0), p99Ms: pass, successfulRps: 150,
  })));
  assert.deepEqual(summarize(rows).gzip.appCpuUsecPerSuccess, { min: 3, median: 4, max: 5 });
  assert.deepEqual(pairedDeltas(rows).gzip.map((r) => [r.bodyBytesPerSuccess, r.cpuUsecPerSuccess]), Array(3).fill([-60, 2]));
  rows[0].generatorLimited = true;
  assert.equal(pairedDeltas(rows).gzip, null);
  assert.equal(summarize(rows).identity, null);
});
