// Local subprocess fixture only. No provider/SSH executable or network is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountId, context, commit, campaign, harness, subject, syntheticDelivery, syntheticProviderRequest } from "./cloud-fixtures.mjs";
import { productionMain, productionSignals } from "./cloud-production.mjs";
import { createProviderEngine } from "./cloud-provider-engine.mjs";
import { controlRegistration } from "./cloud-control-runtime.mjs";
import { digest } from "./cloud-local.mjs";

const scenario = process.argv[2], cleanup = [], h = harness({ after(fn) { cleanup.push(fn); } });
const signals = productionSignals();
let signalCommand, afterSignal = 0, starts = 0, delivered = 0;
const externalEffect = () => { if (signalCommand) afterSignal++; };
const fakeCommand = (binary, argv, options) => {
  if (binary === "git" && argv[0] === "show")
    return { status: 0, stdout: readFileSync(resolve(argv[1].slice(41)), "utf8").replaceAll("\r\n", "\n") };
  let args = [...argv];
  if (binary === "doctl" && args.includes("--http-retry-max")) args.splice(args.indexOf("--http-retry-max"));
  const remote = binary === "ssh" || binary === "sftp";
  const state = remote ? h.saved() : undefined;
  const request = state?.control?.ledger.at(-1)?.request;
  let script = "";
  if (binary === "ssh") {
    const control = request && controlRegistration(request);
    const prefix = control?.inputPrefix ?? "";
    assert.equal(argv.at(-1), control?.command ?? "/bin/bash -s");
    assert.ok(options.input.startsWith(prefix));
    const payload = options.input.slice(prefix.length);
    assert.ok(payload.startsWith("set -euo pipefail\n") && payload.endsWith("\n"));
    if (request) assert.equal(digest(payload), request.invocation.requestSha256);
    script = payload.slice("set -euo pipefail\n".length, -1);
    args[args.length - 1] = script;
  } else if (binary === "sftp") {
    assert.equal(request?.invocation.channel, "sftp");
    assert.deepEqual(argv.slice(-5), ["-b", "-", "-s", controlRegistration(request).command, "root@" + state.ip]);
    const batch = /^put "((?:\\.|[^"\\])*)" "(\/bench\/[^"\\]+)"\n$/.exec(options.input);
    assert.ok(batch, "expected a guarded setup upload");
    args = [batch[1].replace(/\\(.)/g, "$1"), argv.at(-1) + ":" + batch[2]];
    assert.equal(digest(JSON.stringify(args)), request.invocation.requestSha256);
  }
  if (script.startsWith("systemctl start")) starts++;
  if (script.startsWith("node -e") && script.includes("--no-clobber")) delivered++;
  const result = h.run(binary === "sftp" ? "scp" : binary, args, options.timeout);
  const match = scenario === "fetch" ? binary === "git" && args[0] === "fetch"
    : scenario === "create" ? binary === "doctl" && args[2] === "create"
      : scenario === "upload" ? binary === "sftp" && request.epoch === "bootstrap"
        : scenario === "install" ? request?.epoch === "bootstrap" && script.startsWith("bash -n") && script.includes(" && install -m ")
          : scenario === "start" ? request?.epoch === "bootstrap" && script === "systemctl start " + state.unit
            : scenario === "final-unit" ? script.startsWith("systemctl show") && h.units === 2
              : scenario === "final-ownership" ? binary === "doctl" && args[2] === "get" && h.units === 2
                : scenario === "delete" ? binary === "doctl" && args[2] === "delete"
                  : scenario === "audit-upload" ? binary === "scp" : false;
  if (match && !signalCommand) {
    // Deliver a real OS signal while the controller blocks inside its fake command.
    const child = spawnSync(process.execPath, ["-e", 'process.kill(Number(process.argv[1]), "SIGTERM"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);', String(process.pid)],
      { encoding: "utf8", timeout: 5000, windowsHide: true, env: {}, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(child.status, 0);
    signalCommand = binary;
  }
  if (!request) return result;
  const id = request.invocation.id;
  return { ...result, stderr: "CORTEN_CONTROL " + id + " " + "d".repeat(64) + "\nCORTEN_RESULT " + id + " " + result.status + "\n" };
};

try {
  const detach = ["fetch", "create", "upload", "install", "start"].includes(scenario);
  if (!detach) h.seed();
  const args = ["r21", "--state-dir", h.base];
  if (detach) args.push("--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context);
  else if (scenario === "audit-upload") {
    const path = join(h.temp, "delivery.json"); h.flags.active = true;
    writeFileSync(path, JSON.stringify(syntheticDelivery()));
    args.push("--deliver-audit", path, "--campaign", campaign, "--approve-subject", subject);
  } else args.push("--collect");
  let approval;
  const spawn = (...args) => { externalEffect(); return fakeCommand(...args); };
  const request = syntheticProviderRequest(h, (binary, argv, timeout) => fakeCommand(binary, argv, { timeout }));
  const deps = { spawn, roleCheck: () => [], streamSpawn: () => { externalEffect(); assert.fail("unexpected monitor connection"); },
    providerRequest: (options) => { externalEffect(); return request(options); }, repo: h.repo, inspect: async () => h.report(), sleep: async () => {}, interrupted: signals.interrupted,
    write: (value) => { approval = JSON.parse(value).approvalSha256; } };
  deps.providerFactory = ({ repo, interrupted, createMode }) => Object.assign(createProviderEngine({ repo, interrupted, createMode, spawn, request: deps.providerRequest, sleep: deps.sleep }), { close: async () => {} });
  await productionMain([...args, "--print-approval"], deps);
  let code;
  try { code = await productionMain([...args, "--approve-reviewed-merged-ready", approval], deps); }
  catch { code = 2; }
  const cancelObservedAtReturn = signals.interrupted(), saved = existsSync(h.statePath) ? h.saved() : null;
  const output = { scenario, sent: !!signalCommand, signalCommand, code, cancelObservedAtReturn, creates: h.creates, deletes: h.deletes, starts, delivered, afterSignal,
    state: saved?.status, createIntent: !!saved?.createIntentAt, deleteIntent: !!saved?.deletionIntentAt,
    destroyed: !!saved?.destroyedAt, auditIntent: !!saved?.auditIntents?.["json-api"],
    archive: existsSync(join(h.local, "results.tgz")), operationLock: existsSync(join(h.local, "operation.lock")) };
  // Drain signals before removing the handlers, even when reproducing the broken path.
  await new Promise((r) => setImmediate(() => setImmediate(r)));
  console.log(JSON.stringify(output));
} finally {
  signals.close();
  for (const fn of cleanup) fn();
}
