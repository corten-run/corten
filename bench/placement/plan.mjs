// plan.mjs: reads a placement run's plan file and writes what the other scripts run from.
//   node plan.mjs <plan.json>
//       checks the plan and prints what it declares for each part and workload: K, R, the rank
//       of the bound, the pad lists and their phases, the seed
//   node plan.mjs <plan.json> <pilot|gated> <workload> <work dir> [--sized-from <results dir>]
//       also writes <work dir>/plan/ for build.sh, verify.sh, run.sh and report.mjs
// README.md lists the plan's fields; one it does not list is refused. A workload's K is "pilot",
// the smallest K at which the sizing check passes from that workload's pilot under this same plan
// file and the same files it names by path, whose results --sized-from names
// (docs/design.md#choice-placement-runs, "How many placements"); or a number, with the plan's
// sizedFrom saying which A/A it was sized from. With a number, --sized-from names results of this
// kit that hold that A/A: the check is made at that K itself and its setup compared with this
// plan's (the request, the start command, the load, the mask, the build command and the build's
// environment, the probe and the request script). Without it nothing checks the number, and the
// report says so in every reading.
// What the plan names by path (the probe's files, the request script, the expected answer) is
// listed with each file's SHA-256 in <work dir>/plan/inputs.sha256; the list's own SHA-256 is
// printed with what the plan declares, kept with the results and checked by build.sh, run.sh and
// report.mjs, since the plan file's SHA-256 covers the paths and not what is at them. A symbolic
// link in the probe's directory is refused, and so is a probe directory that is itself one.
// DRYRUN=1 in the environment marks the work directory a dry run, a test of the scripts that is
// read for nothing, with DRY_K (6) placements, DRY_R (2) pairs and DRY_TURN (1) second turns.
// A workload's shuffle, true when declared, has every placement of its parts relinked with its
// functions in an order drawn from its seed and the placement's index (order.mjs) as well as
// with its pad, so its placements sample how a build lays its functions against each other and
// not only where its image lies (docs/design.md#choice-placement-runs, "Inner layout"). Left out,
// nothing this script writes differs from a plan without the field.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A plan's fields. One that is not among them is refused: a misspelled field is not one left out. */
const FIELDS = {
  plan: ["plan", "name", "base", "head", "probe", "host", "load", "R", "placementSeconds", "pilot", "workloads"],
  probe: ["dir", "tree", "toolchain", "env", "build", "binary", "start"],
  host: ["cpuModel", "cpus"], "host.cpus": ["server", "load", "driver"], load: ["threads", "connections", "seconds"], pilot: ["K", "why"],
  workload: ["name", "declared", "request", "status", "mask", "K", "sizedFrom", "seed", "reads", "reduction", "recordsSpread", "start", "expect", "shuffle"],
  request: ["path", "headers", "script"],
};
const unknown = (o, kind, at) => (o !== null && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).filter((k) => !FIELDS[kind].includes(k)).map((k) => `${at}: "${k}" is not a field of a plan`) : []);

