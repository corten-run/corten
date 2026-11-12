// Tests for builds.mjs: node --test bench/fullstack/builds.test.mjs (npm run check runs it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { allApps } from "./apps.mjs";
import { buildRow, cargoBuilds, changeOf, contextOf, copyFilter, crateCost, dockerfileOf, oomKills, compiledIn, ranARun, ranSteps, readStep, recipes, runChange, rustcPasses, sourceDockerfile, stepScript, timingUnits, touchThen } from "./builds.mjs";
import { compiledFirst } from "./round.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));

// The rebuild edits the item page, so an app without pages (`pages: false`) has no recipe.
test("every app with pages has a recipe, and every recipe an app", () => {
  const pageApps = Object.keys(allApps).filter((name) => allApps[/** @type {keyof typeof allApps} */ (name)].pages !== false);
  assert.deepEqual(Object.keys(recipes).sort(), pageApps.sort());
});

test("a matched round builds Next.js as the tier's image is built, with the Dockerfile's arguments", () => {
  const nextjsEnv = (/** @type {Record<string, string>} */ env) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'const b = await import("./builds.mjs"); console.log(JSON.stringify(b.recipes.nextjs.env))'], { cwd: import.meta.dirname, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "BENCH_TIER" && k !== "BENCH_APPS" && k !== "BENCH_EDGE")), ...env } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(nextjsEnv({}), { NEXT_TELEMETRY_DISABLED: "1" });
  const dockerfile = readFileSync(join(repo, "bench/fullstack/apps/nextjs/Dockerfile"), "utf8");
  assert.deepEqual(nextjsEnv({ BENCH_TIER: "matched" }), { NEXT_TELEMETRY_DISABLED: "1", PROFILE: "matched", EDGE_HOST: /^ARG EDGE_HOST=(\S+)$/m.exec(dockerfile)?.[1] });
});

test("the apps that build first are the ones with a development build", () => {
  assert.deepEqual([...compiledFirst].sort(), Object.keys(recipes).filter((n) => recipes[n].dev).sort());
});

test("each app's edit changes its one price-alert button", () => {
  for (const name of Object.keys(recipes)) {
    const { from, to } = changeOf(name);
    const text = readFileSync(join(repo, contextOf(name), recipes[name].edit), "utf8");
    assert.equal(text.split(from).length, 2, `${name}: ${recipes[name].edit} needs exactly one ${from}`);
    assert.match(to, /title="Set the price alert"/, `${name}: the same title as the others'`);
  }
});

test("each other kind of edit changes one place in its file, and kinds are not repeated", () => {
  for (const [name, r] of Object.entries(recipes)) {
    const kinds = (r.edits ?? []).map((e) => e.kind);
    assert.equal(new Set(kinds).size, kinds.length, `${name}: a kind of edit twice`);
    // A kind names its group in loopsFailed, beside the test build's and the check's.
    for (const kind of kinds) assert.ok(!["test", "check"].includes(kind), `${name}: an edit may not be called ${kind}`);
    for (const e of r.edits ?? []) {
      const text = readFileSync(join(repo, contextOf(name), e.edit), "utf8");
      assert.equal(text.split(e.from).length, 2, `${name}: ${e.edit} needs exactly one ${e.from}`);
      assert.notEqual(e.from, e.to, `${name}: the ${e.kind} edit changes nothing`);
    }
    if (r.edits?.length || r.check || r.test) assert.ok(cargoBuilds(r) && r.dev, `${name}: editor, test and other edits are measured for the apps that build with cargo`);
  }
});

test("a recipe built from a Dockerfile stage names one its Dockerfile has", () => {
  for (const [name, r] of Object.entries(recipes)) {
    if (!r.stage) continue;
    const dockerfile = readFileSync(join(repo, r.stage, "Dockerfile"), "utf8");
    assert.match(dockerfile, /^FROM \S+ AS tools$/m, `${name}: its Dockerfile has no tools stage`);
    assert.match(r.tools, /^bb-tools-/, `${name}: a stage's image is named bb-tools-<app>`);
  }
});

