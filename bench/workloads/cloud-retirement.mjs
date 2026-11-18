// Retirement evidence is separate from benchmark qualification. No operations on import.
import assert from "node:assert/strict";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digest, evidenceEnvelope, fileHash, physical, regular, treeHash } from "./cloud-local.mjs";
import { bootstrapMarker, remoteFiles } from "./cloud-remote.mjs";
import { quote } from "./cloud-transport.mjs";
import { guardianSha256, guardianSource } from "./cloud-control-runtime.mjs";
import { verifyControlSetupQuery } from "./cloud-control-session.mjs";
import { verifyControlWatcher } from "./isolated/control-admission.mjs";
import { cancellationState, mixedDigest, mixedWait, originalMixedControls, ownedMixedWait, verifyMixedCancellation, verifyMixedSignal } from "./cloud-cancellation.mjs";

// This migration is not a general old-source collection or validation override.
export const failedNativeCommit = "9f3d35884c67d90524f978d173fabeb3a17bc970";
const failedNativeCases = [
  { identity: { commit: failedNativeCommit, round: "r21" }, policy: "r21-9f-failed-native-custody-only-no-qualification" },
  { identity: { commit: "dbe1a34c753ee8ef4ac9927484dc3930d36f6e37", round: "r21", group: "catalog-page",
    id: "620052965", token: "39fa09440f45df00", name: "corten-bench-groups-r21-39fa09440f45df00",
    tag: "corten-bench-groups-run-39fa09440f45df00", unit: "corten-bench-groups-r21-39fa09440f45df00.service" },
    policy: "r21-dbe-exact-catalog-attempt-custody-only-no-qualification" },
  { identity: { commit: "2a4ceb043747b92c753becc2bbcc5def655fc53d", round: "r21", group: "catalog-page",
    id: "620157651", token: "e38164eb06fc2043", name: "corten-bench-groups-r21-e38164eb06fc2043",
    tag: "corten-bench-groups-run-e38164eb06fc2043", unit: "corten-bench-groups-r21-e38164eb06fc2043.service" },
    policy: "r21-2a-exact-lean-catalog-custody-only-no-qualification" },
];
// Eligibility only; original custody, current terminal proof and exact approval still apply.
export function failedNativePolicy(state) {
  const found = failedNativeCases.find(({ identity }) => Object.entries(identity).every(([key, value]) => state[key] === value));
  assert.ok(found, "unsupported failed-native migration identity");
  return found.policy;
}
export function failedNativeRoots(state) {
  failedNativePolicy(state);
  if (state.group === "mixed-production") {
    ownedMixedWait(state); cancellationState(state.mixedCancellation);
    return ["/bench/campaign", "/bench/repo/bench/mixed-production/results/w21", "/bench/mixed-cancel-intent.json"];
  }
  const roots = { "catalog-page": ["bench/catalog/results/c21"], "json-api": ["bench/json-api/results/j42", "bench/json-api/results/j43"],
    "localized-marketplace": ["bench/marketplace/results/r21"], "fullstack-browser": ["bench/fullstack-browser/work/w21"],
    "client-heavy": ["bench/client-heavy/work/w21"], "live-delivery": ["bench/live/results/parity/r21"],
    "recoverable-live": ["bench/recoverable-live/results/r21"], hardening: ["bench/hardening/results/w21"] };
  assert.ok(Object.hasOwn(roots, state.group), "unsupported failed-native group");
  return ["/bench/campaign", ...roots[state.group].map((path) => `/bench/repo/${path}`)];
}
export function mixedIntentRoot(path, root) {
  assert.equal(root.path, "/bench/mixed-cancel-intent.json"); assert.equal(root.present, true);
  const bytes = regular(path, 4096);
  assert.equal(root.nodes, 1); assert.equal(root.bytes, bytes.length);
  assert.equal(root.treeSha256, digest(Buffer.concat([Buffer.from(`f\0\0${bytes.length}\0`), bytes])), "framed cancellation intent root changed");
  return JSON.parse(bytes);
}
// The caller authenticates the original plan and subject first. Hash the saved
// payloads, not a rebuilt Git context or an executable native validator.
function mixedCancelledCustody(directory, subject, binding) {
  const { sourcesManifest: manifest } = subject, { sha256, ...body } = manifest;
  assert.equal(mixedDigest(body), sha256, "mixed source manifest changed");
  const { entries } = manifest.snapshot;
  assert.ok(Array.isArray(entries) && entries.length <= evidenceEnvelope.nodes, "mixed source snapshot bound");
  assert.equal(mixedDigest(entries), manifest.snapshot.sha256, "mixed source snapshot changed");
  physical(directory);
  assert.ok(isDeepStrictEqual(readdirSync(directory).sort(), ["blobs", "contexts"]), "mixed source root differs");
  const saved = new Map(); let total = 0;
  for (const entry of entries) {
    assert.ok(!saved.has(entry.path), "duplicate mixed source snapshot path"); saved.set(entry.path, entry);
    if (entry.type === "directory") {
      assert.ok(["", "blobs", "contexts"].includes(entry.path), "unknown mixed source directory");
      physical(entry.path ? join(directory, entry.path) : directory);
    } else {
      assert.equal(entry.type, "file");
      assert.match(entry.path, /^(?:blobs\/[a-f0-9]{64}|contexts\/[a-z][a-z0-9-]*\.tar)$/);
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= evidenceEnvelope.memberBytes, "mixed source file bound");
      total += entry.bytes; assert.ok(total <= evidenceEnvelope.content, "mixed source content bound");
      const path = join(directory, entry.path);
      assert.equal(lstatSync(path).size, entry.bytes, "mixed source file size changed");
      assert.equal(fileHash(path, entry.bytes), entry.sha256, "mixed source payload changed");
    }
  }
  for (const name of ["", "blobs", "contexts"]) assert.equal(saved.get(name)?.type, "directory", "missing mixed source directory");
  for (const name of ["blobs", "contexts"]) {
    const names = entries.filter((e) => e.type === "file" && e.path.startsWith(`${name}/`)).map((e) => e.path.slice(name.length + 1)).sort();
    assert.ok(isDeepStrictEqual(readdirSync(join(directory, name)).sort(), names), "mixed source inventory differs");
  }
  const blobs = new Set();
  for (const file of manifest.files) {
    assert.equal(file.storedAs, `blobs/${file.sha256}`);
    const entry = saved.get(file.storedAs); assert.equal(entry?.type, "file", "mixed source blob missing from snapshot");
    assert.equal(entry.sha256, file.sha256); assert.equal(entry.bytes, file.bytes); blobs.add(file.storedAs);
  }
  assert.equal(blobs.size, entries.filter((e) => e.path.startsWith("blobs/")).length, "unreferenced mixed source blob");
  assert.ok(isDeepStrictEqual(subject.requests.map((r) => r.identity.app), binding.selection.apps), "mixed context contenders differ");
  assert.equal(subject.bindingSha256, mixedDigest(binding), "mixed subject binding differs");
  for (const request of subject.requests) {
    const entry = saved.get(`contexts/${request.identity.app}.tar`);
    assert.equal(entry?.type, "file", "mixed build context missing from snapshot");
    assert.equal(entry.sha256, request.identity.contextArchiveSha256, "mixed build context differs");
  }
  assert.equal(subject.requests.length, entries.filter((e) => e.path.startsWith("contexts/")).length, "unreferenced mixed build context");
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
  if (state.group === "mixed-production") {
    verifyMixedCancellation(local, state);
    assert.equal(campaign, mixedWait.campaign);
    const { campaignSha256, ...body } = plan;
    assert.equal(campaignSha256, mixedWait.campaignSha256); assert.equal(mixedDigest(body), campaignSha256);
    const event = JSON.parse(regular(join(dir, mixedWait.event))), halted = JSON.parse(regular(join(dir, "00003-halted.json")));
    assert.equal(event.at, mixedWait.waitAt); assert.equal(event.subjectSha256, mixedWait.subjectSha256);
    assert.equal(event.status.state, "blocked-review-needed");
    const subject = JSON.parse(regular(join(dir, "mixed-audit-subject.json"))), { subjectSha256, ...subjectBody } = subject;
    assert.equal(subjectSha256, mixedWait.subjectSha256); assert.equal(mixedDigest(subjectBody), subjectSha256);
    mixedCancelledCustody(join(dir, "mixed-audit-sources"), subject, plan.bindings[0]);
    const reservation = JSON.parse(regular(join(folder, ".host-attempt.json")));
    assert.equal(reservation.id, campaign); assert.equal(reservation.campaignSha256, campaignSha256); assert.equal(reservation.commit, state.commit);
    assert.equal(halted.kind, "halted"); assert.equal(halted.sequence, 3); assert.equal(halted.campaign, campaign);
    assert.equal(halted.campaignSha256, campaignSha256); assert.deepEqual(halted.status, result.status);
    assert.deepEqual(readdirSync(dir).filter((n) => /^\d{5}-/.test(n)).sort(), ["00000-authorized.json", "00001-started.json", mixedWait.event, "00003-halted.json"]);
    assert.equal(result.status.state, "preserved-uncertain"); assert.equal(result.wholeHostTerminal, "parent-must-observe"); assert.equal(result.deletionAuthorized, false);
    assert.deepEqual(result.status.uncollectedNativeRoots, []);
    assert.equal(result.status.outcomes.length, 1); assert.equal(result.status.outcomes[0].group, state.group); assert.equal(result.status.outcomes[0].outcome, "not-run");
    assert.ok(!readdirSync(dir).some((n) => /^mixed-(native-audits|audit-delivery(?:-retained)?)\.json$/.test(n)), "cancelled wait advanced into audit");
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
  const files = state.group === "mixed-production" ? originalMixedControls(state)
    : Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
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
cloud_binding = None

def cloud_instance():
    global cloud_binding
    assert re.fullmatch(r'[1-9][0-9]*', host_id)
    descriptors, entries = [], []
    def entry(parent, name, flags):
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        descriptors.append(fd)
        assert info(before) == info(os.fstat(fd))
        entries.append((parent, name, fd, info(before)))
        return fd
    def directory(parent, name):
        return entry(parent, name, os.O_RDONLY | os.O_DIRECTORY)
    def data(parent, name, limit):
        fd = entry(parent, name, os.O_RDONLY)
        s = os.fstat(fd)
        assert stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= limit
        value = os.read(fd, limit + 1)
        assert len(value) == s.st_size and info(s) == info(os.fstat(fd))
        return value
    try:
        cloud = directory(None, '/')
        for name in ['var', 'lib', 'cloud']:
            cloud = directory(cloud, name)
        # Read the one supported selector as data through its own pinned inode.
        # Never traverse it, and never extend opened()'s no-symlink policy.
        selector = entry(cloud, 'instance', os.O_PATH)
        s = os.fstat(selector)
        assert stat.S_ISLNK(s.st_mode) and s.st_nlink == 1
        assert os.readlink('', dir_fd=selector) == '/var/lib/cloud/instances/' + host_id
        instance = directory(directory(cloud, 'instances'), host_id)
        instance_id = data(directory(cloud, 'data'), 'instance-id', 64)
        assert instance_id in [host_id.encode('ascii'), (host_id + '\\n').encode('ascii')]
        assert data(instance, 'user-data.txt', 0) == b''
        for parent, name, fd, before in reversed(entries):
            assert before == info(os.fstat(fd)) == info(os.stat(name, dir_fd=parent, follow_symlinks=False))
        binding = [before for parent, name, fd, before in entries]
        if cloud_binding is not None:
            assert binding == cloud_binding
        cloud_binding = binding
    finally:
        for fd in reversed(descriptors):
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
    cloud_instance()
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
def admit(key):
    global nodes, names, members
    assert key.count('/') < 60 and len(key) < 3800
    assert nodes + 1 <= c['bounds']['nodes'] - 16
    assert names + len(key.rsplit('/', 1)[-1]) <= c['bounds']['nameBytes'] and members + len(key) <= c['bounds']['memberBytes']
    nodes += 1
    names += len(key.rsplit('/', 1)[-1])
    members += len(key)
def inventory(path, key='', admitted=False):
    global content
    try:
        fd = opened(path)
    except FileNotFoundError:
        assert key == ''
        return None
    try:
        s = os.fstat(fd)
        kind = 'd' if stat.S_ISDIR(s.st_mode) else 'f'
        assert kind == 'd' or stat.S_ISREG(s.st_mode) and s.st_nlink == 1
        if not admitted:
            admit(key)
        rows = [dict(key=key, kind=kind, metadata=info(s))]
        if kind == 'd':
            children = []
            with os.scandir(fd) as entries:
                for entry in entries:
                    name = entry.name
                    assert name.isascii() and re.fullmatch(r'[][A-Za-z0-9_.@$%+-]+', name) and name not in ['.', '..']
                    assert len(name) <= 255 and not name.endswith('.') and not re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.].*)?', name)
                    admit(key + '/' + name)
                    children.append(name)
            for name in sorted(children):
                child = inventory(path + '/' + name, key + '/' + name, True)
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
    if (state.group === "mixed-production" && index === 2) mixedIntentRoot(join(extracted, "campaign", "root-2"), root);
    else if (root.present) assert.equal(treeHash(join(extracted, "campaign", `root-${index}`)), root.treeSha256, "custody root differs");
    else assert.ok(!readdirSync(join(extracted, "campaign")).includes(`root-${index}`), "absent native root was invented");
  }
  for (const name of ["run.log", "host.txt", "exit-code"])
    assert.equal(fileHash(join(extracted, name)), fileHash(join(local, state.evidence, name)), "failed metadata changed");
  assert.equal(treeHash(join(extracted, "campaign", "root-0")), treeHash(join(local, state.evidence, "campaign")), "original campaign changed before custody");
  if (state.group === "mixed-production") {
    verifyMixedCancellation(local, state);
    assert.equal(capture.observation.roots[2].present, true, "remote cancellation intent missing");
    const intentPath = join(extracted, "campaign", "root-2"), intent = mixedIntentRoot(intentPath, capture.observation.roots[2]);
    const signal = verifyMixedSignal(local, state);
    assert.equal(fileHash(intentPath), signal.remoteIntentSha256, "remote intent differs from acknowledged signal");
    assert.equal(intent.schema, "benchmark-mixed-cancel-remote-intent/v1");
    assert.equal(intent.hostId, state.id); assert.equal(intent.unit, state.unit); assert.equal(intent.campaign, mixedWait.campaign);
    assert.equal(intent.subjectSha256, mixedWait.subjectSha256); assert.equal(intent.signal, "SIGTERM");
    const reservation = JSON.parse(regular(join(extracted, "campaign", "root-0", ".host-attempt.json")));
    assert.equal(intent.pid, reservation.pid); assert.ok(Number.isSafeInteger(intent.startTicks) && intent.startTicks > 0);
    assert.equal(intent.pid, signal.pid); assert.equal(intent.startTicks, signal.startTicks);
    const dir = join(extracted, "campaign", "root-0", mixedWait.campaign);
    const waitFiles = [join(extracted, "campaign", "root-0", ".host-attempt.json"), join(dir, "plan.json"), join(dir, mixedWait.event), join(dir, "mixed-audit-subject.json")];
    assert.equal(intent.waitSha256, digest(Buffer.concat(waitFiles.flatMap((path, i) => [ ...(i ? [Buffer.from([0])] : []), regular(path) ]))), "cancellation wait bytes changed");
  }
  return capture;
}

