// The parts of a round that run-all.mjs and droplet.mjs share and round.test.mjs tests: the
// steps, run-all.mjs's calls with their time limits, where a stopped round goes on, and the systemd
// unit a round runs under on a droplet. No side effects.

/** run-all.mjs's steps, in order. The builds come last, so a slow one costs no other step its time. */
export const steps = ["cold-start", "fixture", "api", "count", "browser", "build"];

/**
 * How long the build step may run, all apps together (minutes): it starts no app's build past this,
 * and skips the rest, so the round ends within its unit's hours. An estimate until a round measures
 * it: Corten's builds took about 35 minutes on a loaded desktop's four cores and the interpreted
 * apps' under 5, so six compiled apps at up to 40 and twelve others at up to 15 (estimated).
 */
export const buildBudgetMinutes = 420;

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
 * apps to start and the build budget fit in it (round.test.mjs checks).
 */
export const fullstackHours = 21;

/** How long an unattended call may write nothing before it is stopped (the longest quiet stretch in r5-r8 was 26 minutes, in count.mjs). */
export const idleMinutes = 60;

/** Where an app's build comes in the build step: the compiled apps first, the rest as given. */
const rank = (/** @type {string} */ name) => (compiledFirst.includes(name) ? compiledFirst.indexOf(name) : compiledFirst.length);

/**
 * run-all.mjs's calls, in order, as [step, limit in minutes, script, ...arguments]. Unattended, a
 * call still running at its limit is stopped and the rest of its step skipped. The limits are at
 * least twice the longest each call took in r5-r8, with fourteen apps: cold start 10 minutes, each
 * run-ssr.mjs call 54, count 26, browser timing 11, the others under a minute. Eighteen apps from
 * r13 make those about 69 and 33 minutes (estimated, by app count), so run-ssr.mjs and count.mjs
 * have 120 and 70: 1.7 and 2.1 times. look.mjs is new in r12 (four
 * and a half minutes for fourteen apps on a desktop with other work running) and build.mjs, one
 * call an app, in r13; their limits are guesses until a round measures them. A build call that is
 * stopped skips only its app.
 * @param {string} round
 * @param {string} browserRuns
 * @param {string[]} names the apps
 * @param {number[]} ports their ports, in the same order
 * @returns {[string, number, string, ...string[]][]}
 */
export const calls = (round, browserRuns, names, ports) => [
  ["cold-start", 30, "cold-start.mjs", round, "10"],
  ["fixture", 120, "run-ssr.mjs", round, "fixture", "300", names.join(","), "page"],
  ["fixture", 120, "run-ssr.mjs", round, "fixture", "300", names.join(","), "json"],
  ["api", 120, "run-ssr.mjs", round, "api", "150", names.join(","), "page"],
  ["api", 120, "run-ssr.mjs", round, "api", "150", names.join(","), "json"],
  ["count", 70, "count.mjs", round, "3"],
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
