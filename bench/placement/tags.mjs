// tags.mjs: reads files kept under the repository's evidence tags, for the kit's tests. The kept
// maps and an earlier run's counts are too large to copy into bench/ (scripts/bench-size.mjs), so
// the tests read them where they are kept. A clone without the tags gets them with
//   git fetch https://github.com/corten-run/corten.git "+refs/tags/evidence/*:refs/tags/evidence/*"
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = dirname(fileURLToPath(import.meta.url));
const git = (args, input) => {
  try { return execFileSync("git", args, { cwd, input, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (e) { throw new Error(`git ${args.join(" ")} failed (${String(e.stderr ?? e.message).trim()}): the tests read the evidence tags; see tags.mjs for the fetch that brings them`); }
};

/** One file under a tag, as bytes. */
export const blob = (tag, path) => git(["show", `refs/tags/${tag}:${path}`]);

/** Every file under a directory of a tag whose path, less the directory, `keep` accepts: Map of that path to bytes. */
export function blobs(tag, dir, keep) {
  const listed = git(["ls-tree", "-r", "--full-tree", `refs/tags/${tag}`, "--", dir]).toString("utf8").split("\n").map((l) => /^\d+ blob ([0-9a-f]+)\t(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ id: m[1], path: m[2].slice(dir.length + 1) })).filter((f) => keep(f.path));
  const out = git(["cat-file", "--batch"], listed.map((f) => `${f.id}\n`).join("")), files = new Map();
  let at = 0;
  for (const f of listed) {
    const end = out.indexOf(0x0a, at), size = Number(out.subarray(at, end).toString("utf8").split(" ")[2]);
    files.set(f.path, out.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return files;
}
