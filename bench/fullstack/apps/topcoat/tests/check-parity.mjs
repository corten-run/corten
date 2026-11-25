// Run against a release binary with its Topcoat asset bundle beside it. No timing result.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [, , binary, ...options] = process.argv;
assert.ok(binary && (options.length === 0 || (options.length === 1 && options[0] === "--browser")),
  "usage: node tests/check-parity.mjs PATH_TO_BUNDLED_TOPCOAT_BINARY [--browser]");
const record = JSON.parse(await readFile(new URL("./marketplace.json", import.meta.url), "utf8"));
const related = { ...record, id: "item_2", title: "Another <card>" };
const records = new Map([[record.id, record], [related.id, related]]);
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
  const status = records.has(id) ? 200 : id === "unavailable" ? 503 : 404;
  res.writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(status === 200 ? records.get(id) : { detail: "upstream-only diagnostic" }));
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

const ownedHost = "marketplace-r65-04ded02e68-topcoat";
const unknownHost = "unrecognized.invalid";
const pagePath = `/marketplace/en-US/${record.id}`;

async function withApp(source, apiPort, check, profile = "matched") {
  const probe = createServer();
  const port = await loopback(probe);
  await new Promise((done) => probe.close(done));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(resolve(binary), [], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PROFILE: profile,
      HOSTS: `${ownedHost},fsw-topcoat`,
      ITEM_SOURCE: "api", CATALOG_SOURCE: "api", MARKETPLACE_SOURCE: source,
      API_BASE: `http://127.0.0.1:${apiPort}`, MARKETPLACE_FIXTURE_PATH: fixture, MARKETPLACE_PUBLIC_ORIGIN: base },
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

// Override Host without changing the actual socket or relying on Fetch's header handling.
function statusAt(base, path, host, { method = "GET", headers = {} } = {}) {
  return new Promise((done, reject) => {
    const req = request(base + path, { method, headers: { ...headers, Host: host },
      signal: AbortSignal.timeout(5_000) }, (res) => {
      res.on("error", reject);
      res.on("end", () => done(res.statusCode));
      res.resume();
    });
    req.on("error", reject);
    req.end();
  });
}

async function problem(response, status, title) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  assert.deepEqual(await response.json(), { type: "about:blank", title, status });
}

const csp = "content-security-policy";
const strictScript = /(?:^|;\s*)script-src 'self';/;

async function checkBrowser(browser, base, policy) {
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    try {
      const page = await context.newPage();
      const errors = [], scripts = new Set();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" && /^(?:\[topcoat\])|Content Security Policy/i.test(message.text())) errors.push(message.text());
      });
      page.on("response", (response) => {
        if (response.ok() && response.request().resourceType() === "script") scripts.add(response.url());
      });
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          window.__policyViolations ??= [];
          window.__policyViolations.push(event.violatedDirective);
        });
      });
      async function checked(response) {
        assert.equal(response?.status(), 200);
        const policies = (await response.headersArray()).filter(({ name }) => name.toLowerCase() === csp);
        assert.deepEqual(policies.map(({ value }) => value), [policy]);
        if (javaScriptEnabled) {
          assert.deepEqual(await page.evaluate(() => window.__policyViolations ?? []), []);
          assert.equal(await page.evaluate(() => typeof window.__hydratedAt), "number");
        }
      }
      async function submit(button) {
        const [response] = await Promise.all([page.waitForNavigation({ waitUntil: "load" }), button.click()]);
        await checked(response);
      }

      await checked(await page.goto(base + pagePath));
      if (javaScriptEnabled) {
        const runtime = page.locator("script[type=module][data-topcoat-usize-bits]");
        assert.ok(scripts.has(new URL(await runtime.getAttribute("src"), page.url()).href),
          "the native Topcoat module loaded under the page policy");
      }
      const filter = page.locator(".marketplace__listings form");
      await filter.locator("[name=seller]").fill("Al");
      await submit(filter.locator("button"));
      assert.equal(new URL(page.url()).searchParams.get("seller"), "Al");
      assert.equal(await page.locator("[data-listing-id]").count(), 2);
      await submit(page.locator(".marketplace__more"));
      assert.equal(await page.locator("[data-offer-id]").count(), 6);
      assert.equal(await page.locator(".marketplace__contents a").getAttribute("href"), "/marketplace/en-US/item_2");

      const alert = page.locator(".marketplace__alert form");
      await alert.locator("[name=email]").fill("parity@example.test");
      await alert.locator("[name=target_price]").fill("12.34");
      await submit(alert.locator("button"));
      assert.equal(await page.locator(".marketplace__message").textContent(),
        'Alert set: we will email parity@example.test when Ember <dragon> & "foil" drops below $12.34.');
      const readback = await context.request.get(base + "/api/alerts");
      assert.equal(readback.status(), 200);
      assert.deepEqual(await readback.json(), [{ item_id: record.id, email: "parity@example.test", target_minor: 1234 }]);
      await submit(page.locator(".marketplace__contents a"));
      assert.equal(new URL(page.url()).pathname, "/marketplace/en-US/item_2");
      assert.equal(await page.locator("h1").textContent(), related.title);
      assert.deepEqual(errors, [], "browser runtime errors");
    } finally {
      await context.close();
    }
  }
}

