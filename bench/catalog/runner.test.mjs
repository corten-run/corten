import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { allApps } from "../fullstack/apps.mjs";
import { buildPlan as jsonBuildPlan, descriptor as jsonDescriptor, appArgs as jsonAppArgs, cpuSettings as jsonCpuSettings } from "../json-api/contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
test("catalog Corten uses supported lean settings, not the production timeout/compression profile", () => {
  const manifest = readFileSync(join(here, "corten/Cargo.toml"), "utf8");
  const application = readFileSync(join(here, "corten/src/main.rs"), "utf8");
  const dependency = manifest.split("\n").find((line) => line.startsWith("corten = "));
  assert.match(dependency, /features = \["json"\]/);
  assert.doesNotMatch(dependency, /"compress"/);
  for (const setting of ["deadline", "header_timeout", "send_timeout"]) {
    assert.ok(application.includes(`.${setting}(None)`), `catalog keeps no optional ${setting} timer`);
  }
  assert.ok(application.includes('let lean = std::env::var("PROFILE").as_deref() == Ok("catalog-lean");'));
  assert.ok(application.includes("if lean {"));
  assert.ok(application.includes("} else {\n        app\n    }"));
  assert.ok(application.includes("corten::serve(app(source, lean))"));
  assert.ok(application.includes("req.page(views::document"));
  assert.doesNotMatch(application, /\bunstaged\b/, "catalog remains a working page, not sandboxed data");
});

test("the shared Corten catalog build preserves framework-default JSON settings", () => {
  const plan = jsonBuildPlan("corten", "catalog-v1");
  assert.equal(plan.dockerfile, "bench/catalog/corten/Dockerfile");
  assert.equal(jsonDescriptor().nativeProfile, "framework-default");
  const args = jsonAppArgs({ name: "offline-app", profile: { payload: "catalog-v1", source: "fixture" }, imageId: "offline-image",
    network: "offline-net", upstream: "http://offline-upstream:8080", fixtures: "/fixtures", cpus: jsonCpuSettings({}) });
  assert.ok(args.includes("PROFILE="));
  const manifest = readFileSync(join(here, "corten/Cargo.toml"), "utf8");
  assert.match(manifest, /default = \["compression"\]/);
  assert.match(manifest, /compression = \["corten\/compress"\]/);
  const dockerfile = readFileSync(join(repo, plan.dockerfile), "utf8");
  assert.match(dockerfile, /ARG CATALOG_LEAN=0/);
  assert.ok(dockerfile.includes('1) set -- --no-default-features ;; 0) set -- ;; *) exit 1'));
  const runner = readFileSync(join(here, "run.mjs"), "utf8");
  assert.ok(runner.includes('app === "corten" ? ["--build-arg", "CATALOG_LEAN=1"] : []'));
  assert.ok(!readFileSync(join(repo, "bench/json-api/run.mjs"), "utf8").includes("CATALOG_LEAN=1"));
});

test("catalog checks include failure reporting regressions and native umask coverage is Gin-only parity work", () => {
  const workflow = parse(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  const script = "node --test bench/catalog/gin-permissions.test.mjs";
  const steps = workflow.jobs.parity.steps.filter((step) => step.run === script);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].if, "matrix.app == 'gin'");
  assert.equal(steps[0].env.CATALOG_GIN_DOCKER_TESTS, "1");
  assert.ok(workflow.jobs.harness.steps.every((step) => !step.run?.includes("gin-permissions.test.mjs")));
  const check = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts["check:catalog"];
  for (const file of ["check-result.test.mjs", "runner-failure.test.mjs"]) assert.ok(check.split(" ").includes(`bench/catalog/${file}`));
});

// Chromium and its libraries come from Playwright's image, not from the runner's apt mirror (#2011):
// every browser check runs through the image's command, set up before it in the same job, and the
// image step is what forwards the opt-ins and the Docker boundary those checks need.
const imageTag = "mcr.microsoft.com/playwright:v$(node -p 'require(\"@playwright/test/package.json\").version')-noble";
const imageBase = ["docker", "run", "--rm", "--network", "host", "--ipc", "host", "--user", "$(id -u):$(id -g)",
  "-e", "HOME=/tmp", "-v", "$PWD:$PWD", "-w", "$PWD"];
const dockerBoundary = ["--group-add", "$(stat -c %g /var/run/docker.sock)", "-v", "/tmp:/tmp",
  "-v", "$(command -v docker):/usr/local/bin/docker:ro", "-v", "/var/run/docker.sock:/var/run/docker.sock"];
