// Keeps benchmark raw data out of the tree (https://github.com/corten-run/corten/issues/1719).
// A full clone fetches every version of a committed file still reachable in history, even after a
// later commit deletes it, so a file under bench/ whose name ends in one of ARCHIVE's suffixes, or that is larger than 256 KiB
// (LIMIT), fails unless scripts/bench-size.allow lists its path with its exact blob ID. The name
// is matched, not the contents: a small archive under another name is not found. The list holds
// the files that were in the tree when this check came, which stay because their paths are cited
// and removing them at the tip shrinks no full clone (their blobs stay reachable in history).
//
// The list only shrinks. The check reads three things against a base, the commit a pull request
// merges into (below):
// 1. Every line of the list at the tip is in the base's list with the same path and blob. A new or
//    changed line fails, so a pull request cannot list its own file. A base with no list (before
//    this check came) accepts the tip's list only when every line is a file already in the base's
//    tree at that path and blob.
// 2. Every blob any commit between the base and the tip adds or changes under bench/, including
//    one a later commit deletes, is held to the rule: one that needs a listing passes only as the
//    same path and blob in the base's list. A merge keeps those commits, so each stays in every
//    clone whatever the tip holds.
// 3. The tip's tree: a listed file that changed fails, and a line whose file is gone, or is now
//    small and not an archive, fails as stale.
// A dependency lock file an app builds from is source input, not output, so the size limit does
// not apply to one whose path LOCKS (below) lists, when it and the manifest LOCKS names are
// regular files in the same directory of the same commit (not a directory, submodule or symbolic
// link of that name). Its blob may change (a dependency update) without an edit here. Any other
// lock file over the limit fails until its path is added to LOCKS, in this script, where review
// sees it: a name and a file beside it prove neither that it is a lock nor that anything builds
// from it. History holds a listed lock to its manifest in every commit between the base and the
// tip that changes either, so a manifest removed and later restored, or a lock deleted and added
// back alone, fails. An archive still fails. A path under bench/ that is not valid UTF-8, has a control character (a newline or
// a tab among them) or has a name starting or ending with a space fails as unsupported, shown as a
// JSON string. The rule for benchmark authors is in CONTRIBUTING.md (Benchmark results).
//
// The base is --base <revision>, else CORTEN_BENCH_SIZE_BASE, else the merge base of the tip and
// origin/main, also when the tip is a merge commit: a topic that has merged main has its own
// earlier commits behind its first parent, and they are part of what it brings. An all-zero base,
// GitHub's before for a push that creates a branch or tag, means the merge base with origin/main as it is when the
// check runs: a rerun after main has moved can check a different range, and a commit already on
// main brings no history (a push that creates main itself brings none). Such a check reads the tip
// and what is not yet on main, not the range the push brought. CI gives the base from its event:
// a pull request's merge commit's first parent, a tag push's before, or the last successful CI
// push to main. A manual run takes an explicit base. In GitHub Actions an unspecified base fails
// rather than guessing. When none resolves
// the check fails and says how to give one. A shallow clone fails, since the commits between the
// base and the tip may be missing and would go unread. It reads the commits as committed, not the
// working tree; untracked and ignored files are not read, and nothing is published or fetched.
// Usage: node scripts/bench-size.mjs [--base <revision>] [revision, HEAD by default]. Run by npm run check.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The largest file under bench/ the check accepts without a listing, in bytes. */
export const LIMIT = 256 * 1024;
/** An archive or a compressed file, by the end of its name. */
export const ARCHIVE = /\.(?:tar|tgz|gz|xz|zst|bz2|zip|7z)$/i;
/**
 * The dependency lock files allowed over the size limit, by path, each with the name of the
 * manifest that must be a regular file beside it in the same commit: source input an app builds
 * from, rewritten by every dependency update, so a new blob at a listed path needs no edit here. A
 * new lock over the limit is added here, in review; nothing else grants the exemption.
 * @type {ReadonlyMap<string, string>}
 */
