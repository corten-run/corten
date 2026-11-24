// relink-map.mjs: the kit's relink.mjs with one more argument, the linker's map:
//   node relink-map.mjs <capture dir> <absolute output> <absolute map file> [<pad object> <symbol ordering file>]
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const [, , dir, out, map, pad, order] = process.argv;
const cap = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
const args = [...cap.recorded];
const at = args.indexOf("-o");
if (at < 0) throw new Error("no -o in the capture");
args[at + 1] = out;
if (pad !== undefined) args.push(pad, `-Wl,--symbol-ordering-file=${order}`);
args.push(`-Wl,-Map=${map}`);
const r = spawnSync("/usr/bin/cc", args, { cwd: cap.cwd, stdio: "inherit" });
if (r.error) throw r.error;
process.exit(r.status ?? 1);
