// Keeps benchmark raw data out of the tree (https://github.com/corten-run/corten/issues/1719).
// Every version of a committed file stays in every clone, even after it is deleted, so a file
// under bench/ that is an archive or a compressed file (ARCHIVE below), or larger than 256 KiB
// (LIMIT), fails unless scripts/bench-size.allow lists its path with its exact blob ID. The list
// holds the files that were in the tree when this check came, which stay because their paths are
// cited and removing them shrinks no clone (history keeps every blob). A listed file that changes
// fails too, and a line whose file is gone, or is now small and not an archive, fails as stale, so
// the list only shrinks. A dependency lock file an app builds from (LOCK) is source input, not
// output, so the size limit does not apply to it; any other file that is not benchmark output is
// listed deliberately, where review sees it. The rule for benchmark authors is in
// CONTRIBUTING.md (Benchmark results).
//
// It reads the tree and the list as committed at HEAD (or the revision given), not the working
// tree, so it checks what a pull request adds; untracked and ignored files are not read.
// Usage: node scripts/bench-size.mjs [revision]. Run by npm run check.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The largest file under bench/ the check accepts without a listing, in bytes. */
export const LIMIT = 256 * 1024;
/** An archive or a compressed file, by its name. */
export const ARCHIVE = /\.(?:tar|tgz|gz|xz|zst|bz2|zip|7z)$/i;
/**
 * A dependency lock file an app builds from, by its name: source input, not benchmark output, and
 * rewritten by every dependency update, so the size limit does not apply to it (an archive still does).
 */
export const LOCK = /(?:^|\/)(?:Cargo\.lock|composer\.lock|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|mix\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|gradle\.lockfile|packages\.lock\.json)$/;
/** The grandfather list, as a path from the repository's root. */
export const LIST = "scripts/bench-size.allow";
/** What to do instead of committing raw data. */
export const REMEDY =
  "Commit a report or summary small enough to diff, and keep the raw data outside the tree: the committed provenance names where it is published and its SHA-256 (CONTRIBUTING.md, Benchmark results). " +
  `A file that is not benchmark output (other than a dependency lock file, which the size limit skips) is listed in ${LIST} as "<blob ID> <path>" instead, in the same pull request, where review sees it.`;

/** @typedef {{ path: string, blob: string, size: number }} Entry */

/**
 * Every blob under bench/ in `rev`, with its size, from `git ls-tree`. Git runs with `env`, by
 * default this process's environment, which a test passes without the caller's GIT_DIR.
 * @param {string} root @param {string} [rev] @param {NodeJS.ProcessEnv} [env] @returns {Entry[]}
 */
export function tracked(root, rev = "HEAD", env = process.env) {
  const out = execFileSync("git", ["ls-tree", "-r", "-l", "-z", "--full-tree", rev, "--", "bench/"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, env,
  });
  return out.split("\0").filter(Boolean).flatMap((record) => {
    const tab = record.indexOf("\t");
    const [, type, blob, size] = record.slice(0, tab).split(/\s+/);
    // A submodule is a commit, with no size; it is not a file of this repository.
    if (type !== "blob") return [];
    return [{ path: record.slice(tab + 1), blob, size: Number(size) }];
  });
}

/**
 * The list as committed in `rev`: its text, or null when `rev` has no such file.
 * @param {string} root @param {string} [rev] @param {NodeJS.ProcessEnv} [env] @returns {string | null}
 */
export function committedList(root, rev = "HEAD", env = process.env) {
  try {
    return execFileSync("git", ["cat-file", "blob", `${rev}:${LIST}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  } catch {
    return null;
  }
}

/** Why an entry needs a listing, or null when it needs none. @param {Entry} entry */
export function reason(entry) {
  const archive = ARCHIVE.exec(entry.path);
  if (archive) return `an archive or compressed file (${archive[0]})`;
  if (entry.size > LIMIT && !LOCK.test(entry.path)) return `${(entry.size / 1024).toFixed(1)} KiB (${entry.size} bytes), over the ${LIMIT / 1024} KiB limit`;
  return null;
}

/**
 * The list's lines, each a blob ID and a path, and its problems: a line not in that form, a path
 * listed twice, or lines not sorted by path. Empty lines and lines starting with `#` are skipped.
 * @param {string} text @returns {{ listed: Map<string, string>, problems: string[] }}
 */
export function parseList(text) {
  /** @type {Map<string, string>} */
  const listed = new Map();
  /** @type {string[]} */
  const problems = [];
  let last = "";
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) return;
    const at = `${LIST}:${i + 1}`;
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S(?:.*\S)?)$/.exec(line);
    if (!m) {
      problems.push(`${at}: "${line}" is not "<blob ID> <path>"`);
      return;
    }
    const [, blob, path] = m;
    if (listed.has(path)) problems.push(`${at}: ${path} is listed twice`);
    else if (path < last) problems.push(`${at}: ${path} comes before ${last}; keep the lines sorted by path`);
    listed.set(path, blob);
    last = path;
  });
  return { listed, problems };
}

/**
 * The problems with `entries` (the tree's blobs; those outside bench/ are not read) against the
 * list's `text`: a file that needs a listing and has none, a listed file whose blob is not the
 * listed one, and a line whose file is gone or no longer needs it.
 * @param {Entry[]} entries @param {string} text @returns {string[]}
 */
export function check(entries, text) {
  const { listed, problems } = parseList(text);
  /** @type {Map<string, Entry>} */
  const byPath = new Map(entries.filter((e) => e.path.startsWith("bench/")).map((e) => [e.path, e]));
  for (const entry of byPath.values()) {
    const why = reason(entry);
    if (!why) continue;
    const blob = listed.get(entry.path);
    if (blob === undefined) problems.push(`${entry.path}: ${why}, not in ${LIST}`);
    else if (blob !== entry.blob) {
      problems.push(`${entry.path}: ${why}, changed from the listed blob ${blob} to ${entry.blob}; a listed file stays as it is`);
    }
  }
  for (const [path, blob] of listed) {
    const entry = byPath.get(path);
    if (!entry) problems.push(`${LIST}: ${path} (${blob}) is no longer in the tree; remove its line`);
    else if (!reason(entry)) problems.push(`${LIST}: ${path} is no longer an archive or over ${LIMIT / 1024} KiB; remove its line`);
  }
  return problems;
}

/** The list's text for `entries`: a line for each one that needs a listing, sorted by path. @param {Entry[]} entries */
export function listFor(entries) {
  const lines = entries.filter((e) => e.path.startsWith("bench/") && reason(e)).map((e) => `${e.blob} ${e.path}`);
  return lines.sort((a, b) => {
    const [pa, pb] = [a.slice(a.indexOf(" ") + 1), b.slice(b.indexOf(" ") + 1)];
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  }).join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const rev = process.argv[2] ?? "HEAD";
  const entries = tracked(root, rev);
  const text = committedList(root, rev);
  const problems = text === null ? [`${rev} has no ${LIST}`] : check(entries, text);
  // Thousands when this was written: none means the tree was not read, not that bench/ is clean.
  if (entries.length < 100) problems.push(`found only ${entries.length} files under bench/ at ${rev}`);
  if (problems.length) {
    console.error(`bench-size: ${problems.length} problem(s)\n${problems.join("\n")}\n${REMEDY}`);
    process.exit(1);
  }
  const kept = entries.filter((e) => reason(e));
  console.log(
    `bench-size: ${entries.length} files under bench/ at ${rev}; ${kept.length} archives or files over ${LIMIT / 1024} KiB (${kept.reduce((n, e) => n + e.size, 0)} bytes), each at its listed blob`,
  );
}
