// Opt-in disposable local Docker controls. No credentials, network or provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { accountId, context } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation } from "./cloud-contract.mjs";
import { groupNames } from "./registry.mjs";
import { failedNativeCommit, failedNativeRoots, failedNativeScript } from "./cloud-retirement.mjs";
import { bootstrapMarker, remoteFiles } from "./cloud-remote.mjs";
import { archiveMembers, digest, extractArchive, treeHash } from "./cloud-local.mjs";

const enabled = process.env.CORTEN_FAILED_NATIVE_LINUX === "1";
const tokens = Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")]));
const fleet = fleetPlan({ round: "r21", commit: failedNativeCommit, token: "f".repeat(16), tokens, provider: { accountId, context }, sshKey: "42" });
const state = { ...reservation({ round: "r21", commit: failedNativeCommit, token: tokens["catalog-page"], group: "catalog-page", fleet }),
  status: "running", id: "123", ip: "192.0.2.10", archiveSha256: "a".repeat(64) };
const literal = (value) => `json.loads(${JSON.stringify(JSON.stringify(value))})`;

// Substitute only metadata/service observations. File descriptors, directory
// traversal, tar creation, /proc, parent identity and process lifetimes are real.
function observed(script, mode) {
  if (mode.startsWith("budget-")) {
    const bounds = mode === "budget-names" ? { nameBytes: 60 } : mode === "budget-members" ? { memberBytes: 80 } : { nodes: 32 };
    script = script.replace("c = json.loads(raw_config)", `c = json.loads(raw_config)
c['bounds'].update(${JSON.stringify(bounds)})
original_listdir, original_scandir = os.listdir, os.scandir
def checked_listdir(fd):
    if isinstance(fd, int):
        print('unbounded descriptor listdir', file=sys.stderr)
        raise AssertionError('streaming admission required')
    return original_listdir(fd)
@contextlib.contextmanager
def checked_scandir(fd):
    with original_scandir(fd) as entries:
        def stream():
            previous = None
            for entry in entries:
                if isinstance(fd, int):
                    current = (nodes, names, members)
                    if previous is not None and not all(a > b for a, b in zip(current, previous)):
                        print('enumerated another name before global admission', file=sys.stderr)
                        raise AssertionError('admission before retaining/sort')
                    previous = current
                yield entry
        yield stream()
os.listdir, os.scandir = checked_listdir, checked_scandir`);
  }
  const [header, rest] = script.split("<<'CORTEN_FAILED_NATIVE_HOST'\n"), program = rest.split("\nCORTEN_FAILED_NATIVE_HOST")[0];
  const config = { mode, program, id: state.id, unit: state.unit };
  return `${header}<<'CORTEN_FAILED_NATIVE_HOST'
import contextlib, io, json, subprocess, urllib.request
from unittest.mock import patch
fixture = ${literal(config)}
def metadata(url, timeout):
    assert url == 'http://169.254.169.254/metadata/v1/id' and timeout == 3
    return contextlib.closing(io.BytesIO(('124' if fixture['mode'] == 'host-id' else fixture['id']).encode()))
def service(args, **kwargs):
    assert kwargs == dict(capture_output=True, text=True, timeout=5)
    if args[:2] == ['systemctl', 'show']:
        v = dict(Id=fixture['unit'], LoadState='loaded', FragmentPath='/etc/systemd/system/' + fixture['unit'], ActiveState='failed',
            Restart='no', MainPID='0', Job='', ExecMainCode='1', ExecMainStatus='2', ExecMainStartTimestamp='Sun 2026-11-15 00:00:00 UTC')
        changes = {'active': ('ActiveState', 'active'), 'pid': ('MainPID', '123'), 'restart': ('Restart', 'always'), 'unit-job': ('Job', '123'),
            'wrong-unit': ('Id', 'foreign.service'), 'exit-zero': ('ExecMainStatus', '0')}
        if fixture['mode'] in changes:
            key, value = changes[fixture['mode']]
            v[key] = value
        value = '\\n'.join(k + '=' + v for k, v in v.items())
        if fixture['mode'] == 'duplicate': value += '\\nId=' + fixture['unit']
    elif args == ['systemctl', 'list-jobs', '--no-legend', '--no-pager']:
        value = '123 start' if fixture['mode'] == 'jobs' else ''
    elif args == ['cloud-init', 'status', '--format', 'json']:
        value = json.dumps(dict(status='running' if fixture['mode'] == 'cloud-init' else 'done'))
    else:
        assert args == ['docker', 'ps', '--quiet', '--no-trunc']
        value = 'synthetic-running-container' if fixture['mode'] == 'container' else ''
    return subprocess.CompletedProcess(args, 0, stdout=value, stderr='')
with patch.object(urllib.request, 'urlopen', metadata), patch.object(subprocess, 'run', service):
    try:
        exec(compile(fixture['program'], '<fixed-retirement-program>', 'exec'))
    except BaseException:
        if fixture['mode'] in ['idle', 'exited-process', 'absent']:
            import traceback
            traceback.print_exc()
        raise
CORTEN_FAILED_NATIVE_HOST`;
}

