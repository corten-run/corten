// Memory the probe holds for a connection that is open and idle: how much its resident memory
// grows for each of many connections. Needs Linux with taskset and libjemalloc.so.2 (README.md).
//
// Usage: node idle.mjs <probe binary> [--connections 5000] [--case pipeline] [--requests 1] [--silent]
//          [--addresses 1] [--cpu 0] [--port 8080]
//
// Starts the probe (not under callgrind), opens the connections one after another, sends one
// request of the case on each (or `--requests` of them, each after the answer before it) and
// reads its answer (`--silent`: sends nothing), waits a second with nothing sent, and divides
// the growth of the process's resident memory (VmRSS) by the connections. The kernel's socket
// buffers are not the process's and are not counted.
//
// One client address has ports for about 28,000 connections to the probe: `--addresses 4` opens
// them from 127.0.0.1 to 127.0.0.4, for 100,000. This process and the probe each need that many
// open files (`ulimit -n`).
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Connection, start } from "./probe.mjs";
import { cases, named } from "./requests.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    connections: { type: "string", default: "5000" },
    case: { type: "string", default: "pipeline" },
    requests: { type: "string", default: "1" },
    silent: { type: "boolean", default: false },
    addresses: { type: "string", default: "1" },
    cpu: { type: "string", default: "0" },
    port: { type: "string", default: "8080" },
  },
});
const [binary] = positionals;
if (!binary || positionals.length !== 1) throw new Error("usage: node idle.mjs <probe binary> [--connections 5000] [--case pipeline] [--requests 1] [--silent] [--addresses 1] [--cpu 0] [--port 8080]");
const whole = (/** @type {string} */ name, /** @type {string} */ text) => {
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`--${name} takes a whole number above 0, not ${JSON.stringify(text)}`);
  return Number(text);
};
const connections = whole("connections", values.connections);
const requests = whole("requests", values.requests);
const addresses = whole("addresses", values.addresses);
const port = whole("port", values.port);
if (addresses > 254) throw new Error("--addresses takes at most 254");
const [name] = named(values.case);
const { configuration, request } = /** @type {typeof cases[string]} */ (cases[/** @type {string} */ (name)]);
const bytes = request(port);

/** The process's resident memory, in bytes. @param {number} pid */
function resident(pid) {
  const found = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  if (!found) throw new Error("no VmRSS for the probe");
  return Number(found[1]) * 1024;
}

const probe = await start(binary, configuration, { cpu: values.cpu, port });
try {
  // Warm: the first connections and requests allocate what the probe keeps for all of them.
  for (let warm = 0; warm < 50; warm += 1) {
    const connection = await Connection.open(port);
    connection.write(bytes);
    await connection.answer();
    await connection.close();
  }
  await sleep(500);
  const before = resident(probe.pid);
  const held = [];
  const began = performance.now();
  for (let at = 0; at < connections; at += 1) {
    // An address is bound only to spread the connections: a bound client opens them more slowly.
    const connection = await Connection.open(port, addresses > 1 ? `127.0.0.${1 + (at % addresses)}` : undefined);
    if (!values.silent) {
      for (let sent = 0; sent < requests; sent += 1) {
        connection.write(bytes);
        await connection.answer();
      }
    }
    held.push(connection);
  }
  const took = (performance.now() - began) / 1000;
  await sleep(1000);
  const after = resident(probe.pid);
  // A connection the probe has closed (Corten waits 30 seconds for a request unless the app says
  // otherwise) holds nothing there: the growth is divided by the connections only if all are open.
  const closed = held.filter((connection) => connection.closed).length;
  for (const connection of held) connection.socket.destroy();
  if (closed > 0) throw new Error(`not a measurement: the probe had closed ${closed} of the ${connections} connections, which took ${took.toFixed(1)} s to open`);
  const what = values.silent ? "sent nothing" : `answered ${requests} ${name}`;
  console.log(`${Math.round((after - before) / connections)} bytes a connection (${connections} that ${what}, opened in ${took.toFixed(1)} s; ${before} before, ${after} after)`);
} finally {
  await probe.stop();
}
