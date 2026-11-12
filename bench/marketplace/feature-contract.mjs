import assert from "node:assert/strict";
import { featuresOf, formOf, livePaths, maxConnections } from "../fullstack/conformance.mjs";

export const featureProfile = "marketplace-production/v1";
// The existing production checklist, excluding conditional GET and downstream
// readiness: neither is exercised by this identity-encoding, uncached load suite.
// They remain disclosed differences, not claims of complete enterprise equivalence.
export const requiredFeatures = featuresOf("matched").filter((f) => !["logLines", "etag", "readyDown"].includes(f.key)).map((f) => {
  if (f.key === "page404") return { ...f, label: "missing page returns 404", meets: (c) => c.startsWith("404 ") };
  if (f.key === "connectionCap") return { ...f, cell: (p) => p.cap?.belowHeld === 200 && p.cap?.afterwards === 200 ? f.cell(p) : "unhealthy below cap or after release", meets: (c) => c.startsWith("capped") };
  return f;
});
// Known native antiforgery token names, not action routing/record metadata. An attacker
// can copy public form fields but cannot read a fresh same-origin secret token.
export const csrfFields = ["__RequestVerificationToken", "csrfmiddlewaretoken", "authenticity_token", "_token", "_csrf_token", "_csrf"];
export const sourceFeatures = (source) => {
  assert.ok(["fixture", "api"].includes(source));
  return requiredFeatures.filter((f) => source === "api" || !["page500", "json500", "deadline"].includes(f.key));
};
export const qualificationSettings = {
  nativeProfile: "matched", maxConnections,
  required: Object.fromEntries(["fixture", "api"].map((source) => [source, sourceFeatures(source).map((f) => f.key)])),
  exceptions: ["etag", "readyDown"], logging: "native, not normalized",
  csrf: "cross-site POST without a same-origin secret token", page404: "status 404; native representation disclosed",
};
export function qualification(probes, source = "api") {
  const required = sourceFeatures(source);
  const cells = Object.fromEntries(required.map((f) => [f.key, f.cell(probes)]));
  const missing = required.filter((f) => !f.meets(cells[f.key])).map((f) => f.key);
  return { profile: featureProfile, source, probes, cells, missing, eligible: missing.length === 0 };
}
export function validateQualification(q) {
  assert.equal(q.profile, featureProfile);
  validateProbes(q.probes, q.source);
  const expected = qualification(q.probes, q.source);
  assert.deepEqual(q, expected, "feature qualification must match the saved raw probes");
  return q;
}
const httpProbe = (p, { close = false, timeout = false } = {}) => {
  assert.ok(p && Number.isFinite(p.ms) && p.ms >= 0, "missing raw HTTP probe");
  if (p.status !== undefined) {
    assert.equal(p.timedOut, undefined); assert.equal(p.error, undefined);
    assert.ok(Number.isInteger(p.status) && p.status >= 100 && p.status <= 599);
    assert.ok(p.headers && typeof p.headers === "object" && !Array.isArray(p.headers));
    assert.ok(Number.isSafeInteger(p.bodyLength) && p.bodyLength >= 0);
  } else {
    assert.equal(Number(p.timedOut === true) + Number(typeof p.error === "string" && p.error.length > 0), 1, "probe needs exactly one response/failure variant");
    assert.equal(p.headers, undefined); assert.equal(p.bodyLength, undefined);
    assert.ok(timeout && p.timedOut === true || close && ["EPIPE", "ECONNRESET"].includes(p.error), "inconclusive HTTP transport failure; no capability result");
  }
};
export function validateProbes(p, source) {
  sourceFeatures(source);
  for (const key of ["page", "json", "pageBr", "jsonBr", "jsonGzip", "page404", "json404", "json405", "head", "badHost", "afterConnections"]) httpProbe(p[key]);
  httpProbe(p.bigHead, { close: true });
  for (const key of ["page", "json", "pageBr", "jsonBr", "jsonGzip", "afterConnections"]) assert.equal(p[key].status, 200, `${key}: unhealthy qualification`);
  assert.ok(typeof p.page.body === "string" && p.page.body.length > 0, "missing page/form evidence");
  const bytes = Buffer.from(p.page.body, "base64");
  assert.equal(bytes.toString("base64"), p.page.body); assert.equal(bytes.length, p.page.bodyLength);
  const form = formOf(bytes.toString("utf8"), "/marketplace/en-US/item_1");
  if (!form || form.script) assert.equal(p.form, "no native POST form");
  else {
    assert.equal(p.form, undefined);
    for (const key of ["ownPost", "crossSite", "afterBig"]) httpProbe(p[key]);
    httpProbe(p.bigBody, { close: true });
    assert.ok(p.ownPost.status >= 200 && p.ownPost.status < 400 && p.ownPost.headers.serverfnerror === undefined, "native same-origin form failed");
    assert.equal(p.afterBig.status, 200);
  }
  assert.ok(Array.isArray(p.liveness) && p.liveness.length > 0 && p.liveness.length <= livePaths.length, "missing liveness probes");
  p.liveness.forEach((entry, i) => { assert.equal(entry.path, livePaths[i]); httpProbe(entry); if (i < p.liveness.length - 1) assert.notEqual(entry.status, 200); });
  const last = p.liveness.at(-1);
  if (last.status === 200) assert.deepEqual(p.live, last);
  else { assert.equal(p.live, undefined); assert.equal(p.liveness.length, livePaths.length); }
  const h = p.unfinishedHead;
  assert.ok(h && h.error === undefined, "unfinished-head probe did not establish a connection; qualification is inconclusive");
  assert.equal(Object.keys(h).length, 1, "unfinished-head probe needs one exclusive result variant");
  const headKey = Object.keys(h)[0];
  assert.ok(["closedMs", "timedOutMs"].includes(headKey) && Number.isSafeInteger(h[headKey]) && h[headKey] >= 0, "invalid unfinished-head result");
  const c = p.cap;
  assert.ok(c && c.error === undefined && [c.below, c.held, c.releaseMs].every((n) => Number.isSafeInteger(n) && n >= 0) &&
    ["belowHeld", "whileHeld", "afterwards"].every((k) => c[k] === null || Number.isInteger(c[k]) && c[k] >= 100 && c[k] <= 599) &&
    (c.afterRelease === null || ["refused", "closed"].includes(c.afterRelease) || Number.isInteger(c.afterRelease) && c.afterRelease >= 100 && c.afterRelease <= 599), "missing/invalid connection-cap probe");
  if (source === "api") {
    for (const key of ["page500", "json500", "afterUpstream"]) httpProbe(p[key]);
    httpProbe(p.slow, { timeout: true });
    assert.equal(p.afterUpstream.status, 200);
  }
}
export function admitted(app) {
  return app.qualification?.fixture?.eligible === true && app.qualification?.api?.eligible === true;
}
