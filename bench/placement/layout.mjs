// layout.mjs: a placement's functions against its side's unpadded binary (the placement plan's
// first point, CONTRIBUTING.md, Pull requests, item 2):
//   node layout.mjs <unpadded binary> <placement> <pad bytes> [--second] [--order <file> --map <unpadded map>]
// Reads both binaries' defined function symbols (nm) and .text's start (readelf). The placement
// passes when it holds exactly the unpadded binary's functions and the pad, the pad at the start
// of .text, every function named once in each binary moved by exactly the pad's size, and every
// pair of those that are neighbours at distinct addresses in the unpadded binary still next to
// each other in order. A ThinLTO suffix (".llvm.<n>") is not part of a name. With --second, for a
// run with code aligned beyond 16 bytes: both pads are among the placement's functions and the
// shift is not asked, since map.mjs's check stands in for it. A name defined more than once in a
// binary (local functions of one name) has no one address to compare and is left out of the shift
// and the order; the count of them is printed. Prints the counts and a last line of JSON; exits 1
// with each reason the placement fails.
// With --order, for a workload whose plan shuffles its placements (README.md, workloads[].shuffle):
// the placement was linked with that ordering file (order.mjs), the first pad's function and then
// every function of the unpadded binary's .text, and nothing moved it by the pad alone. It passes
// when it holds exactly the unpadded binary's functions and the pad (both pads with --second), the
// pad at the start of .text, the file names the pad first and then every function of the
// unpadded .text once and nothing else, and the functions named once lie in the file's order as
// LLD lays it: each input section of .text (from the unpadded link's map, by address) at the
// place of the first of its functions the file names, the functions in it as far apart as they
// were. The shift and the neighbours are not asked. The JSON then carries the file's SHA-256.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapText, readMap } from "./map.mjs";

export const PADS = ["corten_layout_pad", "corten_layout_pad2"];

/** nm's defined function symbols: name -> address, null for a name defined more than once. */
export function symbols(nm) {
  const seen = new Map();
  for (const l of nm.split("\n")) {
    const m = /^([0-9a-f]+) [tTwW] (.+)$/.exec(l);
    if (!m) continue;
    const name = m[2].replace(/\.llvm\.\d+$/, "");
    seen.set(name, seen.has(name) ? null : parseInt(m[1], 16));
  }
  return seen;
}

/** nm's defined function symbols as nm writes them: each name, the name less a ThinLTO suffix, and the address. */
export function entries(nm) {
  const out = [];
  for (const l of nm.split("\n")) {
    const m = /^([0-9a-f]+) [tTwW] (.+)$/.exec(l);
    if (m) out.push({ raw: m[2], name: m[2].replace(/\.llvm\.\d+$/, ""), at: parseInt(m[1], 16) });
  }
  return out;
}

/** .text's address in readelf -SW's output. */
export function textStart(readelf) {
  const m = /\]\s+\.text\s+\S+\s+([0-9a-f]+)\s/.exec(readelf);
  if (!m) throw new Error("no .text in readelf's sections");
  return parseInt(m[1], 16);
}

/** .text's address and size in readelf -SW's output. */
export function textRange(readelf) {
  const m = /\]\s+\.text\s+\S+\s+([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)\s/.exec(readelf);
  if (!m) throw new Error("no .text in readelf's sections");
  return { start: parseInt(m[1], 16), size: parseInt(m[2], 16) };
}

