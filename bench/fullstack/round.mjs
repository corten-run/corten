// The parts of a round that run-all.mjs and droplet.mjs share and round.test.mjs tests: the
// steps, run-all.mjs's calls with their time limits, where a stopped round goes on, and the systemd
// unit a round runs under on a droplet. No side effects.
import { fstatSync, readSync, writeSync } from "node:fs";
import { HALT_EXIT } from "./count-perf.mjs";

/** run-all.mjs's steps, in order. The builds come last, so a slow one costs no other step its time. */
export const steps = ["cold-start", "fixture", "api", "count", "conform", "browser", "build"];

/**
 * How long the build step may run, all apps together (minutes): it starts no app's build past this,
 * and skips the rest, so the round ends within its unit's hours. r14, the first droplet round
 * with builds, took 44.5 minutes for all eighteen apps (Leptos the longest, 14.2), so this is
 * about five times what a round needs (it was 420, set from a loaded desktop, until r14 measured
 * it), and only a hung or far slower build reaches it: two hung builds, stopped at 90 minutes
 * each, and the rest at r14's pace come to about 210. With the other limits and nineteen apps the
 * unit's hours allow at most 257 (round.test.mjs checks). Counted from each start, as
 * the unit's hours are: after a restart in the build step only builds are left, and a fresh
 * budget still fits the fresh hours.
 */
export const buildBudgetMinutes = 240;

/**
 * The apps that compile to native code build first, so a budget that runs out drops the
 * interpreted apps, whose builds are short and change little, rather than the stacks Corten is
 * most like.
 */
export const compiledFirst = ["corten", "leptos", "topcoat", "axum-maud", "gin", "drogon"];

/**
 * Why a round's name does not fit its tier, or null. A full round of the defaults tier is r<n>,
 * the rounds trend.mjs reads; a full round of the matched tier is m<n>, so its numbers, measured
 * with the production profile, never enter the defaults tier's trend. A step run on its own (one
 * app measured again, a matrix alone) may use another name, as the defaults tier's experiments do,
 * but never writes the matched tier's numbers into an r<n> round or the defaults' into an m<n>.
 * @param {string} round
 * @param {string} tier "defaults" or "matched"
 * @param {{ full?: boolean }=} options full: run-all.mjs, summarize.mjs and droplet.mjs, which
 *   make or read a whole round
 */
export const roundNameError = (round, tier, { full = false } = {}) => {
  if (tier === "matched") {
    if (/^m\d+$/.test(round)) return null;
    if (full || /^r\d+$/.test(round)) return `a matched-tier round is named m<n> (m1), not ${round}, so the defaults tier's trend (r<n>) never reads it`;
    return null;
  }
  return /^m\d+$/.test(round) ? `${round} is a matched-tier round's name (m<n>): run it with BENCH_TIER=matched (droplet.mjs --tier matched), or name it otherwise` : null;
};

/**
 * The steps run-all.mjs runs from `from` through `until`, or why that range has none.
 * @param {string} from
 * @param {string} until
 * @returns {{ steps: string[], error: string | null }}
 */
export const stepsUntil = (from, until) => {
  const start = steps.indexOf(from);
  const end = steps.indexOf(until);
  if (start < 0 || end < 0) return { steps: [], error: `from and until must each be one of ${steps.join(", ")}` };
  if (end < start) return { steps: [], error: `until (${until}) comes before from (${from})` };
  return { steps: steps.slice(start, end + 1), error: null };
};

/**
 * The steps droplet.mjs's browser suite runs with run-all.mjs: the browser step alone (parity, look,
 * bytes, browser timing), then bench/browser's pass. Not the build step after it: in round browser-4
 * (2026-11-11, a c-8; its log, not committed, as the round stopped there) build.mjs took 11, 22 and
 * 8 minutes for Corten, Leptos and topcoat, the first three it builds, and the builds' budget
 * (buildBudgetMinutes) with the browser step does not fit the suite's three-hour unit.
 */
