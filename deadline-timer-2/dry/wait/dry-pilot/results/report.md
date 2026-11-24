# The deadline's timer, part 1 (the pilot): cycles across placements, workload `wait`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run feacdaa5-515b-4bdd-a67c-5a21a554cf7a, kit cycles-deadline-2029, plan sha256 235bf66b63628ea163de742aa826dd00366d72d6d812a4df5f722835f2ee872d; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7302. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

Placements that failed a check or their time limit on a first attempt and were run again: pilot-wait 2 (seq 2, again as seq 4). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 272264 requests in their recorded turns. Placement medians: median -0.32%, standard deviation +6.21% (labels swapped +6.45%), from -7.81% to +4.51%; 1 above zero. Within a placement the pooled standard deviation of the per-pair changes is +4.29%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -4.2e-1, p 1.000 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho 0.500, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.764, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-wait: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -0.32% | - | - | -7.81% to +4.51% | +0.35% | - | +6.21% | +4.29% | +3.80% |
| cycles user | +1.69% | - | - | -6.05% to +6.53% | -1.65% | - | +6.35% | +5.66% | +5.02% |
| cycles kernel | -2.10% | - | - | -9.60% to +2.60% | +2.32% | - | +6.15% | +4.20% | +3.72% |
| instructions user | -0.14% | - | - | -0.20% to +0.03% | +0.14% | - | +0.12% | +0.43% | +0.38% |
| L1 icache misses user | -1.96% | - | - | -2.01% to +2.82% | +2.02% | - | +2.77% | +2.27% | +2.01% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 59488 | 54808 | -7.81% | -10.46% to -5.16% | +0.03% | -1.96% |
| 3 | 1 | base-p320 | base-p22848 | 50464 | 52612 | +4.51% | +0.33% to +8.69% | -0.20% | -2.01% |
| 4 | 2 | base-p15120 | base-p12160 | 46991 | 46834 | -0.32% | -2.07% to +1.43% | -0.14% | +2.82% |

