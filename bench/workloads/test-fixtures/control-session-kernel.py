"""In-memory kernel/systemd/SFTP loopback. Never executes a host command or proc probe."""
import contextlib
import copy
import fnmatch
import hashlib
import io
import json
import pathlib
import sys
import threading
import time
import traceback
import types


class patch:
    @staticmethod
    @contextlib.contextmanager
    def object(target, name, value):
        previous = getattr(target, name)
        setattr(target, name, value)
        try:
            yield
        finally:
            setattr(target, name, previous)

    @staticmethod
    @contextlib.contextmanager
    def dict(target, values):
        previous = {key: target.get(key) for key in values}
        target.update(values)
        try:
            yield
        finally:
            for key, value in previous.items():
                if value is None:
                    target.pop(key, None)
                else:
                    target[key] = value

argument = json.loads(sys.stdin.read())
source = argument["source"]
scope = {"__name__": "source_bound_fixture"}
exec(compile(source, "<reviewed-control-session>", "exec"), scope)
mode = argument["mode"]
token = "0123456789abcdef"
commit = "a" * 40
boot = {"hostname": "synthetic-host", "bootId": "01234567-89ab-cdef-0123-456789abcdef"}

# Exercise the real storage reader against a tiny fake fd. Read access-time
# changes are ordinary; inode/ownership/mode/content changes must still reject.
storage = {"st_dev": 1, "st_ino": 2, "st_mode": 0o100600, "st_nlink": 1, "st_uid": 0,
           "st_gid": 0, "st_size": 3, "st_mtime_ns": 1, "st_ctime_ns": 1, "st_atime_ns": 0}
def storage_read(fd, limit):
    storage["st_atime_ns"] += 1
    if mode == "storage-mutation":
        storage["st_ino"] += 1
    return b"abc"

storage_os = types.SimpleNamespace(getuid=lambda: 0, open=lambda *args: 9, close=lambda fd: None,
                                   read=storage_read, fstat=lambda fd: types.SimpleNamespace(**storage), O_RDONLY=0, O_NOFOLLOW=0)
with patch.dict(scope, {"os": storage_os}):
    path = types.SimpleNamespace(lstat=lambda: types.SimpleNamespace(**storage))
    if mode == "storage-mutation":
        try:
            scope["read"](path)
            raise RuntimeError("inode mutation accepted")
        except AssertionError:
            print(json.dumps({"mutationRejected": True}))
            sys.exit(0)
    assert scope["read"](path) == b"abc"
data, folders, rows, units, threads, errors = {}, set(), {}, {}, [], []
local = threading.local()
lock = threading.RLock()
current = {}


class Path:
    def __init__(self, value):
        self.value = str(value)

    def __str__(self):
        return self.value

    def __eq__(self, other):
        return self.value == str(other)

    def __lt__(self, other):
        return self.value < str(other)

    def __truediv__(self, part):
        return Path(self.value + "/" + str(part))

    @property
    def name(self):
        return self.value.rsplit("/", 1)[-1]

    def resolve(self):
        return self

    def mkdir(self, mode):
        assert mode == 0o700
        if self.value in folders:
            raise FileExistsError()
        folders.add(self.value)

    def exists(self):
        if self.value.startswith("/sys/fs/cgroup/"):
            cg = self.value[len("/sys/fs/cgroup"):]
            return cg.endswith(".scope") or any(p["cgroup"] == "0::" + cg + "\n" for p in rows.values())
        return self.value in data or self.value in folders

    def read_text(self):
        assert self.name == "cgroup.events"
        cg = self.value[len("/sys/fs/cgroup"):-len("/cgroup.events")]
        populated = any(p["cgroup"] == "0::" + cg + "\n" for p in rows.values())
        return "populated " + str(int(populated)) + "\nfrozen 0\n"

    def glob(self, pattern):
        return [p for p in self.iterdir() if fnmatch.fnmatchcase(p.name, pattern)]

    def iterdir(self):
        return [Path(p) for p in list(data) if p.rsplit("/", 1)[0] == self.value]

    def unlink(self):
        del data[self.value]


root = Path("/run/corten-bench-control-" + token)


def write(path, value):
    assert str(path) not in data and len(value) <= scope["LIMIT"]
    data[str(path)] = bytes(value)


def read(path, limit=8 * 1024 * 1024):
    value = data[str(path)]
    assert len(value) <= limit
    return value