export const browserSuite = { from: "browser", until: "browser" };

/**
 * Why a droplet.mjs suite cannot start with this fixtures/items.json, or null. The full-stack,
 * browser and hardening rounds serve their items from it (the item API, harden's item server) and
 * git does not keep it, so a fresh checkout has none; the live suite has no items. A file that is
 * empty or not JSON with the items the rounds load (item_1) fails the same way. It refuses two
 * cases that could run: a round going on from the build step, which reads no items, and one going
 * on with --host on a droplet that still has an earlier upload's file.
 * @param {string} suite fullstack, live, browser or harden
 * @param {string | null} text the file's contents, or null when there is none
 */
export const fixtureError = (suite, text) => {
  if (suite === "live") return null;
  const round = `a ${{ fullstack: "full-stack", harden: "hardening" }[suite] ?? suite} round`;
  const how = "Copy one from a checkout that has it, or write it with node bench/fullstack/fixtures/fetch.mjs from a rust-item-detail API on :18400 (not in this repository; bench/fullstack/README.md, Running it, and REVIEW.md)";
  if (text === null) return `bench/fullstack/fixtures/items.json is missing: ${round} serves its items from it, and git does not keep it. ${how}`;
  let items;
  try { items = JSON.parse(text); } catch { items = null; }
  if (!items || typeof items !== "object" || !("item_1" in items)) return `bench/fullstack/fixtures/items.json is empty, not JSON or has no item_1, so ${round}'s item API cannot serve it. ${how}`;
  return null;
};

/** The minutes run-all.mjs may wait for each app to start before the browser step. */
export const startMinutes = 2;

/**
 * The hours a full-stack round's unit may run (droplet.mjs): every call's limit, the waits for the
 * apps to start and the build budget fit in it (round.test.mjs checks). r14 ran in 6.3 hours, from
 * cold start to its summary. 23 from #813, whose mixed phase gave the api page call 80 minutes more.
 */
export const fullstackHours = 23;

/** The minutes each of run-ssr.mjs's four calls may take for one pass (`calls`). */
const ssrLimits = [140, 150, 220, 150];

/**
 * The hours a full-stack round of `passes` load passes may run: `fullstackHours`, and each pass
 * after the first adds its run-ssr.mjs calls' limits (round.test.mjs checks they fit).
 * @param {number} passes
 */
export const hoursFor = (passes) => fullstackHours + Math.ceil(((passes - 1) * ssrLimits.reduce((a, b) => a + b, 0)) / 60);

/** How long an unattended call may write nothing before it is stopped (the longest quiet stretch in r5-r8 was 26 minutes, in count.mjs). */
export const idleMinutes = 60;

/** After a call's process exits, how long run-all.mjs waits for its output to close before it releases it (superviseCall). */
export const outputReleaseMs = 10_000;

/** After a stopped call is sent SIGTERM, how long before SIGKILL (superviseCall). */
export const killGraceMs = 30_000;

/**
 * Watches one of run-all.mjs's calls, `child` (spawned detached when unattended, so it leads its
 * own process group, whose ID is its PID), and resolves to its exit code and, when it was stopped
 * or its output released, why. Past `limitMs`, or quiet for `idleMs`, it is stopped: SIGTERM to
 * its group, then SIGKILL after `graceMs`, each sent from a timer only while the call's process
 * has not been reaped (an unreaped leader, even a zombie, keeps the group's number its own; once
 * reaped, the number may be another group's, so it is never signalled again).
 *
 * It settles on the process's exit, not on its output closing: something it started (a detached
 * descendant, or a group member that outlived it) can hold the output open after it exits, and
 * `close` then never comes. The output gets `releaseMs` after the exit to close; then it is
 * destroyed and the call settles with its exit code and a reason, so a released output never
 * reads as a clean success. A stopped call whose process does not exit at all is released
 * `graceMs + releaseMs` after the stop, left running unreferenced, and settles the same way,
 * with `live` true: its stop was not confirmed, and the caller starts no more work on the host
 * (runSteps, buildStep). A process that could not be started (it has no PID; Node sets its exit
 * code before the error comes) settles with a reason, never as an exit.
 * The effects are passed in so round.test.mjs runs this with its own.
 * @param {import("node:events").EventEmitter & { pid?: number, exitCode: number | null, signalCode: string | null, stdout?: any, stderr?: any, unref: () => void }} child
 * @param {{
 *   label: string,
 *   limitMs: number,
 *   idleMs: number,
 *   signalGroup: (pid: number, signal: NodeJS.Signals) => void,
 *   write: (chunk: Buffer) => void,
 *   tickMs?: number,
 *   graceMs?: number,
 *   releaseMs?: number,
 * }} options
 * @returns {Promise<{ stopped: string | null, code: number | null, live: boolean }>}
 */
