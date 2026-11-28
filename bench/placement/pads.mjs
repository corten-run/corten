// pads.mjs: the pad sizes plan.env declares, and the checks on them (plan.md, "The placements"):
//   node pads.mjs [K]                  prints PADS_P and PADS_Q for K placements (default 100) and
//                                      their phase coverage
//   node pads.mjs --check <plan.env>   fails unless plan.env's lists are exactly these for its
//                                      K_A and meet CONTRIBUTING's rule for an A/A's two lists
// A size is 4096 m + 64 t + 16 l bytes: m whole 4 KiB pages (0 to 9, so up to about 40,000
// bytes), t 64-byte lines within the page (0 to 63) and l the 16-byte step within the line (0 to
// 3; rustc aligns functions to 16, so a pad of a multiple of 16 moves every function by the same
// amount). For placement i = 0..K-1:
//   P: l = i mod 4,           t = (39 i + 5) mod 64,  m = 3 i mod 10        (every i)
//   Q: l = floor(i / 4) mod 4, t = (25 i + 37) mod 64, m = (7 i + 5) mod 10  (i < 30)
// which for K <= 30 are the first two placement runs' lists (kits 1965 and 1983), unchanged. Those
// Q sizes repeat q - p mod 4096 with a period of 32 (t_q - t_p = 32 - 14 i mod 64), so from i = 30
// on Q is set by the difference instead: q_i = 4096 m + (p_i + d_i) mod 4096, m = (7 i + 5) mod 10,
// d_i = 1024 (i mod 4) + 64 s + 16 ((l_q - l_p) mod 4) with l_q = floor(i / 4) mod 4 as before and s
// the first of (5 i + 3) mod 16, then s + 1, ... (mod 16) whose d_i no earlier placement has: so
// each difference is new, the four quarters of a page take them in turn, and q_i's line phase is
// the one the formula above would give it.
// A size of 0, or one already used, moves by a page (up, or down past 40,960), which keeps its
// phases and its difference. The rule (CONTRIBUTING, Pull requests, item 2, "Resolution"): no size
// in both lists; across the K pairs the 64-byte-line phases of p_i and q_i (each size mod 64, in
// steps of 16) take all 16 ordered combinations (K when K < 16); and q_i - p_i mod 4096 takes K
// distinct values, at least floor(K / 8) of them in each quarter of a page.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function pads(K = 100) {
  const used = new Set();
  const place = (n) => {
    while (n === 0 || used.has(n)) n = n + 4096 > 40960 ? n - 4096 * 9 : n + 4096;
    used.add(n);
    return n;
  };
  const P = [], Q = [];
  for (let i = 0; i < K; i++) P.push(place(4096 * ((3 * i) % 10) + 64 * ((39 * i + 5) % 64) + 16 * (i % 4)));
  const diffs = new Set();
  const diff = (p, q) => (((q - p) % 4096) + 4096) % 4096;
  for (let i = 0; i < K; i++) {
    let q;
    if (i < 30) q = 4096 * ((7 * i + 5) % 10) + 64 * ((25 * i + 37) % 64) + 16 * (Math.floor(i / 4) % 4);
    else {
      const lp = i % 4, lq = Math.floor(i / 4) % 4;
      let d = null;
      for (let k = 0; k < 16 && d == null; k++) {
        const c = 1024 * (i % 4) + 64 * ((5 * i + 3 + k) % 16) + 16 * ((((lq - lp) % 4) + 4) % 4);
        if (!diffs.has(c)) d = c;
      }
      if (d == null) throw new Error(`pads: no free difference for placement ${i}`);
      q = 4096 * ((7 * i + 5) % 10) + ((P[i] + d) % 4096);
    }
    q = place(q);
    Q.push(q);
    diffs.add(diff(P[i], q));
  }
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
    diffs,
    distinctDiffs: new Set(diffs).size,
    diffQuarters: quarters(diffs),
  };
}

/** Why two lists do not meet the rule for an A/A's lists, or [] when they do. */
export function problems(P, Q) {
  const K = P.length, why = [], all = [...P, ...Q], c = coverage(P, Q);
  if (Q.length !== K) why.push("the lists differ in length");
  if (new Set(all).size !== all.length) why.push("a size repeats");
  if (all.some((x) => !Number.isInteger(x) || x % 16 || x < 16 || x > 40960)) why.push("a size is not a multiple of 16 from 16 to 40,960");
  if (c.linePairCombos !== Math.min(16, K)) why.push(`the line phases take ${c.linePairCombos} ordered combinations, not ${Math.min(16, K)}`);
  if (c.distinctDiffs !== K) why.push(`q - p mod 4096 takes ${c.distinctDiffs} values, not ${K}`);
  if (c.diffQuarters.some((n) => n < Math.floor(K / 8))) why.push(`q - p mod 4096 by quarter of a page is ${c.diffQuarters.join(", ")}: fewer than ${Math.floor(K / 8)} in one`);
  return why;
}

/** plan.env's numbers and lists, as report.mjs and check-report.mjs read them. */
export function readEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((l) => /^([A-Z_0-9]+)=(?:"([^"]*)"|(\S*))$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2] ?? m[3]]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "--check") {
    const env = readEnv(readFileSync(process.argv[3], "utf8"));
    const K = Number(env.K_A);
    const list = (k) => (env[k] ?? "").split(" ").filter(Boolean).map(Number);
    const { P, Q } = pads(K);
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (!Number.isInteger(K) || K < 5) { console.error("pads: plan.env's K_A is not a whole number of at least 5"); process.exit(1); }
    if (!same(list("PADS_P"), P) || !same(list("PADS_Q"), Q)) { console.error(`pads: plan.env's PADS_P or PADS_Q are not pads.mjs's for K_A = ${K}`); process.exit(1); }
    const why = problems(P, Q);
    if (why.length) { console.error("pads: " + why.join("; ")); process.exit(1); }
    const c = coverage(P, Q);
    console.log(`pads: plan.env's sizes are pads.mjs's for K_A = ${K} and meet the rule: ${2 * K} distinct multiples of 16 from ${Math.min(...P, ...Q)} to ${Math.max(...P, ...Q)} bytes, ${c.linePairCombos} line-phase combinations, ${c.distinctDiffs} distinct q - p mod 4096 (${c.diffQuarters.join(", ")} by quarter of a page)`);
  } else {
    const K = Number(process.argv[2] ?? 100);
    const { P, Q } = pads(K);
    console.log(`PADS_P="${P.join(" ")}"`);
    console.log(`PADS_Q="${Q.join(" ")}"`);
    console.log(JSON.stringify(coverage(P, Q)));
    console.log(JSON.stringify(problems(P, Q)));
  }
}