function control(mode) {
  const config = { mode, state, files: remoteFiles(state), marker: `${JSON.stringify(bootstrapMarker(state))}\n`, roots: failedNativeRoots(state) };
  const capture = observed(failedNativeScript(state), mode);
  const confirm = observed(failedNativeScript(state, "e".repeat(64)), mode);
  const fence = observed(failedNativeScript(state, "e".repeat(64), { snapshotSha256: "e".repeat(64),
    roots: [...failedNativeRoots(state), "/bench/run.log", "/bench/host.txt", "/bench/exit-code", "/bench/results.tgz"].map((path) => ({ path })) }), mode);
  return `set -u
/usr/bin/python3 - <<'SETUP'
import hashlib, json, os, pathlib, subprocess, time
c = ${literal(config)}
bench = pathlib.Path('/bench')
assert bench.resolve() == bench and not any(bench.iterdir())
for name, content in c['files'].items():
    (bench / name).write_text(content)
pathlib.Path('/etc/systemd/system', c['state']['unit']).write_text(c['files'][c['state']['unit']])
for name, content in [('run.log', 'failed native run\\n'), ('host.txt', 'unqualified fixture\\n'), ('exit-code', '2\\n'), ('results.tgz', 'original archive bytes')]:
    (bench / name).write_text(content)
repo = bench / 'repo'
(repo / '.git').mkdir(parents=True)
(repo / '.git/HEAD').write_text(c['state']['commit'] + '\\n')
(repo / '.git/config').write_text('[remote "origin"]\\nurl = https://github.com/corten-run/corten.git\\n')
(bench / 'campaign').mkdir()
(bench / 'campaign/evidence.mjs').write_text('throw new Error("must never execute");')
(bench / 'bootstrap-ready.json').write_text(c['marker'])
native = pathlib.Path(c['roots'][1])
if c['mode'] != 'absent':
    native.mkdir(parents=True)
    (native / 'result.json').write_text('{"failed":true}')
    (native / '@fixture[1]+$.txt').write_text('portable archive names')
pathlib.Path('/tmp/outside').write_text('must not read this through a link')
if c['mode'] == 'symlink': (native / 'escape').symlink_to('/tmp/outside')
if c['mode'] == 'dangling': (native / 'escape').symlink_to('/tmp/missing')
if c['mode'] == 'hardlink':
    (repo / 'outside').write_text('outside native custody root')
    os.link(repo / 'outside', native / 'escape')
if c['mode'] == 'fifo': os.mkfifo(native / 'escape')
if c['mode'] == 'ancestor-symlink':
    native.rename(native.with_name('outside-root'))
    native.symlink_to(native.with_name('outside-root'), target_is_directory=True)
if c['mode'] in ['live-process', 'exited-process']:
    p = subprocess.Popen(['/usr/bin/sleep', '20' if c['mode'] == 'live-process' else '0.01'], cwd='/bench')
    if c['mode'] == 'exited-process': p.wait(timeout=2)
if c['mode'] == 'container': pathlib.Path('/run/docker.sock').touch()
if c['mode'].startswith('budget-'):
    target = native
    if c['mode'] == 'budget-nested':
        for index in range(10):
            target = target / ('level-' + str(index))
            target.mkdir()
    for index in range(80):
        (target / ('wide-' + str(index))).touch()
SETUP
# Bind the synthetic archive's actual bytes into the exact emitted configuration.
/usr/bin/python3 - <<'PROGRAM'
import hashlib, json, pathlib
expected = hashlib.sha256(pathlib.Path('/bench/results.tgz').read_bytes()).hexdigest()
pathlib.Path('/tmp/capture.sh').write_text(${literal(capture)}.replace('a' * 64, expected))
pathlib.Path('/tmp/confirmation-template').write_text(${literal(confirm)}.replace('a' * 64, expected))
pathlib.Path('/tmp/fence-template').write_text(${literal(fence)}.replace('a' * 64, expected))
PROGRAM
/bin/bash /tmp/capture.sh > /tmp/capture-observation
code=$?
cat /tmp/capture-observation
if test "$code" -ne 0; then exit "$code"; fi
/usr/bin/python3 - <<'CONFIRM'
import json, pathlib, subprocess
o = json.loads(pathlib.Path('/tmp/capture-observation').read_text())
script = pathlib.Path('/tmp/confirmation-template').read_text().replace('e' * 64, o['snapshotSha256'])
pathlib.Path('/tmp/confirm.sh').write_text(script)
mode = ${JSON.stringify(mode)}
if mode == 'changed-after-capture': pathlib.Path('/bench/campaign/evidence.mjs').write_text('changed')
if mode == 'live-after-capture': subprocess.Popen(['/usr/bin/sleep', '20'], cwd='/bench')
CONFIRM
/bin/bash /tmp/confirm.sh
code=$?
if test "$code" -ne 0; then exit "$code"; fi
/usr/bin/python3 - <<'FENCE'
import json, pathlib, shlex, subprocess
o = json.loads(pathlib.Path('/tmp/capture-observation').read_text())
header, body = pathlib.Path('/tmp/fence-template').read_text().split("<<'CORTEN_FAILED_NATIVE_HOST'\\n", 1)
args = shlex.split(header)
c = json.loads(args[-1])
c['captureSha256'], c['fence'] = o['snapshotSha256'], o
args[-1] = json.dumps(c)
pathlib.Path('/tmp/fence.sh').write_text(shlex.join(args) + " <<'CORTEN_FAILED_NATIVE_HOST'\\n" + body)
mode = ${JSON.stringify(mode)}
if mode == 'changed-before-fence': pathlib.Path('/bench/campaign/evidence.mjs').write_text('changed after complete rehash')
if mode == 'live-before-fence': subprocess.Popen(['/usr/bin/sleep', '20'], cwd='/bench')
FENCE
/bin/bash /tmp/fence.sh
code=$?
if test "$code" -ne 0; then exit "$code"; fi
base64 --wrap=0 /bench/failed-native-custody.tgz
printf '\\n'
`;
}

