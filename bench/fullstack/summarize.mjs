// Writes results/<round>/summary.json and prints the tables in README form.
// Usage: node summarize.mjs <round>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { apps } from "./apps.mjs";
import { rawOf } from "./pack.mjs";
import { passFile, spread, withinNoise } from "./passes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const round = process.argv[2] ?? "r1";
const dir = join(here, "results", round);
// A packed round's raw files (each app's k6, CPU and startup files) are read from its archive.
const raw = rawOf(dir);
const read = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
const pct = (xs, p) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))].toFixed(0) : null;
};
const summary = { ssr: {}, build: read(join(dir, "build.json")), coldStart: read(join(dir, "cold-start.json")), bytes: read(join(dir, "bytes.json")), instructions: {}, browser: {} };
// Steps droplet.mjs skipped after the droplet hung ("<time> step <name> skipped: <why>"): their
// results are partly or wholly missing. Only rounds with one get the key.
const skippedFile = join(dir, "skipped.txt");
if (existsSync(skippedFile)) {
  summary.skipped = readFileSync(skippedFile, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const m = /^(\S+) step (\S+) skipped: (.*)$/.exec(line);
    return m ? { at: m[1], step: m[2], why: m[3] } : { line };
  });
}

/**
 * One pass of one phase: its k6 summary, the app's sampled stats and its counted CPU time.
 * @param {string} source @param {string} name the app @param {string} base the files' name
 */
function phaseOf(source, name, base) {
  const k6 = read(join(raw, source, `${base}.json`));
  if (!k6) return null;
  const d = k6.metrics.http_req_duration;
  const sampled = read(join(raw, source, `${base}-stats.json`));
  const stats = sampled?.[`fsw-${name}`];
  // The item API's samples, where it was sampled: the entry that is not the app's.
  const api = Object.entries(sampled ?? {}).find(([c]) => c !== `fsw-${name}`)?.[1];
  // CPU time the app's container used in the phase, from its cgroup counter (run-ssr writes it
  // from r7 on); before that, the sampled average stands in for it.
  const usec = read(join(raw, source, `${base}-cpu.json`))?.[`fsw-${name}`]?.usec;
  const rps = k6.metrics.http_reqs.rate;
  const offered = k6.metrics.http_reqs.count + (k6.metrics.dropped_iterations?.count ?? 0);
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
    perCpuSecond: usec > 0 ? Math.round(k6.metrics.http_reqs.count / (usec / 1e6)) : stats?.cpuAvgPct > 0 ? Math.round(rps / (stats.cpuAvgPct / 100)) : null,
    cpuCounted: usec > 0,
    perMiB: stats?.memMaxMiB > 0 ? +(rps / stats.memMaxMiB).toFixed(1) : null,
    apiCpuPct: api?.cpuAvgPct ?? null,
  };
}

/** The numbers a phase of several passes gives as their median, with `range` their spread. */
const spreadKeys = ["rps", "unsentPct", "p50", "p95", "p99", "failedPct", "cpuPct", "memMiB", "memMaxMiB", "perCpuSecond", "perMiB", "apiCpuPct"];

/**
 * Several passes of one phase: each number the passes' median (one a pass measured), `range`
 * each one's `[min, max]`, and `passes` how many there were. A failure counts at its worst
 * pass: `unsentPct` and `failedPct` are the most any pass had, so one bad pass fails the app.
 * @param {NonNullable<ReturnType<typeof phaseOf>>[]} runs
 */
function merged(runs) {
  /** @type {Record<string, any>} */
  const out = { passes: runs.length, range: {} };
  for (const key of spreadKeys) {
    const s = spread(runs.map((r) => /** @type {any} */ (r)[key]));
    out[key] = s?.median ?? null;
    if (s) out.range[key] = [s.min, s.max];
  }
  out.unsentPct = Math.max(...runs.map((r) => r.unsentPct));
  out.failedPct = Math.max(...runs.map((r) => r.failedPct));
  out.cpuCounted = runs.every((r) => r.cpuCounted);
  return out;
}

