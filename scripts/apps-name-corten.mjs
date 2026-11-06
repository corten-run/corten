// Checks that the template `corten new` writes and the examples name Corten, not the server
// library under it: no `axum::` in their tracked files and no axum dependency in their manifests
// (docs/design.md, Choice 21). The one
// exception is card-market's benchmark against bare axum, which builds axum's own router.
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
    problems.push(`${file}:${i + 1}: names axum (${line.trim()}); use corten::extract, corten::middleware, corten::answer::Body or corten::Bytes`);
  });
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
