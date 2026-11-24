// report.mjs: kit 1999's results in one page (corten-run/corten#1999 and #1996):
//   node report.mjs <results dir> [--declared <dir>] > report.md
// writes report.json beside the results. --declared names the directory holding the plan.env and
// commits.env the run was declared with (default: this kit's own); the results must carry the same
// bytes. Exit 0: every comparison of the plan complete; 1: one or more incomplete (no bound for
// those); 2: refused, nothing read; 3: report.mjs itself failed (an error in it, not in the
// results; run.sh reads any exit but 0, 1 and 2, or a report.json that does not say the same exit,
// as a crash).
//
// Refused outright (exit 2), as evidence a failed, misconfigured or buggy run of the kit, or a
// record of another kit, could leave:
//   - no kit.txt, run-id, plan.env, commits.env, plan.md, sha256.txt, placements.txt,
//     schedule.txt, retries.txt, host-id.txt or verify/verdicts.txt (a record of the earlier kits
//     has no kit.txt);
//   - kit.txt not naming this kit, a run id other than run-id's, or a plan sha256 other than that
//     of the results' plan.env and commits.env; those two files not the declared ones, byte for byte;
//   - PADS_P and PADS_Q not pads.mjs's lists for plan.env's K_A, or the lists the run read (their
//     first K_A, DRYRUN's when a dry run) not meeting CONTRIBUTING's rule for an A/A's two lists;
//   - schedule.txt not schedule.mjs's order for the run's K_A, K_B, K_C and SCHEDULE_SEED;
//   - retries.txt not lines "<seq> <comparison> <i> retry-of <seq>" numbered on from the schedule,
//     each of a scheduled placement once, in the order they were scheduled, at most RETRY_MAX;
//   - a directory of results the plan has no comparison for (another plan's, or a part this plan
//     cut), or placements not started one after another in the schedule's order;
//   - a binary a comparison reads not verified against its side's unpadded binary (x1 and x2
//     against base), or a padded binary without build.sh's placement check.
// A placement leaves its comparison incomplete, and so without a bound, when its directory is
// missing or one more is there; its counts-old.csv, ages-old.txt, placement.txt or answers-old/
// verdict.txt is missing; placement.txt is not exactly the nine lines run.sh writes (comparison,
// A and B with the build's sha256s for this placement's pads, kit, run, plan, its place in the
// schedule, started, ended); its CSV is not the counts header with pairs 1..R each read once on
// each side; or its starts' ages are not 2 + 2R checked lines, in the order the pairs were turned,
// every Age in OLD_LOW..OLD_HIGH and the handler run once.
//
// What it reports (plan.md, "Reading"), all in user+kernel cycles a request, B / A - 1 per pair,
// the median of a placement's R pairs as its statistic:
//   A  aa-old: the median of the K_A placement medians and its one-sided 95% order-statistic
//      bound, as recorded and with the labels swapped, and whether both are under +1%; the
//      medians' sd and the normal model's failure rate at that sd; Shapiro-Wilk and
//      Anderson-Darling on the medians, their lag-1 autocorrelation in run order and Spearman's
//      correlation with run order, each with a permutation p (run order is time: the placements
//      run in a seeded random order); the two-sided order-statistic interval for the common
//      median (ranks K + 1 - j and j) and a sign test; the sizing model plan.md's rule picks;
//      a 95% interval for the sd from K_A medians and whether the second run's 1.97% (30
//      medians) is inside it, with the two-sided F test of the two, and whether this host's CPU
//      model is that run's (if not, the comparison cannot tell chance from the CPU); what the
//      pairs alone give a median ("from within"); and the correlation of the 30 pad pairs this
//      run shares with the second run (prior/0c0c599c) between the two runs' placement medians.
//   B  same-old (when the plan has it): the same bounds, sd and from within; what of A's sd is
//      left once B's is taken out (the pad lists' own part).
//   C  unpadded-*: each comparison's median offset with its order-statistic interval and how many
//      of its padded placements cost less than the unpadded build (sign test); head's offset less
//      base's, and x1's and x2's less base's, paired by pad, with intervals; whether x1 and x2
//      compile `old` nearly as base does (median user-instructions change within INSTR_NEAR%);
//      each unpadded build's own cost a request ranked among A's 2 K_A padded placements' costs,
//      beside the Spearman correlation of those costs with run order.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARGIN, MEASURES, across, ibeta, placementStats, readPairs, resolution, tQuantile } from "./placement.mjs";
import { andersonDarling, binomUpper, chooseModel, pearson, failRateNormal, failRateSmoothed, fromWithin, kNeeded, median, medianInterval, mean, permutationLag1, permutationSpearman, qchisq, sd, shapiroWilk } from "./model.mjs";
import { pads, problems as padProblems, readEnv } from "./pads.mjs";
import { schedule, UNPADDED } from "./schedule.mjs";
import { pct } from "./stats.mjs";
import { readPilot } from "./size.mjs";

export const KIT = "cycles-1996-1999";
export const PRIOR_SD = 0.0197, PRIOR_K = 30, PRIOR_ID = "0c0c599c";
const here = dirname(fileURLToPath(import.meta.url));
const UK = "cycles user+kernel", IU = "instructions user";
const fmt = (x) => (x == null || !Number.isFinite(x) ? "-" : pct(x));
const mag = (x) => fmt(x).replace(/^\+/, "");
const p3 = (x) => (x == null || !Number.isFinite(x) ? "-" : x < 0.001 ? x.toExponential(1) : x.toFixed(3));
const ITEMS = new Set(["aa-old", "same-old", ...UNPADDED, "check-only", "verify", "preflight", "layout", "failed"]);

