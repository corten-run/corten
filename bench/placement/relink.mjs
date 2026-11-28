// relink.mjs: runs a captured link again (link-capture.mjs's args.json) into another output:
//   node relink.mjs <capture dir> <output> [--map <file>] [--pad <object> --order <file>] [--second <object>]
// The recorded arguments are used as they are but for the output after -o; every path is
// absolute. --pad adds the first pad's object and -Wl,--symbol-ordering-file=<file>, which names
// that pad's function alone, so LLD places its section first in .text and every other input
// section after it in the order it would have had. --second adds the second pad's object after
// them, last on the link line and not named in the ordering file, so LLD lays its section last in
// .text. --map adds -Wl,-Map=<file>. The driver is /usr/bin/cc in the recorded working directory,
// as rustc ran it (through wrap/cc).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const map = opt("--map"), pad = opt("--pad"), order = opt("--order"), second = opt("--second");
const [dir, out] = argv;
if (argv.length !== 2 || [out, map, pad, order, second].some((p) => p !== undefined && !isAbsolute(p)) || (pad === undefined) !== (order === undefined) || (second !== undefined && pad === undefined)) {
  console.error("usage: node relink.mjs <capture dir> <absolute output> [--map <file>] [--pad <object> --order <file>] [--second <object>]");
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
const r = spawnSync("/usr/bin/cc", args, { cwd: cap.cwd, stdio: "inherit" });
if (r.error) throw r.error;
process.exit(r.status ?? 1);
