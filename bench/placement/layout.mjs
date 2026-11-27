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
// every function of the unpadded binary's .text, and nothing moved it by the pad alone. Both
// binaries' functions are then read from the ELF symbol table (readelf -sW's .symtab, type FUNC),
// not nm: a function is of .text when its symbol's section index (st_shndx) is .text's (inText()),
// the one rule order.mjs lists the file's names by too, so a function of no size at the very end
// of .text is of it and one at the same address in the next output section is not. Every such
// definition, in either binary, is of the input section of .text its own link's map gives it
// (map.mjs owner(): by its address, a section of no size and the end of a section included, and
// where two sections share the address, by the map's symbols there, which match the symbol
// table's names byte for byte only in a map LLD writes with --no-demangle, as build.sh asks for in
// a shuffled run; refused when the map gives it none or does not tell them apart), never of one
// expected or found by name. It passes when it
// holds exactly the unpadded binary's functions and the pad (both pads with --second), the pad at
// the start of .text, the file names the pad first and then every function of the unpadded .text
// once and nothing else, and the placement's map lays the unpadded map's input sections (map.mjs
// pair()) as LLD promises to lay them for that file: each at the place of the first of its
// definitions the file names (its key), sections of one key together in any order among
// themselves (LLD sorts by the key alone, not stably, so local copies of one name in several
// objects, each a section of its own, can come in another order) and sections the file places
// nowhere after them in theirs; every definition in the placement's section paired with its
// unpadded one, as far from its start, a name defined more than once included, each local copy by
// its own object's file symbol; the first section after the end
// of the whole pad, each after the end of the one before it, and the last inside .text and before
// the second pad. The shift and the neighbours are not asked. The JSON then carries the file's
// SHA-256 and the placement map's (of its text, gunzipped).
// With --alike, for a shuffled change: base's and head's placements at one index, each passing
// --order against its side's unpadded binary and maps, lay the functions both have in one order
// (their placement maps' section order, then each one's distance into its section), which their
// ordering files give them unless a symbol one side alone has gives a section both have another
// place, each place holding the same of them (alike()). The unit is a function definition. A name
// defined once on each side is one function of both; a name defined more than once in either
// (local copies) is matched copy by copy by what a rebuild of the same code keeps of its object
// (stable(): its file symbol's and its input section's object, less directories, link-capture's
// ordinal and Cargo's and rustc's hashes), then its section's name, and the same as written, never
// its section's size, which a change to the code changes; copies at one place that follow one file
// symbol of the placement's symbol table (one object) are ICF's folded copies, counted. Sections of
// one key are one place, in any order among themselves, and so are sections whose keys are one
// name less a ThinLTO suffix (order.mjs keys them alike and orders them by the suffix alone,
// whether a copy has one and its number, which a rebuild of the same code can change), but for two
// copies both sides write alike, which keep the order the draw gives them. A name nothing tells
// apart (copies in objects named alike that only their sizes would), copies with no one-to-one
// match between the sides, copies folded to one place that no object's file symbol tells apart
// (none, or one written alike for several objects), two copies written alike in both that lie the
// other way round, and places holding different definitions (ICF folding A with B in one and A
// with D in the other) refuse the change, so no definition both have is left out of the
// comparison or compared by where it landed instead of what it is.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapText, origin, owner, PAD, pair, readMap, SECOND_PAD } from "./map.mjs";

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