export function superviseCall(child, { label, limitMs, idleMs, signalGroup, write, tickMs = 15_000, graceMs = killGraceMs, releaseMs = outputReleaseMs }) {
  return new Promise((done) => {
    const started = Date.now();
    let heard = started;
    /** @type {string | null} */
    let stopped = null;
    /** @type {number | null} */
    let code = null;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let grace;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let release;
    let live = false;
    const reaped = () => child.exitCode !== null || child.signalCode !== null;
    // Checked and sent in one step, from a timer: never for a process already reaped.
    const signal = (/** @type {NodeJS.Signals} */ s) => {
      if (reaped() || !child.pid) return;
      try { signalGroup(child.pid, s); } catch {}
    };
    const settle = (/** @type {string | null} */ why) => {
      if (settled) return;
      settled = true;
      clearInterval(watch); clearTimeout(grace); clearTimeout(release);
      done({ stopped: stopped && why ? `${stopped}; ${why}` : stopped ?? why, code, live });
    };
    const arm = (/** @type {number} */ ms) => {
      if (release !== undefined) return;
      release = setTimeout(() => {
        const running = !reaped();
        child.stdout?.destroy(); child.stderr?.destroy();
        if (running) { child.unref(); live = true; }
        settle(running ? `${label} was still running ${Math.round(ms / 1000)} s after it was stopped, so it was left and its output released`
          : `${label} exited ${code ?? child.signalCode} but its output stayed open ${Math.round(ms / 1000)} s after, so it was released`);
      }, ms);
    };
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (/** @type {Buffer} */ chunk) => { heard = Date.now(); write(chunk); });
    const watch = Number.isFinite(limitMs) || Number.isFinite(idleMs) ? setInterval(() => {
      if (stopped || reaped()) return;
      if (Date.now() - started > limitMs) stopped = `${label} ran longer than ${Math.round(limitMs / 60_000)} minutes, so it was stopped`;
      else if (Date.now() - heard > idleMs) stopped = `${label} printed nothing for ${Math.round(idleMs / 60_000)} minutes, so it was stopped`;
      else return;
      signal("SIGTERM");
      grace = setTimeout(() => signal("SIGKILL"), graceMs);
      arm(graceMs + releaseMs);
    }, tickMs) : undefined;
    child.on("exit", (exit) => {
      code = exit;
      clearInterval(watch); clearTimeout(grace);
      clearTimeout(release); release = undefined;
      arm(releaseMs);
    });
    child.on("close", (exit) => { code ??= exit; settle(null); });
    // A process that could not be started: no PID, and no exit comes, only this and its close. Node
    // has already set its exit code (a negative errno), so the PID alone tells it from an exit.
    child.on("error", (/** @type {Error} */ e) => { if (child.pid === undefined) settle(`${label} could not be started: ${e.message}`); });
  });
}

/** Where an app's build comes in the build step: the compiled apps first, the rest as given. */
const rank = (/** @type {string} */ name) => (compiledFirst.includes(name) ? compiledFirst.indexOf(name) : compiledFirst.length);

