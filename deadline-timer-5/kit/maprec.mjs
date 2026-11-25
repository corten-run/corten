// maprec.mjs <LLD map of a side's unpadded link> <side>: the record CONTRIBUTING (Pull requests,
// item 2, the plan's fifth point) asks of every placement run, written before anything is
// measured: each input section of .text aligned beyond 16 bytes, in order with its alignment, and
// every symbol the map lists in .text from the first of them on, by symbol, archive and archive
// member, or object file where it is in no archive, as the map names them, less directories.
// Prints one line a section ("section <n> of <total>: align <a>, size <bytes>, <file>:(<name>)"),
// one a symbol ("symbol <symbol> | <archive> | <member>" or "symbol <symbol> | <object>"), and
// last the line build.sh and report.mjs read:
//   ALIGNED <side>: <count> input sections of .text aligned beyond 16 bytes of <total>; widest alignment <a>; <symbols> symbols from the first on
// Exit 1 if the file is not an LLD map with a .text of input sections. build.sh stops on a count
// other than 0: this kit has no second pad and makes none of the fifth point's checks for a side
// with such a section. report.mjs makes the record again from the map kept with a run's results
// (record, below) and reads no run whose record is not that one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The record's lines for a map's text, or an Error's message in `error`. */
export function record(text, side) {
  const lines = text.split("\n");
  if (!/^\s*VMA\s+LMA\s+Size\s+Align\s+Out\s+In\s+Symbol\s*$/.test(lines[0] ?? "")) return { error: "not an LLD map (its first line is not the columns' names)" };
  let out = null, cur = null;
  const secs = [];
  for (const l of lines.slice(1)) {
    const m = /^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\d+) (.*)$/.exec(l);
    if (!m) { if (l.trim() !== "") return { error: `a line that is not a map's: ${l.slice(0, 80)}` }; continue; }
    const rest = m[5];
    if (/^ {16}\S/.test(rest)) { if (cur) cur.symbols.push(rest.trim()); }
    else if (/^ {8}\S/.test(rest)) { cur = null; if (out === ".text") { cur = { name: rest.trim(), size: parseInt(m[3], 16), align: Number(m[4]), symbols: [] }; secs.push(cur); } }
    else if (/^\S/.test(rest)) { out = rest.trim(); cur = null; }
    else return { error: `a line indented as no map's is: ${l.slice(0, 80)}` };
  }
  if (secs.length === 0) return { error: "no input section of .text" };
  const base = (p) => p.replace(/^.*\//, "");
  /** "<archive>(<member>):(<section>)" or "<object>:(<section>)", less directories. */
  const where = (name) => {
    const m = /^(.*):\(([^()]*)\)$/.exec(name);
    if (!m) return { files: [name], section: "" };
    const a = /^(.*)\(([^()]*)\)$/.exec(m[1]);
    return { files: a ? [base(a[1]), base(a[2])] : [base(m[1])], section: m[2] };
  };
  const first = secs.findIndex((s) => s.align > 16), rec = [];
  let symbols = 0;
  if (first >= 0) {
    secs.forEach((s, i) => { if (s.align > 16) { const w = where(s.name); rec.push(`section ${i + 1} of ${secs.length}: align ${s.align}, size ${s.size}, ${w.files.join("(")}${w.files.length > 1 ? ")" : ""}:(${w.section})`); } });
    for (const s of secs.slice(first)) for (const y of s.symbols) { symbols++; rec.push(`symbol ${y} | ${where(s.name).files.join(" | ")}`); }
  }
  const widest = Math.max(...secs.map((s) => s.align)), beyond = secs.filter((s) => s.align > 16).length;
  rec.push(`ALIGNED ${side}: ${beyond} input sections of .text aligned beyond 16 bytes of ${secs.length}; widest alignment ${widest}; ${symbols} symbols from the first on`);
  return { lines: rec, beyond, total: secs.length, widest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , file, side] = process.argv;
  if (!file || !side) { console.error("usage: node maprec.mjs <map> <side>"); process.exit(2); }
  const r = record(readFileSync(file, "utf8"), side);
  if (r.error) { console.error(`${file}: ${r.error}`); process.exit(1); }
  for (const l of r.lines) console.log(l);
}
