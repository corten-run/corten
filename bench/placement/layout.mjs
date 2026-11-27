// layout.mjs: a placement's functions against its side's unpadded binary (the placement plan's
// first point, CONTRIBUTING.md, Pull requests, item 2):
//   node layout.mjs <unpadded binary> <placement> <pad bytes> [--second] [--order <file> --map <unpadded map>]
//   node layout.mjs --alike <base placement> <head placement> <pad bytes>
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
// unpadded .text once and nothing else, and its .text lays the unpadded functions out as LLD lays
// them for that file: each input section of .text (from the unpadded link's map, by address) at
// the place of the first of its functions the file names, sections of one place in their unpadded
// order, so every definition, a name defined more than once included, at its section's place and
// its place in the section; the functions of a section as far apart as they were; the first
// section after the end of the whole pad, each after the end of the one before it, and the last
// inside .text and before the second pad. The shift and the neighbours are not asked. The JSON
// then carries the file's SHA-256.
// With --alike, for a shuffled change: base's and head's placements at one index lay the
// functions both have (each name defined once in each one's .text) in one order, which their
// ordering files give them unless a symbol one side alone has gives a section both have another
// place.
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
 * binary's textRange(); placed: the placement's textRange(); order: the ordering file's lines;
 * sections: the unpadded map's input sections of .text ({ at, size }). LLD gives each input
 * section the place of the first name the file lists among its symbols, sections of one place in
 * the order they had, and keeps a section's functions together. So the placement's .text, after
 * the pad, holds every function of the unpadded .text, each definition once (a name defined more
 * than once included), in the order of its section's place and then its address in the section;
 * every section's functions as far apart as they were; the first section after the whole pad and
 * each after the end of the one before it; and the last inside .text, before any second pad.
 */
export function ordered(ea, eb, text, placed, order, sections, pad, second = false) {
  const pads = second ? PADS : PADS.slice(0, 1), why = [], fa = unique(ea), fb = unique(eb);
  const onlyA = [...fa.keys()].filter((n) => !fb.has(n)), onlyB = [...fb.keys()].filter((n) => !fa.has(n));
  if (onlyA.length) why.push(`${onlyA.length} functions only in the unpadded binary: ${some(onlyA)}`);
  if (onlyB.sort().join() !== [...pads].sort().join()) why.push(`only in the placement: ${onlyB.join(", ") || "nothing"}, not ${pads.join(" and ")}`);
  if (fb.get(PADS[0]) !== placed.start) why.push("the pad is not at the start of .text");
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
  const units = secs.map((s, k) => ({ s, k, fns: [], p: Infinity })), loose = [];
  for (const e of ea) {
    if (!inText(e.at)) continue;
    const k = sectionOf(e.at);
    if (k < 0) { loose.push(e.raw); continue; }
    units[k].fns.push(e);
    if (pos.has(e.raw)) units[k].p = Math.min(units[k].p, pos.get(e.raw));
  }
  if (loose.length) why.push(`${loose.length} functions of the unpadded .text in no input section of its map: ${some(loose)}`);
  const byRaw = (x, y) => (x.raw < y.raw ? -1 : x.raw > y.raw ? 1 : 0);
  const laid = units.filter((u) => u.fns.length).sort((x, y) => x.p - y.p || x.k - y.k);
  for (const u of laid) u.fns.sort((x, y) => x.at - y.at || byRaw(x, y));
  const expected = laid.flatMap((u) => u.fns.map((e) => ({ e, u })));
  // The placement's functions in its .text, but the pads, by address: the file's order, definition by definition.
  const end = placed.start + placed.size;
  const got = eb.filter((e) => e.at >= placed.start && e.at < end && !PADS.includes(e.name)).sort((x, y) => x.at - y.at || byRaw(x, y));
  let matched = 0, first = -1;
  for (let k = 0; k < Math.max(expected.length, got.length); k++) {
    if (k < expected.length && k < got.length && expected[k].e.raw === got[k].raw) matched++;
    else if (first < 0) first = k;
  }
  if (got.length !== expected.length) why.push(`the placement's .text holds ${got.length} definitions of functions besides the pad${second ? "s" : ""}, not the unpadded .text's ${expected.length}`);
  if (first >= 0) why.push(`functions in the ordering file's order: ${matched} of ${expected.length} places in the placement's .text; the first that differs, place ${first + 1}, holds ${got[first]?.raw ?? "nothing"}, not ${expected[first]?.e.raw ?? "nothing"}`);
  // A section moves whole: its functions as far apart as in the unpadded binary.
  let together = 0, follow = 0;
  if (first < 0) {
    const shift = new Map();
    expected.forEach(({ e, u }, k) => { const d = got[k].at - e.at; if (!shift.has(u)) shift.set(u, d); if (shift.get(u) === d) together++; });
    if (together !== expected.length) why.push(`${expected.length - together} of ${expected.length} functions not as far from the rest of their input section as in the unpadded binary`);
    else {
      // Every section after the whole pad, each after the end of the one before it, and the last
      // inside .text, before the second pad where there is one.
      const top = second && fb.get(PADS[1]) != null ? fb.get(PADS[1]) : end;
      let dot = placed.start + pad, behind = 0;
      laid.forEach((u, k) => {
        const at = u.s.at + shift.get(u);
        if (at < dot) {
          if (k === 0) why.push(`the functions do not all follow the pad: ${u.fns[0].raw} lies at 0x${(u.fns[0].at + shift.get(u)).toString(16)}, in its input section from 0x${at.toString(16)}, before the pad's end at 0x${dot.toString(16)}`);
          else behind++;
        } else follow++;
        dot = Math.max(dot, at + u.s.size);
      });
      if (behind) why.push(`${behind} input sections of .text begin before the end of the one laid before them`);
      if (dot > top) why.push(`the functions' input sections end at 0x${dot.toString(16)}, past ${top === end ? "the end of .text" : "the second pad"} at 0x${top.toString(16)}`);
    }
  }
  const repeated = [...unique(ea.filter((e) => inText(e.at)))].filter(([, at]) => at == null).length;
  return { ok: why.length === 0, why, pad, second, shuffled: true, functions: expected.length, repeated, sections: laid.length, matched, together, follow, listed: listed.length, onlyA, onlyB };
}