/**
 * run-all.mjs's calls, in order, as [step, limit in minutes, script, ...arguments]. Unattended, a
 * call still running at its limit is stopped and the rest of its step skipped. The limits are at
 * least twice the longest each call took in r14, with eighteen apps: cold start 12 minutes, each
 * run-ssr.mjs call 66 to 69 (the JSON calls have 150, since they take the JSON-only apps too:
 * nineteen with aspnet-aot, about 72, estimated by app count), count 33, look.mjs 3.2, browser
 * timing 14.7, the others under a minute, and build.mjs, one call an app, at most 14.2 (Leptos),
 * against its 90. The api page call has 220: from #813 it ends each app with the mixed phase, its
 * 60 s, up to 60 s for the answers still to come after it and the page and one post before it,
 * about 2 minutes an app, so about 105 with eighteen (estimated). conform.mjs, new after r14, took about 2.8 minutes an app locally (two apps in
 * 340 s, Docker Desktop on a busy machine), so nineteen about 55 (estimated): it has 120. A build
 * call that is stopped skips only its app.
 * With twenty apps (FastAPI and Express, added after r16), the same per-app estimates put the
 * fixture page call at about 74 of its 140 minutes (1.9 times, not twice) and the others within
 * their limits.
 * @param {string} round
 * @param {string} browserRuns
 * @param {string[]} names the apps that render the pages (they serve the JSON too)
 * @param {string[]} urls where the browser step reaches each, in the same order (the matched tier's through the edge)
 * @param {string[]} [jsonOnly] the apps that serve only the JSON (`pages: false`)
 * @param {number} [passes] each load phase's passes (run-ssr.mjs): its calls' limits are that many
 *   times one pass's
 * @param {string[]} [pageOnly] page apps left out of the JSON phases (another app serves their JSON)
 * @returns {[string, number, string, ...string[]][]}
 */
export const calls = (round, browserRuns, names, urls, jsonOnly = [], passes = 1, pageOnly = []) => [
  ["cold-start", 30, "cold-start.mjs", round, "10", [...names, ...jsonOnly].join(",")],
  ["fixture", ssrLimits[0] * passes, "run-ssr.mjs", round, "fixture", "300", names.join(","), "page", String(passes)],
  ["fixture", ssrLimits[1] * passes, "run-ssr.mjs", round, "fixture", "300", [...names.filter((n) => !pageOnly.includes(n)), ...jsonOnly].join(","), "json", String(passes)],
  ["api", ssrLimits[2] * passes, "run-ssr.mjs", round, "api", "150", names.join(","), "page", String(passes)],
  ["api", ssrLimits[3] * passes, "run-ssr.mjs", round, "api", "150", [...names.filter((n) => !pageOnly.includes(n)), ...jsonOnly].join(","), "json", String(passes)],
  ["count", 70, "count.mjs", round, "3", [...names, ...jsonOnly].join(",")],
  // The feature matrix from the round's own images, before the browser step starts every app.
  ["conform", 120, "conform.mjs", [...names, ...jsonOnly].join(","), round],
  ["browser", 10, "parity.mjs"],
  ["browser", 15, "look.mjs"],
  ["browser", 10, "bytes.mjs", round],
  ["browser", 30, "browser.mjs", ...names.map((n, i) => `${n}=${urls[i]}`), `runs=${browserRuns}`, `out=${round}/browser.json`],
  ...[...names].sort((a, b) => rank(a) - rank(b)).map((n) => /** @type {[string, number, string, ...string[]]} */ (["build", 90, "build.mjs", round, n])),
];

