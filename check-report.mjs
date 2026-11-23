// check-report.mjs: report.mjs and placement.mjs on made-up results with plan.env's pads, so a
// mistake in the reading shows before a run (pack.sh runs it):  node check-report.mjs
// It writes results directories under the system's temporary directory, each K placements of R
// pairs for the five comparisons, with per-pair changes it chooses, and checks the verdicts:
//   1. the rank of the bound: the 20th of 30;
//   2. A/As near no change and a change near no change: both workloads meet +1%;
//   3. a change of +2% on `old`: misses +1% there, and the plan's condition is not met;
//   4. an A/A whose B list runs 1.5% faster: its bound as recorded is under +1%, its bound with
//      the labels swapped is not, so it is not resolved and the change does not pass;
//   5. a start whose Age is outside its range, or a placement of 7 pairs: incomplete, no bound.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { upperRank } from "./stats.mjs";
import { HEADER } from "./placement.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(here, "plan.env"), "utf8").split("\n").map((l) => /^([A-Z_]+)=(?:"([^"]*)"|(\S*))$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2] ?? m[3]]));
const K = Number(env.K), R = Number(env.R), DK = Number(env.DIAG_K), DR = Number(env.DIAG_R);
const P = env.PADS_P.split(" "), Q = env.PADS_Q.split(" ");
const fail = (why) => { console.error("check-report: " + why); process.exit(1); };
if (upperRank(30) !== 20 || upperRank(100) !== 59) fail(`upperRank(30) = ${upperRank(30)}, upperRank(100) = ${upperRank(100)}`);

// A small deterministic generator, so the made-up results are the same every time.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;

function make(shift, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-1983-"));
  copyFileSync(join(here, "plan.env"), join(dir, "plan.env"));
  const names = new Set(["base", "head", ...P.map((p) => `base-p${p}`), ...Q.map((q) => `base-p${q}`), ...P.map((p) => `head-p${p}`)]);
  writeFileSync(join(dir, "sha256.txt"), [...names].map((n) => `${n} sha-${n} 1 bytes`).join("\n") + "\n");
  const comparisons = {
    "aa-old": ["old", K, R, (i) => [`base-p${P[i]}`, `base-p${Q[i]}`]],
    "change-old": ["old", K, R, (i) => [`base-p${P[i]}`, `head-p${P[i]}`]],
    "aa-young": ["young", K, R, (i) => [`base-p${P[i]}`, `base-p${Q[i]}`]],
    "change-young": ["young", K, R, (i) => [`base-p${P[i]}`, `head-p${P[i]}`]],
    "unpadded-old": ["old", DK, DR, (i) => ["base", `base-p${P[i]}`]],
  };
  for (const [name, [workload, k, r, sides]] of Object.entries(comparisons)) {
    for (let i = 0; i < k; i++) {
      const d = join(dir, name, `p${String(i + 1).padStart(2, "0")}`);
      mkdirSync(d, { recursive: true });
      const [A, B] = sides(i);
      writeFileSync(join(d, "placement.txt"), `comparison ${name} placement ${i + 1} workload ${workload}\nA ${A} sha-${A}\nB ${B} sha-${B}\n`);
      const place = 0.012 * rnd(), rows = [HEADER], ages = [];
      const pairs = opts.short === name && i === 0 ? r - 1 : r;
      const age = workload === "old" ? 10006 : 2;
      for (const v of ["base", "head"]) ages.push(`w1 ${v} before ${age} after ${age + 4} runs 1`);
      for (let p = 1; p <= pairs; p++) {
        const requests = 130000 + Math.round(2000 * rnd());
        const change = (shift[name] ?? 0) + place + 0.02 * rnd();
        const row = (v, f) => `${p},${v},${requests},${Math.round(requests * 6000 * f)},${Math.round(requests * 16000 * f)},${Math.round(requests * 24000)},${Math.round(requests * 2400 * f)}`;
        rows.push(row("base", 1), row("head", 1 + change));
        for (const v of ["base", "head"]) ages.push(`${p} ${v} before ${opts.badAge === name && i === 2 && p === 1 ? 3 : age} after ${age + 4} runs 1`);
      }
      writeFileSync(join(d, `counts-${workload}.csv`), rows.join("\n") + "\n");
      writeFileSync(join(d, `ages-${workload}.txt`), ages.join("\n") + "\n");
    }
  }
  const run = spawnSync(process.execPath, [join(here, "report.mjs"), dir], { encoding: "utf8" });
  if (run.status !== 0) fail("report.mjs failed: " + run.stderr);
  const json = JSON.parse(readFileSync(join(dir, "placements.json"), "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return { json, text: run.stdout };
}

let r = make({});
if (r.json.resolved.old !== "resolved" || r.json.resolved.young !== "resolved" || !r.json.both) fail("near no change: " + JSON.stringify([r.json.resolved, r.json.gate]));
if (r.json.results["aa-old"].across["cycles user+kernel"].rank !== 20) fail("the bound is not the 20th of 30");
if (!r.text.includes("| change-old | 30 of 30 |") || !r.text.includes("**meets +1%**")) fail("the verdict table does not show the change");

r = make({ "change-old": 0.02 });
if (r.json.gate.old !== "misses +1%" || r.json.gate.young !== "meets +1%" || r.json.both) fail("+2% on old: " + JSON.stringify(r.json.gate));

r = make({ "aa-young": -0.015 });
const aa = r.json.results["aa-young"];
if (!(aa.across["cycles user+kernel"].bound < 0.01) || !(aa.swapped["cycles user+kernel"].bound >= 0.01)) fail("a faster B list: bounds " + aa.across["cycles user+kernel"].bound + " and " + aa.swapped["cycles user+kernel"].bound);
if (r.json.resolved.young !== "not resolved" || r.json.gate.young !== "not resolved: does not pass" || r.json.both) fail("a faster B list: " + JSON.stringify([r.json.resolved, r.json.gate]));

r = make({}, { badAge: "change-old" });
if (r.json.results["change-old"].complete || r.json.gate.old !== "no bound (incomplete): does not pass") fail("an Age out of range: " + JSON.stringify(r.json.gate));
r = make({}, { short: "aa-old" });
if (r.json.results["aa-old"].complete || r.json.resolved.old !== "not resolved (incomplete)" || r.json.gate.old !== "not resolved: does not pass") fail("a placement of 7 pairs: " + JSON.stringify([r.json.resolved, r.json.gate]));

console.log("check-report: the rank, the two readings of an A/A, the verdicts and the incomplete cases read as margin.md says");
