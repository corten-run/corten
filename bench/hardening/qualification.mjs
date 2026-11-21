// Ordinary HTTP qualification for the v3 native hardening path. Capabilities
// omitted here must not be inferred from browser parity or the bounded phases.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { pathToFileURL } from "node:url";
import { formBody, formOf, livePaths } from "../fullstack/conformance.mjs";
import { csrfFields, sourceFeatures } from "../marketplace/feature-contract.mjs";

const schema = "native-bounded-qualification/v1";
const page = "/marketplace/en-US/item_1", record = "/api/marketplace/item_1";
const deadlineMs = 5000, maxResponseBytes = 2 ** 20, maxFormBytes = 8192;
const omitted = new Set(["bigHead", "bigBody", "deadline", "unfinishedHead", "connectionCap"]);
const ordinary = ["page", "json", "pageBr", "jsonBr", "jsonGzip", "page404", "json404", "json405", "head", "badHost"];
const responseFields = new Set(["status", "headers", "bodyLength", "ms", "body", "path"]);

function completed(row) {
  assert.ok(row && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599);
  assert.ok(Object.keys(row).every((key) => responseFields.has(key)), "unexpected qualification response fields");
  assert.ok(row.headers && typeof row.headers === "object" && !Array.isArray(row.headers));
  assert.ok(Number.isSafeInteger(row.bodyLength) && row.bodyLength >= 0 && row.bodyLength <= maxResponseBytes);
  assert.ok(Number.isFinite(row.ms) && row.ms >= 0 && row.ms <= deadlineMs, "qualification response missed its deadline");
}

export function boundedQualification(probes, source) {
  const features = sourceFeatures(source), required = features.filter((f) => !omitted.has(f.key));
  const cells = Object.fromEntries(required.map((f) => [f.key, f.cell(probes)]));
  const missing = required.filter((f) => !f.meets(cells[f.key])).map((f) => f.key);
  return { schema, source, probes, cells, missing, eligible: missing.length === 0,
    unmeasured: features.filter((f) => omitted.has(f.key)).map((f) => f.key) };
}

function requireOwnPost(row) {
  assert.ok(row.status >= 200 && row.status < 400 && row.headers.serverfnerror === undefined, "native same-origin form failed");
}

export function validateBoundedQualification(report) {
  assert.equal(report.schema, schema);
  assert.ok(!Object.hasOwn(report, "failure"), "incomplete qualification receipt");
  const { source, probes: p } = report;
  const keys = [...ordinary, "liveness"];
  ordinary.forEach((key) => completed(p[key]));
  for (const key of ordinary.slice(0, 5)) assert.equal(p[key].status, 200, `${key}: unhealthy qualification`);
  assert.ok(typeof p.page.body === "string" && p.page.body.length > 0 && p.page.body.length <= 4 * Math.ceil(maxResponseBytes / 3));
  const body = Buffer.from(p.page.body, "base64");
  assert.equal(body.toString("base64"), p.page.body); assert.equal(body.length, p.page.bodyLength);
  const form = formOf(body.toString("utf8"), page);
  if (!form || form.script) { assert.equal(p.form, "no native POST form"); keys.push("form"); }
  else {
    keys.push("ownPost", "crossSite");
    completed(p.ownPost); completed(p.crossSite);
    requireOwnPost(p.ownPost);
  }
  assert.ok(Array.isArray(p.liveness) && p.liveness.length > 0 && p.liveness.length <= livePaths.length);
  p.liveness.forEach((row, i) => {
    assert.equal(row.path, livePaths[i]); completed(row);
    if (i < p.liveness.length - 1) assert.notEqual(row.status, 200);
  });
  const last = p.liveness.at(-1);
  if (last.status === 200) { assert.deepEqual(p.live, last); keys.push("live"); }
  else assert.equal(p.liveness.length, livePaths.length, "incomplete liveness path discovery");
  if (source === "api") {
    for (const key of ["page500", "json500", "afterUpstream"]) { completed(p[key]); keys.push(key); }
    assert.equal(p.afterUpstream.status, 200, "unhealthy qualification after upstream control");
  }
  assert.deepEqual(Object.keys(p).sort(), keys.sort(), "unexpected or missing bounded qualification probes");
  assert.deepEqual(report, boundedQualification(p, source), "bounded qualification differs from its raw probes");
  return report;
}

class RequestFailure extends Error {}

