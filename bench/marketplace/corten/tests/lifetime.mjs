// Real native images and sockets, never an app substitute. See ../README.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const [app, image, label = "after", mode = "full"] = process.argv.slice(2);
assert.ok(["corten", "aspnet", "express"].includes(app) && image);
assert.ok(["full", "baseline", "posts", "deadlines"].includes(mode));
const output = fileURLToPath(new URL(`./results/${label}-${app}-${Date.now()}/`, import.meta.url));
mkdirSync(output, { recursive: true });
const record = JSON.parse(readFileSync(new URL("./marketplace.json", import.meta.url)));
const body = JSON.stringify(record);
const docker = (...args) => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
};
const wait = async (predicate, ms = 3000) => {
  const end = performance.now() + ms;
  while (performance.now() < end) { if (await predicate()) return true; await sleep(5); }
  return false;
};
let operation;
const upstream = createServer((req, res) => {
  const op = operation;
  assert.ok(op, "unexpected upstream work");
  op.requests++;
  op.paths.push(req.url);
  op.pending++;
  op.responses.push(res);
  let timer;
  let finished = false;
  const finish = (kind) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    op.pending--;
    op[kind]++;
    op.endedAt = performance.now();
  };
  res.once("finish", () => finish("completed"));
  res.once("close", () => finish(res.writableFinished ? "completed" : "cancelled"));
  const answer = () => {
    res.writeHead(op.status ?? 200, { "content-type": "application/json" });
    res.end(op.status ? "{}" : body);
  };
  if (op.mode === "body") {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"id":');
    timer = setTimeout(() => res.end('"item_1"}'), 40000);
  } else if (op.mode === "hold") timer = setTimeout(answer, 40000);
  else if (op.mode === "slow") timer = setTimeout(answer, 100);
  else answer();
});
upstream.listen(0, "0.0.0.0");
await once(upstream, "listening");
function arm(mode, status) {
  assert.ok(!operation?.pending, "previous source work is still running");
  return operation = { mode, status, requests: 0, completed: 0, cancelled: 0, pending: 0, paths: [], responses: [] };
}
function send(base, path, { method = "GET", headers = {}, body: data } = {}) {
  let client;
  const result = new Promise((resolve) => {
    client = request(base + path, { method, headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on("error", () => resolve({ status: 0 }));
    });
    client.on("error", () => resolve({ status: 0 }));
    client.end(data);
  });
  return { result, abort: () => client.destroy() };
}
const observations = [];
let current;
let failures = 0;
const identity = { app, image, imageId: docker("image", "inspect", image, "--format", "{{.Id}}"),
  commit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  recordSha256: createHash("sha256").update(body).digest("hex"), mode };
