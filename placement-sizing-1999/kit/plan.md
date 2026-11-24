# Kit 1999: the plan, declared before any measurement (amended once, see Amendment 1)

corten-run/corten#1999 (a placement run's A/A at K = 30 failed to resolve on `old`, and nothing
tells a plan what K it needs) and #1996 (padded placements cost fewer cycles than the unpadded
build in 15 of 16 read so far). One quiet-host session on a fresh c-8 (Debian 13 x64, 8 dedicated
CPUs, root, nothing else run or logged into while it runs). `plan.env` holds the numbers below
and `commits.env` the commits; run.sh refuses to start without this file, copies all three into
the results, and stamps every placement with the sha256 of `plan.env` and `commits.env`.
report.mjs refuses results whose plan is not this one. Nothing here is a gate verdict on any
change; it measures the apparatus (design Choice 72, CONTRIBUTING Pull requests item 2).

## Amendment 1 (after review 1, 2026-11-24; still before any measurement)

The plan as first declared is kept as `history/plan-1.md` (sha256
b99413afcb288edad3df23465481f3f6c6e946d319592b984d228147a40946f4), with its `plan-1.env`
(7fe9dc66eccc2f15164ab34cfbd971e09b364e12e675204f94584dbe6f061d2a) and `commits-1.env`
(e8ba017b10633067f03ba9bdac4bb71e15790d862c1ad8772f2fb574a10c40b4). No turn has been run or counted
with either plan; the only run of either kit is the container dry run (stand-in counters). Every
rule below is fixed now, before any data. What changed:

1. **Host.** The c-8 is created from DigitalOcean's `debian-13-x64` image. setup.sh refuses any
   other system (`/etc/os-release` not ID `debian`, VERSION_ID `13`) before installing anything,
   so the review's P1 (Ubuntu has no `linux-perf`) cannot arise unnoticed.
2. **A's run order is random, so run order is time** (review P2-1). aa-old's 100 placements take
   the same 100 slots through the session, but placement i runs in the slot a Fisher-Yates shuffle
   of 1..100 gives it, drawing from mulberry32(SCHEDULE_SEED = 1996) (schedule.mjs; same-old, when
   run, takes the generator's next shuffle; C's rounds keep pad order, as C is read by pad).
   `results/schedule.txt` and every `placement.txt` record the order. The lag-1 autocorrelation and
   Spearman's correlation of the medians in run order then read the host over time, not the pads'
   period in i or the rule change at i = 30. Spearman now has a two-sided permutation p (20,000
   permutations, seed 1999) and a read: "the medians drift with time" at p < 0.05 (review P3-10).
3. **The 1.97% comparison is a test of chance only on the same CPU model** (review P2-2). run.sh
   writes `results/host-id.txt` (CPU model, microcode, kernel, `kernel.randomize_va_space`, OS
   release; host.txt adds the last two). report.mjs prints this run's CPU model beside the second
   run's (Intel Xeon Platinum 8280, `prior/0c0c599c/host.txt`). If they differ or either is
   unknown, the report says the chi-square interval and F test cannot separate chance from the
   CPU, and a different sd is read as "another host", not as "1.97% was chance".
4. **The common median of zero is tested** (review P2-3). The two-sided order-statistic interval
   of the 100 medians as recorded, from the 42nd to the 59th (across()'s lower and upper ranks,
   coverage 1 - 2 P(Bin(100, 1/2) >= 59) = 91.1%), with the count below zero and its sign test.
   Read: zero inside, the assumption is not rejected; zero outside, it is rejected (a list offset).
5. **The model that sizes a plan is fixed now** (review P2-4; model.mjs `chooseModel`, printed by
   report.mjs as "Sizing model"). The raw resample is never used (size.mjs gives why). The normal
   model and the smoothed resample both assume medians independent, alike over time and centred on
   zero, so neither is used, and the report says no model sizes a plan from this run, if lag-1 or
   Spearman in run order rejects (p < 0.05) or zero is outside item 4's interval. Otherwise the
   normal model is rejected if Shapiro-Wilk or Anderson-Darling rejects normality (p < 0.05), and of
   the models left the one needing the larger K for a 5% failure rate sizes the plan ("over 400"
   counts as largest).