def row(pid, ppid, cg):
    fields = ["0"] * 49
    fields[0], fields[18] = str(ppid), str(pid * 100)
    return {"pid": pid, "startTicks": fields[18], "cgroup": "0::" + cg + "\n",
            "stat": str(pid) + " (no-name-authority) S " + " ".join(fields) + "\n",
            "executable": {"device": "1", "inode": str(pid)}, "commandSha256": hashlib.sha256(str(pid).encode()).hexdigest()}


def proc(pid):
    if pid not in rows:
        raise FileNotFoundError()
    return copy.deepcopy(rows[pid])


rows[1] = row(1, 0, "/init.scope")
rows[10] = row(10, 1, "/system.slice/ssh.service")


class Sink(io.BytesIO):
    def write(self, value):
        assert str(root / ("registration-" + current["id"] + ".json")) in data, "payload released before registration"
        assert "CORTEN_CONTROL " + current["id"] in frames.getvalue(), "payload released before acknowledgement"
        return super().write(value)

    def close(self):
        self.transferred = self.getvalue()
        super().close()


class Child:
    def __init__(self, args, stdin):
        assert args in (["/bin/bash", "-s"], ["/usr/lib/openssh/sftp-server", "-e"])
        self.pid = current["child"]
        self.stdin = Sink()

    def wait(self, timeout):
        assert timeout > 0 and self.stdin.transferred == current["payload"]
        assert str(root / ("registration-" + current["id"] + ".json")) in data, "payload before registration"
        rows.pop(self.pid)
        if mode == "disconnect":
            raise scope["subprocess"].TimeoutExpired("synthetic-disconnect", timeout)
        return 0


def run(args, **kwargs):
    if args[0] == "/usr/bin/systemd-run":
        assert "--property=Restart=no" in args
        assert args[-3] == "watch"
        identifier = args[-1]
        unit = next(p.split("=", 1)[1] for p in args if p.startswith("--unit="))
        observer = 200 + len(units)
        rows[observer] = row(observer, 1, "/system.slice/" + unit)
        units[unit] = observer

        def target():
            local.pid = observer
            try:
                scope["watch"](root, identifier)
            except Exception as error:
                errors.append(traceback.format_exc(limit=4))
            finally:
                rows.pop(observer, None)

        thread = threading.Thread(target=target, name="outside-session-watcher")
        threads.append(thread)
        thread.start()
        return types.SimpleNamespace(returncode=0)
    assert args[0] == "/usr/bin/systemctl" and args[1] == "show", "unexpected host command"
    unit = args[2]
    active = units[unit] in rows or mode == "watcher-alive"
    values = {"Id": unit, "LoadState": "loaded", "ActiveState": "active" if active else "inactive",
              "MainPID": str(units[unit]) if active else "0", "ExecMainCode": "1", "ExecMainStatus": "0"}
    return types.SimpleNamespace(returncode=0, stdout="".join(k + "=" + v + "\n" for k, v in values.items()).encode())


def sockets(pid):
    return {"500"} if pid == 10 else {"501"} if pid in rows and scope["parent"](rows[pid]) == 10 else set()


tcp = [(["0:", "00000000:0016", "00000000:0000", "0A", "0", "0", "0", "0", "0", "500"],
        "0: 00000000:0016 00000000:0000 0A 0 0 0 0 0 500"),
       (["1:", "0A0200C0:0016", "140200C0:9C40", "01", "0", "0", "0", "0", "0", "501"],
        "1: 0A0200C0:0016 140200C0:9C40 01 0 0 0 0 0 501")]
scope.update({"root_for": lambda t: root if t == token else None, "private": lambda p: None, "write": write, "read": read,
              "proc": proc, "inventory": lambda: copy.deepcopy(rows), "host": lambda: dict(boot),
              "socket_rows": lambda: tcp, "sockets": sockets, "mutex": lambda r: contextlib.nullcontext()})
# Windows Python monotonic may be tick-resolution. The fake clock uses its high-
# resolution monotonic counter; shorten synthetic sleeps, not source deadlines.
scope["time"] = types.SimpleNamespace(monotonic_ns=time.perf_counter_ns, sleep=lambda seconds: time.sleep(min(seconds, 0.005)))
invocations = []
frames = io.StringIO()
binding = {"round": "r21", "commit": commit, "token": token, "helperSha256": hashlib.sha256(source.encode()).hexdigest()}