test("the source image starts from the toolchain and copies the context", () => {
  assert.equal(sourceDockerfile("nextjs"), 'FROM node:24-bookworm-slim\nENV NEXT_TELEMETRY_DISABLED="1"\nWORKDIR /app\nCOPY . .\n');
  assert.equal(contextOf("corten"), ".");
  assert.equal(contextOf("nextjs"), "bench/fullstack/apps/nextjs");
  assert.match(sourceDockerfile("gin"), /^FROM bb-tools-gin\nRUN apk add [^\n]+\nWORKDIR \/src\nCOPY \. \.\n$/);
});

// Whether bash runs, asked twice: on Windows it is a WSL start, which can fail once under load.
const hasBash = () => spawnSync("bash", ["-c", "true"]).status === 0 || spawnSync("bash", ["-c", "true"]).status === 0;

test("each app's edited file is touched by its own name, whatever the shell would read in it", { skip: !hasBash() && "no bash here" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "corten-touch-"));
  const apps = Object.entries(recipes);
  // One bash for every app, each in a subshell in its own directory, as a step runs, with a path
  // relative to it: on Windows each bash is a WSL start, and one per app is the probable cause of
  // the test failing now and then under load, exiting 1 with nothing on stderr. Each app's name is
  // printed before its commands, so one whose quoting breaks the script's parse is the last named.
  // The script is on stdin: Windows passes a command line on to WSL's bash changed.
  let script = "echo started\n";
  for (const [name, r] of apps) {
    const file = join(dir, name, r.edit);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x");
    utimesSync(file, 1, 1);
    const where = join(dir, name).replace(/\\/g, "/");
    script += `echo "app ${name}"\n(cd '${where}' 2>/dev/null || cd "$(wslpath '${where}')" || exit 9\n${touchThen(r.edit, "true")}\n) || echo "failed ${name} $?"\n`;
  }
  let run = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  // A bash that never ran the script (no "started") is asked once more, which only covers a
  // failed start (the probable cause of the failures, not confirmed); a failed touch is not.
  if (!/^started$/m.test(run.stdout)) run = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
  assert.match(run.stdout, /^started$/m, `bash did not start (status ${run.status}): ${run.stderr}`);
  const last = [...run.stdout.matchAll(/^app (.+)$/gm)].at(-1)?.[1] ?? "its start, before any app";
  assert.equal(run.status, 0, `the script stopped at ${last}: ${run.stdout}${run.stderr}`);
  for (const [name, r] of apps) {
    const file = join(dir, name, r.edit);
    assert.doesNotMatch(run.stdout, new RegExp(`^failed ${name} `, "m"), `${name}: ${run.stdout}${run.stderr}`);
    assert.ok(statSync(file).mtimeMs > 1000, `${name}: ${r.edit} was not touched`);
    assert.deepEqual(readdirSync(dirname(file)), [r.edit.split("/").at(-1)], `${name}: the touch made another file`);
  }
});

test("a step's measurements are read from its output, and a step without them failed", () => {
  const output = "compiling\nBENCH ms 61234\nBENCH cpuUsec 183400000\nBENCH anonPeakBytes 1610612736\n";
  assert.deepEqual(readStep(output), { ms: 61234, cpuS: 183.4, peakMiB: 1536 });
  assert.deepEqual(readStep(`   Compiling card-market v0.1.0 (/src/examples/card-market)\n${output}`)?.compiled, ["card-market"]);
  assert.deepEqual(readStep(`    Checking card-market v0.1.0 (/src/examples/card-market)\n${output}`)?.compiled, ["card-market"], "cargo check's line");
  assert.equal(readStep("error[E0425]\nBENCH failed\n"), null);
  assert.equal(readStep("BENCH ms 5\nBENCH cpuUsec 9\n"), null);
  assert.equal(readStep("BENCH ms 5\nBENCH cpuUsec 9\nBENCH anonPeakBytes 0\n"), null, "no memory sample: the sampler did not run");
  assert.equal(oomKills("Killed\nBENCH oomKills 2\nBENCH failed\n"), 2);
  assert.equal(oomKills("error[E0425]\nBENCH oomKills 0\nBENCH failed\n"), 0);
  assert.equal(oomKills("BENCH failed\n"), 0);
});

// Where bash and cgroup v2's files are (a Linux host or WSL), the script runs as a step's would.
const bash = (/** @type {string} */ script) => spawnSync("bash", ["-s"], { input: script, encoding: "utf8", timeout: 30_000 });
const cgroup = bash("test -r /sys/fs/cgroup/cpu.stat && test -r /sys/fs/cgroup/memory.stat").status === 0;

