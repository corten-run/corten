// The controller process never consumes credentials or constructs provider HTTPS.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { controlEnvironment } from "./cloud-transport.mjs";
import { providerDiagnostic } from "./cloud-options.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const worker = join(directory, "cloud-provider-worker.mjs");
export const providerFiles = ["cloud-provider-worker.mjs", "cloud-provider-engine.mjs", "cloud-provider.mjs", "cloud-transport.mjs", "cloud-contract.mjs", "cloud-options.mjs",
  "../catalog/droplet-contract.mjs", "../catalog/contract.mjs", "../catalog/group.mjs", "../fullstack/passes.mjs", "../fullstack/inventory.mjs", "../marketplace/contract.mjs", "registry.mjs"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function snapshot() {
  let bootstrap;
  const sources = providerFiles.map((name) => {
    const path = join(directory, name), stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path, "provider source must be physical");
    const bytes = readFileSync(path);
    if (path === worker) bootstrap = bytes;
    return { name, sha256: hash(bytes) };
  });
  return { sources, bootstrap };
}
const installed = snapshot().sources;
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());

// Entry dependency injection is for local tests, not a CLI/path/URL option.
export function providerTransport({ repo, interrupted = () => false, launch = spawn } = {}) {
  assert.equal(resolve(repo), repo);
  const env = controlEnvironment("doctl");
  let child, pending, sequence = 0, closed = false, failed = false, exitPromise, closing;
  let diagnostic;
  const uncertain = () => Object.assign(new Error("provider worker uncertain; preserve locks/state/evidence/host"),
    { controlTreeUncertain: true, controlUncertain: true }, diagnostic ? { providerDiagnostic: { ...diagnostic } } : {});
  const fail = () => { failed = true; if (pending) { const { reject } = pending; pending = undefined; reject(uncertain()); } };
  const start = async () => {
    const current = snapshot();
    assert.deepEqual(current.sources, installed, "provider source changed after load");
    const nonce = randomBytes(16).toString("hex");
    // Node evaluates the bytes just hashed, never a second read of the mutable
    // entry path. The fixed path argument only anchors the verified import root.
    child = launch(realpathSync(process.execPath), ["--input-type=module", "-", worker], { cwd: repo, env: { ...env }, execArgv: [],
      serialization: "json", windowsHide: true, stdio: ["pipe", "ignore", "ignore", "ipc"] });
    exitPromise = new Promise((resolve) => child.once("exit", () => { if (!closing) fail(); resolve(); }));
    child.on("error", fail); child.stdin.on("error", fail); child.on("disconnect", () => { if (!closing) fail(); });
    child.on("message", (message) => {
      if (pending?.sequence === -1) {
        if (!keys(message, ["schema"]) || message.schema !== "cloud-provider-boot/v1") { fail(); return; }
        const slot = pending; pending = undefined; slot.resolve(); return;
      }
      if (!pending || !keys(message, ["schema", "sequence", "nonce", "ok", "result"]) || message.schema !== "cloud-provider-result/v1"
        || message.sequence !== pending.sequence || message.nonce !== nonce || typeof message.ok !== "boolean") { fail(); return; }
      const slot = pending; pending = undefined;
      if (!message.ok) {
        const value = providerDiagnostic(message.result);
        if (message.result !== null && !value) { fail(); slot.reject(uncertain()); return; }
        diagnostic ??= value; failed = true; slot.reject(uncertain()); return;
      }
      const value = message.result;
      const permittedDiagnostic = value?.status === 1 ? providerDiagnostic(value.providerDiagnostic) : undefined;
      if (slot.sequence === 0) {
        if (value !== "ready") { fail(); slot.reject(uncertain()); } else slot.resolve();
      } else if (!(keys(value, ["status", "stdout", "stderr"])
        || permittedDiagnostic && keys(value, ["status", "stdout", "stderr", "providerDiagnostic"]) && value.stdout === "") || ![0, 1].includes(value.status)
        || typeof value.stdout !== "string" || Buffer.byteLength(value.stdout) > 16 * 1024 ** 2 || value.stderr !== "") {
        fail(); slot.reject(uncertain());
      } else slot.resolve(value);
    });
    const boot = new Promise((resolve, reject) => { pending = { sequence: -1, resolve, reject }; });
    child.stdin.end(current.bootstrap);
    await bounded(boot, 10000);
    const ready = new Promise((resolve, reject) => { pending = { sequence: 0, resolve, reject }; });
    child.send({ schema: "cloud-provider-init/v1", nonce, sources: installed }, (error) => { if (error) fail(); });
    await bounded(ready, 10000);
  };
  async function bounded(promise, timeout) {
    let timer, cancellation;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        const stop = () => { fail(); reject(uncertain()); };
        timer = setTimeout(stop, timeout);
        cancellation = setInterval(() => { if (interrupted()) stop(); }, 25);
      })]);
    } finally { clearTimeout(timer); clearInterval(cancellation); }
  }
  async function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      if (!child) return;
      if (pending) fail();
      try { if (child.connected) child.send({ schema: "cloud-provider-close/v1" }); } catch { failed = true; }
      const wait = async (ms) => { let timer; try { return await Promise.race([exitPromise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); } finally { clearTimeout(timer); } };
      if (!await wait(1000)) { failed = true; child.kill("SIGKILL"); if (!await wait(1000)) throw uncertain(); }
      if (failed) throw uncertain();
    })();
    return closing;
  }
  const run = async (args, timeout = 60000, allowFail = false) => {
    if (closed || failed || interrupted()) throw uncertain();
    assert.ok(!pending, "provider action already pending");
    assert.ok(Array.isArray(args) && args.length <= 20 && args.every((value) => typeof value === "string" && value.length <= 512 && !value.includes("\0")));
    assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900000 && typeof allowFail === "boolean");
    try {
      if (!child) await start();
      if (failed || closed || interrupted()) throw uncertain();
      const id = ++sequence;
      const result = new Promise((resolve, reject) => { pending = { sequence: id, resolve, reject }; });
      child.send({ schema: "cloud-provider-action/v1", sequence: id, args, timeout, allowFail }, (error) => { if (error) fail(); });
      return await bounded(result, timeout + 1000);
    } catch { await close(); throw uncertain(); }
  };
  run.close = close;
  return run;
}
