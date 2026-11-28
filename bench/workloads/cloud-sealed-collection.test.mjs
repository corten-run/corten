import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reservation, terminalUnit } from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";
import { idleArchiveScript, r21Validator, sealedUnit } from "./cloud-sealed-collection.mjs";

const s = { ...reservation({ commit: "a".repeat(40), round: "r21", token: "1".repeat(16) }), id: "123" };
function scratch(t) {
  const prefix = join(tmpdir(), "sealed-collection-"), dir = mkdtempSync(prefix);
  t.after(() => { assert.ok(dir.startsWith(prefix)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
test("the expired property set is not ordinary terminal proof", () => {
  const output = `Id=${s.unit}\nLoadState=loaded\nFragmentPath=/etc/systemd/system/${s.unit}\nRestart=no\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=\nExecMainCode=0\nExecMainStartTimestamp=\n`;
  assert.throws(() => terminalUnit(output, s)); assert.equal(sealedUnit(output, s), "expired");
  assert.equal(sealedUnit(output.replace("Code=0", "Code=1").replace("Timestamp=\n", "Timestamp=started\n"), s), "terminal");
  for (const [before, after] of [["LoadState=loaded", "LoadState=not-found"], ["Restart=no", "Restart=always"],
    ["FragmentPath=/etc", "FragmentPath=/run"], ["MainPID=0", "MainPID=1"], ["SubState=dead", "SubState=running"],
    ["ControlPID=0", "ControlPID=1"], ["Job=\n", ""], ["Job=\n", "Job=42\n"], ["ExecMainStartTimestamp=\n", ""]])
    assert.throws(() => sealedUnit(output.replace(before, after), s));
  assert.equal(sealedUnit(output.replace("ActiveState=inactive", "ActiveState=activating"), s), false);
});

test("a different measured adapter is refused before import", async t => {
  const root = scratch(t), dir = join(root, "bench/workloads"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cloud-validation-snapshot.mjs"), "throw new Error('executed mutable source');");
  await assert.rejects(r21Validator(root), /original r21 replay adapter required/);
});

test("idle proof checks current work and hashes an existing archive without packing", { skip: process.platform !== "linux" }, t => {
  const temp = scratch(t), boot = "01234567-89ab-cdef-0123-456789abcdef";
  const write = (path, bytes) => writeFileSync(join(temp, path), bytes);
  for (const dir of ["proc/1", "cg", "system"]) mkdirSync(join(temp, dir), { recursive: true });
  write("boot", boot); write("proc/1/cmdline", "init"); write("cg/cgroup.events", "populated 0\n");
  write("system/" + s.unit, "unit"); write("results.tgz", "exit archive");
  const script = (pack, stamp) => idleArchiveScript(s, boot, digest("unit"), { pack, stamp }).replaceAll("/etc/systemd/system", temp + "/system")
    .replace("timeout 600 /bin/bash /bench/pack.sh", `echo packed >> '${temp}/packs'; echo reconstructed > '${temp}/results.tgz'`)
    .replace("/proc/sys/kernel/random/boot_id", temp + "/boot").replace("Path('/proc')", `Path('${temp}/proc')`)
    .replace("/sys/fs/cgroup/system.slice/" + s.unit, temp + "/cg").replaceAll("/bench/results.tgz", temp + "/results.tgz")
    .replaceAll("/run/docker.sock", temp + "/absent-docker").replaceAll("/run/containerd/containerd.sock", temp + "/absent-containerd");
  const probe = (jobs = "", pack = false, stamp) => spawnSync("bash", ["-s"], { input: `set -euo pipefail
hostname() { echo '${s.name}'; }
curl() { echo '${s.id}'; }
systemctl() { echo '${jobs}'; }
${script(pack, stamp)}`, encoding: "utf8", timeout: 5000 });
  const yes = probe(); assert.equal(yes.status, 0, yes.stderr); assert.ok(yes.stdout.startsWith(digest("exit archive")));
  const stamp = yes.stdout.split("\n")[1].slice(0, 64); assert.match(stamp, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(script(false, stamp), /sha256sum <&3|sha256sum .*results\.tgz/);
  assert.equal(probe("", false, stamp).status, 0);
  write("results.tgz", "same length!"); assert.notEqual(probe("", false, stamp).status, 0);
  assert.notEqual(probe("pending").status, 0);
  write("cg/cgroup.events", "populated 1\n"); assert.notEqual(probe().status, 0); write("cg/cgroup.events", "populated 0\n");
  write("proc/1/cmdline", "/bin/bash\0/bench/job.sh"); assert.notEqual(probe().status, 0); write("proc/1/cmdline", "init");
  write("system/" + s.unit, "changed"); assert.notEqual(probe().status, 0); write("system/" + s.unit, "unit");
  rmSync(join(temp, "results.tgz")); assert.notEqual(probe().status, 0);
  assert.equal(probe("", true).status, 0); assert.ok(probe("", true).stdout.startsWith(digest("reconstructed\n")));
  assert.equal(readFileSync(join(temp, "packs"), "utf8"), "packed\n");
  rmSync(join(temp, "results.tgz")); symlinkSync("missing", join(temp, "results.tgz"));
  assert.notEqual(probe("", true).status, 0); assert.equal(readFileSync(join(temp, "packs"), "utf8"), "packed\n");
});
