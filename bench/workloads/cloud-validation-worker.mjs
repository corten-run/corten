import { parentPort, workerData } from "node:worker_threads";

try {
  const native = await import("./isolated/campaign-verify.mjs");
  if (typeof native.validateCampaign !== "function") throw new Error("validator unavailable");
  const report = await native.validateCampaign(Object.freeze(workerData));
  parentPort.postMessage({ ok: true, report });
} catch { parentPort.postMessage({ ok: false }); }
