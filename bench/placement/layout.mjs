// layout.mjs: a placement's functions against its side's unpadded binary (the placement plan's
// first point, CONTRIBUTING.md, Pull requests, item 2):
//   node layout.mjs <unpadded binary> <placement> <pad bytes> [--second] [--order <file> --map <unpadded map> --placed-map <placement map>]
//   node layout.mjs --alike <base unpadded> <base placement> <base order> <base unpadded map> <base placement map>
//                           <head unpadded> <head placement> <head order> <head unpadded map> <head placement map> <pad bytes> [--second]
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
// every function of the unpadded binary's .text, and LLD laid .text as that file lays it
// (ordered()): every defined symbol of a name the file lists, a function, a label (NOTYPE) or an
// object, local or global, gives its input section that name's place, as LLD does, read from the
// symbols each link's map lists (written with --no-demangle, as build.sh asks for in a shuffled
// run, so they match the symbol table byte for byte); a listed name the map also has outside
// .text is refused, since LLD orders that output section too. Outside .text, distinct input IDs
// are compared by ID and position only (outsideOrder()). A function is of .text by its ELF
// symbol table entry's section index (readelf -sW's .symtab, type FUNC), and of the input section
// its own link's map gives it (map.mjs owner()). It passes when the first input section of .text
// is the first pad's, exactly the declared pad's size; the rest are the unpadded map's (map.mjs
// pair()), each listing the same symbols as far from its start, sections of one key together in
// any order among themselves (LLD sorts by the key alone, not stably) and sections the file
// places nowhere after them in theirs; every function in its unpadded section's pair, as far from
// its start; each section after the end of the one before it and the last inside .text and before
// the second pad. The JSON carries SHA-256s of the ordering file, both maps (gunzipped) and both
// executables checked.
// With --alike, for a shuffled change: base's and head's placements at one index, each passing
// --order, lay the functions whose identity is plain on both sides in one order (alike()). A
// function is its name less a ThinLTO suffix, compared only where each side defines that name
// exactly once by every reading (one function of .text, one symbol of its symbol table, one symbol
// of its map, at the function's address); a name defined more than once, or that those readings
// disagree on, is left out and counted, never matched by an object, a section or a size. The
// compared functions are taken in each placement's order (its map's order of their input sections,
// then their distance into each), those at one place together, each by name. The lists and
// which names share an ELF address must agree; fewer than FEWEST compared names also refuse.
// Prints "<N> shared names compared, <M> left out as ambiguous" and a JSON line with the counts
// and the SHA-256s of both ordering files, all four maps (gunzipped) and all four executables,
// which report.mjs checks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapBytes, owner, PAD, pair, readMap, SECOND_PAD } from "./map.mjs";

export const PADS = ["corten_layout_pad", "corten_layout_pad2"];
export const thinName = (name) => name.replace(/\.llvm\.\d+$/, "");

/** nm's defined function symbols: name -> address, null for a name defined more than once. */
export function symbols(nm) {
  const seen = new Map();
  for (const l of nm.split("\n")) {
    const m = /^([0-9a-f]+) [tTwW] (.+)$/.exec(l);
    if (!m) continue;
    const name = thinName(m[2]);
    seen.set(name, seen.has(name) ? null : parseInt(m[1], 16));
  }
  return seen;
}

/** nm's defined function symbols as nm writes them: each name, the name less a ThinLTO suffix, and the address. */
export function entries(nm) {
  const out = [];
  for (const l of nm.split("\n")) {
    const m = /^([0-9a-f]+) [tTwW] (.+)$/.exec(l);
    if (m) out.push({ raw: m[2], name: thinName(m[2]), at: parseInt(m[1], 16) });
  }
  return out;
}

/** .text's address in readelf -SW's output. */
export function textStart(readelf) {
  const m = /\]\s+\.text\s+\S+\s+([0-9a-f]+)\s/.exec(readelf);
  if (!m) throw new Error("no .text in readelf's sections");
  return parseInt(m[1], 16);
}

