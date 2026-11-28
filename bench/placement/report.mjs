// report.mjs: one run's results as the page a pull request reports (CONTRIBUTING.md, Pull
// requests, item 2: a workload read across placements):
//   node report.mjs <results dir> > report.md      also writes <results dir>/report.json
// Exit 0: every comparison of the part complete; 1: one or more without all their placements (no
// bound); 2: refused, nothing read; anything else: report.mjs itself failed.
//
// Refused outright (exit 2), as a failed, misconfigured or altered run could leave:
//   - a results directory without the run's id, plan, schedule, SHA-256s, host or verify verdicts;
//   - a plan that is not usable, or whose SHA-256, pad lists, K, R, turn length, seed or seeded
//     order are not what plan.mjs gives for it;
//   - a probe, request script or expected answer in the results that is not, file for file, what
//     plan.mjs listed when it resolved the plan (plan.mjs's inputs);
//   - a K checked from an A/A read on another CPU model than this run's host;
//   - a side without its unpadded link's map or its record from that map, a record that is not
//     what the map gives, or a map that shows the side has no reading across placements;
//   - a binary a comparison reads that was not verified against its side's unpadded binary, has
//     no passing layout check or, where either side has a section of .text aligned beyond 16
//     bytes, no second pad's line and map check;
//   - for a workload the plan shuffles (README.md, workloads[].shuffle), a missing or unreadable
//     list of functions (functions-<side>.txt.gz), a missing or altered unpadded or placement map,
//     or a binary without a shuffled layout check for the ordering file drawn from that list,
//     the seed and the index, both maps in maps/placements.sha256 and both executables in
//     sha256.txt. A second-pad map check must name both maps. A head binary needs a passing
//     cross-side check (layout/head-p<n>-alike.txt) naming both ordering files and all four maps
//     and executables, with compared and left-out counts that sum to the saved lists' shared name
//     count and meet the live check's minimum. An unshuffled plan refuses shuffled checks;
//   - placements not started one after another in the order run.
// A placement leaves its comparison without a bound when its directory, its counts, its
// placement.txt (the comparison, A and B with the build's SHA-256s, the run, the plan, its place
// in the schedule, started and ended) or its answers' verdict is missing or not this run's, or
// its counts are not pairs 1..R each read once on each side, every count above zero.
//
// A gated part's K is checked by the kit only when plan.mjs was given results to check it from
// (--sized-from). When it was not, report.json's "sized" is null and every reading is followed
// by "K not checked by the kit": a pass at a K nobody checked is not printed as a pass.
//
// What it prints, in cycles a request, user plus kernel, B / A - 1 per pair, a placement's
// statistic the median of its R pairs:
//   every part   each side's input sections of .text aligned beyond 16 bytes and its list of
//                symbols from the first on; the second pads' lines when there are any; every
//                measure across placements (the user and kernel split, user instructions and
//                user L1 instruction-cache misses, as cycles are); every placement
//   pilot        the spread of the placement medians; whether the A/A is eligible to size a run;
//                the models kept and the K the sizing check gives. Its bounds decide nothing.
//   gated        the A/A read twice and whether it resolves; the change's bound and whether the
//                workload meets +1%; the benefit side when the plan declares a reduction
//   shuffled     at each index, how many names both sides have head's check compared and left out
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEWEST, PADS, thinName } from "./layout.mjs";
import { mapText, placementMaps, readMap, record, refusals } from "./map.mjs";
import { names as functionNames, order } from "./order.mjs";
import { DRAWS, eligibility, failing, LIMIT, SEED, sizeByRule } from "./pilot.mjs";
import { EVENTS, inputs, K_MAX, K_MIN, problems, resolve, setup } from "./plan.mjs";
import { lines as scheduleLines, sides } from "./schedule.mjs";
import { across, margin, ord, pct, placement, resolution, win } from "./stats.mjs";

const COLUMNS = `pair,version,requests,${EVENTS.replace(/[^A-Za-z0-9,]/g, "_")}`;
const MEASURES = {
  "cycles, user and kernel": (r) => (r.cycles_u + r.cycles_k) / r.requests,
  "cycles, user": (r) => r.cycles_u / r.requests,
  "cycles, kernel": (r) => r.cycles_k / r.requests,
  "instructions, user": (r) => r.instructions_u / r.requests,
  "L1 instruction-cache misses, user": (r) => r.icache_u / r.requests,
};
const GATE = "cycles, user and kernel";
const fmt = (x) => (x == null || !Number.isFinite(x) ? "-" : pct(x));
const width = (x) => fmt(x).replace(/^\+/, ""); // a standard deviation has no sign
const p3 = (x) => (x == null || !Number.isFinite(x) ? "-" : x < 0.001 ? x.toExponential(1) : x.toFixed(3));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isSha = (s) => /^[0-9a-f]{64}$/.test(s);

