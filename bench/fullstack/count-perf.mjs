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

/**
 * The CPU flags perf is given, rebuilt from a checked form: `-a` (every CPU) or `-C` with a CPU
 * list (numbers and ranges, comma-separated), so nothing else (another `-e`) reaches perf's arguments.
 */
function cpuFlags(/** @type {unknown} */ cpus) {
  if (Array.isArray(cpus) && cpus.length === 1 && cpus[0] === "-a") return ["-a"];
  if (Array.isArray(cpus) && cpus.length === 2 && cpus[0] === "-C" && typeof cpus[1] === "string" && /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(cpus[1])) return ["-C", cpus[1]];
  throw new Error(`perf would be given CPUs ${JSON.stringify(cpus)}, not -a or -C with a CPU list`);
}

/** The most CPUs a count's CPU list may name. */
const MAX_CPUS = 4096;

/**
 * The CPUs a count's perf counts on, as numbers: the `-C` list, or for `-a` every online CPU
 * (`online`, as /sys/devices/system/cpu/online lists them). Each must give its own row (`-A`).
 */
export function selectedCpus(/** @type {unknown} */ cpus, /** @type {string | undefined} */ online) {
  const flags = cpuFlags(cpus);
  const list = (flags[0] === "-a" ? online : flags[1])?.trim();
  if (typeof list !== "string" || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(list)) throw new Error(`cannot tell which CPUs perf counts on: ${JSON.stringify(list ?? null)} is not a CPU list`);
  const out = new Set();
  for (const part of list.split(",")) {
    const [from, to = from] = part.split("-").map(Number);
    if (to < from || to - from >= MAX_CPUS || !Number.isSafeInteger(to)) throw new Error(`cannot tell which CPUs perf counts on: ${part} in ${list} is not a CPU range`);
    for (let cpu = from; cpu <= to; cpu += 1) out.add(cpu);
  }
  if (out.size > MAX_CPUS) throw new Error(`cannot tell which CPUs perf counts on: ${list} names more than ${MAX_CPUS}`);
  return [...out].sort((a, b) => a - b);
}

/**
 * The descriptors a count's perf reads its commands from and acknowledges them on (`--control`),
 * and how long it may take to acknowledge one before the count is given up.
 */
export const CONTROL_FD = 3, ACK_FD = 4, ACK_MS = 10_000;

/**
 * A count's perf: its events start disabled (`--delay=-1`) and are enabled and disabled by commands
 * on CONTROL_FD, each acknowledged on ACK_FD, so the count has perf's own word that it counted from
 * before its load started until after it ended. Each CPU's count is a row of its own (`-A`): perf
 * goes on past a CPU whose counter it could not enable, and its total sums the enabled and running
 * times of every CPU, so only each CPU's own times show it counted there (parsePerCpuCounts).
 */
export function perfCountArgs(/** @type {string[]} */ cpus, /** @type {string} */ cgroup, /** @type {string[]} */ names) {
  const flags = cpuFlags(cpus);
  supportedSet(names);
  // perf maps the cgroups to events in order; each event needs its own entry.
  return ["stat", ...flags, "-A", "-x", ",", "--log-fd", "1", "--delay=-1", `--control=fd:${CONTROL_FD},${ACK_FD}`, "-e", names.join(","), "-G", names.map(() => cgroup).join(",")];
}

/**
 * perf's acknowledgments on ACK_FD, each bound to the command it answers. perf is given one command
 * at a time, `command()` called before it is written, and must answer it with one `ack` line (perf
 * 6.1 writes "ack\n" and a NUL byte) before the next is given; an acknowledgment with no command
 * waiting for it, or anything else on the descriptor, is a fault (`error()`), and the count is not
 * kept. Part of a line still unended when a command is given (other than the NUL that follows an
 * "ack\n") is a fault too: it was written before that command, so it cannot answer it.
 * `command()` resolves "ack", "closed" (perf ended first), "timeout" (none within ackMs) or "fault". `end()` is called once perf has closed its descriptors, so nothing more can arrive.
 */
