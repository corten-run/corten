import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { reservation } from "./cloud-contract.mjs";
import { commit } from "./cloud-fixtures.mjs";
import { unusedHostScript } from "./cloud-retirement.mjs";

const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true }).status === 0;
// Execute the exact emitted Python with only its operating-system observations
// substituted. This never contacts metadata, reads /proc or operates systemd.
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
        if self.path == '/proc': return [Entry('/proc/3')]
        if mode in ['partial', 'file-mismatch']: return [Entry('/bench/job.sh')]
        if mode == 'bench-data': return [Entry('/bench/campaign')]
        return []
    def glob(self, pattern): return [Entry('/etc/systemd/system/' + unit)] if mode == 'loaded' and self.path == '/etc/systemd/system' else []
    def read_bytes(self):
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
sys.argv = ['-', config['id'], unit, json.dumps({name: hashlib.sha256(value.encode()).hexdigest() for name, value in config['files'].items()})]
with patch.object(pathlib, 'Path', Entry), patch.object(os.path, 'lexists', lambda p: mode in ['partial', 'file-mismatch', 'symlink', 'bench-data']), patch.object(os, 'getuid', lambda: 0, create=True), patch.object(os, 'getpid', lambda: 2), patch.object(urllib.request, 'urlopen', metadata), patch.object(subprocess, 'run', run), patch.object(time, 'time', lambda: 1000):
    exec(compile(config['program'], '<fixed-unused-probe>', 'exec'))
`;

test("fixed unused-host program accepts only never-started idle host observations", { skip: !available }, () => {
  const state = { ...reservation({ round: "r21", commit, token: "0123456789abcdef" }), id: "123", ip: "192.0.2.10", status: "preparing" };
  const script = unusedHostScript(state), program = script.split("<<'CORTEN_UNUSED_HOST'\n")[1].split("\nCORTEN_UNUSED_HOST")[0];
  assert.ok(program);
  const files = { "job.sh": "fixed job", [state.unit]: "fixed unit" };
  for (const mode of ["empty", "partial", "loaded", "active", "pid", "started", "unit-job", "restart", "wrong-unit", "wrong-host",
    "file-mismatch", "symlink", "bench-data", "docker", "jobs", "cloud-init", "user-data", "process"]) {
    const r = spawnSync(python, ["-c", fixture], { input: JSON.stringify({ mode, unit: state.unit, id: state.id, files, program }),
      encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
    const positive = ["empty", "partial", "loaded"].includes(mode);
    assert.equal(r.status, positive ? 0 : 1, mode);
    const result = JSON.parse(r.stdout);
    assert.equal(result.unused, positive, mode);
    assert.equal(result.schema, "benchmark-unused-host/v1");
    if (positive) assert.deepEqual(result, { schema: "benchmark-unused-host/v1", hostId: "123", unit: state.unit, observedAtMs: 1000000, unused: true });
  }
});
