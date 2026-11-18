// Child process bounds the shared HTTP gate. It never imports or launches a browser.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { checkJsonApp } from "../workloads/json-check.mjs";
import { payloads } from "./contract.mjs";

export async function readUpstreamSnapshot(url) {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  assert.equal(r.status, 200);
  const { requests, status } = await r.json();
  return { upstreamReads: requests, upstreamResponses: { ...JSON.parse(r.headers.get("X-Json-Bench-Responses")), status } };
}

export async function captureJson(spec) {
  writeFileSync(spec.rawPath, "");
  const path = `/__${payloads[spec.identity.payload].path}/control`;
  const fixture = spec.identity.source === "fixture";
  let sweepPending = !fixture;
  const observe = async (response) => {
    // The shared checker's first API counter GET closes the record sweep. Its
    // finally block resets the upstream, so capture finishes before returning.
    if (sweepPending && response.kind === "control" && response.method === "GET" && response.path === path) {
      sweepPending = false;
      try { response.sweepEnd = await readUpstreamSnapshot(spec.upstream + path); }
      catch (error) { response.sweepEnd = { error: error.message }; } // Keep witnessed application errors even without attribution.
    }
    appendFileSync(spec.rawPath, `${JSON.stringify(response)}\n`);
  };
  if (fixture) {
    assert.ok(spec.upstream, "fixture checks require the owned upstream zero-read observer");
    const response = await fetch(spec.upstream + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", redirect: "manual", signal: AbortSignal.timeout(5000) });
    await observe({ kind: "control", method: "POST", path, value: {}, status: response.status, body: await response.text() });
    assert.equal(response.status, 200);
  }
  try { return await checkJsonApp({ payload: spec.identity.payload, source: spec.identity.source, base: spec.base, upstream: spec.upstream,
    records: JSON.parse(readFileSync(spec.recordsPath, "utf8")),
    observe }); }
  finally {
    if (fixture) {
      const response = await fetch(spec.upstream + path, { redirect: "manual", signal: AbortSignal.timeout(5000) }), body = await response.text();
      await observe({ kind: "control", method: "GET", path, status: response.status, type: response.headers.get("content-type"), body });
      assert.equal(response.status, 200); assert.deepEqual(JSON.parse(body).requests, {}, "fixture checks must perform zero upstream reads");
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let spec;
  try {
    spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
    writeFileSync(spec.resultPath, JSON.stringify(await captureJson(spec), null, 2));
  } catch (error) {
    if (spec && error.recordAttempt) writeFileSync(`${spec.resultPath}.failure.json`, JSON.stringify({ identity: spec.identity, attempt: error.recordAttempt }, null, 2));
    console.error(error.stack ?? error); process.exitCode = 1;
  }
}
