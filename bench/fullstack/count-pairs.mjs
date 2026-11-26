// count-pairs.mjs: the catalog count of a change, the base's image against the head's, with its
// own A/A, the base's image against itself, in the same run (CONTRIBUTING.md, Pull requests,
// item 2; docs/design.md#choice-placement-runs, "The catalog's `page` and `json`").
//
//   node bench/fullstack/count-pairs.mjs <prefix> <base image> <head image> [pairs=100] [targets=page,json]
//
// with BENCH_APP_CPUS and BENCH_LOAD_CPUS as count.mjs reads them. Each invocation is one run of
// `count.mjs <round> 1 corten <target>` with the side's image, by the ID pinned when the run
// started, tagged `cb-corten` first. For each target, pair i is two comparisons of two
// invocations each: the change, sides `base` (the base's image) and `head` (the head's), and its
// A/A, the same two names with the base's image under both. Pair 0 is not recorded; pairs 1 to
// <pairs> are. In odd pairs the side named `base` goes first and the A/A before the change; in
// even pairs `head` and the change. So a run is four invocations a pair and target where a count
// without its A/A is two: twice the time.
//
// A pair's change is the second side over the first less 1 (`head` / `base` - 1) in user plus
// kernel cycles a request; the bound is the j-th smallest of the n recorded changes, j the
// smallest rank with P(Binomial(n, 1/2) >= j) <= 5% (the 59th of 100). The A/A is read twice, as
// recorded and with its labels swapped (`base` / `head` - 1), as bench/placement reads one. It
// resolves when both of its bounds less +1% are inside the default band; then the change's bound
// less +1% is read against the band as item 2 reads it: above, a miss; below, it meets +1%;
// inside, not decided. Where the A/A has both bounds and does not resolve, the change is "not
// decided" and read as one inside the band is: it neither holds nor clears. Where the A/A or the
// change has no bound (an invocation not valid, too few pairs), the count failed: it returns to
// the maintainer and does not pass until the maintainer decides.
//
// The run's ledger is `<results>/<prefix>/`: `run.json` (the image IDs, the schedule and every
// setting count.mjs is given, written before the first invocation; a run going on refuses if any
// differs) and `invocations.jsonl` (each invocation as it starts and ends). No invocation is run
// again: the command run again goes on from the first not started. `run.lock` in the ledger and a
// lock on the shared `cb-corten` tag (and the `fsw-corten` container count.mjs starts) keep two
// runners apart. It writes `report.json` and prints the report when every invocation has been
// started.
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { median, pct, upperRank } from "../placement/stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The no-regression margin the count's change is read against. */
export const MARGIN = 0.01;
/**
 * The default band as docs/design.md#choice-placement-runs prints it on `main`: the range a
 * single-build bound's distance from +1% is read against. A plan passes the band `main` printed
 * when it was declared.
 */
export const BAND = Object.freeze({ low: -0.0298, high: 0.0333 });
export const REQUESTS = 5000;
/** The row's counts a request, and the perf event each is read from (count-perf.mjs). */
export const COUNTS = Object.freeze({
  userPerRequest: "instructions:u",
  kernelPerRequest: "instructions:k",
  userCyclesPerRequest: "cycles:u",
  kernelCyclesPerRequest: "cycles:k",
  userL1iMissesPerRequest: "L1-icache-load-misses:u",
});
/** The environment count.mjs reads (bench/fullstack/apps.mjs), recorded in the ledger as given. */
export const COUNT_ENV = Object.freeze(["BENCH_TIER", "BENCH_EDGE", "BENCH_APPS", "BENCH_NETWORK", "BENCH_API_CONTAINER", "BENCH_APP_CPUS", "BENCH_LOAD_CPUS", "BENCH_FIXTURE_LOAD_CPUS"]);
/** The arguments of each invocation after its round name and before its target. */
export const COUNT_ARGS = Object.freeze(["1", "corten"]);
/** The tag count.mjs starts its image from. */
export const TAG = "cb-corten";
/** The fewest recorded pairs whose changes give a 95% bound (P(Binomial(5, 1/2) >= 5) = 1/32). */
export const MIN_PAIRS = (() => { let n = 1; while (upperRank(n) > n) n += 1; return n; })();
/** User plus kernel cycles a request, the measure the count is read in. */
export const cycles = (/** @type {Record<string, number>} */ row) => row.userCyclesPerRequest + row.kernelCyclesPerRequest;

