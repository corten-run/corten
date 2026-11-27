import { spawn } from "node:child_process";

// The perf passes of one count. A Xeon Platinum 8358 guest stalls in its PMU code and stops as a
// whole when one perf session counts `instructions:u` and `instructions:k` together, with `-C` or
// `-p` (#2151), so no session here holds both: each count is two independent loads drawn from the
// same request mix (ssr-load.js picks each request at random), the first counting user instructions,
// both cycles and user L1i misses (the set bench/placement counts), the second, later on the same
// app, kernel instructions alone. Both sets ran without a stall on such a host (measured on
// fresh hosts; the main pass's retry set, `instructions:u` alone, is a subset of its whole set and
// was not run alone there).
/** Each pass's counts a request and the perf event each is read from, in the order perf is given them. */
export const PASSES = Object.freeze({
  main: Object.freeze({
    userCyclesPerRequest: "cycles:u",
    kernelCyclesPerRequest: "cycles:k",
    userPerRequest: "instructions:u",
    userL1iMissesPerRequest: "L1-icache-load-misses:u",
  }),
  kernel: Object.freeze({ kernelPerRequest: "instructions:k" }),
});
/** The event each pass cannot do without: an unusable one fails the pass (or, for main, retries it with that event alone). */
const REQUIRED = Object.freeze({ main: "instructions:u", kernel: "instructions:k" });
/** A row's counts, in the order a row has always listed them. */
const events = {
  userPerRequest: PASSES.main.userPerRequest,
  kernelPerRequest: PASSES.kernel.kernelPerRequest,
  userCyclesPerRequest: PASSES.main.userCyclesPerRequest,
  kernelCyclesPerRequest: PASSES.main.kernelCyclesPerRequest,
  userL1iMissesPerRequest: PASSES.main.userL1iMissesPerRequest,
};
const eventNames = Object.values(events);

/** The events a pass gives perf: all of its own, or, retrying main, its required event alone. */
export function passEvents(/** @type {"main" | "kernel"} */ pass, instructionsOnly = false) {
  if (!(pass in PASSES)) throw new Error(`unknown perf pass ${JSON.stringify(pass)}`);
  return instructionsOnly ? [REQUIRED[pass]] : Object.values(PASSES[pass]);
}

/**
 * Refuses an event list that is not one of the sets a count gives perf, read as perf reads it once
 * joined: one that would count user and kernel instructions in one session (#2151) by that, and any
 * other list (an entry holding a comma or whitespace, another event, another order) as not a set.
 */
function supportedSet(/** @type {string[]} */ names) {
  if (!Array.isArray(names) || !names.every((e) => typeof e === "string")) throw new Error(`perf would be given ${JSON.stringify(names)}, not a list of event names`);
  const emitted = names.join(",").split(",").map((e) => e.trim());
  if (emitted.includes("instructions:u") && emitted.includes("instructions:k")) {
    throw new Error(`perf would count instructions:u and instructions:k in one session (${names.join(",")}), which stops a Xeon Platinum 8358 guest (#2151)`);
  }
  const sets = [passEvents("main", true), passEvents("kernel"), passEvents("main")];
  if (!sets.some((set) => set.length === names.length && set.every((e, i) => names[i] === e))) {
    throw new Error(`perf would be given ${JSON.stringify(names)}, not one of the event sets a count gives it (${sets.map((s) => s.join(",")).join("; ")})`);
  }
  return names;
}

export function perfCountArgs(/** @type {string[]} */ cpus, /** @type {string} */ cgroup, /** @type {string[]} */ names) {
  supportedSet(names);
  // perf maps the cgroups to events in order; each event needs its own entry.
  return ["stat", ...cpus, "-x", ",", "--log-fd", "1", "-e", names.join(","), "-G", names.map(() => cgroup).join(",")];
}

/** The probe of one event set before the first count: the same CPUs and events, over an idle second, no cgroup. */
export function perfProbeArgs(/** @type {string[]} */ cpus, /** @type {string[]} */ names) {
  supportedSet(names);
  return ["stat", ...cpus, "-x", ",", "--log-fd", "1", "-e", names.join(","), "--", "sleep", "1"];
}

/** Every set a count gives perf, in the order the probe runs them: each alone first, then main's whole set. */
export const PROBE_SETS = Object.freeze([passEvents("main", true), passEvents("kernel"), passEvents("main")]);