export const LOCKS = new Map([
  ["bench/fullstack/apps/laravel/composer.lock", "composer.json"],
  ["bench/fullstack/apps/nuxt/package-lock.json", "package.json"],
  ["bench/live/apps/laravel/composer.lock", "composer.json"],
]);
/** A dependency lock file's name, only to say how one not in LOCKS may pass: the name grants nothing. */
const LOCK_NAME = /^(?:Cargo\.lock|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|mix\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|gradle\.lockfile|packages\.lock\.json)$/;
/** The grandfather list, as a path from the repository's root. */
export const LIST = "scripts/bench-size.allow";
/** The environment variable that names the base when --base does not. */
export const BASE_ENV = "CORTEN_BENCH_SIZE_BASE";
/** What to do instead of committing raw data. */
export const REMEDY =
  "Commit a report or summary small enough to diff, and keep the raw data outside the tree: a maintainer publishes it, and the committed provenance names where it can be fetched and its SHA-256 (CONTRIBUTING.md, Benchmark results). " +
  `${LIST} only shrinks: a line cannot be added or changed, even with the file it names.`;
const UNSUPPORTED = "rename it with valid UTF-8, no control characters and no name starting or ending with a space";

/**
 * A file in a tree. `mode` is Git's (100644, 100755, 120000 for a symbolic link, 040000 for a
 * directory, 160000 for a submodule); a hand-built entry without one is a regular file.
 * @typedef {{ key?: string, path: string, blob: string, size: number, mode?: string, unsupported?: string | null }} Entry
 */
/** @typedef {Entry & { commit: string }} Change */

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** GitHub's before for a push that creates its branch or tag: no commit. */
const ZERO = /^(?:0{40}|0{64})$/;

/** Whether an entry is a regular file, executable or not: not a symbolic link, directory or submodule. @param {Entry} entry */
export function regular(entry) {
  return entry.mode === undefined || entry.mode === "100644" || entry.mode === "100755";
}

/** Whether a path is a lock file in LOCKS or the manifest beside one. @param {string} path */
export function pairPath(path) {
  return LOCKS.has(path) || [...LOCKS].some(([lock, manifest]) => `${split(lock)[0]}/${manifest}` === path);
}

/**
 * Why a path cannot be checked, or null: a control character (a newline or a tab among them), or a
 * name in it that starts or ends with white space. @param {string} path
 */
export function unsupportedPath(path) {
  if (/\p{Cc}/u.test(path)) return "a control character";
  if (path.split("/").some((name) => name !== name.trim())) return "a name that starts or ends with white space";
  return null;
}

/**
 * A path as Git wrote it, in bytes: `key`, which is distinct for distinct bytes, the `path` to show
 * (a JSON string when it is unsupported) and why it is unsupported, or null.
 * @param {Buffer} bytes @returns {{ key: string, path: string, unsupported: string | null }}
 */
export function decodePath(bytes) {
  let text = "";
  try {
    text = utf8.decode(bytes);
  } catch {
    text = "";
  }
  if (!text || !Buffer.from(text, "utf8").equals(bytes)) {
    // Bytes that are not UTF-8: each byte past ASCII shown as \xHH. No valid path has a NUL, so
    // the key cannot be one's.
    const shown = [...bytes].map((b) => (b < 0x80 ? JSON.stringify(String.fromCharCode(b)).slice(1, -1) : `\\x${b.toString(16).padStart(2, "0")}`)).join("");
    return { key: `\0${bytes.toString("hex")}`, path: `"${shown}"`, unsupported: "not valid UTF-8" };
  }
  const why = unsupportedPath(text);
  return { key: text, path: why ? JSON.stringify(text) : text, unsupported: why };
}

/**
 * Git's output for `args`, as bytes. Git runs with `env`, by default this process's environment,
 * which a test passes without the caller's GIT_DIR. Pathspecs are literal.
 * @param {string} root @param {string[]} args @param {NodeJS.ProcessEnv} env @param {string} [input] @returns {Buffer}
 */
function git(root, args, env, input) {
  return execFileSync("git", ["--literal-pathspecs", "-c", "log.showSignature=false", "-c", "log.showRoot=true", ...args], {
    cwd: root, env, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 << 30,
  });
}

