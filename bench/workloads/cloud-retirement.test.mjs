import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fleetPlan, reservation, selection } from "./cloud-contract.mjs";
import { commit } from "./cloud-fixtures.mjs";
import { setupEvidence, terminalSetupScript, unusedHostScript } from "./cloud-retirement.mjs";
import { digest } from "./cloud-local.mjs";
import { bootstrapMarker, remoteFiles } from "./cloud-remote.mjs";

const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true }).status === 0;
// Execute the exact emitted Python with only its operating-system observations
// substituted. This never contacts metadata, reads /proc or operates systemd.
const parentFixture = `parent_args = ['/usr/bin/timeout', '25', '/usr/bin/python3'] + sys.argv
for case, index, value in [('parent-timeout', 1, '24'), ('parent-python', 2, '/usr/local/bin/python3'), ('parent-host', 4, '124'), ('parent-unit', 5, 'foreign.service'), ('parent-manifest', 6, '{}'), ('parent-exit-code', 7, '2')]:
    if mode == case: parent_args[index] = value
if mode == 'parent-extra': parent_args.append('extra')
parent_bytes = b'\\0'.join(arg.encode() for arg in parent_args) + b'\\0'
if mode == 'parent-no-nul': parent_bytes = parent_bytes[:-1]
parent_reads, parent_pid_reads, parent_exe_reads = 0, 0, 0
def parent_cmdline():
    global parent_reads
    parent_reads += 1
    if mode == 'parent-missing': raise FileNotFoundError('parent exited')
    if mode == 'parent-permission': raise PermissionError('private process detail')
    return parent_bytes + (b'extra\\0' if mode == 'parent-command-change' and parent_reads > 1 else b'')
def parent_pid():
    global parent_pid_reads
    parent_pid_reads += 1
    if mode == 'parent-pid-one': return 1
    if mode == 'parent-self': return 2
    return 5 if mode == 'parent-pid-change' and parent_pid_reads > 1 else 4
def parent_executable():
    global parent_exe_reads
    parent_exe_reads += 1
    if mode == 'parent-exe': return '/usr/bin/sleep'
    if mode == 'parent-exe-alias': return '/bin/timeout'
    if mode == 'parent-exe-change' and parent_exe_reads > 1: return '/usr/bin/sleep'
    return '/usr/bin/timeout'
`;
const parentNegatives = ["parent-pid-one", "parent-self", "parent-pid-change", "parent-exe", "parent-exe-alias", "parent-exe-change", "parent-timeout", "parent-python", "parent-host", "parent-unit", "parent-manifest", "parent-extra", "parent-no-nul", "parent-command-change", "parent-missing", "parent-permission", "other-timeout"];
const fixture = `import contextlib, hashlib, io, json, os, pathlib, stat, subprocess, sys, time, urllib.request
from unittest.mock import patch
from types import SimpleNamespace
config = json.load(sys.stdin)
mode, unit = config['mode'], config['unit']
class Entry:
    def __init__(self, path): self.path, self.name = path, path.rsplit('/', 1)[-1]
    def __str__(self): return self.path
    def __truediv__(self, name): return Entry(self.path + '/' + name)
    def exists(self):
        return (self.path == '/run/docker.sock' and mode == 'docker') or (self.path.endswith('user-data.txt') and mode == 'user-data')
    def is_dir(self): return True
    def is_symlink(self): return mode == 'symlink'
    def stat(self): return SimpleNamespace(st_size=len(self.read_bytes()))
    def lstat(self): return SimpleNamespace(st_mode=stat.S_IFREG)
    def iterdir(self):
        if self.path == '/proc': return [Entry('/proc/' + pid) for pid in (['2', '3', '4', '5'] if mode == 'other-timeout' else ['2', '3', '4'])]
        if mode in ['partial', 'file-mismatch']: return [Entry('/bench/job.sh')]
        if mode == 'bench-data': return [Entry('/bench/campaign')]
        return []
    def glob(self, pattern): return [Entry('/etc/systemd/system/' + unit)] if mode == 'loaded' and self.path == '/etc/systemd/system' else []
    def read_bytes(self):
        if self.path == '/proc/4/cmdline': return parent_cmdline()
        if self.path == '/proc/5/cmdline': return parent_bytes
        assert self.path != '/proc/2/cmdline'
        if self.path.endswith('/cmdline'): return b'node /bench/job.sh' if mode == 'process' else b'ordinary'
        if mode == 'file-mismatch': return b'changed'
        return config['files'].get(self.name, 'unexpected').encode()
def run(args, **kwargs):
    assert kwargs == dict(capture_output=True, text=True, timeout=5)
    if args[:2] == ['systemctl', 'show']:
        assert args[2] == unit
        values = dict(Id=unit, LoadState='not-found', ActiveState='inactive', MainPID='0', FragmentPath='', ExecMainStartTimestamp='', Job='', Restart='no')
        if mode == 'loaded': values.update(LoadState='loaded', FragmentPath='/etc/systemd/system/' + unit)
        for case, key, value in [('active', 'ActiveState', 'active'), ('pid', 'MainPID', '3'), ('started', 'ExecMainStartTimestamp', 'yesterday'), ('unit-job', 'Job', '1'), ('restart', 'Restart', 'always'), ('wrong-unit', 'Id', 'foreign.service')]:
            if mode == case: values[key] = value
        return SimpleNamespace(returncode=0, stdout='\\n'.join(k + '=' + v for k, v in values.items()))
    if args == ['systemctl', 'list-jobs', '--no-legend', '--no-pager']:
        return SimpleNamespace(returncode=0, stdout='1 start' if mode == 'jobs' else '')
    assert args == ['cloud-init', 'status', '--format', 'json']
    return SimpleNamespace(returncode=0, stdout=json.dumps(dict(status='running' if mode == 'cloud-init' else 'done')))
def metadata(url, timeout):
    assert url == 'http://169.254.169.254/metadata/v1/id' and timeout == 3
    return contextlib.closing(io.BytesIO(('124' if mode == 'wrong-host' else config['id']).encode()))
sys.argv = ['-', config['id'], unit, config['manifest']]
${parentFixture}
def readlink(path):
    assert str(path) == '/proc/4/exe'
    return parent_executable()
with patch.object(pathlib, 'Path', Entry), patch.object(os.path, 'lexists', lambda p: mode in ['partial', 'file-mismatch', 'symlink', 'bench-data']), patch.object(os, 'getuid', lambda: 0, create=True), patch.object(os, 'getpid', lambda: 2), patch.object(os, 'getppid', parent_pid), patch.object(os, 'readlink', readlink), patch.object(urllib.request, 'urlopen', metadata), patch.object(subprocess, 'run', run), patch.object(time, 'time', lambda: 1000):
    exec(compile(config['program'], '<fixed-unused-probe>', 'exec'))
`;

