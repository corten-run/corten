// A round split across droplets started together (droplet.mjs --droplets <n>): which apps each
// droplet runs, and how summarize.mjs merges their results into one round. Each droplet runs a full
// round of its share of the apps and of the anchors besides: Corten, the reference, and axum-maud,
// the bare stack Corten is built on. So each app is reported beside a ratio to Corten on its own
// droplet, and the anchors' numbers on each droplet show how far the droplets differed. Droplets of
// one size are not all the same CPU (README, Method 1). split.test.mjs tests this on round folders
// it writes itself.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withinNoise } from "./passes.mjs";
import { phases } from "./ssr.mjs";

/** The apps every droplet of a split round runs: Corten first, the reference of every comparison. */
export const anchors = ["corten", "axum-maud"];

/** The file in results/<round>/ naming a split round's droplets and their apps; droplet.mjs writes it at launch. */
export const PLAN = "droplets.json";

/**
 * How far apart two one-pass numbers may be and still count as within noise. This is caveat 1 of
 * the README (#811): "in a one-pass round differences under about 10% are noise". With two or more
 * passes on both sides, two numbers are within noise when their ranges overlap (passes.mjs), the
 * test behind summarize.mjs's ~.
 */
export const onePassNoise = 0.1;

/**
 * The numbers compared across droplets and with Corten: the ones summarize.mjs's ~ marks (ssr.mjs).
 * Every phase has requests per CPU-second; the saturation phases also have their rate, since the
 * fixed rate holds every app to the same one.
 * @param {string} phase
 */
export const keysOf = (phase) => (phase === "fixed" ? ["perCpuSecond"] : ["rps", "perCpuSecond"]);

/** The round droplet `k` (from 1) of a split round runs. @param {string} round @param {number} k */
export const partName = (round, k) => `${round}-d${k}`;

/** Whether a round's name is a droplet's of a split round (`<round>-d<k>`). @param {string} round */
export const isPart = (round) => /-d\d+$/.test(round);

/**
 * Each droplet's apps: the anchors plus a share of the rest. The other apps are dealt in catalog
 * order, one to each droplet in turn, and each list keeps catalog order. With one droplet the list
 * is every app, as a round has always run.
 * @param {string[]} names the round's apps, in catalog order
 * @param {number} count droplets
 * @returns {string[][]}
 */
export function split(names, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`--droplets is a count of droplets (2 or more), not ${count}`);
  if (count === 1) return [[...names]];
  for (const anchor of anchors) if (!names.includes(anchor)) throw new Error(`a round on ${count} droplets runs ${anchor} on each, so its apps must include ${anchor}`);
  const rest = names.filter((n) => !anchors.includes(n));
  if (rest.length < count) throw new Error(`${count} droplets need at least ${count} apps besides ${anchors.join(" and ")}, one each; this round has ${rest.length}`);
  return Array.from({ length: count }, (_, k) => names.filter((n) => anchors.includes(n) || rest.indexOf(n) % count === k));
}

/**
 * A split round's plan, as droplet.mjs writes it to results/<round>/droplets.json.
 * @param {string} round @param {string} tier @param {number} passes @param {string[][]} shares split()'s
 */
export const planOf = (round, tier, passes, shares) => ({
  round,
  tier,
  passes,
  anchors,
  droplets: shares.map((apps, i) => ({ round: partName(round, i + 1), apps })),
});

/** @typedef {ReturnType<typeof planOf>} Plan */

/** A round's plan, or null for a round of one droplet. @param {string} dir results/<round> @returns {Plan | null} */
export const readPlan = (dir) => (existsSync(join(dir, PLAN)) ? JSON.parse(readFileSync(join(dir, PLAN), "utf8")) : null);

/**
 * Whether a droplet's round has finished and been collected here: it has its summary, and its log
 * has the line a finished round ends with ("all done", which droplet.mjs waits for).
 * @param {string} dir results/<round>
 */
export const finished = (dir) => existsSync(join(dir, "summary.json")) && existsSync(join(dir, "run.log")) && /all done/.test(readFileSync(join(dir, "run.log"), "utf8"));

/** The CPU model in a droplet's host.txt (lscpu's "Model name"), or null. @param {string} text */
export const cpuOf = (text) => /^Model name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;

/**
 * The app a summary table's key is for: build, cold start and bytes are keyed by app, instructions
 * by `<app>/<page|json>` and browser timing by `<profile>/<app>`.
 * @param {string} table @param {string} key
 */
const appOf = (table, key) => (table === "instructions" ? key.split("/")[0] : table === "browser" ? key.split("/").slice(1).join("/") : key);

