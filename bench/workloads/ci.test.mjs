// CI coverage checks, not native workload qualification.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync,
  rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { addMirror, mirror, publish, withMirror } from "../../scripts/ci-docker-hub-mirror.mjs";

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
  const dockerExit = workflow.on.workflow_dispatch.inputs.docker_exit_control;
  assert.equal(dockerExit.type, "boolean");
  assert.equal(dockerExit.default, false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const scope = workflow.jobs.scope;
  assert.equal(scope.if, undefined);
  assert.equal(scope["continue-on-error"], undefined);
  assert.equal(scope.outputs.run, "${{ steps.scope.outputs.run }}");
  assert.equal(scope.outputs.kernel, "${{ steps.scope.outputs.kernel }}");
  const selector = scope.steps.find((step) => step.id === "scope");
  assert.equal(selector.run, "node scripts/benchmark-scope.mjs evidence-cumulative-v1");
  assert.equal(selector.env.GITHUB_TOKEN, "${{ github.event_name == 'push' && github.token || '' }}");
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
  assert.deepEqual(step.env, {
    CORTEN_NATIVE_DOCKER_EXIT: "${{ github.event_name == 'workflow_dispatch' && inputs.docker_exit_control && '1' || '0' }}",
  });
  assert.equal(step.run, 'sudo env CORTEN_NATIVE_DOCKER_EXIT="$CORTEN_NATIVE_DOCKER_EXIT" /bin/bash scripts/benchmark-kernel-ci.sh "$(command -v node)" "$PWD"');
  const driver = readFileSync(new URL("scripts/benchmark-kernel-ci.sh", root), "utf8");
  assert.ok(driver.includes("bench/workloads/isolated/host-boundary.test.mjs"), "host boundary procfs controls must run on the native host");
  assert.ok(driver.includes("bench/workloads/isolated/host-lifetime-durability.test.mjs"), "durable storage controls must run without native filesystem skips");
  for (const required of ["supervisorBootstrap", "for suite in lifetime participant churn", "Delegate=cpu cpuset memory pids",
    "DelegateSubgroup=supervisor", "BROWSER_PARTICIPANT_NAMESPACE=matched", "BROWSER_PARTICIPANT_NAMESPACE=mismatched",
    "unshare --fork --pid --mount-proc", "# skipped 0", "# cancelled 0", "# fail 0", "--test-reporter=tap"])
    assert.ok(driver.includes(required), `native CI obligation missing: ${required}`);
  assert.ok(!driver.includes("continue-on-error") && !driver.includes("--privileged"));
});

