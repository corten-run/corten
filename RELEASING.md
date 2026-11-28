# Releasing Corten

Maintainers own the release decision, approval and verification. Every published crate in
`crates/` ships at the same workspace version on crates.io; the examples have `publish = false`.
The [Release workflow](.github/workflows/release.yml) also publishes the prebuilt `corten` command
on GitHub.

## Readiness checkpoints

At each checkpoint, compare the candidate on `main` with the last published release. Skip when
there is nothing useful to ship, a gate below is not met, or no maintainer can approve the run
and verify its outputs. A checkpoint is a decision, not a deadline or a publish trigger.

**Proposed cadence, pending maintainer approval:** try Tuesday and Thursday checkpoints for
four weeks. Then review fix-to-release delay, maintainer effort and follow-up regressions before
keeping or changing the cadence. No schedule is in effect until approved.

1. Resolve known applicable P0/P1 defects and address regressions against the last release. For
   each known regression, fix it, leave the change out, or record why its user impact is acceptable;
   that last option does not waive an applicable P0/P1. Backlog priority alone is not a release
   gate: a P1 enhancement or administrative issue does not block a candidate it does not affect.
2. Require passing [checks](CONTRIBUTING.md#checks), [independent review](CONTRIBUTING.md#review)
   and [performance evidence](CONTRIBUTING.md#pull-requests) where a change affects rendering,
   the runtime or the request path. Apply these to the changes being shipped, not only the
   version bump. Take
   [`bench/request-cost`](bench/request-cost/README.md)'s counts of the candidate and of the
   last release's tag and record both in the release-preparation pull request, or that its
   probe does not build against that tag, unless
   [the trend's page](bench/placement/trend/README.md) has a row to cite in their place: its
   base is the last release's tag, its head is the commit of `main` to which the candidate
   adds that pull request alone, and every workload is read. The row stands in for the counts
   only when that pull request adds no change to code a request runs. The first row, of
   2026-11-26, reads `main` at `056aba61c` against `v0.2.0`, so a candidate made from a later
   commit of `main` has no such row until a run reads that commit. A row past its threshold is
   no gate. The first release to record the counts is
   the baseline:
   the changes before it were not counted. From the release after it, a case that counts over
   2% more is no gate: it reopens
   [design Choice 76](docs/design.md#choice-counted-or-measured).
3. Make the changelog explain what users get and what they need to do. Ship related breaking
   changes as one coherent upgrade, with updated guides and migration steps, not successive
   releases that leave users between APIs. Before 1.0, a release that changes the API bumps the
   minor version; a compatible fix can ship in a patch release.

### Urgent patches

Do not wait for a checkpoint for a security vulnerability, data loss, broken installation or
another serious regression in a published version. Keep the candidate focused on the fix; an
unrelated P1 need not delay it, but review, checks and human approval still apply. The fix ships
as a patch of the newest published minor version, as [SECURITY.md](SECURITY.md#supported-versions)
promises for security fixes. If `main` has no unshipped API changes, prepare the patch on `main`.
If it does, do not ship them in a patch: prepare the patch from the newest release's tag with only
the fix ([Patch from a release tag](#patch-from-a-release-tag)).

For a [privately reported vulnerability](SECURITY.md), develop and review the fix in the
advisory's temporary private fork and run applicable checks privately before merging. Merge from
the [GitHub advisory page](https://docs.github.com/en/code-security/tutorials/fix-reported-vulnerabilities/collaborate-in-a-fork#merging-changes-in-a-security-advisory),
not from a public pull request. Verify the fix is on `main` and the release candidate passes the
normal gates. Publish the advisory only after the fix is on `main` and the maintainer approves
publication. Coordinate disclosure with the fixed release so users know what to install.

## Prepare the candidate

1. Check that every crate in `crates/` is already on crates.io and that its publishing and
   ownership settings match [the safeguards below](#publishing-and-ownership). For a crate not
   yet on crates.io, plan the [bootstrap](#before-a-release-that-adds-a-crate) before proceeding.
   Open its temporary token window only after validating the candidate and before pushing the tag.
2. Open one release-preparation pull request. Set `version` in `[workspace.package]` and the same
   version on every `corten*` entry in `[workspace.dependencies]` in `Cargo.toml`. Update
   `Cargo.lock` and the benchmark app lockfiles that build from `crates/`: `bench/catalog/corten`
   and `bench/marketplace/corten` (built with `--locked`), `bench/live/apps/corten` and
   `bench/nodelay/app`. `cargo metadata --manifest-path <app>/Cargo.toml` rewrites an app's
   lockfile. Update `crates/corten/tests/openapi.json` (the test that checks it rewrites it) and
   the README's Status where the version shown there changes.
3. Run `node scripts/changelog.mjs release X.Y.Z YYYY-MM-DD` with the release version and date.
   It puts fragments starting with `**Breaking:**` first, then the rest, in filename order within
   each group. It moves any inline Unreleased entries after them without reordering and keeps the
   pending-notes link under `## Unreleased`. It moves the previous release section unchanged to
   `CHANGELOG.X.Y.Z.md` beside `CHANGELOG.md` and adds its link under `## Release archive`.
   If archive creation succeeded but the index is unchanged after a failure, rerun the same
   command. It reuses byte-identical archives and refuses to overwrite a differing archive.
   Review the changelog diff and include the archive and fragment deletions in the preparation
   pull request. Repoint links that named the moved headings in `CHANGELOG.md`; `npm run check`
   checks anchors in both the current changelog and archives, accepting known anchors and skipping
   unmatched ones only if the target file has a heading whose anchor cannot be determined.
   Check the new section contains any upgrade instructions. Get the preparation pull request
   independently reviewed and merge after its required checks pass.
4. Record the resulting commit SHA on `main`. Confirm the release gates against that exact
   commit, including green CI, the workspace publish dry run in the checks and
   `node scripts/changelog.mjs --check-release` from a clean checkout of that SHA. The command
   fails if any fragments or inline Unreleased entries remain. The pending-notes link may stay.
   If a fragment or an inline entry lands after collection, rerun preparation from the updated
   base. If preparation already merged, restore its consumed fragments and prior inline
   Unreleased entries, remove its untagged version section (leaving the archive and its links
   alone), and rerun step 3 in a follow-up preparation PR, keeping any notes that arrived since
   the original cut. A check on the pull
   request head or a later tip is not a check on this candidate. If the candidate changes,
   repeat validation on the new SHA before tagging it.

### Patch from a release tag

Use this only for an urgent patch when `main` has unshipped API changes. It is a short-lived
branch for one patch, not a maintained release branch.

1. Merge the fix to `main` first (for a private advisory, from the advisory page as above).
2. Create a branch for the new patch version `X.Y.Z` from `vX.Y.W`, the tag of the newest
   published release (the latest patch of the newest minor version), and push it:
   `git switch -c patch/X.Y.Z vX.Y.W` and `git push origin patch/X.Y.Z`.
3. Open the release-preparation pull request against that branch. Cherry-pick the fix from
   `main` (`git cherry-pick -x <fix-commit>`) and apply steps 2 and 3 above to the files the patch
   tree has (a lockfile or example added on `main` since the tag is not added). For step 3, put
   only the fix's own note in `changelog.d/`, even if it was inline on `main`. If the tag
   predates the fragment script, put that note under `## Unreleased` in `CHANGELOG.md` instead,
   rename the heading to `## X.Y.Z (YYYY-MM-DD)`, and put a new empty `## Unreleased` above it.
   Also carry `main`'s `SECURITY.md` (the tag's may name an older supported version) and its current
   `.github/workflows/release.yml` and the scripts it runs, including the current
   `scripts/changelog.mjs` for its pending-notes check. GitHub runs the workflow as the
   tagged commit has it, so an older tag's workflow would publish without the attestation and
   checksum gates the [verification](#verify-what-users-received) below expects.
   Keep the tag's own `ci.yml`, which `release.yml` calls: it checks the tree it was written
   for, and `main`'s expects files the tag lacks. If `release.yml` needs anything from `ci.yml` the
   tag's copy lacks, add only that to the patch branch's `ci.yml`, reviewed in the same pull
   request, so the fix still ships as the patch `SECURITY.md` promises. It gets the same review and
   checks; CI runs on pull requests to any branch.
4. Record the merged commit's SHA on the patch branch as the candidate. At that SHA, confirm
   `git diff origin/main CANDIDATE_SHA -- .github/workflows/release.yml` prints nothing and
   `git diff vX.Y.W CANDIDATE_SHA -- .github/workflows/ci.yml` prints nothing beyond what step 3
   added. Run `node scripts/changelog.mjs --check-release` at that SHA too. CI does not run on
   pushes to that branch, so run the [checks](CONTRIBUTING.md#checks)
   the tag's tree has on that commit before tagging it; the Release run also reuses CI on the
   tagged commit before anything publishes. Right before tagging, confirm `vX.Y.W` is still the
   newest published release: the highest version of `corten` on crates.io that is not yanked,
   which is what users install and what `SECURITY.md` means by the newest published minor. If a
   newer minor shipped meanwhile, patch from its tag instead. Prepare one release at a time, so a
   patch and a minor are never tagged in parallel. Then [publish](#publish) that SHA.
5. After the release, add its versioned section to `main` in a pull request, keeping only the
   newest release in `CHANGELOG.md`. Move the older of the two sections unchanged into its
   own `CHANGELOG.X.Y.Z.md` and link it under `## Release archive` in version order. Remove the
   fix's pending entry from `changelog.d/` (or from `## Unreleased` if it was an inline entry)
   so it is not released twice.

## Publish

Before every tag push, check that the protected `release` environment exists, has at least one
required reviewer and allows deployments only from tags matching `v*`:

```sh
gh api repos/corten-run/corten/environments/release --jq '.protection_rules'
gh api repos/corten-run/corten/environments/release/deployment-branch-policies --jq '.branch_policies'
```

The first must list a `required_reviewers` rule with a reviewer and a `branch_policy` rule; the
second must list exactly one policy, `v*` with type `tag`, and nothing else (a branch policy or a
broader pattern would let something other than a release tag deploy). If either command fails
(a 404 means the environment is missing), any rule is absent, or there is another policy, stop
and do not push the tag. GitHub creates an environment a
workflow names without protection rules, so `publish` would run with no approval. A repository
admin restores the protection first.

Then replace `X.Y.Z` and `CANDIDATE_SHA` below, tag the validated commit explicitly and push
only that tag:

```sh
git tag -a vX.Y.Z CANDIDATE_SHA -m "Corten X.Y.Z"
git push origin vX.Y.Z
```

1. The tag push starts `Release`. It reuses `CI`; its `version` job checks the tag against the
   `corten-run` version, refuses a tagged commit with pending fragments and extracts the
   matching, nonempty `CHANGELOG.md` section. After both jobs pass, `binaries` builds the five
   locked release binaries and uploads their archives:
   Linux musl x86_64 and aarch64, macOS x86_64 and aarch64, and Windows x86_64.
2. `attest` signs build provenance in a separate job that builds nothing; the archive builders
   do not hold an OIDC token. `verify-archives` requires exactly the five expected archives,
   verifies each attestation against this workflow, commit and tag, and produces `SHA256SUMS`
   and its digest. Failure stops the run before publish approval.
3. A maintainer who is a required reviewer of the protected `release` environment confirms the
   run is for the validated SHA and tag, the upstream jobs passed, and the publishing settings
   are right for this run. Only then approve. `publish` authenticates through
   `rust-lang/crates-io-auth-action` unless `CARGO_REGISTRY_TOKEN` is set for a new-crate
   bootstrap, and runs `cargo publish --workspace --locked` in dependency order.
4. After `publish` succeeds, `github-release` checks the downloaded `SHA256SUMS` against the
   digest from `verify-archives` and the archives against exactly the checksums it lists. It
   creates the GitHub release with those archives, `SHA256SUMS` and the extracted release notes.
   If the section exceeds 125,000 bytes, the workflow attaches `CHANGELOG-X.Y.Z.md` and links to
   it and the tagged changelog from the notes instead.

## Verify what users received

These are maintainer checks after publication, not jobs in the workflow. A green run is not a
substitute for checking the public outputs.

1. On crates.io, confirm that every published workspace package has the expected version and
   it is not yanked: currently `corten-run`, `corten-macros`, `corten-cli`, `corten-feed`,
   `corten-protocol`, `corten-cluster` and `corten-ui`.
2. Check that the GitHub release is public, is on the expected tag and has the expected notes
   and any notes attachment. Download all five CLI archives and `SHA256SUMS` from that release.
   Check the file list against the workflow's `ARCHIVES` and run
   `sha256sum --check --strict SHA256SUMS` with all five present. Follow
   [Verify a prebuilt binary](docs/guide/getting-started.md#verify-a-prebuilt-binary)
   for each archive, adding `--source-digest <candidate-sha>` to the attestation check. The
   checksum detects changed bytes; only the attestation identifies the build. Extract the
   verified archives and run `corten --version` on matching platforms to confirm the binaries
   run and report the release version. Record which targets were run; a checksum is not a run
   on that platform. `cargo binstall` checks HTTPS only, not this provenance
   ([Choice 49](docs/design.md#choice-release-verification)).
3. In a clean directory outside the checkout, install the published CLI with
   `cargo install corten-cli --version X.Y.Z --locked --root ./release-check`. Use the installed
   binary from `release-check/bin`, not a copy already on `PATH`, and check `corten --version`.
   Run `corten new release-smoke` without `--corten-path`. In the generated app, resolve the
   release with `cargo update -p corten-run --precise X.Y.Z` and confirm `Cargo.lock` has the
   expected crates.io versions of the Corten packages it uses. Run `corten check` with
   [supported TypeScript](docs/guide/getting-started.md#install-and-create-an-app) and no skips.
   Then build the app's image with a profile, with the script from
   [A profile-guided build](docs/guide/deploy.md#a-profile-guided-build) saved in the app as
   `train.sh`: `docker build --progress=plain --build-arg PROFILE_FROM=train.sh .`. This is the one place the
   Dockerfile's install line runs as written, since it names the release just published: the
   build fails if that release's `corten build` has no `--profile-from`, and its output names
   the four steps of a profiled build when it has.
4. Record the candidate SHA, run, version and verification results in the release-preparation
   pull request. Treat a missing or failing output as incomplete and use the recovery below.

## Recover a failed release

First record the run, tag, failed job and versions actually visible on crates.io. Check for
registry indexing delay before concluding an upload did not reach the registry. Do not announce
completion while a registry package or a release asset is missing.

- **Nothing published:** for a transient failure, [rerun the failed jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)
  on the same SHA and tag, with approval when requested. If the release adds a crate, its
  bootstrap exception was closed after the failed run, and a rerun without the secret would use
  trusted publishing, which cannot publish the new crate. Never rerun such a release that way:
  first get the maintainer's approval to reopen the exception, repeat bootstrap steps 1 and 2
  with a new short-lived token, rerun, then close it again (step 4) whatever the outcome. If
  source or workflow code needs a change, prepare and validate a new candidate at an unused
  version and tag; do not move the pushed tag.
- **Only some crates published:** do not rerun `cargo publish --workspace --locked` expecting it
  to skip existing versions, or finish with ad hoc local uploads. Fix the cause, prepare the
  next coordinated version (normally a patch) and release it through the same gates. Record
  which versions escaped and consider yanking only where they are unsafe or unusable.
- **All crates published, GitHub release or assets missing:** if `publish` succeeded and the
  release does not exist, rerun only `github-release` for the same tag if its verified artifacts
  are still available. If `publish` failed despite the uploads, the workflow cannot reach
  `github-release`; use a corrective version rather than bypassing the failed job.
  If the release already exists and GitHub permits asset repair, a maintainer may approve
  attaching only the missing, original verified assets from that run. Check the checksum
  file's digest against the run's verified digest and verify archive checksums and provenance
  first. If the failed upload left a draft, publish it only with maintainer approval after
  checking the tag, notes and complete asset set. Do not overwrite an existing asset with
  different bytes. If the original verified bytes are unavailable or the release cannot be
  repaired, cut a corrective version. Repeat the public verification after recovery.
- **Defective release:** document the affected versions, impact and upgrade or mitigation.
  Publish a corrective release; crates.io versions cannot be overwritten, and a public tag is
  not moved. With maintainer approval, yank an affected crate version
  (`cargo yank --version X.Y.Z <crate>`) when new resolutions must avoid it, for example for data
  loss, a serious security defect or a broken build. Check the effect on dependent Corten crates;
  prefer making the fixed version available first when safe. A yank does not remove the crate
  or update existing lockfiles; users still need the mitigation or upgrade
  ([Cargo's yank behavior](https://doc.rust-lang.org/cargo/reference/publishing.html#cargo-yank)).

## Publishing and ownership

Every published crate has one trusted publisher (GitHub, repository `corten-run/corten`,
workflow `release.yml`, environment `release`) and accepts trusted publishing only after any
new-crate bootstrap. Only that workflow, approved in the protected environment, publishes
routine versions. Keep both a user owner and the `github:corten-run:maintainers` team as
owners, so publishing or yanking does not depend on one account. Team owners cannot change
crate ownership; that stays with user owners.

The framework's package is `corten-run` and its library is `corten` (`[lib] name` in
`crates/corten/Cargo.toml`), so apps and the paths `corten-macros` generates still name it
`corten`. The `corten` name on crates.io is someone else's placeholder; crates.io does not
transfer it without its owner
([#835 The main crate cannot be published: corten on crates.io is an empty 2022 placeholder, so choose its package name (corten-run) or wait for crates.io](https://github.com/corten-run/corten/issues/835)).
If crates.io frees the name, take it only so no one else can, and keep publishing `corten-run`:
moving back would be a second rename for every app. The `corten` command still reads an app's pin
under the old name (`PACKAGES` in `crates/corten-cli/src/pin.rs`).

### Before a release that adds a crate

crates.io allows trusted publishing only for a crate that already exists. A first publication
needs a one-time API token. The maintainer approves this exception and the same release gate
still applies. Prepare the candidate before opening the token window.

1. Sign in to crates.io with the GitHub account that will own the crates (an admin of
   `corten-run/corten`). Confirm that the `release` environment has a required human reviewer.
   In that environment only, add the secret `CARGO_REGISTRY_TOKEN`: a crates.io token with
   `publish-new` and `publish-update` scopes, expiring in a few days.
2. Allow token publishing temporarily on each already-published crate in the release. With
   the secret set, the workflow skips trusted-publishing authentication and uses that token for
   the entire workspace, not only the new crate. A crate set to trusted publishing only would
   refuse it and could stop the run partway through.
3. Follow [Publish](#publish) with the protected environment approval. Check what actually
   reached crates.io, even if the run failed. For each newly published crate, set the trusted
   publisher above. Correct or remove any wrong publisher on existing crates as well. If the team
   is missing as an owner, add it while keeping a user owner:
   `cargo owner --add github:corten-run:maintainers <crate>` with a `change-owners` token.
   crates.io adds a team only for a member of it and only after crates.io has been granted access
   to the `corten-run` organization on GitHub.
4. Restore trusted-publishing-only on all affected crates, including any newly published ones,
   delete the environment secret and revoke the bootstrap token. Close the exception even on a
   failed run. A retry reopens it only with the maintainer's approval, as
   [the recovery procedure](#recover-a-failed-release) describes. Later routine releases use
   trusted publishing with no stored token. Finish the public verification above.