/**
 * Two placements at one index of a shuffled run, base's and head's, linked with ordering files
 * drawn alike: the functions both have, each name (less a ThinLTO suffix) defined once in each
 * one's .text, lie in one order in both. Their files list those names in one order, but a section
 * takes the place of the first name it holds, so a symbol one side alone has in a section the
 * other has too can give that section, and the functions in it, another place. ea, eb: entries()
 * of the two placements; ta, tb: their textRange()s.
 */
export function alike(ea, eb, ta, tb, pad) {
  const once = (es, t) => {
    const n = new Map();
    for (const e of es) if (e.at >= t.start && e.at < t.start + t.size && !PADS.includes(e.name)) n.set(e.name, n.has(e.name) ? null : e.at);
    return n;
  };
  const a = once(ea, ta), b = once(eb, tb), shared = [...a.keys()].filter((n) => a.get(n) != null && b.get(n) != null);
  const seq = (m) => [...shared].sort((x, y) => m.get(x) - m.get(y) || (x < y ? -1 : x > y ? 1 : 0));
  const sa = seq(a), sb = seq(b), why = [];
  const first = sa.findIndex((n, k) => n !== sb[k]);
  if (first >= 0) why.push(`the ${shared.length} functions both placements have do not lie in one order: place ${first + 1} holds ${sa[first]} in the first and ${sb[first]} in the second`);
  return { ok: why.length === 0, why, pad, shuffled: true, shared: shared.length, same: first < 0 ? shared.length : first };
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
  const orderFile = opt("--order"), mapFile = opt("--map"), second = args.includes("--second"), both = args.includes("--alike");
  const [a, b, padArg] = args.filter((x) => x !== "--second" && x !== "--alike"), pad = Number(padArg);
  if (!a || !b || !Number.isInteger(pad) || (orderFile === undefined) !== (mapFile === undefined) || (both && (second || orderFile !== undefined))) { console.error("usage: node layout.mjs <unpadded binary> <placement> <pad bytes> [--second] [--order <file> --map <unpadded map>] | --alike <base placement> <head placement> <pad bytes>"); process.exit(2); }
  const nmText = (bin) => execFileSync("nm", ["--defined-only", bin], { encoding: "utf8", maxBuffer: 1 << 28 });
  const readelf = (bin) => execFileSync("readelf", ["-SW", bin], { encoding: "utf8" });
  if (both) {
    const r = alike(entries(nmText(a)), entries(nmText(b)), textRange(readelf(a)), textRange(readelf(b)), pad);
    console.log(`functions both placements have, each defined once in each: ${r.shared}; in one order: ${r.same}`);
    console.log("JSON " + JSON.stringify(r));
    for (const w of r.why) console.error(`layout.mjs: ${w}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (orderFile !== undefined) {
    const bytes = readFileSync(orderFile), t = readMap(mapText(readFileSync(mapFile))).find((o) => o.name === ".text");
    if (!t) { console.error(`layout.mjs: no .text output section in ${mapFile}`); process.exit(2); }
    const r = ordered(entries(nmText(a)), entries(nmText(b)), textRange(readelf(a)), textRange(readelf(b)), bytes.toString("utf8").replace(/\n$/, "").split("\n"), t.inputs, pad, second);
    console.log(`definitions of functions in the unpadded .text: ${r.functions}, in ${r.sections} input sections; names defined more than once there, checked by their sections: ${r.repeated}; names the ordering file lists after the pad: ${r.listed}; places in its order: ${r.matched} of ${r.functions}; functions as far from the rest of their input section as unpadded: ${r.together}; sections after the pad and the one before: ${r.follow}; only in the placement: ${r.onlyB.join(", ")}`);
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
