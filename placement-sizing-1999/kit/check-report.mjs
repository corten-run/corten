// check-report.mjs: report.mjs on made-up results, so a mistake in the reading, or evidence a
// failed, misconfigured or buggy run of this kit could leave, shows before a run (pack it only
// after this passes):  node check-report.mjs
// Each case writes a results directory under the system's temporary directory as run.sh would
// (kit.txt, run-id, the plan, sha256.txt, placements.txt, verify/verdicts.txt, schedule.txt and a
// directory per placement with placement.txt, counts-old.csv, ages-old.txt and answers-old/),
// with placement medians it sets exactly, alters it, reads it with report.mjs and checks the
// reading. Positives: the plan as declared reads complete with the right bound rank, sd, normal
// failure rates, tests and C's offsets; an A/A off in one reading does not resolve; normality,
// run-order dependence and the 1.97% comparison each detect what they should; B, when a plan has
// it; C's head-minus-base and the instruction check; a dry run. Negatives: a missing turn, pair,
// placement or answer check, an extra placement, a placement without its ended line, a wrong
// binary or sha256, an Age out of range or out of turn order, another run's or another kit's
// record, a refused plan, pads, schedule, order, verification or placement check, and a part the
// plan cut. Prints how many cases passed; exits 1 if any did not. --show also prints the report of
// the first positive case (the plan as declared, made-up numbers). With a results directory of a
// real run (node check-report.mjs dry-run/results), also: it reads complete, and eleven alterations
// of a copy of it are each refused or leave their comparison without a bound.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADER } from "./placement.mjs";
import { mean, median, qnorm, rng, sd } from "./model.mjs";
import { pads, readEnv } from "./pads.mjs";
import { report, sides, KIT } from "./report.mjs";
import { schedule, UNPADDED } from "./schedule.mjs";
import { readPilot } from "./size.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PLAN = readFileSync(join(here, "plan.env"), "utf8"), COMMITS = readFileSync(join(here, "commits.env"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "check-1999-"));
const RUN = "00000000-0000-4000-8000-000000001999";
const PRIOR_CPU = /^Model name:\s*(.+)$/m.exec(readFileSync(join(here, "prior", "0c0c599c", "host.txt"), "utf8"))[1].trim();
const PRIOR_MEDIANS = readPilot(join(here, "prior", "0c0c599c", "aa-old")).map((p) => median(p.changes));
let cases = 0, passed = 0;
const failures = [];
const check = (name, ok, detail = "") => { cases++; if (ok) passed++; else failures.push(`${name}${detail ? ": " + detail : ""}`); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const setEnv = (text, changes) => text.split("\n").map((l) => { const m = /^([A-Z_0-9]+)=/.exec(l); return m && m[1] in changes ? `${m[1]}=${changes[m[1]]}` : l; }).join("\n");
const edit = (f, fn) => writeFileSync(f, fn(readFileSync(f, "utf8")));

/** K normal quantiles scaled to sd s exactly, in a seeded random order. */
function normalMedians(K, s, seed = 7) {
  const q = Array.from({ length: K }, (_, i) => qnorm((i + 0.5) / K)), f = s / sd(q), u = rng(seed);
  for (let i = K - 1; i > 0; i--) { const j = Math.floor(u() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
  return q.map((x) => x * f);
}

const pl = (dir, c, i) => join(dir, c, `p${String(i).padStart(3, "0")}`);
let n = 0;
function make(o = {}) {
  const dir = join(scratch, `r${++n}`), decl = join(scratch, `d${n}`);
  mkdirSync(dir); mkdirSync(decl); mkdirSync(join(dir, "verify"));
  const planText = o.plan ?? PLAN;
  const env = readEnv(planText);
  const N = o.dry ?? { KA: +env.K_A, KB: +env.K_B, KC: +env.K_C, R: +env.R, RC: +env.R_C };
  const P = env.PADS_P.split(" ").map(Number).slice(0, N.KA), Q = env.PADS_Q.split(" ").map(Number).slice(0, N.KA);
  writeFileSync(join(dir, "plan.env"), planText); writeFileSync(join(dir, "commits.env"), COMMITS);
  writeFileSync(join(decl, "plan.env"), o.declaredPlan ?? planText); writeFileSync(join(decl, "commits.env"), COMMITS);
  writeFileSync(join(dir, "plan.md"), "made-up plan for check-report.mjs\n");
  const planSha = sha(Buffer.concat([Buffer.from(planText), Buffer.from(COMMITS)]));
  writeFileSync(join(dir, "kit.txt"), `kit ${KIT}\nrun ${RUN}\nplan ${planSha}\n`);
  writeFileSync(join(dir, "run-id"), RUN + "\n");
  if (o.dry) writeFileSync(join(dir, "DRYRUN"), `DRY RUN: K_A=${N.KA}, K_B=${N.KB}, K_C=${N.KC}, R=${N.R}, R_C=${N.RC}, TURN=1; fail seq none; not a measurement\n`);
  writeFileSync(join(dir, "host-id.txt"), [`model ${o.cpu ?? PRIOR_CPU}`, "microcode 0x5003901", "kernel 6.12.117+deb13-amd64", "randomize_va_space 2", "os Debian GNU/Linux 13 (trixie)"].join("\n") + "\n");
  const allP = env.PADS_P.split(" "), allQ = env.PADS_Q.split(" ");
  const names = ["base", "head", "x1", "x2", ...allP.map((p) => `base-p${p}`), ...allQ.map((q) => `base-p${q}`), ...allP.slice(0, N.KC).map((p) => `head-p${p}`)];
  writeFileSync(join(dir, "sha256.txt"), names.map((x) => `${x} ${sha(x)} 1000 bytes`).join("\n") + "\n");
  writeFileSync(join(dir, "placements.txt"), names.filter((x) => /-p\d+$/.test(x)).map((x) => `${x} ${sha(x)} 1000 bytes; all functions: moved by exactly the pad`).join("\n") + "\n");
  writeFileSync(join(dir, "verify", "verdicts.txt"), names.filter((x) => x !== "base" && x !== "head").map((x) => `${x} as ${x.startsWith("head") ? "head" : "base"}: checked 4 answers of each build: same status, head lines and body`).join("\n") + "\n");
  const sched = schedule(N.KA, N.KB, N.KC, Number(env.SCHEDULE_SEED));
  writeFileSync(join(dir, "schedule.txt"), sched.map((s) => `${s.seq} ${s.comparison} ${s.i}\n`).join(""));
  // Retries: o.retry = [{ c, i }], each run again after the schedule (seq numbered on), its failed
  // attempt kept under failed/, as run.sh does.
  const retry = (o.retry ?? []).map((r, k) => ({ ...r, seq: sched.length + k + 1, of: sched.find((s) => s.comparison === r.c && s.i === r.i).seq }));
  writeFileSync(join(dir, "retries.txt"), retry.map((r) => `${r.seq} ${r.c} ${r.i} retry-of ${r.of}\n`).join(""));
  for (const r of retry) mkdirSync(join(dir, "failed", `${r.c}-p${String(r.i).padStart(3, "0")}-seq${r.of}`), { recursive: true });
  const runs = sched.map((s) => ({ ...s, seq: retry.find((r) => r.c === s.comparison && r.i === s.i)?.seq ?? s.seq }));
  // o.aaBySeq: aa's medians given in run order (the k-th to run gets aa[k - 1]), not by pad index.
  const aaRank = new Map(sched.filter((s) => s.comparison === "aa-old").map((s, k) => [s.i, k]));
  const aa0 = o.aa ?? normalMedians(N.KA, 0.0197), aa = o.aaBySeq ? Array.from({ length: N.KA }, (_, k) => aa0[aaRank.get(k + 1)]) : aa0;
  const same = o.same ?? normalMedians(N.KB, 0.005, 11);
  const jitter = (i) => 0.002 * Math.sin(1.7 * i), dn = (i) => 0.001 * (i % 2 ? 1 : -1);
  const target = {
    "aa-old": (i) => [aa[i - 1], 0], "same-old": (i) => [same[i - 1], 0],
    "unpadded-base": (i) => [-0.01 + jitter(i), 0], "unpadded-head": (i) => [-0.01 + jitter(i) + dn(i) + (o.headMove ?? 0), 0],
    "unpadded-x1": (i) => [-0.012 + jitter(i) + dn(i), o.x1Instr ?? 0.002], "unpadded-x2": (i) => [-0.011 + jitter(i) - dn(i), 0.002],
  };
  const t0 = Date.parse("2026-12-01T00:00:00Z");
  for (const s of runs) {
    const [A, B] = sides(s.comparison, s.i, P, Q), R = s.comparison.startsWith("unpadded") ? N.RC : N.R, scale = o.scale?.(s.comparison, s.i) ?? 1;
    const d = join(dir, s.comparison, `p${String(s.i).padStart(3, "0")}`);
    mkdirSync(join(d, "answers-old"), { recursive: true });
    const iso = (x) => new Date(t0 + x * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    writeFileSync(join(d, "placement.txt"), [`comparison ${s.comparison} placement ${s.i} workload old`, `A ${A} ${sha(A)}`, `B ${B} ${sha(B)}`, `kit ${KIT}`, `run ${RUN}`, `plan ${planSha}`, `seq ${s.seq}`, `started ${iso(s.seq * 120)}`, `ended ${iso(s.seq * 120 + 100)}`].join("\n") + "\n");
    writeFileSync(join(d, "answers-old", "verdict.txt"), "checked 4 answers of each build: same status, head lines (but Date, the Age's value checked apart) and body\n");
    const [m, ins] = target[s.comparison](s.i);
    const rows = [HEADER], ages = ["w1 base before 10006 after 10010 runs 1", "w1 head before 10006 after 10010 runs 1"];
    for (let p = 1; p <= R; p++) {
      const ch = m + 0.003 * (p - (R + 1) / 2) * (p % 3 ? 1 : -1);
      const req = 130000;
      const row = (v, f, fi) => `${p},${v},${req},${Math.round(req * 2400 * f * scale)},${Math.round(req * 5100 * f * scale)},${Math.round(req * 2900 * fi)},${Math.round(req * 300)}`;
      rows.push(row("base", 1, 1), row("head", 1 + ch, 1 + ins));
      for (const v of p % 2 ? ["base", "head"] : ["head", "base"]) ages.push(`${p} ${v} before 10006 after 10010 runs 1`);
    }
    writeFileSync(join(d, "counts-old.csv"), rows.join("\n") + "\n");
    writeFileSync(join(d, "ages-old.txt"), ages.join("\n") + "\n");
  }
  o.mutate?.(dir, { P, Q, N, env });
  const r = report(dir, decl, { draws: 4000 });
  return { ...r, dir, decl, P, Q };
}

// The per-pair changes above are m + 0.003 (p - (R + 1) / 2) with the sign of some offsets turned;
// their median must still be m exactly, or every case below reads the wrong medians.
{
  const R = 8, offs = Array.from({ length: R }, (_, k) => { const p = k + 1; return 0.003 * (p - (R + 1) / 2) * (p % 3 ? 1 : -1); });
  const s = [...offs].sort((a, b) => a - b);
  if (Math.abs((s[3] + s[4]) / 2) > 1e-15) { console.error("check-report: the made-up pairs' median is not the placement's: " + s.join(",")); process.exit(1); }
}

// Positives.
let r = make();
const A = r.json.A;
if (process.argv.includes("--show")) console.log(r.text + "\n");
check("the plan as declared reads complete", r.code === 0 && Object.values(r.json.complete).every(Boolean), JSON.stringify(r.json.problems));
check("the bound is the 59th of 100", A.across.rank === 59 && A.swapped.rank === 59, `${A.across.rank}`);
check("the A/A at sd 1.97% around zero resolves +1% in both readings", A.resolution === "resolved" && A.across.bound < 0.01 && A.swapped.bound < 0.01, `${A.resolution} ${A.across.bound} ${A.swapped.bound}`);
check("the medians' sd is the one set", Math.abs(A.sd - 0.0197) < 2e-6, `${A.sd}`);
check("the normal model at 1.97% fails about 55.5% at K = 30, 15.4% at 60, 2.0% at 100", Math.abs(A.failNormal[30] - 0.555) < 0.03 && Math.abs(A.failNormal[60] - 0.154) < 0.025 && Math.abs(A.failNormal[100] - 0.02) < 0.01, JSON.stringify(A.failNormal));
check("normal medians: Shapiro-Wilk and Anderson-Darling do not reject", A.shapiroWilk.p > 0.5 && A.andersonDarling.p > 0.5, `${A.shapiroWilk.p} ${A.andersonDarling.p}`);
check("shuffled medians: no lag-1 dependence", A.lag1.p > 0.05, `${A.lag1.r1} ${A.lag1.p}`);
check("1.97% from 100 medians: the second run's sd is inside, F test p near 1", A.priorInside && A.fTestP > 0.9, `${A.sdInterval95} ${A.fTestP}`);
check("from within is read for R = 8", A.within && Number.isFinite(A.within.corrected) && A.within.corrected > 0, JSON.stringify(A.within));
check("B cut: reported as not in the plan", !r.json.B && r.text.includes("Not in this plan (K_B = 0)"));
check("C: base's unpadded build above all 8 of its padded placements", r.json.C["unpadded-base"].below === 8 && Math.abs(r.json.C["unpadded-base"].signP - 0.0078125) < 1e-9, JSON.stringify(r.json.C["unpadded-base"].below));
check("C: base's offset and its interval", Math.abs(r.json.C["unpadded-base"].offset.median + 0.01) < 0.003 && r.json.C["unpadded-base"].offset.rank === 2, JSON.stringify(r.json.C["unpadded-base"].offset));
check("C: head less base, paired by pad, has zero inside", /zero inside/.test(r.text.split("\n").find((l) => l.startsWith("| head's offset less base's")) ?? ""));
check("C: x1 and x2 within INSTR_NEAR", r.json.C["unpadded-x1"].near === true && r.json.C["unpadded-x2"].near === true);
{
  const cli = spawnSync(process.execPath, [join(here, "report.mjs"), r.dir, "--declared", r.decl], { encoding: "utf8" });
  const j = JSON.parse(readFileSync(join(r.dir, "report.json"), "utf8"));
  check("the command line: exit 0, report.md text and report.json", cli.status === 0 && cli.stdout.includes("**The A/A resolves +1%**") && j.exit === 0 && j.A.across.rank === 59, cli.stderr);
}
r = make({ aa: normalMedians(100, 0.01).map((x) => x + 0.012) });
check("an A/A whose B list runs 1.2% slower: bound over +1% as recorded, under swapped, not resolved", r.json.A.across.bound >= 0.01 && r.json.A.swapped.bound < 0.01 && r.json.A.resolution === "not resolved", `${r.json.A.across.bound} ${r.json.A.swapped.bound}`);
r = make({ aa: Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -1) * (0.02 + 0.0005 * Math.sin(i))) });
check("two clumps of medians: Shapiro-Wilk and Anderson-Darling reject normality", r.json.A.shapiroWilk.p < 0.05 && r.json.A.andersonDarling.p < 0.05, `${r.json.A.shapiroWilk.p} ${r.json.A.andersonDarling.p}`);
r = make({ aa: normalMedians(100, 0.0197).sort((a, b) => a - b), aaBySeq: true });
check("medians drifting with run order: lag-1 and Spearman see it, and no sizing model is used", r.json.A.lag1.p < 0.01 && r.json.A.spearmanRunOrder > 0.99 && r.json.A.spearmanP < 0.01 && r.json.A.sizing.model === null && /drift with run order/.test(r.json.A.sizing.why), `${r.json.A.lag1.p} ${r.json.A.spearmanRunOrder} ${r.json.A.spearmanP} ${JSON.stringify(r.json.A.sizing)}`);
r = make({ aa: normalMedians(100, 0.0197).sort((a, b) => a - b) });
check("medians that rise with pad index: run in a random order, lag-1 and Spearman in run order see no dependence", r.json.A.lag1.p > 0.05 && r.json.A.spearmanP > 0.05, `${r.json.A.lag1.p} ${r.json.A.spearmanP}`);
{
  const s = schedule(100, 0, 8, 1996).filter((x) => x.comparison === "aa-old").map((x) => x.i);
  check("the schedule runs aa-old's 100 placements once each, not in pad order, the same for the same seed", s.length === 100 && new Set(s).size === 100 && s.some((x, k) => x !== k + 1) && s.join() === schedule(100, 0, 8, 1996).filter((x) => x.comparison === "aa-old").map((x) => x.i).join() && s.join() !== schedule(100, 0, 8, 1997).filter((x) => x.comparison === "aa-old").map((x) => x.i).join());
  const c = schedule(100, 0, 8, 1996).filter((x) => x.comparison.startsWith("unpadded"));
  check("the schedule keeps C's rounds in pad order, four comparisons a round", c.length === 32 && c.every((x, k) => x.i === Math.floor(k / 4) + 1));
}
r = make({ aa: normalMedians(100, 0.005) });
check("sd 0.5% from 100 medians: 1.97% is outside its interval and the F test rejects", !r.json.A.priorInside && r.json.A.fTestP < 0.01, `${r.json.A.sdInterval95} ${r.json.A.fTestP}`);
r = make({ plan: setEnv(PLAN, { K_B: "30" }) });
check("a plan with B: same-old complete and resolved, the pad lists' part read", r.code === 0 && r.json.complete["same-old"] && r.json.B.resolution === "resolved" && Math.abs(r.json.B.padListPart - Math.sqrt(0.0197 ** 2 - 0.005 ** 2)) < 1e-4, JSON.stringify([r.json.problems["same-old"], r.json.B?.padListPart]));
r = make({ headMove: -0.02 });
check("head's padded placements 2% further below its unpadded build: head less base differs from zero", /differs from zero/.test(r.text.split("\n").find((l) => l.startsWith("| head's offset less base's")) ?? ""));
r = make({ x1Instr: 0.01 });
check("x1 whose instructions differ 1% from base's: not near, read as mixing code with placement", r.json.C["unpadded-x1"].near === false && r.text.includes("its offset mixes code with placement"));
r = make({ dry: { KA: 5, KB: 2, KC: 2, R: 2, RC: 2 } });
check("a dry run: read as one, with its own numbers, never as a measurement", r.code === 0 && r.json.dry === true && r.text.includes("DRY RUN in a container: not a measurement") && r.json.A.across.rank === 5, JSON.stringify(r.json.problems));
check("a dry run at K_A = 5: the shared pad pairs not read, because it has fewer than 30", r.json.A.sharedWithPrior.read === false && /has 5 pairs, fewer than the 30/.test(r.json.A.sharedWithPrior.why) && r.text.includes("fewer than the 30 it shares"), JSON.stringify(r.json.A.sharedWithPrior));

// Amendment 1: the common median, the sizing rule, the CPU, the shared pad pairs, ranks against the
// padded placements, retries, C's intervals and an incomplete C, and a crash of report.mjs.
r = make();
check("normal medians around zero: the common median's interval (ranks 42 and 59) holds zero", r.json.A.commonMedianZero.inside === true && r.json.A.commonMedianZero.ranks.join() === "42,59" && Math.abs(r.json.A.commonMedianZero.coverage - 0.9114) < 0.001, JSON.stringify(r.json.A.commonMedianZero));
check("normal medians: the sizing rule leaves both models and takes the larger K", ["normal", "smoothed resample"].includes(r.json.A.sizing.model) && r.json.A.sizing.K === Math.max(r.json.A.kNormal5 ?? 1e9, r.json.A.kSmoothed5 ?? 1e9), JSON.stringify([r.json.A.sizing, r.json.A.kNormal5, r.json.A.kSmoothed5]));
check("the second run's CPU model: read as the same CPU", r.json.A.cpu.same === true && r.text.includes("The same CPU model"), JSON.stringify(r.json.A.cpu));
check("made-up medians: the 30 pad pairs shared with the second run are read", r.json.A.sharedWithPrior.read === true && r.text.includes("Shared with the second run"), JSON.stringify(r.json.A.sharedWithPrior.why));
check("every comparison's absolute cost equal: unpadded builds among the padded placements", r.json.C.rankAgainstPadded.n === 200 && r.json.C.rankAgainstPadded.rows["unpadded-base"].p > 0.05 && /among the padded placements/.test(r.text), JSON.stringify(r.json.C.rankAgainstPadded.rows["unpadded-base"]));
{
  const s = [-0.01, -0.01, -0.01, -0.01, -0.01, -0.01, -0.01, -0.01].map((m, k) => m + 0.002 * Math.sin(1.7 * (k + 1))).sort((a, b) => a - b), off = r.json.C["unpadded-base"].offset;
  check("C: base's offset interval is ranks 2 and 7 of its 8 medians", Math.abs(off.low - s[1]) < 1e-9 && Math.abs(off.high - s[6]) < 1e-9 && Math.abs(off.coverage - 0.9296875) < 1e-9, JSON.stringify(off));
  const h = r.json.C["unpadded-head"].pairedWithBase, d = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 0.001 * (i % 2 ? 1 : -1));
  check("C: head less base, its mean and 90% t interval (t 1.8946, 7 df)", Math.abs(h.mean) < 1e-9 && Math.abs(h.tHalf - (1.894578605 * sd(d)) / Math.sqrt(8)) < 1e-7 && h.interval.low < 0 && h.interval.high > 0, JSON.stringify(h));
  const x = r.json.C["unpadded-x1"].pairedWithBase;
  check("C: x1 less base differs from zero: interval -0.3% to -0.1%", Math.abs(x.interval.low + 0.003) < 1e-9 && Math.abs(x.interval.high + 0.001) < 1e-9 && Math.abs(x.mean + 0.002) < 1e-9, JSON.stringify(x));
}
r = make({ aa: normalMedians(100, 0.0197).map((x) => x + 0.012) });
check("medians centred 1.2% off zero: the common median of zero rejected, and no sizing model", r.json.A.commonMedianZero.inside === false && r.json.A.sizing.model === null && /common median of zero rejected/.test(r.json.A.sizing.why), JSON.stringify([r.json.A.commonMedianZero, r.json.A.sizing]));
r = make({ aa: Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -1) * (0.02 + 0.0005 * Math.sin(i))) });
check("two clumps: normality rejected, so the sizing rule takes the smoothed resample", r.json.A.sizing.model === "smoothed resample" && /normality rejected/.test(r.json.A.sizing.why), JSON.stringify(r.json.A.sizing));
r = make({ cpu: "AMD EPYC 7713 64-Core Processor" });
check("another CPU model: the 1.97% comparison says it cannot separate chance from the CPU", r.json.A.cpu.same === false && r.text.includes("cannot separate chance from the CPU"), JSON.stringify(r.json.A.cpu));
r = make({ aa: [...PRIOR_MEDIANS, ...normalMedians(70, 0.0197)] });
check("the second run's 30 medians repeated at i = 1..30: rho 1, carry-over read", r.json.A.sharedWithPrior.read && Math.abs(r.json.A.sharedWithPrior.rho - 1) < 1e-12 && r.json.A.sharedWithPrior.p < 0.001 && r.text.includes("the A/A spread carries a part each pad pair keeps"), JSON.stringify(r.json.A.sharedWithPrior.p));
r = make({ aa: [...PRIOR_MEDIANS.map((x) => -x), ...normalMedians(70, 0.0197)] });
check("the second run's medians negated: no carry-over read (one-sided)", r.json.A.sharedWithPrior.read && r.json.A.sharedWithPrior.p > 0.95 && r.text.includes("no sign that a pad pair's median carries over"), JSON.stringify(r.json.A.sharedWithPrior.p));
r = make({ scale: (c) => (c.startsWith("unpadded") ? 1.1 : 1) });
check("unpadded builds 10% dearer: each dearer than all 200 padded placements", UNPADDED.every((c) => r.json.C.rankAgainstPadded.rows[c].below === 200 && Math.abs(r.json.C.rankAgainstPadded.rows[c].p - 1 / 201) < 1e-12) && /dearer than the padded placements at large/.test(r.text), JSON.stringify(r.json.C.rankAgainstPadded.rows));
r = make({ scale: (c, i) => (c === "aa-old" ? 1 + 0.001 * i : 1) });
check("padded costs rising with pad index (random run order): no drift read", r.json.C.rankAgainstPadded.drift.p > 0.05, JSON.stringify(r.json.C.rankAgainstPadded.drift));
r = make({ retry: [{ c: "aa-old", i: 7 }, { c: "unpadded-x2", i: 3 }] });
check("two retried placements: read complete at their retry seq, listed in the report", r.code === 0 && r.json.A.retries.length === 2 && r.json.A.medians.find((m) => m.i === 7).seq === 133 && r.text.includes("Retried after the schedule: aa-old p7"), JSON.stringify([r.json.problems, r.json.refused]));
r = make({ mutate: (d) => rmSync(join(d, "unpadded-x1", "p003"), { recursive: true }) });
{
  const row = r.text.split("\n").find((l) => l.startsWith("| unpadded-x1 | 7 of 8")) ?? "", pair = r.text.split("\n").find((l) => l.startsWith("| x1's offset less base's")) ?? "";
  check("an incomplete C comparison prints no interval, paired or not", r.code === 1 && / none \|/.test(row) && (pair.match(/ none /g) ?? []).length === 2 && r.json.C["unpadded-x1"].pairedWithBase.interval === null, row + " / " + pair);
}
{
  const x = make();
  mkdirSync(join(x.dir, "report.json"));
  const cli = spawnSync(process.execPath, [join(here, "report.mjs"), x.dir, "--declared", x.decl], { encoding: "utf8" });
  check("report.mjs failing in itself (report.json cannot be written): exit 3, not 1", cli.status === 3 && /report\.mjs failed/.test(cli.stderr), `${cli.status} ${cli.stderr.slice(0, 200)}`);
}
{
  const x = make({ mutate: (d) => edit(join(pl(d, "aa-old", 9), "placement.txt"), (t) => t.replace(/ended [^\n]*\n/, "")) });
  const got = readPilot(join(x.dir, "aa-old"));
  check("size.mjs reads only finished placements (an aa-old placement without its ended line is left out)", got.length === 99 && !got.some((p) => p.name === "p009"), `${got.length}`);
}

