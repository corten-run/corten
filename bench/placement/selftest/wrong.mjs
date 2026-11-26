// wrong.mjs <port> [other]: a stand-in that answers every request 200 with a body no build of a
// probe sends, for selftest.sh's case that two binaries answering differently stop a placement;
// with "other", another body of the same length and the same headers.
import { createServer } from "node:http";
const body = process.argv[3] === "other" ? "<!doctype html><p>NOT THE PROBE</p>" : "<!doctype html><p>not the probe</p>";
createServer((_, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); }).listen(Number(process.argv[2]), "127.0.0.1");
