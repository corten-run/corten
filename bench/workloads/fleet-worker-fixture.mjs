// Synthetic worker only. No production controller, subprocess or provider.
import { parentPort, workerData } from "node:worker_threads";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reservation } from "./cloud-contract.mjs";

const { args, cancellation, controls, slot, uncertain = false, holdExit = false } = workerData;
const shared = new Int32Array(controls), cancel = new Int32Array(cancellation);
// Block a real worker event loop until the test releases it. A second worker
// must be able to enter while this one is blocked, unlike spawnSync fan-out.
Atomics.add(shared, 0, 1); Atomics.store(shared, 3 + slot, 1);
while (Atomics.load(shared, 1) === 0 && Atomics.load(cancel, 0) === 0) Atomics.wait(shared, 1, 0, 20);
if (Atomics.load(cancel, 0)) {
  Atomics.add(shared, 2, 1);
  parentPort.postMessage({ schema: "benchmark-group-fleet-worker-result/v1", error: "group-operation-failed", uncertain });
} else {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const fleet = JSON.parse(readFileSync(value("--fleet"))), group = value("--group"), job = fleet.jobs.find((j) => j.group === group);
  const local = join(value("--state-dir"), `groups-${fleet.round}`); mkdirSync(local, { recursive: true });
  const state = { ...reservation({ round: fleet.round, commit: fleet.commit, token: job.token, group, fleet }),
    provider: fleet.provider, fullGroupQualified: false, status: "running", createIntentAt: new Date().toISOString(),
    id: String(slot + 1), ip: `192.0.2.${slot + 1}` };
  writeFileSync(join(local, "state.json"), JSON.stringify(state));
  parentPort.postMessage({ schema: "benchmark-group-fleet-worker-result/v1", code: 3 });
}
Atomics.store(shared, 3 + slot, 2);
if (holdExit) while (Atomics.load(shared, 1) !== 2) Atomics.wait(shared, 1, 1, 20);
parentPort.close();
