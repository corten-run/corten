import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bootstrapWorkspaceScript, fleetPlan, preloginUserData, reservation, selection } from "./cloud-contract.mjs";
import { commit } from "./cloud-fixtures.mjs";
import { controlRequest, guardianSha256, guardianSource } from "./cloud-control-runtime.mjs";
import { failedNativeScript, setupEvidence, terminalSetupScript, unusedEvidence, unusedHostScript, verifyUnusedEvidence } from "./cloud-retirement.mjs";
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
    def lstat(self):
        if config.get('bootstrap'):
            if mode == 'custody-unreadable' and self.path == '/bench': raise PermissionError('private details')
            present = {'partial': '/bench', 'dangling-bench': '/bench', 'guardian': '/run/corten-bench-control-' + config['token'],
                       'unit-file': '/etc/systemd/system/' + unit, 'watcher-file': '/run/systemd/transient/' + config['watcher'],
                       'watcher-cgroup': '/sys/fs/cgroup/system.slice/' + config['watcher']}
            if self.path != present.get(mode): raise FileNotFoundError(self.path)
        return SimpleNamespace(st_mode=stat.S_IFREG)
    def iterdir(self):
        if self.path == '/bench' and config.get('firstUpload'):
            return [Entry('/bench/run.log')] + ([Entry('/bench/job.sh')] if mode == 'job-present' else [])
        if self.path == '/proc': return [Entry('/proc/' + pid) for pid in (['2', '3', '4', '5'] if mode == 'other-timeout' else ['2', '3', '4'])]
        if self.path == '/run' and mode == 'foreign-guardian': return [Entry('/run/corten-bench-control-foreign')]
        if self.path == '/run/systemd/transient' and mode == 'foreign-transient': return [Entry('/run/systemd/transient/corten-bench-control-foreign.service')]
        if self.path == '/sys/fs/cgroup/system.slice' and mode == 'foreign-cgroup': return [Entry('/sys/fs/cgroup/system.slice/corten-bench-control-foreign.service')]
        if mode in ['partial', 'file-mismatch']: return [Entry('/bench/job.sh')]
        if mode == 'bench-data': return [Entry('/bench/campaign')]
        return []
    def glob(self, pattern): return [Entry('/etc/systemd/system/' + unit)] if mode == 'loaded' and self.path == '/etc/systemd/system' else []
    def read_bytes(self):
        if self.path == '/bench/run.log': return b'output' if mode == 'worked' else b''
        if self.path == '/proc/4/cmdline': return parent_cmdline()
        if self.path == '/proc/5/cmdline': return parent_bytes
        assert self.path != '/proc/2/cmdline'
        if self.path.endswith('/cmdline'):
            return {'process': b'node /bench/job.sh', 'guardian-process': b'/usr/bin/python3 -I -c corten-control'}.get(mode, b'ordinary')
        if mode == 'file-mismatch': return b'changed'
        return config['files'].get(self.name, 'unexpected').encode()
