# The deadline's timer, part 1 (the pilot): cycles across placements, workload `besidemt`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run d8eba523-a6c3-42bf-b827-b8ac51bdebea, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7407. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 259152 requests in their recorded turns. Placement medians: median -1.38%, standard deviation +1.11% (labels swapped +1.12%), from -1.49% to +0.49%; 1 above zero. Within a placement the pooled standard deviation of the per-pair changes is +1.17%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -6.7e-1, p 0.331 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho 0.500, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.087, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-besidemt: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -1.38% | - | - | -1.49% to +0.49% | +1.42% | - | +1.11% | +1.17% | +1.04% |
| cycles user | -2.15% | - | - | -2.94% to +0.12% | +2.20% | - | +1.59% | +1.28% | +1.13% |
| cycles kernel | -0.31% | - | - | -0.76% to +0.79% | +0.31% | - | +0.80% | +1.71% | +1.51% |
| instructions user | +0.00% | - | - | -0.00% to +0.00% | -0.00% | - | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | -0.52% | - | - | -3.41% to +2.18% | +0.58% | - | +2.80% | +3.08% | +2.73% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 1 | base-p320 | base-p22848 | 72892 | 71809 | -1.49% | -1.60% to -1.37% | -0.00% | -0.52% |
| 2 | 2 | base-p15120 | base-p12160 | 73294 | 73643 | +0.49% | -0.38% to +1.35% | +0.00% | -3.41% |
| 3 | 3 | base-p25824 | base-p38336 | 73682 | 72659 | -1.38% | -2.53% to -0.24% | +0.00% | +2.18% |

