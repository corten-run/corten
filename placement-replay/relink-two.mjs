// relink-two.mjs: the kit's captured link run again with the first pad, the ordering file that
// names it, a second pad object the ordering file does not name, and LLD's map:
//   node relink-two.mjs <capture dir> <absolute output> <absolute map file> <pad object> <symbol ordering file> <second pad object>
// The second pad is given last on the link line, so LLD lays its section last in .text.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const [, , dir, out, map, pad, order, pad2] = process.argv;
if (!pad2) throw new Error("usage: node relink-two.mjs <capture dir> <output> <map> <pad object> <ordering file> <second pad object>");
const cap = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
const args = [...cap.recorded];
const at = args.indexOf("-o");
if (at < 0) throw new Error("no -o in the capture");
args[at + 1] = out;
args.push(pad, `-Wl,--symbol-ordering-file=${order}`, pad2, `-Wl,-Map=${map}`);
const r = spawnSync("/usr/bin/cc", args, { cwd: cap.cwd, stdio: "inherit" });
if (r.error) throw r.error;
process.exit(r.status ?? 1);
