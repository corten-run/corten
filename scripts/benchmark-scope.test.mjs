import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parse } from "yaml";
import { teardownReserve } from "../bench/marketplace/alert-probe-run.mjs";
import { sourceRoots } from "../bench/workloads/isolated/contract.mjs";
import { eventPaths, mainPushBase, selectEvidence, selectKernel, selectRequestCost, selectScope } from "./benchmark-scope.mjs";
import { LIMIT, LIST, run as checkBenchSize } from "./bench-size.mjs";
import { fixtureGitEnv } from "./fixture-git.mjs";

const root = new URL("../", import.meta.url);
const workflow = parse(readFileSync(new URL(".github/workflows/catalog.yml", root), "utf8"));
const allApps = JSON.parse(workflow.jobs.scope.env.PARITY_APPS);
const packageScripts = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts;

for (const [name, paths, apps, json] of [
  ["framework only", ["crates/corten/src/lib.rs", "Cargo.toml", "Cargo.lock"], ["corten"], false],
  ["standalone catalog app", ["bench/catalog/corten/src/main.rs"], ["corten"], false],
  ["one app", ["bench/fullstack/apps/nextjs/page.tsx", "bench/fullstack/apps/nextjs/package.json"], ["nextjs"], false],
  ["framework and one app", ["crates/corten/src/lib.rs", "bench/fullstack/apps/rails/app.rb"], ["corten", "rails"], false],
  ["shared harness", ["bench/catalog/upstream.mjs"], allApps, true],
  ["shared trace harness", ["bench/fullstack/native-trace-cost.mjs"], allApps, true],
  ["shared trace harness tests", ["bench/fullstack/native-trace-cost.test.mjs"], allApps, true],
  ["shared checker styles", ["bench/fullstack/apps/axum-maud/static/style.css"], allApps, true],
  ["bench classic compiler package", ["bench/package-lock.json"], allApps, true],
  ["bench classic compiler entry", ["bench/typescript.mjs"], allApps, true],
  ["Express driver used by FastAPI", ["bench/fullstack/apps/express/check-native.mjs"], ["fastapi", "express"], false],
  ["Express app without shared driver changes", ["bench/fullstack/apps/express/package.json"], ["express"], false],
  ["compiled alert helper", ["bench/fullstack/apps/gin/check-alerts.mjs"], ["leptos", "topcoat", "gin", "drogon"], false],
  ...["src/main.rs", "src/hosts.rs", "tests/check-parity.mjs", "tests/marketplace.json"]
    .map((path) => [`Topcoat parity input: ${path}`, [`bench/fullstack/apps/topcoat/${path}`], ["topcoat"], false]),
  ["workflow edit", [".github/workflows/catalog.yml"], allApps, true],
  ["docs only", ["docs/design.md", "CHANGELOG.md"], [], false],
  ["JSON-only app", ["bench/fullstack/apps/aspnet-aot/Program.cs"], [], true],
  ["unknown app directory", ["bench/fullstack/apps/newapp/catalog.test.mjs"], allApps, true],
  ["file directly in the apps directory", ["bench/fullstack/apps/express"], allApps, true],
  ["main push or manual dispatch", undefined, allApps, true],
]) {
  test(name, () => assert.deepEqual(selectScope(allApps, paths), { apps, json }));
}

// Every Catalog and Evidence job sets up Node from this file, so a pin bump alone has to run them
// all on the new Node, not pass their scope jobs and skip the rest.
test("a Node pin bump alone runs every Catalog app, both JSON jobs and both Evidence selections", () => {
  const files = new Set(["catalog.yml", "benchmark-evidence.yml"].flatMap(name =>
    Object.values(parse(readFileSync(new URL(`.github/workflows/${name}`, root), "utf8")).jobs)
      .flatMap(job => job.steps ?? []).map(step => step.with?.["node-version-file"]).filter(Boolean)));
  assert.deepEqual([...files], [".node-version"]);
  for (const path of files) {
    assert.deepEqual(selectScope(allApps, [path]), { apps: allApps, json: true }, path);
    assert.equal(selectEvidence([path]), true, path);
    assert.equal(selectKernel([path]), true, path);
  }
});

test("fleet controller changes keep the harness, Corten build, JSON and evidence checks", () => {
  // First-parent diff of the stopped-sibling census fix at 63e7c3314.
  const controllers = ["CLOUD.md", "cloud-production.mjs", "droplet.mjs", "fleet-production.test.mjs",
    "fleet-provider-test-worker.mjs", "fleet-verify.mjs", "group-continuation.mjs"].map(name => "bench/workloads/" + name);
  const paths = [...controllers, "changelog.d/pr-1944-1.md"];
  const expected = { apps: ["corten"], json: true };
  assert.deepEqual(selectScope(allApps, paths), expected);
  for (const path of controllers) {
    assert.deepEqual(selectScope(allApps, [path]), expected);
    assert.equal(selectEvidence([path]), true);
    assert.equal(selectKernel([path]), true);
  }
  assert.deepEqual(selectScope(allApps, [...paths, "bench/fullstack/apps/rails/app.rb"]), { apps: ["corten", "rails"], json: true });
  for (const path of ["bench/workloads/registry.mjs", "bench/workloads/cloud-new.mjs"]) {
    assert.deepEqual(selectScope(allApps, [path, ...paths]), { apps: allApps, json: true });
  }
});

test("Catalog always starts its scope job and gates parity and JSON on the selected inputs", () => {
  assert.equal(workflow.on.pull_request, null);
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  const { scope, harness, parity, "json-harness": jsonHarness, "json-aot": jsonAot } = workflow.jobs;
  assert.equal(scope.if, undefined);
  assert.equal(harness.if, "needs.scope.outputs.apps != '[]' || needs.scope.outputs.json == 'true'");
  assert.equal(parity.if, "needs.scope.outputs.apps != '[]'");
  assert.equal(jsonHarness.if, "needs.scope.outputs.json == 'true'");
  assert.equal(jsonAot.if, jsonHarness.if);
});

