// 1846w's validator and summary (wait.sh): how long a held value's forms took from its second
// read, base against head, with the checks, statistic and bounds results/margin.md declares.
// Usage: node summary-wait.mjs <results/wait> <rounds> <reps>
// Reads results/wait/<build>-<round>.tsv. Rows (tab-separated, wait.sh prefixes the round):
//   round build rep case held kept held_us job_us locked_us ins_start_us ins_us evicted outcome
//         att_us att_held w_in_us w_seen_us lockwait_us                       (18 fields)
//   round build rep enc - kept us bytes                                       (8 fields)
//   round build rep heldown held - us                                         (7 fields)
// Fails closed: the pass is usable only if every declared round and repetition of every case,
// size and reference row is there exactly once in both builds, every value parses as declared,
// and every sample meets its case's conditions (results/margin.md, "What a sample must show").
// The statistic is per process pair (round): d_r = median of the head's samples in round r less
// the median of the base's, and the one-sided 95% upper bound on the median of d_r is the d of
// rank upperRank(rounds) from the smallest. Pooled per-repetition figures are descriptive only.
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { median, upperRank } from "./stats.mjs";

export const DECLARED = { rounds: 40, reps: 21, helds: ["4021", "78967"], kept: "32768", small: "4021" };
const CASES = ["room", "refused", "contended"];
const FIELDS = { sample: 18, enc: 8, heldown: 7 };
const num = (s) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);
const ms = (us) => us / 1000;
const f2 = (x) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(2)) : "none");
const range = (xs) => (xs.length ? f2(Math.min(...xs)) + " to " + f2(Math.max(...xs)) : "-");

// The problems with one sample row, by build and case ([] when it is as declared).
function sampleProblems(build, c, f) {
  const p = [];
  const [, , , , held, kept, heldUs, job, locked, insStart, ins, evicted, outcome, att, attHeld, wIn, wSeen, lockwait] = f;
  const dash = (names, vals) => vals.forEach((v, i) => v !== "-" && p.push(names[i] + " is " + v + ", not -"));
  const pos = (name, v) => !(num(v) > 0) && p.push(name + " " + v + " is not a finite positive number");
  const fin = (name, v) => !Number.isFinite(num(v)) && p.push(name + " " + v + " is not a number");
  if (!DECLARED.helds.includes(held)) p.push("held " + held + " is not a declared size");
  if (kept !== (c === "idle" ? "-" : DECLARED.kept)) p.push("kept " + kept);
  pos("held_us", heldUs);
  const noJob = ["job_us", "locked_us", "outcome", "att_us", "att_held", "lockwait_us"];
  const noWriter = ["ins_start_us", "ins_us", "evicted", "w_in_us", "w_seen_us"];
  if (c !== "contended") dash(noWriter, [insStart, ins, evicted, wIn, wSeen]);
  else {
    fin("ins_start_us", insStart);
    pos("ins_us", ins);
    if (!(Number.isInteger(num(evicted)) && num(evicted) >= 1)) p.push("evicted " + evicted + ": the insertion dropped no page");
    fin("w_in_us", wIn);
  }
  if (build === "base" || c === "idle") {
    dash(noJob, [job, locked, outcome, att, attHeld, lockwait]);
    if (c === "contended") dash(["w_seen_us"], [wSeen]);
    return p;
  }
  // The head's kept job: it came to the lock and to the admission.
  pos("job_us", job);
  fin("locked_us", locked);
  if (!(num(locked) >= 0)) p.push("locked_us " + locked + ": the job did not come to the admission");
  fin("att_us", att);
  if (!(num(lockwait) >= 0)) p.push("lockwait_us " + lockwait + ": no request for the lock before the admission");
  const want = { room: ["admitted"], refused: ["refused"], contended: ["admitted", "refused"] }[c];
  if (!want.includes(outcome)) p.push("outcome " + outcome + ", not " + want.join(" or "));
  if (c !== "contended") {
    if (attHeld !== "0") p.push("att_held " + attHeld + ": the lock was held with no writer");
    return p;
  }
  // Contended: the job asked for the lock while the writer held it, and the writer then ran its
  // eviction under it before letting go.
  if (attHeld !== "1") p.push("att_held " + attHeld + ": the lock was free when the job asked for it");
  fin("w_seen_us", wSeen);
  if (!(num(wIn) < num(att))) p.push("w_in_us " + wIn + " is not before att_us " + att + ": the writer was not inside the lock first");
  if (!(num(wSeen) >= num(att))) p.push("w_seen_us " + wSeen + " is not at or after att_us " + att);
  if (!(num(lockwait) > 0)) p.push("lockwait_us " + lockwait + " is not positive");
  return p;
}

