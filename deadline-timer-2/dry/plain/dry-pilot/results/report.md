# The deadline's timer, part 1 (the pilot): cycles across placements, workload `plain`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run fb770dbf-541a-43a3-8c90-a5116f074e25, kit cycles-deadline-2029, plan sha256 235bf66b63628ea163de742aa826dd00366d72d6d812a4df5f722835f2ee872d; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7301. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

Placements that failed a check or their time limit on a first attempt and were run again: pilot-plain 3 (seq 2, again as seq 4). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 683036 requests in their recorded turns. Placement medians: median +0.09%, standard deviation +15.23% (labels swapped +10.31%), from -0.05% to +26.41%; 2 above zero. Within a placement the pooled standard deviation of the per-pair changes is +19.87%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -6.7e-1, p 0.331 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho 0.500, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.009, Anderson-Darling p -; models kept: smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-plain: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.09% | - | - | -0.05% to +26.41% | -0.09% | - | +15.23% | +19.87% | +17.61% |
| cycles user | +0.75% | - | - | -0.21% to +36.47% | -0.74% | - | +20.91% | +27.19% | +24.09% |
| cycles kernel | +0.09% | - | - | -0.44% to +18.18% | -0.07% | - | +10.60% | +13.87% | +12.30% |
| instructions user | +0.01% | - | - | -0.01% to +0.04% | -0.01% | - | +0.03% | +0.04% | +0.03% |
| L1 icache misses user | +0.70% | - | - | -1.19% to +13.71% | -0.48% | - | +8.11% | +7.07% | +6.26% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 1 | base-p320 | base-p22848 | 54133 | 54104 | -0.05% | -1.63% to +1.54% | -0.01% | +0.70% |
| 3 | 2 | base-p15120 | base-p12160 | 52374 | 66488 | +26.41% | +2.13% to +50.69% | +0.04% | +13.71% |
| 4 | 3 | base-p25824 | base-p38336 | 54057 | 54106 | +0.09% | -0.11% to +0.30% | +0.01% | -1.19% |