/** The NUL-separated records of `out`, without empty ones. @param {Buffer} out */
function records(out) {
  /** @type {Buffer[]} */
  const parts = [];
  for (let start = 0; start < out.length;) {
    let end = out.indexOf(0, start);
    if (end === -1) end = out.length;
    if (end > start) parts.push(out.subarray(start, end));
    start = end + 1;
  }
  return parts;
}

/**
 * The full ID of the commit `rev` names. Throws when it names none, including an option-like one.
 * @param {string} root @param {string} rev @param {NodeJS.ProcessEnv} [env]
 */
export function commitOf(root, rev, env = process.env) {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], env).toString().trim();
  } catch {
    throw new Error(`bench-size: ${JSON.stringify(rev)} is not a commit in this repository (fetch it, with its history)`);
  }
}

/**
 * The commit the tip is checked against and how it was chosen: `base` (--base), else `env`'s
 * CORTEN_BENCH_SIZE_BASE, else the merge base with origin/main (also for a merge commit; parent
 * order says nothing about which side is the target). Throws, saying how to give one, when none resolves.
 * @param {string} root @param {{ head: string, base?: string, env?: NodeJS.ProcessEnv }} options
 * @returns {{ sha: string, how: string }}
 */
export function resolveBase(root, { head, base, env = process.env }) {
  const given = base ? { rev: base, how: "--base" } : env[BASE_ENV] ? { rev: /** @type {string} */ (env[BASE_ENV]), how: BASE_ENV } : null;
  if (given && ZERO.test(given.rev)) {
    try {
      return { sha: git(root, ["merge-base", commitOf(root, head, env), "refs/remotes/origin/main"], env).toString().trim(), how: "the merge base with origin/main, for a new branch or tag (an all-zero base)" };
    } catch {
      throw new Error(`bench-size: an all-zero base (${given.how}) is a new branch or tag, and ${head} has no merge base with origin/main; fetch origin/main with its history, or give the commit the change merges into`);
    }
  }
  if (given) return { sha: commitOf(root, given.rev, env), how: given.how };
  if (env.GITHUB_ACTIONS === "true") {
    throw new Error(
      `bench-size: in GitHub Actions the base must be given, not guessed: a push to main has already moved origin/main to the tip. ` +
        `Set ${BASE_ENV} from the event, as .github/workflows/ci.yml does.`,
    );
  }
  const tip = commitOf(root, head, env);
  try {
    return { sha: git(root, ["merge-base", tip, "refs/remotes/origin/main"], env).toString().trim(), how: "the merge base with origin/main" };
  } catch {
    throw new Error(
      `bench-size: no base to check ${head} against: it has no merge base with origin/main (fetch it, with its history). ` +
        `Give the commit the change merges into with --base <revision> or ${BASE_ENV}.`,
    );
  }
}

/**
 * Every blob under bench/ in `rev`, with its size, from `git ls-tree`.
 * @param {string} root @param {string} [rev] @param {NodeJS.ProcessEnv} [env] @returns {Entry[]}
 */
export function tracked(root, rev = "HEAD", env = process.env) {
  const out = git(root, ["ls-tree", "-r", "-l", "-z", "--full-tree", "--end-of-options", rev, "--", "bench/"], env);
  return records(out).flatMap((record) => {
    const tab = record.indexOf(9);
    const [mode, type, blob, size] = record.subarray(0, tab).toString("latin1").split(/ +/);
    // A submodule is a commit, with no size; it is not a file of this repository.
    if (type !== "blob") return [];
    return [{ ...decodePath(record.subarray(tab + 1)), blob, size: Number(size), mode }];
  });
}

/**
 * The entries directly in `dir` in `commit`'s tree, of every kind, each with its mode: a directory
 * or submodule has size 0.
 * @param {string} root @param {string} commit @param {string} dir @param {NodeJS.ProcessEnv} [env] @returns {Entry[]}
 */
