# The deadline's timer, part 2 (the gated run): cycles across placements, workload `close`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run bdb0ee5a-5c98-4456-8498-02cf06caac20, kit cycles-deadline-2029, plan sha256 10aad555178ba057320dad8bfa972aaff2eac9f78008818a0be181c6fbb0655d; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7313. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

Placements that failed a check or their time limit on a first attempt and were run again: change-close 3 (seq 2, again as seq 7). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). Margin +1%, no floor; no reduction is declared or read.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-close | 3 of 3 | +17.42% | none | none | A/A: **not resolved (incomplete)** |
| change-close | 3 of 3 | +1.34% | none | | **no bound (incomplete): does not pass** |

## aa-close: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +17.42% | - | - | +3.30% to +25.45% | -12.81% | - | +11.21% | +15.82% | +14.02% |
| cycles user | +22.19% | - | - | +4.46% to +29.85% | -15.03% | - | +13.02% | +19.88% | +17.62% |
| cycles kernel | +14.69% | - | - | +2.61% to +22.89% | -11.34% | - | +10.20% | +13.60% | +12.05% |
| instructions user | +0.15% | - | - | -0.11% to +0.19% | -0.15% | - | +0.16% | +0.16% | +0.14% |
| L1 icache misses user | +5.59% | - | - | +0.24% to +9.78% | -4.74% | - | +4.78% | +6.61% | +5.86% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 93330 | 108897 | +17.42% | -0.50% to +35.35% | +0.15% | +5.59% |
| 4 | 1 | base-p320 | base-p22848 | 89608 | 112304 | +25.45% | +18.83% to +32.06% | +0.19% | +9.78% |
| 5 | 2 | base-p15120 | base-p12160 | 89544 | 92528 | +3.30% | +0.13% to +6.47% | -0.11% | +0.24% |

## change-close: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +1.34% | - | - | -0.42% to +1.81% | -1.32% | - | +1.17% | +1.03% | +0.91% |
| cycles user | +1.81% | - | - | -1.17% to +2.62% | -1.77% | - | +2.00% | +1.12% | +1.00% |
| cycles kernel | +1.07% | - | - | +0.04% to +1.33% | -1.05% | - | +0.68% | +1.10% | +0.98% |
| instructions user | +0.69% | - | - | +0.55% to +0.85% | -0.69% | - | +0.15% | +0.29% | +0.26% |
| L1 icache misses user | +1.46% | - | - | +0.47% to +2.67% | -1.43% | - | +1.10% | +1.83% | +1.62% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 3 | 1 | base-p320 | head-p320 | 89677 | 89301 | -0.42% | -1.52% to +0.69% | +0.55% | +0.47% |
| 6 | 2 | base-p15120 | head-p15120 | 87802 | 89388 | +1.81% | +1.70% to +1.91% | +0.69% | +2.67% |
| 7 | 3 | base-p25824 | head-p25824 | 87504 | 88675 | +1.34% | +0.74% to +1.94% | +0.85% | +1.46% |