const forward = (...names) => names.flatMap((name) => ["-e", name]);
// The complete argument list of each command a job's image step exports.
const expectedCommands = {
  harness: {
    PLAYWRIGHT: [...imageBase, "$image"],
    PLAYWRIGHT_WITH_DOCKER: [...imageBase, ...dockerBoundary, ...forward("CATALOG_DOCKER_TESTS", "RUNNER_ENVIRONMENT"), "$image"],
  },
  parity: {
    PLAYWRIGHT_WITH_DOCKER: [...imageBase, ...dockerBoundary, ...forward("RUNNER_ENVIRONMENT"), "$image"],
    PLAYWRIGHT_IMAGE: ["$image"],
  },
};
// The image's Node is a bounded, best-effort diagnostic: a failed, empty or stalled probe says so
// and leaves the step, and the browser checks after it, to run.
const nodeProbe = [
  "status=0",
  'image_node=$(timeout -k 5 60 docker run --rm "$image" node --version) || status=$?',
  'if [ "$status" != 0 ] || [ -z "$image_node" ]; then',
  "echo \"::warning::Could not read the Node version in $image (docker run exit $status, 124 is a timeout); the browser checks' Node is not recorded.\"",
  "image_node=unavailable",
  "fi",
  'echo "Node on the runner $(node --version), in $image $image_node"',
];

// The commands a "Playwright's image" step exports, with $run expanded, as argument lists.
function imageCommands(run) {
  const lines = run.split("\n").map((line) => line.trim());
  const image = lines.find((line) => line.startsWith("image="));
  assert.equal(image, `image="${imageTag}"`);
  const base = lines.find((line) => line.startsWith("run="));
  assert.ok(base, "the image step defines its docker run command");
  const prefix = base.slice('run="'.length, -1);
  const commands = {};
  for (const line of lines) {
    const exported = /^echo "([A-Z_]+)=(.*)" >> "\$GITHUB_ENV"$/.exec(line);
    if (exported) commands[exported[1]] = words(exported[2].replace(/^\$run /, `${prefix} `));
  }
  return commands;
}

// The Node version probe: the lines between the pull and the run command.
function probeLines(run) {
  const lines = run.split("\n").map((line) => line.trim());
  const pull = lines.indexOf('docker pull "$image"');
  const base = lines.findIndex((line) => line.startsWith("run="));
  assert.ok(pull >= 0 && base > pull, "the image step pulls before defining its command");
  return lines.slice(pull + 1, base);
}

// Space-separated words, keeping a $(...) substitution whole.
function words(command) {
  const out = [""];
  let depth = 0;
  for (let at = 0; at < command.length; at++) {
    const char = command[at];
    if (char === "(" && command[at - 1] === "$") depth++;
    else if (char === ")" && depth > 0) depth--;
    if (char === " " && depth === 0) out.push("");
    else out[out.length - 1] += char;
  }
  return out.filter(Boolean);
}

