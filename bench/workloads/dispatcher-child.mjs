// IPC is portable cancellation, not proof that a native runner supports cleanup.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, ...args] = process.argv.slice(2);
process.argv = [process.execPath, resolve(entry), ...args];
let cancelled = null, delivered = false, finished = false;
let release;
const start = new Promise((resolve) => { release = resolve; });
const status = () => cancelled === "SIGINT" ? 130 : 143;
const remember = (signal) => {
  cancelled ??= signal;
  if (!process.exitCode) process.exitCode = status();
};
const deliver = () => {
  if (!cancelled || delivered || finished || process.listenerCount(cancelled) <= 1) return;
  delivered = true;
  process.emit(cancelled);
};
const cancel = (signal) => { remember(signal); release(false); deliver(); };
// Foreground OS signals can arrive before the runner installs its own handler.
// Retain them, just like IPC cancellation, rather than letting Node terminate early.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  remember(signal);
  if (process.listenerCount(signal) > 1) delivered = true;
  release(false);
});
const registered = (event) => {
  if (event === "SIGINT" || event === "SIGTERM") queueMicrotask(deliver);
};
process.on("newListener", registered);
process.on("message", (message) => {
  if (message?.type === "start") release(true);
  else if (message?.type === "cancel" && ["SIGINT", "SIGTERM"].includes(message.signal)) cancel(message.signal);
});
process.on("disconnect", () => { if (!finished) cancel("SIGTERM"); });
process.send({ type: "ready" }, (error) => { if (error) cancel("SIGTERM"); });

const launch = await start;
// The IPC channel must not keep an otherwise finished CLI alive.
process.channel?.unref();
if (launch && !cancelled) {
  try { await import(pathToFileURL(process.argv[1]).href); }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
finished = true;
process.off("newListener", registered);
if (launch && cancelled && !delivered) console.error(`Native runner did not handle ${cancelled}; cooperative cleanup is unverified.`);
if (cancelled && !process.exitCode) process.exitCode = status();
