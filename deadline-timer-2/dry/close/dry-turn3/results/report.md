# The deadline's timer, part 1 (the pilot): cycles across placements, workload `close`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run d4c268e7-6506-4d79-9a16-a197c8e6af17, kit cycles-deadline-2029, plan sha256 235bf66b63628ea163de742aa826dd00366d72d6d812a4df5f722835f2ee872d; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 8 recorded pairs in each after one unrecorded pair, 3 s turns, every turn on a fresh start, order from seed 7303. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

Placements that failed a check or their time limit on a first attempt and were run again: none. Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 2494102 requests in their recorded turns. Placement medians: median +0.89%, standard deviation +0.71% (labels swapped +0.70%), from -0.20% to +1.13%; 2 above zero. Within a placement the pooled standard deviation of the per-pair changes is +9.15%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 8 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -2.7e-1, p 1.000 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho -5.0e-1, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.323, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-close: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.89% | - | - | -0.20% to +1.13% | -0.88% | - | +0.71% | +9.15% | +4.06% |
| cycles user | +1.33% | - | - | +0.14% to +1.44% | -1.31% | - | +0.72% | +10.88% | +4.82% |
| cycles kernel | +1.05% | - | - | +0.09% to +1.07% | -1.03% | - | +0.56% | +8.22% | +3.64% |
| instructions user | +0.02% | - | - | -0.22% to +0.04% | -0.02% | - | +0.14% | +0.42% | +0.19% |
| L1 icache misses user | +0.50% | - | - | -0.91% to +2.65% | -0.50% | - | +1.79% | +3.02% | +1.34% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | base-p15120 | base-p12160 | 88390 | 89264 | +0.89% | -1.28% to +27.93% | +0.02% | +2.65% |
| 2 | 3 | base-p25824 | base-p38336 | 88130 | 89061 | +1.13% | -2.83% to +9.29% | +0.04% | +0.50% |
| 3 | 1 | base-p320 | base-p22848 | 89350 | 89509 | -0.20% | -5.42% to +29.95% | -0.22% | -0.91% |

