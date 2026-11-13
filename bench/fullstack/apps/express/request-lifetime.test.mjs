import assert from "node:assert/strict";
import { once, getEventListeners } from "node:events";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import express from "express";
import timeout from "connect-timeout";
import { requestLifetime, readForm } from "./lib/request-lifetime.mjs";
import * as zlib from "node:zlib";

const compressors = {
  gzip: [zlib.createGzip, zlib.gzipSync],
  deflate: [zlib.createDeflate, zlib.deflateSync],
  br: [zlib.createBrotliCompress, zlib.brotliCompressSync],
  ...(zlib.createZstdCompress ? { zstd: [zlib.createZstdCompress, zlib.zstdCompressSync] } : {}),
};

for (const encoding of ["identity", ...Object.keys(compressors)]) for (const matched of [false, true]) test(`unfinished ${encoding} native parser is released after ${matched ? "matched" : "default"} timeout`, { timeout: 15000 }, async () => {
  const app = express();
  if (matched) app.use(timeout("10s"));
  let incoming, readerError, decoder, handlerCalls = 0, settle;
  const readerSettled = new Promise((resolve) => { settle = resolve; });
  const parser = express.urlencoded({ extended: false });
  app.post("/", requestLifetime, (req, res, next) => {
    incoming = req;
    const pipe = req.pipe;
    req.pipe = function (reader, ...args) { decoder = reader; return pipe.call(this, reader, ...args); };
    const observed = (req, res, done) => parser(req, res, (error) => {
      readerError = error; settle(true); done(error);
    });
    try { readForm(observed, req, res, next); } finally { delete req.pipe; }
  }, (req, res) => { handlerCalls++; res.sendStatus(200); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  let client, drip, compressor;
  try {
    const response = new Promise((resolve, reject) => {
      client = request(`http://127.0.0.1:${server.address().port}/`, { method: "POST", agent: false,
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": 100000,
          ...(encoding === "identity" ? {} : { "content-encoding": encoding }) } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, complete: res.complete,
          body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      });
      client.on("error", reject);
      if (encoding === "identity") {
        client.write("email=reader%40example.test&padding=");
        drip = setInterval(() => client.write("x".repeat(100)), 100);
      } else {
        compressor = compressors[encoding][0]();
        compressor.on("error", reject);
        compressor.pipe(client);
        compressor.write("email=reader%40example.test&padding=" + "x".repeat(100));
        compressor.flush();
      }
    });
    const result = await response;
    assert.equal(result.status, matched ? 503 : 504);
    assert.equal(result.complete, true, "timeout response was reset before completion");
    assert.equal(result.body, "Marketplace request timed out");
    assert.equal(await Promise.race([readerSettled, sleep(500).then(() => false)]), true, "body parser was abandoned");
    if (encoding === "identity") assert.equal(readerError?.type, "request.aborted");
    else {
      assert.ok(readerError, "decoder cancellation must settle the parser with an error");
      assert.equal(decoder.destroyed, true);
      assert.equal(decoder.listenerCount("data"), 0, "raw-body retained a decoder reader");
    }
    assert.equal(incoming.destroyed, true);
    assert.equal(incoming.listenerCount("data"), 0, "raw-body retained a data reader");
    assert.equal(handlerCalls, 0);
  } finally {
    clearInterval(drip);
    compressor?.destroy();
    client?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const [encoding, [, encode]] of Object.entries(compressors)) for (const matched of [false, true]) test(`complete ${encoding} native form remains accepted in ${matched ? "matched" : "defaults"}`, async () => {
  const app = express();
  if (matched) app.use(timeout("10s"));
  const parser = express.urlencoded({ extended: false });
  app.post("/", requestLifetime, (req, res, next) => readForm(parser, req, res, next), (req, res) => {
    assert.equal(getEventListeners(res.locals.requestSignal, "abort").length, 0);
    assert.equal(Object.hasOwn(req, "pipe"), false);
    res.json(req.body);
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-encoding": encoding },
      body: encode("email=native%40example.test&target_price=1.005"),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { email: "native@example.test", target_price: "1.005" });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const encoding of Object.keys(compressors)) for (const matched of [false, true]) test(`disconnected ${encoding} parser releases its decoder in ${matched ? "matched" : "defaults"}`, { timeout: 5000 }, async () => {
  const app = express();
  if (matched) app.use(timeout("10s"));
  const parser = express.urlencoded({ extended: false });
  let decoder, incoming, select, settle, handlerCalls = 0;
  const selected = new Promise(resolve => { select = resolve; });
  const settled = new Promise(resolve => { settle = resolve; });
  app.post("/", requestLifetime, (req, res, next) => {
    incoming = req;
    const pipe = req.pipe;
    req.pipe = function (reader, ...args) { decoder = reader; select(); return pipe.call(this, reader, ...args); };
    try {
      readForm((req, res, done) => parser(req, res, error => { settle(error); done(error); }), req, res, next);
    } finally { delete req.pipe; }
  }, (_req, res) => { handlerCalls++; res.sendStatus(200); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = request(`http://127.0.0.1:${server.address().port}/`, { method: "POST", agent: false,
    headers: { "content-type": "application/x-www-form-urlencoded", "content-encoding": encoding, "content-length": 100000 } });
  client.on("error", () => {});
  const compressor = compressors[encoding][0]();
  compressor.pipe(client);
  try {
    compressor.write("email=native%40example.test&padding=" + "x".repeat(100));
    compressor.flush();
    await selected;
    client.destroy();
    assert.ok(await Promise.race([settled, sleep(500).then(() => false)]), "disconnected parser was abandoned");
    assert.equal(decoder.destroyed, true);
    assert.equal(decoder.listenerCount("data"), 0);
    assert.equal(incoming.destroyed, true);
    assert.equal(handlerCalls, 0);
  } finally {
    compressor.destroy(); client.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
