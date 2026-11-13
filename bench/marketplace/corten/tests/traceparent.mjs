// Immutable per-operation observations against the actual native production image.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { sourceIdentity } from "./image-source.mjs";

const [app, image, label = "trace"] = process.argv.slice(2);
assert.ok(["corten", "aspnet", "express"].includes(app) && image);
const docker = (...args) => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
};
const inspected = JSON.parse(docker("image", "inspect", image))[0];
const source = sourceIdentity(app);
assert.equal(inspected.Config.Labels["bench.source.sha256"], source.sha256, "build the current source with build-lifetime.mjs");
const output = fileURLToPath(new URL(`./results/${label}-${app}-${Date.now()}/`, import.meta.url));
mkdirSync(output, { recursive: true });
const fixture = JSON.parse(readFileSync(new URL("./marketplace.json", import.meta.url)));
const identity = { app, image, imageId: inspected.Id, labels: inspected.Config.Labels, source,
  driverSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
  fixtureSha256: createHash("sha256").update(JSON.stringify(fixture)).digest("hex"), contract: "235ffd5" };
const operations = new Map(), observations = [], incomingTraceIds = new Set();
let sequence = 0, failures = 0, current;
const valid = (value) => typeof value === "string" && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)
  && value.slice(3, 35) !== "0".repeat(32) && value.slice(36, 52) !== "0".repeat(16);
