# The deadline's timer, part 1 (the pilot): cycles across placements, workload `beside`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run c1ca23bf-d696-459d-ba3b-cb8f56cf78a9, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7406. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 240264 requests in their recorded turns. Placement medians: median +0.51%, standard deviation +0.61% (labels swapped +0.61%), from -0.34% to +0.85%; 2 above zero. Within a placement the pooled standard deviation of the per-pair changes is +0.10%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -3.5e-1, p 1.000 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho 0.500, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.537, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-beside: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.51% | - | - | -0.34% to +0.85% | -0.51% | - | +0.61% | +0.10% | +0.09% |
| cycles user | +2.00% | - | - | -0.44% to +2.23% | -1.96% | - | +1.48% | +1.18% | +1.05% |
| cycles kernel | -0.25% | - | - | -0.60% to -0.19% | +0.26% | - | +0.22% | +0.87% | +0.77% |
| instructions user | +0.00% | - | - | -0.00% to +0.01% | -0.00% | - | +0.00% | +0.01% | +0.00% |
| L1 icache misses user | +1.68% | - | - | -1.81% to +5.96% | -1.58% | - | +3.89% | +5.21% | +4.61% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 74942 | 74687 | -0.34% | -0.37% to -0.31% | +0.00% | +1.68% |
| 2 | 1 | base-p320 | base-p22848 | 75212 | 75853 | +0.85% | +0.80% to +0.90% | -0.00% | -1.81% |
| 3 | 2 | base-p15120 | base-p12160 | 75510 | 75895 | +0.51% | +0.40% to +0.63% | +0.01% | +5.96% |