export function verifyFailedNativeRetirement(local, state, expectedSha256 = state.retirement.evidenceSha256) {
  const bytes = regular(join(local, "failed-native-host.json"));
  assert.match(expectedSha256, /^[a-f0-9]{64}$/);
  assert.equal(digest(bytes), expectedSha256, "failed-native retirement receipt changed");
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

// The only unacknowledged action this path may retire is the first, fixed SSH
// no-op. Keep that invocation unacknowledged, including in terminal state.
export function unusedBootstrap(state) {
  const c = state.control, row = c?.ledger[0], request = row?.request;
  return !!(state.id && state.ip && state.createIntentAt && c?.helperSha256 === guardianSha256
    && c.monitor?.phase === "pending" && !c.monitor.registrationSha256 && !c.sealed.length && c.ledger.length === 1
    && request.epoch === "bootstrap" && request.sequence === 0 && !request.seal && !row.localTerminal
    && request.invocation.channel === "ssh" && request.invocation.deadlineMs === 30000
    && request.invocation.requestSha256 === digest("set -euo pipefail\ntrue\n")
    && (state.status === "preparing" ? !state.deletionIntentAt : state.status === "retired" && state.retirement?.kind === "unused")
    && ["bootstrapReady", "preBootstrapTerminal", "auditIntent", "auditIntents", "archiveSha256", "evidenceSha256", "extractionAttempts",
      "evidence", "evidenceOutcome", "exitCode", "validation", "collectedAt", "mixedCancellation"].every((key) => state[key] === undefined));
}

export function unusedHostScript(state) {
  const bootstrap = unusedBootstrap(state);
  const files = bootstrap ? {} : Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  const watcher = bootstrap && `corten-bench-control-${state.token}-${state.control.ledger[0].request.invocation.id}.service`;
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
${bootstrap ? `def absent(path):
    try:
        pathlib.Path(path).lstat()
    except FileNotFoundError:
        return
    raise AssertionError('unexpected bootstrap custody')
assert values['LoadState'] == 'not-found'
for path in ['/bench', '/run/corten-bench-control-${state.token}', '/etc/systemd/system/' + unit,
             '/run/systemd/transient/${watcher}', '/sys/fs/cgroup/system.slice/${watcher}']:
    absent(path)
assert not any(entry.name.startswith('corten-bench-control-') for entry in pathlib.Path('/run').iterdir())
watcher = subprocess.run(['systemctl', 'show', '${watcher}', '--property=LoadState'], capture_output=True, text=True, timeout=5)
assert watcher.returncode in (0, 1) and watcher.stdout.strip() == 'LoadState=not-found'
` : ""}bench = pathlib.Path('/bench')
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
${bootstrap ? `    assert all(value not in command for value in [b'/bench', b'corten-bench-control-', b'corten-control'])
absent('/run/corten-bench-control-${state.token}')
absent('/bench')
` : ""}assert os.getppid() == parent_pid and (parent / 'cmdline').read_bytes() == parent_command
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
function setupControlExpected(state, exitCode, sequence) {
  assert.equal(state.control.helperSha256, guardianSha256, "setup control source changed");
  assert.deepEqual(state.control.sealed, [], "sealed/native entry cannot use pre-entry retirement");
  assert.ok(Number.isSafeInteger(sequence) && sequence > 0 && sequence < 4096 && sequence <= state.control.ledger.length);
  const rows = state.control.ledger.slice(0, sequence);
  assert.ok(rows.every((row) => row.localTerminal && !row.request.seal), "unsettled control cannot retire");
  const files = Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  return { binding: { round: state.round, commit: state.commit, token: state.token, helperSha256: guardianSha256 }, sequence,
    requests: rows.map((row) => row.request), queryArgv: ["/usr/bin/python3", "-", state.id, state.unit, JSON.stringify(files), String(exitCode)] };
}
export function terminalSetupScript(state, exitCode, sequence = state.control?.ledger.length) {
  assert.ok(Number.isInteger(exitCode) && exitCode >= 1 && exitCode <= 255, "nonzero setup exit code required");
  const files = Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, content]) => [name, digest(content)]));
  assert.deepEqual(Object.keys(files).sort(), ["job.sh", "pack.sh", state.unit].sort());
  const marker = `${JSON.stringify(bootstrapMarker(state))}\n`, observed = state.bootstrapReady !== undefined;
  assert.ok(Buffer.byteLength(marker) <= 1024, "bounded common bootstrap marker required");
  if (observed) {
    assert.ok(state.bootstrapReady && typeof state.bootstrapReady === "object" && !Array.isArray(state.bootstrapReady), "saved bootstrap observation required");
    assert.equal(state.bootstrapReady.sha256, digest(marker), "saved bootstrap marker differs");
  }
  const expected = state.control ? setupControlExpected(state, exitCode, sequence) : null;
  const controlHeader = expected ? `control_namespace = {'__name__': 'fixed_setup_control'}
exec(compile(${JSON.stringify(guardianSource)}, '<fixed-control-source>', 'exec'), control_namespace)
control_expected = json.loads(${JSON.stringify(JSON.stringify(expected))})
control_proof = control_namespace['setup_query'](control_namespace['root_for'](${quote(state.token)}), control_expected)
` : "";
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
${controlHeader}bench = pathlib.Path('/bench')
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
${expected ? "    elif entry.name == 'control':\n        control_namespace['private'](entry)\n" : ""}    elif entry.name in ['run.log', 'host.txt', 'exit-code', 'results.tgz']:
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
print(json.dumps(dict(schema='benchmark-failed-setup-host/${expected ? "v2" : "v1"}', hostId=host_id, unit=unit,
                     observedAtMs=int(time.time()*1000), exitCode=int(expected_code), setupFailed=True${expected ? ", control=control_proof" : ""})))