/** .text's section index, address and size in readelf -SW's output. */
export function textRange(readelf) {
  const m = /\[\s*(\d+)\]\s+\.text\s+\S+\s+([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)\s/.exec(readelf);
  if (!m) throw new Error("no .text in readelf's sections");
  return { index: Number(m[1]), start: parseInt(m[2], 16), size: parseInt(m[3], 16) };
}

/**
 * The defined function symbols (type FUNC, in a section) of readelf -sW's .symtab, as the ELF
 * symbol table has them: each name as written, the name less a ThinLTO suffix, its address, its
 * size and the index of the output section that holds it (st_shndx), which says which section a
 * symbol is of where an address alone does not: a function of no size at the very end of .text,
 * or one at the address where the next section begins. A local symbol also has the name of the
 * file symbol (STT_FILE) before it (file), which names the object it was compiled as: LLD writes
 * each object's local symbols together, after that object's file symbol, so a local copy of a
 * name keeps its own object even where ICF folded its body into another object's section. It
 * also has that file symbol's ordinal among the table's file symbols (object), which tells two
 * objects apart within one binary where their file symbols are written alike (four objects
 * compiled from files named util.c), and means nothing across two binaries. A global or weak
 * symbol, and a local one with no file symbol before it, has null for both. .dynsym is not read.
 * A binary without a .symtab (stripped) has none to read and is refused.
 */
export function elfSymbols(readelf) {
  const out = [];
  let table = null, symtab = false, file = null, object = null, files = 0;
  for (const l of readelf.split("\n")) {
    const h = /^Symbol table '([^']*)'/.exec(l);
    if (h) { table = h[1]; symtab ||= table === ".symtab"; file = null; object = null; continue; }
    if (table !== ".symtab") continue;
    const m = /^\s*\d+:\s+([0-9a-f]+)\s+(0x[0-9a-f]+|\d+)\s+(\S+)\s+(\S+)\s+\S+(?:\s+\[[^\]]*\])?\s+(\S+)\s+(\S.*?)\s*$/.exec(l.replace(/\r$/, ""));
    if (m?.[3] === "FILE") { file = m[6]; object = files++; continue; }
    if (!m || m[3] !== "FUNC" || !/^\d+$/.test(m[5])) continue;
    const local = m[4] === "LOCAL";
    out.push({ raw: m[6], name: m[6].replace(/\.llvm\.\d+$/, ""), at: parseInt(m[1], 16), size: Number(m[2]), shndx: Number(m[5]), file: local ? file : null, object: local ? object : null });
  }
  if (!symtab) throw new Error("no .symtab in readelf's symbols: a stripped binary has no function symbols to read");
  return out;
}

/** A file's name less directories and less the ordinal link-capture.mjs puts before a copied input (`014-`), which says where in one link's arguments it came. */
export const bare = (name) => name.replace(/^.*[\\/]/, "").replace(/^\d{3,}-/, "");

/**
 * A file's name as a rebuild of the same code names it again: bare(), with every hash written as
 * `#`, a run of exactly 16 hexadecimal digits or of 12 or more lowercase letters and digits with
 * at least one of each (Cargo's metadata hash, `-80a519a4f0b14295`, and rustc's codegen unit's,
 * `.2876a78816aebac3-cgu.0`), which a change to a dependency, a version or the set of inputs can change while the code is
 * the same. Two objects that differ only by such a hash (one crate at two versions) are one here.
 */
