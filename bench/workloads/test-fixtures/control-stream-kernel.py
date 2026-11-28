"""Execute the shipped guardian against virtual proc/fd/clock custody, never SSH."""
import hashlib
import json
import stat
import sys
import types

argument = json.loads(sys.stdin.read())
source, mode = argument['source'], argument['mode']
scope = {'__name__': 'source_bound_control_stream_fixture'}
exec(compile(source, '<fixed-guardian>', 'exec'), scope)
token, identifier = '0123456789abcdef', 'd' * 32
root = '/run/corten-bench-control-' + token
binding = {'round': 'r21', 'commit': 'a' * 40, 'token': token, 'helperSha256': hashlib.sha256(source.encode()).hexdigest()}
host = {'hostname': 'synthetic-host', 'bootId': '01234567-89ab-cdef-0123-456789abcdef'}
campaign, subject = 'r21-0123456789abcdef', 'e' * 64
folder = '/bench/campaign/' + campaign
blob = b'fixed source material'
blob_hash = hashlib.sha256(blob).hexdigest()
entries = [{'path': '', 'type': 'directory'}, {'path': 'blobs', 'type': 'directory'},
           {'path': 'blobs/' + blob_hash, 'type': 'file', 'bytes': len(blob), 'sha256': blob_hash}]
data = {root + '/helper.py': source.encode(), root + '/binding.json': json.dumps(binding).encode(),
        folder + '/json-audit-subject.json': json.dumps({'subjectSha256': subject, 'commit': binding['commit'], 'sourcesManifest': {'snapshot': {'entries': entries}}}).encode(),
        folder + '/audit-sources/blobs/' + blob_hash: blob}
rows, descriptors, incoming, output, pinned = {}, {}, bytearray(), [], []
diagnostic = bytearray()
clock, next_fd = 1000000, 2
session = '/user.slice/user-0.slice/session-7.scope'

def add(pid, parent, group):
    fields = ['0'] * 49
    fields[0], fields[18] = str(parent), str(pid * 100)
    rows[pid] = {'stat': str(pid) + ' (not-an-exemption) S ' + ' '.join(fields) + '\n', 'cgroup': '0::' + group + '\n',
                 'cmdline': ('fixed-' + str(pid)).encode() + b'\0', 'cpus': '0-7', 'net': '4'}
add(1, 0, '/init.scope')
add(10, 1, '/system.slice/ssh.service')
add(20, 10, '/system.slice/ssh.service')
add(21, 20, session)
add(40, 1, '/system.slice/corten-bench-groups-r21-' + token + '.service/supervisor')

class Path:
    def __init__(self, value): self.value = str(value)
    def __str__(self): return self.value
    def __truediv__(self, part): return Path(self.value + '/' + str(part))
    def __lt__(self, other): return self.value < str(other)
    def __eq__(self, other): return self.value == str(other)
    @property
    def name(self): return self.value.rsplit('/', 1)[-1]
    @property
    def parent(self): return Path(self.value.rsplit('/', 1)[0])
    def resolve(self): return self
    def is_relative_to(self, other): return self.value.startswith(str(other) + '/')
    def relative_to(self, other): return self.value[len(str(other)) + 1:]
    def is_symlink(self): return False
    def is_dir(self): return self.value in (folder, folder + '/audit-sources', folder + '/audit-sources/blobs')
    def exists(self): return self.value in data or self.is_dir() or self.value == '/sys/fs/cgroup' + session
    def rglob(self, pattern): return [Path(p) for p in sorted(data) if p.startswith(self.value + '/')]
    def iterdir(self):
        if self.value == '/proc': return [Path('/proc/' + str(pid)) for pid in rows]
        parts = self.value.split('/')
        if self.name == 'task': return [Path(self.value + '/' + parts[2])]
        if self.name == 'fd': return [Path(self.value + '/3')] if int(parts[2]) in (10, 20) else []
        names = {p[len(self.value) + 1:].split('/')[0] for p in data if p.startswith(self.value + '/')}
        return [Path(self.value + '/' + p) for p in sorted(names)]
    def read_text(self, **kwargs):
        if self.value == '/proc/sys/kernel/hostname': return host['hostname'] + '\n'
        if self.value == '/proc/sys/kernel/random/boot_id': return host['bootId'] + '\n'
        if self.value == '/proc/net/tcp': return 'header\n0: 00000000:0016 00000000:0000 0A 0 0 0 0 0 500\n1: 0A0200C0:0016 140200C0:9C40 01 0 0 0 0 0 501\n'
        if self.value == '/proc/net/tcp6': return 'header\n'
        if self.name == 'cgroup.events': return 'populated ' + str(int(any(p['cgroup'] == '0::' + session + '\n' for p in rows.values()))) + '\nfrozen 0\n'
        pid = int(self.value.split('/')[2])
        if pid not in rows: raise FileNotFoundError()
        if self.name == 'status': return 'Cpus_allowed_list:\t' + rows[pid]['cpus'] + '\n'
        return rows[pid][self.name]
    def read_bytes(self):
        if self.name == 'cmdline': return rows[int(self.value.split('/')[2])]['cmdline']
        return data[self.value]
    def stat(self): return types.SimpleNamespace(st_dev=1, st_ino=int(self.value.split('/')[2]) + 100)
    def lstat(self): return file_stat(self.value, self.is_dir())