/** .text's section index, address and size in readelf -SW's output. */
export function textRange(readelf) {
  const m = /\[\s*(\d+)\]\s+\.text\s+\S+\s+([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)\s/.exec(readelf);
  if (!m) throw new Error("no .text in readelf's sections");
  return { index: Number(m[1]), start: parseInt(m[2], 16), size: parseInt(m[3], 16) };
}

/**
 * The defined symbols of readelf -sW's .symtab, as the ELF symbol table has them: each name as
 * written, the name less a ThinLTO suffix, its type (FUNC, NOTYPE, OBJECT, ...), whether it is
 * local, its address, its size and the index of the output section that holds it (st_shndx), or
 * null for an absolute one (ABS). A function's section index says which section it is of where an
 * address alone does not: a function of no size at the very end of .text, or one at the address
 * where the next section begins. File and section symbols (STT_FILE, STT_SECTION) and undefined
 * ones are not read, nor is .dynsym. A binary without a .symtab (stripped) has none to read and is
 * refused.
 */
export function elfSymbols(readelf) {
  const out = [];
  let table = null, symtab = false;
  for (const l of readelf.split("\n")) {
    const h = /^Symbol table '([^']*)'/.exec(l);
    if (h) { table = h[1]; symtab ||= table === ".symtab"; continue; }
    if (table !== ".symtab") continue;
    const m = /^\s*\d+:\s+([0-9a-f]+)\s+(0x[0-9a-f]+|\d+)\s+(\S+)\s+(\S+)\s+\S+(?:\s+\[[^\]]*\])?\s+(\S+)\s+(\S.*?)\s*$/.exec(l.replace(/\r$/, ""));
    if (!m || m[3] === "FILE" || m[3] === "SECTION" || m[5] === "UND") continue;
    out.push({ raw: m[6], name: thinName(m[6]), type: m[3], local: m[4] === "LOCAL", at: parseInt(m[1], 16), size: Number(m[2]), shndx: /^\d+$/.test(m[5]) ? Number(m[5]) : null });
  }
  if (!symtab) throw new Error("no .symtab in readelf's symbols: a stripped binary has no function symbols to read");
  return out;
}

/** The functions (type FUNC) among elfSymbols(), each in a section. */
export const functionsOf = (es) => es.filter((e) => e.type === "FUNC" && Number.isInteger(e.shndx));

/**
 * Whether a symbol (elfSymbols()) is of .text (textRange()): its st_shndx is .text's index. The
 * one rule both the ordering file's list (textFunctions(), order.mjs) and the shuffled checks
 * (ordered()) take a function of .text by, whatever its address or size.
 */
export function inText(e, text) {
  if (!Number.isInteger(e.shndx) || !Number.isInteger(text.index)) throw new Error(`inText: ${e.raw} or .text has no section index (elfSymbols() and textRange() give them)`);
  return e.shndx === text.index;
}