test("the Actions lookup gets a read-only token in the benchmark scope jobs and the CI base step", () => {
  for (const [name, mode] of [["catalog.yml", "catalog"], ["benchmark-evidence.yml", "evidence"]]) {
    const { permissions, jobs } = parse(readFileSync(new URL(`.github/workflows/${name}`, root), "utf8"));
    assert.deepEqual(permissions, { contents: "read" });
    assert.deepEqual(jobs.scope.permissions, { contents: "read", actions: "read" });
    assert.equal(jobs.scope.if, undefined);
    assert.equal(jobs.scope.steps.find(step => step.uses?.startsWith("actions/checkout")).with["fetch-depth"], 0);
    const step = jobs.scope.steps.find(step => step.run === `node scripts/benchmark-scope.mjs ${mode}`);
    assert.deepEqual(step.env, { GITHUB_TOKEN: "${{ github.event_name == 'push' && github.token || '' }}" });
  }
  const ci = parse(readFileSync(new URL(".github/workflows/ci.yml", root), "utf8"));
  const release = parse(readFileSync(new URL(".github/workflows/release.yml", root), "utf8"));
  const { smoke } = ci.jobs;
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.deepEqual(smoke.permissions, { contents: "read", actions: "read" });
  assert.deepEqual(release.permissions, ci.permissions);
  assert.deepEqual(release.jobs.checks.permissions, smoke.permissions);
  assert.equal(ci.on.workflow_dispatch.inputs.base.required, true);
  assert.equal(ci.on.workflow_dispatch.inputs.base.type, "string");
  const step = smoke.steps.find(step => step.name === "The bench size check's base");
  assert.deepEqual(step.env, { PUSH_BEFORE: "${{ github.event.before }}",
    DISPATCH_BASE: "${{ inputs.base }}",
    GITHUB_TOKEN: "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && github.token || '' }}" });
  assert.match(step.run, /base=\$\(git rev-parse 'HEAD\^1'\) ;;/);
  assert.match(step.run, /if \[ "\$GITHUB_REF" = refs\/heads\/main \]; then\s+base=\$\(node scripts\/benchmark-scope.mjs ci-base\) \|\| exit 1\s+else\s+base=\$PUSH_BEFORE/);
  assert.match(step.run, /workflow_dispatch\)[^]*git merge-base --is-ancestor "\$DISPATCH_BASE" "\$GITHUB_SHA"[^]*base=\$DISPATCH_BASE ;;/);
});

test("only direct PRs share a cancellable ref group; an older main run cannot cancel the tip", () => {
  for (const [file, name, isolated] of [["ci.yml", "CI", "ci-run-"], ["catalog.yml", "Catalog Contract", ""],
    ["benchmark-evidence.yml", "Benchmark Evidence", "benchmark-evidence-run-"]]) {
    const { concurrency, on } = parse(readFileSync(new URL(`.github/workflows/${file}`, root), "utf8"));
    const repo = "example/repo";
    function group(event_name, ref, run_id, { caller = file, workflow = name, run_attempt = "1" } = {}) {
      const github = { event_name, ref, run_id, run_attempt, workflow, repository: repo,
        workflow_ref: `${repo}/.github/workflows/${caller}@${ref}` };
      // Evaluate just the syntax these expressions use, like probeRuns below.
      const evaluate = (_, expression) => {
        const js = expression.replaceAll("==", "===").replace(/github\.(\w+)/g, (_, key) => {
          assert.ok(Object.hasOwn(github, key), key);
          return JSON.stringify(github[key]);
        });
        assert.match(js, /^(?:"[\w ./@-]+"|'[\w ./@{}-]+'|startsWith|format|===|&&|\|\||[(),\s])+$/);
        const format = (template, value) => template.replace("{0}", value);
        return Function("startsWith", "format", `return ${js}`)((text, prefix) => text.startsWith(prefix), format);
      };
      const key = concurrency.group.replace(/\$\{\{ (.*?) \}\}/g, evaluate);
      const cancel = evaluate(.../^\$\{\{ (.*?) \}\}$/.exec(concurrency["cancel-in-progress"]));
      return [key, cancel];
    }
    const main = "refs/heads/main";
    const pr = "refs/pull/27/merge";
    assert.deepEqual(on.push, { branches: ["main"] });
    assert.deepEqual(group("push", main, "1"), [`${name}-${isolated}1`, false]);
    assert.deepEqual(group("push", main, "2"), [`${name}-${isolated}2`, false]);
    assert.deepEqual(group("push", main, "1", { run_attempt: "2" }), [`${name}-${isolated}1`, false]);
    assert.deepEqual(group("pull_request", pr, "3"), [`${name}-${pr}`, true]);
    assert.deepEqual(group("pull_request", pr, "3", { run_attempt: "2" }), group("pull_request", pr, "3"));
    assert.ok(Object.hasOwn(on, "workflow_dispatch"));
    assert.deepEqual(group("workflow_dispatch", main, "4"), [`${name}-${isolated}4`, false]);
    assert.equal(Object.hasOwn(on, "workflow_call"), file !== "catalog.yml");
    if (Object.hasOwn(on, "workflow_call")) {
      // Calls report the caller's event and workflow file, even if it has the same display name.
      const call = { caller: "caller.yml" };
      assert.deepEqual(group("push", main, "5", call), [`${name}-${isolated}5`, false]);
      assert.deepEqual(group("pull_request", pr, "6", call), [`${name}-${isolated}6`, false]);
      assert.deepEqual(group("push", "refs/tags/v1.0.0", "7", { caller: "release.yml", workflow: "Release" }), [`Release-${isolated}7`, false]);
    }
  }
});

test("only a first direct main push reads the tip, before any heavy work can begin", () => {
  const initial = "github.event_name == 'push' && github.ref == 'refs/heads/main' && github.run_attempt == '1'";
  const read = (file) => parse(readFileSync(new URL(`.github/workflows/${file}`, root), "utf8")).jobs;
  const direct = (file) => ` && github.workflow_ref == format('{0}/.github/workflows/${file}@refs/heads/main', github.repository)`;
  const ci = read("ci.yml");
  assert.equal(ci["main-tip"].if, initial + direct("ci.yml"));
  assert.deepEqual(ci["main-tip"].steps.map(step => step.name), ["Stop a superseded main push"]);
  const admit = "(needs.main-tip.result == 'success' || needs.main-tip.result == 'skipped')";
  for (const [name, job] of Object.entries(ci)) {
    if (name === "main-tip") continue;
    assert.ok([job.needs].flat().includes("main-tip"), name);
    assert.equal(job.if, (name === "rust" || name === "browser" ? "always()" : "!cancelled()") + " && " + admit, name);
  }
  for (const [file, condition] of [["catalog.yml", initial], ["benchmark-evidence.yml", initial + direct("benchmark-evidence.yml")]]) {
    const jobs = read(file);
    const [first] = jobs.scope.steps;
    assert.equal(first.name, "Stop a superseded main push");
    assert.equal(first.if, condition);
    assert.equal(first.run, ci["main-tip"].steps[0].run);
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "scope") continue;
      assert.ok([job.needs].flat().includes("scope"), name);
      assert.doesNotMatch(job.if, /always\(|failure\(|cancelled\(|success\(/, name);
    }
  }
});

test("the main-tip Bash step checks the newer push and stops the older push even if it arrives last", {
  skip: process.platform === "win32" && "requires Linux Bash and GNU timeout",
}, t => {
  const { cwd, env, git, write, commit } = fixture(t);
  write("older");
  const older = commit();
  write("newer");
  const newer = commit();
  const server = join(cwd, "server");
  mkdirSync(join(server, "example"), { recursive: true });
  git("clone", "--quiet", "--bare", cwd, join(server, "example", "repo.git"));
  const ci = parse(readFileSync(new URL(".github/workflows/ci.yml", root), "utf8"));
  const { run } = ci.jobs["main-tip"].steps[0];
  for (const [GITHUB_SHA, GITHUB_REPOSITORY, status, message] of [
    [newer, "example/repo", 0, /^$/],
    [older, "example/repo", 1, /::notice::Main has moved/],
    [newer, "example/unavailable", 0, /::warning::Could not read the live main tip/],
  ]) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
      cwd, env: { ...env, GITHUB_SERVER_URL: pathToFileURL(server).href, GITHUB_REPOSITORY, GITHUB_SHA },
      encoding: "utf8", timeout: 25_000,
    });
    assert.equal(result.status, status, result.error ?? result.stderr);
    assert.match(result.stdout, message);
  }
});

