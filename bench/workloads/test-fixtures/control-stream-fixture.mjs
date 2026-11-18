import { streamLimits } from "../isolated/control-stream.mjs";
export const binding = { round: "r21", commit: "a".repeat(40), token: "0123456789abcdef", helperSha256: "b".repeat(64) };
export const participant = (pid, parentPid, cgroup) => ({ pid, startTicks: String(pid + 100), parentPid, cgroup,
  executable: { device: "1", inode: String(pid) }, commandSha256: "c".repeat(64), cpus: "0",
  namespaces: { cgroup: "1", ipc: "2", mnt: "3", net: "4", pid: "5", user: "6", uts: "7" },
  threads: [{ pid, startTicks: String(pid + 100), cpus: "0" }] });
export const members = [participant(20, 10, "0::/system.slice/ssh.service\n"), participant(21, 20, "0::/user.slice/session-1.scope\n")];
export const registration = { schema: "benchmark-control-apparatus/v1", binding, id: "d".repeat(32),
  host: { hostname: "fixture", bootId: "01234567-89ab-cdef-0123-456789abcdef" }, members,
  listener: Object.fromEntries(Object.entries(participant(10, 1, "0::/system.slice/ssh.service\n")).filter(([key]) => key !== "commandSha256")),
  socket: { connection: "192.0.2.1 40000 192.0.2.2 22", byteOrder: "little", sessionPid: 20, listenerFds: ["100"], sessionFds: ["101"],
    listener: "0: 00000000:0016 00000000:0000 0A 0 0 0 0 0 100", session: "0: 020200C0:0016 010200C0:9C40 01 0 0 0 0 0 101" },
  createdMonoNs: "1000000", deadlineMonoNs: String(1000000n + BigInt(streamLimits.maximumMs) * 1000000n) };
