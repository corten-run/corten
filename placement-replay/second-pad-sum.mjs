// second-pad-sum.mjs <second-pad.txt>: what second-pad.sh found, added up. For each side: the
// placements by first pad mod 64 and the second pad kept for each, and, over every size tried,
// how far the second pad moved .data beyond what the first pad alone does on that side (the
// first pad's size mod 64 on a side with no section aligned beyond 16 bytes, nothing on a side
// whose largest alignment is 64), less the second pad's own size, mod 64: one value a side
// means a second pad of a multiple of 16 moves the data by itself plus a constant.
import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[2], "utf8").split("\n").map((l) => /^(base|head) first pad (\d+) \(mod 64: (\d+)\): second pad (\d+); each size tried and how far it put \.data:((?: \d+:\d+)+);.*beginning (\d+) bytes after/.exec(l)).filter(Boolean)
  .map((m) => ({ side: m[1], pad: Number(m[2]), want: Number(m[3]), kept: Number(m[4]), tried: m[5].trim().split(" ").map((t) => t.split(":").map(Number)), gap: Number(m[6]) }));
const firstMoves = { base: (p) => p % 64, head: () => 0 };
for (const side of ["base", "head"]) {
  const r = rows.filter((x) => x.side === side);
  const byWant = {}, constants = new Map(), gaps = new Set();
  for (const x of r) {
    (byWant[x.want] ??= { placements: 0, kept: new Set() }).placements++;
    byWant[x.want].kept.add(x.kept);
    gaps.add(x.gap);
    for (const [n, got] of x.tried) { const c = (((got - firstMoves[side](x.pad) - n) % 64) + 64) % 64; constants.set(c, (constants.get(c) ?? 0) + 1); }
  }
  console.log(`${side}: ${r.length} placements; by first pad mod 64: ${Object.entries(byWant).map(([w, v]) => `${w}: ${v.placements} placements, second pad ${[...v.kept].join(" or ")}`).join("; ")}`);
  console.log(`${side}: the second pad begins ${[...gaps].join(" or ")} bytes after the code before it; over ${[...constants.values()].reduce((a, b) => a + b, 0)} links tried, .data moved by the second pad's size plus ${[...constants].map(([c, n]) => `${c} (${n} links)`).join(", ")}, mod 64`);
}