const resourceProbeMocks = String.raw`
  _owned=$(printf '%064d' 1)
  _foreign=$(printf '%064d' 2)
  _label=corten.json.resource-probe-attempt
  _waits=0
  _probed=0
  _removed=0
  timeout() {
    [[ "$1" =~ ^--kill-after=([0-9]+)s$ ]] || return 98
    local grace=$((BASH_REMATCH[1]))
    [[ "$2" =~ ^([0-9]+)s$ ]] || return 98
    printf 'budget:%d\n' "$((BASH_REMATCH[1] + grace))" >&2
    _bound=$2
    shift 2
    case "$1" in docker|node) "$@" ;; *) return 98 ;; esac
  }
  sleep() { [[ "$*" == 1 ]] || return 98; _waits=$((_waits + 1)); printf 'budget:1\n' >&2; }
  node() {
    if [[ "$1" == -p ]]; then
      [[ "$2" == 'require("node:crypto").randomUUID()' ]] || return 98
      printf '%s\n' "$ATTEMPT"
      return
    fi
    [[ "$#" == 2 && "$1" == bench/json-api/load-resource-probe.mjs && "$2" == "$_owned" ]] || return 98
    _probed=1
    printf 'probe:%s\n' "$2" >&2
    [[ "$MODE" != probeFailed ]]
  }
  docker() {
    [[ "$1" == --host && "$2" == unix:///var/run/docker.sock ]] || return 98
    shift 2
    case "$1" in
      pull) ;;
      create)
        printf 'create\n' >&2
        [[ "$*" == *" --label corten.json.resource-probe=1 --label $_label=$ATTEMPT "* ]] || return 98
        case "$MODE" in
          ok|probeFailed|removeFailed|ackInspectDelayed|cleanupDelayed|cleanupMismatch|cleanupDelayedMismatch|cleanupUnavailable|rmTimeout*)
            printf '%s\n' "$_owned" ;;
          foreignAck) printf '%s\n' "$_foreign" ;;
          *) return 124 ;;
        esac
        ;;
      ps)
        if [[ "$*" == "ps --all --no-trunc --filter id=$_owned --format {{.ID}}" ]]; then
          [[ "$_bound" == 2s ]] || return 98
          printf 'census:%s\n' "$_owned" >&2
          case "$MODE" in
            rmTimeoutUnknown) return 124 ;;
            rmTimeoutMalformed) printf '%s\n' "$_foreign" ;;
            rmTimeoutBlank) printf '\n' ;;
            rmTimeoutGone) : ;;
            rmTimeoutRecheckGone) if [[ ! -e .removal-finished ]]; then printf '%s\n' "$_owned"; fi ;;
            rmTimeoutRetryGone) if (( _removed == 1 )); then printf '%s\n' "$_owned"; fi ;;
            *) printf '%s\n' "$_owned" ;;
          esac
          return 0
        fi
        [[ "$_bound" == 2s && "$*" == "ps --all --no-trunc --filter label=$_label=$ATTEMPT --format {{.ID}}" ]] || return 98
        printf 'lookup\n' >&2
        case "$MODE" in
          lost) if (( _waits >= 2 )); then printf '%s\n' "$_owned"; fi ;;
          absent) ;;
          lookupFailed) return 124 ;;
          short) printf '0123456789ab\n' ;;
          multiple) printf '%s\n' "$_owned" "$_foreign" ;;
          foreign) printf '%s\n' "$_foreign" ;;
          changed) if (( _waits )); then printf '%s\n' "$_foreign"; else printf '%s\n' "$_owned"; fi ;;
          ambiguousAfterRetry) if (( _waits )); then printf '%s\n' "$_owned" "$_foreign"; else printf '%s\n' "$_owned"; fi ;;
          malformedAfterRetry) if (( _waits )); then printf '0123456789ab\n'; else printf '%s\n' "$_owned"; fi ;;
          *) printf '%s\n' "$_owned" ;;
        esac
        ;;
      container)
        [[ "$_bound" == 3s && "$2" == inspect && "$3" == --format && "$4" == '{{.Id}} {{index .Config.Labels "corten.json.resource-probe"}} {{index .Config.Labels "corten.json.resource-probe-attempt"}}' ]] || return 98
        printf 'inspect:%s\n' "$5" >&2
        case "$MODE" in
          inspectDelayed|ackInspectDelayed) if (( _waits < 3 )); then return 124; fi ;;
          inspectUnavailable) return 124 ;;
          cleanupDelayed|cleanupDelayedMismatch) if (( _probed && !_waits )); then return 124; fi ;;
          cleanupUnavailable) if (( _probed )); then return 124; fi ;;
          rmTimeoutBudget) if (( _probed && !_waits )); then return 124; fi ;;
          rmTimeoutLate) if (( _probed && _waits < 3 )); then return 124; fi ;;
          rmTimeoutRecheckUnavailable) if (( _removed )); then return 124; fi ;;
          rmTimeoutRecheckGone) if (( _removed )); then : > .removal-finished; return 1; fi ;;
          changed|ambiguousAfterRetry|malformedAfterRetry|wrongIdAfterRetry) if (( _waits == 0 )); then return 124; fi ;;
        esac
        if [[ "$MODE" == wrongId || "$MODE" == wrongIdAfterRetry ]]; then
          printf '%s 1 %s\n' "$_foreign" "$ATTEMPT"
        elif [[ "$5" == "$_foreign" ]] || { (( _probed )) && [[ "$MODE" == cleanupMismatch || "$MODE" == cleanupDelayedMismatch ]]; } ||
          { (( _removed )) && [[ "$MODE" == rmTimeoutForeign ]]; }; then
          printf '%s 1 foreign-attempt\n' "$5"
        else
          printf '%s 1 %s\n' "$_owned" "$ATTEMPT"
        fi
        ;;
      rm)
        printf 'remove:%s\n' "$4" >&2
        [[ "$*" == "rm -f -v $_owned" && "$MODE" != removeFailed ]] || return 98
        if (( !_removed )); then [[ "$_bound" == 10s ]] || return 98
        else [[ "$_bound" == 4s ]] || return 98
        fi
        _removed=$((_removed + 1))
        if [[ "$MODE" == rmTimeout* ]] && { (( _removed == 1 )) || [[ "$MODE" == rmTimeoutRetryGone || "$MODE" == rmTimeoutStill || "$MODE" == rmTimeoutBudget ]]; }; then
          return 124
        fi
        ;;
      *) return 98 ;;
    esac
  }
`;
const resourceProbeBash = process.env.CORTEN_TEST_BASH ?? (process.platform === "linux" ? "/bin/bash" : null);
test("the synthetic JSON resource probe settles cleanup without removing foreign containers", { skip: !resourceProbeBash }, async (t) => {
  const step = workflow.jobs.kernel.steps.find((s) => s.name === "Prove bracketed JSON resource reads on a synthetic Docker participant");
  const owned = "1".padStart(64, "0"), foreign = "2".padStart(64, "0");
  const inspect = `inspect:${owned}`, inspectForeign = `inspect:${foreign}`, remove = `remove:${owned}`, probe = `probe:${owned}`, census = `census:${owned}`;
  const refused = "Synthetic JSON resource probe cleanup could not confirm one owned container";
  const unresolved = "Synthetic JSON resource probe cleanup could not settle removal";
  const fullSearch = Array(4).fill(["lookup", inspect]).flat();
  const rmTimeout = [inspect, probe, inspect, remove, census];
  const cases = [
    ["ok", 0, [inspect, probe, inspect, remove]],
    ["probeFailed", 1, [inspect, probe, inspect, remove]],
    ["removeFailed", 1, [inspect, probe, inspect, remove]],
    ["rmTimeoutGone", 0, rmTimeout],
    ["rmTimeoutRetry", 0, [...rmTimeout, inspect, remove]],
    ["rmTimeoutRetryGone", 0, [...rmTimeout, inspect, remove, census]],
    ["rmTimeoutStill", 1, [...rmTimeout, inspect, remove, census, unresolved]],
    ["rmTimeoutForeign", 1, [...rmTimeout, inspect, unresolved]],
    ["rmTimeoutUnknown", 1, [...rmTimeout, unresolved]],
    ["rmTimeoutMalformed", 1, [...rmTimeout, unresolved]],
    ["rmTimeoutBlank", 1, [...rmTimeout, unresolved]],
    ["rmTimeoutRecheckUnavailable", 1, [...rmTimeout, inspect, census, unresolved]],
    ["rmTimeoutRecheckGone", 0, [...rmTimeout, inspect, census]],
    ["rmTimeoutBudget", 1, [inspect, probe, inspect, inspect, remove, census, inspect, remove, census, unresolved], 173],
    ["rmTimeoutLate", 1, [inspect, probe, ...Array(4).fill(inspect), remove, census, unresolved], 170],
    ["cleanupDelayed", 0, [inspect, probe, inspect, inspect, remove], 154],
    ["cleanupMismatch", 1, [inspect, probe, inspect, refused]],
    ["cleanupDelayedMismatch", 1, [inspect, probe, inspect, inspect, refused]],
    ["cleanupUnavailable", 1, [inspect, probe, ...Array(4).fill(inspect), refused], 154],
    ["foreignAck", 1, [inspectForeign, refused]],
    ["lost", 124, ["lookup", "lookup", "lookup", inspect, remove]],
    ["inspectDelayed", 124, [...fullSearch, remove], 145],
    ["ackInspectDelayed", 1, [inspect, ...Array(4).fill(inspect), remove], 134],
    ["inspectUnavailable", 124, [...fullSearch, refused], 133],
    ...["changed", "ambiguousAfterRetry", "malformedAfterRetry"].map((mode) => [mode, 124, ["lookup", inspect, "lookup", refused]]),
    ["wrongIdAfterRetry", 124, ["lookup", inspect, "lookup", inspect, refused]],
    ["absent", 124, [...Array(4).fill("lookup"), refused]],
    ["lookupFailed", 124, [...Array(4).fill("lookup"), refused]],
    ["short", 124, ["lookup", refused]],
    ["multiple", 124, ["lookup", refused]],
    ["foreign", 124, ["lookup", inspectForeign, refused]],
    ["wrongId", 124, ["lookup", inspect, refused]],
  ];
  for (const [mode, status, trace, budget] of cases) {
    await t.test(mode, () => {
      const scratch = mode === "rmTimeoutRecheckGone" ? mkdtempSync(join(tmpdir(), "corten-resource-rm-")) : null;
      if (scratch) t.after(() => rmSync(scratch, { recursive: true, force: true }));
      const result = spawnSync(resourceProbeBash, ["-e", "-o", "pipefail", "-s"], {
        input: resourceProbeMocks + step.run, cwd: scratch ?? root,
        env: { ...process.env, MODE: mode, ATTEMPT: randomUUID() }, encoding: "utf8", timeout: 5000, windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stderr);
      const lines = result.stderr.trim().split(/\r?\n/), budgetLines = lines.filter((line) => line.startsWith("budget:"));
      assert.deepEqual(lines.filter((line) => !line.startsWith("budget:")), ["create", ...trace]);
      const boundedSeconds = budgetLines.reduce((sum, line) => sum + Number(line.slice(7)), 0);
      assert.ok(boundedSeconds < 60 * step["timeout-minutes"], "no time left for the shell and UUID generation");
      if (budget !== undefined) assert.equal(boundedSeconds, budget);
    });
  }
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

test("the Docker Hub cache helper refuses to write a config outside a GitHub-hosted runner (#1499)", () => {
  const dir = mkdtempSync(join(tmpdir(), "corten-mirror-guard-"));
  try {
    const config = join(dir, "daemon.json");
    const cli = fileURLToPath(new URL("scripts/ci-docker-hub-mirror.mjs", root));
    for (const env of [{}, { RUNNER_ENVIRONMENT: "self-hosted", CI: "true" }, { RUNNER_ENVIRONMENT: "github-hosted" }]) {
      const result = spawnSync(process.execPath, [cli, config], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
      assert.notEqual(result.status, 0, JSON.stringify(env));
      assert.match(result.stderr, /refusing to change Docker's configuration outside a GitHub-hosted runner/);
      assert.equal(existsSync(config), false, JSON.stringify(env));
    }
    const hosted = spawnSync(process.execPath, [cli, config], { encoding: "utf8",
      env: { PATH: process.env.PATH, RUNNER_ENVIRONMENT: "github-hosted", CI: "true" } });
    assert.equal(hosted.status, 0, hosted.stderr);
    assert.equal(hosted.stdout, "changed\n");
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8"))["registry-mirrors"], [mirror]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kernel job points the runner's Docker at Docker Hub's cache before the driver pulls, and the driver pulls Hub's reference (#1499)", () => {
  const steps = workflow.jobs.kernel.steps;
  const at = steps.findIndex((s) => s.run?.includes("scripts/ci-docker-hub-mirror.sh"));
  const driver = steps.findIndex((s) => s.run?.includes("scripts/benchmark-kernel-ci.sh"));
  assert.ok(at >= 0 && driver > at, "the mirror step must run before the kernel driver");
  // sudo's env_reset drops RUNNER_ENVIRONMENT and CI, which the script's guard requires, so the
  // step passes exactly those two and nothing else (not sudo -E).
  assert.equal(
    steps[at].run,
    'sudo env RUNNER_ENVIRONMENT="$RUNNER_ENVIRONMENT" CI="$CI" /bin/bash scripts/ci-docker-hub-mirror.sh "$(command -v node)"',
  );
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
  for (const bad of ["", "{", "{} {}", "[]", "null", "3", '{"registry-mirrors":"https://mirror.gcr.io"}', '{"registry-mirrors":[1]}',
    '{"registry-mirrors":null}', '{"debug":true,"registry-mirrors":null}'])
    assert.throws(() => withMirror(bad), bad);
});

test("Docker Hub cache merge writes the daemon config only when it adds the mirror, and refuses bad configs untouched", () => {
  const folder = mkdtempSync(join(tmpdir(), "corten-docker-mirror-"));
  try {
    const configs = join(folder, "docker");
    mkdirSync(configs);
    const absent = join(configs, "absent", "daemon.json");
    assert.equal(addMirror(absent), true);
    assert.deepEqual(JSON.parse(readFileSync(absent, "utf8")), { "registry-mirrors": [mirror] });
    const existing = join(configs, "existing.json");
    writeFileSync(existing, '{"exec-opts":["native.cgroupdriver=cgroupfs"],"registry-mirrors":["https://cache.example"]}');
    assert.equal(addMirror(existing), true);
    const merged = readFileSync(existing, "utf8");
    assert.deepEqual(JSON.parse(merged), { "exec-opts": ["native.cgroupdriver=cgroupfs"], "registry-mirrors": ["https://cache.example", mirror] });
    assert.equal(addMirror(existing), false);
    assert.equal(readFileSync(existing, "utf8"), merged, "a second run leaves the file as it is");
    for (const [name, text] of [["malformed.json", '{"exec-opts": ['], ["null.json", '{"registry-mirrors":null}'], ["string.json", '{"registry-mirrors":"x"}']]) {
      const path = join(configs, name);
      writeFileSync(path, text);
      assert.throws(() => addMirror(path), name);
      assert.equal(readFileSync(path, "utf8"), text);
    }
    mkdirSync(join(configs, "directory.json"));
    assert.throws(() => addMirror(join(configs, "directory.json")), /not a regular file/);
    assert.deepEqual(readdirSync(configs).sort(), ["absent", "directory.json", "existing.json", "malformed.json", "null.json", "string.json"],
      "no staged file is left");
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true });
  }
});

test("Docker Hub cache merge removes its staged file when publishing fails", () => {
  const folder = mkdtempSync(join(tmpdir(), "corten-docker-mirror-publish-"));
  try {
    const target = join(folder, "daemon.json");
    mkdirSync(join(target, "occupied"), { recursive: true });
    assert.throws(() => publish(target, Buffer.from("{}\n"), { mode: 0o644, uid: 0, gid: 0 }));
    assert.deepEqual(readdirSync(folder), ["daemon.json"], "the staged file is removed");
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true });
  }
});

/**
 * Runs scripts/ci-docker-hub-mirror.sh against stand-in systemctl and docker on PATH, which
 * record their calls; docker info lists what the test says the daemon loaded.
 */
function mirrorStep() {
  const folder = mkdtempSync(join(tmpdir(), "corten-docker-mirror-step-"));
  const bin = join(folder, "bin"), state = join(folder, "state"), log = join(folder, "calls");
  mkdirSync(bin); mkdirSync(state);
  const stub = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\nstate='${state}'\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  stub("systemctl", `[[ "$*" == "reload docker" ]] || exit 3
[[ -e $state/reloadfail ]] && exit 1
exit 0`);
  // Each process a stand-in leaves running records its PID in state/pids.
  stub("docker", `if [[ -e $state/stuck ]]; then trap '' TERM; sleep 30 & echo $! >> "$state/pids"; wait $!; fi
if [[ -e $state/straggler ]]; then (trap '' TERM; exec sleep 30) & echo $! >> "$state/pids"; fi
[[ "$*" == *RegistryConfig.Mirrors* ]] && cat "$state/listed"; exit 0`);
  const stalledNode = stub("stalled-node", "trap '' TERM; sleep 30");
  const script = fileURLToPath(new URL("scripts/ci-docker-hub-mirror.sh", root));
  const flag = (name, on) => on ? writeFileSync(join(state, name), "") : rmSync(join(state, name), { force: true });
  /**
   * @param {string} config
   * @param {{ listed?: string, reloadFail?: boolean, stuck?: boolean, straggler?: boolean, node?: string, deadline?: number,
   *   umask?: string, hosted?: Record<string, string> }} [options]
   */
  const run = (config, options = {}) => {
    writeFileSync(join(state, "listed"), options.listed ?? "https://mirror.gcr.io/\n");
    flag("reloadfail", options.reloadFail); flag("stuck", options.stuck); flag("straggler", options.straggler);
    writeFileSync(log, ""); writeFileSync(join(state, "pids"), "");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI_DOCKER_MIRROR_DEADLINE: String(options.deadline ?? 2) };
    delete env.RUNNER_ENVIRONMENT; delete env.CI;
    Object.assign(env, options.hosted ?? { RUNNER_ENVIRONMENT: "github-hosted", CI: "true" });
    const started = performance.now();
    const result = spawnSync("/bin/bash", ["-c", `umask ${options.umask ?? "022"}; exec /bin/bash "$0" "$@"`, script,
      options.node ?? process.execPath, config], { encoding: "utf8", timeout: 60000, env });
    assert.equal(result.error, undefined);
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, seconds: (performance.now() - started) / 1000,
      calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
      pids: readFileSync(join(state, "pids"), "utf8").split("\n").filter(Boolean).map(Number) };
  };
  const cleanup = () => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true }); };
  return { folder, run, cleanup, stalledNode };
}

