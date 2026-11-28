import assert from "node:assert/strict";
import { spread } from "../fullstack/passes.mjs";
import { groupDescriptor, originalCatalogApps } from "./group.mjs";

export const workload = "catalog-v1";
export const sources = ["fixture", "api"];
export const targets = ["page", "json"];
export const phases = ["fixed", "sat64", "sat256"];
export const leanProfile = "catalog-lean";
export const leanApps = Object.freeze(groupDescriptor("catalog-page").apps);
export const recordedLeanApps = (summary) => summary.group ? groupDescriptor("catalog-page", { savedHash: summary.group.contractSha256 }).apps
  : originalCatalogApps;
// The longest run.mjs gives one app's image build.
export const imageBuildTimeoutMs = 60 * 60 * 1000;
// The wider placement is for k6 only. Probes/checkers run on the original client cores.
export function probeCpu(measurement) {
  return measurement.loadLayout === "c16-generator-v1"
    ? cpuSettings({ CATALOG_LOAD_CPUS: "4-7" }).load : measurement.cpus.load;
}
export function cpuSettings(env, loadLayout) {
  if (loadLayout !== undefined) {
    assert.equal(loadLayout, "c16-generator-v1", "unknown catalog generator layout");
    for (const [role, pins] of [["APP", "1"], ["API", "2-3"], ["LOAD", "4-15"]]) {
      assert.equal(env[`CATALOG_${role}_CPUS`], pins, `c16 generator layout requires ${role} on ${pins}`);
    }
  }
  const quotas = { app: 1, load: loadLayout === undefined ? 4 : 12, api: 2 };
  const used = new Map();
  return Object.fromEntries(Object.entries(quotas).map(([role, quota]) => {
    const key = `CATALOG_${role.toUpperCase()}_CPUS`;
    const value = env[key] || null;
    if (value) {
      assert.match(value, /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/, `${key}: expected CPU indices/ranges`);
      for (const part of value.split(",")) {
        const [start, end = start] = part.split("-").map(Number);
        assert.ok(Number.isSafeInteger(start) && start >= 0 && end >= start && end <= 4095, `${key}: invalid CPU range`);
        for (let index = start; index <= end; index++) {
          assert.ok(!used.has(index), `${key}: CPU ${index} already pinned by ${used.get(index)}`);
          used.set(index, key);
        }
      }
    }
    return [role, { quota, cpuset: value, placement: value ? "explicit logical CPU pinning plus quota" : "not pinned; CPU quota only", args: ["--cpus", String(quota), ...(value ? ["--cpuset-cpus", value] : [])] }];
  }));
}
const keys = ["id", "title", "subtitle", "description", "tags", "fields", "related"];
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function exact(value, names, at) {
  assert.ok(object(value), `${at}: expected object`);
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), `${at}: keys`);
}
export function validateRecord(record, id = record?.id) {
  exact(record, keys, id);
  for (const key of keys.slice(0, 4)) assert.equal(typeof record[key], "string", `${id}.${key}: string`);
  assert.equal(record.id, id);
  for (const key of keys.slice(4)) assert.ok(Array.isArray(record[key]), `${id}.${key}: array`);
  for (const tag of record.tags) assert.equal(typeof tag, "string", `${id}.tags: string`);
  for (const [key, names] of [["fields", ["name", "value"]], ["related", ["id", "title"]]]) {
    for (const row of record[key]) {
      exact(row, names, `${id}.${key}`);
      for (const name of names) assert.equal(typeof row[name], "string", `${id}.${key}.${name}: string`);
    }
  }
  return record;
}
export function validateCatalog(catalog) {
  assert.ok(object(catalog), "catalog: expected object keyed by record id");
  assert.deepEqual(Object.keys(catalog).sort(), Array.from({ length: 500 }, (_, i) => `record_${i + 1}`).sort());
  for (const [id, record] of Object.entries(catalog)) {
    validateRecord(record, id);
    for (const related of record.related) assert.ok(Object.hasOwn(catalog, related.id), `${id}: missing related ${related.id}`);
  }
  return catalog;
}
export const text = (value) => value.replace(/[\t\n\r\f ]+/g, " ").trim();
const node = (tag, attrs = {}, content = "", children = []) => ({ tag, attrs, text: text(content), children });
export function expectedArticle(record, prefix = "") {
  const li = (value) => node("li", {}, value);
  return node("article", { "aria-label": "Catalog record" }, "", [
    node("h1", {}, record.title), node("p", {}, record.subtitle), node("p", {}, record.description),
    node("ul", { "aria-label": "Tags" }, "", record.tags.map(li)),
    node("form", { method: "get", action: `/catalog/${record.id}` }, "", [
      node("label", {}, "Field name", [node("input", { name: "field", value: prefix, type: "text" })]),
      node("button", { type: "submit" }, "Filter"),
    ]),
    node("table", {}, "", [node("caption", {}, "Record fields"),
      node("thead", {}, "", [node("tr", {}, "", [node("th", { scope: "col" }, "Name"), node("th", { scope: "col" }, "Value")])]),
      node("tbody", {}, "", record.fields.filter((f) => f.name.startsWith(prefix)).map((f) => node("tr", {}, "", [node("th", { scope: "row" }, f.name), node("td", {}, f.value)]))),
    ]),
    node("nav", { "aria-label": "Related records" }, "", [node("ul", {}, "", record.related.map((r) => node("li", {}, "", [node("a", { href: `/catalog/${r.id}` }, r.title)])))]),
  ]);
}
const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function articleHtml(record, prefix = "") {
  const render = (n) => `<${n.tag}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escape(v)}"`).join("")}>${escape(n.text)}${n.tag === "label" ? " " : ""}${n.children.map(render).join("")}${n.tag === "input" ? "" : `</${n.tag}>`}`;
  return render(expectedArticle(record, prefix));
}
export function representativeIds(catalog) {
  const chosen = new Set(["record_1", "record_17", "record_250", "record_500"]);
  for (const condition of [
    (r) => /[<>&"']/.test(JSON.stringify(r)),
    (r) => r.tags.length === 0, (r) => r.fields.length === 0, (r) => r.related.length === 0,
    (r) => r.fields.some((f) => /[^\x00-\x7f]/.test(f.name + f.value)),
  ]) {
    const found = Object.values(catalog).find(condition);
    if (found) chosen.add(found.id);
  }
  return [...chosen];
}
export function filterPrefixes(record) {
  const name = record.fields.find((f) => /[a-zA-Z]/.test(f.name))?.name ?? "Access";
  const prefix = name.slice(0, Math.max(1, Math.floor(name.length / 2)));
  return [...new Set(["", prefix, prefix.toUpperCase(), prefix.toLowerCase(), ` ${prefix}`, `${prefix} `, '<&"\' +', "__catalog_no_such_field__"])];
}
export function expectedPageChecks(catalog) {
  // Eight profiles, with two style visits and a fresh page for the form in each.
  return (representativeIds(catalog).length + filterPrefixes(catalog.record_1).length + 3) * 8;
}
export const documentHeaderNames = Object.freeze(["content-type", "content-security-policy", "x-frame-options",
  "x-content-type-options", "referrer-policy", "cross-origin-opener-policy", "permissions-policy", "cache-control"]);
export const catalogPagePath = (id, prefix = "") => `/catalog/${id}${prefix ? `?${new URLSearchParams({ field: prefix })}` : ""}`;
export function expectedDocumentHeaderPaths(catalog, source) {
  const visits = [...representativeIds(catalog).map((id) => catalogPagePath(id)),
    ...filterPrefixes(catalog.record_1).map((prefix) => catalogPagePath("record_1", prefix)),
    "/catalog/record_1", "/catalog/record_500", "/catalog/record_1"];
  return [...Array.from({ length: 8 }, () => visits).flat(), ...(source === "api" ? ["/catalog/record_1", "/catalog/record_1"] : [])];
}

const strictReferrers = ["strict-origin-when-cross-origin", "strict-origin", "same-origin", "no-referrer"];
const referrers = new Set([...strictReferrers, "no-referrer-when-downgrade", "origin", "origin-when-cross-origin", "unsafe-url"]);
const trimOWS = (v) => v.replace(/^[ \t]+|[ \t]+$/g, "");
// The checker browser enforces COOP with RFC 8941 item parameters. It treats
// the later Date and Display String types as malformed and drops the policy.
function sameOriginOpener(value) {
  if (!value.startsWith("same-origin")) return false;
  const param = /; *[a-z*][a-z0-9_.*-]*(?:=("(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"|\?[01]|[A-Za-z*][A-Za-z0-9!#$%&'*+.^_\x60|~:/-]*|-?\d{1,12}\.\d{1,3}|-?\d{1,15}|:[A-Za-z0-9+/]*={0,2}:))?/y;
  for (let i = "same-origin".length; i < value.length; i = param.lastIndex) {
    param.lastIndex = i;
    const m = param.exec(value);
    if (!m) return false;
    const bare = m[1] ?? "";
    try {
      if (bare.startsWith(":")) atob(bare.slice(1, -1));
    } catch { return false; }
  }
  return true;
}
export function verifyDocumentHeaders(row, path) {
  assert.ok(row && row.path === path && row.status === 200 && Array.isArray(row.headers), `${path}: missing HTML response observation`);
  const fields = new Map();
  for (const header of row.headers) {
    assert.ok(documentHeaderNames.includes(header?.name) && typeof header.value === "string" && !/[\0\r\n]/.test(header.value),
      `${path}: invalid document header observation`);
    if (!fields.has(header.name)) fields.set(header.name, []);
    fields.get(header.name).push(trimOWS(header.value));
  }
  const list = (name) => (fields.get(name) ?? []).join(",").split(",").map(trimOWS);
  const single = (name) => fields.get(name)?.length === 1 ? fields.get(name)[0] : "";
  assert.match(single("content-type"), /^text\/html(?:\s*;|$)/i, `${path}: expected text/html`);

  // CSP directive names are insensitive to case, the first occurrence wins,
  // and separate enforced policies are applied together.
  const policies = list("content-security-policy").map((policy) => {
    const directives = new Map();
    for (const part of policy.split(";")) {
      if (/[^\x00-\x7f]/.test(part)) continue;
      const [name, ...values] = part.replace(/^[\t\n\r\f ]+|[\t\n\r\f ]+$/g, "").toLowerCase().split(/[\t\n\r\f ]+/);
      if (/^[a-z0-9-]+$/.test(name) && !directives.has(name)) directives.set(name, values);
    }
    return directives;
  });
  const blocksInline = (tokens) => tokens !== undefined && !tokens.includes("'unsafe-inline'");
  const script = (p) => p.get("script-src") ?? p.get("default-src");
  assert.ok(policies.some((p) => blocksInline(script(p))) &&
    ["script-src-elem", "script-src-attr"].every((name) => policies.some((p) => blocksInline(p.get(name) ?? script(p)))),
  `${path}: enforced Content-Security-Policy must restrict inline scripts`);
  const ancestors = policies.filter((p) => p.has("frame-ancestors")).map((p) => p.get("frame-ancestors"));
  // An enforced frame-ancestors overrides X-Frame-Options.
  assert.ok(ancestors.length ? ancestors.some((tokens) => tokens.every((token) => token === "'none'" || token === "'self'"))
    : /^(deny|sameorigin)$/i.test(single("x-frame-options")), `${path}: document must refuse cross-origin framing`);
  assert.equal(list("x-content-type-options")[0].toLowerCase(), "nosniff", `${path}: X-Content-Type-Options must be nosniff`);
  const referrer = list("referrer-policy").map((v) => v.toLowerCase()).findLast((v) => referrers.has(v));
  assert.ok(strictReferrers.includes(referrer), `${path}: Referrer-Policy must be strict-origin-when-cross-origin or stricter`);
  assert.ok(sameOriginOpener(single("cross-origin-opener-policy")),
    `${path}: Cross-Origin-Opener-Policy must be same-origin`);
  for (const name of ["permissions-policy", "cache-control"]) {
    assert.ok(list(name).some(Boolean), `${path}: ${name} must be present and nonempty`);
  }
}
export function verifyDocumentHeaderChecks(rows, catalog, source) {
  const paths = expectedDocumentHeaderPaths(catalog, source);
  assert.ok(Array.isArray(rows) && rows.length === paths.length, "incomplete catalog document header observations");
  for (const [i, path] of paths.entries()) verifyDocumentHeaders(rows[i], path);
}
export function parseArgs(args, available) {
  const [round, ...rest] = args;
  if (!/^c[1-9]\d*$/.test(round ?? "")) throw new Error("round must be cN (for example c1), never rN or mN");
  const options = { round, apps: Object.keys(available), build: false, checkOnly: false, passes: 3, duration: 60, warmup: 30, rate: 150, startupTimeout: 120 };
  const numeric = { "--passes": ["passes", 1, 5], "--duration": ["duration", 1, 300], "--warmup": ["warmup", 1, 120], "--rate": ["rate", 1, 10000], "--startup-timeout": ["startupTimeout", 1, 300] };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (seen.has(flag)) throw new Error(`duplicate option ${flag}`);
    seen.add(flag);
    if (flag === "--build") options.build = true;
    else if (flag === "--check-only") options.checkOnly = true;
    else if (flag === "--group") options.group = groupDescriptor(rest[++i]).group;
    else if (flag === "--apps") {
      const names = rest[++i]?.split(",");
      if (!names?.length || new Set(names).size !== names.length || names.some((n) => !Object.hasOwn(available, n))) throw new Error("--apps must name distinct page apps");
      options.apps = names;
    } else if (numeric[flag]) {
      const [key, min, max] = numeric[flag];
      const value = rest[++i];
      const n = Number(value);
      if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${flag} must be an integer from ${min} through ${max}`);
      options[key] = n;
    } else throw new Error(`unknown option ${flag}`);
  }
  if (options.group !== undefined) {
    assert.ok(!seen.has("--apps"), "--group cannot be combined with --apps");
    options.apps = groupDescriptor(options.group).apps;
    assert.ok(options.apps.every((app) => Object.hasOwn(available, app)), "catalog group requires every registry app in the native page inventory");
  }
  if (options.passes % 2 !== 1) throw new Error("--passes must be 1, 3 or 5");
  return options;
}
export function readLoad(summary) {
  const m = summary?.metrics;
  const metric = (name) => m?.[name]?.values ?? m?.[name];
  const requests = metric("http_reqs");
  const duration = metric("http_req_duration");
  const failures = metric("http_req_failed");
  const checks = metric("checks");
  assert.ok(requests?.count > 0 && requests.rate > 0 && Number.isFinite(requests.rate), "load sent no requests");
  for (const k of ["avg", "p(50)", "p(95)", "p(99)", "max"]) assert.ok(Number.isFinite(duration?.[k]) && duration[k] >= 0, `load missing duration ${k}`);
  assert.ok(Number.isFinite(failures?.value ?? failures?.rate), "load missing failure rate");
  assert.ok(checks?.passes > 0 && checks?.fails === 0, "load checks failed or missing");
  assert.equal(failures.value ?? failures.rate, 0, "load HTTP errors");
  const dropped = metric("dropped_iterations")?.count ?? 0;
  assert.equal(dropped, 0, "load dropped iterations");
  return { requests: requests.count, rps: requests.rate, p50: duration["p(50)"], p95: duration["p(95)"], p99: duration["p(99)"], failed: 0, dropped };
}
export function aggregate(runs) {
  const result = { passes: runs.length };
  for (const key of ["rps", "p50", "p95", "p99", "cpuUsec", "perCpuSecond", "memAvgMiB", "memMaxMiB"]) result[key] = spread(runs.map((r) => r[key]));
  if (runs.some((r) => r.outcome !== undefined)) {
    for (const key of ["requests", "successfulRequests", "successfulRps", "failed", "timeouts", "httpErrors", "dropped"]) result[key] = spread(runs.map((r) => r[key]));
    result.outcomes = { passed: runs.filter((r) => r.outcome === "passed").length, failed: runs.filter((r) => r.outcome === "failed").length };
  }
  return result;
}
