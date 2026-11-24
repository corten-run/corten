// Hosted native Linux fixture: no apps, load, network, or extra image pull.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../bench/json-api/process.mjs";
import { extractNativeSource } from "../bench/mixed-production/build-context.mjs";
import { createAttachedParticipant, createExecutionEvidence } from "../bench/mixed-production/execution-evidence.mjs";
import { executionMountArgs } from "../bench/mixed-production/execution-inputs.mjs";
import { fixtureGitCommands, fixtureGitEnv } from "./fixture-git.mjs";

const [image, runId, work] = process.argv.slice(2);
assert.match(image, /@sha256:[a-f0-9]{64}$/);
assert.match(runId, /^corten-evidence-kernel-[a-f0-9]{16}-mixed-mount$/);
const repo = join(work, "mixed-mount-repo"), folder = join(work, "mixed-mount-output");
mkdirSync(repo); mkdirSync(folder);
// extractNativeSource archives the fixture with Git through `io`; Docker goes through unchanged.
const io = fixtureGitCommands(commands(repo)), docker = (args, options) => io.command("docker", args, options);
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 30000,
  stdio: ["ignore", "pipe", "pipe"], env: fixtureGitEnv() }).trim();
const worker = `${runId}-corten-fixture-capture`;
let execution;
try {
  const result = "fresh mixed source mount started";
  writeFileSync(join(repo, "worker.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import marker from "mixed-mount-fixture";
assert.equal(marker, "dependency");
assert.equal(readFileSync("/out/input.txt", "utf8"), "output mount");
console.log(${JSON.stringify(result)});
`);
  git("init", "--quiet");
  git("add", "--", "worker.mjs");
  git("-c", "user.name=Mount Smoke", "-c", "user.email=smoke@example.test",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fresh source fixture");
  const commit = git("rev-parse", "HEAD");
  const { root } = await extractNativeSource(io, folder, commit);
  // Fail even on a Docker version that can synthesize the missing nested destination.
  assert.deepEqual(readdirSync(join(root, "node_modules")), []);
  const dependency = join(folder, "execution/dependencies/mixed-mount-fixture");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "package.json"), '{"exports":"./index.mjs"}');
  writeFileSync(join(dependency, "index.mjs"), 'export default "dependency";\n');
  writeFileSync(join(folder, "input.txt"), "output mount");
  execution = createExecutionEvidence({ folder, summary: { round: "w1", runId, inventory: ["corten"], options: { passes: 1 },
    provenance: { nativeSource: { commit } } }, docker });
  const own = (args, name) => execution.own(name, args);
  const start = await createAttachedParticipant({ own, docker }, worker, ["--pull=never", "--network", "none",
    "--cpus", "1", "--memory", "128m", ...executionMountArgs(root, folder), image, "node", "worker.mjs"]);
  assert.equal(await start({ timeout: 15000 }), result);
} finally {
  try { for (const name of execution?.pendingNames() ?? []) await execution.remove(name); }
  finally { io.dispose(); }
}
console.log("Mixed production fresh-source Docker mount and exact-ID cleanup passed");
