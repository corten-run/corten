// map.mjs: what the placement plan's fifth point reads from LLD's maps (-Wl,-Map), gzipped or not
// (CONTRIBUTING.md, Pull requests, item 2; docs/design.md#choice-placement-runs, "Code aligned beyond 16
// bytes"):
//   node map.mjs record <unpadded map>          a side's record, as JSON: each input section of
//                                               .text aligned beyond 16 bytes, in order, and every
//                                               symbol of .text from the first of them on
//   node map.mjs refuse <unpadded map>          exit 1 with the reason when the side has no
//                                               reading across placements: a section aligned
//                                               beyond 64 bytes, or a .text.* section named for a
//                                               Rust-mangled symbol at or after the first section
//                                               aligned beyond 16 bytes or in another output
//                                               section
//   node map.mjs data <unpadded map> <placement map> <first pad bytes>
//                                               where the placement's .data begins and whether
//                                               that is where the rule says (exit 1 when not)
//   node map.mjs check <unpadded map> <placement map> <first pad bytes> <second pad bytes> [--shuffled]
//                                               the placement against the unpadded link by LLD's
//                                               layout rule; exit 1 with each reason it fails.
//                                               --shuffled, for a placement linked with a
//                                               shuffled ordering file (order.mjs): its input
//                                               sections between the pads are the unpadded
//                                               link's in any order, which layout.mjs --order
//                                               checks from the same placement map
// A map line is VMA, LMA, size and alignment, then an output section at no indent, an input
// section (`file:(name)`) at 8 spaces or a symbol at 16. LLD lays the input sections of an output
// section in order, each at the first multiple of its own alignment at or after the end of the
// one before it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

/** Beyond this alignment a pad does not move a section by its own size. */
export const STEP = 16;
/** Beyond this alignment a side has no reading. */
export const LIMIT = 64;
export const LINE = 64;
/** The second pad's sizes. */
export const SIZES = [16, 32, 48, 64];
export const PAD = ".text.corten_layout_pad";
export const SECOND_PAD = ".text.corten_layout_pad2";
/** The fifth point's pattern for a section named for a Rust-mangled symbol, as CONTRIBUTING.md prints it. */
export const RUST_NAME = /\.(_R[A-Za-z0-9_.$]+|_ZN[A-Za-z0-9_.$]*17h[0-9a-f]{16}E(\.llvm\.\d+)?)$/;

/** A map file's bytes, gunzipped when it is gzipped. */
export const mapBytes = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
export const mapText = (bytes) => mapBytes(bytes).toString("utf8");

/** The output sections of a map, each with its input sections, each with its symbols. */
export function readMap(text) {
  const out = [];
  let cur = null, sec = null;
  for (const raw of text.split("\n")) {
    const m = /^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\d+) (.*)$/.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    const row = { at: parseInt(m[1], 16), size: parseInt(m[3], 16), align: Number(m[4]) }, rest = m[5];
    if (!rest.startsWith(" ")) { cur = { name: rest, ...row, inputs: [] }; out.push(cur); sec = null; }
    else if (/^ {8}\S/.test(rest) && cur) {
      const id = rest.trim(), k = id.lastIndexOf(":(");
      sec = { id, file: k < 0 ? id : id.slice(0, k), section: k < 0 ? "" : id.slice(k + 2, -1), ...row, symbols: [] };
      cur.inputs.push(sec);
    } else if (/^ {16}\S/.test(rest) && sec) sec.symbols.push({ name: rest.trim(), at: row.at });
  }
  return out;
}

const text = (map) => {
  const t = map.find((o) => o.name === ".text");
  if (!t) throw new Error("no .text output section in the map");
  return t;
};
const base = (path) => path.replace(/^.*[\\/]/, "");
/** Where the map says an input section came from, less directories: an archive and its member, or an object file. */
export function origin(file) {
  const m = /^(.*)\(([^()]*)\)$/.exec(file);
  return m ? { archive: base(m[1]), member: base(m[2]) } : { object: base(file) };
}

/**
 * What a run records of a side from its unpadded link's map: each input section of .text aligned
 * beyond 16 bytes, in order with its alignment, and every symbol the map lists in .text from the
 * first of them on, by symbol and by archive and member, or object file.
 */
