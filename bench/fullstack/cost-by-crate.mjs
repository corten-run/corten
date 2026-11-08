// Splits one request's user instructions between two callgrind dumps of the same server (one
// after N1 requests, one after N2) by stage, by the crate of each instruction's source file
// (inlined code counts where it was written) and by function. Self cost: a function's own
// instructions, not those of what it calls.
// Usage: node cost-by-crate.mjs <small.out> <large.out> [requests between them = 1000]
// TOP=<n> lists the n costliest functions (default 40); ONLY=<regex> lists only those matching.
// INCLUSIVE=<regex> lists the functions matching it with what they call (callgrind's calls= costs).
import fs from "node:fs";

/** A dump's total, its self cost by source file's crate and by function, and each function's cost
 * with what it calls (a direct call to itself not counted twice; mutual recursion would be). */
function parse(path) {
  const lines = fs.readFileSync(path, "utf8").split("\n");
  const events = (lines.find((l) => l.startsWith("events:")) ?? "events: Ir").slice(7).trim().split(/\s+/);
  const positions = (lines.find((l) => l.startsWith("positions:")) ?? "positions: line").slice(10).trim().split(/\s+/);
  const column = positions.length + events.indexOf("Ir");
  if (events.indexOf("Ir") < 0) throw new Error(`${path}: no Ir event`);
  // Compressed names: "(id) name" defines id, "(id)" refers to it; files share one table.
  const tables = { fl: new Map(), fn: new Map(), ob: new Map() };
  const table = { fl: "fl", fi: "fl", fe: "fl", cfi: "fl", cfl: "fl", fn: "fn", cfn: "fn", ob: "ob", cob: "ob" };
  const name = (kind, value) => {
    const m = /^\((\d+)\)(?: (.*))?$/.exec(value);
    if (!m) return value;
    const t = tables[table[kind]];
    if (m[2] !== undefined) t.set(m[1], m[2]);
    return t.get(m[1]);
  };
  let ob = "", fl = "", file = "", fn = "", callee = "", inclusive = false, total = 0;
  const byFile = new Map(), byName = new Map(), withCalls = new Map();
  const add = (map, key, n) => map.set(key, (map.get(key) || 0) + n);
  for (const line of lines) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq > 0 && /^[a-z]+$/.test(line.slice(0, eq))) {
      const [key, value] = [line.slice(0, eq), line.slice(eq + 1)];
      if (key === "ob") ob = name(key, value);
      else if (key === "fl") file = fl = name(key, value);
      else if (key === "fi" || key === "fe") file = name(key, value);
      else if (key === "fn") [fn, file] = [name(key, value), fl];
      else if (key === "cfn") callee = name(key, value);
      else if (key in table) name(key, value);
      // The line after calls= is the call's inclusive cost, already counted in the callee.
      else if (key === "calls") inclusive = true;
      continue;
    }
    if (!/^[0-9+*-]/.test(line)) continue;
    const ir = Number(line.trim().split(/\s+/)[column] || 0);
    if (inclusive) {
      inclusive = false;
      if (callee !== fn) add(withCalls, fn, ir);
      continue;
    }
    total += ir;
    add(withCalls, fn, ir);
    add(byFile, crateOfFile(file, ob), ir);
    add(byName, fn, ir);
  }
  return { total, byFile, byName, withCalls };
}

