// Tests for builds.mjs: node --test bench/fullstack/builds.test.mjs (npm run check runs it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { allApps } from "./apps.mjs";
import { buildRow, cargoBuilds, changeOf, contextOf, copyFilter, crateCost, dockerfileOf, oomKills, compiledIn, ranARun, ranSteps, readStep, rebuildTimeoutMs, recipes, runChange, rustcPasses, sourceDockerfile, stepScript, timingUnits, touchThen } from "./builds.mjs";
import { calls, compiledFirst, idleMinutes } from "./round.mjs";
import { imageBuildTimeoutMs as catalogBuildTimeoutMs } from "../catalog/contract.mjs";
import { imageBuildTimeoutMs as marketplaceBuildTimeoutMs } from "../marketplace/run-contract.mjs";
import { nativeDeployment } from "../mixed-production/source-audit.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));

const rustDockerfiles = [
  "bench/fullstack/apps/axum-maud/Dockerfile",
  "bench/fullstack/apps/leptos/Dockerfile",
  "bench/fullstack/apps/topcoat/Dockerfile",
  "bench/catalog/corten/Dockerfile",
  "bench/live/apps/corten/Dockerfile",
  "bench/marketplace/corten/Dockerfile",
  "bench/nodelay/app/Dockerfile",
  "bench/live/apps/corten/Dockerfile.parity",
  "bench/live/apps/leptos/Dockerfile",
  "bench/live/apps/topcoat/Dockerfile",
];

