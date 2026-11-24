import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.deepEqual(harness.commands, {
    PLAYWRIGHT: [...imageBase, "$image"],
    PLAYWRIGHT_WITH_DOCKER: [...imageBase, ...dockerBoundary, ...forward("CATALOG_DOCKER_TESTS", "RUNNER_ENVIRONMENT"), "$image"],
  });
  assert.deepEqual(after("harness", harness.at, (step) => step.run?.includes("check:marketplace"), "Marketplace oracle"),
    { run: "${PLAYWRIGHT:?} npm run check:marketplace" });
  assert.deepEqual(after("harness", harness.at, (step) => step.run?.includes("bench/catalog/*.test.mjs"), "catalog tests"),
    { run: "${PLAYWRIGHT_WITH_DOCKER:?} node --test bench/catalog/*.test.mjs", env: { CATALOG_DOCKER_TESTS: "1" } });

  // Parity: every Chromium-launching check, with the matrix cells it runs for and its exact command.
  const parity = imageStep("parity");
  const compiled = "contains(fromJSON('[\"gin\",\"drogon\",\"topcoat\",\"leptos\"]'), matrix.app)";
  assert.deepEqual(Object.keys(parity.step).sort(), ["if", "name", "run"]);
  assert.equal(parity.step.if, compiled);
  assert.deepEqual(parity.commands, {
    PLAYWRIGHT_WITH_DOCKER: [...imageBase, ...dockerBoundary, ...forward("RUNNER_ENVIRONMENT"), "$image"],
  });
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

// A browser check names its image command as ${NAME:?}: when the image step did not set it, the
// step fails under GitHub's bash -e instead of running the check on the runner with no image.
test("a browser check whose image command is unset fails instead of running on the runner", {
  skip: process.platform === "win32" && "runs the step's command in bash",
}, () => {
  const workflow = parse(readFileSync(join(repo, ".github/workflows/catalog.yml"), "utf8"));
  const oracle = workflow.jobs.harness.steps.find((step) => step.run?.includes("check:marketplace")).run;
  const run = (env) => spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", oracle.replace("npm run check:marketplace", "true ran")],
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

// The probe runs in bash with GNU timeout's -k. Hosted CI (Ubuntu) always runs it; a local host
// without both skips it, with the reason.
const probeHost = process.platform !== "win32"
  && spawnSync("timeout", ["-k", "1", "5", "true"], { stdio: "ignore" }).status === 0;
test("the image step's Node probe reports a failed, empty or stalled docker run without failing the step", {
  skip: !probeHost && !process.env.GITHUB_ACTIONS && "runs the probe in bash with GNU timeout -k and a stand-in docker",
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
  // Run as GitHub runs a step's script, under -e and pipefail.
  const run = (mode, lines) => spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c",
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
