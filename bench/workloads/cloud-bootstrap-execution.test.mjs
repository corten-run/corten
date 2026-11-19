import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fleetPlan, remoteFiles, reservation } from "./cloud-contract.mjs";
import { guardianSha256 } from "./cloud-control-runtime.mjs";
import { remoteFiles as productionFiles } from "./cloud-remote.mjs";
import { groupNames } from "./registry.mjs";

const state = reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" });
const job = remoteFiles(state)["job.sh"];
const units = ["fwupd.service", "fwupd-refresh.service", "fwupd-refresh.timer"];

function execute(t, { failed = [], active, load = "masked", pid = "0", resetFails = false,
  resetLoad = load, resetPid = pid, resetActive = "inactive", queryFailAfter = "", script = job } = {}) {
  const start = script.indexOf("for unit in fwupd.service fwupd-refresh.service fwupd-refresh.timer; do");
  const end = script.indexOf("# The entry derives", start);
  assert.ok(start >= 0 && end > start);
  const preflight = script.slice(start, end);
  const root = mkdtempSync(join(tmpdir(), "corten-bootstrap-units-")); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const unit of units) writeFileSync(join(root, unit), failed.includes(unit) ? "failed" : active ?? "inactive");
  const shim = join(root, "systemctl");
  writeFileSync(shim, `#!/bin/sh
set -eu
case "$2" in fwupd.service|fwupd-refresh.service|fwupd-refresh.timer) ;; *) exit 91 ;; esac
case "$1" in
show)
  case "$3" in
    --property=LoadState) if test -e "$TEST_ROOT/reset-$2"; then printf '%s\\n' "$TEST_RESET_LOAD"; else printf '%s\\n' "$TEST_LOAD"; fi ;;
    --property=ActiveState) cat "$TEST_ROOT/$2" ;;
    --property=MainPID) if test -e "$TEST_ROOT/reset-$2"; then printf '%s\\n' "$TEST_RESET_PID"; else printf '%s\\n' "$TEST_PID"; fi ;;
    *) exit 92 ;;
  esac
  if test -e "$TEST_ROOT/reset-$2" && test "$TEST_QUERY_FAIL" = "$3"; then exit 37; fi ;;
reset-failed)
  printf '%s\\n' "$2" >> "$TEST_ROOT/resets"
  test "$TEST_RESET_FAILS" = no
  printf '%s\\n' "$TEST_RESET_ACTIVE" > "$TEST_ROOT/$2"
  touch "$TEST_ROOT/reset-$2" ;;
*) exit 93 ;;
esac
`, { mode: 0o700 });
  const env = { PATH: `${root}:/usr/bin:/bin`, HOME: root, LANG: "C", TEST_ROOT: root,
      TEST_LOAD: load, TEST_PID: pid, TEST_RESET_FAILS: resetFails ? "yes" : "no",
      TEST_RESET_LOAD: resetLoad, TEST_RESET_PID: resetPid, TEST_RESET_ACTIVE: resetActive,
      TEST_QUERY_FAIL: queryFailAfter };
  const fixture = spawnSync(shim, ["show", units[0], "--property=LoadState", "--value"], {
    cwd: root, env, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
  });
  assert.equal(fixture.error, undefined, "systemctl fixture must be executable; never fall back to the real host service");
  assert.equal(fixture.status, 0); assert.equal(fixture.stdout, `${load}\n`);
  const result = spawnSync("/bin/bash", ["-c", `set -Eeuo pipefail\n${preflight}\nprintf 'NATIVE_ENTRY_REACHED\\n'`], {
    cwd: root, env,
    encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  const resetPath = join(root, "resets");
  return { ...result, resets: existsSync(resetPath) ? readFileSync(resetPath, "utf8").trim().split("\n") : [] };
}

test("firmware preflight accepts inactive masked services without resetting them", { skip: process.platform !== "linux" }, t => {
  const result = execute(t); assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.resets, []);
});
for (const unit of units) test(`firmware preflight normalizes only stopped masked failed ${unit}`, { skip: process.platform !== "linux" }, t => {
  const result = execute(t, { failed: [unit] });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.resets, [unit]);
  assert.match(result.stdout, /firmware unit=/);
});
for (const active of ["active", "activating", "deactivating"]) test(`firmware preflight refuses ${active} units before reset`, { skip: process.platform !== "linux" }, t => {
  const result = execute(t, { active }); assert.notEqual(result.status, 0); assert.deepEqual(result.resets, []);
});
test("firmware preflight refuses unmasked stopped failed service before reset", { skip: process.platform !== "linux" }, t => {
  const result = execute(t, { load: "loaded", failed: [units[0]] });
  assert.notEqual(result.status, 0); assert.deepEqual(result.resets, []);
});
test("firmware preflight refuses a nonzero service PID even when inactive", { skip: process.platform !== "linux" }, t => {
  const result = execute(t, { pid: "42" }); assert.notEqual(result.status, 0); assert.deepEqual(result.resets, []);
});
test("firmware preflight preserves reset failure", { skip: process.platform !== "linux" }, t => {
  const result = execute(t, { failed: [units[0]], resetFails: true }); assert.notEqual(result.status, 0);
});
for (const [name, options] of Object.entries({
  "lost mask": { resetLoad: "loaded" }, "live PID": { resetPid: "42" },
  "failed state": { resetActive: "failed" }, "active state": { resetActive: "active" },
})) test(`firmware preflight independently refuses ${name} after reset`, { skip: process.platform !== "linux" }, t => {
  const result = execute(t, { failed: [units[0]], ...options });
  assert.notEqual(result.status, 0); assert.deepEqual(result.resets, [units[0]]);
});
for (const [name, script] of [["contract", job], ["production", productionFiles(state)["job.sh"]]]) {
  for (const property of ["LoadState", "ActiveState", "MainPID"]) {
    test(`${name} preserves post-reset ${property} query failure with expected stdout`, { skip: process.platform !== "linux" }, t => {
      const result = execute(t, { failed: [units[0]], queryFailAfter: `--property=${property}`, script });
      assert.equal(result.status, 37);
      assert.ok(!result.stdout.includes("NATIVE_ENTRY_REACHED"));
    });
  }
  test(`${name} job failure diagnostics identify stage and line without dumping the command or environment`, { skip: process.platform !== "linux" }, () => {
    const start = script.indexOf("bootstrap_error()"), trap = script.indexOf("trap 'bootstrap_error", start);
    assert.ok(start >= 0 && trap > start, "generated job must retain bounded failure diagnostics");
    const end = script.indexOf("\n", trap);
    const result = spawnSync("/bin/bash", ["-c", `set -Eeuo pipefail\nbootstrap_stage=source-cleanliness\n${script.slice(start, end)}\nfalse`], {
      env: { PATH: "/usr/bin:/bin", PRIVATE_TEST_SENTINEL: "must-not-appear" },
      encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
    });
    assert.equal(result.status, 1); assert.match(result.stderr, /stage=source-cleanliness line=[0-9]+ exit=1/);
    assert.ok(!result.stderr.includes("must-not-appear") && !result.stderr.includes("BASH_COMMAND"));
  });
}
test("production job names the final preparation stages before native entry", () => {
  const job = productionFiles(state)["job.sh"];
  for (const [stage, command] of [["campaign-directory", "mkdir -m 700"],
    ["source-cleanliness", 'test -z "$(git status'], ["bootstrap-marker", "node --input-type=module -e"],
    ["native-entry", "node 'bench/workloads/isolated/campaign-entry.mjs'"]]) {
    assert.ok(job.includes(`bootstrap_stage=${stage}\n${command}`), `stage ${stage} must precede its command`);
  }
});

