// Untimed qualification against the same image built by the marketplace browser gate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { collectBoundedResponse } from "../../../../hardening/qualification.mjs";
import { records } from "../../../../marketplace/fixtures.mjs";
import { qualify } from "../../../../marketplace/qualify.mjs";
import { marketplaceServer } from "../../../../marketplace/upstream.mjs";

const [image, output] = process.argv.slice(2);
assert.ok(image && output, "usage: node marketplace-matched.mjs IMAGE OUTPUT_DIRECTORY");
const command = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "inherit"] }).trim();
const docker = (...args) => command("docker", args);
const head = command("git", ["rev-parse", "HEAD"]);
const [{ Id: imageId, Config: { Labels: labels } }] = JSON.parse(docker("image", "inspect", image));
assert.equal(labels["run.corten.marketplace.commit"], head);
assert.equal(labels["run.corten.marketplace.dirty"], "false");
await mkdir(output);
const results = { head, image: imageId, profile: "matched", sources: {} };
const server = marketplaceServer(records());
const controlPath = "/__marketplace/control";
const upstreamRequests = [];
server.prependListener("request", request => {
  const { pathname } = new URL(request.url, "http://marketplace");
  if (pathname !== controlPath) upstreamRequests.push(`${request.method} ${pathname}`);
});
const fixtureDir = resolve("bench/marketplace/fixtures");
const pagePath = "/marketplace/en-US/item_1";
const host = "market.drogon.test";

async function live(base) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await collectBoundedResponse(base, undefined, "/health/live", undefined, "GET").catch(() => null);
    if (result?.status === 200) return result.status;
    await sleep(100);
  }
  assert.fail("native liveness did not return 200");
}

async function scripts(browser, base) {
  const page = await browser.newPage();
  try {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.policyViolations = [];
      document.addEventListener("securitypolicyviolation", event => window.policyViolations.push(event.violatedDirective));
    });
    const response = await page.goto(base + pagePath, { timeout: 10_000 });
    assert.equal(response.status(), 200);
    assert.equal(await page.evaluate(() => typeof window.htmx === "object" && Number.isFinite(window.__hydratedAt)), true,
      "the existing same-origin scripts did not run");
    assert.deepEqual(await page.evaluate(() => window.policyViolations), []);
    assert.deepEqual(errors, []);
    return "both scripts ran without CSP violations or page errors";
  } finally { await page.close(); }
}

let browser;
try {
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  const upstream = `http://127.0.0.1:${server.address().port}`;
  const control = async (value) => {
    const response = await fetch(upstream + controlPath, {
      method: value === undefined ? "GET" : "POST",
      body: JSON.stringify(value), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  // The record fault leaves upstream /health working. Count the actual HTTP
  // requests so even a successful upstream health check fails the liveness gate.
  await control({ status: 503 });
  await control();
  assert.deepEqual(upstreamRequests, [], "the observer must ignore control requests");
  const upstreamHealth = await fetch(upstream + "/health", { signal: AbortSignal.timeout(5000) });
  assert.equal(upstreamHealth.status, 200);
  await upstreamHealth.arrayBuffer();
  assert.deepEqual(upstreamRequests, ["GET /health"], "the observer must count upstream health requests");
  browser = await chromium.launch();
  for (const source of ["fixture", "api"]) {
    await control({ status: 503 });
    const beforeLiveness = upstreamRequests.length;
    const name = `drogon-marketplace-matched-${source}-${process.pid}`;
    const container = docker("run", "-d", "--name", name, "--cpus", "1", "--memory", "512m",
      "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080",
      "-v", `${fixtureDir}:/fixtures:ro`, "-e", "PROFILE=matched", "-e", `HOSTS=127.0.0.1,${host}`,
      "-e", `MARKETPLACE_SOURCE=${source}`, "-e", `API_BASE=http://host.docker.internal:${server.address().port}`, imageId);
    try {
      const port = docker("port", container, "8080/tcp");
      assert.match(port, /^127\.0\.0\.1:\d+$/);
      const base = "http://" + port;
      const liveDuringUpstream503 = await live(base);
      const upstreamRequestsDuringLiveness = upstreamRequests.slice(beforeLiveness);
      const row = results.sources[source] = { liveDuringUpstream503, upstreamRequestsDuringLiveness };
      assert.deepEqual(upstreamRequestsDuringLiveness, [], "liveness must not contact the upstream");
      await control({});
      const qualification = await qualify({ base, source, upstream });
      row.qualification = qualification;
      row.configuredHost = (await collectBoundedResponse(base, undefined, pagePath, { host }, "GET")).status;
      assert.equal(row.configuredHost, 200);
      row.browser = await scripts(browser, base);
      console.log(`${source}: eligible=${qualification.eligible} missing=${qualification.missing.join(",") || "none"}; ${row.browser}`);
    } catch (error) {
      console.error(docker("logs", container));
      throw error;
    } finally { docker("rm", "-f", "-v", container); }
  }
  for (const [source, { qualification }] of Object.entries(results.sources)) {
    assert.equal(qualification.eligible, true, `${source}: ${qualification.missing.join(", ")}`);
  }
} finally {
  server.close();
  server.closeAllConnections();
  try { await browser?.close(); }
  finally { await writeFile(join(output, "qualification.json"), JSON.stringify(results, null, 2) + "\n"); }
}
