// check-report.mjs: report.mjs and placement.mjs on made-up results (pack.ps1 runs it; it needs
// nothing but node). Writes made-up result directories under the system's temporary directory,
// with the pad lists of the kit's plan.env, runs report.mjs on each and checks its readings,
// then removes them:
//   1. the plan's ranks and quantiles: the 20th of 30, the 59th of 100, t(0.95, 29);
//   2. small A/A spread and a change of -1%: both A/As resolved, the change meets +1%;
//   3. a wide aa-kept (placements -6% to +6%): not resolved, so the same change does not pass,
//      and the A/A's largest placement median in absolute value reads about 6%;
//   4. a change of +2% with resolved A/As: misses +1%;
//   5. one change placement missing, one with the wrong binary's sha256, one with R - 1 pairs,
//      one naming another pad's binary: each leaves change-kept incomplete, with no bound, and it
//      does not pass;
//   6. the diagnostic (unpadded-kept): every padded placement 2% dearer gives 8 of 8 above zero
//      and a sign test p of 2/256; a missing diagnostic placement leaves the gate's reading as it was.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upperRank } from "./stats.mjs";
import { across, tQuantile } from "./placement.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

check(upperRank(30) === 20, "the bound across 30 placements is the 20th");
check(upperRank(100) === 59, "the bound across 100 pairs is the 59th");
check(upperRank(4) > 4, "4 placements give no bound");
check(Math.abs(tQuantile(0.95, 29) - 1.699127) < 1e-5, "t(0.95, 29) = 1.6991");
const xs = Array.from({ length: 30 }, (_, i) => (i - 10) / 1000);
check(across(xs).bound === xs[19] && across(xs).lower === xs[10], "across(30 values) bounds by the 20th and 11th smallest");

