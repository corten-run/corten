// Real Git/source/context replay; review receipts here are synthetic test data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { deploymentSha256 } from "../deployments.mjs";
import { digest, tree } from "./evidence.mjs";
import { prepareMixedAudit, replayMixedSubject, validateMixedDelivery, validateMixedRun } from "./mixed-staging.mjs";

// Verbatim native build-context.mjs from 288d10fcba8db3ec2de22f9875f80898c4d4930a.
// Keep this immutable test dependency portable before the parent routes that commit.
// This exercises real Git contexts, not a native build or whole-campaign qualification.
// Unused build-only imports throw if accidentally used.
const nativeSource = readFileSync(new URL("./test-fixtures/mixed-build-context.txt", import.meta.url), "utf8").replaceAll("\r\n", "\n");
assert.equal(digest(nativeSource), "ca52c73035b996de1a90846ec03c5c065fef0a92a984493c4c2397a1df1627ae");
const nativeUrl = `data:text/javascript;base64,${Buffer.from(nativeSource).toString("base64")}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === new URL("./mixed-staging.mjs", import.meta.url).href && specifier === "../../mixed-production/build-context.mjs")
    return { url: nativeUrl, shortCircuit: true };
  if (context.parentURL === nativeUrl && ["./source-audit.mjs", "./capture.mjs"].includes(specifier))
    return { url: `data:text/javascript,export function ${specifier.includes("source-audit") ? "sourceSnapshot" : "sha256"}(){throw new Error('unused native build dependency')}`, shortCircuit: true };
  return next(specifier, context);
} });
test.after(() => hooks.deregister());

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "isolated-mixed-audit-")), repo = join(root, "repo"), sources = join(root, "sources"); mkdirSync(repo);
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true }); });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet"); git("config", "user.name", "Offline Test"); git("config", "user.email", "test@example.invalid"); git("config", "core.autocrlf", "false");
  for (const path of ["Cargo.toml", "bench/marketplace/corten/Dockerfile", "bench/fullstack/apps/express/server.mjs"] ) {
    mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), `synthetic ${path}\n`);
  }
  git("add", "."); git("commit", "--quiet", "-m", "synthetic sources");
  const commit = git("rev-parse", "HEAD"), binding = { request: { group: "mixed-production", round: "w17", commit },
    selection: { apps: ["corten", "express"], contractSha256: "a".repeat(64) }, execution: { effectiveOptions: { profile: "matched" } } };
  const plan = { commit, campaignSha256: "b".repeat(64), bindings: [binding] }, subject = await prepareMixedAudit(plan, repo, sources);
  const delivery = { schema: "benchmark-mixed-audit-delivery/v1", subjectSha256: subject.subjectSha256,
    review: { reviewer: "synthetic-independent-reviewer", reviewedAt: "2026-11-13T12:00:00Z", subjectSha256: subject.subjectSha256, findings: [], decision: "approved" },
    bundle: { schema: "mixed-native-source-audits/v1", receipts: subject.requests.map((r) => ({ schema: "json-api-native-audit/v1", ...r,
      auditor: "synthetic-independent-reviewer", auditedAt: "2026-11-13T12:00:00Z", findings: [],
      traceContext: { requestScoped: true, delayedWorkRetainsTrace: true, noAmbientCurrentOperation: true },
      verified: { typedCompleteRecord: true, nativeSerialization: true, noOutputCache: true, noJsonPassthrough: true,
        fixtureParsedAtStartup: true, requestTimeFetchParse: true, upstreamErrors: true } })) } };
  return { root, repo, sources, binding, plan, subject, delivery, git };
}
test("exact committed mixed contexts and independent delivery replay without claiming built-image or operator authority", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await replayMixedSubject(f.plan, f.subject, f.repo, f.sources), f.subject);
  assert.deepEqual(validateMixedDelivery(f.delivery, f.subject, f.sources), f.delivery);
  assert.equal(f.subject.scope, "committed-source-and-build-context-not-built-image");
  assert.ok(f.subject.requests[0].sourceFiles.some((f) => f.path === "Cargo.toml"), "Corten uses the whole actual tracked context");
  assert.equal(f.subject.requests[1].sourceFiles.length, 1);
});
test("the native Docker output-file archive convention produces the exact retained review contexts", async (t) => {
  const f = await fixture(t), { nativeBuildArchiveArgs } = await import(nativeUrl);
  for (const app of f.binding.selection.apps) {
    const output = join(f.root, `${app}-native-build-context.tar`);
    execFileSync("git", nativeBuildArchiveArgs(f.plan.commit, app, { output }), { cwd: f.repo, windowsHide: true,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(readFileSync(output), readFileSync(join(f.sources, `contexts/${app}.tar`)));
  }
});
for (const [name, mutate] of [
  ["cross commit", (f, d) => { d.bundle.receipts[0].identity.commit = "f".repeat(40); }],
  ["foreign context", (f, d) => { d.bundle.receipts[0].identity.contextArchiveSha256 = "f".repeat(64); }],
  ["source omission", (f, d) => { d.bundle.receipts[0].sourceFiles.pop(); }],
  ["source substitution", (f, d) => { d.bundle.receipts[0].sourceFiles[0].sha256 = "f".repeat(64); }],
  ["foreign review subject", (f, d) => { d.review.subjectSha256 = "f".repeat(64); }],
  ["unresolved findings", (f, d) => { d.review.findings.push("unresolved"); }],
  ["duplicate receipt", (f, d) => { d.bundle.receipts[1] = structuredClone(d.bundle.receipts[0]); }],
  ["missing request trace review", (f, d) => { delete d.bundle.receipts[0].traceContext; }],
]) test(`${name} cannot pass the mixed audit handoff`, async (t) => {
  const f = await fixture(t), delivery = structuredClone(f.delivery); mutate(f, delivery);
  assert.throws(() => validateMixedDelivery(delivery, f.subject, f.sources));
});
test("rehashing retained context or changing plan commit cannot replace actual Git archive bytes", async (t) => {
  const f = await fixture(t), path = join(f.sources, "contexts/express.tar");
  const original = readFileSync(path); writeFileSync(path, Buffer.concat([original, Buffer.from("foreign")]));
  await assert.rejects(replayMixedSubject(f.plan, f.subject, f.repo, f.sources));
  const forged = structuredClone(f.subject); forged.sourcesManifest.snapshot = tree(f.sources);
  const { sha256, ...sourceBody } = forged.sourcesManifest; forged.sourcesManifest.sha256 = deploymentSha256(sourceBody);
  forged.requests[1].identity.contextArchiveSha256 = digest(readFileSync(path));
  const { subjectSha256: previousSeal, ...forgedBody } = forged; forged.subjectSha256 = deploymentSha256(forgedBody);
  await assert.rejects(replayMixedSubject(f.plan, forged, f.repo, f.sources), "matching self-rehashed context declarations cannot replace committed archive bytes");
  writeFileSync(path, original);
  writeFileSync(join(f.repo, "Cargo.toml"), "changed\n"); f.git("add", "."); f.git("commit", "--quiet", "-m", "different commit");
  await assert.rejects(replayMixedSubject({ ...f.plan, commit: f.git("rev-parse", "HEAD") }, f.subject, f.repo, f.sources));
  const changed = structuredClone(f.subject); changed.requests[0].identity.contextArchiveSha256 = "f".repeat(64);
  const { subjectSha256, ...body } = changed; changed.subjectSha256 = deploymentSha256(body);
  await assert.rejects(replayMixedSubject(f.plan, changed, f.repo, f.sources));
});
test("native receipts and actual built images must equal the accepted context-bound audit", async (t) => {
  const f = await fixture(t), folder = join(f.root, "native"); mkdirSync(folder); mkdirSync(join(folder, "source-audits"));
  const summary = { options: f.binding.execution.effectiveOptions, apps: {}, sourceAudits: {} };
  for (const [i, request] of f.subject.requests.entries()) {
    const app = request.identity.app, image = { id: `sha256:${"c".repeat(64)}`, buildCommit: f.plan.commit, buildDirty: "false",
      profile: "matched", contextArchiveSha256: request.identity.contextArchiveSha256 };
    summary.apps[app] = { buildInputs: request.sourceFiles, contextArchiveSha256: request.identity.contextArchiveSha256, image };
    writeFileSync(join(folder, `${app}-build-context.tar`), readFileSync(join(f.sources, `contexts/${app}.tar`)));
    const receipt = f.delivery.bundle.receipts[i], value = JSON.stringify({ identity: request.identity, sourceFiles: request.sourceFiles,
      imageId: image.id, receiptSha256: digest(JSON.stringify(receipt)), receipt });
    const path = `source-audits/${app}.json`; writeFileSync(join(folder, path), value);
    summary.sourceAudits[app] = { artifact: { path, sha256: digest(value) } };
  }
  const save = () => writeFileSync(join(folder, "summary.json"), JSON.stringify(summary)); save();
  assert.equal(validateMixedRun(f.binding, folder, f.subject, f.delivery.bundle), true);
  const retainedPath = join(folder, "source-audits/corten.json"), original = readFileSync(retainedPath), originalReference = summary.sourceAudits.corten.artifact;
  const replaced = JSON.parse(original); replaced.receipt.auditor = "another-independent-reviewer";
  const replacedBytes = JSON.stringify(replaced); writeFileSync(retainedPath, replacedBytes);
  summary.sourceAudits.corten.artifact = { ...originalReference, sha256: digest(replacedBytes) }; save();
  assert.throws(() => validateMixedRun(f.binding, folder, f.subject, f.delivery.bundle), "independently valid replacement is not accepted delivery");
  writeFileSync(retainedPath, original); summary.sourceAudits.corten.artifact = originalReference;
  summary.apps.corten.image.buildCommit = "d".repeat(40); save(); assert.throws(() => validateMixedRun(f.binding, folder, f.subject, f.delivery.bundle));
  summary.apps.corten.image.buildCommit = f.plan.commit; delete summary.sourceAudits.corten; save();
  assert.equal(validateMixedRun(f.binding, folder, f.subject, f.delivery.bundle), false);
});
