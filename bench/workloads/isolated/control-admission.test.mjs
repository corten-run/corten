// Offline native SSH fence: install shape, readback refusals and bounded diagnostics.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
// A namespace import lets this file run against the r62 module, which lacks the new exports.
import * as admission from "./control-admission.mjs";
const { beginOfflineWindow, offlineFenceRules, verifyOfflineFence } = admission;
const fenceOutcome = (r) => admission.fenceOutcome(r);
const installOfflineFence = () => admission.installOfflineFence();
import { binding } from "../test-fixtures/control-stream-fixture.mjs";

const table = "corten_bench_native";
const canary = "CANARY-7f3e nft stderr must stay out of the diagnostic";
const prefix = "native SSH fence unavailable";
const shape = /^native SSH fence unavailable: (install|install readback|close readback|remove) (error=(E[A-Z0-9]+|unknown)|signal=(SIG[A-Z0-9]+|unknown)|exit=(-?\d+|unknown)|invalid|policy mismatch)$/;
const tcpMatch = { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 22 } };

// The JSON shape Noble's nftables 1.0.9 prints for offlineFenceRules.
function installedPolicy() {
  return { nftables: [
    { metainfo: { version: "1.0.9", release_name: "Old Doc Yak #3", json_schema_version: 1 } },
    { table: { family: "inet", name: table, handle: 2 } },
    { chain: { family: "inet", table, name: "input", handle: 1, type: "filter", hook: "input", prio: 10, policy: "accept" } },
    { rule: { family: "inet", table, chain: "input", handle: 2, expr: [tcpMatch,
      { match: { op: "==", left: { "&": [{ payload: { protocol: "tcp", field: "flags" } }, ["fin", "syn", "rst", "ack"]] }, right: "syn" } },
      { limit: { rate: 8, burst: 8, per: "minute" } }, { counter: { packets: 0, bytes: 0 } }, { drop: null }] } },
    { rule: { family: "inet", table, chain: "input", handle: 3, expr: [tcpMatch, { counter: { packets: 0, bytes: 0 } }, { drop: null }] } },
  ] };
}

