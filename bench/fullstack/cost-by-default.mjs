// What each production default costs one request, from cost-by-default.sh's results.tsv: per
// build, target and encoding, one request's user instructions (the run of N2 requests less the run
// of N1, over N2 - N1) for each repeat, then a default's cost as the build as it is less the build
// with the default removed, as the median and range across repeats.
// Usage: node cost-by-default.mjs <results.tsv>
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** Median of a list of numbers. */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** One request's instructions for each build, target, encoding and repeat. */
export function perRequest(tsv) {
  const [head, ...rows] = tsv.trim().split("\n").map((line) => line.split("\t"));
  const col = Object.fromEntries(head.map((name, i) => [name, i]));
  const runs = new Map();
  for (const row of rows) {
    const key = [row[col.variant], row[col.target], row[col.encoding], row[col.repeat]].join("\t");
    const sizes = runs.get(key) ?? new Map();
    sizes.set(Number(row[col.requests]), Number(row[col.instructions]));
    runs.set(key, sizes);
  }
  const out = new Map();
  for (const [key, sizes] of runs) {
    const [small, large] = [...sizes.keys()].sort((a, b) => a - b);
    if (large === undefined) throw new Error(`${key}: one run, not two`);
    const [variant, target, encoding] = key.split("\t");
    const group = [variant, target, encoding].join("\t");
    out.set(group, [...(out.get(group) ?? []), (sizes.get(large) - sizes.get(small)) / (large - small)]);
  }
  return out;
}

/** Each removed default's cost against the build as it is: median and range over repeats. */
export function costs(tsv) {
  const per = perRequest(tsv);
  const rows = [];
  for (const [group, values] of per) {
    const [variant, target, encoding] = group.split("\t");
    const base = per.get(["as-is", target, encoding].join("\t"));
    if (!base) throw new Error(`no as-is build for ${target} ${encoding}`);
    // Pair repeats in order: repeat k of both builds ran one after the other.
    const deltas = values.map((v, i) => base[i] - v).filter(Number.isFinite);
    rows.push({
      variant, target, encoding,
      request: median(values), requestRange: [Math.min(...values), Math.max(...values)],
      cost: median(deltas), costRange: [Math.min(...deltas), Math.max(...deltas)],
      share: median(deltas) / median(base),
    });
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = costs(fs.readFileSync(process.argv[2], "utf8"));
  const n = (x) => Math.round(x).toLocaleString("en-US");
  for (const r of rows.sort((a, b) => (a.target + a.encoding + a.variant).localeCompare(b.target + b.encoding + b.variant))) {
    console.log([r.target, r.encoding, r.variant, n(r.request), `${n(r.requestRange[0])}-${n(r.requestRange[1])}`,
      r.variant === "as-is" ? "" : `${n(r.cost)} (${n(r.costRange[0])} to ${n(r.costRange[1])}) ${(r.share * 100).toFixed(1)}%`].join("\t"));
  }
}
