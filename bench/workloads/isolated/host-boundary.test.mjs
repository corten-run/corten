import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import "../cloud-local.mjs"; // Keep physical evidence reads on the real filesystem.
import { remoteFiles, reservation } from "../cloud-contract.mjs";
import { groupNames, runnerFor } from "../registry.mjs";

let procFiles = null;
mock.module("node:child_process", { namedExports: { execFileSync(command, args) {
  if (command === "/usr/bin/getconf") { assert.deepEqual(args, ["CLK_TCK"]); return "100\n"; }
  assert.equal(command, "docker");
  assert.ok(args[0] === "ps" || args[0] === "network");
  return "";
} } });
mock.module("node:os", { defaultExport: { ...os, platform: () => "linux" } });
mock.module("node:fs", { namedExports: {
  readlinkSync(path) { return procFiles?.get(path)?.executable ?? fs.readlinkSync(path); },
  statSync(path, options) {
    const fixture = procFiles?.get(path);
    if (fixture?.metadata) { assert.deepEqual(options, { bigint: true }); return fixture.metadata; }
    return fs.statSync(path, options);
  },
  readFileSync(path, encoding) {
    if (!procFiles) return fs.readFileSync(path, encoding);
    if (procFiles.has(path)) {
      const value = procFiles.get(path);
      return typeof value === "function" ? value() : value;
    }
    return "";
  },
  readdirSync(path) { return procFiles && path === "/proc"
    ? [...procFiles.keys()].flatMap((k) => /^\/proc\/(\d+)\/stat$/.exec(k)?.slice(1) ?? []) : fs.readdirSync(path); },
} });
const { hostTerminalClock, liveWorkloadEndFile, liveWorkloadEndSchema, observeHost, readLiveWorkloadEnd, udevSettleCandidates,
  udevSettlePolicy, verifyHostBoundary, verifyLifetimeSettledBoundary, verifyLiveWorkloadWindows, verifySettledHostBoundary } =
  await import("./host-observation.mjs");
const { registration } = await import("../test-fixtures/control-stream-fixture.mjs");

const before = { bootId: "boot", hostname: "host", containers: [], networks: [], processes: [] };
// PID/start/flags from the retained read-only r21 diagnostic, not repaired historical evidence.
// Other fields form a synthetic /proc stat fixture; the Linux test below also reads real stat bytes.
function stat(pid = 37463, start = "112953", flags = "69238880", comm = "kworker/u17:2-events_unbound", parent = "2", state = "I") {
  const fields = Array(49).fill("0");
  fields[0] = parent; fields[5] = flags; fields[18] = start;
  return `${pid} (${comm}) ${state} ${fields.join(" ")}\n`;
}
const kernel = () => ({ pid: 37463, startTicks: "112953", cgroup: "0::/\n", stat: stat() });
const after = (...processes) => ({ ...structuredClone(before), processes });
const rejects = (value) => assert.throws(() => verifyHostBoundary(before, value), /new persistent host processes remain/);

test("new kernel threads require saved stat flags bound to the exact PID/start identity", () => {
  const observed = after(kernel());
  const original = structuredClone(observed);
  assert.equal(verifyHostBoundary(before, observed).cleanup, "observed-boundary-matched");
  assert.deepEqual(observed, original, "raw kernel PID inventory is retained");
  for (const proof of [stat(37464), stat(37463, "112954"), stat(37463, "112953", "4194560"),
    undefined, null, true, "", "not stat", stat().replace("69238880", "69238880junk"),
    stat().replace("69238880", "-2097152"), stat().replace("69238880", "4297064448"),
    stat().replace("69238880", "0x200000"), stat().replace("69238880", "2.097152e6"),
    stat().split(" ").slice(0, 10).join(" ")]) rejects(after({ ...kernel(), stat: proof, kernelThread: true }));
});

test("comm, parent PID, cgroup and a kernel boolean cannot excuse user processes", () => {
  for (const comm of ["kworker/5:2-rcu_gp", "kthreadd", "fwupd", "node", "worker ) ( name\n"])
    rejects(after({ ...kernel(), stat: stat(37463, "112953", "4194560", comm), kernelThread: true }));
  assert.equal(verifyHostBoundary(before, after({ ...kernel(), stat: stat(37463, "112953", "69238880", "ordinary", "1") })).cleanup,
    "observed-boundary-matched", "flags, not names or parentage, establish kernel ownership");
});

