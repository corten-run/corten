// Synthetic parent startup control. Only the injected clean child consumes a fake
// credential and constructs native HTTPS to its own closing loopback socket.
import childProcess, { fork } from "node:child_process";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
let parentConsumes = 0, parentRequests = 0;
childProcess.spawnSync = () => { parentConsumes++; throw new Error("synthetic parent consumption forbidden"); };
https.request = () => { parentRequests++; throw new Error("synthetic parent HTTPS forbidden"); };
syncBuiltinESMExports();
if (mode === "clear-before-import") delete process.env.NODE_DEBUG;
if (mode.endsWith("clear-options-before-import")) delete process.env.NODE_OPTIONS;
const provider = await import("./cloud-provider.mjs");
if (mode === "clear-after-import") delete process.env.NODE_DEBUG;
if (mode === "enable-before-consume") process.env.NODE_DEBUG = "https";
const scratch = mkdtempSync(join(tmpdir(), "cloud-diagnostic-test-")), output = join(scratch, "observation.json");
let ipcToken = false, cleanLaunch = false, refused = false, observation;
const run = provider.providerTransport({ repo: resolve("."), launch(worker, args, options) {
  cleanLaunch = worker === realpathSync(process.execPath) && args.length === 3 && args[0] === "--input-type=module" && args[1] === "-"
    && args[2].endsWith("cloud-provider-worker.mjs") && options.execArgv.length === 0
    && options.stdio[0] === "pipe" && options.stdio[1] === "ignore" && options.stdio[2] === "ignore"
    && !Object.keys(options.env).some((name) => /^(?:NODE_|SSL|OPENSSL|LD_|DYLD_)/i.test(name));
  const child = fork(fileURLToPath(new URL("cloud-provider-test-worker.mjs", import.meta.url)), [mode, output], options);
  child.on("message", (value) => { ipcToken ||= JSON.stringify(value).includes("SYNTHETIC_ONLY_DIAGNOSTIC_CREDENTIAL"); });
  return child;
} });
try {
  if (mode.startsWith("direct-")) refused = !Object.hasOwn(provider, "restRequest");
  else {
    try { await run(["account", "get", "--output", "json", "--context", "synthetic-diagnostic-context"], 1000); } catch {}
  }
} finally {
  try { await run.close(); } catch (error) { if (!error.controlTreeUncertain) throw error; }
  try { observation = JSON.parse(readFileSync(output, "utf8")); } catch { observation = { consumes: 0, requests: 0 }; }
  if (!mode.startsWith("direct-")) refused = observation.requests === 0;
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...observation, refused, ipcToken, cleanLaunch, parentConsumes, parentRequests }));
