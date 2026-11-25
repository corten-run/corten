// report-selftest.mjs: report.mjs on made-up results, node alone (no host, no build, nothing
// measured):   node selftest/report-selftest.mjs
// Each case writes a whole record of a gated part as run.sh would leave it (K = 30 placements of
// R = 2 pairs, made-up counts) under the system's temporary directory, changes one thing, and
// says what report.mjs must make of it. Prints "ok <case>: <what was read>" a case and a last
// line "<n> of <n> cases"; exits 1 at the first that is read otherwise. The directory is removed.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { pads, readEnv } from "../pads.mjs";
import { KIT, checksOf, report, sides } from "../report.mjs";
import { comparisons, schedule, WORKLOADS } from "../schedule.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "report-selftest-"));
const K = 30, R = 2, RUN = "0f0e0d0c-0b0a-4908-8706-050403020100";
const MAP = [
  "             VMA              LMA     Size Align Out     In      Symbol",
  "          201000           201000     2000    16 .text",
  "          201000           201000     1000    16         probe.0.rcgu.o:(.text._ZN5probe4main17h0000000000000000E)",
  "          201000           201000        0     1                 _ZN5probe4main17h0000000000000000E",
  "          202000           202000     1000    16         probe.1.rcgu.o:(.text._ZN5probe4wait17h0000000000000001E)",
  "          203000           203000      100     8 .data",
  "",
].join("\n");
const MAP32 = MAP.replace("     1000    16         probe.1.rcgu.o", "     1000    32         probe.1.rcgu.o");
const aligned = (side, n = 0, of = 2, widest = 16, syms = 0) => `ALIGNED ${side}: ${n} input sections of .text aligned beyond 16 bytes of ${of}; widest alignment ${widest}; ${syms} symbols from the first on\n`;
const sha = (s) => createHash("sha256").update(s).digest("hex");
// A placement's made-up change: the comparison's centre and a spread of +-0.05% that depends on i.
const around = (centre, i) => centre + (((i * 7) % 11) - 5) * 1e-4;

/** Writes one made-up record. `o`: W, aa and change (the centres of the placement medians), and
 * `edit(files)`, which may change the files (a Map of path to text or Buffer) before they
 * are written, and `env(text)`, which may change plan.env before its sha256 is taken. Returns
 * [results dir, declared dir]. */
