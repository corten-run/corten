"""Run the emitted guest program and its bound helper against in-memory Linux observations."""
import io
import json
import os
# Load the helper's randomness module before replacing its OS interface.
import secrets
import shlex
import stat
import sys
import urllib.request
from pathlib import PurePosixPath
from types import SimpleNamespace as NS
from unittest.mock import patch

case = json.load(sys.stdin)
mode = case["mode"]
header, body = case["script"].split(" <<'CORTEN_UNUSED_HOST'\n")
program, end = body.rsplit("\nCORTEN_UNUSED_HOST", 1)
args = shlex.split(header)
assert not end and args == ["/usr/bin/timeout", "25", "/usr/bin/python3", "-", case["hostId"], case["unit"], "{}"]
requests = case["requests"]
inv = requests[0]["invocation"]
host = dict(hostname="guest", bootId="synthetic-boot")


class Path(PurePosixPath):
    def iterdir(self):
        if not self.is_dir(): raise NotADirectoryError(str(self))
        return (p for p in nodes if p != self and p.parent == self)

    def glob(self, pattern):
        return [p for p in self.iterdir() if p.match(pattern)]

    def exists(self): return self in nodes
    def is_dir(self): return self in nodes and nodes[self] is None
    def is_symlink(self): return self in links
    def resolve(self): return self

    def read_bytes(self):
        if self not in nodes: raise FileNotFoundError(str(self))
        return nodes[self]

    def read_text(self, **kwargs): return self.read_bytes().decode()

    def lstat(self):
        data = self.read_bytes()
        mode = stat.S_IFLNK if self.is_symlink() else stat.S_IFDIR if self.is_dir() else stat.S_IFREG
        return NS(st_dev=1, st_ino=abs(hash(self)), st_uid=0, st_gid=0, st_mode=mode | 0o700,
                  st_size=len(data or b""), st_nlink=1, st_ctime_ns=1, st_mtime_ns=1)

    def stat(self):
        return Path(links.get(self, self)).lstat()


nodes, links = {}, {}


def put(path, data=b""):
    p = Path(path)
    nodes[p] = data
    for parent in p.parents: nodes.setdefault(parent, None)


def link(path, target):
    put(path)
    links[Path(path)] = target


def encoded(value): return (json.dumps(value, separators=(",", ":")) + "\n").encode()


root = Path("/run/corten-bench-control-" + inv["token"])
put(root / "helper.py", case["guardianSource"].encode())
put(root / "binding.json", encoded({k: inv[k] for k in ("round", "commit", "token")} | {"helperSha256": requests[0]["helperSha256"]}))
put(root / "mutex")
put("/bench/run.log")
instance = "/var/lib/cloud/instances/" + case["hostId"]
link("/var/lib/cloud/instance", instance)
put(instance + "/user-data.txt", case["preloginUserData"].encode())
put("/var/lib/cloud/data/instance-id", case["hostId"].encode())
put("/proc/sys/kernel/random/boot_id", host["bootId"].encode())
put("/usr/lib/openssh/sftp-server")
for directory in ("/etc/systemd/system", "/run/systemd/system", "/run/systemd/transient", "/sys/fs/cgroup/system.slice"):
    put(directory, None)

# The fresh observation has an SSH connection distinct from the missing upload.
put("/proc/net/tcp", b"header\n0: 00000000:0016 00000000:0000 0A 0 0 0 0 0 500\n1: 0A0200C0:0016 140200C0:9C40 01 0 0 0 0 0 501\n")
put("/proc/net/tcp6", b"header\n")
for pid, parent, exe in [(10, 1, "/usr/sbin/sshd"), (11, 10, "/usr/bin/timeout"), (12, 11, "/usr/bin/python3")]:
    fields = ["0"] * 49
    fields[0], fields[18] = str(parent), str(pid * 100)
    proc = Path("/proc") / str(pid)
    put(exe)
    link(proc / "exe", exe)
    put(proc / "stat", (f"{pid} (proc) S " + " ".join(fields) + "\n").encode())
    put(proc / "cgroup", b"0::/system.slice/ssh.service\n" if pid == 10 else b"0::/user.slice/session-3.scope\n")
    put(proc / "cmdline", ("\0".join(args) + "\0").encode() if pid == 11 else b"process\0")
    put(proc / "fd", None)
link("/proc/10/fd/5", "socket:[500]")
link("/proc/11/fd/6", "socket:[501]")

listener = dict(pid=10, startTicks="1000", cgroup="0::/system.slice/ssh.service\n",
                executable=dict(device="1", inode=str(Path("/usr/sbin/sshd").stat().st_ino)))
