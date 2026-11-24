// totals.mjs: adds up replay-all.sh's summary.txt, one line of replay.mjs's JSON a placement.
//   node totals.mjs <summary.txt>
import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => { const i = l.indexOf(" "); return { name: l.slice(0, i), ...JSON.parse(l.slice(i + 1)) }; });
for (const side of ["base", "head"]) {
  const r = rows.filter((x) => x.name.startsWith(side + "-"));
  const sum = (f) => r.reduce((a, x) => a + f(x), 0);
  const ok = r.every((x) => x.ok && x.padFirst && x.same && x.tightA && x.tightB && x.replayed && x.symbolsSame);
  console.log(`${side}: ${r.length} placements, every check passed: ${ok}`);
  console.log(`  .text: ${r[0].inputs} input sections, by alignment ${JSON.stringify(r[0].alignments)}; the first aligned beyond 16 bytes: ${r[0].firstBeyond ?? "none"}`);
  console.log(`  before it: ${r[0].before} sections holding ${r[0].symbolsBefore} symbols (${r[0].ownSymbolsBefore} of the crates named); moved by exactly the pad: ${sum((x) => x.beforeExact)} of ${sum((x) => x.before)} sections and ${sum((x) => x.symbolsBeforeExact)} of ${sum((x) => x.symbolsBefore)} symbols`);
  const t = {};
  for (const x of r) for (const [d, n] of Object.entries(x.fromShiftsLessPad)) t[d] = (t[d] ?? 0) + n;
  console.log(`  from it on: ${r[0].from} sections holding ${r[0].symbolsFrom} symbols, ${r[0].ownSectionsFrom} of the sections of the crates named; their ${sum((x) => x.from)} shifts less the pad: ${JSON.stringify(t)}`);
  const s = {};
  for (const x of r) { const k = Object.keys(x.sectionsAfter).join(","); s[k] = (s[k] ?? 0) + 1; }
  console.log(`  the output sections after .text, shift less the pad, by number of placements: ${JSON.stringify(s)}`);
  const pl = {};
  for (const x of r) for (const [n, [a, b]] of Object.entries(x.placeInLine)) { pl[n] = pl[n] ?? { a, b: new Set() }; pl[n].b.add(b); }
  console.log(`  where each begins in a 64-byte line, unpadded and then in the placements: ${Object.entries(pl).map(([n, v]) => `${n} ${v.a}, then ${[...v.b].sort((p, q) => p - q).join(" ")}`).join("; ")}`);
}
