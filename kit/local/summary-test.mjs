// summary-test.mjs (local, not packed): synthetic receipts for summary.mjs. A complete run of
// 100 pairs on each of the four comparisons is judged; the same run with one hit row's error
// count blank, the errors column missing, or a turn of zero requests has no verdict (exit 1).
// Usage: node summary-test.mjs <summary.mjs>
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const script = process.argv[2];
const HEAD = "pair,version,requests,cycles_u,cycles_k,instructions_u,page_faults,minor_faults,icache_u,minflt,rss_idle_kb,rss_end_kb,hwm_kb,anon_huge_kb,errors";
const row = (pair, version, over = {}) => {
  const r = { pair, version, requests: 30000, cycles_u: 3e9 + pair * 1e6, cycles_k: 1e9 + (version === "head" ? -1e6 : 0), instructions_u: 4e9, page_faults: 10, minor_faults: 10, icache_u: 1e6, minflt: 200, rss_idle_kb: 7800, rss_end_kb: 8700, hwm_kb: 8700, anon_huge_kb: 0, errors: 0, ...over };
  return HEAD.split(",").map((c) => (c in r ? r[c] : "")).join(",");
};
const csv = (edit = (l) => l) => [HEAD, ...Array.from({ length: 100 }, (_, i) => [row(i + 1, "base"), row(i + 1, "head")]).flat()].map(edit).join("\n") + "\n";
const run = (name, hitCsv) => {
  const dir = mkdtempSync(join(tmpdir(), "summary-1824f-"));
  for (const c of ["room", "hit", "plain", "jroom"]) writeFileSync(join(dir, `pairs-${c}.csv`), c === "hit" ? hitCsv : csv());
  const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  const decision = r.stdout.split("\n").find((l) => l.startsWith("DECISION")) ?? "";
  const hit = r.stdout.split("\n").find((l) => l.startsWith("### hit") || l.startsWith("hit:")) ?? "";
  return { name, status: r.status, decision, hit };
};
const cases = [
  [run("complete", csv()), 0],
  [run("one hit row's errors blank", csv((l) => (l.startsWith("37,head,") ? l.replace(/,0$/, ",") : l))), 1],
  [run("errors column missing", csv((l) => l.replace(/,[^,]*$/, ""))), 1],
  [run("a hit turn of zero requests", csv((l) => (l.startsWith("12,base,") ? l.replace(/^12,base,30000,/, "12,base,0,") : l))), 1],
  [run("errors not a whole count", csv((l) => (l.startsWith("5,base,") ? l.replace(/,0$/, ",x") : l))), 1],
  [run("errors a space", csv((l) => (l.startsWith("9,head,") ? l.replace(/,0$/, ", ") : l))), 1],
  [run("cycles a space", csv((l) => (l.startsWith("9,base,") ? l.replace(/^9,base,30000,[0-9]+,/, "9,base,30000, ,") : l))), 1],
  [run("a negative cycle count", csv((l) => (l.startsWith("9,base,") ? l.replace(/^9,base,30000,/, "9,base,30000,-") : l))), 1],
  [run("a third row of another version", csv() + row(3, "main") + "\n"), 1],
  [run("a pair's head row twice", csv() + row(3, "head") + "\n"), 1],
];
let failed = 0;
for (const [c, want] of cases) {
  const ok = c.status === want;
  failed += ok ? 0 : 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name}: exit ${c.status} (want ${want}); ${c.decision}${c.status !== 0 ? " | " + c.hit : ""}`);
}
process.exitCode = failed ? 1 : 0;