test("PID reuse and mixed new OS-daemon/application leaks remain fail-closed", () => {
  const daemon = { pid: 37422, startTicks: "88103", cgroup: "0::/system.slice/fwupd.service\n",
    stat: stat(37422, "88103", "4194560", "fwupd", "1") };
  const app = { pid: 37329, startTicks: "81541", cgroup: "0::/app\n", stat: stat(37329, "81541", "4194304", "node", "1") };
  for (const leaked of [[daemon], [app], [kernel(), daemon], [kernel(), app], [kernel(), daemon, app]]) rejects(after(...leaked));
  const previous = after({ ...kernel(), startTicks: "112952" });
  assert.throws(() => verifyHostBoundary(previous, after({ ...kernel(), stat: stat(37463, "112953", "4194304") })),
    /new persistent host processes remain/);
  assert.equal(verifyHostBoundary(previous, after(kernel())).cleanup, "observed-boundary-matched");
  rejects(after({ ...kernel(), stat: undefined })); // Original r21 inventories cannot acquire later proof.
});

test("kernel exemptions do not relax boot, host, container or network boundaries", () => {
  for (const change of [{ bootId: "other" }, { hostname: "other" }, { containers: ["leak"] }, { networks: ["leak"] }])
    assert.throws(() => verifyHostBoundary(before, { ...after(kernel()), ...change }));
});

function udevBoundaries(executable = "/usr/lib/systemd/systemd-udevd") {
  const cgroup = "0::/system.slice/systemd-udevd.service/udev\n";
  const udevExecutable = { path: executable, device: "2049", inode: "10" };
  const daemon = { pid: 846, startTicks: "812", stat: stat(846, "812", "4194560", "systemd-udevd", "1", "S"), cgroup, udevExecutable };
  const worker = { pid: 62274, startTicks: "209603", stat: stat(62274, "209603", "4194624", "(udev-worker)", "846", "S"), cgroup, udevExecutable };
  const apparatusPids = [...registration.members, registration.listener].map((p) => ({
    pid: p.pid, startTicks: p.startTicks, cgroup: p.cgroup, stat: stat(p.pid, p.startTicks, "4194304", "ordinary", String(p.parentPid)),
  }));
  const boundary = (uptime, monoNs, ...processes) => ({ ...after(...processes, ...apparatusPids), ...registration.host, uptime,
    controlApparatus: { registration, sample: { host: registration.host, monoNs, members: registration.members, listener: registration.listener } } });
  const terminal = { bootId: registration.host.bootId, uptime: "2096.02 10244.13\n", ticksPerSecond: 100, monoNs: "4000000" };
  return structuredClone({ baseline: boundary("236.30 1500.23\n", "2000000", daemon),
    first: { ...boundary("2100.71 10444.32\n", "5000000", daemon, worker), terminalClock: terminal },
    settled: boundary("2105.72 10494.00\n", "5015000000", daemon), terminal });
}

test("a proved sleeping post-terminal udev worker can settle; the first after stays strict and intact", () => {
  const { baseline, first, settled, terminal } = udevBoundaries(), keep = structuredClone(first);
  assert.throws(() => verifyHostBoundary(baseline, first), /new persistent host processes remain: 1/);
  assert.ok(udevSettleCandidates(baseline, first, terminal));
  assert.deepEqual(verifySettledHostBoundary(baseline, first, settled, terminal), {
    cleanup: "observed-boundary-matched", isolation: "unverified",
    settledUdevWorkers: [{ pid: 62274, startTicks: "209603" }],
  });
  assert.deepEqual(first, keep);
  assert.throws(() => verifySettledHostBoundary(baseline, first, settled, undefined), /terminal clock/);
});

test("an offline udev settle uses only its own bounded monotonic observations", () => {
  const { baseline, first, settled, terminal } = udevBoundaries();
  for (const observation of [baseline, first, settled]) {
    observation.offlineMonoNs = observation.controlApparatus.sample.monoNs;
    delete observation.controlApparatus;
  }
  assert.equal(udevSettleCandidates(baseline, first, terminal), null, "old replay cannot substitute offline clocks");
  assert.deepEqual(verifySettledHostBoundary(baseline, first, settled, terminal, "post-terminal", true).settledUdevWorkers,
    [{ pid: 62274, startTicks: "209603" }]);
  settled.offlineMonoNs = first.offlineMonoNs;
  assert.throws(() => verifySettledHostBoundary(baseline, first, settled, terminal, "post-terminal", true), /bounded monotonic interval/);
});