/** The names, as the symbol table writes them, of an unpadded binary's functions of .text (inText()), each once and sorted: what an ordering file lists after the pad. */
export function textFunctions(ea, text) {
  const bare = ea.find((e) => !("type" in e) || !("shndx" in e));
  if (bare) throw new Error(`textFunctions: ${bare.raw} has no section index or symbol type (elfSymbols() gives both)`);
  return [...new Set(functionsOf(ea).filter((e) => inText(e, text)).map((e) => e.raw))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const unique = (es) => { const seen = new Map(); for (const e of es) seen.set(e.name, seen.has(e.name) ? null : e.at); return seen; };
const some = (xs) => xs.slice(0, 3).join(", ");
const sameSymbols = (a, b) => a.symbols.length === b.symbols.length && a.symbols.every((y, k) => y.name === b.symbols[k].name && y.at - a.at === b.symbols[k].at - b.at);

// The ordering file is for .text alone. Outside it, compare output sections with inputs in map
// order and distinct inputs by ID and position only. Repeated IDs can come from different inputs;
// also compare their size, alignment and symbol names at relative offsets to tell them apart
// when the map can. Absolute addresses are not compared.
function outsideOrder(unpadded, placed) {
  const a = unpadded.filter((o) => o.inputs.length), b = placed.filter((o) => o.inputs.length);
  if (a.length !== b.length || a.some((o, i) => o.name !== b[i].name)) return ["the output sections with inputs outside .text differ from the unpadded map"];
  return a.flatMap(({ name, inputs }, i) => {
    const seen = new Set(), repeated = new Set();
    for (const s of inputs) { if (seen.has(s.id)) repeated.add(s.id); seen.add(s.id); }
    const got = b[i].inputs;
    const differs = (s, p) => s.id !== p.id || (repeated.has(s.id) && (s.size !== p.size || s.align !== p.align || !sameSymbols(s, p)));
    return inputs.length !== got.length || inputs.some((s, j) => differs(s, got[j])) ? [`input order in ${name} differs from the unpadded map`] : [];
  });
}

/**
 * A shuffled placement against its side's unpadded binary and the ordering file it was linked
 * with. ea, eb: elfSymbols() of the unpadded binary and of the placement; text: the unpadded
 * binary's textRange(); placed: the placement's textRange(); order: the ordering file's lines;
 * sections, placedSections: the input sections of .text ({ at, size, symbols, ... }) in the
 * unpadded link's map and in the placement's, each in its map's order; elsewhere: the placement
 * map's symbols in its other output sections ({ name, output }); otherMaps: both maps' output
 * sections other than .text.
 * Where a section lands is what LLD's --symbol-ordering-file does and no more: every defined
 * symbol of a name the file lists, of any type (FUNC, NOTYPE, OBJECT) and local or global, gives
 * the input section that holds it that name's place, and a section takes the earliest place any
 * of its symbols gives it (its key). So a section's key is read from the symbols its map lists in
 * it, which are every such symbol, kept in the symbol table or not, as LLD writes its map with
 * --no-demangle. The sections the file places are sorted by key alone, with no order among
 * sections of one key (llvm::sort, not a stable sort), and the sections it places nowhere follow
 * in their own order (x86-64, where LLD inserts no thunks). A name the file lists that the
 * placement's map also has in another output section can order that section too and is refused.
 * Outside .text, compare distinct input IDs by ID and position only, with additional checks
 * for repeated IDs (outsideOrder()). Within .text the unpadded sections are taken in
 * groups, one a key (each section the file places nowhere a group of its own), and the placement passes when it holds,
 * besides the pads, the unpadded map's input sections (map.mjs pair()), each listing the same
 * symbols as far from its start, with each group's sections together, in any order among
 * themselves, and the groups in the order of their keys; every function of .text (by its symbol's
 * section index, inText(), and of the input section its own link's map gives it, owner()) in the
 * section paired with its unpadded one, as far from its start; the first pad's section first, at
 * the start of .text and exactly the declared pad's size; the first function's section after it,
 * each after the end of the one before it, and the last inside .text, before any second pad.
 */
export function ordered(ea, eb, text, placed, order, sections, placedSections, pad, second = false, elsewhere = [], otherMaps = [[], []]) {
  const pads = second ? PADS : PADS.slice(0, 1), why = [], fa = unique(functionsOf(ea)), fb = unique(functionsOf(eb));
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
  const orderedNames = new Set(order);
  const outside = [...new Set(elsewhere.filter((y) => orderedNames.has(y.name)).map((y) => `${y.name} (${y.output})`))];
  if (outside.length) why.push(`${outside.length} names the ordering file lists are also defined outside .text, where LLD orders by them too: ${some(outside)}`);
  why.push(...outsideOrder(...otherMaps));
  // Each function of .text, by its symbol's section index (inText()), and its input section by its
  // own link's map (owner(), whose names match the symbol table's when the map is written with
  // --no-demangle). Every one must have one: one the map gives none, or does not tell apart, is
  // refused, the very end of .text included.
  const owned = (es, inputs, range, skip = () => false) => {
    const out = [], loose = [], between = [];
    for (const e of functionsOf(es)) {
      if (skip(e) || !inText(e, range)) continue;
      const k = owner(inputs, e.at, e.raw);
      if (k >= 0) out.push({ e, k, off: e.at - inputs[k].at });
      else (k === -2 ? between : loose).push(e.raw);
    }
    return { out, loose, between };
  };
  const A = sections, oa = owned(ea, A, text);
  if (oa.loose.length) why.push(`${oa.loose.length} functions of the unpadded .text in no input section of its map: ${some(oa.loose)}`);
  if (oa.between.length) why.push(`${oa.between.length} functions of the unpadded .text at an address its map's symbols there do not give to one input section: ${some(oa.between)}`);
  // Each unpadded section's key, from every symbol its map lists in it, and the groups of one key
  // in the order LLD lays them.
  const units = A.map((s, k) => ({ s, k, fns: [], p: Infinity }));
  for (const d of oa.out) units[d.k].fns.push(d);
  A.forEach((s, k) => { for (const y of s.symbols ?? []) if (pos.has(y.name)) units[k].p = Math.min(units[k].p, pos.get(y.name)); });
  const groups = [];
  for (const u of [...units].sort((x, y) => x.p - y.p || x.k - y.k)) {
    const last = groups.at(-1);
    if (u.p !== Infinity && last?.p === u.p) last.members.push(u.k);
    else groups.push({ p: u.p, members: [u.k] });
  }
  const groupOf = [], expected = groups.flatMap((g, i) => g.members.map(() => i)), functions = oa.out.length;
  groups.forEach((g, i) => { for (const k of g.members) groupOf[k] = i; });
  const tied = groups.filter((g) => g.members.length > 1);
  // The first pad's section: first in .text, at its start, exactly the declared size.
  const isPad = (s) => s.section === PAD || s.section === SECOND_PAD, B = placedSections, first = B[0];
  if (!first || first.section !== PAD || first.size !== pad || first.at !== placed.start || B.filter((s) => s.section === PAD).length !== 1) why.push(`the first input section of .text is ${first ? `${first.id ?? first.section}, ${first.size} bytes at 0x${first.at.toString(16)}` : "nothing"}, not the one first pad of ${pad} bytes at its start`);
  // The placement's sections besides the pads, each paired with the unpadded section it is, and
  // listing the same symbols as far from its start.
  const mids = [], mid = new Map();
  B.forEach((s, j) => { if (!isPad(s)) { mid.set(j, mids.length); mids.push(s); } });
  const id = (s) => s.id ?? `${s.file}:(${s.section})`, fn = (k) => (units[k].fns[0] ? ` (${units[k].fns[0].e.raw})` : "");
  let pairs = null;
  if (mids.length !== A.length) why.push(`.text has ${A.length} input sections unpadded and ${mids.length} besides the pads in the placement`);
  else {
    pairs = pair(A, mids);
    const off = pairs.findIndex((i) => i < 0);
    if (off >= 0) { why.push(`${pairs.filter((i) => i < 0).length} input sections of the placement's .text are none of the unpadded .text's of their name, size and alignment: ${id(mids[off])}`); pairs = null; }
    else {
      const unlike = pairs.map((i, j) => j).filter((j) => !sameSymbols(A[pairs[j]], mids[j]));
      if (unlike.length) { why.push(`${unlike.length} input sections of the placement's .text do not list the symbols their unpadded one lists, as far from its start: ${id(mids[unlike[0]])}`); pairs = null; }
    }
  }
  const ob = owned(eb, B, placed, (e) => PADS.includes(e.name));
  if (ob.loose.length) why.push(`${ob.loose.length} functions of the placement's .text in no input section of its map: ${some(ob.loose)}`);
  if (ob.between.length) why.push(`${ob.between.length} functions of the placement's .text at an address its map's symbols there do not give to one input section: ${some(ob.between)}`);
  const inPad = ob.out.filter((d) => !mid.has(d.k));
  if (inPad.length) why.push(`${inPad.length} functions of the placement's .text in a pad's input section: ${some(inPad.map((d) => d.e.raw))}`);
  const got = ob.out.filter((d) => mid.has(d.k));
  if (got.length !== functions) why.push(`the placement's .text holds ${got.length} definitions of functions besides the pad${second ? "s" : ""}, not the unpadded .text's ${functions}`);
  let matched = 0, together = 0, follow = 0, placedSectionsAt = 0;
  if (pairs) {
    // Each place holds a section of the group the file puts there: a group's sections together,
    // in any order among themselves, the groups in the order of their keys.
    const away = new Set();
    pairs.forEach((i, j) => { if (groupOf[i] === expected[j]) placedSectionsAt++; else away.add(i); });
    matched = oa.out.filter((d) => !away.has(d.k)).length;
    const at = pairs.findIndex((i, j) => groupOf[i] !== expected[j]);
    if (at >= 0) {
      const g = groups[expected[at]], k = g.members[0];
      why.push(`definitions where the ordering file puts them: ${matched} of ${functions}, in ${placedSectionsAt} of ${A.length} input sections (sections of one key together, in any order among themselves); the first place that differs, ${at + 1}, holds ${id(mids[at])}${fn(pairs[at])}, where the file puts ${id(A[k])}${fn(k)}${g.members.length > 1 ? ` or another of the ${g.members.length} sections of its key` : ""}`);
    }
    // Every function in the section paired with its unpadded one, as far from its start.
    const tally = new Map(), key = (i, d) => `${i}\0${d.e.raw}\0${d.off}`;
    for (const d of oa.out) tally.set(key(d.k, d), (tally.get(key(d.k, d)) ?? 0) + 1);
    for (const d of got) { const t = key(pairs[mid.get(d.k)], d), n = tally.get(t) ?? 0; if (n > 0) { together++; tally.set(t, n - 1); } }
    if (together !== functions) why.push(`${functions - together} of ${functions} functions not in the placement's input section of their unpadded one, as far from its start`);
    // Every section after the whole pad, each after the end of the one before it, and the last
    // inside .text, before the second pad where there is one.
    const top = second && fb.get(PADS[1]) != null ? fb.get(PADS[1]) : placed.start + placed.size;
    let dot = placed.start + pad, behind = 0;
    mids.forEach((s, j) => {
      if (s.at < dot) {
        if (j === 0) why.push(`the functions do not all follow the pad: ${id(s)} begins at 0x${s.at.toString(16)}, before the pad's end at 0x${dot.toString(16)}`);
        else behind++;
      } else follow++;
      dot = Math.max(dot, s.at + s.size);
    });
    if (behind) why.push(`${behind} input sections of .text begin before the end of the one laid before them`);
    if (dot > top) why.push(`the functions' input sections end at 0x${dot.toString(16)}, past ${top === placed.start + placed.size ? "the end of .text" : "the second pad"} at 0x${top.toString(16)}`);
  }
  const repeated = [...unique(oa.out.map((d) => d.e))].filter(([, at]) => at == null).length;
  // Each placed function of .text with its address, its input section, that section's place among
  // the placement's and how far into it the function is, for alike().
  const defs = pairs ? got.map((d) => ({ raw: d.e.raw, name: d.e.name, at: d.e.at, section: B[d.k], slot: mid.get(d.k), off: d.off })) : null;
  return { ok: why.length === 0, why, pad, second, shuffled: true, functions, repeated, sections: A.length, groups: groups.length, tied: tied.reduce((t, g) => t + g.members.length, 0), matched, placedSections: placedSectionsAt, together, follow, listed: listed.length, onlyA, onlyB, defs };
}

/** The fewest names alike() compares: one name has no order against another. */
export const FEWEST = 2;

/**
 * Two placements at one index of a shuffled run, base's and head's, linked with ordering files
 * drawn alike: the functions whose identity is plain on both sides lie in one order in both. Each
 * side is { ea, eb, text, placed, order, sections, placedSections, elsewhere, otherMaps }, the arguments
 * ordered() takes for it, and each must pass ordered().
 * A function is its name less a ThinLTO suffix (which a rebuild of the same code can renumber,
 * and which order.mjs keys without), and it is compared only where that name is defined exactly
 * once on each side by every reading of the placement: one function of its .text (ordered()), one
 * symbol of any type in its symbol table, and one symbol in its map, at that function's address
 * and written as the symbol table writes it. A name defined more than once (local copies, ThinLTO
 * copies of one name), or that those readings disagree on, is left out of the comparison and
 * counted; no other identity (an object, a section, a size) stands in for it. A name one side
 * alone has is that side's own. Fewer than FEWEST compared names refuse the change. The compared
 * functions are then taken in each placement's order (its map's order of their input sections,
 * then their distance into each), those at one place together. Separately, each name must share
 * its ELF address with the same others, including across input section boundaries. Where LLD's
 * order is not promised (sections of one key), a difference refuses too.
 */
export function alike(base, head, pad, second = false) {
  const check = (x) => ordered(x.ea, x.eb, x.text, x.placed, x.order, x.sections, x.placedSections, pad, second, x.elsewhere, x.otherMaps);
  const ra = check(base), rb = check(head);
  if (!ra.ok || !rb.ok) throw new Error(`alike: ${!ra.ok ? "base's" : "head's"} placement does not pass its own shuffled check: ${(!ra.ok ? ra : rb).why.join("; ")}`);
  const tally = (names) => { const m = new Map(); for (const n of names) m.set(n, (m.get(n) ?? 0) + 1); return m; };
  // Each side's plain names: one function, one symbol of the table, one of the map, which agree.
  const plain = (x, r) => {
    const fns = tally(r.defs.map((d) => d.name)), table = tally(x.eb.map((e) => e.name)), listed = new Map();
    for (const y of [...x.placedSections.flatMap((s) => s.symbols ?? []), ...(x.elsewhere ?? [])]) { const n = thinName(y.name); listed.set(n, [...(listed.get(n) ?? []), y]); }
    const out = new Map();
    for (const d of r.defs) {
      if (PADS.includes(d.name)) continue;
      const y = listed.get(d.name) ?? [];
      if (fns.get(d.name) === 1 && table.get(d.name) === 1 && y.length === 1 && y[0].name === d.raw && y[0].at === d.at) out.set(d.name, d);
    }
    return { out, all: new Set(r.defs.map((d) => d.name).filter((n) => !PADS.includes(n))) };
  };
  const pa = plain(base, ra), pb = plain(head, rb), why = [];
  const shared = [...pa.all].filter((n) => pb.all.has(n)), compared = shared.filter((n) => pa.out.has(n) && pb.out.has(n)), keep = new Set(compared);
  const leftOut = shared.length - compared.length;
  if (compared.length < FEWEST) why.push(`only ${compared.length} of the ${shared.length} names both placements have are defined exactly once on each side, fewer than the ${FEWEST} an order needs`);
  // Each side's compared functions in the placement's order: by the place of their input section
  // and their distance into it, those at one slot and offset together, each by name.
  const laid = (p) => {
    const at = new Map();
    for (const d of [...p.out.values()].filter((d) => keep.has(d.name))) { const k = `${d.slot}\0${d.off}`; at.set(k, { slot: d.slot, off: d.off, ns: [...(at.get(k)?.ns ?? []), d.name] }); }
    return [...at.values()].sort((x, y) => x.slot - y.slot || x.off - y.off).map((x) => x.ns.sort());
  };
  const la = laid(pa), lb = laid(pb), n = Math.max(la.length, lb.length);
  let first = -1;
  for (let k = 0; k < n && first < 0; k++) if (la[k]?.join("\n") !== lb[k]?.join("\n")) first = k;
  const shown = (x) => (x ? x.join(" and ") : "nothing");
  if (compared.length >= FEWEST && first >= 0) why.push(`the ${compared.length} names both placements define exactly once do not lie in one order: place ${first + 1} holds ${shown(la[first])} in the first and ${shown(lb[first])} in the second`);
  if (compared.length >= FEWEST && first < 0) {
    // Use the first compared name at each address as its representative on that side. Walk
    // names in the same order on both sides so only changes in address sharing change the match.
    const a = new Map(), b = new Map();
    for (const name of compared) {
      const x = pa.out.get(name).at, y = pb.out.get(name).at;
      if (!a.has(x)) a.set(x, name);
      if (!b.has(y)) b.set(y, name);
      if (a.get(x) !== b.get(y)) {
        const other = a.get(x) === name ? b.get(y) : a.get(x);
        why.push(`${name} and ${other} share an ELF address in only one placement`);
        break;
      }
    }
  }
  return { ok: why.length === 0, why, pad, shuffled: true, shared: shared.length, compared: compared.length, leftOut, onlyBase: pa.all.size - shared.length, onlyHead: pb.all.size - shared.length, places: la.length, same: first < 0 ? la.length : first };
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
  const orderFile = opt("--order"), mapFile = opt("--map"), placedFile = opt("--placed-map"), second = args.includes("--second"), both = args.includes("--alike");
  const rest = args.filter((x) => x !== "--second" && x !== "--alike"), [a, b, padArg] = both ? [rest[0], rest[5], rest[10]] : rest, pad = Number(padArg);
  const usage = "usage: node layout.mjs <unpadded binary> <placement> <pad bytes> [--second] [--order <file> --map <unpadded map> --placed-map <placement map>] | --alike <base unpadded> <base placement> <base order> <base map> <base placement map> <head unpadded> <head placement> <head order> <head map> <head placement map> <pad bytes> [--second]";
  const ordering = [orderFile, mapFile, placedFile].filter((x) => x !== undefined).length;
  if (!a || !b || !Number.isInteger(pad) || (ordering !== 0 && ordering !== 3) || (both && (ordering !== 0 || rest.length !== 11))) { console.error(usage); process.exit(2); }
  const nmText = (bin) => execFileSync("nm", ["--defined-only", bin], { encoding: "utf8", maxBuffer: 1 << 28 });
  const readelf = (bin) => execFileSync("readelf", ["-SW", bin], { encoding: "utf8" });
  const elf = (bin) => elfSymbols(execFileSync("readelf", ["-sW", bin], { encoding: "utf8", maxBuffer: 1 << 28 }));
  const shaFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  // A map's input sections of .text, the other output sections and their symbols, and the
  // SHA-256 of its bytes, gunzipped: what build.sh writes to maps/placements.sha256 before gzipping it.
  const mapOf = (file) => {
    const bytes = mapBytes(readFileSync(file)), outs = readMap(bytes.toString("utf8")), t = outs.find((o) => o.name === ".text");
    if (!t) { console.error(`layout.mjs: no .text output section in ${file}`); process.exit(2); }
    const other = outs.filter((o) => o !== t);
    const elsewhere = other.flatMap((o) => o.inputs.flatMap((s) => s.symbols.map((y) => ({ name: y.name, at: y.at, output: o.name }))));
    return { inputs: t.inputs, other, elsewhere, sha: createHash("sha256").update(bytes).digest("hex") };
  };
  if (both) {
    const side = ([unpadded, placement, order, map, placedMap]) => {
      const u = mapOf(map), m = mapOf(placedMap), bytes = readFileSync(order);
      return { ea: elf(unpadded), eb: elf(placement), text: textRange(readelf(unpadded)), placed: textRange(readelf(placement)), order: bytes.toString("utf8").replace(/\n$/, "").split("\n"), sections: u.inputs, placedSections: m.inputs, elsewhere: m.elsewhere, otherMaps: [u.other, m.other], orderSha: createHash("sha256").update(bytes).digest("hex"), unpaddedSha: u.sha, placedSha: m.sha, unpaddedBinary: shaFile(unpadded), placedBinary: shaFile(placement) };
    };
    let r, base, head;
    try { base = side(rest.slice(0, 5)); head = side(rest.slice(5, 10)); r = alike(base, head, pad, second); } catch (e) { console.error(`layout.mjs: ${e.message}`); process.exit(2); }
    console.log(`${r.compared} shared names compared, ${r.leftOut} left out as ambiguous (defined more than once, or read otherwise by the symbol table or the map, on a side); names one side alone has: ${r.onlyBase} in base, ${r.onlyHead} in head; places holding the compared names: ${r.places}, in one order: ${r.same}`);
    console.log("JSON " + JSON.stringify({ ...r, baseOrder: base.orderSha, headOrder: head.orderSha, baseMap: base.placedSha, headMap: head.placedSha, baseUnpaddedMap: base.unpaddedSha, headUnpaddedMap: head.unpaddedSha, baseUnpaddedBinary: base.unpaddedBinary, basePlacedBinary: base.placedBinary, headUnpaddedBinary: head.unpaddedBinary, headPlacedBinary: head.placedBinary }));
    for (const w of r.why) console.error(`layout.mjs: ${w}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (orderFile !== undefined) {
    const bytes = readFileSync(orderFile), unpaddedMap = mapOf(mapFile), placedMap = mapOf(placedFile);
    let ra;
    try { ra = ordered(elf(a), elf(b), textRange(readelf(a)), textRange(readelf(b)), bytes.toString("utf8").replace(/\n$/, "").split("\n"), unpaddedMap.inputs, placedMap.inputs, pad, second, placedMap.elsewhere, [unpaddedMap.other, placedMap.other]); } catch (e) { console.error(`layout.mjs: ${e.message}`); process.exit(2); }
    const { defs, ...r } = ra;
    console.log(`definitions of functions in the unpadded .text: ${r.functions}, in ${r.sections} input sections, ${r.groups} groups of one key, ${r.tied} sections in groups of more than one; names defined more than once there, checked by their sections: ${r.repeated}; names the ordering file lists after the pad: ${r.listed}; definitions where the ordering file puts them: ${r.matched} of ${r.functions}, in ${r.placedSections} of ${r.sections} input sections; functions in their unpadded section's pair, as far from its start: ${r.together}; sections after the pad and the one before: ${r.follow}; only in the placement: ${r.onlyB.join(", ")}`);
    console.log("JSON " + JSON.stringify({ ...r, order: createHash("sha256").update(bytes).digest("hex"), unpaddedMap: unpaddedMap.sha, placedMap: placedMap.sha, unpaddedBinary: shaFile(a), placedBinary: shaFile(b), onlyA: r.onlyA.length }));
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