test("catalog CI takes Chromium from Playwright's image, not the runner's apt mirror", () => {
  const workflow = parse(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(job.steps.every((step) => !/playwright install/.test(step.run ?? "")), name);
  }
  // A failing browser check fails its job: neither job that runs one may continue on error.
  for (const job of ["harness", "parity"]) {
    assert.equal(workflow.jobs[job]["continue-on-error"], undefined, `${job} continues on error`);
  }
  const imageStep = (job) => {
    const steps = workflow.jobs[job].steps;
    const at = steps.findIndex((step) => step.name === "Playwright's image");
    assert.ok(at >= 0, job);
    assert.equal(steps.filter((step) => step.name === "Playwright's image").length, 1, job);
    assert.deepEqual(probeLines(steps[at].run), nodeProbe, `${job}: bounded best-effort Node probe`);
    return { at, step: steps[at], commands: imageCommands(steps[at].run) };
  };
  // The one step matching predicate, after the image step. Callers compare the whole step, so an
  // added if: or continue-on-error: fails.
  const after = (job, image, predicate, label) => {
    const steps = workflow.jobs[job].steps;
    const matches = steps.flatMap((step, at) => predicate(step) ? [at] : []);
    assert.equal(matches.length, 1, `${job}: ${label}`);
    assert.ok(matches[0] > image, `${job}: ${label} follows the image step`);
    return steps[matches[0]];
  };

  // Harness: the Marketplace oracle gets no Docker; the catalog tests get Docker and their opt-in.
  // Both run unconditionally and fail the job when they fail; so does the image step.
  const harness = imageStep("harness");
  assert.deepEqual(Object.keys(harness.step).sort(), ["name", "run"]);
  assert.deepEqual(harness.commands, expectedCommands.harness);
  assert.deepEqual(after("harness", harness.at, (step) => step.run?.includes("check:marketplace"), "Marketplace oracle"),
    { run: "${PLAYWRIGHT:?} npm run check:marketplace" });
  assert.deepEqual(after("harness", harness.at, (step) => step.run?.includes("bench/catalog/*.test.mjs"), "catalog tests"),
    { run: "${PLAYWRIGHT_WITH_DOCKER:?} node --test bench/catalog/*.test.mjs", env: { CATALOG_DOCKER_TESTS: "1" } });

  // Parity: every Chromium-launching check, with the matrix cells it runs for and its exact command.
  const parity = imageStep("parity");
  const compiled = "contains(fromJSON('[\"gin\",\"drogon\",\"topcoat\",\"leptos\"]'), matrix.app)";
  assert.deepEqual(Object.keys(parity.step).sort(), ["if", "name", "run"]);
  assert.equal(parity.step.if, compiled);
  assert.deepEqual(parity.commands, expectedCommands.parity);
  const browserChecks = [
    { name: "Test native compiled alert forms and independent readback", if: compiled,
      run: "${PLAYWRIGHT_WITH_DOCKER:?} node bench/fullstack/apps/gin/check-alerts.mjs ${{ matrix.app }} cb-catalog-${{ matrix.app }}" },
    { name: "Qualify the matched Drogon marketplace image with both sources", if: "matrix.app == 'drogon'",
      run: "${PLAYWRIGHT_WITH_DOCKER:?} node bench/fullstack/apps/drogon/tests/marketplace-matched.mjs cb-marketplace-drogon bench/marketplace/results/w1/drogon-matched" },
    { name: "Test native Gin production boundaries and matched forms", if: "matrix.app == 'gin'",
      run: "node bench/fullstack/apps/gin/check-production.mjs cb-catalog-gin bench/fullstack/apps/gin/production-results\n"
        + "${PLAYWRIGHT_WITH_DOCKER:?} node bench/fullstack/apps/gin/check-alerts.mjs gin cb-catalog-gin matched\n" },
  ];
  for (const expected of browserChecks) {
    const step = after("parity", parity.at, (candidate) => candidate.name === expected.name, expected.name);
    assert.deepEqual(step, expected);
  }
});

test("matched Topcoat HTTP and Chromium parity use the built Marketplace bundle after image setup", () => {
  const { jobs: { parity: { steps } } } = parse(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  const marketplace = steps.findIndex((step) => step.id === "marketplace");
  const image = steps.findIndex((step) => step.name === "Playwright's image");
  const probes = steps.filter((step) => step.run?.includes("topcoat/tests/check-parity.mjs"));
  assert.equal(probes.length, 1);
  const probe = probes[0];
  assert.ok(marketplace >= 0 && marketplace < image && image < steps.indexOf(probe));
  assert.equal(steps[marketplace].run, "node bench/marketplace/run.mjs w1 --apps ${{ matrix.app }} --build --check-only");
  assert.deepEqual(probe, {
    name: "Test matched Topcoat Marketplace HTTP and Chromium in both sources",
    if: "matrix.app == 'topcoat'",
    shell: "bash",
    "timeout-minutes": 5,
    run: [
      'image="${PLAYWRIGHT_IMAGE:?}"',
      "docker run --rm --network none --entrypoint tar cb-marketplace-topcoat -c -C /app server assets |",
      '  docker run --rm --init -i --network none --cpus 2 --memory 2g --shm-size 1g \\',
      '    --user "$(id -u):$(id -g)" -e HOME=/tmp \\',
      '    --mount "type=bind,source=$PWD,target=/repo,readonly" -w /repo "$image" sh -ec \'',
      "      mkdir /tmp/topcoat",
      "      tar -x -C /tmp/topcoat",
      "      exec node bench/fullstack/apps/topcoat/tests/check-parity.mjs /tmp/topcoat/server --browser",
      "    '",
      "",
    ].join("\n"),
  });
});

// The shell tests run workflow steps in bash, as GitHub does, and the probe test also needs GNU
// timeout's -k. A local host without them skips those tests with the reason. Hosted CI always runs
// them, and fails them if a tool is missing: the harness runs this file in Playwright's image, which
// receives RUNNER_ENVIRONMENT but not GITHUB_ACTIONS, so either marks the hosted run.
const hosted = Boolean(process.env.GITHUB_ACTIONS) || process.env.RUNNER_ENVIRONMENT === "github-hosted";
const hasBash = process.platform !== "win32"
  && spawnSync("bash", ["--noprofile", "--norc", "-c", "true"], { stdio: "ignore", timeout: 10000 }).status === 0;
const hasTimeout = process.platform !== "win32"
  && spawnSync("timeout", ["-k", "1", "5", "true"], { stdio: "ignore", timeout: 10000 }).status === 0;
const unless = (available, reason) => !available && !hosted && reason;
const bashSkip = unless(hasBash, "runs workflow steps in bash, which this host does not have");

// A browser check names its image command as ${NAME:?}: when the image step did not set it, the
// step fails under GitHub's bash -e instead of running the check on the runner with no image.
test("a browser check whose image command is unset fails instead of running on the runner", {
  skip: bashSkip,
}, () => {
  const workflow = parse(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  const oracle = workflow.jobs.harness.steps.find((step) => step.run?.includes("check:marketplace")).run;
  const run = (env) => spawnSync("bash", ["-e", "-c", oracle.replace("npm run check:marketplace", "true ran")],
    { encoding: "utf8", timeout: 20000, env });
  const { PLAYWRIGHT, ...unset } = process.env;
  const missing = run(unset);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /PLAYWRIGHT/);
  const empty = run({ ...unset, PLAYWRIGHT: "" });
  assert.notEqual(empty.status, 0);
  const set = run({ ...unset, PLAYWRIGHT: "echo image" });
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.stdout, "image true ran\n");
});