/** The crate a source file belongs to. */
function crateOfFile(file, ob) {
  let m;
  if ((m = /registry\/src\/[^/]+\/([A-Za-z0-9_-]+?)-\d+\.\d+[^/]*\//.exec(file))) return m[1];
  if ((m = /\/rustc\/[0-9a-f]+\/library\/([a-z_]+)\//.exec(file))) return `std (${m[1]})`;
  // std's own copy of hashbrown, behind HashMap.
  if (/\/rust\/deps\/hashbrown-/.test(file)) return "std (hashbrown)";
  if ((m = /\/src\/crates\/([a-z0-9_-]+)\//.exec(file))) return m[1];
  if ((m = /\/src\/examples\/([a-z0-9_-]+)\//.exec(file))) return `${m[1]} (app)`;
  if ((m = /\/src\/bench\/fullstack\/apps\/([a-z0-9_-]+)\//.exec(file))) return `${m[1]} (bench app)`;
  if (/\/malloc\//.test(file)) return "glibc (malloc)";
  if (/\/string\/|sysdeps/.test(file)) return "glibc (memcpy, memcmp)";
  if (!file || file === "???") return `no source: ${ob.split("/").pop() || "?"}`;
  return `other: ${file.split("/").slice(0, 4).join("/")}`;
}

const [small, large] = [parse(process.argv[2]), parse(process.argv[3])];
const per = Number(process.argv[4] || 1000);
const diff = (a, b) => new Map([...new Set([...a.keys(), ...b.keys()])].map((k) => [k, ((b.get(k) || 0) - (a.get(k) || 0)) / per]));
const total = (large.total - small.total) / per;
const byFile = diff(small.byFile, large.byFile);
const byName = diff(small.byName, large.byName);
const row = (v, label) => console.log(String(Math.round(v)).padStart(9), `${((100 * v) / total).toFixed(1)}%`.padStart(6), label);

console.log("User instructions a request:", Math.round(total));

// By stage, from function names, the first that matches; what matches none is "the rest".
const stages = [
  ["reading JSON (FromJson, serde_json's Value, UTF-8 checks, numbers)", /json::read|serde_json|FromJson|from_utf8|dec2flt|Decimal>::parse|f64 as core::str::FromStr/],
  ["allocator (malloc, free and their internals)", /malloc|free|realloc|unlink_chunk|alloc_perturb|__rust_alloc|__rust_dealloc|__rdl_/],
  ["memcpy, memcmp", /^__mem/],
  ["writing HTML (Render, escape_into, digits, Formatted; Maud's escape)", /Render|escape_into|push_u64|ascii::digits|i18n::format|AttrValue|mark_head_tags|head_tags|^maud::/],
  ["writing JSON (ToJson, str_body, numbers)", /ToJson|json::str_body|json::unsigned|zmij/],
  ["HTTP: hyper, httparse, http (HeaderMap)", /^<*(hyper|hyper_util|httparse|http)::/],
  ["tokio, mio", /^<*(tokio|mio)::/],
  ["axum, tower, matchit", /^<*(axum|axum_core|tower|tower_service|matchit)::/],
];
const byStage = new Map();
let staged = 0;
for (const [fn, v] of byName) {
  const stage = stages.find(([, re]) => re.test(fn));
  if (!stage) continue;
  byStage.set(stage[0], (byStage.get(stage[0]) || 0) + v);
  staged += v;
}
console.log("\nBy stage (function names, self cost):");
for (const [k, v] of [...byStage].sort((a, b) => b[1] - a[1])) row(v, k);
row(total - staged, "the rest (the framework's request path, the handler and the app's own page code, smaller pieces)");

console.log("\nBy the crate of each instruction's source file (inlined code where it was written):");
for (const [k, v] of [...byFile].sort((a, b) => b[1] - a[1])) if (Math.abs(v) / total >= 0.003) row(v, k);

const top = Number(process.env.TOP ?? 40);
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
if (top > 0) {
  console.log("\nCostliest functions (self):");
  const listed = [...byName].filter(([k]) => !only || only.test(k)).sort((a, b) => b[1] - a[1]).slice(0, top);
  for (const [k, v] of listed) row(v, k.length > 150 ? `${k.slice(0, 150)}...` : k);
}

if (process.env.INCLUSIVE) {
  const re = new RegExp(process.env.INCLUSIVE);
  const withCalls = diff(small.withCalls, large.withCalls);
  console.log("\nWith what they call:");
  for (const [k, v] of [...withCalls].filter(([k]) => re.test(k)).sort((a, b) => b[1] - a[1])) row(v, k.length > 150 ? `${k.slice(0, 150)}...` : k);
}
