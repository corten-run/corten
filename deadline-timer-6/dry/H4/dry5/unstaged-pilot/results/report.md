# The deadline's timer, part 1 (the pilot): cycles across placements, workload `unstaged`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run 3bb48bc0-8d7c-4484-917e-ee778dfc3a7e, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7404. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 1407032 requests in their recorded turns. Placement medians: median +0.24%, standard deviation +3.20% (labels swapped +3.28%), from -4.00% to +2.26%; 2 above zero. Within a placement the pooled standard deviation of the per-pair changes is +2.83%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -3.7e-1, p 1.000 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho -5.0e-1, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.616, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-unstaged: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.24% | - | - | -4.00% to +2.26% | -0.19% | - | +3.20% | +2.83% | +2.51% |
| cycles user | +0.71% | - | - | -3.79% to +1.70% | -0.65% | - | +2.93% | +3.24% | +2.87% |
| cycles kernel | +0.03% | - | - | -4.10% to +2.51% | +0.01% | - | +3.34% | +2.78% | +2.46% |
| instructions user | -0.00% | - | - | -0.01% to +0.01% | +0.00% | - | +0.01% | +0.01% | +0.01% |
| L1 icache misses user | +0.66% | - | - | -0.99% to +1.88% | -0.54% | - | +1.44% | +5.80% | +5.14% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 1 | base-p320 | base-p22848 | 28457 | 28525 | +0.24% | -1.84% to +2.31% | -0.00% | +1.88% |
| 2 | 2 | base-p15120 | base-p12160 | 28094 | 28725 | +2.26% | +0.48% to +4.05% | +0.01% | +0.66% |
| 3 | 3 | base-p25824 | base-p38336 | 29214 | 28044 | -4.00% | -6.13% to -1.88% | -0.01% | -0.99% |