test("the step script measures its command, prints its output, and fails with it", { skip: !cgroup && "no bash with cgroup v2 here" }, () => {
  // One to two seconds of a busy loop (bash counts SECONDS whole), so the CPU time has a floor.
  const ok = bash(stepScript("echo built; head -c 50000000 /dev/zero | tail -c 1 > /dev/null; end=$((SECONDS + 2)); while (( SECONDS < end )); do :; done"));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^built$/m);
  const got = readStep(ok.stdout);
  assert.ok(got && got.ms >= 1000, ok.stdout);
  // Both counters were read: CPU time and a memory sample taken while the command ran. The CPU
  // time is the step's: at least the busy loop's second, at most its wall time on every core
  // (here the cgroup may be a whole machine's, which has run far longer).
  assert.ok(/^BENCH cpuUsec [1-9]\d*$/m.test(ok.stdout), ok.stdout);
  assert.ok(got.cpuS >= 0.9, ok.stdout);
  assert.ok(got.cpuS <= (got.ms / 1000) * availableParallelism() + 0.5, ok.stdout);
  assert.ok(/^BENCH anonPeakBytes [1-9]\d*$/m.test(ok.stdout), ok.stdout);
  const failed = bash(stepScript("echo 'error: it broke'; exit 3"));
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /error: it broke/);
  assert.match(failed.stdout, /^BENCH oomKills \d+$/m);
  assert.equal(readStep(failed.stdout), null);
});

test("cargo's timing units are found in its report and split between own crates and dependencies", () => {
  const html = `<script>\nDURATION = 9;\nconst UNIT_DATA = [\n  {"i": 0, "name": "serde", "version": "1.0.0", "target": "", "start": 0.5, "duration": 4.5},\n  {"i": 1, "name": "corten-macros", "version": "0.1.0", "target": "", "start": 0.5, "duration": 1.25},\n  {"i": 2, "name": "card-market", "version": "0.1.0", "target": " card-market \\"bin\\"", "start": 5, "duration": 3}\n];\nconst CONCURRENCY_DATA = [\n];\n</script>`;
  const units = timingUnits(html);
  assert.equal(units.length, 3);
  const cost = crateCost(units, ["corten", "card-market"]);
  assert.equal(cost.unitSeconds, 8.8);
  assert.equal(cost.ownSeconds, 4.3);
  assert.equal(cost.dependencySeconds, 4.5);
  assert.deepEqual(cost.own.map((u) => u.name), ["corten-macros", "card-market"]);
  assert.deepEqual(cost.slowest[0], { name: "serde", target: "", seconds: 4.5, start: 0.5, end: 5 });
  assert.equal(cost.own[1].target, 'card-market "bin"');
  assert.deepEqual(crateCost(units, ["cort"]).own, [], "a prefix matches whole name parts only");
  assert.throws(() => timingUnits("<html></html>"), /format changed/);
});

/**
 * An app's Dockerfile as Docker reads it: comment lines dropped, continued lines joined, runs of
 * spaces made one, then split into its stages, each with its FROM image, WORKDIR, ENV, ADD and RUN
 * instructions.
 * @param {string} name
 */
function stagesOf(name) {
  const lines = readFileSync(join(repo, dockerfileOf(name)), "utf8").replace(/\r/g, "").split("\n").filter((l) => !/^\s*#/.test(l));
  const text = lines.join("\n").replace(/\\\n/g, " ").replace(/[ \t]+/g, " ");
  /** @type {{ from: string, workdir: string[], env: string[], add: string[], run: string[] }[]} */
  const stages = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [, op, rest] = /^(\S+) ?(.*)$/.exec(line) ?? [];
    if (op === "FROM") stages.push({ from: rest.split(" ")[0], workdir: [], env: [], add: [], run: [] });
    else if (stages.length && op === "WORKDIR") stages.at(-1)?.workdir.push(rest);
    else if (stages.length && op === "ENV") stages.at(-1)?.env.push(rest);
    else if (stages.length && op === "ADD") stages.at(-1)?.add.push(rest);
    else if (stages.length && op === "RUN") stages.at(-1)?.run.push(rest.replace(/^(--mount=\S+ )+/, ""));
  }
  return stages;
}

