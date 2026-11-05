// Whether Corten's numbers drift across full rounds (r<n>): a few percent worse each round, which no single
// round's comparison (differences under about 10% are noise) would flag. Reads every round's
// summary.json and commit.txt in results/, oldest commit first, and for each tracked number
// compares the latest round with a fixed baseline (trend-baseline.json, else the oldest round)
// and with the median of the rounds before it, and keeps a one-sided CUSUM of how much worse
// than the baseline each round is, past the number's own noise. A number has drifted when that
// sum passes three times its noise and the last two rounds are both worse than the baseline by
// more than the noise: one noisy round, however far off, is not a drift. A worsening accepted on
// purpose (a feature that costs instructions) is taken in by naming a later round in
// trend-baseline.json ({ "round": "r15" }), so it is not reported again.
// Usage: node trend.mjs [round]   (the round to end at; the latest by default)
// Writes results/<round>/trend.json and prints a table; "DRIFT" lines name what drifted.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The numbers tracked, Corten's only: the steady ones first. `noise` is how far apart two rounds
 * of one commit land (a share): instruction counts move under 1% between rounds (r13 to r14:
 * -0.4% while throughput moved -20.4%), bytes not at all, CPU-seconds and throughput by about 10%.
 * A number the machine's speed moves (`host`) is compared only between rounds on the latest round's
 * CPU model (host.txt), since droplets of one size come on different CPUs.
 * @type {{ name: string, unit: string, better: "lower" | "higher", noise: number, host?: boolean, of: (s: any) => number | null | undefined }[]}
 */
export const metrics = [
  { name: "instructions, item page", unit: "per request", better: "lower", noise: 0.01, of: (s) => s.instructions?.["corten/page"]?.user },
  { name: "instructions, item JSON", unit: "per request", better: "lower", noise: 0.01, of: (s) => s.instructions?.["corten/json"]?.user },
  { name: "page HTML, gzip", unit: "bytes", better: "lower", noise: 0.005, of: (s) => s.bytes?.corten?.html?.gzip },
  { name: "page JS, gzip", unit: "bytes", better: "lower", noise: 0.005, of: (s) => s.bytes?.corten?.js?.gzip },
  { name: "page CSS, gzip", unit: "bytes", better: "lower", noise: 0.005, of: (s) => s.bytes?.corten?.css?.gzip },
  { name: "peak memory, 64 users", unit: "MiB", better: "lower", noise: 0.05, host: true, of: (s) => s.ssr?.fixture?.corten?.sat64?.memMaxMiB },
  { name: "requests per CPU-second, fixed rate", unit: "/CPU-s", better: "higher", noise: 0.1, host: true, of: (s) => s.ssr?.fixture?.corten?.fixed?.perCpuSecond },
  { name: "requests a second, 64 users", unit: "/s", better: "higher", noise: 0.1, host: true, of: (s) => s.ssr?.fixture?.corten?.sat64?.rps },
];

/** How many noises the sum may reach before a sustained worsening is a drift. */
export const SUM_LIMIT = 3;
/** The rounds before the latest whose median it is also compared with. */
export const WINDOW = 5;

/**
 * One number across rounds, oldest first, against the first round from `base` on that has it: each
 * round's share worse than the baseline (`worse`, log scale, positive is worse), the CUSUM, and
 * the verdict for the latest round.
 * @param {(number | null | undefined)[]} values one per round, oldest first
 * @param {number} base the baseline's index
 * @param {{ better: "lower" | "higher", noise: number }} metric
 */
export function trendOf(values, base, { better, noise }) {
  base = values.findIndex((v, i) => i >= base && typeof v === "number" && v > 0);
  const baseline = base < 0 ? undefined : values[base];
  /** @type {{ at: number, value: number, worse: number, sum: number }[]} */
  const points = [];
  if (!(typeof baseline === "number" && baseline > 0)) return { points, verdict: /** @type {"drift" | "ok" | "unknown"} */ ("unknown"), sum: 0 };
  let sum = 0;
  for (let at = base + 1; at < values.length; at += 1) {
    const value = values[at];
    // A round without the number (a step skipped) neither adds to the sum nor resets it.
    if (!(typeof value === "number" && value > 0)) continue;
    const worse = better === "lower" ? Math.log(value / baseline) : Math.log(baseline / value);
    sum = Math.max(0, sum + worse - noise);
    points.push({ at, value, worse, sum });
  }
  const [before, last] = points.slice(-2);
  const sustained = points.length >= 2 && before.worse > noise && last.worse > noise;
  const verdict = sum > SUM_LIMIT * noise && sustained ? "drift" : "ok";
  return { points, verdict: /** @type {"drift" | "ok" | "unknown"} */ (verdict), sum };
}

/** The median of some numbers (the lower middle of an even count), or null. @param {number[]} xs */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

/** A share as a signed percent, worse positive. @param {number} share */
const pct = (share) => +(100 * share).toFixed(2);

/**
 * The report for rounds given oldest first: each tracked number against the baseline and the
 * median of the `WINDOW` rounds before the latest.
 * @param {{ round: string, commit: string | null, cpu?: string | null, summary: any }[]} rounds
 * @param {string | undefined} baselineRound
 */