export function directoryIn(root, commit, dir, env = process.env) {
  const out = git(root, ["ls-tree", "-l", "-z", "--full-tree", "--end-of-options", commit, "--", `${dir}/`], env);
  return records(out).map((record) => {
    const tab = record.indexOf(9);
    const [mode, , blob, size] = record.subarray(0, tab).toString("latin1").split(/ +/);
    return { ...decodePath(record.subarray(tab + 1)), blob, size: size === "-" ? 0 : Number(size), mode };
  });
}

/**
 * The list as committed in `rev`: its text, or null when `rev` has no such file.
 * @param {string} root @param {string} [rev] @param {NodeJS.ProcessEnv} [env] @returns {string | null}
 */
export function committedList(root, rev = "HEAD", env = process.env) {
  try {
    return git(root, ["cat-file", "blob", `${rev}:${LIST}`], env).toString("utf8");
  } catch {
    return null;
  }
}

/** The directory of a path and its name. @param {string} path */
function split(path) {
  const slash = path.lastIndexOf("/");
  return [path.slice(0, slash), path.slice(slash + 1)];
}

/**
 * Whether `path` is a lock file in LOCKS with its manifest among `siblings`, the names of the
 * regular files in its directory in the same commit. @param {string} path @param {ReadonlySet<string> | undefined} siblings
 */
export function exemptLock(path, siblings) {
  const manifest = LOCKS.get(path);
  return manifest !== undefined && siblings !== undefined && siblings.has(manifest);
}

/**
 * Why an entry needs a listing, or null when it needs none. `siblings` are the names in its
 * directory in the same commit, which a lock file's manifest must be among.
 * @param {Entry} entry @param {ReadonlySet<string>} [siblings]
 */
export function reason(entry, siblings) {
  const archive = ARCHIVE.exec(entry.path);
  if (archive) return `an archive or compressed file (${archive[0]})`;
  if (entry.size <= LIMIT || (regular(entry) && exemptLock(entry.path, siblings))) return null;
  const over = `${(entry.size / 1024).toFixed(1)} KiB (${entry.size} bytes), over the ${LIMIT / 1024} KiB limit`;
  const manifest = LOCKS.get(entry.path);
  if (manifest !== undefined) return `${over} (a lock file in LOCKS is exempt only as a regular file beside its manifest, ${manifest})`;
  if (LOCK_NAME.test(split(entry.path)[1])) return `${over} (a lock file over the limit passes only at a path in LOCKS in scripts/bench-size.mjs, beside its manifest: add its path there, for review)`;
  return over;
}

/**
 * The names of the regular files in each directory of `entries`, by directory: a manifest is one
 * of them, not a directory, submodule or symbolic link of its name. @param {Entry[]} entries
 */
function directories(entries) {
  /** @type {Map<string, Set<string>>} */
  const dirs = new Map();
  for (const entry of entries) {
    if (entry.unsupported || !regular(entry)) continue;
    const [dir, name] = split(entry.path);
    dirs.set(dir, (dirs.get(dir) ?? new Set()).add(name));
  }
  return dirs;
}

/**
 * The list's lines, each a blob ID and a path, the line each is on, and its problems: a line not in
 * that form or with an unsupported path, a path listed twice, or lines not sorted by path. Empty
 * lines and lines starting with `#` are skipped.
 * @param {string} text @returns {{ listed: Map<string, string>, lines: Map<string, number>, problems: string[] }}
 */
export function parseList(text) {
  /** @type {Map<string, string>} */
  const listed = new Map();
  /** @type {Map<string, number>} */
  const lines = new Map();
  /** @type {string[]} */
  const problems = [];
  let last = "";
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) return;
    const at = `${LIST}:${i + 1}`;
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S(?:.*\S)?)$/.exec(line);
    if (!m) {
      problems.push(`${at}: ${JSON.stringify(line)} is not "<blob ID> <path>"`);
      return;
    }
    const [, blob, path] = m;
    const why = unsupportedPath(path);
    if (why) {
      problems.push(`${at}: ${JSON.stringify(path)} has ${why}`);
      return;
    }
    if (listed.has(path)) problems.push(`${at}: ${path} is listed twice`);
    else if (path < last) problems.push(`${at}: ${path} comes before ${last}; keep the lines sorted by path`);
    listed.set(path, blob);
    lines.set(path, i + 1);
    last = path;
  });
  return { listed, lines, problems };
}

