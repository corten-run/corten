// schedule.mjs: the order a run's placements are turned in, from the plan's numbers alone, so
// run.sh follows it and report.mjs can check that the run did:
//   node schedule.mjs <K_A> <K_B> <K_C> <seed>   one line per placement: "<seq> <comparison> <i>"
// Three parts share the session and are spread through it, so a drift of the host over the hours
// falls on all of them alike:
//   aa-old      placements 1..K_A in a random order fixed by the seed (plan.env SCHEDULE_SEED): a
//               Fisher-Yates shuffle of 1..K_A from the end, drawing from mulberry32(seed)
//               (model.mjs's rng). Amendment 1 (review 1, P2-1): the pads are periodic in their
//               index and their rule changes at i = 30, so a run order equal to the index made
//               report.mjs's lag-1 and Spearman read the pad design; in a random order they read
//               time. schedule.txt records the order and every placement.txt its seq.
//   same-old    placements 1..K_B in a random order, the same generator's next shuffle
//   unpadded-*  K_C rounds; round i is placement i of unpadded-base, unpadded-head, unpadded-x1
//               and unpadded-x2 back to back, in that order in odd rounds and the reverse in even
//               ones, so base and head sit side by side every round and neither always goes first
// The k-th placement of a part of n (in its order) is set at (k - 1/2) / n of the session; ties go
// aa-old, same-old, then the unpadded round. C's rounds stay in pad order (C is read by pad, not
// by time).
import { fileURLToPath } from "node:url";
import { rng } from "./model.mjs";

export const UNPADDED = ["unpadded-base", "unpadded-head", "unpadded-x1", "unpadded-x2"];

/** 1..n in a random order: Fisher-Yates from the end, drawing from the generator u. */
export function shuffled(n, u) {
  const a = Array.from({ length: n }, (_, k) => k + 1);
  for (let k = n - 1; k > 0; k--) { const j = Math.floor(u() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; }
  return a;
}

export function schedule(KA, KB, KC, seed) {
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`schedule: no usable seed (${seed})`);
  const u = rng(seed), orderA = shuffled(KA, u), orderB = shuffled(KB, u);
  const items = [];
  for (let k = 1; k <= KA; k++) items.push({ at: (k - 0.5) / KA, tie: 0, list: [["aa-old", orderA[k - 1]]] });
  for (let k = 1; k <= KB; k++) items.push({ at: (k - 0.5) / KB, tie: 1, list: [["same-old", orderB[k - 1]]] });
  for (let i = 1; i <= KC; i++) {
    const order = i % 2 ? UNPADDED : [...UNPADDED].reverse();
    items.push({ at: (i - 0.5) / KC, tie: 2, list: order.map((c) => [c, i]) });
  }
  items.sort((a, b) => a.at - b.at || a.tie - b.tie);
  return items.flatMap((x) => x.list).map(([comparison, i], k) => ({ seq: k + 1, comparison, i }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [KA, KB, KC, seed] = process.argv.slice(2).map(Number);
  if (![KA, KB, KC, seed].every((n) => Number.isInteger(n) && n >= 0)) { console.error("usage: node schedule.mjs <K_A> <K_B> <K_C> <seed>"); process.exit(2); }
  for (const s of schedule(KA, KB, KC, seed)) console.log(`${s.seq} ${s.comparison} ${s.i}`);
}