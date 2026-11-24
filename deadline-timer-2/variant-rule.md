# Which form of the kept deadline timer ships

Written 2026-11-24 before the slot variant (C) exists or is counted. The counts of A and B on the
rows below, except row 7, are already known (A: +449 on row 6, B: +154), so between A and B this
rule's result is known in advance: B is preferred to A unless row 7 or the tests say otherwise.
It replaces the earlier rule (ship B only if it brought row 6 under 100 instructions), which the
second review questioned: the line was arbitrary, B missed it by 55, and A's +1.3% instructions on
row 6 stands against a +1% margin in cycles on the plan's `close` workload.

Candidates
- A: as built at `098f56243` (`Keeps` wrapper, thread-locals, numbered connections).
- B: A with the timer kept only from a connection's second waiting request (two-stage).
- C: no wrapper and no thread-locals: a slot in per-connection state the request already reaches,
  holding the timer between requests.

Rows (instructions a request under callgrind, median of three counts, two rounds, multi-threaded
runtime unless said, against `main` at the branch's base)
1. staged GET, no wait
2. staged GET, handler sleeps 1 ms, kept-alive (from the third request on)
3. unstaged GET, no wait
4. unstaged GET, handler sleeps 1 ms
5. a connection for each request, no wait
6. a connection for each request, handler sleeps 1 ms
7. kept-alive connection whose first request waits and whose later requests do not: the later
   requests (the second review's medium finding)
Also: allocations a request and a connection on rows 1, 2, 5, 6, 7, and bytes an idle connection
holds before and after a wait.

Rule
1. A candidate is out if any test of the branch's `tests::server` that goes through `serve` fails
   on it, if it needs `unsafe`, or if it raises the crate's minimum tokio.
2. Gain: a candidate must be within 100 instructions of the best candidate on row 2.
3. Cost: among those, take the one whose worst row among 1, 3, 4, 5, 6, 7 is least over `main`.
4. Candidates within 50 instructions of each other on that worst row are tied; a tie goes to the
   one that adds an allocation to no connection that never waits, then to the fewest lines of
   non-test code.
5. The chosen form's rows 6 and 7 go into the cycle plan as touched workloads under +1% if they
   are over `main` by more than 50 instructions, with a pilot of their own where none exists.