// texts: { "<build>-<round>.tsv": contents }. Returns { out, lines }.
export function summarize(texts, rounds, reps, declared = DECLARED) {
  const problems = [];
  const P = (s) => problems.push(s);
  const samples = {}; // case held -> build -> round -> rep -> held_us
  const rows = {}; // case held -> build -> [fields]
  const enc = { base: [], head: [] };
  const heldown = {}; // held -> build -> [us]
  const names = Object.keys(texts).sort();
  const want = [];
  for (let r = 1; r <= rounds; r++) for (const b of ["base", "head"]) want.push(b + "-" + r + ".tsv");
  for (const n of want) if (!(n in texts)) P(n + " is missing");
  for (const n of names) if (!want.includes(n)) P(n + " is not a declared round");
  for (const n of want.filter((n) => n in texts)) {
    const [, build, round] = n.match(/^(base|head)-(\d+)\.tsv$/);
    const seen = new Map();
    const lines = texts[n].split("\n");
    if (lines.at(-1) === "") lines.pop();
    lines.forEach((line, i) => {
      const f = line.split("\t");
      const at = n + " line " + (i + 1);
      if (f[0] !== round || f[1] !== build) return P(at + ": round " + f[0] + ", build " + f[1]);
      const rep = f[2];
      if (!/^\d+$/.test(rep) || Number(rep) >= reps) return P(at + ": repetition " + rep);
      const kind = f[3];
      const shape = kind === "enc" || kind === "heldown" ? kind : "sample";
      if (shape === "sample" && kind !== "idle" && !CASES.includes(kind)) return P(at + ": case " + kind);
      if (f.length !== FIELDS[shape]) return P(at + ": " + f.length + " fields, not " + FIELDS[shape]);
      const key = rep + " " + kind + " " + f[4] + " " + f[5];
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (shape === "enc") {
        if (f[4] !== "-" || f[5] !== declared.kept || !(num(f[6]) > 0) || !(num(f[7]) > 0)) return P(at + ": enc " + f.slice(4).join(" "));
        return enc[build].push(ms(num(f[6])));
      }
      if (shape === "heldown") {
        if (!declared.helds.includes(f[4]) || f[5] !== "-" || !(num(f[6]) > 0)) return P(at + ": heldown " + f.slice(4).join(" "));
        return ((heldown[f[4]] ??= {})[build] ??= []).push(ms(num(f[6])));
      }
      const bad = sampleProblems(build, kind, f);
      if (bad.length) return P(at + " (" + kind + " " + f[4] + "): " + bad.join("; "));
      const k = kind + " " + f[4];
      ((((samples[k] ??= {})[build] ??= {})[round] ??= {})[rep] = ms(num(f[6])));
      ((rows[k] ??= {})[build] ??= []).push(f);
    });
    for (let rep = 0; rep < reps; rep++) {
      const keys = [rep + " enc - " + declared.kept];
      for (const h of declared.helds) {
        keys.push(rep + " idle " + h + " -", rep + " heldown " + h + " -");
        for (const c of CASES) keys.push(rep + " " + c + " " + h + " " + declared.kept);
      }
      for (const k of keys) {
        const c = seen.get(k) ?? 0;
        if (c !== 1) P(n + ": " + (c ? c + " rows" : "no row") + " for repetition " + k);
        seen.delete(k);
      }
    }
    for (const [k, c] of seen) P(n + ": " + c + " undeclared row(s) " + k);
  }
  const out = { rounds, reps, declaredMatrix: rounds === declared.rounds && reps === declared.reps, boundRank: upperRank(rounds), cases: {}, gates: {}, problems };
  const lines = ["# 1846w pass 3: a held value's forms behind a kept page's brotli 5 job (ms)", ""];
  lines.push("Statistic: per round r, d_r = median of the head's " + reps + " samples less the median of the base's; one-sided 95% upper bound on the median of the " + rounds + " d_r = the d of rank " + out.boundRank + " from the smallest (sign test, rounds independent). Pooled columns are descriptive.", "");
  lines.push("| case | held B | rounds | base median (range) | head median (range) | median d_r | bound (rank) | d_r range | pooled median per-repetition head - base | head job median | head lock wait median (range) | outcomes |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |");
  for (const k of Object.keys(samples).sort()) {
    const s = samples[k];
    const d = [], pooled = [], all = { base: [], head: [] };
    for (let r = 1; r <= rounds; r++) {
      const x = s.base?.[r], y = s.head?.[r];
      for (const [b, v] of [["base", x], ["head", y]]) if (v) all[b].push(...Object.values(v));
      if (!x || !y) continue;
      const xs = Object.values(x), ys = Object.values(y);
      if (!xs.length || !ys.length) continue;
      d.push(median(ys) - median(xs));
      for (const rep of Object.keys(x)) if (rep in y) pooled.push(y[rep] - x[rep]);
    }
    d.sort((p, q) => p - q);
    const kk = upperRank(d.length);
    const head = rows[k]?.head ?? [], base = rows[k]?.base ?? [];
    const outcomes = {};
    for (const f of head) outcomes[f[12]] = (outcomes[f[12]] ?? 0) + 1;
    const job = head.map((f) => num(f[7])).filter((x) => x > 0).map(ms);
    const wait = head.map((f) => num(f[17])).filter(Number.isFinite).map(ms);
    const ins = base.map((f) => num(f[10])).filter((x) => x > 0).map(ms);
    const m = { rounds: d.length, boundRank: kk, base: median(all.base), head: median(all.head), change: d.length ? median(d) : NaN, bound: kk >= 1 && kk <= d.length ? d[kk - 1] : NaN, dMin: d[0], dMax: d.at(-1), pooledChange: pooled.length ? median(pooled) : NaN, job: job.length ? median(job) : null, lockWait: wait.length ? median(wait) : null, outcomes, baseInsertion: ins.length ? median(ins) : null };
    out.cases[k] = m;
    const [c, held] = k.split(" ");
    const o = Object.entries(outcomes).map(([n, x]) => n + " " + x).join(", ") || "-";
    lines.push("| " + c + " | " + held + " | " + d.length + " | " + f2(m.base) + " (" + range(all.base) + ") | " + f2(m.head) + " (" + range(all.head) + ") | " + f2(m.change) + " | " + f2(m.bound) + " (" + kk + ") | " + (d.length ? f2(m.dMin) + " to " + f2(m.dMax) : "-") + " | " + f2(m.pooledChange) + " | " + (job.length ? f2(m.job) : "-") + " | " + (wait.length ? f2(m.lockWait) + " (" + range(wait) + ")" : "-") + " | " + o + " |");
  }
  lines.push("");
  lines.push("enc " + declared.kept + " B: base " + f2(median(enc.base.length ? enc.base : [NaN])) + " ms, head " + f2(median(enc.head.length ? enc.head : [NaN])) + " ms (" + enc.base.length + " and " + enc.head.length + ")");
  for (const h of declared.helds) {
    const v = heldown[h] ?? {};
    lines.push("heldown " + h + " B: base " + f2(median(v.base ?? [NaN])) + " ms (" + range(v.base ?? []) + "), head " + f2(median(v.head ?? [NaN])) + " ms (" + range(v.head ?? []) + ")");
  }
  for (const c of CASES) {
    const ins = out.cases[c + " " + declared.small]?.baseInsertion;
    if (c === "contended") lines.push("I, the base's median contended 4 MiB insertion call (Store::keep) with the " + declared.small + "-byte value: " + f2(ins ?? NaN) + " ms");
  }
  const H = median(heldown[declared.small]?.base ?? [NaN]);
  out.H = H;
  lines.push("H, the base's median of the " + declared.small + "-byte value's own forms (brotli 9 and gzip 9): " + f2(H) + " ms", "");
  const at = (c) => out.cases[c + " " + declared.small];
  const idle = at("idle"), room = at("room"), refused = at("refused"), contended = at("contended");
  const check = (name, ok, say) => { out.gates[name] = { ok, say }; lines.push((ok ? "met" : "NOT met") + ": " + name + ": " + say); };
  if (!out.declaredMatrix) P("the matrix is " + rounds + " rounds of " + reps + ", not the declared " + declared.rounds + " of " + declared.reps + " (not a result)");
  if (!idle || !room || !refused || !contended) P("a declared case is missing");
  else {
    const I = contended.baseInsertion;
    out.I = I;
    if (!(idle.bound < 0.5)) P("the idle control's bound is " + f2(idle.bound) + " ms, not under +0.5 ms");
    check("room", room.bound < H, "bound " + f2(room.bound) + " ms under H " + f2(H) + " ms");
    check("refused", refused.bound < H, "bound " + f2(refused.bound) + " ms under H " + f2(H) + " ms");
    check("contended", contended.bound < H + I, "bound " + f2(contended.bound) + " ms under H + I = " + f2(H) + " + " + f2(I) + " ms");
  }
  out.usable = problems.length === 0;
  out.met = out.usable && Object.keys(out.gates).length === 3 && Object.values(out.gates).every((g) => g.ok);
  const shown = problems.slice(0, 20);
  lines.push("usable: " + out.usable + (problems.length ? " (" + problems.length + " problems" + (problems.length > shown.length ? ", the first " + shown.length : "") + ": " + shown.join("; ") + ")" : ""));
  lines.push("pass 3 gate: " + (out.met ? "met" : "NOT met"));
  return { out, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, rounds, reps] = process.argv.slice(2);
  if (!dir || !/^\d+$/.test(rounds ?? "") || !/^\d+$/.test(reps ?? "")) {
    console.error("usage: node summary-wait.mjs <results/wait> <rounds> <reps>");
    process.exit(2);
  }
  const texts = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".tsv"))) texts[f] = readFileSync(dir + "/" + f, "utf8");
  const { out, lines } = summarize(texts, Number(rounds), Number(reps));
  console.log(lines.join("\n"));
  console.log("JSON " + JSON.stringify(out));
}
