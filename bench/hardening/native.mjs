// Additional native controls. No routes, middleware or transport are installed in the target.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateQualification } from "../marketplace/feature-contract.mjs";

const hash = (body) => createHash("sha256").update(body).digest("hex");
export function observe(url, { host, method = "GET", body, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const started = performance.now(), chunks = [];
    const row = { url: String(url), method, host: host ?? new URL(url).host };
    let size = 0, complete = false;
    const req = (new URL(url).protocol === "https:" ? https : http)(url, { method, agent: false,
      headers: { host: row.host, connection: "close", "accept-encoding": "identity", ...(body === undefined ? {} : { "content-type": "application/json" }) } }, (res) => {
      row.status = res.statusCode;
      row.headers = Object.fromEntries(["content-type", "location"].filter((key) => res.headers[key] !== undefined).map((key) => [key, res.headers[key]]));
      res.on("data", (chunk) => { size += chunk.length; if (size > 2 ** 20) req.destroy(new Error("native control response budget exceeded")); else chunks.push(chunk); });
      res.on("error", (e) => { row.error = e.code ?? e.message; });
      res.once("end", () => { complete = true; });
    });
    const timer = setTimeout(() => { row.timedOut = true; req.destroy(); }, timeoutMs);
    req.on("error", (e) => { row.error = e.code ?? e.message; });
    req.once("close", () => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      Object.assign(row, { complete, bytes: size, sha256: hash(bytes), body: bytes.toString("utf8"), ms: performance.now() - started }); resolve(row);
    });
    req.end(body);
  });
}
const jsonOf = (row) => { try { return JSON.parse(row.body); } catch { return null; } };
const healthy = (row) => row?.complete === true && !row.error && !row.timedOut && row.status === 200;
const receipt = (row) => {
  assert.ok(row && typeof row.body === "string" && typeof row.complete === "boolean" && Number.isFinite(row.ms) && row.ms >= 0);
  assert.equal(row.bytes, Buffer.byteLength(row.body)); assert.equal(row.sha256, hash(row.body));
};

export function assessNative(report, qualification) {
  validateQualification(qualification);
  assert.equal(report.schema, "native-hardening-controls/v1"); assert.equal(report.source, qualification.source);
  const { host, liveness } = report;
  receipt(host.allowed); receipt(host.denied); receipt(liveness.negative);
  assert.ok(healthy(host.allowed), "native host control needs a healthy allowed-host request");
  const hostState = host.denied.complete && [400, 403, 421].includes(host.denied.status) ? "observed"
    : healthy(host.denied) ? "missing" : "inconclusive";
  const expectedLive = qualification.probes.live?.path ?? null;
  assert.equal(liveness.path, expectedLive);
  if (expectedLive) { receipt(liveness.baseline); assert.ok(healthy(liveness.baseline), "native liveness baseline failed"); }
  const livenessState = !expectedLive ? "missing" : liveness.negative.status === 200 ? "inconclusive" : "observed";
  let sourceControl = "not-applicable";
  if (report.source === "api") {
    const api = report.api; assert.ok(api); assert.match(api.nonce, /^[a-f0-9]{24}$/);
    assert.ok(api.expected.title.includes(api.nonce));
    for (const row of api.responses) receipt(row.response);
    for (const row of api.controllers) { receipt(row.response); assert.ok(healthy(row.response), "broken API control channel"); }
    assert.deepEqual(api.controllers.map((r) => r.step), ["reset-before", "mutate", "count-json", "reset-count", "count-page", "fault-503", "fault-302", "reset-after", "verify-reset"]);
    const byName = Object.fromEntries(api.responses.map((r) => [r.step, r.response]));
    assert.deepEqual(Object.keys(byName), ["mutated-json", "mutated-page", "fault-json-503", "fault-page-503", ...(expectedLive ? ["live-503"] : []), "fault-json-302", "fault-page-302", "restored-json"]);
    assert.equal(api.responses.length, Object.keys(byName).length, "duplicate API control response");
    const counters = (step) => jsonOf(api.controllers.find((r) => r.step === step).response);
    assert.deepEqual(counters("count-json").requests, { item_1: 1 }, "native JSON did not read the upstream exactly once");
    assert.deepEqual(counters("count-page").requests, { item_1: 1 }, "native page did not read the upstream exactly once");
    const reset = counters("verify-reset"); assert.equal(reset.status, 200); assert.deepEqual(reset.answers, {}); assert.deepEqual(reset.requests, {});
    const errorResponse = (row) => row.complete && row.status >= 500 && row.status <= 599;
    const valid = healthy(byName["mutated-json"]) && isDeepStrictEqual(jsonOf(byName["mutated-json"]), api.expected)
      && byName["mutated-json"].body !== JSON.stringify(api.expected, null, 2)
      && healthy(byName["mutated-page"]) && byName["mutated-page"].body.includes(api.expected.title)
      && [503, 302].every((code) => errorResponse(byName[`fault-json-${code}`]) && errorResponse(byName[`fault-page-${code}`]))
      && healthy(byName["restored-json"]) && isDeepStrictEqual(jsonOf(byName["restored-json"]), api.original);
    sourceControl = valid ? "passed" : "target-functional-failure";
  } else assert.equal(report.api, null);
  const liveDuringFailure = expectedLive && report.source === "api" ? healthy(report.api.responses.find((r) => r.step === "live-503").response) ? "observed" : "not-live" : "unavailable";
  const productionQualified = qualification.eligible && hostState === "observed" && livenessState === "observed" && sourceControl !== "target-functional-failure"
    && (report.source !== "api" || liveDuringFailure === "observed");
  return { schema: "native-hardening-assessment/v1", representative: "existing-native-marketplace-production-matched", productionQualified,
    productionQualificationScope: "direct native production probes plus explicit deployment host/liveness/source controls; not inferred edge defense equivalence",
    missingProductionFeatures: qualification.missing,
    hostValidation: hostState, liveness: livenessState, sourceControl,
    livenessDuringUpstreamFailure: liveDuringFailure,
    qualificationPurpose: productionQualified ? "qualified-native-hardening-observation" : "explicit-native-defense-gap-observation-not-qualified-performance",
    alternatives: [] };
}

