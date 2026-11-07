// The hardening step's phases and how their results read, kept apart from harden.mjs (which needs
// Docker) so hardening.test.mjs can check them.

/** The shape of a round's hardening.json. */
export const format = 1;

/**
 * The phases, in order, each against a freshly started app: what harden-probe.mjs sends (input),
 * the most the probe may take (limitMs), and the label of its column. The numbers: 2,000 unfinished
 * heads (4,000 took card-market to 913 MiB of its 1 GiB before its head limit was lowered), held
 * past Corten's 30 s header timeout; 200 heads and 100 bodies sent a byte a second, the slowloris
 * shape; 200 connections that each pipeline 1,000 page requests and never read; 5,000 idle
 * connections; and three oversized requests.
 * @type {{ key: string, label: string, input: Record<string, number>, limitMs: number }[]}
 */
export const phases = [
  { key: "headFlood", label: "2,000 unfinished heads", input: { count: 2000, holdMs: 45_000 }, limitMs: 150_000 },
  { key: "slowHead", label: "200 heads a byte a second", input: { count: 200, everyMs: 1000, holdMs: 60_000 }, limitMs: 150_000 },
  { key: "slowBody", label: "100 bodies a byte a second", input: { count: 100, everyMs: 1000, holdMs: 90_000 }, limitMs: 180_000 },
  // 1,000 pipelined pages a connection are more than the kernel's socket buffers hold between
  // two containers (several MiB each way), so the server's writes do block.
  { key: "slowReader", label: "200 clients that stop reading", input: { count: 200, pipelined: 1000, holdMs: 90_000 }, limitMs: 180_000 },
  { key: "idleFlood", label: "5,000 idle connections", input: { count: 5000, holdMs: 60_000 }, limitMs: 180_000 },
  { key: "oversized", label: "200 headers / 1 MiB header / 16 MiB body", input: {}, limitMs: 120_000 },
];

/**
 * Whether the app came through a phase: still running, not killed for memory, and answering a
 * request on a new connection once the abuse was closed.
 * @param {Record<string, any>} p
 */
export const survived = (p) => !p.error && p.running === true && p.oomKilled !== true && p.after === 200;

/** "closed all in 30.2 s", "closed 120 of 200, the last at 31.0 s, held the rest 60 s", or "held all 60 s". @param {Record<string, any>} p */
export const closureOf = (p) => {
  const closed = Array.isArray(p.closedBy) ? p.closedBy.length : 0;
  const s = (/** @type {number} */ ms) => (ms / 1000).toFixed(1) + " s";
  if (!p.opened) return "none connected";
  if (closed === p.opened) return `closed all ${p.opened} by ${s(p.closedBy[closed - 1])}`;
  if (closed === 0) return `held all ${p.opened} ${Math.round(p.heldMs / 1000)} s`;
  return `closed ${closed} of ${p.opened} by ${s(p.closedBy[closed - 1])}, held the rest ${Math.round(p.heldMs / 1000)} s`;
};

/** The well-behaved client's part: "good p99 12 ms" and how many of its requests failed. @param {Record<string, any> | undefined} g */
export const goodOf = (g) => (!g ? "good: not run" : `good p99 ${g.p99 ?? "-"} ms, ${g.failed} of ${g.sent} failed`);

/**
 * Each phase's cell: whether the app survived, what it did with the abusive connections (or the
 * oversized requests' answers), the well-behaved client, and the memory it reached.
 * @param {Record<string, any>} probes harden.mjs's results for one app, by phase
 * @returns {Record<string, string>}
 */
export const cellsOf = (probes) => Object.fromEntries(Object.entries(probes).map(([key, p]) => {
  if (p.error) return [key, "error " + p.error];
  const what = key === "oversized" ? Object.values(p.statuses ?? {}).map((s) => String(s ?? "no answer")).join(" / ") : closureOf(p);
  const mem = p.memMaxMiB === null || p.memMaxMiB === undefined ? "" : `; ${p.memMaxMiB} MiB peak`;
  return [key, `${survived(p) ? "up" : p.oomKilled ? "DOWN (out of memory)" : "DOWN"}: ${what}; ${goodOf(p.good)}${mem}`];
}));
