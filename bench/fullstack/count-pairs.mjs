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
// <pairs> (5 to 999) are. Pair 0 gives no sample, but an invocation of it that is not valid fails
// its comparison as any other does. In odd pairs the side named `base` goes first and the A/A before the change; in
// even pairs `head` and the change. So a run is four invocations a pair and target where a count
// without its A/A is two: twice the time.
//
// A pair's change is the second side over the first less 1 (`head` / `base` - 1) in user plus
// kernel cycles a request; the bound is the j-th smallest of the n recorded changes, j the
// smallest rank with P(Binomial(n, 1/2) >= j) <= 5% (the 59th of 100), ordered and read against the
// band exactly from the whole cycle counts (an end of the band is inside). The A/A is read twice, as
// recorded and with its labels swapped (`base` / `head` - 1), as bench/placement reads one. It
// resolves when both of its bounds less +1% are inside the default band; then the change's bound
// less +1% is read against the band as item 2 reads it: above, a miss; below, it meets +1%;
// inside, not decided. Where the A/A has both bounds and does not resolve, the change is "not
// decided" and read as one inside the band is: it neither holds nor clears. Where the A/A or the
// change has no bound (an invocation not valid, too few pairs), the count failed: it returns to
// the maintainer and does not pass until the maintainer decides.
//
// The run's ledger is `<results>/<prefix>/`: `run.json` (the image IDs, the schedule, every
// setting count.mjs is given, the SHA-256 of every file the count runs and of the fixture it
// mounts, and the host: the Docker daemon's ID and address, the docker and perf on the count's
// PATH and their versions, the kernel, Node and the k6 image; written before the first invocation,
// and a run going on refuses if any differs or cannot be established) and `invocations.jsonl`
// (each invocation as it starts and as it ends, with the SHA-256 and size of the row, the k6
// summaries of its two loads and the launched image it is read from: a replay reads those bytes
// or none; and, between those, as count.mjs is started and as it exits, its exit written before
// anything that can fail). No invocation is run again: the command run again goes on from the first
// not started, and refuses where count.mjs was started and its end was not recorded, as it may have
// exited 4, or where it exited 4 or was stopped by a signal (a perf or probe it started may still
// count), refusing before any Docker call. Past such an exit the runner asks Docker nothing but
// the daemon's lock's removal, which it waits for no longer than its bound, however Docker answers.
// `run.lock` in the ledger and, on the Docker daemon, a container named corten-count-pairs-lock
// that only one runner can make and that runs while it is held, so a prune leaves it (the lock on
// the daemon's `cb-corten` tag and the `fsw-corten` container count.mjs starts, whatever directory
// a runner starts from) keep two runners apart.
// Before each invocation, as each ends and before the report, it stops with no report if that
// container is not the one it made or a file run.json binds has other bytes. It writes `report.json` and prints the report once every invocation has ended, unless it was
// asked to stop.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { k6Image } from "../load-tool.mjs";
import { EVERY_EVENT, HALT_EXIT, loadTotals } from "./count-perf.mjs";
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
/** The most: a pair's number is three digits in its round names, so every name has one length. */
export const MAX_PAIRS = 999;
/** The container on the Docker daemon that stands for the lock on its `cb-corten` tag and `fsw-corten` container. */
export const DAEMON_LOCK = "corten-count-pairs-lock";
const HOLDER = "run.corten.count-pairs.holder";
/**
 * How long the daemon's lock runs, in seconds: seven days, an expiry and not a bound on a schedule
 * (999 pairs of both targets, 7,992 invocations, are about 77 hours at #2066's 34.8 s each, estimated, before
 * #2151 gave each invocation a second load for kernel instructions, which adds an unmeasured time;
 * a slower run can outlast it, and then stops at its next check, as the lock is not running). It runs so that
 * `docker container prune`, which removes stopped containers, cannot remove it while a run goes on,
 * and exits by itself after this so one a killed runner left stops.
 */
export const LOCK_SECONDS = 7 * 24 * 3600;
/** How long the daemon's lock's removal may take, in ms, so a halt reaches the caller however Docker answers. */
export const RELEASE_MS = 10_000;
/**
 * A command run without blocking, its output not kept, resolved with its exit status once it exits
 * or with a null status at `timeout` ms, when it is sent SIGKILL. The deadline does not wait on the
 * child: one that does not exit after the signal (a client stuck in the kernel) is left, unref'd,
 * so it keeps neither this process nor its caller from going on.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string | undefined>, timeout?: number }} [opts]
 * @param {typeof spawn} [start]
 * @returns {Promise<{ status: number | null }>}
 */
export function spawnBounded(cmd, args, opts = {}, start = spawn) {
  return new Promise((done) => {
    /** @type {ReturnType<typeof spawn>} */
    let child;
    try { child = start(cmd, args, { stdio: "ignore", env: opts.env, windowsHide: true }); } catch { return done({ status: null }); }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done({ status: null }); }, opts.timeout ?? RELEASE_MS);
    child.on("error", () => { clearTimeout(timer); done({ status: null }); });
    child.on("exit", (code) => { clearTimeout(timer); done({ status: code }); });
    child.unref();
  });
}
/**
 * `promise`'s value, or `fallback` once `ms` have passed or where it rejects: a deadline that does
 * not depend on what the promise waits for.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export function within(promise, ms, fallback) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const deadline = new Promise((done) => { timer = setTimeout(done, ms, fallback); });
  return /** @type {Promise<T>} */ (Promise.race([promise.catch(() => fallback), deadline])).finally(() => clearTimeout(timer));
}
/**
 * The runner's exec: a command run to its end, its output to `log` when given and none kept with
 * `output` false, killed at `timeout` ms when given (a command past its bound gives a null status).
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ log?: string, env?: Record<string, string | undefined>, timeout?: number, output?: boolean }} [opts]
 */
