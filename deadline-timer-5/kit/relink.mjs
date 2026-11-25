// relink.mjs: runs a captured link again (link-capture.mjs's args.json) into another output,
// unpadded or with a pad first in .text:
//   node relink.mjs <capture dir> <absolute output> [<pad object> <symbol ordering file>] [--map <file>]
// The recorded arguments are used as they are but for the output after -o. With --map, LLD
// writes its map of that link to the file (-Wl,-Map), which build.sh asks of each side's
// unpadded link (CONTRIBUTING, Pull requests, item 2, the plan's fifth point). With a pad, two
// arguments are added at the end: the pad object (one never-called function of the pad's size in
// a section of its own, kept from --gc-sections by its SHF_GNU_RETAIN flag) and
// -Wl,--symbol-ordering-file=<file>, which names only that function, so LLD places its section
// first in .text and every other input section after it in the order it would have had: every
// function moves by the pad and keeps its neighbours. The driver is /usr/bin/cc in the recorded
// working directory, as rustc ran it (through wrap/cc).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, isAbsolute } from "node:path";

const argv = process.argv.slice(2), mapAt = argv.indexOf("--map");
const map = mapAt < 0 ? undefined : argv.splice(mapAt, 2)[1];
const [dir, out, pad, order] = argv;
if (!dir || !out || !isAbsolute(out) || (pad !== undefined && (!isAbsolute(pad) || !order || !isAbsolute(order))) || (mapAt >= 0 && (!map || !isAbsolute(map)))) {
  console.error("usage: node relink.mjs <capture dir> <absolute output> [<absolute pad object> <absolute ordering file>] [--map <absolute file>]");
  process.exit(2);
}
const cap = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
const args = [...cap.recorded];
const at = args.indexOf("-o");
if (at < 0) throw new Error("no -o in the capture");
args[at + 1] = out;
if (pad !== undefined) args.push(pad, `-Wl,--symbol-ordering-file=${order}`);
if (map !== undefined) args.push(`-Wl,-Map=${map}`);
const r = spawnSync("/usr/bin/cc", args, { cwd: cap.cwd, stdio: "inherit" });
if (r.error) throw r.error;
process.exit(r.status ?? 1);