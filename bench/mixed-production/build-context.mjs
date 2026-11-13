import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceSnapshot } from "./source-audit.mjs";
import { sha256 } from "./capture.mjs";

// Docker receives only these retained bytes, never the mutable working directory.
export async function nativeBuildContext(io, folder, commit, app, expected) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(app, /^[a-z][a-z0-9-]*$/);
  const prefix = app === "corten" ? "" : `bench/fullstack/apps/${app}/`;
  assert.ok(expected.length > 0 && expected.every((f) => f.path.startsWith(prefix)));
  const archive = join(folder, `${app}-build-context.tar`), root = join(folder, `${app}-build-context`);
  await io.command("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", "--output", archive, `${commit}${prefix ? `:${prefix.slice(0, -1)}` : ""}`], { timeout: 60000 });
  const input = readFileSync(archive);
  mkdirSync(root);
  await io.command("tar", ["-xf", archive, "-C", root], { timeout: 60000 });
  const snapshot = sourceSnapshot(root, expected.map((f) => f.path.slice(prefix.length)));
  assert.deepEqual(snapshot.sourceFiles.map((f) => ({ ...f, path: prefix + f.path })), expected,
    "Docker archive differs from independently audited native inputs");
  return { input, sha256: sha256(input), dockerfile: app === "corten" ? "bench/marketplace/corten/Dockerfile" : "Dockerfile" };
}
