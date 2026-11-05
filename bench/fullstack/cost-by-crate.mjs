// Splits the instructions per request between two callgrind dumps of the same server (one after
// N1 requests, one after N2) by crate: by each instruction's source file (inlined code counts
// where it was written), by the crate of the function it ran in, and by function.
// Usage: node cost-by-crate.mjs <small.out> <large.out> [requests between them = 1000]
// TOP=<n> lists the n costliest functions (default 40); ONLY=<regex> lists only those matching.
import fs from "node:fs";
function parse(path) {
const text = fs.readFileSync(path, "utf8");
const names = { fl: new Map(), fn: new Map(), ob: new Map() };
const name = (kind, v) => {
  const m = /^\((\d+)\)(?: (.*))?$/.exec(v);
  if (!m) return v;
  const key = kind === "fi" || kind === "fe" ? "fl" : kind === "cfi" || kind === "cfl" ? "fl" : kind === "cfn" ? "fn" : kind === "cob" ? "ob" : kind;
  if (m[2] !== undefined) names[key].set(m[1], m[2]);
  return names[key].get(m[1]);
};
let ob = "", fl = "", file = "", fn = "", skip = false, total = 0;
const byFile = new Map(), byFn = new Map(), byName = new Map();
const add = (map, k, n) => map.set(k, (map.get(k) || 0) + n);
for (const line of text.split("\n")) {
  if (!line) continue;
  const eq = line.indexOf("=");
  const c = line[0];
  if (eq > 0 && /^[a-z]+$/.test(line.slice(0, eq))) {
    const k = line.slice(0, eq), v = line.slice(eq + 1);
    if (k === "ob") ob = name("ob", v);
    else if (k === "fl") { fl = name("fl", v); file = fl; }
    else if (k === "fi" || k === "fe") file = name(k, v);
    else if (k === "fn") { fn = name("fn", v); file = fl; }
    else if (k === "cfn") name("cfn", v);
    else if (k === "cfi" || k === "cfl") name(k, v);
    else if (k === "cob") name("cob", v);
    else if (k === "calls") skip = true;
    continue;
  }
  if (c >= "0" && c <= "9" || c === "+" || c === "-" || c === "*") {
    const parts = line.trim().split(/\s+/);
    const ir = Number(parts[1] || 0);
    if (skip) { skip = false; continue; }
    total += ir;
    add(byFile, crateOfFile(file, ob), ir);
    add(byFn, crateOfFn(fn, ob), ir);
    add(byName, fn, ir);
  }
}
function crateOfFile(f, o) {
  let m;
  if ((m = /registry\/src\/[^/]+\/([A-Za-z0-9_-]+?)-\d+\.\d+[^/]*\//.exec(f))) return m[1];
  if ((m = /\/rustc\/[0-9a-f]+\/library\/([a-z_]+)\//.exec(f))) return "std (" + m[1] + ")";
  if ((m = /\/src\/crates\/([a-z0-9_-]+)\//.exec(f))) return m[1];
  if ((m = /\/src\/examples\/([a-z0-9_-]+)\//.exec(f))) return m[1] + " (app)";
  if (f === "???" || !f) return "no source: " + (o.split("/").pop() || "?");
  return "other: " + f.split("/").slice(0, 4).join("/");
}
function crateOfFn(f, o) {
  if (!f || f.startsWith("0x")) return "no symbol: " + (o.split("/").pop() || "?");
  let s = f.replace(/^<+/, "");
  const m = /^([A-Za-z_][A-Za-z0-9_]*)::/.exec(s);
  if (m) return m[1];
  return "C: " + (o.split("/").pop() || "?");
}
return { total, byFile, byFn, byName };
}
const [small, large, per] = [parse(process.argv[2]), parse(process.argv[3]), Number(process.argv[4] || 1000)];
const diff = (a, b) => { const m = new Map(); for (const k of new Set([...a.keys(), ...b.keys()])) m.set(k, ((b.get(k) || 0) - (a.get(k) || 0)) / per); return m; };
const total = (large.total - small.total) / per;
const byFile = diff(small.byFile, large.byFile), byFn = diff(small.byFn, large.byFn), byName = diff(small.byName, large.byName);
const show = (title, map) => {
  console.log("\n" + title);
  for (const [k, v] of [...map].sort((a, b) => b[1] - a[1])) if (Math.abs(v) / total >= 0.003) console.log(String(Math.round(v)).padStart(10), (100 * v / total).toFixed(1).padStart(6) + "%", k);
};
console.log("Ir per request", Math.round(total));
show("By source file's crate (inlined code where it was written):", byFile);
show("By function symbol's crate:", byFn);

const top = Number(process.env.TOP || 40);
const filter = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
console.log("\nTop functions (self):");
for (const [k, v] of [...byName].filter(([k]) => !filter || filter.test(k)).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(String(Math.round(v)).padStart(8), (100 * v / total).toFixed(1).padStart(5) + "%", k.slice(0, 150));

const groups = [
  ["Corten (corten, corten-macros' output)", /^corten/],
  ["the app (card-market)", /^card-market|^card_market/],
  ["serde_json", /^serde_json$/],
  ["number formatting (zmij, itoa)", /^(zmij|ryu|itoa)$/],
  ["axum, matchit, tower", /^(axum|axum-core|matchit|tower|tower-layer|tower-service)$/],
  ["hyper, hyper-util, httparse", /^(hyper|hyper-util|httparse|h2)$/],
  ["http, bytes, http-body", /^(http|bytes|http-body|http-body-util)$/],
  ["tokio, mio", /^(tokio|mio|tokio-util)$/],
  ["compression (flate2, brotli, zstd)", /^(flate2|brotli|brotli-decompressor|zstd|zstd-sys|miniz_oxide|crc32fast)$/],
  ["Rust std (core, alloc, std): generic code inlined", /^std \(/],
  ["C library: malloc", /malloc/],
  ["C library: memcpy, memcmp, strings", /string|sysdeps|libc/],
];
const cat = new Map();
for (const [k, v] of byFile) { const g = groups.find(([, re]) => re.test(k)); const name = g ? g[0] : "other (" + k.replace(/^other: /, "") + ")"; cat.set(name, (cat.get(name) || 0) + v); }
const others = [...cat].filter(([k]) => k.startsWith("other (")).reduce((a, [, v]) => a + v, 0);
console.log("\nBy category (source file):");
for (const [k, v] of [...cat].filter(([k]) => !k.startsWith("other (")).sort((a, b) => b[1] - a[1])) console.log(String(Math.round(v)).padStart(9), (100 * v / total).toFixed(1).padStart(5) + "%", k);
console.log(String(Math.round(others)).padStart(9), (100 * others / total).toFixed(1).padStart(5) + "%", "other: " + [...cat].filter(([k, v]) => k.startsWith("other (") && v / total > 0.002).map(([k]) => k.slice(7, -1)).join(", "));

// By stage, from function names: self cost of the functions matching each, the rest unnamed.
const stages = [
  ["reading JSON (FromJson, serde_json's Value, UTF-8 checks, float parsing)", /json::read|serde_json|FromJson|from_utf8|dec2flt/],
  ["allocator (malloc, free and their internals)", /malloc|free|realloc|unlink_chunk|__rust_alloc|__rust_dealloc|__rdl_/],
  ["memcpy, memcmp", /^__mem/],
  ["writing HTML (Render, escape_into, digits, Formatted)", /Render|escape_into|push_u64|ascii::digits|i18n::format|AttrValue|mark_head_tags|head_tags/],
  ["writing JSON (ToJson, str_body, numbers)", /ToJson|json::str_body|json::unsigned|zmij/],
  ["HTTP: hyper, httparse, http's headers", /^<*(hyper|hyper_util|httparse|http)::/],
  ["tokio", /^<*tokio::/],
  ["axum, tower, matchit", /^<*(axum|axum_core|tower|tower_service|matchit)::/],
];
const st = new Map(); let named = 0;
for (const [k, v] of byName) { const s = stages.find(([, re]) => re.test(k)); if (s) { st.set(s[0], (st.get(s[0]) || 0) + v); named += v; } }
console.log("\nBy stage (function names; the rest is Corten's request path, the app's handler and smaller pieces):");
for (const [k, v] of [...st].sort((a, b) => b[1] - a[1])) console.log(String(Math.round(v)).padStart(9), (100 * v / total).toFixed(1).padStart(5) + "%", k);
console.log(String(Math.round(total - named)).padStart(9), (100 * (total - named) / total).toFixed(1).padStart(5) + "%", "the rest");
