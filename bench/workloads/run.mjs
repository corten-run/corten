// Explicit local group execution. Native runners own their gates, evidence and cleanup.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
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
const filters = new Set(["apps", "app", "cases", "case", "group", "groups", "source", "sources", "locale", "locales", "only", "skip", "exclude", "verify-app", "verify-source", "verify-case", "verify-phase", "detach", "collect", "ssh-key", "state-dir"]);

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
  // No shell or detached process: the native runner receives the original foreground
  // signals and retains responsibility for stopping its owned processes and containers.
  const child = start(plan.command, plan.args, { cwd: plan.cwd, stdio: "inherit", shell: false });
  const forward = (signal) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const interrupt = () => forward("SIGINT"), terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    return await new Promise((ok, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => ok({ code: code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1), signal }));
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
