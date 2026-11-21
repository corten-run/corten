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

function completed(row) {
  assert.ok(row && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599);
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

export function validateBoundedQualification(report) {
  assert.equal(report.schema, schema);
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
    assert.ok(p.ownPost.status >= 200 && p.ownPost.status < 400 && p.ownPost.headers.serverfnerror === undefined, "native same-origin form failed");
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

function collect(origin, ca, path, headers, method, body) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  const tls = origin.startsWith("https:");
  assert.ok(body === undefined || Buffer.byteLength(body) <= maxFormBytes, "ordinary form request exceeds qualification cap");
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = (tls ? https : http)({ hostname: "127.0.0.1", port: 8080, path, method, agent: false,
      ...(tls ? { servername: "localhost", ca } : {}),
      headers: { host: new URL(origin).host, connection: "close", "accept-encoding": "identity", ...headers,
        ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }) } }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) req.destroy(new Error("qualification response exceeded byte cap"));
        else if (path === page && method === "GET" && headers === undefined) chunks.push(chunk);
      });
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, bodyLength: bytes,
        ms: performance.now() - started, ...(chunks.length ? { body: Buffer.concat(chunks).toString("base64") } : {}) }));
    });
    const timer = setTimeout(() => req.destroy(new Error("qualification request deadline")), deadlineMs);
    req.once("error", reject); req.once("close", () => clearTimeout(timer)); req.end(body);
  });
}

async function qualify(source, mode, upstream) {
  assert.ok(["fixture", "api"].includes(source) && ["direct", "deployed-edge"].includes(mode));
  assert.match(upstream, /^http:\/\/hardening-[a-f0-9]{12}-cell-upstream:8080$/);
  const origin = mode === "direct" ? "http://127.0.0.1:8080" : "https://localhost:8080";
  const ca = mode === "direct" ? undefined : readFileSync("/results/cert/cert.pem", "utf8");
  const request = (path, headers, method = "GET", body) => collect(origin, ca, path, headers, method, body);
  const p = { page: await request(page), json: await request(record),
    pageBr: await request(page, { "accept-encoding": "br, gzip" }),
    jsonBr: await request(record, { "accept-encoding": "br, gzip" }), jsonGzip: await request(record, { "accept-encoding": "gzip" }),
    page404: await request("/marketplace/en-US/missing"), json404: await request("/api/marketplace/missing"),
    json405: await request(record, undefined, "POST"), head: await request(record, undefined, "HEAD"),
    badHost: await request(page, { host: "unrecognized.invalid" }) };
  const form = formOf(Buffer.from(p.page.body ?? "", "base64").toString("utf8"), page);
  if (!form || form.script) p.form = "no native POST form";
  else {
    const cookie = (p.page.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
    const submit = (sameSite) => {
      const data = formBody(sameSite ? form : { ...form, fields: form.fields.filter((f) => !f.hidden || !csrfFields.includes(f.name)) });
      return request(form.path, { origin: sameSite ? origin : "https://other.invalid", cookie,
        "content-type": data.type, "sec-fetch-site": sameSite ? "same-origin" : "cross-site" }, "POST", data.body);
    };
    p.ownPost = await submit(true); p.crossSite = await submit(false);
  }
  p.liveness = [];
  for (const path of livePaths) {
    const row = { ...await request(path), path }; p.liveness.push(row);
    if (row.status === 200) { p.live = row; break; }
  }
  if (source === "api") {
    const control = async (value) => {
      const response = await fetch(upstream + "/__marketplace/control", { method: "POST", redirect: "error",
        headers: { connection: "close" }, body: JSON.stringify(value), signal: AbortSignal.timeout(deadlineMs) });
      assert.equal(response.status, 200); await response.body.cancel();
    };
    try { await control({ status: 503 }); p.page500 = await request(page); p.json500 = await request(record); }
    finally { await control({}); }
    p.afterUpstream = await request(page);
  }
  return validateBoundedQualification(boundedQualification(p, source));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 6);
  const [source, mode, upstream, output] = process.argv.slice(2);
  assert.equal(output, mode === "direct" ? "/results/qualification.json" : "/results/edge-qualification.json");
  writeFileSync(output, JSON.stringify(await qualify(source, mode, upstream), null, 2) + "\n");
}
