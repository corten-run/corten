// relink.mjs: runs a captured link again (link-capture.mjs's args.json) into another output:
//   node relink.mjs <capture dir> <output> [--map <file> [--no-demangle]] [--pad <object> --order <file> [--every-name]] [--second <object>]
// The recorded arguments are used as they are but for the output after -o; every path is
// absolute. --pad adds the first pad's object and -Wl,--symbol-ordering-file=<file>, which names
// that pad's function alone, so LLD places its section first in .text and every other input
// section after it in the order it would have had. --second adds the second pad's object after
// them, last on the link line and not named in the ordering file, so LLD lays its section last in
// .text. --map adds -Wl,-Map=<file>, and --no-demangle -Wl,--no-demangle, so the map writes each
// symbol as the symbol table does (a shuffled run's maps, which layout.mjs matches with it by
// name); it changes what LLD prints, not what it links. The driver is /usr/bin/cc in the recorded working directory,
// as rustc ran it (through wrap/cc).
// For a shuffled placement the ordering file names every function of .text after the pad
// (order.mjs), and --every-name fails the link when LLD warns that a name in it is no symbol
// ("symbol ordering file: no such symbol"), which LLD otherwise only warns of: such a name means
// the file was not made from this link's functions. LLD's other ordering warnings ("unable to order ...",
// for a copy of a name in a discarded section, say) are passed on as they are: layout.mjs checks
// the order the link has. Without --every-name the driver's output is passed on untouched.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (name) => { const i = argv.indexOf(name); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const everyName = flag("--every-name"), mangled = flag("--no-demangle");
const map = opt("--map"), pad = opt("--pad"), order = opt("--order"), second = opt("--second");
const [dir, out] = argv;
if (argv.length !== 2 || [out, map, pad, order, second].some((p) => p !== undefined && !isAbsolute(p)) || (pad === undefined) !== (order === undefined) || (second !== undefined && pad === undefined) || (everyName && order === undefined) || (mangled && map === undefined)) {
  console.error("usage: node relink.mjs <capture dir> <absolute output> [--map <file> [--no-demangle]] [--pad <object> --order <file> [--every-name]] [--second <object>]");
  process.exit(2);
}
const cap = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
const args = [...cap.recorded];
const at = args.indexOf("-o");
if (at < 0) throw new Error("no -o in the capture");
args[at + 1] = out;
if (pad !== undefined) args.push(pad, `-Wl,--symbol-ordering-file=${order}`);
if (second !== undefined) args.push(second);
if (map !== undefined) args.push(`-Wl,-Map=${map}`);
if (mangled) args.push("-Wl,--no-demangle");
const r = spawnSync("/usr/bin/cc", args, { cwd: cap.cwd, stdio: everyName ? ["inherit", "inherit", "pipe"] : "inherit", maxBuffer: 1 << 28 });
if (r.error) throw r.error;
if (everyName) {
  process.stderr.write(r.stderr);
  const missing = r.stderr.toString("utf8").split("\n").filter((l) => /symbol ordering file: no such symbol: /.test(l));
  if (missing.length) {
    console.error(`relink.mjs: ${missing.length} names of the ordering file ${order} are no symbol of the link, so the file was not made from its functions: ${missing.slice(0, 3).map((l) => l.replace(/^.*no such symbol: /, "")).join(", ")}`);
    process.exit(1);
  }
}
process.exit(r.status ?? 1);
