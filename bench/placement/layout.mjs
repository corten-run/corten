// layout.mjs: a placement's functions against its side's unpadded binary (the placement plan's
// first point, CONTRIBUTING.md, Pull requests, item 2):
//   node layout.mjs <unpadded binary> <placement> <pad bytes> [--second] [--order <file> --map <unpadded map>]
//   node layout.mjs --alike <base unpadded> <base placement> <base order> <base unpadded map>
//                           <head unpadded> <head placement> <head order> <head unpadded map> <pad bytes> [--second]
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
// them for that file: each input section of .text (from the unpadded link's map: a function's by
// its address, and at the end of one section and the start of the next, by the map's symbols
// there) at
// the place of the first of its functions the file names, sections of one place in their unpadded
// order, so every definition, a name defined more than once included, at its section's place and
// its place in the section; the functions of a section as far apart as they were; the first
// section after the end of the whole pad, each after the end of the one before it, and the last
// inside .text and before the second pad. The shift and the neighbours are not asked. The JSON
// then carries the file's SHA-256.
// With --alike, for a shuffled change: base's and head's placements at one index, each passing
// --order against its side's unpadded binary and map, lay the functions both have in one order,
// which their ordering files give them unless a symbol one side alone has gives a section both
// have another place. A name defined once in each one's .text is one function of both; a name
// defined more than once in either is each definition by its input section (its object, or
// archive and member, less directories, and its section's name), and one such that either side
// has more than once, which nothing tells apart, refuses the change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapText, origin, readMap } from "./map.mjs";

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
 * sections: the unpadded map's input sections of .text ({ at, size, symbols }). LLD gives each input
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
  // An address that ends one section and starts the next (a symbol of no size at a section's end,
  // say) is the section's whose map symbols there hold the name, or the one of the two with any
  // symbol there; when both have one there and the name tells them apart in neither (the map
  // writes a mangled name demangled), it is in no section the check can establish.
  const there = (s, x) => (s.symbols ?? []).filter((y) => y.at === x).map((y) => y.name);
  const sectionOf = (e) => {
    const x = e.at;
    let lo = 0, hi = secs.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (secs[mid].at <= x) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    if (k < 0) return -1;
    const end = secs[k].at + secs[k].size;
    if (x >= end) return x === end ? k : -1;
    if (secs[k].at !== x || k === 0 || secs[k - 1].at + secs[k - 1].size !== x) return k;
    const before = there(secs[k - 1], x), after = there(secs[k], x);
    if (!before.length) return k;
    if (!after.length) return k - 1;
    const inBefore = before.includes(e.raw), inAfter = after.includes(e.raw);
    return inBefore !== inAfter ? (inBefore ? k - 1 : k) : -2;
  };
  const units = secs.map((s, k) => ({ s, k, fns: [], p: Infinity })), loose = [], between = [];
  for (const e of ea) {
    if (!inText(e.at)) continue;
    const k = sectionOf(e);
    if (k === -2) { between.push(e.raw); continue; }
    if (k < 0) { loose.push(e.raw); continue; }
    units[k].fns.push(e);
    if (pos.has(e.raw)) units[k].p = Math.min(units[k].p, pos.get(e.raw));
  }
  if (loose.length) why.push(`${loose.length} functions of the unpadded .text in no input section of its map: ${some(loose)}`);
  if (between.length) why.push(`${between.length} functions of the unpadded .text at the end of one input section and the start of the next, which its map's symbols there do not tell apart: ${some(between)}`);
  const byRaw = (x, y) => (x.raw < y.raw ? -1 : x.raw > y.raw ? 1 : 0);
  const laid = units.filter((u) => u.fns.length).sort((x, y) => x.p - y.p || x.k - y.k);
  for (const u of laid) u.fns.sort((x, y) => x.at - y.at || byRaw(x, y));
  const expected = laid.flatMap((u) => u.fns.map((e) => ({ e, u })));
  // The placement's functions in its .text, but the pads, by address: the file's order, definition by definition.
  const end = placed.start + placed.size;
  const got = eb.filter((e) => e.at >= placed.start && e.at < end && !PADS.includes(e.name)).sort((x, y) => x.at - y.at || byRaw(x, y));
  // Definitions at one address have no order by address (one section's end and the next's start,
  // say): such a run takes the order expected at its places when it holds those names.
  for (let i = 0; i < got.length;) {
    let j = i + 1;
    while (j < got.length && got[j].at === got[i].at) j++;
    if (j - i > 1 && j <= expected.length) {
      const want = expected.slice(i, j).map((x) => x.e.raw), run = got.slice(i, j);
      if ([...want].sort().join("\n") === run.map((g) => g.raw).sort().join("\n")) want.forEach((n, k) => { got[i + k] = run.splice(run.findIndex((g) => g.raw === n), 1)[0]; });
    }
    i = j;
  }
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
  // Each placed definition with the unpadded input section it was found to be of, for alike().
  const defs = first < 0 ? got.map((g, k) => ({ raw: g.raw, name: g.name, at: g.at, section: expected[k].u.s })) : null;
  return { ok: why.length === 0, why, pad, second, shuffled: true, functions: expected.length, repeated, sections: laid.length, matched, together, follow, listed: listed.length, onlyA, onlyB, defs };
}