const planText = readFileSync(join(here, "plan.env"), "utf8");
const plan = Object.fromEntries(planText.split("\n").map((l) => /^([A-Z_]+)=(?:"([^"]*)"|(\S*))$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2] ?? m[3]]));
const K = Number(plan.K), R = Number(plan.R), DK = Number(plan.DIAG_K), DR = Number(plan.DIAG_R);
const P = plan.PADS_P.split(/\s+/), Q = plan.PADS_Q.split(/\s+/);
check(K === 30 && R === 8 && DK === 8 && DR === 8 && P.length === K && Q.length === K, `plan.env: K=${K}, R=${R}, DIAG_K=${DK}, DIAG_R=${DR}, ${P.length} and ${Q.length} pads`);
let seed = 1965;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
function results({ aaPlain, aaKept, change, diag = () => 0, mutate = () => {} }) {
  const dir = mkdtempSync(join(tmpdir(), "check-1965-"));
  writeFileSync(join(dir, "plan.env"), planText);
  const sha = (n) => (n.split("").reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, "0")).repeat(8);
  const names = ["main", "base", "head", ...P.flatMap((n) => [`main-p${n}`, `base-p${n}`, `head-p${n}`]), ...Q.map((n) => `main-p${n}`)];
  writeFileSync(join(dir, "sha256.txt"), names.map((n) => `${n} ${sha(n)} 4500000 bytes`).join("\n") + "\n");
  const write = (comparison, workload, i, A, B, offset, r) => {
    const p = join(dir, comparison, `p${String(i + 1).padStart(2, "0")}`);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "placement.txt"), `comparison ${comparison} placement ${i + 1} workload ${workload}\nA ${A} ${sha(A)}\nB ${B} ${sha(B)}\n`);
    const rows = ["pair,version,requests,cycles_u,cycles_k,instructions_u"];
    for (let k = 1; k <= r; k++) {
      const req = 200000, u = 2e4 * req * (1 + 0.03 * (rand() - 0.5)), kk = 2.4e4 * req * (1 + 0.03 * (rand() - 0.5));
      const f = 1 + offset + 0.02 * (rand() - 0.5);
      rows.push(`${k},base,${req},${Math.round(u)},${Math.round(kk)},${4e4 * req}`, `${k},head,${req},${Math.round(u * f)},${Math.round(kk * f)},${4e4 * req}`);
    }
    writeFileSync(join(p, `cycles-${workload}.csv`), rows.join("\n") + "\n");
  };
  for (let i = 0; i < K; i++) {
    write("aa-plain", "plain", i, `main-p${P[i]}`, `main-p${Q[i]}`, aaPlain(i), R);
    write("aa-kept", "kept", i, `main-p${P[i]}`, `main-p${Q[i]}`, aaKept(i), R);
    write("change-kept", "kept", i, `base-p${P[i]}`, `head-p${P[i]}`, change(i), R);
  }
  for (let i = 0; i < DK; i++) write("unpadded-kept", "kept", i, "main", `main-p${P[i]}`, diag(i), DR);
  mutate(dir);
  const md = execFileSync("node", [join(here, "report.mjs"), dir], { encoding: "utf8" });
  const j = JSON.parse(readFileSync(join(dir, "placements.json"), "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return { ...j, md };
}
const small = (i) => 0.004 * Math.sin(i * 1.7);
const wide = (i) => 0.06 * Math.sin(i * 1.7);
let j = results({ aaPlain: small, aaKept: small, change: (i) => -0.01 + small(i) });
check(j.resolved.plain === "resolved" && j.resolved.kept === "resolved", `small A/A spread: both resolved (${j.resolved.plain}, ${j.resolved.kept})`);
check(j.gate === "meets +1%", `a -1% change with resolved A/As meets +1% (${j.gate})`);
check(/the 20th of the 30 sorted placement medians/.test(j.md) && /\| change-kept \| 30 of 30 \|/.test(j.md), "the report names the 20th of 30 and counts 30 of 30 change placements");
j = results({ aaPlain: small, aaKept: wide, change: (i) => -0.01 + small(i) });
const maxAbs = j.results["aa-kept"].spread["cycles user+kernel"].maxAbs;
check(j.resolved.kept === "not resolved" && j.gate === "not resolved: does not pass", `a wide aa-kept is not resolved and the change does not pass (${j.resolved.kept}; ${j.gate})`);
check(maxAbs > 0.05 && maxAbs < 0.07 && /Placement spread on main \(A\/A\)/.test(j.md), `a wide aa-kept's largest placement median in absolute value is about 6% (${(maxAbs * 100).toFixed(2)}%)`);
j = results({ aaPlain: small, aaKept: small, change: (i) => 0.02 + small(i) });
check(j.gate === "misses +1%", `a +2% change with resolved A/As misses +1% (${j.gate})`);
const B3 = `head-p${P[2]}`, B4 = `head-p${P[3]}`;
for (const [what, mutate] of [
  ["one change placement missing", (d) => rmSync(join(d, "change-kept", "p07"), { recursive: true })],
  ["one change placement naming another binary's sha256", (d) => { const f = join(d, "change-kept", "p03", "placement.txt"); writeFileSync(f, readFileSync(f, "utf8").replace(new RegExp(`^B ${B3} [0-9a-f]+$`, "m"), `B ${B3} ` + "0".repeat(64))); }],
  ["one change placement with R - 1 pairs", (d) => { const f = join(d, "change-kept", "p11", "cycles-kept.csv"); writeFileSync(f, readFileSync(f, "utf8").trim().split("\n").slice(0, -2).join("\n") + "\n"); }],
  [`one change placement's B swapped to another pad's ${B4}`, (d) => { const f = join(d, "change-kept", "p03", "placement.txt"); writeFileSync(f, readFileSync(f, "utf8").replace(new RegExp(`^B ${B3} .*$`, "m"), `B ${B4} x`)); }],
]) {
  j = results({ aaPlain: small, aaKept: small, change: (i) => -0.01 + small(i), mutate });
  const c = j.results["change-kept"];
  check(!c.complete && c.across["cycles user+kernel"].bound === null && /does not pass/.test(j.gate), `${what}: incomplete, no bound, does not pass (${j.gate}; ${c.problems.join("; ")})`);
}
j = results({ aaPlain: small, aaKept: small, change: (i) => -0.01 + small(i), diag: () => 0.02 });
const d = j.results["unpadded-kept"];
check(d.complete && d.placements.length === DK && d.above === DK && Math.abs(d.signP - 2 / 256) < 1e-12, `diagnostic: ${d.above} of ${d.placements.length} padded placements dearer, sign test p ${d.signP}`);
j = results({ aaPlain: small, aaKept: small, change: (i) => -0.01 + small(i), mutate: (dd) => rmSync(join(dd, "unpadded-kept", "p02"), { recursive: true }) });
check(!j.results["unpadded-kept"].complete && j.gate === "meets +1%", `a missing diagnostic placement is reported and leaves the gate's reading (${j.gate})`);
if (failed) { console.log(`check-report: ${failed} failed`); process.exit(1); }
console.log("check-report: all passed");
