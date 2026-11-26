# The deadline's timer, part 1 (the pilot): cycles across placements, workload `after`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run 0e73a69f-1cef-4f32-a5bc-161e35fc258f, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7405. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 891375 requests in their recorded turns. Placement medians: median -1.39%, standard deviation +2.04% (labels swapped +2.35%), from -4.79% to -1.13%; 0 above zero. Within a placement the pooled standard deviation of the per-pair changes is +4.44%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -1.3e-1, p 0.660 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho 1.000, p 0.331 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.121, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-after: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -1.39% | - | - | -4.79% to -1.13% | +1.43% | - | +2.04% | +4.44% | +3.94% |
| cycles user | -1.08% | - | - | -6.24% to -0.89% | +1.09% | - | +3.04% | +5.09% | +4.51% |
| cycles kernel | -1.62% | - | - | -3.57% to -1.33% | +1.72% | - | +1.22% | +4.18% | +3.70% |
| instructions user | -0.01% | - | - | -0.02% to -0.00% | +0.01% | - | +0.01% | +0.02% | +0.02% |
| L1 icache misses user | -1.24% | - | - | -3.89% to +1.88% | +1.26% | - | +2.89% | +2.65% | +2.34% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | base-p15120 | base-p12160 | 43494 | 41304 | -4.79% | -10.04% to +0.46% | -0.02% | -1.24% |
| 2 | 1 | base-p320 | base-p22848 | 42183 | 41587 | -1.39% | -2.79% to +0.01% | -0.01% | +1.88% |
| 3 | 3 | base-p25824 | base-p38336 | 41745 | 41274 | -1.13% | -1.45% to -0.81% | -0.00% | -3.89% |

