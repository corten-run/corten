// wrong.mjs <port> [other | same <file>]: a stand-in that answers every request 200 with a body
// no build of a probe sends, for selftest.sh's case that two binaries answering differently stop
// a placement; with "other", another body of the same length and the same headers; with
// "same", the file's bytes (the probe's own body) under the stand-in's headers.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
const [mode, file] = process.argv.slice(3);
const body = mode === "same" ? readFileSync(file) : mode === "other" ? "<!doctype html><p>NOT THE PROBE</p>" : "<!doctype html><p>not the probe</p>";
createServer((_, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); }).listen(Number(process.argv[2]), "127.0.0.1");
