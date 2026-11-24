// replay.mjs: checks a padded placement against its side's unpadded link by LLD's own rule,
// from the two links' maps (LLD's -Map), or prints what an unpadded link holds:
//   node replay.mjs <map of the unpadded link A> <map of the padded link B> <pad bytes> [--own <crate>,<crate>...]
//        [--last-pad <bytes> [--data-further <bytes>]] [--pad-section <name>] [--last-pad-section <name>]
//   node replay.mjs --facts <map of the unpadded link A> [--own <crate>,<crate>...]
// LLD lays the input sections of an output section in order, each at the first multiple of its
// own alignment at or after the end of the one before it. The checks, on .text:
//   1. B's input sections are the pad's and then A's, in A's order, each with A's size and
//      alignment, and .text begins where it did; with --last-pad, one more section follows them,
//      the second pad's, of that many bytes, and nothing else;
//   2. in A and in B every input section begins at the first multiple of its alignment at or
//      after the end of the one before it (the first at .text's start);
//   3. so B's addresses are those A's sizes and alignments give with the pad first (replayed
//      from A alone and compared);
//   4. every input section before the first one aligned beyond STEP (16) bytes moved by exactly
//      the pad, and every one from it on by a multiple of its alignment from the pad rounded
//      down to the pad rounded up to the largest alignment at or before it;
//   5. every symbol the map lists in .text is in B what it is in A: the same names in the same
//      order in each input section, each as far from its section's start, so every function
//      before the first section aligned beyond STEP bytes moved by exactly the pad;
//   6. no input section is aligned beyond LIMIT (64) bytes, and with --own, no section from the
//      first one aligned beyond STEP bytes on holds a function of one of those crates, and no
//      other output section that holds code (.init, .fini, the .plt sections, one named .text.*
//      or one that holds an input section named .text*) holds one;
//   7. with --data-further, .data begins that many bytes further into a 64-byte line in B than
//      in A (0 for a second pad that leaves the data's place as the unpadded link has it).
// A function is one of a crate's by its symbol alone: its section's mangled name holds the
// crate's name as an identifier (its length before it), or a symbol's printed name holds it as a
// path. The input file is not asked: under thin LTO it names a code unit of the program.
// --facts prints, as one line of JSON, what a plan states of a side and a run records again from
// the build it measures (file names without their directories and without cargo's hashes, so two
// builds of one commit by one toolchain print the same line): the count of .text's input
// sections by alignment, each section aligned beyond STEP bytes, the first of them, the number of
// sections and of symbols before it, and the functions from it on by input file.
// Prints what it found and, last, a line of JSON; exits 1 when a check fails.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const own = (opt("--own") ?? "").split(",").filter(Boolean);
const padName = opt("--pad-section") ?? ".text.corten_layout_pad";
const lastName = opt("--last-pad-section") ?? ".text.corten_layout_pad2";
const lastArg = opt("--last-pad"), furtherArg = opt("--data-further");
const lastPad = lastArg === undefined ? null : Number(lastArg), further = furtherArg === undefined ? null : Number(furtherArg);
const factsOnly = argv[0] === "--facts";
if (factsOnly) argv.shift();
const [mapA, mapB, padArg] = argv;
const pad = Number(padArg), STEP = 16, LIMIT = 64, LINE = 64;
if (!mapA || (!factsOnly && (!mapB || !Number.isInteger(pad))) || (lastPad !== null && !Number.isInteger(lastPad)) || (further !== null && (lastPad === null || !Number.isInteger(further))))
  throw new Error("usage: node replay.mjs <map A> <map B> <pad bytes> [--own a,b] [--last-pad <bytes> [--data-further <bytes>]] | node replay.mjs --facts <map A> [--own a,b]");

