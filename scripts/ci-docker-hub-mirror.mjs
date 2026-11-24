// Hosted CI only: scripts/ci-docker-hub-mirror.sh runs this as root before Docker Hub pulls.
// Adds Google's Docker Hub cache as a registry mirror to a Docker daemon config, keeping every
// other key and mirror. The daemon tries the mirror first and falls back to Docker Hub; image
// references stay Docker Hub's, so a digest-pinned pull still checks the same bytes.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const mirror = "https://mirror.gcr.io";

/**
 * The config text with the mirror added once, or null when it is already listed.
 * @param {string | null} text the file's contents, or null when there is no file
 * @returns {string | null}
 */
export function withMirror(text) {
  if (text === null) return JSON.stringify({ "registry-mirrors": [mirror] }, null, 2) + "\n";
  const config = JSON.parse(text);
  if (config === null || typeof config !== "object" || Array.isArray(config))
    throw new Error("the Docker daemon config is not a JSON object");
  const mirrors = config["registry-mirrors"] ?? [];
  if (!Array.isArray(mirrors) || !mirrors.every((entry) => typeof entry === "string"))
    throw new Error("registry-mirrors in the Docker daemon config is not a list of strings");
  if (mirrors.some((entry) => entry.replace(/\/+$/, "") === mirror)) return null;
  config["registry-mirrors"] = [...mirrors, mirror];
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * Adds the mirror to the config at path (creating it if absent) and says whether it changed.
 * A config that does not parse is left as it is.
 * @param {string} path
 * @returns {boolean}
 */
export function addMirror(path) {
  let text = null, mode = 0o644;
  try {
    text = readFileSync(path, "utf8");
    mode = statSync(path).mode & 0o7777;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
  const next = withMirror(text);
  if (next === null) return false;
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, next, { mode, flag: "wx" });
  renameSync(temporary, path);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error("usage: node scripts/ci-docker-hub-mirror.mjs <daemon.json>");
  console.log(addMirror(path) ? "changed" : "unchanged");
}