6. **Two readings at no host time** (review P2-6), both declared now:
   1. Each unpadded build (base, x1, x2, head) against A's 200 padded placements: its cost a
      request (user+kernel cycles, the median of its 8 placements' unpadded-side medians) ranked
      among the 200 base-p<p_i> and base-p<q_i> costs of A, with p = (number of padded costs at
      or above it + 1) / 201, one-sided. Read: "dearer than the padded placements at large" at
      p < 0.05, else "among the padded placements"; head's code is not base's, so its rank mixes
      code with placement. Beside it, Spearman of the 200 padded costs with run order and its
      permutation p; at p < 0.05 the ranks are read as mixing the host's drift with placement.
      Read only when A and that comparison are complete.
   2. The 30 pad pairs shared with the second run (this plan's i = 1..30 are its 30 pairs; the kit
      holds its CSVs in `prior/0c0c599c/aa-old`): Spearman's rho between the two runs' 30
      placement medians (Pearson's r beside it) with a one-sided permutation p (rho > 0, 20,000
      permutations, seed 1999). Read at p < 0.05: the A/A spread carries a placement part that
      carries over between runs; otherwise no sign of it (noise, or a part another host or build
      does not keep). Printed with whether base's binary and the CPU model are the second run's.
      Read only when A is complete and the two runs' 30 lists agree (report.mjs checks).
7. **Every end of a run is marked** (review P2-5). Whatever stops run.sh (a refusal, missing
   binaries, the perf preflight, VERIFY-FAILED, CHECK-FAILED, a signal, an unexpected exit, or the
   end of the schedule), its last two lines in `run.out` and `progress.log` are
   `RUN-ENDED <outcome>: <what>` and `ALL-DONE`; setup.sh writes the same pair to `run.out` if
   it stops (`setup-failed at <step>`), and start.sh adds one if either is killed before it can.
   Outcomes after the schedule: `complete`, `incomplete` (naming the comparisons), `report-refused`
   and `report-crashed`.
8. **A crash of report.mjs is not "incomplete"** (review P3-1): report.mjs exits 3 on an error of
   its own, report.json carries the exit it gave, and run.sh reads anything but 0, 1 or 2 agreeing
   with report.json as `report-crashed`.
9. **Every placement is bounded** (review P3-2): stopped after PLACEMENT_TIMEOUT = 300 s (about
   three times the 101 s a placement took, almost all of it fixed-length turns; `timeout` signals the placement's whole process group,
   servers included) and counted failed; verify.sh's checks have the same bound; run-pair-old.sh's
   port probe and ready() give curl 2 s. Nothing a turn measures changed.
10. **One retry, recorded** (review P3-3). After the schedule, the first RETRY_MAX = 3 failed
    placements, in the order they failed, run once more, numbered on from the schedule (seq 133,
    134, 135), each listed in `results/retries.txt` with the seq it failed at, its failed attempt
    kept in `results/failed/`. A retried placement is read like any other, at its retry's seq (so
    run-order tests see when it ran). A placement that fails twice, or a fourth failure, leaves its
    comparison without a bound, as before.
11. **size.mjs reads only finished placements** (review P3-7): one whose placement.txt has
    `started` but no `ended` is left out and named.
12. **Provenance** (review P3-8): `results/kit-sha256.txt` holds the tar's sha256 (when it is at
    `/root/cycles-1996-1999.tar`), every script's and data file's, and one hash per source tree;
    `sh start.sh <sha256>` refuses a tar with another hash before unpacking.
13. **Wording** (review P3-9): X1 is the first parent of BASE's first parent, not BASE's first
    parent; X2 also differs from BASE in the CLI template's Dockerfile, which the probe does not
    build; and the plan was written before any measurement, not before any binary was built.
14. **apt** (review P3-11): setup.sh waits (up to 600 s) for a running `apt-daily` job and gives
    apt-get a 600 s dpkg lock timeout.
15. **check-report.mjs** covers C's interval endpoints, the paired t interval, an incomplete C
    printing no interval (review P3-5), and every rule above.

Left as they were: review P3-4 (x1 and x2's instruction read is printed when incomplete; the read
is about code, not placement, its 0.5% is declared, and the paired row already prints "none"),
P3-6 (kNeeded's fine scan can return "over 400" just past a coarse hit: conservative, and it does
not change any figure `size.mjs --reproduce` checks), and P3-12 (the dry run travels in the tar
because check-report needs it; the world-writable modes are harmless on a single-user droplet).

## Protocol (unchanged from the second placement run, kit 1983, tag evidence/0c0c599c)

