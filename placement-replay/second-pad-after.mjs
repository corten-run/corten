// second-pad-after.mjs <results/second-pad directory>: from the 90 kept placements' check output, how far
// the output sections after .text moved, less the first pad, by side.
import { readFileSync, readdirSync } from "node:fs";
const dir = process.argv[2];
const by = {};
for (const f of readdirSync(dir).sort()) {
  const m = /^second-pad-(base|head)-p(\d+)\.txt$/.exec(f);
  if (!m) continue;
  const text = readFileSync(`${dir}/${f}`, "utf8");
  const line = text.split("\n").find((l) => l.startsWith(".text grew by"));
  const others = JSON.parse(line.slice(line.indexOf("{")));
  const j = JSON.parse(text.split("\n").find((l) => l.startsWith("JSON ")).slice(5));
  const where = {};
  for (const [d, names] of Object.entries(others)) for (const n of names) where[n] = Number(d);
  const side = (by[m[1]] ??= { n: 0, data: {}, initLess: {}, finiLess: {}, asData: 0, notAsData: new Set(), bySize: {} });
  side.n++;
  const d = where[".data"] ?? 0;
  const key = `${Number(m[2]) % 64}:${d}`;
  side.data[key] = (side.data[key] ?? 0) + 1;
  side.initLess[d - (where[".init"] ?? 0)] = (side.initLess[d - (where[".init"] ?? 0)] ?? 0) + 1;
  side.finiLess[d - (where[".fini"] ?? 0)] = (side.finiLess[d - (where[".fini"] ?? 0)] ?? 0) + 1;
  const names = Object.keys(j.placeInLine).filter((n) => n !== ".init" && n !== ".fini");
  const off = names.filter((n) => (where[n] ?? 0) !== d);
  if (off.length) off.forEach((n) => side.notAsData.add(n)); else side.asData++;
  side.bySize[j.lastPad] = (side.bySize[j.lastPad] ?? 0) + 1;
  side.names = names;
}
for (const [s, v] of Object.entries(by)) {
  console.log(`${s}: ${v.n} placements; second pad sizes ${JSON.stringify(v.bySize)}`);
  console.log(`${s}: .data moved by the first pad plus (first pad mod 64: bytes -> placements) ${JSON.stringify(v.data)}`);
  console.log(`${s}: .init moved less than .data by (bytes -> placements) ${JSON.stringify(v.initLess)}; .fini ${JSON.stringify(v.finiLess)}`);
  console.log(`${s}: every other output section after .text (${v.names.join(", ")}) moved as .data did in ${v.asData} placements${v.notAsData.size ? `; not: ${[...v.notAsData].join(", ")}` : ""}`);
}