test("official timing selects the post-terminal proof for every registered group", () => {
  for (const group of groupNames) {
    assert.equal(udevSettlePolicy(group, "timing"), "post-terminal", group);
    assert.equal(udevSettlePolicy(group, "prepare"), group === "json-api" ? "preparation" : null, group);
  }
  assert.equal(udevSettlePolicy("unknown", "timing"), null);
  assert.equal(udevSettlePolicy("live-delivery", "other"), null);
});

test("without a live workload end only JSON preparation can settle a worker born before terminal", () => {
  const { baseline, first, settled, terminal } = udevBoundaries();
  const preparation = udevSettlePolicy("json-api", "prepare");
  const timing = udevSettlePolicy("live-delivery", "timing");
  assert.equal(timing, "post-terminal");
  const bornAt = (ticks) => Object.assign(first.processes[1], { startTicks: ticks,
    stat: stat(62274, ticks, "4194624", "(udev-worker)", "846", "S") });
  bornAt("209500");
  assert.equal(udevSettleCandidates(baseline, first, terminal, timing), null);
  assert.deepEqual(verifySettledHostBoundary(baseline, first, settled, terminal, preparation).settledUdevWorkers,
    [{ pid: 62274, startTicks: "209500" }]);
  assert.equal(udevSettleCandidates(baseline, first, undefined, preparation), null);
  bornAt("23630");
  assert.equal(udevSettleCandidates(baseline, first, terminal, preparation), null);
});

