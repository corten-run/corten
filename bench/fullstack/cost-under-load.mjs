// What each production default costs a request under load, from the summary.json ab.mjs writes for
// cost-under-load.sh: per build (cbd-<variant>), target, encoding and phase (the fixed 300 a second,
// and 64 users, where a request's CPU is less: work is batched and the app is never idle), the
// requests per CPU-second in each round, and a default's cost as the CPU microseconds a request takes in
// the build as it is less in the build with the default removed. Round k of every build ran in
// the same pass, one after the other, so the cost is taken round by round, then given as the
// median and range across rounds.
// Usage: node cost-under-load.mjs <summary.json>
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** Median of a list of numbers. */
const median = (/** @type {number[]} */ xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Requests per CPU-second, by build, target, encoding and phase, then by round.
 * @param {{ round: number, image: string, target: string, enc: string, phase: string, perCpuSecond: number | null, failed: number }[]} rows
 */
export function perCpuSecond(rows) {
  /** @type {Map<string, Map<number, number>>} */
  const out = new Map();
  for (const row of rows) {
    const variant = row.image.replace(/^cbd-/, "");
    const group = [variant, row.target, row.enc, row.phase].join("\t");
    if (row.failed) throw new Error(`${group}: round ${row.round} had ${row.failed} failed requests`);
    if (row.perCpuSecond === null) throw new Error(`${group}: round ${row.round}'s CPU was not counted`);
    const rounds = out.get(group) ?? new Map();
    if (rounds.has(row.round)) throw new Error(`${group}: two runs of round ${row.round}`);
    rounds.set(row.round, row.perCpuSecond);
    out.set(group, rounds);
  }
  return out;
}

/**
 * Each removed default's cost against the build as it is: CPU microseconds a request, median and
 * range over rounds, and its share of the request.
 * @param {Parameters<typeof perCpuSecond>[0]} rows
 */
export function costs(rows) {
  const per = perCpuSecond(rows);
  const micros = (/** @type {number} */ rate) => 1e6 / rate;
  const result = [];
  for (const [group, values] of per) {
    const [variant, target, encoding, phase] = group.split("\t");
    const base = per.get(["as-is", target, encoding, phase].join("\t"));
    if (!base) throw new Error(`no as-is build for ${target} ${encoding} ${phase}`);
    const missing = [...base.keys()].filter((round) => !values.has(round));
    if (missing.length) throw new Error(`${group}: no run of round ${missing.join(", ")}, which as-is has`);
    const deltas = [...values].map(([round, rate]) => {
      const was = base.get(round);
      if (was === undefined) throw new Error(`${group}: round ${round} has no as-is run`);
      return micros(was) - micros(rate);
    });
    const all = [...values.values()];
    result.push({
      variant, target, encoding, phase,
      rate: median(all), rateRange: [Math.min(...all), Math.max(...all)],
      cost: median(deltas), costRange: [Math.min(...deltas), Math.max(...deltas)],
      share: median(deltas) / median([...base.values()].map(micros)),
    });
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = costs(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
  const n = (/** @type {number} */ x) => Math.round(x).toLocaleString("en-US");
  // A cost within 0.05 of zero is written to two places, so its sign is not lost to "-0.0" or "0.0".
  const us = (/** @type {number} */ x) => x.toFixed(x !== 0 && Math.abs(x) < 0.05 ? 2 : 1);
  for (const r of rows.sort((a, b) => [a.target, a.encoding, a.phase, a.variant].join(" ").localeCompare([b.target, b.encoding, b.phase, b.variant].join(" ")))) {
    console.log([r.target, r.encoding, r.phase, r.variant, n(r.rate), `${n(r.rateRange[0])}-${n(r.rateRange[1])}`,
      r.variant === "as-is" ? "" : `${us(r.cost)} us (${us(r.costRange[0])} to ${us(r.costRange[1])}) ${(r.share * 100).toFixed(1)}%`].join("\t"));
  }
}
