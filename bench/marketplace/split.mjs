// A marketplace round split across droplets started together (#816): the merge of the droplets'
// part summaries into one round of a named group, and how Corten's own numbers differ between the
// droplets. Pure, so split.test.mjs tests it; report.mjs prints it and droplet.mjs collects and merges.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { withinNoise } from "../fullstack/passes.mjs";
import { groupApps } from "./groups.mjs";
import { phases, splitApps, splitSubject, timedProfiles } from "./run-contract.mjs";

// A part's own outcome, as its summary records it. A merged round is finished and clean only
// when every part is, so the merge refuses any other part and keeps each part's in split.parts,
// where the reader checks them again.
export const outcomeFields = ["complete", "checksPassed", "failures", "cleanupFailures", "dirty", "finishedCommit", "finishedDirty"];
/** The outcome every part of a merged round must have. */
export const cleanOutcome = (commit) => ({ complete: true, checksPassed: true, failures: [], cleanupFailures: [], dirty: false, finishedCommit: commit, finishedDirty: false });

/**
 * One round of a named group from its droplets' part summaries, d1 first, each already validated
 * by validateSummary. Every candidate comes from the one droplet that qualified it, with its raw
 * qualification and, if admitted, its measurements; an excluded candidate keeps its evidence and
 * has no runs. Corten, on every droplet, comes from d1 at the top level, as compare.mjs reads it,
 * and from each droplet in split.parts, with each droplet's host, tools, run and times. The parts
 * must be exactly the group's split: each candidate accounted for once, and each part finished,
 * with its checks passed, no failures and a clean tree at the round's commit. Validate the merged
 * summary with validateSummary before using it.
 * @param {string} round
 * @param {object[]} parts the part summaries, d1 first
 */
export function mergeParts(round, parts) {
  const n = parts.length, [first] = parts;
  const group = first?.options.group;
  assert.ok(group !== undefined, "a split round splits a named group");
  const shares = splitApps(group, n), candidates = groupApps(group);
  const shared = ({ apps: _apps, part: _part, ...rest }) => rest;
  parts.forEach((s, i) => {
    const at = `d${i + 1}`;
    assert.equal(s.round, round, `${at} measured ${s.round}, not ${round}`);
    assert.deepEqual(s.options.part, { index: i + 1, of: n }, `${at} is not part ${i + 1} of ${n}`);
    assert.deepEqual(s.options.apps, shares[i], `${at} qualified other candidates than its share of ${group}`);
    assert.deepEqual(Object.keys(s.apps), shares[i], `${at} records other candidates than its share of ${group}`);
    for (const key of ["schema", "workload", "commit", "fixtureSha256", "measurement", "scope"]) {
      assert.ok(isDeepStrictEqual(s[key], first[key]), `${at}'s ${key} differs from d1's: not one round`);
    }
    assert.ok(isDeepStrictEqual(shared(s.options), shared(first.options)), `${at}'s options differ from d1's: not one round`);
    for (const [key, value] of Object.entries(cleanOutcome(first.commit))) assert.ok(isDeepStrictEqual(s[key], value), `${at}'s ${key} is ${JSON.stringify(s[key])}, not ${JSON.stringify(value)}: an unfinished or failed part does not merge`);
  });
  // Each candidate once: Corten from d1, every other from the one droplet whose share has it.
  const owner = (app) => app === splitSubject ? first : parts[shares.findIndex((share) => share.includes(app))];
  for (const app of candidates) assert.equal(app === splitSubject ? 1 : shares.filter((share) => share.includes(app)).length, 1, `${app} is not accounted for exactly once`);
  const { part: _part, ...options } = first.options;
  const times = (key) => parts.map((s) => s[key]).sort();
  return { schema: first.schema, workload: first.workload, round, ...(first.scope === undefined ? {} : { scope: first.scope }),
    options: { ...options, apps: candidates }, startedAt: times("startedAt")[0], finishedAt: times("finishedAt").at(-1),
    complete: true, checksPassed: true, failures: [], cleanupFailures: [],
    commit: first.commit, dirty: false, finishedCommit: first.commit, finishedDirty: false,
    host: first.host, tools: first.tools, fixtureSha256: first.fixtureSha256, measurement: first.measurement,
    apps: Object.fromEntries(candidates.map((app) => [app, owner(app).apps[app]])),
    split: { droplets: n, parts: parts.map((s, i) => ({ index: i + 1, apps: s.options.apps, runId: s.runId, startedAt: s.startedAt, finishedAt: s.finishedAt,
      host: s.host, tools: s.tools, corten: s.apps[splitSubject], ...Object.fromEntries(outcomeFields.map((key) => [key, s[key]])) })) } };
}

// The numbers the droplets are compared on: throughput and counted CPU per request.
export const subjectMetrics = { rps: "req/s", cpuPerRequestUsec: "CPU us/request" };
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
 * How Corten, the one app on every droplet, measured on each droplet of a split round. A stage is
 * flagged when Corten's own range differs between two droplets by more than the noise (the ranges
 * do not overlap): raw numbers of candidates on those droplets then also carry the difference
 * between the machines, so compare them by their ratio to their own droplet's Corten. With only
 * Corten on every droplet, nothing checks that those ratios carry across machines.
 * @param {object} s a validated merged summary (with split)
 */
export function betweenDroplets(s) {
  const stages = [];
  for (const { key } of timedProfiles) for (const phase of phases) for (const metric of Object.keys(subjectMetrics)) {
    const cells = s.split.parts.map((p) => {
      const c = p.corten.phases[key][phase];
      return { index: p.index, passes: c.passes, range: c.passes ? c[metric] : null };
    });
    stages.push({ profile: key, phase, metric, cells, differ: differ(cells) });
  }
  return { stages, flagged: stages.filter((r) => r.differ.length) };
}
