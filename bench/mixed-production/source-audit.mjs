import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verifyNativeReceipt } from "../json-api/contract.mjs";
import { sha256 } from "./capture.mjs";

export const djangoAsgi = Object.freeze({
  recipe: "mixed-production-django-asgi",
  deployment: "django-granian-asgi",
  buildProfile: "matched-asgi",
  entrypoint: null,
  command: Object.freeze(["sh", "-c", "python -m django migrate --noinput && exec python start_mixed_asgi.py"]),
  settings: "itempage.mixed_asgi_settings",
});

export const springWebflux = Object.freeze({
  recipe: "mixed-production-asgi-webflux",
  deployment: "spring-webflux",
  buildProfile: "matched-webflux",
  dockerfile: "Dockerfile.mixed",
  entrypoint: Object.freeze(["java", "-jar", "marketplace-mixed.jar"]),
  command: null,
});

export function mixedDeploymentArgs(recipe) {
  return [
    ...([djangoAsgi.recipe, springWebflux.recipe].includes(recipe) ? ["--django-deployment", djangoAsgi.deployment] : []),
    ...(recipe === springWebflux.recipe ? ["--spring-deployment", springWebflux.deployment] : []),
  ];
}

export function validateDeploymentOption(options) {
  for (const [app, deployment, option] of [["django", djangoAsgi, "djangoDeployment"], ["spring", springWebflux, "springDeployment"]]) {
    if (!Object.hasOwn(options, option)) continue;
    assert.ok(options[option] === deployment.deployment && options.profile === "matched"
      && options.build === true && !options.images && (!options.apps || options.apps.includes(app)),
    `Native deployment requires a fresh matched build including ${app}`);
  }
}

export function nativeDeployment(options, app) {
  if (app === "django" && options.djangoDeployment === djangoAsgi.deployment) return djangoAsgi;
  if (app === "spring" && options.springDeployment === springWebflux.deployment) return springWebflux;
  return null;
}

export function verifyDeploymentCommand(config, deployment) {
  assert.ok(isDeepStrictEqual(config?.Entrypoint ?? null, deployment.entrypoint), "unexpected native image entrypoint");
  assert.ok(isDeepStrictEqual(config?.Cmd ?? null, deployment.command), "unexpected native image command");
  if (deployment.settings) assert.ok(config?.Env?.includes(`DJANGO_SETTINGS_MODULE=${deployment.settings}`), "unexpected Django ASGI image settings");
}

export function deploymentIdentity(options, app) {
  const deployment = nativeDeployment(options, app);
  return deployment ? { nativeDeployment: deployment.deployment, buildProfile: deployment.buildProfile } : {};
}

export function verifyImageDeployment(image, expected) {
  assert.ok(image?.nativeDeployment === expected?.deployment && image?.buildProfile === expected?.buildProfile,
    "native image deployment differs from the selected build");
}

export function buildInputPaths(app) {
  // Corten's Dockerfile copies the whole repository, unlike the other contexts.
  return app === "corten" ? ["."] : [`bench/fullstack/apps/${app}`];
}

export function sourceSnapshot(root, paths) {
  const files = {}, base = realpathSync(root);
  assert.ok(paths.length > 0 && new Set(paths).size === paths.length, "complete unique native build inputs required");
  for (const path of [...paths].sort()) {
    assert.ok(!isAbsolute(path) && !/[\\:]/.test(path) && path.split("/").every((p) => p && p !== "." && p !== ".."), "invalid native source path");
    const target = realpathSync(join(base, path)), rel = relative(base, target);
    assert.ok(!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"), "native source escaped build root");
    files[path] = readFileSync(target);
  }
  return { files, sourceFiles: Object.entries(files).map(([path, body]) => ({ path, sha256: sha256(body) })) };
}

export function sourceAuditIdentity(summary, app) {
  return { app, payload: "marketplace-v2", key: "mixed-native-source", commit: summary.provenance.nativeSource.commit,
    contractSha256: summary.contractSha256, nativeProfile: summary.options.profile,
    ...deploymentIdentity(summary.options, app),
    contextArchiveSha256: summary.apps[app].contextArchiveSha256,
    buildInputsSha256: sha256(JSON.stringify(summary.apps[app].buildInputs)) };
}

// Reuse the independent JSON-source attestation, not a whitespace/byte-difference
// heuristic. The runner emits requests for audits, never positive audit receipts.
export function verifySourceAudit(receipt, expected, snapshot, image) {
  assert.equal(image?.buildCommit, expected.commit, "native audit/image source commit differs");
  assert.equal(image.buildDirty, "false", "native audit needs a clean fresh image");
  assert.equal(image.profile, expected.nativeProfile, "native audit/image configuration differs");
  verifyImageDeployment(image, { deployment: expected.nativeDeployment, buildProfile: expected.buildProfile });
  assert.match(expected.contextArchiveSha256 ?? "", /^[a-f0-9]{64}$/, "immutable Docker build context required");
  assert.equal(image.contextArchiveSha256, expected.contextArchiveSha256, "native image/audited Docker archive differs");
  assert.match(image.id ?? "", /^sha256:[0-9a-f]{64}$/, "immutable native image required");
  assert.deepEqual(receipt?.sourceFiles, snapshot.sourceFiles, "independent source audit must cover every exact native build input");
  assert.deepEqual(receipt.traceContext, { requestScoped: true, delayedWorkRetainsTrace: true, noAmbientCurrentOperation: true },
    "independent audit must verify immutable native request trace propagation");
  assert.equal(sha256(JSON.stringify(snapshot.sourceFiles)), expected.buildInputsSha256, "native build input set differs from the audit identity");
  assert.deepEqual(Object.keys(snapshot.files).sort(), snapshot.sourceFiles.map((f) => f.path).sort(), "native build input bodies missing");
  for (const f of snapshot.sourceFiles) assert.equal(sha256(snapshot.files[f.path]), f.sha256, "native build input bytes changed");
  // Root Cargo manifests stay bound by buildInputsSha256 and the exact comparison;
  // the reused JSON verifier restricts its individual source paths to bench/crates.
  const files = Object.fromEntries(Object.entries(snapshot.files).filter(([path]) => /^(bench|crates)\//.test(path)));
  const checked = receipt && { ...receipt, sourceFiles: receipt.sourceFiles.filter((f) => /^(bench|crates)\//.test(f.path)) };
  verifyNativeReceipt(checked, expected, files);
  return { identity: expected, imageId: image.id, sourceFiles: snapshot.sourceFiles, receiptSha256: sha256(JSON.stringify(receipt)) };
}