export function spawnExec(cmd, args, opts = {}) {
  const bound = opts.timeout ? { timeout: opts.timeout, killSignal: /** @type {const} */ ("SIGKILL") } : {};
  if (opts.output === false) return spawnSync(cmd, args, { stdio: "ignore", env: opts.env, ...bound });
  if (!opts.log) return spawnSync(cmd, args, { encoding: "utf8", env: opts.env, ...bound });
  const fd = openSync(opts.log, "wx");
  try { return spawnSync(cmd, args, { stdio: ["ignore", fd, fd], env: opts.env, ...bound }); } finally { closeSync(fd); }
}
/** User plus kernel cycles a request, the measure the count is read in. */
export const cycles = (/** @type {Record<string, number>} */ row) => row.userCyclesPerRequest + row.kernelCyclesPerRequest;

/**
 * Why a run's options cannot make a schedule with a bound, or null. Checked before any Docker call.
 * @param {{ prefix: unknown, last: unknown, targets: unknown }} o
 */
export function optionsError(o) {
  if (typeof o.prefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(o.prefix)) return "the prefix is letters, digits, - and _, starting with a letter or digit";
  if (typeof o.last !== "number" || !Number.isSafeInteger(o.last)) return `the pair count is a whole number from ${MIN_PAIRS} to ${MAX_PAIRS}`;
  if (o.last < MIN_PAIRS) return `${o.last} recorded pairs give no 95% bound: at least ${MIN_PAIRS}`;
  if (o.last > MAX_PAIRS) return `${o.last} pairs: at most ${MAX_PAIRS}, so every round name has one length`;
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
 * @param {{ row?: any, summary?: any, kernelSummary?: any, launched?: any, want?: string, before?: string, after?: string, rc?: number | null,
 *   signal?: string | null, tagRc?: number | null, fresh?: boolean, interrupted?: boolean, lost?: string[] }} inv
 */
export function invalid(inv) {
  if (inv.interrupted) return ["started and never ended; not run again"];
  if (inv.fresh === false) return ["its output path existed before it ran, so count.mjs was not run"];
  if (inv.tagRc !== 0) return [`docker tag exited ${inv.tagRc ?? "-"}, so count.mjs was not run`];
  const why = [];
  if (typeof inv.want !== "string" || !inv.want) why.push("run.json pins no image for its slot");
  if (Array.isArray(inv.lost) && inv.lost.length) why.push(`while it ran: ${inv.lost.join("; ")}`);
  if (inv.before !== inv.want || inv.after !== inv.want) why.push("the image counted was not the side's");
  if (inv.rc === 0 && (inv.launched?.image !== inv.want || !/^[0-9a-f]{64}$/.test(String(inv.launched?.container)))) why.push("the container counted was not started from the side's image");
  if (inv.rc === HALT_EXIT) why.push(`count.mjs exited ${HALT_EXIT}: a perf it started was not seen to end, so no further count runs on that host`);
  else if (inv.rc !== 0) why.push(inv.signal ? `count.mjs was stopped by ${inv.signal}` : `count.mjs exited ${inv.rc ?? "-"}`);
  const row = inv.row;
  if (row == null) return [...why, "no row"];
  if (!Array.isArray(row)) return [...why, `count.mjs recorded failed: ${row.failed}`];
  if (row.length !== 1) return [...why, `${row.length} rows, not 1`];
  const r = row[0];
  if (r.requests !== REQUESTS) why.push(`${r.requests} requests, not ${REQUESTS}`);
  if (r.failed !== 0) why.push(`${r.failed} failed requests`);
  // Kernel instructions are counted over a second load of their own (count-perf.mjs, #2151).
  if (r.kernelPass?.requests !== REQUESTS) why.push(`${r.kernelPass?.requests} requests in the kernel instructions' load, not ${REQUESTS}`);
  if (r.kernelPass?.failed !== 0) why.push(`${r.kernelPass?.failed} failed requests in the kernel instructions' load`);
  for (const [field, event] of Object.entries(COUNTS)) {
    const v = r[field];
    // count-perf.mjs rounds each count a request to a whole number, so sums and ratios of them are exact.
    if (!isCount(v)) why.push(`${field} is ${typeof v === "string" ? JSON.stringify(v) : String(v)}, not a number`);
    else if (!Number.isSafeInteger(v) || v < 0) why.push(`${field} is ${v}, not a whole count`);
    const running = r.perfRunningPct?.[event];
    if (typeof running !== "number") why.push(`perf's running percentage for ${event} is not recorded`);
    else if (running !== 100) why.push(`perf ran ${event} ${running}% of its enabled time, not 100%`);
  }
  if (isCount(r.userCyclesPerRequest) && isCount(r.kernelCyclesPerRequest)) {
    if (!(cycles(r) > 0)) why.push("no cycles");
    // A sum past 2^53 - 1 is rounded, so the bound would not be read from the counts exactly.
    else if (Number.isSafeInteger(r.userCyclesPerRequest) && Number.isSafeInteger(r.kernelCyclesPerRequest) && !Number.isSafeInteger(cycles(r))) why.push("user plus kernel cycles a request is above 2^53 - 1, so not an exact count");
  }
  // Each load's sealed k6 summary must give the same totals as its part of the row.
  for (const [summary, load, part] of [[inv.summary, "", r], [inv.kernelSummary, " in the kernel instructions' load", r.kernelPass]]) {
    const checks = summary?.metrics?.checks;
    if (!checks) { why.push(`no k6 summary of the counted load${load}`); continue; }
    if (checks.fails !== 0) why.push(`${checks.fails} failed status checks${load}`);
    if (checks.passes !== REQUESTS) why.push(`${checks.passes} passed status checks${load}, not ${REQUESTS}`);
    const t = loadTotals(summary);
    if (t.requests === null || t.requests !== part?.requests) why.push(`its k6 summary gives ${t.requests ?? "no"} requests${load} where the row has ${part?.requests}`);
    if (t.failed === null || t.failed !== part?.failed) why.push(`its k6 summary gives ${t.failed ?? "no"} failed requests${load} where the row has ${part?.failed}`);
  }
  return why;
}

/**
 * A finite double as the exact fraction it is, [numerator, denominator], the denominator a
 * positive power of two: the cycle counts and the bounds are compared to the band in these, so an
 * end of the band is read as inside whatever floating-point subtraction would round it to.
 */
function exact(/** @type {number} */ x) {
  if (!Number.isFinite(x)) throw new Error(`${x} is not a finite number`);
  if (x === 0) return [0n, 1n];
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0), biased = Number((bits >> 52n) & 0x7ffn);
  const mantissa = (bits & 0xfffffffffffffn) | (biased ? 1n << 52n : 0n);
  const power = (biased || 1) - 1075, n = bits >> 63n ? -mantissa : mantissa;
  return power >= 0 ? [n << BigInt(power), 1n] : [n, 1n << BigInt(-power)];
}
/** A constant as it is written (the band's ends, the margin), its shortest decimal, as an exact fraction. */
function decimal(/** @type {number} */ x) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(x));
  if (!m) throw new Error(`${x} is not a decimal`);
  const digits = BigInt((m[1] ? "-" : "") + m[2] + (m[3] ?? "")), scale = (m[3] ?? "").length - Number(m[4] ?? 0);
  return scale >= 0 ? [digits, 10n ** BigInt(scale)] : [digits * 10n ** BigInt(-scale), 1n];
}
const minus = (/** @type {bigint[]} */ [a, b], /** @type {bigint[]} */ [c, d]) => [a * d - c * b, b * d];
const signOf = (/** @type {bigint[]} */ [n, d]) => (n === 0n ? 0 : (n > 0n) === (d > 0n) ? 1 : -1);
/** num / den as an exact fraction, both positive. */
const ratio = (/** @type {number} */ num, /** @type {number} */ den) => { const [a, b] = exact(num), [c, d] = exact(den); return [a * d, b * c]; };