/**
 * Why a run's options cannot make a schedule with a bound, or null. Checked before any Docker call.
 * @param {{ prefix: unknown, last: unknown, targets: unknown }} o
 */
export function optionsError(o) {
  if (typeof o.prefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(o.prefix)) return "the prefix is letters, digits, - and _, starting with a letter or digit";
  if (typeof o.last !== "number" || !Number.isInteger(o.last)) return "the pair count is a whole number";
  if (o.last < MIN_PAIRS) return `${o.last} recorded pairs give no 95% bound: at least ${MIN_PAIRS}`;
  if (!Array.isArray(o.targets) || o.targets.length === 0) return "no target: page, json or both";
  for (const t of o.targets) if (t !== "page" && t !== "json") return `unknown target ${JSON.stringify(t)}; expected page or json`;
  if (new Set(o.targets).size !== o.targets.length) return `a target is named twice: ${o.targets.join(",")}`;
  return null;
}

/** The pair count as the command line gives it: digits only, or NaN. */
export const parsePairs = (/** @type {string} */ text) => (/^\d+$/.test(text) ? Number(text) : NaN);

/**
 * Every invocation of a run, in the order they run.
 * @param {number} last the last pair (pairs 0 to last; 0 is not recorded)
 * @param {string[]} targets
 * @param {string} prefix
 */
export function schedule(last, targets, prefix) {
  const out = [];
  for (let pair = 0; pair <= last; pair++) {
    const odd = pair % 2 === 1;
    const sides = odd ? ["base", "head"] : ["head", "base"];
    const comparisons = odd ? ["aa", "ab"] : ["ab", "aa"];
    for (const target of targets) {
      for (const comparison of comparisons) {
        for (const side of sides) {
          out.push({
            name: `${prefix}-${target}-${comparison}-${String(pair).padStart(3, "0")}-${side}`,
            pair, recorded: pair > 0, target, comparison, side,
            // The A/A is the change with the head's image replaced by the base's.
            image: comparison === "aa" ? "base" : side,
          });
        }
      }
    }
  }
  return out;
}

const isCount = (/** @type {unknown} */ x) => typeof x === "number" && Number.isFinite(x);

/**
 * Why one invocation's row is not valid, or [] when it is.
 * @param {{ row?: any, summary?: any, want: string, before?: string, after?: string, rc?: number | null,
 *   signal?: string | null, tagRc?: number | null, fresh?: boolean, interrupted?: boolean }} inv
 */
export function invalid(inv) {
  if (inv.interrupted) return ["started and never ended; not run again"];
  if (inv.fresh === false) return ["its output path existed before it ran, so count.mjs was not run"];
  if (inv.tagRc !== 0) return [`docker tag exited ${inv.tagRc ?? "-"}, so count.mjs was not run`];
  const why = [];
  if (inv.before !== inv.want || inv.after !== inv.want) why.push("the image counted was not the side's");
  if (inv.rc !== 0) why.push(inv.signal ? `count.mjs was stopped by ${inv.signal}` : `count.mjs exited ${inv.rc ?? "-"}`);
  const row = inv.row;
  if (row == null) return [...why, "no row"];
  if (!Array.isArray(row)) return [...why, `count.mjs recorded failed: ${row.failed}`];
  if (row.length !== 1) return [...why, `${row.length} rows, not 1`];
  const r = row[0];
  if (r.requests !== REQUESTS) why.push(`${r.requests} requests, not ${REQUESTS}`);
  if (r.failed !== 0) why.push(`${r.failed} failed requests`);
  for (const [field, event] of Object.entries(COUNTS)) {
    const v = r[field];
    if (!isCount(v)) why.push(`${field} is ${typeof v === "string" ? JSON.stringify(v) : String(v)}, not a number`);
    const running = r.perfRunningPct?.[event];
    if (typeof running !== "number") why.push(`perf's running percentage for ${event} is not recorded`);
    else if (running !== 100) why.push(`perf ran ${event} ${running}% of its enabled time, not 100%`);
  }
  if (isCount(r.userCyclesPerRequest) && isCount(r.kernelCyclesPerRequest) && !(cycles(r) > 0)) why.push("no cycles");
  const checks = inv.summary?.metrics?.checks;
  if (!checks) why.push("no k6 summary of the counted load");
  else {
    if (checks.fails !== 0) why.push(`${checks.fails} failed status checks`);
    if (checks.passes !== REQUESTS) why.push(`${checks.passes} passed status checks, not ${REQUESTS}`);
  }
  return why;
}

