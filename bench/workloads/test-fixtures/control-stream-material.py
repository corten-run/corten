"""Read-only execution of the shipped payload generator, not SSH/native qualification.

Windows cannot supply Linux private-mode/O_NOFOLLOW semantics. The fixture models
only those metadata bits there; real file bytes, sizes, links and birth remain
checked. It never changes the input packet or its permissions.
"""
import base64
import hashlib
import json
import os
import pathlib
import stat
import sys
import time
import types

request = json.load(sys.stdin)
scope = {'__name__': 'payload_fixture'}
exec(compile(request['source'], '<shipped-guardian>', 'exec'), scope)
folder = pathlib.Path(request['directory']).resolve()
mode = request.get('mode', 'normal')
changed = False

def metadata(info):
    values = {k: getattr(info, k) for k in ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}
    if os.name == 'nt':
        values['st_mode'] &= ~0o077
    if mode == 'identity' and changed:
        values['st_ino'] += 1
    return types.SimpleNamespace(**values)

class Path:
    def __init__(self, value):
        self.path = folder.parent if str(value) == '/bench/campaign' else pathlib.Path(str(value))
    def __str__(self): return str(self.path)
    def __fspath__(self): return str(self.path)
    def __truediv__(self, value): return Path(self.path / value)
    def __eq__(self, value): return self.path == value.path
    def __lt__(self, value): return str(self.path) < str(value.path)
    @property
    def parent(self): return Path(self.path.parent)
    def lstat(self): return metadata(self.path.lstat())
    def resolve(self): return self.path.resolve()
    def relative_to(self, value): return self.path.relative_to(value.path).as_posix()
    def iterdir(self): return (Path(p) for p in self.path.iterdir())

def private(path):
    assert path.path.is_dir() and not path.path.is_symlink()
    assert path.path.resolve() == path.path.absolute(), 'directory alias'

def read(path, limit):
    assert path.path.is_file() and not path.path.is_symlink() and path.path.stat().st_size <= limit
    with path.path.open('rb') as file:
        return file.read(limit + 1)

def raw_read(fd, size):
    global changed
    value = os.read(fd, size)
    if size > 1 and value:
        changed = True
        if mode == 'truncated': return b''
        if mode == 'hash': return bytes([value[0] ^ 1]) + value[1:]
    return value

scope.update({'pathlib': types.SimpleNamespace(Path=Path), 'private': private, 'read': read,
    'os': types.SimpleNamespace(getuid=getattr(os, 'getuid', lambda: 0),
        O_RDONLY=os.O_RDONLY, O_NOFOLLOW=getattr(os, 'O_NOFOLLOW', 0), O_NONBLOCK=getattr(os, 'O_NONBLOCK', 0),
        scandir=os.scandir, open=lambda path, flags: os.open(path, flags | getattr(os, 'O_BINARY', 0)),
        close=os.close, fstat=lambda fd: metadata(os.fstat(fd)), read=raw_read)})
subject_path = folder / ('json-audit-subject.json' if request['group'] == 'json-api' else 'mixed-audit-subject.json')
subject = json.loads(subject_path.read_bytes())
intent = {'campaign': folder.name, 'group': request['group'], 'subjectSha256': subject['subjectSha256']}
frames, total, count, maximum, wire, ended, active = 0, 0, 0, 0, 0, False, None
started = time.monotonic()
failed = False
try:
    for kind, payload in scope['stream_material'](None, intent):
        frames += 1
        wire += len(json.dumps({'schema': 'benchmark-control-frame/v1', 'id': 'd' * 32,
            'sequence': frames, 'kind': kind, 'payload': payload}, separators=(',', ':')).encode()) + 1
        if kind == 'audit-file': active = {'header': payload, 'hash': hashlib.sha256(), 'bytes': 0}
        elif kind == 'audit-data':
            value = base64.b64decode(payload['data'], validate=True)
            assert payload['offset'] == active['bytes'] and 0 < len(value) <= 32768
            active['hash'].update(value)
            active['bytes'] += len(value)
            total += len(value)
            maximum = max(maximum, len(value))
        elif kind == 'audit-file-end':
            assert active['bytes'] == active['header']['bytes'] and active['hash'].hexdigest() == active['header']['sha256']
            active = None
            count += 1
        elif kind == 'audit-end': ended = True
except AssertionError:
    failed = True
print(json.dumps({'failed': failed, 'ended': ended, 'files': count, 'bytes': total, 'frames': frames,
    'maximumChunk': maximum, 'wireBytes': wire, 'elapsedMs': round((time.monotonic() - started) * 1000),
    'windowsMetadataFacade': os.name == 'nt'}))
