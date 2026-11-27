// Tests for round.mjs: node --test bench/fullstack/round.test.mjs (npm run check runs it).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { allApps as apps } from "./apps.mjs";
import { acknowledgments, countRow, measurePerfCounts, parsePerCpuCounts, parsePerfCounts, passEvents, perfCountArgs, perfProbeArgs, PROBE_SETS, probeVerdict, runBounded, selectedCpus, UnconfirmedPerf } from "./count-perf.mjs";
import { maxPasses } from "./passes.mjs";
import { appendLine, browserSuite, buildBudgetMinutes, buildStep, buildsLeft, calls, clearAfterCustody, compiledFirst, countHalt, countRestartError, fixtureError, fullstackHours, hostOnlyFile, hoursFor, launchLock, mayStart, outputReleaseMs, ownsLaunch, quote, relaunchCustody, relaunchError, releaseLaunch, resumeAt, roundNameError, runSteps, snapshotsEnded, startMinutes, startSettled, startUnit, steps, stepsUntil, superviseCall, takeLaunch, unit, unitSnapshot } from "./round.mjs";

test("a new round starts at its first step, or at from", () => {
  assert.deepEqual(resumeAt(""), { ended: null, skip: null, app: null, next: "cold-start", boots: 0, built: [] });
  assert.equal(resumeAt("", "count").next, "count");
});

test("a round that restarted in a step skips it and goes on from the next", () => {
  const progress = ["t start cold-start", "t end cold-start", "t start fixture", ""].join("\n");
  assert.deepEqual(resumeAt(progress), { ended: null, skip: "fixture", app: null, next: "api", boots: 0, built: [] });
});

test("a round that restarted between steps skips nothing", () => {
  assert.deepEqual(resumeAt("t start cold-start\nt end cold-start\n"), { ended: null, skip: null, app: null, next: "fixture", boots: 0, built: [] });
});

test("starts are counted, and a restart in the browser step goes on with the builds", () => {
  const progress = ["t boot", "t start count", "t boot", "t start browser"].join("\n");
  assert.deepEqual(resumeAt(progress, "count"), { ended: null, skip: "browser", app: null, next: "build", boots: 2, built: [] });
});

test("a restart in the build step goes on there, skipping the app that was building and those before it", () => {
  const progress = ["t boot", "t start build", "t build corten", "t build leptos", "t boot", "t start build", "t build topcoat", "t boot"].join("\n");
  assert.deepEqual(resumeAt(progress, "build"), { ended: null, skip: "build", app: "topcoat", next: "build", boots: 3, built: ["corten", "leptos", "topcoat"] });
  assert.deepEqual(resumeAt("t start build\n", "build"), { ended: null, skip: null, app: null, next: "build", boots: 0, built: [] });
  assert.equal(resumeAt("t start build\nt build corten\nt end build\n", "build").next, null, "a finished build step leaves the summary");
});

test("the builds left are the build calls' apps not yet started, in their order", () => {
  const all = calls("r13", "10", ["nextjs", "corten", "django", "gin"], ["u1", "u2", "u3", "u4"]);
  assert.deepEqual(buildsLeft(all, []), ["corten", "gin", "nextjs", "django"]);
  assert.deepEqual(buildsLeft(all, ["corten", "nextjs"]), ["gin", "django"]);
  assert.deepEqual(buildsLeft(all, ["corten", "gin", "nextjs", "django"]), []);
});

/**
 * The build step run with recording effects: `outcomes` is each app's call result (by default it
 * ends with 0), and `clock` the minutes the step has run as each app's turn comes.
 * @param {string[]} built
 * @param {Record<string, { stopped?: string, code?: number | null }>} [outcomes]
 * @param {number[]} [clock]
 */
async function runBuilds(built, outcomes = {}, clock = []) {
  const all = calls("r13", "10", ["nextjs", "corten", "django", "gin"], ["u1", "u2", "u3", "u4"]);
  /** @type {string[]} */
  const log = [];
  let turn = 0;
  await buildStep(all, built, {
    minutes: () => clock[turn++] ?? 0,
    call: async (limit, args) => {
      const app = String(args.at(-1));
      assert.ok(built.includes(app), `${app} is in built while it builds`);
      log.push(`call ${app} ${limit}`);
      return { stopped: outcomes[app]?.stopped ?? null, code: outcomes[app]?.code === undefined ? 0 : outcomes[app].code ?? null };
    },
    progress: (what) => log.push(`progress ${what}`),
    skip: (step, why) => log.push(`skip ${step}: ${why}`),
    reset: () => log.push("reset"),
  });
  return { log, built };
}

test("the build step builds each app in turn, recording each before it starts", async () => {
  const { log, built } = await runBuilds([]);
  assert.deepEqual(log, ["corten", "gin", "nextjs", "django"].flatMap((app) => [`progress build ${app}`, `call ${app} 90`]));
  assert.deepEqual(built, ["corten", "gin", "nextjs", "django"]);
});

test("the build step skips the apps whose builds started before a restart", async () => {
  const { log } = await runBuilds(["corten", "gin"]);
  assert.deepEqual(log, ["progress build nextjs", "call nextjs 90", "progress build django", "call django 90"]);
});

test("the build step starts no build past its budget and names the apps it did not build", async () => {
  const { log, built } = await runBuilds([], {}, [0, buildBudgetMinutes, buildBudgetMinutes + 1]);
  assert.deepEqual(log, [
    "progress build corten", "call corten 90",
    "progress build gin", "call gin 90",
    `skip build: the builds ran past ${buildBudgetMinutes} minutes, so these were not built: nextjs, django`,
  ]);
  assert.deepEqual(built, ["corten", "gin"]);
});

test("a build stopped at its limit skips its app alone, asks for a clean slate and goes on", async () => {
  const { log } = await runBuilds([], { gin: { stopped: "build.mjs r13 gin ran past 90 minutes" } });
  assert.deepEqual(log.slice(2, 6), [
    "progress build gin", "call gin 90",
    "skip build: build.mjs r13 gin ran past 90 minutes (gin; the next app's build goes on)", "reset",
  ]);
  assert.deepEqual(log.slice(6), ["progress build nextjs", "call nextjs 90", "progress build django", "call django 90"]);
});

test("a build.mjs that exits with an error or is killed skips that app's results and goes on", async () => {
  const { log } = await runBuilds([], { corten: { code: 2 }, nextjs: { code: null } });
  assert.deepEqual(log.filter((l) => l.startsWith("skip") || l === "reset"), [
    "skip build: build.mjs exited with 2 for corten, so its results may be missing; the next app's build goes on", "reset",
    "skip build: build.mjs was killed by a signal for nextjs, so its results may be missing; the next app's build goes on", "reset",
  ]);
  assert.equal(log.filter((l) => l.startsWith("call")).length, 4);
});

/**
 * run-all.mjs's steps from count through the builds, run with recording effects: `outcome` is each
 * call's result by its script (by default it ends with 0).
 * @param {(script: string) => { stopped?: string | null, code?: number | null, live?: boolean } | Promise<{ stopped?: string | null, code?: number | null, live?: boolean }>} [outcome]
 * @param {string} [from] the first step
 */
async function runRound(outcome = () => ({}), from = "count") {
  const all = calls("r13", "10", ["corten", "gin"], ["u1", "u2"]);
  /** @type {string[]} */
  const log = [];
  const run = runSteps(stepsUntil(from, "build").steps, all, {
    call: async (limit, args) => {
      log.push(`call ${args[0]}`);
      const r = await outcome(args[0]);
      return { stopped: r.stopped ?? null, code: r.code === undefined ? 0 : r.code, live: r.live ?? false };
    },
    progress: (what) => log.push(`progress ${what}`),
    skip: (step, why) => log.push(`skip ${step}: ${why}`),
    reset: () => log.push("reset"),
    build: async () => { log.push("build"); },
    open: async (step) => { log.push(`open ${step}`); return null; },
    close: (step) => log.push(`close ${step}`),
    linux: true,
    clock: () => 0,
    summary: ["summarize.mjs", "r13"],
    done: () => log.push("done"),
  });
  return { run, log };
}

test("a count call that exits 4, or is stopped or killed before count.mjs saw its perfs end, ends the round: no later call, step, clean slate or summary, and no finish", async () => {
  assert.equal(countHalt({ stopped: null, code: 4 }), "count.mjs exited 4: a perf it started was not seen to end");
  assert.match(countHalt({ stopped: "count.mjs printed nothing for 60 minutes, so it was stopped", code: null }) ?? "", /^count\.mjs printed nothing for 60 minutes, so it was stopped, before count\.mjs saw every perf it started end$/);
  assert.match(countHalt({ stopped: "count.mjs ran longer than 70 minutes, so it was stopped", code: 0 }) ?? "", /ran longer than 70 minutes/);
  assert.match(countHalt({ stopped: null, code: null }) ?? "", /killed by a signal/);
  // An exit count.mjs makes after it saw its perfs end does not.
  for (const code of [0, 1, 2]) assert.equal(countHalt({ stopped: null, code }), null, String(code));
  for (const result of [{ code: 4 }, { stopped: "count.mjs printed nothing for 60 minutes, so it was stopped", code: null }, { code: null }]) {
    const { run, log } = await runRound((script) => (script === "count.mjs" ? result : {}));
    await assert.rejects(run, /the round stopped in its count step/, JSON.stringify(result));
    assert.deepEqual(log.slice(0, 3), ["progress start count", "open count", "call count.mjs"], JSON.stringify(result));
    assert.equal(log.length, 4, log.join("\n"));
    assert.match(log[3], /^skip count: .*, so the round stops here and nothing more runs on this host$/);
    for (const after of ["reset", "progress end count", "call conform.mjs", "progress start conform", "build", "progress start summary", "call summarize.mjs", "done", "progress finished"]) assert.ok(!log.includes(after), `${after} after ${JSON.stringify(result)}`);
  }
  // The controls: a count that ends 0 or with an ordinary error goes on to every step, the summary and the finish.
  for (const code of [0, 1]) {
    const { run, log } = await runRound((script) => (script === "count.mjs" ? { code } : {}));
    await run;
    assert.deepEqual(log.filter((l) => l.startsWith("progress") || l.startsWith("call") || l === "build" || l === "done"), [
      "progress start count", "call count.mjs", "progress end count", "progress start conform", "call conform.mjs", "progress end conform",
      "progress start browser", "call parity.mjs", "call look.mjs", "call bytes.mjs", "call browser.mjs", "progress end browser",
      "progress start build", "build", "progress end build", "progress start summary", "call summarize.mjs", "done", "progress finished",
    ], String(code));
  }
  // Another step's call stopped at its limit skips the rest of that step alone and asks for a clean slate, as before.
  const { run, log } = await runRound((script) => (script === "look.mjs" ? { stopped: "look.mjs ran longer than 15 minutes, so it was stopped", code: null } : {}));
  await run;
  assert.deepEqual(log.slice(log.indexOf("call look.mjs"), log.indexOf("call look.mjs") + 4), ["call look.mjs", "skip browser: look.mjs ran longer than 15 minutes, so it was stopped", "reset", "close browser"]);
  assert.ok(log.includes("progress finished"));
});

test("a call left running after its stop, in any step, ends the round: no clean slate, later call, step or summary", async () => {
  // A call before the count step that never exits after TERM and KILL, through superviseCall itself.
  const stuckCall = async () => {
    const stuck = fakeChild();
    return superviseCall(/** @type {any} */ (stuck), { label: "run-ssr.mjs", limitMs: 0, idleMs: Infinity, tickMs: 10, graceMs: 20, releaseMs: 20, write: () => {}, signalGroup: () => {} });
  };
  const first = await stuckCall();
  assert.equal(first.live, true);
  const { run, log } = await runRound(async (script) => (script === "run-ssr.mjs" ? stuckCall() : {}), "fixture");
  await assert.rejects(run, /run-ssr\.mjs was still running .* after it was stopped.*; the round stopped in its fixture step/);
  assert.match(log.at(-1) ?? "", /^skip fixture: run-ssr\.mjs ran longer than 0 minutes, so it was stopped; run-ssr\.mjs was still running .*, so the round stops here and nothing more runs on this host$/);
  for (const after of ["reset", "progress end fixture", "progress start api", "call count.mjs", "progress start count", "call summarize.mjs", "done", "progress finished"]) assert.ok(!log.includes(after), `${after} after a live call\n${log.join("\n")}`);
  // In the browser step and in the summary too.
  const browser = await runRound((script) => (script === "look.mjs" ? { stopped: "look.mjs was still running", code: null, live: true } : {}));
  await assert.rejects(browser.run, /the round stopped in its browser step/);
  assert.ok(!browser.log.includes("reset") && !browser.log.includes("call bytes.mjs") && !browser.log.includes("call summarize.mjs"));
  const summary = await runRound((script) => (script === "summarize.mjs" ? { stopped: "summarize.mjs was still running", code: null, live: true } : {}));
  await assert.rejects(summary.run, /the round stopped in its summary step/);
  assert.ok(!summary.log.includes("done") && !summary.log.includes("progress finished"));
  // The control: a call stopped and seen to exit skips the rest of its step, asks for a clean slate and goes on.
  const exited = await runRound((script) => (script === "run-ssr.mjs" ? { stopped: "run-ssr.mjs ran longer than 5 minutes, so it was stopped", code: null } : {}), "fixture");
  await exited.run;
  assert.ok(exited.log.includes("reset") && exited.log.includes("call count.mjs") && exited.log.includes("progress finished"));
});

test("a build left running after its stop ends the round; one stopped and seen to exit skips its app alone", async () => {
  const { log, run } = (() => {
    const all = calls("r13", "10", ["corten", "gin"], ["u1", "u2"], ["django"]);
    /** @type {string[]} */
    const log = [];
    return { log, run: buildStep(all, [], {
      minutes: () => 0,
      call: async (limit, args) => { log.push(`call ${args.at(-1)}`); return args.at(-1) === "gin" ? { stopped: "build.mjs r13 gin was still running", code: null, live: true } : { stopped: null, code: 0 }; },
      progress: (what) => log.push(`progress ${what}`),
      skip: (step, why) => log.push(`skip ${step}: ${why}`),
      reset: () => log.push("reset"),
    }) };
  })();
  await assert.rejects(run, /the round stopped in its build step/);
  assert.deepEqual(log.slice(-2), ["call gin", "skip build: build.mjs r13 gin was still running, so the round stops here and nothing more runs on this host"]);
  assert.ok(!log.includes("reset"));
});

test("a call whose output is released after its exit ends the round in any step: no clean slate and no next build beside what held it", async () => {
  // Through superviseCall itself: the call exits (0 or an error) while something it started holds its output.
  const heldCall = async (/** @type {string} */ label, /** @type {number} */ code) => {
    const held = fakeChild();
    const run = superviseCall(/** @type {any} */ (held), { label, limitMs: Infinity, idleMs: Infinity, releaseMs: 20, write: () => {}, signalGroup: () => assert.fail("no group signal after the exit") });
    held.exitCode = code; held.emit("exit", code, null);
    return run;
  };
  // The build step: the first app's build is released after its exit; the next app's build does not start.
  for (const code of [0, 1]) {
    const all = calls("r13", "10", ["corten", "gin"], ["u1", "u2"]);
    /** @type {string[]} */
    const log = [];
    const run = buildStep(all, [], {
      minutes: () => 0,
      call: async (limit, args) => { log.push(`call ${args.at(-1)}`); return args.at(-1) === "corten" ? heldCall("build.mjs", code) : { stopped: null, code: 0 }; },
      progress: (what) => log.push(`progress ${what}`),
      skip: (step, why) => log.push(`skip ${step}: ${why}`),
      reset: () => log.push("reset"),
    });
    const outcome = await run.then(() => "resolved", (e) => e);
    assert.ok(!log.includes("call gin"), `build B started beside what held build A's output (exit ${code}):\n${log.join("\n")}`);
    assert.match(String(outcome), /the round stopped in its build step/, String(code));
    assert.deepEqual(log, ["progress build corten", "call corten", `skip build: build.mjs exited ${code} but its output stayed open 0 s after, so it was released, so the round stops here and nothing more runs on this host`], String(code));
  }
  const released = await heldCall("build.mjs", 0);
  assert.equal(released.live, true);
  assert.match(released.stopped ?? "", /^build\.mjs exited 0 but its output stayed open 0 s after, so it was released$/);
  // Another step: no clean slate, later call, step or summary.
  const { run, log } = await runRound(async (script) => (script === "look.mjs" ? heldCall("look.mjs", 0) : {}));
  await assert.rejects(run, /the round stopped in its browser step/);
  for (const after of ["reset", "call bytes.mjs", "progress end browser", "build", "call summarize.mjs", "done", "progress finished"]) assert.ok(!log.includes(after), `${after} after a released call\n${log.join("\n")}`);
  // A count's release still names count.mjs's own halt.
  const count = await runRound(async (script) => (script === "count.mjs" ? heldCall("count.mjs", 4) : {}));
  await assert.rejects(count.run, /count\.mjs exited 4: a perf it started was not seen to end; the round stopped in its count step/);
  // The control: an exit whose output closes goes on to the next app's build.
  const all = calls("r13", "10", ["corten", "gin"], ["u1", "u2"]);
  /** @type {string[]} */
  const clean = [];
  await buildStep(all, [], {
    minutes: () => 0,
    call: async (limit, args) => {
      clean.push(`call ${args.at(-1)}`);
      const child = fakeChild();
      const run = superviseCall(/** @type {any} */ (child), { label: "build.mjs", limitMs: Infinity, idleMs: Infinity, releaseMs: 5000, write: () => {}, signalGroup: () => {} });
      child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null);
      return run;
    },
    progress: () => {},
    skip: (step, why) => clean.push(`skip ${step}: ${why}`),
    reset: () => clean.push("reset"),
  });
  assert.deepEqual(clean, ["call corten", "call gin"]);
});

test("a round that starts again in its count step goes on only where that step started in another boot, known by its ID", () => {
  const boot = "0f1e2d3c-4b5a-4968-8776-655443322110", other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const started = (/** @type {string} */ line) => `t boot\nt start fixture\nt end fixture\nt ${line}\n`;
  const why = (/** @type {string} */ what) => `the round stopped in its count step and ${what}, so a perf or probe that step started may still run; nothing more runs on this host`;
  // The same boot: run-all.mjs itself was killed or stopped, and the count's perf may still run.
  assert.equal(countRestartError(started(`start count ${boot}`), boot), why("it started again in the boot its count step started in"));
  // No boot ID on the start line (a round started before this change), or none to compare with now.
  assert.equal(countRestartError(started("start count"), boot), why("its count step's start recorded no boot ID"));
  assert.equal(countRestartError(started("start count not-a-boot-id"), boot), why("its count step's start recorded no boot ID"));
  assert.equal(countRestartError(started(`start count ${boot}`), null), why("this boot's ID cannot be read"));
  // The controls: a count step that started in another boot, one that ended, and a restart in another step.
  assert.equal(countRestartError(started(`start count ${other}`), boot), null);
  assert.equal(countRestartError(started(`start count ${boot}`) + "t end count\nt start conform\n", boot), null);
  assert.equal(countRestartError(started("start conform"), boot), null);
  assert.equal(countRestartError("", boot), null);
  // resumeAt reads the start line with its boot ID as before.
  assert.deepEqual(resumeAt(started(`start count ${other}`), "fixture"), resumeAt(started("start count"), "fixture"));
  // A last line with no end was a write cut short, which may have been the count step's start, whole
  // or not: read as a count step that did not end, in this boot or another.
  const cut = "the round's progress file ends in a line cut short, so whether its count step started is not known and a perf or probe that step started may still run; nothing more runs on this host";
  for (const text of ["t boot\nt start fixture\nt end fixture\nt start co", "t boot\nt start fixture\nt end fixture\nt sta", "t boot\nt start fixture\nt end fixture\nt", `t boot\nt start count ${other}`, "t boot\nt start conform\nt end conf"]) {
    assert.equal(countRestartError(text, boot), cut, JSON.stringify(text));
  }
});

