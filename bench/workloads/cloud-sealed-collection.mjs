// A terminal monitor is historical evidence, not proof the host is idle now.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { terminalUnit, unitProperties } from "./cloud-contract.mjs";
import { archiveLimit, digest, physical, regular } from "./cloud-local.mjs";
import { full } from "./cloud-options.mjs";

const measured = "4225a2837e04795c11c1b45b3d6af72b7eb5ddc3";
export function ownedR21(s) {
  assert.equal(s.round, "r21"); assert.equal(s.commit, measured);
  assert.equal(s.fleet.fleetSha256, "58b0f8443642ebecebe3b5ca436d84cda2f630dfcc5f166c3b69222a0a87a22f");
  assert.deepEqual(s.provider, s.fleet.provider);
  assert.ok(["running", "collected"].includes(s.status) && !s.retirement && !s.preBootstrapTerminal);
  assert.equal(s.control.monitor.phase, "closed");
  assert.ok(s.id && s.ip && s.createIntentAt && s.control.sealed.includes("bootstrap"));
}

// Use the measured checkout for Git, non-executable inputs and its original
// dependencies. Load only same-read, pinned adapter bytes; its imports are all
// Node builtins. Its own Git snapshot and deny-unlisted worker remain unchanged.
export async function r21Validator(root) {
  root = resolve(root);
  physical(root);
  const path = join(root, "bench/workloads/cloud-validation-snapshot.mjs");
  const source = regular(path, 1024 * 1024).toString("utf8").replaceAll("\r\n", "\n");
  assert.equal(digest(source), "3db828091de229ad63300fce2402d304eb0a9f9b2f92ab1cee090c2d7db12c1c", "original r21 replay adapter required");
  const url = pathToFileURL(path).href + "?r21-immutable";
  const hook = registerHooks({
    // Do not let a replacement symlink redirect the checked entry at resolution.
    resolve(specifier, context, next) { return specifier === url ? { url, shortCircuit: true } : next(specifier, context); },
    load(specifier, context, next) { return specifier === url ? { format: "module", source, shortCircuit: true } : next(specifier, context); },
  });
  try { return await import(url); } finally { hook.deregister(); }
}

export function sealedUnit(output, s) {
  const p = unitProperties(output, s);
  if (!["inactive", "failed"].includes(p.ActiveState)) return false;
  assert.equal(p.SubState, p.ActiveState === "inactive" ? "dead" : "failed");
  assert.equal(p.Job, ""); assert.equal(p.MainPID, "0"); assert.equal(p.ControlPID, "0");
  if (p.ActiveState === "inactive" && p.ExecMainCode === "0" && p.ExecMainStartTimestamp === "") return "expired";
  assert.ok(terminalUnit(output, s));
  return "terminal";
}

// The registered guardian supplies the shell on stdin (not argv). An unrelated
// host process working in /bench, including one outside the unit, blocks cleanup.
export function idleArchiveScript(s, bootId, unitSha256, { pack = false, stamp, completedOnly = false } = {}) {
  full(bootId, /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/, "registered boot required");
  full(unitSha256, /[a-f0-9]{64}/, "unit bytes required");
  if (stamp !== undefined) full(stamp, /[a-f0-9]{64}/, "hashed archive identity required");
  return `test "$(hostname)" = '${s.name}'
test "$(cat /proc/sys/kernel/random/boot_id)" = '${bootId}'
test "$(curl --noproxy '*' --fail --silent --max-time 3 http://169.254.169.254/metadata/v1/id)" = '${s.id}'
test -f /etc/systemd/system/${s.unit}
test ! -L /etc/systemd/system/${s.unit}
printf '%s  %s\\n' '${unitSha256}' '/etc/systemd/system/${s.unit}' | sha256sum --check --status
jobs=$(systemctl list-jobs --no-legend --no-pager); test -z "$jobs"
cg=/sys/fs/cgroup/system.slice/${s.unit}
if test -e "$cg"; then grep -qx 'populated 0' "$cg/cgroup.events"; fi
if test -e /run/docker.sock || test -e /run/containerd/containerd.sock; then
  containers=$(docker ps --quiet --no-trunc); test -z "$containers"
fi
/usr/bin/python3 -I - <<'CORTEN_IDLE'
import os, pathlib
for p in pathlib.Path('/proc').iterdir():
    if not p.name.isdigit(): continue
    try:
        cmd = (p / 'cmdline').read_bytes()
        assert b'/bench' not in cmd and b'corten-bench-groups-' not in cmd
        assert not any(name in cmd.split(bytes(1), 1)[0] for name in [b'containerd-shim', b'conmon'])
        for name in ['cwd', 'exe']:
            try: target = os.readlink(p / name)
            except FileNotFoundError: continue
            assert '/bench' not in target and 'corten-bench-groups-' not in target
    except FileNotFoundError: continue
CORTEN_IDLE${pack ? `
# Only ENOENT on the final entry, never EACCES, a dangling link or a missing parent.
absent=$(/usr/bin/python3 -I - <<'CORTEN_ABSENT'
import os
archive = '/bench/results.tgz'
fd = os.open(os.path.dirname(archive), os.O_DIRECTORY | os.O_NOFOLLOW)
try: os.stat(os.path.basename(archive), dir_fd=fd, follow_symlinks=False)
except FileNotFoundError: print('yes')
CORTEN_ABSENT
)
if test "$absent" = yes; then${completedOnly ? `
  test -f /bench/exit-code
  test ! -L /bench/exit-code
  test "$(stat -c '%s' /bench/exit-code)" = 2
  grep -qx '[01]' /bench/exit-code
` : " "}timeout 600 /bin/bash /bench/pack.sh; fi` : ""}
test -f /bench/results.tgz
test ! -L /bench/results.tgz
test "$(stat -c '%h' /bench/results.tgz)" = 1
test "$(stat -c '%s' /bench/results.tgz)" -le ${archiveLimit}
# Bind the digest to the inode, size, nanosecond mtime/ctime and link count.
stamp() { LC_ALL=C TZ=UTC stat -c '%d:%i:%f:%h:%s:%y:%z' "$@" | sha256sum; }
${stamp === undefined ? `before=$(stamp /bench/results.tgz)
exec 3</bench/results.tgz
test "$(stamp -L /proc/self/fd/3)" = "$before"
sum=$(sha256sum <&3)
test "$(stamp -L /proc/self/fd/3)" = "$before"
test "$(stamp /bench/results.tgz)" = "$before"
printf '%s  /bench/results.tgz\\n' "\${sum%% *}"
printf '%s\\n' "$before"` : `test "$(stamp /bench/results.tgz)" = '${stamp}  -'`}`;
}