export function stable(name) {
  return bare(name).replace(/(?<![0-9a-z])(?:[0-9a-f]{16}|(?=[0-9a-z]*\d)(?=[0-9a-z]*[a-z])[0-9a-z]{12,})(?![0-9a-z])/g, "#");
}

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
  return [...new Set(ea.filter((e) => inText(e, text)).map((e) => e.raw))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const unique = (es) => { const seen = new Map(); for (const e of es) seen.set(e.name, seen.has(e.name) ? null : e.at); return seen; };
const some = (xs) => xs.slice(0, 3).join(", ");

/**
 * A shuffled placement against its side's unpadded binary and the ordering file it was linked
 * with, function definition by definition. ea, eb: elfSymbols() of the unpadded binary and of
 * the placement; text: the unpadded binary's textRange(); placed: the placement's textRange();
 * order: the ordering file's lines; sections, placedSections: the input sections of .text ({ at,
 * size, symbols, ... }) in the unpadded link's map and in the placement's, each in its map's
 * order. A definition is of .text by its symbol's section index alone (inText()), and of the
 * input section its own link's map gives it (owner(): its address, a section of no size and the
 * end of one included, told apart by the map's symbols there), in either binary; one of .text the
 * map gives no input section is refused, the end of .text included.
 * Where a definition lands is what LLD promises for the file and no more: an input section takes
 * the place of the first name the file lists among its definitions (its key), the sections the
 * file places are sorted by that key alone, with no order among sections of one key (llvm::sort,
 * not a stable sort: local copies of one function in several objects, each in a section of its
 * own, give every one of those sections that name's place), and the sections the file places
 * nowhere follow in their own order. So the unpadded sections are taken in groups, one a key
 * (each section the file places nowhere a group of its own), and the placement passes when it
 * holds, besides the pads, the unpadded map's input sections (map.mjs pair()) with each group's
 * sections together, in any order among themselves, and the groups in the order of their keys;
 * every placed definition in the section paired with its unpadded one, as far from its start; the
 * first section after the whole pad, each after the end of the one before it, and the last inside
 * .text, before any second pad.
 */
export function ordered(ea, eb, text, placed, order, sections, placedSections, pad, second = false) {
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
  // Each definition of .text, by its symbol's section index (inText()), and its input section by
  // its own link's map (owner(), whose names match the symbol table's when the map is written with
  // --no-demangle). Every one must have one: one the map gives none, or does not tell apart, is
  // refused, the very end of .text included; one of another output section is none of .text's,
  // whatever its address.
  const owned = (es, inputs, range, skip = () => false) => {
    const out = [], loose = [], between = [];
    for (const e of es) {
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
  // Each unpadded section's key, and the groups of one key, in the order LLD lays them.
  const units = A.map((s, k) => ({ s, k, fns: [], p: Infinity }));
  for (const d of oa.out) { units[d.k].fns.push(d); if (pos.has(d.e.raw)) units[d.k].p = Math.min(units[d.k].p, pos.get(d.e.raw)); }
  const groups = [];
  for (const u of [...units].sort((x, y) => x.p - y.p || x.k - y.k)) {
    const last = groups.at(-1);
    if (u.p !== Infinity && last?.p === u.p) last.members.push(u.k);
    else groups.push({ p: u.p, members: [u.k] });
  }
  const groupOf = [], expected = groups.flatMap((g, i) => g.members.map(() => i)), functions = oa.out.length;
  groups.forEach((g, i) => { for (const k of g.members) groupOf[k] = i; });
  const tied = groups.filter((g) => g.members.length > 1);
  // The draw's places, for alike(): groups whose keys are one name less a ThinLTO suffix are one.
  // order.mjs keys such names alike and orders them by the suffix alone (whether a copy has one,
  // and its number), which a rebuild of the same code can change, so the draw gives them no order
  // against each other.
  let draws = 0;
  groups.forEach((g, i) => {
    g.name = g.p === Infinity ? null : listed[g.p].replace(/\.llvm\.\d+$/, "");
    g.draw = i > 0 && g.name !== null && groups[i - 1].name === g.name ? groups[i - 1].draw : draws++;
  });
  // The placement's sections besides the pads, each paired with the unpadded section it is.
  const isPad = (s) => s.section === PAD || s.section === SECOND_PAD, B = placedSections, mids = [], mid = new Map();
  B.forEach((s, j) => { if (!isPad(s)) { mid.set(j, mids.length); mids.push(s); } });
  const id = (s) => s.id ?? `${s.file}:(${s.section})`, fn = (k) => (units[k].fns[0] ? ` (${units[k].fns[0].e.raw})` : "");
  let pairs = null;
  if (mids.length !== A.length) why.push(`.text has ${A.length} input sections unpadded and ${mids.length} besides the pads in the placement`);
  else {
    pairs = pair(A, mids);
    const off = pairs.findIndex((i) => i < 0);
    if (off >= 0) { why.push(`${pairs.filter((i) => i < 0).length} input sections of the placement's .text are none of the unpadded .text's of their name, size and alignment: ${id(mids[off])}`); pairs = null; }
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
    // in any order among themselves, the groups in the order of their keys. A definition is where
    // the file puts it when its unpadded section is.
    const away = new Set();
    pairs.forEach((i, j) => { if (groupOf[i] === expected[j]) placedSectionsAt++; else away.add(i); });
    matched = oa.out.filter((d) => !away.has(d.k)).length;
    const first = pairs.findIndex((i, j) => groupOf[i] !== expected[j]);
    if (first >= 0) {
      const g = groups[expected[first]], k = g.members[0];
      why.push(`definitions where the ordering file puts them: ${matched} of ${functions}, in ${placedSectionsAt} of ${A.length} input sections (sections of one key together, in any order among themselves); the first place that differs, ${first + 1}, holds ${id(mids[first])}${fn(pairs[first])}, where the file puts ${id(A[k])}${fn(k)}${g.members.length > 1 ? ` or another of the ${g.members.length} sections of its key` : ""}`);
    }
    // Every definition in the section paired with its unpadded one, as far from its start, a local
    // copy of a repeated name by its own object's file symbol too: the placement's section holds
    // the same definitions as the unpadded one, ICF's folded copies included.
    const tally = new Map(), key = (i, d) => `${i}\0${d.e.raw}\0${d.off}\0${d.e.file ?? ""}`;
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
  // Each placed definition with the input section the placement's map has it in, that section's
  // place there, the group of one key the file puts there, that group's place in the draw and the
  // name less a ThinLTO suffix its key has, and the definition's object by its file symbol (its
  // text and its ordinal in the placement's symbol table), for alike().
  const defs = pairs ? got.map((d) => { const g = expected[mid.get(d.k)]; return { raw: d.e.raw, name: d.e.name, at: d.e.at, file: d.e.file ?? null, object: d.e.object ?? null, section: B[d.k], slot: mid.get(d.k), group: g, draw: groups[g].draw, drawName: groups[g].name, off: d.off }; }) : null;
  return { ok: why.length === 0, why, pad, second, shuffled: true, functions, repeated, sections: A.length, groups: groups.length, tied: tied.reduce((t, g) => t + g.members.length, 0), matched, placedSections: placedSectionsAt, together, follow, listed: listed.length, onlyA, onlyB, defs };
}

/**
 * Two placements at one index of a shuffled run, base's and head's, linked with ordering files
 * drawn alike: every function definition both have lies at one place in both, in one order. Their
 * files list those names in one order, but a section takes the place of the first name it holds,
 * so a symbol one side alone has in a section the other has too can give that section, and the
 * functions in it, another place; and LLD lays sections of one key in no promised order, which
 * can differ between two links. Each side is { ea, eb, text, placed, order, sections,
 * placedSections }, the arguments ordered() takes for it, and each must pass ordered().
 * The unit is a definition: a name (less a ThinLTO suffix) and which of that name's definitions
 * it is. A name defined once on each side is one function of both. A name defined more than once
 * (local copies in several objects) is matched definition by definition by what a rebuild of the
 * same code keeps (stable()): first its object by its file symbol and its input section's object
 * in the placement's map, then with that section's name, then both as written (where two objects
 * differ only by a hash both sides keep), then its file symbol's object alone, its section's
 * object alone, and last its name alone; never by its section's size, which a change to the code
 * changes, so two copies whose objects are named alike and trade sizes are not told apart by it.
 * The first of those that tells each side's definitions apart (definitions that share one are at
 * one place and follow one file symbol of the placement's symbol table, one object: copies ICF
 * folded, with their count) and leaves no definition of either side without a match where the
 * other has one without a match too is taken. Copies at one place that follow two file symbols
 * written alike (objects compiled from files of one name) are of objects nothing names apart, so
 * no key that puts them together tells them apart. A name none tells apart, one whose
 * definitions have no one-to-one match, and copies both have folded to one place a different
 * number of times refuse the change, so no definition both have is left out. Then each
 * placement's places in the draw, in its map's order: a group of input sections its ordering file
 * gives one key (ordered()), or the groups whose keys are one name less a ThinLTO suffix, which
 * order.mjs keys alike and orders by the suffix alone (whether a copy has one, and its number,
 * which a rebuild of the same code can change, so the draw gives them no order against each
 * other), its sections in any order among
 * themselves, each section's definitions in their order there: alike when the two lists are the
 * same, so every definition both have lies in one order, where the files order it, and shares its
 * section and address with the same others (ICF folding A with B on one side and A with D on the
 * other is no reading). Sections one side ties in one place and the other orders in two are two
 * places in one and one in the other, and refuse. Within a place of keys that are one name less a
 * ThinLTO suffix, the draw orders the names as written, so two of its copies both sides write
 * alike (f.llvm.1 and f.llvm.2 in each) keep the order of the groups that hold them: a copy one
 * side alone has that gives one of those sections an earlier key (head's new f.llvm.0 in f.llvm.2's
 * section) lays them the other way round, and refuses. Copies whose suffixes differ between the
 * sides, as a rebuild of the same code can number them, give no such order.
 */
export function alike(base, head, pad, second = false) {
  const check = (x) => ordered(x.ea, x.eb, x.text, x.placed, x.order, x.sections, x.placedSections, pad, second);
  const ra = check(base), rb = check(head);
  if (!ra.ok || !rb.ok) throw new Error(`alike: ${!ra.ok ? "base's" : "head's"} placement does not pass its own shuffled check: ${(!ra.ok ? ra : rb).why.join("; ")}`);
  const marks = (d) => {
    const o = origin(d.section.file ?? "");
    return {
      sym: d.file ?? "", symS: d.file == null ? "" : stable(d.file), map: o.object != null ? bare(o.object) : `${bare(o.archive)}(${o.member})`,
      mapS: o.object != null ? stable(o.object) : `${stable(o.archive)}(${stable(o.member)})`, sect: d.section.section ?? "",
    };
  };
  const KEYS = [(m) => [m.symS, m.mapS], (m) => [m.symS, m.mapS, m.sect], (m) => [m.sym, m.map, m.sect], (m) => [m.symS], (m) => [m.mapS], () => []];
  const byName = (defs) => { const m = new Map(); for (const d of defs) m.set(d.name, [...(m.get(d.name) ?? []), { ...d, m: marks(d), place: `${d.slot}\0${d.off}` }]); return m; };
  const na = byName(ra.defs), nb = byName(rb.defs);
  // A name's definitions by one key: each key's definitions at one place, with their count, or null.
  // Definitions that share a key at one place are copies ICF folded there, counted, but only where
  // they follow one file symbol of the placement's table, one object: copies of other objects,
  // with file symbols written alike or not, or with none (a folded section's object is its kept
  // copy's, whatever object a symbol was compiled in), are not one copy, and which object each of
  // them is cannot be read where its file symbol does not name it apart.
  const told = (ds, K) => {
    const m = new Map();
    for (const d of ds) {
      const k = JSON.stringify(K(d.m)), t = m.get(k);
      if (!t) m.set(k, { d, n: 1 });
      else if (t.d.place !== d.place || !d.m.sym || d.m.sym !== t.d.m.sym || d.object == null || d.object !== t.d.object) return null;
      else t.n++;
    }
    return m;
  };
  const where = (d) => `${d.m.mapS}:(${d.m.sect})`, label = (name, d) => `${name} in ${where(d)}${d.m.symS && d.m.symS !== d.m.mapS ? ` (compiled in ${d.m.symS})` : ""}`;
  const items = [], untold = [], unmatched = [], why = [];
  for (const name of [...na.keys()].filter((n) => nb.has(n)).sort()) {
    const as = na.get(name), bs = nb.get(name), plain = as.length === 1 && bs.length === 1;
    let ta = null, tb = null, apart = null;
    for (const K of KEYS) {
      const x = told(as, K), y = told(bs, K);
      if (!x || !y) continue;
      apart ??= [x, y];
      if ([...x.keys()].some((k) => !y.has(k)) && [...y.keys()].some((k) => !x.has(k))) continue;
      [ta, tb] = [x, y];
      break;
    }
    if (!ta) {
      if (!apart) {
        const twice = (ds) => ds.find((d, k) => ds.some((e, j) => j !== k && e.place !== d.place && where(e) === where(d)));
        untold.push(`${name} in ${where(twice(as) ?? twice(bs) ?? as[0])}`);
      } else {
        // What the first key that tells each side's copies apart leaves without a match on each side.
        const lone = (x, y) => [...x].filter(([k]) => !y.has(k)).map(([, t]) => where(t.d)).join(", ");
        unmatched.push(`${name} (${lone(...apart)} in the first, ${lone(apart[1], apart[0])} in the second)`);
      }
      continue;
    }
    for (const [k, t] of ta) {
      const u = tb.get(k);
      if (!u) continue;
      if (t.n !== u.n) { unmatched.push(`${name} in ${where(t.d)}, folded to one place ${t.n} times in the first and ${u.n} in the second`); continue; }
      items.push({ id: plain ? name : `${name}\n${k}`, labels: { a: plain ? name : label(name, t.d), b: plain ? name : label(name, u.d) }, plain, n: t.n, a: t.d, b: u.d });
    }
  }
  if (untold.length) why.push(`${untold.length} functions both placements have are each defined more than once at places nothing tells apart (their objects, input sections and names, as written and less hashes; a section's size is no identity), or folded to one place with no file symbol to tell the copies apart (none, or the same name written for several objects), so their order cannot be established: ${some(untold)}`);
  if (unmatched.length) why.push(`${unmatched.length} functions both placements have are defined more than once, and their definitions cannot be matched one to one across the two, so their order cannot be established: ${some(unmatched)}`);
  // Within a place of keys that are one name less a ThinLTO suffix, the order of the groups that
  // hold two copies of that name both sides write alike: the draw orders the two names as written
  // on both sides, so their groups lie in one order, or one group holds both, alike on both.
  const sign = (x, y) => Math.sign(x.group - y.group), turned = [], byPlace = new Map();
  for (const it of items) if (it.a.raw === it.b.raw && it.a.drawName === it.a.name && it.b.drawName === it.b.name) byPlace.set(it.a.draw, [...(byPlace.get(it.a.draw) ?? []), it]);
  const rel = (s) => (s < 0 ? "before" : s > 0 ? "after" : "in one group with");
  for (const kept of byPlace.values()) for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) {
    const u = kept[i], v = kept[j];
    if (u.b.draw !== v.b.draw || sign(u.a, v.a) === sign(u.b, v.b)) continue;
    turned.push(`${u.a.raw} in ${where(u.a)} ${rel(sign(u.a, v.a))} ${v.a.raw} in ${where(v.a)} in the first, ${rel(sign(u.b, v.b))} it in the second`);
  }
  if (turned.length) why.push(`${turned.length} pairs of copies of one name less a ThinLTO suffix, written alike in both placements, which the draw orders alike, lie in another order: ${some(turned)}`);
  // Each placement's definitions both have, by where its ordering file puts them: its places in
  // the draw in its map's order (ordered(): a group of one key, or the groups of keys that are one
  // name less a ThinLTO suffix), each place's input sections in any order among themselves, as LLD
  // lays them and order.mjs draws them, and in each section the definitions in their order there,
  // those at one address together. Alike when the places hold the same sections, each holding the
  // same definitions in one order: so the order the drawn files give is compared, and which
  // definitions share a section or an address (ICF's folding), but not an order neither LLD nor the
  // draw promised.
  const places = (side) => {
    const groups = new Map();
    for (const it of items) {
      const d = it[side], g = groups.get(d.draw) ?? groups.set(d.draw, { draw: d.draw, slots: new Map(), labels: [] }).get(d.draw);
      const s = g.slots.get(d.slot) ?? g.slots.set(d.slot, new Map()).get(d.slot), at = s.get(d.off) ?? s.set(d.off, []).get(d.off);
      for (let i = 0; i < it.n; i++) { at.push(it.id); g.labels.push(it.labels[side]); }
    }
    const section = (s) => JSON.stringify([...s].sort((x, y) => x[0] - y[0]).map(([, ids]) => [...ids].sort()));
    return [...groups.values()].sort((x, y) => x.draw - y.draw).map((g) => ({ key: [...g.slots.values()].map(section).sort().join("\n"), show: [...g.labels].sort().join(" and "), size: g.slots.size }));
  };
  const pa = places("a"), pb = places("b"), n = Math.max(pa.length, pb.length);
  let first = -1;
  for (let k = 0; k < n && first < 0; k++) if (pa[k]?.key !== pb[k]?.key) first = k;
  const shown = (x) => (x ? `${x.show}${x.size > 1 ? ` (${x.size} sections of one place)` : ""}` : "nothing");
  if (first >= 0) why.push(`the ${items.length} functions both placements have do not lie in one order, each place holding the same of them: place ${first + 1} holds ${shown(pa[first])} in the first and ${shown(pb[first])} in the second`);
  return { ok: why.length === 0, why, pad, shuffled: true, shared: items.length, repeated: items.filter((x) => !x.plain).length, tied: items.filter((x) => x.n > 1).length, untold: untold.length, unmatched: unmatched.length, places: pa.length, same: first < 0 ? pa.length : first, turned: turned.length };
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
  const mapOf = (file) => { const text = mapText(readFileSync(file)), t = readMap(text).find((o) => o.name === ".text"); if (!t) { console.error(`layout.mjs: no .text output section in ${file}`); process.exit(2); } return { inputs: t.inputs, sha: createHash("sha256").update(text).digest("hex") }; };
  const lines = (file) => readFileSync(file).toString("utf8").replace(/\n$/, "").split("\n");
  if (both) {
    const side = ([unpadded, placement, order, map, placedMap]) => ({ ea: elf(unpadded), eb: elf(placement), text: textRange(readelf(unpadded)), placed: textRange(readelf(placement)), order: lines(order), sections: mapOf(map).inputs, placedSections: mapOf(placedMap).inputs });
    let r;
    try { r = alike(side(rest.slice(0, 5)), side(rest.slice(5, 10)), pad, second); } catch (e) { console.error(`layout.mjs: ${e.message}`); process.exit(2); }
    console.log(`function definitions both placements have: ${r.shared}, ${r.repeated} of them of a name defined more than once, matched by what a rebuild keeps of their objects and input sections, ${r.tied} of them copies folded to one place; places holding them: ${r.places}, in one order and each holding the same of them: ${r.same}; defined more than once at places nothing tells apart: ${r.untold}; defined more than once with no one-to-one match: ${r.unmatched}; pairs of copies of one name less a ThinLTO suffix, written alike in both, in another order: ${r.turned}`);
    console.log("JSON " + JSON.stringify(r));
    for (const w of r.why) console.error(`layout.mjs: ${w}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (orderFile !== undefined) {
    const bytes = readFileSync(orderFile), placedMap = mapOf(placedFile);
    let ra;
    try { ra = ordered(elf(a), elf(b), textRange(readelf(a)), textRange(readelf(b)), bytes.toString("utf8").replace(/\n$/, "").split("\n"), mapOf(mapFile).inputs, placedMap.inputs, pad, second); } catch (e) { console.error(`layout.mjs: ${e.message}`); process.exit(2); }
    const { defs, ...r } = ra;
    console.log(`definitions of functions in the unpadded .text: ${r.functions}, in ${r.sections} input sections, ${r.groups} groups of one key, ${r.tied} sections in groups of more than one; names defined more than once there, checked by their sections: ${r.repeated}; names the ordering file lists after the pad: ${r.listed}; definitions where the ordering file puts them: ${r.matched} of ${r.functions}, in ${r.placedSections} of ${r.sections} input sections; functions in their unpadded section's pair, as far from its start: ${r.together}; sections after the pad and the one before: ${r.follow}; only in the placement: ${r.onlyB.join(", ")}`);
    console.log("JSON " + JSON.stringify({ ...r, order: createHash("sha256").update(bytes).digest("hex"), placedMap: placedMap.sha, onlyA: r.onlyA.length }));
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
