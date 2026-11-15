// Retirement evidence is separate from benchmark qualification. No operations on import.
import assert from "node:assert/strict";
import { digest } from "./cloud-local.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { quote } from "./cloud-transport.mjs";

export function unusedHostScript(state) {
  const files = Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  return `/usr/bin/timeout 25 /usr/bin/python3 - ${quote(state.id)} ${quote(state.unit)} ${quote(JSON.stringify(files))} <<'CORTEN_UNUSED_HOST'
import hashlib, json, os, pathlib, stat, subprocess, sys, time, urllib.request
host_id, unit, manifest = sys.argv[1:]
files = json.loads(manifest)
def failed(kind, value, traceback):
    print(json.dumps(dict(schema='benchmark-unused-host/v1', unused=False)))
sys.excepthook = failed
assert os.getuid() == 0
with urllib.request.urlopen('http://169.254.169.254/metadata/v1/id', timeout=3) as response:
    assert response.read(64).decode().strip() == host_id
properties = ['Id', 'LoadState', 'ActiveState', 'MainPID', 'FragmentPath', 'ExecMainStartTimestamp', 'Job', 'Restart']
r = subprocess.run(['systemctl', 'show', unit] + ['--property=' + p for p in properties], capture_output=True, text=True, timeout=5)
assert r.returncode in (0, 1)
values = dict(line.split('=', 1) for line in r.stdout.splitlines() if '=' in line)
assert len(values) == len(properties) and values['Id'] == unit
assert values['ActiveState'] == 'inactive' and values['MainPID'] == '0'
assert values['ExecMainStartTimestamp'] == '' and values['Job'] == ''
assert values['LoadState'] in ['not-found', 'loaded'] and values['Restart'] == 'no'
assert values['FragmentPath'] == (('/etc/systemd/system/' + unit) if values['LoadState'] == 'loaded' else '')
bench = pathlib.Path('/bench')
if os.path.lexists(bench):
    assert bench.is_dir() and not bench.is_symlink()
    for entry in bench.iterdir():
        assert stat.S_ISREG(entry.lstat().st_mode) and entry.stat().st_size <= 1048576
        if entry.name == 'run.log':
            assert entry.stat().st_size == 0
        else:
            assert entry.name in files and hashlib.sha256(entry.read_bytes()).hexdigest() == files[entry.name]
assert not pathlib.Path('/run/docker.sock').exists() and not pathlib.Path('/run/containerd/containerd.sock').exists()
for base in ['/etc/systemd/system', '/run/systemd/system']:
    for entry in pathlib.Path(base).glob('corten-bench*'):
        assert str(entry) == '/etc/systemd/system/' + unit
        assert stat.S_ISREG(entry.lstat().st_mode) and entry.stat().st_size <= 1048576
        assert hashlib.sha256(entry.read_bytes()).hexdigest() == files[unit]
r = subprocess.run(['systemctl', 'list-jobs', '--no-legend', '--no-pager'], capture_output=True, text=True, timeout=5)
assert r.returncode == 0 and r.stdout.strip() == ''
r = subprocess.run(['cloud-init', 'status', '--format', 'json'], capture_output=True, text=True, timeout=5)
assert r.returncode == 0 and json.loads(r.stdout)['status'] == 'done'
user_data = pathlib.Path('/var/lib/cloud/instance/user-data.txt')
assert not user_data.exists() or user_data.stat().st_size == 0
parent_pid = os.getppid()
assert parent_pid > 1 and parent_pid != os.getpid()
parent = pathlib.Path('/proc') / str(parent_pid)
parent_command = b'\\0'.join(os.fsencode(arg) for arg in ['/usr/bin/timeout', '25', '/usr/bin/python3'] + sys.argv) + b'\\0'
assert (parent / 'cmdline').read_bytes() == parent_command
assert os.readlink(parent / 'exe') == '/usr/bin/timeout'
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit() or int(entry.name) in [os.getpid(), parent_pid]:
        continue
    try:
        command = (entry / 'cmdline').read_bytes()
    except FileNotFoundError:
        continue
    assert b'/bench/' not in command and b'corten-bench-groups-' not in command
assert os.getppid() == parent_pid and (parent / 'cmdline').read_bytes() == parent_command
assert os.readlink(parent / 'exe') == '/usr/bin/timeout'
print(json.dumps(dict(schema='benchmark-unused-host/v1', hostId=host_id, unit=unit,
                     observedAtMs=int(time.time()*1000), unused=True)))
CORTEN_UNUSED_HOST`;
}

