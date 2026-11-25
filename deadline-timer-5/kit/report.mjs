// report.mjs: one host's results in one page:
//   node report.mjs <results dir> [--declared <dir>] > report.md
// writes report.json beside the results. --declared names the directory holding the plan.env and
// commits.env the run was declared with (default: this kit's own); the results must carry the
// same bytes. Exit 0: every comparison of the part complete; 1: one or more incomplete (no bound
// and no sizing from those); 2: refused, nothing read; anything else: report.mjs itself failed.
//
// Refused outright (exit 2), as a failed, misconfigured or altered run could leave:
//   - no kit.txt, run-id, plan.env, commits.env, plan.md, sha256.txt, placements.txt,
//     schedule.txt, host-id.txt or verify/verdicts.txt;
//   - kit.txt not naming this kit, a run id other than run-id's, a plan sha256 other than that of
//     the results' plan.env and commits.env, or a part other than plan.env's; those two files not
//     the declared ones, byte for byte;
//   - the workload's PADS_P_<W> and PADS_Q_<W> not pads.mjs's lists for its K_<W> (padlists.mjs);
//   - schedule.txt not schedule.mjs's order for the part, workload, K and seed;
//   - a sign that a placement was run again, which this kit never does: a retries.txt, a
//     failed/ directory, a RETRY_MAX in plan.env, or a placement whose place in the schedule is
//     not its place in time (below);
//   - a binary a comparison reads not verified against its side's unpadded binary, or without
//     build.sh's placement check; placements not started one after another in the order run;
//   - for the workload `after`, state/verdicts.txt not showing three turns of each side the part
//     reads reaching and keeping the state (state.sh);
//   - for `beside` and `besidemt`, park/verdicts.txt not showing three watched turns of each side
//     the part reads with the server's waits that can block as the side's rule has them
//     (park.sh): no timeout on the base, one on the head;
//   - an aligned-<side>.txt that is not, byte for byte, the record maprec.mjs makes from the
//     map-<side>.map.gz kept beside it, or a map that itself holds code aligned beyond 16 bytes.
// A placement leaves its comparison incomplete, with no bound, and is never run again, when it
// failed a check or was stopped at its time limit (run.sh then writes no "ended" line), and so
// when its directory is missing; its
// counts-<w>.csv, placement.txt or answers-<w>/verdict.txt is missing; placement.txt is not
// exactly the nine lines run.sh writes (comparison, A and B with the build's sha256s for this
// placement's pads, kit, run, plan, its place in the schedule, started, ended); the two builds'
// answers were not found the same; or its CSV is not the counts header with pairs 1..R each read
// once on each side.
//
// What it reports (plan.md), in user+kernel cycles a request, B / A - 1 per pair, the median of
// a placement's R pairs as its statistic:
//   pilot   pilot-<w>: the spread of the K placement medians; whether the pilot is eligible to
//           size a run (all placements read; lag-1 autocorrelation and Spearman's correlation
//           with run order, each by permutation, neither at p < 0.05; zero inside the interval
//           from the (K + 1 - j)-th to the j-th of the sorted medians); Shapiro-Wilk and
//           Anderson-Darling on the medians and the models kept (pilot.mjs); and the K the
//           plan's rule gives. Its bounds are printed and decide nothing.
//   gated   aa-<w> read twice (as recorded and labels swapped) and whether it resolves +1%;
//           change-<w>'s bound and whether it meets the workload's margin: +1%, and +5% for
//           `beside` and `besidemt` alone (the A/A's +1% is the same for every workload). For
//           those two a change that would meet its margin is read as met only if the head ran
//           at least STATE_FLOOR (95) more user instructions a request than the base, at the
//           median across placements of each placement's median over its pairs: under it the
//           counted turns do not show the set timer the workload is declared for, and the
//           workload is not read as declared, which does not pass. The floor turns no miss into
//           anything else.
// Also refused: a map-<side>.map.gz that is empty or no LLD map, an aligned-<side>.txt with no
// ALIGNED line. Also incomplete: a placement whose verdict
// does not name every request of the kit's checks-<w>.txt as compared and the same, a row with
// no requests, user cycles, kernel cycles or user instructions, and, for `beside` and
// `besidemt`, a placement whose raw log does not hold exactly the turns of its pairs, each
// showing the idle connection set up once and held once.
// A dry run's results may be of the gated part with the base as both sides (run.sh under
// DRY_GATED_BASE=1; DRYRUN says so): the part is then gated whatever plan.env names, and the
// head is held to the base's rule in park/verdicts.txt.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { record } from "./maprec.mjs";
import { across, spread } from "./placement.mjs";
import { readEnv } from "./pads.mjs";
import { padLists } from "./padlists.mjs";
import { comparisons, schedule, WORKLOADS } from "./schedule.mjs";
import { median, pct } from "./stats.mjs";
import { eligibility, sizeByRule } from "./pilot.mjs";

