# Rows 1 to 7 for A and B against `main` (counted 2026-11-24, 18:41 to 19:04 UTC)

Everything below is measured unless it says read or estimated. Instructions and allocations a
request, by callgrind, with the harness of the tag `evidence/deadline-timer`
(`deadline-timer/kit/build/r2-count.sh`, `r2-settle.sh`, `count4.py`) and two additions to its
count script, kept in `variants/ab/count5.py`:

1. `--first <case>`: on a kept-alive connection the connection's first request is that case and
   every later one is the counted case. Row 7 is `--cases get --first sdelay1`.
2. Allocations: calls to `malloc`, `calloc`, `realloc`, `posix_memalign`, `aligned_alloc` and
   `memalign`, summed from the `calls=` lines of callgrind's output file by callee, and calls to
   `free` the same way; counted as instructions are (the difference of two runs, over 1,000).

## What was counted

- `main`: `81e77162a666a8be1360a6f4705b9f54feb7d511`, the branch's merge base with `origin/main`.
- A: `098f56243e4445777e97cde99ff738099c13cc33`, the branch's head. Its `deadline.rs` is
  `75ded4019`'s (0 lines differ).
- B: A with the two-stage change: `diff -u` of the tag's `variants/built-deadline.rs` and
  `variants/two-stage-deadline.rs` applied to A's `deadline.rs` with `patch` (20 changed lines
  against A; `variants/ab/two-stage.diff`, `variants/ab/b-deadline.rs`).
- The app is the tag's (`deadline-timer/app/`, the call to `App::per_core` removed by `sed`),
  built inside each whole tree at `bench/httparena/corten`, so with the tree's cargo
  configuration: tokio 1.54.1 and hyper 1.12.0 in all three (`out/r3/app-Cargo.lock-*`),
  `RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"`, release.
