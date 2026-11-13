import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../../../", import.meta.url));
export const contexts = { aspnet: "bench/fullstack/apps/aspnet", express: "bench/fullstack/apps/express", corten: "." };
export function sourceIdentity(app) {
  assert.ok(Object.hasOwn(contexts, app));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const paths = app === "corten" ? ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates", "bench/marketplace/corten"] : [contexts[app]];
  const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths).split("\0").filter(Boolean).sort();
  const manifest = files.map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(root + path)).digest("hex") }));
  return { commit: git("rev-parse", "HEAD"), dirty: Boolean(git("status", "--porcelain", "--", ...paths)), files: manifest,
    sha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
}
