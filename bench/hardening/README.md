# Native Hardening

`run.mjs` is a local, opt-in driver for the registry's complete hardening group:
Corten, ASP.NET Core, Spring Boot, Next.js Pages Router, Django, Express, Gin,
Drogon and Topcoat. Both fixture/API sources, direct/deployed-edge deployments
and all six attack phases stay in its 216-cell ledger. No cloud controller,
operational benchmark network, production deployment or automation is used.

```sh
node --test --test-concurrency=1 bench/hardening/*.test.mjs
node bench/hardening/run.mjs w1 --review approved-profile-reference --build
node bench/hardening/verify.mjs bench/hardening/results/w1
node bench/hardening/adversarial.mjs bench/hardening/results/w1/<observed-cell-directory>
```

The dispatcher interface is `export async function run(args)`, where `args` is
the CLI string array including the mandatory local development round `wN`.
The returned and persisted summary schema is `native-hardening-run/v1`.
`--out` optionally selects a fresh subdirectory under `bench/hardening/results`.
`--node-modules` can name an existing dependency installation (the pinned
Playwright version is checked); it is mounted read-only, not installed or changed.
No options select a smaller benchmark group. `--verify-app`, `--verify-source`,
`--verify-case` and `--verify-phase` select bounded apparatus verification only.
Every other cell remains `not-run`, and verification mode cannot set `groupReady`.

## Native Qualification

A clean, committed checkout and immutable native source/image/config identities
are mandatory. `--build` builds the existing native production Dockerfiles with
the existing matched profile, records the source digest and provenance labels,
and removes only its generated image tags afterwards. Without it, each
`cb-marketplace-production-<app>` image must carry this exact commit, profile,
clean-build and native-source digest. Old or dirty local images are not relabeled.
Missing images/builds/native features remain explicit invalid/not-run cells.

The representative is the existing native matched production adapter, not a
common implementation of a framework's behavior. The summary's `nativeGroup`
keeps all nine representatives visible with `not-established`, `partial`,
`gaps-observed` or `qualified` production qualification and exact missing features.
Its alternatives list is empty until an actual native alternative has its own
source/config/process-budget identity and passes the same complete gates. No
alternative is presumed qualified and no default is weakened to fill that list.
`nativeControlsVersion: 1` requires additional raw controls and replay validation.

Each phase starts fresh native application and upstream containers. Production
qualification uses the unchanged `bench/marketplace/qualify.mjs` infrastructure.
Missing defensive capabilities are disclosed but do not exclude a target.
The complete existing marketplace browser/content gate is separate: 500 numeric
JSON records and 264 page checks across every locale, JS mode and device. It
must pass before attacks. Deployed-edge also reruns this gate through TLS nginx,
with the existing pinned edge image and generated `nginxConf`, without substituting
a common renderer or application transport. Node trusts only the generated CA;
Chromium pins its generated public key. Native form action, encoding, CSRF fields
and cookies are discovered and submitted successfully before body attacks.
`deploymentQualificationVersion: 1` additionally runs the unchanged production
`qualify()` predicate suite through real TLS clients at the edge, including the
unfinished-header and 950/1,050 connection probes. It stores separate
`edge-qualification.json` and `native-parity.json`; direct qualification is never
substituted for effective edge qualification. The TLS adapter changes client
transport only, not the proxy profile, target, budgets, thresholds or predicates.
TLS handshakes must complete and validate the generated CA before requests or
idle connections count. See [native app-owner requirements](NATIVE-GAPS.md) for
the observed Express/Gin feature gaps and full-matrix acceptance command.