export function record(map) {
  const inputs = text(map).inputs, first = inputs.findIndex((s) => s.align > STEP);
  const alignments = {};
  for (const s of inputs) alignments[s.align] = (alignments[s.align] ?? 0) + 1;
  return {
    inputs: inputs.length,
    alignments,
    aligned: inputs.filter((s) => s.align > STEP).map((s) => ({ section: s.section, ...origin(s.file), align: s.align })),
    sectionsBefore: first < 0 ? inputs.length : first,
    list: first < 0 ? [] : inputs.slice(first).flatMap((s) => s.symbols.map((y) => ({ symbol: y.name, ...origin(s.file) }))),
  };
}

const rustNamed = (s) => s.section.startsWith(".text.") && RUST_NAME.test(s.section);

/** Why a side has no reading across placements, from its unpadded link's map; [] when it has one. */
export function refusals(map) {
  const t = text(map), why = [];
  const beyond = t.inputs.filter((s) => s.align > LIMIT);
  if (beyond.length) why.push(`${beyond.length} input sections of .text are aligned beyond ${LIMIT} bytes: ${beyond.slice(0, 3).map((s) => `${s.section} (${s.align})`).join(", ")}`);
  const first = t.inputs.findIndex((s) => s.align > STEP);
  if (first >= 0) for (const s of t.inputs.slice(first).filter(rustNamed)) why.push(`${s.section} [${base(s.file)}] is named for a Rust-mangled symbol and lies at or after the first section aligned beyond ${STEP} bytes`);
  for (const o of map) if (o !== t) for (const s of o.inputs.filter(rustNamed)) why.push(`${s.section} [${base(s.file)}] is named for a Rust-mangled symbol and lies in ${o.name}`);
  return why;
}

/**
 * Which of an output section's input sections (the map's, in its order) holds a definition at
 * address x named name. A section holds the addresses inside it and, where the map lists a symbol
 * there, its end (a symbol of no size that ends it, or one in a section of no size). Where two
 * hold x, the one whose symbols there include name; else, the one alone with any symbol there.
 * One that holds x at its end alone is its section only by name. -1 when none holds it; -2 when
 * the map's symbols there do not give it to one (a mangled name the map writes demangled, say).
 */
export function owner(inputs, x, name) {
  const at = (k) => (inputs[k].symbols ?? []).filter((y) => y.at === x), inside = (k) => inputs[k].at <= x && x < inputs[k].at + inputs[k].size;
  const c = [];
  inputs.forEach((s, k) => { if (inside(k) || (x === s.at + s.size && at(k).length)) c.push(k); });
  if (!c.length) return -1;
  const named = c.filter((k) => at(k).some((y) => y.name === name));
  if (named.length) return named.length === 1 ? named[0] : -2;
  if (!c.some(inside)) return -2;
  if (c.length === 1) return c[0];
  const marked = c.filter((k) => at(k).length);
  return marked.length === 1 ? marked[0] : -2;
}

/**
 * A shuffled placement's input sections between its pads (rest), each paired with an unpadded
 * link's (a): first one of its id, size, alignment and symbols, each as far from its start, then
 * one left over of its id, size and alignment; -1 where none is. Two sections a map names alike
 * (one file's, of one section name) are told apart by their symbols, whatever order the ordering
 * file laid them in; two alike in all of that are interchangeable.
 */
export function pair(a, rest) {
  const sig = (s) => JSON.stringify([s.id, s.size, s.align, s.symbols.map((y) => [y.name, y.at - s.at])]), k3 = (s) => `${s.id}\0${s.size}\0${s.align}`;
  const free = new Map(), used = new Set(), pairs = rest.map(() => -1);
  a.forEach((s, i) => free.set(sig(s), [...(free.get(sig(s)) ?? []), i]));
  rest.forEach((b, j) => { const i = free.get(sig(b))?.shift(); if (i !== undefined) { pairs[j] = i; used.add(i); } });
  const left = new Map();
  a.forEach((s, i) => { if (!used.has(i)) left.set(k3(s), [...(left.get(k3(s)) ?? []), i]); });
  rest.forEach((b, j) => { if (pairs[j] < 0) pairs[j] = left.get(k3(b))?.shift() ?? -1; });
  return pairs;
}

const up = (x, a) => Math.ceil(x / a) * a;
const mod = (x) => ((x % LINE) + LINE) % LINE;

/** Where a placement's .data begins, where the rule puts it in a 64-byte line and whether it is there. */
export function data(unpadded, placed, pad) {
  const a = unpadded.find((o) => o.name === ".data"), b = placed.find((o) => o.name === ".data");
  if (!a || !b) return { at: null, offset: null, want: null, fits: false };
  return { at: b.at, offset: mod(b.at), want: mod(a.at + pad), fits: mod(b.at) === mod(a.at + pad) };
}