test("fixed unused-host program accepts only never-started idle host observations", { skip: !available }, () => {
  const state = { ...reservation({ round: "r21", commit, token: "0123456789abcdef" }), id: "123", ip: "192.0.2.10", status: "preparing" };
  const script = unusedHostScript(state), program = script.split("<<'CORTEN_UNUSED_HOST'\n")[1].split("\nCORTEN_UNUSED_HOST")[0];
  assert.ok(program);
  const files = remoteFiles(state), manifest = JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])));
  for (const mode of ["empty", "partial", "loaded", "active", "pid", "started", "unit-job", "restart", "wrong-unit", "wrong-host",
    "file-mismatch", "symlink", "bench-data", "docker", "jobs", "cloud-init", "user-data", "process", ...parentNegatives]) {
    const r = spawnSync(python, ["-c", fixture], { input: JSON.stringify({ mode, unit: state.unit, id: state.id, files, manifest, program }),
      encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
    const positive = ["empty", "partial", "loaded"].includes(mode);
    assert.equal(r.error, undefined, mode); assert.equal(r.stderr, "", mode);
    assert.equal(r.status, positive ? 0 : 1, mode);
    const result = JSON.parse(r.stdout);
    assert.equal(result.unused, positive, mode);
    assert.equal(result.schema, "benchmark-unused-host/v1");
    if (positive) assert.deepEqual(result, { schema: "benchmark-unused-host/v1", hostId: "123", unit: state.unit, observedAtMs: 1000000, unused: true });
  }
});

