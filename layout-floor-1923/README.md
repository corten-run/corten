# corten-run/corten#1923: the cycle floor from code placement alone

A/A runs of Corten main `14471284c` against itself, with the protocol pull requests are gated on
(#1829's fresh-start paired cycles), to measure how large a cycles-per-request change code
placement alone produces. `results/margin.md` declares the plan, the reporting and the time
(about 60 minutes on a c-8, nothing tested against a margin).

## Run it

On a fresh Debian 13 x64 c-8 droplet (root, nothing else running), upload `cycles-1923.tar` (made
by `pack.ps1`) as `/root/cycles-1923.tar`, then:

```sh
mkdir -p /m && tar -xf /root/cycles-1923.tar -C /m && sh /m/1923/setup.sh
nohup sh /m/1923/run.sh >/m/1923/run.out 2>&1 &
```

`setup.sh` installs the packages and rustc 1.100.0 and runs `build.sh` (ends `SETUP-DONE`).
`run.sh` ends `ALL-DONE` in `run.out`; then copy back `/m/1923/results` (it includes
`sha256.txt` and `layout-*.txt` from `bin/`). `results/floor.md` is the summary. Do not log in or
run anything else while it runs. Everything is under `/m/1923` and `/m/target-1923`, so another
kit can run on the host before or after it (not at the same time: CPUs 2, 4, 5, 7 and ports
18081-18082). `HIT=1` adds the `hit` workload (about 37 more minutes).

## Files

1. `commits.env`, `src-main/`, `src-main.commit`: main's tree (`git archive` of `crates examples
   Cargo.toml Cargo.lock .cargo`).
2. `probe/`: #1829's probe program, unchanged (`src/main.rs`), as one package (`p1923`, bin
   `probe`) depending on `../work/crates/corten`, with main's Cargo.lock.
3. `variants/pad40.diff`, `variants/pad3100.diff`: the layout perturbations of
   `crates/corten/src/router.rs` (a never-called `#[inline(never)]` function of 40 or 3,100 NOP
   bytes after the imports, kept by one `black_box` of its address in `Router::new`, which runs
   once at startup).
4. `build.sh`: builds `bin/main-1`, `bin/main-2` (a second full build of main, target emptied
   first), `bin/pad40`, `bin/pad3100` from `/m/1923/work`; writes `bin/sha256.txt` and
   `bin/layout-*.txt` (`layout.mjs`: how far each build's functions sit from main-1's).
5. `run.sh`: preflights the events, checks every comparison's answers and one unrecorded pair,
   then pass 1 (cycles, 100 pairs x 3 comparisons) and pass 2 (front-end events, 30 pairs x 2),
   then `report.mjs`.
6. `run-pair-fresh.sh`: `../run-pair-fresh.sh` with an `EVENTS` setting (the default writes the
   same CSV as before); `run-pair.sh`, `check-warm.sh`, `summary.mjs`, `lua/get.lua`,
   `checks-*.txt`, `mask.sed`: copied unchanged from the #1829 kit.
7. `stats.mjs`, `summary-events.mjs`, `report.mjs`: the same statistics as summary.mjs for any
   column, and `results/floor.md`.