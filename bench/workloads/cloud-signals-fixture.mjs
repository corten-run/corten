// Local subprocess fixture only. No provider/SSH executable or network is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { commit, campaign, harness, subject } from "./cloud-fixtures.mjs";
import { productionMain, productionSignals } from "./cloud-production.mjs";

const scenario = process.argv[2], cleanup = [], h = harness({ after(fn) { cleanup.push(fn); } });
const signals = productionSignals();
let sent = false, afterSignal = 0, starts = 0, delivered = 0;
const spawn = (binary, argv, options) => {
  if (sent) afterSignal++;
  if (binary === "git" && argv[0] === "show")
    return { status: 0, stdout: readFileSync(resolve(argv[1].slice(41)), "utf8").replaceAll("\r\n", "\n") };
  const args = [...argv];
  if (binary === "doctl") args.splice(args.indexOf("--http-retry-max"));
  if (binary === "ssh") args[args.length - 1] = options.input.replace(/^set -euo pipefail\n/, "").replace(/\n$/, "");
  const script = binary === "ssh" ? args.at(-1) : "";
  if (script.startsWith("systemctl start")) starts++;
  if (script.startsWith("node -e") && args.at(-1).includes("--no-clobber")) delivered++;
  const result = h.run(binary, args, options.timeout);
  const match = scenario === "fetch" ? binary === "git" && args[0] === "fetch"
    : scenario === "create" ? binary === "doctl" && args[2] === "create"
      : scenario === "upload" ? binary === "scp"
        : scenario === "install" ? script.startsWith("bash -n")
          : scenario === "start" ? script.startsWith("systemctl start")
            : scenario === "final-unit" ? script.startsWith("systemctl show") && h.units === 2
              : scenario === "final-ownership" ? binary === "doctl" && args[2] === "list" && h.units === 2
                : scenario === "delete" ? binary === "doctl" && args[2] === "delete"
                  : scenario === "audit-upload" ? binary === "scp" : false;
  if (match && !sent) {
    sent = true;
    // Deliver a real OS signal while the controller blocks inside its fake command.
    const child = spawnSync(process.execPath, ["-e", 'process.kill(Number(process.argv[1]), "SIGTERM"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);', String(process.pid)],
      { encoding: "utf8", timeout: 5000, windowsHide: true, env: {}, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(child.status, 0);
  }
  return result;
};

try {
  const detach = ["fetch", "create", "upload", "install", "start"].includes(scenario);
  if (!detach) h.seed();
  const args = ["r21", "--state-dir", h.base];
  if (detach) args.push("--detach", "--commit", commit, "--ssh-key", "42");
  else if (scenario === "audit-upload") {
    const path = join(h.temp, "delivery.json"); h.flags.active = true;
    writeFileSync(path, JSON.stringify({ schema: "benchmark-json-audit-delivery/v1", subjectSha256: subject,
      review: { subjectSha256: subject, decision: "approved", findings: [] }, bundle: { schema: "json-api-native-audits/v1", receipts: Array(36).fill({}) } }));
    args.push("--deliver-audit", path, "--campaign", campaign, "--approve-subject", subject);
  } else args.push("--collect");
  let approval;
  const deps = { spawn, repo: h.repo, inspect: async () => h.report(), sleep: async () => {}, interrupted: signals.interrupted,
    write: (value) => { approval = JSON.parse(value).approvalSha256; } };
  await productionMain([...args, "--print-approval"], deps);
  let code;
  try { code = await productionMain([...args, "--approve-reviewed-merged-ready", approval], deps); }
  catch { code = 2; }
  const cancelObservedAtReturn = signals.interrupted(), saved = existsSync(h.statePath) ? h.saved() : null;
  const output = { scenario, sent, code, cancelObservedAtReturn, creates: h.creates, deletes: h.deletes, starts, delivered, afterSignal,
    state: saved?.status, createIntent: !!saved?.createIntentAt, deleteIntent: !!saved?.deletionIntentAt,
    destroyed: !!saved?.destroyedAt, auditIntent: !!saved?.auditIntent,
    archive: existsSync(join(h.local, "results.tgz")), operationLock: existsSync(join(h.local, "operation.lock")) };
  // Drain signals before removing the handlers, even when reproducing the broken path.
  await new Promise((r) => setImmediate(() => setImmediate(r)));
  console.log(JSON.stringify(output));
} finally {
  signals.close();
  for (const fn of cleanup) fn();
}
