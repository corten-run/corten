import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { mock, test } from "node:test";
import { remoteFiles, reservation } from "../cloud-contract.mjs";

let procFiles = null;
mock.module("node:child_process", { namedExports: { execFileSync(command, args) {
  assert.equal(command, "docker");
  assert.ok(args[0] === "ps" || args[0] === "network");
  return "";
} } });
mock.module("node:os", { defaultExport: { ...os, platform: () => "linux" } });
mock.module("node:fs", { namedExports: {
  readFileSync(path, encoding) {
    if (!procFiles) return fs.readFileSync(path, encoding);
    if (procFiles.has(path)) return procFiles.get(path);
    return "";
  },
  readdirSync(path) { return procFiles && path === "/proc" ? ["37329", "37463", "37422"] : fs.readdirSync(path); },
} });
const { observeHost, verifyHostBoundary } = await import("./host-observation.mjs");

const before = { bootId: "boot", hostname: "host", containers: [], networks: [], processes: [] };
// PID/start/flags from the retained read-only r21 diagnostic, not repaired historical evidence.
// Other fields form a synthetic /proc stat fixture; the Linux test below also reads real stat bytes.
function stat(pid = 37463, start = "112953", flags = "69238880", comm = "kworker/u17:2-events_unbound", parent = "2") {
  const fields = Array(49).fill("0");
  fields[0] = parent; fields[5] = flags; fields[18] = start;
  return `${pid} (${comm}) I ${fields.join(" ")}\n`;
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
  assert.ok(job.includes('test "$(systemctl show "$unit" --property=LoadState --value)" = masked'));
  assert.ok(job.includes('test "$(systemctl show "$unit" --property=ActiveState --value)" = inactive'));
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
  for (const [target, load, active, maskCode, accepted] of [["", "masked", "inactive", 0, true],
    ["", "masked", "inactive", 1, false],
    ...["fwupd.service", "fwupd-refresh.service", "fwupd-refresh.timer"].flatMap((unit) => [
      [unit, "loaded", "inactive", 0, false], [unit, "masked", "active", 0, false],
      [unit, "not-found", "inactive", 0, false], [unit, "masked", "failed", 0, false],
    ])]) {
    const script = `set -euo pipefail
systemctl() {
  if test "$1" = mask; then return ${maskCode}; fi
  test "$1" = show
  if test "$2" = '${target}'; then
    case "$3" in --property=LoadState) printf '%s\\n' '${load}';; --property=ActiveState) printf '%s\\n' '${active}';; *) return 2;; esac
  else
    case "$3" in --property=LoadState) printf '%s\\n' masked;; --property=ActiveState) printf '%s\\n' inactive;; *) return 2;; esac
  fi
}
${mask}
${check}
printf 'native-entry\\n'
`;
    const result = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 ** 2 });
    assert.equal(result.error, undefined);
    assert.equal(result.status === 0, accepted, `${target}:${load}:${active}:${maskCode}`);
    assert.equal(result.stdout.includes("native-entry"), accepted);
  }
});
