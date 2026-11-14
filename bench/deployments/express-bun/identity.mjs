// Runs inside the same immutable image, once under each runtime, before any app starts.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function tree(root, prefix = "") {
  return readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name, file = join(root, path), stat = lstatSync(file);
    if (stat.isSymbolicLink()) return [{ path, symlink: readlinkSync(file) }];
    return stat.isDirectory() ? tree(root, path) : [{ path, sha256: hash(readFileSync(file)) }];
  });
}
const manifest = JSON.parse(readFileSync("/app/package.json", "utf8"));
const installed = Object.fromEntries(Object.keys(manifest.dependencies).sort().map((name) => [name, JSON.parse(readFileSync(`/app/node_modules/${name}/package.json`, "utf8")).version]));
const sources = ["server.mjs", "package.json"].map((path) => ({ path, sha256: hash(readFileSync(`/app/${path}`)) }))
  .concat(...["lib", "views", "static"].map((dir) => tree("/app", dir))).sort((a, b) => a.path.localeCompare(b.path));
console.log(JSON.stringify({ executable: process.execPath, executableSha256: hash(readFileSync(process.execPath)), versions: process.versions,
  installed, sources, dependenciesSha256: hash(JSON.stringify(tree("/app/node_modules"))),
  lockSha256: hash(readFileSync("/app/package-lock.json")), lock: JSON.parse(readFileSync("/app/package-lock.json", "utf8")) }));