const read = (file) => {
  const out = [];
  let cur = null, sec = null;
  for (const l of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\d+) (.*)$/.exec(l);
    if (!m) continue;
    const row = { at: parseInt(m[1], 16), size: parseInt(m[3], 16), align: Number(m[4]) };
    const rest = m[5];
    if (!rest.startsWith(" ")) { cur = { name: rest, ...row, inputs: [] }; out.push(cur); sec = null; }
    else if (/^ {8}\S/.test(rest)) { sec = { id: rest.trim(), ...row, symbols: [] }; cur.inputs.push(sec); }
    else if (/^ {16}\S/.test(rest) && sec) sec.symbols.push({ name: rest.trim(), at: row.at });
  }
  return out;
};
const up = (x, a) => Math.ceil(x / a) * a, down = (x, a) => Math.floor(x / a) * a;
// An input section's name without its directory and without the hashes cargo gives a crate's
// files, and the file it came from.
const split = (id) => {
  const k = id.lastIndexOf(":("), file = id.slice(0, k), p = file.indexOf("(");
  const name = (p < 0 ? file : file.slice(0, p)).replace(/^.*\//, "") + (p < 0 ? "" : file.slice(p));
  return { file: name.replace(/^\d{3}-/, "").replace(/[-.]?[0-9a-f]{16}/g, "").replace("(-", "(").replace(/\.[0-9a-z]{20,}(?=\.rcgu)/, ""), section: id.slice(k + 2, -1) };
};
const short = (id) => { const s = split(id); return `${s.file}:(${s.section})`; };
const fileOf = (id) => split(id).file;
const ownedBy = (s) => own.find((c) => split(s.id).section.includes(`${c.length}${c}`) || s.symbols.some((y) => new RegExp(`(^|[^A-Za-z0-9_])${c}::`).test(y.name)));

const A = read(mapA);
const tA = A.find((s) => s.name === ".text");
const firstBig = tA.inputs.findIndex((s) => s.align > STEP);
const before = firstBig < 0 ? tA.inputs.length : firstBig;
const aligns = new Map();
for (const s of tA.inputs) aligns.set(s.align, (aligns.get(s.align) ?? 0) + 1);
const big = tA.inputs.filter((s) => s.align > STEP);
const fromOn = tA.inputs.slice(before);
const byFile = new Map();
for (const s of fromOn) { const f = fileOf(s.id); byFile.set(f, [...(byFile.get(f) ?? []), ...s.symbols.map((y) => y.name)]); }
const ownFrom = fromOn.filter(ownedBy).map((s) => short(s.id));
const ownBefore = own.length ? tA.inputs.slice(0, before).filter(ownedBy).reduce((n, s) => n + s.symbols.length, 0) : null;
// Output sections other than .text that hold code, and the named crates' functions in them.
const holdsCode = (o) => o !== tA && (/^\.(init|fini|plt|iplt)(\.|$)/.test(o.name) || o.name.startsWith(".text.") || o.inputs.some((s) => split(s.id).section.startsWith(".text")));
const ownElsewhere = A.filter(holdsCode).flatMap((o) => o.inputs.filter(ownedBy).map((s) => `${o.name}: ${short(s.id)}`));
const largestOfAll = Math.max(...tA.inputs.map((s) => s.align));
const facts = {
  inputs: tA.inputs.length,
  alignments: Object.fromEntries([...aligns].sort((x, y) => x[0] - y[0])),
  beyond: big.map((s) => ({ section: short(s.id), size: s.size, align: s.align })),
  filesBeyond: [...new Set(big.map((s) => fileOf(s.id)))],
  first: firstBig < 0 ? null : short(tA.inputs[firstBig].id),
  sectionsBefore: before,
  symbolsBefore: tA.inputs.slice(0, before).reduce((n, s) => n + s.symbols.length, 0),
  ownCrates: own,
  ownSymbolsBefore: ownBefore,
  ownSectionsFrom: ownFrom,
  ownSectionsOutsideText: ownElsewhere,
  from: Object.fromEntries(byFile),
  largest: largestOfAll,
};
const noReading = [];
if (largestOfAll > LIMIT) noReading.push(`an input section of .text is aligned to ${largestOfAll} bytes, beyond ${LIMIT}`);
if (ownFrom.length) noReading.push(`${ownFrom.length} input sections from the first one aligned beyond ${STEP} bytes on hold a function of ${own.join(" or ")}: ${ownFrom.slice(0, 3).join(", ")}`);
if (ownElsewhere.length) noReading.push(`${ownElsewhere.length} input sections outside .text hold a function of ${own.join(" or ")}: ${ownElsewhere.slice(0, 3).join(", ")}`);
if (factsOnly) {
  for (const w of noReading) console.error(`replay.mjs: ${w}`);
  console.log(JSON.stringify(facts));
  process.exit(noReading.length ? 1 : 0);
}

const B = read(mapB);
const tB = B.find((s) => s.name === ".text");
const why = [...noReading];

// 1. The same input sections after the pad, in order, with the same sizes and alignments, and
// the second pad after them when one is declared.
const first = tB.inputs[0];
const padFirst = first.id.endsWith(`:(${padName})`) && first.size === pad && first.at === tB.at;
if (!padFirst) why.push(`the first input section of .text is ${first.id}, ${first.size} bytes at 0x${first.at.toString(16)}`);
const last = lastPad === null ? null : tB.inputs[tB.inputs.length - 1];
const padLast = last === null ? null : last.id.endsWith(`:(${lastName})`) && last.size === lastPad && tB.inputs.length > 1;
if (padLast === false) why.push(`the last input section of .text is ${last.id}, ${last.size} bytes, not a second pad of ${lastPad}`);
const rest = tB.inputs.slice(1, last === null ? undefined : -1);
let same = rest.length === tA.inputs.length;
if (same) for (let i = 0; i < rest.length; i++) { const a = tA.inputs[i], b = rest[i]; if (a.id !== b.id || a.size !== b.size || a.align !== b.align) { same = false; why.push(`input section ${i} differs: ${a.id} (${a.size}, ${a.align}) against ${b.id} (${b.size}, ${b.align})`); break; } }
else why.push(`.text has ${tA.inputs.length} input sections unpadded and ${rest.length} besides the pad${last === null ? "" : "s"} in the placement`);

// 2. Each begins where the one before it and its own alignment put it.
const tight = (t) => { let dot = t.at, bad = 0; for (const s of t.inputs) { dot = up(dot, s.align); if (s.at !== dot) { bad++; dot = s.at; } dot += s.size; } return { bad, end: dot }; };
const ta = tight(tA), tb = tight(tB);
if (ta.bad) why.push(`${ta.bad} input sections of the unpadded .text are not at the first multiple of their alignment after the one before`);
if (tb.bad) why.push(`${tb.bad} input sections of the placement's .text are not at the first multiple of their alignment after the one before`);
if (ta.end !== tA.at + tA.size || tb.end !== tB.at + tB.size) why.push(".text does not end where its last input section ends");

// 3. Replayed from A alone.
let dot = up(tA.at, first.align) + pad, replayBad = 0;
const predicted = [];
for (const s of tA.inputs) { dot = up(dot, s.align); predicted.push(dot); dot += s.size; }
if (same) for (let i = 0; i < rest.length; i++) if (rest[i].at !== predicted[i]) replayBad++;
if (replayBad) why.push(`${replayBad} input sections are not where the unpadded layout replayed with the pad puts them`);
if (tA.at !== tB.at) why.push(".text begins elsewhere in the placement");

// 4. Shifts of the sections.
const shifts = same ? rest.map((b, i) => b.at - tA.inputs[i].at) : [];
const beforeExact = shifts.slice(0, before).filter((d) => d === pad).length;
if (beforeExact !== before) why.push(`${before - beforeExact} input sections before the first aligned beyond ${STEP} bytes moved by other than the pad`);
let largest = STEP, outside = 0, notMultiple = 0;
const tail = new Map();
for (let i = before; i < shifts.length; i++) {
  const s = tA.inputs[i];
  largest = Math.max(largest, s.align);
  if (shifts[i] % s.align) notMultiple++;
  if (shifts[i] < down(pad, largest) || shifts[i] > up(pad, largest)) outside++;
  tail.set(shifts[i] - pad, (tail.get(shifts[i] - pad) ?? 0) + 1);
}
if (notMultiple) why.push(`${notMultiple} input sections moved by other than a multiple of their alignment`);
if (outside) why.push(`${outside} input sections moved by less than the pad rounded down, or more than the pad rounded up, to the largest alignment before them`);

// 5. The symbols: the same in each section, each as far from its section's start.
let symbolsA = 0, symbolsOff = 0, symbolsBeforeExact = 0, symbolsBefore = 0;
if (same) for (let i = 0; i < rest.length; i++) {
  const a = tA.inputs[i], b = rest[i];
  symbolsA += a.symbols.length;
  if (i < before) symbolsBefore += a.symbols.length;
  if (a.symbols.length !== b.symbols.length) { symbolsOff += Math.max(a.symbols.length, b.symbols.length); continue; }
  for (let k = 0; k < a.symbols.length; k++) {
    const x = a.symbols[k], y = b.symbols[k];
    if (x.name !== y.name || x.at - a.at !== y.at - b.at) symbolsOff++;
    else if (i < before && y.at - x.at === pad) symbolsBeforeExact++;
  }
}
if (symbolsOff) why.push(`${symbolsOff} symbols of .text are not the unpadded link's, in its order, as far from their section's start`);
if (same && symbolsBeforeExact !== symbolsBefore) why.push(`${symbolsBefore - symbolsBeforeExact} symbols before the first section aligned beyond ${STEP} bytes moved by other than the pad`);

// The output sections after .text: how far each moved, and where in a 64-byte line it begins.
const others = new Map(), places = {};
const iText = A.findIndex((s) => s.name === ".text");
for (const s of A.slice(iText + 1)) {
  const b = B.find((x) => x.name === s.name);
  if (!b || !s.at) continue;
  if (b.at !== s.at) others.set(b.at - s.at - pad, [...(others.get(b.at - s.at - pad) ?? []), s.name]);
  places[s.name] = [s.at % LINE, b.at % LINE];
}

// 7. Where the second pad put the data.
const dA = A.find((s) => s.name === ".data"), dB = B.find((s) => s.name === ".data");
const dataFurther = dA && dB ? (((dB.at - dA.at) % LINE) + LINE) % LINE : null;
if (further !== null && dataFurther !== further) why.push(`.data begins ${dataFurther} bytes further into a ${LINE}-byte line than in the unpadded link, not ${further}`);

const beforeLast = last === null || tB.inputs.length < 2 ? null : tB.inputs[tB.inputs.length - 2];
const j = { pad, lastPad, lastPadOk: padLast, lastPadGap: beforeLast === null ? null : last.at - (beforeLast.at + beforeLast.size), dataFurther, inputs: tA.inputs.length, alignments: facts.alignments, padFirst, same, tightA: !ta.bad, tightB: !tb.bad, replayed: same && !replayBad, before, beforeExact, symbolsBefore: facts.symbolsBefore, symbolsBeforeExact, symbolsFrom: symbolsA - symbolsBefore, symbolsSame: same && !symbolsOff, ownSymbolsBefore: ownBefore, ownSectionsFrom: ownFrom.length, ownSectionsOutsideText: ownElsewhere.length, firstBeyond: facts.first, from: shifts.length - before, fromShiftsLessPad: Object.fromEntries([...tail].sort((x, y) => x[0] - y[0])), largest: largestOfAll, textGrew: tB.size - tA.size, sectionsAfter: Object.fromEntries([...others].map(([d, n]) => [d, n.length])), placeInLine: places, ok: why.length === 0 };
console.log(`.text: ${tA.inputs.length} input sections unpadded (by alignment ${JSON.stringify(j.alignments)}), ${tB.inputs.length} in the placement; the pad first: ${padFirst}; the rest the same sections in order with the same sizes and alignments: ${same}`);
if (last !== null) console.log(`the second pad last in .text, ${lastPad} bytes: ${padLast}, beginning ${j.lastPadGap} bytes after the end of the section before it; .data ${dataFurther} bytes further into a ${LINE}-byte line than in the unpadded link`);
console.log(`each at the first multiple of its alignment after the one before: unpadded ${!ta.bad}, placement ${!tb.bad}; the placement is the unpadded layout replayed with the pad: ${j.replayed}`);
console.log(`before the first input section aligned beyond ${STEP} bytes (${j.firstBeyond ?? "none"}): ${before} sections, ${beforeExact} moved by exactly the pad, holding ${symbolsBefore} symbols, ${symbolsBeforeExact} moved by exactly the pad${own.length ? ` (${ownBefore} of them of ${own.join(", ")})` : ""}; from it on: ${j.from} sections holding ${j.symbolsFrom} symbols${own.length ? `, ${ownFrom.length} of the sections of ${own.join(", ")}` : ""}, shift less the pad ${JSON.stringify(j.fromShiftsLessPad)}`);
console.log(`every symbol of .text the unpadded link's, in its order and as far from its section's start: ${j.symbolsSame}`);
console.log(`.text grew by ${j.textGrew}; output sections after it that moved, by shift less the pad: ${JSON.stringify(Object.fromEntries(others))}`);
console.log(`where each output section after .text begins in a 64-byte line, unpadded and in the placement: ${JSON.stringify(places)}`);
for (const w of why) console.error(`replay.mjs: ${w}`);
console.log("JSON " + JSON.stringify(j));
process.exit(why.length ? 1 : 0);
