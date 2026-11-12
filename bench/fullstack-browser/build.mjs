import assert from "node:assert/strict";
import { join } from "node:path";
import { candidates } from "./contract.mjs";

// Reuse each native app's existing build, including its architecture and assets.
// No generated controller or shared page/renderer enters an image.
export function nativeBuildArgs({ app, repo, task, commit, dirty, snapshot }) {
  assert.ok(candidates.includes(app));
  assert.match(task, /^browser-[a-f0-9-]+$/);
  const tag = `${task}-${app}`;
  const context = app === "corten" ? repo : join(repo, "bench/fullstack/apps", app);
  const dockerfile = app === "corten" ? join(repo, "bench/marketplace/corten/Dockerfile") : join(context, app === "sveltekit" ? "Dockerfile.marketplace" : "Dockerfile");
  return { tag, context, dockerfile, args: ["build", "--progress=plain", "--label", "agent.owner=codex", "--label", `agent.task=${task}`,
    "--label", `run.corten.browser.commit=${commit}`, "--label", `run.corten.browser.dirty=${dirty}`,
    "--label", `run.corten.browser.source-snapshot=${snapshot}`, "-t", tag, "-f", dockerfile, context] };
}
