# The deadline's timer, third evidence directory (2026-11-24)

What was taken once the branch had merged `main` at `df9242b56`, for design Choice
`choice-deadline-timer` and for the cycle plan of pull request 2029 as declared again on that
base. The merge commit is `2a653b1d0`; its code under `crates/` is the two-stage form's
(`ca259c467`, the second directory's `rows/head/`) with `main`'s changes.

This tag's commit is a child of the commit of the tag `evidence/deadline-timer-2` and keeps its
tree whole; nothing under `deadline-timer/` or `deadline-timer-2/` is changed.

Nothing here is a cycle count of the change read for a margin, and nothing here sizes the gated
run. Neither part of the plan had started on this base when this tag was made.

Every file is stored byte for byte as it was fetched or written, with no line-ending conversion.

## `rows/`

Instructions and allocations a request by callgrind, four builds in one session on one host:
`main` at `df9242b56` (named `newbase` in the files) against the merge commit `2a653b1d0`
(`merge`), and as a control the pair the second directory counted, `main` at `81e77162a` (`main`)
against `ca259c467` (`b`). Rows 1 to 4, 5 and 6 and 9 of the second directory's `rows-head.md`, on
both runtimes; rows 7 and 8 were not counted again.

1. `r6-count.sh` is the session as run (two rounds, the builds in opposite orders) and `count6.py`
   the counter it calls, the second directory's.
2. `out/` is every count, each build's log and lock file, and `host.txt` (the compiler, valgrind,
   the kernel, the CPU). `count.log` is the session's log; its first four lines are each build's
   hyper and tokio versions and the first 16 digits of its binary's sha256.
3. `rows.txt` is the table made from `out/` by `rows.mjs` (run under another file name): for each
   row and runtime, both rounds' medians of both pairs and each pair's difference.

## `checks/`

On the merge commit, in `rust:1-trixie`, each log ending with the command's exit status:
`fmt.log` (`cargo fmt --all --check`), `clippy.log` (`cargo clippy --workspace --all-features
--all-targets -- -D warnings`) and `lib.log` (`cargo test -p corten-run --all-features --lib`).
`mut2.log` is the tests against broken rules: `mut2.py` breaks one rule of the module at a time
and `mut2.sh` requires the tests named for the break to fail on it, then runs `tests::server` on
the module as it is.

## `trial/`

Two trials of the cycle plan's fifth workload, `after`, and of the check of its state. They ran
on the host that counted the rows, which is not a host of the plan, against one build of the
base alone (by `cargo build --release`, not by the kit's `build.sh`), and read no counter. They
are not measurements and size nothing; they show that the load does what the plan says of it
and that the check passes on a load that does.

`first/` passed, and its captures were not whole. Each held fewer requests than `wrk` counted
answered (157,200 of 157,751 in the first turn, 551 short; 471 and 289 short in the others), so
lacked the turn's end, though `tcpdump` reported no packet dropped: the check stopped `tcpdump`
half a second after the load, before it had read its last, unfilled buffer.
The check did not see that. `second/` is the check as corrected: it stops `tcpdump` two seconds
after the load and requires the capture to hold at least as many requests as were answered.
Its three captures held 63, 63 and 62 more than were answered, the requests on their way when
the load ended.

In each of the two:

1. `kit/` is what the trial ran of the plan's kit. In `first/`: `lua/after.lua` (the load's
   script), `state.sh` and `state.mjs` (the check; `node state.mjs --selftest` holds its rule to
   made-up captures that break it) and `checks-after.txt`. In `second/`: `state.sh` and
   `state.mjs` as corrected; the other two files are `first/`'s.
2. `trial.sh` is the trial as run, and `trial.out` its output: the self-test's last line, the
   three turns' verdicts, and the first turn's `wrk` and `tcpdump` output (in `first/` the
   tools' versions too).
3. `state/` is `state.sh`'s output directory: for each of three turns the server's log, `wrk`'s
   output, `tcpdump`'s and `state.mjs`'s verdict, and `verdicts.txt`. The captures themselves are
   not kept (about 157,000 packets a turn).

## `maps/`

A look, not a run's record, at whether either side's probe has code aligned beyond 16 bytes,
which `main` began to ask of every placement run after this branch merged it. The kit's probe
was built from the base (`df9242b56`) and from the merge commit (`2a653b1d0`) as the kit builds
it but in the `rust:1-trixie` image (the release profile, zstd from the system's libzstd, no C
archive made, linked by LLD 23.1.5), with LLD's map of the final link. `map.sh` is the look as
run, `mapsec.mjs` what read the maps, `map.out` its output, `base.map.gz` and `head.map.gz` the
two maps and `map-build-*.log` the builds. Neither map has an input section of `.text` aligned
beyond 16 bytes: 3,266 sections on the base and 3,276 on the head, the widest alignment 16.
`map.sh` asked `readelf` for the linker, which that host lacked, so `map.out` shows a blank
there; the binaries' `.comment` was read afterwards by hand.