const setupFixture = `import contextlib, io, json, os, pathlib, stat, subprocess, sys, time, urllib.request
from unittest.mock import patch
from types import SimpleNamespace
config = json.load(sys.stdin)
mode, unit, code = config['mode'], config['unit'], config['code']
contents = {'/bench/' + name: value.encode() for name, value in config['files'].items()}
contents.update({'/bench/run.log': b'setup failed\\n', '/bench/host.txt': b'host info\\n', '/bench/exit-code': (str(code) + '\\n').encode(), '/etc/systemd/system/' + unit: config['files'][unit].encode()})
directories = {'/bench', '/proc', '/etc/systemd/system', '/run/systemd/system'}
if mode in ['repo', 'repo-symlink']: directories.add('/bench/repo')
if mode in ['empty-campaign', 'attempt', 'campaign-symlink']: directories.add('/bench/campaign')
if mode == 'attempt': contents['/bench/campaign/attempt.json'] = b'native attempt'
if mode == 'archive': contents['/bench/results.tgz'] = b'preserved archive, not inspected as qualification'
if mode == 'extra-data': contents['/bench/unknown'] = b'unknown'
if mode == 'marker': contents['/bench/bootstrap-ready.json'] = b'marker'
if config.get('marker') is not None: contents['/bench/bootstrap-ready.json'] = config['marker'].encode()
if config.get('markerKind') == 'directory':
    contents.pop('/bench/bootstrap-ready.json', None)
    directories.add('/bench/bootstrap-ready.json')
if mode in ['user-data', 'user-data-symlink']: contents['/var/lib/cloud/instance/user-data.txt'] = b'x' if mode == 'user-data' else b''
if mode == 'empty-user-data': contents['/var/lib/cloud/instance/user-data.txt'] = b''
for name in config['files']:
    if mode == 'changed-' + name: contents['/bench/' + name] += b'changed'
    if mode == 'missing-' + name: del contents['/bench/' + name]
bad_codes = {'exit-zero': b'0\\n', 'exit-other': b'2\\n', 'exit-signed': b'+1\\n', 'exit-padded': b'01\\n', 'exit-spaces': b'1 \\n', 'exit-overflow': b'256\\n', 'exit-unicode': '١\\n'.encode(), 'exit-no-newline': b'1', 'exit-literal-newline': b'1' + bytes([92, 110]), 'exit-extra-line': b'1\\n2\\n'}
if mode in bad_codes: contents['/bench/exit-code'] = bad_codes[mode]
links = {'/bench' if mode == 'bench-symlink' else '/absent-link'}
if mode in ['repo-symlink', 'campaign-symlink']: links.add('/bench/' + mode.split('-')[0])
if mode == 'marker-dangling': links.add('/bench/bootstrap-ready.json')
if config.get('markerKind') == 'symlink': links.add('/bench/bootstrap-ready.json')
if mode == 'unit-symlink': links.add('/etc/systemd/system/' + unit)
if mode == 'control-symlink': links.add('/bench/job.sh')
if mode == 'user-data-symlink': links.add('/var/lib/cloud/instance/user-data.txt')
if mode == 'other-unit': contents['/etc/systemd/system/corten-bench-foreign.service'] = b'foreign'
docker_modes = ['docker-idle', 'docker-running', 'docker-failed', 'docker-timeout', 'containerd-idle']
class Entry:
    def __init__(self, path): self.path, self.name = str(path), str(path).rsplit('/', 1)[-1]
    def __str__(self): return self.path
    def __fspath__(self): return self.path
    def __truediv__(self, name): return Entry(self.path + '/' + name)
    def lstat(self):
        if self.path in links: kind = stat.S_IFLNK
        elif self.path in directories: kind = stat.S_IFDIR
        elif self.path in contents: kind = stat.S_IFIFO if mode == 'special-file' and self.name == 'run.log' else stat.S_IFREG
        else: raise FileNotFoundError(self.path)
        return SimpleNamespace(st_mode=kind, st_size=len(contents.get(self.path, b'')))
    def iterdir(self):
        if self.path == '/proc': return [Entry('/proc/' + pid) for pid in (['2', '3', '4', '5'] if mode == 'other-timeout' else ['2', '3', '4'])]
        return [Entry(path) for path in sorted(set(contents) | directories | (links - {'/absent-link'})) if path.rsplit('/', 1)[0] == self.path]
    def glob(self, pattern):
        assert pattern == 'corten-bench*'
        return [entry for entry in self.iterdir() if entry.name.startswith('corten-bench')]
    def read_bytes(self):
        if self.path == '/proc/4/cmdline': return parent_cmdline()
        if self.path == '/proc/5/cmdline': return parent_bytes
        assert self.path != '/proc/2/cmdline'
        if self.path == '/proc/3/cmdline':
            if mode == 'process-race': raise FileNotFoundError(self.path)
            if mode == 'process-permission': raise PermissionError('private detail must not escape')
            return {'process': b'node /bench/repo/job', 'process-root': b'worker\\x00/bench\\x00', 'process-groups': b'node corten-bench-groups-r21'}.get(mode, b'ordinary')
        if self.path not in contents: raise FileNotFoundError(self.path)
        return contents[self.path]
def lexists(path):
    path = str(path)
    if path == '/run/docker.sock': return mode in docker_modes and mode != 'containerd-idle'
    if path == '/run/containerd/containerd.sock': return mode == 'containerd-idle'
    return path in contents or path in directories or path in links
def readlink(path):
    path = str(path)
    if path == '/proc/4/exe': return parent_executable()
    if mode == 'process-cwd' and path.endswith('/cwd'): return '/bench/repo'
    if mode == 'process-exe' and path.endswith('/exe'): return '/bench/repo/native'
    if mode == 'process-link-race': raise FileNotFoundError(path)
    return '/usr/bin/ordinary' if path.endswith('/exe') else '/'
def run(args, **kwargs):
    assert kwargs == dict(capture_output=True, text=True, timeout=5)
    if args[:2] == ['systemctl', 'show']:
        assert args[2] == unit
        properties = ['Id', 'LoadState', 'ActiveState', 'MainPID', 'FragmentPath', 'ExecMainStartTimestamp', 'Job', 'Restart']
        assert args[3:] == ['--property=' + p for p in properties]
        values = dict(Id=unit, LoadState='loaded', ActiveState='failed', MainPID='0', FragmentPath='/etc/systemd/system/' + unit, ExecMainStartTimestamp='Sun 2026-11-15 12:00:00 UTC', Job='', Restart='no')
        changes = {'inactive': ('ActiveState', 'inactive'), 'active': ('ActiveState', 'active'), 'activating': ('ActiveState', 'activating'), 'pid': ('MainPID', '3'), 'not-loaded': ('LoadState', 'not-found'), 'wrong-unit': ('Id', 'foreign.service'), 'fragment': ('FragmentPath', '/foreign'), 'restart': ('Restart', 'always'), 'not-started': ('ExecMainStartTimestamp', ''), 'start-na': ('ExecMainStartTimestamp', 'n/a'), 'unit-job': ('Job', '1')}
        if mode in changes: values[changes[mode][0]] = changes[mode][1]
        text = '\\n'.join(k + '=' + v for k, v in values.items())
        if mode == 'duplicate-property': text += '\\nId=' + unit
        if mode == 'malformed-property': text = text.replace('Restart=no', 'malformed')
        return SimpleNamespace(returncode=1 if mode == 'show-failed' else 0, stdout=text)
    if args == ['systemctl', 'list-jobs', '--no-legend', '--no-pager']:
        return SimpleNamespace(returncode=1 if mode == 'jobs-failed' else 0, stdout='1 start' if mode == 'jobs' else '')
    if args == ['cloud-init', 'status', '--format', 'json']:
        return SimpleNamespace(returncode=1 if mode == 'cloud-failed' else 0, stdout='bad json' if mode == 'cloud-json' else json.dumps(dict(status='running' if mode == 'cloud-init' else 'done')))
    assert args == ['docker', 'ps', '--quiet', '--no-trunc'] and mode in docker_modes
    if mode == 'docker-timeout': raise subprocess.TimeoutExpired(args, 5)
    return SimpleNamespace(returncode=1 if mode == 'docker-failed' else 0, stdout='running-container' if mode == 'docker-running' else '')
def metadata(url, timeout):
    assert url == 'http://169.254.169.254/metadata/v1/id' and timeout == 3
    if mode == 'metadata-failed': raise OSError('secret metadata detail')
    return contextlib.closing(io.BytesIO(('124' if mode == 'wrong-host' else config['id']).encode()))
sys.argv = ['-', config['id'], unit, config['manifest'], str(code)]
${parentFixture}
with patch.object(pathlib, 'Path', Entry), patch.object(os.path, 'lexists', lexists), patch.object(os, 'getuid', lambda: 1 if mode == 'not-root' else 0, create=True), patch.object(os, 'getpid', lambda: 2), patch.object(os, 'getppid', parent_pid), patch.object(os, 'readlink', readlink), patch.object(urllib.request, 'urlopen', metadata), patch.object(subprocess, 'run', run), patch.object(time, 'time', lambda: 1000):
    exec(compile(config['program'], '<fixed-failed-setup-probe>', 'exec'))
`;