let browser;
try {
  await writeFile(fixture, JSON.stringify(Object.fromEntries(records)));
  const apiPort = await loopback(upstream);
  if (options.length) browser = await (await import("playwright")).chromium.launch({ headless: true });
  for (const source of ["fixture", "api"]) {
    await withApp(source, apiPort, async (get, base) => {
      const json = await get(`/api/marketplace/${record.id}`);
      assert.equal(json.status, 200);
      assert.deepEqual(await json.json(), record);
      const page = await get(pagePath);
      assert.equal(page.status, 200);
      const policy = page.headers.get(csp);
      assert.match(policy, strictScript);
      const home = await get("/");
      const homePolicy = home.headers.get(csp);
      assert.match(homePolicy, /script-src 'self' 'unsafe-eval';/);
      assert.equal(policy, homePolicy.replace(" 'unsafe-eval'", ""), "only the page's eval allowance changes");
      await home.body.cancel();
      assert.match(await page.text(), /Ember &lt;dragon&gt;/);
      const port = new URL(base).port;
      for (const host of [`127.0.0.1:${port}`, "localhost", `[::1]:${port}`, ownedHost, "fsw-topcoat:8080"]) {
        assert.equal(await statusAt(base, pagePath, host), 200, host);
      }
      const beforeBadHost = structuredClone(counts);
      for (const host of [unknownHost, `${ownedHost}.invalid`, "localhost:65536"]) {
        assert.equal(await statusAt(base, pagePath, host, {
          headers: { Forwarded: `host=${ownedHost}`, "X-Forwarded-Host": ownedHost },
        }), 421, host);
      }
      assert.deepEqual(counts, beforeBadHost, "bad Host must not read the upstream");
      // In both modes the 404 and 405 have JSON bodies; native HEAD and Allow stay intact.
      await problem(await get("/api/marketplace/missing"), 404, "Not Found");
      const wrong = await get(`/api/marketplace/${record.id}`, { method: "POST", headers: { Origin: base } });
      assert.deepEqual(wrong.headers.get("allow")?.split(/,\s*/), ["GET", "HEAD"]);
      await problem(wrong, 405, "Method Not Allowed");
      const foreignPost = await get(`/api/marketplace/${record.id}`, {
        method: "POST", headers: { Origin: "https://foreign.invalid" },
      });
      assert.equal(foreignPost.status, 403);
      const internal = `${ownedHost}:8080`, jsonPath = `/api/marketplace/${record.id}`;
      assert.equal(await statusAt(base, jsonPath, internal, {
        method: "POST", headers: { Origin: `http://${internal}` },
      }), 405, "same internal Host and Origin pass the native origin check");
      assert.equal(await statusAt(base, jsonPath, "fsw-topcoat:8080", {
        method: "POST", headers: { Origin: "https://localhost:8080", "Sec-Fetch-Site": "same-origin" },
      }), 405, "the edge's rewritten Host does not block a same-origin browser");
      assert.equal(await statusAt(base, jsonPath, internal, {
        method: "POST", headers: { Origin: "http://fsw-topcoat:8080" },
      }), 403, "a different allowed Host is not a trusted cross-origin writer");
      assert.equal(await statusAt(base, jsonPath, unknownHost, {
        method: "POST", headers: { Origin: `http://${unknownHost}` },
      }), 421, "same Origin does not make an unknown Host valid");
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
      if (browser) {
        const beforeBrowser = counts.get(record.id)?.requests ?? 0;
        await checkBrowser(browser, base, policy);
        if (source === "api") assert.ok((counts.get(record.id)?.requests ?? 0) > beforeBrowser,
          "matched API browser navigations read the upstream");
      }
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
    console.log(`PASS Topcoat matched ${source}: native Marketplace HTTP${browser ? " and Chromium (JS on/off)" : ""}`);
  }
  await withApp("fixture", apiPort, async (get, base) => {
    assert.equal(await statusAt(base, pagePath, unknownHost), 200, "the default profile still does not filter Host");
    const page = await get(pagePath);
    assert.equal(page.headers.get(csp), null, "the default profile still does not add a CSP");
    await page.body.cancel();
  }, "");
} finally {
  try { await browser?.close(); }
  finally {
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
    await unlink(fixture).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(folder);
  }
}