test("an early Live Delivery cohort requires the bound same-boot workload end and successful measured windows", (test) => {
  const folder = fs.mkdtempSync(join(os.tmpdir(), "corten-live-end-"));
  test.after(() => fs.rmSync(folder, { force: true, recursive: true }));
  const { baseline, first, settled, terminal } = udevBoundaries();
  baseline.uptime = "2080.00 10100.00\n";
  terminal.monoNs = "2096020000000";
  for (const [item, ns] of [[baseline, "2080000000000"], [first, "2100710000000"], [settled, "2105720000000"]]) {
    item.offlineMonoNs = ns;
    delete item.controlApparatus;
  }
  const worker = (pid, ticks) => ({ ...first.processes[1], pid, startTicks: ticks,
    stat: stat(pid, ticks, "4194624", "(udev-worker)", "846", "S") });
  first.processes.splice(1, 1, worker(62274, "209306"), worker(62275, "209308"));
  const round = "r111", commit = "a".repeat(40), { entry, selection } = runnerFor("live-delivery");
  const invocation = { executable: "node", argv: [entry, round, ...selection, "--build", "--isolated", "--profile", "native-feed", "--measure"] };
  const binding = { request: { group: "live-delivery", round, commit },
    execution: { invocation, effectiveOptions: { isolated: true, measure: true, build: true } } };
  const result = { terminal: true, success: true, code: 0, signal: null, cancelled: false, forced: false, error: null, pid: 3000 };
  const args = { binding, invocation, round, phase: "timing", result, folder };
  const clock = { bootId: terminal.bootId, uptime: "2093.05 10200.00\n", monoNs: "2093050000000" };
  const record = { schema: liveWorkloadEndSchema, pid: result.pid, round, commit, clock };
  const save = (data) => fs.writeFileSync(join(folder, liveWorkloadEndFile), JSON.stringify(data));
  const settledBoundary = (liveWorkloadEnd) => verifyLifetimeSettledBoundary({ binding, invocation, round, phase: "timing",
    lifetime: { status: "verified", cleanupComplete: true, terminalClock: terminal }, before: baseline, after: first, settled,
    offline: true, liveWorkloadEnd });
  const ends = [
    { ...clock, uptime: "2081.00 10110.00\n", monoNs: "2081000000000" },
    { ...clock, uptime: "2093.04 10199.00\n", monoNs: "2093040000000" },
  ];
  const replay = () => settledBoundary(() => {
    const end = readLiveWorkloadEnd(args);
    if (!end) return;
    verifyLiveWorkloadWindows(baseline, true, end, ends, 2);
    return end;
  });
  assert.throws(replay, /not eligible/, "historical evidence cannot establish an early cutoff");
  save({ ...record, schema: "benchmark-live-workload-end/v1" });
  assert.throws(replay, /differs from native invocation/, "mono-only actor evidence cannot use the early cutoff");
  save(record);
  assert.deepEqual(replay().settledUdevWorkers, [{ pid: 62274, startTicks: "209306" }, { pid: 62275, startTicks: "209308" }]);
  save({ ...record, clock: { ...clock, uptime: "2080.01 10100.00\n" } });
  assert.throws(replay, /measured actor window outside/, "an early uptime cannot borrow a later monotonic timestamp");
  for (const changed of [{ ...record, pid: 3001 }, { ...record, round: "r112" }, { ...record, commit: "b".repeat(40) }]) {
    save(changed);
    assert.throws(replay, /differs from native invocation/);
  }
  save({ ...record, clock: { ...clock, bootId: "different-boot" } });
  assert.throws(replay, /lacks its measured actor windows/);
  for (const changed of [{ monoNs: terminal.monoNs }, { uptime: terminal.uptime },
    { uptime: "2093.06 10244.13\n" }, { uptime: "2093.08 10244.13\n" }]) {
    save({ ...record, clock: { ...clock, ...changed } });
    assert.throws(replay, /not eligible/);
  }
  save(record);
  for (const invalid of [[ends[0]], [ends[0], { ...ends[1], monoNs: clock.monoNs }], [...ends].reverse(),
    [{ ...ends[0], monoNs: baseline.offlineMonoNs }, ends[1]], [ends[0], undefined], [ends[0], { ...ends[1], uptime: undefined }],
    [ends[0], { ...ends[1], bootId: "wrong" }], [ends[0], { ...ends[1], uptime: "2093.06 10199.00\n" }]]) {
    assert.throws(() => verifyLiveWorkloadWindows(baseline, true, clock, invalid, 2), /measured actor window/);
  }
  verifyLiveWorkloadWindows(baseline, true, clock, [ends[0], { ...ends[1], uptime: clock.uptime }], 2);
  for (const changed of [{ result: { ...result, success: false, code: 1 } }, { round: "r112" }, { phase: "prepare" },
    { invocation: { ...invocation, argv: [...invocation.argv, "--other"] } },
    { binding: { ...binding, request: { ...binding.request, group: "recoverable-live" } } },
    { binding: { ...binding, execution: { ...binding.execution, effectiveOptions: { isolated: true, measure: false, build: true } } } }]) {
    assert.equal(readLiveWorkloadEnd({ ...args, ...changed }), undefined);
  }
  settled.containers = ["not-empty"];
  assert.throws(replay, /container/);
  settled.containers = [];
  const earlier = worker(62276, "207999");
  baseline.processes.push(earlier); first.processes.push(earlier); settled.processes.push(earlier);
  assert.throws(replay, /not eligible/, "a worker already present in the baseline cannot be ignored");
});

test("a name, cgroup or executable alone never permits settling an unknown or possibly in-window task", () => {
  for (const change of [
    ({ first }) => { delete first.processes[1].udevExecutable; },
    ({ first }) => { first.processes[1].udevExecutable = { ...first.processes[1].udevExecutable, inode: "20" }; },
    ({ first }) => { first.processes[1].cgroup = "0::/system.slice/benchmark.service\n"; },
    ({ first }) => { first.processes[1].stat = stat(62274, "209603", "4194624", "(udev-worker)", "1", "S"); },
    ({ first }) => { first.processes[1].stat = stat(62274, "209603", "4194624", "(udev-worker)", "846", "R"); },
    ({ first }) => { first.processes.push({ pid: 777, startTicks: "209999", stat: stat(777, "209999", "4194304", "node", "1", "S"), cgroup: "0::/benchmark\n" }); },
    ({ terminal }) => { terminal.uptime = "2096.03 10244.13\n"; }, // Equal ticks do not establish ordering.
    ({ terminal }) => { terminal.uptime = "2096.04 10244.13\n"; },
    ({ terminal }) => { terminal.ticksPerSecond = 1000; },
    ({ terminal }) => { terminal.monoNs = "5000000"; },
    ({ baseline }) => { delete baseline.uptime; },
  ]) {
    const b = udevBoundaries(); change(b);
    assert.equal(udevSettleCandidates(b.baseline, b.first, b.terminal), null);
    assert.throws(() => verifySettledHostBoundary(b.baseline, b.first, b.settled, b.terminal), /not eligible/);
  }
  const { baseline, first, settled, terminal } = udevBoundaries();
  first.processes.push({ pid: 778, startTicks: "209999", stat: stat(778, "209999", "4194304", "sshd", "1", "S"),
    cgroup: "0::/user.slice/session-77.scope\n" });
  assert.throws(() => udevSettleCandidates(baseline, first, terminal), /undeclared SSH\/login/);
  assert.throws(() => verifySettledHostBoundary(baseline, first, settled, terminal), /undeclared SSH\/login/);
});

