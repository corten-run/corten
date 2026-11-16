// Retirement evidence is separate from benchmark qualification. No operations on import.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { digest, evidenceEnvelope, fileHash, physical, regular, treeHash } from "./cloud-local.mjs";
import { bootstrapMarker, remoteFiles } from "./cloud-remote.mjs";
import { quote } from "./cloud-transport.mjs";

// This migration is not a general old-source collection or validation override.
export const failedNativeCommit = "9f3d35884c67d90524f978d173fabeb3a17bc970";
export function failedNativeRoots(state) {
  assert.equal(state.commit, failedNativeCommit, "unsupported failed-native measured source");
  assert.equal(state.round, "r21", "unsupported failed-native round");
  const roots = { "catalog-page": ["bench/catalog/results/c21"], "json-api": ["bench/json-api/results/j42", "bench/json-api/results/j43"],
    "localized-marketplace": ["bench/marketplace/results/r21"], "fullstack-browser": ["bench/fullstack-browser/work/w21"],
    "client-heavy": ["bench/client-heavy/work/w21"], "live-delivery": ["bench/live/results/parity/r21"],
    "recoverable-live": ["bench/recoverable-live/results/r21"], hardening: ["bench/hardening/results/w21"] };
  assert.ok(Object.hasOwn(roots, state.group), "unsupported failed-native group");
  return ["/bench/campaign", ...roots[state.group].map((path) => `/bench/repo/${path}`)];
}
export function failedNativeArchive(local, state) {
  const roots = failedNativeRoots(state);
  assert.equal(fileHash(join(local, "results.tgz")), state.archiveSha256, "original failed archive changed");
  const extracted = join(local, state.evidence); physical(extracted);
  assert.equal(treeHash(extracted), state.evidenceSha256, "original failed extraction changed");
  assert.equal(regular(join(extracted, "exit-code"), 16).toString("ascii"), "2\n", "migration requires the saved failure exit, not a successful report");
  const folder = join(extracted, "campaign"); physical(folder);
  const names = readdirSync(folder), campaigns = names.filter((name) => /^r21-[a-f0-9]{16}$/.test(name));
  assert.equal(campaigns.length, 1, "one original failed campaign required");
  assert.ok(names.every((name) => name === campaigns[0] || name === ".host-attempt.json"), "unknown campaign root");
  const campaign = campaigns[0], dir = join(folder, campaign); physical(dir);
  const plan = JSON.parse(regular(join(dir, "plan.json"))), result = JSON.parse(regular(join(dir, "campaign-result.json")));
  assert.equal(plan.schema, "benchmark-isolated-group-campaign/v1");
  assert.equal(plan.commit, state.commit); assert.equal(plan.round, state.round); assert.deepEqual(plan.order, [state.group]);
  assert.equal(plan.bindings.length, 1); assert.equal(plan.bindings[0].request.group, state.group);
  assert.ok(roots.includes(`/bench/repo/${plan.bindings[0].validation.artifactRoot}`), "unknown reserved native root");
  assert.equal(result.status.campaign, campaign); assert.equal(result.status.round, state.round);
  assert.equal(result.status.campaignSha256, plan.campaignSha256);
  assert.ok(["preserved-uncertain", "finished"].includes(result.status.state), "saved failed terminal campaign required");
  assert.ok(Array.isArray(result.status.uncollectedNativeRoots));
  for (const pending of result.status.uncollectedNativeRoots) {
    assert.equal(pending.group, state.group);
    assert.ok(["prepare", "timing"].includes(pending.phase));
    assert.ok(roots.includes(`/bench/repo/${pending.artifactRoot}`), "unaccounted pending native output");
  }
  return { campaign, roots };
}

