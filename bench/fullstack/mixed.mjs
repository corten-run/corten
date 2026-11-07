// The mixed phase (#813): what run-ssr.mjs gives mixed-load.js to post an app's form, and what
// summarize.mjs reads from the phase. Pure, so mixed.test.mjs can check it without Docker.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formBody, formOf } from "./conformance.mjs";
import { spread } from "./passes.mjs";

const read = (/** @type {string} */ file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

/** The kinds of request mixed-load.js sends, as its metrics name them. */
export const kinds = /** @type {const} */ (["page", "slow", "json", "home", "post"]);
/** How it sorts their answers: 2xx and 3xx, 429, other 4xx, 5xx, and no answer. */
export const classes = /** @type {const} */ (["ok", "limited", "refused", "failed", "none"]);
/**
 * The share of the item pages whose item the item API answers late (item-api/server.mjs's
 * `item_slow_<n>`): about 2 a second at 150/s, enough for a deadline to fire every second. An app
 * with no deadline holds each for `slowMs`, about 84 at once (150 x 70% x 2% x 40 s): one with
 * fewer request slots than that (a few workers or threads) is filled by them, and the phase then
 * measures that, as a site with a slow upstream and no deadline would see it.
 */
export const slowShare = 0.02;
/**
 * How late it answers them: past the 35 s within which the matched profile's deadline must answer
 * (README, The matched tier), so every app with one answers before the item does, and inside the
 * 60 s after which k6 and the edge's nginx give up, so an app with none is seen answering it.
 */
export const slowMs = 40_000;
/** The phase's length: what its rate and CPU are over, not the wait for its last late answers after it. */
export const mixedSeconds = 60;
/**
 * How long the phase waits for the answers still to come when its time is up: k6's 60 s timeout
 * for each request, so every request sent ends counted, answered or not (one k6 stops waiting
 * for is in no count).
 */
export const tailSeconds = 60;

/**
 * What mixed-load.js needs to post the item page's price-alert form as the page posts it: its
 * path, encoding and body (`formOf` and `formBody`, as conform.mjs's own post), the page's cookies,
 * and the origin the app takes as its own. Directly, the post names the app as conform.mjs's own
 * post does (`host`, which the app answers on); through the edge, which names the app by its
 * container, the origin is that name's. `none` says why there is no post: the share then asks
 * for item pages instead.
 * @param {string | null} html the item page, or null when it did not answer
 * @param {string} cookie its cookies, as a Cookie header
 * @param {{ host?: string, origin: string }} own
 * @returns {{ env: Record<string, string> } | { none: string }}
 */
export function formEnv(html, cookie, own) {
  if (html === null) return { none: "the page did not answer" };
  const form = formOf(html, "/items/item_1");
  if (!form) return { none: "no form that posts" };
  if ("script" in form) return { none: `${form.script} (sent by its script)` };
  const { type, body } = formBody(form);
  /** @type {Record<string, string>} */
  const env = { FORM_PATH: form.path, FORM_TYPE: type, FORM_BODY: body, ORIGIN: own.origin };
  if (cookie) env.FORM_COOKIE = cookie;
  if (own.host) env.FORM_HOST = own.host;
  return { env };
}

/**
 * One pass of the mixed phase: for each kind of request how many were sent, their median and p99
 * latency and how many of each class of answer, and for the phase the rate, the share never sent,
 * the app's CPU and peak memory, and what its form was (run-ssr.mjs's `-form.json`).
 * @param {string} folder @param {string} name the app @param {string} base the files' name
 */
export function mixedOf(folder, name, base) {
  const k6 = read(join(folder, `${base}.json`));
  if (!k6) return null;
  const m = k6.metrics;
  const count = (/** @type {string} */ key) => m[key]?.count ?? 0;
  /** @type {Record<string, Record<string, number | null>>} */
  const byKind = {};
  for (const kind of kinds) {
    const answers = Object.fromEntries(classes.map((c) => [c, count(`${kind}_${c}`)]));
    const sent = Object.values(answers).reduce((a, b) => a + b, 0);
    if (!sent) continue;
    const ms = m[`${kind}_ms`];
    byKind[kind] = { sent, p50: ms ? +ms["p(50)"].toFixed(1) : null, p99: ms ? +ms["p(99)"].toFixed(1) : null, ...answers };
  }
  const offered = m.http_reqs.count + (m.dropped_iterations?.count ?? 0);
  // Over the phase's own length: k6's rate is over the run, which waits for the late answers after
  // it, longer for an app with no deadline.
  const seconds = mixedSeconds;
  const usec = read(join(folder, `${base}-cpu.json`))?.[`fsw-${name}`]?.usec;
  const stats = read(join(folder, `${base}-stats.json`))?.[`fsw-${name}`];
  return {
    rps: +(m.http_reqs.count / seconds).toFixed(0),
    unsentPct: +((100 * (m.dropped_iterations?.count ?? 0)) / offered).toFixed(2),
    // The share of a CPU the app used over the phase, from its counted CPU time (the late answers'
    // wait after it included, which is little work).
    cpuUsedPct: usec > 0 && seconds > 0 ? +((100 * usec) / 1e6 / seconds).toFixed(1) : null,
    memMaxMiB: stats?.memMaxMiB ?? null,
    byKind,
    form: read(join(folder, `${base}-form.json`)),
  };
}

/**
 * Several passes of the mixed phase: each number the passes' median (one a pass measured), with no
 * range (the table shows the median alone), the form as the first pass with files found it, `passes` how many measured it and `asked` how many were asked for when
 * that is more. A kind one pass did not send is the median of those that did.
 * @param {NonNullable<ReturnType<typeof mixedOf>>[]} runs @param {number} asked
 */
export function mergedMixed(runs, asked) {
  const median = (/** @type {(number | null | undefined)[]} */ xs) => spread(xs)?.median ?? null;
  /** @type {Record<string, Record<string, number | null>>} */
  const byKind = {};
  for (const kind of kinds) {
    const each = runs.map((r) => r.byKind[kind]).filter(Boolean);
    if (!each.length) continue;
    byKind[kind] = Object.fromEntries(Object.keys(each[0]).map((key) => [key, median(each.map((k) => k[key]))]));
  }
  return {
    passes: runs.length,
    ...(asked > runs.length ? { asked } : {}),
    rps: median(runs.map((r) => r.rps)),
    unsentPct: Math.max(...runs.map((r) => r.unsentPct)),
    cpuUsedPct: median(runs.map((r) => r.cpuUsedPct)),
    memMaxMiB: median(runs.map((r) => r.memMaxMiB)),
    byKind,
    form: runs[0].form,
  };
}
