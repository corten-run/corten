// Untimed checks against a built Leptos image, in a separate container per source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { records } from "../../../marketplace/fixtures.mjs";
import { collectBoundedResponse } from "../../../hardening/qualification.mjs";
import { containerBase, startupFailure, writeFixtures } from "../gin/compiled-check.mjs";

const [image] = process.argv.slice(2);
assert.ok(image, "usage: node check-marketplace-production.mjs IMAGE");
const docker = (...args) => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return (args[0] === "logs" ? result.stdout + result.stderr : result.stdout).trim();
};
const imageId = docker("image", "inspect", "--format", "{{.Id}}", image);
console.log(`Checking Leptos marketplace image ${imageId}`);
const folder = await mkdtemp(join(tmpdir(), "leptos-marketplace-"));
const fixture = records();
const record = "/api/marketplace/item_1";
const site = "market.example.test";
const ipv6Loopback = "[0:0:0:0:0:0:0:1]";
const recordRead = { method: "GET", path: "/marketplace/records/item_1" };
const upstreamRequests = [];
const upstream = createServer((req, res) => {
  upstreamRequests.push({ method: req.method, path: req.url });
  if (req.method !== recordRead.method || req.url !== recordRead.path) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(fixture.item_1));
});
try {
  await new Promise((resolve, reject) => upstream.once("error", reject).listen(0, "0.0.0.0", resolve));
  await writeFixtures(folder, { "marketplace.json": fixture });
  for (const source of ["fixture", "api"]) {
    const before = upstreamRequests.length;
    const container = docker("create", "--pull=never", "--cpus", "1", "--memory", "512m", "-p", "127.0.0.1::8080",
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      "-v", `${folder}:/fixtures:ro`, "-e", "PROFILE=matched", "-e", `HOSTS=${site},Localhost:8443,${ipv6Loopback}:8443`,
      "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
      "-e", `API_BASE=http://host.docker.internal:${upstream.address().port}`, imageId);
    try {
      docker("start", container);
      const base = containerBase(docker, container);
      const request = (path, method = "GET", host = site) => collectBoundedResponse(base, undefined, path, { host }, method);
      // Wait on a source-independent control, not on one of the cells under test.
      let ready = false;
      const startupDeadline = performance.now() + 6_000;
      while (performance.now() < startupDeadline) {
        const alerts = await request("/api/alerts").catch(() => null);
        if (alerts?.status === 200) { ready = true; break; }
        await delay(100);
      }
      if (!ready) throw startupFailure(docker, container);

      const wrongMethod = await request(record, "POST");
      assert.equal(wrongMethod.status, 405, `${source}: json405`);
      assert.equal(wrongMethod.headers["content-type"], "application/problem+json", `${source}: json405 media type`);
      assert.ok(wrongMethod.bodyLength > 0, `${source}: json405 body`);
      assert.deepEqual(wrongMethod.headers.allow.split(",").map((method) => method.trim()).sort(), ["GET", "HEAD"]);
      assert.equal((await request("/marketplace/en-US/item_1", "GET", "unrecognized.invalid")).status, 400, `${source}: host`);
      assert.equal((await request("/health/live")).status, 200, `${source}: live`);
      assert.equal((await request("/health/live", "GET", new URL(base).host)).status, 200, `${source}: local access still works`);
      for (const host of ["localhost:8443", `${ipv6Loopback}:8443`, "[::1]:8443"]) {
        assert.equal((await request("/health/live", "GET", host)).status, 200, `${source}: configured loopback port (${host})`);
      }
      for (const host of ["localhost:8444", "localhost", "[::1]:8444", "[::1]"]) {
        assert.equal((await request("/health/live", "GET", host)).status, 400, `${source}: explicit loopback port takes precedence (${host})`);
      }
      assert.deepEqual(upstreamRequests.slice(before), [], `${source}: controls must not contact upstream`);

      assert.equal((await request(record)).status, 200, `${source}: configured host still serves the record`);
    } finally {
      docker("rm", "-f", "-v", container);
    }
    assert.deepEqual(upstreamRequests.slice(before), source === "api" ? [recordRead] : [], `${source}: verify the actual source`);
    console.log(`PASS leptos ${source}: json405, host policy, liveness`);
  }
} finally {
  upstream.close();
  await rm(folder, { force: true, recursive: true });
}