test("a relaunch on a droplet reads the round's progress file there as run-all.mjs would at a start, before anything clears it", () => {
  const boot = "0f1e2d3c-4b5a-4968-8776-655443322110", other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const answer = (/** @type {string | null} */ text, id = boot) => `${id}\n${text === null ? "absent" : `present ${Buffer.from(text).toString("base64")}`}\n`;
  const unfinished = `t boot\nt start fixture\nt end fixture\nt start count ${boot}\n`;
  // A count step that started in this boot and did not end, whether or not the round recorded its
  // failure after a count halt, a cut last line, or no boot ID to compare: refused.
  assert.match(relaunchError(answer(unfinished)) ?? "", /stopped in its count step and it started again in the boot its count step started in/);
  assert.match(relaunchError(answer(`${unfinished}t failed\n`)) ?? "", /it started again in the boot its count step started in/);
  assert.match(relaunchError(answer("t boot\nt start fixture\nt end fixture\nt start co")) ?? "", /ends in a line cut short/);
  assert.match(relaunchError(answer(unfinished, "")) ?? "", /this boot's ID cannot be read/);
  assert.match(relaunchError(answer(unfinished).replaceAll("\n", "\r\n")) ?? "", /it started again in the boot/);
  // The controls: a count step that started in another boot or ended, an empty file and none.
  assert.equal(relaunchError(answer(unfinished, other)), null);
  assert.equal(relaunchError(answer(`${unfinished}t end count\nt start conform\n`)), null);
  assert.equal(relaunchError(answer("")), null);
  assert.equal(relaunchError(answer(null)), null);
  // An answer that is not relaunchCustody's leaves the file's content unknown: refused.
  const good = Buffer.from(unfinished).toString("base64");
  for (const bad of ["", boot, `${boot}\n`, `${boot}\nsomething\n`, `${boot}\npresent !!!\n`, `${boot}\npresent ${good}x\n`, `${boot}\npresent ${good}\nmore\n`]) {
    assert.match(relaunchError(bad) ?? "", /could not be read/, JSON.stringify(bad));
  }
});

// systemctl as relaunchCustody, startUnit and droplet.mjs call it, answering from FAKE_* variables
// (a known, disabled, inactive unit with no control group of its own, whose start succeeds and
// which is then active, unless they say otherwise; FAKE_RELOAD_HOOK, when set, runs at
// daemon-reload; with FAKE_STARTED, a start makes that file, and while it exists the unit reads
// FAKE_STARTED_STATE, active unless set, as another run of it (InvocationID and state change time);
// with FAKE_START_DONE, a start appends "all done" to that file, as a round that finished at once
// would; a job is queued for it, its id the first word of the file FAKE_JOBS names, while that file
// exists; a snapshot (show with several -p, unitSnapshot) leaves out its Job line with
// FAKE_JOBS_FAIL; with FAKE_FLIP, a file counting the state reads, the unit reads as started (a
// start that completed meanwhile) from read FAKE_FLIP_AT on, the second unless set); while the file
// FAKE_START_IN_DOWNLOAD names exists (the droplet's ssh stand-in makes it at a download), the unit
// reads as another run of it, active; each call recorded in FAKE_SYSTEMCTL_LOG.
const fakeSystemctl = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FAKE_SYSTEMCTL_LOG"',
  'started=; if [ -n "$FAKE_STARTED" ] && [ -e "$FAKE_STARTED" ]; then started=1; fi',
  'if [ -n "$FAKE_START_IN_DOWNLOAD" ] && [ -e "$FAKE_START_IN_DOWNLOAD" ]; then started=1; FAKE_STARTED_STATE=active; fi',
  'flip() { [ -n "$FAKE_FLIP" ] || return 0; n=$(($(cat "$FAKE_FLIP" 2>/dev/null || echo 0) + 1)); echo "$n" > "$FAKE_FLIP"; [ "$n" -lt "${FAKE_FLIP_AT:-2}" ] || { started=1; FAKE_STARTED_STATE=active; }; }',
  'state() { if [ -n "$started" ]; then echo "${FAKE_STARTED_STATE-active}"; else echo "${FAKE_STATE-inactive}"; fi; }',
  'case "$1" in',
  "  show)",
  '    if [ "$4" = "-p" ]; then',
  '      [ -z "$FAKE_STATE_FAIL" ] || exit 1',
  "      flip",
  '      s=$(state); job=; if [ -n "$FAKE_JOBS" ] && [ -e "$FAKE_JOBS" ]; then read -r job rest < "$FAKE_JOBS"; fi',
  '      echo "ActiveState=$s"; case "$s" in active) echo "SubState=running" ;; *) echo "SubState=dead" ;; esac',
  '      [ -n "$FAKE_JOBS_FAIL" ] || echo "Job=$job"',
  '      if [ -n "$started" ]; then echo "InvocationID=bbbb"; echo "StateChangeTimestampMonotonic=2000"; else echo "InvocationID=aaaa"; echo "StateChangeTimestampMonotonic=1000"; fi',
  "      exit 0",
  "    fi",
  '    case "$3" in',
  '      LoadState) [ -z "$FAKE_LOAD_FAIL" ] || exit 1; echo "${FAKE_LOAD-loaded}" ;;',
  '      ActiveState) [ -z "$FAKE_STATE_FAIL" ] || exit 1; flip; state ;;',
  '      ControlGroup) [ -z "$FAKE_CG_FAIL" ] || exit 1; echo "${FAKE_CG-}" ;;',
  "    esac ;;",
  '  disable) exit "${FAKE_DISABLE_RC:-0}" ;;',
  '  stop) exit "${FAKE_STOP_RC:-0}" ;;',
  '  start) [ -z "$FAKE_STARTED" ] || : > "$FAKE_STARTED"; [ -z "$FAKE_START_DONE" ] || echo "all done" >> "$FAKE_START_DONE"; exit "${FAKE_START_RC:-0}" ;;',
  '  is-active) exit "${FAKE_ACTIVE_RC:-0}" ;;',
  '  list-jobs) [ -z "$FAKE_JOBS_FAIL" ] || exit 1; if [ -n "$FAKE_JOBS" ] && [ -e "$FAKE_JOBS" ]; then cat "$FAKE_JOBS"; fi ;;',
  '  daemon-reload) [ -z "$FAKE_RELOAD_HOOK" ] || sh "$FAKE_RELOAD_HOOK" ;;',
  '  is-enabled) echo "${FAKE_ENABLED-disabled}"; [ "${FAKE_ENABLED-disabled}" = enabled ] ;;',
  "esac",
  "exit 0",
  "",
].join("\n");

test("a unit has ended only when two snapshots, each its state and job from one query, agree and read inactive or failed with no job", () => {
  const snap = (/** @type {string} */ state, job = "", invocation = "aaaa", changed = "1000") => `ActiveState=${state} InvocationID=${invocation} Job=${job} StateChangeTimestampMonotonic=${changed} SubState=${state === "active" ? "running" : "dead"}`;
  assert.ok(snapshotsEnded(snap("inactive"), snap("inactive")));
  assert.ok(snapshotsEnded(snap("failed"), `${snap("failed")}\n`));
  // A start that completed between them, a job queued, a state not ended, or another run of it.
  assert.ok(!snapshotsEnded(snap("inactive"), snap("active", "", "bbbb", "2000")));
  assert.ok(!snapshotsEnded(snap("inactive", "4242"), snap("inactive", "4242")));
  assert.ok(!snapshotsEnded(snap("active"), snap("active")));
  assert.ok(!snapshotsEnded(snap("inactive"), snap("inactive", "", "bbbb", "2000")));
  // One snapshot alone, or an answer that is not each property once, is not an answer.
  assert.ok(!snapshotsEnded(snap("inactive"), "unreadable"));
  assert.ok(!snapshotsEnded("ActiveState=inactive", "ActiveState=inactive"));
  const noJob = snap("inactive").replace(" Job=", " ");
  assert.ok(!snapshotsEnded(noJob, noJob));
  const twice = snap("inactive").replace("Job=", "ActiveState=inactive Job=");
  assert.ok(!snapshotsEnded(twice, twice));
  // The query names every property once, so systemd answers them from one reply.
  assert.match(unitSnapshot("corten-bench-r1"), /systemctl show -p ActiveState -p SubState -p Job -p InvocationID -p StateChangeTimestampMonotonic 'corten-bench-r1\.service'/);
});

