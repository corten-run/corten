// Tests for round.mjs: node --test bench/fullstack/round.test.mjs (npm run check runs it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { allApps as apps } from "./apps.mjs";
import { countRow, measurePerfCounts, parsePerfCounts, passEvents, perfCountArgs, perfProbeArgs, PROBE_SETS, probeVerdict, runBounded } from "./count-perf.mjs";
import { maxPasses } from "./passes.mjs";
import { browserSuite, buildBudgetMinutes, buildStep, buildsLeft, calls, compiledFirst, fixtureError, fullstackHours, hoursFor, mayStart, quote, resumeAt, roundNameError, startMinutes, steps, stepsUntil, unit } from "./round.mjs";

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

test("count.mjs counts user and kernel instructions in two perf sessions, never in one (#2151)", () => {
  assert.deepEqual(perfCountArgs(["-C", "1"], "app.scope", passEvents("main")), [
    "stat", "-C", "1", "-x", ",", "--log-fd", "1", "-e",
    "cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u",
    "-G", "app.scope,app.scope,app.scope,app.scope",
  ]);
  assert.deepEqual(perfCountArgs(["-C", "1"], "app.scope", passEvents("main", true)), [
    "stat", "-C", "1", "-x", ",", "--log-fd", "1", "-e", "instructions:u", "-G", "app.scope",
  ]);
  assert.deepEqual(perfCountArgs(["-C", "1"], "app.scope", passEvents("kernel")), [
    "stat", "-C", "1", "-x", ",", "--log-fd", "1", "-e", "instructions:k", "-G", "app.scope",
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
  assert.throws(() => passEvents("both"), /unknown perf pass/);
  assert.deepEqual(perfProbeArgs(["-C", "1"], ["instructions:k"]), ["stat", "-C", "1", "-x", ",", "--log-fd", "1", "-e", "instructions:k", "--", "sleep", "1"]);
});

const mainText = (cacheEvent = "L1-icache-load-misses:u") => [
  "# started on bench host",
  "12345,,instructions:u,app.scope,60000,100.00,",
  "5678,,cycles:u,app.scope,60000,100.00,",
  "0,,cycles:k,app.scope,60000,100.00,",
  `87,,${cacheEvent},app.scope,60000,100.00,`,
].join("\n");
const userInstructions = "12345,,instructions:u,app.scope,60000,100.00,";
const kernelInstructions = "1234,,instructions:k,app.scope,60000,100.00,";
const pass = (text, requests = 10, failed = 0) => ({ counts: parsePerfCounts(text), requests, failed });

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

test("count.mjs keeps instructions when optional perf events are unavailable", () => {
  const main = pass([userInstructions, "<not supported>,,cycles:u,app.scope,0,100.00,", "<not counted>,,cycles:k,app.scope,0,100.00,"].join("\n"));
  assert.deepEqual(JSON.parse(JSON.stringify(countRow(main, pass(kernelInstructions)))), {
    requests: 10, failed: 0, kernelPass: { requests: 10, failed: 0 }, userPerRequest: 1235, kernelPerRequest: 123,
    userCyclesPerRequest: null, kernelCyclesPerRequest: null, userL1iMissesPerRequest: null,
    perfRunningPct: { "instructions:u": 100, "instructions:k": 100, "cycles:u": 100, "cycles:k": 100, "L1-icache-load-misses:u": null },
    perfDiagnostics: {
      "cycles:u": "<not supported>", "cycles:k": "<not counted>", "L1-icache-load-misses:u": "no perf row",
    },
  });
});

function countSummary(count, failed = 0, checksFailed = 0) {
  return { metrics: {
    http_reqs: { count },
    http_req_failed: { passes: failed },
    checks: { fails: checksFailed },
  } };
}

test("count.mjs runs the main pass, then the kernel pass, and reads a pass's own events only", async () => {
  const calls = [];
  const row = await measurePerfCounts((p, instructionsOnly) => {
    calls.push([p, instructionsOnly]);
    // A row of the other pass's event in a pass's output is not read from it.
    return p === "main"
      ? { text: `${mainText()}\n999,,instructions:k,app.scope,60000,100.00,`, summary: countSummary(10) }
      : { text: `${kernelInstructions}\n1,,cycles:u,app.scope,60000,100.00,`, summary: countSummary(10) };
  }, assert.fail);
  assert.deepEqual(calls, [["main", false], ["kernel", false]]);
  assert.equal(row.kernelPerRequest, 123);
  assert.equal(row.userCyclesPerRequest, 568);
});

test("count.mjs records partial and missing optional coverage without reporting usable counts", async () => {
  const row = await measurePerfCounts((p, instructionsOnly) => {
    assert.equal(instructionsOnly, false);
    return p === "kernel" ? { text: kernelInstructions, summary: countSummary(10) } : { text: [
      userInstructions,
      "5678,,cycles:u,app.scope,60000,8.00,",
      "1200,,cycles:k,app.scope,60000,100.00,",
      "87,,L1-icache-load-misses:u,app.scope,60000,,",
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
  const row = await measurePerfCounts(collect, (message) => warnings.push(message));
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
    measurePerfCounts((p, instructionsOnly) => { after.push([p, instructionsOnly]); return { text: instructionsOnly ? partial.split("\n")[1] : partial, summary: countSummary(10) }; }, () => {}),
    /instructions-only perf failed: instructions:u: perf ran 12\.5%/,
  );
  // A failed main pass leaves the kernel pass unrun.
  assert.deepEqual(after, [["main", false], ["main", true]]);
});

test("count.mjs does not retry away failures in the first load", async () => {
  const partial = mainText().replace("60000,100.00", "60000,12.50");
  for (const [failed, checksFailed] of [[9, 9], [0, 2]]) {
    const attempts = [];
    await assert.rejects(measurePerfCounts((p, instructionsOnly) => {
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
    [{ text: kernelInstructions, summary: countSummary(0) }, /kernel instructions' perf failed: k6 made no requests/],
    [{ text: "", error: "perf did not count the full load: exit 1", summary: countSummary(10, 3, 0) }, /kernel instructions' load had 3 HTTP request failures and 0 failed status checks/],
  ]) {
    const attempts = [];
    await assert.rejects(measurePerfCounts((p, instructionsOnly) => {
      attempts.push([p, instructionsOnly]);
      return p === "main" ? { text: mainText(), summary: countSummary(10) } : kernel;
    }, assert.fail), error);
    assert.deepEqual(attempts, [["main", false], ["kernel", false]]);
  }
  // Failures in a kernel pass that counted are kept on its row, for the reader to refuse.
  const row = await measurePerfCounts((p) => (p === "main" ? { text: mainText(), summary: countSummary(10) } : { text: kernelInstructions, summary: countSummary(10, 2) }), assert.fail);
  assert.deepEqual(row.kernelPass, { requests: 10, failed: 2 });
});

test("count.mjs falls back to user instructions when an optional event makes perf abort before any rows", async () => {
  for (const summary of [undefined, countSummary(0)]) {
    const attempts = [];
    const warnings = [];
    const row = await measurePerfCounts((p, instructionsOnly) => {
      attempts.push([p, instructionsOnly]);
      if (p === "kernel") return { text: kernelInstructions, summary: countSummary(10) };
      return instructionsOnly
        ? { text: userInstructions, summary: countSummary(10) }
        : { text: "", error: "event syntax error: L1-icache-load-misses:u", summary };
    }, (message) => warnings.push(message));
    assert.deepEqual(attempts, [["main", false], ["main", true], ["kernel", false]]);
    assert.deepEqual(warnings, ["event syntax error: L1-icache-load-misses:u; retrying with instructions only"]);
    assert.equal(row.userPerRequest, 1235);
    assert.equal(row.kernelPerRequest, 123);
    assert.equal(row.userCyclesPerRequest, null);
    assert.equal(row.perfDiagnostics["cycles:u"], "no perf row");
  }
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
  assert.deepEqual([ok.status, ok.answered, ok.error, ok.stdout], [0, true, undefined, "1000,,instructions:u,1,100.00,,"]);
  const slow = await node("setTimeout(() => {}, 60000)", { timeoutMs: 200, graceMs: 5000 });
  assert.equal(slow.answered, true);
  assert.match(slow.error, /did not finish within 0\.2 s/);
  // A process that a kill does not end (here: one whose kill is never delivered) is given up after
  // the grace, with no answer, and the run settles.
  const started = Date.now();
  const stuck = await runBounded("stuck", [], { timeoutMs: 100, graceMs: 100, start: () => {
    const child = /** @type {any} */ (new EventEmitter());
    Object.assign(child, { kill: () => true, unref: () => {}, stdout: null, stderr: null });
    return child;
  } });
  assert.equal(stuck.answered, false);
  assert.match(stuck.error, /no answer: it did not finish within 0\.1 s and had not exited 0\.1 s after it was killed/);
  assert.ok(Date.now() - started < 5000);
  const missing = await runBounded("no-such-perf-command-i2151", []);
  assert.ok(missing.error, "a command that cannot start is an error, not a count");
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
