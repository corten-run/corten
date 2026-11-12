// Child process bounds the shared HTTP gate. It never imports or launches a browser.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { checkJsonApp } from "../workloads/json-check.mjs";
import { payloads } from "./contract.mjs";

export async function captureJson(spec) {
  writeFileSync(spec.rawPath, "");
  const observe = (response) => appendFileSync(spec.rawPath, `${JSON.stringify(response)}\n`);
  const path = `/__${payloads[spec.identity.payload].path}/control`;
  const fixture = spec.identity.source === "fixture";
  if (fixture) {
    assert.ok(spec.upstream, "fixture checks require the owned upstream zero-read observer");
    const response = await fetch(spec.upstream + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", redirect: "manual", signal: AbortSignal.timeout(5000) });
    observe({ kind: "control", method: "POST", path, value: {}, status: response.status, body: await response.text() });
    assert.equal(response.status, 200);
  }
  try { return await checkJsonApp({ payload: spec.identity.payload, source: spec.identity.source, base: spec.base, upstream: spec.upstream,
    records: JSON.parse(readFileSync(spec.recordsPath, "utf8")),
    observe }); }
  finally {
    if (fixture) {
      const response = await fetch(spec.upstream + path, { redirect: "manual", signal: AbortSignal.timeout(5000) }), body = await response.text();
      observe({ kind: "control", method: "GET", path, status: response.status, type: response.headers.get("content-type"), body });
      assert.equal(response.status, 200); assert.deepEqual(JSON.parse(body).requests, {}, "fixture checks must perform zero upstream reads");
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
    writeFileSync(spec.resultPath, JSON.stringify(await captureJson(spec), null, 2));
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
