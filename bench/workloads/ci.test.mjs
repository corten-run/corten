// CI coverage checks, not native workload qualification.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { addMirror, mirror, withMirror } from "../../scripts/ci-docker-hub-mirror.mjs";

const root = new URL("../../", import.meta.url);
const packageJSON = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const workflow = parse(readFileSync(new URL(".github/workflows/benchmark-evidence.yml", root), "utf8"));

test("Evidence scopes the full diff on pull requests and main without fail-open CI", () => {
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  assert.equal(workflow.on.pull_request, null);
  assert.equal(workflow.on.workflow_call, null);
  const manual = workflow.on.workflow_dispatch.inputs.native_only;
  assert.equal(manual.type, "boolean");
  assert.equal(manual.default, false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const scope = workflow.jobs.scope;
  assert.equal(scope.if, undefined);
  assert.equal(scope["continue-on-error"], undefined);
  assert.equal(scope.outputs.run, "${{ steps.scope.outputs.run }}");
  assert.equal(scope.outputs.kernel, "${{ steps.scope.outputs.kernel }}");
  const selector = scope.steps.find((step) => step.id === "scope");
  assert.equal(selector.run, "node scripts/benchmark-scope.mjs evidence");
  assert.equal(selector.env.PUSH_BEFORE, "${{ github.event.before }}");
  assert.equal(scope.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"], 0);
  const job = workflow.jobs.evidence;
  assert.deepEqual(job.strategy.matrix.suite, ["core", "contracts", "browser"]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.needs, "scope");
  assert.equal(job.if, "needs.scope.outputs.run == 'true' && !(github.event_name == 'workflow_dispatch' && inputs.native_only)");
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
  assert.equal(job.needs, "scope");
  assert.equal(job.if, "needs.scope.outputs.kernel == 'true'");
  assert.equal(job["continue-on-error"], undefined);
  const step = job.steps.find((s) => s.run?.includes("scripts/benchmark-kernel-ci.sh"));
  assert.equal(step.if, undefined);
  assert.equal(step["continue-on-error"], undefined);
  assert.equal(step.run, 'sudo /bin/bash scripts/benchmark-kernel-ci.sh "$(command -v node)" "$PWD"');
  const driver = readFileSync(new URL("scripts/benchmark-kernel-ci.sh", root), "utf8");
  assert.ok(driver.includes("bench/workloads/isolated/host-boundary.test.mjs"), "host boundary procfs controls must run on the native host");
  assert.ok(driver.includes("bench/workloads/isolated/host-lifetime-durability.test.mjs"), "durable storage controls must run without native filesystem skips");
  for (const required of ["supervisorBootstrap", "for suite in lifetime participant churn", "Delegate=cpu cpuset memory pids",
    "DelegateSubgroup=supervisor", "BROWSER_PARTICIPANT_NAMESPACE=matched", "BROWSER_PARTICIPANT_NAMESPACE=mismatched",
    "unshare --fork --pid --mount-proc", "# skipped 0", "# cancelled 0", "# fail 0", "--test-reporter=tap"])
    assert.ok(driver.includes(required), `native CI obligation missing: ${required}`);
  assert.ok(!driver.includes("continue-on-error") && !driver.includes("--privileged"));
});

test("native driver generates the actual churn invocation under the same no-skip gates", () => {
  const driver = readFileSync(new URL("scripts/benchmark-kernel-ci.sh", root), "utf8");
  const generator = /<<'JS'\n([\s\S]*?)\nJS\n/.exec(driver)?.[1]; assert.ok(generator);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  for (const suite of ["lifetime", "participant", "churn"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-", "corten-bench-groups-r999999999-0123456789abcdef.service", process.execPath, "/checkout", suite],
      { cwd: root, env, input: generator, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 ** 2 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    const path = `bench/workloads/isolated/host-${suite === "churn" ? "lifetime-churn" : `${suite}-linux`}.test.mjs`;
    assert.ok(result.stdout.includes(`'${path}'`), result.stdout);
    assert.ok(result.stdout.includes("--test --test-reporter=tap --test-concurrency=1"));
  }
  for (const line of ["grep -Fx '# fail 0'", "grep -Fx '# cancelled 0'", "grep -Fx '# skipped 0'"])
    assert.ok(driver.includes(`${line} "$work/$suite.tap"`));
});

test("kernel job points the runner's Docker at Docker Hub's cache before the driver pulls, and the driver pulls Hub's reference (#1499)", () => {
  const steps = workflow.jobs.kernel.steps;
  const at = steps.findIndex((s) => s.run?.includes("scripts/ci-docker-hub-mirror.sh"));
  const driver = steps.findIndex((s) => s.run?.includes("scripts/benchmark-kernel-ci.sh"));
  assert.ok(at >= 0 && driver > at, "the mirror step must run before the kernel driver");
  assert.equal(steps[at].run, 'sudo /bin/bash scripts/ci-docker-hub-mirror.sh "$(command -v node)"');
  assert.equal(steps[at].if, undefined);
  assert.equal(steps[at]["continue-on-error"], undefined);
  const script = readFileSync(new URL("scripts/benchmark-kernel-ci.sh", root), "utf8");
  assert.ok(script.includes('\ndocker pull "$image"\n'));
  for (const text of ["mirror.gcr.io", "daemon.json", "registry-mirrors"]) assert.ok(!script.includes(text), text);
});

test("Docker Hub cache merge keeps every daemon setting and adds the mirror once", () => {
  assert.equal(mirror, "https://mirror.gcr.io");
  assert.deepEqual(JSON.parse(withMirror(null) ?? ""), { "registry-mirrors": [mirror] });
  const kept = { "exec-opts": ["native.cgroupdriver=cgroupfs"], "cgroup-parent": "/actions_job", features: { buildkit: true } };
  assert.deepEqual(JSON.parse(withMirror(JSON.stringify(kept)) ?? ""), { ...kept, "registry-mirrors": [mirror] });
  const other = { "registry-mirrors": ["https://cache.example"], debug: false };
  assert.deepEqual(JSON.parse(withMirror(JSON.stringify(other)) ?? ""), { ...other, "registry-mirrors": ["https://cache.example", mirror] });
  for (const listed of [[mirror], [`${mirror}/`], ["https://cache.example", mirror]])
    assert.equal(withMirror(JSON.stringify({ "registry-mirrors": listed, debug: true })), null, String(listed));
  for (const bad of ["", "{", "{} {}", "[]", "null", "3", '{"registry-mirrors":"https://mirror.gcr.io"}', '{"registry-mirrors":[1]}'])
    assert.throws(() => withMirror(bad), bad);
});

test("Docker Hub cache merge writes the daemon config only when it adds the mirror, and never over a malformed one", () => {
  const folder = mkdtempSync(join(tmpdir(), "corten-docker-mirror-"));
  try {
    const absent = join(folder, "absent.json");
    assert.equal(addMirror(absent), true);
    assert.deepEqual(JSON.parse(readFileSync(absent, "utf8")), { "registry-mirrors": [mirror] });
    const existing = join(folder, "existing.json");
    writeFileSync(existing, '{"exec-opts":["native.cgroupdriver=cgroupfs"],"registry-mirrors":["https://cache.example"]}');
    assert.equal(addMirror(existing), true);
    const merged = readFileSync(existing, "utf8");
    assert.deepEqual(JSON.parse(merged), { "exec-opts": ["native.cgroupdriver=cgroupfs"], "registry-mirrors": ["https://cache.example", mirror] });
    assert.equal(addMirror(existing), false);
    assert.equal(readFileSync(existing, "utf8"), merged, "a second run leaves the file as it is");
    const malformed = join(folder, "malformed.json"), text = '{"exec-opts": [';
    writeFileSync(malformed, text);
    assert.throws(() => addMirror(malformed), SyntaxError);
    assert.equal(readFileSync(malformed, "utf8"), text);
    assert.deepEqual(readdirSync(folder).sort(), ["absent.json", "existing.json", "malformed.json"], "no temporary file is left");
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true });
  }
});

test("Docker Hub cache step restarts Docker only for a change and fails unless Docker lists the mirror", {
  skip: process.platform !== "linux" && "requires the Linux CI shell",
}, () => {
  const folder = mkdtempSync(join(tmpdir(), "corten-docker-mirror-step-"));
  try {
    const bin = join(folder, "bin"), log = join(folder, "calls"), listed = join(folder, "listed");
    // Stand-ins record their calls; docker info lists what the test says the daemon loaded.
    const stub = (name, body) => { const path = join(bin, name); writeFileSync(path, `#!/bin/bash\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}\n`); chmodSync(path, 0o755); };
    mkdirSync(bin);
    stub("systemctl", "exit 0");
    stub("docker", `[[ "$*" == *RegistryConfig.Mirrors* ]] && cat '${listed}'; exit 0`);
    const script = fileURLToPath(new URL("scripts/ci-docker-hub-mirror.sh", root));
    const run = (config, loaded) => {
      writeFileSync(listed, loaded); writeFileSync(log, "");
      const result = spawnSync("/bin/bash", [script, process.execPath, config], { encoding: "utf8", timeout: 30000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(result.error, undefined);
      return { status: result.status, calls: readFileSync(log, "utf8").split("\n").filter(Boolean), stderr: result.stderr };
    };
    const config = join(folder, "docker", "daemon.json");
    const first = run(config, "https://mirror.gcr.io/\n");
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.calls, ["systemctl restart docker", "docker info",
      "docker info --format {{range .RegistryConfig.Mirrors}}{{println .}}{{end}}"]);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { "registry-mirrors": [mirror] });
    const again = run(config, "https://mirror.gcr.io/\n");
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!again.calls.some((call) => call.startsWith("systemctl")), "an unchanged config does not restart Docker");
    for (const loaded of ["", "https://cache.example/\n", "https://mirror.gcr.io.example/\n"]) {
      const result = run(config, loaded);
      assert.notEqual(result.status, 0, loaded);
      assert.match(result.stderr, /does not list https:\/\/mirror\.gcr\.io/);
    }
    const malformed = join(folder, "malformed.json");
    writeFileSync(malformed, "{");
    const refused = run(malformed, "https://mirror.gcr.io/\n");
    assert.notEqual(refused.status, 0);
    assert.deepEqual(refused.calls, [], "a malformed config stops the step before Docker is touched");
    assert.equal(readFileSync(malformed, "utf8"), "{");
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true });
  }
});

test("kernel preflight accepts systemd's degraded exit without accepting other host states", {
  skip: process.platform !== "linux" && "requires the Linux driver shell, not a native resource fixture",
}, () => {
  const driver = readFileSync(new URL("scripts/benchmark-kernel-ci.sh", root), "utf8");
  const marker = 'cd "$checkout"\n', start = driver.indexOf(marker);
  assert.ok(start >= 0);
  const end = driver.indexOf('\ndocker info', start); assert.ok(end > start);
  const preflight = driver.slice(start + marker.length, end);
  for (const [state, code, accepted] of [["running", 0, true], ["degraded", 1, true],
    ["starting", 1, false], ["offline", 1, false], ["maintenance", 1, false],
    ["running", 1, false], ["degraded", 0, false], ["degraded", 124, false], ["", 1, false]]) {
    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail\nsystemctl() { printf '%s\\n' '${state}'; return ${code}; }\n${preflight}`],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 ** 2 });
    assert.equal(result.error, undefined);
    assert.equal(result.status === 0, accepted, `${state}/${code}: ${result.stdout}${result.stderr}`);
  }
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
