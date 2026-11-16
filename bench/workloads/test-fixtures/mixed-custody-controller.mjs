// Synthetic identities isolate the archive-content predicate. No provider, SSH,
// native qualification, audit approval, or production reservation is exercised.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import * as cancellation from "../cloud-cancellation.mjs";
import { digest, treeHash } from "../cloud-local.mjs";

const wait = { ...cancellation.mixedWait, campaign: "r21-0123456789abcdef" };
mock.module(new URL("../cloud-cancellation.mjs", import.meta.url).href, { namedExports: {
  ...cancellation, mixedWait: wait, ownedMixedWait: () => wait,
  cancellationState: () => {}, verifyMixedCancellation: () => {},
} });
const { failedNativeArchive } = await import("../cloud-retirement.mjs");
const hash = cancellation.mixedDigest;
function fixture(t, largeContext = false) {
  const local = mkdtempSync(join(tmpdir(), "mixed-custody-"));
  t.after(() => { assert.ok(local.startsWith(join(tmpdir(), "mixed-custody-"))); rmSync(local, { recursive: true, force: true }); });
  const extracted = join(local, "evidence-test"), folder = join(extracted, "campaign"), dir = join(folder, wait.campaign);
  mkdirSync(dir, { recursive: true });
  const sources = join(dir, "mixed-audit-sources"); mkdirSync(sources); mkdirSync(join(sources, "blobs")); mkdirSync(join(sources, "contexts"));
  const apps = ["corten", "express"], files = ["README.md", "bench/fullstack/apps/express/server.mjs"].map((path) => {
    const bytes = Buffer.from(`synthetic source ${path}`), sha256 = digest(bytes), storedAs = `blobs/${sha256}`;
    writeFileSync(join(sources, storedAs), bytes); return { path, sha256, storedAs, bytes: bytes.length };
  });
  for (const app of apps) writeFileSync(join(sources, "contexts", `${app}.tar`), largeContext && app === "corten"
    ? Buffer.alloc(17 * 1024 ** 2, 120) : `synthetic opaque context ${app}`);
  const entries = [{ path: "", type: "directory" }];
  for (const name of ["blobs", "contexts"]) {
    entries.push({ path: name, type: "directory" });
    for (const file of readdirSync(join(sources, name)).sort()) {
      const bytes = readFileSync(join(sources, name, file)); entries.push({ path: `${name}/${file}`, type: "file", bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  const manifest = { files, snapshot: { entries, sha256: hash(entries) } }; manifest.sha256 = hash(manifest);
  const binding = { request: { group: "mixed-production", round: "w21", commit: wait.commit },
    validation: { artifactRoot: "bench/mixed-production/results/w21" }, selection: { apps, contractSha256: "c".repeat(64) },
    execution: { effectiveOptions: { profile: "matched" } } };
  const plan = { schema: "benchmark-isolated-group-campaign/v1", commit: wait.commit, round: "r21", order: ["mixed-production"], bindings: [binding] };
  plan.campaignSha256 = hash(plan); wait.campaignSha256 = plan.campaignSha256;
  const subject = { schema: "benchmark-mixed-audit-subject/v1", scope: "committed-source-and-build-context-not-built-image",
    campaignSha256: plan.campaignSha256, commit: wait.commit, round: "w21", bindingSha256: hash(binding), sourcesManifest: manifest,
    requests: apps.map((app) => {
      const prefix = app === "corten" ? "" : `bench/fullstack/apps/${app}/`;
      const sourceFiles = files.filter((f) => f.path.startsWith(prefix)).map(({ path, sha256 }) => ({ path, sha256 }));
      return { identity: { app, payload: "marketplace-v2", key: "mixed-native-source", commit: wait.commit,
        contractSha256: binding.selection.contractSha256, nativeProfile: "matched",
        contextArchiveSha256: digest(readFileSync(join(sources, "contexts", `${app}.tar`))), buildInputsSha256: digest(JSON.stringify(sourceFiles)) }, sourceFiles };
    }) };
  subject.subjectSha256 = hash(subject); wait.subjectSha256 = subject.subjectSha256;
  const status = { campaign: wait.campaign, round: "r21", campaignSha256: plan.campaignSha256, state: "preserved-uncertain",
    uncollectedNativeRoots: [], outcomes: [{ group: "mixed-production", outcome: "not-run" }] };
  const json = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
  json("plan.json", plan); json("mixed-audit-subject.json", subject);
  json(wait.event, { at: wait.waitAt, subjectSha256: subject.subjectSha256, status: { state: "blocked-review-needed" } });
  json("00000-authorized.json", {}); json("00001-started.json", {});
  json("00003-halted.json", { kind: "halted", sequence: 3, campaign: wait.campaign, campaignSha256: plan.campaignSha256, status });
  json("campaign-result.json", { status, wholeHostTerminal: "parent-must-observe", deletionAuthorized: false });
  writeFileSync(join(folder, ".host-attempt.json"), JSON.stringify({ id: wait.campaign, campaignSha256: plan.campaignSha256, commit: wait.commit }));
  writeFileSync(join(extracted, "exit-code"), "2\n"); writeFileSync(join(local, "results.tgz"), "synthetic already-extracted archive fixture");
  const state = { commit: wait.commit, round: "r21", group: "mixed-production", mixedCancellation: {}, evidence: "evidence-test",
    archiveSha256: digest(readFileSync(join(local, "results.tgz"))), evidenceSha256: treeHash(extracted) };
  return { local, state, sources, files, reseal: () => { state.evidenceSha256 = treeHash(extracted); } };
}
test("intact original mixed source blobs and build contexts are retained without qualification", (t) => {
  const f = fixture(t); assert.equal(failedNativeArchive(f.local, f.state).campaign, wait.campaign);
});
test("captured contexts larger than the controller JSON limit are streamed", (t) => {
  const f = fixture(t, true); assert.equal(failedNativeArchive(f.local, f.state).campaign, wait.campaign);
});
for (const kind of ["missing-blob", "changed-blob", "missing-context", "changed-context", "changed-other-context", "missing-source-root", "extra-file"]) {
  test(`wrapper tree hash cannot conceal ${kind} from the pinned mixed subject`, (t) => {
    const f = fixture(t), path = join(f.sources, kind.endsWith("blob") ? f.files[0].storedAs
      : kind === "changed-other-context" ? "contexts/express.tar" : "contexts/corten.tar");
    if (kind === "missing-source-root") rmSync(f.sources, { recursive: true });
    else if (kind.startsWith("missing")) unlinkSync(path);
    else writeFileSync(kind === "extra-file" ? join(f.sources, "contexts/extra.tar") : path, "altered captured payload");
    f.reseal(); assert.throws(() => failedNativeArchive(f.local, f.state));
  });
}
