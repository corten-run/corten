# corten-run/corten#1979: the starter image's jemalloc thread cache, the measurements

What design Choice 23 (`docs/design.md#choice-jemalloc-image`) cites for the limit: the scripts
as they were run and every result file. `plan.md` holds the two cycles runs' plans, each written before its run. The pull request first
set 1 MiB and, after its review asked what the caches keep, 512 KiB: the first cycles run is 64 KiB
against 1 MiB and the second 64 KiB against 512 KiB.

## Host

One DigitalOcean c-16 with a Xeon Platinum 8280 (`results/host.txt`): Ubuntu 24.04, Linux
6.8.0-149, Docker 29.10.0, perf 6.8.12, `wrk` 4.1.0, Node 24.22.3. Every measurement ran
card-market's image built from `bcf4aa073` (`examples/card-market/Dockerfile`), with only
`MALLOC_CONF` and `LD_PRELOAD` changed by the container's environment. `results/host.txt` names the
commit the host's clone had checked out, not the image's: the image was built from an archive of
`bcf4aa073`, and `results/provenance.txt` is the check made afterwards that its server is the
same, byte for byte, as a new build of that tree. The image carries Debian's
libjemalloc2 5.3.0-3.

The scripts expect to sit in `/root` beside a clone of the repository at `/root/corten-pr` and
Node at `/root/node`. They were written for this host and are kept as run (but for two container
labels of the author's machine, removed), not as a tool.

## Page faults by page length and limit

1. `sizes.py`: writes card-market's smoke fixture with the item's contents and field values
   repeated N times under varied names, one fixture a length.
2. `faults4.sh` (pages of 9,793 to 202,041 bytes, seven settings), `faults5.sh` (495,521 and
   984,641 bytes) and `faults6.sh` (other `Accept-Encoding` values): the app on one CPU, the page
   asked by `faults-load.mjs` over 8 connections after 300 requests, the server's `minflt` and CPU
   ticks read from `/proc/1/stat` before and after; three rounds. `sizes-stats.py` reads a result.
3. `results/faults-sizes.out` (`faults4.sh <image>`); `faults-large.out` (`faults5.sh` with
   `NS="400 800"`, `CONFS="65536 524288 1048576 2097152 4194304 8388608 glibc"` and
   `REQUESTS=600`); `faults-enc-gzipdeflateb.out` (`gzip, deflate, br, zstd`),
   `faults-enc-identity.out` and `faults-enc-gzip.out` (`faults6.sh` with `NS="1 20 160"`,
   `CONFS="65536 1048576 glibc"` and `ENC` set). The settings a file ran are in its rows.

## Cycles under load

`tc-pair.sh` (one workload's pairs: one image under the two limits, a fresh container each turn,
2 s of warm-up, then a 3 s `wrk` run inside 3.4 s counted by `perf stat` on the server process, the
limits' order turned every pair) and `tc-run.sh` (the five workloads). `pairs.py <log> tc64k tc1m 1`
reads a log: pairs, medians, best, ranges, the per-pair changes and the order-statistic bound.
`results/tc/*.log` are the first run's logs and `results/tc/*.txt` their readings with every
per-pair change. `tc-pair2.sh` and `tc-run2.sh` are the second run's (64 KiB against 512 KiB, the
answers compared but `Date` and `ETag`, a 495,521-byte page added): `results/tc2/`, read with
`pairs.py <log> tc64k tc512k 1`. `tc-pair2.sh` is kept as it was for the diagnostic that followed
(`tc-diag.sh`, the uncompressed workload again and 64 KiB against itself, kept under the tag
`evidence/thread-cache-1979-diagnostic`): that run added the label `tc64kb`, a second name for the
64 KiB setting, and changed nothing else.

Each log's second line says `ANSWERS DIFFER` for the four compressed workloads: the script
compared the two limits' answers byte for byte but `Date`, and the app's weak `ETag` differs
between any two starts. `results/answers.txt` is the look taken after the run: on the 32,501-byte
page the headers but `Date` and `ETag`, the bodies as sent and the bodies decoded were the same
under the two limits for `br` and for `gzip, deflate, br, zstd`, and three starts under one limit
gave three tags. `answers.sh` and `results/answers2.out` are the same comparison for each
compressed workload of the first run, made after it.

## Memory

1. `flood-memory-x.mjs`: `bench/fullstack/flood-memory.mjs` as it was run here, with the limits
   as variants and room for 65,536 open files in the app's container (Docker 29 gives a
   container 1,024, which refused most of a flood). Eight floods of 4,000 unfinished 30 KiB
   request heads, three runs a setting: `results/flood.out` (jemalloc's background thread alone,
   and with a 64 KiB, a 512 KiB and a 1 MiB limit), `results/flood-glibc.out`, and
   `results/flood2.out` (three more runs at 64 KiB and at 1 MiB); `results/flood/` has each
   run's JSON. In these files `jemalloc-tuned` is the 64 KiB limit.
2. `mem8.sh` and `mem-load.mjs`: the app on eight CPUs, 64 connections asking for the
   202,041-byte page with `br` 20,000 times; the cgroup's memory as the load ended and 35 s after;
   three rounds. `results/mem8.out`.
3. `mix.py`, `mem-mix.sh` and `mem-load-mix.mjs`: the same with a fixture of nine items whose
   pages run from 9,793 to 495,527 bytes, asked in turn, at 64 KiB, 512 KiB, 1 MiB and on glibc,
   and the one-length run for 512 KiB, which `mem8.sh` left out. `results/mem-mix.out`.
4. `idle.sh`: the CPU an app that has served no request takes in 60 s and its threads, three
   rounds. `results/idle.out` (64 KiB and 1 MiB) and `results/idle-512k.out`.
