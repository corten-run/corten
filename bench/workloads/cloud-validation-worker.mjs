// Built-ins only until every captured source is checked and the deny-unlisted
// loader is installed. No filesystem entry or package loader is evaluated.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isBuiltin, registerHooks } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

try {
  assert.deepEqual(Object.keys(workerData).sort(), ["input", "root", "sources"]);
  const { input, root, sources } = workerData, base = new URL(root);
  assert.equal(base.protocol, "file:"); assert.ok(base.href.endsWith("/"));
  const preflight = input.action === "actor-role-preflight";
  assert.deepEqual(Object.keys(input).sort(), preflight ? ["action", "commit", "group", "mode", "round"] : ["commit", "folder", "round"]);
  assert.match(input.commit, /^[a-f0-9]{40}$/);
  // Grow the source budget only for the exact new replay dependencies.
  const additionalSources = new Set([
    "bench/catalog/cgroup.mjs",
    "bench/fullstack-browser/document-navigation.mjs",
    "bench/fullstack/edge.mjs",
    "bench/hardening/bounded-requests.mjs",
    "bench/hardening/dependency-recovery-capture.mjs",
    "bench/hardening/dependency-recovery-contract.mjs",
    "bench/json-api/load-resource-proof.mjs",
    "bench/json-api/placement.mjs",
    "bench/typescript.mjs",
    "bench/workloads/isolated/native-roles.mjs",
  ]);
  let remaining = 211;
  assert.ok(Array.isArray(sources) && sources.length > 0 && sources.length <= remaining + additionalSources.size);
  const approved = new Map(); let total = 0;
  for (const row of sources) {
    assert.deepEqual(Object.keys(row).sort(), ["path", "sha256", "source"]);
    assert.ok(/^(?:(?:bench|scripts)\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.mjs|bench\/node_modules\/typescript\/lib\/typescript\.js|node_modules\/semver\/(?:[a-z-]+\/)*[a-z-]+\.js)$/.test(row.path));
    if (!additionalSources.delete(row.path)) assert.ok(--remaining >= 0);
    assert.equal(typeof row.source, "string");
    total += Buffer.byteLength(row.source); assert.ok(total <= 24 * 1024 * 1024);
    assert.equal(createHash("sha256").update(row.source).digest("hex"), row.sha256);
    const url = new URL(row.path, base).href;
    assert.ok(!approved.has(url)); approved.set(url, row.source);
  }
  const self = approved.get(new URL("bench/workloads/cloud-validation-worker.mjs", base).href);
  assert.equal(import.meta.url, "data:text/javascript;base64," + Buffer.from(self).toString("base64"));
  const typescript = new URL("bench/node_modules/typescript/lib/typescript.js", base).href;
  const semver = new URL("node_modules/semver/", base).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier)) return nextResolve(specifier, context);
    let url = specifier === "typescript" ? typescript : specifier === "semver" ? semver + "index.js" : new URL(specifier, context.parentURL).href;
    // Node-semver uses extensionless CommonJS requires. Resolve only to a
    // captured library member; never consult disk, package.json or NODE_PATH.
    if (!approved.has(url) && context.parentURL?.startsWith(semver) && /^\.\.?\//.test(specifier)) {
      if (approved.has(url + ".js")) url += ".js";
      else if (approved.has(url + "/index.js")) url += "/index.js";
    }
    assert.ok(approved.has(url), "validation-unapproved-import");
    return { url, shortCircuit: true };
  }, load(url, context, nextLoad) {
    if (isBuiltin(url)) return nextLoad(url, context);
    assert.ok(approved.has(url), "validation-unapproved-import");
    return { format: url === typescript || url.startsWith(semver) ? "commonjs" : "module", source: approved.get(url), shortCircuit: true };
  } });
  let report;
  if (preflight) {
    const { bindCampaign, bindGroupCampaign, campaignRoleBlockers } = await import(new URL("bench/workloads/isolated/campaign-contract.mjs", base).href);
    const { round, commit, group, mode } = input;
    assert.ok(group === null ? mode === null : typeof group === "string" && typeof mode === "string");
    report = campaignRoleBlockers(group === null ? bindCampaign({ round, commit }) : bindGroupCampaign({ round, commit, group }, mode));
  } else {
    const native = await import(new URL("bench/workloads/isolated/campaign-verify.mjs", base).href);
    if (typeof native.validateCampaign !== "function") throw new Error("validator unavailable");
    report = await native.validateCampaign(Object.freeze(input));
  }
  parentPort.postMessage({ ok: true, report });
} catch { parentPort.postMessage({ ok: false }); }
