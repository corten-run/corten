// capture.mjs <port> <out dir>: a listening socket that saves the bytes of every request it is
// sent, head and all, as <out dir>/request-<n>.bin in the order they came, and answers each
// `200` with two bytes. verify.mjs runs it in a container named as the app is, so the load
// generator reaches it as it reaches the app.
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
const [port, out] = process.argv.slice(2);
let n = 0;
createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const at = buf.indexOf("\r\n\r\n");
      if (at < 0) return;
      writeFileSync(`${out}/request-${++n}.bin`, buf.subarray(0, at + 4));
      buf = buf.subarray(at + 4);
      sock.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
    }
  });
  sock.on("error", () => {});
}).listen(Number(port), "0.0.0.0", () => console.log(`capturing on ${port}`));