// Negatives: an incomplete comparison (exit 1, no bound) ...
const incomplete = (name, c, mutate, why) => {
  const x = make({ mutate });
  const ok = x.code === 1 && x.json.complete[c] === false && (!why || x.json.problems[c].some((p) => why.test(p)));
  const bound = c === "aa-old" ? x.json.A.across.bound === null && x.json.A.swapped.bound === null && x.json.A.resolution === "not resolved (incomplete)" : true;
  check(name, ok && bound, JSON.stringify([x.code, x.json.problems?.[c], x.json.refused]));
};
incomplete("a missing turn (an ages line gone): no bound", "aa-old", (d) => edit(join(pl(d, "aa-old", 7), "ages-old.txt"), (t) => t.replace(/[^\n]*\n$/, "")), /starts, not 18/);
incomplete("a missing pair (7 of 8 in the CSV): no bound", "aa-old", (d) => edit(join(pl(d, "aa-old", 10), "counts-old.csv"), (t) => t.split("\n").filter((l) => !l.startsWith("8,")).join("\n")), /pairs .* not 1\.\.8/);
incomplete("a missing placement: an incomplete A/A, no bound", "aa-old", (d) => rmSync(pl(d, "aa-old", 50), { recursive: true }), /p050: no /);
incomplete("one placement more than the plan: no bound", "aa-old", (d) => mkdirSync(pl(d, "aa-old", 101)), /p101: not a placement/);
incomplete("a placement whose pairs were not all in (no ended line)", "unpadded-x1", (d) => edit(join(pl(d, "unpadded-x1", 3), "placement.txt"), (t) => t.replace(/ended [^\n]*\n/, "")), /no started and ended/);
incomplete("a wrong binary for a placement (B base-p<q_21> at placement 20)", "aa-old", (d, { Q }) => edit(join(pl(d, "aa-old", 20), "placement.txt"), (t) => t.replace(/^B .*$/m, `B base-p${Q[20]} ${sha(`base-p${Q[20]}`)}`)), /line 3/);
incomplete("a binary whose sha256 is not the build's", "unpadded-head", (d) => edit(join(pl(d, "unpadded-head", 2), "placement.txt"), (t) => t.replace(/^A head [0-9a-f]+$/m, "A head " + "0".repeat(64))), /line 2/);
incomplete("a placement whose two builds' answers were not checked", "aa-old", (d) => rmSync(join(pl(d, "aa-old", 33), "answers-old", "verdict.txt")), /verdict/);
incomplete("an Age out of its range", "unpadded-base", (d) => edit(join(pl(d, "unpadded-base", 4), "ages-old.txt"), (t) => t.replace("1 base before 10006", "1 base before 3")), /not in 10005\.\.10020/);
incomplete("starts out of the protocol's turn order", "aa-old", (d) => edit(join(pl(d, "aa-old", 2), "ages-old.txt"), (t) => t.replace("2 head before 10006 after 10010 runs 1\n2 base", "2 base before 10006 after 10010 runs 1\n2 head")), /not turned as the protocol/);
incomplete("a placement of another run", "aa-old", (d) => edit(join(pl(d, "aa-old", 60), "placement.txt"), (t) => t.replace(`run ${RUN}`, "run 11111111-2222-4333-8444-555555555555")), /line 5/);
incomplete("a placement of an earlier kit (kit cycles-1983)", "aa-old", (d) => edit(join(pl(d, "aa-old", 61), "placement.txt"), (t) => t.replace(`kit ${KIT}`, "kit cycles-1983")), /line 4/);
incomplete("an earlier kit's CSV name (cycles-old.csv)", "aa-old", (d) => renameSync(join(pl(d, "aa-old", 62), "counts-old.csv"), join(pl(d, "aa-old", 62), "cycles-old.csv")), /no counts-old\.csv/);
incomplete("an earlier kit's CSV header (no l1i column)", "aa-old", (d) => edit(join(pl(d, "aa-old", 63), "counts-old.csv"), (t) => t.replace(HEADER, "pair,version,requests,cycles_u,cycles_k,instructions_u")), /not a counts CSV/);