units = []
for i, request in enumerate(requests):
    invocation = request["invocation"]
    unit = root.name + "-" + invocation["id"] + ".service"
    units.append(unit)
    records = dict(request=request, start=dict(unit=unit), launcher=dict(unit=unit, code=0))
    if i < 2:
        child = dict(pid=20+i, startTicks="3000")
        registration = dict(invocation=invocation, host=host, session=dict(scope=f"/user.slice/session-{i}.scope", chain=[child]),
                            socket=dict(connection=str(i)), observer=dict(pid=40+i, startTicks="4000"), listener=listener)
        result = dict(transport="exited", code=0)
        records.update(registration=registration, result=result, receipt=dict(schema="benchmark-control-session/v2", **registration,
                       result=result, samples=[dict(processes=[listener, child])]))
    else:
        records["start"].update(guardian=710, child=711, deadlineMonoNs="100", connection="192.0.2.20 45678 192.0.2.10 22")
        records["watch-failure"] = dict(helperLine=318)
    for prefix, value in records.items():
        put(root / (prefix + "-" + invocation["id"] + ".json"), encoded(value))

if mode == "job-present": put("/bench/job.sh", b"partial")
if mode == "unknown-file": put("/bench/unknown")
if mode == "remote-seal": put(root / "seal-bootstrap.json", b"{}")
if mode == "different-user-data": put(instance + "/user-data.txt", b"unrecognized")


def run(command, **options):
    assert options["timeout"] == 5
    if command[:2] == ["cloud-init", "status"]: out = '{"status":"done"}'
    elif command[:2] == ["systemctl", "list-jobs"]: out = ""
    elif command[:2] == ["systemctl", "list-units"]: out = units[-1] + " loaded failed failed"
    else:
        assert command[0] in ("systemctl", "/usr/bin/systemctl") and command[1] == "show"
        unit = next(x for x in command if x.endswith(".service"))
        benchmark, failed = unit == case["unit"], unit == units[-1]
        assert benchmark or unit in units
        values = dict(Id=unit, LoadState="not-found" if benchmark else "loaded", MainPID="0", ControlPID="0",
                      ActiveState="failed" if failed else "inactive", SubState="failed" if failed else "dead",
                      Restart="no", NRestarts="0", Job="", Triggers="", TriggeredBy="", FragmentPath="",
                      ExecMainStartTimestampMonotonic="1" if benchmark and mode == "started" else "0",
                      ExecMainCode="1", ExecMainStatus="254" if failed else "0")
        out = "\n".join(k+"="+values[k] for k in (a.split("=", 1)[1] for a in command if a.startswith("--property=")))
    return NS(returncode=0, stdout=out if options.get("text") else out.encode())


def entry(name, dir_fd=None): return (dir_fd or Path("/")) / name


def metadata(url, timeout):
    assert url == "http://169.254.169.254/metadata/v1/id" and timeout == 3
    return io.BytesIO(case["hostId"].encode())


# Fake file descriptors denote stable guest paths. Unknown files are absent;
# no fallback to a real subprocess, filesystem, SSH, or metadata endpoint.
guest_os = NS(O_RDONLY=0, O_DIRECTORY=1, O_NOFOLLOW=2, O_NONBLOCK=4, O_PATH=8,
              open=lambda name, flags, dir_fd=None: entry(name, dir_fd), close=lambda fd: None,
              read=lambda fd, n: fd.read_bytes()[:n], fdopen=lambda fd, mode: io.BytesIO(fd.read_bytes()),
              fstat=lambda fd: fd.lstat(), stat=lambda name, dir_fd=None, **kw: entry(name, dir_fd).lstat(),
              readlink=lambda name, dir_fd=None: links[entry(name, dir_fd)], path=NS(lexists=lambda p: Path(p).exists()),
              getuid=lambda: 0, getpid=lambda: 12, getppid=lambda: 11, fsencode=os.fsencode,
              uname=lambda: NS(nodename=host["hostname"]), environ={"SSH_CONNECTION":"192.0.2.20 40000 192.0.2.10 22"})
modules = dict(os=guest_os, pathlib=NS(Path=Path), subprocess=NS(run=run), time=NS(time=lambda: 1000, monotonic_ns=lambda: 101))
with patch.dict(sys.modules, modules), patch.object(urllib.request, "urlopen", metadata), patch.object(sys, "argv", args[3:]):
    exec(compile(program, "<complete-unused-host>", "exec"), {"__name__": "__main__"})
