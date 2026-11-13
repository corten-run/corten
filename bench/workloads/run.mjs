// Explicit local group execution. Native runners own their gates, evidence and cleanup.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import { contractSha256, definition, groupNames, selectedApps } from "./registry.mjs";
import { deploymentPlan } from "./deployments.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runners = Object.freeze({
  "catalog-page": ["bench/catalog/run.mjs", "--group", "catalog-page"],
  "json-api": ["bench/json-api/run.mjs", "--group", "json-api"],
  "localized-marketplace": ["bench/marketplace/run.mjs", "--group", "localized-marketplace"],
  "mixed-production": ["bench/mixed-production/run.mjs"],
  "fullstack-browser": ["bench/fullstack-browser/run.mjs"],
  "client-heavy": ["bench/client-heavy/run.mjs"],
  "live-delivery": ["bench/live/run.mjs", "--group", "live-delivery"],
  "recoverable-live": ["bench/recoverable-live/run.mjs"],
  hardening: ["bench/hardening/run.mjs"],
});
const filters = new Set(["apps", "app", "cases", "case", "group", "groups", "part", "source", "sources", "locale", "locales", "only", "skip", "exclude", "verify-app", "verify-source", "verify-case", "verify-phase", "detach", "collect", "ssh-key", "state-dir"]);

export function runnerFor(group) {
  definition(group);
  const [entry, ...selection] = runners[group];
  return { entry, selection: [...selection] };
}

export function invocation(argv) {
  assert.ok(Array.isArray(argv) && argv.every((arg) => typeof arg === "string"), "argument array required");
  const [group, round, ...args] = argv;
  const workload = definition(group);
  assert.match(round ?? "", /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "explicit safe round required");
  for (const arg of args) {
    if (arg.startsWith("--")) assert.ok(!filters.has(arg.slice(2).split("=", 1)[0]), `group execution cannot filter contenders/cases or operate cloud resources: ${arg}`);
  }
  const { entry, selection } = runnerFor(group);
  return {
    schema: "benchmark-group-invocation/v1", group, round, title: workload.title,
    contractSha256: contractSha256(group), selectedApps: selectedApps(group),
    command: process.execPath, args: [entry, round, ...selection, ...args], cwd: root,
    qualification: "native-runner-evidence-required",
    deploymentIntent: deploymentPlan(group),
  };
}

export async function execute(plan, start = spawn) {
  const overrides = ["BENCH_APPS", "BENCH_TIER", "BENCH_EDGE"].filter((key) => process.env[key]);
  assert.equal(overrides.length, 0, `unset legacy selection overrides before group execution: ${overrides.join(", ")}`);
  // Windows kill(SIGTERM) bypasses JavaScript handlers/finally. Ask the bootstrap
  // over IPC instead, and wait for native cleanup rather than force-killing its owner.
  let child, ready = false, cancelled = null, closed = false, error = null;
  const send = (message) => {
    if (!child?.connected || closed) return;
    child.send(message, (failure) => {
      if (!failure || closed) return;
      error ??= failure;
      if (child.connected) child.disconnect();
    });
  };
  const forward = (signal) => {
    if (cancelled) return;
    cancelled = signal;
    if (ready) send({ type: "cancel", signal });
  };
  const interrupt = () => forward("SIGINT"), terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    child = start(plan.command, [fileURLToPath(new URL("./dispatcher-child.mjs", import.meta.url)), ...plan.args],
      { cwd: plan.cwd, stdio: ["inherit", "inherit", "inherit", "ipc"], shell: false, windowsHide: true });
    return await new Promise((ok, fail) => {
      child.on("message", (message) => {
        if (message?.type !== "ready" || ready) return;
        ready = true;
        send(cancelled ? { type: "cancel", signal: cancelled } : { type: "start" });
      });
      child.once("error", (failure) => {
        error ??= failure;
        if (child.pid && child.connected) child.disconnect();
      });
      const complete = async (code, signal) => {
        if (closed) return;
        closed = true;
        // On Windows Node may omit ChildProcess 'close' after an explicit IPC
        // disconnect. 'exit' plus drained output still observes native completion.
        try { await Promise.all([child.stdout, child.stderr].filter(Boolean).map((stream) => finished(stream, { cleanup: true }))); }
        catch (failure) { error ??= failure; }
        if (error) fail(error);
        else ok({ code: code === 0 && cancelled ? (cancelled === "SIGINT" ? 130 : 143)
          : code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1), signal });
      };
      child.once("exit", complete);
      child.once("close", complete);
    });
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
  }
}

export const usage = `node bench/workloads/run.mjs <${groupNames.join("|")}> <round> [native runner options]\nUse --plan as the first argument to print the exact invocation without executing it.`;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), preview = args[0] === "--plan";
    const plan = invocation(preview ? args.slice(1) : args);
    if (preview) console.log(JSON.stringify(plan, null, 2));
    else process.exitCode = (await execute(plan)).code;
  } catch (error) { console.error(`${error.message}\n${usage}`); process.exitCode = 1; }
}