/** The bound of a set of changes: the upper rank's, or null with too few. */
function boundOf(/** @type {number[]} */ changes) {
  const s = [...changes].sort((a, b) => a - b), j = upperRank(s.length);
  return { rank: j <= s.length ? j : null, bound: j >= 1 && j <= s.length ? /** @type {number} */ (s[j - 1]) : null, min: s[0] ?? null, max: s.at(-1) ?? null };
}

/**
 * One comparison's reading from its recorded pairs, each `{ base, head }` in cycles a request
 * (null where the pair is not valid). A pair not valid leaves the comparison with no bound.
 * @param {{ pair: number, base: number | null, head: number | null }[]} pairs recorded pairs only
 */
export function compare(pairs) {
  const valid = pairs.filter((p) => isCount(p.base) && isCount(p.head) && /** @type {number} */ (p.base) > 0 && /** @type {number} */ (p.head) > 0);
  const complete = pairs.length > 0 && valid.length === pairs.length;
  const changes = valid.map((p) => /** @type {number} */ (p.head) / /** @type {number} */ (p.base) - 1);
  const swapped = valid.map((p) => /** @type {number} */ (p.base) / /** @type {number} */ (p.head) - 1);
  const rec = boundOf(changes), sw = boundOf(swapped);
  return {
    n: pairs.length, valid: valid.length, complete, rank: rec.rank,
    median: changes.length ? median(changes) : null, min: rec.min, max: rec.max,
    bound: complete ? rec.bound : null,
    swappedBound: complete ? sw.bound : null,
    changes,
  };
}

/** Whether a bound's distance from +1% is inside the band, either end inside. */
export const inside = (/** @type {number} */ bound, band = BAND) => bound - MARGIN >= band.low && bound - MARGIN <= band.high;

/**
 * The A/A's resolution: "resolved" when both of its bounds less +1% are inside the band, "not
 * resolved" when it has both and either is outside, "no bound" when it lacks one.
 * @param {ReturnType<typeof compare>} aa
 */
export function resolution(aa, band = BAND) {
  if (!aa.complete || aa.bound == null || aa.swappedBound == null) return "no bound";
  return inside(aa.bound, band) && inside(aa.swappedBound, band) ? "resolved" : "not resolved";
}

/**
 * The change's reading given its A/A. It holds (a miss) or clears (meets +1%) only where the A/A
 * resolves. An A/A with both bounds that does not resolve leaves the change not decided, read as
 * one inside the band is. A change or an A/A with no bound is a failed count: `failed`, which
 * does not pass until the maintainer decides.
 * @param {ReturnType<typeof compare>} change
 * @param {ReturnType<typeof compare>} aa
 */
export function reading(change, aa, band = BAND) {
  const failed = (/** @type {string} */ verdict) => ({ verdict, decided: false, holds: false, clears: false, failed: true });
  if (!change.complete || change.bound == null) return failed("failed: the change's pairs have no bound, so the count does not pass until the maintainer decides");
  const aaIs = resolution(aa, band);
  if (aaIs === "no bound") return failed("failed: the count's A/A has no bound, so the count does not pass until the maintainer decides");
  if (aaIs === "not resolved") return { verdict: "not decided: the count's A/A does not resolve the default band, so the change is read as one inside the band, neither held nor cleared", decided: false, holds: false, clears: false, failed: false };
  const d = change.bound - MARGIN;
  if (d > band.high) return { verdict: "a miss", decided: true, holds: true, clears: false, failed: false };
  if (d < band.low) return { verdict: "meets +1%", decided: true, holds: false, clears: true, failed: false };
  return { verdict: "inside the default band: not decided", decided: false, holds: false, clears: false, failed: false };
}