/** A recipe's commands, one by one, as its Dockerfile should have them. */
const parts = (/** @type {string} */ command) => command.replace(/\s+/g, " ").split(" && ").map((c) => c.trim())
  // This benchmark's own: downloading timed apart from compiling (builds.mjs, `setup`).
  .filter((c) => !c.startsWith("cargo fetch"))
  // A rebuild replaces the release the clean build made rather than asking.
  .map((c) => c.replace(/ --overwrite$/, ""));

// Production dependency pruning packages an already built artifact, never a timed rebuild.
const productionPrune = (/** @type {string} */ command) => /^npm prune --omit=dev(?: --no-audit --no-fund)?$/.test(command);
const postBuildPrune = (/** @type {string[]} */ commands, /** @type {number} */ index, /** @type {string | undefined} */ build) =>
  !!build && productionPrune(commands[index]) && commands.slice(0, index).includes(parts(build).at(-1) ?? "");

test("only exact production pruning after a build is packaging, never a recipe step", () => {
  for (const command of ["npm prune --omit=dev", "npm prune --omit=dev --no-audit --no-fund"]) {
    assert.equal(postBuildPrune(["npm run build", command], 1, "npm run build"), true);
    assert.equal(postBuildPrune([command, "npm run build"], 0, "npm run build"), false);
    assert.equal(postBuildPrune(["npm install", command], 1, undefined), false);
  }
  for (const command of ["npm prune", "npm prune --omit=optional", "npm prune --omit=dev --force", "npm prune --omit=dev --no-audit --no-fund && npm run build"]) {
    assert.equal(postBuildPrune(["npm run build", command], 1, "npm run build"), false, command);
  }
  assert.ok(Object.values(recipes).every((r) => ![...parts(r.deps), ...parts(r.build ?? "")].some((command) => /^npm prune(?:\s|$)/.test(command))), "pruning must not enter timed dependencies or rebuilds");
});

test("each recipe runs its Dockerfile's commands, from its image, in its directory", () => {
  for (const [name, r] of Object.entries(recipes)) {
    const stages = stagesOf(name);
    // Packaging after the build (copying the output aside) and the shared cache's touch, which this
    // benchmark has no use for; every other command of the deps and build stages is the recipe's.
    const packaging = [/^mkdir -p \/out$/, /^cp (-r )?\S+ \/out\/\S+$/, /^chmod 644 /, /^find \. -name target -prune -o -type f -exec touch \{\} \+$/];
    const mine = [...parts(r.deps), ...(r.build ? parts(r.build) : [])];
    for (const stage of stages.filter((s) => s.run.some((c) => mine.some((m) => c.includes(m))))) {
      const commands = stage.run.flatMap((c) => c.split(" && ").map((x) => x.trim()));
      for (const [index, command] of commands.entries()) {
        assert.ok(mine.includes(command) || packaging.some((p) => p.test(command)) || postBuildPrune(commands, index, r.build), `${name}: its Dockerfile runs ${command}, which its recipe does not`);
      }
      if (r.stage) assert.equal(stage.from, "tools", `${name}: its build stage starts from its tools stage`);
    }
    const run = stages.flatMap((s) => s.run).join(" && ");
    for (const part of mine) assert.ok(run.includes(part), `${name}: its Dockerfile does not run ${part}`);
    // An app with no build step: its Dockerfile runs nothing after the dependency step, and what
    // that stage sets and fetches is checked as a build stage's is.
    const last = parts(r.build ?? r.deps)[0];
    const build = stages.find((s) => s.run.some((c) => c.includes(last)));
    if (!r.build) assert.ok(build && build.run.at(-1)?.includes(parts(r.deps).at(-1) ?? ""), `${name}: it has no build, but its Dockerfile runs something after its dependencies`);
    assert.ok(build, `${name}: no stage runs its build`);
    if (!r.stage) assert.equal(stages[0].from, r.tools, `${name}: its toolchain is its Dockerfile's first image`);
    assert.ok(stages.some((s) => s.workdir.includes(r.workdir)), `${name}: its Dockerfile has no WORKDIR ${r.workdir}`);
    for (const [k, v] of Object.entries(r.env ?? {})) assert.ok(stages.some((s) => s.env.some((e) => e.split(" ").includes(`${k}=${v}`))), `${name}: its Dockerfile does not set ${k}=${v}`);
    // And what the build stage sets, the recipe sets.
    for (const e of build.env.flatMap((x) => x.split(" "))) {
      assert.match(e, /^\w+=/, `${name}: its build stage's ENV ${e} is not KEY=value, which this check reads`);
      const [k, v] = e.split("=");
      assert.equal(r.env?.[k], v, `${name}: its build stage sets ${e}, which its recipe does not`);
    }
    // What the build stage fetches with ADD, the source image fetches too.
    assert.deepEqual(r.add ? [r.add] : [], build.add, `${name}: the recipe's ADD is its build stage's`);
    if (r.add) assert.ok(sourceDockerfile(name).split("\n").includes(`ADD ${r.add}`), name);
  }
});

