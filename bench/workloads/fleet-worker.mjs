// Fixed production entry. JSON cannot select an executable, module or function.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

let booted = false;
try {
  assert.deepEqual(Object.keys(workerData).sort(), ["args", "cancellation", "entry", "sources"]);
  assert.ok(workerData.cancellation instanceof SharedArrayBuffer && workerData.cancellation.byteLength === 4);
  assert.ok(Array.isArray(workerData.args) && workerData.args.length <= 24 && workerData.args.every((arg) => typeof arg === "string" && arg.length <= 4096));
  assert.ok(Array.isArray(workerData.sources) && workerData.sources.length <= 100);
  const entry = new URL(workerData.entry), root = new URL("../../", entry);
  assert.equal(entry.protocol, "file:");
  assert.equal(new URL("bench/workloads/fleet-worker.mjs", root).href, entry.href);
  const approved = new Map();
  for (const source of workerData.sources) {
    assert.deepEqual(Object.keys(source).sort(), ["path", "sha256", "source", "url"]);
    assert.equal(typeof source.source, "string"); assert.ok(Buffer.byteLength(source.source) <= 1024 * 1024);
    assert.ok(/^bench\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.mjs$/.test(source.path));
    assert.equal(new URL(source.path, root).href, source.url);
    assert.equal(createHash("sha256").update(source.source).digest("hex"), source.sha256);
    assert.ok(!approved.has(source.url)); approved.set(source.url, source.source);
  }
  assert.ok(approved.has(workerData.entry) && new URL(workerData.entry).pathname.endsWith("/bench/workloads/fleet-worker.mjs"));
  // Built-ins only have evaluated so far. Both resolution and loading deny any
  // unlisted project/package import, including future additions to the closure.
  // All project modules execute captured bytes, never a second filesystem read.
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("node:")) return nextResolve(specifier, context);
    const url = new URL(specifier, context.parentURL).href;
    assert.ok(approved.has(url), "fleet-unapproved-import");
    return { url, shortCircuit: true };
  }, load(url, context, nextLoad) {
    if (url.startsWith("node:")) return nextLoad(url, context);
    assert.ok(approved.has(url), "fleet-unapproved-import");
    return { format: "module", source: approved.get(url), shortCircuit: true };
  } });
  const { parseProductionArgs, productionMain } = await import(new URL("./cloud-production.mjs", workerData.entry).href);
  booted = true;
  const { options, approval, preview } = parseProductionArgs(workerData.args);
  assert.ok(approval && !preview && !options.deliverAudit);
  assert.ok(options.collect || options.detach && options.group && options.fleet);
  const cancelled = new Int32Array(workerData.cancellation);
  // productionMain's finally confirms credential-worker settlement. Its result
  // alone is insufficient: the parent also waits for this worker's clean exit.
  const code = await productionMain(workerData.args, { interrupted: () => Atomics.load(cancelled, 0) !== 0, write: () => {} });
  assert.ok([0, 1, 3].includes(code));
  parentPort.postMessage({ schema: "benchmark-group-fleet-worker-result/v1", code });
} catch (error) {
  parentPort.postMessage({ schema: "benchmark-group-fleet-worker-result/v1", error: booted ? "group-operation-failed" : "group-bootstrap-invalid",
    uncertain: error?.controlTreeUncertain === true || error?.controlUncertain === true });
}
parentPort.close();
