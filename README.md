# corten-run/corten#1983: an older kept answer's Age written to a buffer, read across placements

Paired cycles of a change against its base, each side compiled once and **placed K = 30 ways by
relinking the same objects with a never-called pad first in `.text`** (design Choice 72), on a
kept answer whose `Age` is past the table of ages (`old`) and on the same answer while its `Age`
is in the table (`young`), with an A/A of the base against itself on each. Every placement is
started fresh on every turn and read with R = 8 recorded pairs after one that is not.
`results/margin.md` declares the plan, the margins and what decides, and was written before any
binary was built or measured. Scratch for one measurement, not repository documentation.

It is the first placement run's kit (tag `evidence/ee7b0b41`) with these differences:

1. Two sides (base, head) and four read comparisons (`aa-old`, `change-old`, `aa-young`,
   `change-young`), with a diagnostic of the unpadded base (`unpadded-old`).
2. The probe has one more route, `GET /picture.png`, a PNG of 8,000 bytes kept for four hours, and
   `GET /picture-runs`, how many times its handler ran.
3. `shim/clockstep.c`, preloaded beside the allocator, moves a start's monotonic clock on by
   10,005 seconds when the driver signals it, so a freshly started server gives a kept answer
   past the table. `run-pair-old.sh` (from kit 1965's `run-pair-fresh.sh`) keeps the answer, moves
   the clock for `old`, and checks every start's `Age` against its range before and after its
   turn, and that its handler ran once.
4. Answers are compared as received: the status, every header line but `Date` with only the
   `Age`'s value set aside (checked against its range instead), and the body byte for byte.
5. `L1-icache-load-misses:u` is counted with the cycles and instructions, and each A/A is read
   twice, as recorded and with its lists' labels swapped (`placement.mjs`, `report.mjs`).

## Run it

On a fresh Debian 13 x64 host with 8 dedicated CPUs (root, nothing else running), with the kit
unpacked as `/m/1983`:

```sh
sh /m/1983/setup.sh
nohup sh /m/1983/run.sh >/m/1983/run.out 2>&1 &
```

`setup.sh` installs the packages and rustc 1.100.0 and runs `build.sh` (ends `SETUP-DONE`).
`run.sh` ends `ALL-DONE`; `results/placements.md` is the summary. `DRYRUN=1` for both is a
container test with a stand-in for `perf` (`dry/perf`): the first 5 pads, 2 pairs, and results
marked `DRYRUN`. `node check-report.mjs` checks the reading on made-up results.

## Files

1. `commits.env`, `src-{base,head}/`, `src-*.commit`: the two trees (`git archive` of `crates
   examples Cargo.toml Cargo.lock`).
2. `plan.env` (K, R, the pads, the step and the `Age` ranges), `pads.mjs` (the lists and the
   rule they meet), `plan.sh`.
3. `probe/`, `shim/clockstep.c`, `lua/picture.lua`.
4. `wrap/cc`, `link-capture.mjs`, `relink.mjs`, `layout.mjs`, `stats.mjs`: kit 1965's.
5. `build.sh`, `verify.sh`, `run.sh`, `run-pair-old.sh`, `setup.sh`, `start.sh`.
6. `placement.mjs`, `report.mjs`, `check-report.mjs`.