const COMPARISON = { ab: "the change", aa: "its A/A" };

/**
 * Reads a run's records: each invocation's row and summary from count.mjs's results.
 * @param {ReturnType<typeof schedule>} plan
 * @param {Map<string, any>} records invocation records by name
 * @param {(name: string, target: string) => { row?: any, summary?: any }} load
 */
export function readRun(plan, records, load) {
  /** @type {Record<string, Record<string, any[]>>} */
  const pairs = {};
  for (const inv of plan) {
    const rec = records.get(inv.name);
    const ended = rec?.ended != null;
    const got = ended && rec.fresh !== false ? load(inv.name, inv.target) : {};
    const why = rec ? invalid({ ...got, ...pick(rec), interrupted: !ended }) : ["not run"];
    const row = Array.isArray(got.row) && got.row.length === 1 ? got.row[0] : null;
    const value = why.length === 0 && row ? cycles(row) : null;
    const byTarget = (pairs[inv.target] ??= {});
    const list = (byTarget[inv.comparison] ??= []);
    let p = list.find((x) => x.pair === inv.pair);
    if (!p) list.push((p = { pair: inv.pair, recorded: inv.recorded, first: inv.pair % 2 ? "base" : "head", base: null, head: null, why: [], rows: { base: null, head: null } }));
    p[inv.side] = value;
    p.rows[inv.side] = value == null ? null : Object.fromEntries(Object.keys(COUNTS).map((k) => [k, row[k]]));
    p.why.push(...why.map((w) => `${COMPARISON[inv.comparison]}, pair ${inv.pair}, side ${inv.side}: ${w}`));
  }
  const targets = {};
  for (const [target, byComparison] of Object.entries(pairs)) {
    const recorded = (/** @type {any[]} */ list) => list.filter((p) => p.recorded);
    const change = compare(recorded(byComparison.ab ?? [])), aa = compare(recorded(byComparison.aa ?? []));
    const diagnostics = Object.fromEntries(Object.entries(byComparison).map(([c, list]) => [c, split(recorded(list))]));
    targets[target] = { change, aa, resolution: resolution(aa), reading: reading(change, aa), diagnostics, pairs: byComparison };
  }
  return targets;
}

/** An invocation record's fields that decide its validity. */
const pick = (/** @type {any} */ r) => ({ want: r.want, before: r.before, after: r.after, rc: r.rc, signal: r.signal, tagRc: r.tagRc, fresh: r.fresh });

/**
 * The cycle split and its diagnostics for one comparison: each count's median a request on each
 * side over its valid recorded invocations, and the median of its per-pair changes over the pairs
 * valid on both sides.
 */
function split(/** @type {any[]} */ list) {
  const out = {};
  for (const k of Object.keys(COUNTS)) {
    const side = (/** @type {"base" | "head"} */ s) => list.map((p) => p.rows[s]?.[k]).filter(isCount);
    const both = list.filter((p) => isCount(p.rows.base?.[k]) && isCount(p.rows.head?.[k]) && p.rows.base[k] > 0);
    out[k] = {
      base: side("base").length ? median(side("base")) : null,
      head: side("head").length ? median(side("head")) : null,
      change: both.length ? median(both.map((p) => p.rows.head[k] / p.rows.base[k] - 1)) : null,
      pairs: both.length,
    };
  }
  return out;
}

const fmt = (/** @type {number | null} */ x) => (x == null ? "none" : pct(x));
const num = (/** @type {number | null} */ x) => (x == null ? "none" : Math.round(x).toLocaleString("en-US"));
const LABELS = { userCyclesPerRequest: "user cycles", kernelCyclesPerRequest: "kernel cycles", userPerRequest: "user instructions", kernelPerRequest: "kernel instructions", userL1iMissesPerRequest: "user L1i misses" };