const linuxShell = { skip: process.platform !== "linux" && "requires the Linux CI shell" };
const root0 = process.getuid?.() === 0;
const info = "docker info --format {{range .RegistryConfig.Mirrors}}{{println .}}{{end}}";
// The deadline, the 2 s kill grace and process start-up on a busy test host.
const bound = (deadline) => deadline + 2 + 1.5;
/** Whether each process has exited (a zombie waiting for its reaper counts), waiting up to a second for a KILL to land. */
const exited = (pids) => {
  const gone = (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat[stat.lastIndexOf(")") + 2] === "Z";
    } catch { return true; }
  };
  const until = performance.now() + 1000;
  while (!pids.every(gone) && performance.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  return pids.every(gone);
};

test("Docker Hub cache step reloads Docker once for a change, never restarts it, and checks Docker lists the mirror", linuxShell, () => {
  const { folder, run, cleanup } = mirrorStep();
  try {
    const config = join(folder, "docker", "daemon.json");
    const first = run(config);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.calls, ["systemctl reload docker", info]);
    assert.match(first.stdout, /lists https:\/\/mirror\.gcr\.io among its registry mirrors/);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { "registry-mirrors": [mirror] });
    const again = run(config, { listed: "https://cache.example\nhttps://mirror.gcr.io\n" });
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(again.calls, [info], "an unchanged config does not reload Docker");
  } finally { cleanup(); }
});

