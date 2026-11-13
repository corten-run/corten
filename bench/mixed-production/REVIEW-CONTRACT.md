# Native measurement admission

This supplements the runner README without changing the shared mixed workload or
marketplace checker. Existing captures are not retroactively qualified.

## Immutable upstream identity

The measured load injector returns `{ "traceparent": "00-<trace-id>-<span-id>-00" }`
from each authenticated operation arm. The driver sends this standard W3C Trace
Context header on native discovery, primary and readback HTTP requests. Each phase
has a different trace ID. A POST and its native redirects retain the primary trace.

Each native API client must propagate the incoming trace ID to its upstream record
fetch, including work delayed beyond the native response. Forwarding `traceparent`
unchanged or creating a valid child span with the same trace ID is supported. Capture
the context per native request; a process-global "current operation" is incorrect.
No trace exporter, cloud telemetry or application storage change is required.

`load-upstream.mjs` routes observations by immutable trace ID and validates the record
path against that operation. It never falls back to a currently armed path. Missing,
invalid, unknown and wrong-path identities are retained as failed orphan evidence.
An old delayed second fetch remains charged to the old operation after another arm.
Native clients without propagation are unsupported for measured API windows, not
silently timed. This is an implementation dependency for every selected candidate,
not an image-qualification option. Native ports are outside this runner's ownership.

The final ledger retains all operations, events, pending work and after-seal requests.
Non-write primary API reads require exactly one fetch. Native writes retain their
actual saved fetch count (at least one), including POST/303/GET revalidation permitted
by the shared oracle. Final drift, extra work after the saved observation and leaks
still reject admission. Preparation/readback operations remain separate.

## Independent native source audit

Semantic JSON comparisons cannot distinguish a native parser/serializer from a
byte-forwarding endpoint followed by the runner's own JSON parser. Timing therefore
also requires an independent source audit, using `verifyNativeReceipt` from the
existing JSON group. The runner never generates a positive audit.

Every automatic build uses a retained Git archive of its resolved commit, not the
working directory. Docker receives that exact archive buffer on stdin with its native
Dockerfile. Ignored or untracked files cannot enter `COPY . .`. Each context archive is
hashed, compared with the source snapshot and bound in image labels and audit identity;
the archive and extracted source remain evidence. `--build` resolves HEAD unless an
explicit `--build-ref` is given. Dirty harness diagnostics do not build uncommitted app
changes and cannot qualify measurements.

Fresh automatic builds save `<app>-source-audit-request.json` with an `identity` and
`sourceFiles` containing exact hashes of all tracked native build-context inputs.
Corten's Dockerfile copies the root context, so its audit binds the entire tracked
checkout, including workspace Cargo manifests, crates and build configuration. Inputs are
compared before/after building and again at measurement admission. The source audit
identity includes app, marketplace payload, mixed contract hash, native source commit,
configuration profile, context-archive hash and the input-set hash. The measured immutable image must have
the matching clean build labels. An audit remains source-specific across fresh builds;
it is not an arbitrary positive declaration about an image tag.

Supply `--native-audits <path>` alongside the existing `--build --measure` options.
The bundle can live outside the checkout or in ignored `results/`; admission still
requires a clean checkout. For example, append
`--native-audits bench/mixed-production/results/source-audits.json` to the normal command.
The JSON bundle has schema `mixed-native-source-audits/v1` and a `receipts` array, one
per selected inventory member. Each receipt uses `json-api-native-audit/v1`, copies the
exact requested `identity` and `sourceFiles`, names the independent `auditor` and
`auditedAt`, and has no unresolved `findings`. Its `verified` obligations are exactly
those of the JSON source-audit verifier: typed complete record, native serialization,
no output cache, no JSON pass-through, fixture parsing at startup, request-time native
fetch/parse and upstream errors. The reviewer must inspect the actual native call paths
for these facts; wire formatting and unused parser calls are not proof.
Mixed additionally requires `traceContext` with `requestScoped`,
`delayedWorkRetainsTrace` and `noAmbientCurrentOperation` all audited true. A client
which consults a mutable process-global trace when delayed work starts can still
misattribute work, so observing a header alone is not sufficient source qualification.

Missing, stale, incomplete, mismatched or negative audits leave every candidate/source
visible and block native qualification/calibration/timing. Requests are not receipts.
`measurement/<app>-source-audit.json` retains verified input/image binding and the
independent receipt. Audit trust is the same explicit human/independent-review trust
boundary as the JSON runner, not an automatic proof of arbitrary source behavior.

## Native DOM and resource evidence

`snapshot.mjs` extracts the existing mixed page schema from actual native HTML. It
retains marketplace visibility, control, table and text checks, but validates local
POST actions according to mixed's discovered-action contract. The GET filter must
retain the planned localized record path, even when an inline POST result has another
URL. No DOM action is rewritten and no expected markup enters this extractor.

Resource merging validates each original Docker stream's receipt order before merging
boundary samples. Backwards clocks are rejected rather than repaired by sorting. The
original stats log and JSON remain evidence; duplicate receipt timestamps remain real
duplicates and cannot fill sampling gaps. Whole-window boundary/gap checks still apply.