/**
 * What one probe found wrong with its set, or null: perf could not start, did not answer within its
 * bound, did not exit 0, or gave no count for a required event of the set (a counter the CPU or the
 * VM does not expose prints `<not supported>` and still exits 0). An optional event the set holds
 * may be unusable, as it may in a count.
 * @param {string[]} names
 * @param {{ status: number | null, signal?: string | null, stdout?: string, stderr?: string, error?: string }} r
 */
export function probeError(names, r) {
  const said = (r.stderr ?? "").trim() || (r.stdout ?? "").trim();
  if (r.error) return `perf stat -e ${names.join(",")}: ${r.error}`;
  if (r.status !== 0) return `perf stat -e ${names.join(",")} exited ${r.status ?? r.signal ?? "-"}${said ? `: ${said}` : ""}`;
  const counts = parsePerfCounts(r.stdout ?? "");
  for (const event of names.filter((e) => Object.values(REQUIRED).includes(e))) {
    if (counts.get(event)?.count == null) return `perf stat -e ${names.join(",")} gave no count for ${event}${said ? `: ${said}` : ""}`;
  }
  return null;
}

/** How long a probe's perf may run, and how long it may take to exit once killed, before it is given up as no answer. */
export const PROBE_MS = 30_000, GRACE_MS = 5_000;

/**
 * Runs a command to its end within a bound, and settles even where it never exits. On POSIX it runs
 * in a process group of its own; past `timeoutMs` that group is killed, but only while its leader is
 * not yet reaped (once it is, the group's number may be another's, so it is never signalled after).
 * `graceMs` after the kill, or after the leader exits with its output still held open by a process
 * it started, the run is given up rather than waited out, so a process stuck in the kernel cannot
 * hold the count. Never throws; the result says what happened: `answered` whether the leader's exit
 * was seen, `cleanup` whether it and every holder of its output were seen to end ("confirmed") or
 * not ("unconfirmed": something it started may still run, and no further count should run here).
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, graceMs?: number, env?: Record<string, string | undefined>, start?: typeof spawn,
 *   group?: boolean, signalGroup?: (pid: number, signal: NodeJS.Signals) => void }} [options]
 * @returns {Promise<{ status: number | null, signal: string | null, stdout: string, stderr: string, error?: string, answered: boolean, cleanup: "confirmed" | "unconfirmed" }>}
 */
export function runBounded(command, args, { timeoutMs = PROBE_MS, graceMs = GRACE_MS, env, start = spawn, group = process.platform !== "win32", signalGroup = (pid, signal) => process.kill(-pid, signal) } = {}) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", settled = false, timedOut = false;
    /** @type {{ status: number | null, signal: string | null } | null} */
    let exit = null;
    /** @type {string | undefined} */
    let killError;
    /** @type {ReturnType<typeof setTimeout>[]} */
    const timers = [];
    const later = (/** @type {number} */ ms, /** @type {() => void} */ f) => void timers.push(setTimeout(f, ms));
    const done = (/** @type {any} */ r) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve({ status: exit?.status ?? null, signal: exit?.signal ?? null, stdout, stderr, answered: exit !== null, cleanup: "confirmed", ...r });
    };
    /** @type {any} */
    let child;
    try { child = start(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: group }); } catch (e) { return done({ error: /** @type {Error} */ (e).message }); }
    const giveUp = () => {
      if (settled) return;
      child.unref?.();
      child.stdout?.destroy();
      child.stderr?.destroy();
      const killed = killError ? ` (the kill failed: ${killError})` : "";
      done({ cleanup: "unconfirmed", error: exit === null
        ? `no answer: it did not finish within ${timeoutMs / 1000} s and had not exited ${graceMs / 1000} s after it was killed${killed}`
        : `cleanup unconfirmed: its output stayed open ${graceMs / 1000} s after it exited ${exit.status ?? exit.signal ?? "-"}, so a process it started may still run` });
    };
    child.stdout?.on("data", (/** @type {Buffer} */ d) => (stdout += d));
    child.stderr?.on("data", (/** @type {Buffer} */ d) => (stderr += d));
    // A spawn that started nothing has no process to end; an error after it started (a failed kill) is kept for the report.
    child.on("error", (/** @type {Error} */ e) => { if (child.pid === undefined && exit === null) done({ error: e.message }); else killError ??= e.message; });
    child.on("exit", (/** @type {number | null} */ status, /** @type {string | null} */ signal) => {
      exit = { status, signal };
      later(graceMs, giveUp);
    });
    child.on("close", (/** @type {number | null} */ status, /** @type {string | null} */ signal) => {
      exit ??= { status, signal };
      done(timedOut ? { error: `did not finish within ${timeoutMs / 1000} s` } : {});
    });
    later(timeoutMs, () => {
      // A reaped leader's group number may be another group's by now: never signal it.
      if (exit !== null) return;
      if (child.exitCode != null || child.signalCode != null) {
        exit = { status: child.exitCode ?? null, signal: child.signalCode ?? null };
        return void later(graceMs, giveUp);
      }
      timedOut = true;
      try {
        if (group) signalGroup(child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (e) { killError = /** @type {Error} */ (e).message; }
      later(graceMs, giveUp);
    });
  });
}