/**
 * Where a bound less +1% falls against the band: -1 below its low end, 0 inside (either end
 * inside), 1 above its high end. The bound is a number, or { num, den } for num / den - 1 read
 * exactly from the cycle counts it is the ratio of.
 * @param {number | { num: number, den: number }} bound
 */
export function position(bound, band = BAND) {
  const b = typeof bound === "number" ? exact(bound) : minus(ratio(bound.num, bound.den), [1n, 1n]);
  const d = minus(b, decimal(MARGIN));
  if (signOf(minus(d, decimal(band.low))) < 0) return -1;
  return signOf(minus(d, decimal(band.high))) > 0 ? 1 : 0;
}

/**
 * One comparison's reading from its recorded pairs, each `{ base, head }` in cycles a request
 * (null where the pair is not valid). A pair not valid leaves the comparison with no bound, and
 * so does any of its pair 0 invocations not valid (`unrecordedFailed`), though pair 0 gives no
 * sample. The bound is the j-th smallest `head` / `base` - 1, ordered exactly; with the labels
 * swapped, the j-th smallest `base` / `head` - 1.
 * @param {{ pair: number, base: number | null, head: number | null }[]} pairs recorded pairs only
 */
export function compare(pairs, unrecordedFailed = 0) {
  /** @type {{ base: number, head: number }[]} */
  const valid = /** @type {any[]} */ (pairs.filter((p) => isCount(p.base) && isCount(p.head) && /** @type {number} */ (p.base) > 0 && /** @type {number} */ (p.head) > 0));
  const complete = pairs.length > 0 && valid.length === pairs.length && unrecordedFailed === 0;
  const order = [...valid].sort((p, q) => signOf(minus(ratio(p.head, p.base), ratio(q.head, q.base))));
  const n = order.length, j = upperRank(n), has = complete && j >= 1 && j <= n;
  const at = has ? order[j - 1] : null, swapped = has ? order[n - j] : null;
  const changes = valid.map((p) => p.head / p.base - 1);
  return {
    n: pairs.length, valid: valid.length, unrecordedFailed, complete, rank: j <= n ? j : null,
    median: changes.length ? median(changes) : null,
    min: n ? order[0].head / order[0].base - 1 : null, max: n ? /** @type {any} */ (order.at(-1)).head / /** @type {any} */ (order.at(-1)).base - 1 : null,
    bound: at ? at.head / at.base - 1 : null,
    swappedBound: swapped ? swapped.base / swapped.head - 1 : null,
    // The same two bounds as the cycle counts they are the ratios of, for reading them exactly.
    exact: { bound: at ? { num: at.head, den: at.base } : null, swappedBound: swapped ? { num: swapped.base, den: swapped.head } : null },
    changes,
  };
}