test("rustc's passes and macro statistics are read from its output", () => {
  const output = [
    "time:   0.002; rss:   37MB ->   37MB (   +1MB)\tparse_crate",
    "time:   2.106; rss:   60MB ->  410MB ( +350MB)\texpand_crate",
    "time:  14.250; rss:  900MB -> 1200MB ( +300MB)\tLLVM_passes",
    "time:  14.300; rss:  900MB -> 1200MB ( +300MB)\tfinish_ongoing_codegen",
    "time:  17.000; rss:   37MB ->  151MB ( +114MB)\ttotal",
    // As rustc 1.99 writes them for card-market: digits grouped with _, and a long name wrapped.
    "macro-stats ===================================================================================",
    "macro-stats MACRO EXPANSION STATS: card_market",
    "macro-stats Macro Name                         Uses      Lines  Avg Lines      Bytes  Avg Bytes",
    "macro-stats -----------------------------------------------------------------------------------",
    "macro-stats ::core::include_bytes!               22         22        1.0    400_239   18_192.7",
    "macro-stats #[derive(Deserialize)]               19      4_884      257.1    283_624   14_927.6",
    "macro-stats html!                                18        917       50.9     44_913    2_495.2",
    "macro-stats ::schemars::_private::serde_json::json!",
    "macro-stats                                      10         10        1.0        440       44.0",
    "macro-stats #[derive(Id)]                         2         84       42.0      3_057    1_528.5",
    "macro-stats ===================================================================================",
  ].join("\r\n");
  const { total, passes, macros } = rustcPasses(output);
  // The total is the crate's time; the passes nest (LLVM_passes is inside finish_ongoing_codegen).
  assert.equal(total, 17);
  assert.deepEqual(passes.map((p) => p.pass), ["expand_crate", "LLVM_passes", "finish_ongoing_codegen"]);
  assert.equal(rustcPasses("time:   2.106; rss:   60MB ->  410MB ( +350MB)\texpand_crate").total, null);
  assert.equal(passes[1].rssAfter, "1200MB");
  assert.deepEqual(macros.map((m) => m.macro), ["#[derive(Deserialize)]", "html!", "#[derive(Id)]", "::core::include_bytes!", "::schemars::_private::serde_json::json!"]);
  assert.deepEqual(macros[1], { macro: "html!", uses: 18, lines: 917, bytes: 44913 });
  assert.equal(macros[4].uses, 10);
});

test("each Rust app's completion point is in its file once, and every app that checks has one", () => {
  for (const [name, r] of Object.entries(recipes)) {
    assert.equal(!!r.ra, !!r.check, `${name}: an app the editor's loop checks has a completion point, and only one`);
    if (!r.ra) continue;
    assert.equal(r.ra.at.split("|").length, 2, `${name}: one | in ${r.ra.at}`);
    // The probe types `nope_` at the point and looks for an error naming `nope_<expect>`.
    assert.ok(r.ra.at.split("|")[1].startsWith(r.ra.expect), `${name}: ${r.ra.at} has ${r.ra.expect} right after the |`);
    const text = readFileSync(join(repo, contextOf(name), r.edit), "utf8");
    assert.equal(text.split(r.ra.at.replace("|", "")).length, 2, `${name}: ${r.edit} needs exactly one ${r.ra.at}`);
  }
});

test("a Docker rebuild's edit numbers its run, so no two runs write the same file", () => {
  for (const name of Object.keys(recipes)) {
    const seen = new Set();
    for (let run = 1; run <= 6; run += 1) {
      const { from, to } = runChange(name, run);
      assert.equal(from, changeOf(name).from);
      assert.ok(to.includes(`Set the price alert (${run})`), `${name}: ${to}`);
      seen.add(to);
    }
    assert.equal(seen.size, 6, name);
  }
});