/**
 * Two placements at one index of a shuffled run, base's and head's, linked with ordering files
 * drawn alike: the functions both have lie in one order in both. Their files list those names in
 * one order, but a section takes the place of the first name it holds, so a symbol one side alone
 * has in a section the other has too can give that section, and the functions in it, another
 * place. Each side is { ea, eb, text, placed, order, sections }, the arguments ordered() takes
 * for it, and each must pass ordered(), which finds every placed definition's input section. A
 * name (less a ThinLTO suffix) defined once in each one's .text is one function of both; a name
 * defined more than once in either is each definition by its input section (origin() of its
 * file and the section's name), shared when both have that definition once; one either has more
 * than once is told apart by nothing, and the order of what both have cannot be established.
 */
export function alike(base, head, pad, second = false) {
  const check = (x) => ordered(x.ea, x.eb, x.text, x.placed, x.order, x.sections, pad, second);
  const ra = check(base), rb = check(head);
  if (!ra.ok || !rb.ok) throw new Error(`alike: ${!ra.ok ? "base's" : "head's"} placement does not pass its own shuffled check: ${(!ra.ok ? ra : rb).why.join("; ")}`);
  const count = (defs) => { const n = new Map(); for (const d of defs) n.set(d.name, (n.get(d.name) ?? 0) + 1); return n; };
  const na = count(ra.defs), nb = count(rb.defs);
  const label = new Map(), key = (d) => {
    if (na.get(d.name) === 1 && nb.get(d.name) === 1) return d.name;
    const o = origin(d.section.file ?? ""), file = o.object ?? `${o.archive}(${o.member})`, k = `${d.name}\n${file}\n${d.section.section ?? ""}`;
    label.set(k, `${d.name} in ${file}:(${d.section.section ?? ""})`);
    return k;
  };
  const keyed = (defs) => { const m = new Map(); for (const d of defs) { const k = key(d); m.set(k, [...(m.get(k) ?? []), d.at]); } return m; };
  const a = keyed(ra.defs), b = keyed(rb.defs), both = [...a.keys()].filter((k) => b.has(k));
  const shared = both.filter((k) => a.get(k).length === 1 && b.get(k).length === 1), told = new Set(shared), untold = both.filter((k) => !told.has(k));
  const seq = (m) => [...shared].sort((x, y) => m.get(x)[0] - m.get(y)[0] || (x < y ? -1 : x > y ? 1 : 0));
  const sa = seq(a), sb = seq(b), why = [], show = (k) => label.get(k) ?? k;
  if (untold.length) why.push(`${untold.length} functions both placements have are each defined more than once in input sections of one file and name, which nothing tells apart, so their order cannot be established: ${some(untold.map(show))}`);
  const first = sa.findIndex((n, k) => n !== sb[k]);
  if (first >= 0) why.push(`the ${shared.length} functions both placements have do not lie in one order: place ${first + 1} holds ${show(sa[first])} in the first and ${show(sb[first])} in the second`);
  const repeated = shared.filter((k) => label.has(k)).length;
  return { ok: why.length === 0, why, pad, shuffled: true, shared: shared.length, repeated, untold: untold.length, same: first < 0 ? shared.length : first };
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
  const rest = args.filter((x) => x !== "--second" && x !== "--alike"), [a, b, padArg] = both ? [rest[0], rest[4], rest[8]] : rest, pad = Number(padArg);
  const usage = "usage: node layout.mjs <unpadded binary> <placement> <pad bytes> [--second] [--order <file> --map <unpadded map>] | --alike <base unpadded> <base placement> <base order> <base map> <head unpadded> <head placement> <head order> <head map> <pad bytes> [--second]";
  if (!a || !b || !Number.isInteger(pad) || (orderFile === undefined) !== (mapFile === undefined) || (both && (orderFile !== undefined || rest.length !== 9))) { console.error(usage); process.exit(2); }
  const nmText = (bin) => execFileSync("nm", ["--defined-only", bin], { encoding: "utf8", maxBuffer: 1 << 28 });
  const readelf = (bin) => execFileSync("readelf", ["-SW", bin], { encoding: "utf8" });
  const textOf = (file) => { const t = readMap(mapText(readFileSync(file))).find((o) => o.name === ".text"); if (!t) { console.error(`layout.mjs: no .text output section in ${file}`); process.exit(2); } return t; };
  const lines = (file) => readFileSync(file).toString("utf8").replace(/\n$/, "").split("\n");
  if (both) {
    const side = ([unpadded, placement, order, map]) => ({ ea: entries(nmText(unpadded)), eb: entries(nmText(placement)), text: textRange(readelf(unpadded)), placed: textRange(readelf(placement)), order: lines(order), sections: textOf(map).inputs });
    let r;
    try { r = alike(side(rest.slice(0, 4)), side(rest.slice(4, 8)), pad, second); } catch (e) { console.error(`layout.mjs: ${e.message}`); process.exit(2); }
    console.log(`functions both placements have: ${r.shared}, ${r.repeated} of them of a name defined more than once, told apart by their input sections; in one order: ${r.same}; defined more than once in input sections of one file and name: ${r.untold}`);
    console.log("JSON " + JSON.stringify(r));
    for (const w of r.why) console.error(`layout.mjs: ${w}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (orderFile !== undefined) {
    const bytes = readFileSync(orderFile), t = textOf(mapFile);
    const { defs, ...r } = ordered(entries(nmText(a)), entries(nmText(b)), textRange(readelf(a)), textRange(readelf(b)), bytes.toString("utf8").replace(/\n$/, "").split("\n"), t.inputs, pad, second);
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
