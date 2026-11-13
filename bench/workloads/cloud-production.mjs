// Operator-gated production composition. No provider or state operations on import.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { controller, publicError } from "./droplet.mjs";
import { digest, regular, resolveStateRoot } from "./cloud-local.mjs";
import { controllerState, full, parseDropletArgs } from "./cloud-options.mjs";
import { controlCheckpoint, shellTransport } from "./cloud-transport.mjs";
import { sourceUrl } from "./cloud-remote.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const controllerPaths = ["droplet.mjs", "cloud-contract.mjs", "cloud-options.mjs", "cloud-local.mjs", "cloud-audit.mjs", "cloud-validation.mjs", "cloud-validation-worker.mjs", "cloud-transport.mjs", "cloud-remote.mjs", "cloud-production.mjs"].map((p) => `bench/workloads/${p}`);
export const nativePaths = ["campaign-entry.mjs", "campaign-verify.mjs", "campaign-contract.mjs", "campaign-journal.mjs", "campaign.mjs", "contract.mjs", "worker.mjs", "process.mjs", "evidence.mjs", "host-observation.mjs", "json-staging.mjs", "bootstrap.mjs", "raw-support.mjs"].map((p) => `bench/workloads/isolated/${p}`);
const loadedSources = new Map(controllerPaths.map((path) => [path, regular(join(checkout, path), 1024 * 1024).toString("utf8").replaceAll("\r\n", "\n")]));
export function parseProductionArgs(args) {
  let approval, preview = false; const core = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--approve-reviewed-merged-ready") {
      assert.equal(approval, undefined); approval = full(args[++i], /[a-f0-9]{64}/, "exact operator-approved action required");
    } else if (args[i] === "--print-approval") { assert.equal(preview, false); preview = true; }
    else core.push(args[i]);
  }
  assert.ok(!(approval && preview), "preview cannot execute");
  return { options: parseDropletArgs(core), approval, preview };
}

export async function productionPlan(options, { repo = checkout, run } = {}) {
  // All checks here are local/read-only. Missing integration stays visible, not imported.
  repo = realpathSync(repo);
  assert.ok(!/["$%\r\n\0]/.test(options.stateDir), "SSH config expansion in state path refused");
  const physicalRequest = resolveStateRoot(options.stateDir);
  assert.ok(!/["$%\r\n\0]/.test(physicalRequest), "SSH config expansion in state path refused");
  assert.equal(realpathSync((await run("git", ["rev-parse", "--show-toplevel"])).stdout.trim()), repo);
  const head = full((await run("git", ["rev-parse", "HEAD"])).stdout.trim(), /[a-f0-9]{40}/, "controller commit");
  assert.equal((await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout, "", "clean controller source required");
  for (const path of controllerPaths) {
    // Git's committed bytes, with checkout CRLF normalized, must be this controller.
    const committed = (await run("git", ["show", `${head}:${path}`])).stdout;
    assert.equal(loadedSources.get(path), committed, "loaded controller differs from approved source");
  }
  const missing = [];
  for (const path of nativePaths)
    if ((await run("git", ["cat-file", "-e", `${head}:${path}`], 60000, true)).status !== 0) missing.push(path);
  let reservationSha256 = null, deliverySha256 = null;
  if (options.detach) assert.equal(options.commit, head, "launch must measure the approved controller source");
  else {
    const bytes = regular(join(resolve(options.stateDir), `groups-${options.round}`, "state.json"), 1024 * 1024);
    const saved = controllerState(JSON.parse(bytes), options.round);
    assert.equal(saved.commit, head, "current native verifier needs the measured integrated checkout");
    reservationSha256 = digest(bytes);
  }
  if (options.deliverAudit) deliverySha256 = digest(regular(resolve(options.deliverAudit), 16 * 1024 ** 2));
  const subject = { action: options.detach ? "detach" : options.collect ? "collect" : "deliver-audit", controllerCommit: head,
    options, reservationSha256, deliverySha256,
    declaration: "operator-approved-after-merged-independent-review-and-full-native-readiness" };
  return { subject, approvalSha256: digest(JSON.stringify(subject)), missing };
}

export async function productionMain(args, { spawn, repo = checkout, inspect, sleep, interrupted = () => false, write = console.log } = {}) {
  const { options, approval, preview } = parseProductionArgs(args);
  const processRun = shellTransport({ repo, spawn });
  const run = async (...args) => {
    await controlCheckpoint(interrupted);
    try { return processRun(...args); }
    finally { await controlCheckpoint(interrupted); }
  };
  const plan = await productionPlan(options, { repo, run });
  if (preview) {
    write(JSON.stringify({ action: plan.subject.action, controllerCommit: plan.subject.controllerCommit, round: options.round,
      approvalSha256: plan.approvalSha256, missing: plan.missing, fullGroupQualified: false }));
    return plan.missing.length ? 2 : 3; // Preview is never qualified execution success.
  }
  assert.equal(approval, plan.approvalSha256, "explicit operator-approved exact action required");
  assert.deepEqual(plan.missing, [], "native campaign integration missing; do not allocate");
  assert.ok(!interrupted(), "cancelled before approval");
  // Read remote Git only after explicit approval. Never trust a stale local merge ref.
  await run("git", ["fetch", "--no-tags", sourceUrl, "+refs/heads/main:refs/remotes/origin/main"], 120000);
  await run("git", ["merge-base", "--is-ancestor", plan.subject.controllerCommit, "origin/main"]);
  const repeated = await productionPlan(options, { repo, run });
  assert.equal(repeated.approvalSha256, approval, "source/state/delivery changed after approval");
  assert.deepEqual(repeated.missing, []);
  let entered = false;
  const authorizedRun = async (binary, argv, timeout, allowFail) => {
    if (binary !== "git" && !entered) {
      // The core now holds its exclusive lock. Bind approval to the state it read,
      // not a snapshot that a different collector could have changed meanwhile.
      assert.ok(!interrupted(), "cancelled before provider access");
      assert.equal((await productionPlan(options, { repo, run })).approvalSha256, approval, "locked action changed after approval");
      entered = true;
    }
    return run(binary, argv, timeout, allowFail);
  };
  const task = controller(options, { run: authorizedRun, repo, inspect, sleep, interrupted });
  let result;
  if (options.detach) { await task.launch(); result = 3; }
  else result = options.collect ? await task.collect() : await task.deliverAudit();
  await controlCheckpoint(interrupted);
  return result;
}

export function productionSignals() {
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const names = ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? ["SIGBREAK"] : [])];
  for (const name of names) process.on(name, cancel);
  return { interrupted: () => cancelled, close() { for (const name of names) process.off(name, cancel); } };
}
export async function productionCli(args) {
  const signals = productionSignals();
  try { return await productionMain(args, { interrupted: signals.interrupted }); }
  catch { console.error(publicError()); return 2; }
  finally { signals.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  productionCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
