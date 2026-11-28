// schedule.mjs: the order a part's placements are turned in, from the plan's numbers alone, so
// run.sh follows it and report.mjs can check that the run did:
//   node schedule.mjs <part> <workload> <K> <seed>   one line per placement: "<seq> <comparison> <i>"
// The K indices run in a random order fixed by the seed: a Fisher-Yates shuffle of 1..K from the
// end, drawing from mulberry32(seed) (model.mjs's rng), so that run order is time and not the pad
// lists' own pattern.
//   pilot   pilot-<w>'s placement at each index, one after another
//   gated   at each index aa-<w>'s placement and change-<w>'s back to back, the A/A's first at
//           the odd places of the order and the change's first at the even
import { fileURLToPath } from "node:url";
import { rng } from "./model.mjs";

export const PARTS = ["pilot", "gated"];

/** 1..n in a random order: Fisher-Yates from the end, drawing from the generator u. */
export function shuffled(n, u) {
  const a = Array.from({ length: n }, (_, k) => k + 1);
  for (let k = n - 1; k > 0; k--) { const j = Math.floor(u() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; }
  return a;
}

/** The comparisons a part turns for a workload. */
export const comparisons = (part, w) => (part === "pilot" ? [`pilot-${w}`] : [`aa-${w}`, `change-${w}`]);

/** The binaries of placement i (1-based) of a comparison, A then B, from the workload's pad lists. */
export function sides(comparison, i, P, Q) {
  const p = P[i - 1], q = Q[i - 1];
  if (/^(pilot|aa)-/.test(comparison)) return [`base-p${p}`, `base-p${q}`];
  if (/^change-/.test(comparison)) return [`base-p${p}`, `head-p${p}`];
  throw new Error(`no comparison ${comparison}`);
}

export function schedule(part, w, K, seed) {
  if (!PARTS.includes(part) || !/^[a-z]+$/.test(w ?? "")) throw new Error(`schedule: no part ${part} or workload ${w}`);
  if (!Number.isInteger(K) || K < 1 || !Number.isInteger(seed) || seed < 0) throw new Error(`schedule: no usable K or seed (${K}, ${seed})`);
  const order = shuffled(K, rng(seed)), cs = comparisons(part, w), out = [];
  order.forEach((i, k) => { for (const c of k % 2 ? [...cs].reverse() : cs) out.push({ seq: out.length + 1, comparison: c, i }); });
  return out;
}

export const lines = (s) => s.map((x) => `${x.seq} ${x.comparison} ${x.i}\n`).join("");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [part, w, K, seed] = process.argv.slice(2);
  try { process.stdout.write(lines(schedule(part, w, Number(K), Number(seed)))); }
  catch (e) { console.error(`${e.message}\nusage: node schedule.mjs <pilot|gated> <workload> <K> <seed>`); process.exit(2); }
}