async function check(profile, path, kind, sourceMode, transport = {}) {
  const op = arm(sourceMode);
  const start = performance.now();
  const client = send(current.base, path, transport);
  let abortAt;
  let bound;
  const row = { profile, path, method: transport.method ?? "GET", kind, sourceMode };
  try {
    assert.ok(await wait(() => op.requests > 0), "upstream request was not observed");
    if (kind === "cancel") { await sleep(50); abortAt = performance.now(); client.abort(); }
    const result = await Promise.race([client.result, new Promise((resolve) => { bound = setTimeout(() => resolve({ status: null }), 12000); })]);
    clearTimeout(bound);
    row.status = result.status;
    row.contentType = result.headers?.["content-type"]?.split(";", 1)[0] ?? null;
    row.elapsedMs = performance.now() - start;
    await wait(() => op.pending === 0, 500);
    row.upstream = { requests: op.requests, completed: op.completed, cancelled: op.cancelled, pending: op.pending, paths: op.paths };
    if (abortAt && op.endedAt) row.cancelMs = op.endedAt - abortAt;
    if (kind === "cancel") assert.equal(result.status, 0, "real client did not abort");
    else if (kind === "deadline") {
      assert.ok([408, 503, 504].includes(result.status), `native deadline returned ${result.status}`);
      assert.ok(["text/html", "text/plain", "application/json", "application/problem+json"].includes(row.contentType), "deadline response has no contract content type");
    }
    else assert.equal(result.status, 200);
    assert.equal(op.requests, 1);
    assert.deepEqual(op.paths, ["/marketplace/records/item_1"]);
    assert.equal(op.pending, 0);
    assert.equal(op.completed, kind === "complete" ? 1 : 0);
    assert.equal(op.cancelled, kind === "complete" ? 0 : 1);
    if (kind === "cancel") assert.ok(row.cancelMs <= 500, `cancellation took ${row.cancelMs}ms`);
    if (path.startsWith("/api/") && kind === "complete") assert.deepEqual(JSON.parse(result.text), record);
    row.passed = true;
  } catch (error) { row.passed = false; row.error = error.message; failures++; }
  finally {
    clearTimeout(bound);
    // Forced test cleanup is after the evidence snapshot and never earns cancellation credit.
    client.abort();
    for (const response of op.responses) if (!response.writableFinished && !response.destroyed) response.destroy();
    await wait(() => op.pending === 0);
    observations.push(row);
    writeFileSync(output + "/summary.json", JSON.stringify({ ...identity, observations, failures }, null, 2));
    console.log(`${row.passed ? "PASS" : "FAIL"} ${app} ${profile} ${row.method} ${path} ${kind}/${sourceMode} status=${row.status} ${Math.round(row.elapsedMs)}ms${row.error ? " " + row.error : ""}`);
  }
}
try {
  for (const profile of ["defaults", "matched"]) {
    const name = `parity-lifetime-${app}-${process.pid}-${profile}`;
    current = { name };
    docker("run", "-d", "--name", name, "--label", "agent.owner=codex", "--label", "agent.task=parity-native-lifetimes",
      "--cpus", "1", "--memory", "1g", "-p", "127.0.0.1::8080",
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal=host-gateway"] : []),
      "-e", `PROFILE=${profile}`, "-e", "MAX_CONNECTIONS=256", "-e", "HOSTS=localhost,127.0.0.1",
      "-e", `API_BASE=http://host.docker.internal:${upstream.address().port}`, image);
    current.base = `http://127.0.0.1:${docker("port", name, "8080/tcp").split(":").at(-1)}`;
    assert.ok(await wait(async () => {
      try { const result = await fetch(current.base, { signal: AbortSignal.timeout(500) }); return result.status === 200; } catch { return false; }
    }, 30000), "native app startup failed");
    const locales = mode === "baseline" ? ["en-US"] : ["en-US", "fr-FR", "de-DE"];
    const paths = mode === "posts" ? [] : locales.map((locale) => `/marketplace/${locale}/item_1`);
    if (["full", "deadlines"].includes(mode)) paths.push("/api/marketplace/item_1");
    for (const path of paths) {
      for (const sourceMode of ["baseline", "deadlines"].includes(mode) ? ["hold"] : ["hold", "body"]) {
        if (mode !== "deadlines") await check(profile, path, "cancel", sourceMode);
        await check(profile, path, "deadline", sourceMode);
      }
      await check(profile, path, "complete", "slow");
    }
    if (["full", "posts"].includes(mode)) for (const locale of locales) {
      const path = `/marketplace/${locale}/item_1`;
      arm("normal");
      const page = await send(current.base, path).result;
      assert.equal(page.status, 200);
      const fields = new URLSearchParams({ email: "lifetime@example.test", target_price: locale === "en-US" ? "12.50" : "12,50" });
      // Capture the actual native antiforgery field and response cookie, never synthesize one.
      for (const [input] of page.text.matchAll(/<input\b[^>]*>/g)) {
        if (!/type="hidden"/.test(input)) continue;
        const name = /name="([^"]*)"/.exec(input)?.[1];
        const value = /value="([^"]*)"/.exec(input)?.[1];
        if (name && value !== undefined) fields.append(name, value);
      }
      if (app === "aspnet") assert.ok(fields.has("__RequestVerificationToken"));
      const cookies = new Map();
      const captureCookies = (response) => {
        for (const value of response.headers["set-cookie"] ?? []) {
          const pair = value.split(";", 1)[0], at = pair.indexOf("=");
          cookies.set(pair.slice(0, at), pair.slice(at + 1));
        }
        return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      };
      let cookie = captureCookies(page);
      const transport = { method: "POST", headers: { cookie, origin: current.base,
        "content-type": "application/x-www-form-urlencoded" }, body: fields.toString() };
      // Establish a real accepted session first: a fresh cookie-less read would not expose
      // an erroneous append whose new cookie was lost on the disconnected response.
      arm("normal");
      const accepted = await send(current.base, path, transport).result;
      assert.equal(accepted.status, 200);
      cookie = captureCookies(accepted);
      assert.ok(cookies.has("marketplace-alerts"));
      transport.headers.cookie = cookie;
      const state = await send(current.base, "/api/alerts", { headers: { cookie } }).result;
      const before = JSON.parse(state.text);
      assert.equal(before.length, 1);
      for (const kind of ["cancel", "deadline"]) {
        await check(profile, path, kind, "hold", transport);
        const readback = await send(current.base, "/api/alerts", { headers: { cookie } }).result;
        assert.equal(readback.status, 200);
        assert.deepEqual(JSON.parse(readback.text), before, "unfinished POST committed an alert");
      }
      await check(profile, path, "complete", "slow", transport);
      const recovered = await send(current.base, "/api/alerts", { headers: { cookie } }).result;
      assert.deepEqual(JSON.parse(recovered.text), [...before, ...before], "recovered POST did not append exactly once");
    }
    docker("rm", "-f", "-v", name);
    current = null;
  }
} finally {
  if (current) docker("rm", "-f", "-v", current.name);
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
console.log(`Artifacts: ${output}`);
process.exitCode = failures ? 1 : 0;