def run(args, **kwargs):
    assert kwargs == dict(capture_output=True, text=True, timeout=5)
    if args[:2] == ['systemctl', 'show']:
        if config.get('bootstrap') and args[2] == config['watcher']:
            assert args[3:] == ['--property=LoadState']
            return SimpleNamespace(returncode=0, stdout='LoadState=' + ('loaded' if mode == 'watcher-loaded' else 'not-found'))
        assert args[2] == unit
        values = dict(Id=unit, LoadState='not-found', ActiveState='inactive', MainPID='0', FragmentPath='',
                      ExecMainStartTimestamp=('n/a' if mode == 'systemd249' else ''), ExecMainStartTimestampMonotonic='0', Job='', Restart='no')
        if mode == 'loaded': values.update(LoadState='loaded', FragmentPath='/etc/systemd/system/' + unit)
        for case, key, value in [('active', 'ActiveState', 'active'), ('pid', 'MainPID', '3'), ('started', 'ExecMainStartTimestamp', 'yesterday'), ('unit-job', 'Job', '1'), ('restart', 'Restart', 'always'), ('wrong-unit', 'Id', 'foreign.service')]:
            if mode == case: values[key] = value
        if mode == 'started': values['ExecMainStartTimestampMonotonic'] = '12345'
        if mode == 'malformed-timestamp': values['ExecMainStartTimestampMonotonic'] = '00'
        if mode == 'missing-timestamp': del values['ExecMainStartTimestampMonotonic']
        requested = [arg.removeprefix('--property=') for arg in args[3:]]
        return SimpleNamespace(returncode=0, stdout='\\n'.join(k + '=' + values[k] for k in requested if k in values))
    if args[:2] == ['systemctl', 'list-units']:
        assert args[2:] == ['--all', '--plain', '--no-legend', '--no-pager', 'corten-bench-control-*.service']
        watcher_row = config['watcher'] if mode == 'watcher-loaded' else 'corten-bench-control-foreign.service'
        return SimpleNamespace(returncode=0, stdout=watcher_row + ' loaded active running' if mode in ['watcher-loaded', 'foreign-watcher'] else '')
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
with patch.object(pathlib, 'Path', Entry), patch.object(os.path, 'lexists', lambda p: config.get('firstUpload') or mode in ['partial', 'file-mismatch', 'symlink', 'bench-data']), patch.object(os, 'getuid', lambda: 0, create=True), patch.object(os, 'getpid', lambda: 2), patch.object(os, 'getppid', parent_pid), patch.object(os, 'readlink', readlink), patch.object(urllib.request, 'urlopen', metadata), patch.object(subprocess, 'run', run), patch.object(time, 'time', lambda: 1000):
    exec(compile(config['program'], '<fixed-unused-probe>', 'exec'))
