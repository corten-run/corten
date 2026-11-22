import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { bootstrapWorkspaceScript, fleetPlan, remoteFiles, reservation } from "./cloud-contract.mjs";
import { controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { digest } from "./cloud-local.mjs";
import { remoteFiles as productionFiles } from "./cloud-remote.mjs";
import { settledBootstrap } from "./cloud-retirement.mjs";
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

function ingressState() {
  const saved = structuredClone(supervised);
  const workspace = bootstrapWorkspaceScript(saved, { launch: true });
  for (const [script, timeout] of [["true", 30000], [workspace, 60000]]) {
    const request = controlRequest(saved, "ssh", [script], timeout, "bootstrap");
    saved.control.ledger.push({ request, localTerminal: true, code: 0 });
  }
  return saved;
}

test("SSH ingress job replay requires the new, acknowledged dedicated workspace command", () => {
  const saved = ingressState();
  const script = productionFiles(saved)["job.sh"];
  const stages = ["package-services", "package-prerequisites", "ssh-ingress-install", "ssh-ingress-verification",
    "campaign-directory", "bootstrap-marker", "native-entry"].map((name) => script.lastIndexOf("bootstrap_stage=" + name + "\n"));
  assert.ok(stages.every((position, i) => position > (stages[i - 1] ?? 0)), String(stages));
  const historical = structuredClone(saved);
  historical.control.ledger.pop();
  historical.control.ledger.push({ request: controlRequest(historical, "ssh", [bootstrapWorkspaceScript(historical)], 60000, "bootstrap"),
    localTerminal: true, code: 0 });
  assert.equal(productionFiles(historical)["job.sh"], productionFiles(supervised)["job.sh"]);
  assert.doesNotMatch(productionFiles(historical)["job.sh"], /ssh-ingress/);
  for (const initial of [historical, saved]) {
    const partial = { ...initial, id: "123", ip: "192.0.2.10", status: "preparing", createIntentAt: "2026-11-18T00:00:00.000Z" };
    const jobHash = digest(productionFiles(partial)["job.sh"]);
    const paths = [join(tmpdir(), "job.sh"), "root@192.0.2.10:/bench/job.sh"];
    for (const [binary, args, deadline] of [
      ["scp", paths, 15 * 60000],
      ["ssh", [`printf '%s  %s\\n' '${jobHash}' '/bench/job.sh' | sha256sum --check --status`], 60000],
    ]) partial.control.ledger.push({ request: controlRequest(partial, binary, args, deadline, "bootstrap"), code: 0, localTerminal: true });
    assert.equal(settledBootstrap(partial, tmpdir()), true);
    partial.control.ledger[1].request.invocation.requestSha256 = "f".repeat(64);
    assert.equal(settledBootstrap(partial, tmpdir()), false);
  }
});

test("SSH ingress missing-nft bootstrap waits for the APT list lock and refuses a failed gate", {
  skip: process.platform !== "linux",
}, (t) => {
  const script = productionFiles(ingressState())["job.sh"];
  const start = script.indexOf("bootstrap_stage=package-services\n");
  const end = script.indexOf("bootstrap_stage=git-install\n", start);
  assert.ok(start >= 0 && end > start);
  // Run the generated stages, not the machine's package manager. Stub the
  // owner reader (tested separately with real SSH) and boot-local paths.
  const stages = script.slice(start, end)
    .replaceAll("/usr/sbin/nft", "mock_nft")
    .replace("/usr/bin/python3 -I -c", "mock_owner")
    .replaceAll("/run/corten-bench-ssh-ingress.nft", "./snapshot");
  const shims = String.raw`
set -euo pipefail
locked=1
nft_available=0
systemctl() {
  [[ "$*" == 'disable --now apt-daily.timer apt-daily-upgrade.timer' ]]
  printf '%s\n' timers-disabled
}
timeout() {
  case "$*" in
    '900 systemd-run '*|'900 apt-get '*) shift ;;
    '-k 5 90 apt-get '*|'-k 5 30 systemctl '*|'-k 5 15 mock_nft '*) shift 3 ;;
    *) exit 91 ;;
  esac
  "$@"
}
systemd-run() {
  [[ "$*" == '--quiet --property=After=apt-daily.service --property=After=apt-daily-upgrade.service --wait /bin/true' ]]
  [[ $locked == 1 ]]
  printf '%s\n' apt-gate
  if [[ $MODE == busy ]]; then return 124; fi
  locked=0
}
apt-get() {
  if [[ $locked == 1 ]]; then printf '%s\n' list-lock-contention >&2; return 100; fi
  case "$*" in
    'update -qq') printf '%s\n' update ;;
    'install -y -qq gnupg curl ca-certificates build-essential') printf '%s\n' prerequisites ;;
    *'install -y -qq --no-install-recommends --no-upgrade --no-remove nftables')
      printf '%s\n' nft-package; nft_available=1 ;;
    *) exit 92 ;;
  esac
}
test() {
  if [[ "$*" == '-x mock_nft' ]]; then [[ $nft_available == 1 ]]; else builtin test "$@"; fi
}
mock_owner() { printf '%s\n' 192.0.2.20; }
mock_nft() {
  [[ $nft_available == 1 ]]
  case "$*" in
    '-f -')
      while IFS= read -r line; do printf '%s\n' "$line"; done > transaction
      printf '%s\n' ingress-installed ;;
    '--numeric --stateless --handle list table inet corten_bench_ssh') printf '%s\n' snapshot ;;
    *) exit 93 ;;
  esac
}
`;
  for (const [mode, expected, calls] of [
    ["drain", 0, ["timers-disabled", "apt-gate", "update", "prerequisites", "nft-package", "ingress-installed"]],
    ["busy", 124, ["timers-disabled", "apt-gate"]],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "corten-ingress-apt-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const result = spawnSync("/bin/bash", ["-c", shims + stages], {
      cwd: root, env: { PATH: "", MODE: mode }, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split("\n"), calls);
    assert.equal(existsSync(join(root, "snapshot")), mode === "drain");
  }
});

function rootManagerStages(script, quiet = false) {
  const stages = [...script.matchAll(/^bootstrap_stage=([a-z-]+)$/gm)];
  function section(name, next) {
    const index = stages.findIndex((stage) => stage[1] === name);
    assert.ok(index >= 0, name);
    assert.equal(stages.filter((stage) => stage[1] === name).length, 1);
    assert.equal(stages[index + 1][1], next);
    return { offset: stages[index].index, shell: script.slice(stages[index].index, stages[index + 1].index) };
  }
  return quiet
    ? [section("root-manager-policy", "root-manager-idle"), section("root-manager-idle", "cloud-init")]
    : [section("root-manager-policy", "firmware-mask"), section("root-manager-idle", "native-entry")];
}

function executeRootManager(t, script, { mode = "drain", marker = true, prior, quiet = false } = {}) {
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
      active-query-timeout) exit 124 ;;
      invalid-state) echo secret-fixture ;;
      failed) echo failed ;;
      *) echo inactive ;;
    esac ;;
  "show user@0.service --property=MainPID --value")
    case "$MODE" in
      nonzero-pid|busy) echo 42 ;;
      invalid-pid) echo secret-fixture ;;
      *) echo 0 ;;
    esac
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
  const shell = rootManagerStages(script, quiet).map((stage) => stage.shell).join("");
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
      "show user@0.service --property=MainPID --value", "sleep 1", "show user@0.service --property=ActiveState --value",
      "show user@0.service --property=MainPID --value"]);
  });
}