export function unusedEvidence(raw, state, script, startedAtMs, finishedAtMs) {
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 1024, "bounded unused proof required");
  const observation = JSON.parse(raw);
  assert.ok(observation && typeof observation === "object" && !Array.isArray(observation), "unused proof required");
  assert.deepEqual(Object.keys(observation).sort(), ["hostId", "observedAtMs", "schema", "unit", "unused"]);
  assert.equal(observation.schema, "benchmark-unused-host/v1");
  assert.equal(observation.hostId, state.id); assert.equal(observation.unit, state.unit); assert.equal(observation.unused, true);
  assert.ok(Number.isSafeInteger(startedAtMs) && Number.isSafeInteger(finishedAtMs) && finishedAtMs >= startedAtMs
    && finishedAtMs - startedAtMs <= 30000, "unused observation exceeded its local window");
  assert.ok(Number.isSafeInteger(observation.observedAtMs) && observation.observedAtMs >= startedAtMs - 5000
    && observation.observedAtMs <= finishedAtMs + 5000, "unused observation clock differs");
  return { schema: "benchmark-unused-retirement/v1", round: state.round, commit: state.commit, id: state.id, unit: state.unit,
    scriptSha256: digest(script), observation, startedAtMs, finishedAtMs };
}

// A terminal setup failure is not a native benchmark result. In particular,
// neither a bootstrap marker nor any campaign contents may have existed here.
export function terminalSetupScript(state, exitCode) {
  assert.ok(Number.isInteger(exitCode) && exitCode >= 1 && exitCode <= 255, "nonzero setup exit code required");
  const files = Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  assert.deepEqual(Object.keys(files).sort(), ["job.sh", "pack.sh", state.unit].sort());
  return `/usr/bin/timeout 25 /usr/bin/python3 - ${quote(state.id)} ${quote(state.unit)} ${quote(JSON.stringify(files))} ${quote(String(exitCode))} <<'CORTEN_FAILED_SETUP_HOST'
import hashlib, json, os, pathlib, stat, subprocess, sys, time, urllib.request
host_id, unit, manifest, expected_code = sys.argv[1:]
files = json.loads(manifest)
def failed(kind, value, traceback):
    print(json.dumps(dict(schema='benchmark-failed-setup-host/v1', setupFailed=False)))
sys.excepthook = failed
assert os.getuid() == 0
assert expected_code.isascii() and expected_code.isdecimal() and str(int(expected_code)) == expected_code and 1 <= int(expected_code) <= 255
with urllib.request.urlopen('http://169.254.169.254/metadata/v1/id', timeout=3) as response:
    assert response.read(64).decode().strip() == host_id
properties = ['Id', 'LoadState', 'ActiveState', 'MainPID', 'FragmentPath', 'ExecMainStartTimestamp', 'Job', 'Restart']
r = subprocess.run(['systemctl', 'show', unit] + ['--property=' + p for p in properties], capture_output=True, text=True, timeout=5)
assert r.returncode == 0
lines = r.stdout.splitlines()
assert len(lines) == len(properties) and all('=' in line for line in lines)
values = dict(line.split('=', 1) for line in lines)
assert set(values) == set(properties) and values['Id'] == unit
assert values['LoadState'] == 'loaded' and values['FragmentPath'] == '/etc/systemd/system/' + unit
assert values['ActiveState'] in ['inactive', 'failed'] and values['MainPID'] == '0' and values['Restart'] == 'no'
assert values['ExecMainStartTimestamp'].strip() not in ['', 'n/a'] and values['Job'] == ''
def regular(path, limit=None):
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and (limit is None or info.st_size <= limit)
def control(path, name):
    regular(path, 1048576)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == files[name]
bench = pathlib.Path('/bench')
assert stat.S_ISDIR(bench.lstat().st_mode)
assert not os.path.lexists(bench / 'bootstrap-ready.json')
for name in files:
    control(bench / name, name)
for entry in bench.iterdir():
    if entry.name in files:
        control(entry, entry.name)
    elif entry.name in ['run.log', 'host.txt', 'exit-code', 'results.tgz']:
        regular(entry)
    else:
        assert entry.name in ['repo', 'campaign'] and stat.S_ISDIR(entry.lstat().st_mode)
        if entry.name == 'campaign':
            assert next(iter(entry.iterdir()), None) is None
code_file = bench / 'exit-code'
regular(code_file, 4)
assert code_file.read_bytes() == (expected_code + '\\n').encode('ascii')
control(pathlib.Path('/etc/systemd/system') / unit, unit)
for base in ['/etc/systemd/system', '/run/systemd/system']:
    for entry in pathlib.Path(base).glob('corten-bench*'):
        assert str(entry) == '/etc/systemd/system/' + unit
        control(entry, unit)
r = subprocess.run(['systemctl', 'list-jobs', '--no-legend', '--no-pager'], capture_output=True, text=True, timeout=5)
assert r.returncode == 0 and r.stdout.strip() == ''
r = subprocess.run(['cloud-init', 'status', '--format', 'json'], capture_output=True, text=True, timeout=5)
assert r.returncode == 0 and json.loads(r.stdout)['status'] == 'done'
user_data = pathlib.Path('/var/lib/cloud/instance/user-data.txt')
if os.path.lexists(user_data):
    regular(user_data, 0)
if os.path.lexists('/run/docker.sock') or os.path.lexists('/run/containerd/containerd.sock'):
    r = subprocess.run(['docker', 'ps', '--quiet', '--no-trunc'], capture_output=True, text=True, timeout=5)
    assert r.returncode == 0 and r.stdout.strip() == ''
parent_pid = os.getppid()
assert parent_pid > 1 and parent_pid != os.getpid()
parent = pathlib.Path('/proc') / str(parent_pid)
parent_command = b'\\0'.join(os.fsencode(arg) for arg in ['/usr/bin/timeout', '25', '/usr/bin/python3'] + sys.argv) + b'\\0'
assert (parent / 'cmdline').read_bytes() == parent_command
assert os.readlink(parent / 'exe') == '/usr/bin/timeout'
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit() or int(entry.name) in [os.getpid(), parent_pid]:
        continue
    try:
        command = (entry / 'cmdline').read_bytes()
        assert b'/bench' not in command and b'corten-bench-groups-' not in command
        for name in ['cwd', 'exe']:
            try:
                target = os.readlink(entry / name)
            except FileNotFoundError:
                continue
            assert '/bench' not in target and 'corten-bench-groups-' not in target
    except FileNotFoundError:
        continue
assert os.getppid() == parent_pid and (parent / 'cmdline').read_bytes() == parent_command
assert os.readlink(parent / 'exe') == '/usr/bin/timeout'
print(json.dumps(dict(schema='benchmark-failed-setup-host/v1', hostId=host_id, unit=unit,
                     observedAtMs=int(time.time()*1000), exitCode=int(expected_code), setupFailed=True)))
CORTEN_FAILED_SETUP_HOST`;
}

