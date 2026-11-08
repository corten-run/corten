// Checks that the template `corten new` writes and the examples name Corten, not the server
// library under it: no `axum::` in their tracked files and no axum dependency in their manifests
// (docs/design.md#choice-own-extractors). The exceptions are card-market's benchmark against bare axum,
// which builds axum's own router, and a test's stand-in for a service the app calls, whose
// `corten::axum::Router` and `corten::axum::serve` are allowed in a test file (`tests.rs`, `tests/`).
// Run by npm run check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Lines allowed to name axum, by file: what the bare-axum benchmark builds. */
const allowed = new Map([
  [
    "examples/card-market/src/app.rs",
    ["use corten::{answer::Body, axum::Router, http::Request};", "let bare = corten::axum::routing::get(item_json);"],
  ],
]);

const files = execFileSync("git", ["ls-files", "-z", "--", "examples", "crates/corten-cli/template"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((file) => file && !file.includes("node_modules/"));

/** A test file, where a stand-in server is axum's `Router` and `serve`. */
const testFile = (/** @type {string} */ file) => /(^|\/)(tests\.rs$|tests\/)/.test(file);
/** What a stand-in names of axum, and only that: `corten::axum::Router` and `corten::axum::serve`. */
const standIn = (/** @type {string} */ line) =>
  [...line.matchAll(/axum::[A-Za-z_:]*/g)].every(([name]) => /^axum::(Router(::new)?|serve)$/.test(name));

const problems = [];
for (const file of files) {
  if (!existsSync(join(root, file))) continue;
  const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    // A dependency on axum itself, in a manifest (the template's is Cargo.toml.txt).
    if (/(^|\/)Cargo\.toml(\.txt)?$/.test(file) && /^\s*axum\s*=/.test(line)) {
      problems.push(`${file}:${i + 1}: depends on axum (${line.trim()}); Corten re-exports what an app needs`);
      return;
    }
    if (!line.includes("axum::")) return;
    if (allowed.get(file)?.includes(line.trim())) return;
    if (testFile(file) && /corten::axum::/.test(line) && standIn(line)) return;
    const stand = testFile(file) ? " (a test's stand-in server writes corten::axum::Router::new() and corten::axum::serve as paths)" : "";
    problems.push(`${file}:${i + 1}: names axum (${line.trim()}); use corten::extract (bytes_up_to for a whole body), corten::middleware, corten::answer::Body or corten::Bytes${stand}`);
  });
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
