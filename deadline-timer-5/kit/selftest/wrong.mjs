// wrong.mjs <port>: a stand-in that answers every request 200 with a body no build of the probe
// sends, for selftest.sh's test that two builds answering differently stop a placement.
import { createServer } from "node:http";
createServer((_, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<!doctype html><p>not the probe</p>"); }).listen(Number(process.argv[2]), "127.0.0.1");
