// Writes results/<round>/summary.json and prints the tables in README form.
// Usage: node summarize.mjs <round>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { apps } from "./apps.mjs";
import { rawOf } from "./pack.mjs";
import { phases, ssrOf } from "./ssr.mjs";

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

summary.ssr = ssrOf(raw, Object.keys(apps));

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
// A phase some of whose passes have no files says how many it has.
const show = (/** @type {any} */ e, /** @type {string} */ key, /** @type {string} */ unit = "") => {
  if (e?.[key] === null || e?.[key] === undefined) return "-";
  const range = e.range?.[key];
  const near = e.withinNoiseOfCorten?.[key] ? " ~" : "";
  return range && range[0] !== range[1] ? `${e[key]}${unit} (${range[0]}-${range[1]})${near}` : `${e[key]}${unit}${near}`;
};
// A row some of whose phases have fewer passes than were asked for says so once, by its name.
const named = (/** @type {string} */ name, /** @type {any} */ e) => {
  const short = phases.map((p) => e[p]).find((x) => x?.asked);
  return short ? `${name} [${short.passes} of ${short.asked} passes]` : name;
};
const passesNote = (/** @type {any} */ entries) => {
  const n = Math.max(0, ...Object.values(entries).flatMap((e) => phases.map((p) => /** @type {any} */ (e)[p]?.asked ?? /** @type {any} */ (e)[p]?.passes ?? 1)));
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
    console.log(line([named(`${source}/${name}`, e), `fixed ${show(f, "perCpuSecond")}/CPU-s at ${f?.rps}/s, ${show(f, "cpuUsedPct", "%")} CPU${f && !f.cpuCounted ? " (sampled)" : ""}`, `64 users ${show(s, "perCpuSecond")}/CPU-s${s.cpuCounted ? "" : " (sampled)"}`, `${show(s, "perMiB")}/s per MiB`, s.apiCpuPct === null ? "" : `item API ${s.apiCpuPct}%`, e.failed ? "FAILED" : ""]));
  }
}
for (const source of Object.keys(summary.ssr)) {
  console.log(`\nSSR ${source}${passesNote(summary.ssr[source])}`);
  console.log(line(["App", "fixed rate: achieved rps, p50/p99 ms, CPU", "64 VUs: rps, p50/p99", "256 VUs: rps, p99, failed", "memory under load"]));
  for (const [name, e] of Object.entries(summary.ssr[source])) {
    const f = e.fixed, s = e.sat64, b = e.sat256;
    if (e.failed) console.log(line([name, `FAILED: ${e.failed}`, "", "", ""]));
    if (!f) continue;
    console.log(line([named(name, e), `${f.rps}, ${show(f, "p50")}/${show(f, "p99")}, ${show(f, "cpuPct", "%")}`, `${show(s, "rps")}, ${show(s, "p50")}/${show(s, "p99")}`, `${show(b, "rps")}, ${show(b, "p99")}, ${b?.failedPct}%`, `${s?.memMiB}-${b?.memMaxMiB} MiB`]));
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
  const mb = (/** @type {number | null} */ bytes) => (bytes == null ? "?" : `${Math.round(bytes / 1e6)} MB`);
  const loops = Object.entries(summary.build).filter(([, b]) => !b.failed && b.complete !== false && (b.check || b.test || b.edits || b.disk || b.loopsFailed));
  // How many crates a step compiled, so a rebuild that compiled more than the app shows it.
  const stopped = " (stopped before the edit)";
  const crates = (/** @type {{ runs?: { compiled?: string[] }[], compiled?: string[] }} */ r) => ` [${(r.runs?.[0] ?? r).compiled?.length ?? 0} crates]`;
  if (loops.length) console.log("\nEditor, tests, other edits and disk (wall time; after an edit, the median)");
  for (const [name, b] of loops) {
    console.log(line([
      name,
      b.check ? `check ${s(b.check.clean.ms)}${b.check.again ? `, after the edit ${s(b.check.again.ms)}${crates(b.check.again)}` : stopped}` : "",
      b.test ? `tests compiled ${s(b.test.clean.ms)}${b.test.rebuild ? `, after the edit ${s(b.test.rebuild.ms)}${crates(b.test.rebuild)}` : stopped}` : "",
      ...Object.entries(b.edits ?? {}).map(([kind, e]) => `dev after a ${kind} edit ${s(e.ms)} (${e.runs.length} run${e.runs.length === 1 ? "" : "s"})${crates(e)}`),
      ...Object.entries(typeof b.loopsFailed === "string" ? { loops: b.loopsFailed } : b.loopsFailed ?? {}).map(([group, why]) => `${group} FAILED: ${String(why).split("\n")[0]}`),
      b.disk ? `disk: deps ${mb(b.disk.depsBytes)}, build ${mb(b.disk.buildBytes)}, dev ${mb(b.disk.devBytes)}` : "",
    ].filter(Boolean)));
  }
  const scaled = Object.entries(summary.build).filter(([, b]) => b.scale || b.mold || b.scaleFailed);
  if (scaled.length) console.log("\nThe clean build on other cores, and the development build linked by mold");
  for (const [name, b] of scaled) {
    console.log(line([
      name,
      ...Object.entries(b.scale ?? {}).map(([on, r]) => `cores ${on}: ${s(r.ms)}, ${r.cpuS} CPU-s`),
      b.mold ? `mold: dev ${s(b.mold.clean.ms)}, after the edit ${s(b.mold.rebuild.ms)} (the default build's linker: ${b.linkers?.dev ?? "?"})` : "",
      b.scaleFailed ? `FAILED: ${b.scaleFailed.split("\n")[0]}` : "",
    ].filter(Boolean)));
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
