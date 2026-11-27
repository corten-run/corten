import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { records, writeFixture } from "../../../marketplace/fixtures.mjs";
import { marketplaceServer } from "../../../marketplace/upstream.mjs";
import { runQualificationWorker } from "../../../mixed-production/qualify-worker.mjs";
import { parseArgs } from "../../../mixed-production/run.mjs";

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
const bounded = (promise, ms = 3000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("HTTP control did not settle")), ms);
  })]).finally(() => clearTimeout(timer));
};

const cleanupMs = parseArgs(["w1"]).cleanupMs;
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
const close = (server) => !server.listening ? null : new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });

async function requireCancelledAfter(closed, abortedAt) {
  const { outcome, at } = await bounded(closed, cleanupMs);
  assert.equal(outcome, "cancelled");
  assert.ok(at >= abortedAt, "upstream closed before the client abort");
  assert.ok(at <= abortedAt + cleanupMs, "upstream drained after the Mixed cleanup bound");
}

test("cancellation proof refuses a pre-abort upstream close", async () => {
  const closed = Promise.resolve({ outcome: "cancelled", at: 1 });
  await closed;
  await assert.rejects(requireCancelledAfter(closed, 2), /closed before the client abort/);
});

async function withCandidate(args, run) {
  const image = process.env.SPRING_MIXED_IMAGE;
  assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/, "set SPRING_MIXED_IMAGE to the local candidate image ID");
  const owner = "spring-mixed-http-" + randomBytes(8).toString("hex");
  let id;
  try {
    id = docker("create", "--name", owner, "--label", "agent.owner=codex", "--label", "agent.task=" + owner,
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      "-p", "127.0.0.1::8080", "-e", "PROFILE=matched", "-e", `HOSTS=${owner},localhost,127.0.0.1`, ...args, image);
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
    await run(base, image);
  } finally {
    if (/^[a-f0-9]{64}$/.test(id ?? "")) {
      assert.equal(docker("inspect", "--format", '{{index .Config.Labels "agent.task"}}', id), owner);
      docker("rm", "-f", "-v", id);
    }
  }
}

test("Spring Mixed image passes the existing bounded production precheck", { timeout: 120000 }, async (t) => {
  const fixture = records(), temp = mkdtempSync(join(tmpdir(), "spring-mixed-http-"));
  const server = marketplaceServer(fixture);
  try {
    await listen(server);
    const port = server.address().port, upstream = "http://127.0.0.1:" + port;
    writeFixture(join(temp, "marketplace.json"), JSON.stringify(fixture));
    for (const source of ["fixture", "api"]) await t.test(source, () =>
      withCandidate(["--mount", `type=bind,source=${temp},target=/fixtures,readonly`, "-e",
        `MARKETPLACE_SOURCE=${source}`, "-e", "API_BASE=http://host.docker.internal:" + port], async (base, imageId) => {
        const folder = join(temp, source); mkdirSync(folder);
        const q = await runQualificationWorker({ app: "spring", source, imageId, nativeProfile: "matched", base, upstream,
          output: join(folder, "qualification.json") });
        assert.equal(q.failure, null);
        assert.equal(q.eligible, true, "Missing required features: " + q.missing.join(", "));
      }));
  } finally {
    try { await close(server); }
    finally {
      const rel = relative(tmpdir(), temp); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith(".."));
      rmSync(temp, { recursive: true });
    }
  }
});

test("Spring Mixed form POST writes one session alert and refuses an Origin-only cross-site POST", { timeout: 60000 }, async () => {
  const server = marketplaceServer(records());
  try {
    await listen(server);
    await withCandidate(["-e", "MARKETPLACE_SOURCE=api", "-e", "API_BASE=http://host.docker.internal:" + server.address().port], async (base) => {
      const send = (path, opts) => fetch(base + path, { redirect: "error", signal: AbortSignal.timeout(10000), ...opts });
      const form = (email) => new URLSearchParams({ email, target_price: "12.50" });
      const post = (headers, email) => send("/marketplace/en-US/item_1", { method: "POST", headers, body: form(email) });
      const readback = async (headers) => {
        const res = await send("/api/alerts", { headers });
        assert.equal(res.status, 200);
        return res.json();
      };
      const email = "native-alert@example.test";
      const accepted = await post({ origin: base }, email);
      assert.equal(accepted.status, 200);
      assert.match(accepted.headers.get("content-type") ?? "", /^text\/html\b/);
      await accepted.arrayBuffer();
      const cookies = accepted.headers.getSetCookie().filter((value) => /^SESSION=[^;]+/.test(value));
      assert.equal(cookies.length, 1, "expected one session cookie");
      const headers = { cookie: cookies[0].split(";", 1)[0] };
      const expected = [{ item_id: "item_1", email, target_minor: 1250 }];
      assert.deepEqual(await readback(headers), expected);
      assert.deepEqual(await readback({}), [], "anonymous readback must not see the alert");

      const refused = await post({ ...headers, origin: "https://foreign.example.test" }, "foreign-alert@example.test");
      assert.equal(refused.status, 403);
      await refused.arrayBuffer();
      assert.deepEqual(await readback(headers), expected);
    });
  } finally { await close(server); }
});

test("Spring Mixed image cancels real marketplace reads at headers and during the body", { timeout: 120000 }, async (t) => {
  const { item_1 } = records(), body = Buffer.from(JSON.stringify(item_1));
  const trace = "00-11111111111111111111111111111111-2222222222222222-00";
  let hold;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/marketplace/records/item_1") { res.writeHead(404).end(); return; }
    const headers = { "content-type": "application/json", "content-length": body.length };
    if (!hold) { res.writeHead(200, headers).end(body); return; }
    const active = hold; active.requests++;
    const split = active.partial ? 32 : 0;
    res.once("close", () => {
      active.close = { outcome: res.writableFinished ? "finished" : "cancelled", at: performance.now() };
      active.closed.resolve(active.close);
    });
    if (active.partial) res.writeHead(200, headers).write(body.subarray(0, split));
    active.entered.resolve({ trace: req.headers.traceparent, finish() {
      if (!active.partial) res.writeHead(200, headers);
      res.end(body.subarray(split));
    } });
  });
  try {
    await listen(server);
    await withCandidate(["-e", "MARKETPLACE_SOURCE=api", "-e", "API_BASE=http://host.docker.internal:" + server.address().port], async (base) => {
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
            await delay(abort ? 100 : cleanupMs + 150);
            assert.equal(responded, false, "rendering must still wait for the upstream");
            assert.ok(!active.close, "upstream closed while the client was still connected");
            if (abort) {
              const abortedAt = performance.now();
              caller.destroy();
              await requireCancelledAfter(active.closed.promise, abortedAt);
            } else {
              upstream.finish();
              const page = await bounded(result.promise);
              assert.equal(page?.status, 200);
              assert.ok(page.html.includes(`lang="${locale}"`) && page.html.includes("<h1>"));
              assert.equal((await bounded(active.closed.promise)).outcome, "finished");
            }
            assert.equal(active.requests, 1);
          } finally { caller.destroy(); hold = undefined; }
        });
      }
    });
  } finally { await close(server); }
});