/** Why a plan is not usable, or [] when it is. */
export function problems(plan) {
  const why = [], bad = (x) => why.push(x);
  if (plan?.plan !== 1) return ['"plan": 1 is missing: not a plan this kit reads'];
  why.push(...unknown(plan, "plan", "the plan"), ...unknown(plan.probe, "probe", "probe"), ...unknown(plan.host, "host", "host"), ...unknown(plan.host?.cpus, "host.cpus", "host.cpus"), ...unknown(plan.load, "load", "load"), ...unknown(plan.pilot, "pilot", "pilot"));
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
    why.push(...unknown(w, "workload", at), ...unknown(w.request, "request", `${at}: request`));
    if (!(printable(w.declared) && w.declared.trim())) bad(`${at}: declared, what the plan says of the workload before the run`);
    const r = w.request ?? {};
    // A fragment is no part of a request target. curl drops it, so the captured answers would be of
    // the path without it, while wrk 4.1.0 sends "/p#marker" verbatim: the two would ask for different targets.
    if (!/^\/[\x21-\x7e]*$/.test(r.path ?? "") || /['"\\#]/.test(r.path)) bad(`${at}: request.path, from /, of printable ASCII, with no quote, backslash or fragment (#)`);
    if (!Array.isArray(r.headers) || !r.headers.every((h) => printable(h) && /^[A-Za-z0-9-]+: ?\S/.test(h))) bad(`${at}: request.headers, each "Name: value"`);
    if (r.script !== undefined && !relative(r.script)) bad(`${at}: request.script, a path from the plan file to a wrk script`);
    if (!int(w.status, 100) || w.status > 599) bad(`${at}: status`);
    if (w.K !== "pilot" && !(int(w.K, K_MIN) && w.K <= K_MAX)) bad(`${at}: K, from ${K_MIN} to ${K_MAX} or "pilot"`);
    if (w.K === "pilot" && plan.pilot === undefined) bad(`${at}: K is "pilot" and the plan has no pilot`);
    if (w.K === "pilot" ? w.sizedFrom !== undefined : !(printable(w.sizedFrom) && w.sizedFrom.trim())) bad(`${at}: sizedFrom, which eligible A/A a K given as a number was sized from (where it is kept, its run and its comparison), and only with such a K`);
    if (!int(w.seed, 0)) bad(`${at}: seed, of the order its placements run in`);
    why.push(...maskProblems(w.mask).map((x) => `${at}: ${x}`));
    if (w.reduction !== null && !(typeof w.reduction === "number" && w.reduction > 0 && w.reduction < 1)) bad(`${at}: reduction, the smallest worthwhile reduction as a fraction, or null`);
    if (!Array.isArray(w.reads) || !w.reads.length || new Set(w.reads).size !== w.reads.length || !w.reads.every((t) => THRESHOLDS.includes(t))) bad(`${at}: reads, the thresholds this run reads across placements: "margin", "reduction" or both`);
    else if (w.reads.includes("reduction") && typeof w.reduction !== "number") bad(`${at}: reads the reduction and declares none`);
    if (typeof w.recordsSpread !== "boolean") bad(`${at}: recordsSpread, whether the plan declares that the run's A/A records a placement spread for the workload: true or false`);
    if (w.start !== undefined && !startOk(w.start)) bad(`${at}: start`);
    if (w.expect !== undefined && !relative(w.expect)) bad(`${at}: expect, a path from the plan file`);
    if (w.shuffle !== undefined && w.shuffle !== true) bad(`${at}: shuffle, true when every placement relinks the workload's functions in an order drawn from its seed and the placement's index; left out when its placements move the image by their pads alone`);
    // order.mjs takes the seed as the digits resolved.sh writes it in, which a seed past 2^53 - 1 is not (1e21 is written 1e+21).
    else if (w.shuffle === true && int(w.seed, 0) && !Number.isSafeInteger(w.seed)) bad(`${at}: seed, at most ${Number.MAX_SAFE_INTEGER} for a workload whose placements shuffle, which order.mjs draws each ordering file from`);
  }
  return why;
}

/**
 * What one part of a plan runs for one workload. K is the part's: the pilot's, the workload's
 * number, or the K given for a workload whose K is "pilot". dry: { K, R, seconds } or null.
 * lists: the pad lists for a K, pads.mjs's unless a test gives its own.
 */
export function resolve(plan, part, workload, { K: given, dry = null, lists = pads } = {}) {
  const w = plan.workloads.find((x) => x.name === workload);
  if (!PARTS.includes(part) || !w) throw new Error(`no part ${part} or workload ${workload} in the plan`);
  if (part === "pilot" && plan.pilot === undefined) throw new Error("the plan has no pilot");
  const declared = part === "pilot" ? plan.pilot.K : w.K;
  const K = dry ? dry.K : declared === "pilot" ? given : declared;
  if (!int(K, K_MIN) || K > K_MAX) throw new Error(`${workload}: K is ${K}: ${declared === "pilot" ? "a workload sized from its pilot needs that pilot's results (--sized-from)" : `not from ${K_MIN} to ${K_MAX}`}`);
  const { P, Q } = lists(K), rule = padProblems(P, Q), rank = upperRank(K);
  if (rule.length) throw new Error(`${workload}: the pad lists for K = ${K} miss the fourth point's rule: ${rule.join("; ")}`);
  const R = dry ? dry.R : plan.R, seconds = dry ? dry.seconds : plan.load.seconds;
  return {
    name: plan.name, part, workload, dry, K, declaredK: declared, sizedFrom: w.sizedFrom ?? null, R, seconds, seed: w.seed, rank, lowerRank: K + 1 - rank, P, Q, coverage: coverage(P, Q),
    sides: part === "pilot" ? ["base"] : ["base", "head"], comparisons: comparisons(part, workload), schedule: schedule(part, workload, K, w.seed),
    base: plan.base, head: plan.head, reduction: w.reduction, reads: w.reads, recordsSpread: w.recordsSpread, declared: w.declared,
    ...(w.shuffle ? { shuffle: true } : {}),
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
    `${r.part} ${r.workload}${r.dry ? " (DRY RUN: a test of the scripts, read for nothing)" : ""}: K = ${r.K} placements${r.dry || r.part === "pilot" ? "" : r.declaredK === "pilot" ? " (from the pilot, by the sizing rule)" : ` (the plan's number, which it says was sized from: ${r.sizedFrom})`}, R = ${r.R} recorded pairs each after one that is not, ${r.seconds} s turns; comparisons ${r.comparisons.join(" and ")}`,
    ...(r.part === "pilot" ? ["a pilot: an A/A of the base read only for the spread of its placement medians, to size K; it reads no threshold"] : [`thresholds: ${thresholds(r).join("; ")}`, `the A/A ${r.recordsSpread ? "records a placement spread for the workload, if it is complete and resolves" : "records no placement spread"}`]),
    `the bound is the ${ord(r.rank)} smallest of the ${r.K} placement medians, the lower bound the ${ord(r.lowerRank)}; the order is drawn from seed ${r.seed}`,
    ...(r.shuffle ? [`inner layout: shuffled. Each placement i is relinked with its pad first and then every .text function of its side's unpadded build in an order drawn from seed ${r.seed} and i (order.mjs); each index gets its own draw, and different indices can draw the same order. Binaries at the same index use the same draw for shared names, so the placements sample how the functions lie against each other as well as where the image lies`] : []),
    `pads p (base and head in the change, the A/A's first side): ${r.P.join(" ")}`,
    `pads q (the A/A's second side): ${r.Q.join(" ")}`,
    `${2 * r.K} distinct sizes from ${Math.min(...r.P, ...r.Q)} to ${Math.max(...r.P, ...r.Q)} bytes; p by 64-byte-line phase (0, 16, 32, 48): ${c.P.line.join(", ")}, by quarter of a page: ${c.P.pageQuarters.join(", ")}; q: ${c.Q.line.join(", ")} and ${c.Q.pageQuarters.join(", ")}`,
    `the pairs: ${c.linePairCombos} ordered combinations of the line phases of p and q; q - p mod 4096 takes ${c.distinctDiffs} distinct values, ${c.diffQuarters.join(", ")} by quarter of a page (at least ${Math.floor(r.K / 8)} asked in each)`,
  ];
}

/**
 * What a workload's A/A is read on beside the host and the probe's files: what a K given as a
 * number is compared by with the A/A it was sized from. The build command and the build's
 * environment are among it, since they make the binary as the probe's source does.
 */
export const setup = (plan, w) => ({ request: w.request, start: w.start ?? plan.probe.start, load: plan.load, mask: w.mask, build: plan.probe.build, env: Object.fromEntries(Object.entries(plan.probe.env).sort()), ...(w.shuffle ? { shuffle: true } : {}) });

// Every file under a directory, by its path from it. A symbolic link is refused: the list holds
// files by what they hold, and what a link points at lies outside what the plan names by path.
const under = (dir, at = "") => readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return under(dir, `${at}${e.name}/`);
  if (!e.isFile()) throw new Error(`probe/${at}${e.name}: ${e.isSymbolicLink() ? "a symbolic link" : "neither a file nor a directory"}, which the list of inputs does not take: it lists the probe's files by what they hold, and what a link points at lies outside what the plan names by path. Put the file itself in the probe's directory`);
  return [`${at}${e.name}`];
});
/**
 * What a plan names by path, as a work directory and a results directory hold it: every file of
 * the probe (probe/...), the request script (plan/request.lua) and the expected answer
 * (plan/expect.txt, or null). text: a line a file, "<sha256>  <path>", sorted by path, as
 * `sha256sum -c` reads it; sha256: the SHA-256 of that text. A symbolic link in the probe, or a
 * probe directory that is itself one, is refused.
 */