const tokens = Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")]));
const fleet = fleetPlan({ round: state.round, commit: state.commit, token: "f".repeat(16), tokens,
  provider: { accountId: "user:synthetic-fixture", context: "synthetic-fixture" }, sshKey: "42" });
const group = groupNames[0];
const dedicated = reservation({ round: state.round, commit: state.commit, token: tokens[group], group, fleet });
const ledger = { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: [] };
const control = { ...ledger, monitor: { schema: "benchmark-supervised-control/v1", id: "b".repeat(32), phase: "pending" } };
const supervised = { ...dedicated, control };
const binding = "/run/corten-bench-control-" + dedicated.token + "/binding.json";
const dropin = "/run/systemd/system/user@0.service.d/90-corten-benchmark.conf";
const policy = "[Unit]\nConditionPathExists=!" + binding + "\n";
const optOut = "unset BENCH_APPS BENCH_TIER BENCH_EDGE PROFILE\n";

function rootManagerStages(script) {
  const stages = [...script.matchAll(/^bootstrap_stage=([a-z-]+)$/gm)];
  function section(name, next) {
    const index = stages.findIndex((stage) => stage[1] === name);
    assert.ok(index >= 0, name);
    assert.equal(stages.filter((stage) => stage[1] === name).length, 1);
    assert.equal(stages[index + 1][1], next);
    return { offset: stages[index].index, shell: script.slice(stages[index].index, stages[index + 1].index) };
  }
  return [section("root-manager-policy", "firmware-mask"), section("root-manager-idle", "native-entry")];
}

function executeRootManager(t, script, { mode = "drain", marker = true, prior } = {}) {
  const root = mkdtempSync(join(tmpdir(), "corten-root-manager-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), path = join(root, dropin.slice(1));
  mkdirSync(bin);
  if (marker) {
    const file = join(root, binding.slice(1));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{}\n");
  }
  if (prior !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, prior);
  }
  symlinkSync("/bin/bash", join(bin, "bash"));
  symlinkSync("/usr/bin/mkdir", join(bin, "mkdir"));
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> trace
case "$*" in
  daemon-reload) test -f "$DROPIN"; if test "$MODE" = reload-failed; then exit 37; fi ;;
  "show user@0.service --property=ActiveState --value")
    case "$MODE" in
      drain|busy) if test -f drained; then echo inactive; else echo active; fi ;;
      active-query-failed) echo inactive; exit 38 ;;
      *) echo inactive ;;
    esac ;;
  "show user@0.service --property=MainPID --value")
    if test "$MODE" = nonzero-pid; then echo 42; else echo 0; fi
    if test "$MODE" = pid-query-failed; then exit 39; fi ;;
  *) exit 91 ;;
