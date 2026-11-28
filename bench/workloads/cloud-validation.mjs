// Fixed local native inspection. Never import validator code from evidence.
import { validationFailure as failure, validationTask } from "./cloud-validation-snapshot.mjs";

// One physical scan of a full catalog archive can take more than a minute.
// Bound the whole read-only replay separately from cancellation and shutdown.
export const validationLimit = 15 * 60_000, validationStopLimit = 1000;
const absentReplayLimit = 25 * 60_000;
export const collectRefusal = (stage) => Object.assign(failure(), { controllerStage: stage });

export function inspectCampaign(input, { inspect, start = validationTask, interrupted = () => false,
  preserveLock = () => {}, confirmedAbsent = false } = {}) {
  const limit = confirmedAbsent ? absentReplayLimit : validationLimit;
  const started = performance.now();
  const cancelled = () => { try { return interrupted(); } catch { return true; } };
  const interruption = "collect-native-replay-interrupted", timeout = "collect-native-replay-deadline";
  let task;
  if (cancelled()) return Promise.reject(collectRefusal(interruption));
  try {
    task = inspect === undefined ? start(input) : { result: inspect(input) };
  } catch { return Promise.reject(collectRefusal("collect-native-replay-start")); }
  return new Promise((resolve, reject) => {
    let settled = false, stopStage, finished = false, grace;
    const cleanup = () => { clearTimeout(deadline); clearInterval(cancellation); clearTimeout(grace); };
    const finishStop = () => {
      if (finished) return;
      finished = true;
      if (!settled) { preserveLock(); task.unref?.(); }
      cleanup(); reject(collectRefusal(stopStage));
    };
    const stop = (stage) => {
      if (stopStage) return;
      stopStage = stage;
      if (settled) { finishStop(); return; }
      if (task.stop) {
        // Only the native worker is killable. Wait for exit, but never indefinitely.
        task.stop(); grace = setTimeout(finishStop, validationStopLimit);
      } else finishStop();
    };
    const deadline = setTimeout(() => stop(timeout), Math.max(0, limit - (performance.now() - started)));
    const cancellation = setInterval(() => { if (cancelled()) stop(interruption); }, 25);
    const stopAfterSettlement = () => {
      if (stopStage) { finishStop(); return true; }
      if (cancelled()) { stop(interruption); return true; }
      if (performance.now() - started >= limit) { stop(timeout); return true; }
      return false;
    };
    Promise.resolve(task.result).then((report) => {
      settled = true;
      if (stopAfterSettlement()) return;
      cleanup(); resolve(report);
    }, () => {
      settled = true;
      if (stopAfterSettlement()) return;
      cleanup(); reject(collectRefusal("collect-native-replay-refused"));
    });
    if (cancelled()) stop(interruption);
  });
}