// Only trusted controller code runs remotely. Native files are opened as data,
// never imported, invoked, followed through links, or promoted to valid evidence.
export function failedNativeScript(state, captureSha256 = null, fence = null) {
  const roots = failedNativeRoots(state);
  assert.ok(captureSha256 === null || /^[a-f0-9]{64}$/.test(captureSha256));
  if (fence !== null) {
    assert.equal(fence.snapshotSha256, captureSha256);
    assert.deepEqual(fence.roots.map((root) => root.path), [...roots, "/bench/run.log", "/bench/host.txt", "/bench/exit-code", "/bench/results.tgz"]);
  }
  const files = Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  const config = { roots, files, archiveSha256: state.archiveSha256, captureSha256, marker: `${JSON.stringify(bootstrapMarker(state))}\n`,
    requireMarker: state.bootstrapReady !== undefined, commit: state.commit, bounds: evidenceEnvelope, fence };
  return `/usr/bin/timeout 600 /usr/bin/python3 - ${quote(state.id)} ${quote(state.unit)} ${quote(JSON.stringify(config))} <<'CORTEN_FAILED_NATIVE_HOST'
import configparser, hashlib, io, json, os, pathlib, re, stat, subprocess, sys, tarfile, time, urllib.request
host_id, unit, raw_config = sys.argv[1:]
c = json.loads(raw_config)
def failed(kind, value, traceback):
    print(json.dumps(dict(schema='benchmark-failed-native-host/v1', custody=False)))
sys.excepthook = failed
assert os.getuid() == 0
os.umask(0o077)
def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')
def sha(data):
    return hashlib.sha256(data).hexdigest()
def info(s):
    return [s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns]
def opened(path, flags=os.O_RDONLY):
    parts = path.split('/')
    assert parts[0] == '' and all(p not in ['', '.', '..'] for p in parts[1:])
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        try:
            before = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            assert flags & os.O_CREAT and flags & os.O_EXCL or not flags & os.O_CREAT
            before = None
        if before is not None:
            assert stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode) and before.st_nlink == 1
        result = os.open(parts[-1], flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
        if before is not None:
            try:
                assert info(before) == info(os.fstat(result))
            except:
                os.close(result)
                raise
        return result
    finally:
        os.close(fd)
def small(path, limit):
    fd = opened(path)
    try:
        s = os.fstat(fd)
        assert stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= limit
        data = os.read(fd, limit + 1)
        assert len(data) == s.st_size and info(s) == info(os.fstat(fd))
        return data
    finally:
        os.close(fd)
def command(args):
    r = subprocess.run(args, capture_output=True, text=True, timeout=5)
    assert r.returncode == 0
    return r.stdout
parent_pid = os.getppid()
parent = pathlib.Path('/proc') / str(parent_pid)
parent_command = b'\\0'.join(os.fsencode(arg) for arg in ['/usr/bin/timeout', '600', '/usr/bin/python3'] + sys.argv) + b'\\0'
def quiet():
    assert parent_pid > 1 and os.getppid() == parent_pid and parent_pid != os.getpid()
    assert (parent / 'cmdline').read_bytes() == parent_command and os.readlink(parent / 'exe') == '/usr/bin/timeout'
    with urllib.request.urlopen('http://169.254.169.254/metadata/v1/id', timeout=3) as response:
        assert response.read(64).decode().strip() == host_id
    properties = ['Id', 'LoadState', 'FragmentPath', 'ActiveState', 'Restart', 'MainPID', 'Job', 'ExecMainCode', 'ExecMainStatus', 'ExecMainStartTimestamp']
    lines = command(['systemctl', 'show', unit] + ['--property=' + p for p in properties]).splitlines()
    assert len(lines) == len(properties) and all('=' in line for line in lines)
    v = dict(line.split('=', 1) for line in lines)
    assert set(v) == set(properties) and v['Id'] == unit and v['LoadState'] == 'loaded'
    assert v['FragmentPath'] == '/etc/systemd/system/' + unit
    assert v['ActiveState'] in ['inactive', 'failed'] and v['Restart'] == 'no' and v['MainPID'] == '0' and v['Job'] == ''
    assert v['ExecMainCode'] == '1' and v['ExecMainStatus'] == '2' and v['ExecMainStartTimestamp'].strip() not in ['', 'n/a']
    assert command(['systemctl', 'list-jobs', '--no-legend', '--no-pager']).strip() == ''
    assert json.loads(command(['cloud-init', 'status', '--format', 'json']))['status'] == 'done'
    if os.path.lexists('/var/lib/cloud/instance/user-data.txt'):
        assert small('/var/lib/cloud/instance/user-data.txt', 0) == b''
    for name, expected in c['files'].items():
        assert sha(small('/bench/' + name, 1048576)) == expected
    assert sha(small('/etc/systemd/system/' + unit, 1048576)) == c['files'][unit]
    for base in ['/etc/systemd/system', '/run/systemd/system']:
        for entry in pathlib.Path(base).glob('corten-bench*'):
            assert str(entry) == '/etc/systemd/system/' + unit
    if os.path.lexists('/bench/bootstrap-ready.json'):
        assert small('/bench/bootstrap-ready.json', 1024) == c['marker'].encode('ascii')
    else:
        assert not c['requireMarker']
    assert small('/bench/exit-code', 16) == b'2\\n'
    assert small('/bench/repo/.git/HEAD', 128) == (c['commit'] + '\\n').encode('ascii')
    git = configparser.ConfigParser(interpolation=None)
    git.read_string(small('/bench/repo/.git/config', 65536).decode('utf8'))
    assert git['remote "origin"']['url'] == 'https://github.com/corten-run/corten.git'
    if os.path.lexists('/run/docker.sock') or os.path.lexists('/run/containerd/containerd.sock'):
        assert command(['docker', 'ps', '--quiet', '--no-trunc']).strip() == ''
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit() or int(entry.name) in [os.getpid(), parent_pid]:
            continue
        try:
            cmd = (entry / 'cmdline').read_bytes()
            assert b'/bench' not in cmd and b'corten-bench-groups-' not in cmd
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
quiet()
nodes, content, names, members = 0, 0, 0, 0
def inventory(path, key=''):
    global nodes, content, names, members
    try:
        fd = opened(path)
    except FileNotFoundError:
        assert key == ''
        return None
    try:
        s = os.fstat(fd)
        kind = 'd' if stat.S_ISDIR(s.st_mode) else 'f'
        assert kind == 'd' or stat.S_ISREG(s.st_mode) and s.st_nlink == 1
        nodes += 1
        names += len(key.rsplit('/', 1)[-1])
        members += len(key)
        assert nodes <= c['bounds']['nodes'] - 16 and names <= c['bounds']['nameBytes'] and members <= c['bounds']['memberBytes']
        assert key.count('/') < 60 and len(key) < 3800
        rows = [dict(key=key, kind=kind, metadata=info(s))]
        if kind == 'd':
            children = sorted(os.listdir(fd))
            for name in children:
                assert name.isascii() and re.fullmatch(r'[][A-Za-z0-9_.@$%+-]+', name) and name not in ['.', '..']
                assert len(name) <= 255 and not name.endswith('.') and not re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.].*)?', name)
                child = inventory(path + '/' + name, key + '/' + name)
                assert child is not None
                rows.extend(child)
        else:
            content += s.st_size
            assert content <= c['bounds']['content']
        assert info(s) == info(os.fstat(fd))
        return rows
    finally:
        os.close(fd)
# Validate and hash every node's metadata before reading any evidence payload.
all_roots = c['roots'] + ['/bench/run.log', '/bench/host.txt', '/bench/exit-code', '/bench/results.tgz']
inventories = [inventory(path) for path in all_roots]
assert inventories[0] is not None and all(rows is not None for rows in inventories[len(c['roots']):])
metadata_bytes = encoded(inventories)
metadata_sha = sha(metadata_bytes)
def consume(path, row, callback):
    fd = opened(path)
    try:
        assert info(os.fstat(fd)) == row['metadata'] and row['kind'] == 'f'
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            callback(block)
        assert info(os.fstat(fd)) == row['metadata']
    finally:
        os.close(fd)
hashes = {}
roots = []
if c['fence'] is not None:
    assert metadata_sha == c['fence']['metadataSha256']
    roots = c['fence']['roots']
for index, (path, rows) in enumerate([] if c['fence'] is not None else zip(all_roots, inventories)):
    if rows is None:
        roots.append(dict(path=path, present=False))
        continue
    h = hashlib.sha256()
    size = 0
    for row in rows:
        key = row['key']
        if row['kind'] == 'd':
            h.update(('d\\0' + key + '\\0').encode('ascii'))
        else:
            size += row['metadata'][4]
            h.update(('f\\0' + key + '\\0' + str(row['metadata'][4]) + '\\0').encode('ascii'))
            f = hashlib.sha256()
            def update(block):
                h.update(block)
                f.update(block)
            consume(path + key, row, update)
            hashes[path + key] = f.hexdigest()
    roots.append(dict(path=path, present=True, treeSha256=h.hexdigest(), nodes=len(rows), bytes=size))
if c['fence'] is None:
    assert hashes['/bench/results.tgz'] == c['archiveSha256']
snapshot = dict(roots=roots, metadataSha256=metadata_sha)
snapshot_sha = sha(encoded(snapshot))
archive = '/bench/failed-native-custody.tgz'
if c['captureSha256'] is None:
    # Exclusive publication: unexplained/partial capture files are never adopted.
    fd = opened(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    with os.fdopen(fd, 'wb') as target:
        with tarfile.open(fileobj=target, mode='w|gz', format=tarfile.GNU_FORMAT) as tar:
            def data(name, value):
                t = tarfile.TarInfo(name)
                t.mode, t.size = 0o600, len(value)
                tar.addfile(t, io.BytesIO(value))
            data('campaign/custody-metadata.json', metadata_bytes)
            data('campaign/custody-files.json', encoded(hashes))
            data('campaign/custody-snapshot.json', encoded(snapshot))
            for index, (path, rows) in enumerate(zip(all_roots[:-1], inventories[:-1])):
                if rows is None:
                    continue
                prefix = 'campaign/root-' + str(index) if index < len(c['roots']) else path.rsplit('/', 1)[-1]
                for row in rows:
                    t = tarfile.TarInfo(prefix + row['key'] + ('/' if row['kind'] == 'd' else ''))
                    t.mode = 0o700 if row['kind'] == 'd' else 0o600
                    if row['kind'] == 'd':
                        t.type = tarfile.DIRTYPE
                        tar.addfile(t)
                    else:
                        t.size = row['metadata'][4]
                        f = opened(path + row['key'])
                        with os.fdopen(f, 'rb') as source:
                            assert info(os.fstat(source.fileno())) == row['metadata']
                            class Reader:
                                def __init__(self): self.hash = hashlib.sha256()
                                def read(self, n):
                                    block = source.read(n)
                                    self.hash.update(block)
                                    return block
                            reader = Reader()
                            tar.addfile(t, reader)
                            assert reader.hash.hexdigest() == hashes[path + row['key']]
                            assert info(os.fstat(source.fileno())) == row['metadata']
        target.flush()
        os.fsync(target.fileno())
else:
    assert snapshot_sha == c['captureSha256']
archive_row = inventory(archive)[0]
assert archive_row['metadata'][4] <= c['bounds']['compressed']
h = hashlib.sha256()
consume(archive, archive_row, h.update)
archive_sha = h.hexdigest()
if c['fence'] is not None:
    assert archive_sha == c['fence']['archiveSha256']
# Both the captured paths and their metadata must remain current after copying.
nodes, content, names, members = 0, 0, 0, 0
assert encoded([inventory(path) for path in all_roots]) == metadata_bytes
quiet()
print(json.dumps(dict(schema='benchmark-failed-native-host/v1', hostId=host_id, unit=unit, custody=True,
    roots=roots, metadataSha256=metadata_sha, snapshotSha256=snapshot_sha, archiveSha256=archive_sha,
    observedAtMs=int(time.time()*1000), historicalAccountingQualified=False)))
CORTEN_FAILED_NATIVE_HOST`;
}

