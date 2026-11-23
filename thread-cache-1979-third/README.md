# corten-run/corten#1979: the third declared run, a long page uncompressed and with a browser's encodings

The receipt for the third run design Choice 23 records, on 2026-11-23. The second run is in
`thread-cache-1979-second/` beside this directory (tags `evidence/thread-cache-1979-second` and
`evidence/thread-cache-1979-second-trial`); nothing here replaces it or the first run's tags.

## What is here

1. `plan.md`: the plan as it stood in the pull request's description before the run started. It
   was posted at 15:55:58 UTC and the hosts' first turns began at 15:56:06 and 15:56:07
   (`results/*/host.txt` and the first line of each log). No turn of these workloads was run
   before it: there was no trial of the script.
2. `tc-run4.sh identity|zstd`: one host's two comparisons in order, 64 KiB against itself and
   then 64 KiB against 512 KiB, on the 202,041-byte page (`/root/fixtures-sizes/n160`, which the
   second run's `setup-tc.sh` and `sizes.py` wrote). It calls the second run's `tc-pair3.sh`,
   unchanged, and the readings are the second run's `pairs3.py <log> <A> <B> 1 [--swapped]`;
   both are in `thread-cache-1979-second/`.
3. `results/h06` (`identity`) and `results/h07` (`gzip, deflate, br, zstd`): each host's logs as
   written and its `host.txt` (date, kernel, CPU, Docker, `wrk`, `perf`, the server binary's
   SHA-256, the image's id, the load average). `results/readings.txt`: `pairs3.py` run over the
   four logs, the self-comparisons with `--swapped`.

## The run

The two DigitalOcean c-16s with a Xeon Platinum 8280 that ran the second run's `identity` and
`gzip, deflate, br, zstd` workloads, with the image each built then from `faba240cd` (the server
binary's SHA-256 is `5454a6e3...` on both, as in the second run). Linux 6.8.0-149, Docker
29.10.0, perf 6.8.12, `wrk` 4.1.0. The labels are `tc64k` (64 KiB), `tc64kb` (64 KiB again,
under a second label) and `tc512k` (512 KiB). Each comparison ran once, in the plan's order, 200
recorded pairs after one that is not; no pair was dropped, no request failed and no counter ran
for less than all of a turn.

## Readings (user plus kernel cycles a request; the bound is the 113th of 200 per-pair changes)

| Workload | 64 KiB against itself: bound, and with the labels swapped | 512 KiB against 64 KiB: medians | Median per-pair change | Bound |
|---|---|---|---|---|
| `identity` | +0.30%, +0.25% | 620,974 against 635,169 | -2.26% (-9.76% to +17.76%) | -2.07% |
| `gzip, deflate, br, zstd` | +0.20%, +0.07% | 1,572,721 against 1,585,423 | -0.88% (-7.01% to +5.73%) | -0.69% |

Both workloads resolved 1% and both comparisons are under the +1% the plan held them to. As the
plan says, this does not bear on the first run's miss and does not decide whether the change
merges.