test("Docker Hub cache step fails when the reload fails, without checking or retrying", linuxShell, () => {
  const { folder, run, cleanup } = mirrorStep();
  try {
    const refused = run(join(folder, "daemon.json"), { reloadFail: true });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /systemctl reload docker failed/);
    assert.deepEqual(refused.calls, ["systemctl reload docker"]);
  } finally { cleanup(); }
});

test("Docker Hub cache step fails within its deadline when Docker never lists the mirror", linuxShell, () => {
  const { folder, run, cleanup } = mirrorStep();
  try {
    const config = join(folder, "daemon.json");
    for (const listed of ["", "https://cache.example/\n", "https://mirror.gcr.io.example/\n", "xhttps://mirror.gcr.io\n"]) {
      const result = run(config, { listed });
      assert.notEqual(result.status, 0, listed);
      assert.match(result.stderr, /does not list https:\/\/mirror\.gcr\.io as a registry mirror within 2 s/, listed);
      assert.ok(result.calls.includes(info) && !result.calls.some((call) => /restart|stop|start /.test(call)), result.calls.join("\n"));
      assert.ok(result.seconds < bound(2), `took ${result.seconds} s`);
    }
  } finally { cleanup(); }
});

test("Docker Hub cache step gives up at its deadline on a Docker client or helper that ignores TERM", linuxShell, () => {
  const { folder, run, cleanup, stalledNode } = mirrorStep();
  try {
    const stuck = run(join(folder, "daemon.json"), { stuck: true, deadline: 3 });
    assert.notEqual(stuck.status, 0);
    assert.match(stuck.stderr, /within 3 s/);
    assert.ok(stuck.seconds >= 2.5 && stuck.seconds < bound(3), `took ${stuck.seconds} s`);
    assert.equal(stuck.pids.length, 1);
    assert.ok(exited(stuck.pids), "the client's TERM-ignoring child does not outlive the step");
    const config = join(folder, "stalled.json");
    const stalled = run(config, { node: stalledNode, deadline: 2 });
    assert.notEqual(stalled.status, 0);
    assert.match(stalled.stderr, /did not add the mirror/);
    assert.ok(stalled.seconds < bound(2), `took ${stalled.seconds} s`);
    assert.equal(stalled.calls.length, 1, "nothing reloads or queries Docker after a stalled write");
    assert.ok(stalled.calls[0].startsWith("stalled-node ") && stalled.calls[0].endsWith(` ${config}`), stalled.calls[0]);
    assert.ok(!existsSync(config), "the stalled write published nothing");
  } finally { cleanup(); }
});