test("the main-scope rollout selects every Catalog and Evidence job from an older successful base", () => {
  // The first range crossing this change must cover any gaps left by the old push-only diff.
  const paths = ["scripts/benchmark-scope.mjs"];
  assert.deepEqual(selectScope(allApps, paths), { apps: allApps, json: true });
  assert.equal(selectEvidence(paths), true);
  assert.equal(selectKernel(paths), true);
});

async function localImports(entries) {
  const cwd = fileURLToPath(root);
  const { metafile } = await build({
    absWorkingDir: cwd, entryPoints: entries.flatMap(pattern => {
      const files = globSync(pattern, { cwd });
      assert.ok(files.length > 0, "no entry points for " + pattern);
      return files;
    }), bundle: true, platform: "node", format: "esm", packages: "external", write: false,
    outdir: "unused", metafile: true, logLevel: "silent",
  });
  // The bench package's installed files are its lock's, which must select the harness itself.
  return [...new Set(Object.keys(metafile.inputs).filter(path => !path.startsWith("node_modules/"))
    .map(path => path.startsWith("bench/node_modules/") ? "bench/package-lock.json" : path))];
}

test("every local module used by the Catalog harness starts the harness", async () => {
  const patterns = workflow.jobs.harness.steps.flatMap(({ name, run }) => {
    // Playwright's image takes its tag from package.json, which is shared tooling.
    if (!run || name === "Playwright's image" || run.startsWith("npm ci ") || run.startsWith("npm --prefix bench ci ")) return [];
    // A browser check runs the same command in that image.
    const local = run.replace(/^\$\{PLAYWRIGHT(?:_WITH_DOCKER)?:\?\} /, "");
    const command = local === "npm run check:marketplace" ? packageScripts["check:marketplace"] : local;
    assert.match(command, /^node (?:--test )?bench\//, "trace new harness commands here");
    return command.replace(/^node (?:--test )?/, "").split(" ");
  });
  for (const input of await localImports(patterns)) {
    const { apps, json } = selectScope(allApps, [input]);
    assert.ok(apps.length > 0 || json, "harness input not selected: " + input);
  }
  assert.ok(selectScope(allApps, ["package.json"]).apps.length > 0, "Playwright's image tag input not selected");
});

test("Catalog jobs whose replay parses bindings install the bench package's classic compiler", () => {
  for (const job of ["harness", "json-harness"]) {
    const runs = workflow.jobs[job].steps.map(({ run }) => run);
    const install = runs.indexOf("npm --prefix bench ci --no-audit --no-fund");
    assert.ok(install > runs.indexOf("npm ci --no-audit --no-fund") && runs.indexOf("npm ci --no-audit --no-fund") >= 0, job);
    assert.ok(runs.slice(install + 1).some((run) => run?.startsWith("node ") || run?.startsWith("npm run ")), job);
  }
});

function parityEntries(app) {
  return [...new Set(workflow.jobs.parity.steps.flatMap(({ if: condition, run }) => {
    if (!run) return [];
    const command = run.replaceAll("${{ matrix.app }}", app);
    const entries = [...command.matchAll(/(?:^|\s)(bench\/[^\s]+\.mjs)(?=\s|$)/g)].map(([, path]) => path);
    if (!entries.length || !condition) return entries;
    // A diagnostic that also runs after an earlier step failed: its app selection is the same.
    const selection = /^always\(\) && (matrix\.app == '[^']+') && \((?:steps\.[\w-]+\.outcome == '(?:success|failure)'(?: \|\| )?)+\)$/.exec(condition)?.[1] ?? condition;
    const single = /^matrix\.app == '([^']+)'$/.exec(selection);
    if (single) return single[1] === app ? entries : [];
    const multiple = /^contains\(fromJSON\('([^']+)'\), matrix\.app\)$/.exec(selection);
    assert.ok(multiple, "trace new parity condition: " + condition);
    return JSON.parse(multiple[1]).includes(app) ? entries : [];
  }))];
}

test("every local module used by Catalog parity selects each consuming matrix app", async () => {
  const missing = [];
  for (const app of allApps) {
    const entries = parityEntries(app);
    assert.ok(entries.length > 0, "no parity entries for " + app);
    for (const input of await localImports(entries)) {
      if (!selectScope(allApps, [input]).apps.includes(app)) missing.push(`${app}: ${input}`);
    }
  }
  assert.deepEqual(missing, [], "unselected Catalog parity inputs");
});

// The probe step's condition, for one matrix app and gate outcome. Only the expression's own
// operators and these three operands are allowed; anything new must be traced here.
function probeRuns(condition, app, gate) {
  const js = condition.replaceAll("always()", "true").replaceAll("matrix.app", JSON.stringify(app))
    .replaceAll("steps.marketplace.outcome", JSON.stringify(gate)).replaceAll("==", "===");
  assert.match(js, /^(?:true|"[\w-]+"|'[\w-]+'|===|&&|\|\||[()\s])+$/, "trace new probe condition: " + condition);
  return Function(`return ${js}`)();
}

function probeStep() {
  const steps = workflow.jobs.parity.steps;
  const gate = steps.findIndex((step) => step.id === "marketplace");
  const probe = steps.findIndex((step) => step.run?.includes("bench/marketplace/alert-probe-run.mjs"));
  const upload = steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact"));
  // The results directory, named once in the script and passed to the runner as "$results".
  const results = /^\s*results=(\S+)$/m.exec(steps[probe].run)?.[1] ?? /alert-probe-run\.mjs \S+ \d+ (\S+)/.exec(steps[probe].run)?.[1];
  return { steps, gate, probe, upload, results, ...steps[probe] };
}

