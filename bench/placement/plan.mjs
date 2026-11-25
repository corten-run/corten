// plan.mjs: reads a placement run's plan file and writes what the other scripts run from.
//   node plan.mjs <plan.json>
//       checks the plan and prints what it declares for each part and workload: K, R, the rank
//       of the bound, the pad lists and their phases, the seed
//   node plan.mjs <plan.json> <pilot|gated> <workload> <work dir> [--sized-from <results dir>]
//       also writes <work dir>/plan/ for build.sh, verify.sh, run.sh and report.mjs
// README.md lists the plan's fields. A workload's K is a number, or "pilot": the smallest K at
// which the sizing check passes from that workload's pilot under this same plan file, whose
// results --sized-from names (docs/design.md, Choice 72, "How many placements"). With a number,
// --sized-from names the eligible A/A it was sized from and the check is made at that K.
// DRYRUN=1 in the environment marks the work directory a dry run, a test of the scripts that is
// read for nothing, with DRY_K (6) placements, DRY_R (2) pairs and DRY_TURN (1) second turns.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as path } from "node:path";
import { fileURLToPath } from "node:url";
import { problems as maskProblems, sed } from "./mask.mjs";
import { coverage, pads, problems as padProblems } from "./pads.mjs";
import { comparisons, lines, PARTS, schedule } from "./schedule.mjs";
import { ord, upperRank } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/** The counters every turn reads (item 2: user and kernel cycles, user instructions, user L1 instruction-cache misses). */
export const EVENTS = "cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u";
/** The K's pads.mjs builds lists for; fewer than 5 placements have no rank for the bound. */
export const K_MIN = 5, K_MAX = 254;
/** The thresholds a plan can declare for a workload: its margin (+1%) and a smallest worthwhile reduction. */
export const THRESHOLDS = ["margin", "reduction"];

const int = (x, low) => Number.isInteger(x) && x >= low;
const relative = (p) => typeof p === "string" && p !== "" && !isAbsolute(p) && !p.startsWith("-") && !p.split(/[\\/]/).includes("..") && !/\s/.test(p);
const printable = (s) => typeof s === "string" && /^[\x20-\x7e]*$/.test(s);

