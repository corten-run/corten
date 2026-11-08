// The server-rendering part of a round's summary (run-ssr.mjs's files): each app's phases, their
// passes merged, which apps failed, and which numbers are within noise of Corten's. summarize.mjs
// writes it; ssr.test.mjs tests it on files it writes itself.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { edgeBound, edgeContainer } from "./edge.mjs";
import { mergedMixed, mixedOf } from "./mixed.mjs";
import { passFile, passesOf, spread, withinNoise } from "./passes.mjs";

const read = (/** @type {string} */ file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

/**
 * The load phases, in the order run-ssr.mjs runs them. Item pages from the item API then have the
 * mixed phase (mixed.mjs), read on its own: its numbers are by kind of request.
 */
export const phases = ["fixed", "sat64", "sat256"];

/**
 * How many passes run-ssr.mjs was asked for in a source's folder: its `passes.json`, which rounds
 * from #811 on write, else one.
 * @param {string} folder
 */
export const passesIn = (folder) => passesOf(String(read(join(folder, "passes.json"))?.passes ?? ""));

/**
 * One pass of one phase: its k6 summary, the app's sampled stats and its counted CPU time.
 * @param {string} folder @param {string} name the app @param {string} base the files' name
 */
export function phaseOf(folder, name, base) {
  const k6 = read(join(folder, `${base}.json`));
  if (!k6) return null;
  const d = k6.metrics.http_req_duration;
  const sampled = read(join(folder, `${base}-stats.json`));
  const stats = sampled?.[`fsw-${name}`];
  // The item API's samples, where it was sampled: the entry that is neither the app's nor the edge's.
  const api = Object.entries(sampled ?? {}).find(([c]) => c !== `fsw-${name}` && c !== edgeContainer)?.[1];
  // CPU time the app's container used in the phase, from its cgroup counter (run-ssr writes it
  // from r7 on); before that, the sampled average stands in for it.
  const cpu = read(join(folder, `${base}-cpu.json`));
  const usec = cpu?.[`fsw-${name}`]?.usec;
  // The matched tier's edge (edge.mjs), where the app was reached through it: its counted CPU time.
  const edgeUsec = cpu?.[edgeContainer]?.usec;
  // k6's own CPU time and the cores it had (run-ssr writes them in every tier, from #809 on).
  const k6Usec = cpu?.k6?.usec;
  const k6Cores = cpu?.k6?.cores;
  // The cores the edge had (run-ssr.mjs's edge.json), to say whether it may have bounded the phase.
  const edgeCores = read(join(folder, "edge.json"))?.cores;
  const rps = k6.metrics.http_reqs.rate;
  const offered = k6.metrics.http_reqs.count + (k6.metrics.dropped_iterations?.count ?? 0);
  const edgePct = edgeUsec > 0 ? +((100 * +rps.toFixed(0)) / (k6.metrics.http_reqs.count / (edgeUsec / 1e6))).toFixed(1) : null;
  const k6Pct = k6Usec > 0 ? +((100 * +rps.toFixed(0)) / (k6.metrics.http_reqs.count / (k6Usec / 1e6))).toFixed(1) : null;
  const perCpuSecond = usec > 0 ? Math.round(k6.metrics.http_reqs.count / (usec / 1e6)) : stats?.cpuAvgPct > 0 ? Math.round(rps / (stats.cpuAvgPct / 100)) : null;
  return {
    rps: +k6.metrics.http_reqs.rate.toFixed(0),
    // The fixed rate's requests that were never sent because every client was waiting.
    unsentPct: +((100 * (k6.metrics.dropped_iterations?.count ?? 0)) / offered).toFixed(2),
    p50: +d["p(50)"].toFixed(1),
    p95: +d["p(95)"].toFixed(1),
    p99: +d["p(99)"].toFixed(1),
    failedPct: +(100 * k6.metrics.http_req_failed.value).toFixed(2),
    cpuPct: stats?.cpuAvgPct ?? null,
    memMiB: stats?.memAvgMiB ?? null,
    memMaxMiB: stats?.memMaxMiB ?? null,
    // Requests per second of the app's CPU time, and per MiB of its peak memory in the phase.
    perCpuSecond,
    cpuCounted: usec > 0,
    // The share of a CPU the app used, from the counted time where there is one (the sampled
    // `cpuPct` otherwise): what the cost table shows.
    cpuUsedPct: usec > 0 && perCpuSecond ? +((100 * +rps.toFixed(0)) / perCpuSecond).toFixed(1) : stats?.cpuAvgPct ?? null,
    perMiB: stats?.memMaxMiB > 0 ? +(rps / stats.memMaxMiB).toFixed(1) : null,
    apiCpuPct: api?.cpuAvgPct ?? null,
    // Requests per second of the edge's CPU time and the share of a CPU it used: what the
    // deployed shape adds to each request, beside the app's own.
    edgePerCpuSecond: edgeUsec > 0 ? Math.round(k6.metrics.http_reqs.count / (edgeUsec / 1e6)) : null,
    edgeCpuUsedPct: edgePct,
    // True when the edge used at least 90% of its cores: the phase measured the edge, not the app.
    edgeBound: edgeCores > 0 ? edgeBound(edgePct, edgeCores) : null,
    // The share of a CPU k6 used, and whether it used 90% of the cores it had (then k6 set the rate).
    k6CpuUsedPct: k6Pct,
    loadBound: k6Cores > 0 && k6Pct !== null ? k6Pct >= 90 * k6Cores : null,
    // In a saturation phase reached through the edge, whether the app used less than 90% of its one
    // core: then the edge, k6, the machine or the app's own concurrency set the rate, not its CPU.
    // The fixed rate's app is meant to be idle, and directly (the defaults tier) it is not said.
    appIdle: /-sat\d+(-p\d+)?$/.test(base) && edgeUsec > 0 && usec > 0 && perCpuSecond ? (100 * +rps.toFixed(0)) / perCpuSecond < 90 : null,
  };
}

/**
 * Whether a round reached its apps through the edge: run-ssr.mjs writes edge.json into a load
 * folder only then, so a matched round run with BENCH_EDGE=off has none.
 * @param {string} raw the round's raw folder
 */
export const edgeOf = (raw) =>
  existsSync(raw) && readdirSync(raw, { withFileTypes: true }).some((d) => d.isDirectory() && existsSync(join(raw, d.name, "edge.json")));

/** The numbers a phase of several passes gives as their median, with `range` their spread. */
const spreadKeys = ["rps", "unsentPct", "p50", "p95", "p99", "failedPct", "cpuPct", "memMiB", "memMaxMiB", "perCpuSecond", "cpuUsedPct", "perMiB", "apiCpuPct", "edgePerCpuSecond", "edgeCpuUsedPct", "k6CpuUsedPct"];

/**
 * Several passes of one phase: each number the passes' median (one a pass measured), `range`
 * each one's `[min, max]`, `passes` how many measured it and `asked` how many were asked for
 * when that is more. A failure counts at its worst pass: `unsentPct` and `failedPct` are the
 * most any pass had, so one bad pass fails the app.
 * @param {NonNullable<ReturnType<typeof phaseOf>>[]} runs @param {number} asked
 */
export function merged(runs, asked) {
  /** @type {Record<string, any>} */
  const out = { passes: runs.length, range: {} };
  if (asked > runs.length) out.asked = asked;
  for (const key of spreadKeys) {
    const s = spread(runs.map((r) => /** @type {any} */ (r)[key]));
    out[key] = s?.median ?? null;
    if (s) out.range[key] = [s.min, s.max];
  }
  out.unsentPct = Math.max(...runs.map((r) => r.unsentPct));
  out.failedPct = Math.max(...runs.map((r) => r.failedPct));
  out.cpuCounted = runs.every((r) => r.cpuCounted);
  for (const flag of /** @type {const} */ (["edgeBound", "loadBound", "appIdle"])) {
    if (runs.some((r) => r[flag] !== null && r[flag] !== undefined)) out[flag] = runs.some((r) => r[flag] === true);
  }
  return out;
}

/**
 * Why an app failed, or null: it did not start in some pass, or in some pass could not serve the
 * fixed rate (more than 5% unsent or 1% failed), said from that pass's own numbers.
 * @param {(Record<string, any> | null)[]} startups one per pass asked for
 * @param {(ReturnType<typeof phaseOf>)[]} fixed one per pass asked for
 */
function failure(startups, fixed) {
  const several = startups.length > 1;
  const inPass = (/** @type {number} */ i) => (several ? ` (pass ${i + 1})` : "");
  const notStarted = startups.findIndex((s) => s?.failed);
  if (notStarted >= 0) return `${startups[notStarted]?.failed}${inPass(notStarted)}`;
  const worst = (/** @type {"unsentPct" | "failedPct"} */ key) =>
    fixed.reduce((at, r, i) => (r && (at < 0 || r[key] > /** @type {any} */ (fixed[at])[key]) ? i : at), -1);
  const unsent = worst("unsentPct");
  if (unsent >= 0 && /** @type {any} */ (fixed[unsent]).unsentPct > 5) {
    const r = /** @type {any} */ (fixed[unsent]);
    return `served ${r.rps}/s of the fixed rate, ${r.unsentPct}% never sent${inPass(unsent)}`;
  }
  const failed = worst("failedPct");
  if (failed >= 0 && /** @type {any} */ (fixed[failed]).failedPct > 1) return `${/** @type {any} */ (fixed[failed]).failedPct}% of requests at the fixed rate failed${inPass(failed)}`;
  return null;
}

/**
 * The SSR part of a round's summary from its raw folder: for each source ("fixture" and "api" are
 * the item page, "fixture-json" and "api-json" the item as JSON) each app's startup and phases,
 * and for "api" its mixed phase (`mixed`).
 * Every pass asked for is read; a phase a pass has no files for counts in `asked`, not as a
 * failure, since a step skipped after the droplet hung leaves the same gap.
 * @param {string} raw @param {string[]} names the apps
 */
export function ssrOf(raw, names) {
  /** @type {Record<string, Record<string, any>>} */
  const ssr = {};
  for (const [key, source, suffix] of [["fixture", "fixture", ""], ["api", "api", ""], ["fixture-json", "fixture", "-json"], ["api-json", "api", "-json"]]) {
    ssr[key] = {};
    const folder = join(raw, source);
    const asked = passesIn(folder);
    for (const name of names) {
      const file = `${name}${suffix}`;
      const startups = Array.from({ length: asked }, (_, i) => read(join(folder, `${passFile(`${file}-startup`, i + 1)}.json`)));
      /** @type {Record<string, any>} */
      const entry = { startup: startups[0] };
      /** @type {ReturnType<typeof phaseOf>[]} */
      let fixed = [];
      for (const phase of phases) {
        const each = Array.from({ length: asked }, (_, i) => phaseOf(folder, name, passFile(`${file}-${phase}`, i + 1)));
        if (phase === "fixed") fixed = each;
        const runs = /** @type {NonNullable<ReturnType<typeof phaseOf>>[]} */ (each.filter(Boolean));
        if (!runs.length) continue;
        entry[phase] = asked === 1 ? runs[0] : merged(runs, asked);
      }
      if (key === "api") {
        const mixed = Array.from({ length: asked }, (_, i) => mixedOf(folder, name, passFile(`${file}-mixed`, i + 1))).filter((m) => m !== null);
        if (mixed.length) entry.mixed = asked === 1 ? mixed[0] : mergedMixed(mixed, asked);
      }
      // Apps run with their usual settings, not tuned to fit one CPU and 1 GiB: one that did not
      // start, or could not serve the fixed rate, failed.
      const failed = failure(startups, fixed);
      if (failed) entry.failed = failed;
      if (entry.fixed || entry.failed) ssr[key][name] = entry;
    }
  }
  // Within noise of Corten, where both have two or more passes: an app's range overlaps Corten's,
  // for its rate (not at the fixed rate, which every app is held to) and its requests per
  // CPU-second.
  for (const entries of Object.values(ssr)) {
    const reference = entries.corten;
    if (!reference) continue;
    for (const [name, entry] of Object.entries(entries)) {
      if (name === "corten") continue;
      for (const phase of phases) {
        const mine = entry[phase], theirs = reference[phase];
        if (!mine?.passes || !theirs?.passes) continue;
        const of = (/** @type {any} */ e, /** @type {string} */ key) => (e.range[key] ? { min: e.range[key][0], max: e.range[key][1] } : null);
        /** @type {Record<string, boolean | null>} */
        const near = { perCpuSecond: withinNoise(of(mine, "perCpuSecond"), mine.passes, of(theirs, "perCpuSecond"), theirs.passes) };
        if (phase !== "fixed") near.rps = withinNoise(of(mine, "rps"), mine.passes, of(theirs, "rps"), theirs.passes);
        mine.withinNoiseOfCorten = near;
      }
    }
  }
  return ssr;
}
