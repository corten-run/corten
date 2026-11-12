// Evidence for docs/design.md#choice-data-on-single-quoted (corten-run/corten#1281), not part of
// Corten: what a minimal reader of a `<script type="application/json">` data block costs the runtime.
// This commit adds the reader to crates/corten/js (an `&id` argument in on.js, read with
// getElementById and JSON.parse in corten.js); this script bundles and minifies the runtime as it is
// here and as it is in the parent commit, and prints each one's bytes raw, gzip -9 and brotli.
//   npm ci && node block-reader-size.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { build } from "esbuild";
import { minify } from "terser";

const root = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
/** @param {string} dir */
async function size(dir) {
  const r = await build({ entryPoints: [join(dir, "corten.js")], bundle: true, format: "esm", minify: true, target: "es2022", legalComments: "none", write: false });
  const code = /** @type {string} */ ((await minify(r.outputFiles[0].text, { module: true, ecma: 2022, compress: { passes: 2 } })).code);
  return { raw: code.length, gzip: gzipSync(code, { level: 9 }).length, br: brotliCompressSync(code).length };
}
const parent = mkdtempSync(join(tmpdir(), "block-reader-parent-"));
try {
  const git = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  for (const file of git(["ls-tree", "--name-only", "HEAD^:crates/corten/js"]).split("\n").filter((f) => f.endsWith(".js"))) {
    writeFileSync(join(parent, file), git(["show", `HEAD^:crates/corten/js/${file}`]));
  }
  const before = await size(parent);
  const after = await size(join(root, "crates", "corten", "js"));
  console.log(JSON.stringify({ before, after, added: { raw: after.raw - before.raw, gzip: after.gzip - before.gzip, br: after.br - before.br } }));
} finally {
  rmSync(parent, { recursive: true, force: true });
}