Every turn on a fresh start of the build, server pinned to CPU 2, `wrk -t2 -c64` for 3 s on CPUs 4
and 5, driver and perf on CPU 7, jemalloc and the clock shim preloaded, the order turned every
pair, one unrecorded pair then the recorded ones, `cycles:u,cycles:k,instructions:u,
L1-icache-load-misses:u` at 100%. The workload is `old` (GET /picture.png given kept, the start's
clock moved on 10,005 s so its Age is past the table), every start's Age checked in 10005..10020
before and after its turn and its handler run once. Placement: each side compiled once with
rustc 1.100.0 and relinked with a never-called pad of p bytes first in `.text`
(`--symbol-ordering-file`), each placement checked by build.sh (every function moved by exactly
the pad, neighbours kept, pad at the start, a relink byte-identical, distinct sha256s) and by
verify.sh (answers as its side's unpadded binary).

## Parts

1. **A, the A/A at K = 100** (#1999 items 2 and 3). `aa-old`: base-p<p_i> against base-p<q_i>,
   i = 1..100, R = 8 recorded pairs each, run in a seeded random order (Amendment 1). The pads are pads.mjs's lists for K = 100; their first
   30 are the first two runs' lists. They meet the rule for an A/A's two lists at K = 100: 200
   distinct multiples of 16 from 320 to 40,624 bytes, all 16 ordered line-phase combinations,
   100 distinct q_i - p_i mod 4096, 25 in each quarter of a page (`node pads.mjs --check
   plan.env`).
2. **B, one pad list against itself** (#1999 item 3). `same-old`: base-p<p_i> against the same
   binary, i = 1..30, R = 8, every turn a fresh start. **Cut for time in this plan (K_B = 0)**,
   see Time; the kit keeps it (K_B = 30 restores it, about 51 minutes more) and check-report.mjs
   tests its reading.
3. **C, unpadded against padded on both sides** (#1996). Pads p_1..p_8 (320, 15120, 25824, 40624,
   10304, 21008, 35808, 5552), R_C = 8 recorded pairs after one unrecorded, every turn a fresh
   start:
   1. `unpadded-base`: base (cargo's binary) against base-p<p_i>;
   2. `unpadded-head`: head against head-p<p_i>;
   3. `unpadded-x1`, `unpadded-x2`: two more unpadded builds of nearby commits, each against the
      same base-p<p_i> as `unpadded-base`.
   The four are interleaved (schedule.mjs): round i runs placement i of all four back to back,
   order reversed every other round, the rounds spread through the session with A, so a drift of
   the host falls on all alike.

Placements in all: 100 (A) + 32 (C) = 132, in schedule.mjs's order (results/schedule.txt), and at
most 3 retries after them (Amendment 1).

## Commits

1. BASE `14126d2a8` and HEAD `8d02090bf`: the second placement run's base and change (#1983's
   buffer for an older Age), as that run built them.
2. X1 `92bc32678`: main, the first parent of BASE's first parent `a01dd5109` (which differs from X1
   only in CONTRIBUTING.md and docs/design.md). In `crates/` it differs from BASE only by #1980 (a
   kept answer's head held in fewer allocations), which is on `old`'s path: callgrind put a kept
   hit at 32 instructions in 17,875 fewer (-0.18%). Its path is therefore not identical to
   base's, only near it.
3. X2 `705d14045`: the first commit of #2002's branch (merged to main as `8ab63c008`), on main
   `6f1bbf055`, whose `crates/` are BASE's. In the code the probe builds it differs from BASE only
   in `api.rs` (a media type read byte by byte) and `compress.rs` (a `Cache-Control` line compared
   with the default before it is searched for `no-transform`); it also differs in
   `crates/corten-cli/template/Dockerfile` and in `examples/`, which the probe does not build. Its
   runtime script, `Cargo.lock` and `.cargo` are BASE's. Main's first-parent commits nearest BASE do not serve: X1's parent `a02c81e86`
   and older embed another runtime script, whose hash is in every answer's
   Content-Security-Policy, so verify.sh refuses them (the dry run showed it for `a02c81e86`);
   `6f1bbf055` and `e19c25b5b` (#1979) compile BASE's crates unchanged, so their binary would be
   BASE's and build.sh refuses a fourth unpadded sha256 that is not new; `8ab63c008` carries all
   of #2002, which changed cycles on other workloads by 1 to 4%.

Neither X1 nor X2 is byte-for-byte base's code, so report.mjs reads each as compiling `old`'s
path "nearly as base" only if its median user-instructions change a request against base's
padded builds is within INSTR_NEAR = 0.5% either way; otherwise its offset mixes code with
placement and is reported as such. Both are on `old`'s request path in a small way (X1 by #1980,
X2 by the Cache-Control comparison every answer passes through).

## Reading (report.mjs; all user+kernel cycles a request, B / A - 1 per pair, the median of a placement's pairs as its statistic)

1. A: the median of the 100 placement medians and its one-sided 95% order-statistic bound (the
   59th of 100), as recorded and with the labels swapped; the A/A resolves +1% only if both are
   under it. The medians' sd (and swapped), the normal model's failure rate at that sd (K = 30,
   60, 100) and the K it needs for 5%. A test of the model: Shapiro-Wilk W and Anderson-Darling
   A*2 on the 100 medians (normality rejected at p < 0.05), their lag-1 autocorrelation in run
   order with a permutation p (dependence at p < 0.05) and Spearman's correlation with run order
   with a permutation p (drift at p < 0.05), run order being time (Amendment 1, item 2); the
   common median of zero (item 4) and the sizing model (item 5); the CPU against the second run's
   (item 3); the 30 shared pad pairs (item 6.2). Whether the second run's 1.97% (30 medians) is inside the 95% chi-square interval for
   the sd from 100 medians, with the two-sided F test of the two variances. From within: what 8
   pairs alone give a median (leave-one-out residuals rescaled, size.mjs's figure), beside the
   normal formula.
2. B (when run): the same bounds, sd and from within; A's sd against B's (F test) and
   sqrt(A^2 - B^2), the pad lists' own part.
3. C: each comparison's median offset with its order-statistic interval (ranks 2 and 7 of 8,
   93% coverage) and how many of its 8 padded placements cost less than the unpadded build (sign
   test). Paired by pad: head's placement median less base's, and x1's and x2's less base's, each
   the median with its interval and the mean with a 90% t interval. Read: the change moves what a
   pad does if head-minus-base's interval excludes zero; an unpadded build sits above its padded
   ones if its offset's interval lies wholly below zero; the claim of #1996 holds across unpadded
   builds of base's code if it does so for base and for each of x1 and x2 that is near. Beside it,
   each unpadded build ranked among A's 200 padded placements (Amendment 1, item 6.1).
4. Anything incomplete gives no bound and says why; results that a failed, misconfigured or
   buggy run, or another kit, could leave are refused (report.mjs's header lists the checks;
   check-report.mjs tests them).

## Sizing tool (#1999 items 1 and 4)

`size.mjs` sizes a plan from a pilot A/A's medians: failure rate of the two-reading A/A and the K
for a target under the normal model and under resampling the pilot's centred medians (smoothed,
and as they are), and the "from within" figure. `node size.mjs --reproduce` repeats the issue's
figures from the saved medians in prior/ (analysis/size-reproduce.txt).

## Time (estimated, c-8)

From the second run's progress log on its c-8 (Xeon Platinum 8280): a placement of `old` with 8
recorded pairs after one took about 101 s; verifying 90 placements 31 s; a side's build 56 s; 90
relinks 46 s.

| part | placements | estimated |
| --- | ---: | ---: |
| A | 100 | 168 min |
| B | 30 | 51 min |
| C | 32 | 54 min |
| checks, verify (210 binaries), setup, 4 builds, 208 relinks | | about 13 min |
| retries (Amendment 1), at most 3 | 0 to 3 | 0 to 5 min |

With B the turns alone are about 273 minutes (4.5 h) and the session about 285 minutes (4.75 h),
over the 4.5 hours the session is held to, so **B is cut** (the first part the request allows to
go). Without B: about 222 minutes of turns and **about 235 minutes (3.9 h) in all**, so the extra
unpadded commits stay. With Amendment 1: about 240 minutes with all three retries used and each retry
taking the usual 101 s. Worse: three placements that each hang to the 300 s limit (330 s with
`timeout`'s 30 s before KILL) and whose retries hang too: 235 + 3 x (330 - 101) s + 3 x 330 s, about
263 minutes (4.4 h), still under 4.5 h. Each further placement that hangs (no retry left) adds
about 229 s, so the session passes 4.5 h only if two more hang beyond those six. A hang in verify
or the checks stops the run after 330 s at most, with its RUN-ENDED line. These are estimates from one earlier host, not measurements of this run;
the run's progress.log gives the real times.