// Opt-in diagnostics around the existing native driver, without changing its gates or startup.
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const [image, phase = "before"] = process.argv.slice(2);
assert.ok(image, "usage: node check-trace.mjs IMAGE [before|after]");
assert.ok(["before", "after"].includes(phase));
const regressionsOnly = process.argv.includes("--regressions-only");
const run = `${phase}-${Date.now()}`;
const results = new URL("./tests/results/", import.meta.url);
const output = new URL(`cause-${run}/`, results);
mkdirSync(output, { recursive: true });
const observe = (event) => appendFileSync(new URL("upstream.ndjson", output), JSON.stringify({ at: Date.now(), monotonic: performance.now(), ...event }) + "\n");
const hash = (url) => createHash("sha256").update(readFileSync(url)).digest("hex");
const files = ["app/record_json.py", "app/main.py", "app/catalog.py", "app/marketplace.py", "check-trace.mjs"];
const sourceFiles = files.map(path => ({ path, sha256: hash(new URL(path, import.meta.url)) }));
const require = createRequire(import.meta.url);
const child = require("node:child_process"), http = require("node:http");
const spawnSync = child.spawnSync, createServer = http.createServer;
const lag = monitorEventLoopDelay({ resolution: 20 });
const requests = new WeakSet(), sockets = new WeakMap();
const servers = [], containers = new Set();
let socketNumber = 0;
http.createServer = (...args) => {
  const server = createServer(...args);
  servers.push(server);
  server.on("connection", socket => {
    const connection = ++socketNumber;
    sockets.set(socket, connection);
    observe({ kind: "socket-open", connection, local: socket.localPort, remote: socket.remotePort });
    socket.once("end", () => observe({ kind: "socket-end", connection, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten }));
    socket.once("close", hadError => observe({ kind: "socket-close", connection, hadError, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten }));
    socket.on("error", error => observe({ kind: "socket-error", connection, code: error.code, message: error.message }));
  });
  server.prependListener("request", (req, res) => {
    if (requests.has(req)) return;
    requests.add(req);
    const connection = sockets.get(req.socket), path = req.url;
    observe({ kind: "request", connection, path, method: req.method });
    res.once("finish", () => observe({ kind: "finish", connection, path, status: res.statusCode }));
    res.once("close", () => observe({ kind: "response-close", connection, path, ended: res.writableEnded, finished: res.writableFinished }));
    req.once("aborted", () => observe({ kind: "request-aborted", connection, path }));
  });
  return server;
};
child.spawnSync = (command, args, options) => {
  if (command === "docker" && args[0] === "run") args = [...args.slice(0, -1), "-e", "RECORD_JSON_TRACE=1",
    "--label", "agent.task=corten-bench-fastapi-cause", args.at(-1)];
  const start = performance.now();
  const result = spawnSync(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
  observe({ kind: "command", command, action: args[0], elapsed: performance.now() - start, status: result.status, error: result.error?.code });
  if (command === "docker" && args[0] === "run" && result.status === 0) containers.add(args[args.indexOf("--name") + 1]);
  if (command === "docker" && args[0] === "rm" && result.status === 0) containers.delete(args.at(-1));
  if (command === "docker" && args[0] === "logs") {
    const name = args[1];
    assert.match(name, /^corten-json-fastapi-\d+-(?:api|fixture)-(?:default|matched)$/);
    writeFileSync(new URL(`${name}.stderr.log`, output), result.stderr ?? "");
    writeFileSync(new URL(`${name}.stdout.log`, output), result.stdout ?? "");
  }
  return result;
};
syncBuiltinESMExports();
lag.enable();
let failure;
try {
  const { checkNative } = await import("../express/check-native.mjs");
  await checkNative("fastapi", image, { quick: true, regressionsOnly, label: `trace-${run}` });
  if (regressionsOnly) {
    for (const profile of ["default", "matched"]) {
      const name = readdirSync(output).find(name => name.endsWith(`-api-${profile}.stderr.log`));
      assert.ok(name, `${profile}: native stderr missing`);
      const events = readFileSync(new URL(name, output), "utf8").split("\n").flatMap(line => {
        try { const value = JSON.parse(line); return value.record_trace ? [value] : []; } catch { return []; }
      });
      const failures = events.filter(event => event.record_trace === "serialization.failed");
      assert.equal(failures.length, 1, `${profile}: native serialization trace missing`);
      const failure = failures[0], request = events.filter(event => event.trace === failure.trace);
      assert.match(failure.error.type, /PydanticSerializationError$/);
      assert.match(failure.error.traceback, /PydanticSerializationError/);
      assert.match(failure.error.traceback, /serialize/);
      assert.ok(request.every(event => event.path === "/api/catalog/record_1" && event.record_id === "record_1"));
      assert.ok(request.some(event => event.record_trace === "source.complete"));
      assert.ok(request.some(event => event.record_trace === "source.cleanup" && event.disconnect_cancelled));
      assert.equal(request.at(-1).record_trace, "request.cleanup");
      console.log(`PASS ${profile}/native-serialization-trace`);
    }
  }
} catch (error) {
  failure = error;
} finally {
  lag.disable();
  child.spawnSync = spawnSync; http.createServer = createServer; syncBuiltinESMExports();
  for (const name of containers) {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(new URL(`${name}.cleanup.stderr.log`, output), logs.stderr ?? "");
    writeFileSync(new URL(`${name}.cleanup.stdout.log`, output), logs.stdout ?? "");
    const removed = spawnSync("docker", ["rm", "-f", "-v", name], { encoding: "utf8", timeout: 30000 });
    observe({ kind: "cleanup", name, status: removed.status });
    if (removed.status !== 0) failure ??= new Error(`could not remove owned container ${name}`);
  }
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  }
  const nativeFolders = readdirSync(results).filter(name => name.startsWith(`trace-${run}-`));
  const sourcesAfter = files.map(path => ({ path, sha256: hash(new URL(path, import.meta.url)) }));
  writeFileSync(new URL("identity.json", output), JSON.stringify({ image, phase, sourceFiles, sourcesAfter, nativeFolders,
    error: failure?.message, eventLoopDelayMs: { mean: lag.mean / 1e6, max: lag.max / 1e6 } }, null, 2));
  console.log(`Trace evidence: ${fileURLToPath(output)}`);
  assert.deepEqual(sourcesAfter, sourceFiles, "diagnostic sources changed during trace");
}
if (failure) throw failure;