`native-controls.json` separately records allowed/unknown Host responses, the
actual liveness path found by production qualification, and a negative health
path. No endpoint means `missing`; a catch-all 200 is `inconclusive`, not live.
A failed, partial or timed-out negative health request is also inconclusive;
only a completed negative 4xx distinguishes the endpoint from a catch-all.
API-source controls retain nonce-mutated page/full JSON responses, exact one-read
upstream counters, 503/302 refusal, independent liveness under upstream failure,
and reset/readback receipts. Controls run in the direct and deployed-edge namespace
as applicable. Wire differences are observations, not proof of native serialization;
the existing native source and complete browser/content gates remain mandatory.
The timed API run independently resets its owned upstream before the clock starts
and retains the actual read/status totals afterwards. Those totals include attack
reads, not an invented per-legitimate-request attribution. Unavailable observations
remain unavailable and block numeric qualification; they are never zero reads.
An unqualified representative is explicitly labeled a native defense-gap
observation, never qualified performance. Missing defenses are target outcomes.

## Apparatus

The exact profiles live in `plan.mjs`, serialized into each cell's settings.
`--profile bounded` is the default: 2.5 s baseline, 6 s attack, 5 s recovery,
12 attack attempts in one second and legitimate new-connection reads every
400 ms in every window. Reads rotate the three localized pages and complete
numeric JSON. This is a safety/driver verification, not a timeout, saturation
or throughput qualification. `--profile sustained` explicitly selects a 95 s
attack and 1,200 attempts. Neither profile inherits legacy defense thresholds.
`--review` identifies the caller's approved profile; a string alone does not
constitute independent review or authorize shared-service attacks.

Direct and edge both charge 1.5 CPU and 1.5 GiB total: upstream 0.5 CPU/512 MiB,
direct app 1 CPU/1 GiB, or edge app 0.75 CPU/768 MiB plus proxy 0.25 CPU/256 MiB.
The fixture case still inventories/charges its idle upstream. These are container
quotas, not CPU pinning or physical memory reservations. Every container has
512-task and 65,536-FD bounds and no swap allowance above its memory budget.
The separate injector has 2 CPU/1 GiB; preflight/browser processes use 2 CPU/2 GiB
and are removed before the attack. All native child processes and threads are
charged by their container cgroups; `docker top` and actual `cgroup.procs` are
retained, not normalized to one process. The isolated network inventory must
match every declared native target container before injection.
Replay checks actual Docker CPU/memory/swap/task/FD quotas against the serialized
profile, rejects automatic recovery restarts and published ports, and rejects
configuration updates or changed native limits during the attack. An exit during
asynchronous collection is checked against the collection interval's end, not
incorrectly attributed to a missing resource sample before the exit.
The short-lived observer uses the host PID and cgroup namespaces, with read-only
cgroup access and no Docker socket, so other containers' PIDs are visible rather
than represented as namespace-hidden zeros. Asynchronous cgroup reads retain their
actual monotonic collection intervals; reads cannot block the socket scheduler.

The same socket injector runs independent receiving controls before/after each
phase. Controls verify actual emitted/received bytes, trickle ticks, incomplete
heads/bodies, paused-reader write backpressure and an independently checked JSON
legitimate response. Attacks send unfinished trickled heads, native form bodies
trickled after complete heads (4 KiB declared, below ordinary form-size caps),
pipelined requests from readers that stop reading,
idle sockets, fresh-connection GET floods, and all three oversized variants
(200 headers, 128 KiB header, 4 MiB body). Oversize writes honor backpressure.
Scheduled starts and actual monotonic starts are retained including refusals;
local FD/memory/address exhaustion, missing work, excessive lag, stalled event
loop, invalid controls, changed lifecycle or failed cleanup invalidate apparatus.

Receiving controls release on actual payload receipt (including every byte of
the 4 MiB body), two trickles, or demonstrated reader backpressure, under a separate
finite 5 s deadline. They no longer presume delivery within 350 ms. Their exact
byte checks remain intact. The recorder unit test explicitly triggers its deadline
after the hung request arrives instead of requiring a good response within 150 ms.
Serial local socket tests avoid aggregate test-runner contention; native 600 ms
requests, 200 ms scheduler/host gates and all reviewed attack windows are unchanged.