`;

test("fixed unused-host program accepts only never-started idle host observations", { skip: !available }, () => {
  const state = { ...reservation({ round: "r21", commit, token: "0123456789abcdef" }), id: "123", ip: "192.0.2.10", status: "preparing" };
  const script = unusedHostScript(state), program = script.split("<<'CORTEN_UNUSED_HOST'\n")[1].split("\nCORTEN_UNUSED_HOST")[0];
  assert.ok(program);
  const files = remoteFiles(state), manifest = JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])));
  for (const mode of ["empty", "systemd249", "partial", "loaded", "active", "pid", "started", "malformed-timestamp", "missing-timestamp", "unit-job", "restart", "wrong-unit", "wrong-host",
    "file-mismatch", "symlink", "bench-data", "docker", "jobs", "cloud-init", "user-data", "process", ...parentNegatives]) {
    const r = spawnSync(python, ["-c", fixture], { input: JSON.stringify({ mode, unit: state.unit, id: state.id, files, manifest, program }),
      encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
    const positive = ["empty", "systemd249", "partial", "loaded"].includes(mode);
    assert.equal(r.error, undefined, mode); assert.equal(r.stderr, "", mode);
    assert.equal(r.status, positive ? 0 : 1, mode);
    const result = JSON.parse(r.stdout);
    assert.equal(result.unused, positive, mode);
    assert.equal(result.schema, "benchmark-unused-host/v1");
    if (positive) assert.deepEqual(result, { schema: "benchmark-unused-host/v1", hostId: "123", unit: state.unit, observedAtMs: 1000000, unused: true });
  }
});

test("interrupted first SSH probe positively proves absence of the guardian and all benchmark setup", { skip: !available }, () => {
  const state = { ...reservation({ round: "r21", commit, token: "0123456789abcdef" }), id: "123", ip: "192.0.2.10", status: "preparing",
    createIntentAt: "2026-11-18T00:00:00.000Z", control: { helperSha256: guardianSha256, ledger: [], sealed: [], monitor: { phase: "pending" } } };
  const request = controlRequest(state, "ssh", [`root@${state.ip}`, "true"], 30000, "bootstrap");
  state.control.ledger.push({ request, localTerminal: false });
  const watcher = `corten-bench-control-${state.token}-${request.invocation.id}.service`;
  for (const hasRequest of [true, false]) {
    if (!hasRequest) state.control.ledger.pop();
    const program = unusedHostScript(state, { bootstrap: true }).split("<<'CORTEN_UNUSED_HOST'\n")[1].split("\nCORTEN_UNUSED_HOST")[0];
    const modes = hasRequest ? ["empty", "systemd249", "wrong-host", "active", "partial", "dangling-bench", "custody-unreadable", "loaded",
      "unit-file", "guardian", "foreign-guardian", "guardian-process", "watcher-file", "watcher-cgroup", "watcher-loaded", "jobs", "process", "docker"]
      : ["systemd249", "started", "guardian-process", "foreign-guardian", "foreign-transient", "foreign-cgroup", "foreign-watcher"];
    for (const mode of modes) {
      const positive = ["empty", "systemd249"].includes(mode);
      const r = spawnSync(python, ["-c", fixture], { input: JSON.stringify({ mode, unit: state.unit, id: state.id, token: state.token,
        watcher, files: {}, manifest: "{}", program, bootstrap: true }),
        encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
      assert.equal(r.error, undefined, mode); assert.equal(r.stderr, "", mode);
      assert.equal(r.status, positive ? 0 : 1, mode);
      assert.equal(JSON.parse(r.stdout).unused, positive, mode);
    }
  }
});

test("unused retirement replays legacy proofs and requires the key digest for a pinned proof", () => {
  const state = { ...reservation({ round: "r21", commit, token: "0123456789abcdef" }), id: "123", ip: "192.0.2.10", status: "preparing",
    createIntentAt: "2026-11-18T00:00:00.000Z" };
  const at = 1000000, raw = JSON.stringify({ schema: "benchmark-unused-host/v1", hostId: state.id, unit: state.unit, observedAtMs: at, unused: true });
  const legacy = unusedEvidence(raw, state, unusedHostScript(state, { legacyTimestamp: true }), at, at);
  verifyUnusedEvidence(legacy, state);
  state.control = { helperSha256: guardianSha256, ledger: [], sealed: [], monitor: { phase: "pending" } };
  const pinned = unusedEvidence(raw, state, unusedHostScript(state, { bootstrap: true }), at, at, "e".repeat(64));
  verifyUnusedEvidence(pinned, state);
  assert.throws(() => verifyUnusedEvidence({ ...pinned, knownHostsSha256: "not-a-digest" }, state));
  delete pinned.knownHostsSha256;
  assert.throws(() => verifyUnusedEvidence(pinned, state));
});

// Execute the emitted drain function with bounded synthetic observations. The
// native unused-host program above independently exercises unit and file proof.
const drainFixture = String.raw`import ast, hashlib, ipaddress, json, os, re, stat, sys
from types import SimpleNamespace as S
config = json.load(sys.stdin)
requests = config['requests']
functions = [n for n in ast.parse(config['program']).body if isinstance(n, ast.FunctionDef) and n.name in ('settled_receipts', 'refused_upload')]
interrupted = config.get('interrupted', False)
assert len(functions) == (2 if interrupted else 1)
code = compile(ast.Module(body=functions, type_ignores=[]), '<emitted-drain>', 'exec')
token = requests[0]['invocation']['token']
host = {'hostname': 'fixture', 'bootId': 'fixture-boot'}
binding = {**{k: requests[0]['invocation'][k] for k in ('round', 'commit', 'token')}, 'helperSha256': requests[0]['helperSha256']}
root_name = 'corten-bench-control-' + token
root_path = '/run/' + root_name
def row(pid, parent, cgroup):
    return {'pid': pid, 'parent': parent, 'startTicks': '100', 'cgroup': '0::' + cgroup + '\n', 'executable': {'device': '1', 'inode': '2'}}
listener = row(10, 1, '/system.slice/ssh.service')
probe = row(11, 10, '/user.slice/probe.scope')
names = {'binding.json': binding, 'helper.py': {}, 'mutex': {}}
units = []
for n, request in enumerate(requests):
    inv = request['invocation']
    identifier = inv['id']
    unit = root_name + '-' + identifier + '.service'
    units.append(unit)
    scope = '/user.slice/session-' + str(n) + '.scope'
    child, escaped, observer = row(20+n, 10, scope), row(40+n, 1, '/escaped.scope'), row(60+n, 1, '/system.slice/' + unit)
    registration = dict(invocation=inv, host=host, listener=listener, observer=observer, socket={'connection': str(n)},
                        session=dict(scope=scope, chain=[child]))
    result = {'transport': 'exited', 'code': 0}
    for prefix, data in dict(request=request, start={'unit': unit}, launcher={'unit': unit, 'code': 0}, registration=registration,
                             result=result, receipt=dict(schema='benchmark-control-session/v2', result=result, **registration,
                                                          samples=[{'processes': [listener, observer, child, escaped]}])).items():
        names[prefix+'-'+identifier+'.json'] = data
