// link-capture.mjs: run by wrap/cc for the probe binary's final link, before the real driver runs
// it. Records the command line rustc gave `cc` and copies the inputs rustc deletes after linking,
// so that relink.mjs can run the same link again, as often as it likes, from the same objects:
//   node link-capture.mjs <the cc arguments>     (LINK_CAPTURE=<empty or missing directory>)
// The probe's final link is the one whose output (-o) is a file named probe or probe-<hash> under
// CARGO_TARGET_DIR (cargo 1.100 links into build/<package>/<hash>/out/probe, older cargo into
// deps/probe-<hash>); any other call returns at once. Copied: every rustc temporary directory the
// arguments name (a path component rustcXXXXXX, under the system's temporary directory or, with
// cargo 1.100, beside the output: the symbols object and anything else rustc wrote there) and
// every .o, .a or .rlib the arguments name under CARGO_TARGET_DIR (the objects thin LTO wrote for
// this link). The copies' paths replace the
// originals in the recorded command line (args.json: cwd, the output, the original and the
// recorded arguments, and the files copied with their sha256). Anything else the link reads (the
// sysroot's rlibs and its gcc-ld/ld.lld, the system's crt files and libraries) is left where it
// is and stays put for the life of the host. Fails, and so fails the build, on a response file
// (@file), a second capture into the same directory or no output.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createHash as hash } from "node:crypto";

const argv = process.argv.slice(2);
const fail = (why) => { console.error(`link-capture: ${why}`); process.exit(1); };
const at = argv.indexOf("-o");
if (at < 0 || !argv[at + 1]) fail("no -o in the link");
const out = argv[at + 1];
const target0 = process.env.CARGO_TARGET_DIR;
if (!/^probe(-[0-9a-f]+)?$/.test(basename(out)) || !target0 || !resolve(out).startsWith(resolve(target0) + "/")) process.exit(0);
const dir = process.env.LINK_CAPTURE;
if (!dir || !isAbsolute(dir)) fail("LINK_CAPTURE is not an absolute directory");
if (existsSync(join(dir, "args.json"))) fail(`${dir} already holds a capture: one link per build`);
const target = process.env.CARGO_TARGET_DIR;
if (!target || !isAbsolute(target)) fail("CARGO_TARGET_DIR is not an absolute directory");
for (const a of argv) if (a.startsWith("@")) fail(`a response file (${a}): not handled`);
mkdirSync(join(dir, "in"), { recursive: true });
const sha = (f) => hash("sha256").update(readFileSync(f)).digest("hex");
const copied = [];
// rustc's temporary directory: an absolute path whose last component is rustc and six characters
// (tempfile's default), followed by a file in it.
const tmpDirs = new Set();
for (const a of argv) for (const m of a.matchAll(/(?:\/[^/\s,=]+)*\/rustc[A-Za-z0-9]{6}(?=\/)/g)) if (statSync(m[0], { throwIfNoEntry: false })?.isDirectory()) tmpDirs.add(m[0]);
const swaps = new Map();
let n = 0;
for (const d of tmpDirs) {
  const to = join(dir, "in", `tmp${n++}`);
  cpSync(d, to, { recursive: true });
  swaps.set(d, to);
  copied.push({ from: d, to, kind: "rustc temporary directory" });
}
const recorded = argv.map((a) => {
  let r = a;
  for (const [from, to] of swaps) r = r.split(from).join(to);
  if (r === a && isAbsolute(a) && /\.(o|a|rlib)$/.test(a) && resolve(a).startsWith(resolve(target) + "/") && existsSync(a) && statSync(a).isFile()) {
    const to = join(dir, "in", `${String(n++).padStart(3, "0")}-${basename(a)}`);
    copyFileSync(a, to);
    copied.push({ from: a, to, kind: "target file", sha256: sha(to) });
    r = to;
  }
  return r;
});
writeFileSync(join(dir, "args.json"), JSON.stringify({ cwd: process.cwd(), out, original: argv, recorded, copied }, null, 1) + "\n");
console.error(`link-capture: ${out}: ${argv.length} arguments, ${copied.length} inputs copied to ${dir}`);