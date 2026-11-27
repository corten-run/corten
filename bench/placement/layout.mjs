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
// every function of the unpadded binary's .text, and nothing moved it by the pad alone. Every
// definition, in either binary, is of the input section of .text its own link's map gives it
// (map.mjs owner(): by its address, a section of no size and the very end of a section, or of
// .text, included, and where two sections share the address, by the map's symbols there; refused
// when they do not tell them apart), never of one expected or found by name. It passes when it
// holds exactly the unpadded binary's functions and the pad (both pads with --second), the pad at
// the start of .text, the file names the pad first and then every function of the unpadded .text
// once and nothing else, and the placement's map lays the unpadded map's input sections (map.mjs
// pair()) as LLD lays them for that file: each at the place of the first of its definitions the
// file names, sections of one place in their unpadded order and sections the file places nowhere
// after them in theirs; every definition in the placement's section paired with its unpadded one,
// as far from its start, a name defined more than once included; the first section after the end
// of the whole pad, each after the end of the one before it, and the last inside .text and before
// the second pad. The shift and the neighbours are not asked. The JSON then carries the file's
// SHA-256 and the placement map's (of its text, gunzipped).
// With --alike, for a shuffled change: base's and head's placements at one index, each passing
// --order against its side's unpadded binary and maps, lay the functions both have in one order
// (their placement maps' section order, then each one's distance into its section), which their
// ordering files give them unless a symbol one side alone has gives a section both have another
// place. A name defined once in each one's .text is one function of both; a name defined more
// than once in either is each definition by the input section its placement's map has it in (its
// object, or archive and member, less directories, and its section's name), and one such that
// either side has more than once, which nothing tells apart, refuses the change.
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
 * sections, placedSections: the input sections of .text ({ at, size, symbols, ... }) in the
 * unpadded link's map and in the placement's, each in its map's order. Every definition is of the
 * input section its own link's map gives it (owner(): its address, a section of no size and the
 * end of one included, told apart by the map's symbols there), in either binary, the end of .text
 * included. LLD gives each input section the place of the first name the file lists among its
 * definitions, sections of one place in the order they had, and sections the file places after
 * them in their own order. So the placement's map holds, besides the pads, the unpadded map's
 * input sections (map.mjs pair()) in that order; each placed definition is in the section paired
 * with its unpadded one, as far from its start; the first section after the whole pad, each after
 * the end of the one before it, and the last inside .text, before any second pad.
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
  // Each definition's input section by its own link's map. One at the very end of .text is of it
  // only when the map gives it a section there; anywhere else in .text, one the map does not tell
  // apart is refused.
  const owned = (es, inputs, range, skip = () => false) => {
    const end = range.start + range.size, out = [], loose = [], between = [];
    for (const e of es) {
      if (skip(e) || e.at < range.start || e.at > end) continue;
      const k = owner(inputs, e.at, e.raw);
      if (k >= 0) out.push({ e, k, off: e.at - inputs[k].at });
      else if (e.at < end) (k === -2 ? between : loose).push(e.raw);
    }
    return { out, loose, between };
  };
  const A = sections, oa = owned(ea, A, text);
  if (oa.loose.length) why.push(`${oa.loose.length} functions of the unpadded .text in no input section of its map: ${some(oa.loose)}`);
  if (oa.between.length) why.push(`${oa.between.length} functions of the unpadded .text at an address its map's symbols there do not give to one input section: ${some(oa.between)}`);
  const units = A.map((s, k) => ({ s, k, fns: [], p: Infinity }));
  for (const d of oa.out) { units[d.k].fns.push(d); if (pos.has(d.e.raw)) units[d.k].p = Math.min(units[d.k].p, pos.get(d.e.raw)); }
  const laid = [...units].sort((x, y) => x.p - y.p || x.k - y.k), functions = oa.out.length;
  // The placement's sections besides the pads, each paired with the unpadded section it is.
  const isPad = (s) => s.section === PAD || s.section === SECOND_PAD, B = placedSections, mids = [], mid = new Map();
  B.forEach((s, j) => { if (!isPad(s)) { mid.set(j, mids.length); mids.push(s); } });
  const id = (s) => s.id ?? `${s.file}:(${s.section})`;
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
  let matched = 0, together = 0, follow = 0;
  if (pairs) {
    // The sections in the order the file gives them, by the placement's map.
    const expected = laid.map((u) => u.k);
    let first = -1;
    pairs.forEach((i, j) => { if (i === expected[j]) matched++; else if (first < 0) first = j; });
    if (first >= 0) why.push(`input sections in the ordering file's order: ${matched} of ${A.length} places in the placement's .text; the first that differs, place ${first + 1}, holds ${id(mids[first])}${units[pairs[first]].fns[0] ? ` (${units[pairs[first]].fns[0].e.raw})` : ""}, not ${id(A[expected[first]])}${units[expected[first]].fns[0] ? ` (${units[expected[first]].fns[0].e.raw})` : ""}`);
    // Every definition in the section paired with its unpadded one, as far from its start.
    const tally = new Map(), k = (i, d) => `${i}\0${d.e.raw}\0${d.off}`;
    for (const d of oa.out) tally.set(k(d.k, d), (tally.get(k(d.k, d)) ?? 0) + 1);
    for (const d of got) { const t = k(pairs[mid.get(d.k)], d), n = tally.get(t) ?? 0; if (n > 0) { together++; tally.set(t, n - 1); } }
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
  // Each placed definition with the input section the placement's map has it in, and that
  // section's place there, for alike().
  const defs = pairs ? got.map((d) => ({ raw: d.e.raw, name: d.e.name, at: d.e.at, section: B[d.k], slot: mid.get(d.k), off: d.off })) : null;
  return { ok: why.length === 0, why, pad, second, shuffled: true, functions, repeated, sections: A.length, matched, together, follow, listed: listed.length, onlyA, onlyB, defs };
}

