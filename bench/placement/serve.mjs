// serve.mjs <command> [<argument>...]: runs the command, verify.sh's server, as its own child and
// stops it when its standard input ends, so the server's stop needs no process number from the
// shell. The command gets this process's environment (verify.sh gives it env -i first) and no
// standard input or output. Its stop: TERM, and KILL if it is still running 5 s later. A signal
// is sent only through the child's handle, which Node clears when it reaps the child, and a child
// is reaped by its parent alone: until then its number cannot name another process, so neither
// signal can reach one. Exits 0 once the server has ended after being stopped; 1 if the server
// could not be started, ended before it was stopped, or this process was stopped by a signal
// rather than by its input ending (the server stopped as above all the same); 3 if the server is
// still running 5 s after KILL, so a stop takes at most about 10 s however the server behaves.
// It stops its child and nothing the child started: the command must be, or exec, the server that
// listens. One that starts the server and waits can end on TERM and leave the server listening,
// which verify.sh's check of its port after each stop then fails.
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) { console.error("usage: node serve.mjs <command> [<argument>...]"); process.exit(2); }
const say = (text) => process.stderr.write(`serve: ${text}\n`);
let stopping = null, ended = false, status = 0;
const child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"] });
child.on("error", (e) => { say(`the server could not be started: ${e.message}`); process.exit(1); });
child.on("exit", (code, signal) => {
  ended = true;
  if (stopping === null) { say(`the server ended before it was stopped (${signal ?? `exit ${code}`})`); process.exit(1); }
  process.exit(status);
});
function stop(why) {
  if (stopping !== null) return;
  stopping = why;
  if (why !== "end") { status = 1; say(`stopped by ${why}, not by verify.sh; stopping the server`); }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (ended) return;
    child.kill("SIGKILL");
    setTimeout(() => { if (!ended) { say("the server is still running 5 s after KILL"); process.exit(3); } }, 5000);
  }, 5000);
}
for (const s of ["SIGHUP", "SIGINT", "SIGTERM"]) process.on(s, () => stop(s));
// A closed stderr does not end this process before the server.
process.stderr.on("error", () => {});
process.stdin.on("end", () => stop("end"));
process.stdin.on("close", () => stop("end"));
process.stdin.on("error", () => stop("end"));
process.stdin.resume();
