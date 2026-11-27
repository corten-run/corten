// Test-only: run.test.mjs starts idle.mjs with `node --import` of this file, which turns its read
// of a process's /proc/<pid>/status into a read of the status stand-in.mjs writes in
// $STAND_IN/proc/<pid>/status, so a test knows each reading. idle.mjs reads only /proc; nothing but
// the tests loads this file.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const state = process.env.STAND_IN;
if (!state) throw new Error("STAND_IN names no directory");
const read = fs.readFileSync;
fs.readFileSync = /** @type {typeof fs.readFileSync} */ (
  /** @type {any} */ (
    (/** @type {any} */ path, /** @type {any} */ options) => {
      const pid = typeof path === "string" ? /^\/proc\/(\d+)\/status$/.exec(path)?.[1] : undefined;
      return read(pid === undefined ? path : join(state, "proc", pid, "status"), options);
    }
  )
);
// idle.mjs imports readFileSync by name: this gives that binding the function above.
syncBuiltinESMExports();
