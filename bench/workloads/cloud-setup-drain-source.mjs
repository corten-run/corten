// Fixed pre-entry drain proof for a bootstrap watcher that failed before its receipt.
// The failed-setup query runs it after the guardian source, in the guardian's namespace,
// and only when the preserved archive holds a watch-failure record. It mirrors
// setup_query and adds no write, signal, kill or provider call. It never writes a receipt.
export default String.raw`

SETTLED_EVENTS = r"populated 0\n(?:frozen [01]\n)?"
DRAINED_RECORDS = ("request", "start", "launcher", "registration", "result", "watch-failure")
DOCKER_SOCKETS = ("/run/docker.sock", "/run/containerd/containerd.sock")
DOCKER_RUNTIME = "Docker or containerd present"


def kernel_thread(row):
    # PF_KTHREAD (stat field 9) under kthreadd in the root cgroup. Userspace cannot become one.
    fields = row["stat"].rsplit(") ", 1)[1].split()
    return (int(fields[6]) & 0x00200000) != 0 and int(fields[1]) == 2 and row["cgroup"] == "0::/\n"


def docker_runtime(rows):
    # bootstrap_stage=docker-install leaves dockerd and containerd running, and a bootstrap
    # poll can fail its watcher after that, so they predate the fence. The proof cannot see
    # work a daemon holds for a session, so either socket path, or a dockerd, containerd or
    # containerd shim process (by its kernel command name), refuses.
    sockets = {path: pathlib.Path(path).exists() or pathlib.Path(path).is_symlink() for path in DOCKER_SOCKETS}
    assert not any(sockets.values()), DOCKER_RUNTIME
    for row in rows.values():
        name = row["stat"].split(" (", 1)[1].rsplit(") ", 1)[0]
        assert name not in ("dockerd", "containerd") and not name.startswith("containerd-"), DOCKER_RUNTIME
    return sockets


def setup_drained_session(root, request, failure):
    invocation = request_valid(request)
    identifier = invocation["id"]
    assert sorted(failure) == ["code", "failureSha256", "id"] and failure["id"] == identifier, "drain expectation differs"
    assert type(failure["code"]) is int and 0 <= failure["code"] <= 255
    assert re.fullmatch(r"[a-f0-9]{64}", failure["failureSha256"])
    assert sha(read(root / ("watch-failure-" + identifier + ".json"))) == failure["failureSha256"], "watcher failure differs from the archive"
    assert not (root / ("receipt-" + identifier + ".json")).exists(), "failed watcher has a receipt"
    result = load(root, "result-" + identifier + ".json")
    assert sorted(result) == ["code", "completedMonoNs", "releasedMonoNs", "transport"], "command result differs from the ledger"
    assert result["transport"] == "exited" and result["code"] == failure["code"], "command result differs from the ledger"
    start = load(root, "start-" + identifier + ".json")
    unit = "corten-bench-control-" + invocation["token"] + "-" + identifier + ".service"
    assert start["unit"] == unit and load(root, "launcher-" + identifier + ".json") == {"unit": unit, "code": 0}
    registration = load(root, "registration-" + identifier + ".json")
    assert registration["invocation"] == invocation, "failed session registration differs"
    assert registration["host"] == host(), "failed session boot differs"
    assert time.monotonic_ns() >= int(start["deadlineMonoNs"]), "watcher window still open"
    properties = ["Id", "LoadState", "ActiveState", "MainPID", "ControlPID", "Job"]
    shown = subprocess.run(["/usr/bin/systemctl", "show", unit] + ["--property=" + p for p in properties],
                           check=True, capture_output=True, timeout=5)
    assert len(shown.stdout) < 4096
    values = dict(line.split("=", 1) for line in shown.stdout.decode().splitlines())
    assert sorted(values) == sorted(properties) and values["Id"] == unit
    assert ((values["LoadState"], values["ActiveState"]) in (("loaded", "failed"), ("not-found", "inactive"))
            and values["MainPID"] == "0" and values["ControlPID"] == "0" and values["Job"] == ""), "watcher unit still active or queued"
    observer = registration["observer"]
    try:
        assert key(proc(observer["pid"])) != key(observer), "watcher process remains"
    except (FileNotFoundError, ProcessLookupError):
        pass
    cgroup = pathlib.Path("/sys/fs/cgroup/system.slice/" + unit)
    events = (cgroup / "cgroup.events").read_text() if cgroup.exists() else None
    assert events is None or re.fullmatch(SETTLED_EVENTS, events), "watcher cgroup populated"
    rows = inventory()
    session = registration["session"]
    scoped = scope_read(session["scope"], rows)
    assert not scoped["members"] and (not scoped["exists"] or re.fullmatch(SETTLED_EVENTS, scoped["events"])), "session scope populated"
    chain_keys, chain_pids = {key(p) for p in session["chain"]}, {p["pid"] for p in session["chain"]}
    for row in rows.values():
        assert key(row) not in chain_keys, "session process remains"
        assert parent(row) not in chain_pids, "session descendant remains"
    return {"id": identifier, "failureSha256": failure["failureSha256"], "result": result, "start": start, "launcher": load(root, "launcher-" + identifier + ".json"),
            "registration": registration, "watcher": values, "cgroupEvents": events, "scope": scoped}


def setup_drain_query(root, expected):
    # setup_query, except that each expected failed watcher gets setup_drained_session
    # instead of its missing receipt. Every other check and the order stay the same.
    failures = expected["watcherFailures"]
    assert isinstance(failures, list) and 0 < len(failures) <= len(expected["requests"])
    failed = {failure["id"]: failure for failure in failures}
    assert len(failed) == len(failures)
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
    receipts, watchers, drained = [], [], []
    allowed_names = {"helper.py", "binding.json", "mutex"}
    for sequence, request in enumerate(requests + [current]):
        assert request["sequence"] == sequence and request["epoch"] in ("bootstrap", "collection") and "seal" not in request
        invocation = request_valid(request)
        assert all(invocation[k] == expected["binding"][k] for k in ("round", "commit", "token"))
        assert request["helperSha256"] == expected["binding"]["helperSha256"]
        failure = failed.pop(invocation["id"], None)
        assert failure is None or (sequence < len(requests) and request["epoch"] == "bootstrap"), "drain expectation differs"
        names = ("request", "start", "launcher", "registration") + (() if sequence == len(requests)
                                                                    else ("result", "watch-failure") if failure else ("result", "receipt"))
        allowed_names.update(name + "-" + invocation["id"] + ".json" for name in names)
        if failure:
            receipts.append(None)
            watchers.append(None)
            drained.append(setup_drained_session(root, request, failure))
        elif sequence < len(requests):
            receipt = load(root, "receipt-" + invocation["id"] + ".json")
            assert receipt["invocation"] == invocation and receipt["host"] == host()
            terminal = watcher_terminal(root, invocation["id"], receipt)
            assert terminal is not None, "earlier query watcher unresolved"
            receipts.append(receipt)
            watchers.append(terminal)
    assert not failed, "drain expectation differs"
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
    # A failed session's process can leave both its scope and its parent (systemd-run --scope,
    # then reparenting to PID 1), so neither cgroup nor parentage finds it. Every process outside
    # the live query's own set must have started before the earliest failed session's first
    # process. Later unrelated processes refuse too; that is accepted. The live query's SSH
    # listener is exempt below, so it must be the listener (PID and start time) that served
    # every failed session, which therefore predates it.
    for entry in drained:
        assert key(entry["registration"]["listener"]) == key(registration["listener"]), "listener differs from a failed session"
    fence = min(int(p["startTicks"]) for entry in drained for p in entry["registration"]["session"]["chain"])
    for row in rows.values():
        if row["pid"] not in allowed and not kernel_thread(row):
            assert int(row["startTicks"]) < fence, "process started during or after a failed session"
    sockets = docker_runtime(rows)
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
    assert {name + "-" + failure["id"] + ".json" for failure in failures for name in DRAINED_RECORDS} <= {p["name"] for p in copied}, "failed watcher record missing from custody"
    observed = time.monotonic_ns()
    assert observed < int(start["deadlineMonoNs"])
    proof = {"schema": "benchmark-control-setup-query/v2", "binding": expected["binding"], "requests": requests + [current],
             "receipts": receipts, "watchers": watchers, "drained": drained, "registration": registration, "start": start, "launcher": launcher,
             "watcher": values, "query": identity(query), "timeout": identity(timeout), "executables": executables,
             "observation": {**host(), "monoNs": str(observed), "processes": sorted(rows.values(), key=lambda p: p["pid"])},
             "entries": entries, "custody": copied, "dockerSockets": sockets}
    assert len(encoded(proof)) <= LIMIT
    return proof
`;
