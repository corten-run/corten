import streamSource from "./control-stream-source.mjs";

export default String.raw`"""Fixed SSH/SFTP guardian and outside-session observer. No provider or kill API."""
import contextlib
import errno
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import secrets
import stat
import subprocess
import sys
import time

LIMIT = 8 * 1024 * 1024


def encoded(value):
    return (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def read(path, limit=LIMIT):
    def stable(info):
        return tuple(getattr(info, field) for field in ("st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid", "st_size", "st_mtime_ns", "st_ctime_ns"))
    before = path.lstat()
    assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.getuid()
    assert before.st_size <= limit and before.st_mode & 0o077 == 0
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        assert stable(os.fstat(fd)) == stable(before)
        data = os.read(fd, limit + 1)
        assert len(data) == before.st_size and stable(os.fstat(fd)) == stable(before) and stable(path.lstat()) == stable(before)
        return data
    finally:
        os.close(fd)


def write(path, data, limit=LIMIT):
    assert len(data) <= limit and limit in (LIMIT, 16 * 1024 * 1024, 64 * 1024 * 1024)
    stage = path.parent / (".stage-" + secrets.token_hex(16))
    fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as out:
            out.write(data)
            out.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.link(stage, path, follow_symlinks=False)
    finally:
        stage.unlink()
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def root_for(token):
    assert re.fullmatch(r"[a-f0-9]{16}", token)
    root = pathlib.Path("/run") / ("corten-bench-control-" + token)
    assert root.resolve() == root
    return root


@contextlib.contextmanager
def mutex(root):
    import fcntl
    fd = os.open(root / "mutex", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        assert os.fstat(fd).st_uid == os.getuid() and os.fstat(fd).st_mode & 0o077 == 0
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def alive(owner):
    try:
        return key(proc(owner["pid"])) == key(owner)
    except (FileNotFoundError, ProcessLookupError):
        return False


def window_operation(root, mode):
    binding = load(root, "binding.json")
    owner = proc(os.getppid())
    assert owner["cgroup"] == "0::/system.slice/corten-bench-groups-" + binding["round"] + "-" + binding["token"] + ".service/supervisor\n"
    with mutex(root):
        stream_apparatus(root)
        requests = sorted(p.name for p in root.glob("request-*.json"))
        assert not list(root.glob("intrusion-*.json")), "retained control intrusion"
        if mode in ("activate", "window-open"):
            epochs = {load(root, p)["epoch"] for p in requests}
            assert epochs and epochs <= {"bootstrap", "audit-json-api", "audit-mixed-production"}
            assert all(inspect_epoch(root, epoch) is not None for epoch in epochs), "unsettled control before native baseline"
        if mode == "activate":
            assert all(load(root, p)["epoch"] == "bootstrap" for p in requests), "unaccounted pre-entry control"
            write(root / "campaign-active.json", encoded({"owner": identity(owner)}))
        elif mode == "window-open":
            write(root / "window.json", encoded({"owner": identity(owner), "requests": requests}))
        else:
            window = load(root, "window.json")
            assert key(window["owner"]) == key(owner) and window["requests"] == requests, "control during native phase"
            (root / "window.json").unlink()


def private(root):
    info = root.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0
    assert root.resolve() == root


def load(root, name):
    assert re.fullmatch(r"[a-z0-9-]+\.json", name)
    return json.loads(read(root / name))


def task_text(path):
    # Linux comm is a byte string. Even a UTF-8 name can be truncated mid-character.
    return path.read_text(encoding="utf-8", errors="surrogateescape")


def proc(pid):
    directory = pathlib.Path("/proc") / str(pid)
    raw = task_text(directory / "stat")
    match = re.fullmatch(r"([1-9]\d*) \([\s\S]*\) [A-Za-z] ([\s\S]*)\n", raw)
    assert match and int(match[1]) == pid
    fields = match[2].split()
    assert len(fields) >= 49
    cgroup = (directory / "cgroup").read_text()
    assert re.fullmatch(r"0::/[^\n\r\0]*\n", cgroup)
    executable = None
    if not int(fields[5]) & 0x00200000:
        try:
            exe = (directory / "exe").stat()
            executable = {"device": str(exe.st_dev), "inode": str(exe.st_ino)}
        except FileNotFoundError:
            # PF_EXITING (stat field 9) may precede Z/X. Keep this identity until reaped.
            closing = task_text(directory / "stat")
            current = closing.rsplit(") ", 1)[1].split()
            assert (closing.startswith(str(pid) + " (") and current[19] == fields[18]
                    and (current[0] in ("Z", "X") or int(current[6]) & 0x4)), "userspace executable unresolved"
            raw = closing
    value = {"pid": pid, "startTicks": fields[18], "cgroup": cgroup, "stat": raw,
             "executable": executable, "commandSha256": sha((directory / "cmdline").read_bytes())}
    assert task_text(directory / "stat").rsplit(") ", 1)[1].split()[19] == value["startTicks"]
    return value


def parent(row):
    return int(row["stat"].rsplit(") ", 1)[1].split()[1])


def identity(row):
    return {key: row[key] for key in ("pid", "startTicks", "cgroup", "executable", "commandSha256")}


def key(row):
    return (row["pid"], row["startTicks"])


def inventory():
    rows = {}
    pids = [int(p.name) for p in pathlib.Path("/proc").iterdir() if p.name.isdecimal()]
    assert len(pids) <= 8192
    for pid in pids:
        try:
            rows[pid] = proc(pid)
        except (FileNotFoundError, ProcessLookupError):
            assert not (pathlib.Path("/proc") / str(pid) / "stat").exists(), "process identity unresolved"
    return rows


def host():
    return {"hostname": os.uname().nodename, "bootId": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()}


def member(row, scope):
    return row["cgroup"] == "0::" + scope + "\n" or row["cgroup"].startswith("0::" + scope + "/")


def scope_read(scope, rows):
    assert re.fullmatch(r"/(?:[A-Za-z0-9_.:@-]+/)*[A-Za-z0-9_.:@-]+\.scope", scope)
    assert all(p not in (".", "..") for p in scope.split("/"))
    path = pathlib.Path("/sys/fs/cgroup" + scope)
    assert path.resolve() == path
    try:
        events = (path / "cgroup.events").read_text() if path.exists() else None
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ENODEV) or path.exists():
            raise
        events = None
    return {"path": scope, "exists": events is not None, "events": events,
            "members": sorted(p["pid"] for p in rows.values() if member(p, scope))}


def socket_rows():
    rows = []
    for name in ("tcp", "tcp6"):
        for line in pathlib.Path("/proc/net/" + name).read_text().splitlines()[1:]:
            fields = line.split()
            rows.append((fields, line))
    return rows


def address(raw):
    chunks = [raw[i:i + 8] for i in range(0, len(raw), 8)]
    value = ipaddress.ip_address(b"".join(int(p, 16).to_bytes(4, sys.byteorder) for p in chunks))
    return getattr(value, "ipv4_mapped", None) or value


def sockets(pid):
    result = set()
    for fd in (pathlib.Path("/proc") / str(pid) / "fd").iterdir():
        try:
            target = os.readlink(fd)
        except FileNotFoundError:
            continue
        match = re.fullmatch(r"socket:\[(\d+)\]", target)
        if match:
            result.add(match[1])
    return result


def ancestry(child, connection):
    parts = connection.split()
    assert len(parts) == 4 and all(re.fullmatch(r"[0-9.:a-fA-F]+", s) for s in parts)
    client_port, server_port = int(parts[1]), int(parts[3])
    assert 0 < client_port < 65536 and 0 < server_port < 65536
    rows = socket_rows()
    chain = []
    row = proc(child)
    while row["pid"] > 1 and len(chain) < 32:
        fds = sockets(row["pid"])
        listener = [(f, raw) for f, raw in rows if f[3] == "0A" and int(f[1].split(":")[1], 16) == server_port and f[9] in fds]
        if listener:
            connected = [(p, f, raw) for p in chain for f, raw in rows if f[3] == "01"
                         and int(f[1].split(":")[1], 16) == server_port
                         and int(f[2].split(":")[1], 16) == client_port
                         and address(f[1].split(":")[0]) == ipaddress.ip_address(parts[2])
                         and address(f[2].split(":")[0]) == ipaddress.ip_address(parts[0]) and f[9] in sockets(p["pid"])]
            assert connected
            return identity(row), list(reversed(chain)), {"connection": connection, "byteOrder": sys.byteorder, "listener": listener[0][1],
                  "session": connected[0][2], "sessionPid": connected[0][0]["pid"],
                  "listenerFds": sorted(fds), "sessionFds": sorted(sockets(connected[0][0]["pid"]))}
        chain.append(row)
        row = proc(parent(row))
    raise AssertionError("SSH listener ancestry not proved")


def request_valid(request):
    invocation = request["invocation"]
    assert re.fullmatch(r"r[1-9]\d{0,8}", invocation["round"])
    assert re.fullmatch(r"[a-f0-9]{40}", invocation["commit"])
    assert re.fullmatch(r"[a-f0-9]{16}", invocation["token"])
    assert re.fullmatch(r"[a-f0-9]{32}", invocation["id"])
    assert invocation["channel"] in ("ssh", "sftp")
    assert invocation["purpose"] in ("bootstrap", "audit", "status", "collection")
    assert 0 < invocation["deadlineMs"] <= 900000
    assert request["epoch"] in ("bootstrap", "audit-json-api", "audit-mixed-production", "collection")
    assert re.fullmatch(r"[a-f0-9]{64}", request["helperSha256"])
    assert isinstance(request["sequence"], int) and 0 <= request["sequence"] < 4096
    return invocation


def watch(root, identifier):
    request = load(root, "request-" + identifier + ".json")
    invocation = request_valid(request)
    start = load(root, "start-" + identifier + ".json")
    deadline = int(start["deadlineMonoNs"])
    launcher = root / ("launcher-" + identifier + ".json")
    while not launcher.exists():
        assert time.monotonic_ns() < deadline, "watcher launcher did not settle"
        time.sleep(0.025)
    assert load(root, launcher.name) == {"unit": start["unit"], "code": 0}
    observer = identity(proc(os.getpid()))
    assert observer["cgroup"] == "0::/system.slice/" + start["unit"] + "\n"
    listener, chain, socket = ancestry(start["child"], start["connection"])
    assert any(p["pid"] == start["guardian"] for p in chain)
    scope = proc(start["child"])["cgroup"][3:-1]
    assert scope.endswith(".scope") and not member(observer, scope) and not member(listener, scope)
    known = {key(p) for p in chain}
    samples = []
    rows_count = 0
    while time.monotonic_ns() < deadline:
        before = scope_read(scope, {})["events"] if samples else None
        rows = inventory()
        selected = {pid: p for pid, p in rows.items() if key(p) in known}
        changed = True
        while changed:
            changed = False
            for pid, p in rows.items():
                if pid not in selected and parent(p) in selected:
                    selected[pid] = p
                    known.add(key(p))
                    changed = True
        assert len(known) <= 8192
        scoped = scope_read(scope, rows)
        # A short-lived member may exit after /proc was read. Preserve both
        # actual cgroup reads and every observed PID; this is never a final sample.
        if (scoped["members"] and before and (not scoped["exists"]
                or before.startswith("populated 1\n") and scoped["events"].startswith("populated 0\n"))):
            scoped["eventsBeforeInventory"] = before
        assert all(pid in selected for pid in scoped["members"]), "unowned scope participant"
        for p in (listener, observer):
            actual = rows[p["pid"]]
            actual_identity = identity(actual)
            if p is listener and samples:
                assert all(actual_identity[field] == p[field] for field in ("pid", "startTicks", "cgroup", "executable"))
            else:
                assert actual_identity == p
            selected[p["pid"]] = actual
        at = time.monotonic_ns()
        assert at <= deadline, "control observation exceeded original deadline"
        sample = {**host(), "monoNs": str(at), "processes": sorted(selected.values(), key=lambda p: p["pid"]), "scope": scoped}
        samples.append(sample)
        rows_count += len(selected)
        assert len(samples) <= 4096 and rows_count <= 65536
        if len(samples) == 1:
            assert all(key(rows[pid]) in {key(p) for p in chain} for pid in scoped["members"])
            registration = {"invocation": invocation, "host": host(), "listener": listener, "observer": observer,
                            "session": {"scope": scope, "chain": [identity(p) for p in chain]}, "socket": socket, "first": sample}
            write(root / ("registration-" + identifier + ".json"), encoded(registration))
        result_path = root / ("result-" + identifier + ".json")
        if result_path.exists() and not any(key(p) in known for p in rows.values()) and not scoped["members"]:
            assert not scoped["exists"] or "populated 0\n" in scoped["events"]
            result = load(root, "result-" + identifier + ".json")
            receipt = {"schema": "benchmark-control-session/v2", "invocation": invocation, "host": registration["host"],
                       "listener": listener, "observer": observer, "session": registration["session"],
                       "samples": samples, "result": result, "socket": socket,
                       "window": {"startedMonoNs": str(deadline - invocation["deadlineMs"] * 1000000), "deadlineMonoNs": str(deadline)}}
            write(root / ("receipt-" + identifier + ".json"), encoded(receipt))
            return
        time.sleep(0.25)
    raise AssertionError("remote session drainage deadline expired")


def guard(request, source):
    invocation = request_valid(request)
    deadline = time.monotonic_ns() + invocation["deadlineMs"] * 1000000
    assert sha(source) == request["helperSha256"]
    root = root_for(invocation["token"])
    try:
        root.mkdir(mode=0o700)
        write(root / "helper.py", source)
        write(root / "binding.json", encoded({k: invocation[k] for k in ("round", "commit", "token")} | {"helperSha256": sha(source)}))
    except FileExistsError:
        private(root)
        assert read(root / "helper.py") == source
        assert load(root, "binding.json") == ({k: invocation[k] for k in ("round", "commit", "token")} | {"helperSha256": sha(source)})
    private(root)
    identifier = invocation["id"]
    with mutex(root):
        write(root / ("request-" + identifier + ".json"), encoded(request))
        for name in ("window.json", "campaign-active.json"):
            if (root / name).exists():
                owner = load(root, name)["owner"]
                recovery = (root / 'stream-drain.json').exists() or ((root / 'stream-invalid.json').exists() and (root / 'stream-lease.json').exists() and time.monotonic_ns() >= int(stream_load(root, 'stream-lease.json')['expiresMonoNs']))
                if alive(owner) and (name == "window.json" or request["epoch"] == "collection") and not recovery:
                    write(root / ("intrusion-" + identifier + ".json"), encoded({"invocation": invocation, "owner": owner}))
                    raise AssertionError("control during native campaign/window")
        if request["epoch"] != "collection":
            assert not (root / ("seal-" + request["epoch"] + ".json")).exists(), "control epoch closed"
    child_argv = ["/bin/bash", "-s"] if invocation["channel"] == "ssh" else ["/usr/lib/openssh/sftp-server", "-e"]
    child = subprocess.Popen(child_argv, stdin=subprocess.PIPE)
    unit = "corten-bench-control-" + invocation["token"] + "-" + identifier + ".service"
    write(root / ("start-" + identifier + ".json"), encoded({"guardian": os.getpid(), "child": child.pid, "unit": unit,
          "connection": os.environ["SSH_CONNECTION"], "deadlineMonoNs": str(deadline)}))
    launched = subprocess.run(["/usr/bin/systemd-run", "--quiet", "--unit=" + unit, "--property=Restart=no",
                    "--property=RuntimeMaxSec=" + str(invocation["deadlineMs"] / 1000),
                    "/usr/bin/python3", "-I", str(root / "helper.py"), "watch", invocation["token"], identifier],
                   check=True, timeout=min(10, invocation["deadlineMs"] / 1000), stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    write(root / ("launcher-" + identifier + ".json"), encoded({"unit": unit, "code": launched.returncode}))
    registration = root / ("registration-" + identifier + ".json")
    while not registration.exists():
        assert time.monotonic_ns() < deadline
        time.sleep(0.025)
    ack = sha(read(registration))
    released = time.monotonic_ns()
    print("CORTEN_CONTROL " + identifier + " " + ack, file=sys.stderr, flush=True)
    try:
        if request.get("seal") is not None:
            assert invocation["channel"] == "ssh"
            write(root / ("seal-" + request["epoch"] + ".json"), encoded({"schema": "benchmark-control-epoch/v1",
                  "binding": load(root, "binding.json"), "epoch": request["epoch"], "ledger": request["seal"], "final": identifier}))
        if invocation["channel"] == "ssh":
            payload = sys.stdin.buffer.read(LIMIT + 1)
            assert len(payload) <= LIMIT and sha(payload) == invocation["requestSha256"]
            child.stdin.write(payload)
        else:
            while True:
                block = sys.stdin.buffer.read1(65536)
                if not block:
                    break
                assert time.monotonic_ns() < deadline
                child.stdin.write(block)
                child.stdin.flush()
        child.stdin.close()
        code = child.wait(timeout=max(0.001, (deadline - time.monotonic_ns()) / 1000000000))
        assert 0 <= code <= 255
        completed = time.monotonic_ns()
        assert completed <= deadline, "remote command exceeded original deadline"
        result = {"transport": "exited", "code": code, "releasedMonoNs": str(released), "completedMonoNs": str(completed)}
        write(root / ("result-" + identifier + ".json"), encoded(result))
        print("CORTEN_RESULT " + identifier + " " + str(code), file=sys.stderr, flush=True)
        return code
    finally:
        # EOF/cooperative closure only. Never kill SSH ancestors or adopt a foreign scope.
        if not child.stdin.closed:
            child.stdin.close()


def watcher_terminal(root, identifier, receipt):
    start = load(root, "start-" + identifier + ".json")
    unit = start["unit"]
    expected = "corten-bench-control-" + receipt["invocation"]["token"] + "-" + identifier + ".service"
    assert unit == expected
    result = subprocess.run(["/usr/bin/systemctl", "show", unit, "--property=Id", "--property=LoadState",
                             "--property=ActiveState", "--property=MainPID", "--property=ExecMainCode", "--property=ExecMainStatus"],
                            check=True, capture_output=True, timeout=5)
    assert len(result.stdout) < 4096
    properties = dict(line.split("=", 1) for line in result.stdout.decode().splitlines())
    assert properties["Id"] == unit
    if properties["MainPID"] != "0" or properties["ActiveState"] not in ("inactive", "failed"):
        return None
    assert properties["LoadState"] in ("loaded", "not-found")
    if properties["LoadState"] == "loaded":
        assert properties["ExecMainCode"] == "1" and properties["ExecMainStatus"] == "0"
    observer = receipt["observer"]
    try:
        assert key(proc(observer["pid"])) != key(observer), "watcher still exists"
    except (FileNotFoundError, ProcessLookupError):
        pass
    path = pathlib.Path("/sys/fs/cgroup/system.slice/" + unit)
    events = (path / "cgroup.events").read_text() if path.exists() else None
    assert events is None or "populated 0\n" in events
    return {"unit": unit, "properties": properties, "observer": observer, "cgroupEvents": events, "identityAbsent": True}


def inspect_epoch(root, epoch):
    assert not (root / ("admission-blocked-" + epoch + ".json")).exists(), "first blocked control inventory retained"
    seal_path = root / ("seal-" + epoch + ".json")
    if not seal_path.exists():
        return None
    seal = load(root, seal_path.name)
    references = seal["ledger"]
    assert 0 < len(references) <= 4096 and references[-1]["id"] == seal["final"]
    assert len({r["id"] for r in references}) == len(references)
    ledger = []
    for reference in references:
        assert re.fullmatch(r"[a-f0-9]{32}", reference["id"])
        invocation = load(root, "request-" + reference["id"] + ".json")["invocation"]
        assert sha(encoded(invocation)[:-1]) == reference["sha256"]
        ledger.append(invocation)
    actual = [load(root, p.name)["invocation"] for p in root.glob("request-*.json") if load(root, p.name)["epoch"] == epoch]
    assert sorted(actual, key=lambda p: p["id"]) == sorted(ledger, key=lambda p: p["id"])
    receipts, watchers = [], []
    for invocation in ledger:
        identifier = invocation["id"]
        assert not (root / ("watch-failure-" + identifier + ".json")).exists(), "control watcher failed"
        path = root / ("receipt-" + identifier + ".json")
        if not path.exists():
            start = load(root, "start-" + identifier + ".json")
            assert time.monotonic_ns() < int(start["deadlineMonoNs"]), "session receipt expired"
            return None
        receipt = load(root, path.name)
        assert receipt["invocation"] == invocation
        terminal = watcher_terminal(root, identifier, receipt)
        if terminal is None:
            return None
        receipts.append(receipt)
        watchers.append(terminal)
    rows = inventory()
    apparatus = stream_apparatus(root)
    blocked = False
    for receipt in receipts:
        listener = receipt["listener"]
        blocked |= any(key(p) != key(listener) and (p["cgroup"] == listener["cgroup"]
                       or p["cgroup"].startswith(listener["cgroup"].rstrip("\n") + "/") or parent(p) == listener["pid"])
                       for p in rows.values() if p['pid'] not in apparatus)
    blocked |= any(p["cgroup"].startswith("0::/user.slice/") or re.search(r"/session-[^/\n]+\.scope(?:/|\n)", p["cgroup"])
                   for p in rows.values() if p['pid'] not in apparatus)
    if blocked:
        target = root / ("admission-blocked-" + epoch + ".json")
        if not target.exists():
            write(target, encoded({"host": host(), "monoNs": str(time.monotonic_ns()), "processes": sorted(rows.values(), key=lambda p: p["pid"])}))
        raise AssertionError("unregistered SSH/login userspace remains")
    assert not list(root.glob("intrusion-*.json")), "control intrusion retained"
    return {"schema": "benchmark-control-admission/v1", "seal": seal, "invocations": ledger, "receipts": receipts, "watchers": watchers,
            "host": host(), "closedMonoNs": str(time.monotonic_ns()), "qualification": "pending-first-host-native-proof",
            **({'apparatus': load(root, 'stream-registration.json'), 'apparatusSample': stream_sample(load(root, 'stream-registration.json'))} if apparatus else {})}


def setup_query(root, expected):
    private(root)
    assert load(root, "binding.json") == expected["binding"]
    assert sha(read(root / "helper.py")) == expected["binding"]["helperSha256"]
    assert not list(root.glob("seal-*.json")) and not list(root.glob("admission-*.json")), "sealed/native entry is not failed setup"
    assert not (root / "campaign-active.json").exists() and not (root / "window.json").exists()
    assert not list(root.glob("intrusion-*.json"))
    requests = expected["requests"]
    assert 0 < len(requests) < 4096 and expected["sequence"] == len(requests)
    actual = [load(root, p.name) for p in root.glob("request-*.json")]
    assert len(actual) == len(requests) + 1
    current = [p for p in actual if p["sequence"] == expected["sequence"]]
    assert len(current) == 1
    current = current[0]
    identifier = request_valid(current)["id"]
    assert current["epoch"] == "collection" and current["invocation"]["channel"] == "ssh" and "seal" not in current
    assert current["helperSha256"] == expected["binding"]["helperSha256"]
    assert sorted(actual, key=lambda p: p["sequence"]) == requests + [current]
    receipts, watchers = [], []
    allowed_names = {"helper.py", "binding.json", "mutex"}
    for sequence, request in enumerate(requests + [current]):
        assert request["sequence"] == sequence and request["epoch"] in ("bootstrap", "collection") and "seal" not in request
        invocation = request_valid(request)
        assert all(invocation[k] == expected["binding"][k] for k in ("round", "commit", "token"))
        assert request["helperSha256"] == expected["binding"]["helperSha256"]
        names = ("request", "start", "launcher", "registration") + (() if sequence == len(requests) else ("result", "receipt"))
        allowed_names.update(name + "-" + invocation["id"] + ".json" for name in names)
        if sequence < len(requests):
            receipt = load(root, "receipt-" + invocation["id"] + ".json")
            assert receipt["invocation"] == invocation and receipt["host"] == host()
            terminal = watcher_terminal(root, invocation["id"], receipt)
            assert terminal is not None, "earlier query watcher unresolved"
            receipts.append(receipt)
            watchers.append(terminal)
    assert {p.name for p in root.iterdir()} == allowed_names, "unknown control custody member"
    registration = load(root, "registration-" + identifier + ".json")
    start = load(root, "start-" + identifier + ".json")
    launcher = load(root, "launcher-" + identifier + ".json")
    assert launcher == {"unit": start["unit"], "code": 0}
    assert registration["invocation"] == current["invocation"] and registration["host"] == host()
    unit = "corten-bench-control-" + expected["binding"]["token"] + "-" + identifier + ".service"
    assert start["unit"] == unit
    properties = ["Id", "LoadState", "ActiveState", "MainPID", "Restart", "FragmentPath", "ControlGroup"]
    result = subprocess.run(["/usr/bin/systemctl", "show", unit] + ["--property=" + p for p in properties],
                            check=True, capture_output=True, timeout=5)
    assert len(result.stdout) < 4096
    values = dict(line.split("=", 1) for line in result.stdout.decode().splitlines())
    observer = registration["observer"]
    assert values == {"Id": unit, "LoadState": "loaded", "ActiveState": "active", "MainPID": str(observer["pid"]),
                      "Restart": "no", "FragmentPath": "/run/systemd/transient/" + unit, "ControlGroup": "/system.slice/" + unit}
    assert identity(proc(observer["pid"])) == observer
    command = lambda args: b"\0".join(os.fsencode(arg) for arg in args) + b"\0"
    watcher_argv = ["/usr/bin/python3", "-I", str(root / "helper.py"), "watch", expected["binding"]["token"], identifier]
    assert (pathlib.Path("/proc") / str(observer["pid"]) / "cmdline").read_bytes() == command(watcher_argv)
    query, timeout = proc(os.getpid()), proc(os.getppid())
    assert parent(query) == timeout["pid"]
    query_argv = ["/usr/bin/python3"] + sys.argv
    assert query_argv == expected["queryArgv"]
    timeout_argv = ["/usr/bin/timeout", "25"] + query_argv
    for row, argv in ((query, query_argv), (timeout, timeout_argv)):
        assert (pathlib.Path("/proc") / str(row["pid"]) / "cmdline").read_bytes() == command(argv)
    executables = {}
    for name, path in (("python", "/usr/bin/python3"), ("timeout", "/usr/bin/timeout")):
        info = pathlib.Path(path).stat()
        executables[name] = {"device": str(info.st_dev), "inode": str(info.st_ino)}
    assert query["executable"] == observer["executable"] == executables["python"]
    assert timeout["executable"] == executables["timeout"]
    rows = inventory()
    assert identity(rows[query["pid"]]) == identity(query) and identity(rows[timeout["pid"]]) == identity(timeout)
    chain = registration["session"]["chain"]
    assert {p["pid"] for p in registration["first"]["processes"]} == {p["pid"] for p in chain} | {observer["pid"], registration["listener"]["pid"]}
    assert chain[-1]["pid"] == start["child"] and chain[-2]["pid"] == start["guardian"]
    assert start["connection"] == registration["socket"]["connection"]
    allowed = {p["pid"] for p in chain} | {registration["listener"]["pid"], observer["pid"], query["pid"], timeout["pid"]}
    assert len(allowed) >= len(chain) + 3
    for owned in chain + [observer, registration["listener"]]:
        actual_row = rows[owned["pid"]]
        assert key(actual_row) == key(owned) and actual_row["cgroup"] == owned["cgroup"]
        if owned["pid"] not in (registration["listener"]["pid"], timeout["pid"]):
            assert identity(actual_row) == owned
        if owned["pid"] == registration["listener"]["pid"]:
            assert actual_row["executable"] == owned["executable"]
    assert parent(timeout) in (start["child"], start["guardian"]) and timeout["pid"] != start["guardian"]
    scope = registration["session"]["scope"]
    assert member(query, scope) and member(timeout, scope)
    for row in rows.values():
        if row["pid"] in allowed:
            continue
        assert parent(row) not in allowed, "unregistered query descendant"
        assert not row["cgroup"].startswith("0::/user.slice/") and not re.search(r"/session-[^/\n]+\.scope(?:/|\n)", row["cgroup"])
        assert not row["cgroup"].startswith("0::/system.slice/corten-bench"), "unknown owned-unit participant"
        assert row["cgroup"] != registration["listener"]["cgroup"] and not row["cgroup"].startswith(registration["listener"]["cgroup"].rstrip("\n") + "/")
    entries, total = [], 0
    for path in sorted(root.iterdir()):
        contents = read(path)
        total += len(contents)
        assert total <= 64 * 1024 * 1024
        entries.append({"name": path.name, "bytes": len(contents), "sha256": sha(contents)})
    custody = pathlib.Path("/bench/control")
    private(custody)
    copied = []
    for path in sorted(custody.iterdir()):
        assert path.name in allowed_names
        contents = read(path)
        assert contents == read(root / path.name), "original custody changed"
        copied.append({"name": path.name, "bytes": len(contents), "sha256": sha(contents)})
    assert {p["name"] for p in copied} >= {"helper.py", "binding.json"}
    observed = time.monotonic_ns()
    assert observed < int(start["deadlineMonoNs"])
    proof = {"schema": "benchmark-control-setup-query/v1", "binding": expected["binding"], "requests": requests + [current],
             "receipts": receipts, "watchers": watchers, "registration": registration, "start": start, "launcher": launcher,
             "watcher": values, "query": identity(query), "timeout": identity(timeout), "executables": executables,
             "observation": {**host(), "monoNs": str(observed), "processes": sorted(rows.values(), key=lambda p: p["pid"])},
             "entries": entries, "custody": copied}
    assert len(encoded(proof)) <= LIMIT
    return proof


def custody(root):
    destination = pathlib.Path("/bench/control")
    if destination.exists():
        private(destination)
    else:
        destination.mkdir(mode=0o700)
    total = 0
    for path in sorted(root.iterdir()):
        assert re.fullmatch(r"(?:helper\.py|mutex|binding\.json|window\.json|campaign-active\.json|stream-(?:registration|lease|state|invalid|terminal|sealed|drain|audit-json-api|audit-mixed-production)\.json|stream-observations\.jsonl|(?:request|start|launcher|registration|result|receipt|intrusion|watch-failure)-[a-f0-9]{32}\.json|(?:seal|admission|admission-blocked)-(?:bootstrap|audit-json-api|audit-mixed-production|collection)\.json)", path.name)
        data = read(path, 64 * 1024 * 1024 if path.name == 'stream-observations.jsonl' else LIMIT)
        total += len(data)
        assert total <= 64 * 1024 * 1024
        target = destination / path.name
        if target.exists():
            assert read(target) == data
        else:
            write(target, data, limit=64 * 1024 * 1024 if path.name == 'stream-observations.jsonl' else LIMIT)


${streamSource}


def main(args):
    if args[0] in ("guard", "guard-stdin"):
        if args[0] == "guard-stdin":
            assert re.fullmatch(r"[1-9]\d{0,7}", args[1])
            length = int(args[1])
            assert length <= LIMIT
            raw = sys.stdin.buffer.read(length)
            assert len(raw) == length
        else:
            raw = bytes.fromhex(args[1])
        request = json.loads(raw)
        source = bytes.fromhex(args[2]) if len(args) == 3 else read(root_for(request["invocation"]["token"]) / "helper.py")
        return guard(request, source)
    mode, token = args[:2]
    root = root_for(token)
    private(root)
    assert sha(read(root / "helper.py")) == load(root, "binding.json")["helperSha256"]
    if mode == "monitor":
        return stream_monitor(root, json.loads(bytes.fromhex(args[2])))
    elif mode == "stream-watchdog":
        return stream_watchdog(root, args[2])
    elif mode == "stream-drain":
        proof = stream_drain(root)
        if proof is None:
            return 3
        sys.stdout.buffer.write(encoded(proof))
    elif mode == "watch":
        assert re.fullmatch(r"[a-f0-9]{32}", args[2])
        try:
            watch(root, args[2])
        except Exception as error:
            # Only a line in this exact hashed helper, never exception text or process data.
            write(root / ("watch-failure-" + args[2] + ".json"), encoded({"helperLine": helper_line(error)}))
            raise
    elif mode == "inspect":
        assert args[2] in ("bootstrap", "audit-json-api", "audit-mixed-production")
        admission = inspect_epoch(root, args[2])
        if admission is None:
            return 3
        target = root / ("admission-" + args[2] + ".json")
        if target.exists():
            admission = load(root, target.name)
        else:
            write(target, encoded(admission))
        sys.stdout.buffer.write(encoded(admission))
    elif mode == "custody":
        custody(root)
    elif mode in ("activate", "window-open", "window-close"):
        window_operation(root, mode)
    else:
        raise AssertionError("unknown control helper mode")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        print("control session unresolved; preserve state/evidence/host", file=sys.stderr)
        sys.exit(254)
`;
