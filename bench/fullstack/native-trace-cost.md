# Native trace capture cost

`native-trace-cost.mjs` is an opt-in, local before/after diagnostic for Gin,
Drogon and Topcoat. It does not admit a framework to a workload group or change
historical benchmark results. Its pure counter-parser tests also run in
`npm run check:marketplace`.

Build the pre-capture revision and the release revision with the **same**
optimized toolchain, lockfiles and flags for each app. Use the normal app build
(Go's optimized build, CMake Release, Cargo's release profile), not a debug or
test server. Put each binary at `server` in its own directory, together with
the build's normal `static/` (Gin/Drogon) or bundled `assets/` (Topcoat).
Record source revisions, compiler versions, builder image identities and flags
in the manifest. The driver additionally records binary and fixture SHA-256s,
its own hash, and the runtime image identity. The runtime image needs valgrind
and the native libraries required by all selected binaries.

Example manifest (paths relative to the invocation directory):

```json
{
  "before": "PRE_CAPTURE_COMMIT",
  "after": "RELEASE_COMMIT",
  "toolchains": "Record exact versions, image identities and optimized flags here",
  "runtimeImage": "native-cost-tools",
  "apps": {
    "gin": { "before": "builds/before/gin", "after": "builds/after/gin" },
    "drogon": { "before": "builds/before/drogon", "after": "builds/after/drogon" },
    "topcoat": { "before": "builds/before/topcoat", "after": "builds/after/topcoat" }
  }
}
```

```sh
node bench/fullstack/native-trace-cost.mjs manifest.json fresh-output-directory
```

The driver creates only labeled, uniquely named containers, removing them with
their volumes in `finally`. It requires Docker's `host.docker.internal` bridge
(adds the Linux host-gateway mapping when needed), but no cloud host, hardware
performance counters, ptrace capability or official benchmark reservation.
Use a fresh output directory: existing receipts are never overwritten.

Each source has two real native servers, one per revision. Traffic is serial
HTTP/1.1 over a persistent connection, one worker, defaults profile. Fixture
traffic is **untraced**; API traffic sends one valid sampled version-00 parent
and one state field to a controlled upstream serving identical fixture bytes.
Both JSON GET and English page GET are covered. All responses must have equal
body bytes within an app/route across revisions and sources. API source call
counts and headers must match the revision's expected behavior: no propagation
before, the incoming context after. These are validity gates, **not** cost
measurements or proof of zero overhead.

Callgrind instrumentation starts only after readiness. Each route warms for 50
requests, then counts 200 and 1,200 requests. Subtracting the first instruction
count from the second and dividing by 1,000 removes fixed batch/control work.
The parser requires a complete `totals:` footer and verifies it against the sum
of exclusive `Ir` cost lines, excluding inclusive call-edge lines, as the
[Callgrind format](https://valgrind.org/docs/manual/cl-format.html) specifies.
The independently maintained header `summary:` counter is retained separately,
including any discrepancy; it is not substituted for the dumped self-cost sum.
Counter disagreement is a tool limitation to report, not evidence of zero cost
or proof that every instruction executed was represented in the dump.
Three rounds alternate before/after, after/before, before/after. Idle servers
are woken through `/api/alerts` to deliver callgrind control commands without
ptrace; raw receipts record those extra control-request counts. Differences in
that work, native timers, allocator/GC cycles and socket scheduling can still
vary the result. The summary reports median and range, and explicitly marks
when a revision's range exceeds the median delta. Do not interpret an unresolved
delta or body equality as zero capture overhead.

For a bounded calibration, the manifest can set `"batches": [40, 240]` instead
of the default `[200, 1200]`. The receipt records the actual subtraction. This
smaller sample has less precision, particularly for untraced capture costs;
keep failed/partial calibrations separate and report unresolved differences.

These are user-space instruction counts for each server, including native
HTTP parsing, routing, serialization/rendering, HTTP-client work and runtime
bookkeeping. They exclude kernel, load-driver and upstream CPU, startup and
asset loading; they do not measure waiting, production throughput or browser
work. Gin uses `GODEBUG=asyncpreemptoff=1` identically in both revisions because
callgrind's signal handling can abort on Go's asynchronous preemption. This
is an instrumentation-only limitation, not a production setting change.
Matched profiles, concurrency, non-English routes, form POST, malformed and
duplicate trace headers remain separate correctness/cost checks. In particular,
this diagnostic does not relax Drogon's strict native parser failures.