export function report(rounds, baselineRound) {
  const base = Math.max(0, rounds.findIndex((r) => r.round === baselineRound));
  const latest = rounds[rounds.length - 1];
  const out = {
    format: 1,
    baseline: { round: rounds[base]?.round, commit: rounds[base]?.commit },
    latest: { round: latest?.round, commit: latest?.commit, cpu: latest?.cpu ?? null },
    commits: rounds[base]?.commit && latest?.commit ? `${rounds[base].commit.slice(0, 12)}..${latest.commit.slice(0, 12)}` : null,
    rounds: rounds.map((r) => r.round),
    /** @type {any[]} */
    metrics: [],
    /** @type {string[]} */
    drift: [],
  };
  for (const metric of metrics) {
    // A number the machine moves, only from rounds on the latest one's CPU.
    const values = rounds.map((r) => (metric.host && r.cpu !== latest?.cpu ? null : metric.of(r.summary)));
    const t = trendOf(values, base, metric);
    const last = values[values.length - 1];
    const from = values.findIndex((v, i) => i >= base && typeof v === "number" && v > 0);
    const prior = values.slice(Math.max(0, values.length - 1 - WINDOW), -1).filter((v) => typeof v === "number" && v > 0);
    const rolling = median(/** @type {number[]} */ (prior));
    const worseThan = (/** @type {number | null | undefined} */ from) =>
      typeof from === "number" && from > 0 && typeof last === "number" && last > 0 ? pct(metric.better === "lower" ? last / from - 1 : from / last - 1) : null;
    out.metrics.push({
      name: metric.name,
      unit: metric.unit,
      better: metric.better,
      noisePct: pct(metric.noise),
      baseline: from < 0 ? null : values[from],
      baselineRound: from < 0 ? null : rounds[from].round,
      latest: last ?? null,
      worseThanBaselinePct: from < 0 ? null : worseThan(values[from]),
      rollingMedian: rolling,
      worseThanRollingPct: worseThan(rolling),
      cusumPct: pct(t.sum),
      limitPct: pct(SUM_LIMIT * metric.noise),
      verdict: t.verdict,
      series: rounds.map((r, i) => ({ round: r.round, value: values[i] ?? null })),
    });
    if (t.verdict === "drift") out.drift.push(metric.name);
  }
  return out;
}

/**
 * The full rounds in `results` (`r<n>`, the ones run on the same terms) that have a commit and a
 * summary, oldest commit first (then by name). An experiment's round (an A/B, a few apps) is left
 * out: it may have measured a branch.
 * @param {string} results
 */
export function roundsIn(results) {
  const time = (/** @type {string} */ commit) => {
    const r = spawnSync("git", ["show", "-s", "--format=%ct", commit], { encoding: "utf8" });
    return r.status === 0 ? Number(r.stdout.trim()) : Infinity;
  };
  return readdirSync(results, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^r\d+$/.test(d.name) && existsSync(join(results, d.name, "commit.txt")) && existsSync(join(results, d.name, "summary.json")))
    .map((d) => {
      const commit = readFileSync(join(results, d.name, "commit.txt"), "utf8").trim() || null;
      const host = join(results, d.name, "host.txt");
      const cpu = existsSync(host) ? (/^Model name:\s*(.+)$/m.exec(readFileSync(host, "utf8"))?.[1].trim() ?? null) : null;
      return { round: d.name, commit, cpu, at: commit ? time(commit) : Infinity, summary: JSON.parse(readFileSync(join(results, d.name, "summary.json"), "utf8")) };
    })
    .sort((a, b) => a.at - b.at || a.round.localeCompare(b.round, "en", { numeric: true }));
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = join(here, "results");
  let rounds = roundsIn(results);
  const to = process.argv[2];
  if (to) {
    const end = rounds.findIndex((r) => r.round === to);
    if (end < 0) throw new Error(`no round ${to} with a commit.txt and a summary.json in results/`);
    rounds = rounds.slice(0, end + 1);
  }
  if (rounds.length < 2) throw new Error("a trend needs two rounds with a commit.txt and a summary.json");
  const baselineFile = join(here, "trend-baseline.json");
  const baselineRound = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")).round : undefined;
  if (baselineRound && !rounds.some((r) => r.round === baselineRound)) console.log(`trend-baseline.json names ${baselineRound}, which is not among these rounds: the oldest is the baseline`);
  const out = report(rounds, baselineRound);
  writeFileSync(join(results, out.latest.round, "trend.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`Trend, ${out.rounds.join(", ")}: ${out.latest.round} against ${out.baseline.round} (${out.commits ?? "commits unknown"}) and the median of the ${WINDOW} rounds before it`);
  const cell = (/** @type {number | null} */ p) => (p === null ? "-" : `${p > 0 ? "+" : ""}${p}%`);
  console.log("| Number | Baseline | Latest | Worse than baseline | Worse than recent median | Sum (limit) | |");
  for (const m of out.metrics) {
    console.log(`| ${m.name} | ${m.baseline ?? "-"} | ${m.latest ?? "-"} | ${cell(m.worseThanBaselinePct)} | ${cell(m.worseThanRollingPct)} | ${m.cusumPct}% (${m.limitPct}%) | ${m.verdict === "drift" ? "DRIFT" : m.verdict} |`);
  }
  for (const name of out.drift) console.log(`DRIFT: ${name} has been worse than ${out.baseline.round} by more than its noise for two rounds or more, in ${out.commits}`);
}