function make(name, o) {
  const dir = join(root, name, "results"), declared = join(root, name, "declared");
  const W = o.W, U = W.toUpperCase();
  let env = readFileSync(join(kit, "plan.env"), "utf8").replace(/^PADS_[PQ]_.*\n/gm, "").replace(/^PART=.*$/m, "PART=gated").replace(/^R=.*$/m, `R=${R}`);
  for (const w of WORKLOADS) env = env.replace(new RegExp(`^K_${w.toUpperCase()}=.*$`, "m"), `K_${w.toUpperCase()}=${K}`);
  if (o.env) env = o.env(env);
  const { P, Q } = pads(K);
  for (const w of WORKLOADS) env += `PADS_P_${w.toUpperCase()}="${P.join(" ")}"\nPADS_Q_${w.toUpperCase()}="${Q.join(" ")}"\n`;
  const commits = readFileSync(join(kit, "commits.env"), "utf8");
  const planSha = sha(Buffer.concat([Buffer.from(env), Buffer.from(commits)]));
  const files = new Map();
  files.set("plan.env", env); files.set("commits.env", commits);
  files.set("kit.txt", `kit ${KIT}\nrun ${RUN}\nplan ${planSha}\npart gated\nworkload ${W}\n`);
  files.set("run-id", `${RUN}\n`); files.set("plan.md", "made up\n");
  files.set("host-id.txt", "model made-up CPU\nkernel 0.0.0\n");
  const seed = Number(readEnv(env)[`SEED_${U}`]), sched = schedule("gated", W, K, seed);
  files.set("schedule.txt", sched.map((s) => `${s.seq} ${s.comparison} ${s.i}\n`).join(""));
  const bins = new Set();
  for (const c of comparisons("gated", W)) for (let i = 1; i <= K; i++) for (const b of sides(c, i, P, Q)) bins.add(b);
  files.set("sha256.txt", [...bins].map((b) => `${b} ${sha(b)}\n`).join(""));
  files.set("placements.txt", [...bins].map((b) => `${b} ${sha(b)} placed\n`).join(""));
  files.set(join("verify", "verdicts.txt"), [...bins].map((b) => `${b} as ${b.replace(/-p\d+$/, "")}: checked 4 requests: same; bodies as received\n`).join(""));
  for (const side of ["base", "head"]) { files.set(`aligned-${side}.txt`, aligned(side)); files.set(`map-${side}.map.gz`, gzipSync(MAP)); }
  const idleW = W === "beside" || W === "besidemt";
  if (idleW) files.set(join("park", "verdicts.txt"), ["base", "head"].flatMap((s) => [1, 2, 3].map((n) => `${s} turn ${n}: 900 requests, no error; idle connection held; PARK holds: 905 waits that can block in the turn, 1.01 a request of 900; every one with ${s === "base" ? "no timeout" : "a timeout, from 26480 to 29998 ms"}; 0 more that cannot (a timeout of 0) passed over\n`)).join(""));
  if (W === "after") files.set(join("state", "verdicts.txt"), ["base", "head"].flatMap((s) => [1, 2, 3].map((n) => `${s} turn ${n}: 900 requests, no error; AFTER made up; STATE holds: 900 requests captured of 900 answered; 64 connections; made up\n`)).join(""));
  const checks = checksOf(W).length, t0 = Date.UTC(2026, 0, 1);
  for (const s of sched) {
    const c = s.comparison, i = s.i, p = join(c, `p${String(i).padStart(3, "0")}`), [A, B] = sides(c, i, P, Q);
    const at = (ms) => new Date(t0 + 60000 * s.seq + ms).toISOString();
    files.set(join(p, "placement.txt"), [`comparison ${c} placement ${i} workload ${W}`, `A ${A} ${sha(A)}`, `B ${B} ${sha(B)}`, `kit ${KIT}`, `run ${RUN}`, `plan ${planSha}`, `seq ${s.seq}`, `started ${at(0)}`, `ended ${at(30000)}`, ""].join("\n"));
    files.set(join(p, `answers-${W}`, "verdict.txt"), `checked ${checks} requests: same\n`);
    const x = around(c.startsWith("aa-") ? o.aa ?? 0 : o.change ?? 0, i), rows = ["pair,version,requests,cycles_u,cycles_k,instructions_u,L1_icache_load_misses_u"];
    // User instructions a request, B less A: none in an A/A, and in a change what the case says
    // (by default the 190 of a set timer for the two workloads that have one, and none otherwise).
    const more = c.startsWith("aa-") ? 0 : o.instr ?? (idleW ? 190 : 0);
    for (let pair = 1; pair <= R; pair++) {
      const f = 1 + x + (pair - 1.5) * 2e-5;
      rows.push(`${pair},base,100000,1000000000,500000000,2000000000,300000`, `${pair},head,100000,${Math.round(1e9 * f)},${Math.round(5e8 * f)},${2000000000 + 100000 * more},300000`);
    }
    files.set(join(p, `counts-${W}.csv`), rows.join("\n") + "\n");
    if (W === "beside" || W === "besidemt") {
      const turn = (pair, v) => `## pair ${pair} ${v}\n1000000000,,cycles:u,3000000000,100.00,,\nRESULT 100000 0 0 0 0 0\nIDLE-READY 3 answers of 200 to GET /wait on one connection\nIDLE-HELD open for 3512 ms after its last answer, nothing received since\n`;
      files.set(join(p, `raw-${W}.log`), ["w1", ...Array.from({ length: R }, (_, k) => String(k + 1))].map((pair) => turn(pair, "base") + turn(pair, "head")).join(""));
    }
  }
  o.edit?.(files, { W, P, Q, planSha });
  for (const [f, text] of files) {
    const to = join(f === "plan.env" || f === "commits.env" ? declared : dir, f);
    mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, text);
    if (f === "plan.env" || f === "commits.env") { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, f), text); }
  }
  return [dir, declared];
}

