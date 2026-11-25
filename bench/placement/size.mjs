// size.mjs: how many placements an A/A needs, from a pilot A/A's placement medians
// (corten-run/corten#1999, items 1 and 4). A pilot reads only the spread of its placement medians,
// never a change's comparison, and its turns are not part of a run it sizes.
//
//   node size.mjs <results dir>/<comparison> [--target 5] [--K 30,60,100] [--draws 200000]
//       a pilot A/A as a placement run writes it (p01/, p02/, ... each with counts-<w>.csv or
//       cycles-<w>.csv: pair,version,requests,cycles_u,cycles_k,...; A = the "base" rows). Prints
//       the placement medians' spread; the failure rate of the two-reading A/A (its bound, the
//       j-th smallest placement median, at or over +1% as recorded or with the labels swapped) at
//       each K under (a) the normal model (normal medians, common median zero, the pilot's sd) and
//       (b) resampling the pilot's own placements (each reading centred on its median, scaled by
//       sqrt(n / (n - 1))); the smallest K at or under the target rate under each; and what the
//       pairs alone give a median of R ("from within", model.mjs's fromWithin): the normal formula
//       beside pooled residuals (low), leave-one-out residuals (high) and those rescaled, the
//       figure this kit reads.
//   node size.mjs --sd 1.97 [--K ...]     the normal model alone at a standard deviation (percent)
//   node size.mjs --reproduce             the figures corten-run/corten#1999 and docs/design.md#choice-placement-runs
//                                         quote, from the saved medians in prior/ (tags
//                                         evidence/ee7b0b41 and evidence/0c0c599c); exits 1 if one
//                                         is outside simulation error
//   node size.mjs --selftest              the from-within figures against the truth on made-up
//                                         placements of normal, t3 and Laplace pairs
// Rates are seeded draws (seed 1983, as analysis/resolve-sim.mjs, whose normal draws this repeats
// exactly), so a figure is the same every time.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { failRateNormal, failRateResample, failRateSmoothed, fromWithin, gauss, kNeeded, mean, median, rng, sd } from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/** Prints each argument on its own line. */
const say = (...lines) => console.log(lines.join("\n"));
const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? "-" : (100 * x).toFixed(d) + "%");

/**
 * A pilot's placements: [{ name, changes: [B / A - 1 per pair], swapped: [A / B - 1 per pair] }].
 * A placement whose placement.txt has a "started" line but no "ended" line (this kit's runs write
 * both; a placement stopped part way has only the first) is left out, and named in out.skipped;
 * earlier kits' placement.txt has neither line and is read as before.
 */
export function readPilot(dir) {
  const out = [];
  out.skipped = [];
  for (const p of readdirSync(dir).filter((d) => /^p\d+$/.test(d)).sort()) {
    const rec = join(dir, p, "placement.txt");
    if (existsSync(rec)) {
      const t = readFileSync(rec, "utf8");
      if (/^started /m.test(t) && !/^ended /m.test(t)) { out.skipped.push(p); continue; }
    }
    const f = readdirSync(join(dir, p)).find((x) => /^(counts|cycles)-[a-z]+\.csv$/.test(x));
    if (!f) throw new Error(`${dir}/${p}: no counts CSV`);
    const [header, ...lines] = readFileSync(join(dir, p, f), "utf8").trim().split(/\r?\n/);
    const names = header.split(",");
    const col = (n) => { const i = names.indexOf(n); if (i < 0) throw new Error(`${f}: no ${n}`); return i; };
    const [ip, iv, ir, iu, ik] = ["pair", "version", "requests", "cycles_u", "cycles_k"].map(col);
    const per = new Map();
    for (const l of lines) {
      const v = l.split(",");
      const e = per.get(v[ip]) ?? {};
      if (e[v[iv]] != null) throw new Error(`${dir}/${p}: pair ${v[ip]} ${v[iv]} twice`);
      e[v[iv]] = (Number(v[iu]) + Number(v[ik])) / Number(v[ir]);
      per.set(v[ip], e);
    }
    const pairs = [...per.values()];
    if (pairs.some((e) => !(e.base > 0 && e.head > 0))) throw new Error(`${dir}/${p}: a pair without both rows`);
    out.push({ name: p, changes: pairs.map((e) => e.head / e.base - 1), swapped: pairs.map((e) => e.base / e.head - 1) });
  }
  if (!out.length) throw new Error(`${dir}: no placements`);
  return out;
}

const Ks = (s) => s.split(",").map(Number).filter((k) => Number.isInteger(k) && k >= 5);

