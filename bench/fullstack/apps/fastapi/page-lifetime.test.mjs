// Real socket observations. A failed capability stays a failed test, never a skip
// or synthetic success. No production timeout/worker/runtime overrides are used.
// PAGE_IMAGE=... PAGE_FRAMEWORK=fastapi|django|spring node --test page-lifetime.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import test from "node:test";
import { records } from "../../../marketplace/fixtures.mjs";

const framework = process.env.PAGE_FRAMEWORK, image = process.env.PAGE_IMAGE;
assert.ok(["fastapi", "django", "spring"].includes(framework));
assert.ok(image);
const record = records().item_1;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function docker(...args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
function send(base, path) {
  let req;
  const response = new Promise(resolve => {
    req = request(base + path, { agent: false }, res => {
      let body = "";
      res.setEncoding("utf8").on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
      res.on("error", error => resolve({ error: error.code }));
    });
    req.on("error", error => resolve({ error: error.code }));
    req.end();
  });
  return { req, response };
}

for (const profile of (process.env.PAGE_PROFILES || "defaults,matched").split(",")) {
  test(`${framework}/${profile}: native page request lifetime`, { timeout: 240000 }, async () => {
    const states = new Map();
    const sockets = new Set();
    const upstream = createServer((req, res) => {
      const state = states.get(req.url);
      assert.ok(state, "only this probe's native source requests are observed");
      state.requests++; state.pending++;
      let finished = false;
      res.on("finish", () => { finished = true; state.completed++; state.pending--; });
      res.on("close", () => {
        if (!finished) { state.cancelled++; state.pending--; state.cancelAt = performance.now(); }
        clearInterval(state.drip);
      });
      state.seen();
      if (state.mode === "normal") res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ...record, id: state.id }));
      if (state.mode === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(" ");
        // A whole-operation deadline must also stop an active, unfinished body.
        state.drip = setInterval(() => res.write(" "), 100);
      }
    });
    upstream.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise(resolve => upstream.listen(0, "0.0.0.0", resolve));
    const name = `parity-python-java-page-${framework}-${profile}-${process.pid}`;
    let started = false;
    const observations = [];
    try {
      const nativeImage = profile === "matched" ? process.env.PAGE_MATCHED_IMAGE || image : image;
      if (framework === "django" && profile === "matched") assert.ok(process.env.PAGE_MATCHED_IMAGE);
      docker("run", "-d", "--name", name, "--label", "agent.owner=codex", "--label", "agent.task=parity-python-java-page",
        "--cpus=1", "--memory=1g", "--pids-limit=256", "-p", "127.0.0.1::8080", "--add-host=host.docker.internal:host-gateway",
        "-e", `API_BASE=http://host.docker.internal:${upstream.address().port}`, "-e", "MARKETPLACE_SOURCE=api",
        "-e", `PROFILE=${profile}`, "-e", "HOSTS=localhost,127.0.0.1", nativeImage);
      started = true;
      const base = `http://${docker("port", name, "8080/tcp")}`;
      const readyBy = performance.now() + 120000;
      while (true) {
        try {
          const ready = await fetch(base + "/api/alerts", { signal: AbortSignal.timeout(1000) });
          if (ready.status === 200) break;
        } catch {}
        assert.ok(performance.now() < readyBy, "functional-test startup bound, not a qualification gate");
        await delay(100);
      }
      for (const locale of ["en-US", "fr-FR", "de-DE"]) {
        const modes = locale === "en-US" && framework === "fastapi" ? ["headers", "body"] : ["headers"];
        for (const mode of modes) {
          for (const operation of ["normal", "abort", "deadline"]) {
            let seen;
            const observed = new Promise(resolve => { seen = resolve; });
            const id = `item_lifetime_${states.size + 1}`;
            const state = { id, mode: operation === "normal" ? "normal" : mode,
              requests: 0, completed: 0, cancelled: 0, pending: 0, seen };
            // Late retries from failed-probe cleanup cannot be attributed to the
            // next operation. Each source path has its own counters and record ID.
            states.set(`/marketplace/records/${id}`, state);
            const start = performance.now(), call = send(base, `/marketplace/${locale}/${id}`);
            await Promise.race([observed, delay(10000).then(() => { throw new Error("upstream never observed"); })]);
            let result;
            if (operation === "abort") {
              await delay(50);
              call.req.destroy();
              const aborted = performance.now();
              while (state.pending && performance.now() - aborted < 500) await delay(5);
              result = { cancelMs: state.cancelAt === undefined ? null : state.cancelAt - aborted };
            } else {
              result = await Promise.race([call.response, delay(12000).then(() => ({ error: "client-timeout-after-12s" }))]);
              // Observe actual upstream cleanup, not just a status or client error.
              const cleanupBy = performance.now() + 500;
              while (state.pending && performance.now() < cleanupBy) await delay(5);
            }
            const counters = { requests: state.requests, completed: state.completed, cancelled: state.cancelled, pending: state.pending };
            const passed = operation === "normal"
              ? result.status === 200 && result.body.includes(`lang="${locale}"`) && counters.requests === 1 && counters.completed === 1 && counters.pending === 0
              : counters.requests === 1 && counters.completed === 0 && counters.cancelled === 1 && counters.pending === 0
                && (operation === "abort" ? result.cancelMs !== null && result.cancelMs <= 500 : [408, 503, 504].includes(result.status));
            const row = { framework, profile, locale, mode: state.mode, operation, passed,
              elapsedMs: Math.round(performance.now() - start), ...result, body: undefined, ...counters };
            observations.push(row);
            console.log(JSON.stringify(row));
            // Cleanup of a failed probe is deliberately AFTER the captured counters.
            call.req.destroy();
            for (const socket of sockets) socket.destroy();
            clearInterval(state.drip);
            await call.response;
            await delay(50);
          }
        }
      }
      assert.deepEqual(observations.filter(row => !row.passed), [], "real request-lifetime gate failures remain failures");
    } finally {
      if (started) docker("rm", "-f", "-v", name);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => upstream.close(resolve));
    }
  });
}