test("the image step's Node probe reports a failed, empty or stalled docker run without failing the step", {
  skip: bashSkip || unless(hasTimeout, "runs the probe with GNU timeout -k, which this host does not have"),
}, (t) => {
  const workflow = parse(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  const probe = probeLines(workflow.jobs.harness.steps.find((step) => step.name === "Playwright's image").run);
  assert.deepEqual(probe, nodeProbe);
  const dir = mkdtempSync(join(tmpdir(), "catalog-node-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const docker = join(dir, "docker");
  writeFileSync(docker, [
    "#!/bin/sh",
    'case "$PROBE" in',
    "  ok) echo v26.13.1 ;;",
    "  empty) ;;",
    "  fail) echo 'docker: Error response from daemon' >&2; exit 125 ;;",
    "  stall) exec sleep 30 ;;",
    "esac",
  ].join("\n") + "\n");
  chmodSync(docker, 0o755);
  // Run as GitHub runs a step without `shell:`, under `bash -e`.
  const run = (mode, lines) => spawnSync("bash", ["-e", "-c",
    ['image="the-image"', ...lines].join("\n")], {
    encoding: "utf8", timeout: 20000, env: { ...process.env, PROBE: mode, PATH: `${dir}:${process.env.PATH}` },
  });
  const ok = run("ok", probe);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^Node on the runner v\S+, in the-image v26\.13\.1$/m);
  assert.doesNotMatch(ok.stdout, /::warning::/);
  // The stall case shortens only the bound, so the test does not wait the step's 60 seconds.
  const shortBound = probe.map((line) => line.replace("timeout -k 5 60 ", "timeout -k 1 1 "));
  for (const [mode, status, lines] of [["empty", 0, probe], ["fail", 125, probe], ["stall", 124, shortBound]]) {
    const result = run(mode, lines);
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    assert.ok(result.stdout.includes(`::warning::Could not read the Node version in the-image (docker run exit ${status}, `), `${mode}: ${result.stdout}`);
    assert.match(result.stdout, /^Node on the runner v\S+, in the-image unavailable$/m, mode);
  }
});

// Read a $GITHUB_ENV file as Actions does: NAME=value lines, and NAME<<DELIMITER blocks.
function readGithubEnv(text) {
  const env = {};
  const lines = text.split("\n");
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at];
    if (line === "") continue;
    const equals = line.indexOf("="), heredoc = line.indexOf("<<");
    if (equals > 0 && (heredoc < 0 || equals < heredoc)) {
      env[line.slice(0, equals)] = line.slice(equals + 1);
      continue;
    }
    assert.ok(heredoc > 0, `GITHUB_ENV line ${at + 1} is neither NAME=value nor NAME<<DELIMITER: ${line}`);
    const end = lines.indexOf(line.slice(heredoc + 2), at + 1);
    assert.ok(end > at, `GITHUB_ENV line ${at + 1} has no closing delimiter`);
    env[line.slice(0, heredoc)] = lines.slice(at + 1, end).join("\n");
    at = end;
  }
  return env;
}