first = requests[0]['invocation']['id']
if interrupted:
    suffix = '-' + requests[-1]['invocation']['id'] + '.json'
    for prefix in ['registration', 'result', 'receipt']: del names[prefix+suffix]
    names['start'+suffix] = dict(unit=units[-1], guardian=710, child=711, deadlineMonoNs='100', connection='192.0.2.1 45678 192.0.2.10 22')
    names['watch-failure'+suffix] = {'helperLine': 1}
class Path:
    def __init__(self, value): self.value, self.name = value, value.rsplit('/', 1)[-1]
    def __truediv__(self, child): return Path(self.value+'/'+child)
    @property
    def parent(self): return Path(self.value.rsplit('/', 1)[0])
    def iterdir(self): return [self / name for name in records]
    def lstat(self):
        if mode == 'unknown-cgroup': raise PermissionError
        if mode == 'populated': return S(st_mode=stat.S_IFDIR)
        raise FileNotFoundError
    def read_text(self):
        assert self.name == 'cgroup.events'
        return 'populated 1\n'
    def glob(self, pattern):
        assert pattern == 'corten-bench-control-*'
        return [self / root_name] if self.value == '/run' else [self / units[0]] if mode == 'terminal' else []
def terminal(root, identifier, receipt):
    return None if mode == 'watcher' else {'unit': root_name + '-' + identifier + '.service'}
def scope_read(scope, rows):
    return {'exists': True, 'members': [], 'events': 'populated 1\n' if mode == 'scope' else 'populated 0\n'}
def run(args, **kwargs):
    if args[:3] == ['systemctl', 'show', '--all']:
        assert args[3] == units[-1] and kwargs['check'] and kwargs['timeout'] == 5
        values = dict(Id=args[3], LoadState='loaded', ActiveState='failed', SubState='failed', Restart='no',
                      MainPID='0', ControlPID='0', NRestarts='0', Job='', Triggers='', TriggeredBy='', ExecMainCode='1', ExecMainStatus='254')
        for case, key, value in [('live-watcher','MainPID','712'), ('trigger','TriggeredBy','later.timer'), ('pending-watch','Job','3'), ('retry','Restart','on-failure')]:
            if mode == case: values[key] = value
        return S(stdout='\n'.join(k+'='+values[k] for k in (a.removeprefix('--property=') for a in args[4:])))
    assert args[-1] == 'corten-bench-control-*.service' and kwargs['timeout'] == 5
    return S(returncode=0, stdout='foreign.service loaded active\n' if mode == 'foreign-watcher' else '')
def raw(path): return json.dumps(records[path.name]).encode()
def inventory():
    rows = [listener, probe]
    if mode == 'sftp': rows.append(dict(row(91, 1, '/other.scope'), executable=dict(device='33', inode='44')))
    if mode == 'escaped': rows.append(row(40, 1, '/escaped.scope'))
    if mode == 'other-session': rows.append(row(90, 10, '/unknown.scope'))
    if mode == 'foreign-control': rows.append(row(90, 1, '/system.slice/corten-bench-control-foreign.service'))
    if mode == 'changed-listener': rows[0] = dict(listener, startTicks='101')
    return {p['pid']:p for p in rows}
def load(root, name): return records[name]
g = dict(private=lambda root: None, load=load, read=raw, ancestry=lambda *args: (listener, [probe], None),
         host=lambda: host, watcher_terminal=terminal, inventory=inventory, key=lambda p: (p['pid'],p['startTicks']),
         scope_read=scope_read, parent=lambda p: p['parent'])
def os_stat(path):
    if path == '/usr/lib/openssh/sftp-server': return S(st_dev=33, st_ino=44)
    assert path in ('/proc/710','/proc/711')
    if (mode, path) in [('guardian','/proc/710'), ('child','/proc/711')]: return S()
    if mode == 'unreadable': raise PermissionError
    raise FileNotFoundError