const p3 = join("change-W", "p003");
const at = (W, f) => join(p3.replace("W", W), f);
const sub = (files, f, from, to) => { const was = files.get(f); if (was === undefined || (from instanceof RegExp ? !from.test(was) : !was.includes(from))) throw new Error(`selftest: ${f} has no "${from}"`); files.set(f, was.replace(from, to)); };
const READY = "IDLE-READY 3 answers of 200 to GET /wait on one connection\n", HELD = "IDLE-HELD open for 3512 ms after its last answer, nothing received since\n";
const NOT_SHOWN = "not read as declared (the set timer is not shown in the counted turns): does not pass";
/** A dry run's marks on made-up results: DRYRUN naming the gated part with the base as both sides, and the "head" watched as the base is. */
const DRY_GATED = (f) => {
  f.set("DRYRUN", `DRY RUN: K=${K}, R=${R}, TURN=1; fail seq none; not a measurement; part gated with the base as both sides\n`);
  f.set(join("park", "verdicts.txt"), f.get(join("park", "verdicts.txt")).replaceAll(/every one with a timeout, from \d+ to \d+ ms/g, "every one with no timeout"));
};
const CASES = [
  // The verdict a placement's answers must carry: every request of the workload's checks file.
  ["`after`: every placement's verdict names its 2 requests", { W: "after" }, { exit: 0, gate: "meets +1%" }],
  ["`after`: one placement's verdict names 1 request of its 2", { W: "after", edit: (f) => sub(f, at("after", join("answers-after", "verdict.txt")), "checked 2 requests", "checked 1 requests") }, { exit: 1, problem: /p003: its two builds' answers were not found the same on the workload's 2 requests \(verdict "checked 1 requests: same"\)/ }],
  ["`plain`: every placement's verdict names its 1 request", { W: "plain" }, { exit: 0, gate: "meets +1%" }],
  ["`plain`: one placement's verdict names 2 requests", { W: "plain", edit: (f) => sub(f, at("plain", join("answers-plain", "verdict.txt")), "checked 1 requests", "checked 2 requests") }, { exit: 1, problem: /p003: .* on the workload's 1 request \(verdict "checked 2 requests: same"\)/ }],
  ["`plain`: one placement's answers differed", { W: "plain", edit: (f) => f.set(at("plain", join("answers-plain", "verdict.txt")), "checked 1 requests: differ only as /x says\n") }, { exit: 1, problem: /p003: its two builds' answers were not found the same/ }],
  // A counter that did not count.
  ["`plain`: a turn's kernel cycles are 0", { W: "plain", edit: (f) => sub(f, at("plain", "counts-plain.csv"), "1,base,100000,1000000000,500000000,", "1,base,100000,1000000000,0,") }, { exit: 1, problem: /p003: unusable row 1,base,100000,1000000000,0,/ }],
  ["`plain`: a turn's user instructions are 0", { W: "plain", edit: (f) => sub(f, at("plain", "counts-plain.csv"), "1,base,100000,1000000000,500000000,2000000000,", "1,base,100000,1000000000,500000000,0,") }, { exit: 1, problem: /p003: unusable row/ }],
  // The record from each side's unpadded link's map.
  ["`plain`: the base's map file is empty", { W: "plain", edit: (f) => f.set("map-base.map.gz", Buffer.alloc(0)) }, { exit: 2, refused: /map-base\.map\.gz is empty or is not an LLD map with a \.text/ }],
  ["`plain`: the head's map is an empty text, compressed", { W: "plain", edit: (f) => f.set("map-head.map.gz", gzipSync("")) }, { exit: 2, refused: /map-head\.map\.gz is empty or is not an LLD map with a \.text/ }],
  ["`plain`: the head's record of aligned sections is empty", { W: "plain", edit: (f) => f.set("aligned-head.txt", "") }, { exit: 2, refused: /aligned-head\.txt is empty or has no ALIGNED line for the head/ }],
  ["`plain`: the base's record is the head's", { W: "plain", edit: (f) => f.set("aligned-base.txt", aligned("head")) }, { exit: 2, refused: /aligned-base\.txt is empty or has no ALIGNED line for the base/ }],
  ["`plain`: the head has one section aligned to 32 bytes", { W: "plain", edit: (f) => f.set("aligned-head.txt", aligned("head", 1, 2, 32, 4)) }, { exit: 2, refused: /aligned-head\.txt: the side has code aligned beyond 16 bytes \(1 input sections, widest alignment 32\), which this kit does not place/ }],
  ["`plain`: the record counts 3 sections and the map holds 2", { W: "plain", edit: (f) => f.set("aligned-base.txt", aligned("base", 0, 3)) }, { exit: 2, refused: /aligned-base\.txt counts 3 input sections of \.text and map-base\.map\.gz holds 2/ }],
  ["`plain`: no map of the head", { W: "plain", edit: (f) => f.delete("map-head.map.gz") }, { exit: 2, refused: /no aligned-head\.txt or map-head\.map\.gz/ }],
  // The record is made again from the kept map and must be that one, whole.
  ["`plain`: the head's map holds a section aligned to 32 bytes beside a record saying 16", { W: "plain", edit: (f) => f.set("map-head.map.gz", gzipSync(MAP32)) }, { exit: 2, refused: /map-head\.map\.gz holds code aligned beyond 16 bytes \(1 input sections of \.text, widest alignment 32\), which this kit does not place/ }],
  ["`plain`: the same map, and its record is not the one made from it", { W: "plain", edit: (f) => f.set("map-head.map.gz", gzipSync(MAP32)) }, { exit: 2, refused: /aligned-head\.txt is not the record maprec\.mjs makes from map-head\.map\.gz \(the map's last line is "ALIGNED head: 1 input sections of \.text aligned beyond 16 bytes of 2; widest alignment 32; 0 symbols from the first on"\)/ }],
  ["`plain`: the head's map holds a section aligned to 32 bytes and its record says so", { W: "plain", edit: (f) => { f.set("map-head.map.gz", gzipSync(MAP32)); f.set("aligned-head.txt", "section 2 of 2: align 32, size 4096, probe.1.rcgu.o:(.text._ZN5probe4wait17h0000000000000001E)\n" + aligned("head", 1, 2, 32, 0)); } }, { exit: 2, refused: /aligned-head\.txt: the side has code aligned beyond 16 bytes \(1 input sections, widest alignment 32\)/ }],
  ["`plain`: the base's record has a line its map does not give", { W: "plain", edit: (f) => f.set("aligned-base.txt", "symbol made_up | probe.0.rcgu.o\n" + aligned("base")) }, { exit: 2, refused: /aligned-base\.txt is not the record maprec\.mjs makes from map-base\.map\.gz/ }],
  ["`plain`: the base's map has a line that is no map's", { W: "plain", edit: (f) => f.set("map-base.map.gz", gzipSync(MAP + "made up\n")) }, { exit: 2, refused: /map-base\.map\.gz: no record can be made from it \(a line that is not a map's: made up\)/ }],
  // The margins: +1% for a change, +5% for `beside` and `besidemt` alone; an A/A at +1% for all.
  ["`plain`: the change's medians lie about +3%", { W: "plain", change: 0.03 }, { exit: 0, gate: "misses +1%", margin: 0.01 }],
  ["`beside`: the change's medians lie about +3%", { W: "beside", change: 0.03 }, { exit: 0, gate: "meets +5%", margin: 0.05 }],
  ["`besidemt`: the change's medians lie about +3%", { W: "besidemt", change: 0.03 }, { exit: 0, gate: "meets +5%", margin: 0.05 }],
  ["`beside`: the change's medians lie about +6%", { W: "beside", change: 0.06 }, { exit: 0, gate: "misses +5%", margin: 0.05 }],
  ["`beside`: the change's medians lie about +5%, its bound just over it", { W: "beside", change: 0.05 },{ exit: 0, gate: "misses +5%", margin: 0.05 }],
  ["`beside`: the A/A's medians lie about +2%, the change's about +3%", { W: "beside", aa: 0.02, change: 0.03 }, { exit: 0, gate: "not resolved: does not pass", resolved: "not resolved" }],
  ["`beside`: the A/A's medians lie about -2% (over +1% with the labels swapped alone)", { W: "beside", aa: -0.02, change: 0.03 }, { exit: 0, gate: "not resolved: does not pass", resolved: "not resolved" }],
  ["`after`: the change's medians lie about +3% (no wider margin for it)", { W: "after", change: 0.03 }, { exit: 0, gate: "misses +1%", margin: 0.01 }],
  // The idle connection of `beside` and `besidemt`: set up and held in every turn.
  ["`beside`: one turn's log has no line of the idle connection held", { W: "beside", edit: (f) => sub(f, at("beside", "raw-beside.log"), HELD, "") }, { exit: 1, problem: /p003: 1 of its 6 turns do not show the idle connection set up once and held once: pair w1 base \(1 set up, 0 held, 1 lines of it\)$/ }],
  ["`besidemt`: one turn's idle connection failed", { W: "besidemt", edit: (f) => sub(f, at("besidemt", "raw-besidemt.log"), READY, "IDLE-FAILED: answer 2 was 404\n") }, { exit: 1, problem: /p003: 1 of its 6 turns do not show the idle connection set up once and held once: pair w1 base \(0 set up, 1 held, 2 lines of it\)$/ }],
  ["`beside`: a placement has no raw log", { W: "beside", edit: (f) => f.delete(at("beside", "raw-beside.log")) }, { exit: 1, problem: /p003: its log holds 0 turns \(none\), not once each the 6 of its pairs/ }],
  ["`beside`: the idle connection asked for another path", { W: "beside", edit: (f) => f.set(at("beside", "raw-beside.log"), f.get(at("beside", "raw-beside.log")).replaceAll("GET /wait", "GET /private")) }, { exit: 1, problem: /p003: 6 of its 6 turns do not show the idle connection set up once and held once: pair w1 base \(0 set up, 1 held, 2 lines of it\); / }],
  // Counted a turn, not over the log: one turn with neither line and another with both twice
  // hold as many lines as six good turns.
  ["`beside`: one turn lacks both of the idle connection's lines and another carries them twice", { W: "beside", edit: (f) => { const p = at("beside", "raw-beside.log"), t = f.get(p).split(/^(?=## pair )/m); t[0] = t[0].replace(READY, "").replace(HELD, ""); t[1] += READY + HELD; f.set(p, t.join("")); } }, { exit: 1, problem: /p003: 2 of its 6 turns do not show the idle connection set up once and held once: pair w1 base \(0 set up, 0 held, 0 lines of it\); pair w1 head \(2 set up, 2 held, 4 lines of it\)$/ }],
  ["`besidemt`: one turn is in the log twice and another not at all", { W: "besidemt", edit: (f) => sub(f, at("besidemt", "raw-besidemt.log"), "## pair 2 head\n", "## pair 1 head\n") }, { exit: 1, problem: /p003: its log holds 6 turns \(w1 base, w1 head, 1 base, 1 head, 2 base, 1 head\), not once each the 6 of its pairs/ }],
  // The state the two workloads are declared for, in the counted turns: at least 95 more user
  // instructions a request on the head, at the median across the change's placements. Under it
  // a change within its margin is not read as declared; a miss stays a miss.
  ["`beside`: the change's medians lie about +3% and the head runs 95 more instructions a request", { W: "beside", change: 0.03, instr: 95 }, { exit: 0, gate: "meets +5%", margin: 0.05 }],
  ["`beside`: the change's medians lie about +3% and the head runs 94 more instructions a request", { W: "beside", change: 0.03, instr: 94 }, { exit: 0, gate: NOT_SHOWN, margin: 0.05 }],
  ["`besidemt`: the change's medians lie about 0% and the head runs no more instructions a request", { W: "besidemt", change: 0, instr: 0 }, { exit: 0, gate: NOT_SHOWN, margin: 0.05 }],
  ["`beside`: the change's medians lie about +6% and the head runs no more instructions a request (a miss stays a miss)", { W: "beside", change: 0.06, instr: 0 }, { exit: 0, gate: "misses +5%", margin: 0.05 }],
  ["`plain`: the head runs no more instructions a request (no such floor for it)", { W: "plain", instr: 0 }, { exit: 0, gate: "meets +1%", margin: 0.01 }],
  // The watched turns of the two workloads (park.sh): the base's waits with no timeout, the head's with one.
  ["`beside`: no record of the watched turns", { W: "beside", edit: (f) => f.delete(join("park", "verdicts.txt")) }, { exit: 2, refused: /beside: no watched turn 1 of the base shown with no timeout on any wait that can block \(no timer in the wheel\) \(park\/verdicts\.txt\)/ }],
  ["`beside`: the head's watched turns show no timeout", { W: "beside", edit: (f) => f.set(join("park", "verdicts.txt"), f.get(join("park", "verdicts.txt")).replaceAll(/every one with a timeout, from \d+ to \d+ ms/g, "every one with no timeout")) }, { exit: 2, refused: /beside: no watched turn 3 of the head shown with a timeout on every wait that can block \(the idle connection's timer in the wheel\)/ }],
  ["`besidemt`: the base's second watched turn shows a timeout", { W: "besidemt", edit: (f) => sub(f, join("park", "verdicts.txt"), /^(base turn 2: .*)every one with no timeout;/m, "$1every one with a timeout, from 12 to 29000 ms;") }, { exit: 2, refused: /besidemt: no watched turn 2 of the base shown with no timeout on any wait/ }],
  ["`besidemt`: two watched turns of the head, not three", { W: "besidemt", edit: (f) => sub(f, join("park", "verdicts.txt"), /^head turn 3: .*\n/m, "") }, { exit: 2, refused: /besidemt: no watched turn 3 of the head shown/ }],
  // A dry run of the gated part's scripts with the base as both sides: the part is the gated one
  // whatever plan.env names, the head is held to the base's rule, and nothing is read as met.
  ["`beside`: a dry run of the gated part with the base as both sides", { W: "beside", change: 0, instr: 0, env: (e) => e.replace(/^PART=gated$/m, "PART=pilot"), edit: DRY_GATED }, { exit: 0, gate: NOT_SHOWN, margin: 0.05 }],
  ["`beside`: the same results with no word of a dry run", { W: "beside", change: 0, instr: 0, env: (e) => e.replace(/^PART=gated$/m, "PART=pilot"), edit: (f) => { DRY_GATED(f); f.delete("DRYRUN"); } }, { exit: 2, refused: /kit\.txt's part gated is not plan\.env's pilot/ }],
  ["`beside`: a dry run with the base as both sides whose \"head\" shows a timeout", { W: "beside", change: 0, instr: 0, env: (e) => e.replace(/^PART=gated$/m, "PART=pilot"), edit: (f) => f.set("DRYRUN", `DRY RUN: K=${K}, R=${R}, TURN=1; fail seq none; not a measurement; part gated with the base as both sides\n`) }, { exit: 2, refused: /beside: no watched turn 1 of the head shown with no timeout on any wait/ }],
  // No placement is run again: a failed one leaves its comparison with no bound, and results
  // that show one run again are not read.
  ["`plain`: a placement was stopped at its time limit (no ended line, one pair of its two)", { W: "plain", edit: (f) => { sub(f, at("plain", "placement.txt"), /ended \S+\n$/, ""); sub(f, at("plain", "counts-plain.csv"), /2,base,[^\n]*\n2,head,[^\n]*\n$/, ""); } }, { exit: 1, problem: /p003: placement\.txt has no started and ended lines \(8 lines\): its pairs were not all in/ }],
  ["`beside`: a placement failed its answers' check (no counts, no ended line)", { W: "beside", edit: (f) => { sub(f, at("beside", "placement.txt"), /ended \S+\n$/, ""); f.delete(at("beside", "counts-beside.csv")); f.set(at("beside", join("answers-beside", "verdict.txt")), "checked 1 requests: differ\n"); } }, { exit: 1, problem: /p003: no counts-beside\.csv/ }],
  ["`plain`: the results hold a retries.txt", { W: "plain", edit: (f) => f.set("retries.txt", "61 change-plain 3 retry-of 7\n") }, { exit: 2, refused: /the results hold a retries\.txt: this kit runs no placement again/ }],
  ["`plain`: the results hold a failed attempt moved aside", { W: "plain", edit: (f) => f.set(join("failed", "change-plain-p003-seq7", "placement.txt"), "made up\n") }, { exit: 2, refused: /the results hold a failed\/ directory: this kit runs no placement again/ }],
  ["`plain`: plan.env names a count of retries", { W: "plain", env: (e) => e + "RETRY_MAX=3\n" }, { exit: 2, refused: /plan\.env names RETRY_MAX: this kit runs no placement again/ }],
  ["`plain`: the schedule's first placement was run after all the others (as one run again would be)", { W: "plain", edit: (f) => { const [, c, i] = f.get("schedule.txt").split("\n")[0].split(" "), p = join(c, `p${String(i).padStart(3, "0")}`, "placement.txt"); sub(f, p, /started \S+\nended \S+\n$/, "started 2026-01-02T00:00:00.000Z\nended 2026-01-02T00:00:30.000Z\n"); } }, { exit: 2, refused: /\(seq 2\) started before .* \(seq 1\) ended: the placements did not run one after another in the schedule's order/ }],
  // Another kit's results.
  ["`plain`: results of the kit before this one", { W: "plain", edit: (f) => sub(f, "kit.txt", `kit ${KIT}`, "kit cycles-deadline-2029-2") }, { exit: 2, refused: /kit\.txt names kit cycles-deadline-2029-2, not cycles-deadline-2029-3/ }],
];

let n = 0;
try {
  for (const [what, o, want] of CASES) {
    const r = report(...make(`case-${n + 1}`, o)), j = r.json, W = o.W;
    const fail = (why) => { console.log(`FAILED ${what}: ${why}`); console.log(JSON.stringify({ exit: r.exit, refused: j.refused, gated: j.gated, problems: j.problems }, null, 1)); process.exitCode = 1; throw new Error("stop"); };
    if (r.exit !== want.exit) fail(`exit ${r.exit}, not ${want.exit}`);
    let read;
    if (want.refused) {
      if (!j.refused.some((x) => want.refused.test(x))) fail("not refused for that reason");
      read = `refused: ${j.refused.find((x) => want.refused.test(x))}`;
    } else if (want.problem) {
      const all = Object.values(j.problems).flat();
      if (all.length !== 1 || !want.problem.test(all[0])) fail("not left incomplete for that reason alone");
      if (!/^no bound \(incomplete\)|^not resolved/.test(j.gated.gate)) fail(`an incomplete comparison was read: ${j.gated.gate}`);
      read = `incomplete, "${j.gated.gate}": ${all[0]}`;
    } else {
      if (j.gated.gate !== want.gate) fail(`read "${j.gated.gate}", not "${want.gate}"`);
      if (want.margin != null && j.gated.margin !== want.margin) fail(`margin ${j.gated.margin}, not ${want.margin}`);
      if ((want.resolved ?? "resolved") !== j.gated.resolved) fail(`the A/A read "${j.gated.resolved}"`);
      if (!r.md.includes(`| change-${W} | ${K} of ${K} |`) || !r.md.includes(`**${want.gate}**`)) fail("the page does not say so");
      const pc = (x) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(2)}%`;
      read = `A/A ${pc(j.gated.aaBound)} and ${pc(j.gated.aaSwapped)} swapped, ${j.gated.resolved}; change bound ${pc(j.gated.changeBound)} against +${Math.round(100 * j.gated.margin)}%: ${j.gated.gate}`;
    }
    n++;
    console.log(`ok ${what}: ${read}`);
  }
} catch (e) { if (e.message !== "stop") throw e; } finally { rmSync(root, { recursive: true, force: true }); }
console.log(`${n} of ${CASES.length} cases`);