with patch.object(scope["pathlib"], "Path", Path), patch.object(scope["subprocess"], "Popen", Child), \
        patch.object(scope["subprocess"], "run", run), patch.object(scope["os"], "getpid", lambda: getattr(local, "pid", current["guardian"])), \
        patch.dict(scope["os"].environ, {"SSH_CONNECTION": "192.0.2.20 40000 192.0.2.10 22"}), patch.object(sys, "stderr", frames):
    for sequence, channel in enumerate(["ssh", "sftp", "ssh"]):
        identifier = format(sequence + 1, "032x")
        payload = b"set -euo pipefail\n:\n" if channel == "ssh" else b"synthetic-sftp-protocol"
        invocation = {"schema": "benchmark-control-invocation/v1", "round": "r21", "commit": commit, "token": token,
                      "id": identifier, "channel": channel, "purpose": "bootstrap", "requestSha256": hashlib.sha256(payload).hexdigest(), "deadlineMs": 1000}
        request = {"invocation": invocation, "helperSha256": binding["helperSha256"], "epoch": "bootstrap", "sequence": sequence}
        invocations.append(invocation)
        if sequence == 2:
            request["seal"] = [{"id": p["id"], "sha256": hashlib.sha256(scope["encoded"](p)[:-1]).hexdigest()} for p in invocations]
        current.update({"id": identifier, "guardian": 101 + sequence * 10, "child": 102 + sequence * 10, "payload": payload})
        local.pid = current["guardian"]
        ancestor = 100 + sequence * 10
        session = "/user.slice/user-0.slice/session-" + str(sequence + 7) + ".scope"
        rows[ancestor] = row(ancestor, 10, "/system.slice/ssh.service")
        rows[current["guardian"]] = row(current["guardian"], ancestor, session)
        rows[current["child"]] = row(current["child"], current["guardian"], session)
        try:
            with patch.object(sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(payload))):
                assert scope["guard"](request, source.encode()) == 0
        except scope["subprocess"].TimeoutExpired:
            pass
        except AssertionError as error:
            raise RuntimeError("synthetic watcher errors: " + str(errors)) from error
        rows.pop(current["guardian"], None)
        if mode == "listener-title":
            rows[10]["commandSha256"] = hashlib.sha256(("listener-status-" + identifier).encode()).hexdigest()
        if mode == "ancestor-zombie":
            rows[ancestor]["executable"] = None
            rows[ancestor]["stat"] = rows[ancestor]["stat"].replace(") S ", ") Z ")
        if mode not in ("ancestor-survives", "ancestor-zombie"):
            rows.pop(ancestor, None)
        threads[-1].join(3)
        assert not threads[-1].is_alive(), "test watcher leaked"
        if mode in ("disconnect", "ancestor-survives", "ancestor-zombie"):
            assert str(root / ("receipt-" + identifier + ".json")) not in data
            break
    if mode in ("disconnect", "ancestor-survives", "ancestor-zombie"):
        output = {"intentionalNegative": mode, "receiptAbsent": True, "observerErrors": errors}
    else:
        if mode == "unknown-survivor":
            rows[999] = row(999, 10, "/foreign.scope")
        if mode == "unknown-user-manager":
            rows[999] = row(999, 1, "/user.slice/user-0.slice/user@0.service")
        try:
            admission = scope["inspect_epoch"](root, "bootstrap")
        except AssertionError:
            assert mode in ("unknown-survivor", "unknown-user-manager")
            assert str(root / "admission-blocked-bootstrap.json") in data
            original_blocked = data[str(root / "admission-blocked-bootstrap.json")]
            rows.pop(999)
            try:
                scope["inspect_epoch"](root, "bootstrap")
                raise RuntimeError("later clean inventory cleared first unknown survivor")
            except AssertionError:
                assert data[str(root / "admission-blocked-bootstrap.json")] == original_blocked
            admission = None
        scope["custody"](root)
        assert any(p.startswith("/bench/control/registration-") for p in data), "early registration custody missing"
        assert data["/bench/control/helper.py"] == source.encode()
        output = {"binding": binding, "admission": admission, "frames": frames.getvalue(), "custodyFiles": len([p for p in data if p.startswith("/bench/control/")])}
        if mode == "window":
            node = 30
            rows[node] = row(node, 1, "/system.slice/corten-bench-groups-r21-" + token + ".service/supervisor")
            with patch.object(scope["os"], "getppid", lambda: node):
                scope["window_operation"](root, "activate")
                scope["window_operation"](root, "window-open")
                request = copy.deepcopy(request)
                request.pop("seal")
                request["epoch"] = "collection"
                request["invocation"]["id"] = "f" * 32
                request["invocation"]["purpose"] = "collection"
                try:
                    scope["guard"](request, source.encode())
                    raise RuntimeError("intrusion accepted")
                except AssertionError:
                    pass
                try:
                    scope["window_operation"](root, "window-close")
                    raise RuntimeError("intruded phase advanced")
                except AssertionError:
                    output["intrusionBlocked"] = True
print(json.dumps(output))