test("Docker Hub cache step kills what a Docker client leaves running, so the client's output ends when it exits", linuxShell, () => {
  const { folder, run, cleanup } = mirrorStep();
  try {
    const left = run(join(folder, "daemon.json"), { straggler: true });
    assert.equal(left.status, 0, left.stderr);
    assert.ok(left.seconds < bound(2), `took ${left.seconds} s`);
    assert.equal(left.pids.length, 1);
    assert.ok(exited(left.pids), "the TERM-ignoring process the client left behind is gone");
  } finally { cleanup(); }
});

test("Docker Hub cache step refuses to run outside a GitHub-hosted runner, before writing or calling anything", linuxShell, () => {
  const { folder, run, cleanup } = mirrorStep();
  try {
    const config = join(folder, "docker", "daemon.json");
    for (const hosted of [{}, { CI: "true" }, { RUNNER_ENVIRONMENT: "github-hosted" }, { RUNNER_ENVIRONMENT: "self-hosted", CI: "true" },
      { RUNNER_ENVIRONMENT: "github-hosted", CI: "1" }]) {
      const result = run(config, { hosted });
      assert.notEqual(result.status, 0, JSON.stringify(hosted));
      assert.match(result.stderr, /outside a GitHub-hosted runner/);
      assert.deepEqual(result.calls, [], JSON.stringify(hosted));
      assert.ok(!existsSync(join(folder, "docker")), "nothing is written");
    }
  } finally { cleanup(); }
});

