# What result would make me drop the change

Written before any build of the change was measured (2026-11-24, base `origin/main` be1192a7b).

The change: a request's deadline keeps one tokio timer for its connection and moves it later
(`Sleep::reset`), in place of making a timer for each request that waits and dropping it.

Drop the change (report it as not worth merging) if any of these holds:

1. `/sdelay/10` at 32,000 connections, default runtime: the change's median over the two passes
   is not at least 8% above base's (the investigation saw 17% lost and 97% of it recovered by the
   prototype; under half of that is not the effect this change is for), or its best run in either
   pass is below base's best in that pass.
2. `baseline` or `json-comp` (workloads whose handlers never wait): the change's median is more
   than 2% below base's in both passes (one pass alone is inside what two runs of one image have
   differed by on this harness, 1 to 2%, and up to 6% between passes).
3. The unstaged `async` profile (no deadline there): more than 2% below base in both passes.
4. p99 on `/sdelay/10` or `/spool` worse than base's in both passes by more than the spread
   between base's own runs.
5. Instructions a request (callgrind) for a staged GET that does not wait: more than 20 more than
   base (0.1% of a request of about 20,000 is the most I would defend for a request that gets
   nothing from this), or any more at all if a design with none measures the same on the waits.
6. Instructions a request for a staged GET that waits: not fewer than base.
7. A deadline behavior the guide documents cannot be held by a test on the new code (the 503 or
   408 or 413, when it fires, `Abort::Deadline`, a handler that finishes first, shutdown's wait),
   or either open question cannot be closed by construction and a test: a timer used on a runtime
   other than the one that made it, or timers that outlive their connection.

Between candidates (kept timer per connection, kept timers per thread, the clock's sweep): the
one whose behavior an app can observe is unchanged wins unless another is more than 3% faster on
`/sdelay/10` in both passes; among those, the one with no cost to a request that never waits wins
unless it needs something the task rules out (a new dependency, a raised minimum version, an
environment switch).
