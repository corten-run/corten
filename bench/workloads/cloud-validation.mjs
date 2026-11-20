// Fixed local native inspection. Never import validator code from evidence.
import { validationFailure as failure, validationTask } from "./cloud-validation-snapshot.mjs";

export const validationLimit = 60000, validationStopLimit = 1000;

export function inspectCampaign(input, { inspect, start = validationTask, interrupted = () => false, preserveLock = () => {} } = {}) {
  const started = performance.now();
  let task;
  try {
    if (interrupted()) return Promise.reject(failure());
    task = inspect === undefined ? start(input) : { result: inspect(input) };
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
    const deadline = setTimeout(stop, Math.max(0, validationLimit - (performance.now() - started)));
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
