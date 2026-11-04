// Tests for round.mjs: node --test bench/fullstack/round.test.mjs (npm run check runs it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { apps } from "./apps.mjs";
import { buildBudgetMinutes, buildsLeft, calls, compiledFirst, fullstackHours, mayStart, quote, resumeAt, startMinutes, steps, unit } from "./round.mjs";

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
  const all = calls("r13", "10", ["nextjs", "corten", "django", "gin"], [1, 2, 3, 4]);
  assert.deepEqual(buildsLeft(all, []), ["corten", "gin", "nextjs", "django"]);
  assert.deepEqual(buildsLeft(all, ["corten", "nextjs"]), ["gin", "django"]);
  assert.deepEqual(buildsLeft(all, ["corten", "gin", "nextjs", "django"]), []);
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
  const all = calls("r10", "10", ["corten", "nextjs"], [18410, 18411]);
  assert.deepEqual([...new Set(all.map(([step]) => step))], steps);
  for (const [, limit] of all) assert.ok(limit > 0 && limit <= 120);
  const browser = all.filter(([step]) => step === "browser").at(-1);
  assert.deepEqual(browser?.slice(2), ["browser.mjs", "corten=http://localhost:18410", "nextjs=http://localhost:18411", "runs=10", "out=r10/browser.json"]);
});

test("the builds come last, one call an app", () => {
  const all = calls("r13", "10", ["corten", "nextjs"], [18410, 18411]);
  assert.equal(steps.at(-1), "build");
  assert.deepEqual(all.filter(([step]) => step === "build").map((c) => c.slice(2)), [["build.mjs", "r13", "corten"], ["build.mjs", "r13", "nextjs"]]);
});

test("the compiled apps build first, the others in the order given", () => {
  for (const name of compiledFirst) assert.ok(name in apps, `${name} is not an app`);
  const order = calls("r13", "10", ["nextjs", "django", "gin", "corten", "leptos"], [1, 2, 3, 4, 5]).filter(([step]) => step === "build").map((c) => c.at(-1));
  assert.deepEqual(order, ["corten", "leptos", "gin", "nextjs", "django"]);
});

test("a full-stack round's calls and its build budget fit in its unit's hours", () => {
  const names = Object.keys(apps);
  const all = calls("r13", "10", names, names.map((_, i) => i));
  // Every app may take its full wait to start before the browser step.
  const measuring = all.filter(([step]) => step !== "build").reduce((n, [, limit]) => n + limit, 0) + names.length * startMinutes;
  // The budget stops new builds; the last one started may still run to its own limit.
  const lastBuild = Math.max(...all.filter(([step]) => step === "build").map(([, limit]) => limit));
  assert.ok(measuring + buildBudgetMinutes + lastBuild + 10 <= fullstackHours * 60, `${measuring} + ${buildBudgetMinutes} + ${lastBuild} + 10 (the summary) minutes do not fit in ${fullstackHours} hours`);
});

test("an app that serves only the JSON is in the JSON phases, cold start and count, not the pages", () => {
  const all = calls("r13", "10", ["corten"], [18410], ["aspnet-aot"]);
  const named = (/** @type {string} */ script, /** @type {string=} */ target) => all.filter(([, , s, ...rest]) => s === script && (!target || rest.at(-1) === target)).map((c) => c.join(" "));
  for (const c of [...named("run-ssr.mjs", "json"), ...named("cold-start.mjs"), ...named("count.mjs")]) assert.match(c, /corten,aspnet-aot/);
  for (const c of [...named("run-ssr.mjs", "page"), ...named("browser.mjs")]) assert.doesNotMatch(c, /aspnet-aot/);
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
