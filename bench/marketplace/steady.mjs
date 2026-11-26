// Convergence and soak passes for marketplace v2 (#1851), separate from the timed rounds: this
// runner changes no timed phase, warmup, rate, droplet job or saved round. Each adapter, source and
// target gets a fresh container, started the way run.mjs starts one before a timed warmup (created,
// then started while a sidecar polls the target's path to its first 200), and then one long k6 pass
// (window-load.js) whose answers are counted per window. steady-run.mjs does the work.
//   convergence: a closed loop (the timed warmup's 32 users, 5 minutes in 15 s windows by default);
//                the tolerance reading in steady-contract.mjs says from which window each
//                adapter's throughput stayed within stated bounds to the end; a screening reading,
//                not a certificate of steady state. A pass with any failed request (in a window or
//                in k6's aggregate), or whose app stopped, restarted or was OOM-killed, gets none.
//   soak:        a fixed rate (150 requests/second, 30 minutes in 60 s intervals by default), with
//                memory at the start and end, p99 per interval and any restart.
// node bench/marketplace/steady.mjs convergence w3 --group production --build
// node bench/marketplace/steady.mjs soak w4 --group production --admitted-from bench/marketplace/results/w2/summary.json
// Results: bench/marketplace/results/<convergence|soak>/<name>/summary.json; read them with steady-report.mjs.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory } from "./run-contract.mjs";
import { groupApps } from "./groups.mjs";
import { commandRunner } from "../catalog/output.mjs";
import { parseSteadyArgs } from "./steady-contract.mjs";
import { combinedRunner, passRunId, runSteady } from "./steady-run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const options = parseSteadyArgs(process.argv.slice(2), Object.keys(inventory), groupApps);
// The pass's name stays in its run ID and summary; Docker names come from a hash of it (containerBase).
const runId = passRunId(options.kind, options.name);
let interrupted = false;
const { command, interrupt } = commandRunner({ cwd: repo, interrupted: () => interrupted, interruptMessage: `marketplace ${options.kind} pass interrupted` });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; interrupt(); });
// A container log keeps its stderr as well as its stdout (combinedRunner); every other command is
// Catalog's runner as it is.
const summary = await runSteady({ options, folder: join(here, "results", options.kind, options.name), runId,
  docker: combinedRunner(command), git: (args) => command("git", args), interrupted: () => interrupted });
if (!summary.complete) process.exitCode = 1;