test("a relaunch reads the round's progress file only once systemd confirms its unit is disabled, stopped and inactive with no process in its control group or below it", { skip: process.platform !== "linux" && "needs Linux's /proc" }, () => {
  const root = mkdtempSync(join(tmpdir(), "relaunch-custody-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), fakeSystemctl, { mode: 0o755 });
    const units = join(root, "systemd");
    const cgroups = join(root, "cgroup");
    mkdirSync(units);
    mkdirSync(cgroups);
    writeFileSync(join(cgroups, "cgroup.controllers"), "cpu io memory pids\n");
    const group = join(cgroups, "system.slice", "corten-bench-r1.service");
    const progress = join(root, "results-r1.progress");
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const script = relaunchCustody("corten-bench-r1", progress, { unitDir: units, cgroupRoot: cgroups });
    const log = join(root, "log");
    /** @param {Record<string, string>} fake */
    const run = (fake = {}, body = script) => {
      rmSync(log, { force: true });
      const r = spawnSync("bash", ["-c", body], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SYSTEMCTL_LOG: log, ...fake } });
      return { ...r, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
    };
    // A unit not confirmed stopped is refused (exit 4: the launch leaves the droplet); only a boot
    // ID or progress file that cannot be read fails (exit 1).
    const refused = (/** @type {Record<string, string>} */ fake, /** @type {RegExp} */ why, /** @type {string} */ label, body = script, status = 4) => {
      const r = run(fake, body);
      assert.equal(r.status, status, `${label}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, why, label);
      assert.equal(r.stdout, "", label);
      return r;
    };
    const ok = (/** @type {Record<string, string>} */ fake, /** @type {string} */ label, body = script) => {
      const r = run(fake, body);
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      return r;
    };
    // A query or command that failed is not an answer: a disable or a stop that failed, a load
    // state, state or control group that could not be read, and no load state at all.
    refused({ FAKE_DISABLE_RC: "1" }, /unit corten-bench-r1: its disable failed/, "disable failed");
    refused({ FAKE_STOP_RC: "5" }, /unit corten-bench-r1: its stop failed/, "stop failed");
    refused({ FAKE_LOAD_FAIL: "1" }, /its load state could not be read/, "load state failed");
    refused({ FAKE_LOAD: "" }, /its load state could not be read/, "no load state");
    refused({ FAKE_STATE_FAIL: "1" }, /its state and job could not be read/, "state failed");
    refused({ FAKE_CG_FAIL: "1" }, /its control group could not be read/, "control group failed");
    // A snapshot without its Job (not each property once), or a job queued for the unit after
    // its stop.
    const jobs = join(root, "jobs");
    refused({ FAKE_JOBS_FAIL: "1" }, /unit corten-bench-r1: its state and job could not be read/, "snapshot without its job");
    writeFileSync(jobs, "4242 corten-bench-r1.service start waiting\n");
    refused({ FAKE_JOBS: jobs }, /a job for it is queued after its stop \(job 4242\), so it may yet start/, "job queued");
    rmSync(jobs);
    // A start that completes after the unit's state is read and before its job is (two queries
    // apart, the old check read inactive with nothing queued while the unit was active): the
    // unit's state and job come from one snapshot, and a second after the control group, the boot
    // and the progress file must be the same, so the start refuses, here and in the clear's check.
    const flips = join(root, "flips");
    for (const [label, body] of /** @type {const} */ ([["first check", script], ["clear's check", relaunchCustody("corten-bench-r1", progress, { unitDir: units, cgroupRoot: cgroups, observe: true })]])) {
      rmSync(flips, { force: true });
      refused({ FAKE_FLIP: flips }, /it changed while its custody was read \(from \S+=inactive .* to \S+=active .*\), so it may have started/, `start completed between reads, ${label}`, body);
    }
    rmSync(flips, { force: true });
    // A unit a boot could still start: still enabled, enablement unknown, or a wants link left
    // (a unit file without [Install] has nothing for disable to remove).
    refused({ FAKE_ENABLED: "enabled" }, /it is enabled after its disable, so a boot could start it/, "enabled");
    refused({ FAKE_ENABLED: "" }, /of unknown enablement/, "enablement unknown");
    mkdirSync(join(units, "multi-user.target.wants"));
    symlinkSync(join(units, "corten-bench-r1.service"), join(units, "multi-user.target.wants", "corten-bench-r1.service"));
    refused({}, /multi-user\.target\.wants\/corten-bench-r1\.service is left, so a boot could start it/, "wants link");
    rmSync(join(units, "multi-user.target.wants"), { recursive: true, force: true });
    // A stop that did not take.
    for (const state of ["active", "deactivating", "reloading"]) refused({ FAKE_STATE: state }, new RegExp(`it is ${state} after its stop`), state);
    refused({ FAKE_STATE: "" }, /it is of unknown state after its stop/, "no state");
    // A unit systemd no longer has a file for may still run: its state is read all the same.
    refused({ FAKE_LOAD: "not-found", FAKE_STATE: "active" }, /it is active after its stop/, "not-found, active");
    // Something left in a child of its control group: cgroup.procs lists only the group's own
    // processes, so the group's own file is empty; cgroup.events counts the whole subtree.
    mkdirSync(join(group, "escaped"), { recursive: true });
    writeFileSync(join(group, "cgroup.procs"), "");
    writeFileSync(join(group, "escaped", "cgroup.procs"), "4242\n");
    writeFileSync(join(group, "cgroup.events"), "populated 1\nfrozen 0\n");
    refused({}, /it still has processes after its stop/, "child group populated");
    refused({ FAKE_CG: "/system.slice/corten-bench-r1.service" }, /it still has processes after its stop/, "named group populated");
    writeFileSync(join(group, "cgroup.events"), "frozen 0\n");
    refused({}, /it still has processes after its stop/, "events without populated");
    rmSync(join(group, "cgroup.events"));
    refused({}, /its control group's events could not be read/, "events unreadable");
    refused({ FAKE_CG: "system.slice/corten-bench-r1.service" }, /is not a path/, "relative group");
    writeFileSync(join(group, "cgroup.events"), "populated 0\nfrozen 0\n");
    rmSync(join(cgroups, "cgroup.controllers"));
    refused({}, /no cgroup v2 hierarchy can be read/, "no cgroup v2");
    writeFileSync(join(cgroups, "cgroup.controllers"), "cpu io memory pids\n");
    // Confirmed: disabled, stopped, inactive, and its group empty to the bottom, or absent.
    const stopped = ok({}, "group empty");
    assert.deepEqual(stopped.calls.slice(0, 4), ["show -p LoadState --value corten-bench-r1.service", "disable --quiet corten-bench-r1.service", "stop corten-bench-r1.service", "is-enabled corten-bench-r1.service"]);
    assert.equal(stopped.stdout, `${bootId}\nabsent\n`);
    assert.equal(relaunchError(stopped.stdout), null);
    ok({ FAKE_CG: "/system.slice/corten-bench-r1.service" }, "named group empty");
    // The clear's second check only reads: it disables and stops nothing, so a unit that started
    // again since the first check (active, enabled, or with processes) fails it, and one that did
    // not reads as the first check did.
    const observed = relaunchCustody("corten-bench-r1", progress, { unitDir: units, cgroupRoot: cgroups, observe: true });
    const stopsNothing = (/** @type {{ calls: string[] }} */ r, /** @type {string} */ label) => assert.ok(!r.calls.some((c) => /^(disable|stop) /.test(c)), `${label}: ${r.calls.join("; ")}`);
    for (const state of ["active", "activating", "reloading"]) stopsNothing(refused({ FAKE_STATE: state }, new RegExp(`it is ${state} since the launch's custody check`), `observe ${state}`, observed), state);
    stopsNothing(refused({ FAKE_ENABLED: "enabled" }, /it is enabled since the launch's custody check, so a boot could start it/, "observe enabled", observed), "observe enabled");
    writeFileSync(join(group, "cgroup.events"), "populated 1\nfrozen 0\n");
    stopsNothing(refused({}, /it still has processes since the launch's custody check/, "observe populated", observed), "observe populated");
    writeFileSync(join(group, "cgroup.events"), "populated 0\nfrozen 0\n");
    // A start queued for the disabled unit since the first check, its job waiting its turn: the
    // unit still reads inactive with an empty group, so only its job shows it. A queue that could
    // not be read refuses too. Neither stops anything.
    writeFileSync(jobs, "4243 corten-bench-r1.service start waiting\n");
    stopsNothing(refused({ FAKE_JOBS: jobs }, /a job for it is queued since the launch's custody check \(job 4243\), so it may yet start/, "observe job queued", observed), "observe job queued");
    rmSync(jobs);
    stopsNothing(refused({ FAKE_JOBS_FAIL: "1" }, /its state and job could not be read/, "observe snapshot without its job", observed), "observe snapshot without its job");
    const same = ok({}, "observe unchanged", observed);
    stopsNothing(same, "observe unchanged");
    assert.equal(same.stdout, stopped.stdout);
    // Two snapshots, one query each, and no separate state or job-queue read.
    assert.equal(same.calls.filter((c) => c === "show -p ActiveState -p SubState -p Job -p InvocationID -p StateChangeTimestampMonotonic corten-bench-r1.service").length, 2, same.calls.join("; "));
    assert.ok(!same.calls.some((c) => c.startsWith("list-jobs") || c === "show -p ActiveState --value corten-bench-r1.service"), same.calls.join("; "));
    rmSync(join(cgroups, "system.slice"), { recursive: true, force: true });
    ok({}, "no group");
    for (const enabled of ["static", "masked"]) ok({ FAKE_ENABLED: enabled }, enabled);
    // A unit systemd confirms it does not have: nothing to disable or stop, and neither is called.
    const missing = ok({ FAKE_LOAD: "not-found", FAKE_DISABLE_RC: "1", FAKE_STOP_RC: "5", FAKE_ENABLED: "" }, "not-found");
    assert.ok(!missing.calls.some((c) => /^(disable|stop|is-enabled) /.test(c)), missing.calls.join("; "));
    // A failed unit is stopped too; its progress file comes back byte for byte.
    writeFileSync(progress, `t boot\nt start count ${bootId}\n`);
    assert.match(relaunchError(ok({ FAKE_STATE: "failed" }, "failed").stdout) ?? "", /it started again in the boot its count step started in/);
    writeFileSync(progress, "t boot\nt start co");
    assert.match(relaunchError(ok({}, "cut").stdout) ?? "", /ends in a line cut short/);
    // A progress file that cannot be read prints nothing.
    rmSync(progress);
    mkdirSync(progress);
    refused({}, /the progress file could not be read/, "progress unreadable", script, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a launch's lock is taken by one launch at a time, and the clear runs only under it, after a custody check that reads as the first did", { skip: process.platform === "win32" && "needs ln -s and readlink" }, () => {
  const root = mkdtempSync(join(tmpdir(), "launch-lock-"));
  try {
    const lock = join(root, "var", "launch-r1.lock");
    const sh = (/** @type {string} */ script) => spawnSync("bash", ["-c", script], { encoding: "utf8" });
    const target = () => { try { return readlinkSync(lock); } catch { return null; } };
    assert.equal(launchLock("r1"), "/var/lib/corten-bench/launch-r1.lock");
    // The first launch takes it, and takes it again (a step tried again); a second refuses, with
    // how to clear one a stopped launch left, and leaves it.
    assert.equal(sh(takeLaunch(lock, "launch-a")).status, 0);
    assert.equal(target(), "launch-a");
    assert.equal(sh(takeLaunch(lock, "launch-a")).status, 0);
    const second = sh(takeLaunch(lock, "launch-b"));
    assert.equal(second.status, 3);
    assert.match(second.stderr, /is held \(launch-a\): another droplet\.mjs is launching this round here/);
    assert.ok(second.stderr.includes(`rm ${lock}`), second.stderr);
    assert.equal(target(), "launch-a");
    assert.equal(sh(ownsLaunch(lock, "launch-a")).status, 0);
    const notOwned = sh(ownsLaunch(lock, "launch-b"));
    assert.equal(notOwned.status, 4);
    assert.match(notOwned.stderr, /this launch no longer holds/);
    // The clear: its custody check stands in as a file read twice; `clear` removes a sentinel.
    const state = join(root, "state");
    const sentinel = join(root, "sentinel");
    writeFileSync(state, "boot\nabsent\n");
    const step = (/** @type {string} */ token, clear = `rm ${quote(sentinel)}`) => sh(clearAfterCustody({ lock, token, custody: `cat ${quote(state)}`, expected: "boot\nabsent\n", clear }));
    writeFileSync(sentinel, "");
    // Another launch's token, or a custody that changed in between: nothing is cleared.
    const otherToken = step("launch-b");
    assert.equal(otherToken.status, 4);
    assert.match(otherToken.stderr, /no longer holds/);
    assert.ok(existsSync(sentinel));
    writeFileSync(state, "boot\npresent dCBzdGFydCBjb3VudAo=\n");
    const changed = step("launch-a");
    assert.equal(changed.status, 4);
    assert.match(changed.stderr, /changed between the launch's custody check and its clear, so nothing is cleared/);
    assert.ok(existsSync(sentinel));
    writeFileSync(state, "boot\nabsent\n");
    // A second check that fails (the unit started again since the first, which that check only
    // reads) refuses as a change does, and clears nothing.
    const startedAgain = sh(clearAfterCustody({ lock, token: "launch-a", custody: "echo 'unit corten-bench-r1: it is active since the first check' >&2; exit 1", expected: "boot\nabsent\n", clear: `rm ${quote(sentinel)}` }));
    assert.equal(startedAgain.status, 4, startedAgain.stderr);
    assert.match(startedAgain.stderr, /it is active since the first check/);
    assert.match(startedAgain.stderr, /could not be confirmed stopped and disabled, as the launch's custody check read it, at its clear \(above\), so nothing is cleared/);
    assert.ok(existsSync(sentinel));
    assert.ok(!existsSync(`${lock}.cleared`));
    // A clear that failed leaves no marker, so a step tried again checks again.
    assert.equal(step("launch-a", "false").status, 1);
    assert.ok(!existsSync(`${lock}.cleared`));
    // The same reading: cleared once; a step tried again after that does not clear again.
    assert.equal(step("launch-a").status, 0);
    assert.ok(!existsSync(sentinel));
    writeFileSync(sentinel, "");
    writeFileSync(state, "boot\npresent bm90IHRoZSBzYW1lCg==\n");
    assert.equal(step("launch-a").status, 0);
    assert.ok(existsSync(sentinel));
    // Released only by its holder.
    assert.equal(sh(releaseLaunch(lock, "launch-b")).status, 0);
    assert.equal(target(), "launch-a");
    assert.equal(sh(releaseLaunch(lock, "launch-a")).status, 0);
    assert.equal(target(), null);
    assert.ok(!existsSync(`${lock}.cleared`));
    assert.equal(sh(takeLaunch(lock, "launch-b")).status, 0);
    // A directory at the lock's path: `ln -s` alone would put the link inside it and go on.
    // Refused, with nothing made inside it, and so is a plain file there.
    assert.equal(sh(releaseLaunch(lock, "launch-b")).status, 0);
    mkdirSync(lock);
    const dir = sh(takeLaunch(lock, "launch-a"));
    assert.equal(dir.status, 3, dir.stderr);
    assert.match(dir.stderr, /is held \(not a link: something else is at its path\)/);
    assert.deepEqual(readdirSync(lock), []);
    assert.equal(sh(ownsLaunch(lock, "launch-a")).status, 4);
    rmdirSync(lock);
    writeFileSync(lock, "launch-a");
    assert.equal(sh(takeLaunch(lock, "launch-a")).status, 3);
    rmSync(lock);
    assert.equal(sh(takeLaunch(lock, "launch-a")).status, 0);
    assert.equal(target(), "launch-a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startUnit says its start settled only when systemctl start succeeded, and asks the manager nothing more after one that did not", { skip: process.platform === "win32" && "stands in for systemctl with a shell script" }, () => {
  const root = mkdtempSync(join(tmpdir(), "start-unit-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), fakeSystemctl, { mode: 0o755 });
    const lock = join(root, "launch-r1.lock");
    symlinkSync("launch-a", lock);
    const log = join(root, "systemctl.log");
    const run = (/** @type {Record<string, string>} */ fake, token = "launch-a") => {
      rmSync(log, { force: true });
      const r = spawnSync("bash", ["-c", startUnit(lock, token, "corten-bench-r1")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SYSTEMCTL_LOG: log, ...fake } });
      return { ...r, settled: startSettled(r.stdout), calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
    };
    // A start that succeeded has settled; the manager is asked only whether the unit is active.
    const ok = run({});
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, "start settled 0\n");
    assert.ok(ok.settled);
    assert.deepEqual(ok.calls, ["start corten-bench-r1", "is-active --quiet corten-bench-r1"]);
    // A start that succeeded whose unit is then not active (it already ended, or the check failed)
    // has settled all the same, and fails.
    const inactive = run({ FAKE_ACTIVE_RC: "3" });
    assert.equal(inactive.status, 1, inactive.stderr);
    assert.equal(inactive.stdout, "start settled 0\n");
    assert.ok(inactive.settled);
    assert.deepEqual(inactive.calls, ["start corten-bench-r1", "is-active --quiet corten-bench-r1"]);
    // Any other return may only have lost its reply from systemd while its job goes on, whatever
    // the manager would say afterwards: nothing settled is printed, and nothing more is asked.
    for (const [label, fake] of /** @type {[string, Record<string, string>][]} */ ([
      ["failed, the unit failed", { FAKE_START_RC: "1", FAKE_STATE: "failed" }],
      ["failed, the unit inactive", { FAKE_START_RC: "1", FAKE_STATE: "inactive" }],
      ["failed, the unit active", { FAKE_START_RC: "1", FAKE_STATE: "active" }],
      ["unit not found", { FAKE_START_RC: "5" }],
      ["the job failed", { FAKE_START_RC: "3" }],
    ])) {
      const r = run(fake);
      assert.equal(r.status, 1, label);
      assert.equal(r.stdout, "", label);
      assert.ok(!r.settled, label);
      assert.deepEqual(r.calls, ["start corten-bench-r1"], label);
    }
    // Only the line for a start that succeeded says it settled.
    for (const out of ["start settled 1\n", "start settled\n", "start settled 0 later\n", ""]) assert.ok(!startSettled(out), out);
    assert.ok(startSettled("start settled 0\r\n"));
    // A launch that no longer holds the lock starts nothing.
    const lost = run({}, "launch-b");
    assert.equal(lost.status, 4, lost.stderr);
    assert.deepEqual(lost.calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("droplet.mjs uploads none of a round's progress files or logs from the working tree", () => {
  for (const member of ["./bench/fullstack/results-r1.progress", "bench/fullstack/results-m3.log", "./bench/live/results-l2.log", "./bench/live/results-l2.progress\r"]) assert.ok(hostOnlyFile(member), member);
  for (const member of ["./bench/fullstack/round.mjs", "./bench/fullstack/results-r1.progress.bak", "./bench/browser/results-r1.log", "./bench/fullstack/results/r1/run.log", "./x/bench/fullstack/results-r1.progress"]) assert.ok(!hostOnlyFile(member), member);
});

test("droplet.mjs on a reused droplet holds the round's launch from its custody check through its unit's start, clears what that round left only under it, and uploads no progress file", { skip: process.platform === "win32" && "stands in for ssh with a shell script" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "relaunch-droplet-"));
  try {
    // droplet.mjs and what it imports, in a tree of their own with a fixture, so the launch
    // uploads (with the real tar) only that tree. The tree is dirty: it has a progress file saying
    // the round finished and a log saying it is all done, as a local round would leave.
    const tree = join(root, "tree");
    const fullstack = join(tree, "bench", "fullstack");
    mkdirSync(join(fullstack, "fixtures"), { recursive: true });
    mkdirSync(join(tree, "bench", "live"));
    for (const file of ["droplet.mjs", "apps.mjs", "conformance.mjs", "inventory.mjs", "pack.mjs", "passes.mjs", "round.mjs", "count-perf.mjs"]) copyFileSync(join(import.meta.dirname, file), join(fullstack, file));
    copyFileSync(join(import.meta.dirname, "..", "live", "apps.mjs"), join(tree, "bench", "live", "apps.mjs"));
    writeFileSync(join(fullstack, "fixtures", "items.json"), JSON.stringify({ item_1: { id: "item_1" } }));
    writeFileSync(join(fullstack, "results-r1.progress"), "t boot\nt finished\n");
    writeFileSync(join(fullstack, "results-r1.log"), "all done\n");
    // The droplet is a directory: ssh runs each script there with its paths moved into it (but
    // provisioning, which it only records), scp copies into it, and systemctl, docker, npm and
    // npx are stand-ins; doctl fails (a reused droplet needs none). FAKE_HOOK, when it exists,
    // runs just before the clear, as another launch or operator would act between the two.
    const remote = join(root, "remote");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ssh"), [
      "#!/bin/sh",
      "for last; do :; done",
      'printf "ssh %s\\n=====\\n" "$last" >> "$FAKE_LOG"',
      'case "$last" in *cloud-init*) exit 0 ;; esac',
      // The clear's step, by words of it its quoting leaves whole.
      'case "$last" in *"so nothing is cleared"*) if [ -f "$FAKE_HOOK" ]; then sh "$FAKE_HOOK"; fi ;; esac',
      // /bench only where a path starts (not the second of /bench/bench). FAKE_FLOCK_WAIT, when
      // set, is how many seconds a step waits for its turn at the droplet's flock.
      'wait="s#^##"; [ -z "$FAKE_FLOCK_WAIT" ] || wait="s#-w [0-9][0-9]* /tmp/droplet.lock#-w $FAKE_FLOCK_WAIT /tmp/droplet.lock#"',
      'script=$(printf "%s" "$last" | sed -E -e "$wait" -e "s#(^|[^A-Za-z0-9_./-])/bench#\\1$FAKE_REMOTE/bench#g" -e "s#/var/lib/corten-bench#$FAKE_REMOTE/lock#g" -e "s#/sys/fs/cgroup#$FAKE_REMOTE/cgroup#g" -e "s#/etc/systemd/system#$FAKE_REMOTE/systemd#g" -e "s#/tmp/droplet.lock#$FAKE_REMOTE/droplet.lock#g" -e "s#/tmp/results.tgz#$FAKE_REMOTE/results.tgz#g")',
      // FAKE_DROP_START: the unit's start runs there, and then the connection drops before its
      // output comes back, as ssh reports a connection lost.
      'case "$last" in *"systemctl start corten-bench-r1"*|*"start settled"*) if [ -n "$FAKE_DROP_START" ]; then bash -c "$script" >/dev/null 2>&1; echo "Connection to 203.0.113.9 closed by remote host." >&2; exit 255; fi ;; esac',
      // FAKE_DROP_WATCH: the watch's look at the round (its script reads /proc/uptime) gets no
      // answer, as from a droplet that stopped answering; other calls go through.
      'case "$last" in */proc/uptime*) if [ -n "$FAKE_DROP_WATCH" ]; then echo "ssh: connect to host 203.0.113.9 port 22: Connection timed out" >&2; exit 255; fi ;; esac',
      // FAKE_START_IN_DOWNLOAD: a download's archive step makes that file, as a start of the unit
      // that ran while the results were packed (the systemctl stand-in then reads it active).
      'case "$last" in *"tar -czf /tmp/results.tgz"*) if [ -n "$FAKE_START_IN_DOWNLOAD" ]; then : > "$FAKE_START_IN_DOWNLOAD"; fi ;; esac',
      // FAKE_DROP: a step whose script holds that text runs there, and then every reply is lost.
      'if [ -n "$FAKE_DROP" ]; then case "$last" in *"$FAKE_DROP"*) bash -c "$script" >/dev/null 2>&1; echo "Connection to 203.0.113.9 closed by remote host." >&2; exit 255 ;; esac; fi',
      'exec bash -c "$script"',
      "",
    ].join("\n"), { mode: 0o755 });
    // A download's archive comes from the droplet's directory (/tmp/results.tgz is moved into it).
    writeFileSync(join(bin, "scp"), [
      "#!/bin/sh",
      'printf "scp %s\\n=====\\n" "$*" >> "$FAKE_LOG"',
      "for last; do :; done",
      'eval "src=\\${$(($# - 1))}"',
      'case "$src" in *:/tmp/results.tgz) cp "$FAKE_REMOTE/results.tgz" "$last" ;; *) cp "$src" "$FAKE_REMOTE$(printf "%s" "${last#*:}")" ;; esac',
      "",
    ].join("\n"), { mode: 0o755 });
    // doctl fails unless FAKE_DOCTL_CREATE or FAKE_DOCTL_LIST is set: then it lists no droplet (or
    // FAKE_DOCTL_LIST's line, for a --collect to find), creates one at the droplet's address, and
    // deletes it when asked. With FAKE_DOCTL_ACCOUNT, DigitalOcean answers (account get) and a
    // power cycle succeeds, so a droplet that does not answer is taken as stuck.
    writeFileSync(join(bin, "doctl"), [
      "#!/bin/sh",
      'printf "doctl %s\\n=====\\n" "$*" >> "$FAKE_LOG"',
      '[ -n "$FAKE_DOCTL_CREATE$FAKE_DOCTL_LIST" ] || exit 1',
      'case "$*" in "account get"*|"compute droplet-action power-cycle"*) [ -n "$FAKE_DOCTL_ACCOUNT" ] && exit 0 ;; esac',
      'case "$*" in',
      '  "compute droplet list"*) [ -z "$FAKE_DOCTL_LIST" ] || echo "$FAKE_DOCTL_LIST" ;;',
      '  "compute droplet create"*) echo "4242 203.0.113.9" ;;',
      '  "compute droplet delete"*|"compute tag delete"*) exit 0 ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"), { mode: 0o755 });
    writeFileSync(join(bin, "systemctl"), fakeSystemctl, { mode: 0o755 });
    // docker exits FAKE_DOCKER_RC (0 unless set), as a build that failed would.
    writeFileSync(join(bin, "docker"), '#!/bin/sh\nexit "${FAKE_DOCKER_RC:-0}"\n', { mode: 0o755 });
    for (const stub of ["npm", "npx"]) writeFileSync(join(bin, stub), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const other = bootId === "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" ? "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const unfinished = (/** @type {string} */ boot) => `t boot\nt start fixture\nt end fixture\nt start count ${boot}\n`;
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: join(root, "log"), FAKE_SYSTEMCTL_LOG: join(root, "systemctl"), FAKE_REMOTE: remote, FAKE_HOOK: join(root, "hook") };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const remoteProgress = join(remote, "bench", "bench", "fullstack", "results-r1.progress");
    const remoteLog = join(remote, "bench", "bench", "fullstack", "results-r1.log");
    const lock = join(remote, "lock", "launch-r1.lock");
    const target = () => { try { return readlinkSync(lock); } catch { return null; } };
    // With `fast`, droplet.mjs waits no minute between the tries of a step (its retry).
    const fastTimers = `data:text/javascript,${encodeURIComponent("const wait = globalThis.setTimeout; globalThis.setTimeout = (f, ms, ...a) => wait(f, ms === 60_000 ? 0 : ms, ...a);")}`;
    /** @typedef {{ progress?: string | null, extra?: string[], hook?: string, held?: string, fake?: Record<string, string>, fast?: boolean, create?: boolean, detach?: boolean, log?: string, collect?: boolean }} Setup */
    // Lays out the droplet for a launch and returns droplet.mjs's arguments and environment. With
    // `create`, the launch creates its droplet (doctl's stand-in) rather than reusing it with --host.
    // With `collect`, it is a --collect of the round, which finds the droplet DigitalOcean lists
    // under the round's name, as one this run created, and so may delete it.
    const prepare = (/** @type {Setup} */ { progress = null, extra = [], hook, held, fake = {}, fast = false, create = false, detach = true, log = "the droplet's own log\n", collect = false }) => {
      rmSync(remote, { recursive: true, force: true });
      mkdirSync(join(remote, "bench", "bench", "fullstack"), { recursive: true });
      mkdirSync(join(remote, "systemd"), { recursive: true });
      mkdirSync(join(remote, "cgroup"), { recursive: true });
      writeFileSync(join(remote, "cgroup", "cgroup.controllers"), "cpu io memory pids\n");
      writeFileSync(remoteLog, log);
      if (progress !== null) writeFileSync(remoteProgress, progress);
      if (held) {
        mkdirSync(join(remote, "lock"));
        symlinkSync(held, lock);
      }
      rmSync(join(root, "hook"), { force: true });
      if (hook) writeFileSync(join(root, "hook"), hook);
      for (const file of ["log", "systemctl", "started", "jobs", "flips", "download-start"]) rmSync(join(root, file), { force: true });
      rmSync(join(fullstack, "results"), { recursive: true, force: true });
      const argv = [...(fast ? ["--import", fastTimers] : []), join(fullstack, "droplet.mjs"), "r1", ...(collect ? ["--collect"] : [...(create ? ["--ssh-key", "1"] : ["--host", "203.0.113.9"]), ...extra, ...(detach ? ["--detach"] : [])])];
      return { argv, options: { cwd: tree, encoding: /** @type {const} */ ("utf8"), env: { ...env, ...(create ? { FAKE_DOCTL_CREATE: "1" } : {}), ...(collect ? { FAKE_DOCTL_LIST: "4242 corten-bench-r1 203.0.113.9" } : {}), ...fake } } };
    };
    const callsOf = () => existsSync(join(root, "log")) ? readFileSync(join(root, "log"), "utf8").split("\n=====\n").filter(Boolean) : [];
    /** @param {{ stdout: string, stderr: string, status: number | null }} r */
    const outcome = (r) => {
      const calls = callsOf();
      const units = existsSync(join(root, "systemctl")) ? readFileSync(join(root, "systemctl"), "utf8").trim().split("\n") : [];
      return { ...r, calls, units, started: units.includes("start corten-bench-r1"), progress: existsSync(remoteProgress) ? readFileSync(remoteProgress, "utf8") : null, downloaded: calls.some((c) => c.includes("tar -czf /tmp/results.tgz")), deleted: calls.some((c) => c.startsWith("doctl compute droplet delete")) };
    };
    const launch = (/** @type {Setup} */ setup) => {
      const { argv, options } = prepare(setup);
      return outcome(spawnSync(process.execPath, argv, { ...options, timeout: 120_000 }));
    };
    // A launch interrupted (SIGINT, as Ctrl-C) once `until` holds of its calls so far.
    const interrupted = async (/** @type {Setup} */ setup, /** @type {(calls: string[]) => boolean} */ until) => {
      const { argv, options } = prepare(setup);
      const child = spawn(process.execPath, argv, options);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      const closed = new Promise((done) => child.on("close", (code) => done(code)));
      let seen = false;
      for (const deadline = Date.now() + 90_000; Date.now() < deadline && child.exitCode === null; ) {
        if (until(callsOf())) { seen = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      child.kill("SIGINT");
      const status = /** @type {number | null} */ (await closed);
      return { ...outcome({ stdout, stderr, status }), seen };
    };
    const label = (/** @type {string[]} */ extra) => extra.join(" ") || "new";
    const notStarted = (/** @type {ReturnType<typeof launch>} */ r, /** @type {string} */ what) => {
      assert.ok(!r.started, what);
      assert.ok(!r.calls.some((c) => c.startsWith("scp ")), what);
    };
    for (const extra of [["--from", "count"], []]) {
      // The same boot: refused, with the progress file as it was, nothing uploaded or started, and
      // the lock released.
      const same = launch({ progress: unfinished(bootId), extra });
      assert.notEqual(same.status, 0, `${label(extra)}: ${same.stdout}`);
      assert.match(same.stderr, /round r1 may not start again on the droplet at 203\.0\.113\.9: the round stopped in its count step and it started again in the boot its count step started in/, label(extra));
      assert.equal(same.progress, unfinished(bootId), label(extra));
      notStarted(same, label(extra));
      assert.equal(target(), null, label(extra));
      // Another boot (the droplet rebooted, which ends any perf): the launch goes on and clears the
      // progress file; none of the working tree's progress file or log reaches the droplet; the
      // lock is released once the unit has started.
      const ok = launch({ progress: unfinished(other), extra });
      assert.equal(ok.status, 0, `${label(extra)}: ${ok.stderr}`);
      assert.ok(ok.started, label(extra));
      assert.equal(ok.progress, null, label(extra));
      assert.ok(existsSync(join(remote, "bench", "bench", "fullstack", "round.mjs")), label(extra));
      assert.equal(readFileSync(remoteLog, "utf8"), extra.length ? "the droplet's own log\n" : "", label(extra));
      assert.equal(target(), null, label(extra));
      assert.ok(!existsSync(`${lock}.cleared`), label(extra));
      // Every step after the custody check that changes the droplet checks the lock first.
      const changes = ok.calls.filter((c) => c.startsWith("ssh ") && !c.includes("cloud-init") && !c.includes("launch release") && !c.includes("passes.json"));
      assert.ok(changes.length >= 5, label(extra));
      for (const c of changes.slice(1)) assert.ok(c.includes("no longer holds"), `${label(extra)}: ${c.slice(0, 200)}`);
    }
    // Another launch holds the lock (or a stopped one left it): refused before the unit is even
    // stopped, with how to clear it, and the lock is left as it is.
    const held = launch({ progress: unfinished(other), held: "another-launch" });
    assert.notEqual(held.status, 0, held.stdout);
    assert.match(held.stderr, /the launch lock \S+launch-r1\.lock is held \(another-launch\): another droplet\.mjs is launching this round here/);
    assert.match(held.stderr, /rm \S+launch-r1\.lock\) and launch again/);
    assert.ok(!held.units.some((u) => u.startsWith("stop ")), held.units.join("; "));
    assert.equal(held.progress, unfinished(other));
    notStarted(held, "held");
    assert.equal(target(), "another-launch");
    // Between the custody check and the clear, the round's progress file changes (a round that
    // started meanwhile), or another launch takes the lock: nothing is cleared or started.
    const moved = launch({ progress: unfinished(other), hook: `printf 't start count ${bootId}\\n' >> '${remoteProgress}'\n` });
    assert.notEqual(moved.status, 0, moved.stdout);
    assert.match(moved.stderr, /changed between the launch's custody check and its clear, so nothing is cleared/);
    assert.equal(moved.progress, `${unfinished(other)}t start count ${bootId}\n`);
    notStarted(moved, "progress changed");
    assert.equal(target(), null);
    const taken = launch({ progress: unfinished(other), hook: `rm -f '${lock}' && ln -s another-launch '${lock}'\n` });
    assert.notEqual(taken.status, 0, taken.stdout);
    assert.match(taken.stderr, /this launch no longer holds/);
    assert.equal(taken.progress, unfinished(other));
    notStarted(taken, "lock taken");
    assert.equal(target(), "another-launch");
    // The unit's start runs under the flock the other steps use, after its lock check. Its
    // connection drops once the start has run there: the outcome is not known, so it is not tried
    // again and the lock is left, with how to check the round and remove the lock.
    const dropped = launch({ progress: unfinished(other), fake: { FAKE_DROP_START: "1" } });
    assert.notEqual(dropped.status, 0, dropped.stdout);
    assert.ok(dropped.started, dropped.units.join("; "));
    const starts = dropped.calls.filter((c) => c.includes("systemctl start corten-bench-r1") || c.includes("start settled"));
    assert.equal(starts.length, 1, starts.join("\n---\n"));
    assert.match(starts[0], /flock -E 75 -w \d+ \/tmp\/droplet\.lock/);
    assert.ok(starts[0].includes("no longer holds"), starts[0]);
    assert.match(dropped.stdout, /the start of corten-bench-r1 on the droplet at 203\.0\.113\.9 was not acknowledged, so whether round r1 is running is not known and the launch lock \/var\/lib\/corten-bench\/launch-r1\.lock is left there/);
    assert.match(dropped.stdout, /systemctl status corten-bench-r1/);
    assert.match(dropped.stdout, /rm \/var\/lib\/corten-bench\/launch-r1\.lock/);
    assert.ok(!dropped.calls.some((c) => c.includes("launch release")), "an unacknowledged start released the lock");
    assert.notEqual(target(), null, "an unacknowledged start released the lock");
    assert.notEqual(target(), "another-launch");
    // The round may be running: the droplet is left for a --collect, nothing downloaded from it.
    assert.ok(!dropped.stdout.includes("downloading what it has"), dropped.stdout);
    assert.match(dropped.stdout, /droplet 203\.0\.113\.9 is left as it is \(a round there goes on by itself\)/);
    assert.match(dropped.stdout, /systemctl list-jobs/);
    assert.match(dropped.stdout, /do not run --collect until the unit is running, or no start job for it is queued and it is inactive or failed/);
    // systemctl start returns nonzero, its reply from systemd lost while its job is still queued
    // (the unit inactive until the job runs): not settled, so not tried again, and the lock stays.
    const queued = launch({ progress: unfinished(other), fake: { FAKE_START_RC: "1" } });
    assert.notEqual(queued.status, 0, queued.stdout);
    assert.deepEqual(queued.units.filter((u) => u === "start corten-bench-r1"), ["start corten-bench-r1"], queued.units.join("; "));
    assert.ok(!queued.stdout.includes("start settled"), queued.stdout);
    assert.ok(!queued.stdout.includes("retrying"), queued.stdout);
    assert.match(queued.stdout, /the start of corten-bench-r1 on the droplet at 203\.0\.113\.9 was not acknowledged/);
    assert.match(queued.stdout, /do not run --collect until/);
    assert.ok(!queued.calls.some((c) => c.includes("launch release")), "a start whose job is queued released the lock");
    assert.notEqual(target(), null, "a start whose job is queued released the lock");
    assert.ok(!queued.stdout.includes("downloading what it has"), queued.stdout);
    // The control: the start failed and the unit then reads failed. Nothing read afterwards ties
    // that state to this start, so it is not acknowledged either: one start, no retry, the lock and
    // the droplet left, nothing downloaded, and the operator told how to check.
    const failed = launch({ progress: unfinished(other), fake: { FAKE_START_RC: "1", FAKE_STATE: "failed" }, fast: true });
    assert.notEqual(failed.status, 0, failed.stdout);
    assert.deepEqual(failed.units.filter((u) => u === "start corten-bench-r1"), ["start corten-bench-r1"], failed.units.join("; "));
    assert.ok(!failed.units.slice(failed.units.indexOf("start corten-bench-r1") + 1).some((u) => u.startsWith("list-jobs") || u.startsWith("show -p ActiveState")), failed.units.join("; "));
    assert.ok(!failed.stdout.includes("start settled"), failed.stdout);
    assert.ok(!failed.stdout.includes("retrying"), failed.stdout);
    assert.match(failed.stdout, /the start of corten-bench-r1 on the droplet at 203\.0\.113\.9 was not acknowledged, so whether round r1 is running is not known and the launch lock \/var\/lib\/corten-bench\/launch-r1\.lock is left there/);
    assert.match(failed.stdout, /systemctl list-jobs/);
    assert.match(failed.stdout, /do not run --collect until/);
    assert.match(failed.stdout, /rm \/var\/lib\/corten-bench\/launch-r1\.lock/);
    assert.ok(!failed.calls.some((c) => c.includes("launch release")), "a failed start released the lock");
    assert.notEqual(target(), null, "a failed start released the lock");
    assert.ok(!failed.stdout.includes("downloading what it has"), failed.stdout);
    assert.match(failed.stdout, /droplet 203\.0\.113\.9 is left as it is \(a round there goes on by itself\)/);
    // The lock taken by another launch just before the start (at the unit's daemon-reload): the
    // start step refuses (exit 4) and starts nothing, so it is not an unknown start, and the other
    // launch's lock is left as it is.
    writeFileSync(join(root, "reload-hook"), `rm -f '${lock}' && ln -s another-launch '${lock}'\n`);
    const lost = launch({ progress: unfinished(other), fake: { FAKE_RELOAD_HOOK: join(root, "reload-hook") }, fast: true });
    assert.notEqual(lost.status, 0, lost.stdout);
    assert.ok(lost.units.includes("daemon-reload"), lost.units.join("; "));
    assert.ok(!lost.started, lost.units.join("; "));
    assert.match(lost.stderr, /this launch no longer holds/);
    assert.ok(!lost.stdout.includes("was not acknowledged"), lost.stdout);
    assert.ok(!/retrying \(\d of \d\): the start/.test(lost.stdout), lost.stdout);
    assert.equal(target(), "another-launch");
    // A refusal for custody collects nothing (it would land in the other launch's results) and
    // destroys nothing, even a droplet this launch created; the operator is told how to delete it.
    const refusal = /round r1's launch on the droplet at 203\.0\.113\.9 was refused: another launch holds or took its lock/;
    for (const r of [lost, taken, moved, held]) {
      assert.ok(!r.downloaded, r.calls.join("\n---\n").slice(0, 2000));
      assert.ok(!r.stdout.includes("downloading what it has"), r.stdout);
      assert.match(r.stdout, refusal);
    }
    const lostCreated = launch({ progress: unfinished(other), fake: { FAKE_RELOAD_HOOK: join(root, "reload-hook") }, fast: true, create: true });
    assert.notEqual(lostCreated.status, 0, lostCreated.stdout);
    assert.ok(lostCreated.calls.some((c) => c.startsWith("doctl compute droplet create")), lostCreated.calls.join("\n---\n").slice(0, 2000));
    assert.ok(!lostCreated.started, lostCreated.units.join("; "));
    assert.ok(!lostCreated.downloaded, "a launch that lost its lock downloaded results");
    assert.ok(!lostCreated.deleted, "a launch that lost its lock deleted the droplet");
    assert.match(lostCreated.stdout, refusal);
    assert.match(lostCreated.stdout, /delete it with doctl compute droplet delete 4242 --force/);
    assert.ok(!existsSync(join(fullstack, "results", "r1")), "a launch that lost its lock wrote into the results tree");
    assert.equal(target(), "another-launch");
    // The control: a created droplet whose launch fails for another reason (the same boot's
    // unfinished count step) is destroyed, so the harness sees a delete.
    const refusedCreated = launch({ progress: unfinished(bootId), create: true });
    assert.notEqual(refusedCreated.status, 0, refusedCreated.stdout);
    assert.match(refusedCreated.stderr, /round r1 may not start again/);
    assert.ok(refusedCreated.deleted, refusedCreated.calls.join("\n---\n").slice(0, 2000));
    assert.ok(!refusedCreated.stdout.includes("was refused"), refusedCreated.stdout);
    // The clear's second check only reads: a unit that started again between the custody check and
    // the clear (here, just before the clear) refuses it, without that check stopping the unit.
    // Nothing is cleared, retried, started, downloaded or destroyed.
    const again = launch({ progress: unfinished(other), hook: `: > '${join(root, "started")}'\n`, fake: { FAKE_STARTED: join(root, "started") }, fast: true, create: true });
    assert.notEqual(again.status, 0, again.stdout);
    assert.match(again.stderr, /it is active since the launch's custody check/);
    assert.match(again.stderr, /so nothing is cleared/);
    assert.deepEqual(again.units.filter((u) => /^(stop|disable) /.test(u)), ["disable --quiet corten-bench-r1.service", "stop corten-bench-r1.service"], again.units.join("; "));
    assert.ok(!again.stdout.includes("retrying"), again.stdout);
    assert.equal(again.progress, unfinished(other));
    notStarted(again, "started again before the clear");
    assert.ok(!again.downloaded && !again.deleted, again.calls.join("\n---\n").slice(0, 2000));
    assert.match(again.stdout, refusal);
    assert.equal(target(), null);
    // systemctl start succeeded, but the unit is then not read as active (here is-active fails):
    // the start settled, so it is not tried again and the lock is released, and the launch goes
    // on to watch the round as a started one. Interrupted while the watch reads it running, it has
    // downloaded nothing and destroyed nothing.
    const startedFile = join(root, "started");
    const watched = await interrupted({ progress: unfinished(other), fake: { FAKE_STARTED: startedFile, FAKE_ACTIVE_RC: "3" }, create: true, detach: false }, (calls) => calls.some((c) => c.includes("/proc/uptime") && c.includes("-p Job -p InvocationID")));
    assert.ok(watched.seen, `the launch did not reach the watch: ${watched.stdout}${watched.stderr}`);
    assert.equal(watched.status, 130, `${watched.stdout}${watched.stderr}`);
    assert.deepEqual(watched.units.filter((u) => u === "start corten-bench-r1"), ["start corten-bench-r1"], watched.units.join("; "));
    assert.match(watched.stdout, /start settled 0/);
    assert.match(watched.stdout, /the start of corten-bench-r1 on the droplet at 203\.0\.113\.9 succeeded, but whether the unit was then active could not be confirmed/);
    assert.ok(!watched.stdout.includes("was not acknowledged"), watched.stdout);
    assert.ok(watched.calls.some((c) => c.includes("launch release")), "a settled start kept the lock");
    assert.equal(target(), null);
    assert.ok(!watched.downloaded, "a settled start whose round was not seen to end downloaded results");
    assert.ok(!watched.deleted, "a settled start whose round was not seen to end deleted the droplet");
    assert.ok(!watched.stdout.includes("downloading"), watched.stdout);
    assert.match(watched.stdout, /droplet 203\.0\.113\.9 is left as it is/);
    // With --detach the round is left for --collect, which watches for the same, and the lock is
    // released: the start settled.
    const detached = launch({ progress: unfinished(other), fake: { FAKE_STARTED: startedFile, FAKE_ACTIVE_RC: "3" }, create: true });
    assert.equal(detached.status, 0, `${detached.stdout}${detached.stderr}`);
    assert.match(detached.stdout, /succeeded, but whether the unit was then active could not be confirmed/);
    assert.ok(!detached.downloaded && !detached.deleted, detached.calls.join("\n---\n").slice(0, 2000));
    assert.match(detached.stdout, /collect it with node bench\/fullstack\/droplet\.mjs r1 --collect/);
    assert.equal(target(), null);
    // A start queued for the disabled unit between the custody check and the clear (here, just
    // before the clear), its job waiting while the unit reads inactive with no control group: the
    // clear's read-only check sees the job and refuses without stopping anything, so /bench and the
    // progress file are not cleared, and nothing is started, downloaded or destroyed.
    const jobsFile = join(root, "jobs");
    const queuedStart = launch({ progress: unfinished(other), hook: `printf '4242 corten-bench-r1.service start waiting\\n' > '${jobsFile}'\n`, fake: { FAKE_JOBS: jobsFile }, fast: true, create: true });
    assert.notEqual(queuedStart.status, 0, queuedStart.stdout);
    assert.match(queuedStart.stderr, /a job for it is queued since the launch's custody check \(job 4242\)/);
    assert.match(queuedStart.stderr, /so nothing is cleared/);
    assert.deepEqual(queuedStart.units.filter((u) => /^(stop|disable) /.test(u)), ["disable --quiet corten-bench-r1.service", "stop corten-bench-r1.service"], queuedStart.units.join("; "));
    assert.equal(queuedStart.progress, unfinished(other));
    assert.equal(readFileSync(remoteLog, "utf8"), "the droplet's own log\n");
    notStarted(queuedStart, "start queued before the clear");
    assert.ok(!queuedStart.downloaded && !queuedStart.deleted, queuedStart.calls.join("\n---\n").slice(0, 2000));
    assert.match(queuedStart.stdout, refusal);
    // A custody step whose every reply is lost (here after it refused there: another launch holds
    // the lock, or the progress file changed before the clear) is taken as refused: tried again,
    // then nothing downloaded and the droplet this launch created not destroyed, with how to delete
    // it, as for a refusal that came back.
    const unanswered = /round r1's launch on the droplet at 203\.0\.113\.9 was refused: a step that checks its lock got no answer from the droplet/;
    const silentHeld = launch({ progress: unfinished(other), held: "another-launch", fake: { FAKE_DROP: "another droplet.mjs is launching" }, fast: true, create: true });
    const silentClear = launch({ progress: unfinished(other), hook: `printf 't start count ${bootId}\\n' >> '${remoteProgress}'\n`, fake: { FAKE_DROP: "so nothing is cleared" }, fast: true, create: true });
    for (const [what, r, pattern] of /** @type {const} */ ([["custody check", silentHeld, "another droplet.mjs is launching"], ["clear", silentClear, "so nothing is cleared"]])) {
      assert.notEqual(r.status, 0, `${what}: ${r.stdout}`);
      assert.equal(r.calls.filter((c) => c.startsWith("ssh ") && c.includes(pattern)).length, 3, `${what}: tried three times`);
      assert.ok(r.calls.some((c) => c.startsWith("doctl compute droplet create")), what);
      assert.ok(!r.started, `${what}: ${r.units.join("; ")}`);
      assert.ok(!r.downloaded, `${what}: downloaded results`);
      assert.ok(!r.deleted, `${what}: deleted the droplet`);
      assert.match(r.stdout, unanswered, what);
      assert.match(r.stdout, /delete it with doctl compute droplet delete 4242 --force/, what);
    }
    assert.equal(target(), null);
    assert.notEqual(silentClear.progress, null, "an unanswered clear's progress file was cleared");
    // Another launch's step holds the droplet's flock past this launch's wait for its custody
    // check (here a second): the check never ran, so whether it would have refused is not known,
    // and it is taken as refused, as an unanswered one is. Tried again, then nothing started,
    // downloaded or destroyed, with how to delete the droplet this launch created.
    const holding = join(root, "holding");
    rmSync(holding, { force: true });
    const busy = prepare({ progress: unfinished(other), fake: { FAKE_FLOCK_WAIT: "1" }, fast: true, create: true });
    // flock -o: only flock holds the lock, not the command; the group is ended below.
    const holder = spawn("flock", ["-o", join(remote, "droplet.lock"), "-c", `: > '${holding}'; sleep 60`], { detached: true, stdio: "ignore" });
    let flockBusy;
    try {
      for (const deadline = Date.now() + 10_000; !existsSync(holding) && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 50));
      assert.ok(existsSync(holding), "the flock holder did not take the lock");
      flockBusy = outcome(spawnSync(process.execPath, busy.argv, { ...busy.options, timeout: 120_000 }));
    } finally {
      // Its leader is not yet reaped (it sleeps a minute), so the group is still its own.
      if (holder.exitCode === null && holder.signalCode === null && holder.pid) process.kill(-holder.pid, "SIGKILL");
    }
    assert.notEqual(flockBusy.status, 0, flockBusy.stdout);
    assert.equal(flockBusy.calls.filter((c) => c.startsWith("ssh ") && c.includes("another droplet.mjs is launching")).length, 3, "the custody check was not tried three times");
    assert.ok(flockBusy.calls.some((c) => c.startsWith("doctl compute droplet create")), "no droplet was created");
    assert.ok(!flockBusy.started, flockBusy.units.join("; "));
    assert.ok(!flockBusy.downloaded, "a custody check with no turn at the flock downloaded results");
    assert.ok(!flockBusy.deleted, "a custody check with no turn at the flock deleted the droplet");
    assert.match(flockBusy.stdout, /round r1's launch on the droplet at 203\.0\.113\.9 was refused: a step that checks its lock got no turn at the droplet's flock within its wait/);
    assert.match(flockBusy.stdout, /delete it with doctl compute droplet delete 4242 --force/);
    assert.equal(flockBusy.progress, unfinished(other));
    assert.equal(target(), null);
    // The control: a custody step that ran and failed for another reason (its docker build exits
    // 1) is an ordinary failure, as before: the lock released and the created droplet destroyed.
    const buildFailed = launch({ progress: unfinished(other), fake: { FAKE_DOCKER_RC: "1" }, fast: true, create: true });
    assert.notEqual(buildFailed.status, 0, buildFailed.stdout);
    assert.match(buildFailed.stderr, /docker build/);
    assert.ok(!buildFailed.started, buildFailed.units.join("; "));
    assert.ok(!buildFailed.downloaded, buildFailed.calls.join("\n---\n").slice(0, 2000));
    assert.ok(buildFailed.deleted, buildFailed.calls.join("\n---\n").slice(0, 2000));
    assert.ok(!buildFailed.stdout.includes("was refused"), buildFailed.stdout);
    assert.ok(buildFailed.calls.some((c) => c.includes("launch release")), "a failed build kept the lock");
    assert.equal(target(), null);
    // The watch collects a round only once its unit reads inactive or failed with no job queued
    // for it: the log's "all done" alone, printed before the unit's process exits or kept by a
    // round resumed with --from, is not the round's end. A --collect that finds the unit active, a
    // start queued, or its state or job queue unreadable, downloads and destroys nothing and says
    // where the round is (exit 3).
    const done = "2026-11-27T00:00:00.000Z all done\n";
    for (const [what, fake, said] of /** @type {const} */ ([
      ["active", { FAKE_STATE: "active" }, /round r1 is still running/],
      ["start queued", { FAKE_JOBS: jobsFile }, /round r1 is still running/],
      ["state unreadable", { FAKE_STATE_FAIL: "1" }, /whether round r1 has ended is not known: the state of corten-bench-r1 or its job queue could not be read, so nothing is downloaded or destroyed/],
      ["snapshot without its job", { FAKE_JOBS_FAIL: "1" }, /whether round r1 has ended is not known/],
    ])) {
      const { argv, options } = prepare({ log: done, collect: true, fake });
      if (what === "start queued") writeFileSync(jobsFile, "4242 corten-bench-r1.service start waiting\n");
      const r = outcome(spawnSync(process.execPath, argv, { ...options, timeout: 120_000 }));
      assert.equal(r.status, 3, `${what}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, said, what);
      assert.ok(!r.downloaded, `${what}: downloaded results`);
      assert.ok(!r.deleted, `${what}: deleted the droplet`);
      assert.match(r.stdout, /droplet 203\.0\.113\.9 is left as it is/, what);
    }
    // The control: the unit inactive with no job queued and the log all done is a finished round,
    // downloaded and its droplet destroyed.
    const finished = (() => { const { argv, options } = prepare({ log: done, collect: true }); return outcome(spawnSync(process.execPath, argv, { ...options, timeout: 120_000 })); })();
    assert.match(finished.stdout, /downloading the results/, `${finished.stdout}${finished.stderr}`);
    assert.ok(finished.downloaded, finished.calls.join("\n---\n").slice(0, 2000));
    assert.ok(finished.deleted, finished.calls.join("\n---\n").slice(0, 2000));
    // A launch whose start settled but whose unit was not then read as active, going on from a step
    // with the earlier run's "all done" still in its log: the watch reads the unit active and keeps
    // watching; interrupted after three looks it has downloaded and destroyed nothing.
    const keptMarker = await interrupted({ progress: unfinished(other), extra: ["--from", "count"], log: done, fake: { FAKE_STARTED: startedFile, FAKE_ACTIVE_RC: "3" }, create: true, detach: false, fast: true }, (calls) => calls.filter((c) => c.includes("/proc/uptime")).length >= 3);
    assert.ok(keptMarker.seen, `the watch did not look three times: ${keptMarker.stdout}${keptMarker.stderr}`);
    assert.equal(keptMarker.status, 130, `${keptMarker.stdout}${keptMarker.stderr}`);
    assert.match(keptMarker.stdout, /succeeded, but whether the unit was then active could not be confirmed/);
    assert.ok(!keptMarker.downloaded, "a watch that read the unit active downloaded results");
    assert.ok(!keptMarker.deleted, "a watch that read the unit active deleted the droplet");
    // An ordinary launch, waited on, whose round finishes (its unit then inactive with no job
    // queued and its log all done) is still downloaded and its droplet destroyed.
    const ordinary = launch({ progress: unfinished(other), fake: { FAKE_STARTED: startedFile, FAKE_STARTED_STATE: "inactive", FAKE_START_DONE: remoteLog }, create: true, detach: false, fast: true });
    assert.match(ordinary.stdout, /downloading the results/, `${ordinary.stdout}${ordinary.stderr}`);
    assert.ok(!ordinary.stdout.includes("could not be confirmed"), ordinary.stdout);
    assert.ok(ordinary.started && ordinary.downloaded && ordinary.deleted, ordinary.calls.join("\n---\n").slice(0, 2000));
    const collectWith = (/** @type {Setup} */ setup) => { const { argv, options } = prepare({ log: done, collect: true, ...setup }); return outcome(spawnSync(process.execPath, argv, { ...options, timeout: 120_000 })); };
    // A start that completes between the watch's reads, with the log's "all done" kept from an
    // earlier run: read as a state and then a job queue, it was inactive with nothing queued while
    // the unit was active, and the round was collected and its droplet destroyed. Two snapshots
    // around the log, each its state and job from one query, disagree, so the round is running.
    const flips = join(root, "flips");
    const torn = collectWith({ fake: { FAKE_FLIP: flips } });
    assert.ok(!torn.deleted, "a watch whose reads tore deleted the droplet");
    assert.ok(!torn.downloaded, "a watch whose reads tore downloaded results");
    assert.equal(torn.status, 3, `${torn.stdout}${torn.stderr}`);
    assert.match(torn.stdout, /round r1 is still running/);
    // The unit starts after the watch saw it ended and before the droplet would be destroyed: the
    // results come down, but a snapshot after the download no longer reads as the watch saw it, so
    // the droplet is left (exit 3).
    const lateStart = collectWith({ fake: { FAKE_FLIP: flips, FAKE_FLIP_AT: "3" } });
    assert.ok(!lateStart.deleted, "a unit that started after the watch saw it end had its droplet deleted");
    assert.equal(lateStart.status, 3, `${lateStart.stdout}${lateStart.stderr}`);
    assert.match(lateStart.stdout, /downloading the results/);
    assert.ok(lateStart.downloaded, lateStart.calls.join("\n---\n").slice(0, 2000));
    assert.match(lateStart.stdout, /corten-bench-r1 on the droplet at 203\.0\.113\.9 could not be confirmed ended after the download/);
    assert.match(lateStart.stdout, /delete it with doctl compute droplet delete 4242 --force/);
    // The first custody check finds a start queued for the unit (its job waiting): a refusal, as
    // the clear's is, so the droplet this launch created is not destroyed, nothing is cleared,
    // started or downloaded, and the operator is told how to delete it.
    const firstQueued = (() => {
      const { argv, options } = prepare({ progress: unfinished(other), fake: { FAKE_JOBS: jobsFile }, fast: true, create: true });
      writeFileSync(jobsFile, "4242 corten-bench-r1.service start waiting\n");
      return outcome(spawnSync(process.execPath, argv, { ...options, timeout: 120_000 }));
    })();
    assert.ok(firstQueued.calls.some((c) => c.startsWith("doctl compute droplet create")), "no droplet was created");
    assert.ok(!firstQueued.deleted, "a first check that found a queued start deleted the droplet");
    assert.ok(!firstQueued.downloaded, "a first check that found a queued start downloaded results");
    assert.notEqual(firstQueued.status, 0, firstQueued.stdout);
    assert.match(firstQueued.stderr, /a job for it is queued after its stop \(job 4242\), so it may yet start/);
    assert.equal(firstQueued.progress, unfinished(other));
    notStarted(firstQueued, "start queued at the first check");
    assert.match(firstQueued.stdout, refusal);
    assert.match(firstQueued.stdout, /delete it with doctl compute droplet delete 4242 --force/);
    assert.equal(target(), null);
    // A launch that waits loses the droplet (no answer to the watch, though DigitalOcean answers,
    // so it is power-cycled twice and taken as stuck) while its unit is active: the round may be
    // running, so nothing is downloaded and the droplet is left, with how to delete it.
    const lostWatch = launch({ progress: unfinished(other), extra: ["--stall", "0.00001"], fake: { FAKE_STARTED: startedFile, FAKE_DROP_WATCH: "1", FAKE_DOCTL_ACCOUNT: "1" }, create: true, detach: false, fast: true });
    assert.ok(lostWatch.started, lostWatch.units.join("; "));
    assert.equal(lostWatch.calls.filter((c) => c.startsWith("doctl compute droplet-action power-cycle")).length, 2, lostWatch.calls.join("\n---\n").slice(0, 2000));
    assert.ok(!lostWatch.deleted, "a watch that lost the droplet deleted it while its unit was active");
    assert.ok(!lostWatch.downloaded, "a watch that lost the droplet downloaded results from a running round");
    assert.notEqual(lostWatch.status, 0, lostWatch.stdout);
    assert.match(lostWatch.stdout, /the round could not go on \(the droplet at 203\.0\.113\.9 is stuck/);
    assert.match(lostWatch.stdout, /corten-bench-r1 on the droplet at 203\.0\.113\.9 could not be confirmed ended/);
    assert.match(lostWatch.stdout, /delete it with doctl compute droplet delete 4242 --force/);
    // The control: the same, but the unit then reads ended: what the round has is downloaded and
    // the droplet destroyed, as before.
    const lostEnded = launch({ progress: unfinished(other), extra: ["--stall", "0.00001"], fake: { FAKE_STARTED: startedFile, FAKE_STARTED_STATE: "inactive", FAKE_DROP_WATCH: "1", FAKE_DOCTL_ACCOUNT: "1" }, create: true, detach: false, fast: true });
    assert.notEqual(lostEnded.status, 0, lostEnded.stdout);
    assert.match(lostEnded.stdout, /downloading what it has/, `${lostEnded.stdout}${lostEnded.stderr}`);
    assert.ok(lostEnded.downloaded && lostEnded.deleted, lostEnded.calls.join("\n---\n").slice(0, 2000));
    // The same, but a start of the unit runs during the download, after the snapshots that let it
    // begin: the results come down, but the unit no longer reads ended after the download, so the
    // droplet is left (the check after the download), with how to delete it.
    const lostLate = launch({ progress: unfinished(other), extra: ["--stall", "0.00001"], fake: { FAKE_STARTED: startedFile, FAKE_STARTED_STATE: "inactive", FAKE_DROP_WATCH: "1", FAKE_DOCTL_ACCOUNT: "1", FAKE_START_IN_DOWNLOAD: join(root, "download-start") }, create: true, detach: false, fast: true });
    assert.notEqual(lostLate.status, 0, lostLate.stdout);
    assert.match(lostLate.stdout, /reads ended, so downloading what it has/, `${lostLate.stdout}${lostLate.stderr}`);
    assert.ok(lostLate.downloaded, lostLate.calls.join("\n---\n").slice(0, 2000));
    assert.ok(!lostLate.deleted, "a unit that started during the download after the watch gave up had its droplet deleted");
    assert.match(lostLate.stdout, /corten-bench-r1 on the droplet at 203\.0\.113\.9 could not be confirmed ended after the download/);
    assert.match(lostLate.stdout, /delete it with doctl compute droplet delete 4242 --force/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a progress line is written whole before its step starts, or the step is not started and the cut line is read as an unfinished count step", async () => {
  const root = mkdtempSync(join(tmpdir(), "progress-line-"));
  try {
    const file = join(root, "results-r1.progress");
    const append = (/** @type {string} */ line, /** @type {any} */ write) => { const fd = openSync(file, "a+"); try { appendLine(fd, line, write); } finally { closeSync(fd); } };
    // A write that takes 3 bytes at a time: called again for the rest, so the line is whole.
    const calls = [];
    append("t boot");
    append("t start count 0f1e2d3c-4b5a-4968-8776-655443322110", (/** @type {number} */ fd, /** @type {Buffer} */ b, /** @type {number} */ at, /** @type {number} */ n) => (calls.push(n), writeSync(fd, b, at, Math.min(3, n))));
    assert.equal(readFileSync(file, "utf8"), "t boot\nt start count 0f1e2d3c-4b5a-4968-8776-655443322110\n");
    assert.ok(calls.length > 1, String(calls.length));
    // A write that stops part way (writes none, or fails): the line is cut short and appendLine throws.
    for (const stop of ["none", "ENOSPC"]) {
      writeFileSync(file, "t boot\nt start fixture\nt end fixture\n");
      let n = 0;
      const short = (/** @type {number} */ fd, /** @type {Buffer} */ b, /** @type {number} */ at, /** @type {number} */ len) => {
        if (n++ === 0) return writeSync(fd, b, at, 10);
        if (stop === "none") return 0;
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      };
      assert.throws(() => append("2026-11-26T10:00:00.000Z start count 0f1e2d3c-4b5a-4968-8776-655443322110", short), stop === "none" ? /was cut short: 10 of its 74 bytes were written/ : /ENOSPC/, stop);
      const text = readFileSync(file, "utf8");
      assert.equal(text, "t boot\nt start fixture\nt end fixture\n2026-11-26", stop);
      // A start again reads it as a count step that did not end.
      assert.match(countRestartError(text, "0f1e2d3c-4b5a-4968-8776-655443322110") ?? "", /ends in a line cut short/, stop);
      // The next line is written on a line of its own, so the round's failure is read as one.
      append("t failed");
      assert.equal(readFileSync(file, "utf8"), "t boot\nt start fixture\nt end fixture\n2026-11-26\nt failed\n", stop);
      assert.equal(resumeAt(readFileSync(file, "utf8"), "count").ended, "failed", stop);
    }
    // A step whose start was not written is not started.
    const log = [];
    await assert.rejects(runSteps(["count", "conform"], [["count", 60, "count.mjs", "r1"], ["conform", 60, "conform.mjs", "r1"]], {
      call: async (_, args) => { log.push(`call ${args[0]}`); return { stopped: null, code: 0 }; },
      progress: (what) => { log.push(`progress ${what}`); if (what === "start count") throw new Error("the progress line was cut short"); },
      skip: () => {}, reset: () => {}, build: async () => {}, open: async () => null, close: () => {}, linux: true, clock: () => 0, summary: ["summarize.mjs", "r1"], done: () => {},
    }), /cut short/);
    assert.deepEqual(log, ["progress start count"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unattended run-all.mjs whose count step's start is written short writes the rest before it counts, and one whose write fails does not count and records the round failed", { skip: process.platform !== "linux" && "an unattended round runs on Linux only" }, async () => {
  const bench = resolve(import.meta.dirname, "..");
  const root = mkdtempSync(join(tmpdir(), "run-all-short-"));
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  try {
    for (const mode of ["short", "enospc"]) {
      const copy = join(root, mode, "bench");
      for (const file of importClosure(join(import.meta.dirname, "run-all.mjs"))) {
        mkdirSync(dirname(join(copy, relative(bench, file))), { recursive: true });
        copyFileSync(file, join(copy, relative(bench, file)));
      }
      const here = join(copy, "fullstack");
      const stand = (/** @type {string} */ script) => writeFileSync(join(here, script), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(here, "ran.txt"))}, ${JSON.stringify(script)} + "\\n");\nprocess.exit(0);\n`);
      for (const script of ["count.mjs", "conform.mjs", "summarize.mjs"]) stand(script);
      // fs.writeSync as the kernel may answer it: the count step's start line takes only 10 bytes,
      // and the next write after it takes the rest ("short") or fails ("enospc").
      const patch = join(root, mode, "short-write.mjs");
      writeFileSync(patch, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const real = fs.writeSync;
let cut = null;
fs.writeSync = function (fd, data, offset, length, position) {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const from = typeof data === "string" ? 0 : offset ?? 0;
  const len = typeof data === "string" ? buf.length : length ?? buf.length - from;
  if (cut === null && buf.subarray(from, from + len).toString().includes("start count")) { cut = fd; return real.call(this, fd, buf, from, 10); }
  if (cut === fd) { cut = -1; if (${JSON.stringify(mode)} === "enospc") throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); }
  return real.call(this, fd, data, offset, length, position);
};
syncBuiltinESMExports();
`);
      const scratch = join(root, mode, "tmp");
      mkdirSync(scratch);
      const child = spawn(process.execPath, ["--import", pathToFileURL(patch).href, join(here, "run-all.mjs"), "r1", "10", "count", "conform", "--unattended"], {
        cwd: here, env: { PATH: dirname(process.execPath), HOME: scratch, TMPDIR: scratch, BENCH_APP_CPUS: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let said = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => (said += d));
      const exit = await new Promise((done) => child.on("close", done));
      const ran = existsSync(join(here, "ran.txt")) ? readFileSync(join(here, "ran.txt"), "utf8").split("\n").filter(Boolean) : [];
      const text = readFileSync(join(here, "results-r1.progress"), "utf8");
      const lines = text.split("\n").filter(Boolean);
      if (mode === "short") {
        assert.equal(exit, 0, said);
        // The start line is whole, on its own line, and names this boot.
        assert.equal(lines[1].split(" ").slice(1).join(" "), `start count ${boot}`, text);
        assert.deepEqual(lines.map((l) => l.split(" ").slice(1, 3).join(" ")), ["boot", "start count", "end count", "start conform", "end conform", "start summary", "finished"], text);
        assert.deepEqual(ran, ["count.mjs", "conform.mjs", "summarize.mjs"], said);
      } else {
        assert.equal(exit, 1, said);
        assert.deepEqual(ran, [], `count dispatched after its start line was cut short: ${said}`);
        assert.match(said, /round failed: .*ENOSPC/, said);
        // The cut line stays as it is, and the failure is read on its own line: the round does not start again.
        assert.equal(lines.length, 3, text);
        assert.equal(lines[1].length, 10, text);
        assert.equal(lines[2].split(" ").slice(1).join(" "), "failed", text);
        assert.equal(resumeAt(text, "count").ended, "failed", text);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The relative module files `entry` imports, itself included, followed through every file they import. */
function importClosure(/** @type {string} */ entry) {
  const seen = new Set();
  const visit = (/** @type {string} */ file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/^\s*import\s+(?:[^"']*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/gm)) visit(resolve(dirname(file), spec));
  };
  visit(entry);
  return [...seen];
}

test("an unattended run-all.mjs whose count exits 4 starts no later step and does not finish; one whose count exits 0 or 1 goes on", { skip: process.platform !== "linux" && "an unattended round runs on Linux only" }, async () => {
  const bench = resolve(import.meta.dirname, "..");
  const root = mkdtempSync(join(tmpdir(), "run-all-halt-"));
  try {
    for (const code of [4, 0, 1]) {
      const copy = join(root, String(code), "bench");
      for (const file of importClosure(join(import.meta.dirname, "run-all.mjs"))) {
        mkdirSync(dirname(join(copy, relative(bench, file))), { recursive: true });
        copyFileSync(file, join(copy, relative(bench, file)));
      }
      const here = join(copy, "fullstack");
      // Stand-ins for the step's scripts: each records that it ran; count.mjs exits with the code under test.
      const stand = (/** @type {string} */ name, /** @type {string} */ exit) => writeFileSync(join(here, name), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(here, "ran.txt"))}, ${JSON.stringify(name)} + "\\n");\nprocess.exit(${exit});\n`);
      stand("count.mjs", String(code));
      stand("conform.mjs", "0");
      stand("summarize.mjs", "0");
      const scratch = join(root, String(code), "tmp");
      mkdirSync(scratch);
      // No docker on PATH: the clean slate's docker calls fail and change nothing.
      const child = spawn(process.execPath, [join(here, "run-all.mjs"), "r1", "10", "count", "conform", "--unattended"], {
        cwd: here, env: { PATH: dirname(process.execPath), HOME: scratch, TMPDIR: scratch, BENCH_APP_CPUS: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let said = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => (said += d));
      const exit = await new Promise((done) => child.on("close", done));
      const ran = readFileSync(join(here, "ran.txt"), "utf8").split("\n").filter(Boolean);
      const lines = readFileSync(join(here, "results-r1.progress"), "utf8").split("\n").filter(Boolean);
      const progress = lines.map((l) => l.split(" ").slice(1, 3).join(" "));
      // The count step's start names the boot it started in.
      assert.equal(lines.find((l) => l.split(" ")[1] === "start")?.split(" ").slice(1).join(" "), `start count ${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}`);
      if (code === 4) {
        assert.equal(exit, 1, said);
        assert.deepEqual(ran, ["count.mjs"], said);
        assert.deepEqual(progress, ["boot", "start count", "failed"], said);
        assert.match(readFileSync(join(here, "results", "r1", "skipped.txt"), "utf8"), /step count skipped: count\.mjs exited 4: a perf it started was not seen to end, so the round stops here/);
        assert.ok(!said.includes("all done"), said);
      } else {
        assert.equal(exit, 0, said);
        assert.deepEqual(ran, ["count.mjs", "conform.mjs", "summarize.mjs"], said);
        assert.deepEqual(progress, ["boot", "start count", "end count", "start conform", "end conform", "start summary", "finished"], said);
        assert.ok(!existsSync(join(here, "results", "r1", "skipped.txt")), said);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unattended run-all.mjs that starts again in the boot its count step started in ends the round; one in another boot goes on", { skip: process.platform !== "linux" && "an unattended round runs on Linux only" }, async () => {
  const bench = resolve(import.meta.dirname, "..");
  const root = mkdtempSync(join(tmpdir(), "run-all-restart-"));
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  try {
    for (const [name, at] of [["same", boot], ["legacy", ""], ["other", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], ["cut", null]]) {
      const copy = join(root, name, "bench");
      for (const file of importClosure(join(import.meta.dirname, "run-all.mjs"))) {
        mkdirSync(dirname(join(copy, relative(bench, file))), { recursive: true });
        copyFileSync(file, join(copy, relative(bench, file)));
      }
      const here = join(copy, "fullstack");
      const stand = (/** @type {string} */ script) => writeFileSync(join(here, script), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(here, "ran.txt"))}, ${JSON.stringify(script)} + "\\n");\nprocess.exit(0);\n`);
      for (const script of ["count.mjs", "conform.mjs", "summarize.mjs"]) stand(script);
      // A start before this one, which stopped in its count step: run-all.mjs killed, or the host restarted.
      // "cut": a start line written short, with no end, as a write before appendLine could leave it.
      writeFileSync(join(here, "results-r1.progress"), at === null ? "t boot\nt start co" : `t boot\nt ${`start count ${at}`.trimEnd()}\n`);
      const scratch = join(root, name, "tmp");
      mkdirSync(scratch);
      const child = spawn(process.execPath, [join(here, "run-all.mjs"), "r1", "10", "count", "conform", "--unattended"], {
        cwd: here, env: { PATH: dirname(process.execPath), HOME: scratch, TMPDIR: scratch, BENCH_APP_CPUS: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let said = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => (said += d));
      const exit = await new Promise((done) => child.on("close", done));
      const ran = existsSync(join(here, "ran.txt")) ? readFileSync(join(here, "ran.txt"), "utf8").split("\n").filter(Boolean) : [];
      const progress = readFileSync(join(here, "results-r1.progress"), "utf8").split("\n").filter(Boolean).map((l) => l.split(" ").slice(1, 3).join(" "));
      const skipped = readFileSync(join(here, "results", "r1", "skipped.txt"), "utf8");
      if (name === "other") {
        assert.equal(exit, 0, said);
        assert.deepEqual(ran, ["conform.mjs", "summarize.mjs"], said);
        assert.deepEqual(progress, ["boot", "start count", "boot", "start conform", "end conform", "start summary", "finished"], said);
        assert.match(skipped, /step count skipped: the droplet restarted while it ran/);
      } else {
        assert.equal(exit, 1, `${name}: ${said}`);
        assert.deepEqual(ran, [], `${name}: ${said}`);
        // Refused before anything is written: a cut file is left as it is, the others record the failure.
        assert.deepEqual(progress, name === "cut" ? ["boot", "start co"] : ["boot", "start count", "failed"], `${name}: ${said}`);
        assert.match(skipped, name === "same" ? /step count skipped: the round stopped in its count step and it started again in the boot its count step started in, so a perf or probe that step started may still run; nothing more runs on this host/
          : name === "cut" ? /step count skipped: the round's progress file ends in a line cut short, so whether its count step started is not known/ : /its count step's start recorded no boot ID/, name);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A child process as superviseCall reads it, with outputs that never close unless told to. */
function fakeChild() {
  const stream = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  return Object.assign(new EventEmitter(), { pid: 4242, exitCode: /** @type {number | null} */ (null), signalCode: null, unrefs: 0, unref() { this.unrefs += 1; }, stdout: stream(), stderr: stream() });
}
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

test("a call settles on its process's exit and releases an output something it started holds open, never as a clean success", async () => {
  // Exit 4 with the output held open: settled with the code and a reason, the outputs destroyed, nothing signalled.
  const held = fakeChild();
  /** @type {string[]} */
  const signals = [];
  const heldRun = superviseCall(/** @type {any} */ (held), { label: "count.mjs", limitMs: Infinity, idleMs: Infinity, signalGroup: (_, s) => signals.push(s), write: () => {}, releaseMs: 100 });
  held.exitCode = 4; held.emit("exit", 4, null);
  const first = await Promise.race([heldRun, wait(5000).then(() => "pending")]);
  assert.notEqual(first, "pending", "a call whose output stays open after its exit never settled");
  assert.equal(/** @type {any} */ (first).code, 4);
  assert.match(/** @type {any} */ (first).stopped, /^count\.mjs exited 4 but its output stayed open 0 s after, so it was released$/);
  assert.ok(held.stdout.destroyed && held.stderr.destroyed);
  assert.equal(countHalt(/** @type {any} */ (first)), "count.mjs exited 4: a perf it started was not seen to end");
  // An exit 0 with its output released is not a clean success either.
  const zero = fakeChild();
  const zeroRun = superviseCall(/** @type {any} */ (zero), { label: "conform.mjs", limitMs: Infinity, idleMs: Infinity, signalGroup: (_, s) => signals.push(s), write: () => {}, releaseMs: 50 });
  zero.exitCode = 0; zero.emit("exit", 0, null);
  assert.match((await zeroRun).stopped ?? "", /exited 0 but its output stayed open/);
  // The control: an exit whose output closes settles clean, with what it wrote passed on.
  const clean = fakeChild();
  /** @type {string[]} */
  const wrote = [];
  const cleanRun = superviseCall(/** @type {any} */ (clean), { label: "conform.mjs", limitMs: Infinity, idleMs: Infinity, signalGroup: (_, s) => signals.push(s), write: (c) => wrote.push(String(c)), releaseMs: 5000 });
  clean.stdout.emit("data", Buffer.from("ok"));
  clean.exitCode = 0; clean.emit("exit", 0, null); clean.emit("close", 0, null);
  assert.deepEqual(await cleanRun, { stopped: null, code: 0, live: false });
  assert.deepEqual(wrote, ["ok"]);
  assert.deepEqual(signals, []);
});

test("a stopped call's group is signalled only while its process is unreaped, and one that never exits is left and released at a bound", async () => {
  // Stopped: SIGTERM; its process exits 4 before the grace, so no SIGKILL goes to the group's number afterwards.
  const exits = fakeChild();
  /** @type {string[]} */
  const signals = [];
  const run = superviseCall(/** @type {any} */ (exits), {
    label: "count.mjs", limitMs: 0, idleMs: Infinity, tickMs: 20, graceMs: 200, releaseMs: 50, write: () => {},
    signalGroup: (pid, s) => { signals.push(`${s} ${pid}`); setImmediate(() => { exits.exitCode = 4; exits.emit("exit", 4, null); }); },
  });
  const result = await run;
  assert.equal(result.code, 4);
  assert.match(result.stopped ?? "", /^count\.mjs ran longer than 0 minutes, so it was stopped; count\.mjs exited 4 but its output stayed open/);
  await wait(400);
  assert.deepEqual(signals, ["SIGTERM 4242"], "a group was signalled after its leader was reaped");
  // Reaped (its exit fields set) before its exit event is delivered: past its limit, nothing is signalled.
  const reaped = fakeChild();
  /** @type {string[]} */
  const none = [];
  reaped.exitCode = 0;
  const reapedRun = superviseCall(/** @type {any} */ (reaped), { label: "look.mjs", limitMs: 0, idleMs: 0, tickMs: 10, graceMs: 20, releaseMs: 1000, write: () => {}, signalGroup: (_, s) => none.push(s) });
  await wait(100);
  reaped.emit("exit", 0, null); reaped.emit("close", 0, null);
  assert.deepEqual(await reapedRun, { stopped: null, code: 0, live: false });
  assert.deepEqual(none, []);
  // Never exits: SIGTERM, then SIGKILL while still unreaped, then left unreferenced with its output released.
  const stuck = fakeChild();
  /** @type {string[]} */
  const both = [];
  const stuckResult = await superviseCall(/** @type {any} */ (stuck), { label: "count.mjs", limitMs: 0, idleMs: Infinity, tickMs: 20, graceMs: 50, releaseMs: 50, write: () => {}, signalGroup: (_, s) => both.push(s) });
  assert.deepEqual(both, ["SIGTERM", "SIGKILL"]);
  assert.equal(stuckResult.code, null);
  assert.match(stuckResult.stopped ?? "", /count\.mjs was still running 0 s after it was stopped, so it was left and its output released/);
  assert.ok(stuck.stdout.destroyed && stuck.stderr.destroyed && stuck.unrefs === 1);
  assert.equal(stuckResult.live, true);
  assert.notEqual(countHalt(stuckResult), null);
});

test("a real call that could not be started settles with why, never as an exit, though Node has set its exit code", async () => {
  const child = spawn(join(tmpdir(), "corten-no-such-command-i2151"), [], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  /** @type {string[]} */
  const signals = [];
  const result = await superviseCall(child, { label: "count.mjs", limitMs: Infinity, idleMs: Infinity, signalGroup: (_, s) => signals.push(s), write: () => {}, releaseMs: 500 });
  assert.equal(child.pid, undefined);
  assert.equal(result.code, null);
  assert.equal(result.live, false);
  assert.match(result.stopped ?? "", /^count\.mjs could not be started: spawn .*ENOENT/);
  assert.notEqual(countHalt(result), null);
  assert.deepEqual(signals, []);
});

test("a real call that exits 4 while a detached descendant holds its output settles within the release bound", async () => {
  const holder = "setTimeout(() => {}, 20000)";
  const script = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref(); console.log("started"); process.exit(4);`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  /** @type {string[]} */
  const signals = [];
  let wrote = "";
  const began = Date.now();
  const result = await superviseCall(child, { label: "count.mjs", limitMs: Infinity, idleMs: Infinity, signalGroup: (_, s) => signals.push(s), write: (c) => (wrote += c), releaseMs: 500 });
  assert.ok(Date.now() - began < 10_000, `took ${Date.now() - began} ms`);
  assert.equal(result.code, 4);
  assert.match(result.stopped ?? "", /exited 4 but its output stayed open/);
  assert.match(wrote, /started/);
  assert.deepEqual(signals, []);
});

test("an unattended run-all.mjs whose count exits 4 while a descendant holds its output open still stops the round", { skip: process.platform !== "linux" && "an unattended round runs on Linux only" }, async () => {
  const bench = resolve(import.meta.dirname, "..");
  const root = mkdtempSync(join(tmpdir(), "run-all-held-"));
  try {
    const copy = join(root, "bench");
    for (const file of importClosure(join(import.meta.dirname, "run-all.mjs"))) {
      mkdirSync(dirname(join(copy, relative(bench, file))), { recursive: true });
      copyFileSync(file, join(copy, relative(bench, file)));
    }
    const here = join(copy, "fullstack");
    // A descendant in a session of its own (out of the call's group) holds the output for 60 s, bounded by itself.
    writeFileSync(join(here, "count.mjs"), `import { appendFileSync } from "node:fs";\nimport { spawn } from "node:child_process";\nappendFileSync(${JSON.stringify(join(here, "ran.txt"))}, "count.mjs\\n");\nspawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref();\nprocess.exit(4);\n`);
    for (const script of ["conform.mjs", "summarize.mjs"]) writeFileSync(join(here, script), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(here, "ran.txt"))}, ${JSON.stringify(script)} + "\\n");\nprocess.exit(0);\n`);
    const scratch = join(root, "tmp");
    mkdirSync(scratch);
    const child = spawn(process.execPath, [join(here, "run-all.mjs"), "r1", "10", "count", "conform", "--unattended"], {
      cwd: here, env: { PATH: dirname(process.execPath), HOME: scratch, TMPDIR: scratch, BENCH_APP_CPUS: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let said = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => (said += d));
    const bound = outputReleaseMs + 20_000;
    const exit = await Promise.race([new Promise((done) => child.on("exit", done)), wait(bound).then(() => "pending")]);
    if (exit === "pending") child.kill("SIGKILL");
    assert.notEqual(exit, "pending", `run-all.mjs did not end within ${bound} ms of a count that exited 4: ${said}`);
    assert.equal(exit, 1, said);
    assert.deepEqual(readFileSync(join(here, "ran.txt"), "utf8").split("\n").filter(Boolean), ["count.mjs"], said);
    assert.deepEqual(readFileSync(join(here, "results-r1.progress"), "utf8").split("\n").filter(Boolean).map((l) => l.split(" ").slice(1, 3).join(" ")), ["boot", "start count", "failed"], said);
    assert.match(readFileSync(join(here, "results", "r1", "skipped.txt"), "utf8"), /step count skipped: count\.mjs exited 4: a perf it started was not seen to end/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restart on a progress file cut short writes nothing over it, so a start stopped part way leaves the next start the same refusal", { skip: process.platform !== "linux" && "an unattended round runs on Linux only" }, async () => {
  const bench = resolve(import.meta.dirname, "..");
  const root = mkdtempSync(join(tmpdir(), "run-all-torn-"));
  try {
    const copy = join(root, "bench");
    for (const file of importClosure(join(import.meta.dirname, "run-all.mjs"))) {
      mkdirSync(dirname(join(copy, relative(bench, file))), { recursive: true });
      copyFileSync(file, join(copy, relative(bench, file)));
    }
    const here = join(copy, "fullstack");
    for (const script of ["count.mjs", "conform.mjs", "summarize.mjs"]) writeFileSync(join(here, script), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(here, "ran.txt"))}, ${JSON.stringify(script)} + "\\n");\nprocess.exit(0);\n`);
    const torn = "t boot\nt start co";
    writeFileSync(join(here, "results-r1.progress"), torn);
    // The first restart stops dead (as a power loss would) right after any progress line it writes is synced.
    const patch = join(root, "stop-after-sync.mjs");
    writeFileSync(patch, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeSync, sync = fs.fsyncSync;
let wrote = null;
fs.writeSync = function (fd, ...rest) { const n = write.call(this, fd, ...rest); wrote = fd; return n; };
fs.fsyncSync = function (fd) { sync.call(this, fd); if (fd === wrote) process.kill(process.pid, "SIGKILL"); };
syncBuiltinESMExports();
`);
    const scratch = join(root, "tmp");
    mkdirSync(scratch);
    /** Each start's output and the progress file after it. @type {[string, string, string][]} */
    const starts = [];
    for (const start of ["stopped after its first write", "next"]) {
      const child = spawn(process.execPath, [...(start === "next" ? [] : ["--import", pathToFileURL(patch).href]), join(here, "run-all.mjs"), "r1", "10", "count", "conform", "--unattended"], {
        cwd: here, env: { PATH: dirname(process.execPath), HOME: scratch, TMPDIR: scratch, BENCH_APP_CPUS: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let said = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => (said += d));
      await new Promise((done) => child.on("close", done));
      starts.push([start, said, readFileSync(join(here, "results-r1.progress"), "utf8")]);
    }
    const ran = existsSync(join(here, "ran.txt")) ? readFileSync(join(here, "ran.txt"), "utf8").split("\n").filter(Boolean) : [];
    assert.deepEqual(ran, [], `count dispatched past a cut progress line: ${JSON.stringify(starts)}`);
    for (const [start, said, text] of starts) {
      assert.equal(text, torn, `${start}: ${said}`);
      assert.match(said, /round failed: the round's progress file ends in a line cut short/, start);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a round started from a step and then restarted goes on after the step it was in", () => {
  assert.deepEqual(resumeAt("t start api\n", "api"), { ended: null, skip: "api", app: null, next: "count", boots: 0, built: [] });
});

test("a start cut short before its first step still counts", () => {
  assert.deepEqual(resumeAt("t boot\nt boot\n"), { ended: null, skip: null, app: null, next: "cold-start", boots: 2, built: [] });
});

test("a round starts at most once a step and twice more", () => {
  assert.equal(mayStart(0), true);
  assert.equal(mayStart(steps.length + 1), true);
  assert.equal(mayStart(steps.length + 2), false);
});

test("a round that ended does not start again", () => {
  assert.equal(resumeAt("t start browser\nt end browser\nt start summary\nt finished\n").ended, "finished");
  assert.equal(resumeAt("t boot\nt failed\n").ended, "failed");
});

test("the summary is not a step: a restart in it runs the summary again", () => {
  const state = resumeAt("t start build\nt end build\nt start summary\n");
  assert.equal(state.skip, null);
  assert.equal(state.next, null);
});

test("every step has calls, each with a time limit, in the steps' order", () => {
  const all = calls("r10", "10", ["corten", "nextjs"], ["http://localhost:18410", "http://localhost:18411"]);
  assert.deepEqual([...new Set(all.map(([step]) => step))], steps);
  for (const [, limit] of all) assert.ok(limit > 0 && limit <= 220);
  const browser = all.filter(([step]) => step === "browser").at(-1);
  assert.deepEqual(browser?.slice(2), ["browser.mjs", "corten=http://localhost:18410", "nextjs=http://localhost:18411", "runs=10", "out=r10/browser.json"]);
});

test("the builds come last, one call an app", () => {
  const all = calls("r13", "10", ["corten", "nextjs"], ["http://localhost:18410", "http://localhost:18411"]);
  assert.equal(steps.at(-1), "build");
  assert.deepEqual(all.filter(([step]) => step === "build").map((c) => c.slice(2)), [["build.mjs", "r13", "corten"], ["build.mjs", "r13", "nextjs"]]);
});

test("the compiled apps build first, the others in the order given", () => {
  for (const name of compiledFirst) assert.ok(name in apps, `${name} is not an app`);
  const order = calls("r13", "10", ["nextjs", "django", "gin", "corten", "leptos"], ["u1", "u2", "u3", "u4", "u5"]).filter(([step]) => step === "build").map((c) => c.at(-1));
  assert.deepEqual(order, ["corten", "leptos", "gin", "nextjs", "django"]);
});

test("a full-stack round's calls and its build budget fit in its unit's hours, for every number of passes", () => {
  const names = Object.keys(apps);
  assert.equal(hoursFor(1), fullstackHours);
  for (let passes = 1; passes <= maxPasses; passes += 1) {
    const all = calls("r13", "10", names, names.map((_, i) => `u${i}`), [], passes);
    // Every app may take its full wait to start before the browser step.
    const measuring = all.filter(([step]) => step !== "build").reduce((n, [, limit]) => n + limit, 0) + names.length * startMinutes;
    // The budget stops new builds; the last one started may still run to its own limit.
    const lastBuild = Math.max(...all.filter(([step]) => step === "build").map(([, limit]) => limit));
    const hours = hoursFor(passes);
    assert.ok(measuring + buildBudgetMinutes + lastBuild + 10 <= hours * 60, `${passes} passes: ${measuring} + ${buildBudgetMinutes} + ${lastBuild} + 10 (the summary) minutes do not fit in ${hours} hours`);
  }
});

test("each load call runs the round's passes, with that many times one pass's limit", () => {
  const one = calls("r15", "10", ["corten"], ["u1"]).filter(([, , script]) => script === "run-ssr.mjs");
  const three = calls("r15", "10", ["corten"], ["u1"], [], 3).filter(([, , script]) => script === "run-ssr.mjs");
  assert.equal(one.length, 4);
  for (const [i, call] of three.entries()) {
    assert.equal(call[1], one[i][1] * 3);
    assert.equal(call.at(-1), "3");
    assert.equal(one[i].at(-1), "1");
  }
});

test("BENCH_APPS keeps only the apps it names, in the catalog's order, and pageApps leaves out those without pages", () => {
  const list = (/** @type {string} */ only) => spawnSync(process.execPath, ["--input-type=module", "-e", 'const a = await import("./apps.mjs"); console.log(JSON.stringify([Object.keys(a.apps), Object.keys(a.pageApps)]))'], { cwd: import.meta.dirname, encoding: "utf8", env: { ...process.env, BENCH_APPS: only } });
  const picked = list("aspnet-aot, corten,aspnet");
  assert.equal(picked.status, 0, picked.stderr);
  assert.deepEqual(JSON.parse(picked.stdout), [["corten", "aspnet", "aspnet-aot"], ["corten", "aspnet"]]);
  assert.match(list("aspnet").stderr, /must include corten/);
  assert.match(list("corten,nope").stderr, /names nope, which is not an app/);
});

test("count.mjs has perf watch the app's pinned cores on a bench host, and every core elsewhere", () => {
  const cpus = (/** @type {Record<string, string>} */ env) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'const a = await import("./apps.mjs"); console.log(JSON.stringify([a.countCpus, a.appCpus]))'], { cwd: import.meta.dirname, encoding: "utf8", env: { ...process.env, BENCH_APP_CPUS: "", ...env } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // The cores perf watches are the ones Docker pins the app to.
  assert.deepEqual(cpus({ BENCH_APP_CPUS: "1" }), [["-C", "1"], ["--cpuset-cpus", "1"]]);
  assert.deepEqual(cpus({ BENCH_APP_CPUS: "1-2" }), [["-C", "1-2"], ["--cpuset-cpus", "1-2"]]);
  assert.deepEqual(cpus({})[0], ["-a"]);
});

test("count.mjs counts user and kernel instructions in two perf sessions, never in one (#2151)", () => {
  // Each session starts with its events disabled and takes enable and disable on its control
  // descriptor, acknowledging each, so a count knows perf counted over its whole load (#2183).
  const control = ["--delay=-1", "--control=fd:3,4"];
  assert.deepEqual(perfCountArgs(["-C", "1"], "app.scope", passEvents("main")), [
    "stat", "-C", "1", "-A", "-x", ",", "--log-fd", "1", ...control, "-e",
    "cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u",
    "-G", "app.scope,app.scope,app.scope,app.scope",
  ]);
  assert.deepEqual(perfCountArgs(["-C", "1"], "app.scope", passEvents("main", true)), [
    "stat", "-C", "1", "-A", "-x", ",", "--log-fd", "1", ...control, "-e", "instructions:u", "-G", "app.scope",
  ]);
  assert.deepEqual(perfCountArgs(["-C", "1"], "app.scope", passEvents("kernel")), [
    "stat", "-C", "1", "-A", "-x", ",", "--log-fd", "1", ...control, "-e", "instructions:k", "-G", "app.scope",
  ]);
  // The kernel pass already counts its one event: retrying it "with instructions only" is the same set.
  assert.deepEqual(passEvents("kernel", true), ["instructions:k"]);
  // Every set a count or its probe gives perf holds at most one of the two, and a list that holds both is refused.
  for (const set of [passEvents("main"), passEvents("main", true), passEvents("kernel"), ...PROBE_SETS]) {
    assert.ok(!(set.includes("instructions:u") && set.includes("instructions:k")), set.join(","));
  }
  assert.deepEqual(PROBE_SETS, [["instructions:u"], ["instructions:k"], passEvents("main")]);
  for (const both of [["instructions:u", "instructions:k"], ["instructions:k", "cycles:u", "instructions:u"]]) {
    assert.throws(() => perfCountArgs(["-C", "1"], "app.scope", both), /instructions:u and instructions:k in one session/);
    assert.throws(() => perfProbeArgs(["-C", "1"], both), /instructions:u and instructions:k in one session/);
  }
  // The list is checked as perf reads it once joined: an entry that holds a comma is two events.
  for (const joined of [["instructions:u,instructions:k"], ["cycles:u,cycles:k", "instructions:u,instructions:k"], ["instructions:k, instructions:u"]]) {
    assert.throws(() => perfCountArgs(["-C", "1"], "app.scope", joined), /instructions:u and instructions:k in one session/, joined.join("|"));
    assert.throws(() => perfProbeArgs(["-C", "1"], joined), /instructions:u and instructions:k in one session/, joined.join("|"));
  }
  // Anything but the three sets a count gives perf, exactly as it gives them, is refused.
  for (const other of [["instructions:u "], [" instructions:k"], ["instructions:u", "cycles:k"], ["cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u"], [...passEvents("main")].reverse(), [], ["instructions:u", "instructions:u"], "instructions:u", [1]]) {
    assert.throws(() => perfCountArgs(["-C", "1"], "app.scope", /** @type {any} */ (other)), /not one of the event sets a count gives it|not a list of event names/, JSON.stringify(other));
    assert.throws(() => perfProbeArgs(["-C", "1"], /** @type {any} */ (other)), /not one of the event sets a count gives it|not a list of event names/, JSON.stringify(other));
  }
  for (const set of PROBE_SETS) assert.doesNotThrow(() => perfProbeArgs(["-C", "1"], set));
  assert.throws(() => passEvents("both"), /unknown perf pass/);
  assert.deepEqual(perfProbeArgs(["-C", "1"], ["instructions:k"]), ["stat", "-C", "1", "-x", ",", "--log-fd", "1", "-e", "instructions:k", "--", "sleep", "1"]);
});

test("perf's CPUs are every CPU or a CPU list, so nothing else (another -e) reaches its arguments in a count or a probe", () => {
  // The positive forms: every CPU, one CPU, a range, a list of both.
  for (const cpus of [["-a"], ["-C", "1"], ["-C", "1-2"], ["-C", "0,2-3,7"]]) {
    assert.deepEqual(perfCountArgs(cpus, "app.scope", passEvents("kernel")).slice(1, 1 + cpus.length), cpus);
    assert.deepEqual(perfProbeArgs(cpus, ["instructions:k"]).slice(1, 1 + cpus.length), cpus);
  }
  // A CPU argument that carries another event, or anything but those forms, is refused before perf runs.
  for (const cpus of [
    ["-C", "1", "-e", "instructions:u"], ["-a", "-e", "instructions:u"], ["-e", "instructions:u"], ["-C", "1 -e instructions:u"],
    ["-C", "1,-e"], ["-C", "-e"], ["-C", ""], ["-C"], [], ["-C", "1", "-C", "2"], ["--cpu=1"], "-a", ["-C", 1], ["-a", "-a"],
  ]) {
    assert.throws(() => perfCountArgs(/** @type {any} */ (cpus), "app.scope", passEvents("kernel")), /not -a or -C with a CPU list/, JSON.stringify(cpus));
    assert.throws(() => perfProbeArgs(/** @type {any} */ (cpus), ["instructions:k"]), /not -a or -C with a CPU list/, JSON.stringify(cpus));
  }
});

const mainText = (cacheEvent = "L1-icache-load-misses:u") => [
  "# started on bench host",
  "CPU1,12345,,instructions:u,app.scope,60000,100.00,",
  "CPU1,5678,,cycles:u,app.scope,60000,100.00,",
  "CPU1,0,,cycles:k,app.scope,60000,100.00,",
  `CPU1,87,,${cacheEvent},app.scope,60000,100.00,`,
].join("\n");
const userInstructions = "CPU1,12345,,instructions:u,app.scope,60000,100.00,";
const kernelInstructions = "CPU1,1234,,instructions:k,app.scope,60000,100.00,";
const pass = (text, requests = 10, failed = 0) => ({ counts: parsePerCpuCounts(text, [1]), requests, failed });
/** measurePerfCounts over perf rows of CPU 1, the CPU these counts give perf. */
const measure = (/** @type {any} */ collect, /** @type {any} */ warn, /** @type {any} */ expected = {}) => measurePerfCounts(collect, warn, { cpus: [1], ...expected });

test("count.mjs reads each count over its own pass's load", () => {
  for (const cacheEvent of ["L1-icache-load-misses", "L1-icache-load-misses:u"]) {
    assert.deepEqual(countRow(pass(mainText(cacheEvent)), pass(kernelInstructions)), {
      requests: 10, failed: 0, kernelPass: { requests: 10, failed: 0 }, userPerRequest: 1235, kernelPerRequest: 123,
      userCyclesPerRequest: 568, kernelCyclesPerRequest: 0, userL1iMissesPerRequest: 9,
      perfRunningPct: { "instructions:u": 100, "instructions:k": 100, "cycles:u": 100, "cycles:k": 100, "L1-icache-load-misses:u": 100 },
      perfDiagnostics: {},
    });
  }
  // Kernel instructions are divided by the kernel pass's requests, the rest by the main pass's.
  const row = countRow(pass(mainText(), 10, 1), pass(kernelInstructions, 2, 0));
  assert.deepEqual([row.requests, row.failed, row.kernelPass, row.userPerRequest, row.kernelPerRequest], [10, 1, { requests: 2, failed: 0 }, 1235, 617]);
});

test("a count's events are summed over each CPU perf was given, and kept only when every one of them counted with full coverage", () => {
  // perf 6.1's rows a CPU (`-A -x , -G`), as it printed them for a cgroup that ran on CPU 0 alone:
  // CPU 1's counter never ran, and perf still prints 100.00 for it, as its own total read 100% too.
  const real = [
    "CPU0,2166251060,,instructions:u,pt,900798000,100.00,,",
    "CPU1,<not counted>,,instructions:u,pt,0,100.00,,",
  ].join("\n");
  // Perf given CPU 0 alone: its one row, counted.
  assert.deepEqual(parsePerCpuCounts(real.split("\n")[0], [0]).get("instructions:u"), { count: 2166251060, runningPct: 100, error: null });
  assert.deepEqual(parsePerCpuCounts(real, [0, 1]).get("instructions:u"), { count: null, runningPct: 100, error: "CPU 1: <not counted>" });
  // Each CPU's count is summed; the percentage is the lowest CPU's.
  const two = (/** @type {string} */ second) => `CPU0,100,,instructions:k,app.scope,5000,100.00,,\n${second}`;
  assert.deepEqual(parsePerCpuCounts(two("CPU1,23,,instructions:k,app.scope,7000,100.00,,"), [0, 1]).get("instructions:k"), { count: 123, runningPct: 100, error: null });
  assert.deepEqual(parsePerCpuCounts(two("CPU1,23,,instructions:k,app.scope,7000,40.00,,"), [0, 1]).get("instructions:k"), { count: 123, runningPct: 40, error: null });
  for (const [text, cpus, error] of [
    // A CPU with a count and no running time, one with no row, one perf was not given, one twice.
    [two("CPU1,0,,instructions:k,app.scope,0,100.00,,"), [0, 1], "CPU 1: no running time, so perf is not shown to have counted there"],
    [two(""), [0, 1], "no row for CPU 1"],
    [two("CPU2,23,,instructions:k,app.scope,7000,100.00,,"), [0, 1], "a row for CPU 2, which perf was not given"],
    [two("CPU0,23,,instructions:k,app.scope,7000,100.00,,"), [0], "two rows for CPU 0"],
    // Counts whose sum is not exact.
    [two(`CPU1,${2 ** 53},,instructions:k,app.scope,7000,100.00,,`), [0, 1], "its CPUs' counts sum past 2^53 - 1"],
    // A percentage past 100, which the lowest of the CPUs' would otherwise read as 100, on either CPU.
    [two("CPU1,23,,instructions:k,app.scope,7000,101.00,,"), [0, 1], "CPU 1: running percentage 101.00 is outside 0 to 100"],
    [`CPU0,100,,instructions:k,app.scope,5000,100.01,,\nCPU1,23,,instructions:k,app.scope,7000,100.00,,`, [0, 1], "CPU 0: running percentage 100.01 is outside 0 to 100"],
    [two(`CPU1,23,,instructions:k,app.scope,7000,${"9".repeat(400)},,`), [0, 1], `CPU 1: running percentage ${"9".repeat(400)} is outside 0 to 100`],
    // Read from its digits, not its conversion: a hair above 100, or below it, converts to exactly 100.
    [two("CPU1,23,,instructions:k,app.scope,7000,100.000000000000001,,"), [0, 1], "CPU 1: running percentage 100.000000000000001 is outside 0 to 100"],
    [two("CPU1,23,,instructions:k,app.scope,7000,0100.0000000000000001,,"), [0, 1], "CPU 1: running percentage 0100.0000000000000001 is outside 0 to 100"],
    [two("CPU1,23,,instructions:k,app.scope,7000,99.99999999999999999,,"), [0, 1], "CPU 1: running percentage 99.99999999999999999 is below 100 but converts to 100"],
  ]) assert.equal(parsePerCpuCounts(/** @type {string} */ (text), /** @type {number[]} */ (cpus)).get("instructions:k")?.error, error, String(text));
  // The controls: exactly 100 however it is written, and a percentage below 100 kept as such.
  for (const text of ["100", "100.00", "0100.000", "100.000000000000000000"]) assert.deepEqual(parsePerCpuCounts(two(`CPU1,23,,instructions:k,app.scope,7000,${text},,`), [0, 1]).get("instructions:k"), { count: 123, runningPct: 100, error: null }, text);
  assert.deepEqual(parsePerCpuCounts(two("CPU1,23,,instructions:k,app.scope,7000,99.99,,"), [0, 1]).get("instructions:k"), { count: 123, runningPct: 99.99, error: null });
  // A total (no CPU column) is not a count's row at all.
  assert.equal(parsePerCpuCounts("123,,instructions:k,app.scope,7000,100.00,,", [1]).get("instructions:k"), undefined);
  // The row a count keeps from such a CPU is none: the counter is unusable and named.
  const row = countRow({ counts: parsePerCpuCounts(real.replaceAll("instructions:u", "instructions:k").replaceAll(",pt,", ",app.scope,"), [0, 1]), requests: 10, failed: 0 }, { counts: parsePerCpuCounts(real.replaceAll("instructions:u", "instructions:k"), [0, 1]), requests: 10, failed: 0 });
  assert.equal(row.kernelPerRequest, null);
  assert.equal(row.perfDiagnostics["instructions:k"], "CPU 1: <not counted>");
});

test("a count's CPUs are -C's list or every online CPU, and a count with none to read runs no load", async () => {
  assert.deepEqual(selectedCpus(["-C", "1"], undefined), [1]);
  assert.deepEqual(selectedCpus(["-C", "0,2-3,7"], undefined), [0, 2, 3, 7]);
  assert.deepEqual(selectedCpus(["-a"], "0-3\n"), [0, 1, 2, 3]);
  for (const [cpus, online] of [[["-a"], undefined], [["-a"], ""], [["-a"], "0-x"], [["-C", "3-1"], undefined], [["-C", "0-999999"], undefined], [["-C", "1", "-e", "x"], undefined]]) {
    assert.throws(() => selectedCpus(cpus, online), /cannot tell which CPUs perf counts on|not -a or -C with a CPU list/, JSON.stringify([cpus, online]));
  }
  for (const expected of [undefined, {}, { cpus: [] }, { cpus: ["1"] }]) {
    let ran = false;
    await assert.rejects(measurePerfCounts(() => { ran = true; return {}; }, assert.fail, /** @type {any} */ (expected)), /not a list of CPU numbers/);
    assert.equal(ran, false);
  }
});

test("perf's acknowledgments are bound to its commands: one to each, in order, and no other", async () => {
  // perf 6.1's "ack\n\0" for each command, however its bytes arrive.
  const fine = acknowledgments(1000);
  const enabled = fine.command();
  fine.data("ac");
  fine.data("k\n");
  assert.equal(await enabled, "ack");
  const disabled = fine.command();
  fine.data("\0ack\n\0");
  assert.equal(await disabled, "ack");
  fine.end();
  assert.equal(fine.error(), null);
  // Two acknowledgments after enable and none after disable: a fault, whether they come together or apart.
  for (const apart of [false, true]) {
    const two = acknowledgments(50);
    const first = two.command();
    if (apart) { two.data("ack\n\0"); await new Promise((r) => setTimeout(r, 5)); two.data("ack\n\0"); } else two.data("ack\n\0ack\n\0");
    assert.equal(await first, "ack");
    assert.match(String(two.error()), /perf acknowledged 2 commands where it had been given 1/);
    assert.equal(await two.command(), "fault");
  }
  // An acknowledgment before its command, or one too many after the last.
  const early = acknowledgments(50);
  early.data("ack\n\0");
  assert.match(String(early.error()), /acknowledged 1 commands where it had been given 0/);
  const late = acknowledgments(50);
  const one = late.command();
  late.data("ack\n\0");
  assert.equal(await one, "ack");
  late.data("ack\n\0");
  late.end();
  assert.match(String(late.error()), /acknowledged 2 commands where it had been given 1/);
  // None within the bound, perf ending first, or anything else on the descriptor.
  const silent = acknowledgments(30);
  assert.equal(await silent.command(), "timeout");
  const ended = acknowledgments(1000);
  const waiting = ended.command();
  ended.end();
  assert.equal(await waiting, "closed");
  assert.equal(ended.error(), null);
  const other = acknowledgments(1000);
  const asked = other.command();
  other.data("nack\n");
  assert.equal(await asked, "fault");
  assert.match(String(other.error()), /perf wrote "nack" on its acknowledgment descriptor/);
  const cut = acknowledgments(1000);
  const cutAsked = cut.command();
  cut.data("ac");
  cut.end();
  assert.equal(await cutAsked, "closed");
  assert.match(String(cut.error()), /perf left "ac" on its acknowledgment descriptor/);
  // Part of a line written before a command is given cannot answer it, however the rest arrives:
  // "ack\n\0ac" during enable, then disable, then "k\n\0" is a fault, not an ack for both.
  const split = acknowledgments(1000);
  const splitEnable = split.command();
  split.data("ack\n\0ac");
  assert.equal(await splitEnable, "ack");
  const splitDisable = split.command();
  split.data("k\n\0");
  assert.equal(await splitDisable, "fault");
  assert.match(String(split.error()), /perf wrote "\\u0000ac" on its acknowledgment descriptor before command 2 was given/);
  // The control: the NUL after an "ack\n", alone or split from it, is no fragment.
  const nul = acknowledgments(1000);
  const nulEnable = nul.command();
  nul.data("ack\n");
  assert.equal(await nulEnable, "ack");
  nul.data("\0");
  const nulDisable = nul.command();
  nul.data("ack\n\0");
  assert.equal(await nulDisable, "ack");
  nul.end();
  assert.equal(nul.error(), null);
  // One command at a time.
  const busy = acknowledgments(30);
  const pending = busy.command();
  assert.throws(() => busy.command(), /still waiting/);
  await pending;
});

test("the summary says which load each key's kernel instructions are from: a second load, the same load, or both across its runs", () => {
  const here = import.meta.dirname;
  const round = `kernel-load-test-${process.pid}-${Date.now()}`;
  const dir = join(here, "results", round);
  mkdirSync(dir);
  try {
    const run = (/** @type {boolean} */ second) => ({ requests: 5000, failed: 0, ...(second ? { kernelPass: { requests: 5000, failed: 0 } } : {}), userPerRequest: 75000, kernelPerRequest: 26000 });
    writeFileSync(join(dir, "instructions.json"), JSON.stringify({ "corten/page": [run(true), run(true), run(true)], "corten/json": [run(false), run(false), run(false)], "corten/page/api": [run(false), run(true), run(true)] }));
    const result = spawnSync(process.execPath, [join(here, "summarize.mjs"), round], { encoding: "utf8", windowsHide: true, timeout: 15_000, env: { ...process.env, BENCH_TIER: "defaults", BENCH_APPS: "corten" } });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    assert.deepEqual(Object.fromEntries(Object.entries(summary.instructions).map(([k, v]) => [k, /** @type {any} */ (v).kernelLoad])), { "corten/page": "second", "corten/json": "same", "corten/page/api": "mixed" });
    const lines = result.stdout.split("\n");
    assert.ok(lines.some((l) => l.startsWith("| corten/page |") && l.includes("kernel over a second load")), result.stdout);
    assert.ok(lines.some((l) => l.startsWith("| corten/json |") && l.includes("kernel over the same load") && !l.includes("second")), result.stdout);
    assert.ok(lines.some((l) => l.startsWith("| corten/page/api |") && l.includes("kernel over the same load in some runs, a second in others")), result.stdout);
    assert.ok(!result.stdout.includes("kernel over its second"), result.stdout);
  } finally {
    assert.equal(dirname(dir), join(here, "results"));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("count.mjs keeps instructions when optional perf events are unavailable", () => {
  const main = pass([userInstructions, "CPU1,<not supported>,,cycles:u,app.scope,0,100.00,", "CPU1,<not counted>,,cycles:k,app.scope,0,100.00,"].join("\n"));
  assert.deepEqual(JSON.parse(JSON.stringify(countRow(main, pass(kernelInstructions)))), {
    requests: 10, failed: 0, kernelPass: { requests: 10, failed: 0 }, userPerRequest: 1235, kernelPerRequest: 123,
    userCyclesPerRequest: null, kernelCyclesPerRequest: null, userL1iMissesPerRequest: null,
    perfRunningPct: { "instructions:u": 100, "instructions:k": 100, "cycles:u": 100, "cycles:k": 100, "L1-icache-load-misses:u": null },
    perfDiagnostics: {
      "cycles:u": "CPU 1: <not supported>", "cycles:k": "CPU 1: <not counted>", "L1-icache-load-misses:u": "no perf row",
    },
  });
});

function countSummary(count, failed = 0, checksFailed = 0) {
  return { metrics: {
    http_reqs: { count },
    http_req_failed: { passes: failed },
    checks: { passes: count - checksFailed, fails: checksFailed },
  } };
}

test("count.mjs runs the main pass, then the kernel pass, and reads a pass's own events only", async () => {
  const calls = [];
  const row = await measure((p, instructionsOnly) => {
    calls.push([p, instructionsOnly]);
    // A row of the other pass's event in a pass's output is not read from it.
    return p === "main"
      ? { text: `${mainText()}\nCPU1,999,,instructions:k,app.scope,60000,100.00,`, summary: countSummary(10) }
      : { text: `${kernelInstructions}\nCPU1,1,,cycles:u,app.scope,60000,100.00,`, summary: countSummary(10) };
  }, assert.fail);
  assert.deepEqual(calls, [["main", false], ["kernel", false]]);
  assert.equal(row.kernelPerRequest, 123);
  assert.equal(row.userCyclesPerRequest, 568);
});

test("count.mjs records partial and missing optional coverage without reporting usable counts", async () => {
  const row = await measure((p, instructionsOnly) => {
    assert.equal(instructionsOnly, false);
    return p === "kernel" ? { text: kernelInstructions, summary: countSummary(10) } : { text: [
      userInstructions,
      "CPU1,5678,,cycles:u,app.scope,60000,8.00,",
      "CPU1,1200,,cycles:k,app.scope,60000,100.00,",
      "CPU1,87,,L1-icache-load-misses:u,app.scope,60000,,",
    ].join("\n"), summary: countSummary(10) };
  }, assert.fail);
  assert.equal(row.userCyclesPerRequest, null);
  assert.equal(row.kernelCyclesPerRequest, 120);
  assert.equal(row.userL1iMissesPerRequest, null);
  assert.equal(row.perfRunningPct["cycles:u"], 8);
  assert.equal(row.perfRunningPct["L1-icache-load-misses:u"], null);
  assert.match(row.perfDiagnostics["cycles:u"], /8% of enabled time/);
  assert.match(row.perfDiagnostics["L1-icache-load-misses:u"], /missing or invalid/);
});

test("count.mjs retries partial user instruction coverage without optional events, then rejects if still partial", async () => {
  const partial = mainText().replace("60000,100.00", "60000,12.50");
  const warnings = [];
  const calls = [];
  const collect = (p, instructionsOnly) => {
    calls.push([p, instructionsOnly]);
    if (p === "kernel") return { text: kernelInstructions, summary: countSummary(10) };
    return { text: instructionsOnly ? userInstructions : partial, summary: countSummary(instructionsOnly ? 10 : 20) };
  };
  const row = await measure(collect, (message) => warnings.push(message));
  assert.deepEqual(calls, [["main", false], ["main", true], ["kernel", false]]);
  assert.equal(row.requests, 10);
  assert.equal(row.failed, 0);
  assert.equal(row.userPerRequest, 1235);
  assert.equal(row.kernelPerRequest, 123);
  assert.equal(row.perfRunningPct["instructions:u"], 100);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /instructions:u: perf ran 12\.5% .*retrying with instructions only/);
  const after = [];
  await assert.rejects(
    measure((p, instructionsOnly) => { after.push([p, instructionsOnly]); return { text: instructionsOnly ? partial.split("\n")[1] : partial, summary: countSummary(10) }; }, () => {}),
    /instructions-only perf failed: instructions:u: perf ran 12\.5%/,
  );
  // A failed main pass leaves the kernel pass unrun.
  assert.deepEqual(after, [["main", false], ["main", true]]);
});

test("count.mjs does not retry away failures in the first load", async () => {
  const partial = mainText().replace("60000,100.00", "60000,12.50");
  for (const [failed, checksFailed] of [[9, 9], [0, 2]]) {
    const attempts = [];
    await assert.rejects(measure((p, instructionsOnly) => {
      attempts.push([p, instructionsOnly]);
      return {
        text: instructionsOnly ? userInstructions : partial,
        summary: instructionsOnly ? countSummary(5000) : countSummary(5000, failed, checksFailed),
      };
    }, assert.fail), new RegExp(`first load had ${failed} HTTP request failures and ${checksFailed} failed status checks`));
    assert.deepEqual(attempts, [["main", false]]);
  }
});

test("count.mjs does not retry the kernel pass: an unusable kernel instructions count or failures in its load reject the count", async () => {
  for (const [kernel, error] of [
    [{ text: kernelInstructions.replace("60000,100.00", "60000,50.00"), summary: countSummary(10) }, /kernel instructions' perf failed: instructions:k: perf ran 50%/],
    [{ text: "", error: "perf did not count the full load: no answer", summary: countSummary(10) }, /kernel instructions' perf failed: perf did not count the full load: no answer/],
    // A load that ran is whole before its counts are read.
    [{ text: kernelInstructions, summary: countSummary(0) }, /kernel instructions' load is not whole: 0 requests, not 10/],
    [{ text: "", error: "perf did not count the full load: exit 1", summary: countSummary(10, 3, 0) }, /kernel instructions' load had 3 HTTP request failures and 0 failed status checks/],
  ]) {
    const attempts = [];
    await assert.rejects(measure((p, instructionsOnly) => {
      attempts.push([p, instructionsOnly]);
      return p === "main" ? { text: mainText(), summary: countSummary(10) } : kernel;
    }, assert.fail), error);
    assert.deepEqual(attempts, [["main", false], ["kernel", false]]);
  }
});

test("a count is returned only when both loads are whole: as many requests as the count makes, none failed in the kernel load, a status check a request, every total given", async () => {
  const run = (/** @type {any} */ main, /** @type {any} */ kernel, expected = { requests: 10 }) => measure((p) => (p === "main" ? { text: mainText(), summary: main } : { text: kernelInstructions, summary: kernel }), assert.fail, expected);
  // Both whole: the row.
  assert.equal((await run(countSummary(10), countSummary(10))).kernelPerRequest, 123);
  for (const [main, kernel, why] of [
    // 4,999 requests in the kernel load, with or without failures, where the first load made 5,000.
    [countSummary(5000), countSummary(4999), /kernel instructions' load is not whole: 4999 requests, not 5000/],
    [countSummary(5000), countSummary(4999, 3, 3), /kernel instructions' load is not whole: 4999 requests, not 5000/],
    // Failures in a whole kernel load: its count is not kept.
    [countSummary(5000), countSummary(5000, 2, 0), /kernel instructions' load had 2 HTTP request failures and 0 failed status checks across 5000 requests, so its count is not kept/],
    [countSummary(5000), countSummary(5000, 0, 1), /kernel instructions' load had 0 HTTP request failures and 1 failed status checks/],
    // The first load short of the count's requests.
    [countSummary(4999), countSummary(5000), /first load is not whole: 4999 requests, not 5000/],
    // A total missing or not a whole number, or checks that do not add up to the requests.
    [countSummary(5000), { metrics: { http_reqs: { count: 5000 }, checks: { passes: 5000, fails: 0 } } }, /kernel instructions' load is not whole: its k6 summary gives no failed/],
    [{ metrics: { http_reqs: { count: 5000 }, http_req_failed: { passes: 0 }, checks: { fails: 0 } } }, countSummary(5000), /first load is not whole: its k6 summary gives no checksPassed/],
    [countSummary(5000), { metrics: { http_reqs: { count: 5000 }, http_req_failed: { passes: "0" }, checks: { passes: 5000, fails: 0 } } }, /kernel instructions' load is not whole: its k6 summary gives no failed/],
    [countSummary(5000), { metrics: { http_reqs: { count: 5000 }, http_req_failed: { passes: 0 }, checks: { passes: 4000, fails: 0 } } }, /kernel instructions' load is not whole: 4000 passed and 0 failed status checks across 5000 requests/],
  ]) await assert.rejects(run(main, kernel, { requests: 5000 }), why);
  // Without an expected count, the kernel load must still match the first load's requests.
  await assert.rejects(run(countSummary(10), countSummary(9), {}), /kernel instructions' load is not whole: 9 requests, not 10/);
});

test("a first load whose status checks failed where its requests did not is not kept, since its row records only the requests", async () => {
  const run = (/** @type {any} */ main) => measure((p) => (p === "main" ? { text: mainText(), summary: main } : { text: kernelInstructions, summary: countSummary(5000) }), assert.fail, { requests: 5000 });
  for (const [failed, checksFailed] of [[0, 1], [0, 5000], [2, 3]]) {
    await assert.rejects(run(countSummary(5000, failed, checksFailed)), new RegExp(`^Error: the first load had ${checksFailed} failed status checks where ${failed} of its 5000 requests failed, so its count is not kept$`), `${failed}/${checksFailed}`);
  }
  // The controls: no failure, and failures each of which is a failed request, are recorded in the row as before.
  assert.equal((await run(countSummary(5000))).failed, 0);
  assert.equal((await run(countSummary(5000, 2, 2))).failed, 2);
});

test("a first load that ran is whole before it is repeated: a counter error does not buy a load short of its requests a repeat", async () => {
  // 4,999 requests, no failures, and user instructions crowded out: refused, not repeated.
  const partial = mainText().replace("60000,100.00", "60000,12.50");
  const attempts = [];
  await assert.rejects(measure((p, instructionsOnly) => {
    attempts.push([p, instructionsOnly]);
    if (p === "kernel") return { text: kernelInstructions, summary: countSummary(5000) };
    return instructionsOnly ? { text: userInstructions, summary: countSummary(5000) } : { text: partial, summary: countSummary(4999) };
  }, () => {}, { requests: 5000 }), /first load is not whole: 4999 requests, not 5000/);
  assert.deepEqual(attempts, [["main", false]]);
  // A repeat that ran is whole too.
  const repeated = [];
  await assert.rejects(measure((p, instructionsOnly) => {
    repeated.push([p, instructionsOnly]);
    return { text: instructionsOnly ? userInstructions : partial, summary: countSummary(instructionsOnly ? 4999 : 5000) };
  }, () => {}, { requests: 5000 }), /first load's repeat is not whole: 4999 requests, not 5000/);
  assert.deepEqual(repeated, [["main", false], ["main", true]]);
  // The control: a whole first load with the same counter error is repeated and kept.
  const kept = [];
  const row = await measure((p, instructionsOnly) => {
    kept.push([p, instructionsOnly]);
    if (p === "kernel") return { text: kernelInstructions, summary: countSummary(5000) };
    return { text: instructionsOnly ? userInstructions : partial, summary: countSummary(5000) };
  }, () => {}, { requests: 5000 });
  assert.deepEqual(kept, [["main", false], ["main", true], ["kernel", false]]);
  assert.equal(row.requests, 5000);
});

test("a perf not seen to end stops the count at once: no retry, no next pass, and an UnconfirmedPerf the caller stops the host for", async () => {
  const noAnswer = { text: "", error: "perf did not count the full load: no answer", unconfirmed: true, summary: countSummary(10) };
  for (const [stuck, calls, retried] of [
    [(p, i) => p === "main" && !i, [["main", false]], false],
    // In the repeat of the first load, after a fault the retry is for.
    [(p, i) => p === "main" && i, [["main", false], ["main", true]], true],
    [(p) => p === "kernel", [["main", false], ["kernel", false]], false],
  ]) {
    const attempts = [];
    const warnings = [];
    await assert.rejects(measure((p, instructionsOnly) => {
      attempts.push([p, instructionsOnly]);
      if (stuck(p, instructionsOnly)) return noAnswer;
      // The first try of the first load has unusable user instructions, so a repeat would follow.
      if (p === "main" && !instructionsOnly && retried) return { text: mainText().replace("60000,100.00", "60000,12.50"), summary: countSummary(10) };
      return p === "main" ? { text: instructionsOnly ? userInstructions : mainText(), summary: countSummary(10) } : { text: kernelInstructions, summary: countSummary(10) };
    }, (m) => warnings.push(m)), (e) => e instanceof UnconfirmedPerf && /no answer; no further count runs on this host/.test(e.message));
    assert.deepEqual(attempts, calls);
  }
  // A collect that throws it (count.mjs's, whose perf did not exit even when killed) stops the count the same way.
  const thrown = [];
  await assert.rejects(measure((p, i) => { thrown.push([p, i]); throw new UnconfirmedPerf("perf did not count the full load: no answer"); }, assert.fail), UnconfirmedPerf);
  assert.deepEqual(thrown, [["main", false]]);
});

test("count.mjs falls back to user instructions when an optional event makes perf abort before any load ran", async () => {
  for (const summary of [undefined, countSummary(0)]) {
    const attempts = [];
    const warnings = [];
    const row = await measure((p, instructionsOnly) => {
      attempts.push([p, instructionsOnly]);
      if (p === "kernel") return { text: kernelInstructions, summary: countSummary(10) };
      return instructionsOnly
        ? { text: userInstructions, summary: countSummary(10) }
        : { text: "", error: "event syntax error: L1-icache-load-misses:u", ranLoad: false, summary };
    }, (message) => warnings.push(message));
    assert.deepEqual(attempts, [["main", false], ["main", true], ["kernel", false]]);
    assert.deepEqual(warnings, ["event syntax error: L1-icache-load-misses:u; retrying with instructions only"]);
    assert.equal(row.userPerRequest, 1235);
    assert.equal(row.kernelPerRequest, 123);
    assert.equal(row.userCyclesPerRequest, null);
    assert.equal(row.perfDiagnostics["cycles:u"], "no perf row");
  }
  // A collect that says no load ran with no error of its own still fails that attempt, and is repeated.
  const attempts = [];
  const row = await measure((p, instructionsOnly) => {
    attempts.push([p, instructionsOnly]);
    if (p === "kernel") return { text: kernelInstructions, summary: countSummary(10) };
    return instructionsOnly ? { text: userInstructions, summary: countSummary(10) } : { text: mainText(), ranLoad: false };
  }, () => {});
  assert.deepEqual(attempts, [["main", false], ["main", true], ["kernel", false]]);
  assert.equal(row.userPerRequest, 1235);
});

test("the probe refuses a set perf cannot count or does not answer for, and notes main's whole set the count falls back from", () => {
  const counted = (names) => ({ status: 0, signal: null, stdout: names.map((e) => `1000,,${e},1000000,100.00,,`).join("\n"), stderr: "" });
  for (const names of PROBE_SETS) assert.deepEqual(probeVerdict(names, counted(names)), { refuse: null, note: null });
  // A required event not counted (a counter the VM does not expose still exits 0), a nonzero exit, no answer.
  assert.match(probeVerdict(["instructions:k"], { status: 0, stdout: "<not supported>,,instructions:k,0,100.00,,", stderr: "" }).refuse, /gave no count for instructions:k/);
  assert.match(probeVerdict(["instructions:u"], { status: 1, stdout: "", stderr: "perf_event_open failed" }).refuse, /exited 1: perf_event_open failed/);
  assert.match(probeVerdict(["instructions:u"], { status: null, signal: "SIGKILL", stdout: "", stderr: "", error: "did not finish within 30 s" }).refuse, /did not finish within 30 s/);
  // An optional event of main's whole set may be unusable, as in a count.
  const main = passEvents("main");
  assert.deepEqual(probeVerdict(main, { status: 0, stdout: "1000,,instructions:u,1,100.00,,\n<not supported>,,cycles:k,0,100.00,,", stderr: "" }), { refuse: null, note: null });
  // main's whole set failing by itself is what the count repeats its first load for; one that
  // did not answer within its bound is refused, as any set is.
  const failed = probeVerdict(main, { status: 129, stdout: "", stderr: "event syntax error: 'L1-icache-load-misses:u'" });
  assert.equal(failed.refuse, null);
  assert.match(failed.note, /exited 129: event syntax error.*the count repeats its first load with instructions:u alone/);
  assert.match(probeVerdict(main, { status: null, stdout: "", stderr: "", error: "no answer: it did not finish within 30 s" }).refuse, /no answer/);
});

test("a bounded run kills a command past its bound and gives up one that does not exit, instead of waiting it out", async () => {
  const node = (code, options) => runBounded(process.execPath, ["-e", code], options);
  const ok = await node("process.stdout.write('1000,,instructions:u,1,100.00,,')");
  assert.deepEqual([ok.status, ok.answered, ok.cleanup, ok.error, ok.stdout], [0, true, "confirmed", undefined, "1000,,instructions:u,1,100.00,,"]);
  const slow = await node("setTimeout(() => {}, 60000)", { timeoutMs: 200, graceMs: 5000 });
  assert.equal(slow.answered, true);
  assert.equal(slow.cleanup, "confirmed");
  assert.match(slow.error, /did not finish within 0\.2 s/);
  // A process that a kill does not end (here: one whose kill is never delivered) is given up after
  // the grace, with no answer, and the run settles.
  const started = Date.now();
  const signalled = [];
  const stuck = await runBounded("stuck", [], { timeoutMs: 100, graceMs: 100, group: true, signalGroup: (pid, signal) => signalled.push([pid, signal]), start: () => {
    const child = /** @type {any} */ (new EventEmitter());
    Object.assign(child, { pid: 4242, kill: () => true, unref: () => {}, stdout: null, stderr: null });
    return child;
  } });
  assert.equal(stuck.answered, false);
  assert.equal(stuck.cleanup, "unconfirmed");
  assert.match(stuck.error, /no answer: it did not finish within 0\.1 s and had not exited 0\.1 s after it was killed/);
  // Its group was killed while its leader was not reaped.
  assert.deepEqual(signalled, [[4242, "SIGKILL"]]);
  assert.ok(Date.now() - started < 5000);
  // Unconfirmed cleanup refuses the probe, main's whole set included.
  assert.match(probeVerdict(passEvents("main"), stuck).refuse, /no answer/);
  const missing = await runBounded("no-such-perf-command-i2151", []);
  assert.ok(missing.error, "a command that cannot start is an error, not a count");
  assert.equal(missing.cleanup, "confirmed");
});

test("a bounded run never signals a group whose leader was reaped, and gives up output a process it started holds open as cleanup unconfirmed", async () => {
  // The leader exits (reaped) at once while something it started holds its output: no group signal
  // at the bound, nor ever, and the run settles a grace after the exit, cleanup unconfirmed.
  const signalled = [];
  const started = Date.now();
  const held = await runBounded("leader", [], { timeoutMs: 150, graceMs: 300, group: true, signalGroup: (pid, signal) => signalled.push([pid, signal]), start: () => {
    const child = /** @type {any} */ (new EventEmitter());
    Object.assign(child, { pid: 4343, kill: () => assert.fail("no kill after the leader exited"), unref: () => {}, stdout: null, stderr: null });
    setTimeout(() => child.emit("exit", 0, null), 10);
    return child;
  } });
  assert.deepEqual(signalled, []);
  assert.deepEqual([held.status, held.answered, held.cleanup], [0, true, "unconfirmed"]);
  assert.match(held.error, /cleanup unconfirmed: its output stayed open 0\.3 s after it exited 0, so a process it started may still run/);
  assert.ok(Date.now() - started < 2000);
  assert.match(probeVerdict(["instructions:u"], held).refuse, /cleanup unconfirmed/);
  // A real exit's code, read once the leader is reaped, also stops the bound's signal (exitCode set, no exit event yet).
  const quiet = [];
  await runBounded("reaped", [], { timeoutMs: 50, graceMs: 50, group: true, signalGroup: (pid, signal) => quiet.push([pid, signal]), start: () => {
    const child = /** @type {any} */ (new EventEmitter());
    Object.assign(child, { pid: 4444, exitCode: 0, signalCode: null, kill: () => assert.fail("no kill"), unref: () => {}, stdout: null, stderr: null });
    return child;
  } });
  assert.deepEqual(quiet, []);
});

/**
 * Whether process `pid` is gone: no such process, or one that has exited but that its parent has
 * not reaped yet (a zombie, as in a container whose init does not reap). Linux's /proc says which,
 * and elsewhere ps's process state. The process can be reaped between the signal check and the
 * read, so a stat file that is no longer there (ENOENT, or ESRCH from a read of one just gone),
 * and a ps that finds no such process, read as gone; any other failure is thrown.
 * @param {number} pid
 * @param {{ signal?: (pid: number, signal: 0) => unknown, read?: (path: string) => string, ps?: (pid: number) => { status: number | null, stdout?: string | null, stderr?: string | null, error?: Error }, platform?: string }} [steps]
 */
function processGone(pid, {
  signal = (p, s) => process.kill(p, s),
  read = (path) => readFileSync(path, "utf8"),
  ps = (p) => spawnSync("ps", ["-o", "stat=", "-p", String(p)], { encoding: "utf8" }),
  platform = process.platform,
} = {}) {
  try { signal(pid, 0); } catch { return true; }
  if (platform === "linux") {
    let stat;
    try { stat = read(`/proc/${pid}/stat`); } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") return true;
      throw error;
    }
    // The state follows the command name's closing parenthesis; the name may hold ") Z" itself.
    return stat[stat.lastIndexOf(")") + 2] === "Z";
  }
  const answer = ps(pid);
  if (answer.error) throw answer.error;
  const state = (answer.stdout ?? "").trim();
  // ps exits 1 and prints nothing when it finds no such process.
  if (answer.status === 1 && state === "" && (answer.stderr ?? "").trim() === "") return true;
  assert.equal(answer.status, 0, `ps -p ${pid} failed: ${answer.stderr ?? ""}`);
  return /^Z/.test(state);
}

test("a process reaped between the signal check and the stat read reads as gone, and a live one does not", () => {
  const failure = (code) => Object.assign(new Error(code), { code });
  const alive = () => true;
  const vanished = (code) => () => { throw failure(code); };
  // The race: the signal finds the zombie, its parent reaps it, then the read finds no stat file.
  assert.equal(processGone(4242, { signal: alive, read: vanished("ENOENT"), platform: "linux" }), true);
  assert.equal(processGone(4242, { signal: alive, read: vanished("ESRCH"), platform: "linux" }), true);
  // Any other read failure is not evidence the process is gone.
  assert.throws(() => processGone(4242, { signal: alive, read: vanished("EACCES"), platform: "linux" }), /EACCES/);
  // A zombie is gone; a running or sleeping process is not.
  assert.equal(processGone(4242, { signal: alive, read: () => "4242 (node) Z 1 4242 4242 0 -1", platform: "linux" }), true);
  for (const state of ["R", "S", "D"])
    assert.equal(processGone(4242, { signal: alive, read: () => `4242 (a (b) Z) ${state} 1 4242 4242 0 -1`, platform: "linux" }), false, state);
  // No such process at the signal check is gone before any read.
  assert.equal(processGone(4242, { signal: vanished("ESRCH"), read: () => assert.fail("no read"), platform: "linux" }), true);
  // Elsewhere: ps finding no such process is gone, a zombie is gone, a running process is not, and
  // a ps that fails some other way is an error.
  assert.equal(processGone(4242, { signal: alive, ps: () => ({ status: 1, stdout: "", stderr: "" }), platform: "darwin" }), true);
  assert.equal(processGone(4242, { signal: alive, ps: () => ({ status: 0, stdout: "Z+\n" }), platform: "darwin" }), true);
  assert.equal(processGone(4242, { signal: alive, ps: () => ({ status: 0, stdout: "Ss\n" }), platform: "darwin" }), false);
  assert.throws(() => processGone(4242, { signal: alive, ps: () => ({ status: 1, stdout: "", stderr: "ps: illegal option\n" }), platform: "darwin" }), /illegal option/);
  assert.throws(() => processGone(4242, { signal: alive, ps: () => ({ status: null, error: failure("ENOENT") }), platform: "darwin" }), /ENOENT/);
});

test("a running process, read through the real /proc or ps, is not gone", { skip: process.platform === "win32" && "reads /proc or ps" }, () => {
  assert.equal(processGone(process.pid), false);
});

test("on POSIX a bounded run kills the probe's whole group at its bound, and does not wait out a descendant that holds its output after the leader exits", { skip: process.platform === "win32" && "process groups are POSIX" }, async () => {
  // A leader and the child it started, both in its group, both sleeping past the bound: both are killed.
  const killed = await runBounded(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); console.log(c.pid); setTimeout(() => {}, 60000);"], { timeoutMs: 1000, graceMs: 3000 });
  assert.equal(killed.cleanup, "confirmed", killed.error);
  assert.equal(killed.signal, "SIGKILL");
  const descendant = Number(killed.stdout.trim());
  assert.ok(descendant > 0, killed.stdout);
  // Gone, or a zombie its new parent has not reaped yet.
  assert.ok(processGone(descendant), `the leader's child ${descendant} still runs`);
  // A leader that exits 0 at once while a self-bounded child holds its stdout: given up a grace after
  // the exit, not when the child ends, and the group is not signalled after the leader was reaped.
  const started = Date.now();
  const left = await runBounded(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref(); process.exit(0);"], { timeoutMs: 500, graceMs: 1000 });
  assert.deepEqual([left.status, left.answered, left.cleanup], [0, true, "unconfirmed"]);
  assert.match(left.error, /cleanup unconfirmed/);
  assert.ok(Date.now() - started < 3500, `settled after ${Date.now() - started} ms`);
});
test("the counter rejects an unknown target before starting the benchmark", () => {
  const result = spawnSync(process.execPath, ["count.mjs", "target-test", "1", "corten", "page,typo"], {
    cwd: import.meta.dirname, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown target "typo"; expected page or json/);
  assert.equal(result.stdout, "");
});

test("an app that serves only the JSON is in the JSON phases, cold start and count, not the pages", () => {
  const all = calls("r13", "10", ["corten"], ["http://localhost:18410"], ["aspnet-aot"]);
  const named = (/** @type {string} */ script, /** @type {string=} */ target) => all.filter(([, , s, ...rest]) => s === script && (!target || rest.at(-2) === target)).map((c) => c.join(" "));
  assert.equal(named("run-ssr.mjs", "json").length, 2, "both JSON phases");
  for (const c of [...named("run-ssr.mjs", "json"), ...named("cold-start.mjs"), ...named("count.mjs")]) assert.match(c, /corten,aspnet-aot/);
  assert.equal(named("run-ssr.mjs", "page").length, 2, "both page phases");
  for (const c of [...named("run-ssr.mjs", "page"), ...named("browser.mjs")]) assert.doesNotMatch(c, /aspnet-aot/);
});

test("a page app whose JSON is another app's is in the page phases, not the JSON ones", () => {
  const all = calls("m1", "10", ["corten", "aspnet"], ["u1", "u2"], ["aspnet-aot"], 1, ["aspnet"]);
  const json = all.filter(([, , s, ...rest]) => s === "run-ssr.mjs" && rest.at(-2) === "json").map((c) => c.join(" "));
  const page = all.filter(([, , s, ...rest]) => s === "run-ssr.mjs" && rest.at(-2) === "page").map((c) => c.join(" "));
  assert.equal(json.length, 2);
  assert.equal(page.length, 2);
  for (const c of json) assert.match(c, / corten,aspnet-aot json /);
  for (const c of page) assert.match(c, / corten,aspnet page /);
  for (const script of ["cold-start.mjs", "count.mjs", "conform.mjs"]) assert.match(all.find(([, , s]) => s === script)?.join(" ") ?? "", /corten,aspnet,aspnet-aot/, script);
  const pageOnlyUnder = (/** @type {Record<string, string>} */ env) => spawnSync(process.execPath, ["--input-type=module", "-e", 'console.log(JSON.stringify((await import("./apps.mjs")).pageOnly))'], { cwd: import.meta.dirname, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "BENCH_TIER" && k !== "BENCH_APPS")), ...env } }).stdout.trim();
  assert.equal(pageOnlyUnder({ BENCH_TIER: "matched" }), '["aspnet"]');
  assert.equal(pageOnlyUnder({}), "[]", "the defaults tier runs every page app's JSON");
});

test("quote makes one shell word of any text", { skip: spawnSync("bash", ["-c", "true"]).status !== 0 && "no bash here" }, () => {
  for (const text of ["plain", "it's", "a b", "$(echo x) \$HOME ; | & ' '' \\"]) {
    // On stdin: Windows passes a command line on to bash (WSL's) changed.
    const r = spawnSync("bash", ["-s"], { input: `printf %s ${quote(text)}`, encoding: "utf8" });
    assert.equal(r.stdout, text);
  }
});

test("the unit starts again at boot only when asked, and refuses what systemd would read itself", () => {
  const options = { description: "corten benchmark round r10", script: "/bench/round-r10.sh", log: "/bench/r10.log", hours: 11 };
  const atBoot = unit({ ...options, atBoot: true });
  assert.match(atBoot, /^ExecStart=\/bin\/bash \/bench\/round-r10\.sh$/m);
  assert.match(atBoot, /^StandardOutput=append:\/bench\/r10\.log$/m);
  assert.match(atBoot, /^WantedBy=multi-user\.target$/m);
  assert.match(atBoot, /^RuntimeMaxSec=39600$/m);
  assert.throws(() => unit({ ...options, hours: 0, atBoot: true }));
  assert.doesNotMatch(unit({ ...options, atBoot: false }), /WantedBy/);
  assert.throws(() => unit({ ...options, script: "/bench/%n.sh", atBoot: true }));
  assert.throws(() => unit({ ...options, log: "/bench/a\nExecStart=/bin/sh", atBoot: true }));
});

test("a matched-tier round is m<n>, and m<n> is the matched tier's alone, so the trend's r<n> never mix", () => {
  for (const round of ["m1", "m12"]) assert.equal(roundNameError(round, "matched", { full: true }), null, round);
  for (const round of ["r17", "ab1", "m", "m1x"]) assert.match(String(roundNameError(round, "matched", { full: true })), /is named m<n>/, round);
  for (const round of ["r17", "aot2", "conform2", "p1"]) assert.equal(roundNameError(round, "defaults", { full: true }), null, round);
  assert.match(String(roundNameError("m3", "defaults", { full: true })), /BENCH_TIER=matched/);
  // A step run on its own may write a matched matrix under another name, never into r<n>.
  assert.equal(roundNameError("conform-matched1", "matched"), null);
  assert.match(String(roundNameError("r16", "matched")), /is named m<n>/);
  assert.match(String(roundNameError("m3", "defaults")), /BENCH_TIER=matched/);
});

/** apps.mjs's exports under an environment, from a fresh process. @param {Record<string, string>} env */
const appsUnder = (env) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'const a = await import("./apps.mjs"); console.log(JSON.stringify({ apps: Object.keys(a.apps), tierApps: Object.keys(a.tierApps), tierEnv: a.tierEnv, run: a.runArgs("corten", a.allApps.corten, "api", "/f") }))'], { cwd: import.meta.dirname, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "BENCH_TIER" && k !== "BENCH_APPS")), ...env } });
  return { status: r.status, stderr: r.stderr, ...(r.status === 0 ? JSON.parse(r.stdout) : {}) };
};

test("the matched tier starts its apps with the profile and only its apps; the defaults tier is as before", () => {
  const defaults = appsUnder({});
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(defaults.tierEnv, []);
  assert.ok(!defaults.run.some((/** @type {string} */ a) => /^(PROFILE|MAX_CONNECTIONS)=/.test(a)), "no profile in the defaults tier");
  assert.equal(defaults.apps.length, Object.keys(apps).length);
  const matched = appsUnder({ BENCH_TIER: "matched" });
  assert.equal(matched.status, 0, matched.stderr);
  assert.deepEqual(matched.tierEnv, ["-e", "PROFILE=matched", "-e", "MAX_CONNECTIONS=1000"]);
  const run = matched.run;
  assert.ok(run.indexOf("PROFILE=matched") > 0 && run.indexOf("PROFILE=matched") < run.indexOf("cb-corten"), "set before the image");
  for (const name of ["corten", "axum-maud"]) assert.ok(matched.tierApps.includes(name), name);
  assert.deepEqual(matched.apps, matched.tierApps);
  assert.ok(matched.tierApps.every((/** @type {string} */ n) => /** @type {{ matched?: boolean }} */ (apps[/** @type {keyof typeof apps} */ (n)]).matched), "only the tier's apps");
  assert.deepEqual(appsUnder({ BENCH_TIER: "matched", BENCH_APPS: "axum-maud,corten" }).apps, ["corten", "axum-maud"]);
  assert.match(appsUnder({ BENCH_TIER: "matched", BENCH_APPS: "corten,gin" }).stderr, /names gin, which is not in the matched tier/);
  assert.match(appsUnder({ BENCH_TIER: "fast" }).stderr, /BENCH_TIER is defaults or matched/);
});

test("an app whose config is fixed at build runs its own image in the matched tier, built with the profile", async () => {
  const under = (/** @type {Record<string, string>} */ env) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'const a = await import("./apps.mjs"); console.log(JSON.stringify({ image: a.tierApps.nextjs.image, run: a.runArgs("nextjs", a.tierApps.nextjs, "api", "/f").at(-1), build: a.buildArgs("nextjs", a.tier), other: a.buildArgs("axum-maud", a.tier) }))'], { cwd: import.meta.dirname, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "BENCH_TIER" && k !== "BENCH_APPS")), ...env } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const defaults = under({});
  assert.equal(defaults.image, "cb-nextjs");
  assert.deepEqual(defaults.build, ["build", "-q", "-t", "cb-nextjs", "bench/fullstack/apps/nextjs"]);
  const matched = under({ BENCH_TIER: "matched" });
  assert.equal(matched.image, "cb-nextjs-matched");
  assert.equal(matched.run, "cb-nextjs-matched");
  assert.deepEqual(matched.build, ["build", "-q", "--build-arg", "PROFILE=matched", "-t", "cb-nextjs-matched", "bench/fullstack/apps/nextjs"]);
  assert.deepEqual(matched.other, ["build", "-q", "-t", "cb-axum-maud", "bench/fullstack/apps/axum-maud"], "an app without a matched image builds as before");
  const corten = spawnSync(process.execPath, ["--input-type=module", "-e", 'const a = await import("./apps.mjs"); a.buildArgs("corten", "matched")'], { cwd: import.meta.dirname, encoding: "utf8" });
  assert.match(corten.stderr, /examples\/card-market's, not built by buildArgs/);
});

test("run-all.mjs runs from one step through another, and the browser suite stops before the builds", () => {
  assert.deepEqual(stepsUntil(browserSuite.from, browserSuite.until).steps, ["browser"]);
  const droplet = readFileSync(new URL("./droplet.mjs", import.meta.url), "utf8");
  assert.match(droplet, /browser: `[^`]*node run-all\.mjs \$\{round\} 10 \$\{browserSuite\.from\} \$\{browserSuite\.until\};/);
  assert.deepEqual(stepsUntil("browser", "browser"), { steps: ["browser"], error: null });
  assert.deepEqual(stepsUntil("cold-start", steps.at(-1) ?? "").steps, steps);
  assert.deepEqual(stepsUntil("count", "conform").steps, ["count", "conform"]);
  assert.match(stepsUntil("build", "browser").error ?? "", /until \(browser\) comes before from \(build\)/);
  assert.match(stepsUntil("browser", "nope").error ?? "", /must each be one of/);
});

test("a round that serves items refuses a missing, empty or itemless fixture, and the live suite needs none", () => {
  const good = JSON.stringify({ item_1: { id: "item_1" } });
  for (const suite of ["fullstack", "browser", "harden"]) {
    assert.match(fixtureError(suite, null) ?? "", /is missing: an? [\w-]+ round serves its items from it.*Copy one from a checkout that has it/);
    for (const bad of ["", "{", "[]", "null", JSON.stringify({ item_2: {} })]) assert.match(fixtureError(suite, bad) ?? "", /empty, not JSON or has no item_1/, bad);
    assert.equal(fixtureError(suite, good), null);
  }
  assert.equal(fixtureError("live", null), null);
});