/**
 * Where a round goes on from, read from its progress file: "<time> boot" each time run-all.mjs
 * starts (before it does anything else), "<time> start <step>", "<time> end <step>", and
 * "<time> finished" or "<time> failed" at the end. `boots` counts the starts so far.
 * `skip` is the step that was running when the round stopped (its host restarted: a lockup
 * panics the kernel, which reboots it, or it was power-cycled); it is not run again. `next` is the
 * step to run next, or null when only the summary is left.
 *
 * The build step is one app at a time, each started with "<time> build <app>": a restart in it
 * goes on in the same step, and `built` lists the apps whose builds started (each finished, failed
 * or was running at the restart, and none is built again); `skip` is then "build" and `app` the
 * app that was building, the only one skipped. `app` is null otherwise.
 * @param {string} progress
 * @param {string} from the step the round started at
 */
export function resumeAt(progress, from = steps[0]) {
  /** @type {string | null} */
  let running = null;
  let next = steps.indexOf(from);
  let boots = 0;
  /** @type {"finished" | "failed" | null} */
  let ended = null;
  /** @type {string[]} */
  const built = [];
  for (const line of progress.split("\n")) {
    const [, what, step] = line.trim().split(" ");
    if (what === "build" && step && running === "build") built.push(step);
    else if (what === "start" && steps.includes(step)) running = step;
    else if (what === "end" && steps.includes(step)) { running = null; next = steps.indexOf(step) + 1; }
    else if (what === "boot") boots += 1;
    else if (what === "finished" || what === "failed") ended = what;
  }
  if (running === "build") return { ended, skip: built.length ? "build" : null, app: built.at(-1) ?? null, next: "build", boots, built };
  if (running) next = steps.indexOf(running) + 1;
  return { ended, skip: running, app: null, next: steps[next] ?? null, boots, built };
}

/**
 * Why a round that starts again may not go on past its count step, or null. A count step that
 * started and did not end may have left a `perf` or probe counting (countHalt), as when run-all.mjs
 * itself was killed in it: a reboot ends them, a start of run-all.mjs again in the same boot does
 * not, and the clean slate cannot tell the two apart. run-all.mjs writes the boot's ID
 * (/proc/sys/kernel/random/boot_id) on the step's start line, "<time> start count <boot ID>", so
 * the round goes on only where that step started in another boot, known by its ID.
 * @param {string} progress the progress file as resumeAt reads it
 * @param {string | null} bootId this boot's ID, or null where it cannot be read
 */
export function countRestartError(progress, bootId) {
  // A last line with no end is a write cut short (appendLine), which may have been the count
  // step's start: what it was is not known, so it is read as a count step that did not end.
  if (progress.length && !progress.endsWith("\n")) return "the round's progress file ends in a line cut short, so whether its count step started is not known and a perf or probe that step started may still run; nothing more runs on this host";
  /** @type {string | null} */
  let running = null;
  /** @type {string | undefined} */
  let started;
  for (const line of progress.split("\n")) {
    const [, what, step, boot] = line.trim().split(" ");
    if (what === "start" && steps.includes(step)) { running = step; started = boot; }
    else if (what === "end" && steps.includes(step)) running = null;
  }
  if (running !== "count") return null;
  const why = !started || !BOOT_ID.test(started) ? "its count step's start recorded no boot ID"
    : !bootId || !BOOT_ID.test(bootId) ? "this boot's ID cannot be read"
    : started === bootId ? "it started again in the boot its count step started in" : null;
  return why && `the round stopped in its count step and ${why}, so a perf or probe that step started may still run; nothing more runs on this host`;
}
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The script droplet.mjs runs on a droplet before it starts a round there, before it removes
 * anything an earlier round of that name left (its progress file, or all of /bench). It disables
 * and stops the round's unit, so a reboot cannot start the old round again while the new one is
 * set up, and fails unless the unit is then inactive (or failed) with no process left in its
 * control group: a stop that did not take leaves the old round running. Then it prints this boot's
 * ID and the full-stack round's progress file, base64 ("present <base64>", or "absent"), which
 * relaunchError reads.
 * @param {string} unitName the round's unit, without ".service"
 * @param {string} progressFile the full-stack round's progress file on the droplet
 */
