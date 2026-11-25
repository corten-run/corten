// idle.mjs <port> <path> <count>: the idle connection of the workloads `beside` and `besidemt`.
// Opens one connection to 127.0.0.1:<port>, sends `GET <path> HTTP/1.1` <count> times, each after
// the answer before it has arrived whole, and then keeps the connection open and sends nothing
// more. It prints
//   IDLE-READY <count> answers of 200 to GET <path> on one connection
// once the last answer is in, and, when it is stopped with TERM, as a turn's end stops it,
//   IDLE-HELD open for <ms> ms after its last answer, nothing received since
// and exits 0. Anything else ends it with a line that begins IDLE-FAILED and exit 1: an answer
// that is not 200 or has no Content-Length, the server closing the connection or sending anything
// after the last answer, an error, or no READY within 5 s. run-pair-fresh.sh waits for the first
// line before a turn's counters start and requires the second after the turn.
import net from "node:net";

const [port, path, count] = [Number(process.argv[2]), process.argv[3], Number(process.argv[4])];
if (!port || !path || !(count >= 1)) { console.log("IDLE-FAILED: usage: node idle.mjs <port> <path> <count>"); process.exit(1); }
const fail = (why) => { console.log(`IDLE-FAILED: ${why}`); process.exit(1); };
const request = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`;
let buf = Buffer.alloc(0), answered = 0, readyAt = null;
const sock = net.connect({ host: "127.0.0.1", port, noDelay: true });
const late = setTimeout(() => fail(`no ${count} answers within 5 s (${answered} in)`), 5000);
sock.on("connect", () => sock.write(request));
sock.on("error", (e) => fail(`socket error: ${e.message}`));
sock.on("close", () => fail(readyAt === null ? `the server closed the connection after ${answered} answers` : "the server closed the idle connection"));
sock.on("data", (d) => {
  if (readyAt !== null) fail(`${d.length} bytes received after the last answer`);
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = buf.subarray(0, end).toString("latin1");
    if (!/^HTTP\/1\.1 200 /.test(head)) fail(`answer ${answered + 1} is "${head.split("\r\n")[0]}"`);
    const m = /\r\ncontent-length: *(\d+)/i.exec(head);
    if (!m) fail(`answer ${answered + 1} has no Content-Length`);
    if (/\r\nconnection: *close/i.test(head)) fail(`answer ${answered + 1} says Connection: close`);
    const whole = end + 4 + Number(m[1]);
    if (buf.length < whole) return;
    buf = buf.subarray(whole);
    answered++;
    if (answered < count) { if (buf.length) fail("bytes after an answer before the next request was sent"); sock.write(request); continue; }
    if (buf.length) fail(`${buf.length} bytes after the last answer`);
    clearTimeout(late);
    readyAt = Date.now();
    console.log(`IDLE-READY ${count} answers of 200 to GET ${path} on one connection`);
    return;
  }
});
process.on("SIGTERM", () => {
  if (readyAt === null) fail(`stopped after ${answered} answers`);
  console.log(`IDLE-HELD open for ${Date.now() - readyAt} ms after its last answer, nothing received since`);
  process.exit(0);
});
