# corten-run/corten#1971: a request's gzip by libdeflate, the measurements

What design Choice 72 (`docs/design.md#choice-request-gzip`) cites: the kit as it was run and
every result file. The base is `bcf4aa073` (main) and the candidate `fdf94a6a7`, the commit this
tag sits on. `plan.md` holds the two plans, each written before its run.

## Hosts

Two DigitalOcean droplets with a Xeon Platinum 8280, Ubuntu 24.04, Docker 29.10.0, rustc 1.100.0
in `rust:1-trixie`:

1. A c-48 (Linux 7.0.0-43, perf 6.12.118): the cycles under load, the instruction counts and the
   times in process. `results/host.txt` has its details and the image ids.
2. A c-16 (Linux 6.8.0-149): the size sweep, the coders alone, the probe of card-market's image
   and the build times.

The scripts expect this directory at `/root/kit`, a clone of the repository at
`/root/corten-pr` and a clone of `MDA2AV/HttpArena@986128bbf527` (its `requests/`, its
`data/dataset.json` and its load generator, `docker/gcannon.Dockerfile`) at
`/root/work/httparena-gap/HttpArena`. They were written for these two hosts and are kept as
run, not as a tool.

## Cycles under load

1. `entry-staged/`: the small app (one runtime per core, each with its own listener, through
   Corten's stages; `GET /json/{n}?m=` writes `n` rows of the dataset with `Json`).
2. `stage-corten.sh`: builds its image from a tree's `crates`. `build-images.sh gcannon` and
   `build-perf.sh` build the load generator's and perf's images.
3. `pair.sh`: one workload's pairs (a fresh server each turn, 2 s of warm-up, the turn counted by
   `perf stat` on the server process, the builds' order turned every pair), after comparing the
   two builds' answers. `pairs.py` reads its log: pairs, medians, best, ranges, the per-pair
   changes and the order-statistic bound.
4. `measure-gz.sh <base> <candidate>`: the declared run. It makes the zstd request files from the
   benchmark's gzip ones, builds both images and runs the three workloads into
   `results/measure-gz/` (`gzbr.log`, `zstd.log`, `identity.log`); `results/final-*.txt` are
   `pairs.py`'s readings with every per-pair change.
5. `diag-gz.sh`, `pair-d.sh`, `pairs-d.py`, `pad3100.diff`: the diagnostic for the zstd
   workload, which also counts user L1 instruction-cache misses (`results/diag-gz/`,
   `results/diag-*.txt`). The pad is the layout-floor receipt's (`evidence/24c0d897`);
   `results/padcheck.txt` shows it in the padded binaries and how many functions it moved.
6. `results/preview-01ad562a3/`: a first run at an earlier commit, read before the plan was
   revised. Not the evidence.

## In process

`gz-count.sh` (callgrind and times of `route_loop`, card-market's release test build) and
`count-stats.py`; `results/gz-count-final.txt`. The long page's zstd row was not counted.

## The image probe

`faults.sh`, `faults3.sh`, `faults-load.mjs`, `faults-stats.py`: page faults and CPU a request
on card-market's image by allocator setting; `results/faults-item.out`, `faults-long.out`,
`faults-tcache.out`. `bodies3.sh` writes the long page's fixture (the smoke fixture's item with
its contents and field values repeated twenty times under varied names).

## Sizes and the coders alone

`compbench/` (the program), `prefixes.sh` (the sweep: each body cut to sizes from 1 KB up and
compressed whole by each coder; it renders the README, two guides and `docs/design.md` with
Python-Markdown's `tables` and `fenced_code`), `sweep-stats.py`, `compbench2.sh` (the coders
alone, timed); `results/prefixes.log`, `compbench3.log` to `compbench5.log`.
`bodies.sh` and `bodies2.sh` fetch card-market's pages and JSON and copy the JSON files;
`results/bodies.txt` lists the swept bodies with their sizes and hashes. The documents were
rendered from the repository at `01ad562a3`; Python-Markdown's version was not pinned or
recorded then, and 3.11.3 was what the same command installed a few hours later.

## Build time

`buildtime.sh`: card-market's clean release build as its image makes it, before and after, the
two taking turns; `results/buildtime.out`.
