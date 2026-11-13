// Holds the tag-only release's provenance and checksum gate in npm run check. The workflow is
// parsed, not matched as text, because what matters is job-scoped: which job holds which
// permission, and what each job needs before it runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const { jobs } = workflow;
const archives = workflow.env.ARCHIVES.split("\n");
const needs = (job) => [jobs[job].needs ?? []].flat();
const step = (job, uses) => jobs[job].steps.find((s) => s.uses?.startsWith(`${uses}@`));
const gate = jobs["verify-archives"].steps.find((s) => s.name === "Verify every release archive");
const create = jobs["github-release"].steps.find((s) => s.run?.includes("gh release create"));

test("one archive list names every matrix target's archive", () => {
  const targets = jobs.binaries.strategy.matrix.include.map(({ target }) => target);
  assert.equal(archives.length, 5);
  assert.deepEqual(
    archives,
    targets.map((t) => `corten-${t}.${t.includes("windows") ? "zip" : "tgz"}`),
  );
  assert.equal(step("attest", "actions/attest").with["subject-path"], "${{ env.ARCHIVES }}");
  assert.match(gate.run, /for archive in \$ARCHIVES; do/);
  assert.match(gate.run, /sha256sum \$ARCHIVES > SHA256SUMS/);
  assert.match(create.run, /gh release create "\$GITHUB_REF_NAME" \$ARCHIVES SHA256SUMS /);
});

test("only the attest job holds an OIDC token for the archives, and it builds nothing", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(jobs.binaries.permissions?.["id-token"], undefined);
  assert.deepEqual(needs("attest"), ["binaries"]);
  assert.deepEqual(jobs.attest.permissions, { contents: "read", "id-token": "write", attestations: "write" });
  assert.ok(!jobs.attest.steps.some((s) => s.uses?.startsWith("actions/checkout@") || s.run), "no checkout or build");
  assert.deepEqual(jobs["verify-archives"].permissions, { contents: "read", attestations: "read" });
  assert.deepEqual(jobs["github-release"].permissions, { contents: "write" });
  for (const [name, job] of Object.entries(jobs)) {
    if (name !== "attest" && name !== "publish") assert.equal(job.permissions?.["id-token"], undefined, name);
  }
});

test("every archive is verified before crates.io publishing and the GitHub release", () => {
  assert.deepEqual(needs("verify-archives"), ["attest"]);
  assert.ok(needs("publish").includes("verify-archives"), "the gate runs before publish and its approval");
  assert.ok(needs("github-release").includes("publish"));
  assert.equal(gate.if, undefined);
  assert.equal(gate["continue-on-error"], undefined);
  assert.match(gate.run, /^set -euo pipefail$/m);
  assert.match(gate.run, /\[ "\$found" = "\$expected" \] \|\| \{/, "exactly the expected archives");
  assert.ok(gate.run.includes('gh attestation verify "$archive" --repo "$GITHUB_REPOSITORY"'));
  assert.ok(gate.run.includes("--signer-workflow corten-run/corten/.github/workflows/release.yml"));
  assert.ok(gate.run.includes('--source-ref "$GITHUB_REF"'));
  assert.equal(gate.env.GH_TOKEN, "${{ github.token }}");
  assert.ok(!gate.run.includes("|| true"), "verification failures must fail the job");
  const sums = jobs["verify-archives"].steps.at(-1);
  assert.ok(sums.uses.startsWith("actions/upload-artifact@") && sums.with.path === "SHA256SUMS");
  assert.equal(sums.with["if-no-files-found"], "error");

  const release = jobs["github-release"].steps;
  const check = release.findIndex((s) => s.run?.includes("sha256sum --check --strict SHA256SUMS"));
  assert.ok(check >= 0 && check < release.indexOf(create), "checksums gate the release");
  assert.match(release[check].run, /^set -euo pipefail$/m);
  assert.ok(release[check].run.includes('[ "$(sha256sum $ARCHIVES)" = "$(cat SHA256SUMS)" ]'), "SHA256SUMS lists exactly the archives");
});

test("every action is pinned to a full commit, and checkouts keep no credentials", () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const s of job.steps ?? []) {
      if (!s.uses) continue;
      assert.match(s.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${s.uses}`);
      if (s.uses.startsWith("actions/checkout@")) assert.equal(s.with?.["persist-credentials"], false, name);
    }
  }
  assert.equal(jobs.binaries.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@")).with["if-no-files-found"], "error");
});
