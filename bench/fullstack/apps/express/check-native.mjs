// Focused native HTTP regression checks, shared by the Express and FastAPI adapters only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { records as catalogRecords } from "../../../catalog/fixtures.mjs";
import { records as marketplaceRecords } from "../../../marketplace/fixtures.mjs";
import { catalogServer } from "../../../catalog/upstream.mjs";
import { marketplaceServer } from "../../../marketplace/upstream.mjs";
import { checkJsonApp } from "../../../workloads/json-check.mjs";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const docker = (...args) => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]}: ${result.stderr || result.error || result.stdout}`);
  return result.stdout.trim();
};
const waitFor = async (predicate, message, milliseconds = 3000) => {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) { if (await predicate()) return; await delay(25); }
  throw new Error(message);
};

export async function checkNative(app, image, { quick = false, regressionsOnly = false, label = "after" } = {}) {
  assert.ok(["express", "fastapi"].includes(app));
  assert.ok(image, "supply an existing native image with this adapter's dependencies");
  const adapter = join(root, "bench/fullstack/apps", app);
  const output = join(adapter, "tests/results", `${label}-${Date.now()}`);
  mkdirSync(output, { recursive: true });
  const raw = join(output, "responses.ndjson");
  let context = {};
  const observe = (value) => appendFileSync(raw, JSON.stringify({ ...context, ...value }) + "\n");
  const cases = { catalog: { payload: "catalog-v1", records: catalogRecords(), id: "record_1" },
    marketplace: { payload: "marketplace-v2", records: marketplaceRecords(), id: "item_1" } };
  for (const [kind, value] of Object.entries(cases)) writeFileSync(join(output, `${kind}.json`), JSON.stringify(value.records));
  const sources = app === "express" ? ["server.mjs", "lib/catalog.mjs", "lib/marketplace.mjs", "lib/record-json.mjs"]
    : ["app/main.py", "app/catalog.py", "app/marketplace.py", "app/record_json.py"];
  const sourceSnapshot = () => sources.flatMap((path) => {
    try { return [{ path: `bench/fullstack/apps/${app}/${path}`, sha256: createHash("sha256").update(readFileSync(join(adapter, path))).digest("hex") }]; }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  });
  const sourceFiles = sourceSnapshot();
  writeFileSync(join(output, "identity.json"), JSON.stringify({ app, image, imageId: docker("image", "inspect", image, "--format", "{{.Id}}"),
    commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(), sourceFiles }, null, 2));
  const failures = [];
  let passed = 0, current;
  const test = async (name, run) => {
    const start = performance.now();
    try { await run(); passed++; observe({ kind: "test", name, passed: true, elapsed: performance.now() - start }); console.log(`PASS ${name}`); }
    catch (error) { failures.push({ name, message: error.message }); observe({ kind: "test", name, passed: false, message: error.message, elapsed: performance.now() - start }); console.error(`FAIL ${name}: ${error.message}`); }
  };
  const originals = { catalog: catalogServer(cases.catalog.records), marketplace: marketplaceServer(cases.marketplace.records) };
  let control = null, totalReads = 0;
  const calls = [];
  const upstream = createServer((req, res) => {
    const started = performance.now();
    res.once("finish", () => observe({ kind: "upstream-finish", path: req.url, status: res.statusCode, elapsed: performance.now() - started }));
    req.once("error", (error) => observe({ kind: "upstream-request-error", path: req.url, code: error.code, elapsed: performance.now() - started }));
    if (/^\/(catalog|marketplace)\/records\//.test(req.url)) totalReads++;
    const kind = req.url.includes("marketplace") ? "marketplace" : "catalog";
    if (!control || !req.url.startsWith(`/${kind}/records/`)) return originals[kind].emit("request", req, res);
    const call = { kind, path: req.url, closed: false, start: performance.now() };
    calls.push(call);
    let timer;
    res.once("close", () => { call.closed = true; clearInterval(timer); observe({ kind: "upstream-close", path: req.url, elapsed: performance.now() - call.start }); });
    if (control === "invalid") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{bad"); }
    else if (control === "surrogate") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...cases[kind].records[cases[kind].id], title: "\ud800" }));
    }
    else if (control === "incomplete") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); }
    else if (control === "redirect") { res.writeHead(302, { Location: "/target" }); res.end(); }
    else if (control === "error") { res.writeHead(503); res.end("private upstream error"); }
    else if (control === "body") {
      res.writeHead(200, { "Content-Type": "application/json" }); res.write("{\"id\":");
      timer = setInterval(() => res.write(" "), 100);
    }
    // "headers" deliberately writes nothing until this app cancels the socket.
  });
  upstream.listen(0, "0.0.0.0"); await once(upstream, "listening");
  const upstreamPort = upstream.address().port;
  const mounts = app === "express" ? ["server.mjs", "lib", "views"].flatMap((path) => ["-v", `${join(adapter, path)}:/app/${path}:ro`])
    : ["-v", `${adapter}:/app:ro`];
  async function start(source, profile) {
    context = { source, profile: profile || "default" };
    const name = `corten-json-${app}-${process.pid}-${source}-${profile || "default"}`;
    docker("run", "-d", "--name", name, "--label", "agent.owner=codex", "--label", "agent.task=corten-bench-json-repair",
      "--cpus", "1", "--memory", "1g", ...(process.platform === "linux" ? ["--add-host", "host.docker.internal=host-gateway"] : []),
      "-p", "127.0.0.1::8080", ...mounts, "-v", `${output}:/fixtures:ro`,
      "-e", `API_BASE=http://host.docker.internal:${upstreamPort}`, "-e", `CATALOG_SOURCE=${source}`, "-e", `MARKETPLACE_SOURCE=${source}`,
      "-e", "CATALOG_FIXTURE_PATH=/fixtures/catalog.json", "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
      "-e", `PROFILE=${profile}`, "-e", "HOSTS=localhost,127.0.0.1", image);
    current = name;
    const port = docker("port", name, "8080/tcp").split(":").at(-1);
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => { try { return (await fetch(`${base}/api/catalog/record_1`, { signal: AbortSignal.timeout(1000) })).status === 200; } catch { return false; } }, "native app did not start", 30000);
    return base;
  }
  function stop() {
    if (!current) return;
    writeFileSync(join(output, `${current}.log`), docker("logs", current));
    docker("rm", "-f", "-v", current); current = null;
  }
  async function read(base, path, method = "GET") {
    const response = await fetch(base + path, { method, redirect: "manual", signal: AbortSignal.timeout(14000) });
    const result = { status: response.status, type: response.headers.get("content-type"), headers: Object.fromEntries(response.headers), body: await response.text() };
    observe({ kind: "focused", path, method, ...result });
    return result;
  }
  function jsonError(result, status) {
    assert.equal(result.status, status);
    assert.ok(["application/json", "application/problem+json"].includes(result.type?.split(";")[0]), `JSON error type: ${result.type}`);
    JSON.parse(result.body);
    assert.ok(!result.body.includes("private upstream error"), "upstream error text leaked");
  }
  try {
    for (const profile of ["", "matched"]) {
      for (const source of ["fixture", "api"]) {
        const base = await start(source, profile);
        for (const [kind, value] of Object.entries(cases)) {
          const path = `/api/${kind}/${value.id}`;
          if (app === "express") await test(`${profile || "default"}/${source}/${kind}/case-alias-errors`, async () => {
            for (const prefix of [`/API/${kind.toUpperCase()}`, `/Api/${kind[0].toUpperCase()}${kind.slice(1)}`]) {
              const valid = await read(base, `${prefix}/${value.id}`);
              assert.equal(valid.status, 200); assert.deepEqual(JSON.parse(valid.body), value.records[value.id]);
              jsonError(await read(base, `${prefix}/%ZZ`), 400);
              jsonError(await read(base, `${prefix}/missing`), 404);
              jsonError(await read(base, `${prefix}/${value.id}`, "POST"), 405);
              const head = await read(base, `${prefix}/%ZZ`, "HEAD");
              assert.equal(head.status, 400); assert.equal(head.body, ""); assert.ok(head.type?.startsWith("application/json"));
            }
          });
          if (app === "fastapi" && source === "api") await test(`${profile || "default"}/${kind}/serialization-error`, async () => {
            control = "surrogate";
            try {
              const before = calls.length;
              const result = await read(base, path); jsonError(result, 502);
              assert.equal(JSON.parse(result.body).detail, "Record source unavailable");
              assert.equal(calls.length, before + 1, "unserializable input must not retry");
            } finally { control = null; }
            const healthy = await read(base, path);
            assert.equal(healthy.status, 200); assert.deepEqual(JSON.parse(healthy.body), value.records[value.id]);
          });
          if (regressionsOnly) continue;
          await test(`${profile || "default"}/${source}/${kind}/missing`, async () => jsonError(await read(base, `/api/${kind}/missing`), 404));
          await test(`${profile || "default"}/${source}/${kind}/method`, async () => {
            const before = totalReads;
            for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
              const result = await read(base, path, method); jsonError(result, 405);
              assert.ok(result.headers.allow?.includes("GET"), "Allow must include GET");
            }
            assert.equal(totalReads, before, "wrong methods fetched upstream");
          });
          await test(`${profile || "default"}/${source}/${kind}/head`, async () => {
            const result = await read(base, path, "HEAD");
            const supported = app === "express" || profile === "matched";
            assert.equal(result.status, supported ? 200 : 405);
            assert.equal(result.body, "");
            assert.ok(result.type?.startsWith("application/json"));
          });
          await test(`${profile || "default"}/${source}/${kind}/head-missing`, async () => {
            const result = await read(base, `/api/${kind}/missing`, "HEAD");
            assert.equal(result.status, app === "fastapi" && !profile ? 405 : 404);
            assert.equal(result.body, "");
            assert.ok(result.type?.startsWith("application/json"));
          });
          if (app === "express") await test(`${profile || "default"}/${source}/${kind}/bad-id`, async () => {
            jsonError(await read(base, `/api/${kind}/%ZZ`), 400);
          });
          await test(`${profile || "default"}/${source}/${kind}/shared-gate`, async () => {
            const result = await checkJsonApp({ payload: value.payload, base, records: value.records, source,
              upstream: `http://127.0.0.1:${upstreamPort}`, observe });
            observe({ kind: "shared-result", profile, ...result });
            assert.equal(result.jsonRecords, 500);
          });
          if (source === "api") {
            for (const mode of ["error", "redirect", "invalid", "incomplete"]) {
              await test(`${profile || "default"}/${kind}/${mode}`, async () => {
                control = mode; const before = calls.length;
                jsonError(await read(base, path), 502);
                assert.equal(calls.length, before + 1, "exactly one read, without retry or redirect");
              });
              control = null;
            }
            if (app === "express" || profile === "matched") await test(`${profile || "default"}/${kind}/head-error`, async () => {
              control = "error";
              try {
                const result = await read(base, path, "HEAD");
                assert.equal(result.status, 502); assert.equal(result.body, "");
                assert.ok(result.type?.startsWith("application/json"));
              } finally { control = null; }
            });
            if (!quick) for (const phase of ["headers", "body"]) {
              await test(`${profile || "default"}/${kind}/${phase}/deadline`, async () => {
                control = phase; const before = calls.length, started = performance.now();
                const result = await read(base, path);
                assert.ok(result.status >= 500 && result.status < 600, "deadline must fail");
                jsonError(result, result.status);
                assert.ok(performance.now() - started >= 9000 && performance.now() - started < 13500, "whole read must end near ten seconds");
                await waitFor(() => calls[before]?.closed, "timed-out upstream socket remained open");
                assert.equal(calls.length, before + 1);
              });
              control = null; upstream.closeAllConnections();
              await test(`${profile || "default"}/${kind}/${phase}/caller-abort`, async () => {
                control = phase; const before = calls.length;
                const pending = request(base + path); pending.on("error", () => {}); pending.end();
                try {
                  await waitFor(() => calls.length > before, "request never reached upstream");
                  if (phase === "body") await delay(250);
                  pending.destroy();
                  await waitFor(() => calls[before].closed, "caller abort did not close in-flight upstream");
                  assert.equal(calls.length, before + 1);
                } finally { pending.destroy(); }
              });
              control = null; upstream.closeAllConnections();
              await test(`${profile || "default"}/${kind}/${phase}/recovery`, async () => {
                const result = await read(base, path); assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), value.records[value.id]);
              });
            }
          }
        }
        stop();
      }
    }
  } finally {
    stop(); upstream.closeAllConnections(); await new Promise((done) => upstream.close(done));
    for (const server of Object.values(originals)) server.closeAllConnections();
    const sourceFilesAfter = sourceSnapshot();
    if (JSON.stringify(sourceFilesAfter) !== JSON.stringify(sourceFiles)) failures.push({ name: "source-stability", message: "native sources changed during checks" });
    writeFileSync(join(output, "summary.json"), JSON.stringify({ passed, failures, quick, regressionsOnly, sourceFiles, sourceFilesAfter }, null, 2));
  }
  console.log(JSON.stringify({ app, passed, failures, output }));
  assert.equal(failures.length, 0, `${failures.length} native HTTP regressions; raw evidence: ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkNative("express", process.argv[2], { quick: process.argv.includes("--quick"), regressionsOnly: process.argv.includes("--regressions-only"), label: process.argv.includes("--before") ? "before" : "after" });
}