/** The report's Markdown for a run's reading. */
export function markdown(/** @type {Record<string, any>} */ targets, /** @type {{ prefix: string, base: string, head: string }} */ run) {
  const out = [`# The catalog count with its own A/A: ${run.prefix}`, "",
    `Base image ${run.base}, head image ${run.head}. User plus kernel cycles a request, \`head\` over \`base\` less 1 a pair; the bound the upper rank's; the default band ${pct(BAND.low)} to ${pct(BAND.high)} for a bound less +1%.`, ""];
  for (const [target, t] of Object.entries(targets)) {
    const c = t.change, a = t.aa;
    out.push(`## \`${target}\`: ${t.reading.verdict}`, "",
      "| comparison | valid pairs | least | median | greatest | bound | bound less +1% | A/A bound with labels swapped |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      `| the change (base, head) | ${c.valid} of ${c.n} | ${fmt(c.min)} | ${fmt(c.median)} | ${fmt(c.max)} | ${fmt(c.bound)} | ${c.bound == null ? "none" : pct(c.bound - MARGIN)} | |`,
      `| its A/A (base, base) | ${a.valid} of ${a.n} | ${fmt(a.min)} | ${fmt(a.median)} | ${fmt(a.max)} | ${fmt(a.bound)} | ${a.bound == null ? "none" : pct(a.bound - MARGIN)} | ${fmt(a.swappedBound)} |`,
      "", `The A/A: ${t.resolution}. The change is held or cleared only where both of the A/A's bounds, less +1%, are inside the band; with both bounds and either outside it is not decided, and with no bound the count failed.`, "",
      "Diagnostics, medians a request over the valid recorded invocations of each side, and the median of the per-pair changes:", "",
      "| comparison | measure | side `base` | side `head` | per-pair change, median |",
      "| --- | --- | ---: | ---: | ---: |");
    for (const [comparison, d] of Object.entries(t.diagnostics)) {
      for (const [k, v] of Object.entries(/** @type {Record<string, any>} */ (d))) {
        out.push(`| ${COMPARISON[/** @type {"ab" | "aa"} */ (comparison)]} | ${LABELS[/** @type {keyof typeof LABELS} */ (k)]} | ${num(v.base)} | ${num(v.head)} | ${fmt(v.change)} |`);
      }
    }
    out.push("");
    const bad = Object.values(t.pairs).flat().filter((p) => p.why.length);
    if (bad.length) out.push("Not valid:", "", ...bad.flatMap((p) => p.why.map((/** @type {string} */ w) => `- ${w}`)), "");
  }
  return out.join("\n");
}

/**
 * Takes a lock file, created exclusively; throws, naming its holder, when one is there. A lock is
 * never removed but by the runner that made it: one left by a runner that is gone is removed by
 * hand.
 * @param {string} file
 * @param {string} what
 */
export function lock(file, what) {
  const token = randomUUID();
  let fd;
  try {
    fd = openSync(file, "wx");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
    let holder = "an unreadable holder";
    try { const h = JSON.parse(readFileSync(file, "utf8")); holder = `process ${h.pid} on ${h.host}, since ${h.started}, for ${h.ledger}`; } catch {}
    throw new Error(`${what} is locked by ${holder} (${file}). Another runner holds it; if none is running, the lock is stale: remove ${file} by hand and run again`);
  }
  try { writeSync(fd, JSON.stringify({ token, pid: process.pid, host: hostname(), started: new Date().toISOString(), ledger: what }) + "\n"); } finally { closeSync(fd); }
  return () => {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token === token) unlinkSync(file);
    } catch {}
  };
}

/** The run's settings as the ledger keeps them: what decides which experiment it is. */
export function settingsOf(/** @type {{ prefix: string, images: { base: string, head: string }, last: number, targets: string[], env: Record<string, string | undefined> }} */ o, /** @type {{ base: string, head: string }} */ ids, /** @type {ReturnType<typeof schedule>} */ plan) {
  return {
    version: 1,
    prefix: o.prefix,
    images: { base: o.images.base, head: o.images.head },
    ids: { base: ids.base, head: ids.head },
    pairs: o.last,
    targets: [...o.targets],
    count: { script: "bench/fullstack/count.mjs", args: ["<round>", ...COUNT_ARGS, "<target>"], tag: TAG, node: process.version },
    env: Object.fromEntries(COUNT_ENV.map((k) => [k, o.env[k] ?? null])),
    requests: REQUESTS,
    band: { ...BAND },
    margin: MARGIN,
    schedule: plan.map((i) => [i.name, i.target, i.comparison, i.side, i.image]),
  };
}