CORTEN_FAILED_SETUP_HOST`;
}

export function setupEvidence(raw, state, script, exitCode, startedAtMs, finishedAtMs, local) {
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= (state.control ? 8 * 1024 * 1024 : 1024), "bounded setup proof required");
  for (const key of ["archiveSha256", "evidenceSha256"])
    assert.ok(typeof state[key] === "string" && state[key].length === 64 && /^[a-f0-9]{64}$/.test(state[key]), "preserved setup evidence hash required");
  const observation = JSON.parse(raw);
  assert.ok(observation && typeof observation === "object" && !Array.isArray(observation), "setup proof required");
  const sequence = state.control ? observation.control.requests.length - 1 : undefined;
  assert.ok(typeof script === "string" && script === terminalSetupScript(state, exitCode, sequence), "fixed setup script required");
  assert.deepEqual(Object.keys(observation).sort(), [...(state.control ? ["control"] : []), "exitCode", "hostId", "observedAtMs", "schema", "setupFailed", "unit"]);
  assert.equal(observation.schema, `benchmark-failed-setup-host/${state.control ? "v2" : "v1"}`);
  assert.equal(observation.hostId, state.id); assert.equal(observation.unit, state.unit);
  assert.equal(observation.setupFailed, true); assert.equal(observation.exitCode, exitCode);
  if (state.control) {
    assert.equal(sequence, state.control.ledger.length - 1, "setup query is not the final registered control");
    const expected = setupControlExpected(state, exitCode, sequence), proof = observation.control;
    verifyControlSetupQuery(expected, proof);
    const row = state.control.ledger[sequence];
    assert.equal(row.localTerminal, true); assert.equal(row.code, 0);
    assert.deepEqual(row.request, proof.requests.at(-1));
    assert.equal(row.request.invocation.requestSha256, digest(`set -euo pipefail\n${script}\n`), "setup query payload source differs");
    for (let i = 0; i < sequence; i++) {
      assert.equal(proof.receipts[i].result.code, state.control.ledger[i].code);
      verifyControlWatcher(proof.requests[i].invocation, proof.receipts[i], proof.watchers[i]);
    }
    assert.equal(typeof local, "string", "original control custody required");
    const custody = join(local, state.evidence, "control"); physical(custody);
    assert.deepEqual(readdirSync(custody).sort(), proof.custody.map((entry) => entry.name).sort(), "original control custody inventory differs");
    for (const entry of proof.custody) {
      const bytes = regular(join(custody, entry.name), 8 * 1024 * 1024);
      assert.equal(bytes.length, entry.bytes); assert.equal(digest(bytes), entry.sha256, "original control custody bytes differ");
    }
  }
  assert.ok(Number.isSafeInteger(startedAtMs) && Number.isSafeInteger(finishedAtMs) && finishedAtMs >= startedAtMs
    && finishedAtMs - startedAtMs <= 30000, "setup observation exceeded its local window");
  assert.ok(Number.isSafeInteger(observation.observedAtMs) && observation.observedAtMs >= startedAtMs - 5000
    && observation.observedAtMs <= finishedAtMs + 5000, "setup observation clock differs");
  return { schema: `benchmark-failed-setup-retirement/${state.control ? "v2" : "v1"}`, round: state.round, commit: state.commit, id: state.id, unit: state.unit,
    archiveSha256: state.archiveSha256, evidenceSha256: state.evidenceSha256, exitCode, scriptSha256: digest(script),
    observation, startedAtMs, finishedAtMs };
}
