// The controller process never consumes credentials or constructs provider HTTPS.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { controlEnvironment } from "./cloud-transport.mjs";
import { catalogClosureDetails, erroredCreate, pendingCreate, providerDiagnostic, unsentCreate, unsentDelete } from "./cloud-options.mjs";
import { fleetCatalogCommand, providerCreateHost } from "./cloud-contract.mjs";

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
export function providerTransport({ repo, interrupted = () => false, launch = spawn, createMode = null } = {}) {
  assert.equal(resolve(repo), repo);
  const host = providerCreateHost(createMode);
  const env = controlEnvironment("doctl");
  let child, pending, sequence = 0, closed = false, failed = false, exited = false, exitPromise, drainPromise, closing;
  let diagnostic, terminal, mutationStarted = false;
  const inBudget = (slot) => {
    const current = Date.now(), valid = current >= slot.last && current < slot.deadline;
    slot.last = current; return valid;
  };
  const uncertain = () => Object.assign(new Error("provider worker uncertain; preserve locks/state/evidence/host"),
    { controlTreeUncertain: true, controlUncertain: true }, diagnostic ? { providerDiagnostic: { ...diagnostic } } : {});
  const fail = () => { failed = true; if (pending) { const { reject } = pending; pending = undefined; reject(uncertain()); } };
  const start = async () => {
    const current = snapshot();
    assert.deepEqual(current.sources, installed, "provider source changed after load");
    const nonce = randomBytes(16).toString("hex");
    // Node evaluates the bytes just hashed, never a second read of the mutable
    // entry path. The fixed path argument only anchors the verified import root.
    const owned = child = launch(realpathSync(process.execPath), ["--input-type=module", "-", worker], { cwd: repo, env: { ...env }, execArgv: [],
      serialization: "json", windowsHide: true, stdio: ["pipe", "ignore", "ignore", "ipc"] });
    exitPromise = new Promise((resolve) => owned.once("exit", (code, signal) => {
      exited = true;
      if (terminal ? code !== 0 || signal !== null || !inBudget(terminal) || interrupted() : !closing) fail();
      resolve();
    }));
    drainPromise = new Promise((resolve) => owned.once("disconnect", () => {
      if (terminal ? owned.connected !== false || owned.channel !== null || !inBudget(terminal) || interrupted() : !closing) fail();
      resolve();
    }));
    owned.on("error", fail); owned.stdin.on("error", fail);
    owned.on("internalMessage", () => { if (terminal) fail(); });
    owned.on("message", (message) => {
      if (terminal) { fail(); return; } // A terminal proof is the only and last reply.
      if (pending?.sequence === -1) {
        if (!keys(message, ["schema"]) || message.schema !== "cloud-provider-boot/v1") { fail(); return; }
        const slot = pending; pending = undefined; slot.resolve(); return;
      }
      const accountFailure = message?.schema === "cloud-provider-account-failed/v2";
      const catalogFailure = message?.schema === "cloud-provider-catalog-failed/v1";
      if (accountFailure || catalogFailure) {
        if (!(accountFailure ? pending?.account : pending?.catalog && pending.allowFail && host && createMode !== "legacy" && !mutationStarted)
          || pending.sequence <= 0 || failed || interrupted()
          || !keys(message, ["schema", "nonce", "sequence", "disposition", "diagnostic"])
          || message.nonce !== nonce || message.sequence !== pending.sequence || message.disposition !== "resources-closed"
          || !inBudget(pending)) { fail(); return; }
        const value = providerDiagnostic(message.diagnostic);
        if (!(accountFailure ? ["account-request", "account-http"].includes(value?.code)
          : value?.code === "catalog-request" && catalogClosureDetails.includes(value.detail))) { fail(); return; }
        const slot = pending; pending = undefined; diagnostic = value;
        const error = Object.assign(new Error(accountFailure ? "provider account observation failed; operation not accepted"
          : "fleet catalog request failed; operation not accepted"), { providerDiagnostic: { ...value } });
        terminal = { error, last: slot.last, deadline: slot.deadline }; closed = true;
        slot.reject(error); return;
      }
      // Only an unsettled, permitted create may name the IDs its accepted POST returned.
      const posted = Object.hasOwn(message ?? {}, "pendingCreate") ? pendingCreate(message.pendingCreate) : undefined;
      if (!pending || !(keys(message, ["schema", "sequence", "nonce", "ok", "result"])
          || posted && message.ok === false && pending.create && pending.allowFail && keys(message, ["schema", "sequence", "nonce", "ok", "result", "pendingCreate"]))
        || message.schema !== "cloud-provider-result/v1"
        || message.sequence !== pending.sequence || message.nonce !== nonce || typeof message.ok !== "boolean") { fail(); return; }
      const slot = pending; pending = undefined;
      if (!message.ok) {
        const value = providerDiagnostic(message.result);
        if (message.result !== null && !value) { fail(); slot.reject(uncertain()); return; }
        diagnostic ??= value; failed = true; slot.reject(Object.assign(uncertain(), posted ? { pendingCreate: posted } : {})); return;
      }
      const value = message.result;
      const permittedDiagnostic = value?.status === 1 ? providerDiagnostic(value.providerDiagnostic) : undefined;
      // Only a permitted create failure may carry output: the exact errored action/droplet IDs.
      const errored = permittedDiagnostic?.code === "create-action-errored" && slot.create && slot.allowFail ? erroredCreate(value) : undefined;
      if (slot.sequence === 0) {
        if (value !== "ready") { fail(); slot.reject(uncertain()); } else slot.resolve();
      } else if (slot.fencedDelete && slot.allowFail && keys(value, ["status", "stdout", "stderr", "deleteNotDispatched"])
        && value.status === 1 && value.stdout === "" && value.stderr === "" && value.deleteNotDispatched === true) {
        slot.resolve(value);
      } else if (!(keys(value, ["status", "stdout", "stderr"])
        || permittedDiagnostic && keys(value, ["status", "stdout", "stderr", "providerDiagnostic"])
          && (errored || value.stdout === "" && permittedDiagnostic.code !== "create-action-errored")) || ![0, 1].includes(value.status)
        || value.status === 1 && (!slot.allowFail || slot.get && !(permittedDiagnostic?.code === "get-http" && permittedDiagnostic.httpStatus === 404)
          || slot.catalog && !["catalog-http", "catalog-response"].includes(permittedDiagnostic?.code))
        || typeof value.stdout !== "string" || Buffer.byteLength(value.stdout) > 16 * 1024 ** 2 || value.stderr !== "") {
        fail(); slot.reject(uncertain());
      } else slot.resolve(value);
    });
    const boot = new Promise((resolve, reject) => { pending = { sequence: -1, resolve, reject }; });
    child.stdin.end(current.bootstrap);
    await bounded(boot, 10000);
    const ready = new Promise((resolve, reject) => { pending = { sequence: 0, resolve, reject }; });
    child.send({ schema: "cloud-provider-init/v2", nonce, sources: installed, createMode }, (error) => { if (error) fail(); });
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
    if (closing) {
      await closing;
      if (terminal && interrupted()) failed = true;
      if (failed) throw uncertain();
      return;
    }
    closed = true;
    closing = (async () => {
      if (!child) return;
      if (pending) fail();
      try { if (child.connected && !terminal) child.send({ schema: "cloud-provider-close/v1" }); } catch { failed = true; }
      const wait = async (completion, ms) => { let timer; try { return await Promise.race([completion.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); } finally { clearTimeout(timer); } };
      // Exit can precede the IPC EOF. Keep checking messages until the owned
      // child's disconnect event confirms they drained, without initiating disconnect.
      const completion = terminal ? Promise.all([exitPromise, drainPromise]) : exitPromise;
      if (!await wait(completion, terminal ? Math.max(0, Math.min(1000, terminal.deadline - Date.now())) : 1000)) {
        failed = true;
        if (!exited) { child.kill("SIGKILL"); if (!await wait(exitPromise, 1000)) throw uncertain(); }
      }
      if (terminal && (interrupted() || !inBudget(terminal))) failed = true;
      if (failed) throw uncertain();
    })();
    return closing;
  }
  const run = async (args, timeout = 60000, allowFail = false, deleteProofExpiresAtMs) => {
    if (closed || failed) throw uncertain();
    const creating = allowFail && args?.[0] === "compute" && args[1] === "droplet" && args[2] === "create";
    if (interrupted()) {
      if (creating && !pending) return unsentCreate;
      if (allowFail && args?.[2] === "delete" && deleteProofExpiresAtMs !== undefined && !pending) return unsentDelete;
      throw uncertain();
    }
    assert.ok(!pending, "provider action already pending");
    assert.ok(Array.isArray(args) && args.length <= 20 && args.every((value) => typeof value === "string" && value.length <= 512 && !value.includes("\0")));
    assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900000 && typeof allowFail === "boolean");
    if (deleteProofExpiresAtMs !== undefined) assert.ok(args[2] === "delete" && Number.isSafeInteger(deleteProofExpiresAtMs) && deleteProofExpiresAtMs > 0);
    try {
      if (!child) await start();
      if (failed || closed) throw uncertain();
      if (interrupted()) {
        if (creating && !pending) return unsentCreate;
        throw uncertain();
      }
      const id = ++sequence;
      const scoped = args.at(-2) === "--context" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(args.at(-1));
      const command = JSON.stringify(args.slice(0, -2));
      const account = scoped && command === JSON.stringify(["account", "get", "--output", "json"]);
      const catalog = scoped && command === JSON.stringify(fleetCatalogCommand);
      const started = Date.now();
      const result = new Promise((resolve, reject) => { pending = { sequence: id, resolve, reject, allowFail, get: args[2] === "get", create: args[2] === "create", account, catalog,
        fencedDelete: args[2] === "delete" && deleteProofExpiresAtMs !== undefined, last: started, deadline: started + timeout }; });
      if (args[2] === "create" || args[2] === "delete") mutationStarted = true;
      child.send({ schema: "cloud-provider-action/v1", sequence: id, args, timeout, allowFail,
        ...(deleteProofExpiresAtMs === undefined ? {} : { deleteProofExpiresAtMs }) }, (error) => { if (error) fail(); });
      return await bounded(result, timeout + 1000);
    } catch (error) {
      // Teardown keeps the posted create's IDs with whichever uncertainty is reported.
      const posted = pendingCreate(error?.pendingCreate), attach = (value) => posted ? Object.assign(value, { pendingCreate: posted }) : value;
      try { await close(); } catch (closeError) { throw attach(closeError); }
      if (terminal?.error === error && !failed && !interrupted()) throw error;
      throw attach(uncertain());
    }
  };
  run.close = close;
  return run;
}
