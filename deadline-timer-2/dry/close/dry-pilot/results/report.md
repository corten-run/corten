# The deadline's timer, part 1 (the pilot): cycles across placements, workload `close`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run 2da4108c-618e-4dd9-a86f-059664ae4b9d, kit cycles-deadline-2029, plan sha256 235bf66b63628ea163de742aa826dd00366d72d6d812a4df5f722835f2ee872d; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7303. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

Placements that failed a check or their time limit on a first attempt and were run again: pilot-close 3 (seq 2, again as seq 4). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 208386 requests in their recorded turns. Placement medians: median +1.12%, standard deviation +3.43% (labels swapped +3.50%), from -3.63% to +3.04%; 2 above zero. Within a placement the pooled standard deviation of the per-pair changes is +3.40%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -6.1e-1, p 0.660 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho 0.500, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.540, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-close: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +1.12% | - | - | -3.63% to +3.04% | -1.11% | - | +3.43% | +3.40% | +3.02% |
| cycles user | +1.26% | - | - | -4.51% to +3.08% | -1.25% | - | +3.96% | +3.61% | +3.20% |
| cycles kernel | +1.04% | - | - | -3.10% to +3.02% | -1.03% | - | +3.12% | +3.27% | +2.90% |
| instructions user | +0.11% | - | - | +0.10% to +0.29% | -0.11% | - | +0.11% | +0.19% | +0.17% |
| L1 icache misses user | +0.39% | - | - | -3.18% to +3.05% | -0.39% | - | +3.12% | +1.55% | +1.37% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | base-p15120 | base-p12160 | 88355 | 89349 | +1.12% | +0.99% to +1.26% | +0.11% | +3.05% |
| 3 | 1 | base-p320 | base-p22848 | 94643 | 91099 | -3.63% | -6.69% to -0.57% | +0.10% | -3.18% |
| 4 | 3 | base-p25824 | base-p38336 | 88188 | 90878 | +3.04% | +0.21% to +5.87% | +0.29% | +0.39% |