esac
`, { mode: 0o700 });
  // The first poll interval ends either in natural drain or the simulated deadline.
  writeFileSync(join(bin, "timeout"), `#!/bin/bash
set -eu
test "$1" = 120 && test "$2" = bash || exit 92
printf 'timeout %s\\n' "$1" >> trace
shift
sleep() {
  printf 'sleep %s\\n' "$1" >> trace
  if test "$MODE" = busy; then exit 124; fi
  : > drained
}
export -f sleep
exec "$@"
`, { mode: 0o700 });
  const shell = rootManagerStages(script).map((stage) => stage.shell).join("");
  // Only the two extracted stages run. Redirect their paths into the fixture,
  // except the literal condition written into the drop-in.
  assert.doesNotMatch(shell, /\/(?:usr\/)?(?:s?bin|etc)\//);
  const result = spawnSync("/bin/bash", ["-c", "set -Eeuo pipefail\n" +
    shell.replace(/(?<!!)\/run\//g, "./run/") + "printf 'NATIVE_ENTRY_REACHED\\n'\n"], {
    cwd: root, env: { PATH: bin, LANG: "C", MODE: mode, DROPIN: "." + dropin },
    encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  const trace = join(root, "trace");
  const calls = existsSync(trace) ? readFileSync(trace, "utf8").trimEnd().split("\n") : [];
  assert.ok(calls.every((call) => /^(daemon-reload|timeout 120|sleep 1|show user@0\.service --property=(ActiveState|MainPID) --value)$/.test(call)), calls.join("\n"));
  return { ...result, calls, contents: existsSync(path) ? readFileSync(path, "utf8") : null };
}

for (const [name, generate] of [["contract", remoteFiles], ["production", productionFiles]]) {
  test(name + " limits root-manager stages to supervised groups and orders them before the actual native command", () => {
    for (const plain of [state, { ...state, control }, dedicated, { ...dedicated, control: ledger }]) {
      assert.doesNotMatch(generate(plain)["job.sh"], /root-manager-(policy|idle)|user@0\.service|90-corten-benchmark/);
    }
    const script = generate(supervised)["job.sh"];
    const [install, idle] = rootManagerStages(script);
    const unset = script.indexOf(optOut);
    assert.ok(install.offset < unset && unset + optOut.length === idle.offset);
    const entries = [...script.matchAll(/^node '?bench\/workloads\/isolated\/campaign-entry\.mjs'? /gm)];
    assert.equal(entries.length, 1);
    const entry = entries[0].index;
    assert.ok(script.slice(idle.offset + idle.shell.length, entry).endsWith("bootstrap_stage=native-entry\n"));
    if (name === "production") {
      const marker = script.indexOf('writeFileSync("/bench/bootstrap-ready.json"');
      assert.ok(idle.offset + idle.shell.length <= marker && marker < entry);
    }
  });

  test(name + " installs only the runtime condition and waits for natural drain", { skip: process.platform !== "linux" }, (t) => {
    const result = executeRootManager(t, generate(supervised)["job.sh"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "NATIVE_ENTRY_REACHED\n");
    assert.equal(result.contents, policy);
    assert.deepEqual(result.calls, ["daemon-reload", "timeout 120", "show user@0.service --property=ActiveState --value",
      "sleep 1", "show user@0.service --property=ActiveState --value", "show user@0.service --property=MainPID --value"]);
  });
}

test("root-manager preparation fails closed without overwriting policy or stopping busy services", {
  skip: process.platform !== "linux",
}, (t) => {
  const script = productionFiles(supervised)["job.sh"];
  for (const [options, status, contents, last] of [
    [{ marker: false }, 1, null, undefined],
    [{ prior: "existing policy\n" }, 1, "existing policy\n", undefined],
    [{ mode: "reload-failed" }, 37, policy, "daemon-reload"],
    [{ mode: "busy" }, 124, policy, "sleep 1"],
    [{ mode: "active-query-failed" }, 38, policy, "show user@0.service --property=ActiveState --value"],
    [{ mode: "nonzero-pid" }, 1, policy, "show user@0.service --property=MainPID --value"],
    [{ mode: "pid-query-failed" }, 39, policy, "show user@0.service --property=MainPID --value"],
  ]) {
    const result = executeRootManager(t, script, options);
    assert.equal(result.status, status, JSON.stringify(options) + ": " + result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.contents, contents);
    assert.equal(result.calls.at(-1), last);
  }
});
