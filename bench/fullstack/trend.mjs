// Whether Corten's numbers drift across full rounds (r<n>): a few percent worse each round, which
// no single round's comparison (differences under about 10% are noise) would flag. Reads every
// full round's summary.json and commit (commit.txt, else conformance.json's imagesFrom) in
// results/, oldest commit first, and for each tracked number compares the latest round with its
// accepted baseline (trend-baseline.json) and with the median of the rounds before the last two
// (at least three of the five before them). A round
// whose images were built from a tree with changes is marked dirty: its numbers may not be the
// commit's.
//
// A number with a verdict keeps a one-sided CUSUM: the sum of each round's share worse than the
// baseline less the number's noise, never below zero. It has drifted ("drift") when that sum passes
// three times its noise, each round adding no more than the worse of the rounds beside it, and the
// last two rounds are both worse than the baseline by more than the noise, so a noisy round on its
// own, however far off, is not a drift and does not help a later one become one. A round no worse
// than the baseline starts the sum again, so a fixed regression does not linger in it (one noisy
// low round does the same, delaying a slow drift). It is a warning ("warn") when the last two
// rounds are both worse than the median of at least three rounds before them, from the baseline on,
// by more than the noise and at least 3%, and it has not drifted: a recent step that holds. A
// latest round without the number has no verdict. Throughput and CPU-seconds move 20% between rounds of
// one commit on one CPU model, more than a drift worth catching, so they are shown with no verdict.
//
// A worsening accepted on purpose (a feature that costs bytes) moves that number's baseline only:
// trend-baseline.json { "round": "r14", "why": "..", "metrics": { "<name>": { "round": "r16",
// "why": ".." } } }.
// Usage: node trend.mjs [round]   (the round to end at; the latest by default)
// Writes results/<round>/trend.json and prints a table; "DRIFT:" and "WARN:" lines name what moved.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The numbers tracked, Corten's only, the steady ones first. `noise` is how far apart two rounds
 * of one commit land (a share): a round's three instruction counts spread at most 0.7% (r14's page:
 * 105,147 to 105,826), bytes not at all, peak memory 2.4% (16.3 to 16.7 MiB over r8 to r14; 5%
 * with a margin).
 * `verdict: false` is a number shown for context only: throughput moved 20% between rounds on
 * one CPU model (r12 to r13 +22%, r13 to r14 -20%).
 * @type {{ name: string, unit: string, better: "lower" | "higher", noise: number, verdict?: false, of: (s: any) => number | null | undefined }[]}
 */
export const metrics = [
  { name: "instructions, item page", unit: "per request", better: "lower", noise: 0.01, of: (s) => s.instructions?.["corten/page"]?.user },
  { name: "instructions, item JSON", unit: "per request", better: "lower", noise: 0.01, of: (s) => s.instructions?.["corten/json"]?.user },
  { name: "page HTML, gzip", unit: "bytes", better: "lower", noise: 0.005, of: (s) => s.bytes?.corten?.html?.gzip },
  { name: "page JS, gzip", unit: "bytes", better: "lower", noise: 0.005, of: (s) => s.bytes?.corten?.js?.gzip },
  { name: "page CSS, gzip", unit: "bytes", better: "lower", noise: 0.005, of: (s) => s.bytes?.corten?.css?.gzip },
  { name: "peak memory, 64 users", unit: "MiB", better: "lower", noise: 0.05, of: (s) => s.ssr?.fixture?.corten?.sat64?.memMaxMiB },
  { name: "requests per CPU-second, fixed rate", unit: "/CPU-s", better: "higher", noise: 0.2, verdict: false, of: (s) => s.ssr?.fixture?.corten?.fixed?.perCpuSecond },
  { name: "requests a second, 64 users", unit: "/s", better: "higher", noise: 0.2, verdict: false, of: (s) => s.ssr?.fixture?.corten?.sat64?.rps },
];

/** How many noises the sum may reach before a sustained worsening is a drift. */
export const SUM_LIMIT = 3;
/** The rounds before the latest whose median it is also compared with. */
export const WINDOW = 5;
/** The fewest rounds that median takes: with one or two, one unusual round would set it. */
export const MEDIAN_OF = 3;
/** The least step from that median a warning names, whatever the number's noise. */
export const WARN_AT = 0.03;

