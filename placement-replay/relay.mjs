// relay.mjs: writes an unpadded link's map with its .text edited and laid out again by LLD's
// rule (the first input section where it was, each one after it at the first multiple of its own
// alignment at or after the end of the one before), so that replay.mjs --kinds can be run on
// layouts nobody has linked:
//   node relay.mjs <map> <output map> [edit ...]
//   --insert-after <section> <file> <name> <size> <align>   one more input section, named
//       .text.<name> and holding one function <name>, from <file> (an archive member as
//       "libx.rlib(y.o)" or a plain object as "y.o"), after the section named .text.<section>
//   --insert-first <file> <name> <size> <align>             the same, before every input section
//   --align <section> <align>                               that section's alignment
//   --align-all <from> <to>                                 every section aligned to <from> bytes
//   --size <section> <size>                                 that section's size
// With no edit it must write .text as the map has it, which is the check that the map follows
// the rule; the last line printed says how many lines of .text differ from the input's. The
// output sections after .text are written as they were: this models .text alone, which is all
// --kinds reads.
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const [mapA, out] = argv.splice(0, 2);
if (!mapA || !out) throw new Error("usage: node relay.mjs <map> <output map> [--insert-after <section> <file> <name> <size> <align>] [--insert-first <file> <name> <size> <align>] [--align <section> <align>] [--align-all <from> <to>] [--size <section> <size>] ...");
const RE = /^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\d+) (.*)$/;
const line = (at, size, align, rest) => `${at.toString(16).padStart(16)} ${at.toString(16).padStart(16)} ${size.toString(16).padStart(8)} ${String(align).padStart(5)} ${rest}`;
const up = (x, a) => Math.ceil(x / a) * a;
const ls = readFileSync(mapA, "utf8").split("\n");
const rows = ls.map((l) => { const m = RE.exec(l); return m ? { at: parseInt(m[1], 16), size: parseInt(m[3], 16), align: Number(m[4]), rest: m[5] } : null; });
const kind = (r) => (r === null ? "other" : !r.rest.startsWith(" ") ? "output" : /^ {8}\S/.test(r.rest) ? "input" : "symbol");
const iText = rows.findIndex((r) => r && r.rest === ".text");
let end = iText + 1;
while (end < rows.length && kind(rows[end]) !== "output") end++;

// .text as a list of input sections, each with the lines that follow it (its symbols).
const sections = [];
for (let i = iText + 1; i < end; i++) {
  const r = rows[i];
  if (kind(r) === "input") sections.push({ ...r, was: r.at, lines: [] });
  else if (sections.length) sections[sections.length - 1].lines.push(r ? { ...r } : { raw: ls[i] });
}
const named = (name) => { const i = sections.findIndex((s) => s.rest.endsWith(`:(.text.${name})`)); if (i < 0) throw new Error(`relay.mjs: no input section .text.${name}`); return i; };
const made = (file, name, size, align) => ({ at: 0, was: 0, size: Number(size), align: Number(align), rest: `        /m/written/${file}:(.text.${name})`, lines: [{ at: 0, size: Number(size), align: 1, rest: `                ${name}` }] });
const first = sections[0].at;
while (argv.length) {
  const op = argv.shift();
  if (op === "--insert-after") { const [sec, file, name, size, align] = argv.splice(0, 5); sections.splice(named(sec) + 1, 0, made(file, name, size, align)); }
  else if (op === "--insert-first") { const [file, name, size, align] = argv.splice(0, 4); sections.unshift(made(file, name, size, align)); }
  else if (op === "--align") { const [sec, align] = argv.splice(0, 2); sections[named(sec)].align = Number(align); }
  else if (op === "--align-all") { const [from, to] = argv.splice(0, 2); for (const s of sections) if (s.align === Number(from)) s.align = Number(to); }
  else if (op === "--size") { const [sec, size] = argv.splice(0, 2); sections[named(sec)].size = Number(size); }
  else throw new Error(`relay.mjs: ${op}?`);
}
const written = [];
let dot = first;
for (const s of sections) {
  dot = up(dot, s.align);
  written.push(line(dot, s.size, s.align, s.rest));
  for (const y of s.lines) written.push(y.raw !== undefined ? y.raw : line(y.at - s.was + dot, y.size, y.align, y.rest));
  dot += s.size;
}
const text = rows[iText];
writeFileSync(out, [...ls.slice(0, iText), line(text.at, dot - text.at, text.align, text.rest), ...written, ...ls.slice(end)].join("\n"));
const norm = (l) => { const m = RE.exec(l); return m ? `${parseInt(m[1], 16)} ${parseInt(m[3], 16)} ${m[4]} ${m[5]}` : l; };
const old = ls.slice(iText + 1, end);
let off = Math.abs(old.length - written.length);
for (let i = 0; i < Math.min(old.length, written.length); i++) if (norm(old[i]) !== norm(written[i])) off++;
console.log(`relay.mjs: ${sections.length} input sections of .text written, ${off} lines that differ from the input's`);