/** The F distribution's cdf, from the incomplete beta. */
export const fCdf = (x, d1, d2) => (x <= 0 ? 0 : ibeta((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2));
/** Two-sided sign test: the chance of a split at least this uneven among n placements. */
export function signTest(k, n) {
  if (!n) return null;
  const lo = Math.min(k, n - k);
  let c = 0, t = 1;
  for (let j = 0; j <= lo; j++) { c += t; t = (t * (n - j)) / (j + 1); }
  return Math.min(1, (2 * c) / 2 ** n);
}

/** The sides of placement i (1-based) of a comparison: [A, B]. */
export function sides(c, i, P, Q) {
  const p = P[i - 1], q = Q[i - 1];
  switch (c) {
    case "aa-old": return [`base-p${p}`, `base-p${q}`];
    case "same-old": return [`base-p${p}`, `base-p${p}`];
    case "unpadded-base": return ["base", `base-p${p}`];
    case "unpadded-head": return ["head", `head-p${p}`];
    case "unpadded-x1": return ["x1", `base-p${p}`];
    case "unpadded-x2": return ["x2", `base-p${p}`];
    default: throw new Error(`no comparison ${c}`);
  }
}
const reference = (name) => (/^head-p\d+$/.test(name) ? "head" : /^base-p\d+$/.test(name) || name === "x1" || name === "x2" ? "base" : null);

/** A placement's starts: 2 + 2r lines, turned as run-pair-old.sh turns them, each checked. */
export function readAges(file, r, low, high) {
  const lines = readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
  if (lines.length !== 2 + 2 * r) throw new Error(`${lines.length} starts, not ${2 + 2 * r}`);
  const order = [["w1", "base"], ["w1", "head"]];
  for (let p = 1; p <= r; p++) order.push(...(p % 2 ? [[`${p}`, "base"], [`${p}`, "head"]] : [[`${p}`, "head"], [`${p}`, "base"]]));
  const ages = [];
  lines.forEach((l, k) => {
    const m = /^(\S+) (base|head) before (\d+) after (\d+) runs 1$/.exec(l);
    if (!m) throw new Error(`unchecked start: ${l}`);
    if (m[1] !== order[k][0] || m[2] !== order[k][1]) throw new Error(`start ${k + 1} is pair ${m[1]} ${m[2]}, not ${order[k].join(" ")}: not turned as the protocol turns them`);
    for (const a of [Number(m[3]), Number(m[4])]) {
      if (!(a >= low && a <= high)) throw new Error(`an Age of ${a} is not in ${low}..${high}`);
      ages.push(a);
    }
  });
  return ages;
}

export function read(dir, declared = here) {
  const refused = [];
  const need = ["kit.txt", "run-id", "plan.env", "commits.env", "plan.md", "sha256.txt", "placements.txt", "schedule.txt", "retries.txt", "host-id.txt", join("verify", "verdicts.txt")];
  const missing = need.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) return { refused: [`no ${missing.join(", ")} in the results: not a complete record of this kit's run (an earlier kit's results have no kit.txt)`] };
  const text = (f) => readFileSync(join(dir, f), "utf8");
  const kitLines = text("kit.txt").replace(/\n$/, "").split("\n");
  const kv = Object.fromEntries(kitLines.map((l) => l.split(" ")));
  const runId = text("run-id").trim();
  if (kitLines.length !== 3 || kv.kit !== KIT) refused.push(`kit.txt names kit ${kv.kit ?? "(none)"}, not ${KIT}`);
  if (!/^[0-9a-f-]{36}$/.test(runId) || kv.run !== runId) refused.push(`kit.txt's run ${kv.run} is not run-id's ${runId}`);
  const planSha = createHash("sha256").update(Buffer.concat([readFileSync(join(dir, "plan.env")), readFileSync(join(dir, "commits.env"))])).digest("hex");
  if (kv.plan !== planSha) refused.push(`kit.txt's plan ${kv.plan} is not the sha256 of the results' plan.env and commits.env (${planSha})`);
  for (const f of ["plan.env", "commits.env"]) {
    const d = join(declared, f);
    if (!existsSync(d) || !readFileSync(d).equals(readFileSync(join(dir, f)))) refused.push(`the results' ${f} is not the declared one (${d})`);
  }
  const env = readEnv(text("plan.env"));
  if (env.KIT !== KIT) refused.push(`plan.env's KIT is ${env.KIT}, not ${KIT}`);
  const dry = existsSync(join(dir, "DRYRUN"));
  let n = { KA: +env.K_A, KB: +env.K_B, KC: +env.K_C, R: +env.R, RC: +env.R_C, TURN: +env.TURN };
  if (dry) {
    const m = /K_A=(\d+), K_B=(\d+), K_C=(\d+), R=(\d+), R_C=(\d+), TURN=(\d+)/.exec(text("DRYRUN"));
    if (!m) refused.push("DRYRUN does not say the dry run's numbers");
    else n = { KA: +m[1], KB: +m[2], KC: +m[3], R: +m[4], RC: +m[5], TURN: +m[6] };
  }
  if (!Object.values(n).every((x) => Number.isInteger(x) && x >= 0) || n.KA < 5 || n.R < 1 || n.RC < 1 || n.KB > n.KA || n.KC > n.KA) refused.push(`the plan's numbers are not usable: ${JSON.stringify(n)}`);
  const allP = (env.PADS_P ?? "").split(" ").filter(Boolean).map(Number), allQ = (env.PADS_Q ?? "").split(" ").filter(Boolean).map(Number);
  const want = pads(Number(env.K_A));
  if (allP.join() !== want.P.join() || allQ.join() !== want.Q.join()) refused.push(`plan.env's PADS_P or PADS_Q are not pads.mjs's lists for K_A = ${env.K_A}`);
  const P = allP.slice(0, n.KA), Q = allQ.slice(0, n.KA);
  const padWhy = padProblems(P, Q);
  if (padWhy.length) refused.push(`the ${n.KA} pairs of pads the run read do not meet the rule: ${padWhy.join("; ")}`);
  const seed = /^\d+$/.test(env.SCHEDULE_SEED ?? "") ? Number(env.SCHEDULE_SEED) : NaN, retryMax = /^\d+$/.test(env.RETRY_MAX ?? "") ? Number(env.RETRY_MAX) : NaN;
  if (!Number.isInteger(seed) || !Number.isInteger(retryMax)) return { refused: [...refused, "plan.env has no usable SCHEDULE_SEED or RETRY_MAX"] };
  const sched = schedule(n.KA, n.KB, n.KC, seed);
  if (text("schedule.txt") !== sched.map((s) => `${s.seq} ${s.comparison} ${s.i}\n`).join("")) refused.push(`schedule.txt is not schedule.mjs's order for K_A = ${n.KA}, K_B = ${n.KB}, K_C = ${n.KC}, seed ${seed}`);
  const retries = [];
  text("retries.txt").split("\n").filter(Boolean).forEach((l, k) => {
    const m = /^(\d+) (\S+) (\d+) retry-of (\d+)$/.exec(l);
    if (!m) { refused.push(`retries.txt line ${k + 1} is not "<seq> <comparison> <i> retry-of <seq>": ${l}`); return; }
    const r = { seq: +m[1], c: m[2], i: +m[3], of: +m[4] }, orig = sched.find((s) => s.comparison === r.c && s.i === r.i);
    if (r.seq !== sched.length + k + 1) refused.push(`retries.txt line ${k + 1}: seq ${r.seq}, not ${sched.length + k + 1}`);
    if (!orig || orig.seq !== r.of) refused.push(`retries.txt line ${k + 1}: ${r.c} ${r.i} is not seq ${r.of} of the schedule`);
    if (retries.some((x) => x.c === r.c && x.i === r.i)) refused.push(`retries.txt: ${r.c} ${r.i} retried twice`);
    if (retries.length && retries[retries.length - 1].of >= r.of) refused.push(`retries.txt: retries not in the order their placements were scheduled`);
    retries.push(r);
  });
  if (retries.length > retryMax) refused.push(`retries.txt: ${retries.length} retries, more than RETRY_MAX = ${retryMax}`);
  const planned = ["aa-old", ...(n.KB ? ["same-old"] : []), ...(n.KC ? UNPADDED : [])];
  for (const d of readdirSync(dir)) {
    if (!statSync(join(dir, d)).isDirectory()) continue;
    if (!ITEMS.has(d) || (["aa-old", "same-old", ...UNPADDED].includes(d) && !planned.includes(d))) refused.push(`results/${d}: no comparison of this plan writes it`);
  }
  const shas = new Map();
  for (const l of text("sha256.txt").trim().split("\n")) { const [name, s] = l.split(" "); shas.set(name, s); }
  const checked = new Set(text("placements.txt").trim().split("\n").map((l) => l.split(" ").slice(0, 2).join(" ")));
  const verified = new Map();
  for (const l of text(join("verify", "verdicts.txt")).trim().split("\n")) {
    const m = /^(\S+) as (\S+): checked 4 answers of each build/.exec(l);
    if (m) verified.set(m[1], m[2]);
  }
  const ksOf = { "aa-old": [n.KA, n.R], "same-old": [n.KB, n.R] };
  for (const c of UNPADDED) ksOf[c] = [n.KC, n.RC];
  const used = new Set();
  for (const c of planned) for (let i = 1; i <= ksOf[c][0]; i++) for (const b of sides(c, i, P, Q)) used.add(b);
  for (const b of used) {
    if (!shas.has(b)) { refused.push(`${b}: not in sha256.txt`); continue; }
    if (verified.get(b) !== reference(b) && reference(b)) refused.push(`${b}: not verified as ${reference(b)} answers (verify/verdicts.txt)`);
    if (/-p\d+$/.test(b) && !checked.has(`${b} ${shas.get(b)}`)) refused.push(`${b}: no placement check in placements.txt with its sha256`);
  }
  if (refused.length) return { refused };

  const [low, high] = [Number(env.OLD_LOW), Number(env.OLD_HIGH)];
  const seqOf = new Map(sched.map((s) => [`${s.comparison} ${s.i}`, s.seq]));
  for (const r of retries) seqOf.set(`${r.c} ${r.i}`, r.seq);
  const hostId = Object.fromEntries(text("host-id.txt").replace(/\n$/, "").split("\n").map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1).trim()]));
  const results = {}, times = [];
  for (const c of planned) {
    const [k, r] = ksOf[c];
    const placements = [], problems = [], ages = [];
    const cdir = join(dir, c);
    const want = new Set(Array.from({ length: k }, (_, i) => `p${String(i + 1).padStart(3, "0")}`));
    const there = existsSync(cdir) ? readdirSync(cdir) : [];
    for (const x of there) if (!want.has(x)) problems.push(`${x}: not a placement of the plan`);
    for (let i = 1; i <= k; i++) {
      const name = `p${String(i).padStart(3, "0")}`, p = join(cdir, name);
      const [A, B] = sides(c, i, P, Q), seq = seqOf.get(`${c} ${i}`);
      const files = ["placement.txt", "counts-old.csv", "ages-old.txt", join("answers-old", "verdict.txt")];
      const gone = files.filter((f) => !existsSync(join(p, f)));
      if (gone.length) { problems.push(`${name}: no ${gone.join(", ")}`); continue; }
      const lines = readFileSync(join(p, "placement.txt"), "utf8").replace(/\n$/, "").split("\n");
      const head = [`comparison ${c} placement ${i} workload old`, `A ${A} ${shas.get(A)}`, `B ${B} ${shas.get(B)}`, `kit ${KIT}`, `run ${runId}`, `plan ${planSha}`, `seq ${seq}`];
      const bad = head.findIndex((l, j) => lines[j] !== l);
      const started = /^started (\S+Z)$/.exec(lines[7] ?? ""), ended = /^ended (\S+Z)$/.exec(lines[8] ?? "");
      if (bad >= 0) { problems.push(`${name}: placement.txt line ${bad + 1} is "${lines[bad] ?? ""}", not "${head[bad]}"`); continue; }
      if (lines.length !== 9 || !started || !ended) { problems.push(`${name}: placement.txt has no started and ended lines (${lines.length} lines): its pairs were not all in`); continue; }
      if (!/^checked 4 answers of each build/.test(readFileSync(join(p, "answers-old", "verdict.txt"), "utf8"))) { problems.push(`${name}: its two builds' answers were not checked alike`); continue; }
      let pairs;
      try { pairs = readPairs(join(p, "counts-old.csv")); } catch (e) { problems.push(`${name}: ${e.message}`); continue; }
      if (pairs.length !== r || pairs.some((x, j) => x.pair !== String(j + 1))) { problems.push(`${name}: pairs ${pairs.map((x) => x.pair).join(",")}, not 1..${r}`); continue; }
      try { ages.push(...readAges(join(p, "ages-old.txt"), r, low, high)); } catch (e) { problems.push(`${name}: ${e.message}`); continue; }
      times.push({ seq, c, i, started: started[1], ended: ended[1] });
      placements.push({ i, seq, A, B, started: started[1], retryOf: retries.find((x) => x.c === c && x.i === i)?.of ?? null, stats: placementStats(pairs) });
    }
    const complete = placements.length === k && problems.length === 0;
    results[c] = { k, r, complete, problems, placements, starts: ages.length / 2, ageMin: ages.length ? Math.min(...ages) : null, ageMax: ages.length ? Math.max(...ages) : null };
  }
  times.sort((a, b) => a.seq - b.seq);
  for (let j = 0; j < times.length; j++) {
    const t = times[j];
    if (t.ended < t.started) return { refused: [`${t.c} p${t.i}: ended before it started`] };
    if (j && times[j - 1].ended > t.started) return { refused: [`${t.c} p${t.i} (seq ${t.seq}) started before ${times[j - 1].c} p${times[j - 1].i} (seq ${times[j - 1].seq}) ended: the placements did not run one after another in the schedule's order`] };
  }
  return { dry, n, env, P, Q, runId, planSha, planned, results, shas, retries, hostId, seed };
}