test("the React Router alert probe diagnoses a failed gate without hiding it, and ends inside its step", () => {
  const { steps, gate, probe, upload, results, if: condition, run, env, "timeout-minutes": minutes } = probeStep();
  assert.ok(gate >= 0 && gate < probe && probe < upload);
  // A failed gate fails the job: no step or job in parity may turn a failure into a pass.
  assert.equal(workflow.jobs.parity["continue-on-error"], undefined);
  assert.deepEqual(steps.filter((step) => step["continue-on-error"] !== undefined).map((step) => step.name), []);
  // It runs for React Router after the gate passed or failed, and not after cancellation or a skip.
  for (const app of allApps) for (const outcome of ["success", "failure", "cancelled", "skipped"])
    assert.equal(probeRuns(condition, app, outcome), app === "react-router" && ["success", "failure"].includes(outcome), `${app} ${outcome}`);
  // The only way past it without the probe is a gate that failed before building the image; how the
  // step tells that apart from a failed image check is run below.
  assert.equal(env.GATE, "${{ steps.marketplace.outcome }}");
  // Its receipts and diagnostics upload whatever the outcome.
  const node = run.trim().split("\n").at(-1).trim();
  assert.match(node, /^node bench\/marketplace\/alert-probe-run\.mjs cb-marketplace-react-router \d+ "\$results" /);
  assert.ok(results);
  assert.equal(steps[upload].if, "always()");
  assert.ok(steps[upload].with.path.split("\n").includes(`${results}/`));
  // The image check is bounded (its timeout plus the kill grace), and with Node's own deadline and
  // half a minute for Node to start and exit, ends inside the step timeout. The deadline is longer
  // than the cleanup it reserves plus one source's budget.
  const deadline = Number(/--deadline (\d+)/.exec(node)?.[1]), budget = Number(/--budget (\d+)/.exec(node)?.[1]);
  const [, kill, limit] = /\btimeout -k (\d+) (\d+) docker image inspect\b/.exec(run) ?? [];
  const check = Number(kill) + Number(limit);
  assert.ok(check > 0, "the image check must be bounded by timeout -k");
  assert.ok(check + deadline + 30 <= minutes * 60, `the ${check} s image check and --deadline ${deadline} must leave half a minute of the ${minutes}-minute step timeout`);
  assert.ok(deadline > teardownReserve + budget, `--deadline ${deadline} must leave the cleanup reserve and one probe budget`);
});

// The step's script under bash as Actions runs it (`bash -e`), with stub `docker` and `node` on
// PATH: bash itself off Windows, WSL's bash on Windows when it is installed.
function stepShell() {
  const wsl = process.platform === "win32";
  const present = wsl ? spawnSync("wsl.exe", ["-e", "bash", "-c", "true"], { timeout: 30_000 }) : spawnSync("bash", ["-c", "true"]);
  if (present.status !== 0) return null;
  const path = wsl ? (p) => p.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll("\\", "/") : (p) => p;
  return (script, results, { gate, docker }) => {
    const dir = mkdtempSync(join(tmpdir(), "probe-step-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "docker"), [
        "#!/bin/sh", 'echo "docker $*" >> calls.log', 'case "$FAKE_DOCKER" in',
        "  present) echo sha256:0123 ;;",
        '  absent) echo "Error response from daemon: No such image: cb-marketplace-react-router:latest" >&2; exit 1 ;;',
        '  error) echo "Error response from daemon: Bad Gateway" >&2; exit 1 ;;',
        "  hang) exec sleep 30 ;;", "esac", ""].join("\n"), { mode: 0o755 });
      writeFileSync(join(bin, "node"), '#!/bin/sh\necho "node $*" >> calls.log\n', { mode: 0o755 });
      writeFileSync(join(dir, "step.sh"), script);
      const command = ["env", "-i", `PATH=${path(bin)}:/usr/bin:/bin`, `GATE=${gate}`, `FAKE_DOCKER=${docker}`, "bash", "-e", path(join(dir, "step.sh"))];
      const started = Date.now();
      const run = spawnSync(wsl ? "wsl.exe" : command[0], wsl ? ["-e", ...command] : command.slice(1), { cwd: dir, encoding: "utf8", timeout: 60_000 });
      const read = (file) => { try { return readFileSync(join(dir, file), "utf8"); } catch { return null; } };
      return { status: run.status, output: run.stdout + run.stderr, ms: Date.now() - started,
        calls: (read("calls.log") ?? "").split("\n").filter(Boolean), preflight: read(join(results, "preflight.log")) };
    // WSL can hold the directory for a moment after its bash exits.
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  };
}
const shell = stepShell();

test("the probe step skips only an image the failed gate did not build, and fails on a failed or stalled image check", { skip: !shell && "no bash to run the step" }, () => {
  const { run, results } = probeStep();
  // The stalled check runs with a one-second bound in place of the step's, which the test above reads.
  const short = run.replace(/\btimeout -k \d+ \d+ docker/, "timeout -k 1 1 docker");
  for (const [gate, docker, status, commands, preflight] of [
    ["success", "error", 0, ["node"], null],
    ["failure", "present", 0, ["docker", "node"], null],
    ["failure", "absent", 0, ["docker"], null],
    ["failure", "error", 1, ["docker"], /exit 1\b[^]*Bad Gateway/],
    ["failure", "hang", 1, ["docker"], /exit 124\b/],
  ]) {
    const outcome = shell(docker === "hang" ? short : run, results, { gate, docker });
    const what = `gate ${gate}, image check ${docker}: ${outcome.output}`;
    assert.equal(outcome.status, status, what);
    assert.deepEqual(outcome.calls.map((call) => call.split(" ")[0]), commands, what);
    if (commands.includes("node")) assert.match(outcome.calls.at(-1), new RegExp(` ${results} .*--deadline \\d+$`), what);
    if (preflight) assert.match(outcome.preflight ?? "", preflight, what);
    else assert.equal(outcome.preflight, null, what);
    if (docker === "hang") assert.ok(outcome.ms < 20_000, `the stalled check ended after ${outcome.ms} ms`);
  }
});

test("Evidence covers every real source-custody root and its descendants", () => {
  for (const path of sourceRoots) {
    assert.equal(selectEvidence([path]), true, path);
    assert.equal(selectEvidence([path + "/new file"]), true, path);
  }
  for (const path of [".github/workflows/benchmark-evidence.yml", ".gitattributes", "docs/new-link.md", "crates/corten/src/lib.rs"]) {
    assert.equal(selectEvidence([path]), true, path);
  }
  assert.equal(selectEvidence(["CHANGELOG.md", "examples/watchlist/src/main.rs", "docs-other/file"]), false);
  assert.equal(selectEvidence(undefined), true);
});

test("native kernel controls run for fixture and tooling inputs, not portable source custody alone", () => {
  for (const path of ["bench/workloads/isolated/bootstrap.mjs", "scripts/benchmark-kernel-ci.sh",
    "scripts/ci-docker-hub-mirror.sh", "scripts/ci-docker-hub-mirror.mjs",
    ".github/workflows/benchmark-evidence.yml", "package-lock.json"]) {
    assert.equal(selectKernel([path]), true, path);
  }
  for (const path of ["crates/corten/src/lib.rs", "Cargo.toml", "Cargo.lock", "docs/design.md"]) {
    assert.equal(selectKernel([path]), false, path);
  }
  assert.equal(selectKernel(undefined), true);
});