test("fixed recovery program on local Linux uses real safe file and terminal process controls", { skip: !enabled, timeout: 240000 }, async () => {
  const modes = ["idle", "exited-process", "absent", "live-process", "live-after-capture", "changed-after-capture", "changed-before-fence", "live-before-fence", "symlink", "dangling", "hardlink", "fifo",
    "ancestor-symlink", "active", "pid", "restart", "unit-job", "wrong-unit", "exit-zero", "duplicate", "jobs", "cloud-init", "host-id", "container",
    "budget-wide", "budget-nested", "budget-names", "budget-members"];
  for (const mode of modes) {
    const child = spawnSync("docker", ["run", "--rm", "-i", "--init", "--label", "agent.owner=codex", "--label", "agent.task=corten-bench-failed-retirement",
      "--network", "none", "--read-only", "--tmpfs", "/bench:rw", "--tmpfs", "/tmp:rw", "--tmpfs", "/etc/systemd/system:rw", "--tmpfs", "/run:rw",
      "node@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496", "/bin/bash"],
    { input: control(mode), encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 65536 });
    assert.equal(child.error, undefined, mode); assert.equal(child.signal, null, mode); assert.equal(child.stderr, "", mode);
    const positive = ["idle", "exited-process", "absent"].includes(mode);
    assert.equal(child.status, positive ? 0 : 1, `${mode}: ${child.stdout}`);
    const lines = child.stdout.trim().split("\n"), bytes = positive ? Buffer.from(lines.pop(), "base64") : undefined;
    const observations = lines.map((line) => JSON.parse(line));
    assert.equal(observations.at(-1).custody, positive, mode);
    if (positive) {
      assert.equal(observations.length, 3, mode);
      assert.equal(observations[0].snapshotSha256, observations[1].snapshotSha256, mode);
      assert.equal(observations[0].archiveSha256, observations[1].archiveSha256, mode);
      assert.equal(observations[0].snapshotSha256, observations[2].snapshotSha256, mode);
      assert.equal(observations[0].archiveSha256, observations[2].archiveSha256, mode);
      assert.equal(observations[1].historicalAccountingQualified, false, mode);
      assert.equal(digest(bytes), observations[0].archiveSha256);
      await archiveMembers(bytes, observations[0].archiveSha256);
      const local = mkdtempSync(join(tmpdir(), "failed-native-linux-"));
      try {
        await extractArchive(bytes, local, observations[0].archiveSha256);
        assert.equal(treeHash(join(local, "campaign", "root-0")), observations[0].roots[0].treeSha256);
        if (mode !== "absent") assert.equal(treeHash(join(local, "campaign", "root-1")), observations[0].roots[1].treeSha256);
      } finally {
        assert.ok(local.startsWith(join(tmpdir(), "failed-native-linux-"))); rmSync(local, { recursive: true });
      }
      if (mode === "absent") assert.deepEqual(observations[1].roots[1], { path: failedNativeRoots(state)[1], present: false });
    }
  }
});
