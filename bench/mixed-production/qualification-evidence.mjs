import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { formOf, livePaths } from "../fullstack/conformance.mjs";
import { qualification, validateQualification } from "../marketplace/feature-contract.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const errors = new Set(["EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "closed without an answer", "could not connect"]);
const headerRules = {
  "content-type": /^(?:text\/(?:html|plain)|application\/(?:json|problem\+json|octet-stream))(?:;\s*charset=(?:utf-8|UTF-8))?$/,
  "content-encoding": /^(?:identity|br|gzip|deflate|zstd)?$/,
  "cache-control": /^(?:(?:private|public|no-store|no-cache|must-revalidate|proxy-revalidate|immutable|no-transform|(?:s-maxage|max-age|stale-while-revalidate|stale-if-error)=\d+)(?:\s*,\s*|$))+$/,
  "x-content-type-options": /^(?:nosniff)?$/,
  "referrer-policy": /^(?:no-referrer|no-referrer-when-downgrade|origin|origin-when-cross-origin|same-origin|strict-origin|strict-origin-when-cross-origin|unsafe-url)?$/,
  "x-frame-options": /^(?:DENY|SAMEORIGIN|deny|sameorigin)?$/,
  "cross-origin-opener-policy": /^(?:same-origin|same-origin-allow-popups|unsafe-none)?$/,
  "permissions-policy": /^(?:(?:accelerometer|ambient-light-sensor|autoplay|battery|camera|clipboard-read|clipboard-write|display-capture|encrypted-media|fullscreen|geolocation|gyroscope|hid|idle-detection|interest-cohort|magnetometer|microphone|midi|payment|picture-in-picture|publickey-credentials-get|screen-wake-lock|serial|usb|web-share|xr-spatial-tracking)=\((?:self|\*)?\)(?:\s*,\s*|$))+$/,
};
const directives = new Set(["default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr", "img-src", "font-src", "connect-src", "media-src", "object-src", "base-uri", "form-action", "frame-ancestors", "frame-src", "child-src", "worker-src", "manifest-src", "upgrade-insecure-requests", "block-all-mixed-content", "require-trusted-types-for"]);
const cspWords = new Set(["'self'", "'none'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "'strict-dynamic'", "'report-sample'", "'script'", "*", "data:", "blob:", "https:", "http:"]);

function cspProjection(value) {
  assert.ok(typeof value === "string" && value.length <= 16384);
  for (const part of value.split(";")) {
    const words = part.trim().split(/\s+/);
    if (!words[0]) continue;
    assert.ok(directives.has(words[0].toLowerCase()), "unfilterable CSP directive");
    for (const word of words.slice(1)) assert.ok(cspWords.has(word) || /^'(?:nonce|sha256|sha384|sha512)-[A-Za-z0-9+/=_-]+'$/.test(word), "unfilterable CSP source");
  }
  return value.replace(/('(nonce|sha256|sha384|sha512)-)([A-Za-z0-9+/=_-]+)(')/g,
    (_, prefix, _kind, secret, suffix) => prefix + "x".repeat(secret.length) + suffix);
}

function headersProjection(headers) {
  assert.ok(headers && typeof headers === "object" && !Array.isArray(headers));
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    // Only these headers affect the unchanged qualification contract. Cookie,
    // ETag, redirect, authentication and arbitrary extension values are omitted.
    if (key === "serverfnerror") { result[key] = ""; continue; }
    if (key !== "content-security-policy" && !Object.hasOwn(headerRules, key)) continue;
    const filter = (v) => {
      assert.ok(typeof v === "string" && v.length <= 16384);
      if (key === "content-security-policy") return cspProjection(v);
      assert.match(v, headerRules[key], "unfilterable qualification header");
      return v;
    };
    result[key] = Array.isArray(value) ? value.map(filter) : filter(value);
  }
  return result;
}

const branch = (html) => {
  const form = formOf(html, "/marketplace/en-US/item_1");
  return form === null ? "none" : form.script ?? "http";
};

// This is an explicit lossy projection of the actual response, not a replacement
// expected page. Retained spans are original source bytes; everything else is
// blanked, including fields, URLs, scripts, comments, text and credential values.
export function pageProjection(base64) {
  assert.ok(typeof base64 === "string" && base64.length <= 12 * 1024 * 1024);
  const raw = Buffer.from(base64, "base64");
  assert.ok(raw.length > 0 && raw.toString("base64") === base64);
  const html = raw.toString("utf8");
  assert.ok(Buffer.from(html).equals(raw), "non-UTF8 qualification page");
  const projected = Buffer.alloc(raw.length, 32), spans = [];
  let forms = 0;
  const keep = (start, length) => {
    const offset = Buffer.byteLength(html.slice(0, start)), bytes = Buffer.from(html.slice(start, start + length));
    bytes.copy(projected, offset); spans.push({ offset, length: bytes.length });
  };
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    assert.ok(++forms <= 128, "qualification page projection form limit");
    keep(match.index, 5);
    const end = match.index + match[0].indexOf(">"), tag = html.slice(match.index, end + 1);
    keep(end, 1); keep(match.index + match[0].length - 7, 7);
    const method = /\smethod\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (method && /^(post|get)$/i.test(method[1] ?? method[2] ?? method[3] ?? "")) keep(match.index + method.index, method[0].length);
    for (const name of ["wire:submit", "phx-submit"]) {
      const attr = new RegExp("\\s" + name + "(\\s|=|>|/|\\.)", "i").exec(tag);
      if (attr) keep(match.index + attr.index, name.length + 1);
    }
  }
  assert.equal(branch(projected.toString("utf8")), branch(html), "page projection changed native form branch");
  return { body: projected.toString("base64"), rawSha256: digest(raw), spans: spans.toSorted((a, b) => a.offset - b.offset) };
}