/** Whether a bound's distance from +1% is inside the band, either end inside, read exactly. */
export const inside = (/** @type {number | { num: number, den: number }} */ bound, band = BAND) => position(bound, band) === 0;

/** A comparison's bound, or its swapped bound, exactly where compare() gave it. */
const boundOf = (/** @type {any} */ c, /** @type {"bound" | "swappedBound"} */ which) => c.exact?.[which] ?? c[which];

/**
 * The A/A's resolution: "resolved" when both of its bounds less +1% are inside the band, "not
 * resolved" when it has both and either is outside, "no bound" when it lacks one.
 * @param {ReturnType<typeof compare>} aa
 */
export function resolution(aa, band = BAND) {
  if (!aa.complete || aa.bound == null || aa.swappedBound == null) return "no bound";
  return inside(boundOf(aa, "bound"), band) && inside(boundOf(aa, "swappedBound"), band) ? "resolved" : "not resolved";
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
  const where = position(boundOf(change, "bound"), band);
  if (where > 0) return { verdict: "a miss", decided: true, holds: true, clears: false, failed: false };
  if (where < 0) return { verdict: "meets +1%", decided: true, holds: false, clears: true, failed: false };
  return { verdict: "inside the default band: not decided", decided: false, holds: false, clears: false, failed: false };
}

const COMPARISON = { ab: "the change", aa: "its A/A" };

/**
 * Reads a run's records: each invocation's row, summary and launched image from count.mjs's
 * results, as `load` gives them from the invocation's record (and why it could not), each against
 * the image ID run.json pins for its slot's side, not the one its own record names.
 * @param {ReturnType<typeof schedule>} plan
 * @param {Map<string, any>} records invocation records by name
 * @param {(name: string, target: string, record: any) => { row?: any, summary?: any, kernelSummary?: any, launched?: any, why?: string[] }} load
 * @param {{ base?: string, head?: string }} [ids] the image IDs run.json pins
 */
export function readRun(plan, records, load, ids = {}) {
  /** @type {Record<string, Record<string, any[]>>} */
  const pairs = {};
  for (const inv of plan) {
    const rec = records.get(inv.name);
    const ended = rec?.ended != null;
    const got = ended && rec.fresh !== false && rec.tagRc === 0 ? load(inv.name, inv.target, rec) : {};
    const why = rec ? [...(got.why ?? []), ...invalid({ ...got, ...pick(rec), want: ids[/** @type {"base" | "head"} */ (inv.image)], interrupted: !ended })] : ["not run"];
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
    // Pair 0 gives no sample, but an invocation of it that is not valid fails its comparison, as any other does.
    const unrecordedFailed = (/** @type {any[]} */ list) => list.filter((p) => !p.recorded && (p.why.length > 0 || p.base == null || p.head == null)).length;
    const of = (/** @type {any[]} */ list) => compare(recorded(list), unrecordedFailed(list));
    const change = of(byComparison.ab ?? []), aa = of(byComparison.aa ?? []);
    const diagnostics = Object.fromEntries(Object.entries(byComparison).map(([c, list]) => [c, split(recorded(list))]));
    targets[target] = { change, aa, resolution: resolution(aa), reading: reading(change, aa), diagnostics, pairs: byComparison };
  }
  return targets;
}

/** An invocation record's fields that decide its validity, but the image it wanted, which run.json gives. */
const pick = (/** @type {any} */ r) => ({ before: r.before, after: r.after, rc: r.rc, signal: r.signal, tagRc: r.tagRc, fresh: r.fresh, lost: r.lost });

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
// Each measure names the load it is counted over: kernel instructions are a second load's (#2151).
const LABELS = { userCyclesPerRequest: "user cycles, first load", kernelCyclesPerRequest: "kernel cycles, first load", userPerRequest: "user instructions, first load", kernelPerRequest: "kernel instructions, second load", userL1iMissesPerRequest: "user L1i misses, first load" };

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
      "Each invocation counts two loads of 5,000 requests on the same container: user and kernel cycles (the reading above), user instructions and user L1i misses over the first, kernel instructions alone over the second, each over its own load's requests. So kernel instructions are not from the load the cycles are, and their sum with user instructions is two loads'.", "",
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

const sha256 = (/** @type {Buffer} */ bytes) => createHash("sha256").update(bytes).digest("hex");
const own = fileURLToPath(import.meta.url);

/**
 * The files a count runs, kit-relative with `/`: count.mjs and every module it imports by a
 * relative specifier, the k6 script it loads and that script's relative imports, the fixture it
 * mounts into the app, and this runner and its own imports. Bare specifiers (`node:` modules, k6's
 * own) are the Node and k6 the environment and images pin. Throws where a file is missing.
 * @param {string} kit the directory count.mjs is in
 */
