import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boundedQualification, validateBoundedQualification } from "./qualification.mjs";
import { livePaths } from "../fullstack/conformance.mjs";

// Run the actual CLI with scripted HTTP responses and capture its output write.
// Neither the network nor the container's /results directory is used.
const fake = `
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
const secret = "synthetic-private-value";
const page = "<form method='post'><input type='hidden' name='_csrf' value='" + secret + "'></form>";
let controls = 0;
globalThis.fetch = async (url, options) => {
  assert.equal(scenario, "upstream-read-reset");
  assert.equal(url, "http://hardening-000000000000-cell-upstream:8080/__marketplace/control");
  assert.equal(options.method, "POST");
  assert.equal(options.body, ['{"status":503}', '{}'][controls]);
  controls++;
  return { status: 200, body: { cancel: async () => {} } };
};
process.on("exit", () => {
  if (scenario === "upstream-read-reset" && controls !== 2) process.exitCode = 2;
});
const originalRead = fs.readFileSync;
fs.readFileSync = (path, ...args) => path === "/results/cert/cert.pem" ? "fixture CA" : originalRead(path, ...args);
fs.writeFileSync = (path, contents) => {
  if (path !== output) throw new Error("unexpected write");
  process.stdout.write(contents);
};
(edge ? https : http).request = (options, onResponse) => {
  if (options.path === "/health/live") {
    assert.equal(options.method, "GET"); assert.equal(options.headers.host, edge ? "localhost:8080" : "127.0.0.1:8080");
    assert.equal(options.servername, edge ? "localhost" : undefined);
  }
  const req = new EventEmitter();
  req.destroy = (error) => { req.emit("error", error); req.emit("close"); };
  req.end = () => queueMicrotask(() => {
    const crossSite = options.headers["sec-fetch-site"] === "cross-site";
    if (crossSite && scenario === "reset" || controls === 1 && options.path === "/api/marketplace/item_1") {
      req.destroy(Object.assign(new Error(secret), { code: "ECONNRESET" }));
      return;
    }
    const res = Object.assign(new EventEmitter(), {
      statusCode: controls === 1 ? 503 : crossSite || scenario === "own-post-denied" && options.headers["sec-fetch-site"] === "same-origin" ? 403
        : scenario === "discovery-503" && ${JSON.stringify(livePaths)}.includes(options.path) ? options.path === "/health/live" ? 503 : 404
        : options.path === "/health/live" && scenario === "liveness" ? 404 : 200,
      complete: !(options.path === "/healthz" && scenario === "liveness"),
      headers: { "set-cookie": ["session=" + secret] },
    });
    onResponse(res);
    res.emit("data", Buffer.from(page));
    res.emit("end");
    req.emit("close");
  });
  return req;
};
syncBuiltinESMExports();`;

function run(scenario, source = "fixture", edge = false) {
  const output = `/results/${edge ? "edge-" : ""}qualification.json`;
  const preload = "data:text/javascript;base64," + Buffer.from(`const scenario = ${JSON.stringify(scenario)}, edge = ${edge}, output = ${JSON.stringify(output)};\n${fake}`).toString("base64");
  const script = fileURLToPath(new URL("./qualification.mjs", import.meta.url));
  const child = spawnSync(process.execPath, ["--import", preload, script, source, edge ? "deployed-edge" : "direct",
    "http://hardening-000000000000-cell-upstream:8080", output], { encoding: "utf8", timeout: 10000 });
  assert.ifError(child.error);
  return { ...child, receipt: child.stdout ? JSON.parse(child.stdout) : null };
}

for (const edge of [false, true]) test(`qualification records the discovery request on the ${edge ? "TLS edge" : "direct app"}`, () => {
  const { status, stderr, receipt } = run("discovery-503", "fixture", edge);
  assert.equal(status, 0, stderr);
  const url = new URL("/health/live", edge ? "https://localhost:8080" : "http://127.0.0.1:8080");
  const row = receipt.probes.liveness[0];
  assert.equal(receipt.probes.live, undefined);
  assert.deepEqual([row.status, row.url, row.method, row.host], [503, url.href, "GET", url.host]);
  assert.equal(validateBoundedQualification(receipt), receipt);
});

test("qualification counts a complete HTTP 403 as a cross-site refusal", () => {
  const { status, stderr, receipt } = run("refusal");
  assert.equal(status, 0, stderr);
  assert.equal(receipt.probes.crossSite.status, 403);
  assert.equal(receipt.cells.crossSite, "403");
  assert.ok(!receipt.missing.includes("crossSite"));
  assert.equal(validateBoundedQualification(receipt), receipt);
});

test("a denied legitimate form records the completed HTTP response, not a transport error", () => {
  const { status, receipt, stdout } = run("own-post-denied");
  assert.equal(status, 1);
  assert.equal(receipt.eligible, false);
  assert.equal(receipt.probes.ownPost.status, 403);
  assert.equal(receipt.failure.step, "ownPost");
  assert.equal(receipt.probes.crossSite, undefined);
  assert.doesNotMatch(stdout, /synthetic-private-value/);
  assert.throws(() => validateBoundedQualification(receipt), /incomplete qualification receipt/);
});

test("qualification retains sanitized prior observations when the cross-site request resets", () => {
  const { status, stderr, stdout, receipt } = run("reset");
  assert.equal(status, 1);
  assert.ok(receipt, "no partial qualification receipt");
  assert.equal(receipt.eligible, false);
  assert.deepEqual(receipt.failure, { step: "crossSite", kind: "transport-error" });
  assert.equal(receipt.probes.ownPost.status, 200);
  assert.deepEqual(Object.keys(receipt.probes.page).sort(), ["bodyLength", "ms", "status"]);
  assert.equal(receipt.probes.crossSite, undefined);
  assert.equal(receipt.cells, undefined);
  assert.ok(stdout.length < 4096);
  assert.doesNotMatch(stdout + stderr, /synthetic-private-value/);
  assert.throws(() => validateBoundedQualification(receipt), /incomplete qualification receipt/);
});

test("qualification does not promote an incomplete liveness response to HTTP evidence", () => {
  const { status, receipt } = run("liveness");
  assert.equal(status, 1);
  assert.equal(receipt.eligible, false);
  assert.deepEqual(receipt.failure, { step: "liveness", kind: "incomplete-response" });
  assert.equal(receipt.probes.crossSite.status, 403);
  assert.deepEqual(receipt.probes.liveness.map(({ path, status }) => ({ path, status })), [{ path: "/health/live", status: 404 }]);
  assert.equal(receipt.probes.live, undefined);
});

test("qualification resets the API control after an ordinary probe fails", () => {
  const { status, receipt } = run("upstream-read-reset", "api");
  assert.equal(status, 1);
  assert.equal(receipt.eligible, false);
  assert.deepEqual(receipt.failure, { step: "json500", kind: "transport-error" });
  assert.equal(receipt.probes.page500.status, 503);
  assert.equal(receipt.probes.afterUpstream, undefined);
});

test("qualification replay rejects contradictory receipt fields even with recomputed cells", () => {
  const { receipt } = run("refusal");
  for (const [probe, field, value] of [
    ["json", "error", "ECONNRESET"], ["page404", "failure", "transport-error"], ["head", "complete", false],
    ["crossSite", "timedOut", true], ["live", "incomplete", true],
  ]) {
    const probes = structuredClone(receipt.probes);
    probes[probe][field] = value;
    if (probe === "live") probes.liveness[0][field] = value;
    assert.throws(() => validateBoundedQualification(boundedQualification(probes, receipt.source)),
      /unexpected qualification response fields/, `${probe}.${field}`);
  }
});
