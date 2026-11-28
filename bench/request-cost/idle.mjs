// Memory the probe holds for a connection that is open and idle: how much its resident memory
// grows for each of many connections. Needs Linux with taskset and libjemalloc.so.2 (README.md).
//
// Usage: node idle.mjs <probe binary> [--connections 5000] [--case pipeline] [--requests 1 | --silent]
//          [--addresses 1] [--cpu 0] [--port 8080] [--json] [--allocator]
//
// `--json` prints the run as a line of JSON in place of the sentence, for compare.mjs to read,
// once the probe has been stopped: a run that fails there has printed no reading.
// Starts the probe (not under callgrind), opens the connections one after another, sends one
// request of the case on each (or `--requests` of them, each after the answer before it) and
// reads its answer (`--silent`: sends nothing), waits a second with nothing sent, and divides
// the growth of the process's resident memory (VmRSS) by the connections. It prints that growth in
// bytes and the page size (`getconf PAGESIZE`). With --allocator, it also samples the allocator and
// the serving thread; the gate compares growth in live bytes from those runs. The kernel's socket
// buffers are not the process's and are not counted. A run prints no figure when an answer was
// not the case's or did not come in 30 seconds, when the probe had closed a connection, or when
// its open files did not grow by the number of connections.
//
// One client address has ports for about 28,000 connections to the probe: `--addresses 4` opens
// them from 127.0.0.1 to 127.0.0.4, for 100,000. This process and the probe each need that many
// open files (`ulimit -n`).
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { held, resident } from "./figures.mjs";
import { Connection, send, start } from "./probe.mjs";
import { cases, named } from "./requests.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    connections: { type: "string", default: "5000" },
    case: { type: "string", default: "pipeline" },
    requests: { type: "string" },
    silent: { type: "boolean", default: false },
    addresses: { type: "string", default: "1" },
    cpu: { type: "string", default: "0" },
    port: { type: "string", default: "8080" },
    json: { type: "boolean", default: false },
    allocator: { type: "boolean", default: false },
  },
});
const [binary] = positionals;
if (!binary || positionals.length !== 1) throw new Error("usage: node idle.mjs <probe binary> [--connections 5000] [--case pipeline] [--requests 1 | --silent] [--addresses 1] [--cpu 0] [--port 8080] [--json] [--allocator]");
const whole = (/** @type {string} */ name, /** @type {string} */ text) => {
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`--${name} takes a whole number above 0, not ${JSON.stringify(text)}`);
  return Number(text);
};
if (values.silent && values.requests !== undefined) throw new Error("--silent sends nothing: it takes no --requests");
const connections = whole("connections", values.connections);
const requests = whole("requests", values.requests ?? "1");
const addresses = whole("addresses", values.addresses);
const port = whole("port", values.port);
if (addresses > 254) throw new Error("--addresses takes at most 254");
const [name] = /** @type {[string]} */ (named(values.case));
const { configuration, hosts } = /** @type {typeof cases[string]} */ (cases[name]);

// Resident memory moves a page at a time, so a difference of one page is the least a reading shows.
const pageSize = spawnSync("getconf", ["PAGESIZE"], { encoding: "utf8" });
const pageText = pageSize.stdout?.trim() ?? "";
const page = Number(pageText);
if (pageSize.status !== 0 || !/^[1-9]\d*$/.test(pageText) || !Number.isSafeInteger(page)) throw new Error("getconf PAGESIZE did not give the page size");

const probe = await start(binary, configuration, { cpu: values.cpu, port, hosts, idleMemory: values.allocator });
const memory = () => resident(readFileSync(`/proc/${probe.pid}/status`, "utf8"));
const files = () => readdirSync(`/proc/${probe.pid}/fd`).length;
/** The run as JSON, printed after the probe has stopped. @type {string | undefined} */
let json;
try {
  // Warm the observer too, so its first use is not included in resident or allocator growth.
  if (values.allocator) await probe.memory();
  // Warm: the first connections and requests allocate what the probe keeps for all of them.
  for (let warm = 0; warm < 50; warm += 1) {
    const connection = await Connection.open(port);
    await send(connection, name, 1);
    await connection.close();
  }
  await sleep(500);
  const before = memory();
  const open = files();
  const beforeAllocator = values.allocator ? await probe.memory() : undefined;
  const all = [];
  const began = performance.now();
  for (let at = 0; at < connections; at += 1) {
    // An address is bound only to spread the connections: a bound client opens them more slowly.
    const connection = await Connection.open(port, addresses > 1 ? `127.0.0.${1 + (at % addresses)}` : undefined);
    if (!values.silent) await send(connection, name, requests);
    all.push(connection);
  }
  const seconds = (performance.now() - began) / 1000;
  const took = `${seconds.toFixed(1)} s`;
  await sleep(1000);
  const after = memory();
  const checkHeld = () => {
    const accepted = files() - open;
    const closed = all.filter((connection) => connection.closed).length;
    try {
      return held({ connections, before, after, closed, accepted });
    } catch (error) {
      throw new Error(`${/** @type {Error} */ (error).message} (they took ${took} to open)`);
    }
  };
  let bytes;
  let diagnostic;
  try {
    bytes = checkHeld();
    if (beforeAllocator) {
      const afterAllocator = await probe.memory();
      // A close during the sweep would put the two readings over different connections.
      checkHeld();
      const allocator = {
        live: afterAllocator.live - beforeAllocator.live,
        threadNet: afterAllocator.threadNet - beforeAllocator.threadNet,
        active: afterAllocator.active - beforeAllocator.active,
      };
      if (!Object.values(allocator).every(Number.isSafeInteger)) throw new Error("idle allocator growth exceeds safe integer range");
      diagnostic = { allocator, sweepNanos: [beforeAllocator.nanos, afterAllocator.nanos] };
    }
  } finally {
    for (const connection of all) connection.socket.destroy();
  }
  const what = values.silent ? `sent nothing to the probe for ${name}` : `answered ${requests} ${name}`;
  // In JSON a connection that was sent nothing answered 0 requests. The gate compares live
  // growth in bytes, with an allowance based on the page size. `bytes` is rounded resident growth.
  const measured = { kind: diagnostic ? "idle-allocator" : "idle", case: name, requests: values.silent ? 0 : requests, connections, addresses, bytes, before, after, grown: after - before, page, seconds, ...diagnostic };
  if (values.json) json = JSON.stringify(measured);
  else {
    const rss = `${bytes} bytes a connection (${connections} that ${what}, opened in ${took}; ${before} before, ${after} after, ${after - before} grown, in ${page}-byte pages)`;
    const allocator = diagnostic?.allocator;
    console.log(allocator ? `Observer on: ${rss}; allocator growth in bytes: ${allocator.live} live, ${allocator.threadNet} serving-thread net, ${allocator.active} active` : rss);
  }
} finally {
  await probe.stop();
}
if (json !== undefined) console.log(json);