g.update(ipaddress=ipaddress, address=ipaddress.ip_address, socket_rows=lambda: [(['0:', '192.0.2.10:0016','192.0.2.1:B26E'], '')] if mode == 'socket' else [])
space = dict(hashlib=hashlib, json=json, stat=stat, os=S(getpid=os.getpid, environ={'SSH_CONNECTION':'fixture'}, stat=os_stat),
             time=S(monotonic_ns=lambda: 99 if mode == 'before-deadline' else 101), source=b'fixture\n', re=re,
             pathlib=S(Path=Path), subprocess=S(run=run))
exec(code, space)
for mode in ['terminal', 'missing', 'extra', 'wrong-host', 'wrong-request', 'partial-result', 'watcher', 'scope', 'escaped', 'other-session',
             'foreign-control', 'foreign-watcher', 'changed-listener'] + (['guardian','child','sftp','unreadable','before-deadline','socket','populated',
             'unknown-cgroup','live-watcher','trigger','pending-watch','retry','no-failure','late-registration','foreign-request','wrong-launcher'] if interrupted else []):
    records = dict(names)
    if mode == 'missing': del records['receipt-'+first+'.json']
    if mode == 'extra': records['seal-bootstrap.json'] = {}
    if mode == 'no-failure': del records['watch-failure'+suffix]
    if mode == 'late-registration': records['registration'+suffix] = {}
    if mode == 'foreign-request': records['request'+suffix] = requests[0]
    if mode == 'wrong-launcher': records['launcher'+suffix] = dict(unit=units[0], code=0)
    if mode == 'wrong-host': records['receipt-'+first+'.json'] = dict(records['receipt-'+first+'.json'], host={})
    if mode == 'wrong-request': records['request-'+first+'.json'] = {}
    if mode == 'partial-result':
        records['result-'+first+'.json'] = {'code': 0}
        records['receipt-'+first+'.json'] = dict(records['receipt-'+first+'.json'], result=records['result-'+first+'.json'])
    try:
        result = space['settled_receipts'](Path(root_path), binding, requests, g)
    except (AssertionError, KeyError, PermissionError):
        if mode == 'terminal': raise
        continue
    assert mode == 'terminal', mode
    if interrupted:
        result, refused = result
        assert refused == dict(invocationId=requests[-1]['invocation']['id'],jobPresent=False,failureSha256=hashlib.sha256(raw(Path('watch-failure'+suffix))).hexdigest())
    assert result == [hashlib.sha256(raw(Path('receipt-'+r['invocation']['id']+'.json'))).hexdigest() for r in (requests[:-1] if interrupted else requests)]