/**
 * Two placements at one index of a shuffled run, base's and head's, linked with ordering files
 * drawn alike: the functions both have lie in one order in both. Their files list those names in
 * one order, but a section takes the place of the first name it holds, so a symbol one side alone
 * has in a section the other has too can give that section, and the functions in it, another
 * place. Each side is { ea, eb, text, placed, order, sections, placedSections }, the arguments
 * ordered() takes for it, and each must pass ordered(), which finds every placed definition's
 * input section in the placement's map. A name (less a ThinLTO suffix) defined once in each one's
 * .text is one function of both; a name defined more than once in either is each definition by
 * its input section (origin() of its file and the section's name), shared when both have that
 * definition once; one either has more than once is told apart by nothing, and the order of what
 * both have cannot be established. The order is the placement map's: its sections' order, then
 * each definition's distance from its section's start.
 */
export function alike(base, head, pad, second = false) {
  const check = (x) => ordered(x.ea, x.eb, x.text, x.placed, x.order, x.sections, x.placedSections, pad, second);
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
  const keyed = (defs) => { const m = new Map(); for (const d of defs) { const k = key(d); m.set(k, [...(m.get(k) ?? []), d]); } return m; };
  const a = keyed(ra.defs), b = keyed(rb.defs), both = [...a.keys()].filter((k) => b.has(k));
  const shared = both.filter((k) => a.get(k).length === 1 && b.get(k).length === 1), told = new Set(shared), untold = both.filter((k) => !told.has(k));
  const seq = (m) => [...shared].sort((x, y) => { const p = m.get(x)[0], q = m.get(y)[0]; return p.slot - q.slot || p.off - q.off || (x < y ? -1 : x > y ? 1 : 0); });
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
  const orderFile = opt("--order"), mapFile = opt("--map"), placedFile = opt("--placed-map"), second = args.includes("--second"), both = args.includes("--alike");
  const rest = args.filter((x) => x !== "--second" && x !== "--alike"), [a, b, padArg] = both ? [rest[0], rest[5], rest[10]] : rest, pad = Number(padArg);
  const usage = "usage: node layout.mjs <unpadded binary> <placement> <pad bytes> [--second] [--order <file> --map <unpadded map> --placed-map <placement map>] | --alike <base unpadded> <base placement> <base order> <base map> <base placement map> <head unpadded> <head placement> <head order> <head map> <head placement map> <pad bytes> [--second]";
  const ordering = [orderFile, mapFile, placedFile].filter((x) => x !== undefined).length;
  if (!a || !b || !Number.isInteger(pad) || (ordering !== 0 && ordering !== 3) || (both && (ordering !== 0 || rest.length !== 11))) { console.error(usage); process.exit(2); }
  const nmText = (bin) => execFileSync("nm", ["--defined-only", bin], { encoding: "utf8", maxBuffer: 1 << 28 });
  const readelf = (bin) => execFileSync("readelf", ["-SW", bin], { encoding: "utf8" });
  const mapOf = (file) => { const text = mapText(readFileSync(file)), t = readMap(text).find((o) => o.name === ".text"); if (!t) { console.error(`layout.mjs: no .text output section in ${file}`); process.exit(2); } return { inputs: t.inputs, sha: createHash("sha256").update(text).digest("hex") }; };
  const lines = (file) => readFileSync(file).toString("utf8").replace(/\n$/, "").split("\n");
  if (both) {
    const side = ([unpadded, placement, order, map, placedMap]) => ({ ea: entries(nmText(unpadded)), eb: entries(nmText(placement)), text: textRange(readelf(unpadded)), placed: textRange(readelf(placement)), order: lines(order), sections: mapOf(map).inputs, placedSections: mapOf(placedMap).inputs });
    let r;
    try { r = alike(side(rest.slice(0, 5)), side(rest.slice(5, 10)), pad, second); } catch (e) { console.error(`layout.mjs: ${e.message}`); process.exit(2); }
    console.log(`functions both placements have: ${r.shared}, ${r.repeated} of them of a name defined more than once, told apart by their input sections; in one order: ${r.same}; defined more than once in input sections of one file and name: ${r.untold}`);
    console.log("JSON " + JSON.stringify(r));
    for (const w of r.why) console.error(`layout.mjs: ${w}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (orderFile !== undefined) {
    const bytes = readFileSync(orderFile), placedMap = mapOf(placedFile);
    const { defs, ...r } = ordered(entries(nmText(a)), entries(nmText(b)), textRange(readelf(a)), textRange(readelf(b)), bytes.toString("utf8").replace(/\n$/, "").split("\n"), mapOf(mapFile).inputs, placedMap.inputs, pad, second);
    console.log(`definitions of functions in the unpadded .text: ${r.functions}, in ${r.sections} input sections; names defined more than once there, checked by their sections: ${r.repeated}; names the ordering file lists after the pad: ${r.listed}; input sections in its order in the placement's map: ${r.matched} of ${r.sections}; functions in their unpadded section's pair, as far from its start: ${r.together}; sections after the pad and the one before: ${r.follow}; only in the placement: ${r.onlyB.join(", ")}`);
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