function setupState() {
  return { ...reservation({ round: "r21", commit, token: "0123456789abcdef" }), id: "123", ip: "192.0.2.10", status: "preparing",
    archiveSha256: "a".repeat(64), evidenceSha256: "b".repeat(64) };
}

test("probe launch argv exactly matches the validated timeout parent", () => {
  const state = setupState();
  const manifest = JSON.stringify(Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)])));
  const prefix = `/usr/bin/timeout 25 /usr/bin/python3 - '${state.id}' '${state.unit}' '${manifest}'`;
  assert.equal(unusedHostScript(state).split("\n")[0], `${prefix} <<'CORTEN_UNUSED_HOST'`);
  for (const code of [1, 255])
    assert.equal(terminalSetupScript(state, code).split("\n")[0], `${prefix} '${code}' <<'CORTEN_FAILED_SETUP_HOST'`);
});

test("fixed failed-setup program proves pre-entry terminal setup, never native work", { skip: !available }, () => {
  const state = setupState(), files = remoteFiles(state);
  const hashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)]));
  const positives = ["failed", "inactive", "repo", "empty-campaign", "archive", "empty-user-data", "docker-idle", "containerd-idle", "process-race", "process-link-race", "code-255"];
  const negatives = ["active", "activating", "pid", "not-loaded", "wrong-unit", "fragment", "restart", "not-started", "start-na", "unit-job", "duplicate-property", "malformed-property", "show-failed", "wrong-host", "metadata-failed", "not-root",
    ...Object.keys(files).flatMap(name => ["changed-" + name, "missing-" + name]), "bench-symlink", "control-symlink", "unit-symlink", "repo-symlink", "campaign-symlink", "special-file", "marker", "marker-dangling", "attempt", "extra-data",
    "exit-zero", "exit-other", "exit-signed", "exit-padded", "exit-spaces", "exit-overflow", "exit-unicode", "exit-no-newline", "exit-literal-newline", "exit-extra-line", "other-unit", "jobs", "jobs-failed", "cloud-init", "cloud-failed", "cloud-json", "user-data", "user-data-symlink", "docker-running", "docker-failed", "docker-timeout", "process", "process-root", "process-groups", "process-cwd", "process-exe", "process-permission", ...parentNegatives, "parent-exit-code"];
  for (const mode of [...positives, ...negatives]) {
    const code = mode === "code-255" ? 255 : 1, script = terminalSetupScript(state, code);
    const program = script.split("<<'CORTEN_FAILED_SETUP_HOST'\n")[1].split("\nCORTEN_FAILED_SETUP_HOST")[0];
    assert.ok(program);
    const r = spawnSync(python, ["-c", setupFixture], { input: JSON.stringify({ mode, id: state.id, unit: state.unit, files, manifest: JSON.stringify(hashes), code, program }),
      encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
    const positive = positives.includes(mode);
    assert.equal(r.error, undefined, mode); assert.equal(r.status, positive ? 0 : 1, mode); assert.equal(r.stderr, "", mode);
    const observation = JSON.parse(r.stdout);
    if (positive) {
      assert.deepEqual(observation, { schema: "benchmark-failed-setup-host/v1", hostId: state.id, unit: state.unit,
        observedAtMs: 1000000, exitCode: code, setupFailed: true }, mode);
      const evidence = setupEvidence(r.stdout, state, script, code, 999999, 1000001);
      assert.equal(evidence.exitCode, code); assert.equal(evidence.archiveSha256, state.archiveSha256);
    } else assert.deepEqual(observation, { schema: "benchmark-failed-setup-host/v1", setupFailed: false }, mode);
  }
});

