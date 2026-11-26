# The deadline's timer, part 1 (the pilot): cycles across placements, workload `wait`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run 6707dc06-6055-4439-8f41-31a1fa1d85ff, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7402. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 272211 requests in their recorded turns. Placement medians: median +3.66%, standard deviation +17.63% (labels swapped +13.69%), from -2.79% to +30.46%; 2 above zero. Within a placement the pooled standard deviation of the per-pair changes is +5.57%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -6.4e-1, p 0.331 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho 0.500, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.352, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-wait: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +3.66% | - | - | -2.79% to +30.46% | -3.53% | - | +17.63% | +5.57% | +4.94% |
| cycles user | +1.11% | - | - | -3.96% to +32.38% | -1.08% | - | +19.68% | +4.66% | +4.13% |
| cycles kernel | +6.14% | - | - | -1.62% to +28.51% | -5.76% | - | +15.65% | +6.83% | +6.05% |
| instructions user | -0.16% | - | - | -0.18% to -0.02% | +0.16% | - | +0.09% | +0.14% | +0.13% |
| L1 icache misses user | +0.63% | - | - | -0.03% to +3.72% | -0.62% | - | +2.00% | +1.06% | +0.94% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 1 | base-p320 | base-p22848 | 49512 | 47935 | -2.79% | -7.21% to +1.63% | -0.02% | +0.63% |
| 2 | 2 | base-p15120 | base-p12160 | 46368 | 60512 | +30.46% | +25.27% to +35.64% | -0.18% | +3.72% |
| 3 | 3 | base-p25824 | base-p38336 | 45646 | 47317 | +3.66% | +3.37% to +3.96% | -0.16% | -0.03% |

