# Margin, declared before the run (2026-11-23 UTC, prepared; not yet run)

corten-run/corten#1846, "Send a kept page in brotli 5, made off the request after its second answer"
(issue #1793), fifth quiet-host cycle run (1846r3): the integrated merge candidate, the branch merged
with current main, against that main.

<!-- commits --> Base `fef1f83de307e618dbd996c567eb616e9c2da650`, head `a14a80294515db14d5e70727042f0b00c07c2419` (from commits.env; merge-base of the head with origin/main: `fef1f83de307e618dbd996c567eb616e9c2da650`; origin/main at export: `fef1f83de307e618dbd996c567eb616e9c2da650`).

## Why a fifth run

Round 13 found that the recorded gates clear their own pins, not the merge candidate. The fourth
run (1846r2, receipt `evidence/1ccc71a3`) timed `ef8587ca0` against main's `7a275ef15`, and the
wait run (1846w, receipt `evidence/53fa534d`) `76a9dc1e4` against `7a275ef15`. Main has since
merged, among others, #1955 ("Give a kept answer again with three fewer allocations": the `Age`
of a kept answer given again is a slice of a table, and the cache's mark is read from what was kept
rather than inserted as an extension) and #1962 ("Reserve a text or bytes answer's header map
once": the header maps' room, and `compress::finish` reads the media type once). Both change code
every turn of these workloads runs. The branch merged that main at `a14a80294` (two conflicts in
`kept.rs`, both sides kept). This run measures that merge against its main parent, so the
integrated binary has cycle evidence of its own. 1846r2's results stay results for their pins; they
are not pooled with this run and this run does not depend on them.

## The commits

Base: origin/main `fef1f83de` ("Merge pull request #1969"), the main parent of the merge. Head:
`a14a80294`, the merge commit (its first parent `76a9dc1e4`, the PR's head before the merge).
Commits after the merge on the branch that change none of the exported paths (`crates`,
`examples`, `Cargo.toml`, `Cargo.lock`, `.cargo`) build the same binary, and the report names
any such later head with that check.

## The plan: 1846r2's passes 1 and 2, unchanged

1. The probe program (`probe-{base,head}/src/main.rs`, byte-identical to 1846r2's; only the package
   name and the path to `corten` differ between the two), the template's features and `json`, the
   tree's Cargo.lock, the repository's release profile (opt-level 3, thin LTO, one codegen unit),
   rustc 1.100.0, zstd linked to the system's libzstd, jemalloc preloaded
   (`PROBE_ALLOCATOR=jemalloc` checks it).
2. The four workloads, with 1846r2's checks, masks and expected differences (`checks-*.txt`,
   `mask*.sed`, `expect-*.diff`, byte-identical): `browser` (`/page`, the 6,124-byte `Public`
   record page, `Accept-Encoding: gzip, deflate, br, zstd`), `gzip` (gzip only), `refused`
   (browser codings at a bound calibrated on the built head by `calibrate-refused.sh`, seven other
   pages kept first, leaving the page and its zstd 1 room and too little for its brotli 5) and
   `json-browser` (`/records`, the 1,999-byte JSON body, `Accept: application/json` and browser
   codings). On `browser` and `json-browser` the head answers `br` where the base answers
   `zstd`, with a smaller body; `gzip` and `refused` answer the same, gzip and zstd 1.
3. Every turn, its warm-up pair included, on a freshly started build (`run-pair-fresh.sh`,
   unchanged), server on CPU 2, `wrk -t2 -c64` for 3 s on CPUs 4 and 5, the driver and perf on
   CPU 7, the order of the two builds turned every pair, `perf stat` `cycles:u`, `cycles:k` and
   `instructions:u` of the server process over the turn, divided by the requests wrk saw answered.
   Before the first turn the two builds' answers are compared and must differ only as
   `expect-*.diff` says.
4. **100 recorded pairs** a workload after one unrecorded warm-up pair; the one-sided 95% upper bound
   on the median per-pair change is the 59th smallest of the 100.
5. `refused`'s completion fence (`/mark`, kept by a second app in the process, queued behind
   `/page`'s job on the one compression thread; the head's port opens only once `/mark` answers
   `br`), then `/page` asked once more and required to be a kept zstd 1 of one size on every start.
   The panic hook of 1846r2's probe stays: the fence fails on any panic counted before the port
   opens, caught ones included, a start with one prints `PANICKED` and exits, and a workload is
   rejected if either build's server log over every start and turn has `panicked at`, `PANICKED`
   or `FENCE FAILED`. Every start of both builds must log one WARM line, the page kept, in one
   coding and size (`starts-<w>.txt`), and `check-warm.sh`'s rule.
6. Pass 2, a diagnostic: each workload again as `<w>-icache`, one warm-up pair and **30 recorded
   pairs** of 1 s turns on fresh starts, counting `L1-icache-load-misses:u` and `instructions:u`
   only. Reported per request: each build's median, the median per-pair change, its 20th-of-30
   bound and the range. **No margin.**

## The margin (pass 1)

