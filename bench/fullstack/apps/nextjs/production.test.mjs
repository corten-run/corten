// Build and test each profile separately, with the same PROFILE for both commands.
// Kept separate from fast unit tests because these checks need a built app and Chromium.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "@playwright/test";
import { qualify } from "../../../marketplace/qualify.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const fixture = fileURLToPath(new URL("../../../marketplace/fixtures/marketplace.json", import.meta.url));
const upstreamScript = fileURLToPath(new URL("../../../marketplace/upstream.mjs", import.meta.url));
const profile = process.env.PROFILE === "matched" ? "matched" : "";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function child(script, args = [], env = {}, processTree = false) {
  const environment = { ...globalThis.process.env, ...env };
  for (const [name, value] of Object.entries(environment)) if (value === undefined) delete environment[name];
  const process = spawn(globalThis.process.execPath, [script, ...args], {
    cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"],
    detached: processTree && globalThis.process.platform !== "win32", windowsHide: true,
  });
  let log = "";
  for (const stream of [process.stdout, process.stderr]) stream.on("data", (part) => log = (log + part).slice(-16384));
  const exit = once(process, "exit");
  return {
    process, log: () => log,
    stop: async () => {
      if (process.exitCode === null) {
        if (processTree && globalThis.process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          await once(killer, "exit");
        } else if (processTree) globalThis.process.kill(-process.pid, "SIGTERM");
        else process.kill();
      }
      let limit;
      try {
        await Promise.race([exit, new Promise((_resolve, reject) => {
          limit = setTimeout(() => reject(new Error("owned child failed to exit")), 5000);
        })]);
      } finally { clearTimeout(limit); }
    },
  };
}

async function ready(base, process, path = "/health/live") {
  for (let i = 0; i < 120; i++) {
    assert.equal(process.process.exitCode, null, process.log());
    try {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(1000) });
      await response.text();
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail("server did not become live: " + process.log());
}

async function fixtureApp(profile, run, env = {}, npmStart = false) {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const entry = npmStart ? process.env.npm_execpath : "server.mjs";
  assert.ok(entry, "run the normal-start regression through npm run test:production");
  const app = child(entry, npmStart ? ["start"] : [], {
    NODE_ENV: undefined, NEXT_TELEMETRY_DISABLED: "1", PROFILE: profile,
    PORT: String(port), HOSTNAME: "127.0.0.1", HOSTS: "localhost,127.0.0.1",
    MARKETPLACE_SOURCE: "fixture", MARKETPLACE_FIXTURE_PATH: fixture,
    ITEM_SOURCE: "fixture", FIXTURE_PATH: fileURLToPath(new URL("../../fixtures/items.json", import.meta.url)),
    ...env,
  }, npmStart);
  try {
    await ready(base, app, "/api/marketplace/item_1");
    await run(base);
  } finally {
    await app.stop();
    if (npmStart) {
      // Verify the outcome, not taskkill's racy per-process exit code: npm and its server are gone.
      await new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.on("connect", () => { socket.destroy(); reject(new Error("npm start server survived cleanup")); });
        socket.on("error", (error) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
        socket.setTimeout(1000, () => socket.destroy(new Error("cleanup connection check timed out")));
      });
    }
  }
}