export function setupEvidence(raw, state, script, exitCode, startedAtMs, finishedAtMs) {
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 1024, "bounded setup proof required");
  assert.ok(typeof script === "string" && script === terminalSetupScript(state, exitCode), "fixed setup script required");
  for (const key of ["archiveSha256", "evidenceSha256"])
    assert.ok(typeof state[key] === "string" && state[key].length === 64 && /^[a-f0-9]{64}$/.test(state[key]), "preserved setup evidence hash required");
  const observation = JSON.parse(raw);
  assert.ok(observation && typeof observation === "object" && !Array.isArray(observation), "setup proof required");
  assert.deepEqual(Object.keys(observation).sort(), ["exitCode", "hostId", "observedAtMs", "schema", "setupFailed", "unit"]);
  assert.equal(observation.schema, "benchmark-failed-setup-host/v1");
  assert.equal(observation.hostId, state.id); assert.equal(observation.unit, state.unit);
  assert.equal(observation.setupFailed, true); assert.equal(observation.exitCode, exitCode);
  assert.ok(Number.isSafeInteger(startedAtMs) && Number.isSafeInteger(finishedAtMs) && finishedAtMs >= startedAtMs
    && finishedAtMs - startedAtMs <= 30000, "setup observation exceeded its local window");
  assert.ok(Number.isSafeInteger(observation.observedAtMs) && observation.observedAtMs >= startedAtMs - 5000
    && observation.observedAtMs <= finishedAtMs + 5000, "setup observation clock differs");
  return { schema: "benchmark-failed-setup-retirement/v1", round: state.round, commit: state.commit, id: state.id, unit: state.unit,
    archiveSha256: state.archiveSha256, evidenceSha256: state.evidenceSha256, exitCode, scriptSha256: digest(script),
    observation, startedAtMs, finishedAtMs };
}