export function failedNativeObservation(raw, state, startedAtMs, finishedAtMs) {
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 16384, "bounded custody observation required");
  const observation = JSON.parse(raw);
  assert.deepEqual(Object.keys(observation).sort(), ["archiveSha256", "custody", "historicalAccountingQualified", "hostId", "metadataSha256", "observedAtMs", "roots", "schema", "snapshotSha256", "unit"].sort());
  assert.equal(observation.schema, "benchmark-failed-native-host/v1");
  assert.equal(observation.hostId, state.id); assert.equal(observation.unit, state.unit);
  assert.equal(observation.custody, true); assert.equal(observation.historicalAccountingQualified, false);
  for (const key of ["archiveSha256", "metadataSha256", "snapshotSha256"]) assert.match(observation[key], /^[a-f0-9]{64}$/);
  assert.deepEqual(observation.roots.map((root) => root.path), [...failedNativeRoots(state), "/bench/run.log", "/bench/host.txt", "/bench/exit-code", "/bench/results.tgz"]);
  for (const root of observation.roots) {
    assert.equal(typeof root.present, "boolean");
    assert.deepEqual(Object.keys(root).sort(), (root.present ? ["bytes", "nodes", "path", "present", "treeSha256"] : ["path", "present"]).sort());
    if (root.present) {
      assert.match(root.treeSha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(root.nodes) && root.nodes >= 1 && root.nodes <= evidenceEnvelope.nodes);
      assert.ok(Number.isSafeInteger(root.bytes) && root.bytes >= 0 && root.bytes <= evidenceEnvelope.content);
    }
  }
  assert.equal(observation.roots[0].present, true);
  assert.ok(observation.roots.slice(failedNativeRoots(state).length).every((root) => root.present));
  assert.ok(Number.isSafeInteger(startedAtMs) && Number.isSafeInteger(finishedAtMs) && finishedAtMs >= startedAtMs
    && finishedAtMs - startedAtMs <= 660000, "custody observation exceeded its local window");
  assert.ok(Number.isSafeInteger(observation.observedAtMs) && observation.observedAtMs >= startedAtMs - 5000
    && observation.observedAtMs <= finishedAtMs + 5000, "custody observation clock differs");
  return observation;
}