// "fixture" and "api" are the item page; "fixture-json" and "api-json" the item as JSON.
for (const [key, source, suffix] of [["fixture", "fixture", ""], ["api", "api", ""], ["fixture-json", "fixture", "-json"], ["api-json", "api", "-json"]]) {
  summary.ssr[key] = {};
  for (const name of Object.keys(apps)) {
    const file = `${name}${suffix}`;
    const entry = { startup: read(join(raw, source, `${file}-startup.json`)) };
    for (const phase of ["fixed", "sat64", "sat256"]) {
      // Pass 1's files, then any later passes' (`-p2` on), until one is missing.
      const runs = [];
      for (let pass = 1; ; pass += 1) {
        const run = phaseOf(source, name, passFile(`${file}-${phase}`, pass));
        if (!run) break;
        runs.push(run);
      }
      if (!runs.length) continue;
      entry[phase] = runs.length === 1 ? runs[0] : merged(runs);
    }
    // Apps run with their usual settings, not tuned to fit one CPU and 1 GiB: one that did not
    // start, or could not serve the fixed rate (more than 5% unsent or 1% failed), failed.
    if (entry.startup?.failed) entry.failed = entry.startup.failed;
    else if (entry.fixed && entry.fixed.unsentPct > 5) entry.failed = `served ${entry.fixed.rps}/s of the fixed rate, ${entry.fixed.unsentPct}% never sent`;
    else if (entry.fixed && entry.fixed.failedPct > 1) entry.failed = `${entry.fixed.failedPct}% of requests at the fixed rate failed`;
    if (entry.fixed || entry.failed) summary.ssr[key][name] = entry;
  }
}

// Within noise of Corten, where both have two or more passes: an app's range overlaps Corten's,
// for its rate and for its requests per CPU-second.
for (const entries of Object.values(summary.ssr)) {
  const reference = entries.corten;
  if (!reference) continue;
  for (const [name, entry] of Object.entries(entries)) {
    if (name === "corten") continue;
    for (const phase of ["fixed", "sat64", "sat256"]) {
      const mine = entry[phase], theirs = reference[phase];
      if (!mine?.passes || !theirs?.passes) continue;
      const of = (/** @type {any} */ e, /** @type {string} */ key) => (e.range[key] ? { min: e.range[key][0], max: e.range[key][1] } : null);
      mine.withinNoiseOfCorten = {
        rps: withinNoise(of(mine, "rps"), mine.passes, of(theirs, "rps"), theirs.passes),
        perCpuSecond: withinNoise(of(mine, "perCpuSecond"), mine.passes, of(theirs, "perCpuSecond"), theirs.passes),
      };
    }
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const [key, runs] of Object.entries(read(join(dir, "instructions.json")) ?? {})) {
  if (!Array.isArray(runs)) { summary.instructions[key] = { failed: runs.failed }; continue; }
  summary.instructions[key] = { user: median(runs.map((r) => r.userPerRequest)), kernel: median(runs.map((r) => r.kernelPerRequest)), runs: runs.length, failed: runs.reduce((n, r) => n + r.failed, 0) };
}

const rows = read(join(dir, "browser.json")) ?? [];
for (const row of rows) {
  const key = `${row.profile}/${row.app}`;
  (summary.browser[key] ??= []).push(row);
}
for (const [key, list] of Object.entries(summary.browser)) {
  const m = (k) => ({ med: pct(list.map((r) => r[k]), 0.5), p90: pct(list.map((r) => r[k]), 0.9) });
  summary.browser[key] = { n: list.length, allWorked: list.every((r) => r.sortWorked !== false), ttfb: m("ttfb"), fcp: m("fcp"), lcp: m("lcp"), interactive: m("hydratedAt"), tbt: m("tbtToHydration"), action: m("actionMs"), clientNav: m("clientNavMs"), heapMB: { med: +(pct(list.map((r) => r.jsHeapUsedMB * 10), 0.5) / 10).toFixed(1) } };
}
writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 1));

