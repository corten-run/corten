// Test-only native loopback entry; production has no port/origin/fixture switch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--consume-synthetic") {
  assert.deepEqual(process.execArgv, ["--max-old-space-size=256"]);
  if (process.argv[3] === "--hang") setInterval(() => {}, 1000);
  else { process.stdout.write("SYNTHETIC_ONLY_CREDENTIAL_A"); process.exit(0); }
} else {
const { serveProviderWorker } = await import("./cloud-provider-worker.mjs");
const [port, output, mode] = process.argv.slice(2);
assert.equal(process.env.NODE_OPTIONS, "--max-old-space-size=256"); delete process.env.NODE_OPTIONS;
assert.deepEqual(process.execArgv, []); process.stdin.resume();
const observed = { consumes: 0, requests: 0, requestClose: 0, responseClose: 0, socketClose: 0, credentialExited: false, credentialTimedOut: false };
const save = () => writeFileSync(output, JSON.stringify(observed)); save();
const exit = process.exit.bind(process);
if (["withhold-exit", "exit"].includes(mode)) process.exit = (code) => { if (code !== 0) exit(code); };
if (mode === "exit2") process.exit = (code) => exit(code === 0 ? 2 : code);
let lastReset, retryClockSet = false, closedSamples = 0;
function rewindNextSample() {
  const clock = Date.now, checkpoint = clock();
  Date.now = () => { Date.now = clock; return checkpoint - 100; };
  return checkpoint;
}
serveProviderWorker({
  now: () => {
    if (mode === "first-handoff-rollback" && !retryClockSet && observed.credentialExited) {
      retryClockSet = true; return rewindNextSample();
    }
    // The first post-close sample proves the original request closed; the
    // second is the retry checkpoint. Rewind only the sample after that.
    if (mode === "retry-start-rollback" && !retryClockSet && lastReset?.request && lastReset.socket && ++closedSamples === 2) {
      retryClockSet = true;
      const clock = Date.now, checkpoint = clock() + 1;
      // Only the first sample inside the retry goes backwards. A later
      // check before connect must not erase that observation.
      Date.now = () => {
        Date.now = () => Math.max(clock(), checkpoint);
        observed.retryStartRewound = true; save();
        return checkpoint - 1;
      };
      return checkpoint;
    }
    return Date.now() + (observed.requests >= 2 && observed.socketClose >= 2
      ? mode === "reset-expired" ? 50000 : ["engine-clock", "reset-engine-clock"].includes(mode) ? -50000 : 0 : 0);
  },
  spawn(binary, args, options) {
    assert.equal(binary, "doctl"); assert.deepEqual(args.slice(0, 2), ["auth", "token"]);
    assert.ok(options.timeout > 0 && options.timeout <= 10000);
    observed.consumes++; save();
    const result = spawnSync(process.execPath, ["--max-old-space-size=256", fileURLToPath(import.meta.url), "--consume-synthetic",
      ...(mode === "credential-hang" ? ["--hang"] : [])], options);
    observed.credentialExited = result.status === 0 && !result.error && !result.signal;
    observed.credentialTimedOut = result.error?.code === "ETIMEDOUT";
    save(); return result;
  },
  connect(url, options, callback) {
    assert.equal(url.origin, "https://api.digitalocean.com");
    assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
    if (lastReset) {
      assert.ok(lastReset.request && lastReset.socket, "retry must follow actual native close");
      lastReset = undefined;
    }
    observed.requests++; save();
    let status;
    const req = request({ ...options, hostname: "127.0.0.1", port: Number(port), path: url.pathname + url.search }, (res) => {
      status = res.statusCode;
      res.once("close", () => { observed.responseClose++; save(); }); callback(res);
    });
    const closed = { request: false, socket: false };
    req.once("close", () => { closed.request = true; observed.requestClose++; save(); });
    req.once("socket", (socket) => {
      assert.equal(req.reusedSocket, false);
      socket.once("close", () => {
        closed.socket = true; observed.socketClose++; save();
        if (mode === "reset-cancelled" && lastReset === closed) setImmediate(() => process.emit("SIGINT"));
      });
    });
    req.once("error", (error) => {
      if (url.pathname === "/v2/account" && error.code === "ECONNRESET") lastReset = closed;
    });
    if (mode === "unobserved-close" || mode === "reset-unobserved-close" || mode === "catalog-unobserved-close" && url.pathname === "/v2/sizes") {
      // Withhold the proof listener, not native closure: destruction alone must
      // not be sufficient. The counters above still record actual native events.
      const once = req.once.bind(req);
      req.once = (event, listener) => once(event, event === "close" ? (...args) => {
        if (status !== ({ "unobserved-close": 503, "catalog-unobserved-close": 200 })[mode]) listener(...args);
      } : listener);
    }
    if (mode === "retry-timer-rollback" && observed.requests === 2) rewindNextSample();
    return req;
  },
});
}
