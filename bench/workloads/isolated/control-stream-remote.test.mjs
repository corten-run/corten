import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { guardianSource } from "../cloud-control-runtime.mjs";
import { binding, registration } from "../test-fixtures/control-stream-fixture.mjs";
import { streamHash, verifyStreamDrain } from "./control-stream.mjs";
import { superviseControlStream } from "./control-stream-remote.mjs";
import { digest } from "./evidence.mjs";

async function fixture(t, { survivor = false, autoExit = true, beforeReady = false, probe } = {}) {
  const root = mkdtempSync(join(tmpdir(), "corten-control-lease-")), abort = new AbortController();
  let at = 2000000n, probes = 0, supervisor;
  const put = (name, value) => writeFileSync(join(root, name), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  const get = (name) => JSON.parse(readFileSync(join(root, name)));
  const lease = () => put("stream-lease.json", { id: registration.id, host: registration.host, expiresMonoNs: String(at + 15000000000n), observedMonoNs: String(at), renewal: 1 });
  const drain = () => ({ schema: "benchmark-control-stream-drain/v1", id: registration.id, host: registration.host,
    registrationSha256: streamHash(registration), monoNs: String(at), identitiesAbsent: true, listener: registration.listener,
    scopes: [{ path: "/user.slice/session-1.scope", exists: true, events: "populated 0\nfrozen 0\n", members: [] }] });
  put("stream-registration.json", registration); lease();
  const launches = [], child = new EventEmitter(); let samples = 0;
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.stdin.once("finish", () => { if (autoExit) setImmediate(() => child.emit("close", 0, null)); });
  const log = join(root, "run.log"), faultFd = fs.openSync(log, "ax", 0o600);
  const lastFault = async () => {
    for (let i = 0; i < 100; i++) {
      const bytes = readFileSync(log, "utf8");
      if (bytes.endsWith("\n")) return JSON.parse(bytes.trimEnd().split("\n").at(-1).slice("control fault: ".length));
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail("no fault diagnostic");
  };
  const runtime = { root, faultFd, now: () => at, launch(...args) {
      launches.push(args); if (!beforeReady) setImmediate(() => child.stdout.write("R")); return child;
    }, sample: () => { samples++; return { host: registration.host, members: structuredClone(registration.members), listener: structuredClone(registration.listener), monoNs: String(at) }; },
    sleep: async () => {
      at += 100000000n; lease();
      if (get("stream-state.json").kind === "seal" && !existsSync(join(root, "stream-sealed.json"))) {
        const bytes = JSON.stringify({ sequence: 1, monoNs: String(at), registrationSha256: streamHash(registration) }) + "\n";
        put("stream-observations.jsonl", bytes); put("stream-sealed.json", { monoNs: String(at), lease: get("stream-lease.json"), observationsSha256: digest(bytes) });
      }
    }, probe: probe ?? (() => (++probes < 2 || survivor ? { status: 3 } : { status: 0, stdout: JSON.stringify(drain()) })) };
  const pending = superviseControlStream(binding, { apparatus: registration }, abort, runtime);
  t.after(async () => { try { await supervisor?.dispose(); if (abort.signal.aborted) await lastFault(); }
    finally { fs.closeSync(faultFd); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))); rmSync(root, { recursive: true }); } });
  if (beforeReady) return { child, abort, pending, launches };
  supervisor = await pending;
  return { root, abort, supervisor, put, get, lastFault, lease, drain, runtime, launches, child, samples: () => samples, tick: (ns) => { at += ns; }, probes: () => probes };
}