export const KIT = "cycles-deadline-2029-3";
const here = dirname(fileURLToPath(import.meta.url));
// An A/A is resolved at +1% in both readings, for every workload. A change meets its workload's
// margin: +1%, and +5% for the two workloads the plan declares it for.
const MARGIN = 0.01;
const CHANGE_MARGIN = { beside: 0.05, besidemt: 0.05 };
const IDLE = new Set(["beside", "besidemt"]);
// What the counted turns of those two must show of their state: user instructions a request,
// head less base, at the median across placements of each placement's median over its pairs.
// Half the 190 a park that callgrind counted for a set timer at one park a request.
export const STATE_FLOOR = 95;
/** The requests a placement's answers are compared on: the non-blank lines of the kit's checks-<w>.txt. */
export const checksOf = (w) => readFileSync(join(here, `checks-${w}.txt`), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
const COLUMNS = "pair,version,requests,cycles_u,cycles_k,instructions_u,L1_icache_load_misses_u";
const MEASURES = {
  "cycles user+kernel": (r) => (r.cycles_u + r.cycles_k) / r.requests,
  "cycles user": (r) => r.cycles_u / r.requests,
  "cycles kernel": (r) => r.cycles_k / r.requests,
  "instructions user": (r) => r.instructions_u / r.requests,
  "L1 icache misses user": (r) => r.icache_u / r.requests,
};
const GATE = "cycles user+kernel";
const fmt = (x) => (x == null || !Number.isFinite(x) ? "-" : pct(x));
const p3 = (x) => (x == null || !Number.isFinite(x) ? "-" : x < 0.001 ? x.toExponential(1) : x.toFixed(3));
const ord = (n) => (n == null ? "-" : `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`);
const sd = (xs) => {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

function readPairs(file) {
  const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  if (header !== COLUMNS) throw new Error(`not this kit's counts CSV`);
  const rows = lines.map((l) => {
    const [pair, version, ...v] = l.split(",");
    const n = v.map(Number);
    // Requests, user cycles, kernel cycles and user instructions of a turn that served anything
    // are all above zero; a zero is a counter that did not count.
    if (n.length !== 5 || n.some((x) => !Number.isFinite(x) || x < 0) || n[0] <= 0 || n[1] <= 0 || n[2] <= 0 || n[3] <= 0) throw new Error(`unusable row ${l}`);
    return { pair, version, requests: n[0], cycles_u: n[1], cycles_k: n[2], instructions_u: n[3], icache_u: n[4] };
  });
  return [...new Set(rows.map((r) => r.pair))].map((pair) => {
    const one = (v) => {
      const r = rows.filter((x) => x.pair === pair && x.version === v);
      if (r.length !== 1) throw new Error(`pair ${pair} ${v}: ${r.length} rows`);
      return r[0];
    };
    return { pair, base: one("base"), head: one("head") };
  });
}
function placementStats(pairs) {
  const out = {};
  for (const [name, f] of Object.entries(MEASURES)) {
    const changes = pairs.map((p) => f(p.head) / f(p.base) - 1);
    const swapped = pairs.map((p) => f(p.base) / f(p.head) - 1);
    out[name] = { a: median(pairs.map((p) => f(p.base))), b: median(pairs.map((p) => f(p.head))), changes, median: median(changes), swapped: median(swapped), min: Math.min(...changes), max: Math.max(...changes), sd: sd(changes) };
  }
  return out;
}
/** User instructions a request, B less A, in instructions: the median over a placement's pairs. */
function instructionsMore(pairs) {
  return median(pairs.map((p) => p.head.instructions_u / p.head.requests - p.base.instructions_u / p.base.requests));
}
/** The sides of placement i (1-based) of a comparison: [A, B]. */
export function sides(c, i, P, Q) {
  const p = P[i - 1], q = Q[i - 1];
  if (/^(pilot|aa)-/.test(c)) return [`base-p${p}`, `base-p${q}`];
  if (/^change-/.test(c)) return [`base-p${p}`, `head-p${p}`];
  throw new Error(`no comparison ${c}`);
}

export function read(dir, declared = here) {
  const refused = [];
  const need = ["kit.txt", "run-id", "plan.env", "commits.env", "plan.md", "sha256.txt", "placements.txt", "schedule.txt", "host-id.txt", join("verify", "verdicts.txt")];
  const missing = need.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) return { refused: [`no ${missing.join(", ")} in the results: not a complete record of this kit's run`] };
  const text = (f) => readFileSync(join(dir, f), "utf8");
  const kitLines = text("kit.txt").replace(/\n$/, "").split("\n");
  const kv = Object.fromEntries(kitLines.map((l) => l.split(" ")));
  const runId = text("run-id").trim();
  if (kitLines.length !== 5 || kv.kit !== KIT) refused.push(`kit.txt names kit ${kv.kit ?? "(none)"}, not ${KIT}`);
  if (!/^[0-9a-f-]{36}$/.test(runId) || kv.run !== runId) refused.push(`kit.txt's run ${kv.run} is not run-id's ${runId}`);
  const planSha = createHash("sha256").update(Buffer.concat([readFileSync(join(dir, "plan.env")), readFileSync(join(dir, "commits.env"))])).digest("hex");
  if (kv.plan !== planSha) refused.push(`kit.txt's plan ${kv.plan} is not the sha256 of the results' plan.env and commits.env (${planSha})`);
  for (const f of ["plan.env", "commits.env"]) {
    const d = join(declared, f);
    if (!existsSync(d) || !readFileSync(d).equals(readFileSync(join(dir, f)))) refused.push(`the results' ${f} is not the declared one (${d})`);
  }
  const env = readEnv(text("plan.env"));
  const dry = existsSync(join(dir, "DRYRUN"));
  // A dry run alone may be of the gated part with the base as both sides, whatever plan.env names.
  const dryGated = dry && /; part gated with the base as both sides$/m.test(text("DRYRUN"));
  const part = dryGated ? "gated" : env.PART, W = kv.workload;
  if (env.KIT !== KIT) refused.push(`plan.env's KIT is ${env.KIT}, not ${KIT}`);
  if (kv.part !== part || !["pilot", "gated"].includes(part)) refused.push(`kit.txt's part ${kv.part} is not plan.env's ${part}`);
  if (!WORKLOADS.includes(W)) return { refused: [...refused, `kit.txt names no workload of the plan (${W})`] };
  let K = Number(env[`K_${W.toUpperCase()}`]), R = Number(env.R), TURN = Number(env.TURN);
  if (dry) {
    const m = /K=(\d+), R=(\d+), TURN=(\d+)/.exec(text("DRYRUN"));
    if (!m) refused.push("DRYRUN does not say the dry run's numbers");
    else [K, R, TURN] = m.slice(1).map(Number);
  }
  if (![K, R, TURN].every((x) => Number.isInteger(x) && x >= 1)) refused.push(`the plan's numbers are not usable: K ${K}, R ${R}, TURN ${TURN}`);
  const lists = padLists(env, W);
  refused.push(...lists.why.map((x) => `plan.env: ${x}`));
  const P = lists.P.slice(0, K), Q = lists.Q.slice(0, K);
  const seed = /^\d+$/.test(env[`SEED_${W.toUpperCase()}`] ?? "") ? Number(env[`SEED_${W.toUpperCase()}`]) : NaN;
  if (!Number.isInteger(seed) || refused.length) return { refused: refused.length ? refused : ["plan.env has no usable seed"] };
  const sched = schedule(part, W, K, seed);
  if (text("schedule.txt") !== sched.map((s) => `${s.seq} ${s.comparison} ${s.i}\n`).join("")) refused.push(`schedule.txt is not schedule.mjs's order for ${part} ${W}, K = ${K}, seed ${seed}`);
  // No placement is run again, replaced or dropped: results that say one was are not this kit's.
  if (existsSync(join(dir, "retries.txt"))) refused.push("the results hold a retries.txt: this kit runs no placement again, so a run that did is not read");
  if (existsSync(join(dir, "failed"))) refused.push("the results hold a failed/ directory: this kit runs no placement again and moves no failed one aside, so a run that did is not read");
  if ("RETRY_MAX" in env) refused.push("plan.env names RETRY_MAX: this kit runs no placement again");
  const planned = comparisons(part, W);
  // The record from each side's unpadded link's map: without it a run has no reading across
  // placements, and this kit places no side with code aligned beyond 16 bytes.
  for (const side of part === "pilot" ? ["base"] : ["base", "head"]) {
    const f = `aligned-${side}.txt`;
    if (!existsSync(join(dir, f)) || !existsSync(join(dir, `map-${side}.map.gz`))) { refused.push(`no ${f} or map-${side}.map.gz: no record from the unpadded link's map, so no reading across placements`); continue; }
    let map = null;
    try { map = gunzipSync(readFileSync(join(dir, `map-${side}.map.gz`))).toString("latin1"); } catch { map = null; }
    if (map === null || !/^\s*VMA\s+LMA\s+Size\s+Align\s+Out\s+In\s+Symbol\s*\n/.test(map) || !/^\s*[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+\d+ \.text\s*$/m.test(map)) refused.push(`map-${side}.map.gz is empty or is not an LLD map with a .text: no record from the unpadded link's map, so no reading across placements`);
    const last = /^ALIGNED (\S+): (\d+) input sections of \.text aligned beyond 16 bytes of (\d+); widest alignment (\d+); (\d+) symbols from the first on$/m.exec(text(f));
    if (!last || last[1] !== side) refused.push(`${f} is empty or has no ALIGNED line for the ${side}: no record from the unpadded link's map, so no reading across placements`);
    else if (last[2] !== "0" || last[5] !== "0" || Number(last[4]) > 16) refused.push(`${f}: the side has code aligned beyond 16 bytes (${last[2]} input sections, widest alignment ${last[4]}), which this kit does not place`);
    if (map !== null) {
      // The record must be this map's: maprec.mjs's record made again from the kept map, whole.
      const again = record(gunzipSync(readFileSync(join(dir, `map-${side}.map.gz`))).toString("utf8"), side);
      if (again.error) refused.push(`map-${side}.map.gz: no record can be made from it (${again.error}), so no reading across placements`);
      else {
        if (again.beyond !== 0 || again.widest > 16) refused.push(`map-${side}.map.gz holds code aligned beyond 16 bytes (${again.beyond} input sections of .text, widest alignment ${again.widest}), which this kit does not place`);
        if (text(f) !== again.lines.join("\n") + "\n") {
          if (last && last[3] !== String(again.total)) refused.push(`${f} counts ${last[3]} input sections of .text and map-${side}.map.gz holds ${again.total}: the record is not that map's`);
          refused.push(`${f} is not the record maprec.mjs makes from map-${side}.map.gz (the map's last line is "${again.lines.at(-1)}"): the record is not that map's`);
        }
      }
    }
  }
  const other = new Set(["check-only", "verify", "preflight", "layout", "masks", "state", "park"]);
  if (IDLE.has(W)) {
    // park.sh's verdicts: three watched turns of each side the part reads, the server's waits
    // as the side's rule has them (the head with the base as both sides: the base's rule).
    const lines = existsSync(join(dir, "park", "verdicts.txt")) ? text(join("park", "verdicts.txt")).trim().split("\n") : [];
    for (const side of part === "pilot" ? ["base"] : ["base", "head"]) {
      const what = side === "base" || dryGated ? /; PARK holds: \d+ waits that can block in the turn, [\d.]+ a request of \d+; every one with no timeout; \d+ more that cannot \(a timeout of 0\) passed over$/ : /; PARK holds: \d+ waits that can block in the turn, [\d.]+ a request of \d+; every one with a timeout, from [\d.]+ to [\d.]+ ms; \d+ more that cannot \(a timeout of 0\) passed over$/;
      for (let n = 1; n <= 3; n++) {
        if (!lines.some((l) => l.startsWith(`${side} turn ${n}: `) && / requests, no error; idle connection held; /.test(l) && what.test(l))) refused.push(`${W}: no watched turn ${n} of the ${side} shown with ${side === "base" || dryGated ? "no timeout on any wait that can block (no timer in the wheel)" : "a timeout on every wait that can block (the idle connection's timer in the wheel)"} (park/verdicts.txt)`);
      }
    }
  }
  if (W === "after") {
    // state.sh's verdicts: three turns of each side the part reads, each holding state.mjs's rule.
    const lines = existsSync(join(dir, "state", "verdicts.txt")) ? text(join("state", "verdicts.txt")).trim().split("\n") : [];
    for (const side of part === "pilot" ? ["base"] : ["base", "head"]) {
      for (let n = 1; n <= 3; n++) {
        if (!lines.some((l) => l.startsWith(`${side} turn ${n}: `) && / requests, no error; /.test(l) && /; STATE holds: \d+ requests captured of \d+ answered; 64 connections; /.test(l))) refused.push(`after: no turn ${n} of ${side} shown to reach and keep the state (state/verdicts.txt)`);
      }
    }
  }
  for (const d of readdirSync(dir)) if (d !== "failed" && statSync(join(dir, d)).isDirectory() && !other.has(d) && !planned.includes(d)) refused.push(`results/${d}: no comparison of this part writes it`);
  const shas = new Map();
  for (const l of text("sha256.txt").trim().split("\n")) { const [name, s] = l.split(" "); shas.set(name, s); }
  const checked = new Set(text("placements.txt").trim().split("\n").map((l) => l.split(" ").slice(0, 2).join(" ")));
  const verified = new Map();
  for (const l of text(join("verify", "verdicts.txt")).trim().split("\n")) {
    const m = /^(\S+) as (\S+): checked 4 requests: same;/.exec(l);
    if (m) verified.set(m[1], m[2]);
  }
  const used = new Set();
  for (const c of planned) for (let i = 1; i <= K; i++) for (const b of sides(c, i, P, Q)) used.add(b);
  for (const b of used) {
    if (!shas.has(b)) { refused.push(`${b}: not in sha256.txt`); continue; }
    if (verified.get(b) !== b.replace(/-p\d+$/, "")) refused.push(`${b}: not verified as its unpadded binary answers (verify/verdicts.txt)`);
    if (!checked.has(`${b} ${shas.get(b)}`)) refused.push(`${b}: no placement check in placements.txt with its sha256`);
  }
  if (refused.length) return { refused };

  const wantChecks = checksOf(W).length;
  const seqOf = new Map(sched.map((s) => [`${s.comparison} ${s.i}`, s.seq]));
  const results = {}, times = [];
  for (const c of planned) {
    const placements = [], problems = [];
    const cdir = join(dir, c);
    const want = new Set(Array.from({ length: K }, (_, i) => `p${String(i + 1).padStart(3, "0")}`));
    for (const x of existsSync(cdir) ? readdirSync(cdir) : []) if (!want.has(x)) problems.push(`${x}: not a placement of the plan`);
    for (let i = 1; i <= K; i++) {
      const name = `p${String(i).padStart(3, "0")}`, p = join(cdir, name);
      const [A, B] = sides(c, i, P, Q), seq = seqOf.get(`${c} ${i}`);
      const files = ["placement.txt", `counts-${W}.csv`, join(`answers-${W}`, "verdict.txt")];
      const gone = files.filter((f) => !existsSync(join(p, f)));
      if (gone.length) { problems.push(`${name}: no ${gone.join(", ")}`); continue; }
      const lines = readFileSync(join(p, "placement.txt"), "utf8").replace(/\n$/, "").split("\n");
      const head = [`comparison ${c} placement ${i} workload ${W}`, `A ${A} ${shas.get(A)}`, `B ${B} ${shas.get(B)}`, `kit ${KIT}`, `run ${runId}`, `plan ${planSha}`, `seq ${seq}`];
      const bad = head.findIndex((l, j) => lines[j] !== l);
      const started = /^started (\S+Z)$/.exec(lines[7] ?? ""), ended = /^ended (\S+Z)$/.exec(lines[8] ?? "");
      if (bad >= 0) { problems.push(`${name}: placement.txt line ${bad + 1} is "${lines[bad] ?? ""}", not "${head[bad]}"`); continue; }
      if (lines.length !== 9 || !started || !ended) { problems.push(`${name}: placement.txt has no started and ended lines (${lines.length} lines): its pairs were not all in`); continue; }
      // The verdict run-pair-fresh.sh writes names how many requests it compared: every request
      // of the workload's check file (two for `after`, one for the others), found the same.
      const said = readFileSync(join(p, `answers-${W}`, "verdict.txt"), "utf8").replace(/\s+$/, "");
      if (said !== `checked ${wantChecks} requests: same`) { problems.push(`${name}: its two builds' answers were not found the same on the workload's ${wantChecks} request${wantChecks === 1 ? "" : "s"} (verdict "${said}")`); continue; }
      let pairs;
      try { pairs = readPairs(join(p, `counts-${W}.csv`)); } catch (e) { problems.push(`${name}: ${e.message}`); continue; }
      if (pairs.length !== R || pairs.some((x, j) => x.pair !== String(j + 1))) { problems.push(`${name}: pairs ${pairs.map((x) => x.pair).join(",")}, not 1..${R}`); continue; }
      if (IDLE.has(W)) {
        // Every turn, the unrecorded pair's two included, held its idle connection: the log
        // holds each turn of the placement once, and in each turn's own lines the connection is
        // set up once and held once and nothing of it failed.
        const raw = existsSync(join(p, `raw-${W}.log`)) ? readFileSync(join(p, `raw-${W}.log`), "utf8") : "";
        const turns = raw.split(/^(?=## pair )/m).filter((t) => t.startsWith("## pair "));
        const names = turns.map((t) => t.slice(8, t.indexOf("\n") < 0 ? undefined : t.indexOf("\n")));
        const wanted = ["w1", ...Array.from({ length: R }, (_, k) => String(k + 1))].flatMap((x) => [`${x} base`, `${x} head`]);
        const count = (t, re) => (t.match(re) ?? []).length;
        const bad = turns.map((t, k) => [names[k], count(t, /^IDLE-READY 3 answers of 200 to GET \/wait on one connection$/gm), count(t, /^IDLE-HELD open for \d+ ms after its last answer, nothing received since$/gm), count(t, /^IDLE-/gm)]).filter(([, ready, held, all]) => ready !== 1 || held !== 1 || all !== 2);
        if ([...names].sort().join("|") !== [...wanted].sort().join("|")) { problems.push(`${name}: its log holds ${turns.length} turns (${names.join(", ") || "none"}), not once each the ${wanted.length} of its pairs, so its turns do not each show the idle connection set up and held`); continue; }
        if (bad.length) { problems.push(`${name}: ${bad.length} of its ${turns.length} turns do not show the idle connection set up once and held once: ${bad.map(([n, ready, held, all]) => `pair ${n} (${ready} set up, ${held} held, ${all} lines of it)`).join("; ")}`); continue; }
      }
      times.push({ seq, c, i, started: started[1], ended: ended[1] });
      placements.push({ i, seq, A, B, started: started[1], requests: pairs.reduce((s, x) => s + x.base.requests + x.head.requests, 0), stats: placementStats(pairs), instructionsMore: instructionsMore(pairs) });
    }
    results[c] = { complete: placements.length === K && problems.length === 0, problems, placements };
  }
  times.sort((a, b) => a.seq - b.seq);
  for (let j = 0; j < times.length; j++) {
    const t = times[j];
    if (t.ended < t.started) return { refused: [`${t.c} p${t.i}: ended before it started`] };
    // Also what a placement run again would show: its place in the schedule, and a later time.
    if (j && times[j - 1].ended > t.started) return { refused: [`${t.c} p${t.i} (seq ${t.seq}) started before ${times[j - 1].c} p${times[j - 1].i} (seq ${times[j - 1].seq}) ended: the placements did not run one after another in the schedule's order`] };
  }
  const hostId = Object.fromEntries(text("host-id.txt").replace(/\n$/, "").split("\n").map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1).trim()]));
  return { dry, dryGated, part, W, K, R, TURN, env, P, Q, runId, planSha, planned, results, hostId, seed };
}

function stats(r, K, R) {
  const acrossBy = {}, swappedBy = {}, spreadBy = {};
  for (const m of Object.keys(MEASURES)) {
    const a = across(r.placements.map((p) => p.stats[m].median)), s = across(r.placements.map((p) => p.stats[m].swapped));
    if (!r.complete) { a.bound = null; a.lower = null; s.bound = null; s.lower = null; }
    acrossBy[m] = a; swappedBy[m] = s; spreadBy[m] = spread(r.placements.map((p) => p.stats), m, R);
  }
  return { across: acrossBy, swapped: swappedBy, spread: spreadBy, above: r.placements.filter((p) => p.stats[GATE].median > 0).length, requests: r.placements.reduce((s, p) => s + p.requests, 0) };
}

export function report(dir, declared = here) {
  const run = read(dir, declared);
  if (run.refused) return { exit: 2, json: { exit: 2, kit: KIT, refused: run.refused }, md: ["# Refused: these results are not read", "", ...run.refused.map((r) => `- ${r}`), ""].join("\n") };
  const { dry, part, W, K, R, results } = run;
  const out = [`# The deadline's timer, ${part === "pilot" ? "part 1 (the pilot)" : "part 2 (the gated run)"}: cycles across placements, workload \`${W}\``, ""];
  if (dry) out.push(`**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**${run.dryGated ? " The gated part's scripts with the base as both sides: the \"head\" below is the base, and no cycle of the head was counted." : ""}`, "");
  out.push(`Run ${run.runId}, kit ${KIT}, plan sha256 ${run.planSha}; CPU ${run.hostId.model ?? "?"}, kernel ${run.hostId.kernel ?? "?"}. K = ${K} placements, R = ${R} recorded pairs in each after one unrecorded pair, ${run.TURN} s turns, every turn on a fresh start, order from seed ${run.seed}. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.`, "");
  const json = { exit: 0, kit: KIT, run: run.runId, plan: run.planSha, part, workload: W, dry, K, R, seed: run.seed, host: run.hostId, complete: {}, problems: {} };
  const st = {};
  for (const c of run.planned) {
    const r = results[c];
    st[c] = stats(r, K, R);
    json.complete[c] = r.complete; json.problems[c] = r.problems;
    if (!r.complete) out.push(`**${c} is incomplete** (${r.placements.length} of ${K} placements read): ${r.problems.join("; ")}.`, "");
  }
  const unread = run.planned.reduce((s, c) => s + K - results[c].placements.length, 0);
  out.push(`No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than ${R} pairs is left unread and its comparison has no bound (${unread ? `${unread} such here, named above` : "none here"}). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).`, "");
  if (part === "pilot") {
    const c = `pilot-${W}`, r = results[c], g = st[c].across[GATE], w = st[c].swapped[GATE];
    const inOrder = [...r.placements].sort((x, y) => x.seq - y.seq);
    const meds = inOrder.map((p) => p.stats[GATE].median);
    out.push("## The spread", "", `${r.placements.length} of ${K} placements read, ${st[c].requests} requests in their recorded turns. Placement medians: median ${fmt(g.median)}, standard deviation ${fmt(g.sd)} (labels swapped ${fmt(w.sd)}), from ${fmt(g.min)} to ${fmt(g.max)}; ${st[c].above} above zero. Within a placement the pooled standard deviation of the per-pair changes is ${fmt(st[c].spread[GATE].within)}.`, "");
    out.push(`For the record, and deciding nothing (a pilot is not a gate's A/A): the ${ord(g.rank)} of the ${K} sorted medians is ${fmt(g.bound)} as recorded and ${fmt(w.bound)} with the labels swapped.`, "");
    let el = null, size = null, why = null;
    try { el = eligibility({ complete: r.complete, medians: meds }); } catch (e) { why = `eligibility could not be worked out: ${e.message}`; }
    if (el) {
      out.push("## Eligibility", "", "| condition | figure | holds |", "| --- | --- | --- |",
        `| every placement read with all ${R} pairs | ${r.placements.length} of ${K} | ${r.complete ? "yes" : "no"} |`,
        `| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 ${p3(el.lag1.r1)}, p ${p3(el.lag1.p)} | ${el.lag1Ok ? "yes" : "no"} |`,
        `| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho ${p3(el.spearman.rho)}, p ${p3(el.spearman.p)} | ${el.spearmanOk ? "yes" : "no"} |`,
        `| zero inside the interval from the ${ord(el.zero.ranks?.[0])} to the ${ord(el.zero.ranks?.[1])} sorted median | ${fmt(el.zero.low)} to ${fmt(el.zero.high)} | ${el.zero.inside == null ? "no interval" : el.zero.inside ? "yes" : "no"} |`,
        "", `**The pilot is ${el.eligible ? "eligible" : "not eligible"}.** Normality of the medians: Shapiro-Wilk p ${p3(el.shapiroWilk.p)}, Anderson-Darling p ${p3(el.andersonDarling.p)}; models kept: ${el.models.join(" and ")}.`, "");
      if (dry) why = "a dry run sizes nothing";
      else if (!el.eligible) why = "the pilot is not eligible, so it sizes nothing";
      // In the order of the placements' indices, as size.mjs's readPilot gives them: the smoothed
      // resample draws by position, so the counts are those of the call the plan names.
      else size = sizeByRule([...r.placements].sort((x, y) => x.i - y.i).map((p) => [p.stats[GATE].median, p.stats[GATE].swapped]), el.models);
      if (size) {
        out.push("## The K the plan's rule gives", "", size.K == null
          ? `**None:** no K from ${size.from} to ${size.to} has every kept model's count of failing draws at or under ${size.limit} of ${size.draws}. The workload is not read across placements under this plan.`
          : `**K = ${size.K}**, the smallest K from ${size.from} to ${size.to} at which every kept model's count of failing draws is at most ${size.limit} of ${size.draws} (seed ${size.seed}): ${size.at.map((m) => `${m.model} ${m.failing} (rank ${m.rank})`).join(", ")}. The K's before it: ${size.tried.slice(-6, -1).map((t) => `${t.K}: ${t.counts.map((m) => `${m.model} ${m.failing}`).join(", ")}`).join("; ") || "none"}.`, "");
      } else out.push("## The K the plan's rule gives", "", `Not worked out: ${why}.`, "");
    } else out.push("## Eligibility", "", `Not worked out: ${why}.`, "");
    json.pilot = { median: g.median, sd: g.sd, sdSwapped: w.sd, min: g.min, max: g.max, bound: g.bound, boundSwapped: w.bound, rank: g.rank, within: st[c].spread[GATE].within, requests: st[c].requests, eligibility: el, size, notSized: size ? null : why, medians: inOrder.map((p) => ({ i: p.i, seq: p.seq, median: p.stats[GATE].median, swapped: p.stats[GATE].swapped })) };
  } else {
    const aa = st[`aa-${W}`], ch = st[`change-${W}`], ac = results[`aa-${W}`].complete, cc = results[`change-${W}`].complete;
    const aaBound = aa.across[GATE].bound, aaSwapped = aa.swapped[GATE].bound, cb = ch.across[GATE].bound;
    const resolved = !ac || aaBound == null || aaSwapped == null ? "not resolved (incomplete)" : aaBound < MARGIN && aaSwapped < MARGIN ? "resolved" : "not resolved";
    const margin = CHANGE_MARGIN[W] ?? MARGIN, mtext = `+${Math.round(100 * margin)}%`;
    // The state of `beside` and `besidemt` in the counted turns: user instructions a request,
    // head less base, at the median across placements. It can only refuse a change that would
    // otherwise meet its margin; a miss stays a miss.
    const more = (c) => (results[c].placements.length ? median(results[c].placements.map((p) => p.instructionsMore)) : null);
    const moreChange = more(`change-${W}`), moreAa = more(`aa-${W}`), floored = IDLE.has(W);
    const shown = !floored || (cc && moreChange != null && moreChange >= STATE_FLOOR);
    const gate = !cc || cb == null ? "no bound (incomplete): does not pass" : resolved !== "resolved" ? "not resolved: does not pass" : cb >= margin ? `misses ${mtext}` : shown ? `meets ${mtext}` : `not read as declared (the set timer is not shown in the counted turns): does not pass`;
    out.push("## Verdicts", "", `The bound is the ${ord(aa.across[GATE].rank)} of the ${K} sorted placement medians (lower bound: the ${ord(aa.across[GATE].lowerRank)}). The A/A is resolved at +1% in both readings; the change's margin for \`${W}\` is ${mtext}, no floor; no reduction is declared or read.`, "",
      ...(floored ? [`The state in the counted turns: the head ran ${moreChange == null ? "-" : moreChange.toFixed(1)} more user instructions a request than the base at the median across the change's placements (the A/A's two base placements: ${moreAa == null ? "-" : moreAa.toFixed(1)}). A set timer is declared to show as at least ${STATE_FLOOR}: ${shown ? "shown" : "**not shown**, so a change within its margin is not read as declared, which does not pass"}. The floor turns no miss into anything else.`, ""] : []),
      "| comparison | placements | median of medians | bound | bound, labels swapped | reading |", "| --- | ---: | ---: | ---: | ---: | --- |",
      `| aa-${W} | ${results[`aa-${W}`].placements.length} of ${K} | ${fmt(aa.across[GATE].median)} | ${aaBound == null ? "none" : pct(aaBound)} | ${aaSwapped == null ? "none" : pct(aaSwapped)} | A/A: **${resolved}** |`,
      `| change-${W} | ${results[`change-${W}`].placements.length} of ${K} | ${fmt(ch.across[GATE].median)} | ${cb == null ? "none" : pct(cb)} | | **${gate}** |`, "");
    json.gated = { resolved, gate, margin, aaBound, aaSwapped, changeBound: cb, changeMedian: ch.across[GATE].median, aaSd: aa.across[GATE].sd, stateFloor: floored ? STATE_FLOOR : null, instructionsMore: moreChange, instructionsMoreAa: moreAa, stateShown: floored ? shown : null };
  }
  for (const c of run.planned) {
    const r = results[c], s = st[c];
    out.push(`## ${c}: every measure`, "", "| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |", "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |");
    for (const m of Object.keys(MEASURES)) {
      const a = s.across[m], w = s.swapped[m], sp = s.spread[m];
      out.push(`| ${m} | ${fmt(a.median)} | ${fmt(a.bound)} | ${fmt(a.lower)} | ${fmt(a.min)} to ${fmt(a.max)} | ${fmt(w.median)} | ${fmt(w.bound)} | ${fmt(sp.between)} | ${fmt(sp.within)} | ${fmt(sp.fromWithin)} |`);
    }
    out.push("", "| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |", "| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |");
    for (const p of [...r.placements].sort((x, y) => x.seq - y.seq)) {
      const t = p.stats[GATE];
      out.push(`| ${p.seq} | ${p.i} | ${p.A} | ${p.B} | ${t.a.toFixed(0)} | ${t.b.toFixed(0)} | ${pct(t.median)} | ${pct(t.min)} to ${pct(t.max)} | ${pct(p.stats["instructions user"].median)} | ${pct(p.stats["L1 icache misses user"].median)} |`);
    }
    out.push("");
    json[c] = { across: s.across, swapped: s.swapped, spread: s.spread, above: s.above, requests: s.requests, placements: r.placements.map((p) => ({ i: p.i, seq: p.seq, A: p.A, B: p.B, medians: Object.fromEntries(Object.entries(p.stats).map(([m, x]) => [m, { a: x.a, b: x.b, median: x.median, swapped: x.swapped, min: x.min, max: x.max }])) })) };
  }
  json.exit = Object.values(json.complete).every(Boolean) ? 0 : 1;
  return { exit: json.exit, json, md: out.join("\n") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), d = args.indexOf("--declared");
  const declared = d >= 0 ? args.splice(d, 2)[1] : here;
  if (args.length !== 1) { console.error("usage: node report.mjs <results dir> [--declared <dir>]"); process.exit(3); }
  let r;
  try { r = report(args[0], declared); } catch (e) { console.error(e.stack ?? String(e)); process.exit(3); }
  writeFileSync(join(args[0], "report.json"), JSON.stringify(r.json, null, 1) + "\n");
  console.log(r.md);
  process.exit(r.exit);
}