function kernelEntries() {
  const script = readFileSync(new URL("scripts/benchmark-kernel-ci.sh", root), "utf8");
  // Read Node arguments and inline imports, including the generated unit's test path.
  const paths = [...script.matchAll(/(?:^|[\s"'`])(?:\$checkout\/|\.\/)?([\w/.$\-{}]+\.mjs)(?=[\s"'`]|$)/g)]
    .map(([, path]) => path);
  assert.ok(paths.length > 0, "no kernel Node entries");
  const entries = paths.flatMap(path => {
    if (!path.includes("$")) return path;
    const suites = /^\s*for suite in ([\w -]+); do$/m.exec(script);
    const branch = /const file = suite === '([\w-]+)' \? '[^']+\.mjs'/.exec(script);
    assert.ok(suites && branch && path.includes("${suite}"), "trace new kernel unit path: " + path);
    const values = suites[1].split(/\s+/);
    assert.ok(values.length > 1 && values.includes(branch[1]), "trace new kernel suite branches");
    return values.filter(suite => suite !== branch[1]).map(suite => path.replaceAll("${suite}", suite));
  });

  // The process launcher passes bootstrap as argv, not as an import. Bootstrap imports
  // dispatcher-child, whose argv targets (and the directly spawned fixtures) are in the tests.
  const spawned = ["bench/workloads/isolated/bootstrap.mjs"];
  for (const entry of new Set(entries)) {
    const source = readFileSync(new URL(entry, root), "utf8");
    for (const [, path] of source.matchAll(/["']((?:bench\/|\.\/)[\w/.-]*(?:dispatcher-fixtures|test-fixtures)\/[\w/.-]+\.mjs)["']/g)) {
      spawned.push(path.startsWith("./") ? new URL(path, new URL(entry, root)).href.slice(root.href.length) : path);
    }
  }
  return [...new Set([...entries, ...spawned])];
}

test("every local module used by native kernel controls selects the kernel job", async () => {
  const inputs = await localImports(kernelEntries());
  assert.deepEqual(inputs.filter(input => !selectKernel([input])).sort(), [], "unselected native kernel inputs");
});

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "corten-benchmark-scope-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  // Git's environment for the fixture, in process and for the scope script: the caller's GIT_DIR and the like would
  // choose another repository.
  const env = fixtureGitEnv();
  const git = (...args) => execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "user.name=Catalog Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd, encoding: "utf8", env }).trim();
  git("init", "-q", "-b", "main");
  const write = (path, text = "fixture\n") => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const rename = (from, to) => {
    mkdirSync(dirname(join(cwd, to)), { recursive: true });
    renameSync(join(cwd, from), join(cwd, to));
  };
  const merge = head => {
    git("switch", "--quiet", "main");
    git("merge", "--quiet", "--no-ff", "--no-edit", head);
    return git("rev-parse", "HEAD");
  };
  return { cwd, env, git, write, commit, rename, merge };
}

const prEvent = GITHUB_SHA => ({ GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA });

test("PR diff excludes base-only changes and includes both sides of an app rename without an API lookup", async t => {
  const { cwd, env: gitEnv, git, write, commit, rename, merge } = fixture(t);
  const before = "bench/fullstack/apps/rails/old file";
  const after = "bench/fullstack/apps/nextjs/new file";
  write(before);
  const fork = commit();
  write("bench/catalog/upstream.mjs");
  commit();
  git("switch", "--quiet", "--detach", fork);
  rename(before, after);
  const event = prEvent(merge(commit()));
  const paths = await eventPaths(event, cwd, gitEnv, { workflow: "catalog", fetchRuns: assert.fail });
  assert.deepEqual(paths.sort(), [after, before]);

  const script = fileURLToPath(new URL("./benchmark-scope.mjs", import.meta.url));
  const output = join(cwd, "output");
  const env = fixtureGitEnv({ ...event, GITHUB_OUTPUT: output, PARITY_APPS: workflow.jobs.scope.env.PARITY_APPS });
  for (const job of ["catalog", "evidence"]) execFileSync(process.execPath, [script, job], { cwd, env });
  assert.equal(readFileSync(output, "utf8"), 'apps=["nextjs","rails"]\njson=false\nrun=true\nkernel=true\n');
});

test("a base-side rename scopes the edited file where parity actually tests it", async t => {
  const { cwd, env, git, write, commit, rename, merge } = fixture(t);
  const before = "bench/fullstack/apps/express/driver.mjs";
  const after = "bench/workloads/driver.mjs";
  write(before);
  const fork = commit();
  rename(before, after);
  const base = commit();
  git("switch", "--quiet", "--detach", fork);
  write(before, "edited on PR\n");
  const head = commit();
  const merged = merge(head);
  assert.equal(git("diff", "--name-only", base + "..." + head), before);
  const paths = await eventPaths(prEvent(merged), cwd, env);
  assert.deepEqual(paths, [after]);
  assert.deepEqual(selectScope(allApps, paths), { apps: allApps, json: true });
});

for (const [name, paths, run] of [
  ["the framework", ["crates/corten/src/router.rs"], true],
  ["the macros", ["docs/guide/views.md", "crates/corten-macros/src/lib.rs"], true],
  ["the feed", ["crates/corten-feed/src/lib.rs"], true],
  ["the feed's protocol", ["crates/corten-protocol/src/lib.rs"], true],
  ["a locked version", ["Cargo.lock"], true],
  ["the workspace's manifest", ["Cargo.toml"], true],
  ["the kit", ["bench/request-cost/probe/src/main.rs"], true],
  ["the job", [".github/workflows/request-cost.yml"], true],
  ["the scope script", ["scripts/benchmark-scope.mjs"], true],
  ["the Node pin", [".node-version"], true],
  ["what an archive of a commit holds", [".gitattributes"], true],
  ["what an archive holds of a directory", ["README.md", "crates/.gitattributes"], true],
  ["what an archive holds of a crate's directory", ["crates/corten-cli/src/.gitattributes"], true],
  ["an event with no diff to read", undefined, true],
  ["what no request is built from", ["README.md", "docs/design.md", "CONTRIBUTING.md", "package.json", "examples/card-market/src/main.rs",
    "crates/corten-cli/src/main.rs", "crates/corten-ui/src/lib.rs", "crates/corten-cluster/src/lib.rs", "crates/corten-macros.md",
    "bench/fullstack/count.mjs", "bench/request-costs/README.md", ".github/workflows/ci.yml", "examples/watchlist/Cargo.toml",
    ".cargo/config.toml", "docs/gitattributes", "docs/x.gitattributes"], false],
]) {
  test(`Request Cost ${run ? "counts" : "skips"} ${name}`, () => assert.equal(selectRequestCost(paths), run));
}

test("Request Cost's scope reads a pull request's merge against its first parent, not what the base alone changed", t => {
  const { cwd, git, write, commit, merge } = fixture(t);
  write("initial");
  const fork = commit();
  write("crates/corten/src/lib.rs");
  commit();
  const script = fileURLToPath(new URL("./benchmark-scope.mjs", import.meta.url));
  const output = join(cwd, "output");
  const scope = (from, path) => {
    git("switch", "--quiet", "--detach", from);
    write(path);
    writeFileSync(output, "");
    const env = fixtureGitEnv({ ...prEvent(merge(commit())), GITHUB_OUTPUT: output });
    execFileSync(process.execPath, [script, "request-cost"], { cwd, env });
    return readFileSync(output, "utf8");
  };
  // The base changed the framework after the fork; the pull request changed a guide.
  assert.equal(scope(fork, "docs/guide/views.md"), "run=false\n");
  assert.equal(scope("main", "crates/corten-macros/src/lib.rs"), "run=true\n");
});

test("Request Cost runs for pull requests alone, in one job that always scopes, counts only what the scope selects and asks nothing of the token", () => {
  const source = readFileSync(new URL(".github/workflows/request-cost.yml", root), "utf8");
  const requestCost = parse(source);
  assert.deepEqual(requestCost.on, { pull_request: null });
  assert.deepEqual(requestCost.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(requestCost.jobs), ["request-cost"]);
  const { if: when, permissions, steps } = requestCost.jobs["request-cost"];
  assert.deepEqual([when, permissions], [undefined, undefined]);
  // The readings' end is set in the job's first step, so what comes before them is in its time.
  assert.match(steps[0].run, /^echo "STOP_AT=\$\(\(\$\(date \+%s\) \+ \d+\)\)" >> "\$GITHUB_ENV"$/);
  // The merge base is found in the history, and the token is not left in the checkout.
  assert.deepEqual(steps[1].with, { "fetch-depth": 0, "persist-credentials": false });
  // The scope's step runs for every pull request, and every step after it by what it said: a
  // scope that said neither true nor false fails the job, and is not a skip.
  const scope = steps.findIndex(step => step.run === "node scripts/benchmark-scope.mjs request-cost");
  assert.deepEqual(steps.slice(1, scope + 1).map(step => [step.uses?.split("@")[0] ?? step.id, step.if]), [["actions/checkout", undefined], ["actions/setup-node", undefined], ["scope", undefined]]);
  assert.deepEqual(steps.slice(scope + 1).map(step => step.if), ["steps.scope.outputs.run == 'false'",
    "steps.scope.outputs.run != 'true' && steps.scope.outputs.run != 'false'", ...Array(4).fill("steps.scope.outputs.run == 'true'")]);
  assert.match(steps[scope + 1].run, /^echo "Not counted, .*" >> "\$GITHUB_STEP_SUMMARY"$/);
  assert.match(steps[scope + 2].run, /\nexit 1\n$/);
  // The builds and the readings are the kit's controller's, which job.test.mjs runs.
  assert.deepEqual(steps.slice(scope + 4, scope + 6).map(step => step.run.match(/^bash bench\/request-cost\/job\.sh .*$/m)?.[0]),
    ['bash bench/request-cost/job.sh build "$RUNNER_TEMP/request-cost"', 'bash bench/request-cost/job.sh read "$RUNNER_TEMP/request-cost" "$cpu"']);
  // A fork's run has a token that reads and no secrets, and a description is whatever its author
  // typed: it is read from the event's file, never written into a script.
  assert.doesNotMatch(source, /secrets\.|github\.token|GITHUB_TOKEN/);
  assert.deepEqual(source.match(/\$\{\{[^}]*\}\}/g).filter(expression => !/^\$\{\{ (github\.workflow|github\.ref) \}\}$/.test(expression)), []);
  assert.ok(steps.at(-1).run.includes(`jq -r '.pull_request.body // ""' "$GITHUB_EVENT_PATH"`));
});

function pushEvent(GITHUB_SHA, file, PUSH_BEFORE) {
  const GITHUB_REF = "refs/heads/main";
  const GITHUB_REPOSITORY = "example/repo";
  return { GITHUB_EVENT_NAME: "push", GITHUB_SHA, GITHUB_REF, GITHUB_REPOSITORY, PUSH_BEFORE,
    GITHUB_WORKFLOW_REF: `${GITHUB_REPOSITORY}/.github/workflows/${file}@${GITHUB_REF}`,
    GITHUB_API_URL: "https://api.example.invalid", GITHUB_TOKEN: "fixture-token" };
}

const successfulPush = head_sha => ({ event: "push", head_branch: "main", status: "completed", conclusion: "success", head_sha });
const successfulDispatch = head_sha => ({ ...successfulPush(head_sha), event: "workflow_dispatch" });
const workflowRuns = (...runs) => Response.json({ workflow_runs: runs });

test("CI checks a deleted oversized blob since its last successful main push", async t => {
  const { cwd, env, git, write, commit } = fixture(t);
  write(LIST, "# grandfathered\n");
  const success = commit();
  const path = "bench/r2/run.log";
  write(path, Buffer.alloc(LIMIT + 1, 97));
  const superseded = commit();
  git("rm", path);
  const head = commit();
  git("update-ref", "refs/remotes/origin/main", head);
  const event = pushEvent(head, "ci.yml", superseded);
  const workflow = "ci-base";
  const { base } = await mainPushBase(event, cwd, env, { workflow, fetchRuns: url => {
    assert.equal(url.pathname, "/repos/example/repo/actions/workflows/ci.yml/runs");
    return workflowRuns(successfulPush(success));
  } });
  assert.equal(base, success);
  // Neither the previous tip nor the already-updated origin/main range reads the added blob.
  assert.deepEqual(checkBenchSize(cwd, { head, base: superseded, env }).problems, []);
  assert.deepEqual(checkBenchSize(cwd, { head, base: "0".repeat(40), env }).problems, []);
  const wanted = new RegExp(`bench/r2/run\\.log: .* from commit ${superseded},`);
  assert.match(checkBenchSize(cwd, { head, base, env }).problems[0], wanted);
});

test("CI base lookup failure emits one actionable error and no base, even with a usable previous tip", t => {
  const { cwd, env, write, commit } = fixture(t);
  write("initial");
  const before = commit();
  write("second");
  const head = commit();
  const event = pushEvent(head, "ci.yml", before);
  const script = fileURLToPath(new URL("./benchmark-scope.mjs", import.meta.url));
  const mock = source => `--import=data:text/javascript,${encodeURIComponent("globalThis.fetch = " + source)}`;
  const forbidden = '() => new Response("untrusted body", { status: 403 })';
  for (const [extra, reason, response] of [
    [{ GITHUB_TOKEN: "" }, "the GitHub Actions API token is missing", forbidden],
    [{}, "the GitHub Actions API returned HTTP 403", forbidden],
    [{}, "none of the most recent 100 successful main runs is an available earlier ancestor", '() => Response.json({ workflow_runs: [] })'],
  ]) {
    const result = spawnSync(process.execPath, [mock(response), script, "ci-base"], {
      cwd, env: { ...env, ...event, ...extra }, encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(),
      `::error::Could not find a successful main CI base: ${reason}. Rerun CI or dispatch it on main (workflow_dispatch) with an explicit base.`);
  }
});

test("a push to main scopes Catalog and Evidence from each last successful run, including superseded paths", async t => {
  const { cwd, env, write, commit } = fixture(t);
  write("initial");
  const base = commit();
  const app = "bench/fullstack/apps/rails/app.rb";
  write(app);
  const superseded = commit();
  write("unrelated");
  const head = commit();
  for (const [workflow, file] of [["catalog", "catalog.yml"], ["evidence", "benchmark-evidence.yml"]]) {
    const event = pushEvent(head, file, superseded); // The old base would miss app.
    let calls = 0;
    const paths = await eventPaths(event, cwd, env, { workflow, fetchRuns: async (url, options) => {
      calls++;
      assert.equal(url.origin, event.GITHUB_API_URL);
      assert.equal(url.pathname, `/repos/${event.GITHUB_REPOSITORY}/actions/workflows/${file}/runs`);
      assert.deepEqual(Object.fromEntries(url.searchParams), { branch: "main", event: "push", status: "success", per_page: "100" });
      assert.equal(options.headers.Authorization, "Bearer fixture-token");
      return workflowRuns(successfulPush(base));
    } });
    assert.equal(calls, 1);
    assert.deepEqual(paths, [app, "unrelated"]);
    assert.deepEqual(selectScope(allApps, paths), { apps: ["rails"], json: false });
    assert.equal(selectEvidence(paths), true);
    assert.equal(selectKernel(paths), true);
  }
});

test("a missing, failed or non-ancestor main run lookup selects everything", async t => {
  const { cwd, env, write, commit } = fixture(t);
  write("initial");
  const base = commit();
  write("unrelated");
  const head = commit();
  write("later");
  const later = commit();
  for (const [label, fetchRuns] of [
    ["no successful runs", () => workflowRuns()],
    ["failed run", () => workflowRuns({ ...successfulPush(base), conclusion: "failure" })],
    ["cancelled run", () => workflowRuns({ ...successfulPush(base), conclusion: "cancelled" })],
    ["manual run", () => workflowRuns(successfulDispatch(base))],
    ["HTTP error", () => new Response(null, { status: 403 })],
    ["network error", () => { throw new Error("request refused"); }],
    ["malformed response", () => new Response("not JSON")],
    ["malformed SHA", () => workflowRuns(successfulPush([base]))],
    ["missing commit", () => workflowRuns(successfulPush("a".repeat(40)))],
    ["non-ancestor commit", () => workflowRuns(successfulPush(later))],
    ["same commit", () => workflowRuns(successfulPush(head))],
  ]) {
    for (const [workflow, file] of [["catalog", "catalog.yml"], ["evidence", "benchmark-evidence.yml"]]) {
      const paths = await eventPaths(pushEvent(head, file, base), cwd, env, { workflow, fetchRuns });
      assert.equal(paths, undefined, label);
      assert.deepEqual(selectScope(allApps, paths), { apps: allApps, json: true }, label);
      assert.equal(selectEvidence(paths), true, label);
      assert.equal(selectKernel(paths), true, label);
    }
  }
});

test("CI can use a successful dispatch on the rewritten main line as the next push base", async t => {
  const { cwd, env, git, write, commit } = fixture(t);
  write("initial");
  const fork = commit();
  write("old-tip");
  const oldTip = commit();
  git("switch", "--quiet", "--detach", fork);
  write("new-line");
  const dispatched = commit();
  write("after-dispatch");
  const head = commit();
  const event = pushEvent(head, "ci.yml", dispatched);
  const workflow = "ci-base";
  const unavailable = await mainPushBase(event, cwd, env, { workflow, fetchRuns: () => workflowRuns(
    successfulPush(oldTip), { ...successfulDispatch(dispatched), head_branch: "topic" },
    { ...successfulDispatch(dispatched), conclusion: "failure" },
  ) });
  assert.match(unavailable.reason, /none of the most recent 100/);
  const recovered = await mainPushBase(event, cwd, env, { workflow, fetchRuns: url => {
    assert.deepEqual(Object.fromEntries(url.searchParams), { branch: "main", status: "success", per_page: "100" });
    return workflowRuns(successfulPush(oldTip), successfulDispatch(dispatched));
  } });
  assert.deepEqual(recovered, { base: dispatched });
});

test("an older run skips invalid, same-head and newer successes and picks the first strict ancestor within 100 rows", async t => {
  const { cwd, env, write, commit } = fixture(t);
  write("earliest");
  const earliest = commit();
  write("latest-ancestor");
  const ancestor = commit();
  write("rerun-head");
  const head = commit();
  write("newer-success");
  const newer = commit();
  const ignored = [successfulPush(newer), successfulPush(head), successfulPush("a".repeat(40))];
  for (const [workflow, file] of [["ci-base", "ci.yml"], ["catalog", "catalog.yml"], ["evidence", "benchmark-evidence.yml"]]) {
    const event = pushEvent(head, file, ancestor);
    const lookup = (...runs) => mainPushBase(event, cwd, env, { workflow, fetchRuns: () => workflowRuns(...runs) });
    assert.deepEqual(await lookup(...ignored, successfulPush(ancestor), successfulPush(earliest)), { base: ancestor });
    const late = Array.from({ length: 99 }, () => successfulPush(head));
    assert.deepEqual(await lookup(...late, successfulPush(ancestor)), { base: ancestor });
    assert.match((await lookup(...late, successfulPush(head), successfulPush(ancestor))).reason, /none of the most recent 100/);
  }
});

test("a rewrite still scopes safely if a checked ancestor remains, without using the previous tip", async t => {
  const { cwd, env, git, write, commit } = fixture(t);
  write("initial");
  const base = commit();
  write("old-tip");
  const oldTip = commit();
  git("switch", "--quiet", "--detach", base);
  write("new-tip");
  const head = commit();
  const options = { workflow: "catalog", fetchRuns: () => workflowRuns(successfulPush(base)) };
  for (const before of [oldTip, "0".repeat(40)]) {
    const event = pushEvent(head, "catalog.yml", before);
    assert.deepEqual(await eventPaths(event, cwd, env, options), ["new-tip"]);
  }
  assert.deepEqual(await eventPaths(pushEvent(head, "catalog.yml", base), cwd, env, options), ["new-tip"]);
});

test("the main-push union includes a restored app path and a path introduced only by a merge", async t => {
  const { cwd, env, git, write, commit } = fixture(t);
  const app = "bench/fullstack/apps/rails/app.rb";
  write(app, "original");
  const base = commit();
  git("switch", "--quiet", "-c", "topic");
  write("topic");
  const topic = commit();
  git("switch", "--quiet", "main");
  write(app, "changed");
  commit();
  write(app, "original");
  const before = commit();
  git("merge", "--quiet", "--no-ff", "--no-commit", topic);
  const resolution = "bench/fullstack/apps/express/file with spaces.mjs";
  write(resolution);
  const head = commit();
  assert.deepEqual(git("diff", "--name-only", base, head).split(/\r?\n/), [resolution, "topic"]);
  const paths = await eventPaths(pushEvent(head, "catalog.yml", before), cwd, env, {
    workflow: "catalog", fetchRuns: () => workflowRuns(successfulPush(base)),
  });
  assert.deepEqual(paths, [resolution, app, "topic"]);
  assert.deepEqual(selectScope(allApps, paths), { apps: ["rails", "express"], json: false });
});

test("manual and called workflows do not look up a main push base", async t => {
  const { cwd, env, write, commit } = fixture(t);
  write("initial");
  const head = commit();
  const event = pushEvent(head, "benchmark-evidence.yml");
  let calls = 0;
  const options = { workflow: "evidence", fetchRuns: () => { calls++; return workflowRuns(); } };
  assert.equal(await eventPaths({ ...event, GITHUB_EVENT_NAME: "workflow_dispatch" }, cwd, env, options), undefined);
  assert.equal(await eventPaths(pushEvent(head, "caller.yml"), cwd, env, options), undefined);
  assert.equal(calls, 0);
});

test("PR and multi-commit push diffs see inputs beyond the hosted path-filter limit", async t => {
  const { cwd, env, git, write, commit, merge } = fixture(t);
  write("initial");
  const base = commit();
  git("switch", "--quiet", "--detach", base);
  for (let i = 0; i < 301; i++) write("aaa-unrelated/" + i);
  const input = "bench/fullstack/native-trace-cost.mjs";
  write(input);
  const before = commit();
  write("zzz-unrelated");
  const head = commit();
  const events = [prEvent(merge(head)), pushEvent(head, "benchmark-evidence.yml", before)];
  for (const event of events) {
    const paths = await eventPaths(event, cwd, env, { workflow: "evidence", fetchRuns: () => workflowRuns(successfulPush(base)) });
    assert.equal(paths.length, 303);
    assert.equal(paths[301], input);
    assert.deepEqual(selectScope(allApps, paths), { apps: allApps, json: true });
    assert.equal(selectEvidence(paths), true);
    assert.equal(selectKernel(paths), true);
  }
});

// The benchmark gates run on the framework CI's Node line and the release workflow's artifact
// pin, so moving either is one edit and a literal Node or tag cannot drift back in. Each job that
// needs Node or uploads evidence is named, so dropping its step fails instead of falling back to
// the runner's default Node or losing that job's artifacts.
const toolchainJobs = {
  "catalog.yml": { node: ["scope", "harness", "parity", "json-harness", "json-aot"], upload: ["parity", "json-aot"] },
  "benchmark-evidence.yml": { node: ["scope", "evidence", "kernel"], upload: [] },
  "request-cost.yml": { node: ["request-cost"], upload: [] },
};

function assertToolchain(workflows, pin) {
  for (const [name, required] of Object.entries(toolchainJobs)) {
    const jobs = workflows[name].jobs;
    for (const job of [...required.node, ...required.upload]) assert.ok(jobs[job], `${name} has no job ${job}`);
    for (const [job, { steps = [] }] of Object.entries(jobs)) {
      const node = steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
      const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
      if (required.node.includes(job)) assert.ok(node.length > 0, `${name} ${job} sets up no Node`);
      if (required.upload.includes(job)) assert.ok(uploads.length > 0, `${name} ${job} uploads no artifact`);
      for (const step of node) {
        assert.equal(step.with?.["node-version-file"], ".node-version", `${name} ${job}`);
        assert.equal(step.with?.["node-version"], undefined, `${name} ${job}`);
      }
      for (const step of uploads) assert.equal(step.uses, pin, `${name} ${job}`);
    }
  }
}

test("Catalog, Benchmark Evidence and Request Cost take Node from .node-version and upload-artifact from release.yml's pin", () => {
  const read = (name) => parse(readFileSync(new URL(`.github/workflows/${name}`, root), "utf8"));
  const pins = new Set(Object.values(read("release.yml").jobs).flatMap((job) => job.steps ?? [])
    .map((step) => step.uses).filter((uses) => uses?.startsWith("actions/upload-artifact@")));
  assert.equal(pins.size, 1);
  const [pin] = pins;
  assert.match(pin, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  const workflows = Object.fromEntries(Object.keys(toolchainJobs).map((name) => [name, read(name)]));
  assertToolchain(workflows, pin);

  // Each mutation leaves the rest of the workflow passing, so only the named job's gap fails.
  const without = (name, job, prefix) => {
    const copy = structuredClone(workflows);
    const steps = copy[name].jobs[job].steps;
    copy[name].jobs[job].steps = steps.filter((step) => !step.uses?.startsWith(prefix));
    assert.ok(copy[name].jobs[job].steps.length < steps.length);
    return copy;
  };
  const edit = (name, job, prefix, change) => {
    const copy = structuredClone(workflows);
    change(copy[name].jobs[job].steps.find((step) => step.uses?.startsWith(prefix)));
    return copy;
  };
  for (const [workflowSet, message] of [
    [without("catalog.yml", "parity", "actions/setup-node@"), /catalog\.yml parity sets up no Node/],
    [without("catalog.yml", "json-aot", "actions/upload-artifact@"), /catalog\.yml json-aot uploads no artifact/],
    [without("benchmark-evidence.yml", "kernel", "actions/setup-node@"), /benchmark-evidence\.yml kernel sets up no Node/],
    [edit("catalog.yml", "json-harness", "actions/setup-node@", (step) => { step.with = { "node-version": 24 }; }), /catalog\.yml json-harness/],
    [edit("benchmark-evidence.yml", "evidence", "actions/setup-node@", (step) => { step.with["node-version"] = 26; }), /benchmark-evidence\.yml evidence/],
    [edit("catalog.yml", "json-aot", "actions/upload-artifact@", (step) => { step.uses = "actions/upload-artifact@v6"; }), /catalog\.yml json-aot/],
  ]) {
    assert.throws(() => assertToolchain(workflowSet, pin), message);
  }
});