test("setup evidence binds expected exit, fixed script, preserved hashes and bounded observation", () => {
  const state = setupState(), script = terminalSetupScript(state, 1);
  const observation = { schema: "benchmark-failed-setup-host/v1", hostId: state.id, unit: state.unit, observedAtMs: 1000000, exitCode: 1, setupFailed: true };
  const proof = JSON.stringify(observation), evidence = setupEvidence(proof, state, script, 1, 999999, 1000001);
  assert.deepEqual(evidence, { schema: "benchmark-failed-setup-retirement/v1", round: state.round, commit: state.commit, id: state.id, unit: state.unit,
    archiveSha256: state.archiveSha256, evidenceSha256: state.evidenceSha256, exitCode: 1, scriptSha256: digest(script), observation,
    startedAtMs: 999999, finishedAtMs: 1000001 });
  assert.ok(!("validation" in evidence) && !("fullGroupQualified" in evidence));
  for (const code of [0, -1, 256, "1", NaN, Infinity, 1.5, undefined]) {
    assert.throws(() => terminalSetupScript(state, code));
    assert.throws(() => setupEvidence(proof, state, script, code, 999999, 1000001));
  }
  for (const changed of [{ hostId: "124" }, { unit: "foreign" }, { schema: "other" }, { exitCode: 2 }, { exitCode: "1" }, { setupFailed: false }, { setupFailed: 1 }, { observedAtMs: 994998 }, { observedAtMs: 1005002 }, { observedAtMs: 1.5 }, { rawLog: "private" }])
    assert.throws(() => setupEvidence(JSON.stringify({ ...observation, ...changed }), state, script, 1, 999999, 1000001));
  for (const raw of [null, "x".repeat(1025), "bad json", "[]", "null", "{}"])
    assert.throws(() => setupEvidence(raw, state, script, 1, 999999, 1000001));
  for (const [start, end] of [[1000001, 999999], [999999, 1030000], [NaN, 1000001], [999999, Infinity], [999999.5, 1000001]])
    assert.throws(() => setupEvidence(proof, state, script, 1, start, end));
  for (const key of ["archiveSha256", "evidenceSha256"]) for (const value of [undefined, "", "a".repeat(63), "g".repeat(64), "A".repeat(64), "a".repeat(64) + "\n"])
    assert.throws(() => setupEvidence(proof, { ...state, [key]: value }, script, 1, 999999, 1000001));
  assert.throws(() => setupEvidence(proof, state, script + "\n", 1, 999999, 1000001));
  assert.throws(() => setupEvidence(proof, state, terminalSetupScript(state, 2), 1, 999999, 1000001));
  assert.throws(() => setupEvidence(proof, { ...state, id: "124" }, script, 1, 999999, 1000001));
  assert.equal(setupEvidence(proof, state, script, 1, 1005000, 1005000).observation.observedAtMs, 1000000);
  assert.equal(setupEvidence(proof, state, script, 1, 995000, 995000).observation.observedAtMs, 1000000);
  assert.equal(setupEvidence(proof, state, script, 1, 985000, 1015000).exitCode, 1);
});