function collect(origin, ca, path, headers, method, body) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  const tls = origin.startsWith("https:");
  if (body !== undefined && Buffer.byteLength(body) > maxFormBytes) throw new RequestFailure("form-byte-cap");
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const fail = (kind) => reject(new RequestFailure(kind));
    const abort = (kind) => { fail(kind); req.destroy(); };
    const req = (tls ? https : http)({ hostname: "127.0.0.1", port: 8080, path, method, agent: false,
      ...(tls ? { servername: "localhost", ca } : {}),
      headers: { host: new URL(origin).host, connection: "close", "accept-encoding": "identity", ...headers,
        ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }) } }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) abort("response-byte-cap");
        else if (path === page && method === "GET" && headers === undefined) chunks.push(chunk);
      });
      res.once("error", () => fail("transport-error"));
      res.once("end", () => {
        if (!res.complete) { fail("incomplete-response"); return; }
        resolve({ status: res.statusCode, headers: res.headers, bodyLength: bytes,
          ms: performance.now() - started, ...(chunks.length ? { body: Buffer.concat(chunks).toString("base64") } : {}) });
      });
    });
    const timer = setTimeout(() => abort("deadline"), deadlineMs);
    req.once("error", () => fail("transport-error")); req.once("close", () => clearTimeout(timer)); req.end(body);
  });
}

async function qualify(source, mode, upstream, p, step) {
  const origin = mode === "direct" ? "http://127.0.0.1:8080" : "https://localhost:8080";
  const ca = mode === "direct" ? undefined : await step("setup", () => readFileSync("/results/cert/cert.pem", "utf8"));
  const request = (path, headers, method = "GET", body) => collect(origin, ca, path, headers, method, body);
  const probe = async (key, ...args) => { p[key] = await step(key, () => request(...args)); };
  await probe("page", page); await probe("json", record);
  await probe("pageBr", page, { "accept-encoding": "br, gzip" });
  await probe("jsonBr", record, { "accept-encoding": "br, gzip" });
  await probe("jsonGzip", record, { "accept-encoding": "gzip" });
  await probe("page404", "/marketplace/en-US/missing"); await probe("json404", "/api/marketplace/missing");
  await probe("json405", record, undefined, "POST"); await probe("head", record, undefined, "HEAD");
  await probe("badHost", page, { host: "unrecognized.invalid" });
  const form = await step("form", () => formOf(Buffer.from(p.page.body ?? "", "base64").toString("utf8"), page));
  if (!form || form.script) p.form = "no native POST form";
  else {
    const cookie = (p.page.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
    const submit = (sameSite) => step(sameSite ? "ownPost" : "crossSite", () => {
      const data = formBody(sameSite ? form : { ...form, fields: form.fields.filter((f) => !f.hidden || !csrfFields.includes(f.name)) });
      return request(form.path, { origin: sameSite ? origin : "https://other.invalid", cookie,
        "content-type": data.type, "sec-fetch-site": sameSite ? "same-origin" : "cross-site" }, "POST", data.body);
    });
    p.ownPost = await submit(true);
    await step("ownPost", () => requireOwnPost(p.ownPost));
    p.crossSite = await submit(false);
  }
  p.liveness = [];
  for (const path of livePaths) {
    const row = { ...await step("liveness", () => request(path)), path }; p.liveness.push(row);
    if (row.status === 200) { p.live = row; break; }
  }
  if (source === "api") {
    const control = async (value) => {
      const response = await fetch(upstream + "/__marketplace/control", { method: "POST", redirect: "error",
        headers: { connection: "close" }, body: JSON.stringify(value), signal: AbortSignal.timeout(deadlineMs) });
      assert.equal(response.status, 200); await response.body.cancel();
    };
    try { await step("upstreamFault", () => control({ status: 503 })); await probe("page500", page); await probe("json500", record); }
    finally { await step("upstreamReset", () => control({})); }
    await probe("afterUpstream", page);
  }
  return validateBoundedQualification(boundedQualification(p, source));
}

// A failed run is diagnostic only. Keep observations, not headers, form bodies or exception text.
function observation(row) {
  if (Array.isArray(row)) return row.map(observation);
  if (typeof row === "string") return row;
  const { status, bodyLength, ms, path } = row;
  return { status, bodyLength, ms, ...(path === undefined ? {} : { path }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 6);
  const [source, mode, upstream, output] = process.argv.slice(2);
  assert.ok(["fixture", "api"].includes(source) && ["direct", "deployed-edge"].includes(mode));
  assert.match(upstream, /^http:\/\/hardening-[a-f0-9]{12}-cell-upstream:8080$/);
  assert.equal(output, mode === "direct" ? "/results/qualification.json" : "/results/edge-qualification.json");
  const save = (report) => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  const probes = {};
  let failure, report;
  const step = async (name, run) => {
    try { return await run(); }
    catch (error) {
      failure ??= { step: name, kind: error instanceof RequestFailure ? error.message : "qualification-error" };
      throw error;
    }
  };
  try { report = await qualify(source, mode, upstream, probes, step); }
  catch {
    failure ??= { step: "validation", kind: "qualification-error" };
    save({ schema, source, eligible: false, failure,
      probes: Object.fromEntries(Object.entries(probes).map(([key, row]) => [key, observation(row)])) });
    throw new Error(`ordinary qualification failed at ${failure.step}: ${failure.kind}`);
  }
  save(report);
}