/**
 * Whether a probe refuses the count: every fault of a set does, but one perf answered for in main's
 * whole set (it exited by itself, not within a bound's kill), which the count meets by repeating its
 * first load with user instructions alone, the set probed first; that is a note, not a refusal.
 * @param {string[]} names
 * @param {Parameters<typeof probeError>[1]} r
 * @returns {{ refuse: string | null, note: string | null }}
 */
export function probeVerdict(names, r) {
  const why = probeError(names, r);
  if (!why) return { refuse: null, note: null };
  const whole = names.join(",") === passEvents("main").join(",");
  return whole && !r.error ? { refuse: null, note: `${why}; the count repeats its first load with ${REQUIRED.main} alone` } : { refuse: why, note: null };
}

export function parsePerfCounts(/** @type {string} */ text) {
  const counts = new Map();
  for (const line of text.split("\n")) {
    const [value, , event, , , running] = line.split(",");
    // Some perf versions omit :u when displaying a generic cache event.
    const name = event === "L1-icache-load-misses" ? events.userL1iMissesPerRequest : event;
    if (!eventNames.includes(name)) continue;
    const raw = value.trim();
    const runningPct = /^\d+(?:\.\d+)?$/.test(running?.trim() ?? "") ? Number(running) : null;
    const count = /^\d+$/.test(raw) ? Number(raw) : null;
    counts.set(name, { count, runningPct, error: count === null ? raw || "missing count" : null });
  }
  return counts;
}

function countError(entry) {
  if (!entry) return "no perf row";
  if (entry.error) return entry.error;
  if (entry.runningPct === null) return "missing or invalid perf running percentage";
  return entry.runningPct === 100 ? null : `perf ran ${entry.runningPct}% of enabled time (need 100%)`;
}

/** The exit status of count.mjs when a perf it started was not seen to end: no further count runs on that host. */
export const HALT_EXIT = 4;

/** A perf whose end was not seen (no answer, or its output held open after it exited): the count stops, and so does the host's schedule. */
export class UnconfirmedPerf extends Error {}

const whole = (/** @type {unknown} */ x) => Number.isSafeInteger(x) && /** @type {number} */ (x) >= 0;

/**
 * A load's totals from its k6 summary: requests, failed requests and passed and failed status
 * checks, each null where the summary does not give it as a whole number.
 */
export function loadTotals(/** @type {any} */ summary) {
  const m = summary?.metrics;
  const of = (/** @type {unknown} */ x) => (whole(x) ? /** @type {number} */ (x) : null);
  return { requests: of(m?.http_reqs?.count), failed: of(m?.http_req_failed?.passes), checksPassed: of(m?.checks?.passes), checksFailed: of(m?.checks?.fails) };
}

/** Why a load's totals are not whole, or null: each given, and one status check for each request (`requests` the number it must have made, when given). */
function totalsError(/** @type {ReturnType<typeof loadTotals>} */ t, /** @type {number | undefined} */ requests) {
  const missing = Object.entries(t).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length) return `its k6 summary gives no ${missing.join(", ")}`;
  if (requests !== undefined && t.requests !== requests) return `${t.requests} requests, not ${requests}`;
  if (/** @type {number} */ (t.checksPassed) + /** @type {number} */ (t.checksFailed) !== t.requests) return `${t.checksPassed} passed and ${t.checksFailed} failed status checks across ${t.requests} requests`;
  return null;
}