/** The names, as nm writes them, of an unpadded binary's functions in .text, each once and sorted: what an ordering file lists after the pad. */
export function textFunctions(ea, text) {
  return [...new Set(ea.filter((e) => e.at >= text.start && e.at < text.start + text.size).map((e) => e.raw))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const unique = (es) => { const seen = new Map(); for (const e of es) seen.set(e.name, seen.has(e.name) ? null : e.at); return seen; };
const some = (xs) => xs.slice(0, 3).join(", ");

/**
 * A shuffled placement against its side's unpadded binary and the ordering file it was linked
 * with. ea, eb: entries() of the unpadded binary and of the placement; text: the unpadded
 * binary's textRange(); start: the placement's .text start; order: the ordering file's lines;
 * sections: the unpadded map's input sections of .text ({ at, size }). LLD gives each input
 * section the place of the first name the file lists among its symbols and keeps its functions
 * together, so a function's place is its section's, and within it its unpadded address.
 */
export function ordered(ea, eb, text, start, order, sections, pad, second = false) {
  const pads = second ? PADS : PADS.slice(0, 1), why = [], fa = unique(ea), fb = unique(eb);
  const onlyA = [...fa.keys()].filter((n) => !fb.has(n)), onlyB = [...fb.keys()].filter((n) => !fa.has(n));
  if (onlyA.length) why.push(`${onlyA.length} functions only in the unpadded binary: ${some(onlyA)}`);
  if (onlyB.sort().join() !== [...pads].sort().join()) why.push(`only in the placement: ${onlyB.join(", ") || "nothing"}, not ${pads.join(" and ")}`);
  if (fb.get(PADS[0]) !== start) why.push("the pad is not at the start of .text");
  // The file: the pad, then every function of the unpadded .text once and nothing else.
  const want = textFunctions(ea, text), wanted = new Set(want), listed = order.slice(1), pos = new Map();
  if (order[0] !== PADS[0]) why.push(`the ordering file's first name is ${order[0] ?? "nothing"}, not ${PADS[0]}`);
  listed.forEach((n, k) => { if (!pos.has(n)) pos.set(n, k); });
  if (pos.size !== listed.length) why.push(`${listed.length - pos.size} names more than once in the ordering file`);
  const missing = want.filter((n) => !pos.has(n)), extra = [...pos.keys()].filter((n) => !wanted.has(n));
  if (missing.length) why.push(`${missing.length} functions of the unpadded .text not in the ordering file: ${some(missing)}`);
  if (extra.length) why.push(`${extra.length} names in the ordering file that are no function of the unpadded .text: ${some(extra)}`);
  // Each function's input section, by its unpadded address; a section's place, its first listed name's.
  const secs = sections.filter((s) => s.size > 0).sort((x, y) => x.at - y.at), inText = (x) => x >= text.start && x < text.start + text.size;
  const sectionOf = (x) => {
    let lo = 0, hi = secs.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (secs[mid].at <= x) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    if (k < 0) return -1;
    const end = secs[k].at + secs[k].size;
    return x < end || (x === end && secs[k + 1]?.at !== x) ? k : -1;
  };
  const place = new Map(), loose = [];
  for (const e of ea) {
    if (!inText(e.at)) continue;
    const s = sectionOf(e.at);
    if (s < 0) { loose.push(e.raw); continue; }
    if (pos.has(e.raw)) place.set(s, Math.min(place.get(s) ?? Infinity, pos.get(e.raw)));
  }
  if (loose.length) why.push(`${loose.length} functions of the unpadded .text in no input section of its map: ${some(loose)}`);
  const both = [];
  for (const [name, at] of fa) {
    const bt = fb.get(name);
    if (at != null && bt != null && inText(at)) { const s = sectionOf(at); both.push({ name, at, bt, s, p: place.get(s) ?? Infinity }); }
  }
  // In the file's order: each function after the one before it in that order, or at its address where the two were one.
  const byOrder = [...both].sort((x, y) => x.p - y.p || x.at - y.at || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  let pairs = 0, inOrder = 0;
  for (let i = 1; i < byOrder.length; i++) {
    const a = byOrder[i - 1], b = byOrder[i];
    pairs++;
    if (b.bt > a.bt || (b.bt === a.bt && b.at === a.at)) inOrder++;
  }
  if (inOrder !== pairs) why.push(`functions in the ordering file's order: ${inOrder} of ${pairs} pairs that follow each other in it`);
  // A section moves whole: its functions as far apart as in the unpadded binary.
  const shift = new Map();
  let together = 0;
  for (const f of both) { if (!shift.has(f.s)) shift.set(f.s, f.bt - f.at); if (shift.get(f.s) === f.bt - f.at) together++; }
  if (together !== both.length) why.push(`${both.length - together} of ${both.length} functions not as far from the rest of their input section as in the unpadded binary`);
  const repeated = [...fa].filter(([name, at]) => at == null || fb.get(name) === null).length;
  return { ok: why.length === 0, why, pad, second, shuffled: true, functions: both.length, repeated, pairs, inOrder, together, listed: listed.length, onlyA, onlyB };
}

/** fa, fb: symbols() of the unpadded binary and of the placement; text: the placement's .text start. */
export function compare(fa, fb, text, pad, second = false) {
  const pads = second ? PADS : PADS.slice(0, 1), why = [];
  const onlyA = [...fa.keys()].filter((n) => !fb.has(n)), onlyB = [...fb.keys()].filter((n) => !fa.has(n));
  if (onlyA.length) why.push(`${onlyA.length} functions only in the unpadded binary: ${onlyA.slice(0, 3).join(", ")}`);
  if (onlyB.sort().join() !== [...pads].sort().join()) why.push(`only in the placement: ${onlyB.join(", ") || "nothing"}, not ${pads.join(" and ")}`);
  if (fb.get(PADS[0]) !== text) why.push("the pad is not at the start of .text");
  const both = [];
  for (const [name, at] of fa) { const bt = fb.get(name); if (at != null && bt != null) both.push({ name, at, bt }); }
  const exact = both.filter((f) => f.bt - f.at === pad).length;
  if (!second && exact !== both.length) why.push(`${both.length - exact} of ${both.length} functions moved by other than the pad's ${pad} bytes`);
  const byA = [...both].sort((x, y) => x.at - y.at);
  const rankB = new Map([...both].sort((x, y) => x.bt - y.bt).map((f, i) => [f.name, i]));
  let neighbours = 0, kept = 0;
  for (let i = 1; i < byA.length; i++) {
    if (byA[i].at === byA[i - 1].at) continue;
    neighbours++;
    if (rankB.get(byA[i].name) - rankB.get(byA[i - 1].name) === 1) kept++;
  }
  if (kept !== neighbours) why.push(`neighbours still next to each other in order: ${kept} of ${neighbours}`);
  // Names defined more than once have no one address to compare: they are counted, not checked.
  const repeated = [...fa].filter(([name, at]) => at == null || fb.get(name) === null).length;
  return { ok: why.length === 0, why, pad, second, functions: both.length, repeated, exact, neighbours, neighboursKept: kept, onlyA, onlyB };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const orderFile = opt("--order"), mapFile = opt("--map"), second = args.includes("--second");
  const [a, b, padArg] = args.filter((x) => x !== "--second"), pad = Number(padArg);
  if (!a || !b || !Number.isInteger(pad) || (orderFile === undefined) !== (mapFile === undefined)) { console.error("usage: node layout.mjs <unpadded binary> <placement> <pad bytes> [--second] [--order <file> --map <unpadded map>]"); process.exit(2); }
  const nmText = (bin) => execFileSync("nm", ["--defined-only", bin], { encoding: "utf8", maxBuffer: 1 << 28 });
  const readelf = (bin) => execFileSync("readelf", ["-SW", bin], { encoding: "utf8" });
  if (orderFile !== undefined) {
    const bytes = readFileSync(orderFile), t = readMap(mapText(readFileSync(mapFile))).find((o) => o.name === ".text");
    if (!t) { console.error(`layout.mjs: no .text output section in ${mapFile}`); process.exit(2); }
    const r = ordered(entries(nmText(a)), entries(nmText(b)), textRange(readelf(a)), textStart(readelf(b)), bytes.toString("utf8").replace(/\n$/, "").split("\n"), t.inputs, pad, second);
    console.log(`functions in both: ${r.functions}; names defined more than once in a binary, left out of the order: ${r.repeated}; names the ordering file lists after the pad: ${r.listed}; pairs in its order: ${r.inOrder} of ${r.pairs}; functions as far from the rest of their input section as unpadded: ${r.together}; only in the placement: ${r.onlyB.join(", ")}`);
    console.log("JSON " + JSON.stringify({ ...r, order: createHash("sha256").update(bytes).digest("hex"), onlyA: r.onlyA.length }));
    for (const w of r.why) console.error(`layout.mjs: ${w}`);
    process.exit(r.ok ? 0 : 1);
  }
  const nm = (bin) => symbols(nmText(bin));
  const r = compare(nm(a), nm(b), textStart(readelf(b)), pad, second);
  console.log(`functions in both: ${r.functions}; names defined more than once in a binary, left out of the shift and the order: ${r.repeated}; moved by exactly the pad: ${r.exact}${second ? " (not asked: the map's check stands in)" : ""}; neighbours kept: ${r.neighboursKept} of ${r.neighbours}; only in the placement: ${r.onlyB.join(", ")}`);
  console.log("JSON " + JSON.stringify({ ...r, onlyA: r.onlyA.length }));
  for (const w of r.why) console.error(`layout.mjs: ${w}`);
  process.exit(r.ok ? 0 : 1);
}
