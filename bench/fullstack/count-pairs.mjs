// count-pairs.mjs: the catalog count of a change, the base's image against the head's, with its
// own A/A, the base's image against itself, in the same run (CONTRIBUTING.md, Pull requests,
// item 2; docs/design.md#choice-placement-runs, "The catalog's `page` and `json`").
//
//   node bench/fullstack/count-pairs.mjs <prefix> <base image> <head image> [pairs=100] [targets=page,json]
//
// with BENCH_APP_CPUS and BENCH_LOAD_CPUS as count.mjs reads them. Each invocation is one run of
// `count.mjs <round> 1 corten <target>` with the side's image tagged `cb-corten` first. For each
// target, pair i is two comparisons of two invocations each: the change, sides `base` (the base's
// image) and `head` (the head's), and its A/A, the same two names with the base's image under
// both. Pair 0 is not recorded; pairs 1 to <pairs> are. In odd pairs the side named `base` goes
// first and the A/A before the change; in even pairs `head` and the change. So a run is four
// invocations a pair and target where a count without its A/A is two: twice the time.
//
// A pair's change is the second side over the first less 1 (`head` / `base` - 1) in user plus
// kernel cycles a request; the bound is the j-th smallest of the n recorded changes, j the
// smallest rank with P(Binomial(n, 1/2) >= j) <= 5% (the 59th of 100). The A/A is read twice, as
// recorded and with its labels swapped (`base` / `head` - 1), as bench/placement reads one. It
// resolves when both of its bounds less +1% are inside the default band; then the change's bound
// less +1% is read against the band as item 2 reads it: above, a miss; below, it meets +1%;
// inside, not decided. Where the A/A does not resolve, or has no bound, the change is not
// decided and neither holds nor clears. A comparison with a pair that is not valid has no bound.
//
// No invocation is run again: `<results>/<prefix>/invocations.jsonl` records each one as it starts
// and ends, and the command run again goes on from the first not started. It writes
// `report.json` and prints the report when every invocation has been started.
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const COUNTS = ["userPerRequest", "kernelPerRequest", "userCyclesPerRequest", "kernelCyclesPerRequest", "userL1iMissesPerRequest"];
/** User plus kernel cycles a request, the measure the count is read in. */
export const cycles = (/** @type {Record<string, number>} */ row) => row.userCyclesPerRequest + row.kernelCyclesPerRequest;

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

/**
 * Why one invocation's row is not valid, or [] when it is.
 * @param {{ row?: any, summary?: any, want: string, before?: string, after?: string, rc?: number, interrupted?: boolean }} inv
 */
export function invalid(inv) {
  if (inv.interrupted) return ["started and never ended; not run again"];
  const why = [];
  if (inv.before !== inv.want || inv.after !== inv.want) why.push("the image counted was not the side's");
  const row = inv.row;
  if (row == null) return [...why, `no row (count.mjs exit ${inv.rc ?? "-"})`];
  if (!Array.isArray(row)) return [...why, `count.mjs recorded failed: ${row.failed}`];
  if (row.length !== 1) return [...why, `${row.length} rows, not 1`];
  const r = row[0];
  if (r.requests !== REQUESTS) why.push(`${r.requests} requests, not ${REQUESTS}`);
  if (r.failed !== 0) why.push(`${r.failed} failed requests`);
  for (const c of COUNTS) if (r[c] == null) why.push(`${c} is null`);
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
  const valid = pairs.filter((p) => p.base != null && p.head != null && p.base > 0 && p.head > 0);
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
 * resolved" when either is outside, "no bound" when it has none.
 * @param {ReturnType<typeof compare>} aa
 */
export function resolution(aa, band = BAND) {
  if (!aa.complete || aa.bound == null || aa.swappedBound == null) return "no bound";
  return inside(aa.bound, band) && inside(aa.swappedBound, band) ? "resolved" : "not resolved";
}

/**
 * The change's reading given its A/A: held or cleared only where the A/A resolves.
 * @param {ReturnType<typeof compare>} change
 * @param {ReturnType<typeof compare>} aa
 */
export function reading(change, aa, band = BAND) {
  if (!change.complete || change.bound == null) return { verdict: "no bound: does not pass", decided: false, holds: false, clears: false };
  const aaIs = resolution(aa, band);
  if (aaIs === "no bound") return { verdict: "not decided: the count's A/A has no bound, so it neither holds nor clears", decided: false, holds: false, clears: false };
  if (aaIs === "not resolved") return { verdict: "not decided: the count's A/A does not resolve the default band, so it neither holds nor clears", decided: false, holds: false, clears: false };
  const d = change.bound - MARGIN;
  if (d > band.high) return { verdict: "a miss", decided: true, holds: true, clears: false };
  if (d < band.low) return { verdict: "meets +1%", decided: true, holds: false, clears: true };
  return { verdict: "inside the default band: not decided", decided: false, holds: false, clears: false };
}

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
    const got = ended ? load(inv.name, inv.target) : {};
    const why = rec ? invalid({ ...got, want: rec.want, before: rec.before, after: rec.after, rc: rec.rc, interrupted: !ended }) : ["not run"];
    const row = Array.isArray(got.row) && got.row.length === 1 ? got.row[0] : null;
    const value = why.length === 0 && row ? cycles(row) : null;
    const byTarget = (pairs[inv.target] ??= {});
    const list = (byTarget[inv.comparison] ??= []);
    let p = list.find((x) => x.pair === inv.pair);
    if (!p) list.push((p = { pair: inv.pair, recorded: inv.recorded, first: inv.pair % 2 ? "base" : "head", base: null, head: null, why: [], instructions: {} }));
    p[inv.side] = value;
    p.instructions[inv.side] = row?.userPerRequest ?? null;
    p.why.push(...why.map((w) => `${inv.side}: ${w}`));
  }
  const targets = {};
  for (const [target, byComparison] of Object.entries(pairs)) {
    const recorded = (/** @type {any[]} */ list) => list.filter((p) => p.recorded);
    const change = compare(recorded(byComparison.ab ?? [])), aa = compare(recorded(byComparison.aa ?? []));
    targets[target] = { change, aa, resolution: resolution(aa), reading: reading(change, aa), pairs: byComparison };
  }
  return targets;
}

