// Build the existing production Dockerfile, with attributable source input hashes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { contexts, root, sourceIdentity } from "./image-source.mjs";

const [app, tag] = process.argv.slice(2);
assert.ok(tag);
const before = sourceIdentity(app);
const result = spawnSync("docker", ["build", "--label", "agent.owner=codex", "--label", "agent.task=native-upload-repair",
  "--label", `bench.source.commit=${before.commit}`, "--label", `bench.source.sha256=${before.sha256}`,
  "--label", `bench.source.dirty=${before.dirty}`,
  ...(app === "corten" ? ["-f", "bench/marketplace/corten/Dockerfile"] : []), "-t", tag, contexts[app]],
{ cwd: root, stdio: "inherit" });
assert.equal(result.status, 0);
assert.equal(sourceIdentity(app).sha256, before.sha256, "source changed during native image build; rebuild before testing");
console.log(JSON.stringify({ app, tag, sourceCommit: before.commit, sourceSha256: before.sha256, files: before.files.length }));