test("enhanced alert POST returns JSON source failures without changing its session", { timeout: 45000 }, async (t) => {
  const record = { id: "item_1", title: "Synthetic item", subtitle: null, description: "",
    categories: [], badges: [], tags: [], images: [], fields: [], summary: null,
    listings: [], offers: [], contents: [], included_in: [] };
  const upstream = createServer((request, response) => {
    const id = request.url.split("/").at(-1);
    response.setHeader("Content-Type", "application/json");
    if (id === "failed") { response.writeHead(503); response.end('{"error":"unavailable"}'); }
    else if (id === "malformed") response.end('{"id":"malformed"}');
    else if (id === "invalid-json") response.end('{');
    else response.end(JSON.stringify(record));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    await fixtureApp(profile, async (base) => {
      const initial = await fetch(base + "/api/alerts");
      assert.deepEqual(await initial.json(), []);
      const cookie = initial.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      const post = (id) => fetch(`${base}/api/marketplace/${id}/alerts?locale=en-US`, {
        method: "POST", headers: { Origin: base, Cookie: cookie },
        body: new URLSearchParams({ email: "source@example.test", target_price: "1.25" }),
        signal: AbortSignal.timeout(10000),
      });
      const accepted = await post("item_1");
      assert.equal(accepted.status, 200);
      await accepted.json();
      const readback = async () => (await fetch(base + "/api/alerts", { headers: { Cookie: cookie } })).json();
      const expected = [{ item_id: "item_1", email: "source@example.test", target_minor: 125 }];
      assert.deepEqual(await readback(), expected);
      for (const id of ["failed", "malformed", "invalid-json"]) await t.test(id, async () => {
        const response = await post(id);
        const body = await response.text();
        assert.deepEqual(await readback(), expected, "source failure must not append an alert");
        assert.equal(response.status, 502, body);
        assert.match(response.headers.get("content-type"), /application\/json/);
        assert.match(response.headers.get("cache-control"), /no-store/);
        assert.deepEqual(JSON.parse(body), { error: "marketplace source failed" });
        const get = await fetch(`${base}/api/marketplace/${id}`);
        assert.equal(get.status, 502);
        assert.deepEqual(await get.json(), { error: "marketplace source failed" });
      });
    }, { MARKETPLACE_SOURCE: "http", API_BASE: `http://127.0.0.1:${upstream.address().port}` });
  } finally {
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("marketplace forms use the configured public origin only on its exact Host", { timeout: 45000 }, async () => {
  const publicOrigin = "https://localhost:8080";
  const form = "email=edge%40example.test&target_price=1.25";
  await fixtureApp(profile, async (base) => {
    const send = (path, headers, body) => new Promise((resolve, reject) => {
      const req = request(new URL(path, base), {
        method: body ? "POST" : "GET", headers, signal: AbortSignal.timeout(5000),
      }, async (res) => {
        try {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          resolve({ status: res.statusCode, cookie: res.headers["set-cookie"]?.[0], body: Buffer.concat(chunks).toString() });
        } catch (error) { reject(error); }
      });
      req.once("error", reject);
      req.end(body);
    });
    for (const path of ["/marketplace/en-US/item_1", "/api/marketplace/item_1/alerts?locale=en-US"]) {
      for (const [host, origin, site, status, secure] of [
        ["localhost:8080", publicOrigin, "same-origin", 200, true],
        ["localhost:8080", "http://localhost:8080", "same-origin", 403],
        ["localhost:8080", "https://other.invalid", "same-origin", 403],
        ["localhost:8081", publicOrigin, "same-origin", 403],
        ["127.0.0.1:8080", publicOrigin, "same-origin", 403],
        ["localhost:8080", undefined, "same-origin", 403],
        ["localhost:8080", publicOrigin, "cross-site", 403],
        ...(profile === "matched" ? [["other.invalid:8080", publicOrigin, "same-origin", 400]] : []),
        ["127.0.0.1:8080", "http://127.0.0.1:8080", "same-origin", 200, false],
      ]) {
        const claimed = new URL(origin ?? publicOrigin), scheme = claimed.protocol.slice(0, -1);
        const forged = { Forwarded: `host="${claimed.host}";proto=${scheme}`, "X-Forwarded-Host": claimed.host, "X-Forwarded-Proto": scheme };
        const res = await send(path, { Host: host, ...(origin && { Origin: origin }), "Sec-Fetch-Site": site,
          ...(status !== 200 && forged), "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(form) }, form);
        assert.equal(res.status, status, `${path}: ${host} from ${origin} (${site})`);
        if (status !== 200) {
          assert.ok(res.cookie === undefined, "rejected form created a session");
          continue;
        }
        assert.ok(res.cookie?.startsWith("nextjs_alerts="), "accepted form did not set the Next.js alert cookie");
        assert.equal(/;\s*secure\b/i.test(res.cookie), secure);
        const read = await send("/api/alerts", { Host: host, Cookie: res.cookie.split(";")[0] });
        assert.equal(read.status, 200);
        assert.deepEqual(JSON.parse(read.body), [{ item_id: "item_1", email: "edge@example.test", target_minor: 125 }]);
      }
    }
  }, { MARKETPLACE_PUBLIC_ORIGIN: publicOrigin });
});

test(`built ${profile || "default"} artifact preserves native not-found prerendering and rejects mismatched runtime`, () => {
  const manifest = JSON.parse(readFileSync(new URL("./.next/required-server-files.json", import.meta.url), "utf8"));
  assert.equal(manifest.config.env.PROFILE, profile, "test PROFILE must match the independently built artifact");
  const prerender = JSON.parse(readFileSync(new URL("./.next/prerender-manifest.json", import.meta.url), "utf8"));
  assert.equal(Object.hasOwn(prerender.routes, "/_not-found"), !profile, "only the default artifact prerenders its native 404");
  const wrong = spawnSync(process.execPath, ["server.mjs"], {
    cwd: directory, env: { ...process.env, NODE_ENV: undefined, PROFILE: profile ? "" : "matched" }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.equal(wrong.status, 1, wrong.stderr);
  assert.match(wrong.stderr, /PROFILE must match the Next build profile/);
});

test(`npm start entry with NODE_ENV unset: ${profile || "defaults"}`, { timeout: 45000 }, async () => {
  // npm does not set NODE_ENV. Exercise its real lifecycle command, not just node server.mjs.
  const { scripts } = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(scripts.start, "node server.mjs");
  await fixtureApp(profile, async (base) => {
    for (const path of ["/marketplace/en-US/item_1", "/", "/items/item_1"]) {
      const response = await fetch(base + path);
      const html = await response.text();
      assert.equal(response.status, 200, path);
      assert.doesNotMatch(html, /dispatcher\.getOwner/);
      assert.match(html, /<h1\b/);
    }
  }, {}, true);
});

test(`Chromium ${profile || "default"}: native 404 hydration and valid navigation`, { timeout: 60000 }, async () => {
  // Explicit production here keeps the CSP regression independent of the startup regression.
  await fixtureApp(profile, async (base) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addInitScript(() => {
        globalThis.cspViolations = [];
        document.addEventListener("securitypolicyviolation", (event) => globalThis.cspViolations.push({
          directive: event.effectiveDirective, blocked: event.blockedURI, disposition: event.disposition,
        }));
      });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const healthyPolicy = async (status, path) => {
        const response = await page.goto(base + path, { waitUntil: "networkidle" });
        assert.equal(response.status(), status, path);
        const policy = response.headers()["content-security-policy"];
        const nonce = policy ? /'nonce-([^']+)'/.exec(policy)?.[1] : "";
        if (profile) {
          assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
          assert.ok(nonce, path);
          assert.equal(response.headers()["x-content-type-options"], "nosniff");
        } else {
          assert.equal(policy, undefined, "default build retains its native, unmodified policy");
          assert.equal(response.headers()["x-content-type-options"], undefined);
        }
        assert.deepEqual(await page.evaluate(() => globalThis.cspViolations), [], path);
        assert.deepEqual(errors, [], path);
        await page.waitForFunction(() => Number.isFinite(globalThis.__hydratedAt) || globalThis.next?.router?.isReady);
        const scripts = await page.locator("script").evaluateAll((nodes) => nodes.map((node) => ({
          nonce: node.nonce, executable: !node.type || node.type === "module" || node.type.includes("javascript"),
        })));
        for (const script of scripts.filter((script) => script.executable)) assert.equal(script.nonce, nonce, path);
        assert.deepEqual(await page.evaluate(() => globalThis.cspViolations), [], path + " hydrated");
        assert.deepEqual(errors, [], path + " hydrated");
        if (status === 404) assert.equal(await page.getByRole("heading", { name: "Not found", exact: true }).isVisible(), true);
        return nonce;
      };
      const first = await healthyPolicy(404, "/marketplace/en-US/missing");
      const second = await healthyPolicy(404, "/marketplace/fr-FR/missing");
      if (profile) assert.notEqual(first, second, "404 nonces must be fresh, not a build artifact");
      await page.getByRole("link", { name: "Card Market", exact: true }).click();
      await page.waitForURL(base + "/");
      await page.getByRole("heading", { name: "Popular items", exact: true }).waitFor();
      await page.locator('a[href="/items/item_1"]').click();
      await page.waitForURL(base + "/items/item_1");
      await page.waitForLoadState("networkidle");
      assert.deepEqual(await page.evaluate(() => globalThis.cspViolations), [], "404 to native App Router navigation");
      assert.deepEqual(errors, []);
      await healthyPolicy(200, "/marketplace/fr-FR/item_1");
      await context.close();
    } finally { await browser.close(); }
  }, { NODE_ENV: "production" });
});

for (const source of profile ? ["fixture", "api"] : []) {
  test(`native matched bounded production qualification: ${source}`, { timeout: 150000 }, async () => {
    const upstreamPort = await freePort(), port = await freePort();
    const upstreamBase = `http://127.0.0.1:${upstreamPort}`, base = `http://127.0.0.1:${port}`;
    const upstream = child(upstreamScript, [], { PORT: String(upstreamPort), MARKETPLACE_FIXTURE_PATH: fixture });
    const app = child("server.mjs", [], {
      NODE_ENV: undefined, NEXT_TELEMETRY_DISABLED: "1", PROFILE: "matched", HOSTNAME: "127.0.0.1",
      PORT: String(port), HOSTS: "localhost,127.0.0.1", MAX_CONNECTIONS: "1000",
      API_BASE: upstreamBase, MARKETPLACE_SOURCE: source, MARKETPLACE_FIXTURE_PATH: fixture,
    });
    try {
      await ready(base, app);
      const result = await qualify({ base, source, upstream: upstreamBase });
      await mkdir(new URL("./work/", import.meta.url), { recursive: true });
      await writeFile(new URL(`./work/bounded-qualification-${source}.json`, import.meta.url), JSON.stringify(result, null, 2));
      assert.deepEqual(result.missing, []);
      assert.equal(result.cells.json405, "405 json");
      assert.equal(result.eligible, true);
      assert.ok(result.unmeasured.includes("connectionCap"));
      const record = "/api/marketplace/item_1";
      const alert = record + "/alerts";
      const post = (path) => fetch(base + path, {
        method: "POST", headers: { Origin: base },
        body: new URLSearchParams({ email: "method@example.test", target_price: "1.25" }),
        signal: AbortSignal.timeout(5000),
      });
      for (const send of [
        () => fetch(base + record, { method: "POST", signal: AbortSignal.timeout(5000) }),
        () => post(record + "?locale=en-US"),
        () => fetch(base + record, { method: "POST", headers: { "Content-Type": "application/json" },
          body: "{", signal: AbortSignal.timeout(5000) }),
      ]) {
        const refused = await send();
        assert.equal(refused.status, 405, "POST is not a method of the JSON record resource");
        assert.equal(refused.headers.get("allow"), "GET, HEAD");
        assert.deepEqual(await refused.json(), { error: "method not allowed" });
        assert.deepEqual(refused.headers.getSetCookie(), []);
      }
      const put = await fetch(base + alert + "?locale=en-US", {
        method: "PUT", headers: { Origin: base },
        body: new URLSearchParams({ email: "method@example.test", target_price: "1.25" }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(put.status, 405);
      assert.equal(put.headers.get("allow"), "POST");
      assert.deepEqual(await put.json(), { error: "method not allowed" });
      assert.deepEqual(put.headers.getSetCookie(), []);
      const malformed = await fetch(base + alert + "?locale=en-US", {
        method: "PUT", headers: { Origin: base, "Content-Type": "application/json" },
        body: "{", signal: AbortSignal.timeout(5000),
      });
      assert.equal(malformed.status, 400, "the write route keeps Next's native malformed-body rejection");
      await malformed.text();
      assert.deepEqual(malformed.headers.getSetCookie(), []);
      const badInput = await post(alert);
      assert.equal(badInput.status, 400, "the write resource accepts POST but requires a locale");
      assert.deepEqual(await badInput.json(), { error: "Unsupported locale" });
      assert.deepEqual(badInput.headers.getSetCookie(), []);
      const accepted = await post(alert + "?locale=en-US");
      assert.equal(accepted.status, 200);
      assert.match((await accepted.json()).message, /method@example\.test/);
      const cookie = accepted.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      assert.ok(cookie);
      const readback = await fetch(base + "/api/alerts", { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) });
      assert.equal(readback.status, 200);
      assert.deepEqual(await readback.json(), [{ item_id: "item_1", email: "method@example.test", target_minor: 125 }]);
      const first = await fetch(base + "/marketplace/fr-FR/item_1", {
        headers: { "x-nonce": "attacker", "content-security-policy": "script-src * 'unsafe-eval'" },
      });
      const html = await first.text();
      assert.equal(first.status, 200);
      assert.match(html, /<html[^>]*lang="fr-FR"/);
      const nonce = /'nonce-([^']+)'/.exec(first.headers.get("content-security-policy"))?.[1];
      assert.ok(nonce, "native page policy must carry its nonce");
      assert.notEqual(nonce, "attacker");
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)];
      assert.ok(scripts.length > 0, "Next's native scripts must remain present");
      for (const [tag] of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), "Next script missing document nonce");
      const live = await fetch(base + "/health/live", { signal: AbortSignal.timeout(5000) });
      assert.equal(live.status, 200);
      assert.equal(await live.text(), "ok");
      console.log(`${source}: bounded qualification passed. Connection-flood resistance: not measured.`);
    } finally { await Promise.all([app.stop(), upstream.stop()]); }
  });
}
