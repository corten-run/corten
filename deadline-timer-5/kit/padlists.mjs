// padlists.mjs: plan.env's pad lists, a pair for each workload. A workload's lists are those
// pads.mjs prints for that workload's own K (PADS_P_<W> and PADS_Q_<W>, K_<W> sizes each): the
// lists pads.mjs builds for one K are not the first sizes of those it builds for a larger K, so
// a workload with its own K has its own lists.
//   node padlists.mjs --lines <plan.env>   the list lines for plan.env's K's, to append to it
//   node padlists.mjs --check <plan.env>   every workload's lists are pads.mjs's for its K and
//                                          meet the rule for an A/A's two lists (pads.mjs's
//                                          problems); exit 1 with the reasons if not
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { coverage, pads, problems, readEnv } from "./pads.mjs";
import { WORKLOADS } from "./schedule.mjs";

const list = (s) => (s ?? "").split(" ").filter(Boolean).map(Number);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A workload's K and lists from plan.env's variables, and why they are not usable ([] when they are). */
export function padLists(env, w) {
  const U = w.toUpperCase(), K = Number(env[`K_${U}`]), why = [];
  const P = list(env[`PADS_P_${U}`]), Q = list(env[`PADS_Q_${U}`]);
  if (!/^\d+$/.test(env[`K_${U}`] ?? "") || K < 5 || K > 254) return { K, P, Q, why: [`K_${U} is not a whole number from 5 to 254`] };
  const want = pads(K);
  if (!same(P, want.P) || !same(Q, want.Q)) why.push(`PADS_P_${U} or PADS_Q_${U} are not pads.mjs's lists for K_${U} = ${K}`);
  else why.push(...problems(P, Q).map((x) => `${w}: ${x}`));
  return { K, P, Q, why };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, file] = process.argv.slice(2);
  if (!["--lines", "--check"].includes(mode) || !file) { console.error("usage: node padlists.mjs --lines|--check <plan.env>"); process.exit(2); }
  const env = readEnv(readFileSync(file, "utf8"));
  if (mode === "--lines") {
    for (const w of WORKLOADS) {
      const U = w.toUpperCase(), K = Number(env[`K_${U}`]);
      if (!Number.isInteger(K) || K < 5 || K > 254) { console.error(`padlists: K_${U} is not a whole number from 5 to 254`); process.exit(1); }
      const { P, Q } = pads(K);
      console.log(`PADS_P_${U}="${P.join(" ")}"`);
      console.log(`PADS_Q_${U}="${Q.join(" ")}"`);
    }
  } else {
    let bad = 0;
    for (const w of WORKLOADS) {
      const l = padLists(env, w);
      if (l.why.length) { bad++; console.error(`padlists: ${l.why.join("; ")}`); continue; }
      const c = coverage(l.P, l.Q);
      console.log(`padlists: ${w}: plan.env's sizes are pads.mjs's for K = ${l.K} and meet the rule: ${2 * l.K} distinct multiples of 16 from ${Math.min(...l.P, ...l.Q)} to ${Math.max(...l.P, ...l.Q)} bytes, ${c.linePairCombos} line-phase combinations, ${c.distinctDiffs} distinct q - p mod 4096 (${c.diffQuarters.join(", ")} by quarter of a page)`);
    }
    process.exit(bad ? 1 : 0);
  }
}
