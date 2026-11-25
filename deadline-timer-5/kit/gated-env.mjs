// gated-env.mjs <out plan.env> <workload>=<K>...: the gated part's plan.env, made from the
// pilot's (this kit's plan.env) and the K the pilot sized for each workload, with the gated seeds
// the plan declares and each workload's pad lists for its K (pads.mjs's). pack.sh takes the file
// as its third argument. Nothing on a host runs this.
// Every workload of schedule.mjs must be given, each once and nothing else: a K from 30 to 254,
// or `none` for a workload the pilot sized no K for. Such a workload gets K_<W>=0 and no lists,
// which plan.sh and padlists.mjs refuse, so the file cannot be packed or run: the plan starts
// Part 2 on no host unless all seven workloads have a K, and a file with a `none` is a record of
// what the pilot gave. Exit 1 then.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pads } from "./pads.mjs";
import { WORKLOADS } from "./schedule.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [out, ...pairs] = process.argv.slice(2);
if (!out) { console.error("usage: node gated-env.mjs <out plan.env> <workload>=<K>..."); process.exit(2); }
// The gated seeds, as the plan declares them, in the order of the kit's workloads.
const GATED_SEEDS = { plain: 7411, wait: 7412, close: 7413, unstaged: 7414, after: 7415, beside: 7416, besidemt: 7417 };
if (WORKLOADS.some((w) => !(w in GATED_SEEDS)) || Object.keys(GATED_SEEDS).length !== WORKLOADS.length) throw new Error(`the kit's workloads (${WORKLOADS.join(", ")}) are not the ones the gated seeds are declared for`);
const given = new Map();
for (const p of pairs) {
  const m = /^([a-z]+)=(\d+|none)$/.exec(p);
  if (!m || !WORKLOADS.includes(m[1])) throw new Error(`"${p}" is not <workload>=<K> for a workload of the kit (${WORKLOADS.join(", ")})`);
  if (given.has(m[1])) throw new Error(`${m[1]} given twice`);
  if (m[2] !== "none" && (+m[2] < 30 || +m[2] > 254)) throw new Error(`${m[1]}: K ${m[2]} is not from 30 to 254`);
  given.set(m[1], m[2]);
}
const missing = WORKLOADS.filter((w) => !given.has(w));
if (missing.length) throw new Error(`no K given for ${missing.join(", ")}`);
let e = readFileSync(join(here, "plan.env"), "utf8").replace(/^PADS_[PQ]_.*\n/gm, "");
const set = (k, v) => { const re = new RegExp(`^${k}=.*$`, "m"); if (!re.test(e)) throw new Error(`no ${k} in the kit's plan.env`); e = e.replace(re, `${k}=${v}`); };
if (!/^PART=pilot$/m.test(e)) throw new Error("the kit's plan.env is not the pilot's");
set("PART", "gated");
for (const w of WORKLOADS) {
  const U = w.toUpperCase(), K = given.get(w) === "none" ? 0 : Number(given.get(w));
  set(`K_${U}`, K);
  set(`SEED_${U}`, GATED_SEEDS[w]);
  if (K) { const { P, Q } = pads(K); e += `PADS_P_${U}="${P.join(" ")}"\nPADS_Q_${U}="${Q.join(" ")}"\n`; }
}
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), e);
console.log(e.split("\n").filter((l) => l && !l.startsWith("#") && !l.startsWith("PADS_")).join(" "));
const without = WORKLOADS.filter((w) => given.get(w) === "none");
console.log(without.length ? `NO K for ${without.join(", ")} (K_<W>=0, no pad lists): this file cannot be packed or run, and Part 2 starts on no host; those workloads return to the maintainer` : "every workload has a K and its pad lists");
process.exit(without.length ? 1 : 0);