function operation(mode = "normal", id) {
  const n = ++sequence, trace = `00-a${n.toString(16).padStart(31, "0")}-b${n.toString(16).padStart(15, "0")}-00`;
  incomingTraceIds.add(trace.slice(3, 35));
  const op = { key: n, id: id ?? `trace_${n}`, trace, mode, events: [] };
  operations.set(n, op);
  return op;
}
const upstream = createServer((req, res) => {
  const id = decodeURIComponent(req.url.split("/").at(-1));
  const candidates = [...operations.values()].filter((op) => op.id === id);
  const traceId = req.headers.traceparent?.slice(3, 35);
  const op = candidates.find((op) => op.trace.slice(3, 35) === traceId)
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!op) { failures++; res.writeHead(500).end(); return; }
  const event = { path: req.url, traceparent: req.headers.traceparent ?? null, completed: 0, cancelled: 0, pending: 1 };
  op.events.push(event);
  res.once("finish", () => { event.completed = 1; event.pending = 0; });
  res.once("close", () => { if (!res.writableFinished) { event.cancelled = 1; event.pending = 0; } });
  const body = JSON.stringify({ ...fixture, id });
  const answer = () => { if (!res.writableEnded) { res.writeHead(200, { "content-type": "application/json" }); res.end(body); } };
  if (op.mode === "headers") op.release = answer;
  else if (op.mode === "body") {
    res.writeHead(200, { "content-type": "application/json" });
    res.write(body.slice(0, 50));
    op.release = () => { if (!res.writableEnded) res.end(body.slice(50)); };
  } else answer();
});
upstream.listen(0, "0.0.0.0");
await once(upstream, "listening");
const wait = async (predicate, ms = 2000) => {
  const end = performance.now() + ms;
  while (performance.now() < end) { if (predicate()) return true; await sleep(5); }
  return false;
};
function send(path, { trace, method = "GET", headers = {}, data, deferred = false } = {}) {
  let client, finished = false;
  const result = new Promise((resolve, reject) => {
    client = request(current.base + path, { method, agent: false,
      headers: { ...headers, ...(trace === undefined ? {} : { traceparent: trace }) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => { finished = true; resolve({ status: res.statusCode, headers: res.headers, text }); });
      res.on("error", reject);
    });
    client.on("error", reject);
    client.setTimeout(5000, () => client.destroy(new Error("bounded native trace request timed out")));
    if (deferred) { client.flushHeaders(); client.write(data.slice(0, Math.floor(data.length / 2))); }
    else client.end(data);
  });
  // A delayed request can fail while another is being observed; retain its rejection.
  result.catch(() => {});
  return { result, finish: () => client.end(data.slice(Math.floor(data.length / 2))),
    isFinished: () => finished,
    abort: () => { if (!finished) client.destroy(); } };
}
const page = (op, locale = "en-US") => `/marketplace/${locale}/${op.id}`;
const api = (op) => `/api/marketplace/${op.id}`;
function verify(op, trace = op.trace) {
  assert.equal(op.events.length, 1, "source fetch count changed");
  const event = op.events[0];
  assert.equal(event.path, `/marketplace/records/${op.id}`);
  assert.deepEqual([event.completed, event.cancelled, event.pending], [1, 0, 0]);
  if (trace) {
    assert.ok(valid(event.traceparent), "missing/invalid native upstream traceparent");
    assert.equal(event.traceparent.slice(3, 35), trace.slice(3, 35), "upstream belongs to another operation");
  } else if (event.traceparent !== null) {
    // ASP.NET may start a fresh native Activity for an untraced request. Never adopt
    // invalid input or retain any previously issued operation's identity.
    assert.equal(app, "aspnet", "untraced source unexpectedly acquired a traceparent");
    assert.ok(valid(event.traceparent));
    assert.ok(!incomingTraceIds.has(event.traceparent.slice(3, 35)), "untraced request reused an incoming context");
  }
}
async function get(op, path = api(op), trace = op.trace, expected = op.trace) {
  const result = await send(path, { trace: trace ?? undefined }).result;
  assert.equal(result.status, 200);
  if (path.startsWith("/api/")) assert.equal(JSON.parse(result.text).id, op.id);
  verify(op, expected);
  return result;
}
async function check(name, body) {
  const start = performance.now(), first = sequence;
  const row = { profile: current.profile, name };
  try { await body(); row.passed = true; }
  catch (error) { row.passed = false; row.error = error.message; failures++; }
  row.elapsedMs = performance.now() - start;
  row.operations = [...operations.values()].filter((op) => op.key > first)
    .map(({ id, trace, mode, events }) => ({ id, trace, mode, events }));
  observations.push(row);
  writeFileSync(output + "/summary.json", JSON.stringify({ ...identity, observations, failures }, null, 2));
  console.log(`${row.passed ? "PASS" : "FAIL"} ${app} ${current.profile} ${name}${row.error ? ": " + row.error : ""}`);
  if (!row.passed) throw new Error(row.error);
}
function form(response, locale) {
  const fields = new URLSearchParams({ email: "trace@example.test", target_price: locale === "en-US" ? "12.50" : "12,50" });
  for (const [input] of response.text.matchAll(/<input\b[^>]*>/g)) {
    if (!/type="hidden"/.test(input)) continue;
    const name = /name="([^"]*)"/.exec(input)?.[1], value = /value="([^"]*)"/.exec(input)?.[1];
    if (name && value !== undefined) fields.append(name, value);
  }
  if (app === "aspnet") assert.ok(fields.has("__RequestVerificationToken"));
  return { method: "POST", data: fields.toString(), headers: {
    cookie: (response.headers["set-cookie"] ?? []).map((value) => value.split(";", 1)[0]).join("; "),
    origin: current.base, "content-type": "application/x-www-form-urlencoded",
  } };
}
try {
  for (const profile of ["defaults", "matched"]) {
    const name = `native-trace-${app}-${process.pid}-${profile}`;
    current = { name, profile };
    docker("run", "-d", "--name", name, "--label", "agent.owner=codex", "--label", "agent.task=native-trace-scope",
      "--cpus", "1", "--memory", "1g", "-p", "127.0.0.1::8080", "-e", `PROFILE=${profile}`,
      "-e", "HOSTS=localhost,127.0.0.1", "-e", "MAX_CONNECTIONS=256",
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal=host-gateway"] : []),
      "-e", `API_BASE=http://host.docker.internal:${upstream.address().port}`, inspected.Id);
    current.base = `http://127.0.0.1:${docker("port", name, "8080/tcp").split(":").at(-1)}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = (await send("/").result).status === 200; } catch { await sleep(100); }
    }
    assert.ok(ready, "native startup failed");
    for (const locale of ["en-US", "fr-FR", "de-DE"]) await check(`${locale} native page/JSON/POST/readback`, async () => {
      const op = operation(), discovery = await get(op, page(op, locale));
      const json = operation(); await get(json);
      // Reuse the discovered form's real native token and cookie for this record.
      const transport = form(discovery, locale);
      const primary = operation("normal", op.id);
      const posted = await send(page(primary, locale), { ...transport, trace: primary.trace }).result;
      assert.equal(posted.status, 200);
      verify(op); verify(primary);
      const cookie = [...(posted.headers["set-cookie"] ?? []), ...(discovery.headers["set-cookie"] ?? [])]
        .map((value) => value.split(";", 1)[0]).join("; ");
      const count = [...operations.values()].reduce((n, value) => n + value.events.length, 0);
      const readback = await send("/api/alerts", { trace: operation().trace, headers: { cookie } }).result;
      assert.equal(readback.status, 200);
      assert.deepEqual(JSON.parse(readback.text), [{ item_id: op.id, email: "trace@example.test", target_minor: 1250 }]);
      assert.equal([...operations.values()].reduce((n, value) => n + value.events.length, 0), count, "readback fetched source data");
    });
    for (const mode of ["headers", "body"]) await check(`overlapping distinct contexts with delayed ${mode}`, async () => {
      const a = operation(mode), client = send(page(a), { trace: a.trace });
      try {
        assert.ok(await wait(() => a.events.length === 1 && a.release));
        assert.equal(a.events[0].pending, 1);
        const b = operation(); await get(b);
        assert.equal(client.isFinished(), false, "delayed source response finished before release");
        assert.equal(a.events[0].pending, 1);
        a.release();
        assert.equal((await client.result).status, 200);
        verify(a);
      } finally { a.release?.(); client.abort(); }
    });
    await check("POST source starts after another context finishes", async () => {
      const discovery = operation(), response = await get(discovery, page(discovery));
      const a = operation("normal", discovery.id), transport = form(response, "en-US");
      transport.headers["content-length"] = Buffer.byteLength(transport.data);
      const client = send(page(a), { ...transport, trace: a.trace, deferred: true });
      try {
        await sleep(100);
        assert.equal(a.events.length, 0, "unfinished form started source work");
        const b = operation(); await get(b);
        assert.equal(client.isFinished(), false);
        client.finish();
        const posted = await client.result;
        assert.equal(posted.status, 200); verify(a);
        const cookie = (posted.headers["set-cookie"] ?? []).map((value) => value.split(";", 1)[0]).join("; ");
        const readback = await send("/api/alerts", { headers: { cookie } }).result;
        assert.deepEqual(JSON.parse(readback.text), [{ item_id: a.id, email: "trace@example.test", target_minor: 1250 }]);
      } finally { client.abort(); }
    });
    await check("missing/invalid contexts followed by untraced reads", async () => {
      const seed = operation(); await get(seed);
      for (const invalid of [null, "bad", seed.trace.toUpperCase(), `ff${seed.trace.slice(2)}`,
        seed.trace.replace(seed.trace.slice(3, 35), "0".repeat(32)),
        seed.trace.replace(`-${seed.trace.slice(36, 52)}-`, `-${"0".repeat(16)}-`),
        `${seed.trace}-extra`, seed.trace.replaceAll("-", "_"), [seed.trace, seed.trace]]) {
        const op = operation(); await get(op, api(op), invalid, null);
        const next = operation(); await get(next, api(next), null, null);
      }
      const future = operation(); await get(future, api(future), `01${future.trace.slice(2)}-future`);
      const last = operation(); await get(last);
    });
    docker("rm", "-f", "-v", name); current = null;
  }
} finally {
  if (current) docker("rm", "-f", "-v", current.name);
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  console.log(`Artifacts: ${output}`);
}
process.exitCode = failures ? 1 : 0;
