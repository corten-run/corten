// One old-source migration, never audit approval or general process control.
import assert from "node:assert/strict";
import { join } from "node:path";
import { digest, regular } from "./cloud-local.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { quote } from "./cloud-transport.mjs";
import { cancellationState } from "./cloud-options.mjs";
export { cancellationState } from "./cloud-options.mjs";

export const mixedWait = Object.freeze({
  commit: "9f3d35884c67d90524f978d173fabeb3a17bc970", tree: "b891ebbc250c435fdfa3d04b50aa302fb298362f",
  round: "r21", group: "mixed-production", token: "d170147514518ef2", id: "619664120", ip: "64.225.43.20",
  accountId: "team:d2fc16cc-37b5-4a40-8894-f0d557305948", context: "default",
  campaign: "r21-9f531818ffec33ca", campaignSha256: "a2fe989b2f763f681fc0c9e0f1b0e5124a4d8556c15715617f73316200125516",
  subjectSha256: "ac237a1fba4298163ad0968696764515980f7e97f28943224416e45777ca8bce",
  event: "00002-mixed-review-needed.json", waitAt: "2026-11-15T23:57:08.811Z", deadline: "2026-11-16T23:57:08.811Z",
  wrapperPid: 2251, unitStart: "Sun 2026-11-15 23:53:50 UTC",
  knownHostsSha256: "ce013953e800061e1bb958966788a22129a8b97add819a62d6eb2e52dbe51b5f",
  operatorReason: "retire-old-unpublishable-attempt-preserving-all-evidence-not-a-source-guarantee-verdict",
});
const sha = (v) => assert.match(v, /^[a-f0-9]{64}$/);
export const mixedDigest = (value) => digest(JSON.stringify(value, (key, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
export function ownedMixedWait(state) {
  assert.equal(state.schema, "benchmark-dedicated-group-host/v1");
  for (const key of ["commit", "round", "group", "token", "id", "ip"]) assert.equal(state[key], mixedWait[key], "unsupported mixed cancellation identity");
  assert.deepEqual(state.provider, { accountId: mixedWait.accountId, context: mixedWait.context });
  assert.equal(state.name, `corten-bench-groups-r21-${mixedWait.token}`);
  assert.equal(state.tag, `corten-bench-groups-run-${mixedWait.token}`);
  assert.equal(state.unit, `${state.name}.service`);
  assert.equal(state.fullGroupQualified, false);
  assert.ok(!state.auditIntent && !state.auditIntents, "audit delivery attempt cannot become cancellation authority");
  return mixedWait;
}
export function verifyMixedCancellation(local, state) {
  ownedMixedWait(state); cancellationState(state.mixedCancellation);
  const originalBytes = regular(join(local, "mixed-cancel-reservation.json"), 1024 * 1024);
  assert.equal(digest(originalBytes), state.mixedCancellation.reservationSha256);
  const original = JSON.parse(originalBytes); ownedMixedWait(original);
  assert.equal(original.status, "running");
  for (const key of ["mixedCancellation", "archiveSha256", "evidence", "deletionIntentAt"]) assert.equal(original[key], undefined);
  const intent = regular(join(local, "mixed-cancel-intent.json"), 65536);
  assert.equal(digest(intent), state.mixedCancellation.intentSha256);
  assert.deepEqual(JSON.parse(intent), { schema: "benchmark-mixed-cancel-intent/v1", wait: mixedWait,
    controllerCommit: state.mixedCancellation.controllerCommit, reservationSha256: digest(originalBytes),
    scriptSha256: digest(mixedCancelScript(original)) });
  // Only subsequent evidence custody and deletion bookkeeping may differ.
  const current = { ...state };
  for (const key of ["mixedCancellation", "archiveSha256", "evidenceSha256", "extractionAttempts", "evidence", "retirement", "deletionIntentAt", "destroyedAt"])
    delete current[key];
  if (current.status === "retired") current.status = "running";
  assert.deepEqual(current, original, "mixed reservation changed after cancellation intent");
  return JSON.parse(intent);
}
export function verifyMixedSignal(local, state) {
  verifyMixedCancellation(local, state); sha(state.mixedCancellation.signalSha256);
  const bytes = regular(join(local, "mixed-cancel-signal.json"), 65536);
  assert.equal(digest(bytes), state.mixedCancellation.signalSha256, "signal acknowledgement changed");
  const record = JSON.parse(bytes);
  assert.deepEqual(Object.keys(record).sort(), ["finishedAtMs", "observation", "startedAtMs"]);
  const value = mixedSignalObservation(JSON.stringify(record.observation), state, record.startedAtMs, record.finishedAtMs);
  assert.ok(value.observedAtMs < Date.parse(mixedWait.deadline), "signal observation exceeded original wait deadline");
  return value;
}

// The kernel pidfd, not a numeric kill(2), binds the single signal to the process
// inspected here. No systemctl stop/kill, arbitrary argv, process-group signal,
// unit restart, retry, native import or audit inbox write is available.
export function mixedCancelProgram(state) {
  ownedMixedWait(state);
  const config = { ...mixedWait, unit: state.unit,
    files: Object.fromEntries(Object.entries(remoteFiles(state)).map(([name, bytes]) => [name, digest(bytes)])) };
  return `import hashlib, json, os, pathlib, re, select, signal, stat, subprocess, sys, time, urllib.request
c = json.loads(${JSON.stringify(JSON.stringify(config))})
assert os.getuid() == 0
os.umask(0o077)
def sha(data): return hashlib.sha256(data).hexdigest()
def canonical(v): return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
def stamp(s): return (s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def opened(path, flags=os.O_RDONLY):
    parts = path.split('/')
    assert parts[0] == '' and all(p not in ('','.','..') for p in parts[1:])
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = next_fd
        return os.open(parts[-1], flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
    finally: os.close(fd)
def read(path, limit=16777216):
    fd = opened(path)
    try:
        s = os.fstat(fd)
        assert stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == 0 and s.st_size <= limit
        if path.startswith('/bench/campaign/'): assert s.st_mode & 0o077 == 0
        data = b''
        while len(data) <= limit:
            part = os.read(fd, min(65536, limit + 1 - len(data)))
            if not part: break
            data += part
        assert len(data) == s.st_size and stamp(s) == stamp(os.fstat(fd))
        assert stamp(s) == stamp(os.stat(path, follow_symlinks=False))
        return data
    finally: os.close(fd)
def command(args):
    r = subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10,
        env=dict(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/nonexistent', LANG='C', TZ='UTC',
            GIT_NO_REPLACE_OBJECTS='1', GIT_NO_LAZY_FETCH='1', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null'))
    assert len(r.stdout) <= 16777216
    return r.stdout
def git(args): return command(['git','--no-optional-locks','-C','/bench/repo','-c','core.fsmonitor=false'] + args)
# Expensive source verification happens before the 30-second dispatch anchor.
assert git(['rev-parse','HEAD']).decode().strip() == c['commit']
assert git(['rev-parse',c['commit']+'^{tree}']).decode().strip() == c['tree']
entries = git(['ls-tree','-rz','--full-tree',c['commit']]).split(b'\\0')
assert len(entries) <= 100001
total = 0
for entry in entries:
    if not entry: continue
    header, name = entry.split(b'\\t',1); mode, kind, oid = header.split()
    assert mode in (b'100644',b'100755') and kind == b'blob'
    name = name.decode('ascii'); assert not name.startswith('/') and all(p not in ('','.','..') for p in name.split('/'))
    data = read('/bench/repo/'+name,268435456); total += len(data); assert total <= 1073741824
    assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\\0'+data).hexdigest().encode() == oid
for name, expected in c['files'].items():
    path = '/etc/systemd/system/'+name if name.endswith('.service') else '/bench/'+name
    assert sha(read(path)) == expected
anchor = time.monotonic()
def fresh():
    assert 0 <= time.monotonic()-anchor < 30
    assert time.time() < __import__('datetime').datetime.fromisoformat(c['deadline'].replace('Z','+00:00')).timestamp()
def unit():
    fields = ['Id','LoadState','FragmentPath','ActiveState','SubState','Restart','NRestarts','Job','MainPID','ExecMainCode','ExecMainStartTimestamp','ControlGroup']
    data = command(['systemctl','show',c['unit']] + ['--property='+f for f in fields]).decode()
    rows = data.splitlines(); assert len(rows) == len(fields)
    result = dict(row.split('=',1) for row in rows); assert set(result) == set(fields)
    assert result == dict(Id=c['unit'],LoadState='loaded',FragmentPath='/etc/systemd/system/'+c['unit'],
        ActiveState='active',SubState='running',Restart='no',NRestarts='0',Job='',MainPID=str(c['wrapperPid']),
        ExecMainCode='0',ExecMainStartTimestamp=c['unitStart'],ControlGroup='/system.slice/'+c['unit'])
    return result
def metadata():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://169.254.169.254/metadata/v1/id', timeout=3) as r:
        assert r.status == 200 and r.read(65).decode().strip() == c['id']
directory = '/bench/campaign/'+c['campaign']
def waiting():
    fd = opened(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        s = os.fstat(fd); assert s.st_uid == 0 and s.st_mode & 0o077 == 0
        names = []
        with os.scandir(fd) as it:
            for item in it:
                assert len(names) < 100000; names.append(item.name)
        assert sorted(n for n in names if re.fullmatch(r'[0-9]{5}-[a-z-]+\\.json',n))[-1] == c['event']
        assert not any(n in names for n in ['mixed-audit-delivery.json','mixed-audit-delivery-retained.json','mixed-native-audits.json','campaign-result.json'])
    finally: os.close(fd)
    paths = ['/bench/campaign/.host-attempt.json',directory+'/plan.json',directory+'/'+c['event'],directory+'/mixed-audit-subject.json']
    raw = [read(p) for p in paths]; reservation, plan, event, subject = [json.loads(v) for v in raw]
    assert reservation['id'] == c['campaign'] and reservation['commit'] == c['commit'] and reservation['campaignSha256'] == c['campaignSha256']
    for value, key, expected in [(plan,'campaignSha256',c['campaignSha256']),(subject,'subjectSha256',c['subjectSha256'])]:
        assert value[key] == expected and sha(canonical({k:v for k,v in value.items() if k != key})) == expected
    assert plan['round'] == c['round'] and plan['commit'] == c['commit'] and plan['order'] == [c['group']]
    assert subject['schema'] == 'benchmark-mixed-audit-subject/v1' and subject['commit'] == c['commit'] and subject['campaignSha256'] == c['campaignSha256']
    assert event['kind'] == 'mixed-review-needed' and event['sequence'] == 2 and event['at'] == c['waitAt']
    assert event['campaign'] == c['campaign'] and event['campaignSha256'] == c['campaignSha256'] and event['subjectSha256'] == c['subjectSha256']
    status = event['status']
    assert status['campaign'] == c['campaign'] and status['campaignSha256'] == c['campaignSha256'] and status['round'] == c['round']
    assert status['state'] == 'blocked-review-needed' and status['auditGroup'] == c['group'] and status['nextGroup'] == c['group']
    assert status['auditInbox'] == c['campaign']+'/mixed-audit-delivery.json' and status['mixedAuditSubjectSha256'] == c['subjectSha256']
    assert status['outcomes'] == [] and status['uncollectedNativeRoots'] == []
    assert status['controllerReady'] is False and status['reservation'] == 'retained-no-release-or-restart'
    return reservation, sha(b'\\0'.join(raw))
def process(pid, parent, argv, cwd):
    raw = pathlib.Path('/proc/'+str(pid)+'/stat').read_text()
    tail = raw[raw.rindex(')')+2:].split(); assert tail[0] not in ('Z','X') and (parent is None or int(tail[1]) == parent)
    base = pathlib.Path('/proc/'+str(pid))
    assert (base/'cmdline').read_bytes().split(b'\\0')[:-1] == [v.encode() for v in argv]
    assert os.readlink(base/'cwd') == cwd
    assert (base/'cgroup').read_text().strip() in ('0::/system.slice/'+c['unit'], '0::/system.slice/'+c['unit']+'/supervisor')
    fields = dict(line.split(':',1) for line in (base/'status').read_text().splitlines())
    assert fields['Uid'].split() == ['0']*4 and fields['Gid'].split() == ['0']*4
    if parent is not None:
        assert int(fields['SigCgt'].strip(),16) & (1 << (signal.SIGTERM-1)), 'missing handled SIGTERM'
        env = (base/'environ').read_bytes().split(b'\\0')
        assert not any(v.startswith((b'NODE_OPTIONS=',b'NODE_PATH=',b'LD_PRELOAD=',b'LD_LIBRARY_PATH=')) and v.split(b'=',1)[-1] for v in env)
    return int(tail[19]), os.stat(base/'exe').st_ino, os.readlink(base/'exe')
metadata(); first_unit = unit(); reservation, wait_sha = waiting(); fresh()
pid = reservation['pid']; assert type(pid) is int and pid > 1 and pid != c['wrapperPid']
wrapper_fd = os.pidfd_open(c['wrapperPid']); target_fd = os.pidfd_open(pid)
try:
    poll = select.poll(); poll.register(wrapper_fd,select.POLLIN); poll.register(target_fd,select.POLLIN)
    def live(): assert not poll.poll(0), 'owned process exited; never signal reused PID'
    node_argv = ['node','bench/workloads/isolated/campaign-entry.mjs','r21','--commit',c['commit'],'--state-dir','/bench/campaign','--group','mixed-production']
    wrapper = process(c['wrapperPid'],None,['/bin/bash','/bench/job.sh'],'/bench/repo')
    node = process(pid,c['wrapperPid'],node_argv,'/bench/repo')
    assert node[2] in ('/usr/bin/node','/usr/local/bin/node')
    live(); metadata(); assert unit() == first_unit
    assert waiting() == (reservation,wait_sha)
    assert process(c['wrapperPid'],None,['/bin/bash','/bench/job.sh'],'/bench/repo') == wrapper
    assert process(pid,c['wrapperPid'],node_argv,'/bench/repo') == node
    fresh(); live()
    # Exclusive durable remote intent survives SSH acknowledgement loss. Its
    # presence is always a refusal, never a reason to deliver another signal.
    intent = dict(schema='benchmark-mixed-cancel-remote-intent/v1',hostId=c['id'],unit=c['unit'],campaign=c['campaign'],
        subjectSha256=c['subjectSha256'],pid=pid,startTicks=node[0],waitSha256=wait_sha,signal='SIGTERM')
    fd = opened('/bench/mixed-cancel-intent.json',os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    try:
        data = canonical(intent)+b'\\n'; assert os.write(fd,data) == len(data); os.fsync(fd)
    finally: os.close(fd)
    fd = opened('/bench',os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
    fresh(); live()
    signal.pidfd_send_signal(target_fd,signal.SIGTERM,None,0)
    print(json.dumps(dict(schema='benchmark-mixed-cancel-signal/v1',hostId=c['id'],unit=c['unit'],campaign=c['campaign'],
        subjectSha256=c['subjectSha256'],remoteIntentSha256=sha(data),pid=pid,startTicks=node[0],signaled=True,observedAtMs=int(time.time()*1000))))
finally:
    os.close(target_fd); os.close(wrapper_fd)
`;
}
export function mixedCancelScript(state) {
  return `/usr/bin/timeout -k 5 45 /usr/bin/python3 - <<'CORTEN_MIXED_CANCEL'\n${mixedCancelProgram(state)}CORTEN_MIXED_CANCEL`;
}
export function mixedSignalObservation(raw, state, startedAtMs, finishedAtMs) {
  ownedMixedWait(state);
  assert.ok(Number.isSafeInteger(startedAtMs) && Number.isSafeInteger(finishedAtMs)
    && Buffer.byteLength(raw) <= 4096 && finishedAtMs >= startedAtMs && finishedAtMs - startedAtMs <= 50000);
  const value = JSON.parse(raw);
  assert.deepEqual(Object.keys(value).sort(), ["schema", "hostId", "unit", "campaign", "subjectSha256", "remoteIntentSha256", "pid", "startTicks", "signaled", "observedAtMs"].sort());
  assert.equal(value.schema, "benchmark-mixed-cancel-signal/v1"); assert.equal(value.hostId, state.id); assert.equal(value.unit, state.unit);
  assert.equal(value.campaign, mixedWait.campaign); assert.equal(value.subjectSha256, mixedWait.subjectSha256); sha(value.remoteIntentSha256);
  assert.equal(value.signaled, true); assert.ok(Number.isSafeInteger(value.pid) && value.pid > 1 && value.pid !== mixedWait.wrapperPid);
  assert.ok(Number.isSafeInteger(value.startTicks) && value.startTicks > 0);
  assert.ok(Number.isSafeInteger(value.observedAtMs) && value.observedAtMs >= startedAtMs - 5000 && value.observedAtMs <= finishedAtMs + 5000);
  return value;
}