test("a first-scan watchdog fault aborts now but can report to the job log before exit", async (t) => {
  const f = await fixture(t, { beforeReady: true });
  assert.equal(f.launches[0][2].stdio[2], "inherit");
  const kill = t.mock.fn(); f.child.kill = kill;
  let settled = false;
  const rejected = assert.rejects(f.pending, /pinned control watchdog failed/).then(() => { settled = true; });
  try {
    f.child.stdout.write("F");
    assert.ok(f.abort.signal.aborted);
    f.child.stdout.write("R"); // A subsequent ready byte cannot reopen admission.
    await new Promise(setImmediate);
    assert.equal(kill.mock.callCount(), 0); assert.equal(settled, false);
  } finally { f.child.emit("close", 254, null); await rejected; }
  assert.equal(kill.mock.callCount(), 0);
});

test("a wedged first-fault reporter is killed at the original startup deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { beforeReady: true });
  const kill = t.mock.fn(); f.child.kill = kill;
  let settled = false;
  const rejected = assert.rejects(f.pending, /control watchdog deadline expired/).then(() => { settled = true; });
  try {
    t.mock.timers.tick(2500); f.child.stdout.write("F");
    assert.ok(f.abort.signal.aborted);
    t.mock.timers.tick(2499); await new Promise(setImmediate);
    assert.equal(kill.mock.callCount(), 0); assert.equal(settled, false);
    t.mock.timers.tick(1); await new Promise(setImmediate);
    assert.deepEqual(kill.mock.calls.map((call) => call.arguments), [["SIGKILL"]]);
    assert.equal(settled, true); // Startup rejects without waiting for child close.
  } finally { f.child.emit("close", 254, null); t.mock.timers.reset(); await rejected; }
});

test("only the independent watchdog is launched on CPU0; native-window ticks never scan in the campaign parent", async (t) => {
  const f = await fixture(t);
  assert.equal(f.launches.length, 1);
  const [exe, args, opts] = f.launches[0];
  assert.equal(exe, "/usr/bin/taskset"); assert.deepEqual(args.slice(0, 4), ["--cpu-list", "0", "/usr/bin/python3", "-I"]);
  assert.equal(opts.shell, false);
  f.supervisor.open({ app: "1", api: "2-3", load: "4-7" });
  const samples = f.samples(); await new Promise((r) => setTimeout(r, 350));
  assert.equal(f.samples(), samples);
  f.child.emit("close", 1, null);
  assert.equal(f.abort.signal.aborted, true); assert.throws(() => f.supervisor.close(), /revoked/);
  assert.equal((await f.lastFault()).reason, "watchdog exit");
});