function readPairs(file) {
  const [header, ...rest] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  if (header !== COLUMNS) throw new Error("not this kit's counts CSV");
  const rows = rest.map((l) => {
    const [pair, version, ...v] = l.split(",");
    const n = v.map(Number);
    // A count of zero is a counter that counted nothing, not a turn that cost nothing.
    if (n.length !== 5 || n.some((x) => !Number.isFinite(x) || x <= 0)) throw new Error(`unusable row ${l}`);
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

/** A results directory as run.sh left it: { refused: [why] } or the run with its placements. */
export function read(dir) {
  const refused = [];
  const need = ["run-id", "schedule.txt", "sha256.txt", "host-id.txt", join("plan", "plan.json"), join("plan", "resolved.json"), join("plan", "request.lua"), join("verify", "verdicts.txt")];
  const missing = need.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) return { refused: [`no ${missing.join(", ")} in the results: not a complete record of a run`] };
  const text = (f) => readFileSync(join(dir, f), "utf8");
  const bytes = readFileSync(join(dir, "plan", "plan.json")), planSha = createHash("sha256").update(bytes).digest("hex");
  let plan, saved;
  try { plan = JSON.parse(bytes.toString("utf8")); saved = JSON.parse(text(join("plan", "resolved.json"))); } catch (e) { return { refused: [`the results' plan is not JSON: ${e.message}`] }; }
  const bad = problems(plan);
  if (bad.length) return { refused: bad.map((x) => `plan.json: ${x}`) };
  if (saved.plan !== planSha) refused.push(`resolved.json was written for plan ${saved.plan}, not the results' plan.json (${planSha})`);
  // What the plan names by path, as the results hold it, against the list plan.mjs resolved.
  const expect = join(dir, "plan", "expect.txt");
  let list;
  try { list = inputs(join(dir, "probe"), join(dir, "plan", "request.lua"), existsSync(expect) ? expect : null); } catch (e) { return { refused: [...refused, e.message] }; }
  if (list.sha256 !== saved.inputs) refused.push(`the results' probe, request script and expected answer are not the files plan.mjs resolved (inputs sha256 ${list.sha256}, resolved ${saved.inputs})`);
  const hostId = Object.fromEntries(text("host-id.txt").replace(/\n$/, "").split("\n").map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1).trim()]));
  if (saved.sized && saved.sized.model !== hostId.model) refused.push(`K was checked from an A/A read on "${saved.sized.model}", and this run's host is "${hostId.model}": an A/A sizes a run on its own setup`);
  const runId = text("run-id").trim();
  if (!/^[0-9a-f-]{36}$/.test(runId)) refused.push("run-id is not a run's id");
  const dry = saved.dry ?? null;
  if (existsSync(join(dir, "DRYRUN")) !== Boolean(dry)) refused.push("the results and their plan do not agree on whether this is a dry run");
  let r;
  try { r = resolve(plan, saved.part, saved.workload, { K: saved.declaredK === "pilot" ? saved.sized?.K : undefined, dry }); } catch (e) { return { refused: [...refused, `plan.mjs gives no run for the results' plan: ${e.message}`] }; }
  for (const k of ["K", "R", "seconds", "seed", "P", "Q", "schedule", "shuffle"]) if (!same(r[k], saved[k])) refused.push(`resolved.json's ${k} is not what plan.mjs gives for the plan`);
  if (text("schedule.txt") !== scheduleLines(r.schedule)) refused.push(`schedule.txt is not the seeded order of ${r.part} ${r.workload}, K = ${r.K}, seed ${r.seed}`);
  const { part, workload: W, K, R, P, Q } = r;

  const used = new Set(), alike = [];
  for (const c of r.comparisons) for (let i = 1; i <= K; i++) for (const b of sides(c, i, P, Q)) used.add(b);
  const maps = r.shuffle ? placementMaps(join(dir, "maps"), [...r.sides, ...used]) : null;
  if (maps?.why.length) return { refused: [...refused, ...maps.why] };

  // Each side's record of code aligned beyond 16 bytes, from its unpadded link's map.
  const records = {};
  for (const side of r.sides) {
    const m = join(dir, "maps", `${side}.map.gz`), rec = join(dir, `record-${side}.json`);
    if (!existsSync(m) || !existsSync(rec)) { refused.push(`${side}: no unpadded map or no record from it; a run without that record has no reading across placements`); continue; }
    const map = readMap(maps ? maps.unpadded.get(side).toString("utf8") : mapText(readFileSync(m)));
    records[side] = record(map);
    if (!same(records[side], JSON.parse(readFileSync(rec, "utf8")))) refused.push(`${side}: record-${side}.json is not what its map gives`);
    for (const why of refusals(map)) refused.push(`${side} has no reading across placements: ${why}`);
  }
  const second = Object.values(records).some((x) => x.aligned.length > 0);
  const secondPads = new Map();
  if (second) {
    if (!existsSync(join(dir, "second-pads.txt"))) refused.push("a side has a section aligned beyond 16 bytes and the results have no second-pads.txt");
    else for (const l of text("second-pads.txt").trim().split("\n")) {
      const m = /^(\S+): first pad (\d+) \(mod 64: (\d+)\), second pad (16|32|48|64), \.data at (0x[0-9a-f]+);/.exec(l);
      if (m) secondPads.set(m[1], { pad: +m[2], second: +m[4], data: m[5], line: l });
    }
  }
  const shas = new Map();
  for (const l of text("sha256.txt").trim().split("\n")) { const [name, s] = l.split(" "); shas.set(name, s); }
  const verified = new Map();
  for (const l of text(join("verify", "verdicts.txt")).trim().split("\n")) {
    const m = /^(\S+) as (\S+): answers: same;/.exec(l);
    if (m) verified.set(m[1], m[2]);
  }
  const check = (file, want) => {
    if (!existsSync(join(dir, file))) return false;
    const j = text(file).split("\n").find((l) => l.startsWith("JSON "));
    try { const o = JSON.parse(j.slice(5)); return o.ok === true && Object.entries(want).every(([k, v]) => o[k] === v) ? o : false; } catch { return false; }
  };
  // A shuffled placement's ordering file, as order.mjs draws it from its side's list of functions,
  // the seed and the placement's index (its place in P or Q); unshuffled, a layout check carries
  // no "shuffled" and no "order".
  const lists = new Map();
  if (r.shuffle) for (const side of r.sides) {
    const file = `functions-${side}.txt.gz`, f = join(dir, file);
    if (!existsSync(f)) { refused.push(`${side}: no list of its functions (${file}); a shuffled run without it does not show the order each placement was linked in`); continue; }
    try { lists.set(side, functionNames(readFileSync(f))); }
    catch { return { refused: [...refused, `${side}: cannot read function list (${file})`] }; }
  }
  const orderSha = (side, pad) => {
    const i = P.includes(pad) ? P.indexOf(pad) + 1 : Q.indexOf(pad) + 1;
    try { return createHash("sha256").update(order(lists.get(side), r.seed, i)).digest("hex"); } catch { return null; }
  };
  const namesOf = (side) => new Set(lists.get(side)?.map(thinName).filter((n) => !PADS.includes(n)));
  const shared = r.shuffle && part === "gated" ? namesOf("base").intersection(namesOf("head")).size : 0;
  for (const b of used) {
    const side = b.replace(/-p\d+$/, ""), pad = Number(b.replace(/^.*-p/, ""));
    if (!shas.has(b)) { refused.push(`${b}: not in sha256.txt`); continue; }
    if (verified.get(b) !== side) refused.push(`${b}: not verified to answer as its unpadded binary (verify/verdicts.txt)`);
    if (r.shuffle && !lists.has(side)) continue;
    const unpaddedBinary = shas.get(side), placedBinary = shas.get(b);
    if (r.shuffle && !(isSha(unpaddedBinary) && isSha(placedBinary))) { refused.push(`${b}: no valid executable digest for it or its unpadded binary in sha256.txt`); continue; }
    const map = maps?.digests.get(b), unpaddedMap = maps?.digests.get(side);
    const shuffled = r.shuffle ? { shuffled: true, unpaddedMap, placedMap: map } : { shuffled: undefined };
    const sha = r.shuffle ? orderSha(side, pad) : undefined;
    if (r.shuffle && sha === null) refused.push(`${b}: its side's list of functions makes no ordering file (functions-${side}.txt.gz)`);
    else if (!check(join("layout", `${b}.txt`), { pad, second, ...shuffled, order: sha, ...(r.shuffle ? { unpaddedBinary, placedBinary } : {}) })) refused.push(r.shuffle ? `${b}: no passing shuffled layout check for a pad of ${pad} bytes, its drawn ordering file, maps and executables (layout/${b}.txt)` : `${b}: no passing layout check for a pad of ${pad} bytes (layout/${b}.txt)`);
    if (second && !(secondPads.get(b)?.pad === pad && check(join("layout", `${b}-map.txt`), { pad, second: secondPads.get(b).second, ...shuffled }))) refused.push(`${b}: no second pad's line with a passing map check${r.shuffle ? " for the saved unpadded and placement maps" : ""} (second-pads.txt, layout/${b}-map.txt)`);
    // The check against base's placement at its index names the two ordering files and the two
    // unpadded and two placement maps it read, each the one this run drew or kept, and the four
    // executables in the timing manifest.
    // It also gives how many of the names both sides have it compared and how many it left out,
    // which the report states for each index.
    if (r.shuffle && side === "head") {
      const baseMap = maps.digests.get(`base-p${pad}`), baseOrder = orderSha("base", pad);
      const a = baseMap && baseOrder && sha && check(join("layout", `${b}-alike.txt`), { pad, shuffled: true, baseOrder, headOrder: sha, baseMap, headMap: map, baseUnpaddedMap: maps.digests.get("base"), headUnpaddedMap: unpaddedMap, baseUnpaddedBinary: shas.get("base"), basePlacedBinary: shas.get(`base-p${pad}`), headUnpaddedBinary: unpaddedBinary, headPlacedBinary: placedBinary });
      if (!a) refused.push(`${b}: no passing check that the names it compares with base-p${pad} lie in the same order, using the ordering files, maps and executables for both (layout/${b}-alike.txt, maps/placements.sha256, sha256.txt)`);
      else if (![a.shared, a.compared, a.leftOut].every((n) => Number.isInteger(n) && n >= 0) || a.compared + a.leftOut !== a.shared) refused.push(`${b}: its check against base-p${pad} does not say how many of the names both have it compared and left out (layout/${b}-alike.txt)`);
      else if (a.shared !== shared) refused.push(`${b}: its check against base-p${pad} counts ${a.shared} shared names, not the ${shared} shared names in the saved function lists (layout/${b}-alike.txt)`);
      else if (a.compared < FEWEST) refused.push(`${b}: its check against base-p${pad} compared fewer than ${FEWEST} names (layout/${b}-alike.txt)`);
      else alike.push({ i: P.indexOf(pad) + 1, head: b, base: `base-p${pad}`, shared: a.shared, compared: a.compared, leftOut: a.leftOut });
    }
  }
  alike.sort((x, y) => x.i - y.i);
  if (refused.length) return { refused };

  const seqOf = new Map(r.schedule.map((s) => [`${s.comparison} ${s.i}`, s.seq]));
  const results = {}, times = [];
  for (const c of r.comparisons) {
    const placements = [], why = [], cdir = join(dir, c);
    const want = new Set(Array.from({ length: K }, (_, i) => `p${String(i + 1).padStart(3, "0")}`));
    for (const x of existsSync(cdir) ? readdirSync(cdir) : []) if (!want.has(x)) why.push(`${x}: not a placement of the plan`);
    for (let i = 1; i <= K; i++) {
      const name = `p${String(i).padStart(3, "0")}`, p = join(cdir, name), [A, B] = sides(c, i, P, Q), seq = seqOf.get(`${c} ${i}`);
      const gone = ["placement.txt", `counts-${W}.csv`, join("answers", "verdict.txt")].filter((f) => !existsSync(join(p, f)));
      if (gone.length) { why.push(`${name}: no ${gone.join(", ")}`); continue; }
      const got = readFileSync(join(p, "placement.txt"), "utf8").replace(/\n$/, "").split("\n");
      const head = [`comparison ${c} placement ${i} workload ${W}`, `A ${A} ${shas.get(A)}`, `B ${B} ${shas.get(B)}`, `run ${runId}`, `plan ${planSha}`, `seq ${seq}`];
      const off = head.findIndex((l, j) => got[j] !== l);
      const started = /^started (\S+Z)$/.exec(got[6] ?? ""), ended = /^ended (\S+Z)$/.exec(got[7] ?? "");
      if (off >= 0) { why.push(`${name}: placement.txt line ${off + 1} is "${got[off] ?? ""}", not "${head[off]}"`); continue; }
      if (got.length !== 8 || !started || !ended) { why.push(`${name}: placement.txt has no started and ended lines: its pairs were not all in`); continue; }
      if (!/^answers: (same|differ only as the plan's expected difference says)\s*$/.test(readFileSync(join(p, "answers", "verdict.txt"), "utf8"))) { why.push(`${name}: its two binaries' answers were not compared and passed`); continue; }
      let pairs;
      try { pairs = readPairs(join(p, `counts-${W}.csv`)); } catch (e) { why.push(`${name}: ${e.message}`); continue; }
      if (pairs.length !== R || pairs.some((x, j) => x.pair !== String(j + 1))) { why.push(`${name}: pairs ${pairs.map((x) => x.pair).join(",") || "none"}, not 1..${R}`); continue; }
      times.push({ seq, c, i, started: started[1], ended: ended[1] });
      const stats = Object.fromEntries(Object.entries(MEASURES).map(([m, f]) => [m, placement(pairs.map((x) => f(x.base)), pairs.map((x) => f(x.head)))]));
      placements.push({ i, seq, A, B, started: started[1], requests: pairs.reduce((s, x) => s + x.base.requests + x.head.requests, 0), stats });
    }
    results[c] = { complete: placements.length === K && why.length === 0, why, placements };
  }
  times.sort((a, b) => a.seq - b.seq);
  for (let j = 0; j < times.length; j++) {
    const t = times[j];
    if (t.ended < t.started) return { refused: [`${t.c} p${t.i}: ended before it started`] };
    if (j && times[j - 1].ended > t.started) return { refused: [`${t.c} p${t.i} (seq ${t.seq}) started before ${times[j - 1].c} p${times[j - 1].i} (seq ${times[j - 1].seq}) ended: the placements did not run one after another`] };
  }
  return { ...r, plan, planSha, inputs: list, setup: setup(plan, plan.workloads.find((x) => x.name === W)), runId, hostId, records, second, secondPads, results, sized: saved.sized ?? null, alike };
}

/** A comparison across placements in one measure: as recorded and with the labels swapped; no bound when incomplete. */
function reading(r, m) {
  const a = across(r.placements.map((p) => p.stats[m].median)), s = across(r.placements.map((p) => p.stats[m].swapped));
  if (!r.complete) for (const x of [a, s]) { x.bound = null; x.lower = null; }
  return { recorded: a, swapped: s };
}

/**
 * What an A/A sizes (docs/design.md#choice-placement-runs, "How many placements"): dir is the results of a
 * pilot, or of a gated run for its A/A. With K, the check at that K itself; without, the smallest
 * K the pads allow at which it passes. ok: the A/A is eligible and the check passes at K.
 */
export function sizing(dir, K) {
  const run = read(dir);
  if (run.refused) return { ok: false, refused: true, lines: ["sizing: these results are refused:", ...run.refused.map((x) => `  ${x}`)] };
  const c = run.comparisons[0], r = run.results[c];
  const out = { ok: false, lines: [], K: null, workload: run.workload, R: run.R, plan: run.planSha, inputs: run.inputs, setup: run.setup, model: run.hostId.model, run: run.runId, models: null, counts: null };
  const say = (l) => out.lines.push(l);
  say(`sizing from ${c} of run ${run.runId} (plan ${run.planSha}): ${r.placements.length} of ${run.K} placements read, R = ${run.R}`);
  if (run.dry) { say("a dry run sizes nothing"); return out; }
  const inOrder = [...r.placements].sort((x, y) => x.seq - y.seq);
  const el = eligibility({ complete: r.complete, medians: inOrder.map((p) => p.stats[GATE].median) });
  say(`eligible: ${el.eligible ? "yes" : "no"} (every placement read with all its pairs: ${r.complete ? "yes" : "no"}; lag-1 autocorrelation r1 ${p3(el.lag1.r1)}, p ${p3(el.lag1.p)}; Spearman's correlation with run order rho ${p3(el.spearman.rho)}, p ${p3(el.spearman.p)}; zero inside ${fmt(el.zero.low)} to ${fmt(el.zero.high)}, the ${ord(el.zero.ranks?.[0])} to the ${ord(el.zero.ranks?.[1])} sorted median: ${el.zero.inside ? "yes" : "no"})`);
  say(`placement medians: standard deviation ${width(el.sd)}; Shapiro-Wilk p ${p3(el.shapiroWilk.p)}, Anderson-Darling p ${p3(el.andersonDarling.p)}; models kept: ${el.models.join(" and ")}`);
  out.models = el.models;
  if (!el.eligible) { say("an A/A that is not eligible sizes nothing"); return out; }
  // In the order of the placements' indices, as size.mjs's readPilot gives them: the smoothed
  // resample draws by position, so the counts are those of the call the Choice names.
  const pilot = [...r.placements].sort((x, y) => x.i - y.i).map((p) => [p.stats[GATE].median, p.stats[GATE].swapped]);
  const count = (cs) => cs.map((m) => `${m.model} ${m.failing} (the ${ord(m.rank)})`).join(", ");
  if (K === undefined) {
    const s = sizeByRule(pilot, el.models, { from: K_MIN, to: K_MAX, each: (t) => process.stderr.write(`sizing: K = ${t.K}: ${count(t.counts)} failing draws of ${DRAWS}, against at most ${LIMIT}\n`) });
    if (s.K == null) { say(`no K from ${K_MIN} to ${K_MAX} has every kept model's count of failing draws at most ${LIMIT} of ${DRAWS}: the workload is not read across placements on this setup at this R`); return out; }
    say(`K = ${s.K}, the smallest from ${K_MIN} to ${K_MAX} at which every kept model's count of failing draws is at most ${LIMIT} of ${DRAWS} (seed ${SEED}): ${count(s.at)}; at the K's before it: ${s.tried.slice(-4, -1).map((t) => `${t.K}: ${count(t.counts)}`).join("; ") || "none"}`);
    return { ...out, ok: true, K: s.K, counts: s.at };
  }
  if (!Number.isInteger(K) || K < K_MIN || K > K_MAX) { say(`K = ${K} is not from ${K_MIN} to ${K_MAX}`); return out; }
  const counts = failing(pilot, el.models, K), ok = counts.every((m) => m.failing <= LIMIT);
  say(`K = ${K}: failing draws of ${DRAWS} (seed ${SEED}) against at most ${LIMIT}: ${count(counts)}: ${ok ? "passes" : "does not pass; the plan takes no K the models do not allow"}`);
  return { ...out, ok, K, counts };
}

const section = (s) => (s.archive ? `${s.archive}(${s.member})` : s.object);

export function report(dir) {
  const run = read(dir);
  if (run.refused) return { exit: 2, json: { exit: 2, refused: run.refused }, md: ["# Refused: these results are not read", "", ...run.refused.map((r) => `- ${r}`), ""].join("\n") };
  const { dry, part, workload: W, K, R, results, plan } = run, w = plan.workloads.find((x) => x.name === W);
  const out = [`# ${plan.name}: \`${W}\` across placements, ${part === "pilot" ? "the pilot" : "the gated run"}`, ""];
  if (dry) out.push("**DRY RUN: a test of the scripts, read for nothing. No figure below is a measurement of anything.**", "");
  out.push(`Run ${run.runId}, plan sha256 ${run.planSha}, inputs sha256 ${run.inputs.sha256} (the ${run.inputs.files} files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base ${run.base}${part === "gated" ? `, head ${run.head}` : ""}; CPU ${run.hostId.model ?? "?"}, kernel ${run.hostId.kernel ?? "?"}. K = ${K} placements, R = ${R} recorded pairs in each after one that is not, ${run.seconds} s turns of \`wrk -t${plan.load.threads} -c${plan.load.connections}\`, every turn on a freshly started binary, the order drawn from seed ${run.seed}. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the ${ord(run.rank)} smallest of the ${K} placement medians and the lower bound the ${ord(run.lowerRank)}. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.`, "");
  out.push(`The workload as the plan declares it: ${w.declared}`, "");
  if (run.shuffle) {
    const draw = `Inner layout: shuffled. Each placement i was linked with its pad first and then every .text function of its side's unpadded build in an order drawn from seed ${run.seed} and i (order.mjs); each index gets its own draw, and different indices can draw the same order. Binaries at the same index used the same draw for shared names, so the placements sample how a build lays its functions against each other as well as where its image lies. That order is partial: input sections the file gives one key lie in any order among themselves.`;
    const pairs = part === "gated" ? ` At each index the check compared only names (less a ThinLTO suffix) it could identify unambiguously on both sides and checked that they lie in the same order and share addresses with the same names. Names defined more than once or read otherwise by the symbol table or the map on either side were left out and counted (layout/head-p<n>-alike.txt). Of the names both sides have, compared and left out at each index: ${run.alike.map((x) => `${x.i}: ${x.compared} and ${x.leftOut} of ${x.shared}`).join("; ")}.` : "";
    out.push(`${draw}${pairs} Each placement is a link no app builds.`, "");
  }
  // A K nothing checked is said in every reading: no bare pass for a K nobody checked.
  const unchecked = run.sized ? "" : "; K not checked by the kit";
  if (part === "gated") out.push(dry ? `K = ${K} is the dry run's, not one the plan declares or the sizing check passed.` : run.sized ? `K = ${K} is ${run.declaredK === "pilot" ? "the smallest at which the sizing check passes" : `the plan's number (which it says was sized from: ${run.sizedFrom}), checked at that K itself`} from run ${run.sized.from}: ${run.sized.counts.map((m) => `${m.model} ${m.failing} failing draws of ${DRAWS}`).join(", ")}, against at most ${LIMIT}.` : `K = ${K} is the plan's number, which the plan says was sized from: ${run.sizedFrom}. **The kit did not check it**: plan.mjs was given no results to check it from (--sized-from), so whether this K meets the sizing rule is the author's to show, and each reading below says so.`, "");
  const json = { exit: 0, name: plan.name, run: run.runId, plan: run.planSha, inputs: run.inputs.sha256, part, workload: W, dry: Boolean(dry), K, sizedFrom: run.sizedFrom, sized: part === "gated" ? run.sized : undefined, R, seed: run.seed, ...(run.shuffle ? { shuffle: true, alike: run.alike } : {}), host: run.hostId, base: run.base, head: part === "gated" ? run.head : null, complete: {}, problems: {}, records: run.records, secondPads: [...run.secondPads.values()].map((x) => x.line) };
  for (const c of run.comparisons) {
    json.complete[c] = results[c].complete; json.problems[c] = results[c].why;
    if (!results[c].complete) out.push(`**${c} has no bound** (${results[c].placements.length} of ${K} placements read; none is rerun, replaced or dropped): ${results[c].why.join("; ")}.`, "");
  }
  const g = Object.fromEntries(run.comparisons.map((c) => [c, reading(results[c], GATE)]));
  if (part === "pilot") {
    const c = `pilot-${W}`, a = g[c].recorded, s = g[c].swapped;
    out.push("## The spread", "", `${results[c].placements.length} of ${K} placements read. Placement medians: median ${fmt(a.median)}, standard deviation ${width(a.sd)} (labels swapped ${width(s.sd)}), lowest ${fmt(a.min)}, highest ${fmt(a.max)}. A pilot is read only for this spread: its bounds (${fmt(a.bound)} as recorded, ${fmt(s.bound)} with the labels swapped) decide nothing.`, "");
    const z = sizing(dir);
    out.push("## Sizing", "", ...z.lines.map((l) => `- ${l}`), "");
    json.pilot = { median: a.median, sd: a.sd, sdSwapped: s.sd, min: a.min, max: a.max, sizing: { ok: z.ok, K: z.K, models: z.models, counts: z.counts } };
  } else {
    const aa = g[`aa-${W}`], ch = g[`change-${W}`].recorded;
    const res = resolution(aa.recorded, aa.swapped), gate = margin(ch, res);
    const recordsSpread = !run.shuffle && w.recordsSpread;
    const word = (gate === "meets +1%" ? "pass" : gate === "misses +1%" ? "miss" : gate.startsWith("not resolved") ? "not resolved" : "no bound") + unchecked;
    const reads = (t) => w.reads.includes(t), left = "not read by this run: it stays as one build read it, whatever this run reads";
    out.push("## Reading", "", "Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.", "",
      "| comparison | placements | median of medians | bound | lower bound | reading |", "| --- | ---: | ---: | ---: | ---: | --- |",
      `| aa-${W}, as recorded | ${results[`aa-${W}`].placements.length} of ${K} | ${fmt(aa.recorded.median)} | ${aa.recorded.bound == null ? "none" : pct(aa.recorded.bound)} | ${fmt(aa.recorded.lower)} | |`,
      `| aa-${W}, labels swapped | | ${fmt(aa.swapped.median)} | ${aa.swapped.bound == null ? "none" : pct(aa.swapped.bound)} | ${fmt(aa.swapped.lower)} | A/A: **${res}** |`,
      `| change-${W} | ${results[`change-${W}`].placements.length} of ${K} | ${fmt(ch.median)} | ${ch.bound == null ? "none" : pct(ch.bound)} | ${fmt(ch.lower)} | ${reads("margin") ? `**${gate}${unchecked}**` : "the margin is not read"} |`, "",
      `The A/A's lowest and highest placement median as recorded: ${fmt(aa.recorded.min)} to ${fmt(aa.recorded.max)} (standard deviation ${width(aa.recorded.sd)}); the change's: ${fmt(ch.min)} to ${fmt(ch.max)}.`, "",
      `- The margin, \`${W}\`: ${reads("margin") ? `**${word}** (${gate}).` : `${left}.`}`);
    json.gated = { resolution: res, reads: w.reads, margin: reads("margin") ? gate : "not read", reading: reads("margin") ? word : "not read", aaBound: aa.recorded.bound, aaBoundSwapped: aa.swapped.bound, aaLower: aa.recorded.lower, aaLowerSwapped: aa.swapped.lower, aaMin: aa.recorded.min, aaMax: aa.recorded.max, changeMedian: ch.median, changeBound: ch.bound, recordsSpread };
    if (w.reduction == null) out.push("- A CPU-cost win: the plan declares no reduction for this workload, so none is read.");
    else if (!reads("reduction")) { out.push(`- A CPU-cost win, a smallest worthwhile reduction of ${(100 * w.reduction).toFixed(2)}%: ${left}.`); json.gated.win = "not read"; }
    else {
      const benefit = win(ch, aa.recorded, aa.swapped, w.reduction) + unchecked;
      out.push(`- A CPU-cost win, a smallest worthwhile reduction of ${(100 * w.reduction).toFixed(2)}%: the change's bound ${fmt(ch.bound)} against ${pct(-w.reduction)}, the A/A's lower bound ${fmt(aa.recorded.lower)} as recorded and ${fmt(aa.swapped.lower)} with the labels swapped: **${benefit}**.`);
      json.gated.win = benefit;
    }
    const canRecord = res === "resolved";
    if (run.shuffle) out.push("- The spread: shuffled A/As cannot record or replace the policy placement spread, even if the plan declares one. Shuffled and unshuffled spreads have not been compared.", "");
    else out.push(recordsSpread
      ? `- The spread: the plan declares that this A/A records a placement spread for the workload. ${canRecord ? `It is complete and resolved, so it gives ${fmt(aa.recorded.min)} to ${fmt(aa.recorded.max)}, which is recorded only by a pull request that changes the Choice.` : "It is not a complete, resolved A/A, so it records none."}`
      : "- The spread: the plan declares that this A/A records no placement spread, so it records none whatever it read.", "");
  }
  for (const c of run.comparisons) {
    const r = results[c];
    out.push(`## ${c}: every measure`, "", "| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |", "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |");
    json[c] = { measures: {}, placements: r.placements.map((p) => ({ i: p.i, seq: p.seq, A: p.A, B: p.B, requests: p.requests, medians: Object.fromEntries(Object.entries(p.stats).map(([m, x]) => [m, { a: x.a, b: x.b, median: x.median, swapped: x.swapped, min: x.min, max: x.max }])) })) };
    for (const m of Object.keys(MEASURES)) {
      const { recorded: a, swapped: s } = reading(r, m);
      out.push(`| ${m} | ${fmt(a.median)} | ${fmt(a.bound)} | ${fmt(a.lower)} | ${fmt(a.min)} to ${fmt(a.max)} | ${fmt(s.median)} | ${fmt(s.bound)} | ${fmt(s.lower)} |`);
      json[c].measures[m] = { recorded: a, swapped: s };
    }
    out.push("", "| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |", "| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |");
    for (const p of [...r.placements].sort((x, y) => x.seq - y.seq)) {
      const t = p.stats[GATE];
      out.push(`| ${p.seq} | ${p.i} | ${p.A} | ${p.B} | ${t.a.toFixed(0)} | ${t.b.toFixed(0)} | ${pct(t.median)} | ${pct(t.min)} to ${pct(t.max)} | ${fmt(p.stats["cycles, user"].median)} | ${fmt(p.stats["cycles, kernel"].median)} | ${fmt(p.stats["instructions, user"].median)} | ${fmt(p.stats["L1 instruction-cache misses, user"].median)} |`);
    }
    out.push("");
  }
  out.push("## Code aligned beyond 16 bytes", "");
  for (const [side, rec] of Object.entries(run.records)) {
    out.push(`\`${side}\`: ${rec.inputs} input sections in \`.text\` (by alignment: ${Object.entries(rec.alignments).map(([a, n]) => `${a}: ${n}`).join(", ")}), ${rec.aligned.length} aligned beyond 16 bytes${rec.aligned.length ? `, the first after ${rec.sectionsBefore} sections; ${rec.list.length} symbols from it on` : ""}.`, "");
    if (!rec.aligned.length) continue;
    out.push("| section | alignment | archive(member) or object |", "| --- | ---: | --- |", ...rec.aligned.map((s) => `| \`${s.section}\` | ${s.align} | ${section(s)} |`), "");
    out.push(`The side's list, every symbol the map lists in \`.text\` from the first such section on:`, "", "| symbol | archive(member) or object |", "| --- | --- |", ...rec.list.map((s) => `| \`${s.symbol}\` | ${section(s)} |`), "");
  }
  if (run.second) out.push(`Every placement has a second pad, the smallest of 16, 32, 48 and 64 bytes whose map shows \`.data\` where the rule says, and passed the map check against its side's unpadded link:`, "", ...[...run.secondPads.values()].map((x) => `- ${x.line}`), "");
  else out.push(run.shuffle ? "Neither side has such a section: no second pad, and every placement passed the check that it holds its side's functions after its pad in the order of its ordering file." : "Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.", "");
  json.exit = Object.values(json.complete).every(Boolean) ? 0 : 1;
  return { exit: json.exit, json, md: out.join("\n") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !existsSync(args[0]) || !statSync(args[0]).isDirectory()) { console.error("usage: node report.mjs <results dir>"); process.exit(3); }
  let r;
  try { r = report(args[0]); } catch (e) { console.error(e.stack ?? String(e)); process.exit(3); }
  writeFileSync(join(args[0], "report.json"), JSON.stringify(r.json, null, 1) + "\n");
  console.log(r.md);
  process.exit(r.exit);
}
