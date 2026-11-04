// Packs a round's raw output into results/<round>/raw.tar.xz, beside the summaries the README is
// written from, so a round adds one archive to Git rather than a file for every run.
// Usage: node bench/fullstack/pack.mjs <round> (droplet.mjs runs it once a finished round is here)
//
// Kept as files: the summaries (KEPT below). Packed: everything else in the round's folder (each
// app's k6, CPU and startup files, every count, the round's log). The archive is listed back and
// each file is removed only once the listing has it, so nothing is lost if tar fails part way.
// `tar -xJf results/<round>/raw.tar.xz -C results/<round>` brings the files back, for
// summarize.mjs or a look at one run.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** What stays a file: what summarize.mjs writes and the README and tests read. */
export const KEPT = new Set([
  "summary.json",
  "commit.txt",
  "host.txt",
  "skipped.txt",
  "build.json",
  "bytes.json",
  "cold-start.json",
  "instructions.json",
  "browser.json",
  "conformance.json",
]);
export const ARCHIVE = "raw.tar.xz";

/** The round's entries that go in the archive, in name order. */
export const packed = (/** @type {string} */ dir) =>
  readdirSync(dir)
    .filter((name) => !KEPT.has(name) && name !== ARCHIVE)
    .sort();

/** Every file under the given entries of dir, as tar lists them (forward slashes). */
export const filesOf = (/** @type {string} */ dir, /** @type {string[]} */ entries) => {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ path) => {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
    else out.push(relative(dir, path).split(sep).join("/"));
  };
  for (const entry of entries) walk(join(dir, entry));
  return out;
};

/**
 * Packs dir's raw output and removes it. Returns the number of files packed; 0 when there is
 * nothing to pack. Throws, leaving every file in place, when the round has no summary, is packed
 * already, or the archive does not list a file.
 * @param {string} dir
 * @param {(args: string[]) => { status: number | null, stdout: string, stderr: string }} [tar]
 */
export const pack = (dir, tar = (args) => spawnSync("tar", args, { encoding: "utf8", maxBuffer: 64 << 20 })) => {
  const entries = packed(dir);
  if (entries.length === 0) return 0;
  if (existsSync(join(dir, ARCHIVE))) throw new Error(`${dir} has ${ARCHIVE} already and files beside it: ${entries.join(", ")}`);
  if (!existsSync(join(dir, "summary.json"))) throw new Error(`${dir} has no summary.json: run summarize.mjs before its raw output is packed`);
  const files = filesOf(dir, entries);
  const made = tar(["-cJf", join(dir, ARCHIVE), "-C", dir, ...entries]);
  if (made.status !== 0) throw new Error(`tar could not write ${ARCHIVE}: ${made.stderr}`);
  const listed = tar(["-tJf", join(dir, ARCHIVE)]);
  if (listed.status !== 0) throw new Error(`tar could not list ${ARCHIVE}: ${listed.stderr}`);
  const has = new Set(listed.stdout.split("\n").map((line) => line.replace(/^\.\//, "").trim()));
  const missing = files.filter((file) => !has.has(file));
  if (missing.length > 0) throw new Error(`${ARCHIVE} lacks ${missing.length} file(s), so none was removed: ${missing.slice(0, 5).join(", ")}`);
  const root = resolve(dir);
  for (const file of files) {
    const path = resolve(root, file);
    if (!path.startsWith(root + sep)) throw new Error(`${file} is outside ${dir}`);
    unlinkSync(path);
  }
  // The folders left are empty now: the deepest first.
  for (const entry of entries) {
    const emptied = (/** @type {string} */ path) => {
      if (!existsSync(path) || !statSync(path).isDirectory()) return;
      for (const name of readdirSync(path)) emptied(join(path, name));
      rmdirSync(path);
    };
    emptied(join(root, entry));
  }
  return files.length;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const round = process.argv[2];
  if (!round || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(round)) throw new Error("usage: node bench/fullstack/pack.mjs <round>");
  const dir = join(import.meta.dirname, "results", round);
  const n = pack(dir);
  console.log(n === 0 ? `${round}: nothing to pack` : `${round}: ${n} files in ${join(dir, ARCHIVE)}`);
}