test("workers or replacements still present, other new work and boundary drift still fail after waiting", () => {
  for (const change of [
    ({ first, settled }) => { settled.processes.push(first.processes[1]); },
    ({ first, settled }) => { settled.processes.push({ ...first.processes[1], startTicks: "210100",
      stat: stat(62274, "210100", "4194624", "(udev-worker)", "846", "S") }); },
    ({ settled }) => { settled.processes.push({ pid: 777, startTicks: "210101", stat: stat(777, "210101", "4194304", "node", "1", "S"), cgroup: "0::/benchmark\n" }); },
    ({ settled }) => { settled.processes = []; },
    ({ settled }) => { settled.containers = ["leak"]; },
    ({ first }) => { first.networks = ["leak"]; },
    ({ settled }) => { settled.bootId = "rebooted"; },
    ({ settled }) => { settled.uptime = "2105.69 10494.00\n"; },
    ({ settled }) => { settled.uptime = "2110.72 10494.00\n"; },
    ({ settled }) => { settled.controlApparatus.sample.monoNs = "5000001"; },
    ({ settled }) => { settled.controlApparatus.sample.monoNs = "10005000001"; },
  ]) {
    const b = udevBoundaries(); change(b);
    assert.throws(() => verifySettledHostBoundary(b.baseline, b.first, b.settled, b.terminal));
  }
});

test("predeclared CPU0 apparatus remains in the raw host boundary; unknown login participants never become baseline", () => {
  const sample = { host: structuredClone(registration.host), monoNs: registration.createdMonoNs,
    members: structuredClone(registration.members), listener: structuredClone(registration.listener) };
  const observation = { ...registration.host, containers: [], networks: [],
    processes: [...registration.members, registration.listener].map((p) => ({ pid: p.pid, startTicks: p.startTicks, cgroup: p.cgroup,
      stat: stat(p.pid, p.startTicks, "4194304", "ordinary", String(p.parentPid)) })),
    controlApparatus: { registration, sample } };
  assert.doesNotThrow(() => verifyHostBoundary(observation, structuredClone(observation)));
  for (const change of [
    (o) => { o.controlApparatus.sample.listener.cpus = "1"; },
    (o) => { o.controlApparatus.sample.members[0].namespaces.net = "999"; },
    (o) => { o.processes.push({ pid: 999, startTicks: "999", cgroup: "0::/user.slice/user-0.slice/user@0.service\n", stat: stat(999, "999", "4194304", "anything", "1") }); },
    (o) => { o.processes.push({ pid: 999, startTicks: "999", cgroup: "0::/system.slice/other.service\n", stat: stat(999, "999", "4194304", "anything", "20") }); },
  ]) {
    const changed = structuredClone(observation); change(changed);
    assert.throws(() => verifyHostBoundary(changed, structuredClone(changed)), "late baseline cannot absorb altered or unknown apparatus");
  }
});

test("large process leaks produce a bounded diagnostic, not an assertion inventory dump", () => {
  const processes = Array.from({ length: 1000 }, (_, i) => ({ pid: i + 1, startTicks: "10", cgroup: "x".repeat(1000) }));
  let failure;
  try { verifyHostBoundary(before, after(...processes)); } catch (error) { failure = error; }
  assert.ok(failure?.message.startsWith("new persistent host processes remain"));
  assert.ok(failure.message.length < 512, "diagnostic must not dump raw inventories");
  assert.ok(failure.message.includes("1000"));
});

