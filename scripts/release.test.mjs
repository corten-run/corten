// Holds the tag-only release's provenance and checksum gate in npm run check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const binaries = workflow.jobs.binaries;
const release = workflow.jobs["github-release"];

test("every matrix archive is attested before upload, with job-local permissions", () => {
  const attest = binaries.steps.findIndex((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
  const upload = binaries.steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.ok(attest >= 0 && attest < upload, "attest before transporting the build output");
  assert.match(binaries.steps[attest].uses, /^actions\/attest-build-provenance@[a-f0-9]{40}$/);
  assert.equal(binaries.steps[attest].if, undefined, "attest on every platform");
  assert.equal(binaries.steps[attest].with["subject-path"], "corten-${{ matrix.target }}.*");
  assert.deepEqual(binaries.permissions, { contents: "read", "id-token": "write", attestations: "write" });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(release.permissions.attestations, "read");
  assert.equal(release.permissions["id-token"], undefined);
  assert.equal(binaries.steps[upload].with["if-no-files-found"], "error");
});

test("the release verifies every checksum and the current build's attestation before publishing", () => {
  const sums = release.steps.findIndex((step) => step.name === "Write SHA256SUMS");
  const verify = release.steps.findIndex((step) => step.name === "Verify every release archive");
  const publish = release.steps.findIndex((step) => step.run?.includes("gh release create"));
  assert.ok(sums >= 0 && sums < verify && verify < publish, "evidence gates publication");
  assert.match(release.steps[sums].run, /sha256sum corten-\*\.tgz corten-\*\.zip > SHA256SUMS/);
  const gate = release.steps[verify];
  assert.equal(gate.if, undefined);
  assert.equal(gate["continue-on-error"], undefined);
  assert.match(gate.run, /sha256sum --check --strict SHA256SUMS/);
  assert.match(gate.run, /for archive in corten-\*\.tgz corten-\*\.zip; do/);
  assert.ok(gate.run.includes('grep -Fx -- "$(sha256sum "$archive")" SHA256SUMS'));
  assert.ok(gate.run.includes('gh attestation verify "$archive" --repo "$GITHUB_REPOSITORY"'));
  assert.ok(gate.run.includes('--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml"'));
  assert.ok(gate.run.includes('--source-digest "$GITHUB_SHA" --source-ref "$GITHUB_REF"'));
  assert.equal(gate.env.GH_TOKEN, "${{ github.token }}");
  assert.ok(!gate.run.includes("|| true"), "verification failures must fail the job");
  assert.match(release.steps[publish].run, /gh release create .* corten-\* SHA256SUMS /);
});
