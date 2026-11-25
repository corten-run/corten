// Run against a release binary with its Topcoat asset bundle beside it. No timing result.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [, , binary] = process.argv;
assert.ok(binary, "usage: node tests/check-parity.mjs PATH_TO_BUNDLED_TOPCOAT_BINARY");
const record = JSON.parse(await readFile(new URL("./marketplace.json", import.meta.url), "utf8"));
const folder = await mkdtemp(join(tmpdir(), "topcoat-parity-"));
const fixture = join(folder, "marketplace.json");
const counts = new Map();
const upstream = createServer((req, res) => {
  const id = req.url?.match(/^\/marketplace\/records\/([^/]+)$/)?.[1];
  if (req.method !== "GET" || !id) {
    res.writeHead(400).end();
    return;
  }
  const row = counts.get(id) ?? { requests: 0, cancelled: 0 };
  counts.set(id, row);
  row.requests++;
  if (id.startsWith("held_")) {
    res.on("close", () => { if (!res.writableFinished) row.cancelled++; });
    return; // Never answer or close this request from the upstream side.
  }
  const status = id === record.id ? 200 : id === "unavailable" ? 503 : 404;
  res.writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(status === 200 ? record : { detail: "upstream-only diagnostic" }));
});

async function loopback(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function until(check, ms, message) {
  const end = performance.now() + ms;
  do {
    if (await check()) return;
    await sleep(25);
  } while (performance.now() < end);
  assert.fail(message);
}

async function withApp(source, apiPort, check) {
  const probe = createServer();
  const port = await loopback(probe);
  await new Promise((done) => probe.close(done));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(resolve(binary), [], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PROFILE: "matched",
      ITEM_SOURCE: "api", CATALOG_SOURCE: "api", MARKETPLACE_SOURCE: source,
      API_BASE: `http://127.0.0.1:${apiPort}`, MARKETPLACE_FIXTURE_PATH: fixture },
  });
  let finished = false;
  const exited = new Promise((done) => {
    const settle = (outcome) => { finished = true; done(outcome); };
    child.once("exit", (code, signal) => settle(`${code ?? signal}`));
    child.once("error", (error) => settle(error.message));
  });
  const get = (path, options = {}) => fetch(base + path, { signal: AbortSignal.timeout(15_000), ...options });
  try {
    await until(async () => {
      if (finished) assert.fail(`Topcoat exited at startup: ${await exited}`);
      try { const response = await get("/", { signal: AbortSignal.timeout(500) }); await response.text(); return response.ok; }
      catch { return false; }
    }, 5_000, "Topcoat did not become ready");
    await check(get, base);
  } finally {
    if (!finished) child.kill("SIGKILL");
    await exited;
  }
}

async function problem(response, status, title) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  assert.deepEqual(await response.json(), { type: "about:blank", title, status });
}

try {
  await writeFile(fixture, JSON.stringify({ [record.id]: record }));
  const apiPort = await loopback(upstream);
  for (const source of ["fixture", "api"]) {
    await withApp(source, apiPort, async (get, base) => {
      const json = await get(`/api/marketplace/${record.id}`);
      assert.equal(json.status, 200);
      assert.deepEqual(await json.json(), record);
      const page = await get(`/marketplace/en-US/${record.id}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Ember &lt;dragon&gt;/);
      // In both modes the 404 and 405 have JSON bodies; native HEAD and Allow stay intact.
      await problem(await get("/api/marketplace/missing"), 404, "Not Found");
      const wrong = await get(`/api/marketplace/${record.id}`, { method: "POST", headers: { Origin: base } });
      assert.deepEqual(wrong.headers.get("allow")?.split(/,\s*/), ["GET", "HEAD"]);
      await problem(wrong, 405, "Method Not Allowed");
      const foreignPost = await get(`/api/marketplace/${record.id}`, {
        method: "POST", headers: { Origin: "https://foreign.invalid" },
      });
      assert.equal(foreignPost.status, 403);
      const other = await get("/api/alerts", { method: "POST", headers: { Origin: base } });
      assert.equal(other.status, 405);
      assert.equal(other.headers.get("content-type"), null);
      const head = await get(`/api/marketplace/${record.id}`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal((await get("/marketplace/en-US/missing")).status, 404);
      const beforeLive = structuredClone(counts);
      const live = await get("/health/live");
      assert.equal(live.status, 200);
      assert.equal(await live.text(), "ok\n");
      assert.deepEqual(counts, beforeLive, "liveness must not call the upstream");
      if (source === "fixture") {
        assert.equal(counts.size, 0, "fixture and liveness probes made no upstream requests");
        return;
      }

      await problem(await get("/api/marketplace/unavailable"), 500, "Internal Server Error");
      const failedPage = await get("/marketplace/en-US/unavailable");
      assert.equal(failedPage.status, 500);
      assert.match(failedPage.headers.get("content-type"), /^text\/html\b/);
      const html = await failedPage.text();
      assert.match(html, /<h1>Marketplace unavailable<\/h1>/);
      assert.doesNotMatch(html, /upstream-only diagnostic/);
      assert.deepEqual(counts.get("unavailable"), { requests: 2, cancelled: 0 });

      // Each locale blocks in the real API read. Only the app's existing deadline can answer.
      await Promise.all(["en-US", "de-DE", "fr-FR"].map(async (locale) => {
        const id = `held_${locale}`;
        const start = performance.now();
        const response = await get(`/marketplace/${locale}/${id}`, {
          headers: { Accept: "text/html", "Accept-Encoding": "br, gzip" },
        });
        assert.ok(performance.now() - start >= 9_900, `${locale} reached the 10-second deadline`);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(response.headers.get("content-encoding") ?? "identity", "identity");
        assert.equal(await response.text(), "Request deadline exceeded\n");
        await until(() => counts.get(id)?.cancelled === 1, 2_000, `${locale} upstream read was not cancelled`);
        assert.deepEqual(counts.get(id), { requests: 1, cancelled: 1 });
      }));
      assert.equal((await get(`/marketplace/fr-FR/${record.id}`)).status, 200);
    });
    console.log(`PASS Topcoat matched ${source}: native Marketplace parity probes`);
  }
} finally {
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
  await unlink(fixture).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await rmdir(folder);
}
