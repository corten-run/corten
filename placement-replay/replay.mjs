// replay.mjs: checks a padded placement against its side's unpadded link by the linker's own
// rule, from the two links' maps (LLD's -Map):
//   node replay.mjs <map of the unpadded link A> <map of the padded link B> <pad bytes> [<pad section name>]
// LLD lays the input sections of an output section in order, each at the first multiple of its
// own alignment at or after the end of the one before it. The checks, on .text:
//   1. B's input sections are the pad's and then A's, in A's order, each with A's size and
//      alignment;
//   2. in A and in B every input section begins at the first multiple of its alignment at or
//      after the end of the one before it (the first at .text's start);
//   3. so B's addresses are those A's sizes and alignments give with the pad first (replayed
//      from A alone and compared);
//   4. every input section before the first one aligned beyond STEP (16) bytes moved by exactly
//      the pad, and every one from it on by a multiple of its alignment from the pad rounded
//      down to the pad rounded up to the largest alignment at or before it.
// Prints what it found and, last, a line of JSON; exits 1 when a check fails.
import { readFileSync } from "node:fs";

const [, , mapA, mapB, padArg, padName = ".text.corten_layout_pad"] = process.argv;
const pad = Number(padArg), STEP = 16;
if (!mapA || !mapB || !Number.isInteger(pad)) throw new Error("usage: node replay.mjs <map A> <map B> <pad bytes>");
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
const A = read(mapA), B = read(mapB);
const tA = A.find((s) => s.name === ".text"), tB = B.find((s) => s.name === ".text");
const up = (x, a) => Math.ceil(x / a) * a, down = (x, a) => Math.floor(x / a) * a;
const why = [];

// 1. The same input sections after the pad, in order, with the same sizes and alignments.
const first = tB.inputs[0];
const padFirst = first.id.endsWith(`:(${padName})`) && first.size === pad && first.at === tB.at;
if (!padFirst) why.push(`the first input section of .text is ${first.id}, ${first.size} bytes at 0x${first.at.toString(16)}`);
const rest = tB.inputs.slice(1);
let same = rest.length === tA.inputs.length;
if (same) for (let i = 0; i < rest.length; i++) { const a = tA.inputs[i], b = rest[i]; if (a.id !== b.id || a.size !== b.size || a.align !== b.align) { same = false; why.push(`input section ${i} differs: ${a.id} (${a.size}, ${a.align}) against ${b.id} (${b.size}, ${b.align})`); break; } }
else why.push(`.text has ${tA.inputs.length} input sections unpadded and ${rest.length} besides the pad in the placement`);

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

// 4. Shifts.
const shifts = same ? rest.map((b, i) => b.at - tA.inputs[i].at) : [];
const firstBig = tA.inputs.findIndex((s) => s.align > STEP);
const before = firstBig < 0 ? tA.inputs.length : firstBig;
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
const aligns = new Map();
for (const s of tA.inputs) aligns.set(s.align, (aligns.get(s.align) ?? 0) + 1);
const fnBefore = tA.inputs.slice(0, before).reduce((n, s) => n + s.symbols.length, 0), fnAfter = tA.inputs.slice(before).reduce((n, s) => n + s.symbols.length, 0);

// The other output sections.
const others = new Map();
for (const s of A) { const b = B.find((x) => x.name === s.name); if (b && s.name !== ".text" && b.at !== s.at) others.set(b.at - s.at - pad, [...(others.get(b.at - s.at - pad) ?? []), s.name]); }

const j = { pad, inputs: tA.inputs.length, alignments: Object.fromEntries([...aligns].sort((x, y) => x[0] - y[0])), padFirst, same, tightA: !ta.bad, tightB: !tb.bad, replayed: same && !replayBad, before, beforeExact, symbolsBefore: fnBefore, symbolsFrom: fnAfter, firstBeyond: firstBig < 0 ? null : tA.inputs[firstBig].id.replace(/^.*\//, ""), from: shifts.length - before, fromShiftsLessPad: Object.fromEntries([...tail].sort((x, y) => x[0] - y[0])), largest, textGrew: tB.size - tA.size, sectionsAfter: Object.fromEntries([...others].map(([d, n]) => [d, n.length])), ok: why.length === 0 };
console.log(`.text: ${tA.inputs.length} input sections unpadded (by alignment ${JSON.stringify(j.alignments)}), ${tB.inputs.length} in the placement; the pad first: ${padFirst}; the rest the same sections in order with the same sizes and alignments: ${same}`);
console.log(`each at the first multiple of its alignment after the one before: unpadded ${!ta.bad}, placement ${!tb.bad}; the placement is the unpadded layout replayed with the pad: ${j.replayed}`);
console.log(`before the first input section aligned beyond ${STEP} bytes (${j.firstBeyond ?? "none"}): ${before} sections holding ${fnBefore} symbols, ${beforeExact} moved by exactly the pad; from it on: ${j.from} sections holding ${fnAfter} symbols, shift less the pad ${JSON.stringify(j.fromShiftsLessPad)}`);
console.log(`.text grew by ${j.textGrew}; other output sections that moved, by shift less the pad: ${JSON.stringify(Object.fromEntries(others))}`);
for (const w of why) console.error(`replay.mjs: ${w}`);
console.log("JSON " + JSON.stringify(j));
process.exit(why.length ? 1 : 0);