export function kitOf(kit) {
  /** @type {Record<string, { sha256: string, bytes: number }>} */
  const out = {};
  const seen = new Set();
  const visit = (/** @type {string} */ file, /** @type {boolean} */ code) => {
    if (seen.has(file)) return;
    seen.add(file);
    const name = relative(kit, file).split(sep).join("/");
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`cannot establish what the count runs: ${name} is missing`);
    const bytes = readFileSync(file);
    out[name] = { sha256: sha256(bytes), bytes: bytes.length };
    if (!code) return;
    const text = bytes.toString("utf8");
    for (const m of text.matchAll(/\b(?:import|export)\s[^"';]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = /** @type {string} */ (m[1] ?? m[2] ?? m[3]);
      if (spec.startsWith("./") || spec.startsWith("../")) visit(resolve(dirname(file), spec), true);
    }
  };
  visit(join(kit, "count.mjs"), true);
  visit(join(kit, "ssr-load.js"), true);
  visit(join(kit, "fixtures", "items.json"), false);
  visit(own, true);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The file a command name runs from PATH, as a spawn finds it, or null. */
export function onPath(/** @type {string} */ name, /** @type {Record<string, string | undefined>} */ env = process.env, platform = process.platform) {
  const key = platform === "win32" ? Object.keys(env).find((k) => k.toUpperCase() === "PATH") : "PATH";
  const exts = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of (key ? env[key] ?? "" : "").split(platform === "win32" ? ";" : delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, name + ext);
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
  }
  return null;
}

const DAEMON = '{"id":{{json .ID}},"version":{{json .ServerVersion}},"kernel":{{json .KernelVersion}},"name":{{json .Name}}}';

/**
 * What can change a count on the host it runs on, as the count's environment reaches it: the
 * Docker daemon (by its ID) and how it is addressed, the docker and perf commands PATH gives and
 * their versions, the kernel, Node, and the k6 image count.mjs loads with (by digest). Throws,
 * naming the probe, where any cannot be established.
 * @param {(cmd: string, args: string[], options?: { env?: Record<string, string | undefined> }) => { status: number | null, stdout?: string }} exec
 * @param {Record<string, string | undefined>} env
 * @param {(name: string) => string | null} which
 */
export function environmentOf(exec, env, which) {
  const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    const r = exec(cmd, args, { env });
    const out = r.status === 0 ? (r.stdout ?? "").trim() : "";
    if (!out) throw new Error(`cannot establish the host the count runs on: ${[cmd, ...args.slice(0, 1)].join(" ")} gave nothing (exit ${r.status ?? "-"})`);
    return out;
  };
  const path = (/** @type {string} */ name) => {
    const found = which(name);
    if (!found) throw new Error(`cannot establish the host the count runs on: no ${name} on the count's PATH`);
    return found;
  };
  /** @type {any} */
  let daemon;
  const info = run("docker", ["info", "--format", DAEMON]);
  try { daemon = JSON.parse(info); } catch { daemon = null; }
  if (!daemon?.id || !daemon?.version) throw new Error("cannot establish the host the count runs on: docker info gave no daemon ID");
  return {
    dockerHost: env.DOCKER_HOST ?? null,
    dockerContext: env.DOCKER_CONTEXT ?? null,
    daemon,
    docker: { path: path("docker"), client: run("docker", ["version", "--format", "{{.Client.Version}}"]) },
    perf: { path: path("perf"), version: run("perf", ["--version"]) },
    kernel: run("uname", ["-r"]),
    node: { version: process.version, path: process.execPath },
    k6: k6Image,
  };
}

/**
 * Takes the daemon's lock on its `cb-corten` tag and `fsw-corten` container: a container named
 * DAEMON_LOCK, made from `image` and started as `sleep LOCK_SECONDS` with no network, which the
 * daemon lets only one runner make whatever directory each runs from, and which a prune does not
 * remove while it runs. Throws, naming its holder, where one is there. `held` says whether the
 * container of that name is still the one made and still running (a hand can remove it and another
 * runner make its own); `release` removes it by the ID it was made with, so never one another
 * runner made after it, through `bounded` and within RELEASE_MS whatever `bounded` does, as it runs
 * after a halt too.
 * @param {(cmd: string, args: string[], options?: { env?: Record<string, string | undefined>, timeout?: number, output?: boolean }) => { status: number | null, stdout?: string }} exec
 * @param {Record<string, string | undefined>} env
 * @param {string} image
 * @param {string} ledger
 * @param {(cmd: string, args: string[], options: { env?: Record<string, string | undefined>, timeout: number }) => Promise<{ status: number | null }>} [bounded]
 */