print('drain fixtures passed')
`;

test("settled bootstrap probe requires exact requests, terminal watchers, dead sessions and no foreign actors", { skip: !available }, () => {
  const state = { ...reservation({ round: "r21", commit, token: "0123456789abcdef" }), id: "123", ip: "192.0.2.10", status: "preparing",
    createIntentAt: "2026-11-18T00:00:00.000Z", control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: [],
      monitor: { schema: "benchmark-supervised-control/v1", id: "a".repeat(32), phase: "pending" } } };
  const steps = [["ssh", "true", 30000], ["ssh", "mkdir -m 700 /bench && touch /bench/run.log", 60000]];
  for (const [name, content] of Object.entries(remoteFiles(state)).slice(0, 2))
    steps.push(["scp", "/bench/" + name, 15 * 60000],
      ["ssh", "printf '%s  %s\\n' '" + digest(content) + "' '/bench/" + name + "' | sha256sum --check --status", 60000]);
  for (const [binary, payload, timeout] of steps) {
    const request = controlRequest(state, binary, ["fixture", payload], timeout, "bootstrap");
    state.control.ledger.push({ request, code: 0, localTerminal: true });
  }
  const script = unusedHostScript(state, { bootstrap: true });
  const program = script.split("<<'CORTEN_UNUSED_HOST'\n")[1].split("\nCORTEN_UNUSED_HOST")[0];
  const requests = state.control.ledger.map((row) => row.request);
  const r = spawnSync(python, ["-I", "-c", drainFixture], { input: JSON.stringify({ program, requests }),
    encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
  assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "drain fixtures passed");
});

function lostUploadState({ offline = false, prelogin = offline } = {}) {
  const state = { ...firstGroupSetupState(offline), createIntentAt: "2026-11-18T00:00:00.000Z", status: "preparing", launchHostKeySha256: "e".repeat(64),
    ...(prelogin ? { quietBootstrap: "prelogin" } : {}), ...(offline ? { gitSource: true } : {}),
    control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, sealed: [], ledger: [],
      ...(offline ? {} : { monitor: { schema: "benchmark-supervised-control/v1", id: "b".repeat(32), phase: "pending" } }) } };
  delete state.archiveSha256; delete state.evidenceSha256;
  for (const [binary, args, ms] of [["ssh", ["true"], 30000], ["ssh", [bootstrapWorkspaceScript(state, { launch: true })], 60000],
    ["scp", ["/fixture/job.sh", "root@192.0.2.10:/bench/job.sh"], 900000]]) {
    state.control.ledger.push({ request: controlRequest(state, binary, args, ms, "bootstrap"), localTerminal: binary === "ssh", ...(binary === "ssh" ? { code: 0 } : {}) });
  }
  return state;
}

for (const offline of [false, true]) test(`complete ${offline ? "offline" : "supervised"} lost-upload guest proof binds unused retirement`, { skip: !available }, () => {
  const state = lostUploadState({ offline, prelogin: true });
  const script = unusedHostScript(state, { bootstrap: true }), at = 1000000;
  const requests = state.control.ledger.map(r => r.request);
  const guest = fileURLToPath(new URL("./test-fixtures/unused-upload-guest.py", import.meta.url));
  const run = mode => spawnSync(python, ["-I", guest], { input: JSON.stringify({ script, requests, guardianSource, preloginUserData,
    hostId: state.id, unit: state.unit, mode }), encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
  const r = run("unused");
  assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr + r.stdout);
  const record = unusedEvidence(r.stdout, state, script, at, at, state.launchHostKeySha256);
  assert.deepEqual(record.observation.refusedUpload, { invocationId: requests[2].invocation.id, jobPresent: false,
    failureSha256: digest('{"helperLine":318}\n') });
  verifyUnusedEvidence(record, state);
  if (offline) for (const mode of ["job-present", "unknown-file", "remote-seal", "started", "different-user-data"]) {
    const refusal = run(mode);
    assert.equal(refusal.error, undefined);
    assert.equal(refusal.status, 1, `${mode}: ${refusal.stderr} ${refusal.stdout}`);
    assert.deepEqual(JSON.parse(refusal.stdout), { schema: "benchmark-unused-host/v1", unused: false }, mode);
    assert.throws(() => unusedEvidence(refusal.stdout, state, script, at, at, state.launchHostKeySha256), { name: "AssertionError" });
  }
});

test("lost first upload requires an absent job and a dead, unregistered transfer on the bound guest", { skip: !available }, () => {
  const state = lostUploadState();
  const script = unusedHostScript(state, { bootstrap: true }), program = script.split("<<'CORTEN_UNUSED_HOST'\n")[1].split("\nCORTEN_UNUSED_HOST")[0];
  assert.ok(script.startsWith(`/usr/bin/timeout 25 /usr/bin/python3 - '${state.id}' '${state.unit}' '{}'`));
  const requests = state.control.ledger.map(r => r.request);
  const check = (driver, input, status) => {
    const r = spawnSync(python, ["-I", "-c", driver], { input: JSON.stringify(input), encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
    assert.equal(r.error, undefined); assert.equal(r.status, status, `${input.mode ?? "drain"}: ${r.stderr} ${r.stdout}`);
    return r.stdout.trim();
  };
  assert.equal(check(drainFixture, { program, requests, interrupted: true }, 0), "drain fixtures passed");
  // Exercise the actual filesystem/unit gates separately from the helper's mocked namespace.
  const guest = program.split("\nimport re\ndef refused_upload(")[0];
  assert.notEqual(guest, program);
  for (const mode of ["empty", "job-present", "worked", "unit-job", "started", "loaded", "jobs", "wrong-host", "process"]) {
    const out = check(fixture, { firstUpload: true, mode, unit: state.unit, id: state.id, manifest: "{}", files: {}, program: guest }, mode === "empty" ? 0 : 1);
    if (mode !== "empty") assert.equal(JSON.parse(out).unused, false, mode);
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

function firstGroupSetupState(offline = false) {
  const single = offline ? { group: "json-api", checkout: fileURLToPath(new URL("../..", import.meta.url)),
    indexSha256: "b".repeat(64), offlineHandoff: true } : undefined;
  const fleet = fleetPlan({ round: "r21", commit, token: "f".repeat(16), sshKey: "42",
    provider: { accountId: "user:synthetic", context: "synthetic-control" },
    tokens: Object.fromEntries(selection().groups.filter(({ group }) => !single || group === single.group)
      .map(({ group }, index) => [group, (index + 1).toString(16).padStart(16, "0")])) },
    "2026-11-15T12:00:00.000Z", undefined, single ? { stagedPlacement: true, single } : undefined);
  const { group, token } = fleet.jobs[0];
  return { ...reservation({ round: "r21", commit, token, group, fleet }), id: "123", ip: "192.0.2.10", status: "running",
    archiveSha256: "a".repeat(64), evidenceSha256: "b".repeat(64) };
}

test("only new dedicated reservations require the exact fixed boot data in all three custody probes", {
  skip: process.platform !== "linux",
}, () => {
  const s = { ...firstGroupSetupState(), quietBootstrap: "prelogin", control: { schema: "benchmark-control-ledger/v1",
    helperSha256: guardianSha256, sealed: [], ledger: [], monitor: { schema: "benchmark-supervised-control/v1",
      id: "b".repeat(32), phase: "pending" } } };
  s.control.ledger.push({ localTerminal: true, code: 0, request: controlRequest(s, "ssh", ["true"], 30000, "bootstrap") });
  const scripts = (saved) => [unusedHostScript(saved), terminalSetupScript(saved, 1),
    failedNativeScript(saved, null, null, { roots: ["/bench/campaign"], host: {} })];
  const [unused, setup, native] = scripts({ ...s, quietBootstrap: "after-start" });
  assert.match(unused, /not user_data\.exists\(\) or user_data\.stat\(\)\.st_size == 0/);
  assert.match(setup, /regular\(user_data, 0\)/);
  assert.match(native, /data\(instance, 'user-data.txt', 0\) == b''/);
  const programs = scripts(s);
  const proof = programs[0].match(/cloud_binding = None[\s\S]*?            os\.close\(fd\)/)[0];
  for (const program of programs) {
    assert.ok(program.includes(proof));
    assert.match(program, /^ *cloud_instance\(\)$/m);
    assert.doesNotMatch(program, /regular\(user_data, 0\)|not user_data\.exists\(\)|data\(instance, 'user-data.txt', 0\)/);
  }
  // Redirect only the descriptor walk's root. The canonical absolute selector,
  // inode checks, bounded reads and content comparisons are the generated probe.
  const info = programs[0].match(/def info\(s\):\n    return \[[^\n]+\]/)[0];
  const code = `import hashlib, os, pathlib, re, stat, tempfile
${info}
${proof.replace("directory(None, '/')", "directory(None, root)")}
host_id = '123'
with tempfile.TemporaryDirectory() as root:
    cloud = pathlib.Path(root, 'var/lib/cloud')
    inst = cloud / 'instances' / host_id
    inst.mkdir(parents=True)
    (cloud / 'data').mkdir()
    (cloud / 'data/instance-id').write_text(host_id)
    (cloud / 'instance').symlink_to('/var/lib/cloud/instances/' + host_id)
    path = inst / 'user-data.txt'
    fixed = ${JSON.stringify(preloginUserData)}.encode('ascii')
    for data in [None, b'', fixed[:-1], b'x' + fixed[1:], fixed + b'x', fixed]:
        cloud_binding = None
        if data is not None: path.write_bytes(data)
        try: cloud_instance()
        except (AssertionError, FileNotFoundError):
            assert data != fixed
        else: assert data == fixed
    path.rename(inst / 'other')
    path.symlink_to('other')
    cloud_binding = None
    try: cloud_instance()
    except OSError: pass
    else: raise AssertionError('accepted a linked payload')
`;
  const result = spawnSync(python, ["-I", "-c", code], { encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
});

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
