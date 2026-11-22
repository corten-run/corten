// How far one build's code sits from another's: node layout.mjs <binary A> <binary B>.
// Reads both binaries' .text sections (readelf) and defined function symbols (nm), and prints
// the .text sizes, then for the function symbols named once in each: how many sit at the same
// address and how many moved, by how much (the most common moves), and the same for Corten's
// own (mangled names holding "6corten") and those of the probe's crate ("5probe", the bin's name). Same names in both builds
// (the same crates, features and profile) are the same functions; a ThinLTO suffix (".llvm.<n>",
// which depends on the module's contents) is ignored.
import { execFileSync } from "node:child_process";

const [, , a, b] = process.argv;
if (!a || !b) throw new Error("usage: node layout.mjs <binary A> <binary B>");
const text = (bin) => {
  const line = execFileSync("readelf", ["-SW", bin], { encoding: "utf8" }).split("\n").find((l) => /\s\.text\s/.test(l));
  const f = line.replace(/^.*\]\s*/, "").trim().split(/\s+/);
  return { address: parseInt(f[2], 16), size: parseInt(f[4], 16) };
};
const symbols = (bin) => {
  const seen = new Map();
  for (const l of execFileSync("nm", ["--defined-only", bin], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n")) {
    const m = /^([0-9a-f]+) [tTwW] (.+)$/.exec(l);
    if (!m) continue;
    const name = m[2].replace(/\.llvm\.\d+$/, "");
    seen.set(name, seen.has(name) ? null : parseInt(m[1], 16));
  }
  return seen;
};
const ta = text(a), tb = text(b);
console.log(`.text: A ${ta.size} bytes at 0x${ta.address.toString(16)}; B ${tb.size} bytes at 0x${tb.address.toString(16)} (B - A ${tb.size - ta.size} bytes)`);
const sa = symbols(a), sb = symbols(b);
const groups = { all: () => true, corten: (n) => n.includes("6corten"), probe: (n) => n.includes("5probe") };
for (const [group, keep] of Object.entries(groups)) {
  const moves = new Map();
  let both = 0, same = 0;
  for (const [name, at] of sa) {
    const bt = sb.get(name);
    if (at == null || bt == null || !keep(name)) continue;
    both++;
    const d = bt - at;
    if (d === 0) same++;
    else moves.set(d, (moves.get(d) ?? 0) + 1);
  }
  const top = [...moves].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([d, n]) => `${d > 0 ? "+" : ""}${d} B (${d % 64 === 0 ? "a multiple of 64" : "mod 64 = " + (((d % 64) + 64) % 64)}): ${n}`);
  console.log(`${group} functions in both: ${both}; at the same address: ${same}; moved: ${both - same}${top.length ? "; most common moves: " + top.join(", ") : ""}`);
}
console.log(`only in A: ${[...sa.keys()].filter((n) => !sb.has(n)).length}; only in B: ${[...sb.keys()].filter((n) => !sa.has(n)).length} (${[...sb.keys()].filter((n) => !sa.has(n) && /layout_pad/.test(n)).length} named layout_pad)`);