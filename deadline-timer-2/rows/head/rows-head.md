# The branch's code at `ca259c467`: rows 1 to 9 against `main`, its checks, its tests against broken rules

Everything below is measured (2026-11-24, 21:13 to 21:52 UTC) unless it says read or reasoned.
`main` is `81e77162a666a8be1360a6f4705b9f54feb7d511`. The change is
`ca259c4670d6c492dc6b197d78b0ae2a272e8856`: form B (the connection makes its timer at its second
request to wait) with the second review's code findings applied. Host: a cloud host of 16 vCPUs,
a Xeon Platinum 8280, Debian 13, Linux 6.12.117; in `rust:1-trixie`: rustc 1.100.0, valgrind
3.24.0, libjemalloc2 5.3.0-3; tokio 1.54.1 and hyper 1.12.0 in both builds
(`counts/out/app-Cargo.lock-*`), `RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"`.

## Instructions a request

The harness is `../ab/rows-AB.md`'s, with one addition to its count script, kept here as
`count6.py`: `--first-count N` makes the connection's first N requests the `--first` case (rows 8
and 9). A count is the difference of a run of 1,240 requests and one of 240, over 1,000; each
figure is the median of three counts; round 1 has the builds in the order `main`, change and
round 2 the reverse. "x and y" is round 1 and round 2. `r4-count.sh` ran rows 1 to 8 and
`r5-count.sh` row 9. No count failed.

| Row | Request | Runtime | `main` | The change | Over `main` | `main`: most minus least of 3, by round | The change: the same |
|---|---|---|---|---|---|---|---|
| 1 | staged GET, no wait, kept-alive | multi | 20,590 and 20,591 | 20,596 | +6 and +5 | 6 and 1 | 6 and 5 |
| 2 | staged GET, sleeps 1 ms, kept-alive | multi | 25,050 and 25,059 | 24,925 and 24,927 | -125 and -132 | 2 and 14 | 21 and 17 |
| 3 | unstaged GET, no wait, kept-alive | multi | 12,169 and 12,166 | 12,186 and 12,184 | +17 and +18 | 4 and 5 | 5 and 2 |
| 4 | unstaged GET, sleeps 1 ms, kept-alive | multi | 18,190 and 18,205 | 18,227 and 18,232 | +37 and +27 | 26 and 17 | 10 and 14 |
| 5 | a connection for each request, no wait | multi | 33,316 and 33,290 | 33,296 and 33,294 | -20 and +4 | 313 and 92 | 112 and 239 |
| 6 | a connection for each request, sleeps 1 ms | multi | 38,400 and 38,375 | 38,481 and 38,499 | +81 and +124 | 44 and 41 | 43 and 358 |
| 7 | kept-alive, the first request sleeps 1 ms, the later ones do not wait: the later ones | multi | 20,593 and 20,591 | 20,592 and 20,595 | -1 and +4 | 5 | 2 |
| 8 | kept-alive, the first two requests sleep 1 ms, the later ones do not wait: the later ones | multi | 20,589 and 20,588 | 20,622 and 20,617 | +33 and +29 | 19 and 5 | 24 and 1 |
| 9 | kept-alive, the first three requests sleep 1 ms, the later ones do not wait: the later ones | multi | 20,590 and 20,593 | 20,803 and 20,805 | +213 and +212 | 2 and 8 | 18 and 10 |
| 1 | staged GET, no wait, kept-alive | single | 19,981 and 19,980 | 19,989 and 19,988 | +8 | 22 and 2 | 22 and 1 |
| 2 | staged GET, sleeps 1 ms, kept-alive | single | 23,813 and 23,788 | 23,680 and 23,679 | -133 and -109 | 3 and 12 | 4 and 10 |
| 5 | a connection for each request, no wait, 10 ms after each close | single | 31,472 and 32,006 | 31,856 and 31,286 | +384 and -720 | 282 and 22 | 508 and 886 |
| 6 | a connection for each request, sleeps 1 ms, 10 ms after each close | single | 35,065 and 35,056 | 35,236 and 35,255 | +171 and +199 | 23 | 22 and 61 |
| 7 | kept-alive, the first request sleeps 1 ms, the later ones do not wait: the later ones | single | 19,961 and 19,982 | 20,010 | +49 and +28 | 20 and 1 | 22 and 1 |
| 8 | kept-alive, the first two requests sleep 1 ms, the later ones do not wait: the later ones | single | 19,981 and 19,961 | 20,013 and 20,014 | +32 and +53 | 22 | 22 and 23 |
| 9 | kept-alive, the first three requests sleep 1 ms, the later ones do not wait: the later ones | single | 19,982 | 20,201 and 20,200 | +219 and +218 | 3 and 2 | 23 and 2 |

Rows 3 and 4 were counted on the multi-threaded runtime only. `node rows8.mjs counts/out` prints
this table, the allocations and every count.

What the counts do and do not separate:

1. **An earlier count of the same two binaries** (`counts-earlier/`, 21:13 to 21:31 UTC; the
   change then at `d1498841b`, whose crates differ from `ca259c467`'s by one comment, and the
   binaries' sha256 are the same in both counts: `main` `9ec12399a0e5e15f`, the change
   `017b6775b57c4c53`) gave, over `main`: row 1 +13 and +4 (multi) and +7 and +28 (single); row 2
   -128 and -130, and -131 and -128; row 3 +9 and +29; row 4 +44 and +30; row 6 +110 and +127,
   and +168 and +169; row 7 -1 and 0, and +7 in both rounds; row 8 +29 and +33, and +32 and +31;
   row 9 +209 and +216, and +219.
2. **Two levels on the single-threaded runtime.** A build's counts of one request there sit on
   one of two levels about 21 apart: `main` 19,960 to 19,961 or 19,980 to 19,984, the change
   19,988 to 19,989 or 20,009 to 20,010 on rows 1 and 7, and 20,013 to 20,014 or 20,035 to
   20,036 on row 8. Which level of one build answers which of the other is not known, so on rows
   1 and 7 the change reads 7 or 8 over `main`, 28 or 29, or 49 or 50, by which levels meet: row
   7's +49 is the change on its upper level against `main` on its lower, and row 1 has single
   counts as far apart (19,960 for `main` and 20,010 for the change in round 1), though its
   medians read +8. After one request that waited the connection has made no timer, and its
   poll runs the same code as on row 1 (read in `deadline.rs`: the connection's state is then
   `WAITED`, which the poll treats as it treats `UNNAMED`), so rows 1 and 7 count the same code
   for the requests they count.
3. **Row 5 is not readable** on either runtime: three counts of one build are 22 to 886 apart.
4. **Row 6:** +81 to +199 over the four rounds of the two counts. With the wait after each close
   the change's six counts are 35,218 to 35,294 here and `main`'s 35,043 to 35,074.
5. **Rows 8 and 9** are not rows of the rule. After two requests that waited the connection has
   made its timer and lends it in every poll: about 25 instructions a request over row 1. After
   three the timer is set and in tokio's wheel, and a request that does not wait costs 209 to
   219 more than `main`, 1.0% and 1.1%. Reasoned, not measured: that lasts until the timer
   fires, a deadline's length after the connection's last request that waited.

Allocations a request (calls to the allocator, counted as in `../ab/rows-AB.md`) are `main`'s on
every row: 16, 14, 11, 12, 28.003, 26.001, 16, 16 and 16 on the multi-threaded runtime and 16,
14, 28, 26, 16, 16 and 16 on the single-threaded one. The change adds no allocation to a
connection whose one request waits.

## Checks (`checks/`)

Each in `rust:1-trixie` on a `git archive` of `ca259c467`, by its own exit status:

1. `cargo fmt --all --check`: exit 0 (`fmt.log`).
2. `cargo clippy --workspace --all-features --all-targets -- -D warnings`: exit 0
   (`clippy.log`).
3. `cargo test -p corten-run --all-features --lib`: exit 0, 1,051 passed, 0 failed, 30 ignored
   (`lib.log`).
4. `mut2.sh` (`mut2.log`): each of 13 breaks of one rule of `deadline.rs` (`mut2.py` makes them)
   fails the tests named for it, and the module unbroken passes `tests::server`, 54 passed, 0
   failed, 2 ignored. `thread-local-unchecked` fails by the test binary aborting, and
   `not-moved` by the stress test's 60 s limit.
5. `paused5.sh` (`paused5.log`): on tokio's paused clock, after one request of 40 ms under a
   300 ms deadline the clock stays at 40 ms while the connection sits idle; after two at 80 ms,
   one timer kept and not set; after three it goes from 120 ms to 380 ms.

## Commands

```sh
# counts, in rust:1-trixie with valgrind and libjemalloc2, for each build B and each round:
ARENA_MODE=default python3 count6.py $B --reps 3 --cases get,sdelay1,pipeline,delay1 --names   # rows 1 to 4
ARENA_MODE=default python3 count6.py $B --reps 3 --cases get,sdelay1 --each-its-own            # rows 5, 6
ARENA_MODE=default python3 count6.py $B --reps 3 --cases get --first sdelay1                   # row 7
ARENA_MODE=default python3 count6.py $B --reps 3 --cases get --first sdelay1 --first-count 2   # row 8
ARENA_MODE=default python3 count6.py $B --reps 3 --cases get --first sdelay1 --first-count 3   # row 9
ARENA_MODE=percore-by-hand python3 count6.py $B --reps 3 --cases get,sdelay1                   # rows 1, 2
ARENA_MODE=percore-by-hand python3 count6.py $B --reps 3 --cases get,sdelay1 --each-its-own --settle-ms 10   # rows 5, 6
# and rows 7 to 9 with ARENA_MODE=percore-by-hand as above
```

`r4-count.sh` and `r5-count.sh` are the scripts as run and name the working directory they ran
in on the count host.