export function sizePilot(placements, { target = 0.05, K = [30, 60, 100], draws = 200000, seed = 1983 } = {}) {
  const rec = placements.map((p) => median(p.changes)), swp = placements.map((p) => median(p.swapped));
  const s = sd(rec);
  const pilot = rec.map((x, i) => [x, swp[i]]);
  const rows = K.map((k) => ({ K: k, normal: failRateNormal(k, s, draws, seed), resample: failRateResample(pilot, k, draws, seed), smoothed: failRateSmoothed(pilot, k, draws, seed) }));
  const needNormal = kNeeded((k, d) => failRateNormal(k, s, d, seed), target);
  const needResample = kNeeded((k, d) => failRateResample(pilot, k, d, seed), target);
  const needSmoothed = kNeeded((k, d) => failRateSmoothed(pilot, k, d, seed), target);
  const R = placements[0].changes.length;
  const within = placements.every((p) => p.changes.length === R) ? fromWithin(placements.map((p) => p.changes)) : null;
  return { n: rec.length, R, sd: s, sdSwapped: sd(swp), median: median(rec), rows, needNormal, needResample, needSmoothed, within, target };
}

const need = (x) => (x ? `${x.K} (${pct(x.rate, 1)})` : "over 400");
export function printPilot(name, r) {
  const lines = [
    `${name}: ${r.n} placements of ${r.R} pairs; placement medians (user+kernel cycles a request, B / A - 1): median ${pct(r.median)}, sd ${pct(r.sd)} (labels swapped ${pct(r.sdSwapped)})`,
    `  failure rate of the two-reading A/A at +1% (${r.rows[0]?.normal.draws ?? 0} seeded draws each):`,
    `  | K | rank | (a) normal model, sd ${pct(r.sd)} | (b) resampling the ${r.n} placements, smoothed | resampling them as they are |`,
    "  | ---: | ---: | ---: | ---: | ---: |",
    ...r.rows.map((x) => `  | ${x.K} | ${x.normal.rank} | ${pct(x.normal.rate, 1)} | ${pct(x.smoothed.rate, 1)} | ${pct(x.resample.rate, 1)} |`),
    `  K for at most ${pct(r.target, 0)}: (a) normal model ${need(r.needNormal)}; (b) resampling, smoothed ${need(r.needSmoothed)}; resampling as they are ${need(r.needResample)}`,
    `  (b) is read: resampling ${r.n} medians as they are reads the gaps between them near the centre, where the bound sits, as the shape of the population, and with lumpy pilots it fails at any K (a gap of over 1% beside the centre is never closed by more draws); the smoothed draws add normal noise of Silverman's bandwidth (${pct(r.rows[0]?.smoothed.bandwidth)}) and keep the pilot's spread.`,
  ];
  if (r.within) {
    const w = r.within, part = Math.sqrt(Math.max(0, r.sd ** 2 - w.corrected ** 2));
    lines.push(
      `  what ${w.R} pairs alone give a placement median ("from within"): ${pct(w.corrected)} (leave-one-out residuals rescaled; this kit's figure), between ${pct(w.pooled)} (pooled residuals about each placement's median, runs low) and ${pct(w.loo)} (leave-one-out, runs high); the normal formula gives ${pct(w.normal)}`,
      `  so the placements' own part of the medians' sd is about ${pct(part)} (sqrt(sd^2 - from within^2))`,
    );
  }
  return lines.join("\n");
}

