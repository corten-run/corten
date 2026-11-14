// CI coverage checks, not native workload qualification.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  assert.ok(browser.includes('--test-name-pattern="^(?!retained real w28 )"'));
  assert.ok(browser.includes(" && node --test "));
});

test("portable core selection excludes delegated-kernel controls but cannot omit another test file", () => {
  const command = packageJSON.scripts["check:groups:evidence:core"];
  assert.ok(!command.includes("bench/workloads/isolated/*.test.mjs"));
  assert.ok(!command.includes("host-lifetime-linux.test.mjs"));
  const files = readdirSync(new URL("bench/workloads/isolated/", root))
    .filter((name) => name.endsWith(".test.mjs") && name !== "host-lifetime-linux.test.mjs");
  for (const file of files) assert.ok(command.includes(`bench/workloads/isolated/${file}`), `portable test missing from CI: ${file}`);
});
