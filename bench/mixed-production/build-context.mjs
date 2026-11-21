import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceSnapshot } from "./source-audit.mjs";
import { sha256 } from "./capture.mjs";

// Commit archives already use immutable commit metadata. Tree archives otherwise
// use the wall clock, which cannot bind an independent prebuild audit to Docker.
export function nativeBuildArchiveArgs(commit, app, { output } = {}) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(app, /^[a-z][a-z0-9-]*$/);
  if (output !== undefined) assert.ok(typeof output === "string" && output.length > 0 && !output.includes("\0"));
  return ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar",
    ...(app === "corten" ? [] : ["--mtime=1970-01-01T00:00:00Z"]), ...(output === undefined ? [] : ["--output", output]),
    app === "corten" ? commit : `${commit}:bench/fullstack/apps/${app}`];
}

export async function extractNativeSource(io, folder, commit) {
  const root = join(folder, "build-source"), archive = join(folder, "build-source.tar");
  const args = nativeBuildArchiveArgs(commit, "corten", { output: archive });
  mkdirSync(root);
  await io.command("git", args, { timeout: 60000 });
  const archiveSha256 = sha256(readFileSync(archive));
  await io.command("tar", ["-xf", archive, "-C", root], { timeout: 60000 });
  // The dependency bind overlays this directory underneath a read-only /src.
  // It must be empty and outside the archived file inventory.
  mkdirSync(join(root, "node_modules"));
  return { root, archiveSha256 };
}

// Docker receives only these retained bytes, never the mutable working directory.
export async function nativeBuildContext(io, folder, commit, app, expected) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(app, /^[a-z][a-z0-9-]*$/);
  const prefix = app === "corten" ? "" : `bench/fullstack/apps/${app}/`;
  assert.ok(expected.length > 0 && expected.every((f) => f.path.startsWith(prefix)));
  const archive = join(folder, `${app}-build-context.tar`), root = join(folder, `${app}-build-context`);
  await io.command("git", nativeBuildArchiveArgs(commit, app, { output: archive }), { timeout: 60000 });
  const input = readFileSync(archive);
  mkdirSync(root);
  await io.command("tar", ["-xf", archive, "-C", root], { timeout: 60000 });
  const snapshot = sourceSnapshot(root, expected.map((f) => f.path.slice(prefix.length)));
  assert.deepEqual(snapshot.sourceFiles.map((f) => ({ ...f, path: prefix + f.path })), expected,
    "Docker archive differs from independently audited native inputs");
  return { input, sha256: sha256(input), dockerfile: app === "corten" ? "bench/marketplace/corten/Dockerfile" : "Dockerfile" };
}
