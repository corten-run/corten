# corten-run/corten#1923: the layout floor, declared before the run (2026-11-22, prepared; not yet run)

All binaries are built from Corten main `14471284cce457e088dd4ded84ebcfd589785611` (commits.env).

## The question

How large a change in cycles per request does code placement alone produce under the protocol
pull requests are gated on (CONTRIBUTING: the one-sided 95% bound on the median per-pair change in
user+kernel cycles per request must be under +1%), when the source and the instructions a request
retires are the same? That is the floor below which the gate cannot attribute a control
workload's change to the pull request.

**No margin is tested.** Nothing here passes or fails. Each comparison is an A/A of main against
main, and every number is reported as measured. Where the gate's rule appears (summary.mjs's
"cycles margin" line, floor.md's last column), it is what the gate would have said of an A/A, a
fact about the floor, not a verdict.

## The builds (build.sh)

Every binary is #1829's probe program (`probe/src/main.rs`, unchanged), its features
(`json`, `compress`), main's Cargo.lock, the repository's release profile (opt-level 3, thin LTO,
one codegen unit), rustc 1.100.0, zstd linked to the system's libzstd, built on the measuring host
from one place (`/m/1923/work`, `/m/1923/probe`, `/m/target-1923`), so paths do not differ:

1. `main-1`: main, the target directory empty first.
2. `main-2`: main again, the target directory emptied again first: a second, separate build of the
   same source. Both sha256 are recorded; if they are identical (as in the local test build), it
   is still run as B, and the comparison is the protocol's pure noise floor.
3. `pad40`: main with `variants/pad40.diff`: a function `layout_pad`, `#[inline(never)]`, whose
   body is 40 NOP bytes (`asm!(".skip 40, 0x90")`) and a return, added after the imports at the
   top of `crates/corten/src/router.rs`, and one `std::hint::black_box(layout_pad as fn())` at the
   start of `Router::new`, which runs once when the app is built, before the port opens, so the
   linker keeps the function. No request calls either. The small shift.
4. `pad3100`: the same with 3,100 NOP bytes. The larger shift.

build.sh checks the pad function is in the pad builds and in neither main build, and layout.mjs
records how far each build's functions sit from main-1's. In the local test build (rustc 1.100.0,
Debian 13 container) main-1 and main-2 were byte-identical, and of the 3,402 functions in both
main-1 and pad40 every one moved: .text starts 64 bytes later (the pad's unwind entry), so 1,097
moved by +64 bytes (the cache-line offset kept), 1,246 by +112 (after the pad: mod 64 = 48) and
1,059 by +160 (after `Router::new` too: mod 64 = 32). In pad3100: +64 (1,097), +3,168 (1,246)
and +3,216 (1,059). The droplet's builds are reported as they are (host.txt, layout-*.txt).

## Comparisons and method

A is `main-1` throughout. B is `main-2` (`aa-same`), `pad40` (`aa-pad40`) or `pad3100`
(`aa-pad3100`).

The protocol is #1829's fresh-start rerun's (`results-fresh-b6`), unchanged: `run-pair-fresh.sh`
starts each build fresh for every turn, warm-up included, pinned to CPU 2, waits for its port,
counts it with `perf stat` for the turn while `wrk -t2 -c64` on CPUs 4 and 5 loads it for 3 s
(`lua/get.lua`), and stops it; the driver and perf run on CPU 7; the order of A and B turns every
pair; jemalloc is preloaded (`PROBE_ALLOCATOR=jemalloc` checks it). The answers of A and B are
compared before the first turn (status, headers but Date, body, after `mask.sed`) and must be the
same; a wrk error, a counter that is not numeric or not counted 100% of the turn stops that run.
Workload `plain`: `/private`, the record page for one visitor (not Public) in an app that keeps
pages, the control on which #1829 missed by +1.47% (bound) with +2.74% user cycles on flat
instructions.

Before anything is recorded, run.sh runs every comparison's answer check and one unrecorded pair,
and pass 2's events on one unrecorded pair (`results/check-only/`); a failure stops the run.

1. **Pass 1, cycles**: `plain`, one unrecorded warm-up pair, then **100 recorded pairs** for each
   of `aa-same`, `aa-pad40`, `aa-pad3100`, counting `cycles:u`, `cycles:k` and `instructions:u`
   (the gate's three counters).
2. **Pass 2, front end**: `plain` again on `aa-pad40` and `aa-pad3100`, one warm-up pair and
   **30 recorded pairs** each, counting `L1-icache-load-misses:u`, `iTLB-load-misses:u`,
   `branch-misses:u` and `instructions:u`. run.sh first counts each event beside
   `instructions:u`, then all four together, on a busy loop on CPU 2; an event the host's PMU
   cannot count numerically at 100% is dropped and recorded (`progress.log`, host.txt). perf
   prints the two cache events without their `:u` (`L1-icache-load-misses`); the scripts accept
   that name, and in the local test `:u` and `:k` counted different numbers for both, so the
   modifier applies.
3. `hit` (`/page`, the kept page, #1829's other control) is **not run** in this plan; it would
   add about 37 minutes. With `HIT=1` it runs after everything above, 100 pairs per comparison,
   as #1829's run-fresh.sh ran it. Whether it ran is in host.txt.

## Reporting

For each comparison and workload (summary.mjs, unchanged, and report.mjs into `floor.md`): the
per-pair change B / A - 1 in user+kernel cycles per request, its median, the one-sided 95% upper
bound on the median (an order statistic: the **59th of the 100** sorted per-pair changes; the 20th
of 30 in pass 2) and the range (smallest to largest change); the same for user and for kernel
cycles alone (the user/kernel split), and for `instructions:u` per request, which should be flat
(the builds retire the same instructions; a change there would mean the perturbation was not
layout alone, and is reported). Pass 2 reports each event per request the same way, with each
build's median. Both builds' sha256, the layout shifts and the host (CPU model, kernel, perf,
linker) are in host.txt. Every turn's perf and wrk output is in `raw-*.log`.

No pooling with other runs, no re-declared plan after the run, no run repeated or dropped for its
result. A failed run is reported as failed with whatever pairs it recorded.

## Time

Estimated from #1829's fresh-start run on a c-8 (Xeon Platinum 8168): 7.2 s a pair (202 recorded
pairs and their starts in 24 min 14 s).

1. Setup (packages, rustup): about 3 minutes.
2. Build: two full builds and two corten-and-probe rebuilds, about 9 to 12 minutes (the local
   test container, 8 CPUs of a busy host, took 126, 172, 132 and 126 s).
3. Checks: 5 unrecorded pairs and the answers, about 1 minute.
4. Pass 1: 3 x 101 pairs, about 36 minutes.
5. Pass 2: 2 x 31 pairs, about 7.5 minutes.

About 57 to 60 minutes in all; under 75. With `HIT=1`, about 95.