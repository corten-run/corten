// Packs a round's raw output into results/<round>/raw.tar.xz, beside the summaries the README is
// written from, so a round adds one archive to Git rather than a file for every run.
// Usage: node bench/fullstack/pack.mjs <round> (droplet.mjs runs it once a finished round is here)
//
// Kept as files: the summaries and the round's log (KEPT below). Packed: everything else in the
// round's folder (each app's k6, CPU and startup files, every count). The archive is listed back and
// each file is removed only once the listing has it, so nothing is lost if tar fails part way.
// summarize.mjs reads a packed round from its archive; `tar -xJf results/<round>/raw.tar.xz -C
// results/<round>` brings the files back for a look at one run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** What stays a file: what summarize.mjs writes, what the README and tests read, the log, and a
 * committed round's note of where its raw output is. */
export const KEPT = new Set([
  "summary.json",
  "run.log",
  "raw.txt",
  "commit.txt",
  "host.txt",
  "skipped.txt",
  "build.json",
  "docker-rebuild.json",
  "rust-analyzer.json",
  "bytes.json",
  "cold-start.json",
  "instructions.json",
  "browser.json",
  "conformance.json",
  "hardening.json",
  "trend.json",
]);
export const ARCHIVE = "raw.tar.xz";

/**
 * The folder a round's raw files are read from: dir itself, or, for a packed round, a temporary
 * folder its archive is unpacked into.
 * @param {string} dir
 */
export const rawOf = (dir) => {
  if (!existsSync(join(dir, ARCHIVE))) {
    // A round whose raw output left the tree has only its summaries: reading it would write an
    // empty summary over the committed one.
    if (existsSync(join(dir, "raw.txt")) && packed(dir).length === 0) {
      throw new Error(`${dir} keeps only its summaries; bring its raw files back first, as ${join(dir, "raw.txt")} says`);
    }
    return dir;
  }
  const out = mkdtempSync(join(tmpdir(), "corten-raw-"));
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));
  const unpacked = spawnSync("tar", ["-xJf", join(dir, ARCHIVE), "-C", out], { encoding: "utf8", timeout: 5 * 60_000 });
  if (unpacked.status !== 0) throw new Error(`tar could not unpack ${join(dir, ARCHIVE)}: ${unpacked.error ?? unpacked.stderr}`);
  return out;
};

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
export const pack = (dir, tar = (args) => spawnSync("tar", args, { encoding: "utf8", maxBuffer: 64 << 20, timeout: 5 * 60_000 })) => {
  const entries = packed(dir);
  if (entries.length === 0) return 0;
  const archive = join(dir, ARCHIVE);
  if (existsSync(archive)) {
    throw new Error(`${dir} has ${ARCHIVE} already and files beside it (${entries.join(", ")}): remove the files, or remove ${ARCHIVE} to pack them all again`);
  }
  if (!existsSync(join(dir, "summary.json"))) throw new Error(`${dir} has no summary.json: run summarize.mjs before its raw output is packed`);
  const root = resolve(dir);
  const files = filesOf(dir, entries);
  const paths = files.map((file) => {
    const path = resolve(root, file);
    if (!path.startsWith(root + sep)) throw new Error(`${file} is outside ${dir}`);
    return path;
  });
  // An archive tar did not write whole, or that does not list every file, is removed, so the
  // round is as it was and can be packed again.
  try {
    const made = tar(["-cJf", archive, "-C", dir, ...entries]);
    if (made.status !== 0) throw new Error(`tar could not write ${ARCHIVE}: ${made.error ?? made.stderr}`);
    const listed = tar(["-tJf", archive]);
    if (listed.status !== 0) throw new Error(`tar could not list ${ARCHIVE}: ${listed.error ?? listed.stderr}`);
    const has = new Set(listed.stdout.split("\n").map((line) => line.replace(/^\.\//, "").trim()));
    const missing = files.filter((file) => !has.has(file));
    if (missing.length > 0) throw new Error(`${ARCHIVE} lacks ${missing.length} file(s), so none was removed: ${missing.slice(0, 5).join(", ")}`);
  } catch (e) {
    rmSync(archive, { force: true });
    throw e;
  }
  for (const path of paths) unlinkSync(path);
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
