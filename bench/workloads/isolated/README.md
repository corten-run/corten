# Bound isolated execution contracts

This is an offline, source-bound execution contract, not a launcher, functional collector,
cloud reservation or passing benchmark. It covers the exact nine official registry groups.
It does not build applications, run native checks, allocate rounds, inspect credentials,
call a provider, publish results or alter nightly work. Popular-choice and performance views
share these same native executions and raw evidence; they are not extra runs.

## Use

Run from a clean, committed checkout containing this module:

```sh
node --test bench/workloads/isolated/contract.test.mjs
```

The module API accepts an explicit full current commit. Obtain it through the integrating
caller's existing source-verification path, not from an untrusted artifact. For example:

```js
import { bindExecution, validateBinding } from "./bench/workloads/isolated/contract.mjs";

const binding = bindExecution({
  group: "catalog-page", round: "c2", commit: measuredCommit,
  recipe: "native-defaults", review: null,
});
const checked = validateBinding(JSON.parse(JSON.stringify(binding)));
// checked.binding === "verified-offline"
// checked.ready === false; checked.executionAuthorized === false
```

There is no command-line execution interface. The only subprocesses used by this module
are fixed read-only Git queries. No API accepts an executable, shell command, flags,
contender/case filter, image substitution, environment map, receipt path or output directory.
Native invocations, preparation fixture commands, artifact roots and report invocations are
derived, never interpolated from caller-provided command fragments.

## Identity

`captureSources` requires the full current HEAD, the same HEAD the module loaded, and an
entirely clean checkout including untracked files. The contract itself must be committed.
It hashes the actual committed Git blob bytes for the fixed source boundary: root manifests
and instructions, docs, bench, crates, scripts and the card-market example. Runtime/build
inputs and locks within that boundary are retained, including native app Dockerfiles and
the contract/tests. Historical results, evidence, work directories and dependency/target
outputs are excluded. Source links and submodules are refused. Git bytes avoid CRLF-dependent
cross-platform fingerprints; local changes are checked before and after hashing.

The binding freezes the measured SHA, all source hashes, official registry definition and
selection hash, exact contenders/cases, retained families, native arguments, effective
options, intended c-8 host description, resource expectations and strict validation state.
`validateBinding` rereads the actual current committed source and reconstructs everything.
Changing fields and computing a new caller-side hash cannot bypass that comparison.
Native client-heavy/live CLI snapshots additionally pin their default-defining source files;
a source change fails closed until the adapter is reviewed, rather than guessing new defaults.

This verifies integrity against local committed source, not who approved that source or
whether it is merged upstream. Git history/ref freshness, independent parity review, real
image/build provenance and effective deployment remain separate requirements.

## Native recipes

`native-defaults` is supported for every group. Fresh builds and required output/review
references are explicit operational options, separate from timing/workload defaults.
The module records the actual parser defaults where dependency-free native parsers exist.
It does not replace any native admission gate or default profile.

| Group | Round and fixed preparation | Native defaults and retained evidence |
|---|---|---|
| Catalog page | `cN`, excluding historical `c1`; catalog fixtures; `--build --group catalog-page` | Three passes, 60 s phases, 30 s warmup, rate 150. Both-source page and JSON/browser gates precede page-only timing. Entire `bench/catalog/results/<round>` and strict commit-bound report. |
| JSON API | `jN`; both fixtures; `--build --group json-api` | Same 60/30/150 defaults. All 36 functional cells plus independent exact-image native-source audits. Receipt staging is blocked here, not invented or waived. Entire results tree and strict commit-bound report. |
| Localized marketplace | `wN` or native official `rN` starting at r17; marketplace fixtures; `--build --group localized-marketplace` | Native defaults are 60/30/150, not the separate short-window cloud profile. Exact-image production/browser gates; preserve excluded/stopped outcomes. Native report has no strict-completeness flag; collection must separately check complete selected coverage. |
| Mixed production | `wN --build`; runner generates fixture | Default functional-only profile, seed 42, two clients, one repetition. Measurement defaults remain three passes, 120 s windows, 15 s warmup, 30 s calibration, 120 s tail, 16 cycles. Raw captures, readbacks, faults and measurement tree stay separate. No standalone validator yet. |
| Full-stack browser | `wN --build --out bench/fullstack-browser/work/<round>` | All ten apps and 240 profiles, native desktop/mobile settings. Host Chromium, local Node tool image and free SvelteKit loopback port 8080 required. Native lifecycle/aggregation gaps and absent standalone validator remain blocked. |
| Client-heavy | Safe explicit round; `--out bench/client-heavy/work/<round>` | Always builds all six native bundles and runs Corten's Rust generator; no `--build` flag, receipt substitution or Cargo override. Sizes 14/110/7/24. Separate qualification/measurement, `result.json`, raw captures and `native/`. No standalone validator or OS isolation. |
| Live delivery | Safe explicit round; `--group live-delivery --build` | Preserve the group flag to avoid historical mode. Default bounded correctness: 24 events, queue 2/history 4, no measurement. Corten is incompatible with that profile; missing registrations remain visible. Entire `bench/live/results/parity/<round>` and shared verifier. |
| Recoverable live | Safe explicit round; `--build` | Same bounded defaults, six recovery scenarios. Entire `bench/recoverable-live/results/<round>` and shared verifier. Missing registrations and Corten's default-profile incompatibility are blockers, not substituted transports. |
| Hardening | `wN --build --review <exact-subject-hash>` | Existing bounded profile and matched native production adapters, all 216 cells. Direct/edge qualification stays separate. The required review-reference string alone establishes no approval. Entire results tree, raw controls/receipts and native verifier. |

