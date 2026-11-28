import assert from "node:assert/strict";
import { open, realpath } from "node:fs/promises";
import { dirname, basename } from "node:path";

export const launchOptions = Object.freeze({ headless: true, args: Object.freeze(["--renderer-process-limit=1"]) });
export const executableBytes = Object.freeze({ node: 192 * 1024 ** 2, browser: 512 * 1024 ** 2 });

export async function captureExecutable(evidence, name, requestedExecutable, linuxImage) {
  const executablePath = await realpath(requestedExecutable);
  // Follow the kernel's executable link intentionally and keep its inode pinned
  // while the regular-file reader opens, checks and reads its own descriptor.
  const processImage = process.platform === "linux" && linuxImage !== undefined ? await open(linuxImage, "r") : undefined;
  try {
    if (processImage) assert.equal(await realpath(linuxImage), executablePath, `${name}-process-image-differs`);
    return { requestedExecutable, executablePath,
      executable: await evidence.file(dirname(executablePath), basename(executablePath), executableBytes[name], processImage) };
  } finally { await processImage?.close(); }
}

export async function nodeIdentity(evidence) {
  return { version: process.version, ...await captureExecutable(evidence, "node", process.execPath, "/proc/self/exe") };
}

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
  // On Linux read the kernel's actual process image, not the registry's default
  // full-Chromium path (headless launch normally selects headless-shell).
  return { version: launched.browser.version(), ...await captureExecutable(evidence, "browser", child.spawnfile, `/proc/${child.pid}/exe`),
    launch: { method: "launchServer", ...launchOptions, pid: child.pid } };
}