- Host: a cloud host, 8 vCPUs, Xeon Platinum 8168 at 2.70 GHz, Debian 13, Linux
  6.12.117+deb13-amd64; in `rust:1-trixie`: rustc 1.100.0, valgrind 3.24.0, libjemalloc2
  5.3.0-3. The earlier counts were on a Xeon Platinum 8280 and an 8358; eight tries for one of
  those gave an 8168 each time. `main`'s single-threaded row 1 reads 19,982 and 19,981 here and
  read 19,982 and 19,981 on the 8358 (the description's table), so the counts carry over.
- A count is the difference of a run of 1,240 requests and one of 240, over 1,000, the server
  held to one CPU under callgrind with jemalloc preloaded
  (`MALLOC_CONF=background_thread:false,tcache_max:65536`), one client, each request sent after
  the answer before it. Each figure is the median of three counts; two rounds, the builds in the
  order `main`, A, B and then B, A, `main`. "x and y" is round 1 and round 2.
- "multi" is `ARENA_MODE=default` (tokio's multi-threaded runtime, which under one CPU has one
  worker); "single" is `ARENA_MODE=percore-by-hand` (one single-threaded runtime).

## Instructions a request

| Row | Request | Runtime | `main` | A | A over `main` | B | B over `main` | A: most minus least of its 3 counts, by round | B: the same |
|---|---|---|---|---|---|---|---|---|---|
| 1 | staged GET, no wait, kept-alive | multi | 20,590 and 20,588 | 20,595 and 20,592 | +5 and +4 | 20,611 and 20,591 | +21 and +3 | 11 and 1 | 30 and 0 |
| 2 | staged GET, sleeps 1 ms, kept-alive | multi | 25,060 and 25,057 | 24,924 and 24,928 | -136 and -129 | 24,926 and 24,936 | -134 and -121 | 20 and 15 | 27 and 7 |
| 3 | unstaged GET, no wait, kept-alive | multi | 12,166 and 12,168 | 12,183 and 12,185 | +17 | 12,184 | +18 and +16 | 3 and 2 | 4 and 2 |
| 4 | unstaged GET, sleeps 1 ms, kept-alive | multi | 18,211 and 18,217 | 18,238 and 18,245 | +27 and +28 | 18,247 and 18,215 | +36 and -2 | 19 and 20 | 27 and 30 |
| 5 | a connection for each request, no wait | multi | 33,248 and 34,247 | 33,303 and 33,233 | +55 and -1,014 | 33,222 and 33,316 | -26 and -931 | 43 and 117 | 61 and 73 |
| 6 | a connection for each request, sleeps 1 ms | multi | 38,392 and 38,391 | 38,794 and 38,784 | +402 and +393 | 38,506 and 38,504 | +114 and +113 | 9 and 507 | 703 and 12 |
| 7 | kept-alive, the first request sleeps 1 ms, the later ones do not wait: the later ones | multi | 20,590 and 20,591 | 20,633 and 20,621 | +43 and +30 | 20,631 and 20,594 | +41 and +3 | 20 and 48 | 2 |
| 1 | staged GET, no wait, kept-alive | single | 19,982 and 19,981 | 19,988 and 20,010 | +6 and +29 | 19,988 and 19,989 | +6 and +8 | 1 and 21 | 0 and 1 |
| 2 | staged GET, sleeps 1 ms, kept-alive | single | 23,811 and 23,802 | 23,676 and 23,683 | -135 and -119 | 23,677 and 23,683 | -134 and -119 | 8 and 3 | 25 and 6 |
| 5 | a connection for each request, no wait, the client waiting 10 ms after each close | single | 31,694 and 31,652 | 31,688 and 31,786 | -6 and +134 | 31,712 and 31,805 | +18 and +153 | 443 and 682 | 138 and 675 |
| 6 | a connection for each request, sleeps 1 ms, the client waiting 10 ms after each close | single | 35,055 and 35,074 | 35,513 and 35,518 | +458 and +444 | 35,226 and 35,222 | +171 and +148 | 8 and 11 | 8 |
| 7 | kept-alive, the first request sleeps 1 ms, the later ones do not wait: the later ones | single | 19,961 and 19,981 | 20,013 | +52 and +32 | 19,990 and 19,988 | +29 and +7 | 2 and 0 | 1 |

What the counts do and do not separate:

1. **Row 7.** On the single-threaded runtime A's six counts are 20,012 to 20,014 and B's are
   19,988 to 19,990; A's own row 1 there is 19,988 (round 1), so the swap of the connection's
   timer in and out costs A's later requests **25 instructions a request** over the same request
   on a connection that never waited, and B's later requests cost what its row 1 costs (B makes
   no timer at a connection's first waiting request). Over `main`: A +52 and +32, B +29 and +7;
   the two figures of each differ because `main`'s own counts took two values (19,983, 19,960,
   19,961 in round 1; 19,982, 19,981, 19,980 in round 2). On the multi-threaded runtime A's six
   counts are 20,616 to 20,664 (+43 and +30) and B's are 20,631 to 20,633 in round 1 and 20,592
   to 20,594 in round 2 (+41 and +3): a build's counts there sit on one of two levels about 40
   apart (B's row 1 shows the same: 20,611, 20,622, 20,592 and then 20,591 three times), so on
   that runtime row 7 does not separate A from B.
2. **Row 6** is the worst row of both: A +458 and +444, B +171 and +148 on the single-threaded
   runtime with the client waiting 10 ms after each close (the series the earlier rule read:
   +449 and +154 then); A +402 and +393, B +114 and +113 on the multi-threaded runtime, where
   one count of three is off by about 500 to 700 in two of the four cells.
3. **Row 5 is not read to 50 instructions by either series.** Multi-threaded, `main`'s round 2
   sits about 1,000 over its round 1 (34,311, 33,773, 34,247 against 33,249, 33,248, 33,180),
   which is what makes A and B read about 1,000 under it. Single-threaded with the 10 ms wait, a
   build's three counts spread 138 to 682; the medians there are -6 (A) and +18 (B) against
   `main` in round 1 and +134 and +153 in round 2, and neither is a difference the counts hold. A connection that never waits gets no timer and no allocation from either
   form (below), and its polls go through the same wrapper as row 1's.
4. Rows 1, 3 and 4: A and B within 36 of `main`, and within 30 of each other.
5. Row 2, the gain the rule's second point reads: A -136 and -129, B -134 and -121
   (multi-threaded), and -135 and -119 for A, -134 and -119 for B (single-threaded): within 100
   of each other.

## Allocations a request (calls to the allocator; calls to `free` are the same numbers in every cell)

| Row | Request | Runtime | `main` | A | B |
|---|---|---|---|---|---|
| 1 | staged GET, no wait, kept-alive | multi | 16 | 16 | 16 |
| 2 | staged GET, sleeps 1 ms, kept-alive | multi | 14 | 14 | 14 |
| 3 | unstaged GET, no wait, kept-alive | multi | 11 | 11 | 11 |
| 4 | unstaged GET, sleeps 1 ms, kept-alive | multi | 12 | 12 | 12 |
| 5 | a connection for each request, no wait | multi | 28.003 | 28.003 | 28.003 |
| 6 | a connection for each request, sleeps 1 ms | multi | 26.001 | 27.001 | 26.001 |
| 7 | kept-alive, the first request sleeps 1 ms: the later ones | multi | 16 | 16 | 16 |
| 1 | staged GET, no wait, kept-alive | single | 16 | 16 | 16 |
| 2 | staged GET, sleeps 1 ms, kept-alive | single | 14 | 14 | 14 |
| 5 | a connection for each request, no wait, 10 ms after each close | single | 28 | 28 | 28 |
| 6 | a connection for each request, sleeps 1 ms, 10 ms after each close | single | 26 | 27 | 26 |
| 7 | kept-alive, the first request sleeps 1 ms: the later ones | single | 16 | 16 | 16 |

Every cell is the same in both rounds and in all three counts of a round, but for two counts of
row 2 on the single-threaded runtime that read 13.997 and 13.998 (`main` and A, round 2).

1. **A request:** neither form adds an allocation to any request (rows 1 to 4 and 7).
2. **A connection** (a row with a connection for each request less the kept-alive row of the
   same request): a connection that never waits costs 28 - 16 = 12 allocations on `main`, A and
   B. A connection whose one request waits costs 26 - 14 = 12 on `main` and B and 27 - 14 = 13
   on A: **A adds one allocation to a connection at its first waiting request (the boxed timer),
   B adds none to a connection with one waiting request.** Neither adds one to a connection that
   never waits.
3. Not counted: B's allocation at a connection's second waiting request. It is one boxed timer
   a connection, as A's (read in `b-deadline.rs`); the kept-alive rows leave it out because a
   count is the difference of two runs on one connection each.
4. Not measured here: bytes an idle connection holds before and after a wait. For A the
   description has them from an earlier build (the connection's future 16 bytes larger, and a
   boxed `Sleep` of 112 bytes from the first wait); nothing was measured for B.

## Commands

On the count host, in `/root/dl` (holding `main.tgz` and `a.tgz`, `git archive` of the two
commits; `b-deadline.rs`; `entry.tgz`, the app; `count5.py`), `bash r3-count.sh`, which is kept
whole in `variants/ab/r3-count.sh`. It unpacks the trees, copies A's to B's with
`b-deadline.rs`, puts the app in each, and runs in one container
(`docker run --rm --ulimit nofile=1048576:1048576 -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/inside-r3.sh`;
the open-file limit because this host's Docker gave a container one of over 10^9, under which
valgrind did not start, and the first start of the counts failed for it):

```sh
apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes" ZSTD_SYS_USE_PKG_CONFIG=1
# for name in main a b:
(cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release)
# for each build, round 1 in the order main a b and round 2 in the order b a main,
# B=/w/target-$name/release/httparena-corten:
ARENA_MODE=default python3 /w/count5.py $B --reps 3 --cases get,sdelay1,pipeline,delay1 --names   # rows 1 to 4
ARENA_MODE=default python3 /w/count5.py $B --reps 3 --cases get,sdelay1 --each-its-own            # rows 5, 6
ARENA_MODE=default python3 /w/count5.py $B --reps 3 --cases get --first sdelay1                   # row 7
ARENA_MODE=percore-by-hand python3 /w/count5.py $B --reps 3 --cases get,sdelay1                   # rows 1, 2
ARENA_MODE=percore-by-hand python3 /w/count5.py $B --reps 3 --cases get,sdelay1 --each-its-own --settle-ms 10   # rows 5, 6
ARENA_MODE=percore-by-hand python3 /w/count5.py $B --reps 3 --cases get --first sdelay1           # row 7
```

`get` is `GET /baseline11?a=1&b=2` (staged, does not wait), `sdelay1` is `GET /sdelay/1`
(staged, sleeps 1 ms), `pipeline` is `GET /pipeline` (unstaged, does not wait) and `delay1` is
`GET /delay/1` (unstaged, sleeps 1 ms).

## Files (all under `variants/ab/`)

- `count5.py`, `r3-count.sh`, `pack.sh` (makes the inputs and starts the counts), `fetch.sh`,
  `rows.mjs` (prints the tables above from the count files, and every count).
- `a-deadline.rs`, `b-deadline.rs`, `two-stage.diff`, `main.tgz`, `a.tgz`.
- `out/r3-count.log`: the whole run's output. `out/r3/count-*-<build>-<round>.txt`: one file a
  series, build and round; `out/r3/host.txt`; `out/r3/app-Cargo.lock-<build>`;
  `out/r3/build-<build>.log`.
- The binaries' sha256 (first 16 characters): `main` `9ec12399a0e5e15f`, A `ac6e6ddeaeb6c9c6`,
  B `80dd115bed1d9fd5`.
