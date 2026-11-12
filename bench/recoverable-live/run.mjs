import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runRound } from "../live/parity.mjs";
export async function run(args) { return runRound("recoverable-live", args); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!await run(process.argv.slice(2))) process.exitCode = 1;
}
