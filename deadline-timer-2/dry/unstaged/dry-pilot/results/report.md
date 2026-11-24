# The deadline's timer, part 1 (the pilot): cycles across placements, workload `unstaged`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run a421d8fa-3be5-44e1-a2c6-5e57ce9b7a93, kit cycles-deadline-2029, plan sha256 235bf66b63628ea163de742aa826dd00366d72d6d812a4df5f722835f2ee872d; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7304. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

Placements that failed a check or their time limit on a first attempt and were run again: pilot-unstaged 3 (seq 2, again as seq 4). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 1413916 requests in their recorded turns. Placement medians: median -0.39%, standard deviation +0.94% (labels swapped +0.94%), from -1.10% to +0.75%; 1 above zero. Within a placement the pooled standard deviation of the per-pair changes is +1.19%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -5.7e-1, p 0.660 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho -5.0e-1, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.745, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-unstaged: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -0.39% | - | - | -1.10% to +0.75% | +0.40% | - | +0.94% | +1.19% | +1.05% |
| cycles user | -2.63% | - | - | -3.49% to +1.36% | +2.70% | - | +2.59% | +1.26% | +1.11% |
| cycles kernel | +0.49% | - | - | -0.03% to +0.58% | -0.48% | - | +0.33% | +1.25% | +1.10% |
| instructions user | -0.00% | - | - | -0.00% to +0.00% | +0.00% | - | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | +0.07% | - | - | -1.79% to +5.77% | -0.07% | - | +3.94% | +3.52% | +3.12% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | base-p15120 | base-p12160 | 27968 | 27856 | -0.39% | -1.39% to +0.61% | -0.00% | +0.07% |
| 3 | 1 | base-p320 | base-p22848 | 28309 | 28519 | +0.75% | -0.17% to +1.68% | +0.00% | +5.77% |
| 4 | 3 | base-p25824 | base-p38336 | 28709 | 28390 | -1.10% | -1.62% to -0.59% | -0.00% | -1.79% |

