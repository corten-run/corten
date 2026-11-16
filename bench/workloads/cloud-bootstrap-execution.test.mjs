import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { remoteFiles, reservation } from "./cloud-contract.mjs";
import { remoteFiles as productionFiles } from "./cloud-remote.mjs";

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