export function probeProjection(probe) {
  assert.ok(probe && typeof probe === "object" && !Array.isArray(probe));
  const result = {};
  for (const key of ["status", "ms", "bodyLength", "closedMs", "timedOutMs", "below", "belowHeld", "held", "whileHeld", "releaseMs", "afterwards"]) {
    if (!Object.hasOwn(probe, key)) continue;
    const value = probe[key];
    assert.ok(value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0));
    result[key] = value;
  }
  if (Object.hasOwn(probe, "afterRelease")) {
    assert.ok(probe.afterRelease === null || ["refused", "closed"].includes(probe.afterRelease)
      || (Number.isSafeInteger(probe.afterRelease) && probe.afterRelease >= 0));
    result.afterRelease = probe.afterRelease;
  }
  if (Object.hasOwn(probe, "timedOut")) { assert.equal(typeof probe.timedOut, "boolean"); result.timedOut = probe.timedOut; }
  if (Object.hasOwn(probe, "error")) { assert.ok(errors.has(probe.error), "unfilterable probe error"); result.error = probe.error; }
  if (Object.hasOwn(probe, "path")) { assert.ok(livePaths.includes(probe.path)); result.path = probe.path; }
  if (Object.hasOwn(probe, "headers")) result.headers = headersProjection(probe.headers);
  return result;
}

export function qualificationEvidence(actual) {
  validateQualification(actual);
  const probes = {}, probeSha256 = {};
  const allowed = new Set(["page", "json", "pageBr", "jsonBr", "jsonGzip", "page404", "json404", "json405", "head", "badHost", "bigHead", "form", "ownPost", "crossSite", "bigBody", "afterBig", "liveness", "live", "page500", "json500", "slow", "afterUpstream", "unfinishedHead", "cap", "afterConnections"]);
  for (const [key, value] of Object.entries(actual.probes)) {
    assert.ok(allowed.has(key));
    probeSha256[key] = digest(JSON.stringify(value));
    if (key === "form") { assert.equal(value, "no native POST form"); probes[key] = value; }
    else if (key === "liveness") probes[key] = value.map(probeProjection);
    else probes[key] = probeProjection(value);
  }
  const page = pageProjection(actual.probes.page.body);
  probes.page.body = page.body;
  const replay = validateQualification(qualification(probes, actual.source));
  assert.deepEqual({ ...replay, probes: null }, { ...actual, probes: null }, "credential filtering changed qualification outcome");
  return { schema: "mixed-native-qualification-evidence/v1", failure: null,
    rawProbeSha256: digest(JSON.stringify(actual.probes)), probeSha256,
    pageProjection: { rawSha256: page.rawSha256, spans: page.spans }, qualification: replay };
}