const medOf = (pl, m = UK) => pl.stats[m].median;
/**
 * The second run's A/A (prior/0c0c599c/aa-old, its 30 placement medians from the saved CSVs)
 * against this run's placements i = 1..30, which have the same pad pairs: Spearman's rho with a
 * one-sided permutation p (a placement part that carries over makes rho positive), and Pearson's r.
 * Read only when this run's A is complete and has all 30, and the two runs' lists agree.
 */
export function sharedWithPrior(A, P, Q) {
  const dir = join(here, "prior", PRIOR_ID);
  if (!existsSync(join(dir, "plan.env")) || !existsSync(join(dir, "aa-old"))) return { read: false, why: `no prior/${PRIOR_ID}/plan.env or aa-old/ in the kit` };
  const env = readEnv(readFileSync(join(dir, "plan.env"), "utf8"));
  const pp = (env.PADS_P ?? "").split(" ").filter(Boolean).map(Number), pq = (env.PADS_Q ?? "").split(" ").filter(Boolean).map(Number);
  const priorBase = existsSync(join(dir, "sha256.txt")) ? readFileSync(join(dir, "sha256.txt"), "utf8").split("\n").find((l) => l.startsWith("base "))?.split(" ")[1] : null;
  const n = pp.length;
  if (P.length < 30) return { read: false, why: `this run's A/A has ${P.length} pairs, fewer than the 30 it shares with the second run`, priorBase };
  if (n !== 30 || pq.length !== 30 || pp.join() !== P.slice(0, 30).join() || pq.join() !== Q.slice(0, 30).join()) return { read: false, why: "the second run's pad lists are not this run's first 30", priorBase };
  const here30 = new Map(A.placements.filter((p) => p.i <= 30).map((p) => [p.i, medOf(p)]));
  if (!A.complete || here30.size !== 30) return { read: false, why: `aa-old is ${A.complete ? "complete" : "incomplete"} with ${here30.size} of the 30 shared placements`, priorBase };
  const prior = readPilot(join(dir, "aa-old")).map((p) => median(p.changes));
  const cur = Array.from({ length: 30 }, (_, k) => here30.get(k + 1));
  const s = permutationSpearman(cur, { ys: prior, side: 1 });
  return { read: true, rho: s.rho, p: s.p, pearson: pearson(cur, prior), prior, current: cur, priorBase };
}
/**
 * Each unpadded build's own cost a request (the median over its placements of its side A's median)
 * ranked among the 2 K_A padded placements' costs of A (each placement's base-p_i and base-q_i),
 * with the one-sided p of an exchangeable placement costing at least as much, (count at or above +
 * 1) / (2 K_A + 1); beside it the Spearman correlation of those padded costs with run order, which
 * says whether the costs drift in time (Amendment 1, P2-6 a).
 */