/** The summary tables keyed by app (appOf), merged by taking each app from its droplet. */
const tables = ["build", "dockerRebuild", "rustAnalyzer", "coldStart", "bytes", "instructions", "browser"];

/**
 * An app's numbers as a ratio to Corten's on the same droplet, phase by phase (keysOf), or null when
 * neither has a phase both measured.
 * @param {Record<string, any>} entry @param {Record<string, any> | undefined} corten
 */
export function toCorten(entry, corten) {
  /** @type {Record<string, Record<string, number | null>>} */
  const out = {};
  for (const phase of phases) {
    const mine = entry[phase], theirs = corten?.[phase];
    if (!mine || !theirs) continue;
    out[phase] = Object.fromEntries(keysOf(phase).map((key) => [key, mine[key] > 0 && theirs[key] > 0 ? +(mine[key] / theirs[key]).toFixed(2) : null]));
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Whether two droplets' numbers for one phase differ by more than the noise: their passes' ranges do
 * not overlap where both ran two or more, or else they are more than onePassNoise apart.
 * @param {Record<string, any>} a @param {Record<string, any>} b one phase of an entry each @param {string} key
 */
export function apart(a, b, key) {
  const range = (/** @type {Record<string, any>} */ e) => (e.range?.[key] ? { min: e.range[key][0], max: e.range[key][1] } : null);
  const near = withinNoise(range(a), a.passes ?? 1, range(b), b.passes ?? 1);
  if (near !== null) return !near;
  return Math.max(a[key], b[key]) / Math.min(a[key], b[key]) - 1 > onePassNoise;
}

/**
 * The anchors' numbers on every droplet, with their spread and the droplets that differ from all
 * the others by more than the noise. A droplet is flagged on a number only when it is apart from
 * every other droplet that measured it. With two droplets that differ, both are flagged, since
 * nothing says which one is off.
 * @param {{ round: string, summary: any }[]} parts
 * @param {string[]} anchorNames
 */
export function betweenDroplets(parts, anchorNames = anchors) {
  /** @type {Record<string, Record<string, Record<string, Record<string, any>>>>} */
  const out = {};
  /** @type {{ droplet: string, source: string, app: string, phase: string, key: string }[]} */
  const flagged = [];
  const sources = [...new Set(parts.flatMap((p) => Object.keys(p.summary.ssr ?? {})))];
  for (const source of sources) {
    for (const app of anchorNames) {
      for (const phase of phases) {
        for (const key of keysOf(phase)) {
          const each = parts.map((p) => ({ droplet: p.round, e: p.summary.ssr?.[source]?.[app]?.[phase] })).filter((x) => x.e && x.e[key] > 0);
          if (each.length < 2) continue;
          const values = each.map((x) => x.e[key]).sort((a, b) => a - b);
          const median = values[Math.floor((values.length - 1) / 2)];
          const off = each.filter((x, i) => each.every((y, j) => j === i || apart(x.e, y.e, key))).map((x) => x.droplet);
          for (const droplet of off) flagged.push({ droplet, source, app, phase, key });
          ((out[source] ??= {})[app] ??= {})[phase] ??= {};
          out[source][app][phase][key] = {
            values: Object.fromEntries(each.map((x) => [x.droplet, x.e[key]])),
            ...(each.some((x) => x.e.range?.[key]) ? { ranges: Object.fromEntries(each.filter((x) => x.e.range?.[key]).map((x) => [x.droplet, x.e.range[key]])) } : {}),
            // The range over the median, as caveat 1 measures a number's noise between passes.
            spreadPct: +((100 * (values[values.length - 1] - values[0])) / median).toFixed(1),
            flagged: off,
          };
        }
      }
    }
  }
  return { between: out, flagged };
}

/**
 * One round's summary from its droplets' summaries, in the shape of a round of one droplet. Each
 * app's entries come from the droplet that ran it, and the anchors' from the first droplet, the
 * reference. Each SSR entry except Corten's gains `toCorten`, a ratio to Corten on its own droplet,
 * and each droplet's own ~ marks against its own Corten are kept. On top, `droplets` lists each
 * droplet's round, CPU model and apps, `betweenDroplets` the anchors' numbers on every droplet, and
 * `flagged` the numbers where a droplet's anchors differ by more than the noise.
 * @param {{ round: string, apps: string[], cpu: string | null, summary: any }[]} parts the first is the reference
 * @param {string[]} [order] app names in catalog order, for the merged tables' rows
 * @param {string[]} [anchorNames]
 */
export function merged(parts, order = [], anchorNames = anchors) {
  if (!parts.length) throw new Error("a split round has no droplets");
  for (const key of ["tier", "edge"]) {
    const seen = [...new Set(parts.map((p) => p.summary[key]))];
    if (seen.length > 1) throw new Error(`the droplets' rounds differ in ${key} (${parts.map((p) => `${p.round}: ${p.summary[key]}`).join(", ")}), so they are not one round`);
  }
  const rank = (/** @type {string} */ app) => (order.includes(app) ? order.indexOf(app) : order.length);
  /**
   * Each key of one table from the first droplet that has it, in catalog order of their apps. An app
   * other than an anchor that two droplets ran is an error: the plan gives it to one.
   * @param {(p: { round: string, summary: any }) => Record<string, any> | null | undefined} of
   * @param {(key: string) => string} app
   * @param {(entry: any, p: { round: string, summary: any }) => any} [take]
   */
  const union = (of, app, take = (entry) => entry) => {
    /** @type {[string, any, string][]} */
    const rows = [];
    for (const p of parts) {
      for (const [key, entry] of Object.entries(of(p) ?? {})) {
        const earlier = rows.find(([k]) => k === key);
        if (earlier && !anchorNames.includes(app(key))) throw new Error(`${app(key)} ran on ${earlier[2]} and ${p.round}; a split round runs each app other than ${anchorNames.join(" and ")} on one droplet`);
        if (!earlier) rows.push([key, take(entry, p), p.round]);
      }
    }
    if (!parts.some((p) => of(p))) return null;
    return Object.fromEntries(rows.map((r, i) => /** @type {const} */ ([r, i])).sort(([a, i], [b, j]) => rank(app(a[0])) - rank(app(b[0])) || i - j).map(([r]) => [r[0], r[1]]));
  };
  const [reference] = parts;
  /** @type {Record<string, any>} */
  const summary = { tier: reference.summary.tier };
  if (reference.summary.edge !== undefined) summary.edge = reference.summary.edge;
  summary.droplets = parts.map((p) => ({ round: p.round, cpu: p.cpu, apps: p.apps }));
  const { between, flagged } = betweenDroplets(parts, anchorNames);
  summary.flagged = flagged;
  summary.ssr = {};
  for (const source of [...new Set(parts.flatMap((p) => Object.keys(p.summary.ssr ?? {})))]) {
    summary.ssr[source] = union((p) => p.summary.ssr?.[source], (key) => key, (entry, p) => {
      const corten = p.summary.ssr?.[source]?.corten;
      const ratio = entry === corten ? null : toCorten(entry, corten);
      return ratio ? { ...entry, toCorten: ratio } : entry;
    }) ?? {};
  }
  summary.betweenDroplets = between;
  for (const table of tables) {
    // A round of one droplet always has instructions and browser, if empty; the others may be null.
    const empty = table === "instructions" || table === "browser" ? {} : null;
    summary[table] = union((p) => p.summary[table], (key) => appOf(table, key)) ?? empty;
  }
  const skipped = parts.flatMap((p) => (p.summary.skipped ?? []).map((/** @type {any} */ s) => ({ ...s, droplet: p.round })));
  if (skipped.length) summary.skipped = skipped;
  return summary;
}

/**
 * The droplets' feature matrices (conform.mjs) as one, or null when none has one. Every droplet's
 * images must come from the same tree, the one droplet.mjs uploaded to them all.
 * @param {{ round: string, conformance: any }[]} parts
 * @param {string[]} [order]
 */
export function mergedConformance(parts, order = []) {
  const have = parts.filter((p) => p.conformance);
  if (!have.length) return null;
  const from = [...new Set(have.map((p) => p.conformance.imagesFrom))];
  if (from.length > 1) throw new Error(`the droplets' images were built from different trees (${have.map((p) => `${p.round}: ${p.conformance.imagesFrom}`).join(", ")}), so they are not one round`);
  const rank = (/** @type {string} */ app) => (order.includes(app) ? order.indexOf(app) : order.length);
  const apps = [...new Set(have.flatMap((p) => p.conformance.apps ?? []))].sort((a, b) => rank(a) - rank(b));
  /** @type {Record<string, any>} */
  const results = {};
  for (const app of apps) results[app] = have.find((p) => p.conformance.results?.[app])?.conformance.results[app];
  return { ...have[0].conformance, apps, results };
}

/**
 * A split round's droplets, read from results/: each one's summary, CPU model and feature matrix.
 * A round counts as finished only when all of its droplets have, so this throws while any droplet
 * has not finished or has not been collected.
 * @param {string} results bench/fullstack/results
 * @param {Plan} plan
 */
export function partsOf(results, plan) {
  const waiting = plan.droplets.filter((d) => !finished(join(results, d.round))).map((d) => d.round);
  if (waiting.length) throw new Error(`round ${plan.round} has not finished: ${waiting.join(", ")} ${waiting.length === 1 ? "has" : "have"} not finished here (node bench/fullstack/droplet.mjs ${plan.round} --collect collects them)`);
  return plan.droplets.map((d) => {
    const dir = join(results, d.round);
    const read = (/** @type {string} */ name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
    const host = read("host.txt");
    const conformance = read("conformance.json");
    return { round: d.round, apps: d.apps, cpu: host === null ? null : cpuOf(host), summary: JSON.parse(/** @type {string} */ (read("summary.json"))), conformance: conformance === null ? null : JSON.parse(conformance) };
  });
}

/** Where an app's rows in a split round come from: its droplet, or the reference for an anchor. @param {any} summary @param {string} app */
export const dropletOf = (summary, app) => (anchors.includes(app) ? summary.droplets[0]?.round : summary.droplets.find((/** @type {any} */ d) => d.apps.includes(app))?.round) ?? null;

/** The labels of the numbers compared across droplets. */
const labels = { fixed: "fixed", sat64: "64 users", sat256: "256 users" };

/**
 * The lines summarize.mjs prints for a split round before its tables: a FLAGGED line for each
 * droplet and anchor that differs from the other droplets by more than the noise, naming the
 * numbers, then each droplet's CPU and apps, and the anchors' numbers on every droplet with their
 * spread.
 * @param {any} summary merged()'s
 */
export function dropletLines(summary) {
  const line = (/** @type {string[]} */ cells) => `| ${cells.join(" | ")} |`;
  const label = (/** @type {string} */ phase, /** @type {string} */ key) => `${labels[/** @type {keyof typeof labels} */ (phase)] ?? phase} ${key === "rps" ? "/s" : "/CPU-s"}`;
  /** @type {Map<string, string[]>} */
  const byAnchor = new Map();
  for (const f of summary.flagged) {
    const at = `${f.droplet}'s ${f.app}`;
    byAnchor.set(at, [...(byAnchor.get(at) ?? []), `${f.source} ${label(f.phase, f.key)}`]);
  }
  const out = [...byAnchor].map(([at, numbers]) => `FLAGGED: ${at} differs from every other droplet's by more than the noise in ${numbers.length} number${numbers.length === 1 ? "" : "s"}: ${numbers.join(", ")}`);
  const names = summary.droplets.map((/** @type {any} */ d) => d.round);
  out.push(`\nDroplets (${names.length}, started together; each app's ratio is to Corten on its own droplet, and ${anchors.join(" and ")}'s rows are ${names[0]}'s)`);
  out.push(line(["Droplet", "CPU", "Apps"]));
  for (const d of summary.droplets) out.push(line([d.round, d.cpu ?? "?", d.apps.join(", ")]));
  out.push(`\nThe anchors on each droplet (spread: range over the median; FLAGGED: apart from every other droplet, with ranges that do not overlap, or more than ${100 * onePassNoise}% in one pass)`);
  out.push(line(["Number", ...names, "spread"]));
  for (const [source, byApp] of Object.entries(summary.betweenDroplets)) {
    for (const [app, byPhase] of Object.entries(/** @type {Record<string, any>} */ (byApp))) {
      for (const [phase, byKey] of Object.entries(/** @type {Record<string, any>} */ (byPhase))) {
        for (const [key, n] of Object.entries(/** @type {Record<string, any>} */ (byKey))) {
          const cell = (/** @type {string} */ d) => {
            const v = n.values[d];
            if (v === undefined) return "-";
            const r = n.ranges?.[d];
            return r && r[0] !== r[1] ? `${v} (${r[0]}-${r[1]})` : `${v}`;
          };
          out.push(line([`${source}/${app} ${label(phase, key)}`, ...names.map(cell), `${n.spreadPct}%${n.flagged.length ? ` FLAGGED ${n.flagged.join(", ")}` : ""}`]));
        }
      }
    }
  }
  return out;
}

/**
 * An SSR row's ratios to Corten on its droplet, as summarize.mjs prints them beside the raw numbers.
 * @param {any} e an ssr entry
 */
export function ratioCell(e) {
  if (!e.toCorten) return "";
  const x = (/** @type {number | null | undefined} */ r) => (r === null || r === undefined ? "-" : `${r}x`);
  const t = e.toCorten;
  return `to corten: fixed ${x(t.fixed?.perCpuSecond)} /CPU-s, 64 users ${x(t.sat64?.rps)} /s ${x(t.sat64?.perCpuSecond)} /CPU-s, 256 users ${x(t.sat256?.rps)} /s`;
}
