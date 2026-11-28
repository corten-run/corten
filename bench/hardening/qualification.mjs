// Ordinary HTTP qualification for the v3 native hardening path. Capabilities
// omitted here must not be inferred from browser parity or the bounded phases.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { pathToFileURL } from "node:url";
import { formBody, formOf, livePaths } from "../fullstack/conformance.mjs";
import { csrfFields, boundedQualificationSchema as schema, boundedDeadlineMs as deadlineMs, boundedResponseBytes as maxResponseBytes,
  boundedQualification, validateBoundedQualification, requireOwnPost } from "../marketplace/feature-contract.mjs";
export { boundedQualification, validateBoundedQualification };

const page = "/marketplace/en-US/item_1", record = "/api/marketplace/item_1";
const maxFormBytes = 8192;

class RequestFailure extends Error {}

export function collectBoundedResponse(origin, ca, path, headers, method, body, discovery = false) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  const address = new URL(origin), tls = address.protocol === "https:";
  assert.ok(tls || address.protocol === "http:");
  if (body !== undefined && Buffer.byteLength(body) > maxFormBytes) throw new RequestFailure("form-byte-cap");
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const fail = (kind) => reject(new RequestFailure(kind));
    const abort = (kind) => { fail(kind); req.destroy(); };
    const options = { hostname: address.hostname === "localhost" ? "127.0.0.1" : address.hostname, port: address.port || (tls ? 443 : 80), path, method, agent: false,
      ...(tls ? { servername: address.hostname, ca } : {}),
      headers: { host: address.host, connection: "close", "accept-encoding": "identity", ...headers,
        ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }) } };
    const req = (tls ? https : http)(options, (res) => {
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
          ...(discovery ? { url: origin + options.path, method: options.method, host: options.headers.host } : {}),
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
  return collectQualification({ origin, source, upstream, p, step,
    request: (path, headers, method = "GET", body, discovery) => collectBoundedResponse(origin, ca, path, headers, method, body, discovery) });
}

export async function collectQualification({ origin, source, upstream, request, p = {}, step = (_name, run) => run() }) {
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
    const row = { ...await step("liveness", () => request(path, undefined, "GET", undefined, true)), path }; p.liveness.push(row);
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