def encoded(value): return scope['encoded'](value)
def put(name, value): data[root + '/' + name] = encoded(value)
def write(path, value, limit=8388608):
    assert str(path) not in data and len(value) <= limit
    data[str(path)] = bytes(value)
    if str(path) == root + '/stream-sealed.json':
        put('stream-state.json', {'kind': 'terminal', 'payload': {'id': identifier, 'nativeTerminal': True, 'campaign': campaign, 'sealSha256': 'f' * 64}})
def read(path, limit=8388608):
    value = data[str(path)]; assert len(value) <= limit; return value
def send(kind, payload): incoming.extend(encoded({'id': identifier, 'kind': kind, 'payload': payload}))
def emit(frame):
    output.append(frame)
    kind = frame['kind']
    if kind == 'registered':
        assert not data.get(root + '/seal-bootstrap.json') and not data.get(root + '/campaign-active.json')
        if mode == 'early-job-exit':
            data['/bench/exit-code'] = b'2\n'
            return
        if mode in ('already-exited', 'exit-after-renewals'):
            return
        put('campaign-active.json', {'owner': {'pid': 40}})
        put('stream-state.json', {'kind': 'progress', 'payload': {'state': 'active'}})
    elif kind == 'progress':
        if mode == 'new-child': add(22, 21, session)
        if mode == 'namespace': rows[20]['net'] = '999'
        if mode == 'affinity': rows[20]['cpus'] = '0-1'
        if mode == 'unknown-login': add(999, 10, '/foreign.scope')
        if mode == 'failed-group':
            # A failed timing group finishes without producing an audit subject.
            put('stream-state.json', {'kind': 'seal', 'payload': {}})
        elif mode != 'lost-lease': put('stream-state.json', {'kind': 'audit-ready', 'payload': {'campaign': campaign, 'group': 'json-api', 'subjectSha256': subject}})
    elif kind == 'challenge':
        if mode == 'exit-after-renewals' and frame['payload']['sequence'] == 3:
            data['/bench/exit-code'] = b'2\n'
        if mode != 'lost-lease': send('renew', frame['payload'])
        if mode == 'replayed-renewal': send('renew', frame['payload'])
        if mode == 'unknown-input': send('shell', {'command': 'never executed'})
    elif kind == 'audit-end':
        import base64
        value = encoded({'subjectSha256': subject})
        send('delivery-begin', {'campaign': campaign, 'group': 'json-api', 'subjectSha256': subject, 'sha256': hashlib.sha256(value).hexdigest(), 'bytes': len(value)})
        send('delivery-data', {'offset': 0, 'data': base64.b64encode(value).decode()})
        send('delivery-end', {})
        if mode == 'native-delivery': put('window.json', {'owner': {'pid': 40}})
    elif kind == 'delivery-sealed': put('stream-state.json', {'kind': 'seal', 'payload': {}})
    elif kind == 'terminal': send('close', {})

def opened(path, flags, *args):
    global next_fd
    name = str(path)
    if flags & 64:
        if name in data: raise FileExistsError()
        data[name] = b''
    next_fd += 1; descriptors[next_fd] = {'path': name, 'offset': 0}; return next_fd
def file_stat(path, directory=False):
    return types.SimpleNamespace(st_dev=1, st_ino=int(hashlib.sha256(path.encode()).hexdigest()[:8], 16), st_size=len(data.get(path, b'')), st_uid=0,
        st_mode=(stat.S_IFDIR | 0o700) if directory else (stat.S_IFREG | 0o600), st_nlink=1, st_mtime_ns=1, st_ctime_ns=1)