/**
 * The problems with `entries` (the tip's blobs; those outside bench/ are not read) against the
 * list's `text`: an unsupported path, a file that needs a listing and has none, a listed file whose
 * blob is not the listed one, and a line whose file is gone or no longer needs it.
 * @param {Entry[]} entries @param {string} text @returns {string[]}
 */
export function check(entries, text) {
  const { listed, problems } = parseList(text);
  const bench = entries.filter((e) => e.unsupported || e.path.startsWith("bench/"));
  /** @type {Map<string, Entry>} */
  const byKey = new Map(bench.map((e) => [e.key ?? e.path, e]));
  const dirs = directories(bench);
  for (const entry of byKey.values()) {
    if (entry.unsupported) {
      problems.push(`${entry.path}: an unsupported path under bench/ (${entry.unsupported}); ${UNSUPPORTED}`);
      continue;
    }
    const why = reason(entry, dirs.get(split(entry.path)[0]));
    if (!why) continue;
    const blob = listed.get(entry.path);
    if (blob === undefined) problems.push(`${entry.path}: ${why}, not in ${LIST}`);
    else if (blob !== entry.blob) {
      problems.push(`${entry.path}: ${why}, changed from the listed blob ${blob} to ${entry.blob}; a listed file stays as it is`);
    }
  }
  for (const [path, blob] of listed) {
    const entry = byKey.get(path);
    if (!entry) problems.push(`${LIST}: ${path} (${blob}) is no longer in the tree; remove its line`);
    else if (!reason(entry, dirs.get(split(path)[0]))) problems.push(`${LIST}: ${path} is no longer an archive or over ${LIMIT / 1024} KiB; remove its line`);
  }
  return problems;
}

/**
 * The lines of the tip's list (`text`) that are not the base's: with a base list (`baseText`), a
 * line not in it at the same path and blob; with none, a line whose file is not in the base's tree
 * (`baseEntries`) at that path and blob. Returns those problems and the lines a commit's file may
 * match: the base's list, or with none, the tip's lines that are in the base's tree.
 * @param {string} text @param {string | null} baseText @param {Entry[]} baseEntries @param {string} base
 * @returns {{ trusted: Map<string, string>, problems: string[] }}
 */
export function grandfathered(text, baseText, baseEntries, base) {
  const { listed, lines } = parseList(text);
  /** @type {string[]} */
  const problems = [];
  if (baseText !== null) {
    const trusted = parseList(baseText).listed;
    for (const [path, blob] of listed) {
      if (trusted.get(path) === blob) continue;
      const was = trusted.get(path);
      problems.push(
        `${LIST}:${lines.get(path)}: ${path} (${blob}) is ${was ? `listed at ${was}` : "not listed"} in the base ${base}'s list; the list only shrinks, so a line is never added or changed`,
      );
    }
    return { trusted, problems };
  }
  /** @type {Map<string, string>} */
  const trusted = new Map();
  const tree = new Map(baseEntries.map((e) => [e.key ?? e.path, e.blob]));
  for (const [path, blob] of listed) {
    if (tree.get(path) === blob) trusted.set(path, blob);
    else problems.push(`${LIST}:${lines.get(path)}: ${path} (${blob}) is not in the base ${base}, which has no list, at that path and blob; a first list holds only files already there`);
  }
  return { trusted, problems };
}

/**
 * What a commit in `base`..`head` brings under bench/ (merges against each parent): `changes`, each
 * blob it adds or changes, once for each path and blob, with the earliest commit that has it and its
 * size; and `pairs`, each commit and directory where a lock file in LOCKS or its manifest was
 * added, changed, deleted or changed mode, in commit order, so the pairing is checked in every commit it changes.
 * @param {string} root @param {string} base @param {string} head @param {NodeJS.ProcessEnv} [env]
 * @returns {{ changes: Change[], pairs: { commit: string, dir: string }[] }}
 */