The bounded raw journal is buffered in injector memory (64 MiB maximum) and
flushed after the timed windows, so host-mounted filesystem stalls cannot delay
scheduled traffic. Adjacent windows share one observed boundary clock sample.
The final cleanup observer samples the same Linux kernel monotonic clock and
boot identity as the injector, including on Docker Desktop; the parent removes
that observer before verifying zero remaining owned containers.

Raw JSONL retains attempts, status prefixes, byte hashes/counts, paused-reader
kernel receive queues, observation boundaries, cgroup CPU/memory/OOM/procs and
controls. Lifecycle/config/image/source records, complete parity/qualification,
logs and manifests accompany it. Replay rehashes artifacts, rechecks native
parity/controls/counters, reconstructs the shared-oracle capture and compares it
to the saved file. This is integrity validation, not signed remote attestation.
Ephemeral form credentials and the TLS private key are removed after use.

Cleanup's 15 s timeout bounds each Docker cleanup operation, not total artifact
collection wall time, which is retained separately. API-source upstream failure
is a charged deployment outcome; unexpected failure of the unused fixture-source
upstream invalidates its apparatus. Generic HTTP 400/403/5xx responses do not
identify a defensive rejection; only phase-appropriate limit/timeout statuses do.

The shared outcome validator is used only after real native observations and
owned cleanup. A refusal, lost useful service, resource exhaustion, missing
defense or failure to recover remains a target outcome. No target is restarted
to manufacture recovery. A broken functional gate or apparatus gets no measured
capture. All owned containers (including anonymous volumes), command clients,
sockets, timers, network and generated image tags are reaped; results remain.
Each invalid cell names its failed stage and distinguishes `parity-blocked` from
`apparatus-invalid`. Valid native captures separately classify `service-preserved`
or `target-capacity-failure`. Loss of baseline service after successful preflight
is retained as an unavailable numeric measurement, not mislabeled broken injection.
`numericComparisonQualified` also requires observed production qualification;
`groupReady` means complete native apparatus evidence, not universal protection.
Its source and deployment-specific native receipts must exist, including separate
edge controls. A production-checklist pass alone cannot set the group ledger's
`productionQualification` to `qualified`: all selected native content/browser and
apparatus cells must actually be observed, and direct and edge production controls
must qualify. Failed browser gates, absent edge receipts and unknown checks remain
partial, while explicit native feature gaps remain gaps.

## Limits

The driver measures HTTP/1.1, including through the TLS edge, not HTTP/2/3 attacks.
Slow-reader queue samples establish unread data, not necessarily blocked native
server writes; protection remains inconclusive without a rejection. A bounded
paused reader may not deliver its peer's EOF to JavaScript until it reads again,
so closure counters describe client-observed closure, not an exact server FIN time.
A hold shorter than a native deadline cannot prove the defense absent outside that
window. Statuses and closures never identify a proxy/server mechanism by inference.
TCP receive-queue scans are shared for at most 50 ms and retain their sample age;
they match both loopback endpoints and the destination port, not just a local
port that an upstream socket could also use. An absent connection is unavailable
evidence, never an invented zero-byte queue. Timed JSON reads validate the full
record; timed page reads check completed HTTP bodies and page markers, not a full
DOM/CSS comparison on every request. The full browser gate runs before injection.
Memory/CPU are window samples, not continuous peaks or kernel socket-memory totals.
CPU seconds are raw cumulative cgroup counters, including startup and preflight,
not per-window CPU deltas or per-request costs.
No ranking or throughput claim is supported by these safety runs, particularly
on a concurrently loaded workstation. Full native qualification and group-wide
execution are still required for any complete-group claim. This scoped runner
does not repair missing native adapter features outside `bench/hardening`.

Independent review and repository-wide checks remain the integrating parent's
responsibility when this task explicitly disallows subagents and edits outside
this directory. Run the focused checks above and report actual native verification
and residual gaps, never a passing oracle fixture as a native result.
