import assert from "node:assert/strict";
import { spread } from "../fullstack/passes.mjs";

export const workload = "catalog-v1";
export const sources = ["fixture", "api"];
export const targets = ["page", "json"];
export const phases = ["fixed", "sat64", "sat256"];
export function cpuSettings(env) {
  const quotas = { app: 1, load: 4, api: 2 };
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
  return result;
}
