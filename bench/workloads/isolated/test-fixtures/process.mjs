import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export function fakeChild(action = () => {}, { ready = true, killCloses = true } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { connected: true, stdout: new PassThrough(), stderr: new PassThrough(),
    send(message, callback) { callback?.(null); if (message.type === "start") queueMicrotask(() => action(child)); },
    disconnect() { child.connected = false; child.emit("disconnect"); }, unref() {},
    kill() { if (killCloses) queueMicrotask(() => close(0, "SIGKILL")); },
  });
  function close(code, signal = null) { child.emit("exit", code, signal); child.stdout.end(); child.stderr.end(); child.emit("close", code, signal); }
  child.close = close;
  if (ready) queueMicrotask(() => child.emit("message", { type: "ready" }));
  return child;
}