test("collector retains every raw PID/stat and takes startTicks from that same read", () => {
  procFiles = new Map([
    ["/proc/37329/stat", stat(37329, "81541", "4194304", "node", "1")],
    ["/proc/37463/stat", stat()], ["/proc/37422/stat", stat(37422, "88103", "4194560", "fwupd", "1")],
    ["/proc/37329/cgroup", "0::/application\n"], ["/proc/37463/cgroup", "0::/\n"],
    ["/proc/37422/cgroup", "0::/system.slice/fwupd.service\n"],
  ]);
  try {
    const observed = observeHost();
    assert.deepEqual(observed.processes.map((p) => p.pid), [37329, 37422, 37463]);
    for (const p of observed.processes) assert.equal(p.stat, procFiles.get(`/proc/${p.pid}/stat`));
    assert.equal(observed.processes[2].startTicks, "112953");
    rejects({ ...before, processes: observed.processes });
  } finally { procFiles = null; }
});

test("udev collector retains executable evidence only bound to the same PID and cgroup readback", () => {
  const { first, terminal } = udevBoundaries();
  const [daemon, worker] = first.processes;
  procFiles = new Map([
    ["/proc/uptime", terminal.uptime], ["/proc/sys/kernel/random/boot_id", terminal.bootId + "\n"],
    ...[daemon, worker].flatMap((p) => [[`/proc/${p.pid}/stat`, p.stat], [`/proc/${p.pid}/cgroup`, p.cgroup],
      [`/proc/${p.pid}/exe`, { executable: p.udevExecutable.path, metadata: { dev: 2049n, ino: 10n } }]]),
  ]);
  try {
    const { monoNs, ...captured } = hostTerminalClock();
    const { monoNs: _fixtureTime, ...expected } = terminal;
    assert.match(monoNs, /^\d+$/);
    assert.deepEqual(captured, expected);
    assert.equal(observeHost().processes[1].udevExecutable, undefined);
    assert.deepEqual(observeHost(undefined, true).processes, [daemon, worker]);
    let reads = 0;
    procFiles.set("/proc/62274/stat", () => reads++ ? worker.stat.replace("209603", "209613") : worker.stat);
    assert.deepEqual(observeHost(undefined, true).processes[1], {
      pid: worker.pid, startTicks: worker.startTicks, cgroup: worker.cgroup, stat: worker.stat,
    });
  } finally { procFiles = null; }
});

test("udevadm-backed daemon and workers can settle only with matching executable evidence", () => {
  const { baseline, first, settled, terminal } = udevBoundaries("/usr/bin/udevadm");
  const [daemon, worker] = first.processes;
  procFiles = new Map([daemon, worker].flatMap((p) => [
    [`/proc/${p.pid}/stat`, p.stat], [`/proc/${p.pid}/cgroup`, p.cgroup],
    [`/proc/${p.pid}/exe`, { executable: p.udevExecutable.path, metadata: { dev: 2049n, ino: 10n } }],
  ]));
  try {
    const captured = observeHost(undefined, true).processes;
    assert.deepEqual(captured, [daemon, worker]);
    const saved = { ...first, processes: [...captured, ...first.processes.slice(2)] };
    assert.throws(() => verifyHostBoundary(baseline, saved), /new persistent host processes remain: 1/);
    assert.deepEqual(verifySettledHostBoundary(baseline, saved, settled, terminal).settledUdevWorkers,
      [{ pid: worker.pid, startTicks: worker.startTicks }]);
    for (const [executable, ino] of [["/tmp/udevadm", 10n], ["/usr/bin/udevadm", 11n]]) {
      procFiles.set(`/proc/${worker.pid}/exe`, { executable, metadata: { dev: 2049n, ino } });
      const replay = { ...first, processes: [...observeHost(undefined, true).processes, ...first.processes.slice(2)] };
      assert.equal(udevSettleCandidates(baseline, replay, terminal), null);
    }
  } finally { procFiles = null; }
});