// The image step, run as GitHub runs a step, exports through $GITHUB_ENV the commands the browser
// checks after it receive. This reads that file as Actions does, then runs each check's guarded
// command line with that environment and a stand-in docker that records its argv, so a flag added
// anywhere in the step, not only in its first run= line, fails.
test("each browser check receives exactly its image command from the image step, run as GitHub runs it", {
  skip: bashSkip,
}, (t) => {
  const workflow = parse(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  const version = JSON.parse(readFileSync(join(repo, "node_modules/@playwright/test/package.json"), "utf8")).version;
  const image = `mcr.microsoft.com/playwright:v${version}-noble`;
  const dir = mkdtempSync(join(tmpdir(), "catalog-image-step-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(bin);
  mkdirSync(elsewhere);
  const log = join(dir, "docker.log");
  const tool = (name, lines) => {
    writeFileSync(join(bin, name), lines.join("\n") + "\n");
    chmodSync(join(bin, name), 0o755);
  };
  // docker records every call; its pull succeeds and the image's node --version prints a version.
  tool("docker", [
    `#!${process.execPath}`,
    'const args = process.argv.slice(2);',
    'require("node:fs").appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + "\\n");',
    'if (args[0] === "run" && args.at(-2) === "node" && args.at(-1) === "--version") console.log("v26.13.1");',
  ]);
  // A runner's uid and gid, and its Docker socket's group.
  tool("id", ["#!/bin/sh", 'case "$*" in -u) echo 1001 ;; -g) echo 127 ;; *) echo "unexpected id $*" >&2; exit 1 ;; esac']);
  tool("stat", ["#!/bin/sh", '[ "$*" = "-c %g /var/run/docker.sock" ] || { echo "unexpected stat $*" >&2; exit 1; }', "echo 118"]);
  // The probe's bound runs its command; the probe test covers GNU timeout itself.
  tool("timeout", ["#!/bin/sh", '[ "$1 $2 $3" = "-k 5 60" ] || { echo "unexpected timeout $*" >&2; exit 1; }', "shift 3", 'exec "$@"']);
  const values = { "$(id -u):$(id -g)": "1001:127", "$(stat -c %g /var/run/docker.sock)": "118",
    "$(command -v docker)": join(bin, "docker"), "$PWD": realpathSync(repo), "$image": image };
  const concrete = (word) => Object.entries(values).reduce((out, [name, value]) => out.replaceAll(name, value), word);
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  // A step without `shell:` runs as GitHub runs it on Linux: its script in a file, under `bash -e`
  // (`bash -e {0}`), with no pipefail.
  const bash = (script, options) => {
    const file = join(dir, "step.sh");
    writeFileSync(file, script);
    rmSync(log, { force: true });
    return spawnSync("bash", ["-e", file], { encoding: "utf8", timeout: 60000, ...options });
  };
  const path = `${bin}:${process.env.PATH}`;

  for (const job of ["harness", "parity"]) {
    const steps = workflow.jobs[job].steps;
    const at = steps.findIndex((step) => step.name === "Playwright's image");
    assert.ok(at >= 0, job);
    const githubEnv = join(dir, `${job}.env`);
    writeFileSync(githubEnv, "");
    // Run from the checkout with no inherited PWD, so bash's $PWD is the checkout's real path.
    // The hosted runner's RUNNER_ENVIRONMENT, so a flag added only on a hosted runner shows here too.
    const setup = bash(steps[at].run, { cwd: repo, env: { PATH: path, GITHUB_ENV: githubEnv, DOCKER_LOG: log, RUNNER_ENVIRONMENT: "github-hosted" } });
    assert.equal(setup.status, 0, `${job} image step: ${setup.stderr}`);
    assert.ok(setup.stdout.includes(`in ${image} v26.13.1\n`), `${job}: ${setup.stdout}`);
    assert.deepEqual(calls(), [["pull", image], ["run", "--rm", image, "node", "--version"]], `${job}: the step's own docker calls`);
    const exported = readGithubEnv(readFileSync(githubEnv, "utf8"));
    assert.deepEqual(Object.keys(exported).sort(), Object.keys(expectedCommands[job]).sort(), `${job}: exported names`);

    const checks = steps.slice(at + 1).flatMap((step) => (step.run ?? "").split("\n")
      .filter((line) => line.startsWith("${PLAYWRIGHT")).map((line) => ({ step, line })));
    assert.equal(checks.length, job === "harness" ? 2 : 3, `${job}: guarded browser-check lines`);
    for (const { step, line } of checks) {
      const guarded = /^\$\{(PLAYWRIGHT\w*):\?\} (.+)$/.exec(line);
      assert.ok(guarded, `${job}: ${line}`);
      // Actions substitutes the matrix value before bash runs the line; any compiled app will do.
      const command = line.replaceAll("${{ matrix.app }}", "gin");
      assert.ok(!command.includes("${{"), command);
      // An empty directory leaves the catalog tests' glob as written, so its words compare as is.
      const result = bash(command + "\n", { cwd: elsewhere,
        env: { PATH: path, DOCKER_LOG: log, RUNNER_ENVIRONMENT: "github-hosted", ...exported, ...(step.env ?? {}) } });
      assert.equal(result.status, 0, `${job}: ${command}: ${result.stderr}`);
      const tail = guarded[2].replaceAll("${{ matrix.app }}", "gin").split(" ");
      assert.deepEqual(calls().map((args) => ["docker", ...args]),
        [[...expectedCommands[job][guarded[1]].map(concrete), ...tail]], `${job}: ${command}`);
    }
  }
});

test("an existing catalog results directory is reserved, including a failed or check-only round", () => {
  const round = `c${Date.now()}${process.pid}`;
  const parent = join(here, "results");
  const dir = join(parent, round);
  mkdirSync(parent, { recursive: true });
  mkdirSync(dir);
  const sentinel = join(dir, "sentinel");
  writeFileSync(sentinel, "do not overwrite");
  try {
    for (const extra of [[], ["--group", "catalog-page"]]) {
      const result = spawnSync(process.execPath, [join(here, "run.mjs"), round, "--check-only", ...extra], {
        cwd: repo, encoding: "utf8", windowsHide: true, timeout: 10000,
        env: { ...process.env, BENCH_APPS: "corten", BENCH_TIER: "matched" },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EEXIST/, "full native inventory remains available despite legacy tier/subset environment");
    }
    assert.equal(readFileSync(sentinel, "utf8"), "do not overwrite");
    assert.equal(existsSync(join(dir, "summary.json")), false);
  } finally {
    assert.equal(dirname(dir), parent, "cleanup remains in catalog results");
    rmSync(dir, { recursive: true, force: true });
  }
});
test("runner rejects marketplace/matched/unsafe rounds before any Docker commands", () => {
  for (const round of ["r1", "m1", "../c1", "c0"]) {
    const result = spawnSync(process.execPath, [join(here, "run.mjs"), round], { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /round must be cN/);
  }
});
test("catalog CI covers exactly the registry's twenty page apps and both sources without nightly integration", () => {
  const workflow = readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8");
  const names = JSON.parse(/PARITY_APPS: >-\s*(\[[^\]]+\])/.exec(workflow)[1].replace(/\s+/g, " "));
  assert.equal(names.length, 20);
  assert.deepEqual(names.sort(), Object.entries(allApps).filter(([, app]) => app.pages !== false).map(([name]) => name).sort());
  assert.match(workflow, /run\.mjs c1 --apps \$\{\{ matrix\.app \}\} --build --check-only/);
  assert.match(workflow, /CATALOG_DOCKER_TESTS:\s*"1"/, "Linux CI must execute the cleanup regression rather than skip it");
  assert.ok(!/schedule:|droplet\.mjs|run-all\.mjs|trend\.mjs|BENCH_TIER|BENCH_NETWORK/.test(workflow));
  const runner = readFileSync(join(here, "run.mjs"), "utf8");
  assert.match(runner, /for \(const source of sources\)/);
  assert.match(runner, /mkdirSync\(folder\);/);
  assert.match(runner, /Config\.Labels\?\.\[label\], runId/);
  assert.match(runner, /mcr\.microsoft\.com\/playwright/);
  assert.match(runner, /finally \{ await remove\(checkContainer\); \}/);
  assert.ok(!runner.includes('command(process.execPath, [join(here, "check.mjs")'), "checks must not launch a host browser outside owned cleanup");
  assert.ok(!/fsw-|rustbench|\brmi\b|volume.*prune|network.*prune/.test(runner));
});