export function verifyFailedNativeCustody(local, state, capture) {
  failedNativeArchive(local, state);
  assert.equal(capture.schema, "benchmark-failed-native-custody/v1");
  assert.equal(capture.measuredCommit, state.commit);
  assert.match(capture.controllerCommit, /^[a-f0-9]{40}$/);
  assert.match(capture.reservationSha256, /^[a-f0-9]{64}$/);
  const original = regular(join(local, "failed-native-reservation.json"), 1024 * 1024);
  assert.equal(digest(original), capture.reservationSha256);
  const prior = JSON.parse(original), current = { ...state };
  assert.ok(["starting", "running"].includes(prior.status));
  if (current.retirement) {
    current.status = prior.status;
    for (const key of ["retirement", "deletionIntentAt", "destroyedAt"]) delete current[key];
  }
  assert.deepEqual(current, prior, "original measured reservation changed");
  assert.match(capture.evidence, /^custody-[A-Za-z0-9]+$/);
  const observation = failedNativeObservation(JSON.stringify(capture.observation), state, capture.startedAtMs, capture.finishedAtMs);
  assert.equal(capture.scriptSha256, digest(failedNativeScript(state)));
  assert.equal(fileHash(join(local, "failed-native-results.tgz")), observation.archiveSha256, "custody archive changed");
  const extracted = join(local, capture.evidence); physical(extracted);
  assert.equal(treeHash(extracted), capture.evidenceSha256, "custody extraction changed");
  const snapshot = regular(join(extracted, "campaign", "custody-snapshot.json"), 16384);
  assert.equal(digest(snapshot), observation.snapshotSha256);
  assert.deepEqual(JSON.parse(snapshot), { roots: observation.roots, metadataSha256: observation.metadataSha256 });
  assert.equal(fileHash(join(extracted, "campaign", "custody-metadata.json")), observation.metadataSha256);
  for (const [index, root] of observation.roots.slice(0, failedNativeRoots(state).length).entries()) {
    if (root.present) assert.equal(treeHash(join(extracted, "campaign", `root-${index}`)), root.treeSha256, "custody root differs");
    else assert.ok(!readdirSync(join(extracted, "campaign")).includes(`root-${index}`), "absent native root was invented");
  }
  for (const name of ["run.log", "host.txt", "exit-code"])
    assert.equal(fileHash(join(extracted, name)), fileHash(join(local, state.evidence, name)), "failed metadata changed");
  assert.equal(treeHash(join(extracted, "campaign", "root-0")), treeHash(join(local, state.evidence, "campaign")), "original campaign changed before custody");
  return capture;
}