/**
 * Both passes of one count. `collect(pass, instructionsOnly)` runs one load under perf with
 * `passEvents(pass, instructionsOnly)` and gives perf's output, its error, whether perf's end was
 * not seen (`unconfirmed`) and the load's k6 summary. A perf whose end was not seen stops the count
 * at once (UnconfirmedPerf): no retry and no next pass. The main pass is retried once with user
 * instructions alone when they are unusable and its load had no failures; the kernel pass counts
 * one event already, so it is not retried. Each load's request and status-check totals must be
 * whole (`expected.requests` requests each, when given); the kernel pass's load must also match the
 * main pass's request count and have no failures, since its count is not kept otherwise.
 * @param {(pass: "main" | "kernel", instructionsOnly: boolean) => any} collect
 * @param {(message: string) => void} warn
 * @param {{ requests?: number }} [expected]
 */
export async function measurePerfCounts(collect, warn, expected = {}) {
  const attempt = async (/** @type {"main" | "kernel"} */ pass, /** @type {boolean} */ instructionsOnly) => {
    const names = passEvents(pass, instructionsOnly);
    const { text = "", error, summary, unconfirmed } = await collect(pass, instructionsOnly);
    const load = pass === "kernel" ? "kernel instructions' load" : instructionsOnly ? "first load's repeat" : "first load";
    if (unconfirmed) throw new UnconfirmedPerf(`${load}: ${error || "perf was not seen to end"}; no further count runs on this host`);
    // Only the pass's own events are read from its output.
    const counts = new Map([...parsePerfCounts(text)].filter(([event]) => names.includes(event)));
    const reason = countError(counts.get(REQUIRED[pass]));
    const totals = loadTotals(summary);
    const requests = totals.requests ?? 0, failed = totals.failed ?? 0, checksFailed = totals.checksFailed ?? 0;
    return { load, totals, counts, requests, failed, checksFailed, error: error || (reason ? `${REQUIRED[pass]}: ${reason}` : null) || (requests ? null : "k6 made no requests") };
  };
  const requireWhole = (/** @type {Awaited<ReturnType<typeof attempt>>} */ run, /** @type {number | undefined} */ requests) => {
    const why = totalsError(run.totals, requests);
    if (why) throw new Error(`the ${run.load} is not whole: ${why}`);
  };
  // A retry can replace unusable counters, not failures observed under load.
  const noRetry = (/** @type {Awaited<ReturnType<typeof attempt>>} */ run, /** @type {string} */ load) => {
    if (run.failed || run.checksFailed) {
      throw new Error(`${load} had ${run.failed} HTTP request failures and ${run.checksFailed} failed status checks across ${run.requests} requests; not retrying (${run.error})`);
    }
  };
  let main = await attempt("main", false);
  if (main.error) {
    noRetry(main, "first load");
    // Drop optional events that may have prevented perf from starting or crowded out instructions.
    warn(`${main.error}; retrying with instructions only`);
    main = await attempt("main", true);
    if (main.error) throw new Error(`instructions-only perf failed: ${main.error}`);
  }
  requireWhole(main, expected.requests);
  const kernel = await attempt("kernel", false);
  if (kernel.error) {
    noRetry(kernel, "kernel instructions' load");
    throw new Error(`kernel instructions' perf failed: ${kernel.error}`);
  }
  requireWhole(kernel, main.requests);
  if (kernel.failed || kernel.checksFailed) throw new Error(`the kernel instructions' load had ${kernel.failed} HTTP request failures and ${kernel.checksFailed} failed status checks across ${kernel.requests} requests, so its count is not kept`);
  return countRow(main, kernel);
}

/**
 * One count's row: each count a request over its own pass's requests. `requests` and `failed` are
 * the main pass's load (the one the cycles are from); `kernelPass` is the kernel pass's.
 * @param {{ counts: Map<string, any>, requests: number, failed: number }} main
 * @param {{ counts: Map<string, any>, requests: number, failed: number }} kernel
 */
export function countRow(main, kernel) {
  const row = { requests: main.requests, failed: main.failed, kernelPass: { requests: kernel.requests, failed: kernel.failed } };
  const perfRunningPct = {};
  const perfDiagnostics = {};
  for (const [field, event] of Object.entries(events)) {
    const pass = field in PASSES.kernel ? kernel : main;
    const entry = pass.counts.get(event);
    const error = countError(entry);
    perfRunningPct[event] = entry?.runningPct ?? null;
    if (error) perfDiagnostics[event] = error;
    // perf already scales counts, so only normalize by the number of requests here.
    row[field] = error ? null : Math.round(entry.count / pass.requests);
  }
  return { ...row, perfRunningPct, perfDiagnostics };
}
