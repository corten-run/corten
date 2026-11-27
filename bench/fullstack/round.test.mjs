// Tests for round.mjs: node --test bench/fullstack/round.test.mjs (npm run check runs it).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { allApps as apps } from "./apps.mjs";
import { acknowledgments, countRow, measurePerfCounts, parsePerCpuCounts, parsePerfCounts, passEvents, perfCountArgs, perfProbeArgs, PROBE_SETS, probeVerdict, runBounded, selectedCpus, UnconfirmedPerf } from "./count-perf.mjs";
import { maxPasses } from "./passes.mjs";
import { appendLine, browserSuite, buildBudgetMinutes, buildStep, buildsLeft, calls, compiledFirst, countHalt, countRestartError, fixtureError, fullstackHours, hoursFor, mayStart, quote, resumeAt, roundNameError, runSteps, startMinutes, steps, stepsUntil, unit } from "./round.mjs";

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
 * @param {(script: string) => { stopped?: string | null, code?: number | null }} [outcome]
 */
async function runRound(outcome = () => ({})) {
  const all = calls("r13", "10", ["corten", "gin"], ["u1", "u2"]);
  /** @type {string[]} */
  const log = [];
  const run = runSteps(stepsUntil("count", "build").steps, all, {
    call: async (limit, args) => {
      log.push(`call ${args[0]}`);
      const r = outcome(args[0]);
      return { stopped: r.stopped ?? null, code: r.code === undefined ? 0 : r.code };
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
        assert.deepEqual(progress, ["boot", name === "cut" ? "start co" : "start count", "boot", "failed"], `${name}: ${said}`);
        assert.match(skipped, name === "same" ? /step count skipped: the round stopped in its count step and it started again in the boot its count step started in, so a perf or probe that step started may still run; nothing more runs on this host/
          : name === "cut" ? /step count skipped: the round's progress file ends in a line cut short, so whether its count step started is not known/ : /its count step's start recorded no boot ID/, name);
      }
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
  ]) assert.equal(parsePerCpuCounts(/** @type {string} */ (text), /** @type {number[]} */ (cpus)).get("instructions:k")?.error, error, String(text));
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

test("on POSIX a bounded run kills the probe's whole group at its bound, and does not wait out a descendant that holds its output after the leader exits", { skip: process.platform === "win32" && "process groups are POSIX" }, async () => {
  // A leader and the child it started, both in its group, both sleeping past the bound: both are killed.
  const killed = await runBounded(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); console.log(c.pid); setTimeout(() => {}, 60000);"], { timeoutMs: 1000, graceMs: 3000 });
  assert.equal(killed.cleanup, "confirmed", killed.error);
  assert.equal(killed.signal, "SIGKILL");
  const descendant = Number(killed.stdout.trim());
  assert.ok(descendant > 0, killed.stdout);
  // Gone, or a zombie its new parent has not reaped yet (in a container whose init does not reap).
  const gone = () => { try { process.kill(descendant, 0); } catch { return true; } return /^\S+ \(.*\) Z/.test(readFileSync(`/proc/${descendant}/stat`, "utf8")); };
  assert.ok(gone(), `the leader's child ${descendant} still runs`);
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
