// order.mjs: the ordering file a shuffled placement is linked with (README.md, workloads[].shuffle;
// docs/design.md#choice-placement-runs, "Inner layout"):
//   node order.mjs functions <unpadded binary>        the names, as the ELF symbol table writes
//                                                     them, of the binary's functions of .text
//                                                     (layout.mjs inText(): type FUNC, the
//                                                     symbol's section index .text's), each once
//                                                     and sorted, one a line (layout.mjs checks
//                                                     a placement by the same rule)
//   node order.mjs order <functions file> <seed> <i>  placement i's ordering file (i from 1 to
//                                                     K): the first pad's function, then those
//                                                     names in the order of their keys
// A name's key is HMAC-SHA-256, keyed by "<seed>:<i>", of the name less a ThinLTO suffix
// (".llvm.<n>", which layout.mjs strips too); names sort by key, then by the name as written. So
// base and head at one index, and the A/A's two sides there, lay every function they share in one
// order against every other, and only a change's own functions differ; each index draws another
// order. The seed is the workload's, which also draws the order its placements run in. The
// functions file may be gzipped, as the results keep it.
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { elfSymbols, PADS, textFunctions, textRange } from "./layout.mjs";
import { mapText } from "./map.mjs";

/** A name's key at placement i of a workload with this seed. */
export const key = (seed, i, name) => createHmac("sha256", `${seed}:${i}`).update(name.replace(/\.llvm\.\d+$/, "")).digest("hex");

/** Why a functions file's names cannot make an ordering file, or null. */
export function namesProblem(names) {
  if (!names.length) return "it names no function";
  if (names.some((n) => n === "" || /[\n\r]/.test(n))) return "it has an empty line";
  if (new Set(names).size !== names.length) return "it names a function twice";
  if (names.includes(PADS[0]) || names.includes(PADS[1])) return "it names a pad's function";
  return null;
}

/** Placement i's ordering file, as text: the first pad's function, then the names by key. */
export function order(names, seed, i) {
  if (!Number.isInteger(seed) || seed < 0 || !Number.isInteger(i) || i < 1) throw new Error(`order: no usable seed or index (${seed}, ${i})`);
  const odd = namesProblem(names);
  if (odd) throw new Error(`order: the functions file ${odd}`);
  const keyed = names.map((n) => ({ n, k: key(seed, i, n) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  return [PADS[0], ...keyed.map((x) => x.n)].join("\n") + "\n";
}

/** A functions file's names. */
export const names = (bytes) => mapText(bytes).replace(/\n$/, "").split("\n");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, file, seed, i] = process.argv.slice(2);
  try {
    if (mode === "functions" && file && seed === undefined) {
      const syms = elfSymbols(execFileSync("readelf", ["-sW", file], { encoding: "utf8", maxBuffer: 1 << 28 }));
      const list = textFunctions(syms, textRange(execFileSync("readelf", ["-SW", file], { encoding: "utf8" })));
      const odd = namesProblem(list);
      if (odd) throw new Error(`${file}: its .text ${odd}`);
      process.stdout.write(list.map((n) => `${n}\n`).join(""));
    } else if (mode === "order" && file && /^\d+$/.test(seed ?? "") && /^\d+$/.test(i ?? "")) process.stdout.write(order(names(readFileSync(file)), Number(seed), Number(i)));
    else { console.error("usage: node order.mjs functions <unpadded binary> | order <functions file> <seed> <i>"); process.exit(2); }
  } catch (e) { console.error(`order.mjs: ${e.message}`); process.exit(1); }
}