export const relaunchCustody = (unitName, progressFile) => {
  const service = quote(`${unitName}.service`);
  return [
    `systemctl disable --quiet ${service} >/dev/null 2>&1 || true`,
    `systemctl stop ${service} >/dev/null 2>&1 || true`,
    `state=$(systemctl show -p ActiveState --value ${service})`,
    `case "$state" in inactive|failed) ;; *) echo "unit ${unitName} is $state after its stop" >&2; exit 1 ;; esac`,
    // A cgroup file's size reads 0, so its content is read.
    `cg=$(systemctl show -p ControlGroup --value ${service})`,
    `if [ -n "$cg" ] && [ -e "/sys/fs/cgroup$cg/cgroup.procs" ] && [ -n "$(cat "/sys/fs/cgroup$cg/cgroup.procs")" ]; then echo "unit ${unitName} still has processes after its stop" >&2; exit 1; fi`,
    "cat /proc/sys/kernel/random/boot_id || exit 1",
    `if [ -e ${quote(progressFile)} ]; then printf 'present '; base64 -w0 < ${quote(progressFile)} || exit 1; echo; else echo absent; fi`,
  ].join("\n");
};

/**
 * Why a round may not start again on a droplet it ran on, read from relaunchCustody's output, or
 * null: countRestartError on the progress file as the droplet holds it, before anything clears it,
 * so a count step that started in this boot and did not end (a perf it started may still run) is
 * refused as run-all.mjs would refuse it. Output that does not read as relaunchCustody's is
 * refused too: what the progress file holds is then not known.
 * @param {string} output
 */
export function relaunchError(output) {
  const read = /^([^\n]*)\n(?:absent|present ([A-Za-z0-9+/]*={0,2}))\n?$/.exec(output.replaceAll("\r\n", "\n"));
  const bytes = read?.[2] === undefined ? Buffer.alloc(0) : Buffer.from(read[2], "base64");
  if (!read || (read[2] !== undefined && bytes.toString("base64") !== read[2])) {
    return "the droplet's boot ID and the round's progress file could not be read, so whether a perf or probe its count step started may still run is not known";
  }
  return countRestartError(bytes.toString("utf8"), read[1].trim() || null);
}

/**
 * Appends `line` and its newline to the progress file open on `fd` (read and append, "a+"), every
 * byte of it, or throws: `write` (writeSync) may write fewer bytes than it was given, and is called
 * again for the rest, and one that writes none, or throws, leaves the line cut short and this
 * throws, so a step whose start was not written whole is not started. A last line a write before
 * this one cut short is ended first, so this line, "failed" included, is read on its own; until
 * then countRestartError reads that cut line as a count step that did not end. The caller syncs.
 * @param {number} fd
 * @param {string} line
 * @param {(fd: number, buffer: Buffer, offset: number, length: number) => number} [write]
 */
export function appendLine(fd, line, write = writeSync) {
  const { size } = fstatSync(fd);
  const last = Buffer.alloc(1);
  const cut = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
  const bytes = Buffer.from(`${cut ? "\n" : ""}${line}\n`, "utf8");
  for (let at = 0; at < bytes.length;) {
    const n = write(fd, bytes, at, bytes.length - at);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`the progress line ${JSON.stringify(line)} was cut short: ${at} of its ${bytes.length} bytes were written`);
    at += n;
  }
}

/**
 * The apps whose build calls are in `all` and not in `built`, in the order they run: what the
 * build step has left.
 * @param {ReturnType<typeof calls>} all
 * @param {string[]} built
 */
export const buildsLeft = (all, built) => all.filter(([step]) => step === "build").map((c) => String(c.at(-1))).filter((app) => !built.includes(app));