test("Docker Hub cache step keeps the config's owner and mode under a restrictive umask", linuxShell, () => {
  const { folder, run, cleanup } = mirrorStep();
  try {
    const config = join(folder, "daemon.json");
    writeFileSync(config, "{}\n");
    if (root0) chownSync(config, 65534, 65534);
    chmodSync(config, 0o664);
    const kept = run(config, { umask: "077" });
    assert.equal(kept.status, 0, kept.stderr);
    const stat = statSync(config);
    assert.equal(stat.mode & 0o7777, 0o664);
    if (root0) assert.deepEqual([stat.uid, stat.gid], [65534, 65534]);
    const fresh = join(folder, "fresh.json");
    const created = run(fresh, { umask: "077" });
    assert.equal(created.status, 0, created.stderr);
    const made = statSync(fresh);
    assert.equal(made.mode & 0o7777, 0o644);
    if (root0) assert.deepEqual([made.uid, made.gid], [0, 0]);
    assert.deepEqual(readdirSync(folder).filter((name) => name.endsWith(".tmp")), []);
  } finally { cleanup(); }
});

test("Docker Hub cache step refuses a symlinked, malformed or explicitly null config before touching Docker", linuxShell, () => {
  const { folder, run, cleanup } = mirrorStep();
  try {
    const target = join(folder, "target.json"), link = join(folder, "daemon.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, link);
    const linked = run(link);
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /symbolic link/);
    assert.deepEqual(linked.calls, []);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readFileSync(target, "utf8"), "{}\n");
    for (const text of ["{", '{"registry-mirrors":null}', '{"registry-mirrors":"https://mirror.gcr.io"}']) {
      const path = join(folder, "refused.json");
      writeFileSync(path, text);
      const refused = run(path);
      assert.notEqual(refused.status, 0, text);
      assert.deepEqual(refused.calls, [], `${text} stops the step before Docker is touched`);
      assert.equal(readFileSync(path, "utf8"), text);
    }
  } finally { cleanup(); }
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
