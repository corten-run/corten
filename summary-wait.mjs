// Summary of 1846r2's pass 3 (wait.sh): how long a held value's forms took from its second read,
// base against head, paired by round and repetition, with the bounds results/margin.md declares.
// Usage: node summary-wait.mjs <results/wait>
// Rows (tab-separated): round, build, case, held, kept, held_us, job_us, locked_us, ins_start_us,
// ins_us, evicted, outcome; and round, build, enc, -, kept, us, bytes / round, build, heldown, held,
// -, us. A pair is the same case, held and kept size, round and repetition in the two builds.
import { readFileSync, readdirSync } from "node:fs";
import { median, upperRank } from "./stats.mjs";

const dir = process.argv[2];
const rows = [];
for (const f of readdirSync(dir).filter((f) => /^(base|head)-\d+\.tsv$/.test(f)).sort()) {
  for (const line of readFileSync(dir + "/" + f, "utf8").split("\n")) if (line) rows.push(line.split("\t"));
}
const ms = (us) => Number(us) / 1000;
const f2 = (x) => (Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(2));
const range = (xs) => `${f2(Math.min(...xs))} to ${f2(Math.max(...xs))}`;
const samples = {}; // key -> build -> round -> [rows]
const other = { enc: {}, heldown: {} };
for (const r of rows) {
  const [round, build, kind] = r;
  if (kind === "enc" || kind === "heldown") {
    const key = kind === "enc" ? r[4] : r[3];
    ((other[kind][key] ??= {})[build] ??= []).push(ms(r[5]));
    continue;
  }
  const key = `${kind}\t${r[3]}\t${r[4]}`;
  (((samples[key] ??= {})[build] ??= {})[round] ??= []).push(r);
}
const out = { pairs: {}, gates: {}, usable: true, problems: [] };
const lines = ["# 1846r2 pass 3: a held value's forms behind a kept page's brotli 5 job (ms)", ""];
lines.push("| case | held B | kept B | pairs | base median (range) | head median (range) | median head - base | one-sided 95% bound | head job median (range) | outcomes |");
lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
for (const key of Object.keys(samples).sort()) {
  const [kind, held, kept] = key.split("\t");
  const s = samples[key];
  const d = [], a = [], b = [], job = [], outcomes = {}, ins = [];
  for (const round of Object.keys(s.base ?? {})) {
    const x = s.base[round], y = s.head?.[round] ?? [];
    if (x.length !== y.length) { out.usable = false; out.problems.push(`${key} round ${round}: ${x.length} base, ${y.length} head`); continue; }
    x.forEach((xb, i) => {
      const yh = y[i];
      a.push(ms(xb[5])); b.push(ms(yh[5])); d.push(ms(yh[5]) - ms(xb[5]));
      if (Number(yh[6]) >= 0) job.push(ms(yh[6]));
      outcomes[yh[11]] = (outcomes[yh[11]] ?? 0) + 1;
      if (Number(xb[9]) >= 0) ins.push(ms(xb[9]));
    });
  }
  if (!d.length) continue;
  d.sort((p, q) => p - q);
  const k = upperRank(d.length);
  const m = { pairs: d.length, base: median(a), head: median(b), change: median(d), bound: d[k - 1], boundRank: k, min: d[0], max: d[d.length - 1], job: job.length ? median(job) : null, outcomes, baseInsertion: ins.length ? median(ins) : null };
  out.pairs[key.replaceAll("\t", " ")] = m;
  const o = Object.entries(outcomes).map(([n, c]) => `${n} ${c}`).join(", ");
  lines.push(`| ${kind} | ${held} | ${kept} | ${d.length} | ${f2(m.base)} (${range(a)}) | ${f2(m.head)} (${range(b)}) | ${f2(m.change)} | ${f2(m.bound)} (rank ${k}) | ${job.length ? f2(m.job) + " (" + range(job) + ")" : "-"} | ${o} |`);
}
lines.push("");
for (const [kind, by] of Object.entries(other)) for (const [size, v] of Object.entries(by)) {
  lines.push(`${kind} ${size} B: base ${f2(median(v.base ?? [NaN]))} ms (${range(v.base ?? [NaN])}), head ${f2(median(v.head ?? [NaN]))} ms (${range(v.head ?? [NaN])}), ${(v.base ?? []).length} and ${(v.head ?? []).length}`);
}
// The declared checks and bounds (results/margin.md, pass 3).
const small = Object.keys(other.heldown).map(Number).sort((p, q) => p - q)[0];
const H = median(other.heldown[small]?.base ?? [NaN]);
const at = (kind) => Object.entries(out.pairs).find(([k]) => k.startsWith(kind + " " + small + " 32768"))?.[1];
const idle = Object.entries(out.pairs).find(([k]) => k.startsWith("idle " + small + " "))?.[1];
const room = at("room"), refused = at("refused"), contended = at("contended");
const check = (name, ok, say) => { out.gates[name] = { ok, say }; lines.push(`${ok ? "met" : "NOT met"}: ${name}: ${say}`); };
lines.push("", `H, the base's median of a ${small}-byte held value's own forms (brotli 9 and gzip 9) on this host: ${f2(H)} ms`);
if (!idle || !room || !refused || !contended) { out.usable = false; out.problems.push("a declared case is missing"); }
else {
  if (room.outcomes.admitted !== room.pairs) { out.usable = false; out.problems.push("a room job did not put its bytes in"); }
  if (refused.outcomes.refused !== refused.pairs) { out.usable = false; out.problems.push("a refused job was not refused"); }
  if (!(idle.bound < 0.5)) { out.usable = false; out.problems.push(`the idle control's bound is ${f2(idle.bound)} ms, not under +0.5 ms`); }
  check("room", room.bound < H, `bound ${f2(room.bound)} ms under H ${f2(H)} ms`);
  check("refused", refused.bound < H, `bound ${f2(refused.bound)} ms under H ${f2(H)} ms`);
  const I = contended.baseInsertion;
  check("contended", contended.bound < H + I, `bound ${f2(contended.bound)} ms under H + I = ${f2(H)} + ${f2(I)} ms (I, the base's median 4 MiB insertion's store.keep call)`);
}
lines.push(`usable: ${out.usable}${out.problems.length ? " (" + out.problems.join("; ") + ")" : ""}`);
lines.push(`pass 3 gate: ${out.usable && Object.values(out.gates).every((g) => g.ok) ? "met" : "NOT met"}`);
console.log(lines.join("\n"));
console.log("JSON " + JSON.stringify(out));