/** A number a round measured. @param {unknown} v @returns {v is number} */
const has = (v) => typeof v === "number" && v > 0;

/** The median of some numbers (the lower middle of an even count), or null. @param {number[]} xs */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

/**
 * One number across rounds, oldest first, from its baseline at `base`: each later round's share
 * worse than the baseline (log scale, positive is worse), the CUSUM, and the verdict for the
 * latest round.
 * @param {(number | null | undefined)[]} values one per round, oldest first
 * @param {number} base the baseline round's index; it must have the number
 * @param {{ better: "lower" | "higher", noise: number }} metric
 */
export function trendOf(values, base, { better, noise }) {
  const baseline = values[base];
  /** @type {{ at: number, value: number, worse: number, held: number, sum: number }[]} */
  const points = [];
  if (!has(baseline)) return { points, verdict: /** @type {"drift" | "warn" | "ok" | "unknown"} */ ("unknown"), sum: 0 };
  const worseThan = (/** @type {number} */ from, /** @type {number} */ value) => (better === "lower" ? Math.log(value / from) : Math.log(from / value));
  for (let at = base + 1; at < values.length; at += 1) {
    const value = values[at];
    // A round without the number (a step skipped) neither adds to the sum nor resets it.
    if (!has(value)) continue;
    points.push({ at, value, worse: worseThan(baseline, value), held: 0, sum: 0 });
  }
  // What a round adds to the sum is its share worse, but no more than the worse of its neighbours'
  // (the one before it for the latest): a round off on its own, however far and wherever it
  // falls, adds only what the rounds beside it do, while a step that holds two rounds counts in
  // full. Without it one outlier would leave the sum high for many rounds and let a later pair
  // just past the noise through.
  let sum = 0;
  for (const [i, p] of points.entries()) {
    const beside = Math.max(points[i - 1]?.worse ?? -Infinity, points[i + 1]?.worse ?? -Infinity);
    p.held = beside === -Infinity ? 0 : Math.min(p.worse, beside);
    // A round no worse than the baseline (a fixed regression, or a noisy low round) starts the
    // sum again.
    sum = p.sum = p.worse <= 0 ? 0 : Math.max(0, sum + p.held - noise);
  }
  const [before, last] = points.slice(-2);
  /** The median of the rounds before the last two (from the baseline on), when there are enough. */
  let recent = /** @type {number | null} */ (null);
  if (points.length >= 2) {
    const prior = values.slice(Math.max(base, before.at - WINDOW), before.at).filter(has);
    if (prior.length >= MEDIAN_OF) recent = median(prior);
  }
  // The verdict is the latest round's: one without the number has none.
  if (!has(values[values.length - 1])) return { points, verdict: /** @type {const} */ ("unknown"), sum, recent };
  /** @type {"drift" | "warn" | "ok"} */
  let verdict = "ok";
  if (points.length >= 2 && before.worse > noise && last.worse > noise && sum > SUM_LIMIT * noise) verdict = "drift";
  else if (recent !== null) {
    // A recent step that holds: the last two both worse than that median by more than the noise
    // and at least `WARN_AT`.
    const at = Math.max(noise, WARN_AT);
    if (worseThan(recent, before.value) > at && worseThan(recent, last.value) > at) verdict = "warn";
  }
  return { points, verdict, sum, recent };
}

/** A share as a signed percent, worse positive. @param {number} share */
const pct = (share) => +(100 * share).toFixed(2);

/**
 * The baseline round of each number: its own in `metrics`, else the file's `round`.
 * @typedef {{ round: string, why?: string, metrics?: Record<string, { round: string, why: string }> }} Baselines
 */

/**
 * The report for rounds given oldest first: each tracked number against its baseline round and the
 * median of the `WINDOW` rounds before the latest. A baseline round not among `rounds`, or
 * one without the number, is an error: no number is compared with a round it was not given.
 * @param {{ round: string, commit: string | null, dirty?: boolean, summary: any }[]} rounds
 * @param {Baselines} baselines
 */
