// Included in measured guardian bytes, never a remote-selected import.
import { streamLimits } from "./control-stream.mjs";
export default String.raw`
def stream_replace(path, value):
    stage = path.parent / ('.stage-' + secrets.token_hex(16))
    write(stage, encoded(value))
    os.replace(stage, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def stream_load(root, name):
    assert name in ('stream-lease.json', 'stream-state.json')
    fd = os.open(root / name, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        assert stat.S_ISREG(before.st_mode) and before.st_nlink <= 1 and before.st_uid == os.getuid() and before.st_mode & 0o077 == 0 and before.st_size <= 65536
        data = os.read(fd, 65537)
        after = os.fstat(fd)
        assert len(data) == before.st_size and all(getattr(before, k) == getattr(after, k) for k in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_uid', 'st_mode'))
        return json.loads(data)
    finally:
        os.close(fd)


def stream_member(pid, pin=False):
    row, directory = proc(pid), pathlib.Path('/proc') / str(pid)
    tasks = sorted(int(p.name) for p in (directory / 'task').iterdir())
    assert 0 < len(tasks) <= 32
    if pin:
        for tid in tasks:
            os.sched_setaffinity(tid, {0})
    def affinity(path):
        found = re.search(r'^Cpus_allowed_list:\s*([^\r\n]+)$', task_text(path / 'status'), re.M)
        assert found and found[1] == '0', 'control affinity changed'
        return found[1]
    threads = []
    for tid in tasks:
        task = directory / 'task' / str(tid)
        fields = task_text(task / 'stat').rsplit(') ', 1)[1].split()
        threads.append({'pid': tid, 'startTicks': fields[19], 'cpus': affinity(task)})
    namespaces = {}
    for name in ('cgroup', 'ipc', 'mnt', 'net', 'pid', 'user', 'uts'):
        match = re.fullmatch(r'\w+:\[([0-9]+)\]', os.readlink(directory / 'ns' / name))
        assert match
        namespaces[name] = match[1]
    return {**identity(row), 'parentPid': parent(row), 'cpus': affinity(directory), 'namespaces': namespaces, 'threads': threads}


def stream_sample(registration):
    assert host() == registration['host'], 'control boot changed'
    members = [stream_member(p['pid']) for p in registration['members']]
    assert members == registration['members'], 'control identity/membership changed'
    pids = {p['pid'] for p in members}
    scopes = {p['cgroup'] for p in members if re.search(r'/session-[^/]+\.scope\n$', p['cgroup'])}
    rows = inventory()
    active = (root_for(registration['binding']['token']) / 'campaign-active.json').exists()
    for row in rows.values():
        assert row['pid'] in pids or (parent(row) not in pids and row['cgroup'] not in scopes), 'new control participant'
        if active and row['pid'] not in pids and row['pid'] != registration['listener']['pid']:
            assert parent(row) != registration['listener']['pid'] and row['cgroup'] != registration['listener']['cgroup'] and not row['cgroup'].startswith('0::/user.slice/') and not re.search(r'/session-[^/]+\.scope(?:/|\n)', row['cgroup']), 'foreign SSH/login participant'
    listener = stream_member(registration['listener']['pid'])
    listener.pop('commandSha256')
    assert listener == registration['listener'], 'listener identity/membership/affinity changed'
    return {'host': host(), 'monoNs': str(time.monotonic_ns()), 'members': members, 'listener': listener}


def helper_line(error):
    frame, line = error.__traceback__, 0
    while frame:
        if frame.tb_frame.f_code.co_filename == helper_line.__code__.co_filename:
            line = frame.tb_lineno
        frame = frame.tb_next
    return line


def stream_revoke(root):
    # Existence revokes. Custody may copy it immediately, so never populate it.
    fd = os.open(root / 'stream-invalid.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def stream_failure(root, registration, reason, error):
    pinned = reason == 'pinned watchdog'
    if pinned:
        # Only one ready byte preceded this notification on the campaign pipe.
        try:
            os.write(1, b'F')
        except OSError:
            pass
    try:
        stream_revoke(root)
    except OSError:
        pass  # The peer may already have created the marker.
    line = helper_line(error)
    try:
        if pinned:
            os.write(2, b'control fault: ' + encoded({'id': registration['id'], 'host': registration['host'],
                     'monoNs': str(time.monotonic_ns()), 'reason': reason, 'helperLine': line}))
        else:
            # The SSH peer may already have packaged run.log. Its local close receipt
            # can keep this bounded location without copying arbitrary SSH stderr.
            os.write(2, ('CORTEN_MONITOR_FAULT %s %d\n' % (registration['id'], line)).encode('ascii'))
    except OSError:
        pass


def stream_watchdog(root, expected_hash):
    registration = load(root, 'stream-registration.json')
    assert sha(encoded(registration)[:-1]) == expected_hash
    try:
        return stream_watchdog_loop(root, registration)
    except Exception as error:
        stream_failure(root, registration, 'pinned watchdog', error)
        raise


def stream_watchdog_loop(root, registration):
    import select
    previous, renewal = None, 0
    while True:
        # taskset execs this single-threaded consumer, never the campaign or its native children.
        assert os.sched_getaffinity(0) == {0}
        assert not (root / 'stream-invalid.json').exists()
        stream_sample(registration)
        lease = stream_load(root, 'stream-lease.json')
        now = time.monotonic_ns()
        assert int(registration['createdMonoNs']) <= now < int(registration['deadlineMonoNs'])
        assert lease['id'] == registration['id'] and lease['host'] == registration['host']
        assert 0 < int(lease['expiresMonoNs']) - now <= 15000000000
        assert 0 <= now - int(lease['observedMonoNs']) <= 2000000000
        assert type(lease['renewal']) == int and lease['renewal'] >= renewal
        renewal = lease['renewal']
        if previous is None:
            assert os.write(1, b'R') == 1
        else:
            assert 0 <= now - previous <= 2000000000
        previous = now
        if select.select([0], [], [], 0.25)[0]:
            assert time.monotonic_ns() - previous <= 2000000000
            assert os.read(0, 2) == b'S', 'unexpected campaign disappearance'
            return 0


def stream_apparatus(root):
    path = root / 'stream-registration.json'
    if not path.exists():
        return set()
    registration = load(root, path.name)
    stream_sample(registration)
    assert not (root / 'stream-invalid.json').exists(), 'control lease permanently invalidated'
    assert time.monotonic_ns() < int(stream_load(root, 'stream-lease.json')['expiresMonoNs']), 'control lease expired'
    return {p['pid'] for p in registration['members']}


def stream_material(root, state):
    import base64
    campaign, group = state['campaign'], state['group']
    assert re.fullmatch(r'r[1-9][0-9]*-[a-f0-9]{16}', campaign) and group in ('json-api', 'mixed-production')
    prefix = 'json' if group == 'json-api' else 'mixed'
    folder = pathlib.Path('/bench/campaign') / campaign
    private(folder)
    source = 'audit-sources' if group == 'json-api' else 'mixed-audit-sources'
    subject_path = folder / (prefix + '-audit-subject.json')
    subject_bytes = read(subject_path, 16777216)
    subject = json.loads(subject_bytes)
    assert subject['subjectSha256'] == state['subjectSha256']
    entries = subject['sourcesManifest']['snapshot']['entries']
    assert isinstance(entries, list) and len(entries) <= ${streamLimits.auditFiles} + 3
    expected, directories, seen = {}, set(), set()
    for index, row in enumerate(entries, 1):
        name = row['path']
        assert name not in seen
        seen.add(name)
        if row['type'] == 'directory':
            assert name in ('', 'blobs', 'contexts') and (group == 'mixed-production' or name != 'contexts')
            directories.add(name)
        else:
            assert row['type'] == 'file' and re.fullmatch(r'(?:blobs/[a-f0-9]{64}|contexts/[a-z][a-z0-9-]*\.tar)', name)
            assert group == 'mixed-production' or name.startswith('blobs/')
            assert isinstance(row['bytes'], int) and 0 <= row['bytes'] <= ${streamLimits.auditFileBytes} and re.fullmatch(r'[a-f0-9]{64}', row['sha256'])
            expected[source + '/' + name] = row
        if index % 64 == 0:
            yield None
    assert '' in directories and 'blobs' in directories and len(expected) < ${streamLimits.auditFiles}
    paths, total = [subject_path], len(subject_bytes)
    visited = set()
    def walk(directory, name):
        assert name in directories and name not in visited
        visited.add(name)
        private(directory)
        with os.scandir(directory) as items:
            for index, item in enumerate(items, 1):
                path = directory / item.name
                info = path.lstat()
                assert not stat.S_ISLNK(info.st_mode)
                if stat.S_ISDIR(info.st_mode):
                    yield from walk(path, str(path.relative_to(folder / source)))
                else:
                    assert stat.S_ISREG(info.st_mode) and len(paths) < ${streamLimits.auditFiles} and str(path.relative_to(folder)) in expected
                    paths.append(path)
                if index % 64 == 0:
                    yield None
    yield from walk(folder / source, '')
    assert visited == directories
    assert {str(path.relative_to(folder)) for path in paths[1:]} == set(expected), 'audit inventory differs from subject'
    for index, path in enumerate(paths[1:], 1):
        info = path.lstat()
        assert 0 <= info.st_size <= ${streamLimits.auditFileBytes}
        total += info.st_size
        if index % 64 == 0:
            yield None
    assert total <= ${streamLimits.auditBytes}
    def stable(info):
        return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
    yield ('audit-begin', state)
    for path in [paths[0]] + sorted(paths[1:]):
        private(path.parent)
        before, name = path.lstat(), str(path.relative_to(folder))
        assert path.resolve().is_relative_to(folder)
        assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.getuid() and before.st_mode & 0o077 == 0
        wanted = {'bytes': len(subject_bytes), 'sha256': sha(subject_bytes)} if path == subject_path else expected[name]
        assert before.st_size == wanted['bytes']
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            assert stable(os.fstat(fd)) == stable(before)
            yield ('audit-file', {'group': group, 'path': name, 'bytes': before.st_size, 'sha256': wanted['sha256']})
            offset, hashed = 0, hashlib.sha256()
            while offset < before.st_size:
                value = os.read(fd, min(${streamLimits.auditChunkBytes}, before.st_size - offset))
                assert value, 'truncated audit source'
                hashed.update(value)
                yield ('audit-data', {'offset': offset, 'data': base64.b64encode(value).decode('ascii')})
                offset += len(value)
            assert not os.read(fd, 1) and hashed.hexdigest() == wanted['sha256'], 'audit source hash differs'
            private(path.parent)
            assert stable(os.fstat(fd)) == stable(before) == stable(path.lstat()), 'audit source changed'
            yield ('audit-file-end', {})
        finally:
            os.close(fd)
    yield ('audit-end', {'group': group, 'subjectSha256': state['subjectSha256']})


def stream_drain(root):
    registration = load(root, 'stream-registration.json')
    assert host() == registration['host'] and not (root / 'window.json').exists()
    assert not (root / 'stream-invalid.json').exists()
    assert (root / 'stream-sealed.json').exists() and stream_load(root, 'stream-state.json')['kind'] == 'terminal'
    rows = inventory()
    if any(p['pid'] in rows and key(rows[p['pid']]) == key(p) for p in registration['members']):
        return None
    listener = registration['listener']
    actual = identity(rows[listener['pid']])
    assert all(actual[k] == listener[k] for k in ('pid', 'startTicks', 'cgroup', 'executable'))
    scopes = sorted({p['cgroup'][3:-1] for p in registration['members'] if re.search(r'/session-[^/]+\.scope\n$', p['cgroup'])})
    assert scopes
    observations = [scope_read(scope, rows) for scope in scopes]
    assert all(not p['exists'] or p['members'] == [] and re.fullmatch(r'populated 0\n(?:frozen [01]\n)?', p['events']) for p in observations)
    for row in rows.values():
        if row['pid'] != listener['pid']:
            assert row['cgroup'] != listener['cgroup'] and parent(row) != listener['pid'] and not row['cgroup'].startswith('0::/user.slice/') and not re.search(r'/session-[^/]+\.scope(?:/|\n)', row['cgroup']), 'unregistered SSH/login survivor'
    proof = {'schema': 'benchmark-control-stream-drain/v1', 'registrationSha256': sha(encoded(registration)[:-1]),
        'id': registration['id'], 'host': host(), 'monoNs': str(time.monotonic_ns()), 'identitiesAbsent': True, 'scopes': observations, 'listener': actual}
    write(root / 'stream-drain.json', encoded(proof))
    return proof


def stream_monitor(root, expected):
    import base64
    import select
    assert set(expected) == {'binding', 'id'} and expected['binding'] == load(root, 'binding.json')
    assert re.fullmatch(r'[a-f0-9]{32}', expected['id'])
    assert not (root / 'seal-bootstrap.json').exists() and not (root / 'campaign-active.json').exists()
    listener, chain, socket = ancestry(os.getpid(), os.environ['SSH_CONNECTION'])
    listener = stream_member(listener['pid'], True)
    listener.pop('commandSha256')
    assert chain[-1]['pid'] == os.getpid() and len(chain) <= 32
    # The exact socket-owned listener and connection ancestry are declared before seal.
    members = [stream_member(p['pid'], True) for p in chain]
    at = time.monotonic_ns()
    registration = {'schema': 'benchmark-control-apparatus/v1', **expected, 'host': host(), 'listener': listener,
        'socket': socket, 'members': members, 'createdMonoNs': str(at), 'deadlineMonoNs': str(at + 172800000000000)}
    stream_sample(registration)
    write(root / 'stream-registration.json', encoded(registration))
    lease_until, challenge, challenge_at, renewal = at + 15000000000, None, 0, 0
    sequence, incoming, outgoing, journal_bytes, sampled, sample_sequence = 0, b'', b'', 0, 0, 0
    material, state_hash, delivery, terminal, sealed = iter(()), None, None, False, False
    observations = os.open(root / 'stream-observations.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.set_blocking(0, False)
    os.set_blocking(1, False)
    def emit(kind, payload):
        nonlocal sequence, outgoing
        sequence += 1
        frame = encoded({'schema': 'benchmark-control-frame/v1', 'id': expected['id'], 'sequence': sequence, 'kind': kind, 'payload': payload})
        assert sequence <= 1000000 and len(frame) <= 65536 and len(outgoing) + len(frame) <= 131072
        outgoing += frame
    try:
        emit('registered', registration)
        while True:
            now = time.monotonic_ns()
            assert now < int(registration['deadlineMonoNs']), 'control absolute deadline expired'
            assert not (root / 'stream-invalid.json').exists(), 'campaign invalidated control lease'
            assert terminal or now < lease_until, 'control lease expired'
            if now - sampled >= 1000000000:
                stream_sample(registration)
                assert sampled == 0 or now - sampled <= 2000000000, 'control observation gap'
                sampled, sample_sequence = now, sample_sequence + 1
                entry = encoded({'sequence': sample_sequence, 'monoNs': str(now), 'registrationSha256': sha(encoded(registration)[:-1])})
                if not sealed:
                    journal_bytes += len(entry)
                    assert journal_bytes <= 64 * 1024 * 1024 and os.write(observations, entry) == len(entry)
                    os.fsync(observations)
            if not terminal and challenge is None and now - challenge_at >= 1000000000 and len(outgoing) < 65536:
                challenge, challenge_at = {'sequence': renewal + 1, 'nonce': secrets.token_hex(16)}, now
                emit('challenge', challenge)
            stream_replace(root / 'stream-lease.json', {'id': expected['id'], 'host': registration['host'],
                'expiresMonoNs': str(lease_until), 'renewal': renewal, 'observedMonoNs': str(sampled)})
            state_path = root / 'stream-state.json'
            # The job's EXIT trap also runs if native entry failed before its
            # first progress publication. A healthy SSH lease is not a live job.
            # The first renewal proves the client received registration, which
            # it needs to collect evidence after an early failure.
            if renewal and state_hash is None and pathlib.Path('/bench/exit-code').exists():
                assert state_path.exists(), 'benchmark job exited before first campaign state'
            if state_path.exists() and len(outgoing) < 32768:
                state = stream_load(root, state_path.name)
                current = sha(encoded(state))
                if current != state_hash:
                    state_hash = current
                    assert state['kind'] in ('progress', 'audit-ready', 'seal', 'terminal')
                    if state['kind'] == 'audit-ready':
                        assert not sealed
                        material = iter(stream_material(root, state['payload']))
                    elif state['kind'] == 'seal':
                        assert not sealed and delivery is None and not (root / 'window.json').exists()
                        stream_sample(registration)
                        os.fsync(observations)
                        write(root / 'stream-sealed.json', encoded({'monoNs': str(now), 'lease': stream_load(root, 'stream-lease.json'),
                            'observationsSha256': sha(read(root / 'stream-observations.jsonl', 64 * 1024 * 1024))}))
                        sealed, material = True, iter(())
                    else:
                        assert not sealed or state['kind'] == 'terminal'
                        if state['kind'] == 'terminal':
                            assert sealed and delivery is None
                        material = iter(())
                        emit(state['kind'], state['payload'])
                        terminal = state['kind'] == 'terminal'
                try:
                    # Internal checkpoints return to custody/lease sampling, never the wire.
                    frame = next(material)
                    if frame is not None:
                        emit(*frame)
                except StopIteration:
                    pass
            readable, writable, _ = select.select([0], [1] if outgoing else [], [], 0.05)
            if writable:
                outgoing = outgoing[os.write(1, outgoing):]
            if not readable:
                continue
            block = os.read(0, 65536)
            assert block, 'control input disconnected'
            incoming += block
            assert len(incoming) <= 131072
            while b'\n' in incoming:
                raw, incoming = incoming.split(b'\n', 1)
                assert len(raw) <= 65536
                value = json.loads(raw)
                assert value.get('id') == expected['id'] and set(value) == {'id', 'kind', 'payload'}
                kind, payload = value['kind'], value['payload']
                if kind == 'renew':
                    if terminal:
                        continue
                    assert challenge is not None and payload == challenge and time.monotonic_ns() < lease_until
                    renewal += 1
                    challenge, lease_until = None, time.monotonic_ns() + 15000000000
                elif kind == 'close':
                    assert terminal and payload == {}
                    return 0
                elif kind == 'delivery-begin':
                    assert not terminal and not sealed and delivery is None and not (root / 'window.json').exists()
                    state = stream_load(root, 'stream-state.json')
                    assert state['kind'] == 'audit-ready'
                    assert set(payload) == {'campaign', 'group', 'subjectSha256', 'sha256', 'bytes'}
                    assert all(payload[k] == state['payload'][k] for k in ('campaign', 'group', 'subjectSha256'))
                    assert 0 < payload['bytes'] <= 16777216 and re.fullmatch(r'[a-f0-9]{64}', payload['sha256'])
                    delivery = {'intent': payload, 'data': bytearray()}
                elif kind == 'delivery-data':
                    assert delivery is not None and set(payload) == {'offset', 'data'} and payload['offset'] == len(delivery['data'])
                    delivery['data'].extend(base64.b64decode(payload['data'], validate=True))
                    assert len(delivery['data']) <= delivery['intent']['bytes']
                elif kind == 'delivery-end':
                    assert delivery is not None and payload == {} and not (root / 'window.json').exists()
                    intent, data = delivery['intent'], bytes(delivery['data'])
                    assert len(data) == intent['bytes'] and sha(data) == intent['sha256']
                    state = stream_load(root, 'stream-state.json')
                    assert state['kind'] == 'audit-ready' and all(state['payload'][k] == intent[k] for k in ('campaign', 'group', 'subjectSha256'))
                    prefix = 'json' if intent['group'] == 'json-api' else 'mixed'
                    folder = pathlib.Path('/bench/campaign') / intent['campaign']
                    private(folder)
                    write(folder / (prefix + '-audit-delivery-pending.json'), data, limit=16777216)
                    write(root / ('stream-audit-' + intent['group'] + '.json'), encoded({'binding': expected['binding'], 'id': expected['id'],
                        'intent': intent, 'renewal': renewal, 'monoNs': str(time.monotonic_ns()), 'registrationSha256': sha(encoded(registration)[:-1])}))
                    emit('delivery-sealed', intent)
                    delivery = None
                else:
                    raise AssertionError('untyped control input')
    except Exception as error:
        if not terminal:
            stream_failure(root, registration, 'control monitor', error)
        raise
    finally:
        os.close(observations)
`;