export async function daemonLock(exec, env, image, ledger, bounded = spawnBounded) {
  const holder = `process ${process.pid} on ${hostname()}, since ${new Date().toISOString()}, for ${ledger}`;
  const made = exec("docker", ["create", "--name", DAEMON_LOCK, "--network", "none", "--label", `${HOLDER}=${holder}`, "--label", `run.corten.count-pairs.token=${randomUUID()}`, "--entrypoint", "sleep", image, String(LOCK_SECONDS)], { env });
  const id = (made.stdout ?? "").trim();
  if (made.status === 0 && /^[0-9a-f]{64}$/.test(id)) {
    // A docker that does not answer is given up at RELEASE_MS, and not waited for past it.
    const release = () => within(bounded("docker", ["rm", "-f", id], { env, timeout: RELEASE_MS }).then((r) => r.status === 0), RELEASE_MS, false);
    const started = exec("docker", ["start", id], { env });
    if (started.status !== 0) {
      const removed = await release();
      throw new Error(`could not start the daemon's lock: docker start exited ${started.status ?? "-"}${removed ? "" : `; remove it with docker rm -f ${DAEMON_LOCK}`}`);
    }
    return {
      held: () => { const r = exec("docker", ["inspect", "-f", "{{.Id}} {{.State.Running}}", DAEMON_LOCK], { env }); return r.status === 0 && (r.stdout ?? "").trim() === `${id} true`; },
      release,
    };
  }
  if (made.status === 0) throw new Error(`docker create ${DAEMON_LOCK} gave no container ID; remove it with docker rm -f ${DAEMON_LOCK} and run again`);
  const seen = exec("docker", ["inspect", "-f", "{{json .Config.Labels}}", DAEMON_LOCK], { env });
  if (seen.status !== 0) throw new Error(`could not take the daemon's lock: docker create ${DAEMON_LOCK} exited ${made.status ?? "-"}`);
  /** @type {string | undefined} */
  let by;
  try { by = JSON.parse(seen.stdout ?? "")?.[HOLDER]; } catch {}
  throw new Error(`the ${TAG} tag and the fsw-corten container on this Docker daemon are locked by ${by ?? "an unlabeled holder"} (container ${DAEMON_LOCK}). Another runner holds it; if none is running, the lock is stale: remove it with docker rm -f ${DAEMON_LOCK} and run again`);
}

/** The outputs of one invocation that its reading is made from, sealed when it ends. */
export const artifactsOf = (/** @type {string} */ target) => ["instructions.json", `count-corten-${target}-0.json`, "count-images.json", `count-corten-${target}-0-kernel.json`];

/** Each of an invocation's outputs as it is now: its SHA-256 and size, or null where it is not there. */
export function seal(/** @type {string} */ dir, /** @type {string[]} */ names) {
  return Object.fromEntries(names.map((name) => {
    const file = join(dir, name);
    if (!existsSync(file) || !statSync(file).isFile()) return [name, null];
    const bytes = readFileSync(file);
    return [name, { sha256: sha256(bytes), bytes: bytes.length }];
  }));
}

/** The run's settings as the ledger keeps them: what decides which experiment it is. */
export function settingsOf(/** @type {{ prefix: string, images: { base: string, head: string }, last: number, targets: string[], env: Record<string, string | undefined> }} */ o, /** @type {{ base: string, head: string }} */ ids, /** @type {ReturnType<typeof schedule>} */ plan, /** @type {ReturnType<typeof kitOf>} */ kit, /** @type {ReturnType<typeof environmentOf>} */ environment) {
  return {
    version: 2,
    prefix: o.prefix,
    images: { base: o.images.base, head: o.images.head },
    ids: { base: ids.base, head: ids.head },
    pairs: o.last,
    targets: [...o.targets],
    count: { script: "count.mjs", args: ["<round>", ...COUNT_ARGS, "<target>"], tag: TAG },
    env: Object.fromEntries(COUNT_ENV.map((k) => [k, o.env[k] ?? null])),
    kit,
    environment,
    requests: REQUESTS,
    band: { ...BAND },
    margin: MARGIN,
    schedule: plan.map((i) => [i.name, i.target, i.comparison, i.side, i.image]),
  };
}

/** The keys whose values differ between two settings, with the entries that differ in `kit` and `environment`. */
const differences = (/** @type {Record<string, any>} */ a, /** @type {Record<string, any>} */ b) => {
  const keys = (/** @type {Record<string, any>} */ x, /** @type {Record<string, any>} */ y) => [...new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])].filter((k) => JSON.stringify(x?.[k]) !== JSON.stringify(y?.[k]));
  return keys(a, b).map((k) => ((k === "kit" || k === "environment") && a[k] && typeof a[k] === "object" ? `${k} (${keys(a[k], b[k]).join(", ")})` : k));
};

/**
 * Runs a count's invocations not yet started, then reads them all.
 * @param {{ prefix: string, images: { base: string, head: string }, last: number, targets: string[], results: string,
 *   exec: (cmd: string, args: string[], options?: { log?: string, env?: Record<string, string | undefined>, timeout?: number, output?: boolean }) => { status: number | null, signal?: string | null, stdout?: string },
 *   bounded?: (cmd: string, args: string[], options: { env?: Record<string, string | undefined>, timeout: number }) => Promise<{ status: number | null }>,
 *   env?: Record<string, string | undefined>, kit?: string, which?: (name: string) => string | null, stop?: () => boolean,
 *   now?: () => number, log?: (line: string) => void }} o
 */
