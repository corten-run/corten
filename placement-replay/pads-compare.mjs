// Two pad generators against the plan's fourth point, at every K from 31 to 254: the first
// placement runs' `pads.mjs` (the tags `evidence/ee7b0b41` and, the same file,
// `evidence/request-gzip-1971-placed`) and the sizing kit's (`evidence/placement-sizing-1999`).
// Both export `pads(K)`, which returns the two lists `{ P, Q }`.
//
//   git show evidence/ee7b0b41:pads.mjs > first/pads.mjs
//   git show evidence/placement-sizing-1999:placement-sizing-1999/kit/pads.mjs > sizing/pads.mjs
//   node pads-compare.mjs first/pads.mjs sizing/pads.mjs
//
// The rule below is written from the fourth point's text and uses neither generator's own check.
import { pathToFileURL } from 'node:url';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: node pads-compare.mjs <the first runs' pads.mjs> <the sizing kit's pads.mjs>");
  process.exit(2);
}
// Either file prints when it is run as a script; imported, it may still print, so that is dropped.
const log = console.log;
console.log = () => {};
const first = await import(pathToFileURL(a).href);
const sizing = await import(pathToFileURL(b).href);
console.log = log;

// No size in both lists or twice in one, each a multiple of 16 up to 40,960 bytes; the line
// phases of (p_i, q_i), each size mod 64, take all 16 ordered combinations (K distinct ones
// under 16); q_i - p_i mod 4096 takes K distinct values, at least floor(K / 8) in each quarter
// of a page.
const rule = (P, Q) => {
  const K = P.length;
  const why = [];
  const all = [...P, ...Q];
  if (Q.length !== K) why.push('the lists differ in length');
  if (new Set(all).size !== all.length) why.push('a size repeats or is in both lists');
  if (all.some((x) => x % 16 || x < 16 || x > 40960)) why.push('a size out of range');
  const combos = new Set(P.map((p, i) => `${p % 64}/${Q[i] % 64}`)).size;
  if (combos !== Math.min(16, K)) why.push(`${combos} line-phase combinations`);
  const d = P.map((p, i) => (((Q[i] - p) % 4096) + 4096) % 4096);
  if (new Set(d).size !== K) why.push(`${new Set(d).size} distinct differences of ${K}`);
  const quarters = [0, 1, 2, 3].map((k) => d.filter((x) => Math.floor(x / 1024) === k).length);
  if (quarters.some((n) => n < Math.floor(K / 8))) why.push(`quarters ${quarters.join(' ')}`);
  return why;
};
const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const ranges = (xs) => {
  const out = [];
  for (const x of xs) {
    const last = out[out.length - 1];
    if (last && last[1] === x - 1) last[1] = x;
    else out.push([x, x]);
  }
  return out.map(([s, e]) => (s === e ? `${s}` : `${s} to ${e}`)).join(', ') || 'none';
};

const base = first.pads(30);
const other = sizing.pads(30);
log(`K = 30: the two give the same lists: ${same(base.P, other.P) && same(base.Q, other.Q)};`
  + ` the rule's complaints of them: ${JSON.stringify(rule(base.P, base.Q))}`);
for (const [name, g] of [["the first runs' generator", first], ["the sizing kit's generator", sizing]]) {
  const pass = [];
  const keep = [];
  const fail = [];
  for (let K = 31; K <= 254; K++) {
    let lists;
    try {
      lists = g.pads(K);
    } catch (e) {
      fail.push(`${K}: ${e.message}`);
      continue;
    }
    const why = rule(lists.P, lists.Q);
    if (why.length) fail.push(`${K}: ${why.join('; ')}`);
    else pass.push(K);
    if (same(lists.P.slice(0, 30), base.P) && same(lists.Q.slice(0, 30), base.Q)) keep.push(K);
  }
  log(`${name}: meets the rule at K = ${ranges(pass)} (${pass.length} of 224);`
    + ` its first 30 pairs are the lists at K = 30 at K = ${ranges(keep)} (${keep.length} of 224)`);
  if (fail.length) log(`  the first K it fails at: ${fail.slice(0, 3).join(' | ')}`);
}
let differ = 0;
for (let K = 31; K <= 254; K++) {
  const x = first.pads(K);
  const y = sizing.pads(K);
  if (!same(x.P, y.P) || !same(x.Q, y.Q)) differ += 1;
}
log(`K from 31 to 254 at which the two give different lists: ${differ} of 224`);
for (let K = 255; K <= 258; K++) {
  let why;
  try {
    const lists = sizing.pads(K);
    why = rule(lists.P, lists.Q);
  } catch (e) {
    why = [e.message];
  }
  log(`the sizing kit's generator at K = ${K}: ${why.length ? why.join('; ') : 'meets the rule'}`);
}
