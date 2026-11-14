// Pure replay of a closed npm install's aliases. Never follows a saved link.
import { posix } from "node:path";
import { need, keys } from "./replay-v2.mjs";

export function binTarget(path, target, entries, blob) {
  const match = /^(.*?)(?:\.bin\/)([^/]+)$/.exec(path);
  need(match && (match[1] === "" || match[1].endsWith("node_modules/"))
    && /^[A-Za-z0-9_.-]+$/.test(match[2]) && typeof target === "string" && !/[\\\x00-\x1f]/.test(target)
    && !posix.isAbsolute(target), "unapproved-install-link");
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  need(!resolved.startsWith("../") && entries.has(resolved), "escaped-or-missing-install-bin");
  const tail = resolved.slice(match[1].length).split("/"), depth = tail[0].startsWith("@") ? 2 : 1;
  const packageRoot = match[1] + tail.slice(0, depth).join("/"), manifestRef = entries.get(`${packageRoot}/package.json`);
  need(resolved.startsWith(`${packageRoot}/`) && manifestRef, "unapproved-install-bin-package");
  const manifest = JSON.parse(blob(manifestRef));
  const bins = typeof manifest.bin === "string" ? { [manifest.name?.split("/").at(-1)]: manifest.bin } : manifest.bin;
  const entry = bins?.[match[2]];
  need(typeof entry === "string" && !posix.isAbsolute(entry) && !/[\\\x00-\x1f]/.test(entry)
    && posix.normalize(`${packageRoot}/${entry}`) === resolved, "install-bin-differs-from-package");
  return resolved;
}

export function installLayout(layout, entries, blob) {
  keys(layout, ["schema", "bins", "hardlinks"]);
  need(layout.schema === "client-heavy-install-layout/v1" && Array.isArray(layout.bins) && Array.isArray(layout.hardlinks), "invalid-install-layout");
  const aliases = new Set(), linked = new Set();
  for (const b of layout.bins) {
    keys(b, ["path", "target"]); need(!aliases.has(b.path), "duplicate-install-bin"); aliases.add(b.path);
    const target = binTarget(b.path, b.target, entries, blob);
    need(entries.get(b.path)?.sha256 === entries.get(target)?.sha256, "install-bin-bytes-differ");
  }
  for (const paths of layout.hardlinks) {
    need(Array.isArray(paths) && paths.length >= 2, "invalid-install-hardlink-group");
    for (const path of paths) {
      need(entries.has(path) && !linked.has(path) && !aliases.has(path), "invalid-install-hardlink-member"); linked.add(path);
      need(entries.get(path).sha256 === entries.get(paths[0]).sha256, "install-hardlink-bytes-differ");
    }
  }
}
