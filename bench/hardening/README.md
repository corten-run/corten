# Native Hardening

`run.mjs` is a local, opt-in driver for the registry's complete hardening group:
Corten, ASP.NET Core, Spring Boot, Next.js Pages Router, Django, Express, Gin,
Drogon and Topcoat. Both fixture/API sources, direct/deployed-edge deployments
and all six attack phases stay in its 216-cell ledger. No cloud controller,
operational benchmark network, production deployment or automation is used.

```sh
node --test bench/hardening/*.test.mjs
node bench/hardening/run.mjs w1 --review approved-profile-reference --build
node bench/hardening/verify.mjs bench/hardening/results/w1
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

The same socket injector runs independent receiving controls before/after each
phase. Controls verify actual emitted/received bytes, trickle ticks, incomplete
heads/bodies, paused-reader write backpressure and an independently checked JSON
legitimate response. Attacks send unfinished trickled heads, native form bodies
trickled after complete heads, pipelined requests from readers that stop reading,
idle sockets, fresh-connection GET floods, and all three oversized variants
(200 headers, 128 KiB header, 4 MiB body). Oversize writes honor backpressure.
Scheduled starts and actual monotonic starts are retained including refusals;
local FD/memory/address exhaustion, missing work, excessive lag, stalled event
loop, invalid controls, changed lifecycle or failed cleanup invalidate apparatus.

Raw JSONL retains attempts, status prefixes, byte hashes/counts, paused-reader
kernel receive queues, observation boundaries, cgroup CPU/memory/OOM/procs and
controls. Lifecycle/config/image/source records, complete parity/qualification,
logs and manifests accompany it. Replay rehashes artifacts, rechecks native
parity/controls/counters, reconstructs the shared-oracle capture and compares it
to the saved file. This is integrity validation, not signed remote attestation.
Ephemeral form credentials and the TLS private key are removed after use.

The shared outcome validator is used only after real native observations and
owned cleanup. A refusal, lost useful service, resource exhaustion, missing
defense or failure to recover remains a target outcome. No target is restarted
to manufacture recovery. A broken functional gate or apparatus gets no measured
capture. All owned containers (including anonymous volumes), command clients,
sockets, timers, network and generated image tags are reaped; results remain.

## Limits

The driver measures HTTP/1.1, including through the TLS edge, not HTTP/2/3 attacks.
Slow-reader queue samples establish unread data, not necessarily blocked native
server writes; protection remains inconclusive without a rejection. A bounded
hold shorter than a native deadline cannot prove the defense absent outside that
window. Statuses and closures never identify a proxy/server mechanism by inference.
Memory/CPU are window samples, not continuous peaks or kernel socket-memory totals.
No ranking or throughput claim is supported by these safety runs, particularly
on a concurrently loaded workstation. Full native qualification and group-wide
execution are still required for any complete-group claim. This scoped runner
does not repair missing native adapter features outside `bench/hardening`.

Independent review and repository-wide checks remain the integrating parent's
responsibility when this task explicitly disallows subagents and edits outside
this directory. Run the focused checks above and report actual native verification
and residual gaps, never a passing oracle fixture as a native result.