/** Docker's logical instruction lines, without comments or continuation whitespace. */
const instructionsOf = (/** @type {string} */ text) => text.replace(/\r/g, "").split("\n")
  .filter((line) => !/^\s*#/.test(line)).join("\n").replace(/\\\n/g, " ").replace(/[ \t]+/g, " ")
  .split("\n").map((line) => line.trim()).filter(Boolean);

/** The mount options, before the command of a RUN instruction. */
const mountsOf = (/** @type {string} */ line) => [...line.matchAll(/--mount=(\S+)/g)]
  .map((match) => Object.fromEntries(match[1].split(",").map((option) => option.split("="))));

for (const file of rustDockerfiles) {
  test(`${file}: the target cache has an explicit locked id`, () => {
    const targets = instructionsOf(readFileSync(join(repo, file), "utf8")).flatMap(mountsOf)
      .filter((mount) => mount.type === "cache" && mount.target?.endsWith("/target"));
    assert.equal(targets.length, 1, "one target cache per app image");
    assert.ok(targets[0].id, "the target cache has no id");
    assert.doesNotMatch(targets[0].id, /^[a-z][a-z0-9_-]*-target$/, "the id cannot collide with a generated app's <name>-target");
    assert.equal(targets[0].sharing, "locked", "builds of the same app take turns");
  });

  test(`${file}: cargo shares its whole home, including the package-cache lock`, () => {
    let home;
    let runs = 0;
    for (const line of instructionsOf(readFileSync(join(repo, file), "utf8"))) {
      if (line.startsWith("FROM ")) home = undefined;
      if (line.startsWith("ENV ")) home = /(?:^| )CARGO_HOME=(\S+)/.exec(line)?.[1] ?? home;
      if (!line.startsWith("RUN ") || !/\bcargo (?:install|build|leptos)\b/.test(line)) continue;
      runs += 1;
      const mounts = mountsOf(line);
      assert.ok(!mounts.some((mount) => /\/usr\/local\/(?:cargo|rustup)(?:\/|$)/.test(mount.target)), "do not cache only the registry or hide the installed tools/toolchain");
      const cargo = mounts.filter((mount) => mount.type === "cache" && mount.target === "/var/cache/cargo");
      assert.equal(cargo.length, 1, "mount the whole cargo home");
      assert.equal(cargo[0].id ?? cargo[0].target, "/var/cache/cargo", "one downloaded-crate cache across apps");
      assert.equal(cargo[0].sharing ?? "shared", "shared", "Cargo's own package-cache lock coordinates downloads");
      assert.equal(/\bCARGO_HOME=(\S+) cargo\b/.exec(line)?.[1] ?? home, "/var/cache/cargo", "cargo uses the mounted home");
      if (/\bcargo install\b/.test(line)) assert.match(line, / --root \/usr\/local\/cargo(?: |$)/, "installed CLI binaries stay in the tools image, outside the cache mount");
    }
    assert.ok(runs > 0, "the build's cargo commands were checked");
  });
}

test("unrelated Rust app images never share a target cache id", () => {
  const ids = new Map();
  for (const file of rustDockerfiles) {
    for (const mount of instructionsOf(readFileSync(join(repo, file), "utf8")).flatMap(mountsOf)
      .filter((mount) => mount.type === "cache" && mount.target?.endsWith("/target"))) {
      const id = mount.id ?? mount.target;
      assert.ok(!ids.has(id), `${file} shares ${id} with ${ids.get(id)}`);
      ids.set(id, file);
    }
  }
});

test("Rust recipes keep the mounted cargo home for dependencies, builds and development loops", () => {
  for (const name of ["axum-maud", "leptos", "topcoat"]) {
    const r = recipes[name];
    assert.equal(r.env?.CARGO_HOME, "/var/cache/cargo", name);
    assert.ok(sourceDockerfile(name).split("\n").includes('ENV CARGO_HOME="/var/cache/cargo"'), name);
    for (const kind of ["deps", "build", "dev", "check", "test"]) {
      assert.match(r[/** @type {"deps" | "build" | "dev" | "check" | "test"} */ (kind)] ?? "", /^cargo /, `${name}: ${kind} inherits the source image's cargo home`);
    }
  }
});

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

test("server recipes use the refreshed production toolchain", () => {
  for (const name of ["spring", "django", "fastapi"]) {
    const dockerfile = readFileSync(join(repo, "bench/fullstack/apps", name, "Dockerfile"), "utf8");
    const image = /^FROM (\S+)/m.exec(dockerfile)?.[1];
    assert.equal(recipes[name].tools, image, `${name}: recipe and production image differ`);
    assert.match(image, /@sha256:[a-f0-9]{64}$/, `${name}: immutable image required`);
  }
});

test("native .NET CI tests use each production SDK", () => {
  const workflow = parseYaml(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  for (const [app, job, name] of [
    ["aspnet", "parity", "Test native Razor alert persistence and render failures"],
    ["aspnet-aot", "json-aot", "Test reflection-disabled native record sources"],
  ]) {
    const dockerfile = readFileSync(join(repo, "bench/fullstack/apps", app, "Dockerfile"), "utf8");
    const sdk = /^FROM (mcr\.microsoft\.com\/dotnet\/sdk:\S+) AS build$/m.exec(dockerfile)?.[1];
    assert.ok(sdk, `${app}: production SDK required`);
    const step = workflow.jobs[job].steps.find((step) => step.name === name);
    assert.ok(step, `${app}: native CI test required`);
    const images = step.run.match(/mcr\.microsoft\.com\/dotnet\/sdk:\S+/g);
    assert.deepEqual(images, [sdk], `${app}: native CI and production SDK differ`);
  }
});

test("the source image starts from the toolchain and copies the context", () => {
  assert.equal(sourceDockerfile("nextjs"), 'FROM node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067\nENV NEXT_TELEMETRY_DISABLED="1"\nWORKDIR /app\nCOPY . .\n');
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
 * @param {string} [text] the Dockerfile, when not the app's own
 */
function stagesOf(name, text = readFileSync(join(repo, dockerfileOf(name)), "utf8")) {
  /** @type {{ from: string, workdir: string[], env: string[], add: string[], run: string[] }[]} */
  const stages = [];
  for (const line of instructionsOf(text)) {
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

// The separate build recipe runs the same locked install without the image diagnostics.
// docker-rebuild.mjs instead times the image as written. Only this wrapper is equivalent.
const nextImageInstall = /^timeout --verbose --kill-after=10s 10m (npm ci --no-audit --no-fund) --fetch-timeout=60000 --loglevel=http$/;
const nextInstallInputs = ["WORKDIR /app", "ENV NEXT_TELEMETRY_DISABLED=1", "COPY package.json package-lock.json ./"];
// Spring's image bounds each Maven run and logs each transfer (#1763); the recipe runs the same goals
// and arguments with -q and without the bound. docker-rebuild.mjs times the image as written. Only
// this wrapper and -q are equivalent: the kill grace, the bound and the arguments are captured. The
// arguments are Maven's alone, with no shell operator, so the bound wraps the whole RUN.
const springImageMaven = /^timeout --verbose --kill-after=(\d+[smh]?) (\d+[smh]?) mvn -B ([\w:.=-]+(?: [\w:.=-]+)*)$/;

/** A Dockerfile command as the recipe runs it, past the image-only wrappers above. */
const recipeCommandOf = (/** @type {string} */ name, /** @type {string} */ command) =>
  name === "nextjs" ? command.replace(nextImageInstall, "$1")
    : name === "spring" ? command.replace(springImageMaven, "mvn -q -B $3") : command;

function checkNextInstall(/** @type {string[]} */ lines) {
  const install = lines.findIndex((line) => line.startsWith("RUN ") && nextImageInstall.test(line.slice(4)));
  assert.ok(install >= 0, "expected the exact Next.js image install with no RUN mount");
  assert.ok(install < lines.indexOf("COPY . .") && install < lines.indexOf("RUN npm run build"),
    "expected the Next.js image install before app source and build");
  assert.equal(lines.filter((line) => /^RUN .*\bnpm ci\b/.test(line)).length, 1);
  // Inspect raw instructions: the general equivalence check drops RUN mounts.
  // No source, npm configuration, or extra ENV/ARG can reach the logged install.
  assert.match(lines[0], /^FROM \S+ AS build$/);
  assert.deepEqual(lines.slice(1, install), nextInstallInputs, "expected only the Next.js install inputs");
}

test("Next.js bounds the locked image install before copying app source or building", () => {
  const lines = instructionsOf(readFileSync(join(repo, dockerfileOf("nextjs")), "utf8"));
  checkNextInstall(lines);
  const manifestCopy = nextInstallInputs.at(-1);
  assert.throws(() => checkNextInstall(lines.filter((line) => line !== manifestCopy)), /only the Next.js install inputs/);
  assert.throws(() => checkNextInstall(lines.map((line) => line === manifestCopy ? "COPY . ." : line)), /before app source and build/);
  assert.throws(() => checkNextInstall(lines.map((line) => line.replace(/^RUN timeout /, "RUN --mount=type=bind,target=/app timeout "))),
    /exact Next.js image install with no RUN mount/);
});

// Maven's retries of a 429 or 503 are per request (.mvn/maven.config), and a cold Spring build makes
// hundreds of them, so every Maven run in the image and in hosted CI also has its own positive bound,
// which ends inside the image build or step that directly contains it, with time left to report the
// transfer it stopped on (#1763). The parity job's timeout-minutes also covers the sum of Spring's
// bounded steps and image builds in it. These checks guard against accidental changes, not against a
// deliberately adversarial rewrite such as a shell function that shadows timeout or a Docker call
// spelled another way.
const springRetries = [
  "-Daether.transport.http.retryHandler.count=4",
  "-Daether.transport.http.retryHandler.interval=10000",
  "-Daether.transport.http.retryHandler.intervalMax=40000",
];
// Maven Central is reached through Google's public mirror of it (#1763): Central rate limited hosted
// runners past every bounded retry. maven.config names the app's own settings by Maven's root
// directory, so the transport proof's copies, run with -f from another directory, each read their
// own, and its strict checksums fail a download whose bytes do not match the checksum the mirror
// serves, or that has none. The coordinates and versions Maven resolves are unchanged; only the
// host is.
const springSettings = "--settings=${session.rootDirectory}/.mvn/settings.xml";
const springConfig = [...springRetries, springSettings, "--strict-checksums"];
const springMirror = { id: "google-maven-central", mirrorOf: "central", url: "https://maven-central.storage-download.googleapis.com/maven2/" };
const springInstallInputs = ["WORKDIR /src", "COPY pom.xml ./", "COPY .mvn ./.mvn"];
const springTestBuild = "docker build --target build -t cb-spring-tests bench/fullstack/apps/spring";
const springTestMaven = /^docker run --rm --cpus 2 --memory 2g --mount type=volume,source=cb-spring-m2,target=\/root\/\.m2 cb-spring-tests timeout --verbose --kill-after=(\d+[smh]?) (\d+[smh]?) mvn -B test$/;
const springProofMaven = /^timeout --verbose --kill-after=(\d+[smh]?) "\$maven_seconds" mvn -B -f "\$project\/pom\.xml" "-Dtest=\$suite" -DfailIfNoTests=true test "\$@" \|\| status=1$/;

const springProofProbes = [
  "run_probe mvc MarketplaceDisconnectHttpTest || result=1",
  "run_probe webflux WebFluxDisconnectHttpTest -Dscope=test dependency:tree || result=1",
];

/**
 * How many times a Dockerfile or script names a word, past comment lines, quotes and backslashes:
 * alone or by path, never inside a longer name such as the .mvn directory.
 */
function wordCount(/** @type {string} */ text, /** @type {string} */ word) {
  const plain = text.replace(/\r/g, "").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n").replace(/["'\\]/g, "");
  return plain.match(new RegExp(`(?<![\\w.])${word}(?![\\w.])`, "g"))?.length ?? 0;
}

/** Seconds in a timeout(1) duration: a number with an optional s, m or h, above zero (0 disables it). */
function durationSeconds(/** @type {string} */ value) {
  const match = /^(\d+)([smh]?)$/.exec(value);
  assert.ok(match, `unexpected duration ${value}`);
  const seconds = Number(match[1]) * ({ "": 1, s: 1, m: 60, h: 3600 })[/** @type {"" | "s" | "m" | "h"} */ (match[2])];
  assert.ok(seconds > 0, `duration ${value} is not positive, so it bounds nothing`);
  return seconds;
}

/** A step's timeout-minutes, in seconds. */
function stepSeconds(/** @type {{ "timeout-minutes"?: unknown }} */ step) {
  const minutes = step["timeout-minutes"];
  assert.ok(Number.isInteger(minutes) && Number(minutes) > 0, `step timeout-minutes ${minutes} is not a positive integer`);
  return Number(minutes) * 60;
}

/**
 * A shell script's commands as sh runs them: a comment line dropped (it never continues), a line
 * ending in a backslash joined to the next, runs of spaces made one.
 */
function shellCommandsOf(/** @type {string} */ text) {
  /** @type {string[]} */
  const commands = [];
  let continued = false;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    // A backslash continues the line only as its last character, as in the shell: one followed by a
    // space escapes the space and ends the command there.
    const joins = raw.endsWith("\\");
    const line = raw.replace(/[ \t]+/g, " ").trim();
    if (!continued && line.startsWith("#")) continue;
    const body = joins ? line.slice(0, -1).trim() : line;
    if (continued) commands[commands.length - 1] = `${commands.at(-1)} ${body}`.trim();
    else commands.push(body);
    continued = joins;
  }
  return commands.filter(Boolean);
}

/**
 * Spring's Maven runs in its Dockerfile, in order: each RUN (in any case) that is exactly one Maven
 * command under a positive bound and kill grace. The Dockerfile names mvn only in those, and they are
 * the recipe's commands one for one: none added, none missing.
 */
function springMavenRuns(/** @type {string} */ dockerfile) {
  const maven = instructionsOf(dockerfile).filter((line) => /^run /i.test(line)).flatMap((line) => {
    const bounded = springImageMaven.exec(line.slice(4));
    return bounded ? [{ recipe: `mvn -q -B ${bounded[3]}`, seconds: durationSeconds(bounded[2]) + durationSeconds(bounded[1]) }] : [];
  });
  assert.equal(wordCount(dockerfile, "mvn"), maven.length, "spring: its Dockerfile runs Maven outside one exact positive bound");
  assert.deepEqual(maven.map((m) => m.recipe), [recipes.spring.deps, recipes.spring.build],
    "spring: its Dockerfile runs Maven commands other than its recipe's, one for one and in order");
  return maven;
}

/** Seconds Spring's image can spend in Maven: each RUN's bound plus its kill grace, as the Dockerfile has them. */
const springMavenSeconds = (/** @type {string} */ dockerfile) => springMavenRuns(dockerfile).reduce((sum, run) => sum + run.seconds, 0);

/** The longest a single request can wait between retries under Resolver 2's Apache transport. */
function springRequestWaitSeconds(/** @type {string[]} */ lines) {
  const value = (/** @type {string} */ key) => {
    const line = lines.find((l) => l.startsWith(`-Daether.transport.http.retryHandler.${key}=`));
    assert.ok(line, `maven.config sets no ${key}`);
    return Number(line.split("=")[1]);
  };
  const [count, interval, max] = [value("count"), value("interval"), value("intervalMax")];
  // Retry n waits Retry-After, or else n * interval; a wait above intervalMax, or n above count, stops.
  let linear = 0;
  for (let n = 1; n <= count && n * interval <= max; n++) linear += n * interval;
  return Math.max(linear, count * max) / 1000;
}

/**
 * Spring's Maven settings past their header (the XML declaration and one comment), byte for byte:
 * one mirror, of Central only, at Google's URL, and nothing else. Exact text rather than a parse,
 * so no XML form (a CDATA, a namespace prefix, a space in a tag, an element such as `blocked` or
 * `mirrorOfLayouts`) can change what Maven does and still pass.
 */
const springSettingsBody = `<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.2.0 https://maven.apache.org/xsd/settings-1.2.0.xsd">
  <mirrors>
    <mirror>
      <id>${springMirror.id}</id>
      <name>Google's mirror of Maven Central</name>
      <mirrorOf>${springMirror.mirrorOf}</mirrorOf>
      <url>${springMirror.url}</url>
    </mirror>
  </mirrors>
</settings>
`;

/**
 * Spring's .mvn: maven.config's lines exactly (retries, the app's settings and strict checksums),
 * and settings that are an XML declaration, one comment of printable ASCII, tabs and newlines with
 * no markup, no `--` and no closing `-` (so XML 1.0 reads it as one comment), then exactly
 * `springSettingsBody`: one mirror, of Central only, at Google's URL, and nothing else. Only CRLF
 * line ends are read as LF: a bare CR is kept, so it fails the comparison instead of being dropped
 * from text an XML reader would see as a line break.
 */
function checkSpringMaven(/** @type {string[]} */ config, /** @type {string} */ settings) {
  assert.deepEqual(config, springConfig, "Spring's maven.config changed: its retries, its settings or its strict checksums");
  const text = settings.replace(/\r\n/g, "\n");
  const head = /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!--([\t\n\x20-\x3B=?-~]*)-->\n/.exec(text);
  assert.ok(head && !head[1].includes("--") && !head[1].endsWith("-"), "Spring's Maven settings do not start with their declaration and one plain comment");
  assert.equal(text.slice(head[0].length), springSettingsBody,
    "Spring's Maven reaches Central other than through Google's mirror alone, or its settings declare more than its mirror");
}

function checkSpringInstall(/** @type {string[]} */ lines, inputs = springInstallInputs) {
  const install = lines.findIndex((line) => line.startsWith("RUN ") && springImageMaven.exec(line.slice(4))?.[3] === "dependency:go-offline");
  assert.ok(install >= 0, "expected the exact bounded Spring dependency download with no RUN mount");
  assert.equal(lines.filter((line) => /^RUN .*\bdependency:go-offline\b/.test(line)).length, 1);
  assert.match(lines[0], /^FROM \S+ AS build$/);
  assert.deepEqual(lines.slice(1, install), inputs, "expected only the Spring dependency inputs");
}

/** Seconds the native Spring test step can spend in Maven: the test stage's image build, then its one bounded test run. */
function springTestStepSeconds(/** @type {{ run: string }} */ step, /** @type {number} */ imageSeconds) {
  const commands = shellCommandsOf(step.run);
  const maven = commands.filter((command) => springTestMaven.test(command));
  assert.equal(maven.length, 1, "the native Spring tests run Maven outside one exact positive bound");
  const tests = /** @type {RegExpExecArray} */ (springTestMaven.exec(maven[0]));
  assert.equal(wordCount(step.run, "mvn"), 1, "the native Spring test step runs Maven in more than its one bounded command");
  assert.deepEqual(commands, [springTestBuild, maven[0]], "the native Spring test step runs only its test-stage build, then its bounded tests");
  return imageSeconds + durationSeconds(tests[2]) + durationSeconds(tests[1]);
}

/**
 * The transport proof's Maven runs: how many, and each one's bound and kill grace. The script names
 * mvn only in its one bounded command, inside run_probe, and calls run_probe only as its two probes.
 * The bound is a variable, set once to a positive number before the first probe and read only by
 * the Maven command, so no later assignment, export or second setting can change it.
 */
function springProof(/** @type {string} */ script) {
  const commands = shellCommandsOf(script);
  const maven = commands.filter((command) => springProofMaven.test(command));
  assert.equal(maven.length, 1, "the proof runs Maven outside its exact positive bound");
  const run = /** @type {RegExpExecArray} */ (springProofMaven.exec(maven[0]));
  assert.equal(wordCount(script, "mvn"), 1, "the proof runs Maven in more than its one bounded command");
  assert.deepEqual(commands.filter((command) => wordCount(command, "run_probe") > 0), ["run_probe() {", ...springProofProbes],
    "the proof names run_probe only in its definition and its two probes");
  const settings = commands.filter((command) => command !== maven[0] && command.includes("maven_seconds"));
  assert.equal(settings.length, 1, "the proof sets maven_seconds once and reads it only in its Maven command");
  const bound = /^maven_seconds=(\d+)$/.exec(settings[0]);
  assert.ok(bound, `the proof sets maven_seconds other than to a number: ${settings[0]}`);
  assert.ok(commands.indexOf(settings[0]) < commands.indexOf(springProofProbes[0]), "the proof sets maven_seconds before its first probe");
  // Each copy builds with the app's .mvn, so its Maven retries each 429 or 503, reaches Central through
  // Google's mirror and checks checksums strictly, as the image does.
  for (const mode of ["mvc", "webflux"]) {
    const copy = `cp -R "$app/.mvn" "$work/${mode}/"`;
    assert.ok(commands.includes(copy) && commands.indexOf(copy) < commands.indexOf(springProofProbes[0]),
      `the proof copies .mvn into its ${mode} project before its first probe`);
  }
  return { runs: springProofProbes.length, bound: durationSeconds(bound[1]), seconds: durationSeconds(bound[1]) + durationSeconds(run[1]) };
}

/** The proof step runs Maven only through the proof script, never directly, and runs that script once. */
function checkSpringProofStep(/** @type {{ run: string }} */ step) {
  const commands = shellCommandsOf(step.run);
  assert.equal(wordCount(step.run, "mvn"), 0, "the proof step runs Maven outside the proof script");
  assert.equal(wordCount(step.run, "build"), 0, "the proof step builds an image");
  assert.equal(wordCount(step.run, "timeout"), 0, "the proof step bounds its run outside the proof script's own limits");
  assert.deepEqual(commands.filter((command) => wordCount(command, "run.sh") > 0), ["exec sh /proof/run.sh /src /evidence"],
    "the proof step runs the proof script exactly once");
}

/** Whether docker-rebuild.mjs measures images in one buildx call, bounded by builds.mjs's rebuildTimeoutMs. */
function rebuildCallUses(/** @type {string} */ source) {
  const calls = source.split('must(["buildx", "build",');
  return calls.length === 2 && (source.match(/"build"/g) ?? []).length === 1 &&
    source.includes('const r = run("docker", args, timeout);') && source.includes('spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 2 ** 20, timeout });') &&
    /^[^;]*?, \.\.\.extra, context\], rebuildTimeoutMs\);/.test(calls[1]);
}

/**
 * Whether the shared Catalog and Marketplace launcher (bench/catalog/output.mjs) stops a command at
 * the timeout its caller passed: one deadline timer, on the parameter as given, never reassigned.
 * Its command function sets two timers, that deadline and the pipe release a stop arms, and no other.
 */
function launcherForwards(/** @type {string} */ source) {
  const start = source.indexOf("async function command("), end = source.indexOf("\n  return { command,", start);
  const body = start >= 0 && end > start ? source.slice(start, end) : "";
  return (source.match(/async function command\(binary, args, \{ timeout = \d+, /g) ?? []).length === 1 &&
    (body.match(/\bsetTimeout\(/g) ?? []).length === 2 && body.split("release = setTimeout(() => {").length === 2 &&
    body.split('timer = setTimeout(() => stop("deadline"), timeout);').length === 2 &&
    (source.match(/(?<![\w.])timeout\s*(?:[-+*/%]|\?\?|\|\||&&)?=(?!=)/g) ?? []).length === 1;
}

/** Whether a runner builds images in one docker build call, bounded by its contract's imageBuildTimeoutMs. */
function buildCallUses(/** @type {string} */ runner) {
  const calls = runner.split('await docker(["build",');
  return calls.length === 2 && (runner.match(/"build"/g) ?? []).length === 1 &&
    runner.split('const docker = (args, opts) => command("docker", args, opts);').length === 2 && /^[^;]*?\], \{ timeout: imageBuildTimeoutMs, file: join\(folder, `build-\$\{app\}\.log`\) \}\);/.test(calls[1]);
}

/**
 * Runners that build Spring's Dockerfile outside the shared check-only runners: the exact call that
 * sets each one's build deadline, how many `"build"` arguments its source writes (one build call; the
 * hardening evidence check repeats its arguments; the legacy droplet launcher builds through
 * apps.mjs), that deadline in seconds, the line that passes the deadline on to the process (the
 * hardening check gets its Docker from the shared owned-container recorder, not checked here), and
 * an edit that shortens the deadline.
 * @type {{ runner: string, call: string, builds: number, seconds: number, forward: string, shorter: [string, string] }[]}
 */
const otherSpringBuilds = [
  { runner: "bench/mixed-production/run.mjs", call: '"-t", tag, "-f", deployment?.dockerfile ?? context.dockerfile, "-"], { timeout: 20 * 60 * 1000, file: join(folder, `${app}-build.log`), input: context.input });',
    builds: 1, seconds: 20 * 60, forward: 'docker = (args, opts) => io.command("docker", args, opts);', shorter: ["20 * 60 * 1000", "15 * 60 * 1000"] },
  { runner: "bench/hardening/evidence.mjs", call: "await docker(args, { input: context.input, settleOnInterrupt: true, timeout: 20 * 60 * 1000, file: log, receipt: command });",
    builds: 2, seconds: 20 * 60, forward: "", shorter: ["20 * 60 * 1000", "15 * 60 * 1000"] },
  { runner: "bench/json-api/run.mjs", call: '{ timeout: 60 * 60 * 1000, file: join(folder, `build-${app}-${payload}.log`) });',
    builds: 1, seconds: 60 * 60, forward: 'const docker = (args, opts) => command("docker", args, opts);', shorter: ["60 * 60 * 1000", "15 * 60 * 1000"] },
  // The defaults and legacy Live rounds build every image in one remote setup step of 90 minutes, a
  // limit all those images share, not Spring's own: this checks only that it is passed on and that
  // Spring's Maven runs alone fit inside it.
  { runner: "bench/fullstack/droplet.mjs", call: '].join(" && ")), 90), lockLost));', builds: 0, seconds: 90 * 60,
    forward: "`flock -E ${flockBusy} -w ${limit * 60} /tmp/droplet.lock timeout -k 30 ${limit * 60} bash -c ${quote(script)}`,", shorter: ["), 90), lockLost));", "), 15), lockLost));"] },
];

/** Whether a runner builds images in its known calls only, with its deadline written and passed on as expected. */
function buildDeadlineIs(/** @type {string} */ source, /** @type {typeof otherSpringBuilds[number]} */ build) {
  return source.split(build.call).length === 2 && (source.match(/"build"/g) ?? []).length === build.builds &&
    (build.forward === "" || source.split(build.forward).length === 2);
}

/**
 * Whether a parity step's `if` runs it for Spring, for the forms catalog.yml uses: `always()`,
 * `matrix.app == '<app>'` (or `!=`) and `contains(fromJSON('[...]'), matrix.app)`, joined by `&&`.
 * A matrix term false for Spring decides the condition; any other form fails rather than guess.
 * Names compare as Actions compares strings, ignoring case, so `!= 'Spring'` skips Spring. An `||`
 * outside parentheses and quotes fails, since then a false term no longer decides the condition.
 */
function runsForSpring(/** @type {string | undefined} */ condition) {
  if (condition === undefined) return true;
  /** @type {string[]} */
  const terms = [];
  let depth = 0, from = 0, quoted = false;
  for (let i = 0; i < condition.length; i++) {
    if (condition[i] === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (condition[i] === "(") depth += 1;
    else if (condition[i] === ")") { depth -= 1; if (depth < 0) break; }
    else if (depth === 0 && condition.startsWith("||", i)) assert.fail(`cannot tell whether a parity step runs for Spring: if: ${condition}`);
    else if (depth === 0 && condition.startsWith(" && ", i)) { terms.push(condition.slice(from, i)); from = i + 4; }
  }
  assert.ok(depth === 0 && !quoted, `cannot tell whether a parity step runs for Spring: if: ${condition}`);
  terms.push(condition.slice(from));
  /** @type {string[]} */
  const unknown = [];
  for (const term of terms.map((t) => t.trim())) {
    const app = /^matrix\.app (==|!=) '([\w-]+)'$/.exec(term);
    const listed = /^contains\(fromJSON\('(\[[^']*\])'\), matrix\.app\)$/.exec(term);
    const spring = (/** @type {unknown} */ name) => typeof name === "string" && name.toLowerCase() === "spring";
    const runs = app ? spring(app[2]) === (app[1] === "==") : listed ? JSON.parse(listed[1]).some(spring) : term === "always()" ? true : undefined;
    if (runs === false) return false;
    if (runs === undefined) unknown.push(term);
  }
  assert.equal(unknown.length, 0, `cannot tell whether a parity step runs for Spring: if: ${condition}`);
  return true;
}

const springTestStepName = "Test native Spring alert persistence and source boundaries";

/**
 * Spring's bounded work in the parity job against the job's timeout-minutes, both in seconds: each
 * step whose `if` runs it for Spring at its own timeout-minutes, and each shared runner step that
 * builds images (`--build`) for Spring at the image's Maven runs with their kill grace. Fails when
 * the job's timeout would not cover them, or a build step's own timeout would not cover its Maven.
 */
function springParity(/** @type {string} */ workflowText, /** @type {number} */ imageSeconds) {
  const job = parseYaml(workflowText).jobs.parity;
  // A run step, or an action step with its own timeout (an action with none, such as an upload, runs
  // inside the time the sum leaves for the rest of the job).
  /** @type {{ name?: string, id?: string, if?: string, run?: string, "timeout-minutes"?: unknown }[]} */
  const steps = job.steps.filter((/** @type {{ if?: string, run?: string, "timeout-minutes"?: unknown }} */ step) =>
    (step.run || step["timeout-minutes"] !== undefined) && runsForSpring(step.if));
  const builds = steps.filter((step) => /^node bench\/(catalog|marketplace)\/run\.mjs .*--build\b/.test(step.run ?? ""));
  assert.deepEqual(builds.map((step) => (step.run ?? "").split(" ")[1]).sort(), ["bench/catalog/run.mjs", "bench/marketplace/run.mjs"],
    "the parity job builds Spring's image once in each shared runner");
  for (const step of builds) {
    if (step["timeout-minutes"] !== undefined) assert.ok(imageSeconds <= stepSeconds(step), `${step.name}: its timeout stops before the image's Maven runs can`);
  }
  // A step with its own condition or its own timeout is counted at that timeout; one with neither
  // runs inside the time the sum leaves for the rest of the job.
  const own = steps.filter((step) => (step.if !== undefined || step["timeout-minutes"] !== undefined) && !builds.includes(step));
  assert.ok(own.some((step) => step.name === springTestStepName) && own.some((step) => step.id === "spring_proof"),
    "the parity job runs Spring's test and proof steps for Spring");
  const spent = own.reduce((sum, step) => sum + stepSeconds(step), 0) + builds.length * imageSeconds;
  const limit = stepSeconds(job);
  assert.ok(spent <= limit, `the parity job's ${limit / 60} minutes do not cover Spring's bounded steps and image builds (${spent} s)`);
  return limit - spent;
}

/**
 * The limit, in minutes, run-all.mjs gives an app's build.mjs call, which also runs the Docker
 * rebuild benchmark's measured builds when that app opts in (BENCH_DOCKER_REBUILD_APPS). Fails when
 * it would not cover one measured build.
 */
function rebuildParentMinutes(/** @type {ReturnType<typeof calls>} */ list, /** @type {string} */ app) {
  const builds = list.filter(([step, , script, , name]) => step === "build" && script === "build.mjs" && name === app);
  assert.equal(builds.length, 1, `${app}: an unattended round has no single build call`);
  assert.ok(rebuildTimeoutMs < builds[0][1] * 60_000, `${app}: its build call ends before one measured Docker rebuild can`);
  return builds[0][1];
}

/**
 * The deadline, in seconds, build.mjs gives each measured step (`docker start -a`), the only bound on
 * the build-cost recipe's Maven when build.mjs is run directly (an unattended round adds run-all.mjs's
 * call limit and idle cutoff): written once, passed on by the wrapper.
 * Fails when it is shorter than the image's Maven runs are allowed.
 */
function measuredStepSeconds(/** @type {string} */ source, /** @type {number} */ imageSeconds) {
  assert.equal(source.split("const hour = 3_600_000;").length, 2, "build.mjs's hour moved");
  assert.equal(source.split('spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 2 ** 20, timeout: options.timeout ?? hour, input: options.input });').length, 2,
    "build.mjs's docker wrapper does not pass on the timeout it is given");
  const starts = [...source.matchAll(/docker\(\["start", "-a", container\], \{ timeout: (\d+) \* (hour|60_000) \}\);/g)];
  assert.ok(starts.length === 1 && (source.match(/"start"/g) ?? []).length === 1, "build.mjs starts its measured steps other than in its one bounded call");
  const seconds = Number(starts[0][1]) * (starts[0][2] === "hour" ? 3600 : 60);
  assert.ok(imageSeconds <= seconds, "build.mjs's measured step stops before the image's Maven runs can");
  return seconds;
}

/**
 * Whether run-all.mjs stops an unattended build call at the limit `calls()` gives it: round.mjs's
 * buildStep passes each call's limit on unchanged, run-all.mjs's call hands it to round.mjs's
 * superviseCall in milliseconds with round.mjs's idleMinutes, and superviseCall compares the call's
 * time with the one and its quiet time with the other.
 */
function watchdogUses(/** @type {string} */ runAll, /** @type {string} */ round) {
  return runAll.split("const minute = 60_000;").length === 2 && runAll.split("const all = calls(").length === 2 &&
    runAll.split("await buildStep(all, built, { minutes: () => (Date.now() - stepStarted) / minute, call,").length === 2 &&
    runAll.split("const call = async (/** @type {number} */ limit, /** @type {string[]} */ args) =>").length === 2 &&
    runAll.split("const result = await superviseCall(child, {").length === 2 &&
    runAll.split("limitMs: unattended ? limit * minute : Infinity,").length === 2 &&
    runAll.split("idleMs: unattended ? idleMinutes * minute : Infinity,").length === 2 &&
    !/(?<![\w.])idleMinutes\s*(?:[-+*/%]|\?\?|\|\||&&)?=(?!=)/.test(runAll) &&
    !/(?<![\w.])limit\s*(?:[-+*/%]|\?\?|\|\||&&)?=(?!=)/.test(runAll) &&
    round.split("for (const [step, limit, ...args] of all) {").length === 2 &&
    (round.match(/built\.push\(app\);\r?\n\s*const result = await call\(limit, args\);/g) ?? []).length === 1 &&
    round.split("if (Date.now() - started > limitMs) stopped =").length === 2 &&
    round.split("else if (Date.now() - heard > idleMs) stopped =").length === 2 &&
    !/(?<![\w.])(?:limitMs|idleMs)\s*(?:[-+*/%]|\?\?|\|\||&&)?=(?!=)/.test(round);
}

/** The parity job's Spring test and proof steps. */
function springSteps(/** @type {string} */ workflowText) {
  const steps = parseYaml(workflowText).jobs.parity.steps;
  const testStep = steps.find((/** @type {{ name?: string }} */ step) => step.name === springTestStepName);
  const proofStep = steps.find((/** @type {{ id?: string }} */ step) => step.id === "spring_proof");
  assert.ok(testStep && proofStep, "the parity job has the Spring test and proof steps");
  return { testStep, proofStep };
}

test("Spring bounds each Maven run inside the image build or step that contains it", () => {
  const spring = join(repo, "bench/fullstack/apps/spring");
  const dockerfile = readFileSync(join(spring, "Dockerfile"), "utf8");
  const lines = instructionsOf(dockerfile);
  checkSpringInstall(lines);
  assert.throws(() => checkSpringInstall(lines.filter((line) => line !== "COPY .mvn ./.mvn")), /only the Spring dependency inputs/);
  assert.throws(() => checkSpringInstall(lines.map((line) => line.replace(" mvn -B dependency:go-offline", " mvn -B -q dependency:go-offline"))), /exact bounded Spring/);
  // Every Maven run in the image is bounded; the budget below is the sum of what the Dockerfile sets.
  const image = springMavenSeconds(dockerfile);

  const config = readFileSync(join(spring, ".mvn/maven.config"), "utf8").split("\n").filter(Boolean);
  checkSpringMaven(config, readFileSync(join(spring, ".mvn/settings.xml"), "utf8"));
  const request = springRequestWaitSeconds(config);
  assert.equal(request, 160, "one request waits at most 4 * 40 s, or 10 + 20 + 30 + 40 s without Retry-After");
  assert.equal(springRequestWaitSeconds(["-Daether.transport.http.retryHandler.count=6",
    "-Daether.transport.http.retryHandler.interval=10000", "-Daether.transport.http.retryHandler.intervalMax=300000"]), 1800);

  // The image build: each check-only runner gives an image an hour, and Maven takes at most half of it.
  for (const [runner, timeoutMs] of /** @type {[string, number][]} */ ([
    ["bench/catalog/run.mjs", catalogBuildTimeoutMs], ["bench/marketplace/run.mjs", marketplaceBuildTimeoutMs]])) {
    assert.ok(buildCallUses(readFileSync(join(repo, runner), "utf8")), `${runner}: its one image build is not bounded by imageBuildTimeoutMs`);
    assert.ok(image + 30 * 60 <= timeoutMs / 1000, `${runner}: Spring's bounded Maven runs leave under 30 minutes of its build`);
  }
  const catalogRunner = readFileSync(join(repo, "bench/catalog/run.mjs"), "utf8");
  for (const to of ["{ timeout: imageBuildTimeoutMs / 4, file:", "{ timeout: 60 * 60 * 1000 / 4, file:", "{ timeout: 60 * 60 * 1000, file:"]) {
    assert.ok(!buildCallUses(catalogRunner.replace("{ timeout: imageBuildTimeoutMs, file:", to)), `accepted ${to}`);
  }
  assert.ok(!buildCallUses(catalogRunner.replace('await docker(["build",', 'await docker(["build", "--quiet"]);\n        await docker(["build",')), "accepted a second build call");
  // The Docker rebuild benchmark stops each measured build at rebuildTimeoutMs (20 minutes); the
  // image's Maven runs take at most 18m20s of it, which leaves a nominal 1m40s for the rest.
  const rebuild = readFileSync(join(repo, "bench/fullstack/docker-rebuild.mjs"), "utf8");
  assert.ok(rebuildCallUses(rebuild), "docker-rebuild.mjs: its one measured build is not bounded by rebuildTimeoutMs");
  assert.ok(image < rebuildTimeoutMs / 1000, "Spring's bounded Maven runs outlast the Docker rebuild benchmark's build deadline");
  for (const to of ["...extra, context], 20 * minute);", "...extra, context], rebuildTimeoutMs / 4);"]) {
    assert.ok(!rebuildCallUses(rebuild.replace("...extra, context], rebuildTimeoutMs);", to)), `accepted ${to}`);
  }
  assert.ok(!rebuildCallUses(rebuild.replace('const r = run("docker", args, timeout);', 'const r = run("docker", args, Math.min(timeout, 15 * minute));')), "accepted a clamped launcher timeout");
  // An unattended round's build call for Spring (round.mjs, 90 minutes) covers one 20-minute measured
  // build when Spring opts into the rebuild; the call's other builds share that limit with it.
  const round = calls("r1", "1", ["spring"], ["http://spring"]);
  assert.equal(rebuildParentMinutes(round, "spring"), 90);
  const shortened = round.map((call) => call[0] === "build" ? /** @type {typeof call} */ ([call[0], 15, ...call.slice(2)]) : call);
  assert.throws(() => rebuildParentMinutes(shortened, "spring"), /ends before one measured Docker rebuild/);
  // run-all.mjs stops that call at the limit calls() gave it. The limit is the whole call's, which
  // every build it runs shares; this does not say they all fit in it.
  const runAll = readFileSync(join(repo, "bench/fullstack/run-all.mjs"), "utf8");
  const roundSource = readFileSync(join(repo, "bench/fullstack/round.mjs"), "utf8");
  assert.ok(watchdogUses(runAll, roundSource), "run-all.mjs does not stop a build call at the limit calls() gives it");
  assert.ok(!watchdogUses(runAll.replace("limitMs: unattended ? limit * minute", "limitMs: unattended ? Math.min(limit, 15) * minute"), roundSource), "accepted a clamped watchdog limit");
  assert.ok(!watchdogUses(runAll, roundSource.replace("started > limitMs", "started > Math.min(limitMs, 15 * 60_000)")), "accepted a clamped watchdog");
  assert.ok(!watchdogUses(runAll, roundSource.replace("await call(limit, args);", "await call(Math.min(limit, 15), args);")), "accepted a clamped build call limit");
  assert.ok(!watchdogUses(runAll.replace("idleMs: unattended ? idleMinutes * minute", "idleMs: unattended ? 15 * minute"), roundSource), "accepted a shorter idle cutoff");
  assert.ok(!watchdogUses(runAll, roundSource.replace("heard > idleMs", "heard > Math.min(idleMs, 15 * 60_000)")), "accepted a clamped idle watchdog");
  // The watchdog also stops a call that prints nothing for idleMinutes, and build.mjs prints a measured
  // step's output only when it returns, so a silent build-cost step is stopped then, before its two-hour
  // deadline; that cutoff is still longer than the image's Maven runs are allowed.
  assert.ok(idleMinutes * 60 > image, "run-all.mjs's idle cutoff stops a quiet build before the image's Maven runs can end");
  // The build-cost recipe runs quiet Maven with no bound of its own, so when build.mjs is run directly
  // only its two-hour deadline on each measured step stops it; that is longer than the image's Maven
  // runs are allowed.
  const buildCost = readFileSync(join(repo, "bench/fullstack/build.mjs"), "utf8");
  assert.equal(measuredStepSeconds(buildCost, image), 2 * 3600);
  assert.throws(() => measuredStepSeconds(buildCost.replace("{ timeout: 2 * hour }", "{ timeout: 15 * 60_000 }"), image), /stops before the image's Maven runs can/);
  assert.throws(() => measuredStepSeconds(buildCost.replace("timeout: options.timeout ?? hour,", "timeout: Math.min(options.timeout ?? hour, 15 * 60_000),"), image), /does not pass on/);
  assert.ok(!buildCallUses(catalogRunner.replace('await docker(["build",', 'await docker(["image", "build", "."], { timeout: 15 * 60 * 1000 });\n        await docker(["build",')), "accepted a docker image build call");
  assert.ok(!buildCallUses(catalogRunner.replace('const docker = (args, opts) => command("docker", args, opts);', 'const docker = (args, opts) => command("docker", args, { ...opts, timeout: 15 * 60 * 1000 });')), "accepted a clamped docker wrapper");
  // Both runners' command comes from the shared launcher, which keeps the timeout it was given.
  const launcher = readFileSync(join(repo, "bench/catalog/output.mjs"), "utf8");
  assert.ok(launcherForwards(launcher), "bench/catalog/output.mjs: its command does not stop at the caller's timeout as given");
  const signature = /async function command\(binary, args, \{ timeout = \d+, [^\n]*\{\n/.exec(launcher)?.[0] ?? "";
  assert.ok(signature, "the launcher's command signature moved");
  for (const clamped of [
    launcher.replace('setTimeout(() => stop("deadline"), timeout);', 'setTimeout(() => stop("deadline"), Math.min(timeout, 15 * 60_000));'),
    launcher.replace(signature, `${signature}    timeout = Math.min(timeout, 15 * 60_000);\n`),
    launcher.replace(signature, `${signature}    timeout ??= 15 * 60_000;\n`),
    launcher.replace('timer = setTimeout(() => stop("deadline"), timeout);', 'timer = setTimeout(() => stop("deadline"), timeout);\n    setTimeout(() => stop("deadline"), 15 * 60_000);'),
  ]) assert.ok(!launcherForwards(clamped), "accepted a clamped launcher timeout or a second deadline");
  // Mixed Production, the hardening evidence check and JSON API build the default image under their
  // own deadlines. Mixed Production must also cover the WebFlux override under the same deadline.
  for (const build of otherSpringBuilds) {
    const source = readFileSync(join(repo, build.runner), "utf8");
    assert.ok(buildDeadlineIs(source, build), `${build.runner}: its image build deadline moved, is not passed on, or it builds another image`);
    assert.ok(image < build.seconds, `${build.runner}: Spring's bounded Maven runs outlast its build deadline`);
    assert.ok(!buildDeadlineIs(source.replace(build.call, build.call.replace(...build.shorter)), build), `${build.runner}: accepted a shorter deadline`);
    assert.ok(!buildDeadlineIs(`${source}\nawait docker(["image", "build", "."]);`, build), `${build.runner}: accepted a second build`);
    if (build.forward) assert.ok(!buildDeadlineIs(source.replace(build.forward, build.forward.replace("opts", "{ ...opts, timeout: 15 * 60 * 1000 }").replace("${limit * 60} bash", "900 bash")), build), `${build.runner}: accepted a clamped deadline`);
    if (build.runner === "bench/mixed-production/run.mjs") {
      assert.equal(source.split("const deployment = nativeDeployment(options, app);").length, 2, "Mixed Production must select the native deployment for each app");
      assert.ok(!buildDeadlineIs(source.replace("deployment?.dockerfile ?? context.dockerfile", "context.dockerfile"), build), "accepted a build that ignores the native Dockerfile override");
      const override = nativeDeployment({ springDeployment: "spring-webflux" }, "spring")?.dockerfile;
      assert.equal(override, "Dockerfile.mixed", "Mixed Production's Spring WebFlux deployment must select its own Dockerfile");
      const mixedDockerfile = readFileSync(join(spring, override), "utf8");
      const mixedLines = instructionsOf(mixedDockerfile);
      const mixedInputs = springInstallInputs.with(1, "COPY mixed/pom.xml ./pom.xml");
      checkSpringInstall(mixedLines, mixedInputs);
      assert.throws(() => checkSpringInstall(mixedLines.filter((line) => line !== "COPY .mvn ./.mvn"), mixedInputs), /only the Spring dependency inputs/);
      assert.ok(springMavenSeconds(mixedDockerfile) < build.seconds, "Spring WebFlux's bounded Maven runs outlast the Mixed Production build deadline");
    }
  }

  const { testStep, proofStep } = springSteps(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  // The native test step builds the test stage (both of the image's Maven runs) and runs the tests,
  // so their bounds stop before the step's own, with a minute left for pulling images.
  assert.ok(springTestStepSeconds(testStep, image) + 60 <= stepSeconds(testStep), "the native test step outlasts its build's and tests' Maven bounds");

  // The parity job's 95 minutes cover Spring's test (30) and proof (12) steps and both shared runners'
  // builds at the image's Maven runs (18m20s each): 1h18m40s, which leaves 16m20s for checkout,
  // npm ci, the fixtures, the image builds outside Maven and the checks, which the sum does not reserve.
  const workflowText = readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8").replace(/\r/g, "");
  assert.equal(springParity(workflowText, image), 16 * 60 + 20);
  assert.ok(workflowText.includes("\n    timeout-minutes: 95\n"), "the parity job's timeout moved");
  assert.throws(() => springParity(workflowText.replace("\n    timeout-minutes: 95\n", "\n    timeout-minutes: 75\n"), image), /do not cover Spring's/);
  const proofLimit = "        timeout-minutes: 12\n";
  assert.ok(workflowText.includes(proofLimit), "the proof step's timeout moved");
  assert.throws(() => springParity(workflowText.replace(proofLimit, "        timeout-minutes: 30\n"), image), /do not cover Spring's/);
  assert.throws(() => springParity(workflowText.replace(proofLimit, ""), image), /not a positive integer/);
  // A step counts only when its condition runs it for Spring; a build step's own timeout covers its Maven.
  const catalogBuild = "      - name: Build and verify both catalog sources\n        run:";
  const springTestIf = `      - name: ${springTestStepName}\n        if: matrix.app == 'spring'\n`;
  const proofIf = "        id: spring_proof\n        if: matrix.app == 'spring'\n";
  const parityCheckout = "    steps:\n      - uses: actions/checkout@v7\n      - uses: actions/setup-node@v7\n        with:\n          node-version-file: .node-version\n      - run: npm ci --no-audit --no-fund\n      - run: node bench/catalog/fixtures.mjs\n";
  const routerIf = "        if: always() && matrix.app == 'react-router' && (steps.marketplace.outcome == 'success' || steps.marketplace.outcome == 'failure')\n";
  assert.ok(workflowText.split(parityCheckout).length === 2 && workflowText.includes(routerIf), "the parity job's checkout or the React Router probe's condition moved");
  assert.ok(workflowText.includes(catalogBuild) && workflowText.includes(springTestIf) && workflowText.includes(proofIf), "the Catalog build, Spring test or proof step moved");
  // Actions ignores case, so these still run the proof for spring and leave the sum as it is.
  for (const to of ["        id: spring_proof\n        if: matrix.app == 'Spring'\n", "        id: spring_proof\n        if: contains(fromJSON('[\"SPRING\"]'), matrix.app)\n"]) {
    assert.equal(springParity(workflowText.replace(proofIf, to), image), 16 * 60 + 20, `refused ${to.trim()}`);
  }
  for (const [from, to, refusal] of /** @type {[string, string, RegExp][]} */ ([
    [catalogBuild, catalogBuild.replace("\n        run:", "\n        if: matrix.app == 'gin'\n        run:"), /once in each shared runner/],
    [springTestIf, springTestIf.replace("==", "!="), /runs Spring's test and proof steps/],
    [proofIf, proofIf.replace("== 'spring'", "!= 'Spring'"), /runs Spring's test and proof steps/],
    [proofIf, proofIf.replace("matrix.app == 'spring'", "contains(fromJSON('[\"gin\"]'), matrix.app)"), /runs Spring's test and proof steps/],
    [catalogBuild, catalogBuild.replace("\n        run:", "\n        timeout-minutes: 15\n        run:"), /stops before the image's Maven runs can/],
    [catalogBuild, catalogBuild.replace("\n        run:", "\n        if: matrix.app == 'spring' || matrix.app == 'gin'\n        run:"), /cannot tell whether/],
    [catalogBuild, catalogBuild.replace("\n        run:", "\n        if: matrix.app == 'gin' && always() || matrix.app == 'spring'\n        run:"), /cannot tell whether/],
    [parityCheckout, parityCheckout.replace("@v7\n", "@v7\n        timeout-minutes: 20\n"), /do not cover Spring's/],
    [routerIf, routerIf.replace("&& (steps.marketplace.outcome == 'success' || steps.marketplace.outcome == 'failure')", "&& )steps.marketplace.outcome == 'success' || steps.marketplace.outcome == 'failure'("), /cannot tell whether/],
    [springTestIf, `      - name: Extra\n        timeout-minutes: 20\n        run: "true"\n${springTestIf}`, /do not cover Spring's/],
  ])) assert.throws(() => springParity(workflowText.replace(from, to), image), refusal, `accepted ${to}`);

  // The transport proof: two Maven runs, each with its own bound, and two minutes to report, inside the step.
  checkSpringProofStep(proofStep);
  const proof = springProof(readFileSync(join(spring, "transport-proof/run.sh"), "utf8"));
  assert.ok(request < proof.bound, "one throttled request fits a proof run");
  assert.ok(proof.runs * proof.seconds + 2 * 60 <= stepSeconds(proofStep), "both proof runs and two minutes to report fit the step");

  // Both steps name the same Maven volume.
  const volume = "type=volume,source=cb-spring-m2,target=/root/.m2";
  assert.ok(testStep.run.includes(`--mount ${volume}`) && proofStep.run.includes(`--mount ${volume}`));
});

test("Spring's Maven bound checks refuse a zero, an unbounded or extra run, a bound in a comment and a reassigned bound", () => {
  const spring = join(repo, "bench/fullstack/apps/spring");
  const dockerfile = readFileSync(join(spring, "Dockerfile"), "utf8").replace(/\r/g, "");
  const pkg = "RUN timeout --verbose --kill-after=10s 3m mvn -B package -DskipTests";
  const offline = "RUN timeout --verbose --kill-after=10s 15m mvn -B dependency:go-offline";
  springMavenRuns(dockerfile);
  for (const [from, to, refusal] of /** @type {[string, string, RegExp][]} */ ([
    ["15m mvn -B dependency:go-offline", "0m mvn -B dependency:go-offline", /not positive/],
    ["--kill-after=10s 3m", "--kill-after=0s 3m", /not positive/],
    [pkg, `${pkg} && mvn -q -B package -DskipTests`, /outside one exact positive bound/],
    [pkg, `${pkg}; mvn -q -B package -DskipTests`, /outside one exact positive bound/],
    [pkg, "RUN mvn -q -B package -DskipTests", /outside one exact positive bound/],
    [offline, `# ${offline}\nRUN mvn -B dependency:go-offline`, /outside one exact positive bound/],
    [pkg, `${pkg}\n${pkg}`, /one for one/],
    [`${pkg}\n`, "", /one for one/],
    [pkg, "RUN timeout --verbose --kill-after=10s 3m mvn -B -o package -DskipTests", /one for one/],
    [pkg, `${pkg}\nrun mvn -B help:active-profiles`, /outside one exact positive bound/],
    [pkg, `${pkg}\nrun timeout --verbose --kill-after=10s 3m mvn -B help:active-profiles`, /one for one/],
    [pkg, `${pkg}\nRUN timeout --verbose --kill-after=10s 3m "mvn" -B help:active-profiles`, /outside one exact positive bound/],
  ])) {
    assert.ok(dockerfile.includes(from), `Spring's Dockerfile no longer has ${from}`);
    assert.throws(() => springMavenRuns(dockerfile.replace(from, to)), refusal, `accepted ${to}`);
  }

  const workflow = readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8").replace(/\r/g, "");
  const image = springMavenSeconds(dockerfile);
  const tests = "            cb-spring-tests timeout --verbose --kill-after=10s 10m mvn -B test\n";
  springTestStepSeconds(springSteps(workflow).testStep, image);
  for (const [to, refusal] of /** @type {[string, RegExp][]} */ ([
    [`            cb-spring-tests mvn -B test\n          # ${tests.trim()}\n`, /outside one exact positive bound/],
    ["            cb-spring-tests timeout --verbose --kill-after=10s 0 mvn -B test\n", /not positive/],
    ["            cb-spring-tests timeout --verbose --kill-after=0s 10m mvn -B test\n", /not positive/],
    ["            cb-spring-tests timeout --verbose --kill-after=10s 10m mvn -B test # timeout 1m\n", /outside one exact positive bound/],
    [`${tests}          docker run --rm cb-spring-tests mvn -B test\n`, /more than its one bounded command/],
    [`${tests}          docker run --rm cb-spring-tests "mvn" -B help:active-profiles\n`, /more than its one bounded command/],
    [`${tests}          docker image build --target build -t cb-spring-tests bench/fullstack/apps/spring\n`, /only its test-stage build, then its bounded tests/],
    [`${tests}          echo built\n`, /only its test-stage build, then its bounded tests/],
  ])) {
    assert.ok(workflow.includes(tests), "the native Spring test command moved");
    assert.throws(() => springTestStepSeconds(springSteps(workflow.replace(tests, to)).testStep, image), refusal, `accepted ${to}`);
  }
  // A space after the backslash ends the command there in the shell, so the image is a separate command.
  const joined = `target=/root/.m2 \\\n${tests}`;
  assert.ok(workflow.includes(joined), "the native Spring test command's continuation moved");
  assert.throws(() => springTestStepSeconds(springSteps(workflow.replace(joined, `target=/root/.m2 \\ \n${tests}`)).testStep, image), /outside one exact positive bound|only its test-stage build, then its bounded tests/);
  const proofExec = "                exec sh /proof/run.sh /src /evidence\n";
  checkSpringProofStep(springSteps(workflow).proofStep);
  assert.ok(workflow.includes(proofExec), "the proof step's script call moved");
  for (const extra of ["mvn -B verify", "\"mvn\" -B verify"]) {
    assert.throws(() => checkSpringProofStep(springSteps(workflow.replace(proofExec, `                ${extra}\n${proofExec}`)).proofStep),
      /outside the proof script/, `accepted ${extra}`);
  }
  assert.ok(workflow.includes("\n          docker run --rm --cpus 2 --memory 2g \\\n            --mount \"type=bind,source=$PWD/bench/fullstack/apps/spring/transport-proof"), "the proof step's launch moved");
  assert.throws(() => checkSpringProofStep(springSteps(workflow.replace("\n          docker run --rm --cpus 2 --memory 2g \\\n            --mount \"type=bind,source=$PWD/bench/fullstack/apps/spring/transport-proof", "\n          timeout --kill-after=10s 4m docker run --rm --cpus 2 --memory 2g \\\n            --mount \"type=bind,source=$PWD/bench/fullstack/apps/spring/transport-proof")).proofStep),
    /outside the proof script's own limits/, "accepted an outer timeout on the proof");
  assert.throws(() => checkSpringProofStep(springSteps(workflow.replace(proofExec, `                docker build --target build -t cb-spring-tests bench/fullstack/apps/spring\n${proofExec}`)).proofStep),
    /builds an image/, "accepted an image build in the proof step");
  for (const extra of ["sh /proof/run.sh /src /evidence-2", "\"sh\" \"/proof/run.sh\" /src /evidence-2"]) {
    assert.throws(() => checkSpringProofStep(springSteps(workflow.replace(proofExec, `                ${extra}\n${proofExec}`)).proofStep),
      /exactly once/, `accepted ${extra}`);
  }

  const script = readFileSync(join(spring, "transport-proof/run.sh"), "utf8").replace(/\r/g, "");
  const proofMaven = '    timeout --verbose --kill-after=10s "$maven_seconds" mvn -B -f "$project/pom.xml" "-Dtest=$suite" -DfailIfNoTests=true test "$@" || status=1\n';
  const assignment = "maven_seconds=270\n";
  const probe = `${springProofProbes[0]}\n`;
  assert.deepEqual(springProof(script), { runs: 2, bound: 270, seconds: 280 });
  for (const [from, to, refusal] of /** @type {[string, string, RegExp][]} */ ([
    [assignment, "maven_seconds=0\n", /not positive/],
    [proofMaven, proofMaven.replace("--kill-after=10s", "--kill-after=0s"), /not positive/],
    [assignment, `${assignment}maven_seconds=5000\n`, /sets maven_seconds once/],
    [assignment, `${assignment}${assignment}`, /sets maven_seconds once/],
    [assignment, `${assignment}export maven_seconds=5000\n`, /sets maven_seconds once/],
    [proofMaven, `    maven_seconds=5000\n${proofMaven}`, /sets maven_seconds once/],
    [assignment, "maven_seconds=$((270 * 20))\n", /other than to a number/],
    [proofMaven, `    # ${proofMaven.trim()}\n    mvn -B -f "$project/pom.xml" "-Dtest=$suite" -DfailIfNoTests=true test "$@" || status=1\n`, /outside its exact positive bound/],
    [proofMaven, `    # ${proofMaven.trim()}\n    mvn \\\n      -B -f "$project/pom.xml" "-Dtest=$suite" -DfailIfNoTests=true test "$@" || status=1\n`, /outside its exact positive bound/],
    [proofMaven, proofMaven.replace("|| status=1", "|| status=1 # 270 s"), /outside its exact positive bound/],
    [proofMaven, `${proofMaven}    mvn -B -f "$project/pom.xml" dependency:tree\n`, /more than its one bounded command/],
    [proofMaven, `${proofMaven}    "mvn" -B -f "$project/pom.xml" dependency:tree\n`, /more than its one bounded command/],
    [probe, `${probe.trimEnd()} || run_probe webflux WebFluxDisconnectHttpTest || result=1\n`, /only in its definition and its two probes/],
    [probe, `${probe}run_probe webflux WebFluxDisconnectHttpTest || result=1\n`, /only in its definition and its two probes/],
    ['cp -R "$app/.mvn" "$work/mvc/"\n', "", /copies \.mvn into its mvc project/],
    ['cp -R "$app/.mvn" "$work/webflux/"\n', "", /copies \.mvn into its webflux project/],
  ])) {
    assert.ok(script.includes(from), `the proof no longer has ${from.trim()}`);
    assert.throws(() => springProof(script.replace(from, to)), refusal, `accepted ${to.trim()}`);
  }
});

test("Spring reaches Central only through Google's mirror, and fails a checksum mismatch", () => {
  const spring = join(repo, "bench/fullstack/apps/spring");
  const config = readFileSync(join(spring, ".mvn/maven.config"), "utf8").replace(/\r\n/g, "\n");
  const settings = readFileSync(join(spring, ".mvn/settings.xml"), "utf8").replace(/\r\n/g, "\n");
  const lines = (/** @type {string} */ text) => text.split("\n").filter(Boolean);
  checkSpringMaven(lines(config), settings);
  const mirror = settings.slice(settings.indexOf("    <mirror>"), settings.indexOf("</mirror>\n") + "</mirror>\n".length);
  assert.ok(mirror.startsWith("    <mirror>") && mirror.endsWith("</mirror>\n"), "Spring's mirror moved");
  for (const [from, to] of /** @type {[string, string][]} */ ([
    [mirror, ""],
    ["<mirrorOf>central</mirrorOf>", "<mirrorOf>*</mirrorOf>"],
    ["<mirrorOf>central</mirrorOf>", "<mirrorOf>central,*</mirrorOf>"],
    ["<mirrorOf>central</mirrorOf>", "<mirrorOf>google</mirrorOf>"],
    ["<id>google-maven-central</id>", "<id>central</id>"],
    ["https://maven-central.storage-download.googleapis.com/maven2/", "https://repo.maven.apache.org/maven2/"],
    ["https://maven-central.storage-download.googleapis.com/maven2/", "http://maven-central.storage-download.googleapis.com/maven2/"],
    [mirror, `${mirror}${mirror.replace("google-maven-central", "second").replace(">central<", ">*<")}`],
    [mirror, `<!-- ${mirror} -->`],
    ["</mirrors>", "</mirrors>\n  <profiles><profile><id>more</id><repositories><repository><id>more</id><url>https://example.com/maven2/</url></repository></repositories></profile></profiles>"],
    ["</mirrors>", "</mirrors>\n  <proxies><proxy><host>proxy.example.com</host></proxy></proxies>"],
    ["<name>Google's mirror of Maven Central</name>", "<name><![CDATA[<!--]]></name><blocked>true</blocked><!-- end -->"],
    ["<mirror>", "<mirror >"],
    ["<mirrorOf>central</mirrorOf>", "<mirrorOf>central</mirrorOf>\n      <s:blocked xmlns:s=\"http://maven.apache.org/SETTINGS/1.2.0\">true</s:blocked>"],
    ["<mirrors>", "<mirrors>\n    <!-- <mirror> -->"],
    ["<mirrorOf>central</mirrorOf>", "<mirrorOf>central</mirrorOf>\n      <blocked>true</blocked>"],
    ["<mirrorOf>central</mirrorOf>", "<mirrorOf>central</mirrorOf>\n      <mirrorOfLayouts>!default</mirrorOfLayouts>"],
    ["<mirrorOf>central</mirrorOf>", "<mirrorOf>central</mirrorOf>\n      <layout>legacy</layout>"],
    ["<mirrorOf>central</mirrorOf>", "<mirrorOf>cent\rral</mirrorOf>"],
    ["  <mirrors>\n", "  <mirrors>\r"],
    ["<!--\n", "<!--\u0000\n"],
    ["\n-->\n", "\n--->\n"],
    ["\n-->\n", "\n -->\n<!-- x -->\n"],
  ])) {
    assert.ok(settings.includes(from), `Spring's Maven settings no longer have ${from.trim()}`);
    assert.throws(() => checkSpringMaven(lines(config), settings.replace(from, to)), /through Google's mirror alone|declaration and one plain comment/, `accepted ${to.trim()}`);
  }
  for (const [from, to] of /** @type {[string, string][]} */ ([
    ["--strict-checksums\n", ""],
    ["--strict-checksums\n", "--lax-checksums\n"],
    ["--strict-checksums\n", "--strict-checksums\n--lax-checksums\n"],
    [`${springSettings}\n`, ""],
    [`${springSettings}\n`, "--settings=.mvn/settings.xml\n"],
    [`${springSettings}\n`, `${springSettings}\n--global-settings=${"${session.rootDirectory}"}/.mvn/global.xml\n`],
    ["-Daether.transport.http.retryHandler.count=4\n", ""],
  ])) {
    assert.ok(config.includes(from), `Spring's maven.config no longer has ${from.trim()}`);
    assert.throws(() => checkSpringMaven(lines(config.replace(from, to)), settings), /maven\.config changed/, `accepted ${to.trim() || "no line"}`);
  }
});

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

// card-market's image builds locked (scripts/images.test.mjs), so its recipe downloads and builds
// locked too: an unlocked download could repair the lock before the build would refuse it (#1584).
// The equality test below leaves the download out, since it is this benchmark's own step.
test("card-market's recipe fetches and builds locked, as its image does", () => {
  const named = Object.keys(recipes).filter((name) => dockerfileOf(name) === "examples/card-market/Dockerfile");
  assert.equal(named.length, 1, "one recipe builds card-market's image");
  const recipe = recipes[named[0]];
  assert.equal(typeof recipe.deps, "string");
  assert.match(String(recipe.deps), /^cargo fetch --locked /);
  assert.equal(recipe.build, "cargo build --release --locked -p card-market");
});

/**
 * Asserts that a recipe's commands are its Dockerfile's, past packaging and the image-only wrappers.
 * @param {string} name
 * @param {(typeof recipes)[string]} r
 * @param {string} [dockerfile] the Dockerfile, when not the app's own
 */
function assertRecipeRuns(name, r, dockerfile = readFileSync(join(repo, dockerfileOf(name)), "utf8")) {
  const stages = stagesOf(name, dockerfile);
  // Spring's Maven commands are the recipe's one for one, each under its own bound (#1763).
  if (name === "spring") springMavenRuns(dockerfile);
  // Packaging after the build (copying the output aside) and the shared cache's touch, which this
  // benchmark has no use for; every other command of the deps and build stages is the recipe's.
  const packaging = [/^mkdir -p \/out$/, /^cp (-r )?\S+ \/out\/\S+$/, /^chmod 644 /, /^find \. -name target -prune -o -type f -exec touch \{\} \+$/];
  const mine = [...parts(r.deps), ...(r.build ? parts(r.build) : [])];
  for (const stage of stages.filter((s) => s.run.some((c) => mine.some((m) => recipeCommandOf(name, c).includes(m))))) {
    const commands = stage.run.flatMap((c) => c.split(" && ").map((x) => x.trim()));
    for (const [index, command] of commands.entries()) {
      const recipeCommand = recipeCommandOf(name, command);
      assert.ok(mine.includes(recipeCommand) || packaging.some((p) => p.test(command)) || postBuildPrune(commands, index, r.build), `${name}: its Dockerfile runs ${command}, which its recipe does not`);
    }
    if (r.stage) assert.equal(stage.from, "tools", `${name}: its build stage starts from its tools stage`);
  }
  const run = stages.flatMap((s) => s.run).map((c) => recipeCommandOf(name, c)).join(" && ");
  for (const part of mine) assert.ok(run.includes(part), `${name}: its Dockerfile does not run ${part}`);
}

test("Spring's image runs its recipe's Maven goals and arguments, past only the bound and -q", () => {
  const text = readFileSync(join(repo, dockerfileOf("spring")), "utf8").replace(/\r/g, "");
  assertRecipeRuns("spring", recipes.spring, text);
  const pkg = "RUN timeout --verbose --kill-after=10s 3m mvn -B package -DskipTests";
  for (const [from, to, refusal] of /** @type {[string, string, RegExp][]} */ ([
    ["mvn -B dependency:go-offline", "mvn -B dependency:resolve -DexcludeTransitive=true", /its Dockerfile (runs|does not run)/],
    ["mvn -B dependency:go-offline", "mvn -B dependency:go-offline -DexcludeTransitive=true", /its Dockerfile (runs|does not run)/],
    ["mvn -B package -DskipTests", "mvn -B package", /its Dockerfile (runs|does not run)/],
    ["mvn -B package -DskipTests", "mvn -B -o package -DskipTests", /its Dockerfile (runs|does not run)/],
    ["timeout --verbose --kill-after=10s 15m mvn -B", "timeout 15m mvn -B", /its Dockerfile (runs|does not run)/],
    ["15m mvn -B", "0m mvn -B", /not positive/],
    ["--kill-after=10s 3m", "--kill-after=0s 3m", /not positive/],
    [pkg, `${pkg} && mvn -q -B package -DskipTests`, /its Dockerfile runs Maven outside one exact positive bound/],
    [pkg, `${pkg}\n${pkg}`, /its Dockerfile runs Maven commands other than its recipe's/],
    [`${pkg}\n`, "", /its Dockerfile runs Maven commands other than its recipe's/],
  ])) {
    assert.ok(text.includes(from), `Spring's Dockerfile no longer runs ${from}`);
    assert.throws(() => assertRecipeRuns("spring", recipes.spring, text.replace(from, to)), refusal, `accepted ${to}`);
  }
});

test("each recipe runs its Dockerfile's commands, from its image, in its directory", () => {
  for (const [name, r] of Object.entries(recipes)) {
    const stages = stagesOf(name);
    assertRecipeRuns(name, r);
    // An app with no build step: its Dockerfile runs nothing after the dependency step, and what
    // that stage sets and fetches is checked as a build stage's is.
    const last = parts(r.build ?? r.deps)[0];
    const build = stages.find((s) => s.run.some((c) => recipeCommandOf(name, c).includes(last)));
    if (!r.build) assert.ok(build && recipeCommandOf(name, build.run.at(-1) ?? "").includes(parts(r.deps).at(-1) ?? ""), `${name}: it has no build, but its Dockerfile runs something after its dependencies`);
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
