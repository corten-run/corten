import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import express from "express";
import timeout from "connect-timeout";
import { requestLifetime } from "./lib/request-lifetime.mjs";

for (const matched of [false, true]) test(`unfinished native parser is released after ${matched ? "matched" : "default"} timeout`, { timeout: 15000 }, async () => {
  const app = express();
  if (matched) app.use(timeout("10s"));
  let incoming, readerError, handlerCalls = 0, settle;
  const readerSettled = new Promise((resolve) => { settle = resolve; });
  const parser = express.urlencoded({ extended: false });
  app.post("/", requestLifetime, (req, res, next) => {
    incoming = req;
    parser(req, res, (error) => {
      readerError = error;
      settle(true);
      if (!res.locals.requestSignal.aborted && !res.destroyed && !req.timedout) next(error);
    });
  }, (req, res) => { handlerCalls++; res.sendStatus(200); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  let client, drip;
  try {
    const response = new Promise((resolve, reject) => {
      client = request(`http://127.0.0.1:${server.address().port}/`, { method: "POST", agent: false,
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": 100000 } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
        res.on("error", reject);
      });
      client.on("error", reject);
      client.write("email=reader%40example.test&padding=");
      drip = setInterval(() => client.write("x".repeat(100)), 100);
    });
    assert.equal(await response, matched ? 503 : 504);
    assert.equal(await Promise.race([readerSettled, sleep(500).then(() => false)]), true, "body parser was abandoned");
    assert.equal(readerError?.type, "request.aborted");
    assert.equal(incoming.destroyed, true);
    assert.equal(incoming.listenerCount("data"), 0, "raw-body retained a data reader");
    assert.equal(handlerCalls, 0);
  } finally {
    clearInterval(drip);
    client?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
