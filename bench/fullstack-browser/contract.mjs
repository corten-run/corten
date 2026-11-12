import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { selectedApps, retainedFamilies } from "../workloads/registry.mjs";

export const schema = "native-fullstack-browser/v1";
export const candidates = selectedApps("fullstack-browser");
export { retainedFamilies };
export const settings = {
  profiles: {
    desktop: { viewport: { width: 1440, height: 1000 }, cpu: 1, network: null, cache: "cold", serviceWorker: "blocked" },
    mobile: { viewport: { width: 390, height: 844 }, cpu: 4,
      network: { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 }, cache: "cold", serviceWorker: "blocked" },
  },
  actionTimeoutMs: 15000, startupTimeoutMs: 60000, observationMs: 250, maxCleanupMs: 15000,
};
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// This native build fixes SvelteKit's request/CSRF origin to localhost:8080.
// Preserve it rather than disabling CSRF or rewriting browser Origin headers.
export const publishPort = (app) => app === "sveltekit" ? "127.0.0.1:8080:8080" : "127.0.0.1::8080";
export function publicURL(url) {
  const u = new URL(url);
  return { path: u.pathname, query: Object.fromEntries([...u.searchParams].filter(([key]) => ["seller", "sort", "offers"].includes(key))) };
}
export function parseOptions(args) {
  const round = args[0];
  assert.match(round ?? "", /^w[1-9]\d*$/, "explicit development round wN required; no official/nightly integration");
  const o = { targets: null, out: null, apps: [...candidates], cases: null, build: false };
  const seen = new Set();
  for (let i = 1; i < args.length;) {
    const key = args[i]?.replace(/^--/, "");
    assert.ok(args[i]?.startsWith("--") && Object.hasOwn(o, key) && !seen.has(key), "use wN [--build] [--targets file] --out directory [--apps a,b] [--cases key,key]");
    if (key === "build") { o.build = true; seen.add(key); i++; continue; }
    assert.ok(args[i + 1], "option value missing");
    seen.add(key); o[key] = ["apps", "cases"].includes(key) ? args[i + 1].split(",") : args[i + 1];
    i += 2;
  }
  assert.ok((o.targets || o.build) && o.out, "--out and either --build or --targets are required");
  assert.ok(o.apps.length && new Set(o.apps).size === o.apps.length && o.apps.every((a) => candidates.includes(a)), "unknown/duplicate candidate");
  assert.ok(o.cases === null || o.cases.length && new Set(o.cases).size === o.cases.length, "duplicate/empty cases");
  return { round, ...o };
}
export function validateTargets(value) {
  assert.deepEqual(Object.keys(value).sort(), ["schema", "targets"]);
  assert.equal(value.schema, "native-fullstack-browser-targets/v1");
  for (const [app, target] of Object.entries(value.targets)) {
    assert.ok(candidates.includes(app), `unknown candidate ${app}`);
    assert.ok(Object.keys(target).every((k) => ["image", "readback"].includes(k)), "unknown target option");
    assert.equal(typeof target.image, "string"); assert.match(target.image, /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/);
    if (target.readback !== undefined) {
      assert.deepEqual(Object.keys(target.readback), ["path"]);
      assert.match(target.readback.path, /^\/(?!\/)[^?#\\\s]+$/, "readback must be a local public path");
      assert.ok(!target.readback.path.startsWith("/marketplace/"), "readback cannot be the form response");
    }
  }
  return value.targets;
}
export function emptyCells(plan) {
  return Object.fromEntries(candidates.map((app) => [app, plan.cases.map((p) => ({ case: p.key, outcome: "not-run", reason: "Not selected or no local image configured", qualificationPassed: false, evidence: null }))]));
}
// A native read must return the actual store, not the message/POST response. Only
// canonical, non-secret alert fields enter the artifact; extra data is refused.
export function alertsFromReadback(value) {
  if (!Array.isArray(value)) assert.deepEqual(Object.keys(value), ["alerts"]);
  const alerts = Array.isArray(value) ? value : value.alerts;
  assert.ok(Array.isArray(alerts));
  for (const row of alerts) {
    assert.deepEqual(Object.keys(row).sort(), ["email", "item_id", "target_minor"]);
    assert.match(row.item_id, /^item_[1-9]\d*$/);
    assert.equal(typeof row.email, "string");
    assert.ok(Number.isSafeInteger(row.target_minor));
  }
  return alerts;
}
export function transportOf(request) {
  const h = request.headers();
  if (h["x-livewire"] !== undefined) return "livewire";
  if (h["x-turbo-request-id"] || h.accept?.includes("turbo-stream")) return "turbo";
  if (request.isNavigationRequest()) return "document";
  if (request.method() === "GET" && request.resourceType() === "fetch"
    && /^\/marketplace\/(?:en-US|fr-FR|de-DE)\/item_[1-9]\d*\/__data\.json$/.test(new URL(request.url()).pathname)) return "router";
  if (/\/_next\/data\//.test(request.url()) || h["x-react-router-request"] || h["x-sveltekit-action"]) return "router";
  return "fetch";
}
export function publicInput(request) {
  if (request.method() !== "POST") return { input: null, components: [] };
  const type = request.headers()["content-type"] ?? "";
  const body = request.postData() ?? "";
  let fields, components = [];
  if (type.startsWith("application/x-www-form-urlencoded")) fields = new URLSearchParams(body);
  else if (type.startsWith("multipart/form-data")) {
    // Parsed with the platform multipart reader asynchronously by observe.mjs.
    return null;
  } else if (type.startsWith("application/json") && request.headers()["x-livewire"] !== undefined) {
    const value = JSON.parse(body);
    const rows = value.components ?? [];
    components = rows.map((row) => JSON.parse(row.snapshot).memo.id);
    const updates = Object.assign({}, ...rows.map((row) => ({ ...JSON.parse(row.snapshot).data, ...row.updates })));
    fields = new URLSearchParams(Object.entries(updates).filter(([k]) => ["email", "target_price"].includes(k)));
  }
  return { input: fields ? { email: fields.get("email"), target_price: fields.get("target_price") } : null, components };
}
export function nativeFailures(app, profile, steps) {
  const failures = [];
  if (app === "laravel") {
    const initial = steps[0]?.dom?.native;
    if (!initial?.components.length || !initial?.form?.binding?.startsWith("wire:submit")) failures.push("Marketplace is not a Livewire component with a native wire:submit binding (Blade is not Livewire)");
    if (profile.js && steps.filter((s) => s.action.input).some((s) => !s.requests.some((r) => r.method === "POST" && r.transport === "livewire" && r.components.length
      && r.components.every((id) => s.componentsBefore?.includes(id))) || !s.dom?.native?.components.length)) failures.push("Native Livewire update/component requests missing");
  }
  if (app === "rails") {
    if (!steps[0]?.dom?.native?.turbo || steps[0]?.dom?.native?.turboDisabled) failures.push("Hotwire/Turbo is absent or explicitly disabled on the marketplace page");
    if (profile.js && steps.filter((s) => ["navigate", "accepted-write", "invalid-email", "invalid-price"].includes(s.action.kind))
      .some((s) => !s.requests.some((r) => r.transport === "turbo" && r.path === s.action.path
        && r.method === (s.action.input ? "POST" : "GET")
        && (r.status >= 200 && r.status < 400 || s.action.input && s.action.kind !== "accepted-write" && [400, 422].includes(r.status))))) failures.push("Native Hotwire navigation/form requests missing; controller document fallback cannot qualify");
  }
  return failures;
}