function firstGroupSetupState() {
  const fleet = fleetPlan({ round: "r21", commit, token: "f".repeat(16), sshKey: "42",
    provider: { accountId: "user:synthetic", context: "synthetic-control" },
    tokens: Object.fromEntries(selection().groups.map(({ group }, index) => [group, (index + 1).toString(16).padStart(16, "0")])) }, "2026-11-15T12:00:00.000Z");
  const { group, token } = fleet.jobs[0];
  return { ...reservation({ round: "r21", commit, token, group, fleet }), id: "123", ip: "192.0.2.10", status: "running",
    archiveSha256: "a".repeat(64), evidenceSha256: "b".repeat(64) };
}

test("fixed failed-setup program accepts only exact common tooling markers without native work", { skip: !available }, () => {
  const base = firstGroupSetupState(), canonical = `${JSON.stringify(bootstrapMarker(base))}\n`;
  const cases = [
    { label: "unobserved exact marker", marker: canonical, positive: true },
    { label: "observed exact marker", marker: canonical, observed: true, positive: true },
    { label: "unobserved marker and empty campaign", marker: canonical, mode: "empty-campaign", positive: true },
    { label: "observed marker and empty campaign", marker: canonical, observed: true, mode: "empty-campaign", positive: true },
    { label: "unobserved absent marker", positive: true },
    { label: "observed missing marker", observed: true },
    { label: "invalid marker", marker: "invalid" },
    { label: "observed foreign marker", marker: canonical.replace("benchmark-common-bootstrap/v1", "foreign/v1"), observed: true },
    ...["round", "commit", "token", "group"].map(key => ({ label: "foreign marker " + key,
      marker: `${JSON.stringify({ ...bootstrapMarker(base), [key]: "foreign" })}\n` })),
    { label: "marker without newline", marker: canonical.trimEnd() },
    { label: "marker extra newline", marker: canonical + "\n" },
    { label: "noncanonical marker", marker: `${JSON.stringify(bootstrapMarker(base), null, 1)}\n` },
    { label: "oversized marker", marker: "x".repeat(1025) },
    { label: "marker symlink", marker: canonical, markerKind: "symlink" },
    { label: "observed marker symlink", marker: canonical, markerKind: "symlink", observed: true },
    { label: "marker directory", markerKind: "directory" },
    { label: "dangling marker", mode: "marker-dangling" },
    { label: "marker with native files", marker: canonical, mode: "attempt" },
    { label: "observed marker with native files", marker: canonical, mode: "attempt", observed: true },
    ...["active", "pid", "jobs", "docker-running", "changed-job.sh", "process", "campaign-symlink"].map(mode => ({ label: "marker still refuses " + mode, marker: canonical, mode })),
  ];
  for (const item of cases) {
    const state = item.observed ? { ...base, bootstrapReady: { sha256: digest(canonical), observedAt: "2026-11-15T12:00:01.000Z" } } : base;
    const script = terminalSetupScript(state, 1), files = remoteFiles(state);
    const manifest = JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])));
    const program = script.split("<<'CORTEN_FAILED_SETUP_HOST'\n")[1].split("\nCORTEN_FAILED_SETUP_HOST")[0];
    const r = spawnSync(python, ["-c", setupFixture], { input: JSON.stringify({ mode: item.mode ?? "failed", id: state.id, unit: state.unit,
      files, manifest, code: 1, program, marker: item.marker, markerKind: item.markerKind }), encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
    assert.equal(r.error, undefined, item.label); assert.equal(r.status, item.positive ? 0 : 1, item.label); assert.equal(r.stderr, "", item.label);
    const observation = JSON.parse(r.stdout);
    if (item.positive) {
      assert.deepEqual(observation, { schema: "benchmark-failed-setup-host/v1", hostId: state.id, unit: state.unit,
        observedAtMs: 1000000, exitCode: 1, setupFailed: true }, item.label);
      const evidence = setupEvidence(r.stdout, state, script, 1, 999999, 1000001);
      assert.equal(evidence.scriptSha256, digest(script)); assert.equal(evidence.exitCode, 1);
    } else assert.deepEqual(observation, { schema: "benchmark-failed-setup-host/v1", setupFailed: false }, item.label);
  }
});

test("observed common-bootstrap hash and state remain bound to the exact setup script", () => {
  const state = firstGroupSetupState(), canonical = `${JSON.stringify(bootstrapMarker(state))}\n`;
  const observed = { ...state, bootstrapReady: { sha256: digest(canonical), observedAt: "2026-11-15T12:00:01.000Z" } };
  for (const bootstrapReady of [null, false, {}, { sha256: "a".repeat(64) }, { ...observed.bootstrapReady, sha256: digest(canonical.trimEnd()) }])
    assert.throws(() => terminalSetupScript({ ...state, bootstrapReady }, 1));
  const script = terminalSetupScript(observed, 1), unobservedScript = terminalSetupScript(state, 1);
  assert.notEqual(script, unobservedScript);
  const proof = JSON.stringify({ schema: "benchmark-failed-setup-host/v1", hostId: state.id, unit: state.unit,
    observedAtMs: 1000000, exitCode: 1, setupFailed: true });
  assert.throws(() => setupEvidence(proof, observed, unobservedScript, 1, 999999, 1000001));
  assert.throws(() => setupEvidence(proof, state, script, 1, 999999, 1000001));
  assert.equal(setupEvidence(proof, observed, script, 1, 999999, 1000001).scriptSha256, digest(script));
});