test("the steps a BuildKit build ran are the ones its plain output did not mark CACHED", () => {
  const output = [
    "#1 [internal] load build definition from Dockerfile",
    "#1 DONE 0.0s",
    "#5 [build 1/4] FROM docker.io/library/rust:1-bookworm@sha256:abc",
    "#5 CACHED",
    "#6 [build 2/4] COPY . .",
    "#6 DONE 0.4s",
    "#7 [build 4/4] RUN --mount=type=cache,target=/src/target cargo build --release",
    "#7 12.1    Compiling card-market v0.1.0 (/src/examples/card-market)",
    "#7 DONE 40.2s",
    "#8 [stage-1 3/3] COPY --from=build /out/server /app/server",
    "#8 CACHED",
  ].join("\r\n");
  assert.deepEqual(ranSteps(output), [
    "[internal] load build definition from Dockerfile",
    "[build 2/4] COPY . .",
    "[build 4/4] RUN --mount=type=cache,target=/src/target cargo build --release",
  ]);
  assert.deepEqual(ranSteps("#5 [build 4/4] RUN make\n#5 CACHED\n"), []);
  assert.equal(ranARun(ranSteps(output)), true);
  // A build after the edit that only copied (the build step cached) did not build.
  assert.equal(ranARun(["[internal] load build definition from Dockerfile", "[build 2/4] COPY . ."]), false);
  assert.equal(ranARun(["[build 2/4] COPY ./RUN /src"]), false);
  assert.deepEqual(compiledIn(output.replace("#7 DONE", "#7 30.5    Compiling card-market-two v0.2.0\r\n#7 DONE")), ["card-market", "card-market-two"]);
});

test("build.mjs's table has a row for an app with no build step, a built app and a failed one", () => {
  const step = { ms: 2500, cpuS: 3.1, peakMiB: 120 };
  assert.equal(buildRow("express", { deps: step, build: null, clean: { ms: 2500, cpuS: 3.1 }, rebuild: null, complete: true }),
    "| express | deps 2.5 s | no build step | clean 2.5 s, 3.1 CPU-s | nothing to rebuild |  |");
  assert.equal(buildRow("gin", { deps: step, build: step, clean: { ms: 5000, cpuS: 6.2 }, rebuild: step, complete: true }),
    "| gin | deps 2.5 s | build 2.5 s, 3.1 CPU-s, 120 MiB | clean 5.0 s, 6.2 CPU-s | rebuild 2.5 s, 3.1 CPU-s |  |");
  assert.equal(buildRow("leptos", { failed: "exit 1\nmore", deps: step }), "| leptos | FAILED: exit 1 |");
  assert.equal(buildRow("nuxt", { deps: step, complete: false }), "| nuxt | FAILED: stopped before it finished |");
});

test("a context is copied whatever its own directory is named, without the entries it skips", () => {
  const skip = new Set(["bench", "target"]);
  for (const root of ["/bench", "/src/corten"]) {
    const keep = copyFilter(root, skip);
    assert.equal(keep(root), true, root);
    assert.equal(keep(join(root, "examples", "card-market", "src", "views", "alert.rs")), true, root);
    assert.equal(keep(join(root, "bench")), false, root);
    assert.equal(keep(join(root, "target")), false, root);
  }
  // The real copy, of a root named bench, as docker-rebuild.mjs makes it.
  const scratch = mkdtempSync(join(tmpdir(), "copy-filter-"));
  const from = join(scratch, "bench");
  mkdirSync(join(from, "examples"), { recursive: true });
  mkdirSync(join(from, "bench"), { recursive: true });
  writeFileSync(join(from, "examples", "a.rs"), "a");
  writeFileSync(join(from, "bench", "b.txt"), "b");
  const to = join(scratch, "copy");
  cpSync(from, to, { recursive: true, filter: copyFilter(from, skip) });
  assert.deepEqual(readdirSync(to).sort(), ["examples"]);
  assert.equal(readFileSync(join(to, "examples", "a.rs"), "utf8"), "a");
  rmSync(scratch, { recursive: true, force: true });
});