export function report(rounds, baselines) {
  const latest = rounds[rounds.length - 1];
  const index = (/** @type {string} */ round) => {
    const at = rounds.findIndex((r) => r.round === round);
    if (at < 0) throw new Error(`the baseline ${round} is not among the rounds ${rounds.map((r) => r.round).join(", ")}`);
    return at;
  };
  const range = (/** @type {number} */ from) =>
    rounds[from].commit && latest.commit ? `${rounds[from].commit?.slice(0, 12)}..${latest.commit.slice(0, 12)}` : null;
  const out = {
    format: 1,
    // dirty: the latest round's images were built from a tree with changes, so its numbers may
    // not be its commit's alone.
    latest: { round: latest.round, commit: latest.commit, dirty: latest.dirty === true },
    dirtyRounds: rounds.filter((r) => r.dirty).map((r) => r.round),
    rounds: rounds.map((r) => r.round),
    // Where each round's numbers come from, in this repository.
    // (`raw` is set by the caller, which can see which of a round's raw files it has.)
    artifacts: { summary: `bench/fullstack/results/${latest.round}/summary.json`, raw: /** @type {string | null} */ (null) },
    /** @type {any[]} */
    metrics: [],
    /** @type {string[]} */
    drift: [],
    /** @type {string[]} */
    warn: [],
  };
  for (const metric of metrics) {
    const own = baselines.metrics?.[metric.name];
    const base = index(own?.round ?? baselines.round);
    const values = rounds.map((r) => metric.of(r.summary));
    if (!has(values[base])) throw new Error(`the baseline ${rounds[base].round} has no "${metric.name}": name another round for it in trend-baseline.json`);
    const t = trendOf(values, base, metric);
    const last = values[values.length - 1];
    // The median the warning compares with (the rounds before the last two, from the baseline on).
    const rolling = t.recent;
    // The share worse than `from`: above it for a number that should be lower, below it for one
    // that should be higher (14,460 against 23,898 a second is 39.5% worse).
    const worseThan = (/** @type {number | null | undefined} */ from) =>
      has(from) && has(last) ? pct(metric.better === "lower" ? last / from - 1 : 1 - last / from) : null;
    const verdict = metric.verdict === false ? "none" : t.verdict;
    out.metrics.push({
      name: metric.name,
      unit: metric.unit,
      better: metric.better,
      noisePct: pct(metric.noise),
      baselineRound: rounds[base].round,
      baselineSummary: `bench/fullstack/results/${rounds[base].round}/summary.json`,
      baselineWhy: own?.why ?? baselines.why ?? null,
      commits: range(base),
      baseline: values[base],
      latest: has(last) ? last : null,
      worseThanBaselinePct: worseThan(values[base]),
      // A number with no verdict moves with the droplet's CPU model, so the median of rounds that
      // ran on different ones says more about the CPUs than the code: it is left out.
      rollingMedian: metric.verdict === false ? null : rolling,
      worseThanRollingPct: metric.verdict === false ? null : worseThan(rolling),
      cusumPct: pct(t.sum),
      limitPct: pct(SUM_LIMIT * metric.noise),
      verdict,
      series: rounds.map((r, i) => ({ round: r.round, value: has(values[i]) ? values[i] : null })),
    });
    if (verdict === "drift") out.drift.push(metric.name);
    if (verdict === "warn") out.warn.push(metric.name);
  }
  return out;
}

/**
 * The full rounds in `results` (`r<n>`, the ones run on the same terms) that have a commit and a
 * summary, oldest commit first. An experiment's round (an A/B, a few apps) is left out: it may have
 * measured a branch. A commit this repository does not have is an error, since the order would be
 * a guess.
 * @param {string} results
 */
