// front.mjs <probe binary> <port>: a stand-in the `ranged` plan starts in place of the probe, so
// that verify.sh meets a header that two starts of one binary send differently. The example
// probe's answer carries no such header, so this adds one: it starts the probe on <port> + 1000
// as the example plan does (jemalloc preloaded, configuration plain), passes every request to it
// and every answer back with one header more, `age: <n>`, where n counts the starts of the
// stand-in (kept in starts.count beside this file), modulo 8. Two starts in a row therefore send
// different values, each from 0 to 7.
// It is a test of the kit's mask check, not of any header of Corten's; nothing is turned behind
// it.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

const [bin, port] = process.argv.slice(2), inner = Number(port) + 1000, count = fileURLToPath(new URL("./starts.count", import.meta.url));
let n = 0;
try { n = Number(readFileSync(count, "utf8")) || 0; } catch { /* the first start */ }
writeFileSync(count, String(n + 1));
const age = String(n % 8);
const child = spawn(bin, [String(inner), "plain"], {
  env: { ...process.env, LD_PRELOAD: "libjemalloc.so.2", MALLOC_CONF: "background_thread:true,tcache_max:65536", PROBE_ALLOCATOR: "jemalloc" },
  stdio: ["ignore", "ignore", "inherit"],
});
// Stopped as a server is: the probe first, so its port is free when this has gone.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill());
child.on("exit", (code) => process.exit(code ?? 0));
const server = http.createServer((req, res) => {
  const up = http.request({ host: "127.0.0.1", port: inner, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.statusMessage, [...r.rawHeaders, "age", age]);
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
// Answers only once the probe does, so the kit's wait for the port is a wait for the probe.
const wait = () => {
  const s = net.connect(inner, "127.0.0.1");
  s.on("connect", () => { s.destroy(); server.listen(Number(port), "127.0.0.1"); });
  s.on("error", () => setTimeout(wait, 20));
};
wait();