For **every** workload: the one-sided 95% upper bound on the median per-pair change in user plus
kernel cycles per request is **under +1%**. A bound at or over +1% on any of the four blocks the
merge; a workload that fails or cannot be used (below) does not clear it. A bound under +1% clears
the gate and shows neither a lower cost nor what caused any difference.

**No layout floor.** No workload is named a negative control: all four are kept answers whose hit
path runs this change's code (`Kept::coded` tests how the client ranks brotli, and for a browser's
codings reads the kept brotli or its promotion state), and none is `plain`.
Choice 71's recorded floor (+1.62%) applies only to `plain` on a Xeon Platinum 8358 with its exact
recorded setup, and this run declares no same-run A/A layout control. The host's CPU is not known in
advance (DigitalOcean's c-8 has given this PR's runs both an 8280 and an 8358), and that does not
matter here: every workload is held to +1% on whatever host runs it.

## When a workload, a pass and the run can be used (fail closed)

`gate.mjs` decides from the files alone, after both passes (`gate-<w>.txt`, `gate.txt`; its
own checks on made-up turns are `check-gate.mjs`, which `pack.ps1` runs before packing). A
workload is usable only if: its raw log holds exactly the warm-up pair and pairs 1 to N in the
declared order (base first in the warm-up and odd pairs, head first in even ones), N being 100 in
pass 1 and 30 in pass 2; every turn's perf output has each declared event once, a whole number,
counted 100% of the turn; every turn's wrk `RESULT` line has requests above zero and no connect,
read, write, status or timeout error; the CSV holds exactly those N pairs' rows, each equal to its
turn's raw values; every start of both builds warmed (and, for `refused`, fenced) as above; and the
answers were checked. Only then is a bound computed. Pass 1's gate is met only if all four
workloads are usable and each bound is under +1%.

`run.sh` refuses `PAIRS`, `TURN`, `WARMUP`, `MISS_PAIRS`, `MISS_TURN`, `EVENTS`,
`NOPERF`, `WAIT_ROUNDS` and `WAIT_REPS` in its environment (so does `start.sh`), refuses a results
directory holding anything but this file, stops before any recorded pair if the preflight,
calibration or a check fails, and exits 1 unless every step ran, all eight workloads (four a pass)
are usable and pass 1's gate is met. If the host's perf cannot count the pass 2 events at 100%, pass
2 is not run and the run exits 1 as incomplete; pass 1's gate verdict is still reported, with the
missing diagnostic stated as an exception, never as a pass. `run.out` ends with `run.sh exit <n>`
and `ALL-DONE`. The only dry run is `DRYRUN=1`: the calibration and the four checks with no pair
recorded and no result.

## The held value's wait: not run again

The wait run (1846w) measured the held value's wait behind a kept page's brotli 5 job at
`76a9dc1e4` against `7a275ef15`, and its gate was met for those pins. This kit adds no wait pass,
because the merge changes none of the code that run timed. The merge's diff from `76a9dc1e4` to
`a14a80294` under `crates/` is exactly main's changes since `7a275ef15` (`git diff
76a9dc1e4 a14a80294 -- crates`): in `kept.rs`, the `Age` table and `age_value` (new items after
`NOTICE`), `Kept::typed`, a comment in `Sent::read`, `Asked::find` after the entry is found (the
`Age` value, no `Typed` extension) and a unit test; in `compress.rs`, `compressible`'s argument,
`finish`'s media type read once, `varies_as`, and `Precompressed::pick` and `encoded_headers`
calling `compressible` with the media type; and `answer.rs`, `cache.rs` (`settle` reads the mark
from what was kept), `json.rs` and `response.rs` (header-map room), with tests. None is in
`Entry::make_brotli`, the store's lock (`Store::keep`, `found`, `drop_entry`, the `inner` lock),
`compress::later`, the held-value worker or `compress::Stored`. So 1846w still describes the
integrated build's wait mechanism in source; it did not time the integrated binary, and the report
says so rather than reading 1846w as a measurement of it.

## Not measured by this run

The second qualifying answer's queueing of the job and the compression worker's first start: every
turn begins after a warm-up whose requests have already queued and made the kept brotli, so the
timed turns do not contain them. The wait run does not time them either. They are reported as
unmeasured.

No pooling with the earlier runs, no plan declared again after the run, no run repeated or dropped
for its result. A failed workload or pass is reported as failed with whatever it recorded.

## Time

Estimated from 1846r2's run on a c-8 (its passes 1 and 2 took 57 minutes, 21:58 to 22:55 UTC):

1. Setup (packages, rustup and rustc 1.100.0, the crates) about 3 to 6 minutes, and the two probe
   builds about 2 to 8 (1846r2's took 46 and 40 s on a host with a warm toolchain).
2. Calibration (up to 375 starts of the head) and the four checks: about 1 to 3 minutes.
3. Pass 1: 4 x 101 pairs, about 12.6 minutes a workload: about 51 minutes.
4. Pass 2: 4 x 31 pairs of 1 s turns: about 7 minutes.
5. The gate: under a minute.

About 65 to 75 minutes in all, under 90.
