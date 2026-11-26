// node --test bench/request-cost/probe.test.mjs
// The client against a stand-in server; it needs no probe.
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { Connection, send } from "./probe.mjs";

const ok = (/** @type {string} */ body, more = "", status = "200 OK") => `HTTP/1.1 ${status}\r\ncontent-length: ${body.length}\r\ndate: now\r\n${more}\r\n${body}`;

/**
 * A server that answers each GET it reads with `answer(n)`, n counting from 0 over the
 * connection, and notes how many requests each read brought.
 * @param {(n: number) => string | null} answer null closes the connection instead
 */
async function standIn(answer) {
  /** @type {number[]} */
  const reads = [];
  const server = net.createServer((socket) => {
    let unread = "";
    let n = 0;
    socket.on("data", (chunk) => {
      unread += chunk.latin1Slice();
      const requests = unread.split("\r\n\r\n");
      unread = /** @type {string} */ (requests.pop());
      reads.push(requests.length);
      for (const _ of requests) {
        const next = answer(n++);
        if (next === null) return void socket.destroy();
        socket.write(Buffer.from(next, "latin1"));
      }
    });
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  return { port, reads, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** `send` to a stand-in that answers as `answer` says. */
async function sending(/** @type {(n: number) => string | null} */ answer, /** @type {string} */ name, /** @type {number} */ count, depth = 1) {
  const server = await standIn(answer);
  const connection = await Connection.open(server.port);
  try {
    return { first: await send(connection, name, count, depth), reads: server.reads };
  } finally {
    connection.socket.destroy();
    await server.close();
  }
}
const total = (/** @type {number[]} */ reads) => reads.reduce((sum, read) => sum + read, 0);

test("send writes every request, one after each answer, and gives the first answer masked", async () => {
  const { first, reads } = await sending(() => ok("3"), "get", 12);
  assert.equal(total(reads), 12);
  assert.equal(Math.max(...reads), 1);
  assert.equal(String(first), "HTTP/1.1 200 OK\r\ncontent-length: 1\r\ndate: -\r\n\r\n3");
});

test("send writes whole batches of the depth, each after the answers to the one before", async () => {
  const { reads } = await sending(() => ok("ok"), "pipeline", 10, 4);
  assert.equal(total(reads), 8);
  assert.ok(Math.max(...reads) <= 4, `a read brought ${Math.max(...reads)} requests`);
});

test("send refuses an answer that is not the case's", async () => {
  await assert.rejects(sending((n) => (n === 5 ? ok("3", "", "404 Not Found") : ok("3")), "get", 12), /get: not a 200: HTTP\/1\.1 404 Not Found/);
  await assert.rejects(sending((n) => (n === 5 ? ok("4") : ok("3")), "get", 12), /get: not the body of get: "4"/);
  await assert.rejects(sending(() => ok("3", "content-encoding: zstd\r\n"), "get", 12), /get: Content-Encoding zstd, not none/);
});

test("send refuses an answer of another length than the first", async () => {
  await assert.rejects(sending((n) => (n === 5 ? ok("3", "x-more: 1\r\n") : ok("3")), "get", 12), /an answer of another length than the first/);
});

test("an answer that never comes because the server closed is an error, not a wait", async () => {
  await assert.rejects(sending((n) => (n === 2 ? null : ok("3")), "get", 12), /the probe closed the connection|ECONNRESET/);
});

test("an answer that never comes, the connection still open, is an error once nothing has come for the connection's patience", async () => {
  const server = await standIn((n) => (n === 2 ? "" : ok("3")));
  const connection = await Connection.open(server.port);
  connection.patience = 150;
  // A client that waits without end must fail this test, not keep it waiting: after 5 seconds
  // the socket is destroyed, which ends the wait with another error than the one expected.
  const bound = setTimeout(() => connection.socket.destroy(), 5000);
  try {
    await assert.rejects(send(connection, "get", 12), /no answer from the probe in 0\.15 s/);
    assert.equal(connection.closed, false);
  } finally {
    clearTimeout(bound);
    connection.socket.destroy();
    await server.close();
  }
});