Only three named override recipes exist: `marketplace-short-window` (three passes,
15 s phases/10 s warmup/rate 150), `mixed-measure` (adds measurement without changing the
default native profile/settings), and `native-feed-measure` for either live group
(native-feed for every candidate, 1,044 events, queue 1,024/history 1,025, then the native
1/2/4-browser measurement levels). No arbitrary numeric tuning, matched-profile switch,
sustained attack override or alternative deployment selection is accepted.

`reviewSubject(request)` returns the exact source/registry/round/recipe subject hash.
A review declaration has schema `benchmark-isolated-review/v1`, that `subjectSha256`,
a named `reviewer`, and `decision: "approved"`. It is mechanically checked for this exact
subject and retained as `declared-not-authenticated`, never independent-review proof.
Missing declarations remain unknown; even a matching declaration cannot authorize execution.
Requested overrides are always separate from recorded native defaults.

## Resources and validation

The intended host copies the existing catalog c-8/sfo2/Ubuntu contract; allocation and
isolation remain unobserved. Timed HTTP roles retain native 1/2/4 CPU quotas and explicitly
record intended app/upstream/load pinning `1`/`2-3`/`4-7` using each native environment prefix.
Those settings are expectations, not observed environment or native defaults. Mixed
functional capture has separate 1/2/2 CPU app/upstream/capture budgets; only its explicit
measurement recipe requests the measured CPU placement. Host drivers/checkers remain
unisolated. Browser/live/client-heavy and hardening cannot borrow the HTTP pinning adapter.
Hardening keeps its declared complete direct/edge process budgets, not one normalized server.

Every contract keeps native evidence unknown, validators not run or explicitly missing,
coverage cells unknown/not-run, `ready:false` and `executionAuthorized:false`.
Complete flags, verifier exit zero, source presence, matching declarations and self-consistent
hashes cannot promote those states. Failed, unsupported, stopped and not-run outcomes must
stay visible; unavailable measurements must never become numeric zero.

`validateArtifactPaths(binding, paths)` validates the exact native round namespace,
required entry files and safe non-colliding path segments. It reads no artifact files and
does not establish existence, file type, hashes, native correctness or collection safety.
The **entire** native output tree is required later, not only its summary. Standalone native
report/replay commands are recorded where they exist, including their actual supported flags.
Mixed/browser/client-heavy need separate complete validators before a collector can qualify them.

## Checkpoint boundary

This slice performs real offline source/recipe/namespace binding and hostile validation tests.
It intentionally stops before functional collection, durable reservation, ownership checks,
terminal-unit collection, archive hashing/extraction and deletion. A future approved controller
should reuse catalog's safety machinery rather than duplicate it, preserving uncertain hosts
and durable evidence. No such machinery or permission is supplied here.

Only this new directory is changed. Existing check-script integration, guide/changelog edits,
repository-wide checks and independent review belong to the integrating parent; this bounded
task does not authorize editing those paths or spawning a reviewer.
