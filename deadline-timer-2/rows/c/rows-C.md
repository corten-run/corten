# Form C (a slot in the connection's watch): rows, variants and what was observed

Taken from the report of the session that built and counted form C (2026-11-24), which is not in
this directory because it names local paths; every figure below is that report's, measured there
and not taken again here. The scripts as run and their raw output are beside this file.

`main` is `81e77162a`, A is `098f56243`, C is `05c9bf95f` (branch `prototype/deadline-slot`, a
parent of this tag's commit). Instructions a request by callgrind 3.24, the median of three
counts, round 1 / round 2 in opposite orders, one session, `count2.py` unchanged from the tag
`evidence/deadline-timer`, row 7 by `extra.py` with its server and client. rustc 1.100.0, tokio
1.54.1, hyper 1.12.0, a 16-vCPU host (a Xeon Platinum 8168), Linux 6.8.0. A and B were counted in
another session on another host (`../ab/rows-AB.md`); C's own count of A here is its control.

## What C is

`Slot(Mutex<Option<Held>>)` in the connection's `Watch`, `Held(Pin<Box<Sleep>>)`, no `unsafe`. A
deadline holds `Arc<Watch>` and the timer, so its drop gives the timer back from any thread or
task. The watch is lent to the thread in `Answer::poll` through a thread-local pair, on every
poll of every watched request, and a deadline takes the slot's timer only when the waker it is
polled with is the connection's. C keeps the timer from a connection's first request to wait.
The crate's non-test code passes `cargo check --all-features` against tokio 1.44.0.

## Multi-threaded runtime

| Row | main | A | C | A over main | C over main |
|---|---|---|---|---|---|
| 1 staged GET, no wait | 20592 / 20591 | 20593 / 20592 | 20615 / 20617 | +1 / +1 | +23 / +26 |
| 2 staged, sleeps 1 ms, kept-alive | 25048 / 25048 | 24930 / 24925 | 24976 / 24974 | -118 / -123 | -72 / -74 |
| 3 unstaged GET, no wait | 12166 / 12165 | 12209 / 12183 | 12200 / 12203 | +43 / +18 | +34 / +38 |
| 4 unstaged, sleeps 1 ms | 18198 / 18209 | 18241 / 18239 | 18255 / 18257 | +43 / +30 | +57 / +48 |
| 5 connection each, no wait | 33230 / 33215 | 33291 / 33350 | 33310 / 33311 | +61 / +135 | +80 / +96 |
| 6 connection each, sleeps 1 ms | 38456 / 38212 | 38366 / 38554 | 39002 / 39032 | -90 / +342 | +546 / +820 |
| 6 with 10 ms after each close | 38570 / 38610 | 38955 / 39013 | 39085 / 39076 | +385 / +403 | +515 / +466 |
| 7 first request waits, later ones | 20591 / 20597 | 20619 / 20619 | 20808 / 20799 | +28 / +22 | +217 / +202 |

Row 6 without the wait after each close has wide ranges (`main` 38207 to 38471 in one round).

## Single-threaded runtime

| Row | main | A | C | A over main | C over main |
|---|---|---|---|---|---|
| 1 | 19981 / 19981 | 19989 / 19989 | 20009 / 20008 | +8 / +8 | +28 / +27 |
| 2 | 23814 / 23808 | 23681 / 23686 | 23727 / 23724 | -133 / -122 | -87 / -84 |
| 3 | 11591 / 11591 | 11606 / 11606 | 11622 / 11622 | +15 / +15 | +31 / +31 |
| 4 | 16979 / 16984 | 17010 / 17010 | 17035 / 17034 | +31 / +26 | +56 / +50 |
| 5 | 31148 / 31152 | 31205 / 31200 | 31221 / 31234 | +57 / +48 | +73 / +82 |
| 6 | 34998 / 34929 | 35488 / 35236 | 35443 / 35578 | +490 / +307 | +445 / +649 |
| 6 with 10 ms after each close | 35051 / 35061 | 35516 / 35522 | 35556 / 35561 | +465 / +461 | +505 / +500 |
| 7 | 19981 / 19980 | 20012 / 20013 | 20195 / 20194 | +31 / +33 | +214 / +214 |

Control: on the series with the wait after each close the six-count medians are `main` 35060, A
35519 (+459) and C 35559 (+499); A's figure under the tag `evidence/deadline-timer` is +449.

## Where C's rows 6 and 7 go

By function: about 185 of row 7's 205 is tokio's time driver (`park_internal` +71,
`process_at_time` +39, `sub_timespec` +36, `Timespec::now` +16, the io driver's `turn` +13,
`clock_gettime` +10). The kept timer stays in the wheel between requests, so each park of the
worker works out a timeout. Row 6 carries the same, because the timer stays in the wheel until
the connection is dropped. A makes its timer at the first request to wait and first sets it at
the second, so row 7 as defined does not show this for A. With two waiting requests first (an
extra row, one round): multi-threaded `main` 20613, A 20805, C 20800; single-threaded 19981,
20199, 20195.

## Allocations and bytes

DHAT, blocks and requested bytes a request, three runs each, identical: rows 1, 2 and 7 are
16.000 / 13959, 14.000 / 12925 and 16.000 / 13959 for all three. Row 5: `main` 28.003 / 32983.7,
A 28.003 / 33111.7, C 28.003 / 32999.7. Row 6: `main` 26.001 / 31925.1, A 27.001 / 32165.1, C
27.001 / 32053.1. Neither form adds an allocation to a connection that never waits; a connection
that waits gets one (the 112-byte boxed `Sleep`).

Bytes an idle connection holds (DHAT live bytes at the peak, 600 less 100 idle connections over
500): before a wait `main` 20158.3, A 20286.3 (+128), C 20174.3 (+16), 10 blocks each; after a
wait `main` 20158.1, A 20398.1 (+240), C 20286.1 (+128), one more block for A and C.

Non-test code lines (not blank, not comment, not `cfg(test)`), by script: 139 added for A, 155
for C.

## Variants of C's keep policy (one round each, not committed; `variant-deadline.rs`)

1. d: the first deadline to wait uses its own timer and leaves the connection an unset boxed
   one, as A does. Every serve test passes. Row 7: 20613 and 20010 (+20, +29). Row 6 with the
   wait after each close: 38981 and 35507 (about +390 and +450). One block added to a connection
   that waits.
2. t: the first wait leaves a mark, the second makes the timer. Row 6 with the wait after each
   close: 38719 and 35217 (about +130 and +160); row 7: 20614 and 20008; no block added to a
   connection that waits once. It fails three of A's serve tests as written
   (`a_connections_timer_is_made_once_and_dropped_with_the_connection`,
   `a_served_request_waits_on_its_connections_timer`,
   `a_connection_draining_at_shutdown_makes_its_timer_as_before`), which assert that the first
   wait makes the connection's timer.

## A deadline polled under another runtime's `EnterGuard`

Measured with a scratch test (`scratch-test.rs`, `results/scratch.log`): a deadline polled by the
connection's own task while a layer holds another runtime's `EnterGuard` makes C's kept timer on
that runtime. It fires at its limit while that runtime lives (51.4 ms and 51.6 ms for 50 ms).
After that runtime shuts down, every later waiting request on the connection panics in the
timer's poll (inside the handler's catch, so it is answered 500) for the life of the connection.
A and B make the connection's timer in the connection's own poll and do not have this.

## Tests

On `05c9bf95f`: `cargo fmt --all --check` exit 0; `cargo clippy --workspace --all-features
--all-targets -- -D warnings` exit 0; `cargo test -p corten-run --all-features --lib` 1,048
passed, 0 failed, 30 ignored. Every test A added that goes through `serve` is byte-identical in
C, 11 tests and their helpers.