export function inputs(probe, script, expect) {
  if (existsSync(probe) && lstatSync(probe).isSymbolicLink()) throw new Error(`${probe}: the probe's directory is itself a symbolic link, which the list of inputs does not take: name the directory that holds the probe's files`);
  const files = [...(existsSync(probe) ? under(probe).map((f) => [`probe/${f}`, join(probe, f)]) : []), ["plan/request.lua", script], ...(expect ? [["plan/expect.txt", expect]] : [])].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const odd = files.find(([name]) => !/^[\x21-\x5b\x5d-\x7e]+$/.test(name));
  if (odd) throw new Error(`${odd[0]}: a file's name the list of inputs cannot hold (white space, a backslash or a character outside ASCII)`);
  const text = files.map(([name, at]) => `${createHash("sha256").update(readFileSync(at)).digest("hex")}  ${name}\n`).join("");
  return { sha256: createHash("sha256").update(text).digest("hex"), files: files.length, text };
}
/** The line that declares them. */
export const inputsLine = (i) => `inputs: sha256 ${i.sha256} over the ${i.files} files the plan names by path (the probe's, the request script${/  plan\/expect\.txt\n/.test(i.text) ? ", the expected answer" : ""}), each listed with its own`;

/**
 * The line turns.sh ends a non-empty answers/diff.txt with, after the headers' diff: for two
 * bodies that differ their lengths and SHA-256s, and for one body its length and SHA-256.
 */