export function verifyFailedNativeRetirement(local, state) {
  const bytes = regular(join(local, "failed-native-host.json"));
  assert.equal(digest(bytes), state.retirement.evidenceSha256, "failed-native retirement receipt changed");
  const record = JSON.parse(bytes);
  assert.deepEqual(Object.keys(record).sort(), ["capture", "confirmation", "finishedAtMs", "rehash", "schema", "scriptSha256", "startedAtMs"].sort());
  assert.equal(record.schema, "benchmark-failed-native-retirement/v1");
  verifyFailedNativeCustody(local, state, record.capture);
  assert.deepEqual(Object.keys(record.rehash).sort(), ["finishedAtMs", "observation", "scriptSha256", "startedAtMs"]);
  const rehash = failedNativeObservation(JSON.stringify(record.rehash.observation), state, record.rehash.startedAtMs, record.rehash.finishedAtMs);
  assert.equal(record.rehash.scriptSha256, digest(failedNativeScript(state, record.capture.observation.snapshotSha256)));
  const final = failedNativeObservation(JSON.stringify(record.confirmation), state, record.startedAtMs, record.finishedAtMs);
  assert.equal(record.scriptSha256, digest(failedNativeScript(state, record.capture.observation.snapshotSha256, record.capture.observation)));
  const withoutTime = ({ observedAtMs, ...rest }) => rest;
  assert.deepEqual(withoutTime(rehash), withoutTime(record.capture.observation), "remote custody rehash differs");
  assert.deepEqual(withoutTime(final), withoutTime(record.capture.observation), "predelete custody differs");
  return record;
}

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

