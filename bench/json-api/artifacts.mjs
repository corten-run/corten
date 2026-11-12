import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sha256 } from "./contract.mjs";

export function contained(root, path) {
  assert.ok(typeof path === "string" && path.length && !isAbsolute(path) && !path.includes("\\") && !path.includes(":"), "relative artifact path required");
  assert.ok(path.split("/").every((part) => part && part !== "." && part !== ".."), "unsafe artifact path");
  const absolute = resolve(root, path), rel = relative(resolve(root), absolute);
  assert.ok(rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel), "artifact escapes root");
  return absolute;
}
export function writer(root) {
  return (path, value) => {
    const bytes = JSON.stringify(value, null, 2);
    writeFileSync(contained(root, path), bytes);
    return { path, sha256: sha256(bytes) };
  };
}
export function reader(root) {
  return (reference) => {
    assert.deepEqual(Object.keys(reference ?? {}).sort(), ["path", "sha256"], "artifact reference must bind path and hash");
    const bytes = readContained(root, reference.path);
    assert.equal(sha256(bytes), reference.sha256, "raw artifact digest differs");
    return JSON.parse(bytes.toString("utf8"));
  };
}
export function readContained(root, path) {
  const file = contained(root, path), realRoot = realpathSync(root), real = realpathSync(file), rel = relative(realRoot, real);
  assert.ok(rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel), "artifact symlink escapes root");
  return readFileSync(file);
}