export function rankAgainstPadded(A, C) {
  const padded = A.placements.flatMap((p) => [{ seq: p.seq, cost: p.stats[UK].a }, { seq: p.seq, cost: p.stats[UK].b }]).sort((x, y) => x.seq - y.seq);
  const costs = padded.map((x) => x.cost);
  const drift = costs.length >= 3 ? permutationSpearman(costs, { ys: padded.map((x) => x.seq) }) : { rho: NaN, p: NaN };
  const rows = {};
  for (const [c, r] of Object.entries(C)) {
    const own = r.placements.length ? median(r.placements.map((p) => p.stats[UK].a)) : NaN;
    const below = costs.filter((x) => x < own).length, atOrAbove = costs.length - below;
    rows[c] = { own, below, of: costs.length, p: (atOrAbove + 1) / (costs.length + 1), read: A.complete && r.complete };
  }
  return { drift, rows, n: costs.length };
}
function aaPart(r, n, draws) {
  const meds = r.placements.map((p) => medOf(p)), swp = r.placements.map((p) => p.stats[UK].swapped);
  const a = across(meds), s = across(swp);
  if (!r.complete) { a.bound = null; s.bound = null; a.lower = null; s.lower = null; }
  const res = resolution({ complete: r.complete, across: { [UK]: a }, swapped: { [UK]: s } });
  const K = meds.length, dev = sd(meds);
  const out = { across: a, swapped: s, resolution: res, sd: dev, sdSwapped: sd(swp), K };
  out.within = r.r >= 3 ? fromWithin(r.placements.map((p) => p.stats[UK].changes), draws / 2) : null;
  if (K >= 5 && Number.isFinite(dev) && dev > 0) {
    out.failNormal = Object.fromEntries([...new Set([30, 60, 100, K])].sort((x, y) => x - y).map((k) => [k, failRateNormal(k, dev, draws).rate]));
    const pilot = meds.map((x, i) => [x, swp[i]]), steps = { coarse: Math.max(2000, draws / 10), fine: Math.max(5000, (2 * draws) / 5) };
    out.failSmoothed = failRateSmoothed(pilot, K, draws).rate;
    const need = kNeeded((k, d) => failRateNormal(k, dev, d), 0.05, steps);
    out.kNormal5 = need ? need.K : null;
    const needS = kNeeded((k, d) => failRateSmoothed(pilot, k, d), 0.05, steps);
    out.kSmoothed5 = needS ? needS.K : null;
  }
  return out;
}
export function report(dir, declared = here, { draws = 100000 } = {}) {
  const run = read(dir, declared);
  if (run.refused) return { json: { kit: KIT, refused: run.refused, exit: 2 }, text: ["# Kit 1999 (corten-run/corten#1999, #1996): REFUSED", "", "These results are not read:", "", ...run.refused.map((w) => `1. ${w}`), ""].join("\n"), code: 2 };
  const { dry, n, env, results } = run;
  const json = { kit: KIT, run: run.runId, plan: run.planSha, dry, numbers: n, complete: Object.fromEntries(Object.entries(results).map(([c, r]) => [c, r.complete])), problems: Object.fromEntries(Object.entries(results).map(([c, r]) => [c, r.problems])) };
  const out = ["# Kit 1999: placement A/A at K = " + n.KA + ", one pad list against itself, and unpadded against padded (corten-run/corten#1999, #1996)", ""];
  if (dry) out.push("**DRY RUN in a container: not a measurement.** The counters are made up (dry/perf); every number below shows the pipeline, not a cost.", "");
  out.push(`Run ${run.runId}, kit ${KIT}, plan sha256 ${run.planSha}. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs. Generated by report.mjs from the CSVs beside it.`, "");
  for (const [c, r] of Object.entries(results)) if (!r.complete) out.push(`**${c} is incomplete** (${r.placements.length} of ${r.k} placements read): ${r.problems.join("; ")}. It gives no bound.`, "");

  // A
  const A = results["aa-old"], a = aaPart(A, n, draws);
  const meds = A.placements.map((p) => medOf(p)), seqMeds = [...A.placements].sort((x, y) => x.seq - y.seq).map((p) => medOf(p));
  const sw = shapiroWilk(meds), ad = andersonDarling(meds), l1 = meds.length >= 3 ? permutationLag1(seqMeds) : { r1: NaN, p: NaN }, sp = meds.length >= 3 ? permutationSpearman(seqMeds) : { rho: NaN, p: NaN }, rho = sp.rho;
  const K = meds.length, ciLow = K > 2 ? a.sd * Math.sqrt((K - 1) / qchisq(0.975, K - 1)) : NaN, ciHigh = K > 2 ? a.sd * Math.sqrt((K - 1) / qchisq(0.025, K - 1)) : NaN;
  const F = (PRIOR_SD / a.sd) ** 2, fP = Number.isFinite(F) ? 2 * Math.min(fCdf(F, PRIOR_K - 1, K - 1), 1 - fCdf(F, PRIOR_K - 1, K - 1)) : NaN;
  // The common median of zero (Amendment 1, P2-3): the two-sided interval (ranks K + 1 - j and j
  // of the K medians, across()'s lower and bound) and a sign test.
  const zeroBelow = meds.filter((x) => x < 0).length, zeroCov = a.across.rank ? 1 - 2 * binomUpper(K, a.across.rank) : NaN;
  const zero = { low: a.across.lower, high: a.across.bound, ranks: a.across.rank ? [a.across.lowerRank, a.across.rank] : null, coverage: zeroCov, below: zeroBelow, signP: signTest(zeroBelow, K),
    inside: A.complete && a.across.lower != null ? a.across.lower <= 0 && 0 <= a.across.bound : null };
  // The host against the second run's (Amendment 1, P2-2).
  const priorHost = join(here, "prior", PRIOR_ID, "host.txt");
  const priorModel = existsSync(priorHost) ? (/^Model name:\s*(.+)$/m.exec(readFileSync(priorHost, "utf8"))?.[1].trim() ?? null) : null;
  const model = run.hostId.model || null, sameCpu = model != null && priorModel != null && model === priorModel;
  // The sizing model plan.md's rule picks (Amendment 1, P2-4).
  const sizing = chooseModel({ complete: A.complete, swP: sw.p, adP: ad.p, lag1P: l1.p, spearmanP: sp.p, zeroInside: zero.inside, kNormal: a.kNormal5, kSmoothed: a.kSmoothed5 });
  // The 30 pad pairs shared with the second run (Amendment 1, P2-6 b).
  const shared = sharedWithPrior(A, run.P, run.Q);
  json.A = { ...a, shapiroWilk: sw, andersonDarling: ad, lag1: l1, spearmanRunOrder: rho, spearmanP: sp.p, commonMedianZero: zero, sizing, sdInterval95: [ciLow, ciHigh], priorSd: PRIOR_SD, priorInside: PRIOR_SD >= ciLow && PRIOR_SD <= ciHigh, fTestP: fP, cpu: { model, priorModel, same: sameCpu, hostId: run.hostId }, sharedWithPrior: shared, retries: run.retries, medians: A.placements.map((p) => ({ i: p.i, seq: p.seq, retryOf: p.retryOf, median: medOf(p), swapped: p.stats[UK].swapped })) };
  out.push("## A: the A/A at K = " + n.KA, "", `aa-old: base-p<p_i> against base-p<q_i>, i = 1..${n.KA}, ${n.R} recorded pairs each after one unrecorded, on \`old\`; ${A.placements.length} of ${n.KA} placements read.`, "");
  out.push("| reading | median of medians | bound (rank) | under +1% |", "| --- | ---: | ---: | --- |",
    `| as recorded | ${fmt(a.across.median)} | ${fmt(a.across.bound)} (${a.across.rank ?? "-"} of ${K}) | ${a.across.bound == null ? "no bound" : a.across.bound < MARGIN ? "yes" : "no"} |`,
    `| labels swapped | ${fmt(a.swapped.median)} | ${fmt(a.swapped.bound)} (${a.swapped.rank ?? "-"} of ${K}) | ${a.swapped.bound == null ? "no bound" : a.swapped.bound < MARGIN ? "yes" : "no"} |`, "",
    `**The A/A ${a.resolution === "resolved" ? "resolves" : "does not resolve"} +1%** (${a.resolution}).`, "");
  out.push(`Placement medians: sd ${mag(a.sd)} (labels swapped ${mag(a.sdSwapped)}), range ${fmt(a.across.min)} to ${fmt(a.across.max)}.`, "");
  if (a.failNormal) out.push(`Normal model at that sd (median zero, ${draws} seeded draws): the two-reading A/A fails ${Object.entries(a.failNormal).map(([k, v]) => `${pct(v).replace("+", "")} at K = ${k}`).join(", ")}; K for at most 5%: ${a.kNormal5 ?? "over 400"}. Resampling these ${K} medians, smoothed (size.mjs's model b): ${pct(a.failSmoothed).replace("+", "")} at K = ${K}. \`node size.mjs <results>/aa-old\` gives the full sizing.`, "");
  out.push("Is the normal model right for these medians?", "", "| test | statistic | p | read |", "| --- | ---: | ---: | --- |",
    `| Shapiro-Wilk (normality) | W = ${Number.isFinite(sw.w) ? sw.w.toFixed(4) : "-"} | ${p3(sw.p)} | ${Number.isFinite(sw.p) ? (sw.p < 0.05 ? "normality rejected at 5%" : "not rejected at 5%") : "too few"} |`,
    `| Anderson-Darling (normality) | A*2 = ${Number.isFinite(ad.a2star) ? ad.a2star.toFixed(3) : "-"} | ${p3(ad.p)} | ${Number.isFinite(ad.p) ? (ad.p < 0.05 ? "normality rejected at 5%" : "not rejected at 5%") : "too few (n < 8)"} |`,
    `| lag-1 autocorrelation in run order | r1 = ${Number.isFinite(l1.r1) ? l1.r1.toFixed(3) : "-"} | ${p3(l1.p)} (permutation) | ${Number.isFinite(l1.p) ? (l1.p < 0.05 ? "neighbours in time are alike: not independent" : "no sign of dependence") : "-"} |`,
    `| Spearman with run order (drift) | rho = ${Number.isFinite(rho) ? rho.toFixed(3) : "-"} | ${p3(sp.p)} (permutation) | ${Number.isFinite(sp.p) ? (sp.p < 0.05 ? "the medians drift with time" : "no sign of drift") : "-"} |`,
    `| common median of zero | ${zero.below} of ${K} below zero | ${p3(zero.signP)} (sign test) | ${zero.inside == null ? "no interval" : `interval ${fmt(zero.low)} to ${fmt(zero.high)} (ranks ${zero.ranks.join(" and ")}, ${mag(zeroCov)}): ${zero.inside ? "zero inside, not rejected" : "zero outside, rejected"}`} |`, "",
    `Run order is time: aa-old's placements ran in schedule.mjs's seeded random order (seed ${run.seed}), so lag-1 and Spearman read the host over time, not the pad index.${run.retries.length ? ` Retried after the schedule: ${run.retries.map((r) => `${r.c} p${r.i} (seq ${r.of} failed, read at seq ${r.seq})`).join(", ")}.` : " No placement was retried."}`, "",
    `**Sizing model (plan.md's rule):** ${sizing.model ? `${sizing.model}, K for at most 5%: ${sizing.K ?? "over 400"} (normal ${a.kNormal5 ?? "over 400"}, smoothed resample ${a.kSmoothed5 ?? "over 400"}); ${sizing.why}.` : `none. ${sizing.why}.`}`, "");
  out.push(`The sd from ${K} medians: ${mag(a.sd)}, 95% interval ${mag(ciLow)} to ${mag(ciHigh)} (chi-square, normal medians). The second run's sd of 1.97% from ${PRIOR_K} medians is ${json.A.priorInside ? "inside" : "outside"} it; the two-sided F test of the two variances gives p = ${p3(fP)}.`, "",
    `CPU: this run ${model ?? "unknown"} (microcode ${run.hostId.microcode || "unknown"}, kernel ${run.hostId.kernel || "unknown"}, randomize_va_space ${run.hostId.randomize_va_space || "unknown"}, ${run.hostId.os || "unknown OS"}); the second run ${priorModel ?? "unknown"}. ${sameCpu ? "The same CPU model, so the interval and F test read whether the second run's 1.97% was chance, as far as one CPU model makes two hosts alike (microcode, kernel and the host's neighbours may still differ)." : "**The CPU model differs from the second run's (or is unknown), so this comparison cannot separate chance from the CPU: a different sd here says the host differs or 1.97% was chance, not which.**"}`, "");
  if (a.within) {
    const part = Math.sqrt(Math.max(0, a.sd ** 2 - a.within.corrected ** 2));
    out.push(`From within: ${n.R} pairs alone give a placement median an sd of ${mag(a.within.corrected)} (leave-one-out residuals rescaled), between ${mag(a.within.pooled)} and ${mag(a.within.loo)}; the normal formula gives ${mag(a.within.normal)}. What is left of the medians' sd for placement: about ${mag(part)}.`, "");
  }

  if (shared.read) out.push(`Shared with the second run (prior/${PRIOR_ID}, the same 30 pad pairs, i = 1..30): Spearman rho ${shared.rho.toFixed(3)} between the two runs' placement medians (Pearson r ${shared.pearson.toFixed(3)}), one-sided permutation p = ${p3(shared.p)}: ${shared.p < 0.05 ? "the A/A spread carries a part each pad pair keeps from one run to the next (placement)" : "no sign that a pad pair's median carries over between the runs (noise, or a placement part another host or build does not keep)"}. Base's unpadded binary ${run.shas.get("base") === shared.priorBase ? "is" : "is not"} the second run's, and the CPU model ${sameCpu ? "is" : "is not (or is not known to be)"} the same.`, "");
  else out.push(`Shared with the second run (prior/${PRIOR_ID}): not read, ${shared.why}.`, "");

  // B
  if (results["same-old"]) {
    const Br = results["same-old"], b = aaPart(Br, n, draws);
    json.B = { ...b, medians: Br.placements.map((p) => ({ i: p.i, median: medOf(p) })) };
    const own = Math.sqrt(Math.max(0, a.sd ** 2 - b.sd ** 2)), Fb = (a.sd / b.sd) ** 2, fbP = 2 * Math.min(fCdf(Fb, K - 1, Br.placements.length - 1), 1 - fCdf(Fb, K - 1, Br.placements.length - 1));
    json.B.padListPart = own; json.B.fTestP = fbP;
    out.push("## B: one pad list against itself", "", `same-old: base-p<p_i> against the same binary, i = 1..${n.KB}, ${n.R} pairs each; ${Br.placements.length} of ${n.KB} read. No placement differs between its sides, so its medians' spread is everything but placement.`, "",
      `Median of medians ${fmt(b.across.median)}, bound ${fmt(b.across.bound)} (swapped ${fmt(b.swapped.bound)}), ${b.resolution}. Placement medians' sd ${mag(b.sd)}; from within ${mag(b.within?.corrected)}.`, "",
      `A's sd ${mag(a.sd)} against B's ${mag(b.sd)}: F test p = ${p3(fbP)}; the pad lists' own part, sqrt(A^2 - B^2), about ${mag(own)}.`, "");
  } else out.push("## B: one pad list against itself", "", "Not in this plan (K_B = 0): cut for time, plan.md \"Time\".", "");

  // C
  if (n.KC) {
    const C = Object.fromEntries(UNPADDED.map((c) => [c, results[c]]));
    const byPad = (c) => new Map(C[c].placements.map((p) => [p.i, p]));
    out.push("## C: unpadded against padded (#1996)", "", `Each comparison: A the unpadded build, B a padded one (pads p_1..p_${n.KC}), ${n.RC} pairs after one unrecorded. A negative offset is a padded placement cheaper than the unpadded build. Intervals: the order-statistic interval of a median (coverage given), and for paired differences also the mean with its 90% t interval.`, "",
      "| comparison | read | median offset | interval (coverage) | padded cheaper than unpadded | sign test p | median instructions:u change |", "| --- | ---: | ---: | --- | ---: | ---: | ---: |");
    json.C = {};
    for (const c of UNPADDED) {
      const r = C[c], m = r.placements.map((p) => medOf(p)), iv = medianInterval(m), below = m.filter((x) => x < 0).length, ins = median(r.placements.map((p) => medOf(p, IU)));
      json.C[c] = { complete: r.complete, medians: r.placements.map((p) => ({ i: p.i, seq: p.seq, median: medOf(p), instructions: medOf(p, IU) })), offset: iv, below, signP: signTest(below, m.length), instructions: ins };
      out.push(`| ${c} | ${m.length} of ${r.k} | ${fmt(iv.median)} | ${r.complete && iv.low != null ? `${fmt(iv.low)} to ${fmt(iv.high)} (${pct(iv.coverage).replace("+", "")})` : "none"} | ${below} of ${m.length} | ${p3(signTest(below, m.length))} | ${fmt(ins)} |`);
    }
    out.push("", "Paired by pad (the same pad on both comparisons' padded side):", "", "| difference | pads | median | interval (coverage) | mean | 90% t interval | read |", "| --- | ---: | ---: | --- | ---: | --- | --- |");
    const near = Number(env.INSTR_NEAR) / 100;
    for (const c of ["unpadded-head", "unpadded-x1", "unpadded-x2"]) {
      const bp = byPad("unpadded-base"), cp = byPad(c), d = [];
      for (const [i, p] of cp) if (bp.has(i)) d.push(medOf(p) - medOf(bp.get(i)));
      const iv = medianInterval(d), mu = mean(d), half = d.length > 1 ? (tQuantile(0.95, d.length - 1) * sd(d)) / Math.sqrt(d.length) : NaN;
      const ok = C[c].complete && C["unpadded-base"].complete;
      const what = c === "unpadded-head" ? "head's offset less base's: does the change move what a pad does?" : `${c.slice(9)}'s offset less base's`;
      let read = ok && iv.low != null ? (iv.low > 0 || iv.high < 0 ? "differs from zero" : "zero inside") : "no interval";
      if (c !== "unpadded-head") {
        const ins = json.C[c].instructions, isNear = Math.abs(ins) <= near;
        json.C[c].near = isNear;
        read += `; instructions ${fmt(ins)}: ${isNear ? `within ${env.INSTR_NEAR}%, compiles old's path nearly as base` : `beyond ${env.INSTR_NEAR}%, its offset mixes code with placement`}`;
      }
      json.C[c].pairedWithBase = { d, interval: ok ? iv : null, mean: mu, tHalf: half };
      out.push(`| ${what} | ${d.length} | ${fmt(iv.median)} | ${ok && iv.low != null ? `${fmt(iv.low)} to ${fmt(iv.high)} (${pct(iv.coverage).replace("+", "")})` : "none"} | ${fmt(mu)} | ${ok ? `${fmt(mu - half)} to ${fmt(mu + half)}` : "none"} | ${read} |`);
    }
    const above = UNPADDED.filter((c) => c !== "unpadded-head").map((c) => `${c.slice(9)} ${json.C[c].below} of ${json.C[c].medians.length}`);
    out.push("", `Unpadded builds of base's code (base, x1, x2) above their padded placements: ${above.join(", ")}; head above its own: ${json.C["unpadded-head"].below} of ${json.C["unpadded-head"].medians.length}.`, "");
    const rk = rankAgainstPadded(A, C);
    json.C.rankAgainstPadded = rk;
    out.push(`Against A's ${rk.n} padded placements (base's code at every p_i and q_i, run through the session): each unpadded build's cost a request, the median of its ${n.KC} turns' medians, ranked among theirs. p is the chance that a placement like the padded ones costs at least as much (one-sided).`, "",
      "| unpadded build | cycles/request | padded placements cheaper | p | read |", "| --- | ---: | ---: | ---: | --- |");
    for (const c of UNPADDED) {
      const x = rk.rows[c];
      const read = !x.read ? "no read (incomplete)" : `${x.p < 0.05 ? "dearer than the padded placements at large" : "among the padded placements"}${c === "unpadded-head" ? "; head's code is not base's, so its rank mixes code with placement" : ""}`;
      out.push(`| ${c.slice(9)} | ${Number.isFinite(x.own) ? x.own.toFixed(0) : "-"} | ${x.below} of ${x.of} | ${p3(x.p)} | ${read} |`);
    }
    out.push("", `The padded costs against run order: Spearman rho ${Number.isFinite(rk.drift.rho) ? rk.drift.rho.toFixed(3) : "-"}, permutation p = ${p3(rk.drift.p)}: ${Number.isFinite(rk.drift.p) ? (rk.drift.p < 0.05 ? "the costs drift in time, so these ranks mix the host's drift with placement" : "no sign of drift in the costs") : "-"}.`, "");
    const prior = join(here, "prior", "0c0c599c", "sha256.txt");
    if (existsSync(prior)) {
      const ps = readFileSync(prior, "utf8").split("\n").find((l) => l.startsWith("base "))?.split(" ")[1];
      out.push(`Base's unpadded binary ${ps === run.shas.get("base") ? "is" : "is not"} byte-identical to the second run's (prior/0c0c599c/sha256.txt).`, "");
    }
  }

  // per-placement tables
  for (const [c, r] of Object.entries(results)) {
    out.push(`### ${c}`, "", `Starts: ${r.starts}, every Age ${r.ageMin} to ${r.ageMax} (range ${env.OLD_LOW} to ${env.OLD_HIGH}), the handler run once each.`, "",
      "| placement | seq | A | B | A cycles/request | B cycles/request | median change | range | swapped | instructions:u | L1i misses:u |", "| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |");
    for (const p of r.placements) {
      const g = p.stats[UK];
      out.push(`| ${p.i} | ${p.seq} | ${p.A} | ${p.B} | ${g.a.toFixed(0)} | ${g.b.toFixed(0)} | ${pct(g.median)} | ${pct(g.min)} to ${pct(g.max)} | ${pct(g.swapped)} | ${pct(p.stats[IU].median)} | ${pct(p.stats["L1i misses user"].median)} |`);
    }
    out.push("");
  }
  const code = Object.values(results).every((r) => r.complete) ? 0 : 1;
  json.exit = code;
  return { json, text: out.join("\n"), code };
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (main) {
  const args = process.argv.slice(2), at = args.indexOf("--declared");
  const declared = at >= 0 ? args[at + 1] : here, dir = args.find((x, j) => !x.startsWith("--") && args[j - 1] !== "--declared");
  if (!dir) { console.error("usage: node report.mjs <results dir> [--declared <dir>]"); process.exit(2); }
  try {
    const r = report(dir, declared);
    writeFileSync(join(dir, "report.json"), JSON.stringify(r.json, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v), 1) + "\n");
    console.log(r.text);
    process.exitCode = r.code;
  } catch (e) {
    // An error in report.mjs, not in the results: exit 3, never 1 (an incomplete comparison).
    console.error(`report.mjs failed: ${e?.stack ?? e}`);
    process.exitCode = 3;
  }
}