test("real Linux process stat cannot be excused by a malicious kernel-like comm", {
  skip: process.platform !== "linux" && "requires actual Linux /proc metadata",
}, () => {
  const saved = process.title;
  try {
    process.title = "kworker/5:2";
    const raw = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
    assert.match(raw, /^\d+ \(kworker\/5:2\) /);
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    assert.equal(BigInt(fields[6]) & 0x00200000n, 0n);
    const user = { pid: process.pid, startTicks: fields[19], stat: raw, cgroup: fs.readFileSync(`/proc/${process.pid}/cgroup`, "utf8") };
    rejects(after(user));
    assert.equal(verifyHostBoundary(after(user), after(user)).cleanup, "observed-boundary-matched");
    // Docker probes alone are mocked: every observed stat here comes from the actual procfs.
    const observed = observeHost();
    assert.ok(observed.processes.some((p) => p.pid === process.pid && p.startTicks === user.startTicks && p.stat));
    let kernels = 0;
    for (const p of observed.processes) {
      assert.equal(typeof p.stat, "string");
      const flags = p.stat.slice(p.stat.lastIndexOf(")") + 2).split(" ")[6];
      if (BigInt(flags) & 0x00200000n) {
        assert.equal(verifyHostBoundary(before, after(p)).cleanup, "observed-boundary-matched"); kernels++;
      } else rejects(after(p));
    }
    console.log(`Actual procfs boundary control: ${observed.processes.length} records, ${kernels} kernel threads visible`);
  } finally { process.title = saved; }
});

test("fresh bootstrap masks firmware activation before provisioning and checks quiescence before entry", () => {
  const state = reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" });
  const job = remoteFiles(state)["job.sh"];
  const mask = job.indexOf("systemctl mask --runtime --now fwupd.service fwupd-refresh.service fwupd-refresh.timer");
  assert.ok(mask > job.indexOf("cloud-init status --wait") && mask < job.indexOf("apt-get update"));
  const check = job.indexOf('for unit in fwupd.service fwupd-refresh.service fwupd-refresh.timer; do');
  assert.ok(check > job.indexOf("rustc --version") && check < job.indexOf("node bench/workloads/isolated/campaign-entry.mjs"));
  assert.ok(job.includes('load_state=$(systemctl show "$unit" --property=LoadState --value)\n  test "$load_state" = masked'));
  assert.ok(job.includes('active_state=$(systemctl show "$unit" --property=ActiveState --value)\n  test "$active_state" = inactive'));
  assert.ok(!job.split("\n").find((line) => line.startsWith("systemctl mask")).includes("|| true"));
});

test("fresh-host mask failure or reactivation aborts the shell before native entry", {
  skip: process.platform !== "linux" && "requires the Linux bootstrap shell",
}, () => {
  const state = reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" });
  const job = remoteFiles(state)["job.sh"];
  const mask = job.split("\n").find((line) => line.startsWith("systemctl mask"));
  const start = job.indexOf("for unit in fwupd.service "), end = job.indexOf("\ndone", start);
  assert.ok(start >= 0 && end > start);
  const check = job.slice(start, end + "\ndone".length);
  for (const [target, load, active, maskCode, accepted, failedProperty = ""] of [["", "masked", "inactive", 0, true],
    ["", "masked", "inactive", 1, false],
    ...["fwupd.service", "fwupd-refresh.service", "fwupd-refresh.timer"].flatMap((unit) => [
      [unit, "loaded", "inactive", 0, false], [unit, "masked", "active", 0, false],
      [unit, "not-found", "inactive", 0, false], [unit, "masked", "failed", 0, false],
      [unit, "masked", "inactive", 0, false, "LoadState"],
      [unit, "masked", "inactive", 0, false, "ActiveState"],
      ...(unit.endsWith(".service") ? [[unit, "masked", "inactive", 0, false, "MainPID"]] : []),
    ])]) {
    const script = `set -euo pipefail
systemctl() {
  if test "$1" = mask; then return ${maskCode}; fi
  test "$1" = show
  if test "$2" = '${target}'; then
    case "$3" in --property=LoadState) printf '%s\\n' '${load}';; --property=ActiveState) printf '%s\\n' '${active}';; --property=MainPID) printf '%s\\n' 0;; *) return 2;; esac
    if test "$3" = '--property=${failedProperty}'; then return 1; fi
  else
    case "$3" in --property=LoadState) printf '%s\\n' masked;; --property=ActiveState) printf '%s\\n' inactive;; --property=MainPID) printf '%s\\n' 0;; *) return 2;; esac
  fi
}
${mask}
${check}
printf 'native-entry\\n'
`;
    const result = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 ** 2 });
    assert.equal(result.error, undefined);
    assert.equal(result.status === 0, accepted, `${target}:${load}:${active}:${maskCode}:${failedProperty}`);
    assert.equal(result.stdout.includes("native-entry"), accepted);
  }
});
