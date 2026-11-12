// Mechanical docs generation only; never writes evidence or runs a benchmark.
import { readFileSync, writeFileSync } from "node:fs";
import { markdown } from "./plan.mjs";
const file = new URL("README.md", import.meta.url);
const original = readFileSync(file, "utf8");
const start = "<!-- groups:start -->\n", end = "<!-- groups:end -->";
const at = original.indexOf(start), to = original.indexOf(end);
if (at < 0 || to < at || original.indexOf(start, at + 1) !== -1 || original.indexOf(end, to + 1) !== -1) throw new Error("group table markers missing or duplicate");
writeFileSync(file, `${original.slice(0, at + start.length)}${markdown()}\n${original.slice(to)}`);
