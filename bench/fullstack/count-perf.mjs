import { spawn } from "node:child_process";

// The perf passes of one count. A Xeon Platinum 8358 guest stalls in its PMU code and stops as a
// whole when one perf session counts `instructions:u` and `instructions:k` together, with `-C` or
// `-p` (#2151), so no session here holds both: each count is two loads of the same requests, the
// first counting user instructions, both cycles and user L1i misses (the set bench/placement counts),
// the second kernel instructions alone. Both sets ran without a stall on such a host (measured on
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

/** Refuses an event list that would count user and kernel instructions in one perf session (#2151). */
function oneSession(/** @type {string[]} */ names) {
  if (names.includes("instructions:u") && names.includes("instructions:k")) {
    throw new Error(`perf would count instructions:u and instructions:k in one session (${names.join(",")}), which stops a Xeon Platinum 8358 guest (#2151)`);
  }
  return names;
}

export function perfCountArgs(/** @type {string[]} */ cpus, /** @type {string} */ cgroup, /** @type {string[]} */ names) {
  oneSession(names);
  // perf maps the cgroups to events in order; each event needs its own entry.
  return ["stat", ...cpus, "-x", ",", "--log-fd", "1", "-e", names.join(","), "-G", names.map(() => cgroup).join(",")];
}

/** The probe of one event set before the first count: the same CPUs and events, over an idle second, no cgroup. */
export function perfProbeArgs(/** @type {string[]} */ cpus, /** @type {string[]} */ names) {
  oneSession(names);
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
 * Runs a command to its end within a bound, and settles even where it never exits: past `timeoutMs`
 * it is killed, and `graceMs` after that it is given up (no answer) rather than waited out, so a
 * process stuck in the kernel cannot hold the count. Never throws; the result says what happened.
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, graceMs?: number, env?: Record<string, string | undefined>, start?: typeof spawn }} [options]
 * @returns {Promise<{ status: number | null, signal: string | null, stdout: string, stderr: string, error?: string, answered: boolean }>}
 */
export function runBounded(command, args, { timeoutMs = PROBE_MS, graceMs = GRACE_MS, env, start = spawn } = {}) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", settled = false, timedOut = false;
    /** @type {any} */
    let kill, giveUp;
    const done = (/** @type {any} */ r) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      clearTimeout(giveUp);
      resolve({ status: null, signal: null, stdout, stderr, answered: true, ...r });
    };
    let child;
    try { child = start(command, args, { env, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return done({ error: /** @type {Error} */ (e).message }); }
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => done({ error: e.message }));
    child.on("close", (status, signal) => done({ status, signal, ...(timedOut ? { error: `did not finish within ${timeoutMs / 1000} s` } : {}) }));
    kill = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    giveUp = setTimeout(() => {
      child.unref();
      child.stdout?.destroy();
      child.stderr?.destroy();
      done({ answered: false, error: `no answer: it did not finish within ${timeoutMs / 1000} s and had not exited ${graceMs / 1000} s after it was killed` });
    }, timeoutMs + graceMs);
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

/**
 * Both passes of one count. `collect(pass, instructionsOnly)` runs one load under perf with
 * `passEvents(pass, instructionsOnly)` and gives perf's output, its error and the load's k6 summary.
 * The main pass is retried once with user instructions alone when they are unusable and its load
 * had no failures; the kernel pass counts one event already, so it is not retried.
 */
export async function measurePerfCounts(collect, warn) {
  const attempt = async (/** @type {"main" | "kernel"} */ pass, instructionsOnly) => {
    const names = passEvents(pass, instructionsOnly);
    const { text, error, summary } = await collect(pass, instructionsOnly);
    // Only the pass's own events are read from its output.
    const counts = new Map([...parsePerfCounts(text)].filter(([event]) => names.includes(event)));
    const reason = countError(counts.get(REQUIRED[pass]));
    const requests = summary?.metrics.http_reqs?.count ?? 0;
    const failed = summary?.metrics.http_req_failed?.passes ?? 0;
    const checksFailed = summary?.metrics.checks?.fails ?? 0;
    return { counts, requests, failed, checksFailed, error: error || (reason ? `${REQUIRED[pass]}: ${reason}` : null) || (requests ? null : "k6 made no requests") };
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
  const kernel = await attempt("kernel", false);
  if (kernel.error) {
    noRetry(kernel, "kernel instructions' load");
    throw new Error(`kernel instructions' perf failed: ${kernel.error}`);
  }
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