export function history(root, base, head, env = process.env) {
  const out = git(root, ["log", "--raw", "-z", "--no-abbrev", "-m", "--no-renames", "--no-color", "--no-ext-diff", "--reverse", "--format=%H", `${base}..${head}`], env);
  /** @type {Map<string, Omit<Change, "size">>} */
  const seen = new Map();
  /** @type {Map<string, { commit: string, dir: string }>} */
  const pairs = new Map();
  const parts = records(out);
  let commit = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i][0] === 0x0a ? parts[i].subarray(1) : parts[i];
    if (part.length === 0) continue;
    const text = part.toString("latin1");
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(text)) {
      commit = text;
      continue;
    }
    const m = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])\d*$/.exec(text);
    const pathBytes = parts[++i];
    if (!m || !commit || !pathBytes) throw new Error(`bench-size: unexpected git log output ${JSON.stringify(text)}`);
    const [, mode, blob, status] = m;
    if (!pathBytes.subarray(0, 6).equals(Buffer.from("bench/"))) continue;
    const path = decodePath(pathBytes);
    if (!path.unsupported) {
      if (pairPath(path.path)) {
        const dir = split(path.path)[0];
        pairs.set(`${commit}\0${dir}`, { commit, dir });
      }
    }
    // A deletion has no new blob, and a submodule is a commit, not a file of this repository.
    if (status === "D" || mode === "160000" || /^0+$/.test(blob)) continue;
    const id = `${path.key}\0${blob}`;
    if (!seen.has(id)) seen.set(id, { ...path, blob, mode, commit });
  }
  const found = [...seen.values()];
  if (found.length === 0) return { changes: [], pairs: [...pairs.values()] };
  const ids = [...new Set(found.map((c) => c.blob))];
  const sizes = new Map(
    git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], env, ids.join("\n") + "\n")
      .toString("latin1").trim().split("\n").map((line) => {
        const [id, type, size] = line.split(" ");
        if (type === "missing" || size === undefined) throw new Error(`bench-size: blob ${id} is not in this repository`);
        return [id, Number(size)];
      }),
  );
  return { changes: found.map((c) => ({ ...c, size: /** @type {number} */ (sizes.get(c.blob)) })), pairs: [...pairs.values()] };
}

/** Whether a lock file's exemption decides `entry`: a path in LOCKS, over the limit and not an archive. @param {Entry} entry */
function lockSized(entry) {
  return LOCKS.has(entry.path) && entry.size > LIMIT && !ARCHIVE.test(entry.path);
}

/**
 * The problems with `changes` and `pairs` (history()'s): an unsupported path, and a blob that needs
 * a listing and is not that path and blob in `trusted`. A lock file over the limit is held to its
 * manifest in each commit and directory of `pairs`, whose entries `directory` gives; every commit
 * that adds or changes one is among them.
 * @param {{ changes: Change[], pairs: { commit: string, dir: string }[] }} brought @param {Map<string, string>} trusted
 * @param {(commit: string, dir: string) => Entry[]} directory @returns {string[]}
 */
export function checkHistory({ changes, pairs }, trusted, directory) {
  /** @type {string[]} */
  const problems = [];
  const fail = (/** @type {Entry} */ entry, /** @type {string} */ why, /** @type {string} */ commit) =>
    problems.push(
      `${entry.path}: ${why}, at blob ${entry.blob} from commit ${commit}, which is not that path and blob in the base's list; a merged commit stays in a full clone's history even when a later one deletes the file`,
    );
  for (const change of changes) {
    if (change.unsupported) {
      problems.push(`${change.path}: an unsupported path under bench/ (${change.unsupported}), in commit ${change.commit}; ${UNSUPPORTED}`);
      continue;
    }
    if (lockSized(change)) continue;
    const why = reason(change);
    if (why && trusted.get(change.path) !== change.blob) fail(change, why, change.commit);
  }
  /** @type {Set<string>} */
  const reported = new Set();
  for (const { commit, dir } of pairs) {
    const entries = directory(commit, dir);
    const siblings = directories(entries).get(dir);
    for (const entry of entries) {
      if (entry.unsupported || !lockSized(entry)) continue;
      const why = reason(entry, siblings);
      const id = `${entry.path}\0${entry.blob}`;
      if (!why || trusted.get(entry.path) === entry.blob || reported.has(id)) continue;
      reported.add(id);
      fail(entry, why, commit);
    }
  }
  return problems;
}

