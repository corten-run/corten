// @ts-check
// The standalone Corten benchmark apps resolve the crates they share with the workspace at the
// workspace lock's versions, so a catalog, marketplace, live or nodelay number times the
// dependency tree CI tests (#1767). After a workspace refresh, move each listed lock with
// `cargo update --manifest-path <app>/Cargo.toml -p <crate> --precise <workspace version>`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const locks = ["bench/catalog/corten/Cargo.lock", "bench/marketplace/corten/Cargo.lock",
  "bench/live/apps/corten/Cargo.lock", "bench/nodelay/app/Cargo.lock"];
/** Standalone locks next to a Corten path dependency that keep their own resolution: the HTTP/2
 * probe's is tied to its recorded results (bench/http2/README.md). */
const ownResolution = ["bench/http2/probe/Cargo.lock"];

/** The registry packages of a Cargo.lock, as `{ name, version }`. @param {string} text */
function registryPackages(text) {
  return text.replace(/\r\n/g, "\n").split(/^\[\[package\]\]$/m).slice(1).flatMap((block) => {
    const field = (/** @type {string} */ key) => block.match(new RegExp(`^${key} = "([^"]*)"$`, "m"))?.[1];
    const name = field("name"), version = field("version");
    return name && version && field("source")?.startsWith("registry+") ? [{ name, version }] : [];
  });
}

/** Whether Cargo treats two versions as compatible (one could satisfy the other's caret requirement). */
function compatible(/** @type {string} */ a, /** @type {string} */ b) {
  const [x, y] = [a, b].map((v) => (v.split(/[-+]/)[0] ?? "").split(".").map(Number));
  if (!x || !y || x[0] !== y[0]) return false;
  if (x[0] !== 0) return true;
  return x[1] === y[1] && (x[1] !== 0 || x[2] === y[2]);
}

/** Each crate in `lock` at a version the workspace lock has a different compatible version of.
 * @param {string} workspace @param {string} lock */
function disagreements(workspace, lock) {
  const ours = registryPackages(workspace);
  return registryPackages(lock).flatMap(({ name, version }) => {
    const same = ours.filter((p) => p.name === name && compatible(p.version, version));
    return same.length === 0 || same.some((p) => p.version === version) ? []
      : same.map((p) => `${name} ${version} (workspace ${p.version})`);
  });
}

const read = (/** @type {string} */ path) => readFileSync(new URL(path, root), "utf8");

test("each standalone Corten bench lock has the workspace lock's version of every crate they share", () => {
  const workspace = read("Cargo.lock");
  assert.ok(registryPackages(workspace).length > 0, "Cargo.lock has registry packages");
  for (const lock of locks) {
    assert.ok(registryPackages(read(lock)).length > 0, `${lock} has registry packages`);
    assert.deepEqual(disagreements(workspace, read(lock)), [], lock);
  }
});

test("every bench app with its own lock and a Corten path dependency is listed", () => {
  const manifests = execFileSync("git", ["ls-files", "-z", "--", "bench/**/Cargo.toml"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean);
  const found = manifests.filter((m) => /path = "[./]*crates\/corten"/.test(read(m)))
    .map((m) => m.replace(/Cargo\.toml$/, "Cargo.lock"))
    .filter((l) => execFileSync("git", ["ls-files", "--", l], { cwd: root, encoding: "utf8" }).trim() === l);
  assert.deepEqual(found.sort(), [...locks, ...ownResolution].sort());
});

test("an older or newer compatible version disagrees; another major, a path crate or an equal one does not", () => {
  const pkg = (/** @type {string} */ name, /** @type {string} */ version, source = 'source = "registry+https://github.com/rust-lang/crates.io-index"\n') =>
    `[[package]]\nname = "${name}"\nversion = "${version}"\n${source}`;
  const workspace = [pkg("brotli", "9.1.3"), pkg("zstd", "0.14.4"), pkg("syn", "3.0.10"), pkg("itoa", "1.0.19"), pkg("corten-run", "0.3.0", "")].join("\n");
  const lock = [pkg("brotli", "9.1.1"), pkg("zstd", "0.15.0"), pkg("syn", "3.0.11"), pkg("itoa", "1.0.19"), pkg("corten-run", "0.2.0", "")].join("\n");
  assert.deepEqual(disagreements(workspace, lock), ["brotli 9.1.1 (workspace 9.1.3)", "syn 3.0.11 (workspace 3.0.10)"]);
  assert.deepEqual(disagreements(workspace.replace(/\n/g, "\r\n"), lock.replace(/\n/g, "\r\n")), disagreements(workspace, lock));
});