/**
 * run-all.mjs's build step: each build call in `all` in turn, one app's, skipping the apps in
 * `built` (their builds started before a restart) and starting none once the step has run past
 * `buildBudgetMinutes`, when it skips the rest, naming them. A call stopped at its limit, or one
 * whose build.mjs exited with an error (build.mjs records an app's failed step itself and exits 0,
 * so an error exit means it could not), skips that app alone and asks for `reset` (a clean slate:
 * the containers and images it left); the next app's build goes on. `built` gets each app as its
 * build starts, after `progress` has recorded it, so a restart during it skips that app. The
 * effects are run-all.mjs's, passed in, so round.test.mjs runs this loop itself.
 * @param {ReturnType<typeof calls>} all
 * @param {string[]} built
 * @param {{
 *   minutes: () => number,
 *   call: (limit: number, args: string[]) => Promise<{ stopped: string | null, code: number | null, live?: boolean }>,
 *   progress: (what: string) => void,
 *   skip: (step: string, why: string) => void,
 *   reset: () => void,
 * }} effects `minutes` since the step started
 */
export async function buildStep(all, built, { minutes, call, progress, skip, reset }) {
  for (const [step, limit, ...args] of all) {
    if (step !== "build") continue;
    const app = String(args.at(-1));
    if (built.includes(app)) continue;
    if (minutes() > buildBudgetMinutes) {
      skip("build", `the builds ran past ${buildBudgetMinutes} minutes, so these were not built: ${buildsLeft(all, built).join(", ")}`);
      return;
    }
    progress(`build ${app}`);
    built.push(app);
    const result = await call(limit, args);
    leftRunning("build", result, skip);
    const { stopped, code } = result;
    if (stopped) {
      skip("build", `${stopped} (${app}; the next app's build goes on)`);
      reset();
    } else if (code !== 0) {
      skip("build", `build.mjs ${code === null ? "was killed by a signal" : `exited with ${code}`} for ${app}, so its results may be missing; the next app's build goes on`);
      reset();
    }
  }
}

/**
 * Stops the round where a call was left running (superviseCall's `live`): it was stopped and not
 * seen to exit, so it may still hold the host's cores, containers or counters, and no clean slate,
 * later call or step may run beside it. Records why as `step`'s skip and throws.
 * @param {string} step
 * @param {{ stopped: string | null, live?: boolean }} result
 * @param {(step: string, why: string) => void} skip
 */
function leftRunning(step, { stopped, live }, skip) {
  if (!live) return;
  const why = stopped ?? "a call was left running";
  skip(step, `${why}, so the round stops here and nothing more runs on this host`);
  throw new Error(`${why}; the round stopped in its ${step} step`);
}

/**
 * Why a count call's end stops the round, or null. count.mjs exits HALT_EXIT when a perf it started
 * was not seen to end; a count call stopped by run-all.mjs (past its limit or quiet too long) or
 * killed by a signal ended before count.mjs could see its perfs end, and the probe's runs in a
 * process group of its own, which that stop does not reach. Either may leave a perf counting or
 * stuck in the kernel, so nothing more runs on the host. Any other exit, an error included, is
 * count.mjs's after it saw every perf it started end.
 * @param {{ stopped: string | null, code: number | null }} result
 */
export function countHalt({ stopped, code }) {
  if (code === HALT_EXIT) return `count.mjs exited ${HALT_EXIT}: a perf it started was not seen to end`;
  if (stopped) return `${stopped}, before count.mjs saw every perf it started end`;
  if (code === null) return "count.mjs was killed by a signal before it saw every perf it started end";
  return null;
}

