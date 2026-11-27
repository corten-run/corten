import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { records } from "../../../marketplace/fixtures.mjs";

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
const bounded = (promise, ms = 3000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("HTTP control did not settle")), ms);
  })]).finally(() => clearTimeout(timer));
};

test("Spring Mixed image cancels real marketplace reads at headers and during the body", { timeout: 120000 }, async (t) => {
  const image = process.env.SPRING_MIXED_IMAGE;
  assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/, "set SPRING_MIXED_IMAGE to the local candidate image ID");
  const { item_1 } = records(), body = Buffer.from(JSON.stringify(item_1));
  const trace = "00-11111111111111111111111111111111-2222222222222222-00";
  let hold;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/marketplace/records/item_1") { res.writeHead(404).end(); return; }
    const headers = { "content-type": "application/json", "content-length": body.length };
    if (!hold) { res.writeHead(200, headers).end(body); return; }
    const active = hold; active.requests++;
    const split = active.partial ? 32 : 0;
    res.once("close", () => active.closed.resolve(res.writableFinished ? "finished" : "cancelled"));
    if (active.partial) res.writeHead(200, headers).write(body.subarray(0, split));
    active.entered.resolve({ trace: req.headers.traceparent, finish() {
      if (!active.partial) res.writeHead(200, headers);
      res.end(body.subarray(split));
    } });
  });
  const owner = "spring-mixed-http-" + randomBytes(8).toString("hex");
  let id;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
    id = docker("create", "--name", owner, "--label", "agent.owner=codex", "--label", "agent.task=" + owner,
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      "-p", "127.0.0.1::8080", "-e", "PROFILE=matched", "-e", "MARKETPLACE_SOURCE=api",
      "-e", "API_BASE=http://host.docker.internal:" + server.address().port, image);
    assert.match(id, /^[a-f0-9]{64}$/);
    docker("start", id);
    const port = JSON.parse(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", id))["8080/tcp"][0].HostPort;
    const base = "http://127.0.0.1:" + port;
    const deadline = performance.now() + 30000;
    for (;;) {
      try {
        const result = await fetch(base + "/api/marketplace/item_1", { signal: AbortSignal.timeout(1500) });
        await result.arrayBuffer();
        if (result.ok) break;
      } catch { /* The candidate server is still starting. */ }
      assert.ok(performance.now() < deadline, "Spring Mixed image never became ready");
      await delay(100);
    }
    for (const locale of ["en-US", "fr-FR", "de-DE"]) for (const partial of [false, true]) {
      for (const abort of [false, true]) await t.test(`${locale} ${partial ? "body" : "headers"} ${abort ? "disconnect" : "connected"}`, async () => {
        const active = { partial, requests: 0, entered: Promise.withResolvers(), closed: Promise.withResolvers() };
        hold = active;
        let responded = false;
        const result = Promise.withResolvers();
        const caller = get(base + "/marketplace/" + locale + "/item_1", { headers: { traceparent: trace }, agent: false }, async (res) => {
          responded = true;
          try {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            result.resolve({ status: res.statusCode, html: Buffer.concat(chunks).toString() });
          } catch { result.resolve(null); }
        });
        caller.once("error", () => result.resolve(null));
        try {
          const upstream = await bounded(active.entered.promise);
          assert.equal(upstream.trace, trace);
          await delay(100);
          assert.equal(responded, false, "rendering must still wait for the upstream");
          if (abort) {
            caller.destroy();
            assert.equal(await bounded(active.closed.promise), "cancelled");
          } else {
            upstream.finish();
            const page = await bounded(result.promise);
            assert.equal(page?.status, 200);
            assert.ok(page.html.includes(`lang="${locale}"`) && page.html.includes("<h1>"));
            assert.equal(await bounded(active.closed.promise), "finished");
          }
          assert.equal(active.requests, 1);
        } finally { caller.destroy(); hold = undefined; }
      });
    }
  } finally {
    try {
      if (/^[a-f0-9]{64}$/.test(id ?? "")) {
        assert.equal(docker("inspect", "--format", '{{index .Config.Labels "agent.task"}}', id), owner);
        docker("rm", "-f", "-v", id);
      }
    } finally {
      if (server.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  }
});