// A host model: nft behind taskset, plus the guardian window calls. It models
// Noble's refusal of `nft -f -` on Node's socket stdin; the real refusal is
// the socket-stdin negative in scripts/benchmark-ssh-ingress-ci.sh. A readback
// hook returning a string replaces nft's stdout verbatim.
function host(t, { readback = (policy) => policy, install = true, remove = true } = {}) {
  const h = { policy: null, calls: [], inputs: [] };
  const refuse = (stderr) => ({ status: 1, signal: null, stdout: "", stderr: `Error: ${stderr} ${canary}\n` });
  t.mock.method(childProcess, "spawnSync", (program, args, opts) => {
    if (program === "/usr/bin/python3") {
      assert.equal(args.at(-1), binding.token);
      h.calls.push(args.at(-2));
      return { status: 0, signal: null, stdout: "", stderr: "" };
    }
    assert.equal(program, "/usr/bin/taskset");
    assert.deepEqual(args.slice(0, 3), ["-c", "0", "/usr/sbin/nft"]);
    const nft = args.slice(3);
    h.inputs.push(opts.input);
    if (nft.includes("-f")) { h.calls.push("stdin-install"); return refuse('Not a regular file: "/dev/stdin"'); }
    if (nft.length === 1 && nft[0] === offlineFenceRules) {
      h.calls.push("install");
      if (h.policy) return refuse("Could not process rule: File exists");
      if (install) h.policy = installedPolicy();
      return { status: 0, signal: null, stdout: "", stderr: "" };
    }
    if (nft.join(" ") === `-j -a list table inet ${table}`) {
      h.calls.push("readback");
      if (!h.policy) return refuse("No such file or directory");
      const out = readback(structuredClone(h.policy));
      return { status: 0, signal: null, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "" };
    }
    if (nft.join(" ") === `delete table inet ${table}`) {
      h.calls.push("remove");
      if (!h.policy || !remove) return refuse("Could not process rule: No such file or directory");
      h.policy = null;
      return { status: 0, signal: null, stdout: "", stderr: "" };
    }
    return refuse("unexpected command");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return h;
}

function refusal(fn, expected) {
  let error;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error, "the fence must refuse");
  assert.ok(!error.message.includes("CANARY"), `diagnostic leaked nft output: ${error.message}`);
  if (expected instanceof RegExp) assert.match(error.message, expected);
  else { assert.equal(error.message, expected); assert.match(error.message, shape); }
  return error;
}

// r62's module fed the rules to `nft -f -` and refuses here with the bare prefix.
test("the offline window never feeds nft on standard input, so a stdin-refusing host still admits it", (t) => {
  const h = host(t);
  const close = beginOfflineWindow(binding);
  close();
  assert.ok(!h.calls.includes("stdin-install"));
  assert.deepEqual(h.inputs, ["", "", "", ""]);
});

test("offline window installs from one argv batch, verifies readback, and removes the fence", (t) => {
  const h = host(t);
  const close = beginOfflineWindow(binding);
  assert.deepEqual(h.calls, ["install", "readback", "window-open"]);
  assert.ok(h.policy);
  const { proof, ingress } = close();
  assert.deepEqual(ingress, { packets: 0, bytes: 0 });
  assert.equal(verifyOfflineFence(proof.before).policy.rules.length, 4);
  assert.deepEqual(h.calls, ["install", "readback", "window-open", "window-close", "readback", "remove"]);
  assert.equal(h.policy, null);
});

test("an existing table is an atomic install refusal before any guardian window", (t) => {
  const h = host(t);
  installOfflineFence();
  const before = JSON.stringify(h.policy);
  refusal(() => beginOfflineWindow(binding), `${prefix}: install exit=1`);
  assert.equal(JSON.stringify(h.policy), before);
  assert.deepEqual(h.calls, ["install", "readback", "install"]);
});

test("a missing table refuses at readback", (t) => {
  const h = host(t, { install: false });
  refusal(() => beginOfflineWindow(binding), `${prefix}: install readback exit=1`);
  assert.deepEqual(h.calls, ["install", "readback"]);
});

// Host text in a readback (here the canary) must not reach a refusal through a
// parse error or an assertion diff.
for (const [name, change, expected] of [
  ["a wrong policy", (p) => { p.nftables[3].rule.expr[2].limit.burst = 9; return p; }, "policy mismatch"],
  ["a wrong chain priority", (p) => { p.nftables[2].chain.prio = 0; return p; }, "policy mismatch"],
  ["a foreign rule", (p) => { p.nftables.push({ rule: { family: "inet", table, chain: "input", handle: 4,
    expr: [tcpMatch, { accept: null }], comment: canary } }); return p; }, "policy mismatch"],
  ["a foreign key", (p) => ({ ...p, [canary]: [] }), "policy mismatch"],
  ["an extra rule field", (p) => { p.nftables[4].rule.comment = canary; return p; }, "policy mismatch"],
  ["a foreign metainfo schema", (p) => { p.nftables[0].metainfo.json_schema_version = canary; return p; }, "policy mismatch"],
  ["a JSON null readback", () => "null", "policy mismatch"],
  ["a non-JSON readback", () => `${canary} not json`, "invalid"],
  ["a truncated readback", (p) => JSON.stringify(p).slice(0, 40) + canary, "invalid"],
]) test(`${name} refuses before the guardian window opens`, (t) => {
  const h = host(t, { readback: change });
  refusal(() => beginOfflineWindow(binding), `${prefix}: install readback ${expected}`);
  assert.deepEqual(h.calls, ["install", "readback"]);
  assert.ok(h.policy, "a refused readback leaves the fence for the unit's stop hook");
});

for (const [name, change, expected] of [
  ["a rule changed during the phase", (p) => { p.nftables[4].rule.comment = canary; return p; }, "policy mismatch"],
  ["a regressed probe counter", (p) => { p.nftables[3].rule.expr[3].counter = { packets: -1, bytes: 0 }; return p; }, "policy mismatch"],
  ["a non-JSON close readback", () => `${canary} not json`, "invalid"],
]) test(`${name} refuses at close without host text and keeps the fence`, (t) => {
  let phase = "install";
  const h = host(t, { readback: (p) => phase === "close" ? change(p) : p });
  const close = beginOfflineWindow(binding);
  phase = "close";
  refusal(close, `${prefix}: close readback ${expected}`);
  assert.deepEqual(h.calls, ["install", "readback", "window-open", "window-close", "readback"]);
  assert.ok(h.policy, "a refused close leaves the fence for the unit's stop hook");
});

test("a fence removed or changed during the phase refuses at close", (t) => {
  const h = host(t);
  const close = beginOfflineWindow(binding);
  h.policy = null;
  refusal(close, `${prefix}: close readback exit=1`);
  const g = host(t, { remove: false });
  refusal(beginOfflineWindow(binding), `${prefix}: remove exit=1`);
  assert.ok(g.policy, "an unremoved fence stays for the unit's stop hook");
});

test("diagnostics name only the operation and outcome class", (t) => {
  for (const [result, outcome] of [
    [{ error: Object.assign(new Error(canary), { code: "ENOENT" }), status: null, signal: null, stderr: canary }, "error=ENOENT"],
    [{ error: Object.assign(new Error(canary), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM" }, "error=ETIMEDOUT"],
    [{ error: Object.assign(new Error(canary), { code: canary }), status: null, signal: null }, "error=unknown"],
    [{ status: null, signal: "SIGKILL", stderr: canary }, "signal=SIGKILL"],
    [{ status: null, signal: canary }, "signal=unknown"],
    [{ status: 1, signal: null, stderr: canary }, "exit=1"],
    [{ status: null, signal: null, stderr: canary }, "exit=unknown"],
  ]) {
    assert.equal(fenceOutcome(result), outcome);
    const h = host(t);
    t.mock.method(childProcess, "spawnSync", () => result); syncBuiltinESMExports();
    refusal(() => installOfflineFence(), `${prefix}: install ${outcome}`);
    assert.deepEqual(h.calls, []);
  }
});