def fstat(fd): return file_stat(descriptors[fd]['path'])
def raw_read(fd, length):
    if fd == 0:
        result = bytes(incoming[:length]); del incoming[:length]; return result
    row = descriptors[fd]; result = data[row['path']][row['offset']:row['offset'] + length]; row['offset'] += len(result); return result
def raw_write(fd, value):
    if fd == 1:
        for line in bytes(value).splitlines(): emit(json.loads(line))
    elif fd == 2: diagnostic.extend(value)
    else: data[descriptors[fd]['path']] += bytes(value)
    return len(value)
def replace(old, new): data[str(new)] = data.pop(str(old))
def readlink(path):
    pieces = str(path).split('/'); pid = int(pieces[2])
    if pieces[-2] == 'ns': return pieces[-1] + ':[' + (rows[pid]['net'] if pieces[-1] == 'net' else str(['cgroup', 'ipc', 'mnt', 'net', 'pid', 'user', 'uts'].index(pieces[-1]) + 1)) + ']'
    return 'socket:[' + ('500' if pid == 10 else '501') + ']'
def pin(pid, cpus):
    assert pid in (10, 20, 21) and cpus == {0}; pinned.append(pid); rows[pid]['cpus'] = '0'
def select(readers, writers, errors, timeout):
    global clock
    clock += 100000000
    assert clock < 30000000000, 'fixture producer did not terminate'
    return ([0] if incoming else [], writers, [])
class Scan:
    def __init__(self, path): self.path = path
    def __enter__(self): return iter(self.path.iterdir())
    def __exit__(self, *args): return False
fake_os = types.SimpleNamespace(getuid=lambda: 0, getpid=lambda: 21, uname=lambda: types.SimpleNamespace(nodename=host['hostname']), environ={'SSH_CONNECTION': '192.0.2.20 40000 192.0.2.10 22'},
    readlink=readlink, sched_setaffinity=pin, scandir=Scan, open=opened, fstat=fstat, read=raw_read, write=raw_write, replace=replace, fsync=lambda fd: None,
    close=lambda fd: None, set_blocking=lambda fd, value: None, O_RDONLY=0, O_WRONLY=1, O_CREAT=64, O_EXCL=128, O_NOFOLLOW=256, O_DIRECTORY=512, O_NONBLOCK=1024)
scope.update({'os': fake_os, 'pathlib': types.SimpleNamespace(Path=Path), 'private': lambda p: None, 'read': read, 'write': write,
              'time': types.SimpleNamespace(monotonic_ns=lambda: clock)})
sys.modules['select'] = types.SimpleNamespace(select=select)
terminal, failed, drain, reason, drain_status = False, False, None, None, None
if mode == 'already-exited':
    data['/bench/exit-code'] = b'2\n'
try:
    assert scope['main'](['monitor', token, encoded({'binding': binding, 'id': identifier}).hex()]) == 0
    terminal = True
except AssertionError as error:
    failed = True
    reason = str(error)
if terminal:
    rows.pop(21)
    if mode != 'drain-survivor': rows.pop(20)
    if mode == 'drain-listener': rows.pop(10)
    if mode == 'drain-scope': add(999, 1, session)
    if mode == 'drain-unknown': add(999, 1, '/user.slice/user-0.slice/user@0.service')
    drain_output = bytearray()
    scope['sys'] = types.SimpleNamespace(stdout=types.SimpleNamespace(buffer=types.SimpleNamespace(write=drain_output.extend)))
    try: drain_status = scope['main'](['stream-drain', token])
    except Exception: drain_status = 254  # The shipped CLI's generic failure status.
    failed = drain_status not in (0, 3)
    if drain_output: drain = json.loads(drain_output)
    assert data.get(root + '/stream-drain.json', b'') == drain_output
print(json.dumps({'binding': binding, 'registration': next((v['payload'] for v in output if v['kind'] == 'registered'), None),
    'frames': [v['kind'] for v in output], 'pinned': pinned, 'terminal': terminal, 'failed': failed, 'reason': reason, 'drain': drain,
    'drainStatus': drain_status,
    'renewal': json.loads(data[root + '/stream-lease.json'])['renewal'] if root + '/stream-lease.json' in data else None,
    'invalid': root + '/stream-invalid.json' in data, 'diagnostic': diagnostic.decode(),
    'auditPublished': folder + '/json-audit-delivery-pending.json' in data,
    'seal': json.loads(data[root + '/stream-sealed.json']) if root + '/stream-sealed.json' in data else None}))