/**
 * Every check, for `head` (HEAD by default) against its base (resolveBase()). Throws when the clone
 * is shallow, no base resolves or a revision is not a commit.
 * @param {string} root @param {{ head?: string, base?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ problems: string[], entries: Entry[], head: string, base: { sha: string, how: string }, changes: Change[] }}
 */
export function run(root, { head = "HEAD", base, env = process.env } = {}) {
  if (git(root, ["rev-parse", "--is-shallow-repository"], env).toString().trim() === "true") {
    throw new Error(
      "bench-size: this clone is shallow, so commits between the base and the tip may be missing and would go unread; " +
        "fetch the whole history (git fetch --unshallow; actions/checkout with fetch-depth: 0)",
    );
  }
  const tip = commitOf(root, head, env);
  const from = resolveBase(root, { head: tip, base, env });
  const entries = tracked(root, tip, env);
  const text = committedList(root, tip, env);
  const brought = history(root, from.sha, tip, env);
  const { changes } = brought;
  if (text === null) return { problems: [`${head} has no ${LIST}`], entries, head: tip, base: from, changes };
  const baseText = committedList(root, from.sha, env);
  const { trusted, problems: listProblems } = grandfathered(text, baseText, baseText === null ? tracked(root, from.sha, env) : [], from.sha);
  const problems = [...check(entries, text), ...listProblems, ...checkHistory(brought, trusted, (commit, dir) => directoryIn(root, commit, dir, env))];
  return { problems, entries, head: tip, base: from, changes };
}
/** The list's text for `entries`: a line for each one that needs a listing, sorted by path. @param {Entry[]} entries */
export function listFor(entries) {
  const bench = entries.filter((e) => !e.unsupported && e.path.startsWith("bench/"));
  const dirs = directories(bench);
  const lines = bench.filter((e) => reason(e, dirs.get(split(e.path)[0]))).map((e) => `${e.blob} ${e.path}`);
  return lines.sort((a, b) => {
    const [pa, pb] = [a.slice(a.indexOf(" ") + 1), b.slice(b.indexOf(" ") + 1)];
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  }).join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const args = process.argv.slice(2);
  /** @type {string | undefined} */
  let head;
  /** @type {string | undefined} */
  let base;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--base" && args[i + 1] !== undefined) base = args[++i];
    else if (arg.startsWith("--base=")) base = arg.slice("--base=".length);
    else if (!arg.startsWith("-") && head === undefined) head = arg;
    else {
      console.error("usage: node scripts/bench-size.mjs [--base <revision>] [revision]");
      process.exit(2);
    }
  }
  let result;
  try {
    result = run(root, { head: head ?? "HEAD", base });
  } catch (error) {
    console.error(/** @type {Error} */ (error).message);
    process.exit(1);
  }
  const { problems, entries, base: from, changes } = result;
  const at = head ?? "HEAD";
  // Thousands when this was written: none means the tree was not read, not that bench/ is clean.
  if (entries.length < 100) problems.push(`found only ${entries.length} files under bench/ at ${at}`);
  if (problems.length) {
    console.error(`bench-size: ${problems.length} problem(s) at ${at} against ${from.sha} (${from.how})\n${problems.join("\n")}\n${REMEDY}`);
    process.exit(1);
  }
  const dirs = directories(entries);
  const kept = entries.filter((e) => reason(e, dirs.get(split(e.path)[0])));
  console.log(
    `bench-size: ${entries.length} files under bench/ at ${at}; ${kept.length} archives or files over ${LIMIT / 1024} KiB (${kept.reduce((n, e) => n + e.size, 0)} bytes), each at its listed blob; ` +
      `${changes.length} blobs added or changed under bench/ since ${from.sha} (${from.how})`,
  );
}
