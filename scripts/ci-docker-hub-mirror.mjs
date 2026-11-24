// scripts/ci-docker-hub-mirror.sh runs this as root on a disposable GitHub-hosted runner before
// Docker Hub pulls; see that script before running it anywhere else.
// Adds Google's Docker Hub cache to a Docker daemon config's registry mirrors, after any mirrors
// already listed and keeping every other key. The daemon tries its mirrors before falling back
// to Docker Hub; image references stay Docker Hub's, so a digest-pinned pull still checks the
// same bytes.
import { closeSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const mirror = "https://mirror.gcr.io";

/**
 * The config text with the mirror added once, or null when it is already listed.
 * Only a missing registry-mirrors key counts as no mirrors; an explicit null is refused.
 * @param {string | null} text the file's contents, or null when there is no file
 * @returns {string | null}
 */
export function withMirror(text) {
  if (text === null) return JSON.stringify({ "registry-mirrors": [mirror] }, null, 2) + "\n";
  const config = JSON.parse(text);
  if (config === null || typeof config !== "object" || Array.isArray(config))
    throw new Error("the Docker daemon config is not a JSON object");
  const mirrors = Object.hasOwn(config, "registry-mirrors") ? config["registry-mirrors"] : [];
  if (!Array.isArray(mirrors) || !mirrors.every((entry) => typeof entry === "string"))
    throw new Error("registry-mirrors in the Docker daemon config is not a list of strings");
  if (mirrors.some((entry) => entry.replace(/\/+$/, "") === mirror)) return null;
  config["registry-mirrors"] = [...mirrors, mirror];
  return JSON.stringify(config, null, 2) + "\n";
}

/** @typedef {{ mode: number, uid: number, gid: number }} Metadata */

/**
 * The config's bytes and metadata, or null when there is none. A symbolic link or anything
 * other than a regular file is refused rather than replaced.
 * @param {string} path
 * @returns {(Metadata & { bytes: Buffer }) | null}
 */
export function readConfig(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${path} is a symbolic link; refusing to replace it`);
  if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
  return { bytes: readFileSync(path), mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
}

/**
 * Replaces path with bytes through a staged file in the same directory, giving it the exact
 * owner and mode first (whatever the umask), and removes the staged file if anything fails.
 * @param {string} path
 * @param {Buffer} bytes
 * @param {Metadata} metadata
 */
export function publish(path, bytes, { mode, uid, gid }) {
  const staged = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const fd = openSync(staged, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      const stat = fstatSync(fd);
      // Ownership before mode: chown can clear set-id bits.
      if (stat.uid !== uid || stat.gid !== gid) fchownSync(fd, uid, gid);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    renameSync(staged, path);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}

/**
 * Adds the mirror to the config at path (creating it if absent) and says whether it changed.
 * A config that is refused is left as it is.
 * @param {string} path
 * @returns {boolean}
 */
export function addMirror(path) {
  const original = readConfig(path);
  const next = withMirror(original === null ? null : original.bytes.toString("utf8"));
  if (next === null) return false;
  // A new file is 0644 and owned by the writer, which in CI is root.
  const metadata = original ?? { mode: 0o644, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  publish(path, Buffer.from(next, "utf8"), metadata);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, ...rest] = process.argv.slice(2);
  if (!path || rest.length > 0) throw new Error("usage: node scripts/ci-docker-hub-mirror.mjs <daemon.json>");
  // The same check as the shell script's: a safeguard against running it by accident, not proof of
  // where it runs, since the caller sets the environment.
  if (process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.env.CI !== "true")
    throw new Error("refusing to change Docker's configuration outside a GitHub-hosted runner (RUNNER_ENVIRONMENT=github-hosted and CI=true)");
  console.log(addMirror(path) ? "changed" : "unchanged");
}
