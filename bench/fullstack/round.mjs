// The parts of a round that run-all.mjs and droplet.mjs share and round.test.mjs tests: the
// steps, run-all.mjs's calls with their time limits, where a stopped round goes on, and the systemd
// unit a round runs under on a droplet. No side effects.

/** run-all.mjs's steps, in order. The builds come last, so a slow one costs no other step its time. */
export const steps = ["cold-start", "fixture", "api", "count", "browser", "build"];

/**
 * How long the build step may run, all apps together (minutes): it starts no app's build past this,
 * and skips the rest, so the round ends within its unit's hours. r14, the first droplet round
 * with builds, took 44.5 minutes for all eighteen apps (Leptos the longest, 14.2), so this is
 * about five times what a round needs (it was 420, set from a loaded desktop, until r14 measured
 * it), and only a hung or far slower build reaches it: two hung builds, stopped at 90 minutes
 * each, and the rest at r14's pace come to about 210. With the other limits and nineteen apps the
 * unit's hours allow at most 377 (round.test.mjs checks). Counted from each start, as
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

/** The minutes run-all.mjs may wait for each app to start before the browser step. */
export const startMinutes = 2;

/**
 * The hours a full-stack round's unit may run (droplet.mjs): every call's limit, the waits for the
 * apps to start and the build budget fit in it (round.test.mjs checks). r14 ran in 6.3 hours, from
 * cold start to its summary.
 */
export const fullstackHours = 21;

/** How long an unattended call may write nothing before it is stopped (the longest quiet stretch in r5-r8 was 26 minutes, in count.mjs). */
export const idleMinutes = 60;

/** Where an app's build comes in the build step: the compiled apps first, the rest as given. */
const rank = (/** @type {string} */ name) => (compiledFirst.includes(name) ? compiledFirst.indexOf(name) : compiledFirst.length);

/**
 * run-all.mjs's calls, in order, as [step, limit in minutes, script, ...arguments]. Unattended, a
 * call still running at its limit is stopped and the rest of its step skipped. The limits are at
 * least twice the longest each call took in r14, with eighteen apps: cold start 12 minutes, each
 * run-ssr.mjs call 66 to 69 (the JSON calls have 150, since they take the JSON-only apps too:
 * nineteen with aspnet-aot, about 72, estimated by app count), count 33, look.mjs 3.2, browser timing 14.7, the others under a
 * minute, and build.mjs, one call an app, at most 14.2 (Leptos), against its 90. A build call that
 * is stopped skips only its app.
 * @param {string} round
 * @param {string} browserRuns
 * @param {string[]} names the apps that render the pages (they serve the JSON too)
 * @param {number[]} ports their ports, in the same order
 * @param {string[]} [jsonOnly] the apps that serve only the JSON (`pages: false`)
 * @returns {[string, number, string, ...string[]][]}
 */
export const calls = (round, browserRuns, names, ports, jsonOnly = []) => [
  ["cold-start", 30, "cold-start.mjs", round, "10", [...names, ...jsonOnly].join(",")],
  ["fixture", 140, "run-ssr.mjs", round, "fixture", "300", names.join(","), "page"],
  ["fixture", 150, "run-ssr.mjs", round, "fixture", "300", [...names, ...jsonOnly].join(","), "json"],
  ["api", 140, "run-ssr.mjs", round, "api", "150", names.join(","), "page"],
  ["api", 150, "run-ssr.mjs", round, "api", "150", [...names, ...jsonOnly].join(","), "json"],
  ["count", 70, "count.mjs", round, "3", [...names, ...jsonOnly].join(",")],
  ["browser", 10, "parity.mjs"],
  ["browser", 15, "look.mjs"],
  ["browser", 10, "bytes.mjs", round],
  ["browser", 30, "browser.mjs", ...names.map((n, i) => `${n}=http://localhost:${ports[i]}`), `runs=${browserRuns}`, `out=${round}/browser.json`],
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
 *   call: (limit: number, args: string[]) => Promise<{ stopped: string | null, code: number | null }>,
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
    const { stopped, code } = await call(limit, args);
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