// The common tooling marker does not prove native entry. Retirement still
// requires an absent or empty campaign, not a native benchmark result.
export function terminalSetupScript(state, exitCode) {
  assert.ok(Number.isInteger(exitCode) && exitCode >= 1 && exitCode <= 255, "nonzero setup exit code required");
  const files = Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  assert.deepEqual(Object.keys(files).sort(), ["job.sh", "pack.sh", state.unit].sort());
  const marker = `${JSON.stringify(bootstrapMarker(state))}\n`, observed = state.bootstrapReady !== undefined;
  assert.ok(Buffer.byteLength(marker) <= 1024, "bounded common bootstrap marker required");
  if (observed) {
    assert.ok(state.bootstrapReady && typeof state.bootstrapReady === "object" && !Array.isArray(state.bootstrapReady), "saved bootstrap observation required");
    assert.equal(state.bootstrapReady.sha256, digest(marker), "saved bootstrap marker differs");
  }
  return `/usr/bin/timeout 25 /usr/bin/python3 - ${quote(state.id)} ${quote(state.unit)} ${quote(JSON.stringify(files))} ${quote(String(exitCode))} <<'CORTEN_FAILED_SETUP_HOST'
import hashlib, json, os, pathlib, stat, subprocess, sys, time, urllib.request
host_id, unit, manifest, expected_code = sys.argv[1:]
files = json.loads(manifest)
expected_marker = ${JSON.stringify(marker)}.encode('ascii')
require_marker = ${observed ? "True" : "False"}
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
def common_marker(path):
    regular(path, 1024)
    assert path.read_bytes() == expected_marker
bench = pathlib.Path('/bench')
assert stat.S_ISDIR(bench.lstat().st_mode)
marker_path = bench / 'bootstrap-ready.json'
if os.path.lexists(marker_path):
    common_marker(marker_path)
else:
    assert not require_marker
for name in files:
    control(bench / name, name)
for entry in bench.iterdir():
    if entry.name in files:
        control(entry, entry.name)
    elif entry.name == 'bootstrap-ready.json':
        common_marker(entry)
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