export function replayQualificationEvidence(receipt, raw, expected) {
  assert.deepEqual([receipt.schema, receipt.app, receipt.source, receipt.imageId, receipt.nativeProfile],
    ["mixed-native-qualification-evidence/v1", expected.app, expected.source, expected.imageId, expected.nativeProfile]);
  if (receipt.failure === "native-production-qualification-failed" && receipt.qualification === undefined) {
    assert.equal(raw.failure, "native-production-qualification-failed"); assert.equal(raw.eligible, false);
    assert.ok(Array.isArray(receipt.events) && receipt.events.length >= 2);
    const first = receipt.events.slice(0, 2);
    for (const [index, event] of first.entries()) {
      assert.deepEqual(Object.keys(event).sort(), ["index", "kind", "inputSha256", "responseSha256", "response", "failure"].sort());
      assert.equal(event.index, index); assert.equal(event.kind, "http"); assert.equal(event.failure, null);
      assert.match(event.inputSha256, /^[a-f0-9]{64}$/); assert.match(event.responseSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(probeProjection(event.response), event.response);
      assert.deepEqual(Object.keys(event.response).sort(), ["status", "ms", "bodyLength", "headers"].sort());
      assert.ok(Number.isInteger(event.response.status) && event.response.status >= 100 && event.response.status <= 599
        && Number.isSafeInteger(event.response.bodyLength) && event.response.bodyLength >= 0 && typeof event.response.ms === "number" && Number.isFinite(event.response.ms));
    }
    // qualify always performs page + JSON before either health assertion. Only
    // that exact completed prefix can prove an early unhealthy target gate.
    assert.equal(receipt.events.length, 2); assert.ok(first.some((event) => event.response.status !== 200));
    assert.equal(raw.probes, undefined); assert.equal(raw.cells, undefined);
    return { profile: "marketplace-production/v1", source: expected.source, missing: [], eligible: false,
      targetFailure: first[0].response.status !== 200 ? "native-qualification-unhealthy-page" : "native-qualification-unhealthy-json" };
  }
  assert.equal(receipt.failure, null); assert.match(receipt.rawProbeSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.rawProbeSha256, raw.rawProbeSha256);
  const q = validateQualification(receipt.qualification);
  assert.equal(q.source, expected.source);
  assert.deepEqual([raw.profile, raw.cells, raw.missing, raw.eligible], [q.profile, q.cells, q.missing, q.eligible]);
  assert.deepEqual(Object.keys(raw.probes).sort(), Object.keys(q.probes).sort());
  assert.deepEqual(Object.keys(receipt.probeSha256).sort(), Object.keys(q.probes).sort());
  for (const [key, value] of Object.entries(raw.probes)) {
    assert.match(receipt.probeSha256[key], /^[a-f0-9]{64}$/); assert.equal(value.sha256, receipt.probeSha256[key]);
    const p = q.probes[key];
    for (const [name, fact] of Object.entries(value)) if (name !== "sha256") assert.deepEqual(fact, p[name]);
  }
  assert.ok(Array.isArray(receipt.events) && receipt.events.length > 0 && receipt.events.length <= 64);
  const responses = [];
  for (const key of ["page", "json", "pageBr", "jsonBr", "jsonGzip", "page404", "json404", "json405", "head", "badHost", "bigHead",
    "ownPost", "crossSite", "bigBody", "afterBig", "liveness", "page500", "json500", "slow", "afterUpstream", "unfinishedHead", "cap", "afterConnections"]) {
    const probe = q.probes[key]; if (probe === undefined) continue;
    for (const value of key === "liveness" ? probe : [probe]) responses.push({ kind: ["unfinishedHead", "cap"].includes(key) ? "connection" : "http", value: probeProjection(value) });
  }
  assert.equal(receipt.events.length, responses.length);
  for (const [index, event] of receipt.events.entries()) {
    assert.deepEqual(Object.keys(event).sort(), ["index", "kind", "inputSha256", "responseSha256", "response", "failure"].sort());
    assert.equal(event.index, index); assert.equal(event.kind, responses[index].kind); assert.equal(event.failure, null);
    assert.match(event.inputSha256, /^[a-f0-9]{64}$/); assert.match(event.responseSha256, /^[a-f0-9]{64}$/);
    const expectedResponse = { ...responses[index].value }; delete expectedResponse.path;
    const actualResponse = { ...event.response };
    if (actualResponse.path !== undefined) { assert.equal(actualResponse.path, responses[index].value.path); delete actualResponse.path; }
    assert.deepEqual(actualResponse, expectedResponse);
  }
  const page = Buffer.from(q.probes.page.body, "base64");
  assert.match(receipt.pageProjection.rawSha256, /^[a-f0-9]{64}$/); assert.ok(Array.isArray(receipt.pageProjection.spans));
  let previous = 0;
  for (const span of receipt.pageProjection.spans) {
    assert.ok(Number.isSafeInteger(span.offset) && Number.isSafeInteger(span.length) && span.offset >= previous && span.length > 0 && span.offset + span.length <= page.length);
    assert.ok(page.subarray(previous, span.offset).every((v) => v === 32)); previous = span.offset + span.length;
  }
  assert.ok(page.subarray(previous).every((v) => v === 32));
  return { profile: q.profile, source: q.source, missing: q.missing, eligible: q.eligible };
}