/** The top-level keys whose values differ between two settings. */
const differences = (/** @type {Record<string, unknown>} */ a, /** @type {Record<string, unknown>} */ b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

/**
 * Runs a count's invocations not yet started, then reads them all.
 * @param {{ prefix: string, images: { base: string, head: string }, last: number, targets: string[], results: string,
 *   exec: (cmd: string, args: string[], options?: { log?: string, env?: Record<string, string | undefined> }) => { status: number | null, signal?: string | null, stdout?: string },
 *   env?: Record<string, string | undefined>, tagLock?: string, stop?: () => boolean,
 *   now?: () => number, log?: (line: string) => void }} o
 */
export async function runPairs(o) {
  const error = optionsError(o);
  if (error) throw new Error(error);
  const now = o.now ?? Date.now, log = o.log ?? (() => {}), env = o.env ?? process.env;
  const dir = join(o.results, o.prefix);
  mkdirSync(join(dir, "inv"), { recursive: true });
  const releases = [lock(join(dir, "run.lock"), dir)];
  try {
    releases.push(lock(o.tagLock ?? join(tmpdir(), "corten-bench-cb-corten.lock"), `the ${TAG} tag and the fsw-corten container (${dir})`));
    return await locked(o, { dir, now, log, env });
  } finally {
    for (const release of releases.reverse()) release();
  }
}

async function locked(/** @type {Parameters<typeof runPairs>[0]} */ o, /** @type {{ dir: string, now: () => number, log: (line: string) => void, env: Record<string, string | undefined> }} */ { dir, now, log, env }) {
  const file = join(dir, "invocations.jsonl"), runFile = join(dir, "run.json");
  const id = (/** @type {string} */ image) => {
    const r = o.exec("docker", ["image", "inspect", "-f", "{{.Id}}", image]);
    return r.status === 0 ? (r.stdout ?? "").trim() : "";
  };
  const plan = schedule(o.last, o.targets, o.prefix);
  /** @type {{ base: string, head: string }} */
  let ids;
  if (existsSync(runFile)) {
    const saved = JSON.parse(readFileSync(runFile, "utf8"));
    ids = { base: saved.ids?.base, head: saved.ids?.head };
    const current = { base: id(o.images.base), head: id(o.images.head) };
    const differ = differences(saved, settingsOf({ ...o, env }, ids, plan));
    if (current.base !== ids.base || current.head !== ids.head) differ.push(`the images' IDs now (${o.images.base} ${current.base || "none"}, ${o.images.head} ${current.head || "none"})`);
    if (differ.length) throw new Error(`${runFile} is another experiment's: ${differ.join(", ")} differ from it. Go on with the same images, settings and environment, or use a new prefix`);
  } else {
    if (existsSync(file)) throw new Error(`${file} has no run.json beside it, so what it ran is not known: use a new prefix`);
    ids = { base: id(o.images.base), head: id(o.images.head) };
    if (!ids.base || !ids.head) throw new Error("no image for a side");
    if (ids.base === ids.head) throw new Error("the two sides are one image: the A/A is the run's own, so the change's sides must differ");
    const taken = plan.filter((i) => existsSync(join(o.results, i.name)));
    if (taken.length) throw new Error(`${taken.length} of the run's output paths exist already (${join(o.results, taken[0].name)}): use a new prefix`);
    writeFileSync(runFile, JSON.stringify(settingsOf({ ...o, env }, ids, plan), null, 1) + "\n", { flag: "wx" });
  }
  const records = readRecords(file);
  for (const inv of plan) {
    if (records.has(inv.name)) continue;
    if (o.stop?.()) throw new Error(`stopped before ${inv.name}; run the command again to go on`);
    const want = ids[/** @type {"base" | "head"} */ (inv.image)];
    const out = join(o.results, inv.name), logFile = join(dir, "inv", `${inv.name}.log`);
    const start = { name: inv.name, want, started: now() };
    appendFileSync(file, JSON.stringify(start) + "\n");
    /** @type {Record<string, unknown>} */
    let end;
    if (existsSync(out) || existsSync(logFile)) end = { ...start, ended: now(), fresh: false };
    else {
      const tag = o.exec("docker", ["tag", want, TAG]);
      const before = id(TAG);
      if (tag.status !== 0) end = { ...start, ended: now(), fresh: true, tagRc: tag.status, before };
      else {
        const r = o.exec(process.execPath, [join(here, "count.mjs"), inv.name, ...COUNT_ARGS, inv.target], { log: logFile, env });
        const after = id(TAG);
        end = { ...start, ended: now(), fresh: true, tagRc: 0, rc: r.status, signal: r.signal ?? null, before, after };
      }
    }
    appendFileSync(file, JSON.stringify(end) + "\n");
    records.set(inv.name, end);
    log(`${inv.name} rc ${end.rc ?? "-"} ${((Number(end.ended) - start.started) / 1000).toFixed(1)} s`);
    if (end.signal) throw new Error(`count.mjs was stopped by ${end.signal} in ${inv.name}; run the command again to go on`);
    // A signal sent to this process alone is handled between invocations.
    await new Promise((resolve) => setImmediate(resolve));
  }
  const load = (/** @type {string} */ name, /** @type {string} */ target) => {
    const at = (/** @type {string} */ f) => (existsSync(join(o.results, name, f)) ? JSON.parse(readFileSync(join(o.results, name, f), "utf8")) : undefined);
    return { row: at("instructions.json")?.[`corten/${target}`], summary: at(`count-corten-${target}-0.json`) };
  };
  const targets = readRun(plan, records, load);
  const json = { prefix: o.prefix, images: o.images, ids, last: o.last, band: BAND, margin: MARGIN, targets };
  writeFileSync(join(dir, "report.json"), JSON.stringify(json, null, 1) + "\n");
  return { targets, md: markdown(targets, { prefix: o.prefix, base: `${o.images.base} ${ids.base}`, head: `${o.images.head} ${ids.head}` }) };
}

/** Each invocation's last record: ended, or started and never ended. */
function readRecords(/** @type {string} */ file) {
  const m = new Map();
  if (!existsSync(file)) return m;
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    m.set(r.name, { ...m.get(r.name), ...r });
  }
  return m;
}