test("a normal process name truncated mid-character by Linux still has a readable identity",
  { skip: process.platform !== "linux" || !existsSync("/sys/fs/cgroup/cgroup.controllers") }, () => {
    const program = `import os, pathlib, sys
ns = {'__name__':'fixture'}
exec(compile(sys.stdin.read(), '<guardian>', 'exec'), ns)
pathlib.Path('/proc/self/comm').write_bytes(('catalog-worker' + chr(233)).encode('utf-8'))
assert pathlib.Path('/proc/self/comm').read_bytes().rstrip(b'\\n') == b'catalog-worker\\xc3'
row = ns['proc'](os.getpid())
assert row['pid'] == os.getpid() and int(row['startTicks']) > 0 and ns['parent'](row) == os.getppid()
# Exercise the real thread stat/status readers without changing the runner's CPU mask.
import re
read_task = ns['task_text']
def on_control_cpu(path):
    value = read_task(path)
    return re.sub(r'^Cpus_allowed_list:[^\\n]+', 'Cpus_allowed_list: 0', value, flags=re.M) if path.name == 'status' else value
ns['task_text'] = on_control_cpu
member = ns['stream_member'](os.getpid())
assert member['threads'] == [{'pid': row['pid'], 'startTicks': row['startTicks'], 'cpus': '0'}]
`;
    const result = spawnSync("python3", ["-I", "-c", program], { input: guardianSource, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  });

test("fixed watchdog rechecks its own affinity before every scan and rejects stale samples or an orphaned pipe", () => {
  // Execute the shipped loop with a synthetic clock, kernel and pipe; no host operations.
  const program = `import json, sys, types
ns = {'__name__':'fixture'}
source = sys.stdin.read()
exec(compile(source, '<guardian>', 'exec'), ns)
r = {'id':'stream','host':{},'createdMonoNs':'0','deadlineMonoNs':str(10**12)}
class Root:
    def __truediv__(self, name): return self
    def exists(self): return False
for mode in ('normal','wrong-at-start','drift','stale','eof','late-stop'):
    scans, ready, faults = [], [], []
    clock = [1000000000]
    def poll(*args):
        clock[0] += 3000000000 if mode == 'late-stop' else 250000000
        return ([0] if len(scans) == 2 or mode == 'late-stop' else [], [], [])
    sys.modules['select'] = types.SimpleNamespace(select=poll)
    def revoke(root): assert ready[-1] == b'F' and not faults
    ns.update(stream_revoke=revoke, os=types.SimpleNamespace(sched_getaffinity=lambda tid: {1} if mode == 'wrong-at-start' or mode == 'drift' and scans else {0},
        write=lambda fd, b: (ready.append(b) if fd == 1 else faults.append(json.loads(b.removeprefix(b'control fault: ')))) or len(b), read=lambda *args: b'' if mode == 'eof' else b'S'),
        load=lambda *args: r, stream_sample=lambda *args: scans.append(True), time=types.SimpleNamespace(monotonic_ns=lambda: clock[0]),
        stream_load=lambda *args: {'id':'stream','host':{},'renewal':1,'expiresMonoNs':str(clock[0]+15000000000),
                                   'observedMonoNs':str(clock[0] - (2000000001 if mode == 'stale' else 0))})
    try: ns['stream_watchdog'](Root(),ns['sha'](ns['encoded'](r)[:-1]))
    except AssertionError:
        line = {'wrong-at-start':'sched_getaffinity', 'drift':'sched_getaffinity', 'stale':'observedMonoNs',
                'eof':'os.read(0, 2)', 'late-stop':'monotonic_ns() - previous'}[mode]
        assert len(faults) == 1 and faults[0]['reason'] == 'pinned watchdog'
        assert set(faults[0]) == {'id','host','monoNs','reason','helperLine'}
        assert line in source.splitlines()[faults[0]['helperLine'] - 1]
    else: assert mode == 'normal' and len(scans) == 2 and ready == [b'R'] and not faults
    if mode == 'wrong-at-start': assert scans == [] and ready == [b'F']
    if mode == 'drift': assert len(scans) == 1
`;
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-c", program],
    { input: guardianSource, encoding: "utf8", timeout: 5000, maxBuffer: 65536, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
});

test("independent consumer supervises native windows, paused audit, immutable seal and actual drain probe", async (t) => {
  const f = await fixture(t), s = f.supervisor;
  s.progress({ state: "active" }); assert.equal(f.get("stream-state.json").kind, "progress");
  s.open({ app: "1", api: "2", load: "3-7" }); s.close();
  s.progress({ state: "blocked-review-needed", campaign: "r21-0123456789abcdef", auditGroup: "json-api", auditSubjectSha256: "e".repeat(64) });
  assert.equal(f.get("stream-state.json").kind, "audit-ready");
  const proof = await s.seal(); assert.equal(proof.schema, "benchmark-control-stream-seal/v1");
  assert.throws(() => s.open({ app: "1", api: "2", load: "3-7" }));
  const drained = await s.finish({ id: registration.id, nativeTerminal: true, sealSha256: digest(JSON.stringify(proof)) });
  assert.deepEqual(drained, f.drain());
  assert.equal(f.probes(), 2); assert.equal(verifyStreamDrain(binding, registration, drained).remoteDrained, true); assert.equal(f.abort.signal.aborted, false);
});

test("expired or stale guardian lease irrevocably cancels native independently of local EOF", async (t) => {
  const f = await fixture(t); f.tick(16000000000n); assert.throws(() => f.supervisor.check());
  assert.equal(f.abort.signal.aborted, true); assert.ok(existsSync(join(f.root, "stream-invalid.json")));
  f.lease(); assert.throws(() => f.supervisor.check(), /revoked/);
  assert.equal((await f.lastFault()).reason, "campaign lease expiry");
  assert.equal(readFileSync(join(f.root, "stream-invalid.json")).length, 0);
});

test("a pinned watchdog winning at publication preserves its first failure", async (t) => {
  const f = await fixture(t), first = { id: registration.id, host: registration.host, monoNs: "2000000", reason: "pinned watchdog", helperLine: 23 };
  const open = fs.openSync;
  let collisions = 0;
  const raced = t.mock.method(fs, "openSync", (path, flags, ...args) => {
    if (path === join(f.root, "stream-invalid.json") && flags === "wx") {
      assert.equal(existsSync(path), false);
      f.put("stream-invalid.json", first); collisions++;
    }
    return open(path, flags, ...args);
  });
  syncBuiltinESMExports();
  try { f.child.emit("close", 254, null); }
  finally { raced.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(collisions, 1);
  assert.ok(f.abort.signal.aborted); assert.deepEqual(f.get("stream-invalid.json"), first);
});

test("custody stays identical across a paused or interrupted Linux fault writer",
  { skip: process.platform !== "linux" }, () => {
  const program = `import os, pathlib, sys, tempfile, types
ns = {'__name__':'fixture'}
exec(compile(sys.stdin.read(), '<guardian>', 'exec'), ns)
for mode in ('resume', 'exit'):
  with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp) / 'live'; root.mkdir(mode=0o700)
    archive = root.parent / 'control'
    ns['pathlib'] = types.SimpleNamespace(Path=lambda path: archive if str(path) == '/bench/control' else pathlib.Path(path))
    opened = os.open
    try:
        ready, signal_ready = os.pipe()
        resume, signal_resume = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(ready); os.close(signal_resume)
            def at_open(path, *args, **kw):
                fd = opened(path, *args, **kw)
                if path == root / 'stream-invalid.json':
                    os.write(signal_ready, b'R')
                    if os.read(resume, 1) != b'S' or mode == 'exit': os._exit(7)
                return fd
            os.open = at_open
            try: ns['stream_revoke'](root)
            except BaseException: os._exit(8)
            os._exit(0)
        os.close(signal_ready); os.close(resume)
        try:
            assert os.read(ready, 1) == b'R'
            ns['custody'](root)
            os.write(signal_resume, b'S')
        finally:
            os.close(ready); os.close(signal_resume)
            status = os.waitstatus_to_exitcode(os.waitpid(child, 0)[1])
        assert status == (0 if mode == 'resume' else 7)
        try: ns['stream_revoke'](root)
        except FileExistsError: pass
        else: raise AssertionError('existing marker replaced')
        marker = root / 'stream-invalid.json'
        ns['custody'](root)
        assert list(root.iterdir()) == [marker] and ns['read'](archive / marker.name) == ns['read'](marker) == b''
    finally: os.open = opened
`;
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-c", program],
    { input: guardianSource, encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
});

test("campaign marker I/O failure still aborts and settles the child exit", async (t) => {
  const f = await fixture(t);
  const failed = t.mock.method(fs, "fsyncSync", () => { throw new Error("test fsync"); });
  syncBuiltinESMExports();
  try { f.child.emit("close", 254, null); }
  finally { failed.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(f.abort.signal.aborted);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ["run.log", "stream-invalid.json", "stream-lease.json", "stream-registration.json"]);
  assert.equal((await f.lastFault()).reason, "watchdog exit");
  assert.equal(readFileSync(join(f.root, "stream-invalid.json")).length, 0);
  await f.supervisor.dispose();
});

test("a delayed diagnostic cannot hold the native abort or watchdog settlement", async (t) => {
  const f = await fixture(t), write = fs.write; let finish;
  const slow = t.mock.method(fs, "write", (...args) => {
    assert.ok(f.abort.signal.aborted); assert.ok(existsSync(join(f.root, "stream-invalid.json")));
    finish = () => write(...args);
  });
  syncBuiltinESMExports();
  try {
    f.child.stdout.write("F"); assert.ok(f.abort.signal.aborted);
    f.child.emit("close", 254, null); await f.supervisor.dispose(); assert.ok(finish);
  } finally { slow.mock.restore(); syncBuiltinESMExports(); finish?.(); }
  assert.equal((await f.lastFault()).reason, "pinned watchdog reported a fault");
});

test("local EOF and expired drain deadline cannot replace an actual terminal apparatus probe", async (t) => {
  const f = await fixture(t, { survivor: true }); await f.supervisor.seal();
  const changed = f.drain(); changed.identitiesAbsent = false;
  assert.throws(() => verifyStreamDrain(binding, registration, changed));
  await assert.rejects(f.supervisor.finish({ id: registration.id, nativeTerminal: true }));
  assert.equal(f.probes(), 100);
  assert.equal(f.abort.signal.aborted, true);
  assert.equal((await f.lastFault()).reason, "campaign drain deadline");
});

test("post-terminal drain logs only the failed check, never raw probe output", async (t) => {
  for (const [fault, reason] of [["invalid", "control invalid"], ["final-wait-abort", "control invalid"],
    ["throw", "probe start"], ["spawn", "probe start"], ["timeout", "probe deadline"], ["buffer", "probe output limit"],
    ["signal", "probe exit"], ["refused", "probe exit"], ["other-exit", "probe exit"],
    ["malformed", "invalid proof"], ["wrong-identity", "invalid proof"]]) await t.test(fault, async (t) => {
    const raw = "SYNTHETIC_PRIVATE_DETAIL";
    let calls = 0;
    const f = await fixture(t, { probe() {
      calls++;
      if (fault === "invalid") { f.put("stream-invalid.json", ""); return { status: 3 }; }
      if (fault === "final-wait-abort") {
        f.tick(9900000000n); queueMicrotask(() => f.abort.abort()); return { status: 3 };
      }
      if (fault === "throw") throw new Error(raw);
      const errorCode = { spawn: "ENOENT", timeout: "ETIMEDOUT", buffer: "ENOBUFS" }[fault];
      const signal = fault === "signal" ? raw : null;
      const status = errorCode || signal ? null : ({ refused: 254, "other-exit": 4 }[fault] ?? 0);
      return { status, error: errorCode && Object.assign(new Error(raw), { code: errorCode }), signal,
        stderr: raw, stdout: fault === "wrong-identity" ? JSON.stringify({ ...f.drain(), id: raw }) : raw };
    } });
    await f.supervisor.seal();
    await assert.rejects(f.supervisor.finish({ id: registration.id, nativeTerminal: true }), {
      name: "Error", message: "campaign drain " + reason,
    });
    assert.equal(calls, 1); assert.equal(f.abort.signal.aborted, true);
    assert.equal(f.get("stream-state.json").kind, "terminal");
    assert.equal((await f.lastFault()).reason, "campaign drain " + reason);
    assert.ok(!readFileSync(join(f.root, "run.log"), "utf8").includes(raw));
  });
});

test("terminal handoff requires actual clean exit of the pinned watchdog before the SSH drain probe", async (t) => {
  const f = await fixture(t, { autoExit: false }); await f.supervisor.seal();
  const pending = f.supervisor.finish({ id: registration.id, nativeTerminal: true });
  await new Promise(setImmediate); assert.equal(f.get("stream-state.json").kind, "seal"); assert.equal(f.probes(), 0);
  f.child.emit("close", null, "SIGTERM");
  await assert.rejects(pending, /did not exit cleanly/); assert.equal(f.abort.signal.aborted, true);
  assert.equal(f.get("stream-state.json").kind, "seal"); assert.equal(f.probes(), 0);
});