export async function runPairs(o) {
  const error = optionsError(o);
  if (error) throw new Error(error);
  const now = o.now ?? Date.now, log = o.log ?? (() => {}), env = o.env ?? process.env;
  const dir = join(o.results, o.prefix);
  const id = (/** @type {string} */ image) => {
    const r = o.exec("docker", ["image", "inspect", "-f", "{{.Id}}", image], { env });
    return r.status === 0 ? (r.stdout ?? "").trim() : "";
  };
  mkdirSync(join(dir, "inv"), { recursive: true });
  /** @type {(() => void | Promise<void>)[]} */
  const releases = [lock(join(dir, "run.lock"), dir)];
  try {
    // A halt the ledger has kept is read first, under run.lock and before any Docker call: a perf it
    // left may still count, so this host is asked nothing more.
    const records = readRecords(join(dir, "invocations.jsonl"));
    const halted = haltOf(records);
    if (halted) throw new Error(halted);
    // The daemon's lock is a container made from the base's image, so the base's ID is read first; a
    // new run refuses one image for both sides before it takes the lock, a run going on in locked().
    const base = id(o.images.base), head = id(o.images.head);
    if (!base || !head) throw new Error("no image for a side");
    if (base === head && !existsSync(join(dir, "run.json"))) throw new Error("the two sides are one image: the A/A is the run's own, so the change's sides must differ");
    const daemon = await daemonLock(o.exec, env, base, dir, o.bounded ?? spawnBounded);
    releases.push(async () => { if (!(await daemon.release())) log(`the daemon's lock was not removed: remove it with docker rm -f ${DAEMON_LOCK} if no runner is going`); });
    return await locked(o, { dir, now, log, env, id, held: daemon.held, records });
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

/** A perf count.mjs could not see end may still run on this host (count-perf.mjs): nothing more is counted on it. */
const halt = (/** @type {string} */ name) => `count.mjs exited ${HALT_EXIT} in ${name}: a perf it started was not seen to end, so no further count runs on this host; stopped with no report. Count on a fresh host under a new prefix`;
// A count.mjs stopped by a signal did not see each perf and probe it started end (the probe runs
// in a process group of its own, which the signal may not reach): the same halt, unconfirmed.
const signalled = (/** @type {string} */ name, /** @type {string} */ signal) => `count.mjs was stopped by ${signal} in ${name} before it saw each perf and probe it started end: one may still count, so no further count runs on this host; stopped with no report. Count on a fresh host under a new prefix`;

/**
 * Why a ledger's invocations stop the run before anything else is asked of the host, or null: a
 * count.mjs that exited HALT_EXIT, was stopped by a signal, or was started with no end recorded.
 * @param {Map<string, any>} records
 */
function haltOf(records) {
  for (const [name, r] of records) if (r.rc === HALT_EXIT) return halt(name);
  for (const [name, r] of records) if (r.signal) return signalled(name, r.signal);
  // A count.mjs started with no end recorded: its exit, if it was kept, is not 4, but what it
  // counted was not sealed; if not, it may have been 4. Either way the run does not go on.
  for (const [name, r] of records) {
    if (r.dispatched == null || r.ended != null) continue;
    return r.exited != null
      ? `count.mjs exited ${r.rc ?? r.signal ?? "-"} in ${name} and the end of that invocation (the image it counted and its sealed outputs) was not recorded; stopped with no report. Count under a new prefix`
      : `count.mjs was started in ${name} and its exit was not recorded: it may have exited ${HALT_EXIT}, a perf it started not seen to end, so no further count runs on this host; stopped with no report. Count on a fresh host under a new prefix`;
  }
  return null;
}

async function locked(/** @type {Parameters<typeof runPairs>[0]} */ o, /** @type {{ dir: string, now: () => number, log: (line: string) => void, env: Record<string, string | undefined>, id: (image: string) => string, held: () => boolean, records: Map<string, any> }} */ { dir, now, log, env, id, held, records }) {
  const file = join(dir, "invocations.jsonl"), runFile = join(dir, "run.json");
  const kitDir = o.kit ?? here;
  const plan = schedule(o.last, o.targets, o.prefix);
  const kit = kitOf(kitDir), environment = environmentOf(o.exec, env, o.which ?? ((name) => onPath(name, env)));
  /** @type {{ base: string, head: string }} */
  let ids;
  if (existsSync(runFile)) {
    const saved = JSON.parse(readFileSync(runFile, "utf8"));
    ids = { base: saved.ids?.base, head: saved.ids?.head };
    const current = { base: id(o.images.base), head: id(o.images.head) };
    const differ = differences(saved, settingsOf({ ...o, env }, ids, plan, kit, environment));
    if (current.base !== ids.base || current.head !== ids.head) differ.push(`the images' IDs now (${o.images.base} ${current.base || "none"}, ${o.images.head} ${current.head || "none"})`);
    if (differ.length) throw new Error(`${runFile} is another experiment's: ${differ.join(", ")} differ from it. Go on with the same images, kit, host, settings and environment, or use a new prefix`);
  } else {
    if (existsSync(file)) throw new Error(`${file} has no run.json beside it, so what it ran is not known: use a new prefix`);
    ids = { base: id(o.images.base), head: id(o.images.head) };
    if (!ids.base || !ids.head) throw new Error("no image for a side");
    if (ids.base === ids.head) throw new Error("the two sides are one image: the A/A is the run's own, so the change's sides must differ");
    const taken = plan.filter((i) => existsSync(join(o.results, i.name)));
    if (taken.length) throw new Error(`${taken.length} of the run's output paths exist already (${join(o.results, taken[0].name)}): use a new prefix`);
    writeFileSync(runFile, JSON.stringify(settingsOf({ ...o, env }, ids, plan, kit, environment), null, 1) + "\n", { flag: "wx" });
  }
  // What could make the next count, or the report, not the run's: the daemon's lock taken from it,
  // or a file the count runs no longer the bytes run.json binds.
  const lost = () => {
    const out = held() ? [] : [`the daemon's lock was lost: ${DAEMON_LOCK} is not the container this runner made, or it has stopped, so another runner may use the ${TAG} tag`];
    try {
      const current = kitOf(kitDir);
      for (const f of new Set([...Object.keys(kit), ...Object.keys(current)])) if (JSON.stringify(kit[f]) !== JSON.stringify(current[f])) out.push(`${f} changed since the run started`);
    } catch (e) { out.push(e instanceof Error ? e.message : String(e)); }
    return out;
  };
  const stopIf = (/** @type {string[]} */ why, /** @type {string} */ where) => { if (why.length) throw new Error(`${why.join("; ")} (${where}); stopped with no report`); };
  // The ledger's halts were refused before any Docker call (runPairs, haltOf).
  for (const inv of plan) {
    if (records.has(inv.name)) continue;
    if (o.stop?.()) throw new Error(`stopped before ${inv.name}; run the command again to go on`);
    stopIf(lost(), `before ${inv.name}`);
    const want = ids[/** @type {"base" | "head"} */ (inv.image)];
    const out = join(o.results, inv.name), logFile = join(dir, "inv", `${inv.name}.log`);
    const start = { name: inv.name, want, started: now() };
    appendFileSync(file, JSON.stringify(start) + "\n");
    /** @type {Record<string, unknown>} */
    let end;
    if (existsSync(out) || existsSync(logFile)) end = { ...start, ended: now(), fresh: false };
    else {
      const tag = o.exec("docker", ["tag", want, TAG], { env });
      const before = id(TAG);
      if (tag.status !== 0) end = { ...start, ended: now(), fresh: true, tagRc: tag.status, before };
      else {
        // Written before count.mjs starts, so a restart that finds no exit after it refuses to go on.
        appendFileSync(file, JSON.stringify({ name: inv.name, dispatched: now() }) + "\n");
        // Every event is needed here (invalid), so count.mjs's probe refuses a set any event of which it cannot read.
        const r = o.exec(process.execPath, [join(kitDir, "count.mjs"), inv.name, ...COUNT_ARGS, inv.target], { log: logFile, env: { ...env, [EVERY_EVENT]: "1" } });
        // Its exit first, before anything here that can fail: a halt is in the ledger whatever follows.
        const exited = { name: inv.name, exited: now(), rc: r.status, signal: r.signal ?? null };
        appendFileSync(file, JSON.stringify(exited) + "\n");
        // A halt stops here, before the image read, the seals and the lock's check: the one Docker
        // call left is the lock's bounded removal, and a replay refuses at its exit row.
        if (r.status === HALT_EXIT) throw new Error(halt(inv.name));
        if (r.signal) throw new Error(signalled(inv.name, r.signal));
        const after = id(TAG);
        // The bytes the reading is made from, so a replay reads these or none.
        const artifacts = seal(out, artifactsOf(inv.target));
        end = { ...start, ended: now(), fresh: true, tagRc: 0, rc: r.status, signal: null, before, after, artifacts };
      }
    }
    // Seen as it ends, so an invocation that ran while the lock or the kit was lost is not valid.
    const gone = lost();
    if (gone.length) end = { ...end, lost: gone };
    appendFileSync(file, JSON.stringify(end) + "\n");
    records.set(inv.name, end);
    stopIf(gone, `in ${inv.name}`);
    log(`${inv.name} rc ${end.rc ?? "-"} ${((Number(end.ended) - start.started) / 1000).toFixed(1)} s`);
    // A signal sent to this process alone is handled between invocations.
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (o.stop?.()) throw new Error("stopped before the report was written; run the command again to read it");
  stopIf(lost(), "before the report");
  const load = (/** @type {string} */ name, /** @type {string} */ target, /** @type {any} */ record) => {
    /** @type {string[]} */
    const why = [];
    const at = (/** @type {string} */ f) => {
      const sealed = record.artifacts?.[f], path = join(o.results, name, f);
      if (!sealed) return void why.push(`${f} was not there when the invocation ended`);
      if (!existsSync(path)) return void why.push(`${f} is gone since the invocation ended`);
      const bytes = readFileSync(path);
      if (bytes.length !== sealed.bytes || sha256(bytes) !== sealed.sha256) return void why.push(`${f} changed since the invocation ended`);
      try { return JSON.parse(bytes.toString("utf8")); } catch { return void why.push(`${f} is not JSON`); }
    };
    const [rows, summary, images, kernelSummary] = artifactsOf(target).map(at);
    return { row: rows?.[`corten/${target}`], summary, kernelSummary, launched: images?.[`corten/${target}`], why };
  };
  const targets = readRun(plan, records, load, ids);
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
  try {
    const { md, targets: read } = await runPairs({ ...options, images: { base, head }, results: join(here, "results"), exec: spawnExec, bounded: spawnBounded, stop: () => stopped, log: (l) => console.log(new Date().toISOString(), l) });
    console.log(md);
    process.exit(complete(read) ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
