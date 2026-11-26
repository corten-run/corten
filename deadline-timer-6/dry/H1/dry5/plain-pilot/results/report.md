# The deadline's timer, part 1 (the pilot): cycles across placements, workload `plain`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run 1b4441a4-b7af-4f96-afe6-fbb6a2d40443, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7401. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 686346 requests in their recorded turns. Placement medians: median +0.82%, standard deviation +2.60% (labels swapped +2.90%), from -3.46% to +1.23%; 2 above zero. Within a placement the pooled standard deviation of the per-pair changes is +5.26%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -2.2e-1, p 1.000 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho 0.500, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.154, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-plain: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.82% | - | - | -3.46% to +1.23% | -0.80% | - | +2.60% | +5.26% | +4.66% |
| cycles user | +1.55% | - | - | -4.53% to +2.26% | -1.48% | - | +3.74% | +6.51% | +5.77% |
| cycles kernel | -0.39% | - | - | -2.34% to +0.99% | +0.40% | - | +1.67% | +4.11% | +3.64% |
| instructions user | +0.00% | - | - | -0.02% to +0.00% | -0.00% | - | +0.01% | +0.01% | +0.01% |
| L1 icache misses user | +0.90% | - | - | -0.03% to +1.99% | -0.87% | - | +1.01% | +2.40% | +2.13% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | base-p15120 | base-p12160 | 64268 | 61282 | -3.46% | -9.69% to +2.77% | -0.02% | -0.03% |
| 2 | 3 | base-p25824 | base-p38336 | 52300 | 52942 | +1.23% | +0.23% to +2.24% | +0.00% | +1.99% |
| 3 | 1 | base-p320 | base-p22848 | 53668 | 54096 | +0.82% | -0.45% to +2.08% | +0.00% | +0.90% |

