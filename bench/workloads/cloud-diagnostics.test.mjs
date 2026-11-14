import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const fixture = fileURLToPath(new URL("cloud-diagnostics-fixture.mjs", import.meta.url));
function child(settings = {}, flags = [], mode = "ordinary") {
  const env = Object.fromEntries(["SystemRoot", "WINDIR", "TMP", "TEMP"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  const result = spawnSync(process.execPath, [...flags, fixture, mode], { env: { ...env, ...settings }, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0);
  return { ...JSON.parse(result.stdout), leakedSyntheticCredential: result.stderr.includes("SYNTHETIC_ONLY_DIAGNOSTIC_CREDENTIAL") };
}

test("native startup diagnostics cannot enter the credential-owning child", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "cloud-diagnostic-test-")), keylog = join(scratch, "synthetic-keylog.log");
  t.after(() => { assert.ok(scratch.startsWith(join(tmpdir(), "cloud-diagnostic-test-"))); rmSync(scratch, { recursive: true, force: true }); });
  const controls = [
    ["NODE_DEBUG=https", { NODE_DEBUG: "https" }], ["NODE_DEBUG=HTTP", { NODE_DEBUG: "HTTP" }],
    ["NODE_DEBUG=*", { NODE_DEBUG: "*" }], ["NODE_DEBUG=tls", { NODE_DEBUG: "tls" }],
    ["NODE_DEBUG_NATIVE=TLS", { NODE_DEBUG_NATIVE: "TLS" }], ["NODE_DEBUG_NATIVE=*", { NODE_DEBUG_NATIVE: "*" }],
    ["NODE_OPTIONS trace", { NODE_OPTIONS: "--trace-tls" }],
    ["NODE_OPTIONS quoted trace", { NODE_OPTIONS: '"--trace-tls"' }],
    ["NODE_OPTIONS escaped trace", { NODE_OPTIONS: '"--trac\\e-tls"' }],
    ["NODE_OPTIONS heap", { NODE_OPTIONS: "--heapsnapshot-near-heap-limit=1" }],
    ["NODE_OPTIONS quoted heap flag", { NODE_OPTIONS: '"--heapsnapshot-near-heap-limit" "1"' }],
    ["NODE_OPTIONS escaped heap flag", { NODE_OPTIONS: '"--heapsnapshot-near-heap-limi\\t" "1"' }],
    ["NODE_OPTIONS report", { NODE_OPTIONS: "--report-on-signal" }],
    ["TLS key-log environment", { SSLKEYLOGFILE: keylog }],
    ["CLI TLS key-log", {}, [`--tls-keylog=${keylog}`]],
    ["CLI trace", {}, ["--trace-tls"]], ["CLI heap", {}, ["--heapsnapshot-near-heap-limit=1"]],
    ["CLI inspector", {}, ["--inspect=127.0.0.1:0"]],
    ["cached debug before import", { NODE_DEBUG: "https" }, [], "clear-before-import"],
    ["cached debug after import", { NODE_DEBUG: "https" }, [], "clear-after-import"],
    ["new debug before consumption", {}, [], "enable-before-consume"],
    ["direct HTTPS helper debug", { NODE_DEBUG: "https" }, [], "direct-request"],
    ...["--heapsnapshot-near-heap-limit=1", "--trace-tls", "--report-on-signal"].flatMap((option) => [
      [`effective startup ${option} before import`, { NODE_OPTIONS: option }, [], "clear-options-before-import"],
      [`effective startup ${option} direct helper`, { NODE_OPTIONS: option }, [], "direct-clear-options-before-import"],
    ]),
  ];
  for (const [name, env, flags, mode] of controls) await t.test(name, () => {
    const result = child(env, flags, mode); t.diagnostic(JSON.stringify({ control: name, ...result }));
    const direct = mode?.startsWith("direct-");
    assert.equal(result.parentConsumes, 0); assert.equal(result.parentRequests, 0);
    assert.equal(result.consumes, direct ? 0 : 1); assert.equal(result.requests, direct ? 0 : 1);
    assert.equal(result.refused, Boolean(direct)); assert.equal(result.leakedSyntheticCredential, false); assert.equal(result.ipcToken, false);
    if (!direct) { assert.equal(result.cleanLaunch, true); assert.deepEqual(result.execArgv, []); assert.deepEqual(result.diagnosticNames, []); assert.equal(result.reportOnSignal, false); }
    assert.ok(!existsSync(keylog) || statSync(keylog).size === 0, "refused diagnostics must not write TLS key material");
  });
});

test("unset diagnostic positive permits one private consume and native loopback HTTPS attempt", () => {
  positive(child());
});

test("ordinary non-diagnostic Node options retain private consumption", () => {
  positive(child({ NODE_OPTIONS: "--require=node:path --max-old-space-size=256" }));
});

test("cleared ordinary startup options retain private consumption", () => {
  positive(child({ NODE_OPTIONS: "--max-old-space-size=256" }, [], "clear-options-before-import"));
});

function positive(result) {
  assert.deepEqual(result, { consumes: 1, requests: 1, execArgv: [], diagnosticNames: [], reportOnSignal: false, calls: [],
    refused: false, ipcToken: false, cleanLaunch: true, parentConsumes: 0, parentRequests: 0, leakedSyntheticCredential: false });
}

test("runtime-enabled diagnostics in the clean worker fail closed", async (t) => {
  for (const mode of ["worker-new-debug", "worker-new-report", "worker-late-debug", "worker-late-report"]) await t.test(mode, () => {
    const result = child({}, [], mode);
    assert.equal(result.consumes, mode.includes("late") ? 1 : 0); assert.equal(result.requests, 0); assert.equal(result.refused, true);
    assert.equal(result.ipcToken, false); assert.equal(result.parentConsumes, 0); assert.equal(result.parentRequests, 0); assert.equal(result.leakedSyntheticCredential, false);
  });
});