export function acknowledgments(ackMs = ACK_MS) {
  let partial = "", given = 0, heard = 0, ended = false;
  /** @type {string | null} */
  let fault = null;
  /** @type {{ resolve: (r: "ack" | "closed" | "timeout" | "fault") => void, timer: ReturnType<typeof setTimeout> } | null} */
  let waiting = null;
  const settle = (/** @type {"ack" | "closed" | "timeout" | "fault"} */ r) => {
    const w = waiting;
    if (!w) return;
    waiting = null;
    clearTimeout(w.timer);
    w.resolve(r);
  };
  const fail = (/** @type {string} */ why) => { fault ??= why; settle("fault"); };
  return {
    data(/** @type {string} */ chunk) {
      partial += chunk;
      for (let at; (at = partial.indexOf("\n")) >= 0;) {
        // The NUL perf writes after each "ack\n" begins the next line.
        const line = partial.slice(0, at).replace(/^\0+/, "");
        partial = partial.slice(at + 1);
        if (line !== "ack") fail(`perf wrote ${JSON.stringify(line.slice(0, 80))} on its acknowledgment descriptor, not an acknowledgment`);
        else if (++heard > given) fail(`perf acknowledged ${heard} commands where it had been given ${given}`);
        else settle("ack");
      }
    },
    end() {
      ended = true;
      if (partial.replace(/\0/g, "") !== "") fault ??= `perf left ${JSON.stringify(partial.slice(0, 80))} on its acknowledgment descriptor, not an acknowledgment`;
      settle("closed");
    },
    command() {
      if (waiting) throw new Error("a perf command is still waiting for its acknowledgment");
      given += 1;
      if (partial.replace(/\0/g, "") !== "") fail(`perf wrote ${JSON.stringify(partial.slice(0, 80))} on its acknowledgment descriptor before command ${given} was given`);
      return /** @type {Promise<"ack" | "closed" | "timeout" | "fault">} */ (new Promise((resolve) => {
        if (fault) return resolve("fault");
        if (ended) return resolve("closed");
        waiting = { resolve, timer: setTimeout(() => settle("timeout"), ackMs) };
      }));
    },
    error: () => fault,
  };
}

/**
 * The probe of one event set before the first count: the same CPUs and events over an idle second,
 * no cgroup, a row a CPU (`-A`) as a count asks, so each row is named as a count's will be (#2232).
 */
export function perfProbeArgs(/** @type {string[]} */ cpus, /** @type {string[]} */ names) {
  const flags = cpuFlags(cpus);
  supportedSet(names);
  return ["stat", ...flags, "-A", "-x", ",", "--log-fd", "1", "-e", names.join(","), "--", "sleep", "1"];
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
  const unread = unreadRows(names, r.stdout ?? "");
  if (unread.length) return `perf stat -e ${names.join(",")} printed a row for ${unread.map((e) => JSON.stringify(e)).join(", ")}, which a count does not read as an event of the set`;
  const { counts } = parsePerfCounts(r.stdout ?? "");
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
 * first load with user instructions alone, the set probed first; that is a note, not a refusal. A
 * row a count would not read is refused in every set: the repeat would leave it unread all the same.
 * @param {string[]} names
 * @param {Parameters<typeof probeError>[1]} r
 * @returns {{ refuse: string | null, note: string | null }}
 */
export function probeVerdict(names, r) {
  const why = probeError(names, r);
  if (!why) return { refuse: null, note: null };
  const whole = names.join(",") === passEvents("main").join(",");
  return whole && !r.error && !unreadRows(names, r.stdout ?? "").length ? { refuse: null, note: `${why}; the count repeats its first load with ${REQUIRED.main} alone` } : { refuse: why, note: null };
}

/**
 * The names perf prints the kit's one cache event by, `L1-icache-load-misses:u`: a legacy cache event
 * is named as it was given less its modifier, and with `-A`, from perf 6.8 on, with its PMU's name in
 * brackets, `cpu` on a CPU with one core PMU (#2232). The sets a count gives perf hold that one cache
 * event between them, so either name is it. Every other name is read as written, so a row under
 * another PMU's name (a hybrid CPU's `cpu_core/L1-icache-load-misses/`) or of an event the kit did
 * not ask for is none of its events.
 */
const L1I_ROWS = Object.freeze(["L1-icache-load-misses", "L1-icache-load-misses [cpu]"]);
const eventOf = (/** @type {string | undefined} */ event) => (event !== undefined && L1I_ROWS.includes(event) ? events.userL1iMissesPerRequest : event);

/**
 * A probe's counts from its rows a CPU (`-A -x ,` with no `-G`: CPU, count, unit, event, running time,
 * running percentage), named as a count's rows are. Only whether each event gave a count is read: a
 * whole count on every row of it. `unread` holds each name a row gave that is none of the kit's events.
 * @param {string} text
 */
export function parsePerfCounts(text) {
  /** @type {Map<string, { count: number | null, error: string | null }>} */
  const counts = new Map();
  /** @type {string[]} */
  const unread = [];
  for (const line of text.split("\n")) {
    const [cpu, value = "", , event] = line.split(",");
    if (!/^CPU\d+$/.test(cpu?.trim() ?? "") || event === undefined) continue;
    const name = eventOf(event);
    if (!eventNames.includes(name)) {
      if (!unread.includes(event)) unread.push(event);
      continue;
    }
    const raw = value.trim(), was = counts.get(name);
    const count = /^\d+$/.test(raw) ? Number(raw) : null;
    if (was?.count === null) continue;
    counts.set(name, count === null ? { count: null, error: raw || "missing count" } : { count: (was?.count ?? 0) + count, error: null });
  }
  return { counts, unread };
}

/** The names a probe's rows give that a count of `names` would not read as one of its events. */
function unreadRows(/** @type {string[]} */ names, /** @type {string} */ text) {
  const { counts, unread } = parsePerfCounts(text);
  return [...unread, ...[...counts.keys()].filter((e) => !names.includes(e))];
}

/**
 * perf's running percentage from its decimal text: its value (null when the text is not a decimal),
 * whether the text is above 100 and whether it is exactly 100, both read from the digits before
 * conversion, since a value a hair either side of 100 converts to exactly 100.
 * @param {string} text
 */
function percent(text) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return { pct: null, over: false, full: false };
  const whole = m[1].replace(/^0+(?=\d)/, ""), zeros = /^0*$/.test(m[2] ?? "");
  const over = Number(whole) > 100 || (whole === "100" && !zeros);
  return { pct: Number(text), over, full: whole === "100" && zeros };
}

