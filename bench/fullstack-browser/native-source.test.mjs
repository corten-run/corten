import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { EvidenceStore, openEvidence } from "./native-evidence.mjs";
import { captureSource, replaySource, captureBuildContext, replayBuildContext, captureTools, replayTools } from "./native-source.mjs";

const commit = "0972dc632fbfe3b66012d188ecdb30250f2469bc";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "corten-native-source-")); t.after(() => rmSync(root, { recursive: true }));
  return { root, store: new EvidenceStore(root) };
}
test("actual immutable local Git closes every binding source and exact native build archive", (t) => {
  const { root, store } = fixture(t), source = captureSource(store, commit), context = captureBuildContext(store, commit, "nextjs");
  const corten = captureBuildContext(store, commit, "corten"), svelte = captureBuildContext(store, commit, "sveltekit");
  const ref = store.record("source", source), build = store.record("context-nextjs", context); store.seal();
  const reader = openEvidence(root), result = replaySource(reader, reader.json(ref), commit);
  assert.ok(result.files.length > 1000 && result.files.some((f) => f.path === "Cargo.lock"));
  assert.equal(replayBuildContext(reader, reader.json(build), commit, "nextjs").dockerfile, "Dockerfile");
  assert.equal(replayBuildContext(reader, corten, commit, "corten").dockerfile, "bench/marketplace/corten/Dockerfile");
  assert.equal(replayBuildContext(reader, svelte, commit, "sveltekit").dockerfile, "Dockerfile.marketplace"); reader.finish();
  for (const mutate of [(v) => { v.files.pop(); }, (v) => { v.files[0].mode = "120000"; },
    (v) => { v.files[0].sha256 = "0".repeat(64); }, (v) => { v.repository = "//saved/network/path"; }]) {
    const v = structuredClone(source); mutate(v); assert.throws(() => replaySource(reader, v, commit));
  }
  assert.throws(() => replayBuildContext(reader, context, commit, "rails"));
  assert.throws(() => replayBuildContext(reader, { ...context, body: source.files[0].body }, commit, "nextjs"));
  assert.throws(() => captureBuildContext(store, commit, "../../arbitrary"));
});
test("actual Playwright/TypeScript installed files, cache archives, lock and executable bytes replay", (t) => {
  const { root, store } = fixture(t), tools = captureTools(store, { browserExecutable: chromium.executablePath() });
  const ref = store.record("tools", tools); store.seal(); const reader = openEvidence(root);
  const result = replayTools(reader, reader.json(ref));
  assert.match(result.node, /^[a-f0-9]{64}$/); assert.match(result.browser, /^[a-f0-9]{64}$/);
  assert.deepEqual(tools.packages.map((p) => p.name), ["@playwright/test", "playwright", "playwright-core", "typescript"]);
  assert.ok(tools.packages.at(-1).files.length > 100); reader.finish();
  const v = structuredClone(tools); v.packages.at(-1).files.pop(); assert.throws(() => replayTools(reader, v));
  assert.throws(() => replayTools(reader, { ...tools, browserExecutable: "//saved/network/exe" }));
});