/**
 * A placement's map against its side's unpadded link's, in place of "every function moved by
 * exactly the pad's size": .text begins where it did and holds the first pad's section, of the
 * plan's size, then the unpadded link's input sections in its order, each with its size and
 * alignment, then the second pad's section, of the size given, one of the four; in both links
 * every input section begins at the first multiple of its alignment at or after the end of the
 * one before it; every symbol of .text is in the same input section in both links, as far from
 * its start; and .data is where the rule says.
 * shuffled: the input sections between the pads are the unpadded link's, each of its size and
 * alignment, in the order the placement's ordering file gave them (layout.mjs --order checks
 * that order, from this same placement map), each section's symbols compared with those of an unpadded section of its name,
 * size and alignment that has them, as far from its start (two sections the map names alike are
 * told apart so; two alike in that too are interchangeable here); the counts of what moved by
 * exactly the pad are not taken.
 */
export function check(unpadded, placed, pad, second, shuffled = false) {
  const A = text(unpadded), B = text(placed), why = [];
  if (A.at !== B.at) why.push(`.text begins at 0x${B.at.toString(16)}, not 0x${A.at.toString(16)} as in the unpadded link`);
  const first = B.inputs[0], last = B.inputs.length > 1 ? B.inputs[B.inputs.length - 1] : null;
  if (!first || first.section !== PAD || first.size !== pad || first.at !== B.at) why.push(`the first input section of .text is ${first?.id}, ${first?.size} bytes at 0x${first?.at.toString(16)}, not the first pad of ${pad} bytes at its start`);
  if (!SIZES.includes(second)) why.push(`a second pad of ${second} bytes is not one of ${SIZES.join(", ")}`);
  if (!last || last.section !== SECOND_PAD || last.size !== second || last.align !== STEP) why.push(`the last input section of .text is ${last?.id}, ${last?.size} bytes aligned to ${last?.align}, not the second pad of ${second} bytes aligned to ${STEP}`);
  const rest = B.inputs.slice(1, -1);
  let same = rest.length === A.inputs.length;
  if (!same) why.push(`.text has ${A.inputs.length} input sections unpadded and ${rest.length} between the pads in the placement`);
  else if (shuffled) {
    const tally = new Map(), k = (s) => `${s.id}\0${s.size}\0${s.align}`;
    for (const s of A.inputs) tally.set(k(s), (tally.get(k(s)) ?? 0) + 1);
    for (const s of rest) tally.set(k(s), (tally.get(k(s)) ?? 0) - 1);
    // The counts match, so an unpadded section with no match between the pads is one of them with another size or alignment, or another section in its place.
    const off = [...tally].filter(([, n]) => n > 0), count = off.reduce((t, [, n]) => t + n, 0), [first] = off.map(([x]) => x.split("\0"));
    if (count) { same = false; why.push(`${count} input sections of the unpadded .text are not between the pads with one size and alignment: ${first[0]} (${first[1]} bytes, aligned to ${first[2]})`); }
  } else for (let i = 0; i < rest.length; i++) {
    const a = A.inputs[i], b = rest[i];
    if (a.id !== b.id || a.size !== b.size || a.align !== b.align) { same = false; why.push(`input section ${i} differs: ${a.id} (${a.size} bytes, aligned to ${a.align}) against ${b.id} (${b.size}, ${b.align})`); break; }
  }
  const loose = (t) => { let dot = t.at, bad = 0; for (const s of t.inputs) { dot = up(dot, s.align); if (s.at !== dot) { bad++; dot = s.at; } dot += s.size; } return bad; };
  const looseA = loose(A), looseB = loose(B);
  if (looseA) why.push(`${looseA} input sections of the unpadded .text do not begin at the first multiple of their alignment at or after the end of the one before`);
  if (looseB) why.push(`${looseB} input sections of the placement's .text do not begin at the first multiple of their alignment at or after the end of the one before`);
  let symbols = 0, off = 0, exact = 0, sectionsExact = 0;
  const before = A.inputs.findIndex((s) => s.align > STEP), firstAligned = before < 0 ? A.inputs.length : before;
  // Each placement section with the unpadded link's of its place, or, shuffled, with one of the
  // unpadded link's of its name, size, alignment and symbols, each as far from its start: two
  // sections a map names alike (one file's, of one section name) are told apart by their symbols,
  // whatever order the file laid them in. Sections that match in all of that are interchangeable
  // to this check. A placement section no unpadded one matches so is compared, symbol by symbol,
  // with an unpadded one left over of its name, size and alignment, and fails.
  const pairs = same && shuffled ? pair(A.inputs, rest) : rest.map((b, j) => j);
  if (same) for (let j = 0; j < rest.length; j++) {
    const i = pairs[j], a = A.inputs[i], b = rest[j];
    symbols += a.symbols.length;
    if (!shuffled && i < firstAligned && b.at - a.at === pad) sectionsExact++;
    if (a.symbols.length !== b.symbols.length) { off += Math.max(a.symbols.length, b.symbols.length); continue; }
    for (let k = 0; k < a.symbols.length; k++) {
      const x = a.symbols[k], y = b.symbols[k];
      if (x.name !== y.name || x.at - a.at !== y.at - b.at) off++;
      else if (!shuffled && i < firstAligned && y.at - x.at === pad) exact++;
    }
  }
  if (off) why.push(`${off} symbols of .text are not in the input section the unpadded link has them in, as far from its start`);
  const d = data(unpadded, placed, pad);
  if (!d.fits) why.push(`.data begins ${d.offset} bytes into a ${LINE}-byte line, not ${d.want}, the unpadded link's offset plus the first pad's size`);
  return {
    ok: why.length === 0, why, pad, second, inputs: A.inputs.length, symbols, sectionsBeforeAligned: firstAligned, sectionsBeforeAlignedMovedByPad: sectionsExact,
    symbolsBeforeAlignedMovedByPad: exact, dataAt: d.at, dataOffset: d.offset, ...(shuffled ? { shuffled: true } : {}),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), shuffled = args[0] === "check" && args.at(-1) === "--shuffled";
  const [mode, a, b, padArg, secondArg] = shuffled ? args.slice(0, -1) : args;
  const load = (file) => readMap(mapText(readFileSync(file)));
  const fail = (lines) => { for (const l of lines) console.error(`map.mjs: ${l}`); process.exit(1); };
  if (mode === "record" && a) console.log(JSON.stringify(record(load(a))));
  else if (mode === "refuse" && a) {
    const why = refusals(load(a));
    if (why.length) fail(why);
    console.log("no refusal: no section aligned beyond 64 bytes, and none named for a Rust-mangled symbol at or after the first aligned beyond 16 or outside .text");
  } else if (mode === "data" && b && Number.isInteger(Number(padArg))) {
    const d = data(load(a), load(b), Number(padArg));
    console.log(`.data 0x${d.at?.toString(16)} offset ${d.offset} want ${d.want} ${d.fits ? "fits" : "elsewhere"}`);
    process.exit(d.fits ? 0 : 1);
  } else if (mode === "check" && b && Number.isInteger(Number(padArg)) && Number.isInteger(Number(secondArg))) {
    const bytes = mapBytes(readFileSync(b));
    const r = check(load(a), readMap(bytes.toString("utf8")), Number(padArg), Number(secondArg), shuffled);
    console.log(shuffled
      ? `.text: ${r.inputs} input sections and ${r.symbols} symbols of the unpadded link, in any order (layout.mjs --order checks it against the ordering file), between a first pad of ${r.pad} bytes and a second of ${r.second}; .data at 0x${r.dataAt?.toString(16)}, ${r.dataOffset} bytes into a line`
      : `.text: ${r.inputs} input sections and ${r.symbols} symbols of the unpadded link between a first pad of ${r.pad} bytes and a second of ${r.second}; ${r.sectionsBeforeAlignedMovedByPad} of the ${r.sectionsBeforeAligned} sections before the first aligned beyond ${STEP} bytes moved by exactly the pad, with ${r.symbolsBeforeAlignedMovedByPad} symbols; .data at 0x${r.dataAt?.toString(16)}, ${r.dataOffset} bytes into a line`);
    console.log("JSON " + JSON.stringify(shuffled ? { ...r, placedMap: createHash("sha256").update(bytes).digest("hex") } : r));
    if (!r.ok) fail(r.why);
  } else {
    console.error("usage: node map.mjs record|refuse <unpadded map> | data <unpadded map> <placement map> <pad> | check <unpadded map> <placement map> <pad> <second pad> [--shuffled]");
    process.exit(2);
  }
}
