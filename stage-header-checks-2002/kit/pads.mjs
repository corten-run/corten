// pads.mjs: the pad sizes plan.env declares, and the checks on them (results/margin.md, "Builds
// and placements"):
//   node pads.mjs                      prints PADS_P and PADS_Q and their phase coverage
//   node pads.mjs --check <plan.env>   fails unless plan.env's lists are exactly these and pass
// Kit 1965's pads.mjs, carried from 30 placements to 60. A size is 4096 m + 64 t + 16 l bytes: m
// whole 4 KiB pages (0 to 9, so up to about 40,000 bytes), t 64-byte lines within the page (0 to
// 63) and l the 16-byte step within the line (0 to 3; rustc aligns functions to 16, so a pad of a
// multiple of 16 moves every function by the same amount). For placement i = 0..K-1:
//   P: l = i mod 4,            t = (39 i + 5) mod 64,       m = 3 i mod 10
//   Q: l = floor(i / 4) mod 4, t = (25 i + 37 + s) mod 64,  m = (7 i + 5) mod 10
// with s = 0 for i under 30, which makes the first 30 of each list kit 1965's 30, and s = SHIFT
// from there on: kit 1965's rule alone repeats q_i - p_i mod 4096 every 32 placements, so the
// second 30 are moved by SHIFT lines, the smallest shift from 1 to 63 with which the 60 pass every
// check below. A size of 0, or one already used, moves by a page (up, or down past 40,960), which
// keeps its phases. The checks, which Pull requests asks of a plan's pads: every size a multiple
// of 16 from 16 to 40,960 bytes and in one list once; across the K pairs the 64-byte-line phases
// of p_i and q_i take all 16 ordered combinations; q_i - p_i mod 4096 takes K distinct values, at
// least floor(K / 8) of them in each quarter of a page.
import { readFileSync } from "node:fs";

export const K = 60;

function make(shift) {
  const used = new Set();
  const take = (m, t, l) => {
    let n = 4096 * m + 64 * t + 16 * l;
    while (n === 0 || used.has(n)) n = n + 4096 > 40960 ? n - 4096 * 9 : n + 4096;
    used.add(n);
    return n;
  };
  const P = [], Q = [];
  for (let i = 0; i < K; i++) P.push(take((3 * i) % 10, (39 * i + 5) % 64, i % 4));
  for (let i = 0; i < K; i++) Q.push(take((7 * i + 5) % 10, (25 * i + 37 + (i < 30 ? 0 : shift)) % 64, Math.floor(i / 4) % 4));
  return { P, Q };
}

export function coverage(P, Q) {
  const line = (xs) => [0, 16, 32, 48].map((p) => xs.filter((x) => x % 64 === p).length);
  const quarters = (xs) => [0, 1, 2, 3].map((q) => xs.filter((x) => Math.floor((x % 4096) / 1024) === q).length);
  const pages = (xs) => Array.from({ length: 10 }, (_, m) => xs.filter((x) => Math.floor(x / 4096) === m).length);
  const combos = new Set(P.map((p, i) => `${p % 64}/${Q[i] % 64}`)).size;
  const diffs = P.map((p, i) => (((Q[i] - p) % 4096) + 4096) % 4096);
  return {
    P: { line: line(P), pageQuarters: quarters(P), pages: pages(P), min: Math.min(...P), max: Math.max(...P) },
    Q: { line: line(Q), pageQuarters: quarters(Q), pages: pages(Q), min: Math.min(...Q), max: Math.max(...Q) },
    linePairCombos: combos,
    differences: { distinct: new Set(diffs).size, quarters: quarters(diffs), sorted: [...diffs].sort((a, b) => a - b) },
  };
}

/** Why the lists do not meet the checks above, or nothing. */
export function problems(P, Q) {
  const why = [], all = [...P, ...Q], c = coverage(P, Q);
  if (P.length !== K || Q.length !== K) why.push(`not ${K} sizes in each list`);
  if (new Set(all).size !== all.length) why.push("a size repeats");
  if (all.some((x) => x % 16 || x < 16 || x > 40960)) why.push("a size is not a multiple of 16 from 16 to 40960");
  if (c.linePairCombos !== 16) why.push(`${c.linePairCombos} of 16 line-phase combinations`);
  if (c.differences.distinct !== K) why.push(`${c.differences.distinct} distinct differences mod 4096, not ${K}`);
  if (c.differences.quarters.some((n) => n < Math.floor(K / 8))) why.push(`differences by quarter of a page ${c.differences.quarters}: under ${Math.floor(K / 8)} in one`);
  return why;
}

export function pads() {
  for (let shift = 1; shift < 64; shift++) {
    const made = make(shift);
    if (problems(made.P, made.Q).length === 0) return { ...made, shift };
  }
  throw new Error("pads: no shift passes");
}

const { P, Q, shift } = pads();
if (process.argv[2] === "--check") {
  const env = readFileSync(process.argv[3], "utf8");
  const list = (k) => (new RegExp(`^${k}="([^"]*)"$`, "m").exec(env)?.[1] ?? "").split(" ").map(Number);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(list("PADS_P"), P) || !same(list("PADS_Q"), Q)) { console.error("pads: plan.env's PADS_P or PADS_Q are not pads.mjs's"); process.exit(1); }
  const why = problems(list("PADS_P"), list("PADS_Q"));
  if (why.length) { console.error("pads: " + why.join("; ")); process.exit(1); }
  const all = [...P, ...Q];
  console.log(`pads: plan.env's sizes are pads.mjs's: ${all.length} distinct multiples of 16 from ${Math.min(...all)} to ${Math.max(...all)} bytes, every check passed`);
} else {
  console.log(`PADS_P="${P.join(" ")}"`);
  console.log(`PADS_Q="${Q.join(" ")}"`);
  console.log(`SHIFT ${shift}`);
  console.log(JSON.stringify(coverage(P, Q)));
}
