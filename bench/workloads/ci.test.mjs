// CI coverage checks, not native workload qualification.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);
const packageJSON = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const workflow = parse(readFileSync(new URL(".github/workflows/benchmark-evidence.yml", root), "utf8"));

test("every bounded evidence suite runs on pull requests and main without fail-open CI", () => {
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const job = workflow.jobs.evidence;
  assert.deepEqual(job.strategy.matrix.suite, ["core", "contracts", "browser"]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.if, undefined);
  const step = job.steps.find((step) => step.env?.SUITE);
  assert.equal(step.if, undefined);
  assert.equal(step["continue-on-error"], undefined);
  assert.equal(step.env.SUITE, "${{ matrix.suite }}");
  assert.ok(step.run.includes('npm run "check:groups:evidence:$SUITE"'));
  assert.ok(step.run.includes('--user "$(id -u):$(id -g)"'));
  assert.ok(!step.run.includes("/var/run/docker.sock"));
  assert.equal(job.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"], 0);
  for (const suite of job.strategy.matrix.suite) {
    const command = packageJSON.scripts[`check:groups:evidence:${suite}`];
    assert.ok(command?.includes("--test-concurrency=1"));
    assert.ok(!command.includes("native-controls.test.mjs"));
    assert.ok(!command.includes("BINDING_NEXT_IMAGE"));
  }
});

test("evidence suites cover isolated adapters, record failures and portable browser proof seams", () => {
  const scripts = packageJSON.scripts;
  const core = scripts["check:groups:evidence:core"], contracts = scripts["check:groups:evidence:contracts"];
  const browser = scripts["check:groups:evidence:browser"];
  assert.ok(core.includes("bench/workloads/isolated/adapters/*.test.mjs"));
  for (const path of ["bench/catalog/record-attempt.test.mjs", "bench/json-api/*.test.mjs"]) assert.ok(contracts.includes(path));
  for (const leaf of ["evidence", "source", "responses", "execution", "lifetimes"]) assert.ok(contracts.includes(`bench/fullstack-browser/native-${leaf}.test.mjs`));
  for (const seam of ["runner", "qualification", "transports", "binding-dispatch", "binding-effects", "binding-window", "browser", "capture", "resources", "row7", "ledger", "lifecycle", "lifecycle-proof", "verify"]) assert.ok(browser.includes(`bench/fullstack-browser/${seam}.test.mjs`));
  assert.ok(browser.includes('--test-skip-pattern="^retained real w28 "'));
  assert.ok(browser.includes(" && node --test "));
});

test("portable core selection excludes delegated-kernel controls but cannot omit another test file", () => {
  const command = packageJSON.scripts["check:groups:evidence:core"];
  const native = ["host-lifetime-linux.test.mjs", "host-participant-linux.test.mjs"];
  assert.ok(!command.includes("bench/workloads/isolated/*.test.mjs"));
  for (const file of native) assert.ok(!command.includes(file));
  const files = readdirSync(new URL("bench/workloads/isolated/", root))
    .filter((name) => name.endsWith(".test.mjs") && !native.includes(name));
  for (const file of files) assert.ok(command.includes(`bench/workloads/isolated/${file}`), `portable test missing from CI: ${file}`);
});

test("real Linux controls have a required host job and cannot pass through fixture skips", () => {
  const job = workflow.jobs.kernel;
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  const step = job.steps.find((s) => s.run?.includes("scripts/benchmark-kernel-ci.sh"));
  assert.equal(step.if, undefined);
  assert.equal(step["continue-on-error"], undefined);
  assert.equal(step.run, 'sudo /bin/bash scripts/benchmark-kernel-ci.sh "$(command -v node)" "$PWD"');
  const driver = readFileSync(new URL("scripts/benchmark-kernel-ci.sh", root), "utf8");
  for (const required of ["supervisorBootstrap", "for suite in lifetime participant", "Delegate=cpu cpuset memory pids",
    "DelegateSubgroup=supervisor", "BROWSER_PARTICIPANT_NAMESPACE=matched", "BROWSER_PARTICIPANT_NAMESPACE=mismatched",
    "unshare --fork --pid --mount-proc", "# skipped 0", "# cancelled 0", "# fail 0", "--test-reporter=tap"])
    assert.ok(driver.includes(required), `native CI obligation missing: ${required}`);
  assert.ok(!driver.includes("continue-on-error") && !driver.includes("--privileged"));
});

test("actual Node CLI executes portable verifier sentinels and excludes historical capture", () => {
  const folder = mkdtempSync(join(tmpdir(), "benchmark-ci-selection-"));
  try {
    const path = join(folder, "selection.test.mjs"), marker = join(folder, "executed.jsonl");
    writeFileSync(path, `import test from 'node:test';
import { appendFileSync } from 'node:fs';
const mark = name => appendFileSync(${JSON.stringify(marker)}, JSON.stringify(name) + '\\n');
test('portable receipt tampering', () => mark('receipts'));
test('late failed request', () => mark('request'));
test('portable nested suite', async t => { await t.test('unsafe paths', () => mark('paths')); });
test('retained real w28 historical capture', () => { mark('HISTORICAL'); throw Error('Historical capture must not run in portable CI'); });
`);
    const filter = /--test-(name|skip)-pattern="([^"]+)"/.exec(packageJSON.scripts["check:groups:evidence:browser"]);
    assert.ok(filter);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap",
      `--test-${filter[1]}-pattern=${filter[2]}`, path], { env, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 1024 ** 2 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n").map((row) => JSON.parse(row)), ["receipts", "request", "paths"]);
    assert.doesNotMatch(result.stdout, /# skipped [1-9]/);
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true });
  }
});