function reproduce() {
  const runs = [
    { id: "0c0c599c", c: "aa-old", issue: 1.97 },
    { id: "0c0c599c", c: "aa-young", issue: 1.17 },
    { id: "ee7b0b41", c: "aa-kept", issue: 1.44 },
    { id: "ee7b0b41", c: "aa-plain", issue: 1.48 },
  ];
  const sds = {};
  say("Placement medians' sd from the saved counts (prior/<tag>/<comparison>), against the issue's:");
  for (const r of runs) {
    const pl = readPilot(join(here, "prior", r.id, r.c));
    const s = sd(pl.map((p) => median(p.changes)));
    sds[r.c] = s;
    say(`  ${r.c} (evidence/${r.id}): ${pl.length} placements, sd ${pct(s, 3)} -> ${(100 * s).toFixed(2)}%, issue ${r.issue.toFixed(2)}%: ${(100 * s).toFixed(2) === r.issue.toFixed(2) ? "same" : "DIFFERENT"}`);
    if ((100 * s).toFixed(2) !== r.issue.toFixed(2)) process.exitCode = 1;
  }
  const rows = [
    { what: "`old`, K = 30", c: "aa-old", K: 30, issue: 0.555 },
    { what: "`young`, K = 30", c: "aa-young", K: 30, issue: 0.046 },
    { what: "`kept` (first run), K = 30", c: "aa-kept", K: 30, issue: 0.181 },
    { what: "`plain` (first run), K = 30", c: "aa-plain", K: 30, issue: 0.208 },
    { what: "`old`, K = 60", c: "aa-old", K: 60, issue: 0.154 },
    { what: "`old`, K = 100", c: "aa-old", K: 100, issue: 0.02 },
  ];
  const N = 200000;
  say("", `Normal model, ${N} draws, a different seed (1999) from the issue's (1983), at the sd rounded to two decimals as the issue rounds it. Within simulation error: |size.mjs - issue| <= 3 x sqrt(2 p (1 - p) / ${N}) + 0.05 points (the issue's rounding to 0.1%):`, "");
  say("| A/A | sd | issue | size.mjs | difference | allowed | within |", "| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const r of rows) {
    const s = Number((100 * sds[r.c]).toFixed(2)) / 100;
    const got = failRateNormal(r.K, s, N, 1999).rate;
    const allowed = 3 * Math.sqrt((2 * r.issue * (1 - r.issue)) / N) + 0.0005;
    const ok = Math.abs(got - r.issue) <= allowed;
    if (!ok) process.exitCode = 1;
    say(`| ${r.what} | ${pct(s)} | ${pct(r.issue, 1)} | ${pct(got, 2)} | ${(100 * (got - r.issue)).toFixed(2)} points | ${(100 * allowed).toFixed(2)} points | ${ok ? "yes" : "NO"} |`);
  }
  say("", "With the issue's seed (1983) the normal draws are resolve-sim.mjs's own:", "");
  for (const r of rows) {
    const s = Number((100 * sds[r.c]).toFixed(2)) / 100;
    say(`  ${r.what}: ${pct(failRateNormal(r.K, s, N, 1983).rate, 1)} (issue ${pct(r.issue, 1)})`);
  }
  say("", "Each earlier A/A as a pilot (target 5%):", "");
  for (const r of runs) say(printPilot(`evidence/${r.id} ${r.c}`, sizePilot(readPilot(join(here, "prior", r.id, r.c)))), "");
  say("analysis/output.txt (evidence/c448780e) for the same `old` and `young` A/As: a median of 8 by the normal formula about the median 1.71% and 1.78%, from pooled residuals 1.23% and 1.12%; placement.mjs's normal formula (pairs about their mean) 1.80% and 1.86%.");
}

function selftest() {
  const u = rng(42);
  const t3 = () => gauss(u) / Math.sqrt((gauss(u) ** 2 + gauss(u) ** 2 + gauss(u) ** 2) / 3);
  const lap = () => { const v = u() - 0.5; return -Math.sign(v) * Math.log(1 - 2 * Math.abs(v)); };
  say("From-within figures over the truth (the sd of a median of 8 drawn from the pair distribution itself), 10 made-up pilots of K placements of 8 pairs with no placement part each:");
  for (const [name, f] of [["normal", () => gauss(u)], ["t3", t3], ["Laplace", lap]]) {
    const meds = [];
    for (let n = 0; n < 100000; n++) { const s = []; for (let i = 0; i < 8; i++) s.push(f()); meds.push(median(s)); }
    const truth = sd(meds);
    for (const K of [30, 100]) {
      const got = [];
      for (let rep = 0; rep < 10; rep++) {
        const pl = []; for (let k = 0; k < K; k++) { const s = []; for (let i = 0; i < 8; i++) s.push(f()); pl.push(s); }
        got.push(fromWithin(pl, 20000, rep + 1));
      }
      const r = (k) => (mean(got.map((g) => g[k])) / truth).toFixed(3);
      say(`  ${name}, K = ${K}: normal formula ${r("normal")}, pooled ${r("pooled")}, leave-one-out ${r("loo")}, rescaled ${r("corrected")}`);
    }
  }
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (main) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const target = Number(opt("--target", "5")) / 100, K = Ks(opt("--K", "30,60,100")), draws = Number(opt("--draws", "200000"));
  if (args.includes("--reproduce")) reproduce();
  else if (args.includes("--selftest")) selftest();
  else if (args.includes("--sd")) {
    const s = Number(opt("--sd")) / 100;
    for (const k of K) console.log(`K ${k}: normal model at sd ${pct(s)}: ${pct(failRateNormal(k, s, draws).rate, 1)} fail one of the two readings`);
    const need = kNeeded((k, d) => failRateNormal(k, s, d), target);
    console.log(`K for at most ${pct(target, 0)}: ${need ? `${need.K} (${pct(need.rate, 1)})` : "over 400"}`);
  } else if (args[0] && existsSync(args[0])) {
    const pl = readPilot(args[0]);
    if (pl.skipped.length) console.log(`(left out, not finished: ${pl.skipped.join(", ")})`);
    console.log(printPilot(args[0], sizePilot(pl, { target, K, draws })));
  }
  else { console.error("usage: node size.mjs <results dir>/<comparison> | --sd <percent> | --reproduce | --selftest  [--target 5] [--K 30,60,100] [--draws 200000]"); process.exit(2); }
}