/**
 * A count's counts from perf's rows a CPU (`-A -x , -G`: CPU, count, unit, event, cgroup, running
 * time in ns, running percentage), each event summed here over `cpus`, the CPUs perf was given. An
 * event is usable only when every one of those CPUs gave it exactly one row, with a whole count, a
 * running time above zero and a running percentage from 0 to 100, and no other CPU did: perf 6.1 goes on past a
 * CPU whose counter it could not enable, and its own total sums the times of every CPU, so a 100%
 * total does not show each CPU counted. A CPU the cgroup never ran on gives no running time either,
 * and is refused the same way, as it cannot be told apart. Its percentage is the lowest of its CPUs'.
 * @param {string} text
 * @param {number[]} cpus
 */
export function parsePerCpuCounts(text, cpus) {
  if (!Array.isArray(cpus) || !cpus.length || !cpus.every((c) => Number.isSafeInteger(c) && c >= 0)) throw new Error(`a count's CPUs are ${JSON.stringify(cpus)}, not a list of CPU numbers`);
  /** @type {Map<string, Map<number, { raw: string, count: number | null, run: number | null, pct: number | null, over: boolean, full: boolean, pctRaw: string, twice: boolean }>>} */
  const rows = new Map();
  for (const line of text.split("\n")) {
    const [cpuField, value = "", , event, , run, running] = line.split(",");
    const cpu = /^CPU(\d+)$/.exec(cpuField?.trim() ?? "");
    const name = eventOf(event);
    if (!cpu || !name || !eventNames.includes(name)) continue;
    const at = rows.get(name) ?? new Map();
    rows.set(name, at);
    const raw = value.trim(), n = Number(cpu[1]);
    at.set(n, {
      raw,
      count: /^\d+$/.test(raw) ? Number(raw) : null,
      run: /^\d+$/.test(run?.trim() ?? "") ? Number(run) : null,
      ...percent(running?.trim() ?? ""),
      pctRaw: running?.trim() ?? "",
      twice: at.has(n),
    });
  }
  const counts = new Map();
  for (const [name, at] of rows) {
    /** @type {string | null} */
    let error = null;
    let count = 0;
    /** @type {number | null} */
    let runningPct = 100;
    for (const cpu of at.keys()) if (!cpus.includes(cpu)) error ??= `a row for CPU ${cpu}, which perf was not given`;
    for (const cpu of cpus) {
      const r = at.get(cpu);
      if (!r) { error ??= `no row for CPU ${cpu}`; continue; }
      if (r.twice) error ??= `two rows for CPU ${cpu}`;
      if (r.count === null) error ??= `CPU ${cpu}: ${r.raw || "missing count"}`;
      else if (!r.run) error ??= `CPU ${cpu}: no running time, so perf is not shown to have counted there`;
      // A percentage above 100 is not one perf can mean; the lowest would read it as 100. Read from
      // its digits, as one a hair above or below 100 converts to exactly 100.
      if (r.over) error ??= `CPU ${cpu}: running percentage ${r.pctRaw} is outside 0 to 100`;
      else if (r.pct === 100 && !r.full) error ??= `CPU ${cpu}: running percentage ${r.pctRaw} is below 100 but converts to 100`;
      runningPct = r.pct === null || runningPct === null ? null : Math.min(runningPct, r.pct);
      count += r.count ?? 0;
    }
    if (!error && !Number.isSafeInteger(count)) error = `its CPUs' counts sum past 2^53 - 1`;
    counts.set(name, { count: error ? null : count, runningPct, error });
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
 * `passEvents(pass, instructionsOnly)` and gives perf's output (its rows a CPU, read over
 * `expected.cpus`, the CPUs perf was given), its error, whether perf's end was
 * not seen (`unconfirmed`), whether the load ran (`ranLoad`, false only where perf failed before
 * the load started; a load is taken to have run unless it says so) and the load's k6 summary. A
 * perf whose end was not seen stops the count at once (UnconfirmedPerf): no retry and no next pass.
 * Each load that ran must be whole (`expected.requests` requests, when given, and a status check
 * a request) before anything else is read from it, a retry included. The main pass is retried once
 * with user instructions alone when they are unusable and its load, if it ran, was whole with no
 * failures; the kernel pass counts one event already, so it is not retried. The kernel pass's load
 * must also match the main pass's request count and have no failures, since its count is not kept
 * otherwise; the main pass's load may fail no more status checks than requests, since its row
 * records only the requests.
 * @param {(pass: "main" | "kernel", instructionsOnly: boolean) => any} collect
 * @param {(message: string) => void} warn
 * @param {{ requests?: number, cpus: number[] }} expected
 */
export async function measurePerfCounts(collect, warn, expected) {
  // Checked before any load, so a count with no CPUs to read its rows over runs none.
  parsePerCpuCounts("", expected?.cpus);
  const attempt = async (/** @type {"main" | "kernel"} */ pass, /** @type {boolean} */ instructionsOnly) => {
    const names = passEvents(pass, instructionsOnly);
    const { text = "", error, summary, unconfirmed, ranLoad = true } = await collect(pass, instructionsOnly);
    const load = pass === "kernel" ? "kernel instructions' load" : instructionsOnly ? "first load's repeat" : "first load";
    if (unconfirmed) throw new UnconfirmedPerf(`${load}: ${error || "perf was not seen to end"}; no further count runs on this host`);
    // Only the pass's own events are read from its output.
    const counts = new Map([...parsePerCpuCounts(text, expected.cpus)].filter(([event]) => names.includes(event)));
    const reason = countError(counts.get(REQUIRED[pass]));
    const totals = loadTotals(summary);
    const requests = totals.requests ?? 0, failed = totals.failed ?? 0, checksFailed = totals.checksFailed ?? 0;
    return { load, ranLoad, totals, counts, requests, failed, checksFailed, error: error || (ranLoad ? null : "no load ran") || (reason ? `${REQUIRED[pass]}: ${reason}` : null) || (requests ? null : "k6 made no requests") };
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
  // A load that ran is whole or the count fails: a counter error does not buy a load short of its
  // requests a repeat. Only perf failing before any load started skips this.
  if (main.ranLoad) requireWhole(main, expected.requests);
  if (main.error) {
    noRetry(main, "first load");
    // Drop optional events that may have prevented perf from starting or crowded out instructions.
    warn(`${main.error}; retrying with instructions only`);
    main = await attempt("main", true);
    if (main.ranLoad) requireWhole(main, expected.requests);
    if (main.error) throw new Error(`instructions-only perf failed: ${main.error}`);
  }
  // The row records failed requests, not status checks: one that failed with its request not failed would not show.
  if (main.checksFailed > main.failed) throw new Error(`the ${main.load} had ${main.checksFailed} failed status checks where ${main.failed} of its ${main.requests} requests failed, so its count is not kept`);
  const kernel = await attempt("kernel", false);
  if (kernel.ranLoad) requireWhole(kernel, main.requests);
  if (kernel.error) {
    noRetry(kernel, "kernel instructions' load");
    throw new Error(`kernel instructions' perf failed: ${kernel.error}`);
  }
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
