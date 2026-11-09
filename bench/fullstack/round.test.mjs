// Tests for round.mjs: node --test bench/fullstack/round.test.mjs (npm run check runs it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { allApps as apps } from "./apps.mjs";
import { maxPasses } from "./passes.mjs";
import { buildBudgetMinutes, buildStep, buildsLeft, calls, compiledFirst, fullstackHours, hoursFor, mayStart, quote, resumeAt, roundNameError, startMinutes, steps, unit } from "./round.mjs";

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

test("an app that serves only the JSON is in the JSON phases, cold start and count, not the pages", () => {
  const all = calls("r13", "10", ["corten"], ["http://localhost:18410"], ["aspnet-aot"]);
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
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'const a = await import("./apps.mjs"); console.log(JSON.stringify({ apps: Object.keys(a.apps), tierApps: Object.keys(a.tierApps), tierEnv: a.tierEnv, run: a.runArgs("corten", a.allApps.corten, "api", "/f") }))'], { cwd: import.meta.dirname, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "BENCH_TIER" && k !== "BENCH_APPS" && k !== "BENCH_EDGE")), ...env } });
  return { status: r.status, stderr: r.stderr, ...(r.status === 0 ? JSON.parse(r.stdout) : {}) };
};

test("the matched tier starts its apps with the profile and only its apps; the defaults tier is as before", () => {
  const defaults = appsUnder({});
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(defaults.tierEnv, []);
  assert.ok(!defaults.run.some((/** @type {string} */ a) => /^(PROFILE|MAX_CONNECTIONS|ORIGINS)=/.test(a)), "no profile in the defaults tier");
  assert.equal(defaults.apps.length, Object.keys(apps).length);
  const matched = appsUnder({ BENCH_TIER: "matched" });
  assert.equal(matched.status, 0, matched.stderr);
  assert.deepEqual(matched.tierEnv, ["-e", "PROFILE=matched", "-e", "MAX_CONNECTIONS=1000"]);
  const run = matched.run;
  assert.ok(run.indexOf("PROFILE=matched") > 0 && run.indexOf("PROFILE=matched") < run.indexOf("cb-corten"), "set before the image");
  assert.ok(run.includes("ORIGINS=https://localhost:19410") && run.indexOf("ORIGINS=https://localhost:19410") < run.indexOf("cb-corten"), "the edge's origin, before the image");
  assert.ok(!appsUnder({ BENCH_TIER: "matched", BENCH_EDGE: "off" }).run.some((/** @type {string} */ a) => a.startsWith("ORIGINS=")), "no edge, no edge origin");
  for (const name of ["corten", "axum-maud"]) assert.ok(matched.tierApps.includes(name), name);
  assert.deepEqual(matched.apps, matched.tierApps);
  assert.ok(matched.tierApps.every((/** @type {string} */ n) => /** @type {{ matched?: boolean }} */ (apps[/** @type {keyof typeof apps} */ (n)]).matched), "only the tier's apps");
  assert.deepEqual(appsUnder({ BENCH_TIER: "matched", BENCH_APPS: "axum-maud,corten" }).apps, ["corten", "axum-maud"]);
  assert.match(appsUnder({ BENCH_TIER: "matched", BENCH_APPS: "corten,gin" }).stderr, /names gin, which is not in the matched tier/);
  assert.match(appsUnder({ BENCH_TIER: "fast" }).stderr, /BENCH_TIER is defaults or matched/);
});
