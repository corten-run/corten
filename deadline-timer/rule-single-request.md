# The rule for the connection that serves one waiting request

Written 2026-11-24, after the review of `4c6cdf4ad` and before any of the counts below.

The review's first finding: a connection whose only request waits makes a timer no later request
uses. The earlier counts gave 350 to 800 instructions for it, with a range on the base as wide.

What is counted: instructions under callgrind for a connection for each request whose handler
sleeps 1 ms (`GET /sdelay/1`, the difference of 1,240 and 240 requests over 1,000), and the same
request on one kept-alive connection, for three builds of the benchmark app:

1. `main`: the merged base.
2. `built`: the change with the review's fixes.
3. `two`: `built` with the timer made only once a second request of the connection has waited.

A figure is the median of three counts.

The rule: ship `two` if `built` costs the connection for each request 100 instructions or more over
`main` and `two` brings that under 100, while `two`'s kept-alive waiting request stays within 100
instructions of `built`'s (the count leaves out a connection's first 240 requests, so it is of the
third request on). Otherwise ship `built`.

Where it is read: on one single-threaded runtime (the app's `percore-by-hand` mode held to one
CPU), where the kept-alive counts so far have ranges of a few instructions. The multi-threaded
runtime is counted beside it and reported, not decided on: its base range for this request was
about 700 instructions. If the three counts' ranges on the single-threaded runtime still overlap
across a 100-instruction line, the same number of further counts is taken for every build before
the rule is read, and the report says so.

## Further counts

Written after the first series on the single-threaded runtime and before the second.

The first series, a connection for each request, `GET /sdelay/1`, two rounds of three counts:
`main` 34,993 (34,956 to 35,073) and 35,003 (34,862 to 35,120); `built` 35,394 (35,319 to 35,497)
and 35,474 (35,413 to 35,485); `two` 35,118 (34,890 to 35,123) and 35,144 (35,113 to 35,193).
`built` is over the line by any reading (401 and 471 by medians). `two` is 125 and 141 over by
medians, and its counts less `main`'s reach from under 100 to over it, so the line is not told.

The second series, which the rule is read on: the same request and builds, with the client waiting
10 ms after it closes each connection before it opens the next (`count4.py --settle-ms 10`), so
the server has finished with one connection before it takes the next and the counts vary less;
two rounds of three counts a build, the second in the reverse order; a build's figure is the median
of its six counts. `two` is under the line if its figure less `main`'s is under 100. If the six
counts' ranges still do not tell, the report says that the line is not told and the rule's
"otherwise" applies: ship `built`.

## Read

The second series, six counts a build: `main` 35,045 to 35,061, median 35,058; `built` 35,499 to
35,515, median 35,507, 449 over; `two` 35,205 to 35,227, median 35,212, 154 over. The ranges do not
overlap and none reaches a line.

1. `built` costs the connection for each request 100 instructions or more over `main`: yes, 449.
2. `two` brings that under 100: no, 154. The wrapper every connection is polled through is 33 to
   57 of them (the same series' request that does not wait, first series: `main` 31,148 and
   31,166, `built` 31,205 and 31,199, `two` 31,196 and 31,205).
3. `two`'s kept-alive waiting request within 100 of `built`'s: yes (23,684 and 23,731 against
   23,705 and 23,705 on the single-threaded runtime; 24,932 and 24,928 against 24,925 and 24,936 on
   the multi-threaded one).

The second condition fails, so the rule's "otherwise" applies: `built` ships. `two` takes about two
thirds of the cost away and misses the rule's line by 54 instructions; that is reported, not acted
on.