/** Whether a run's reading has every bound it needs: a target, each with both comparisons' bounds. */
export const complete = (/** @type {Record<string, any>} */ targets) =>
  Object.keys(targets).length > 0 && Object.values(targets).every((t) => t.change.bound != null && t.aa.bound != null && t.aa.swappedBound != null);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [prefix, base, head, pairs = "100", targetsArg = "page,json"] = process.argv.slice(2);
  if (!prefix || !base || !head) {
    console.error("usage: node count-pairs.mjs <prefix> <base image> <head image> [pairs=100] [targets=page,json]");
    process.exit(3);
  }
  const options = { prefix, last: parsePairs(pairs), targets: targetsArg.split(",") };
  const why = optionsError(options);
  if (why) {
    console.error(why);
    process.exit(3);
  }
  let stopped = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopped = true; });
  const exec = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {{ log?: string, env?: Record<string, string | undefined> }} */ opts = {}) => {
    if (!opts.log) return spawnSync(cmd, args, { encoding: "utf8" });
    const fd = openSync(opts.log, "wx");
    try { return spawnSync(cmd, args, { stdio: ["ignore", fd, fd], env: opts.env }); } finally { closeSync(fd); }
  };
  try {
    const { md, targets: read } = await runPairs({ ...options, images: { base, head }, results: join(here, "results"), exec, stop: () => stopped, log: (l) => console.log(new Date().toISOString(), l) });
    console.log(md);
    process.exit(complete(read) ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
