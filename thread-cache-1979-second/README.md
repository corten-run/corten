# corten-run/corten#1979: the second declared run, 64 KiB against 512 KiB on the host's network

The receipt for the second run design Choice 23 records, on 2026-11-23. The first run and its
diagnostic are under the tags `evidence/thread-cache-1979` and
`evidence/thread-cache-1979-diagnostic`; nothing here replaces them.

## What is here

1. `plan.md`: the plan as it stood in the pull request's description before the run started.
2. `noise/`: what was looked at before the plan was written. `noise.sh` runs one setting (64 KiB)
   on the uncompressed 9,793-byte page for 30 turns in each of four modes, on a c-16 with a Xeon
   Platinum 8280 and card-market's image of main `14126d2a8`; `turns.py <log>` reads a log.
   `bridge.log` is a published port with a fresh start each turn, `bridge-warm.log` a published
   port in one start, `host.log` the host's network with a fresh start each turn and
   `host-warm.log` the host's network in one start. Every turn in a log is labelled "turn 1" (a
   fault in `noise.sh`'s counter); the 30 turns are there and `turns.py` does not read the number.
3. `setup-tc.sh`: what each host ran first (Docker, `wrk`, `perf`, card-market's image built
   from an archive of `faba240cd`, the fixtures `sizes.py` writes). `tc-pair3.sh`: one comparison
   (the first run's script with the app on the host's network). `tc-run3.sh identity|zstd|br`:
   one host's three comparisons in order. `pairs3.py <log> <A> <B> 1 [--swapped]`: the reading.
4. `results/h06`, `h07`, `h08`: each host's logs as written and its `host.txt` (date, kernel,
   CPU, Docker, `wrk`, `perf`, the server binary's SHA-256, the image's id, the load average).
   `results/readings.txt`: `pairs3.py` run over every log.

5. `trial/`: a trial of the scripts on `h06`, from 14:06:46 to 14:07:58 UTC, before the plan was
   in the pull request's description (14:08:16 UTC) and before the run started (14:08:24). It ran
   one pair of 512 KiB against 64 KiB with `br` on each of the four page lengths (`n1`, `n20`,
   `n160`, `n400`) and two pairs of 64 KiB against itself with `identity` (`aa.log`). It ran no
   pair of 512 KiB against 64 KiB with `identity` or with `gzip, deflate, br, zstd`. The margins,
   counts and readings in the plan were written before it and were not changed after it. These
   logs were added to the receipt in a second commit, after the first was tagged.

## The run

Three DigitalOcean c-16s, Linux 6.8.0-149, Docker 29.10.0, perf 6.8.12, `wrk` 4.1.0. `h06` and
`h07` have a Xeon Platinum 8280 and `h08` an 8358; the plan named no CPU. The image was built on
each host; the server in it is one binary on all three (SHA-256 `5454a6e3...`, in each
`host.txt`). The labels are `tc64k` (64 KiB), `tc64kb` (64 KiB again, under a second label) and
`tc512k` (512 KiB). Each comparison ran once, in the plan's order, and no pair was dropped.

| Host | Comparison | Pairs | Median per-pair change | Bound | Bound, labels swapped |
|---|---|---|---|---|---|
| h06 | 64 KiB against itself, 9,793 bytes, `identity` | 200 | +0.02% | +0.43% | +0.20% |
| h06 | 512 KiB against 64 KiB, 9,793 bytes, `identity` | 200 | +0.01% | +0.20% | |
| h06 | 512 KiB against 64 KiB, 32,501 bytes, `br` | 40 | -30.09% | -29.30% | |
| h07 | 64 KiB against itself, 9,793 bytes, `gzip, deflate, br, zstd` | 200 | +0.05% | +0.36% | +0.20% |
| h07 | 512 KiB against 64 KiB, 9,793 bytes, `gzip, deflate, br, zstd` | 200 | -0.00% | +0.41% | |
| h07 | 512 KiB against 64 KiB, 202,041 bytes, `br` | 40 | -18.79% | -18.39% | |
| h08 | 64 KiB against itself, 9,793 bytes, `br` | 200 | -0.07% | +0.13% | +0.17% |
| h08 | 512 KiB against 64 KiB, 9,793 bytes, `br` | 200 | -0.19% | -0.06% | |
| h08 | 512 KiB against 64 KiB, 495,521 bytes, `br` | 40 | -13.42% | -13.13% | |

The changes are in user plus kernel cycles a request; the bound is the one-sided 95% order
statistic on the median per-pair change (the 113th of 200, the 26th of 40). Every self-comparison
resolved 1% in both readings, every short page met +1%, and every long page's reduction is past
the 5% the plan asked. No pair had a failed request or a counter under 100%.

Noise, from `turns.py` over the four logs: the standard deviation of cycles a request across 30
turns was 3.99% of the mean behind a published port with fresh starts, 2.51% behind the port in
one start, 1.56% on the host's network with fresh starts and 0.91% on the host's network in one
start.
