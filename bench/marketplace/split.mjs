// A marketplace round split across droplets started together (#816): the merge of the droplets'
// part summaries into one round, and the check that the droplets' machines agree. Pure, so
// split.test.mjs tests it; report.mjs prints it and droplet.mjs collects and merges.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { withinNoise } from "../fullstack/passes.mjs";
import { apps } from "./contract.mjs";
import { anchors, phases, splitApps, timedProfiles } from "./run-contract.mjs";

/**
 * One round from its droplets' part summaries, d1 first, each already validated by
 * validateSummary. Every app's entry comes from the droplet that measured it; the anchors (Corten
 * and axum-maud, on every droplet) come from d1 at the top level, as compare.mjs reads them, and
 * from each droplet in split.parts, with each droplet's host, tools, run and times. The merged
 * summary is a round of all twenty apps: validate it with validateSummary before using it.
 * @param {string} round
 * @param {object[]} parts the part summaries, d1 first
 */
export function mergeParts(round, parts) {
  const n = parts.length, shares = splitApps(n);
  const [first] = parts;
  const shared = ({ apps: _apps, part: _part, ...rest }) => rest;
  parts.forEach((s, i) => {
    const at = `d${i + 1}`;
    assert.equal(s.round, round, `${at} measured ${s.round}, not ${round}`);
    assert.deepEqual(s.options.part, { index: i + 1, of: n }, `${at} is not part ${i + 1} of ${n}`);
    assert.deepEqual(s.options.apps, shares[i], `${at} measured other apps than its share`);
    for (const key of ["schema", "workload", "commit", "fixtureSha256", "measurement", "scope"]) {
      assert.ok(isDeepStrictEqual(s[key], first[key]), `${at}'s ${key} differs from d1's: not one round`);
    }
    assert.ok(isDeepStrictEqual(shared(s.options), shared(first.options)), `${at}'s options differ from d1's: not one round`);
  });
  const owner = (app) => anchors.includes(app) ? first : parts[shares.findIndex((share) => share.includes(app))];
  const { part: _part, ...options } = first.options;
  const times = (key) => parts.map((s) => s[key]).sort();
  return { schema: first.schema, workload: first.workload, round, ...(first.scope === undefined ? {} : { scope: first.scope }),
    options: { ...options, apps: [...apps] }, startedAt: times("startedAt")[0], finishedAt: times("finishedAt").at(-1),
    complete: true, checksPassed: true, failures: [], cleanupFailures: [],
    commit: first.commit, dirty: false, finishedCommit: first.commit, finishedDirty: false,
    host: first.host, tools: first.tools, fixtureSha256: first.fixtureSha256, measurement: first.measurement,
    apps: Object.fromEntries(apps.map((app) => [app, owner(app).apps[app]])),
    split: { droplets: n, parts: parts.map((s, i) => ({ index: i + 1, apps: s.options.apps, runId: s.runId, startedAt: s.startedAt, finishedAt: s.finishedAt,
      host: s.host, tools: s.tools, anchors: Object.fromEntries(anchors.map((app) => [app, s.apps[app]])) })) } };
}

// The numbers the droplets are checked on: throughput and counted CPU per request.
export const anchorMetrics = { rps: "req/s", cpuPerRequestUsec: "CPU us/request" };
// a / b over the passes: the median of the medians, and the widest the passes allow.
const ratio = (a, b) => ({ median: a.median / b.median, min: a.min / b.max, max: a.max / b.min });
// The pairs of droplets whose ranges do not overlap: they differ by more than the noise. Only
// said of two numbers each from two or more passes (withinNoise), so a stopped stage is not.
function differ(cells) {
  const out = [];
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const a = cells[i], b = cells[j];
    if (withinNoise(a.range, a.passes, b.range, b.passes) === false) out.push([a.index, b.index]);
  }
  return out;
}
/** "d1 and d2 differ", for each pair of droplets that do. */
export const differText = (pairs) => pairs.map(([a, b]) => `d${a} and d${b} differ`).join("; ");

/**
 * Whether a split round's droplets agree, from the anchors each one measured. A stage is flagged
 * when axum-maud's ratio to Corten differs between two droplets by more than the noise (their
 * ranges do not overlap): ratios to Corten that compare apps on those droplets are then not
 * like for like. Droplets can differ in machine speed and still agree on the ratio, which is
 * what cross-droplet comparisons use; every table's anchor rows show their raw numbers.
 * @param {object} s a validated merged summary (with split)
 */
export function betweenDroplets(s) {
  const ratios = [];
  for (const { key } of timedProfiles) for (const phase of phases) for (const metric of Object.keys(anchorMetrics)) {
    const cells = s.split.parts.map((p) => {
      const c = p.anchors.corten.phases[key][phase], a = p.anchors["axum-maud"].phases[key][phase];
      const passes = Math.min(c.passes, a.passes);
      return { index: p.index, passes, range: passes ? ratio(a[metric], c[metric]) : null };
    });
    ratios.push({ profile: key, phase, metric, cells, differ: differ(cells) });
  }
  return { ratios, flagged: ratios.filter((r) => r.differ.length) };
}
