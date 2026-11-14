import { sha256, json } from "./evidence.mjs";
// Synthetic trusted-channel contract test ONLY. Not an OS observation or receipt.
export function hostFixture(replay) {
  const d = "a".repeat(64), context = { observerId: "observer", bootId: "synthetic-boot", unitPath: "/bench/unit", cpuSet: "0", cpuMax: "100000 100000", memoryMaxBytes: 1024 };
  const process = (pid, role) => { const fields = Array(19).fill("0"); fields[0] = "1"; fields[18] = String(pid * 10);
    const comm = role === "compiler" ? "rustc" : role === "node" ? "node" : "chrome";
    return { stat: `${pid} (${comm}) S ${fields.join(" ")}`, cgroup: "0::/bench/unit\n", comm, role,
      executableSha256: role === "compiler" ? d : replay.toolIdentities[role === "node" ? "node" : "browser"] }; };
  const sample = (at, roles) => { const processes = roles.map((role, i) => process(role === "compiler" ? 4 : i + 1, role)); return { at, processes,
    groups: [{ path: context.unitPath, procs: processes.map((p) => p.stat.split(" ")[0] + "\n").join(""), cpuSet: "0\n", cpuMax: "100000 100000\n",
      cpuExclusive: "0\n", cpuPartition: "isolated\n", memoryMax: "1024\n", memoryEvents: "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n" }] }; };
  const proof = { schema: "client-heavy-host-proof/v1", commit: replay.commit, round: replay.round, subjectSha256: replay.subjectSha256,
    filesSha256: sha256(json(replay.files)), bootId: context.bootId, unitPath: context.unitPath, observerId: context.observerId,
    coverageReceiptSha256: d, samples: [sample(replay.executionWindow.startedAt - 1, []), ...replay.processWindows.map((w) => sample((w.startedAt + w.endedAt) / 2,
      w.kind === "compiler" ? ["node", "compiler"] : ["node", "browser", "renderer"])), sample(replay.executionWindow.endedAt + 1, [])] };
  return { context, proof };
}