const fmt = (/** @type {number | null} */ x) => (x == null ? "none" : pct(x));

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
      "", `The A/A: ${t.resolution}. The count's resolution is the A/A's two bounds; a change is held or cleared only where both, less +1%, are inside the band.`, "");
    const bad = Object.values(t.pairs).flat().filter((p) => p.why.length);
    if (bad.length) out.push(`Pairs not valid: ${bad.map((p) => `${p.pair}: ${p.why.join("; ")}`).join(" | ")}.`, "");
  }
  return out.join("\n");
}

/**
 * Runs a count's invocations not yet started, then reads them all.
 * @param {{ prefix: string, images: { base: string, head: string }, last: number, targets: string[], results: string,
 *   exec: (cmd: string, args: string[], options?: object) => { status: number | null, stdout?: string },
 *   now?: () => number, log?: (line: string) => void }} o
 */
export function runPairs(o) {
  const now = o.now ?? Date.now, log = o.log ?? (() => {});
  const dir = join(o.results, o.prefix);
  mkdirSync(join(dir, "inv"), { recursive: true });
  const file = join(dir, "invocations.jsonl");
  const id = (/** @type {string} */ image) => (o.exec("docker", ["image", "inspect", "-f", "{{.Id}}", image]).stdout ?? "").trim();
  const want = { base: id(o.images.base), head: id(o.images.head) };
  if (!want.base || !want.head) throw new Error("no image for a side");
  if (want.base === want.head) throw new Error("the two sides are one image: the A/A is the run's own, so the change's sides must differ");
  const plan = schedule(o.last, o.targets, o.prefix);
  const records = readRecords(file);
  for (const inv of plan) {
    if (records.has(inv.name)) continue;
    const image = o.images[/** @type {"base" | "head"} */ (inv.image)];
    const start = { name: inv.name, want: want[/** @type {"base" | "head"} */ (inv.image)], started: now() };
    appendFileSync(file, JSON.stringify(start) + "\n");
    o.exec("docker", ["tag", image, "cb-corten"]);
    const before = id("cb-corten");
    const r = o.exec(process.execPath, [join(here, "count.mjs"), inv.name, "1", "corten", inv.target], { log: join(dir, "inv", `${inv.name}.log`) });
    const after = id("cb-corten");
    const end = { ...start, ended: now(), rc: r.status, before, after };
    appendFileSync(file, JSON.stringify(end) + "\n");
    records.set(inv.name, end);
    log(`${inv.name} rc ${r.status} ${((end.ended - start.started) / 1000).toFixed(1)} s`);
  }
  const load = (/** @type {string} */ name, /** @type {string} */ target) => {
    const at = (/** @type {string} */ f) => (existsSync(join(o.results, name, f)) ? JSON.parse(readFileSync(join(o.results, name, f), "utf8")) : undefined);
    return { row: at("instructions.json")?.[`corten/${target}`], summary: at(`count-corten-${target}-0.json`) };
  };
  const targets = readRun(plan, records, load);
  const json = { prefix: o.prefix, images: o.images, ids: want, last: o.last, band: BAND, margin: MARGIN, targets };
  writeFileSync(join(dir, "report.json"), JSON.stringify(json, null, 1) + "\n");
  return { targets, md: markdown(targets, { prefix: o.prefix, base: `${o.images.base} ${want.base}`, head: `${o.images.head} ${want.head}` }) };
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [prefix, base, head, pairs = "100", targetsArg = "page,json"] = process.argv.slice(2);
  if (!prefix || !base || !head) {
    console.error("usage: node count-pairs.mjs <prefix> <base image> <head image> [pairs=100] [targets=page,json]");
    process.exit(3);
  }
  const targets = targetsArg.split(",");
  for (const t of targets) if (t !== "page" && t !== "json") throw new Error(`unknown target ${t}`);
  const exec = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {{ log?: string }} */ options = {}) => {
    if (!options.log) return spawnSync(cmd, args, { encoding: "utf8" });
    const fd = openSync(options.log, "w");
    try { return spawnSync(cmd, args, { stdio: ["ignore", fd, fd] }); } finally { closeSync(fd); }
  };
  const { md, targets: read } = runPairs({ prefix, images: { base, head }, last: Number(pairs), targets, results: join(here, "results"), exec, log: (l) => console.log(new Date().toISOString(), l) });
  console.log(md);
  process.exit(Object.values(read).every((t) => t.change.complete && t.aa.complete) ? 0 : 1);
}