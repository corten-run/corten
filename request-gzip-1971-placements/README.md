# corten-run/corten#1971: the second declared run, read across placements

The receipt for the run design Choice 73 records, on 2026-11-23: #1971's change (base, main
`14126d2a8`, against head `498291116`, this branch with that main merged) on kit 1965's probe
and protocol, each side compiled once and placed 30 ways by relinking with a never-called pad
first in `.text`. The first declared run for this pull request and its diagnostic are under the
tag `evidence/request-gzip-1971`; nothing here replaces them.

## Outcome

| Comparison | Placements | Median of placement medians | Bound | Bound, labels swapped | Reading |
|---|---|---|---|---|---|
| `aa-zstd`, base against itself | 30 of 30 | +0.27% | +0.49% | -0.09% | resolved |
| `change-zstd` | 30 of 30 | -0.43% | -0.03% | | meets +1% |
| `aa-plain`, base against itself | 30 of 30 | +0.42% | +1.03% | +0.22% | **not resolved** |
| `change-plain` | 30 of 30 | -0.06% | +0.22% | | **not resolved: does not pass** |
| `sb-gzbr`, one build of each side, 40 pairs | | -31.43% | -31.20% | | reduction established |

Changes are in user plus kernel cycles a request. `plain` was not resolved, so by the plan the
change does not pass on it, whatever its own bound. `results/h09/results/placements-plain.md` and
`results/h10/results/placements-zstd.md` are the reports.

## What is here

1. `results/margin.md` in the kit directory: the plan as it stood in the pull request's
   description before the run. Its section "Changed before the run" says what changed after
   the plan was first posted and before any turn was measured (the value of a weak `ETag` is
   masked in the compressed requests' headers). The plan as first posted is
   `results/h09/results-fail2/margin.md`.
2. The kit as run: `setup.sh`, `build.sh`, `verify.sh`, `run.sh`, `run-pair-fresh.sh`,
   `report71.mjs`, `tail.mjs`, `plan.env`, `plan.sh`, `commits.env`, the check and mask files,
   `lua/`, `probe/`, `wrap/cc`, and, unchanged from the tag `evidence/ee7b0b41`, `layout.mjs`,
   `link-capture.mjs`, `relink.mjs`, `pads.mjs`, `stats.mjs` and `placement.mjs`. `src-base/` and
   `src-head/` are `git archive` of `crates examples Cargo.toml Cargo.lock .cargo` at the two
   commits. One comment line of `run-pair-fresh.sh` that named a path on the workstation the kit
   was packed on was shortened in this commit; the script is otherwise as it ran, and this
   commit's parent, under the tag `evidence/request-gzip-1971-placements`, has it as it ran.
3. `results/h09`: the host that ran `plain` (a c-8 with a Xeon Platinum 8168). `results/h10`: the
   host that ran `zstd` and then `sb-gzbr` (a c-8 with a Xeon Platinum 8280). Both Debian 13,
   Linux 6.12.117, rustc 1.100.0 with LLD 23.1.5, gcc 14.2.0, perf 6.12.118. In each: `results/`
   (the run: `host.txt`, `sha256.txt`, `placements.txt`, `layout/`, `verify/`, every placement's
   CSV and logs, the report), `results-dry/` (the dry run that passed, marked `DRYRUN`, read for
   nothing), `results-fail2/` (the dry attempt that stopped at the answer check), `run.out` and
   `dry.out`. The two hosts built the same 92 binaries (`bin/sha256.txt` is the same file).

## What happened before the run

1. The dry run's first attempt stopped in `verify.sh` before any turn: `run-pair-fresh.sh` and
   eight other files copied from the earlier kit had Windows line endings from the checkout they
   were extracted on. They were converted, the kit was unpacked and built again on both hosts, and
   the two unpadded binaries had the SHA-256s they had before. That attempt's output was not kept.
2. The second attempt stopped at the answer check: the plan as first posted compared headers
   with nothing masked but `Date`, and a compressed answer's weak `ETag` is keyed per process
   start. The plan was changed, in the description, before any turn was measured
   (`results/margin.md`, "Changed before the run"); `verify.sh` records two starts' values first
   (`results/h*/results/verify/etag-two-starts.txt`).
3. The third attempt, 5 pads and 2 pairs, ran through. It counted cycles and is not a
   measurement; `results-dry/` holds it.

## The C code

The head links libdeflate, whose function sections gcc aligned to 16, 32 and 64 bytes. In all
30 placements of the head the 3,405 function symbols before the C code moved by exactly the pad
(102,150 of 102,150); of the 1,290 shifts of the 43 after it, 387 were exactly the pad, 318 were
16 bytes more, 312 were 16 less and 273 were 32 less, and every one was exact in the 8 placements
whose pad is a multiple of 64. The base's 3,407 moved by exactly the pad in all 60 of its
placements. `tail.mjs` is the check; `results/h*/results/layout/tail-*.txt` has each placement's.
