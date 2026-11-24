// mapsec.mjs <LLD map>: the input sections of .text by alignment, each one aligned beyond 16 bytes
// in order, and how many symbols the map lists in .text from the first of them on. Not the run's
// record: a look at whether a side has such code at all.
import { readFileSync } from "node:fs";
const lines = readFileSync(process.argv[2], "utf8").split("\n");
let out = null, cur = null;
const secs = [];
for (const l of lines) {
  const m = /^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\d+) (.*)$/.exec(l);
  if (!m) continue;
  const rest = m[5], size = parseInt(m[3], 16), align = Number(m[4]);
  if (/^ {16}\S/.test(rest)) { if (cur) cur.symbols.push(rest.trim()); }
  else if (/^ {8}\S/.test(rest)) { cur = null; if (out === ".text") { cur = { name: rest.trim(), size, align, symbols: [] }; secs.push(cur); } }
  else { out = rest.trim(); cur = null; }
}
const by = new Map();
for (const s of secs) by.set(s.align, (by.get(s.align) ?? 0) + 1);
console.log(`.text: ${secs.length} input sections; by alignment: ${[...by.entries()].sort((a, b) => b[0] - a[0]).map(([a, n]) => `${n} at ${a}`).join(", ")}`);
const first = secs.findIndex((s) => s.align > 16);
if (first < 0) { console.log("no input section of .text is aligned beyond 16 bytes"); process.exit(0); }
const short = (n) => n.replace(/^.*\/([^/]+:\()/, "$1").replace(/^.*\/([^/(]+\()/, "$1");
const rust = /\.(_R[A-Za-z0-9_.$]+|_ZN[A-Za-z0-9_.$]*17h[0-9a-f]{16}E(\.llvm\.\d+)?)\)$/;
let symbols = 0, rustAfter = 0;
for (let i = first; i < secs.length; i++) { symbols += secs[i].symbols.length; if (rust.test(secs[i].name)) rustAfter++; }
console.log(`the first aligned beyond 16 is section ${first + 1} of ${secs.length}; from it on: ${secs.length - first} sections, ${symbols} symbols, ${rustAfter} sections named for a Rust-mangled symbol`);
for (const s of secs.filter((s) => s.align > 16)) console.log(`  align ${s.align} size ${s.size} ${short(s.name)} ${s.symbols.slice(0, 3).join(", ")}`);