export function roundsIn(results) {
  const commitOf = (/** @type {string} */ round) => {
    const file = join(results, round, "commit.txt");
    const conformance = join(results, round, "conformance.json");
    const from = existsSync(conformance) ? JSON.parse(readFileSync(conformance, "utf8")).imagesFrom : null;
    const recorded = typeof from === "string" && /^[0-9a-f]{40}(-dirty)?$/.test(from) ? from : null;
    // The commit the automation wrote, and whether conform.mjs saw the tree dirty, which commit.txt
    // does not say.
    if (existsSync(file)) return { commit: readFileSync(file, "utf8").trim(), dirty: recorded?.endsWith("-dirty") === true };
    // A round droplet.mjs has just collected has no commit.txt yet (the nightly automation writes
    // it after the collect), but conform.mjs recorded the commit its images were built from
    // ("-dirty" when the tree had changes: the commit still places it among the rounds, and the
    // round is marked dirty so a drift it shows is not credited to that commit alone).
    if (!recorded) return null;
    return { commit: recorded.replace(/-dirty$/, ""), dirty: recorded.endsWith("-dirty") };
  };
  const time = (/** @type {string} */ round, /** @type {string} */ commit) => {
    const r = spawnSync("git", ["-C", here, "show", "-s", "--format=%ct", commit], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${round}'s commit ${commit} is not in this repository (a shallow clone?): git fetch it first`);
    return Number(r.stdout.trim());
  };
  return readdirSync(results, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^r\d+$/.test(d.name) && existsSync(join(results, d.name, "summary.json")))
    .flatMap((d) => {
      const of = commitOf(d.name);
      if (!of) return [];
      const { commit, dirty } = of;
      return [{ round: d.name, commit, dirty, at: time(d.name, commit), summary: JSON.parse(readFileSync(join(results, d.name, "summary.json"), "utf8")) }];
    })
    .sort((a, b) => a.at - b.at || a.round.localeCompare(b.round, "en", { numeric: true }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = join(here, "results");
  let rounds = roundsIn(results);
  const to = process.argv[2];
  if (to) {
    const end = rounds.findIndex((r) => r.round === to);
    if (end < 0) throw new Error(`no round ${to} with a summary.json and a commit (commit.txt, or conformance.json's imagesFrom) in results/`);
    rounds = rounds.slice(0, end + 1);
  }
  /** @type {Baselines} */
  const baselines = JSON.parse(readFileSync(join(here, "trend-baseline.json"), "utf8"));
  const out = report(rounds, baselines);
  const raw = ["raw.tar.xz", "raw.txt"].find((name) => existsSync(join(results, out.latest.round, name)));
  out.artifacts.raw = raw ? `bench/fullstack/results/${out.latest.round}/${raw}` : null;
  writeFileSync(join(results, out.latest.round, "trend.json"), JSON.stringify(out, null, 1) + "\n");
  const tree = (/** @type {string} */ round) => (out.dirtyRounds.includes(round) ? " (dirty tree)" : "");
  console.log(`Trend of ${out.latest.round} (${out.latest.commit?.slice(0, 12)}${tree(out.latest.round)}) against each number's baseline round and the median of the ${WINDOW} rounds before it; rounds ${out.rounds.join(", ")}`);
  const cell = (/** @type {number | null} */ p) => (p === null ? "-" : `${p > 0 ? "+" : ""}${p}%`);
  console.log("| Number | Baseline | Latest | Worse than baseline | Worse than recent median | Sum (limit) | |");
  for (const m of out.metrics) {
    console.log(`| ${m.name} | ${m.baseline} (${m.baselineRound}) | ${m.latest ?? "-"} | ${cell(m.worseThanBaselinePct)} | ${cell(m.worseThanRollingPct)} | ${m.verdict === "none" ? "-" : `${m.cusumPct}% (${m.limitPct}%)`} | ${m.verdict === "none" ? "no verdict (noise)" : m.verdict.toUpperCase()} |`);
  }
  // The rounds a verdict rests on (the baseline's to the latest) that were built from a dirty tree.
  const dirtyIn = (/** @type {any} */ m) => {
    const from = out.rounds.indexOf(m.baselineRound);
    const dirty = out.rounds.slice(from).filter((r) => out.dirtyRounds.includes(r));
    return dirty.length ? `, built from a dirty tree: ${dirty.join(", ")}` : "";
  };
  for (const m of out.metrics.filter((x) => x.verdict === "drift")) console.log(`DRIFT: ${m.name} is ${cell(m.worseThanBaselinePct)} against ${m.baselineRound}, worse by more than its ${m.noisePct}% noise for two rounds or more; commits ${m.commits}${dirtyIn(m)}; ${out.artifacts.summary} against ${m.baselineSummary}`);
  for (const m of out.metrics.filter((x) => x.verdict === "warn")) console.log(`WARN: ${m.name} is ${cell(m.worseThanRollingPct)} against the median of the rounds before the last two (${m.rollingMedian}), for two rounds; commits ${m.commits}${dirtyIn(m)}`);
}