/**
 * run-all.mjs's steps in `list` and then the summary. A call stopped at its limit skips the rest of
 * its step and asks for `reset`; `build` runs the build step (buildStep), `open` and `close` start
 * and stop what a step needs (the browser step's apps; `open` gives why browser.mjs cannot run, or
 * null), and `done` is called once the summary has run, before the round is recorded finished. A
 * count call whose end stops the round (countHalt), or any call left running after its stop
 * (superviseCall's `live`), stops it there: the reason is recorded as the step's skip, and no later
 * call, clean slate, step or summary runs, nor is the step's end or the round's finish recorded; this throws, and run-all.mjs records the round failed, which it does not
 * start again (resumeAt). The effects are run-all.mjs's, passed in, so round.test.mjs runs this
 * loop itself.
 * @param {string[]} list
 * @param {ReturnType<typeof calls>} all
 * @param {{
 *   call: (limit: number, args: string[]) => Promise<{ stopped: string | null, code: number | null, live?: boolean }>,
 *   progress: (what: string) => void,
 *   skip: (step: string, why: string) => void,
 *   reset: () => void,
 *   build: (started: number) => Promise<void>,
 *   open: (step: string) => Promise<string | null>,
 *   close: (step: string) => void,
 *   linux: boolean,
 *   clock: () => number,
 *   summary: string[],
 *   done: () => void,
 * }} effects
 */
export async function runSteps(list, all, { call, progress, skip, reset, build, open, close, linux, clock, summary, done }) {
  for (const step of list) {
    if (step === "count" && !linux) continue;
    progress(`start ${step}`);
    // The matched tier's browser timing reaches the apps through the edge: without it, only
    // browser.mjs is skipped (parity, look and bytes reach the apps directly).
    const edgeFailed = await open(step);
    if (edgeFailed) skip(step, `browser.mjs: ${edgeFailed}`);
    if (step === "build") await build(clock());
    else for (const [, limit, ...args] of all.filter(([s, , script]) => s === step && !(edgeFailed && script === "browser.mjs"))) {
      const result = await call(limit, args);
      leftRunning(step, result, skip);
      const halt = step === "count" ? countHalt(result) : null;
      if (halt) {
        skip(step, `${halt}, so the round stops here and nothing more runs on this host`);
        throw new Error(`${halt}; the round stopped in its count step`);
      }
      if (result.stopped) {
        skip(step, result.stopped);
        reset();
        break;
      }
    }
    close(step);
    progress(`end ${step}`);
  }
  progress("start summary");
  // A round whose summary failed has not finished.
  const result = await call(10, summary);
  leftRunning("summary", result, skip);
  if (result.stopped || result.code !== 0) throw new Error(result.stopped ?? `summarize.mjs exited with ${result.code}`);
  done();
  progress("finished");
}

/**
 * Whether a round that has started `boots` times may start again: at most once a step and twice
 * more. A restart skips the step that was running, or in the build step the one app, so a round
 * could go on restarting through the builds; one that has restarted this often is broken, and
 * stops.
 */
export const mayStart = (/** @type {number} */ boots) => boots + 1 <= steps.length + 2;

/** A single-quoted shell word. */
export const quote = (/** @type {string} */ text) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The systemd unit a round runs under on a droplet, so it needs no connection to the machine that
 * started it: it runs `script` with bash and appends everything it prints to `log`. With
 * `atBoot` it starts again when the droplet restarts (run-all.mjs --unattended then goes on).
 * systemd stops it, and everything it started, after `hours` (each start counts afresh).
 * @param {{ description: string, script: string, log: string, atBoot: boolean, hours: number }} options
 */
export function unit({ description, script, log, atBoot, hours }) {
  if (!(hours > 0)) throw new Error("a unit needs a time limit");
  // systemd reads % and $ in these lines itself, and a line break would end one.
  if ([description, script, log].some((v) => /[%$\n]/.test(v))) throw new Error("a unit value may not contain %, $ or a line break");
  return [
    "[Unit]",
    `Description=${description}`,
    "Wants=docker.service",
    "After=docker.service",
    "",
    "[Service]",
    "Type=exec",
    "Environment=HOME=/root",
    `ExecStart=/bin/bash ${script}`,
    `RuntimeMaxSec=${Math.round(hours * 3600)}`,
    `StandardOutput=append:${log}`,
    "StandardError=inherit",
    ...(atBoot ? ["", "[Install]", "WantedBy=multi-user.target"] : []),
    "",
  ].join("\n");
}
