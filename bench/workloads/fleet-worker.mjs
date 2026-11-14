// Fixed production entry. JSON cannot select an executable, module or function.
import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { parseProductionArgs, productionMain } from "./cloud-production.mjs";

try {
  assert.deepEqual(Object.keys(workerData).sort(), ["args", "cancellation"]);
  assert.ok(workerData.cancellation instanceof SharedArrayBuffer && workerData.cancellation.byteLength === 4);
  assert.ok(Array.isArray(workerData.args) && workerData.args.length <= 24 && workerData.args.every((arg) => typeof arg === "string" && arg.length <= 4096));
  const { options, approval, preview } = parseProductionArgs(workerData.args);
  assert.ok(approval && !preview && !options.deliverAudit);
  assert.ok(options.collect || options.detach && options.group && options.fleet);
  const cancelled = new Int32Array(workerData.cancellation);
  // productionMain's finally confirms credential-worker settlement. Its result
  // alone is insufficient: the parent also waits for this worker's clean exit.
  const code = await productionMain(workerData.args, { interrupted: () => Atomics.load(cancelled, 0) !== 0, write: () => {} });
  assert.ok([0, 1, 3].includes(code));
  parentPort.postMessage({ schema: "benchmark-group-fleet-worker-result/v1", code });
} catch (error) {
  parentPort.postMessage({ schema: "benchmark-group-fleet-worker-result/v1", error: "group-operation-failed",
    uncertain: error?.controlTreeUncertain === true || error?.controlUncertain === true });
}
parentPort.close();
