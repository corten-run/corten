# Gin trace functional proof

Local native Go checks, not an independent source-audit receipt, qualification,
mixed-workload admission, calibration or performance measurement.

Base: `cade9017e571710472884e4608127fa1f1ad50bf`. Upstream was fetched read-only;
`origin/main` was `79295b3727d4e56903c8578a9d1396d3f84ccedd`. The scoped upstream
`marketplace.go` and `record_http.go` matched the pinned base. No parent checkout
files were changed. The task explicitly excludes agents and shared changes, so
independent review, shared CHANGELOG, CI/runner changes and full Rust/framework
checks are left to integration.

The pinned native Go/templ environment was the existing `cb-neutral-gin-build`
image (Go 1.27.3). Commands ran in the app directory with the repository's native
dependencies and generated templ views. No application dependency was added.

## Raw attempts

- `before.txt`: `templ generate` then
  `go test -run TestMarketplaceTraceHTTP -count=1 -v ./...`, before the fix.
  Expected failure: missing parent/state at the real source socket for both API
  profiles, every page/form locale and JSON GET/HEAD. Both fixture groups passed.
- `after-focused.txt`: an intermediate build failed because a helper moved while
  an earlier compile still had the old test file list. This was a test-edit race,
  not a passing run or an adapter failure.
- `after-expanded.txt`: all real-HTTP trace groups and the delayed snapshot passed,
  but the validation unit test failed: uppercasing a digits-only trace had not
  actually made it invalid. Its input was corrected to contain uppercase hex.
  The validator was not changed to accept the erroneous assertion.
- `final-tests.txt`: full native app `go test -count=1 -v -timeout=120s ./...`,
  passed (`ok itempage 47.807s`, measured test duration, not a speed result).
- `repeated-tests.txt`: `go test -run TestMarketplaceTrace -count=10 -shuffle=on
  -timeout=120s ./...`, passed (`ok itempage 27.303s`).
- `vet.txt`: native `go vet ./...`, exit 0 with no diagnostics; the wrapper records
  its exit code explicitly.
- `format.txt`: native gofmt check of all changed Go files, passed.
- `runtime-hashes.txt`: changed runtime-file SHA-256 hashes and the test-tool image
  ID, not an audit input-set identity.
- `production-build.txt`: unchanged native Dockerfile build with task/owner labels,
  passed. `production-image.txt` records image
  `sha256:d6acb5d6484045961c2c99d96df9a08495c46bb5cf12a5e3cfda92503fa2b6d9`
  and its labels. This image was built from the local dirty context, not a clean
  retained Git archive, and is not a measured-source identity.

The final trace tests preserve raw source observations as escaped path, parent and
state strings. They use real native Go HTTP servers and the same native Gin
routes, source clients, record parsers and templ renderer, not a replacement
backend. Header/body stalls are synchronized with channels, not guessed sleeps.
An unfinished form is held before its source read while other contexts complete.
Fixtures exercise routes and forms without any upstream HTTP. Alert readback is
separate and must cause zero source fetches. Native cancellation/deadline tests
remain part of the complete suite.

The snapshot unit test uses `context.WithoutCancel` only to inspect delayed
identity after cancellation. Production never detaches cancellation or schedules
new background reads. Context retention is not a new lifetime guarantee.

The logs are retained as produced, including failures. They are not clean-archive
build identities and must not be used as native-audit receipts. No benchmark
instruction counts, race-detector run, browser matrix or shared mixed suite is
claimed. The Docker build proves compilation, not production qualification.

Self-inspection found no additional correctness findings. No independent reviewer
or agent was used, as explicitly required by this task. The worktree, branch and
these raw logs remain for integration; task containers, generated templ files and
the temporary production image are removed after verification. Shared base images
and build caches were not removed.