test("new dedicated reservations drain before cloud-init without changing marker or native command", () => {
  const saved = ingressState();
  const original = productionFiles(saved)["job.sh"];
  const quiet = productionFiles({ ...saved, quietBootstrap: true })["job.sh"];
  rootManagerStages(quiet, true);
  assert.equal(quiet.slice(quiet.indexOf("bootstrap_stage=ssh-ingress-verification")),
    original.slice(original.indexOf("bootstrap_stage=ssh-ingress-verification")));
  for (const plain of [state, { ...state, control }, dedicated, { ...dedicated, control: ledger }])
    assert.throws(() => productionFiles({ ...plain, quietBootstrap: true }), /quiet bootstrap requires a supervised group/);
  assert.throws(() => productionFiles({ ...saved, quietBootstrap: false }), /quiet bootstrap requires a supervised group/);
});

test("new dedicated setup proceeds after natural drain but not with a busy manager", {
  skip: process.platform !== "linux",
}, (t) => {
  const quiet = true, script = productionFiles({ ...ingressState(), quietBootstrap: quiet })["job.sh"];
  const drained = executeRootManager(t, script, { quiet });
  assert.equal(drained.status, 0, drained.stderr);
  assert.equal(drained.stdout, "NATIVE_ENTRY_REACHED\n");
  assert.equal(drained.contents, policy);
  const busy = executeRootManager(t, script, { quiet, mode: "busy" });
  assert.equal(busy.status, 124, busy.stderr);
  assert.equal(busy.stdout, "");
  assert.match(busy.stderr, /ActiveState=active MainPID=42/);
});

test("root-manager preparation fails closed without overwriting policy or stopping busy services", {
  skip: process.platform !== "linux",
}, (t) => {
  const script = productionFiles(supervised)["job.sh"];
  assert.ok(script.includes("exec >>/bench/run.log 2>&1"));
  for (const [options, status, contents, last, diagnostic] of [
    [{ marker: false }, 1, null, undefined],
    [{ prior: "existing policy\n" }, 1, "existing policy\n", undefined],
    [{ mode: "reload-failed" }, 37, policy, "daemon-reload"],
    [{ mode: "busy" }, 124, policy, "sleep 1", "ActiveState=active MainPID=42"],
    [{ mode: "active-query-failed" }, 38, policy, "show user@0.service --property=ActiveState --value", "querying ActiveState"],
    [{ mode: "active-query-timeout" }, 124, policy, "show user@0.service --property=ActiveState --value", "querying ActiveState"],
    [{ mode: "invalid-state" }, 1, policy, "show user@0.service --property=ActiveState --value", "unexpected ActiveState"],
    [{ mode: "failed" }, 1, policy, "show user@0.service --property=MainPID --value", "ActiveState=failed MainPID=0"],
    [{ mode: "nonzero-pid" }, 1, policy, "show user@0.service --property=MainPID --value", "ActiveState=inactive MainPID=42"],
    [{ mode: "pid-query-failed" }, 39, policy, "show user@0.service --property=MainPID --value", "ActiveState=inactive; querying MainPID"],
    [{ mode: "invalid-pid" }, 1, policy, "show user@0.service --property=MainPID --value", "invalid MainPID"],
  ]) {
    const result = executeRootManager(t, script, options);
    assert.equal(result.status, status, JSON.stringify(options) + ": " + result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.contents, contents);
    assert.equal(result.calls.at(-1), last);
    if (diagnostic) assert.equal(result.stderr.trimEnd().split("\n").at(-1), "root-manager: " + diagnostic);
    assert.doesNotMatch(result.stderr, /secret-fixture/);
  }
});