export const BODIES = /^bodies (differ: \d+ and \d+ bytes, sha256 [0-9a-f]{64} and [0-9a-f]{64}|same: \d+ bytes, sha256 [0-9a-f]{64})$/;
/**
 * Why an expected difference's text is not one turns.sh can write, or null. It is the headers'
 * diff, if any, and then exactly one bodies line as BODIES gives it, ended by a newline: a
 * difference without one (in the headers alone, written before the kit bound the shared body)
 * would hold a placement to no body, and one of another form, such as the lengths alone or a
 * digest cut short, can never be matched, so the placement would fail after its build. A
 * "bodies same" line follows the headers' diff alone: turns.sh writes nothing when neither the
 * headers nor the bodies differ, so one standing by itself can never be matched either.
 */
export function expectProblem(text) {
  const lines = text.split("\n"), last = lines.at(-2) ?? "";
  if (text.endsWith("\n") && BODIES.test(last) && lines.filter((l) => l.startsWith("bodies ")).length === 1) {
    if (last.startsWith("bodies same: ") && !lines.slice(0, -2).some((l) => l !== "")) return `is a "bodies same" line alone, which turns.sh writes only after the headers' diff (when neither the headers nor the bodies differ, it writes nothing, and no expected difference is needed): record the difference again with this kit`;
    return null;
  }
  const odd = lines.find((l) => l.startsWith("bodies ") && !BODIES.test(l));
  return `does not end with one bodies line as turns.sh writes it, "bodies differ: <A> and <B> bytes, sha256 <A's> and <B's>" or "bodies same: <N> bytes, sha256 <its>", each SHA-256 in full (${odd !== undefined ? `its line "${odd.slice(0, 120)}" is neither` : text === "" ? "it is empty" : !lines.some((l) => l.startsWith("bodies ")) ? "it has no bodies line" : "its bodies line is not its only one, or not its last line ended by a newline"}): record the difference again with this kit`;
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
  const from = (p) => path(dirname(file), p);
  const named = (w) => {
    const at = { probe: from(plan.probe.dir), script: w.request.script ? from(w.request.script) : join(here, "get.lua"), expect: w.expect ? from(w.expect) : null };
    for (const f of Object.values(at)) if (f && !existsSync(f)) throw new Error(`${f}: named by the plan and not there`);
    const odd = at.expect && expectProblem(readFileSync(at.expect, "utf8"));
    if (odd) throw new Error(`${at.expect}, the workload's expected difference: ${odd}`);
    if (existsSync(join(at.probe, "Cargo.lock"))) throw new Error(`${join(at.probe, "Cargo.lock")}: the probe's directory holds a Cargo.lock, and build.sh puts each side's own there`);
    return { ...at, list: inputs(at.probe, at.script, at.expect) };
  };
  if (argv.length === 1) {
    for (const w of plan.workloads) {
      for (const p of plan.pilot === undefined ? ["gated"] : PARTS) {
        if (p === "gated" && w.K === "pilot" && !dry) { console.log(`gated ${w.name}: K from the pilot, the smallest from ${K_MIN} to ${K_MAX} at which the sizing check passes; its pad lists are pads.mjs's for that K`); continue; }
        console.log(declaration(resolve(plan, p, w.name, { dry })).join("\n"));
      }
      console.log(`${w.name}: ${inputsLine(named(w).list)}`);
    }
    return;
  }
  const w = plan.workloads.find((x) => x.name === workload);
  if (!w) throw new Error(`the plan has no workload ${workload}`);
  if (/\s/.test(path(work))) throw new Error("the work directory's path has white space in it");
  if (sizedFrom !== null && part !== "gated") throw new Error("--sized-from names what a gated part's K is sized from; a pilot is sized from nothing");
  const src = named(w), list = src.list;
  let K, sized = null;
  if (sizedFrom !== null && !dry) {
    const { sizing } = await import("./report.mjs");
    sized = sizing(sizedFrom, w.K === "pilot" ? undefined : w.K);
    console.log(sized.lines.join("\n"));
    if (sized.refused) throw new Error(`${sizedFrom} is not a run's results this kit reads`);
    if (sized.workload !== workload || sized.R !== plan.R) throw new Error(`${sizedFrom} holds workload ${sized.workload} at R = ${sized.R}, not ${workload} at R = ${plan.R}`);
    if (w.K === "pilot" && sized.plan !== sha) throw new Error(`${sizedFrom} was run under plan ${sized.plan}, not this plan file: the pilot and the gated run are two parts of one plan`);
    if (w.K === "pilot" && sized.inputs.sha256 !== list.sha256) throw new Error(`${sizedFrom} was run on inputs ${sized.inputs.sha256}, and this plan's are now ${list.sha256}: the probe, the request script or the expected answer changed since the pilot, and the two parts are one plan`);
    if (w.K !== "pilot") {
      // An A/A read under another plan sizes this one only on this plan's setup (the expected
      // answer is the change's own, so it is left out of the comparison).
      const less = (text) => text.replace(/^.*  plan\/expect\.txt\n/m, ""), mine = setup(plan, w);
      const other = [...new Set([...Object.keys(mine), ...Object.keys(sized.setup)])].filter((k) => !same(mine[k], sized.setup[k])).concat(less(sized.inputs.text) === less(list.text) ? [] : ["probe or request script"]);
      if (other.length) throw new Error(`${sizedFrom} was read on another setup than this plan's: its ${other.join(", ")} differ${other.length > 1 ? "" : "s"}`);
    }
    if (!sized.ok) throw new Error(w.K === "pilot" ? `${sizedFrom} sizes no K for ${workload}: the workload is not read across placements under this plan` : `${sizedFrom} does not pass K = ${w.K} for ${workload}: the plan takes no K the sizing check does not allow`);
    K = sized.K;
  }
  const r = resolve(plan, part, workload, { K, dry });
  const repo = execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const out = join(path(work), "plan");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "plan.json"), bytes);
  writeFileSync(join(out, "schedule.txt"), lines(r.schedule));
  writeFileSync(join(out, "headers.txt"), w.request.headers.map((h) => `${h}\n`).join(""));
  writeFileSync(join(out, "mask.json"), JSON.stringify(w.mask) + "\n");
  writeFileSync(join(out, "mask.sed"), sed(w.mask));
  copyFileSync(src.script, join(out, "request.lua"));
  if (src.expect) copyFileSync(src.expect, join(out, "expect.txt"));
  writeFileSync(join(out, "inputs.sha256"), list.text);
  writeFileSync(join(out, "build-env.sh"), Object.entries(plan.probe.env).map(([k, v]) => `export ${k}=${quote(v)}\n`).join(""));
  writeFileSync(join(out, "resolved.json"), JSON.stringify({ ...r, plan: sha, inputs: list.sha256, sized: sized && { from: sized.run, K: sized.K, models: sized.models, counts: sized.counts, model: sized.model }, ...setup(plan, w), host: plan.host, status: w.status, placementSeconds: plan.placementSeconds }, null, 1) + "\n");
  const c = plan.host.cpus, vars = {
    KIT: here, REPO: repo, WORK: path(work), PLAN_SHA: sha, INPUTS_SHA: list.sha256, SIZED_MODEL: sized?.model ?? "", NAME: plan.name, PART: part, W: workload, DRY: dry ? 1 : 0, K: r.K, R: r.R, TURN: r.seconds, SEED: r.seed,
    PADS_P: r.P.join(" "), PADS_Q: r.Q.join(" "), SIDES: r.sides.join(" "), CMPS: r.comparisons.join(" "), BASE: plan.base, HEAD: plan.head,
    TOOLCHAIN: plan.probe.toolchain, BUILD: plan.probe.build, BINARY: plan.probe.binary, TREE: plan.probe.tree.join(" "), PROBE: from(plan.probe.dir),
    START: w.start ?? plan.probe.start, REQ_PATH: w.request.path, STATUS: w.status, EXPECT: w.expect ? join(out, "expect.txt") : "", EVENTS,
    CPU_SERVER: c.server, CPU_LOAD: c.load.join(","), CPU_DRIVER: c.driver, CPU_MODEL: plan.host.cpuModel ?? "", WRK_T: plan.load.threads, WRK_C: plan.load.connections, PLACEMENT_SECONDS: plan.placementSeconds,
    // The host's, not the plan's (README.md, What is this host's alone): turns.sh's two servers' ports.
    PORT_A: 18081, PORT_B: 18082,
    ...(r.shuffle ? { SHUFFLE: 1 } : {}),
  };
  writeFileSync(join(out, "resolved.sh"), Object.entries(vars).map(([k, v]) => `${k}=${quote(v)}\n`).join(""));
  console.log(declaration(r).join("\n"));
  console.log(inputsLine(list));
  if (part === "gated" && !dry && !sized) console.log(`K = ${r.K} is not checked by the kit: no --sized-from names results of this kit to check it from, and the report says so in every reading`);
  console.log(`written: ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error(`plan.mjs: ${e.message}`); process.exit(1); });
}