export function assessTimedSource(raw) {
  const one = (type) => { const rows = raw.filter((r) => r.type === type); assert.equal(rows.length, 1, `missing/duplicate ${type}`); receipt(rows[0].response); return rows[0].response; };
  const before = one("upstream-control-before"), after = one("upstream-control-after");
  assert.ok(healthy(before), "API upstream reset failed before timed injection"); assert.deepEqual(jsonOf(before), {});
  if (!healthy(after)) return { state: "unavailable", status: after.status ?? null, error: after.error ?? (after.timedOut ? "timeout" : "incomplete response"), counts: null };
  const counts = jsonOf(after); assert.deepEqual(Object.keys(counts).sort(), ["answers", "requests", "status"]); assert.equal(counts.status, 200, "upstream control state changed during injection");
  for (const map of [counts.requests, counts.answers]) {
    assert.ok(map && typeof map === "object" && !Array.isArray(map));
    assert.ok(Object.values(map).every((value) => Number.isSafeInteger(value) && value >= 0), "invalid upstream counters");
  }
  return { state: "observed", status: 200, counts, attribution: "all native upstream reads including attacks; not assigned to individual legitimate requests" };
}

export async function nativeControls({ base, source, upstream, qualification, original, request = observe }) {
  const page = "/marketplace/en-US/item_1", record = "/api/marketplace/item_1";
  const live = qualification.probes.live?.path ?? null;
  const report = { schema: "native-hardening-controls/v1", source,
    host: { allowed: await request(base + page), denied: await request(base + page, { host: "unrecognized.invalid" }) },
    liveness: { path: live, negative: await request(base + "/__hardening_not_a_health_endpoint"), baseline: live ? await request(base + live) : null }, api: null };
  if (source === "api") {
    const nonce = randomBytes(12).toString("hex"), expected = { ...structuredClone(original), title: `Native control ${nonce}` };
    const api = report.api = { nonce, original, expected, controllers: [], responses: [] };
    const control = async (step, value) => {
      const response = await request(upstream + "/__marketplace/control", value === undefined ? {} : { method: "POST", body: JSON.stringify(value) });
      api.controllers.push({ step, response }); assert.ok(healthy(response), `API control channel failed: ${step}`); return response;
    };
    const get = async (step, path) => api.responses.push({ step, response: await request(base + path) });
    try {
      await control("reset-before", {}); await control("mutate", { record: expected, pretty: true });
      await get("mutated-json", record); await control("count-json");
      await control("reset-count", { record: expected, pretty: true });
      await get("mutated-page", page); await control("count-page");
      await control("fault-503", { status: 503 }); await get("fault-json-503", record); await get("fault-page-503", page);
      if (live) await get("live-503", live);
      await control("fault-302", { status: 302 }); await get("fault-json-302", record); await get("fault-page-302", page);
    } finally { await control("reset-after", {}); await control("verify-reset"); }
    await get("restored-json", record);
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, source, upstream, qualificationFile, output] = process.argv.slice(2);
  const qualification = validateQualification(JSON.parse(readFileSync(qualificationFile)));
  const original = JSON.parse(readFileSync("/fixtures/marketplace.json")).item_1;
  const raw = await nativeControls({ base, source, upstream, qualification, original });
  writeFileSync(output, JSON.stringify(raw, null, 2));
  console.log(JSON.stringify(assessNative(raw, qualification)));
}
