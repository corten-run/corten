// Fixed local native inspection. Never import validator code from evidence.
import { Worker } from "node:worker_threads";

export const validationLimit = 60000, validationStopLimit = 1000;
const failure = () => new Error("native campaign validation unavailable or invalid; evidence/host preserved");

function nativeInspection(input) {
  const worker = new Worker(new URL("./cloud-validation-worker.mjs", import.meta.url), {
    workerData: input, stdout: true, stderr: true,
  });
  // Native assertions/logs can contain private archive values. Never forward them.
  worker.stdout.resume(); worker.stderr.resume();
  const result = new Promise((resolve, reject) => {
    let message, failed = false;
    worker.once("message", (value) => { message = value; void worker.terminate().catch(() => {}); });
    worker.once("error", () => { failed = true; });
    worker.once("exit", () => {
      if (!failed && message?.ok === true) resolve(message.report);
      else reject(failure());
    });
  });
  return { result, stop: () => { void worker.terminate().catch(() => {}); }, unref: () => worker.unref() };
}

export function inspectCampaign(input, { inspect, interrupted = () => false, preserveLock = () => {} } = {}) {
  let task;
  try {
    if (interrupted()) return Promise.reject(failure());
    task = inspect === undefined ? nativeInspection(input) : { result: inspect(input) };
  } catch { return Promise.reject(failure()); }
  return new Promise((resolve, reject) => {
    let settled = false, stopping = false, finished = false, grace;
    const cleanup = () => { clearTimeout(deadline); clearInterval(cancellation); clearTimeout(grace); };
    const finishStop = () => {
      if (finished) return;
      finished = true;
      if (!settled) { preserveLock(); task.unref?.(); }
      cleanup(); reject(failure());
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (settled) { finishStop(); return; }
      if (task.stop) {
        // Only the native worker is killable. Wait for exit, but never indefinitely.
        task.stop(); grace = setTimeout(finishStop, validationStopLimit);
      } else finishStop();
    };
    const cancelled = () => { try { return interrupted(); } catch { return true; } };
    const deadline = setTimeout(stop, validationLimit);
    const cancellation = setInterval(() => { if (cancelled()) stop(); }, 25);
    Promise.resolve(task.result).then((report) => {
      settled = true;
      if (stopping) { finishStop(); return; }
      if (cancelled()) { stop(); return; }
      cleanup(); resolve(report);
    }, () => {
      settled = true;
      if (stopping) { finishStop(); return; }
      cleanup(); reject(failure());
    });
    if (cancelled()) stop();
  });
}