// ... and refused results (exit 2, nothing read).
const refused = (name, o, why) => {
  const x = make(o);
  check(name, x.code === 2 && x.json.refused?.some((w) => why.test(w)) && x.text.includes("REFUSED"), JSON.stringify([x.code, x.json.refused ?? x.json.problems]));
};
refused("an earlier kit's results (no kit.txt)", { mutate: (d) => rmSync(join(d, "kit.txt")) }, /no kit\.txt/);
refused("kit.txt naming another kit", { mutate: (d) => edit(join(d, "kit.txt"), (t) => t.replace(`kit ${KIT}`, "kit cycles-1983")) }, /names kit cycles-1983/);
refused("run-id not kit.txt's run", { mutate: (d) => writeFileSync(join(d, "run-id"), "11111111-2222-4333-8444-555555555555\n") }, /is not run-id's/);
refused("a plan sha256 not the results' plan", { mutate: (d) => edit(join(d, "plan.env"), (t) => t.replace("TURN=3", "TURN=1")) }, /not the sha256 of the results' plan/);
refused("results of a plan other than the declared one", { declaredPlan: setEnv(PLAN, { R: "9" }) }, /plan\.env is not the declared one/);
{
  const Q = PLAN.match(/^PADS_Q="([^"]*)"/m)[1].split(" "), bad = [Q[1], ...Q.slice(1)].join(" ");
  refused("pads not pads.mjs's, and failing the phase rule (a size twice)", { plan: setEnv(PLAN, { PADS_Q: `"${bad}"` }), mutate: () => {} }, /do not meet the rule: .*a size repeats/);
}
refused("a schedule not schedule.mjs's", { mutate: (d) => edit(join(d, "schedule.txt"), (t) => t.replace(/^1 (.*)\n2 (.*)\n/, "1 $2\n2 $1\n")) }, /schedule\.txt is not/);
refused("placements not run one after another in the schedule's order", { mutate: (d) => edit(join(pl(d, "aa-old", 4), "placement.txt"), (t) => t.replace(/started (\S+)/, "started 2026-11-30T00:00:00Z")) }, /did not run one after another/);
refused("a binary read without verify's check", { mutate: (d) => edit(join(d, "verify", "verdicts.txt"), (t) => t.split("\n").filter((l) => !l.startsWith("x2 as")).join("\n")) }, /x2: not verified/);
refused("a padded binary without build.sh's placement check", { mutate: (d, { P }) => edit(join(d, "placements.txt"), (t) => t.split("\n").filter((l) => !l.startsWith(`base-p${P[5]} `)).join("\n")) }, /no placement check/);
refused("a part the plan cut (same-old with K_B = 0)", { mutate: (d) => mkdirSync(join(d, "same-old", "p001"), { recursive: true }) }, /results\/same-old: no comparison of this plan/);
refused("another plan's comparison (change-old)", { mutate: (d) => mkdirSync(join(d, "change-old")) }, /results\/change-old/);
refused("no host-id.txt", { mutate: (d) => rmSync(join(d, "host-id.txt")) }, /no host-id\.txt/);
refused("no retries.txt", { mutate: (d) => rmSync(join(d, "retries.txt")) }, /no retries\.txt/);
refused("a retry numbered as if another were before it", { mutate: (d) => writeFileSync(join(d, "retries.txt"), `134 aa-old 7 retry-of ${schedule(100, 0, 8, 1996).find((s) => s.comparison === "aa-old" && s.i === 7).seq}\n`) }, /seq 134, not 133/);
refused("a retry of a placement at a seq the schedule does not give it", { mutate: (d) => writeFileSync(join(d, "retries.txt"), "133 aa-old 7 retry-of 1\n") }, /is not seq 1 of the schedule/);
refused("more retries than RETRY_MAX", { retry: [1, 2, 3, 4].map((i) => ({ c: "unpadded-base", i })) }, /more than RETRY_MAX = 3/);
refused("a schedule from another seed", { mutate: (d) => writeFileSync(join(d, "schedule.txt"), schedule(100, 0, 8, 7).map((s) => `${s.seq} ${s.comparison} ${s.i}\n`).join("")) }, /schedule\.txt is not schedule\.mjs's order .* seed 1996/);
incomplete("a retried placement whose placement.txt still has its first seq", "aa-old", (d) => writeFileSync(join(d, "retries.txt"), `133 aa-old 7 retry-of ${schedule(100, 0, 8, 1996).find((s) => s.comparison === "aa-old" && s.i === 7).seq}\n`), /p007: placement\.txt line 7/);
refused("a dry-run marker whose numbers are not the run's", { mutate: (d) => writeFileSync(join(d, "DRYRUN"), "DRY RUN: K_A=5, K_B=0, K_C=2, R=2, R_C=2, TURN=1; not a measurement\n") }, /schedule\.txt is not/);

// A real run's results (node check-report.mjs <results dir>, e.g. dry-run/results): read as they
// are they must be complete, and each alteration below of a copy of them must be refused or leave
// its comparison without a bound, as on the made-up results.
const realDir = process.argv.slice(2).find((x) => !x.startsWith("--"));
if (realDir) {
  const base = report(realDir, here, { draws: 4000 });
  check(`${realDir}: read complete, as written`, base.code === 0 && !base.json.refused, JSON.stringify(base.json.refused ?? base.json.problems));
  const shas = new Map(readFileSync(join(realDir, "sha256.txt"), "utf8").trim().split("\n").map((l) => l.split(" ").slice(0, 2)));
  const env = readEnv(readFileSync(join(realDir, "plan.env"), "utf8")), Qr = env.PADS_Q.split(" ");
  const first = (c) => join(c, "p001");
  const alter = (name, fn, expect, c, why) => {
    const d = join(scratch, `real${++n}`);
    cpSync(realDir, d, { recursive: true });
    fn(d);
    const x = report(d, here, { draws: 4000 });
    const ok = expect === 2 ? x.code === 2 && x.json.refused?.some((w) => why.test(w)) : x.code === 1 && x.json.complete[c] === false && x.json.problems[c].some((p) => why.test(p));
    check(`${realDir}: ${name}`, ok, JSON.stringify([x.code, x.json.refused ?? x.json.problems?.[c]]));
  };
  alter("a missing turn", (d) => edit(join(d, first("aa-old"), "ages-old.txt"), (t) => t.replace(/[^\n]*\n$/, "")), 1, "aa-old", /starts, not/);
  alter("a missing pair", (d) => edit(join(d, first("aa-old"), "counts-old.csv"), (t) => t.replace(/[^\n]*\n[^\n]*\n$/, "")), 1, "aa-old", /pairs|rows/);
  alter("a placement without its ended line", (d) => edit(join(d, first("unpadded-head"), "placement.txt"), (t) => t.replace(/ended [^\n]*\n/, "")), 1, "unpadded-head", /no started and ended/);
  alter("a wrong binary for a placement", (d) => edit(join(d, first("aa-old"), "placement.txt"), (t) => t.replace(/^B .*$/m, `B base-p${Qr[1]} ${shas.get(`base-p${Qr[1]}`)}`)), 1, "aa-old", /line 3/);
  alter("a missing placement", (d) => rmSync(join(d, first("unpadded-x2")), { recursive: true }), 1, "unpadded-x2", /p001: no /);
  alter("an earlier kit's results (no kit.txt)", (d) => rmSync(join(d, "kit.txt")), 2, null, /no kit\.txt/);
  alter("a plan changed after the run", (d) => edit(join(d, "plan.env"), (t) => t.replace("STEP=10005", "STEP=10006")), 2, null, /not the sha256|not the declared/);
  alter("another plan's comparison", (d) => mkdirSync(join(d, "change-old")), 2, null, /results\/change-old/);
  alter("a schedule not followed", (d) => edit(join(d, "schedule.txt"), (t) => t.replace(/^1 (.*)\n2 (.*)\n/, "1 $2\n2 $1\n")), 2, null, /schedule\.txt is not/);
  alter("an unverified binary", (d) => edit(join(d, "verify", "verdicts.txt"), (t) => t.split("\n").filter((l) => !l.startsWith("x1 as")).join("\n")), 2, null, /x1: not verified/);
  alter("a dry run read without its marker", (d) => rmSync(join(d, "DRYRUN"), { force: true }), 2, null, /schedule\.txt is not/);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`check-report: ${passed} of ${cases} cases passed`);
if (failures.length) { for (const f of failures) console.error("FAILED: " + f); process.exit(1); }