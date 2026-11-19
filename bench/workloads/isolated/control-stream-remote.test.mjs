import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { guardianSource } from "../cloud-control-runtime.mjs";
import { binding, registration } from "../test-fixtures/control-stream-fixture.mjs";
import { streamHash, verifyStreamDrain } from "./control-stream.mjs";
import { superviseControlStream } from "./control-stream-remote.mjs";
import { digest } from "./evidence.mjs";

async function fixture(t, { survivor = false, autoExit = true } = {}) {
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
  const runtime = { root, now: () => at, launch(...args) {
      launches.push(args); setImmediate(() => child.stdout.write("R")); return child;
    }, sample: () => { samples++; return { host: registration.host, members: structuredClone(registration.members), listener: structuredClone(registration.listener), monoNs: String(at) }; },
    sleep: async () => {
      at += 100000000n; lease();
      if (get("stream-state.json").kind === "seal" && !existsSync(join(root, "stream-sealed.json"))) {
        const bytes = JSON.stringify({ sequence: 1, monoNs: String(at), registrationSha256: streamHash(registration) }) + "\n";
        put("stream-observations.jsonl", bytes); put("stream-sealed.json", { monoNs: String(at), lease: get("stream-lease.json"), observationsSha256: digest(bytes) });
      }
    }, probe: () => (++probes < 2 || survivor ? { status: 3 } : { status: 0, stdout: JSON.stringify(drain()) }) };
  supervisor = await superviseControlStream(binding, { apparatus: registration }, abort, runtime);
  t.after(async () => { await supervisor.dispose(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))); rmSync(root, { recursive: true }); });
  return { root, abort, supervisor, put, get, lease, drain, runtime, launches, child, samples: () => samples, tick: (ns) => { at += ns; }, probes: () => probes };
}

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
  assert.equal(f.get("stream-invalid.json").reason, "watchdog exit");
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
    ns.update(write=lambda path, data: faults.append(json.loads(data)), os=types.SimpleNamespace(sched_getaffinity=lambda tid: {1} if mode == 'wrong-at-start' or mode == 'drift' and scans else {0},
        write=lambda fd, b: ready.append(b) or len(b), read=lambda *args: b'' if mode == 'eof' else b'S'),
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
    if mode == 'wrong-at-start': assert scans == [] and not ready
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
  assert.equal(f.probes(), 2); assert.equal(verifyStreamDrain(binding, registration, drained).remoteDrained, true); assert.equal(f.abort.signal.aborted, false);
});

test("expired or stale guardian lease irrevocably cancels native independently of local EOF", async (t) => {
  const f = await fixture(t); f.tick(16000000000n); assert.throws(() => f.supervisor.check());
  assert.equal(f.abort.signal.aborted, true); assert.ok(existsSync(join(f.root, "stream-invalid.json")));
  f.lease(); assert.throws(() => f.supervisor.check(), /revoked/);
  assert.equal(f.get("stream-invalid.json").reason, "campaign lease expiry");
  assert.equal(f.get("stream-invalid.json").remoteDrained, undefined);
});

test("child exit preserves the pinned watchdog's first failure", async (t) => {
  const f = await fixture(t), first = { id: registration.id, host: registration.host, monoNs: "2000000", reason: "pinned watchdog", helperLine: 23 };
  f.put("stream-invalid.json", first); f.child.emit("close", 254, null);
  assert.ok(f.abort.signal.aborted); assert.deepEqual(f.get("stream-invalid.json"), first);
});

test("local EOF and expired drain deadline cannot replace an actual terminal apparatus probe", async (t) => {
  const f = await fixture(t, { survivor: true }); await f.supervisor.seal();
  const changed = f.drain(); changed.identitiesAbsent = false;
  assert.throws(() => verifyStreamDrain(binding, registration, changed));
  await assert.rejects(f.supervisor.finish({ id: registration.id, nativeTerminal: true }));
  assert.ok(f.probes() <= 100);
  assert.equal(f.abort.signal.aborted, true);
});

test("terminal handoff requires actual clean exit of the pinned watchdog before the SSH drain probe", async (t) => {
  const f = await fixture(t, { autoExit: false }); await f.supervisor.seal();
  const pending = f.supervisor.finish({ id: registration.id, nativeTerminal: true });
  await new Promise(setImmediate); assert.equal(f.get("stream-state.json").kind, "seal"); assert.equal(f.probes(), 0);
  f.child.emit("close", null, "SIGTERM");
  await assert.rejects(pending, /did not exit cleanly/); assert.equal(f.abort.signal.aborted, true);
  assert.equal(f.get("stream-state.json").kind, "seal"); assert.equal(f.probes(), 0);
});
