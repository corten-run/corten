// ask.mjs <port> <request file> <headers out> <body out>: sends a request file's lines to
// 127.0.0.1:<port> as they are written, each ended with CRLF and the request with an empty line,
// and saves the answer as curl's -D and -o do: the status line and header lines as received, and
// the body as received (a chunked body with its framing taken off, as curl saves it). For a
// request curl cannot send: curl always writes Host first, and the workloads `last` and
// `anylast` send it last. `<port>` in the file stands for the port. Exit 1 with the reason if
// the server does not answer a whole response within 10 s.
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

/** A request file's bytes on the wire. */
export function wire(file, port) {
  const lines = readFileSync(file, "utf8").replace(/\r/g, "").split("\n").filter((l) => l !== "");
  return Buffer.from(lines.map((l) => l.replaceAll("<port>", String(port)) + "\r\n").join("") + "\r\n", "latin1");
}

/** The answer in `buf` so far: null while it is not whole, else { head, body }. */
export function parse(buf, ended) {
  const at = buf.indexOf("\r\n\r\n");
  if (at < 0) return null;
  const head = buf.subarray(0, at + 4), rest = buf.subarray(at + 4);
  const text = head.toString("latin1");
  const length = /^content-length:\s*(\d+)\s*$/im.exec(text);
  if (/^transfer-encoding:.*chunked\s*$/im.test(text)) {
    const parts = [];
    let i = 0;
    for (;;) {
      const eol = rest.indexOf("\r\n", i);
      if (eol < 0) return null;
      const n = parseInt(rest.subarray(i, eol).toString("latin1"), 16);
      if (!Number.isFinite(n)) throw new Error("a chunk size that is not hex");
      if (n === 0) return rest.indexOf("\r\n\r\n", eol) >= 0 || ended ? { head, body: Buffer.concat(parts) } : null;
      if (rest.length < eol + 2 + n + 2) return null;
      parts.push(rest.subarray(eol + 2, eol + 2 + n));
      i = eol + 2 + n + 2;
    }
  }
  if (length) return rest.length >= Number(length[1]) ? { head, body: rest.subarray(0, Number(length[1])) } : null;
  return ended ? { head, body: rest } : null;
}

if (process.argv[1] && process.argv[1].endsWith("ask.mjs")) {
  const [port, file, headersOut, bodyOut] = process.argv.slice(2);
  if (!bodyOut) { console.error("usage: node ask.mjs <port> <request file> <headers out> <body out>"); process.exit(2); }
  const fail = (why) => { console.error(`ask.mjs: ${why}`); process.exit(1); };
  let got = Buffer.alloc(0), done = false;
  const sock = connect(Number(port), "127.0.0.1", () => sock.write(wire(file, port)));
  const finish = (ended) => {
    if (done) return;
    let answer;
    try { answer = parse(got, ended); } catch (e) { fail(e.message); }
    if (!answer) { if (ended) fail(`the connection ended after ${got.length} bytes, before a whole answer`); return; }
    done = true;
    writeFileSync(headersOut, answer.head);
    writeFileSync(bodyOut, answer.body);
    sock.destroy();
    process.exit(0);
  };
  sock.on("data", (d) => { got = Buffer.concat([got, d]); finish(false); });
  sock.on("end", () => finish(true));
  sock.on("error", (e) => fail(e.message));
  setTimeout(() => fail(`no whole answer in 10 s (${got.length} bytes)`), 10_000);
}
