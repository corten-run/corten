import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { dirname, basename } from "node:path";

export const launchOptions = Object.freeze({ headless: true, args: Object.freeze(["--renderer-process-limit=1"]) });

export async function launchBrowser(chromium) {
  const server = await chromium.launchServer({ ...launchOptions, args: [...launchOptions.args] });
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    return { browser, process: server.process(), close: () => server.close() };
  } catch (error) { await server.close(); throw error; }
}

export async function browserIdentity(evidence, launched) {
  const child = launched.process;
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null,
    "browser-process-not-live");
  const requestedExecutable = child.spawnfile, executablePath = await realpath(requestedExecutable);
  // On Linux read the kernel's actual process image, not the registry's default
  // full-Chromium path (headless launch normally selects headless-shell).
  if (process.platform === "linux") assert.equal(await realpath(`/proc/${child.pid}/exe`), executablePath, "browser-process-image-differs");
  return { version: launched.browser.version(), requestedExecutable, executablePath,
    executable: await evidence.file(dirname(executablePath), basename(executablePath), 512 * 1024 ** 2),
    launch: { method: "launchServer", ...launchOptions, pid: child.pid } };
}