/** Why a plan is not usable, or [] when it is. */
export function problems(plan) {
  const why = [], bad = (x) => why.push(x);
  if (plan?.plan !== 1) return ['"plan": 1 is missing: not a plan this kit reads'];
  if (!/^[a-z0-9-]+$/.test(plan.name ?? "")) bad("name: lowercase letters, digits and hyphens");
  for (const side of ["base", "head"]) if (!/^[0-9a-f]{40}$/.test(plan[side] ?? "")) bad(`${side}: a full commit id. A plan that does not name the commits it reads, the change's base and head, is not declared (CONTRIBUTING.md, Pull requests, item 2)`);
  const p = plan.probe ?? {};
  if (!relative(p.dir)) bad("probe.dir: a path from the plan file to the probe's crate");
  if (!Array.isArray(p.tree) || !p.tree.length || !p.tree.every(relative)) bad("probe.tree: the paths of the repository the probe builds from");
  if (!/^[0-9a-z.-]+$/.test(p.toolchain ?? "")) bad("probe.toolchain: the Rust toolchain's name");
  if (!printable(p.build) || !p.build) bad("probe.build: the command that builds the probe");
  if (!relative(p.binary) || !/(^|\/)probe$/.test(p.binary)) bad("probe.binary: the built binary under the target directory, named probe");
  if (typeof p.env !== "object" || p.env === null || Object.entries(p.env).some(([k, v]) => !/^[A-Z_][A-Z0-9_]*$/.test(k) || !printable(v) || ["PATH", "CARGO_TARGET_DIR", "LINK_CAPTURE", "RUSTUP_TOOLCHAIN", "PLACEMENT_KIT"].includes(k))) bad("probe.env: the build's environment, names to text, without the variables the kit sets");
  const startOk = (s) => printable(s) && s.includes("$BIN") && s.includes("$PORT");
  if (!startOk(p.start)) bad("probe.start: the command that serves $BIN on $PORT");
  const c = plan.host?.cpus ?? {}, cpus = [c.server, ...(Array.isArray(c.load) ? c.load : [undefined]), c.driver];
  if (!cpus.every((x) => int(x, 0)) || new Set(cpus).size !== cpus.length) bad("host.cpus: server, load (a list) and driver, CPUs of their own");
  if (plan.host?.cpuModel !== null && (!printable(plan.host?.cpuModel) || !plan.host.cpuModel)) bad("host.cpuModel: the CPU model the run needs, or null");
  const l = plan.load ?? {};
  if (!int(l.threads, 1) || !int(l.connections, 1) || !int(l.seconds, 1)) bad("load: wrk's threads and connections and a turn's seconds");
  if (!int(plan.R, 1)) bad("R: recorded pairs per placement");
  if (!int(plan.placementSeconds, 1)) bad("placementSeconds: the time limit of a placement");
  if (plan.pilot !== undefined) {
    if (!int(plan.pilot?.K, 30) || plan.pilot.K > K_MAX) bad(`pilot.K: from 30 to ${K_MAX}`);
    else if (plan.pilot.K !== 100 && !(printable(plan.pilot.why) && plan.pilot.why.trim())) bad("pilot.why: why a K other than 100 serves");
  }
  const names = new Set();
  if (!Array.isArray(plan.workloads) || !plan.workloads.length) bad("workloads: at least one");
  else for (const w of plan.workloads) {
    const n = /^[a-z]+$/.test(w?.name ?? "") ? w.name : null, at = `workload ${n ?? JSON.stringify(w?.name)}`;
    if (!n || names.has(n)) { bad(`${at}: a name of lowercase letters, used once`); continue; }
    names.add(n);
    if (!(printable(w.declared) && w.declared.trim())) bad(`${at}: declared, what the plan says of the workload before the run`);
    const r = w.request ?? {};
    if (!/^\/[\x21-\x7e]*$/.test(r.path ?? "") || /['"\\]/.test(r.path)) bad(`${at}: request.path`);
    if (!Array.isArray(r.headers) || !r.headers.every((h) => printable(h) && /^[A-Za-z0-9-]+: ?\S/.test(h))) bad(`${at}: request.headers, each "Name: value"`);
    if (r.script !== undefined && !relative(r.script)) bad(`${at}: request.script, a path from the plan file to a wrk script`);
    if (!int(w.status, 100) || w.status > 599) bad(`${at}: status`);
    if (w.K !== "pilot" && !(int(w.K, K_MIN) && w.K <= K_MAX)) bad(`${at}: K, from ${K_MIN} to ${K_MAX} or "pilot"`);
    if (w.K === "pilot" && plan.pilot === undefined) bad(`${at}: K is "pilot" and the plan has no pilot`);
    if (!int(w.seed, 0)) bad(`${at}: seed, of the order its placements run in`);
    why.push(...maskProblems(w.mask).map((x) => `${at}: ${x}`));
    if (w.reduction !== null && !(typeof w.reduction === "number" && w.reduction > 0 && w.reduction < 1)) bad(`${at}: reduction, the smallest worthwhile reduction as a fraction, or null`);
    if (!Array.isArray(w.reads) || !w.reads.length || new Set(w.reads).size !== w.reads.length || !w.reads.every((t) => THRESHOLDS.includes(t))) bad(`${at}: reads, the thresholds this run reads across placements: "margin", "reduction" or both`);
    else if (w.reads.includes("reduction") && typeof w.reduction !== "number") bad(`${at}: reads the reduction and declares none`);
    if (typeof w.recordsSpread !== "boolean") bad(`${at}: recordsSpread, whether the plan declares that the run's A/A records a placement spread for the workload: true or false`);
    if (w.start !== undefined && !startOk(w.start)) bad(`${at}: start`);
    if (w.expect !== undefined && !relative(w.expect)) bad(`${at}: expect, a path from the plan file`);
  }
  return why;
}

/**
 * What one part of a plan runs for one workload. K is the part's: the pilot's, the workload's
 * number, or the K given for a workload whose K is "pilot". dry: { K, R, seconds } or null.
 */
export function resolve(plan, part, workload, { K: given, dry = null } = {}) {
  const w = plan.workloads.find((x) => x.name === workload);
  if (!PARTS.includes(part) || !w) throw new Error(`no part ${part} or workload ${workload} in the plan`);
  if (part === "pilot" && plan.pilot === undefined) throw new Error("the plan has no pilot");
  const declared = part === "pilot" ? plan.pilot.K : w.K;
  const K = dry ? dry.K : declared === "pilot" ? given : declared;
  if (!int(K, K_MIN) || K > K_MAX) throw new Error(`${workload}: K is ${K}: ${declared === "pilot" ? "a workload sized from its pilot needs that pilot's results (--sized-from)" : `not from ${K_MIN} to ${K_MAX}`}`);
  const { P, Q } = pads(K), rule = padProblems(P, Q), rank = upperRank(K);
  if (rule.length) throw new Error(`${workload}: the pad lists for K = ${K} miss the fourth point's rule: ${rule.join("; ")}`);
  const R = dry ? dry.R : plan.R, seconds = dry ? dry.seconds : plan.load.seconds;
  return {
    name: plan.name, part, workload, dry, K, declaredK: declared, R, seconds, seed: w.seed, rank, lowerRank: K + 1 - rank, P, Q, coverage: coverage(P, Q),
    sides: part === "pilot" ? ["base"] : ["base", "head"], comparisons: comparisons(part, workload), schedule: schedule(part, workload, K, w.seed),
    base: plan.base, head: plan.head, reduction: w.reduction, reads: w.reads, recordsSpread: w.recordsSpread, declared: w.declared,
  };
}

/** The thresholds a workload's plan declares, each as read by this run or left as one build read it. */
export function thresholds(r) {
  const out = [`the margin (+1%, no floor): ${r.reads.includes("margin") ? "read by this run" : "not read by this run, so it stays as one build read it"}`];
  if (r.reduction != null) out.push(`a smallest worthwhile reduction of ${(100 * r.reduction).toFixed(2)}%: ${r.reads.includes("reduction") ? "read by this run" : "not read by this run, so it stays as one build read it"}`);
  return out;
}

/** What a part declares, as the lines a pull request's plan lists. */
export function declaration(r) {
  const c = r.coverage;
  return [
    `${r.part} ${r.workload}${r.dry ? " (DRY RUN: a test of the scripts, read for nothing)" : ""}: K = ${r.K} placements${r.declaredK === "pilot" && !r.dry ? " (from the pilot, by the sizing rule)" : ""}, R = ${r.R} recorded pairs each after one that is not, ${r.seconds} s turns; comparisons ${r.comparisons.join(" and ")}`,
    ...(r.part === "pilot" ? ["a pilot: an A/A of the base read only for the spread of its placement medians, to size K; it reads no threshold"] : [`thresholds: ${thresholds(r).join("; ")}`, `the A/A ${r.recordsSpread ? "records a placement spread for the workload, if it is complete and resolves" : "records no placement spread"}`]),
    `the bound is the ${ord(r.rank)} smallest of the ${r.K} placement medians, the lower bound the ${ord(r.lowerRank)}; the order is drawn from seed ${r.seed}`,
    `pads p (base and head in the change, the A/A's first side): ${r.P.join(" ")}`,
    `pads q (the A/A's second side): ${r.Q.join(" ")}`,
    `${2 * r.K} distinct sizes from ${Math.min(...r.P, ...r.Q)} to ${Math.max(...r.P, ...r.Q)} bytes; p by 64-byte-line phase (0, 16, 32, 48): ${c.P.line.join(", ")}, by quarter of a page: ${c.P.pageQuarters.join(", ")}; q: ${c.Q.line.join(", ")} and ${c.Q.pageQuarters.join(", ")}`,
    `the pairs: ${c.linePairCombos} ordered combinations of the line phases of p and q; q - p mod 4096 takes ${c.distinctDiffs} distinct values, ${c.diffQuarters.join(", ")} by quarter of a page (at least ${Math.floor(r.K / 8)} asked in each)`,
  ];
}

const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function dryRun(env) {
  if (env.DRYRUN !== "1") return null;
  const n = (k, d) => (env[k] === undefined ? d : Number(env[k]));
  const dry = { K: n("DRY_K", 6), R: n("DRY_R", 2), seconds: n("DRY_TURN", 1) };
  if (!int(dry.K, K_MIN) || dry.K > K_MAX || !int(dry.R, 1) || !int(dry.seconds, 1)) throw new Error(`DRY_K (from ${K_MIN}), DRY_R and DRY_TURN must be whole numbers`);
  return dry;
}

async function main(argv) {
  const at = argv.indexOf("--sized-from"), sizedFrom = at < 0 ? null : argv.splice(at, 2)[1];
  const [file, part, workload, work] = argv;
  if (!file || (argv.length !== 1 && argv.length !== 4) || (at >= 0 && !sizedFrom)) throw new Error("usage: node plan.mjs <plan.json> [<pilot|gated> <workload> <work dir> [--sized-from <results dir>]]");
  const bytes = readFileSync(file), plan = JSON.parse(bytes.toString("utf8")), why = problems(plan);
  if (why.length) throw new Error(`${file} is not a usable plan:\n  ${why.join("\n  ")}`);
  const sha = createHash("sha256").update(bytes).digest("hex"), dry = dryRun(process.env);
  console.log(`plan ${plan.name}, sha256 ${sha}: base ${plan.base}, head ${plan.head}`);
  if (argv.length === 1) {
    for (const w of plan.workloads) for (const p of plan.pilot === undefined ? ["gated"] : PARTS) {
      if (p === "gated" && w.K === "pilot" && !dry) { console.log(`gated ${w.name}: K from the pilot, the smallest from ${K_MIN} to ${K_MAX} at which the sizing check passes; its pad lists are pads.mjs's for that K`); continue; }
      console.log(declaration(resolve(plan, p, w.name, { dry })).join("\n"));
    }
    return;
  }
  const w = plan.workloads.find((x) => x.name === workload);
  if (!w) throw new Error(`the plan has no workload ${workload}`);
  if (/\s/.test(path(work))) throw new Error("the work directory's path has white space in it");
  let K, sized = null;
  if (sizedFrom !== null && !dry) {
    const { sizing } = await import("./report.mjs");
    sized = sizing(sizedFrom, w.K === "pilot" ? undefined : w.K);
    console.log(sized.lines.join("\n"));
    if (sized.workload !== workload || sized.R !== plan.R) throw new Error(`${sizedFrom} holds workload ${sized.workload} at R = ${sized.R}, not ${workload} at R = ${plan.R}`);
    if (w.K === "pilot" && part === "gated" && sized.plan !== sha) throw new Error(`${sizedFrom} was run under plan ${sized.plan}, not this plan file: the pilot and the gated run are two parts of one plan`);
    if (!sized.ok) throw new Error(`${sizedFrom} sizes no K for ${workload}: the workload is not read across placements under this plan`);
    K = sized.K;
  }
  const r = resolve(plan, part, workload, { K, dry });
  const repo = execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const from = (p) => path(dirname(file), p), out = join(path(work), "plan");
  for (const f of [from(plan.probe.dir), ...(w.request.script ? [from(w.request.script)] : []), ...(w.expect ? [from(w.expect)] : [])]) if (!existsSync(f)) throw new Error(`${f}: named by the plan and not there`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "plan.json"), bytes);
  writeFileSync(join(out, "schedule.txt"), lines(r.schedule));
  writeFileSync(join(out, "headers.txt"), w.request.headers.map((h) => `${h}\n`).join(""));
  writeFileSync(join(out, "mask.json"), JSON.stringify(w.mask) + "\n");
  writeFileSync(join(out, "mask.sed"), sed(w.mask));
  copyFileSync(w.request.script ? from(w.request.script) : join(here, "get.lua"), join(out, "request.lua"));
  if (w.expect) copyFileSync(from(w.expect), join(out, "expect.txt"));
  writeFileSync(join(out, "build-env.sh"), Object.entries(plan.probe.env).map(([k, v]) => `export ${k}=${quote(v)}\n`).join(""));
  writeFileSync(join(out, "resolved.json"), JSON.stringify({ ...r, plan: sha, sized: sized && { from: sized.run, K: sized.K, models: sized.models, counts: sized.counts }, load: plan.load, host: plan.host, mask: w.mask, request: w.request, status: w.status, placementSeconds: plan.placementSeconds }, null, 1) + "\n");
  const c = plan.host.cpus, vars = {
    KIT: here, REPO: repo, WORK: path(work), PLAN_SHA: sha, NAME: plan.name, PART: part, W: workload, DRY: dry ? 1 : 0, K: r.K, R: r.R, TURN: r.seconds, SEED: r.seed,
    PADS_P: r.P.join(" "), PADS_Q: r.Q.join(" "), SIDES: r.sides.join(" "), CMPS: r.comparisons.join(" "), BASE: plan.base, HEAD: plan.head,
    TOOLCHAIN: plan.probe.toolchain, BUILD: plan.probe.build, BINARY: plan.probe.binary, TREE: plan.probe.tree.join(" "), PROBE: from(plan.probe.dir),
    START: w.start ?? plan.probe.start, REQ_PATH: w.request.path, STATUS: w.status, EXPECT: w.expect ? join(out, "expect.txt") : "", EVENTS,
    CPU_SERVER: c.server, CPU_LOAD: c.load.join(","), CPU_DRIVER: c.driver, CPU_MODEL: plan.host.cpuModel ?? "", WRK_T: plan.load.threads, WRK_C: plan.load.connections, PLACEMENT_SECONDS: plan.placementSeconds,
  };
  writeFileSync(join(out, "resolved.sh"), Object.entries(vars).map(([k, v]) => `${k}=${quote(v)}\n`).join(""));
  console.log(declaration(r).join("\n"));
  console.log(`written: ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error(`plan.mjs: ${e.message}`); process.exit(1); });
}