const line = (cells) => `| ${cells.join(" | ")} |`;
for (const s of summary.skipped ?? []) console.log(`SKIPPED: step ${s.step ?? "?"} (${s.why ?? s.line}); its results are partly or wholly missing`);
// A number, with its passes' range when there were several, and "~" when it is within noise of
// Corten's (their ranges overlap).
const show = (/** @type {any} */ e, /** @type {string} */ key, /** @type {string} */ unit = "") => {
  if (e?.[key] === null || e?.[key] === undefined) return "-";
  const range = e.range?.[key];
  const near = e.withinNoiseOfCorten?.[key] ? " ~" : "";
  return range && range[0] !== range[1] ? `${e[key]}${unit} (${range[0]}-${range[1]})${near}` : `${e[key]}${unit}${near}`;
};
const passesNote = (/** @type {any} */ entries) => {
  const n = Math.max(0, ...Object.values(entries).flatMap((e) => ["fixed", "sat64", "sat256"].map((p) => /** @type {any} */ (e)[p]?.passes ?? 1)));
  return n > 1 ? `, median of ${n} passes (range), ~ within noise of corten` : "";
};
// The cost first: what a steady load costs the machine (CPU at the fixed rate, requests per
// CPU-second), then what each app does at its peak.
console.log("\nCost (requests per CPU-second at the fixed rate and at 64 users, CPU at the fixed rate, 64-user requests a second per MiB)");
for (const source of Object.keys(summary.ssr)) {
  const note = passesNote(summary.ssr[source]);
  if (note) console.log(`${source}${note}`);
  for (const [name, e] of Object.entries(summary.ssr[source])) {
    const f = e.fixed, s = e.sat64;
    if (!s) continue;
    console.log(line([`${source}/${name}`, `fixed ${show(f, "perCpuSecond")}/CPU-s at ${f?.rps}/s, ${show(f, "cpuPct", "%")} CPU`, `64 users ${show(s, "perCpuSecond")}/CPU-s${s.cpuCounted ? "" : " (sampled)"}`, `${show(s, "perMiB")}/s per MiB`, s.apiCpuPct === null ? "" : `item API ${s.apiCpuPct}%`, e.failed ? "FAILED" : ""]));
  }
}
for (const source of Object.keys(summary.ssr)) {
  console.log(`\nSSR ${source}${passesNote(summary.ssr[source])}`);
  console.log(line(["App", "fixed rate: achieved rps, p50/p99 ms, CPU", "64 VUs: rps, p50/p99", "256 VUs: rps, p99, failed", "memory under load"]));
  for (const [name, e] of Object.entries(summary.ssr[source])) {
    const f = e.fixed, s = e.sat64, b = e.sat256;
    if (e.failed) console.log(line([name, `FAILED: ${e.failed}`, "", "", ""]));
    if (!f) continue;
    console.log(line([name, `${f.rps}, ${show(f, "p50")}/${show(f, "p99")}, ${show(f, "cpuPct", "%")}`, `${show(s, "rps")}, ${show(s, "p50")}/${show(s, "p99")}`, `${show(b, "rps")}, ${show(b, "p99")}, ${b?.failedPct}%`, `${s?.memMiB}-${b?.memMaxMiB} MiB`]));
  }
}
if (Object.keys(summary.instructions).length) {
  console.log("\nInstructions per request (median, user / kernel)");
  for (const [key, c] of Object.entries(summary.instructions)) if (c.failed) console.log(line([key, `FAILED: ${c.failed}`])); else console.log(line([key, `${c.user.toLocaleString("en-US")} / ${c.kernel.toLocaleString("en-US")}`, `${c.runs} runs`, `${c.failed} failed`]));
}
if (summary.build) {
  const s = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)} s`;
  console.log(`\nBuild (wall, CPU-seconds, peak memory; ${Object.values(summary.build)[0]?.cpus})`);
  for (const [name, b] of Object.entries(summary.build)) {
    // Entries written before `complete` was recorded have none, and finished.
    if (b.failed || b.complete === false) { console.log(line([name, `FAILED: ${(b.failed ?? "stopped before it finished").split("\n")[0]}`])); continue; }
    const dev = b.dev ? `dev ${s(b.dev.clean.ms)}, after the edit ${s(b.dev.rebuild.ms)} (${b.dev.rebuild.cpuS} CPU-s)` : "";
    console.log(line([name, `clean (deps + build) ${s(b.clean.ms)}, ${b.clean.cpuS} CPU-s`, `deps ${s(b.deps.ms)} (downloads)`, `build ${s(b.build.ms)}, ${b.build.cpuS} CPU-s, ${b.build.peakMiB} MiB`, `after the edit ${s(b.rebuild.ms)}, ${b.rebuild.cpuS} CPU-s, ${b.rebuild.peakMiB} MiB`, dev]));
  }
}
if (summary.coldStart) {
  console.log("\nCold start");
  for (const [name, c] of Object.entries(summary.coldStart)) console.log(line([name, `${c.firstOkMs.median} ms (min ${c.firstOkMs.min}, max ${c.firstOkMs.max})`, c.memAfterFirstRequest, `${c.imageMB} MB image`]));
}
if (summary.bytes) {
  console.log("\nBytes (raw / gzip)");
  const kb = (x) => (x / 1024).toFixed(1);
  for (const [name, b] of Object.entries(summary.bytes)) console.log(line([name, `html ${kb(b.html.raw)}/${kb(b.html.gzip)}`, `js ${kb(b.js.raw)}/${kb(b.js.gzip)} (${b.js.files})`, `wasm ${kb(b.wasm.raw)}/${kb(b.wasm.gzip)}`, `css ${kb(b.css.raw)}/${kb(b.css.gzip)}`]));
}
console.log("\nBrowser (median / p90 ms)");
for (const [key, b] of Object.entries(summary.browser)) console.log(line([key, `interactive ${b.interactive.med}/${b.interactive.p90}`, `LCP ${b.lcp.med}`, `TBT ${b.tbt.med}`, `action ${b.action.med}`, `nav ${b.clientNav.med}/${b.clientNav.p90}`, `heap ${b.heapMB.med} MB`, b.allWorked ? "ok" : "FAILED"]));
