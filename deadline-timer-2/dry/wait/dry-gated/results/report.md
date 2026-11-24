# The deadline's timer, part 2 (the gated run): cycles across placements, workload `wait`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run 27a0a374-416e-4231-ae37-4a8a8a080c37, kit cycles-deadline-2029, plan sha256 10aad555178ba057320dad8bfa972aaff2eac9f78008818a0be181c6fbb0655d; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7312. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

Placements that failed a check or their time limit on a first attempt and were run again: change-wait 3 (seq 2, again as seq 7). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). Margin +1%, no floor; no reduction is declared or read.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-wait | 3 of 3 | +2.77% | none | none | A/A: **not resolved (incomplete)** |
| change-wait | 3 of 3 | +2.81% | none | | **no bound (incomplete): does not pass** |

## aa-wait: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +2.77% | - | - | +1.97% to +5.75% | -2.68% | - | +1.99% | +6.27% | +5.55% |
| cycles user | +1.55% | - | - | +1.45% to +9.65% | -1.52% | - | +4.71% | +8.24% | +7.30% |
| cycles kernel | +2.51% | - | - | +2.07% to +3.97% | -2.13% | - | +1.00% | +6.06% | +5.37% |
| instructions user | -0.07% | - | - | -0.14% to -0.07% | +0.07% | - | +0.04% | +0.09% | +0.08% |
| L1 icache misses user | +0.76% | - | - | +0.19% to +2.21% | -0.61% | - | +1.04% | +3.26% | +2.89% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 47117 | 48416 | +2.77% | +1.55% to +3.98% | -0.14% | +2.21% |
| 4 | 1 | base-p320 | base-p22848 | 54422 | 57358 | +5.75% | -1.11% to +12.61% | -0.07% | +0.76% |
| 5 | 2 | base-p15120 | base-p12160 | 45164 | 46022 | +1.97% | -1.24% to +5.18% | -0.07% | +0.19% |

## change-wait: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +2.81% | - | - | -1.28% to +4.93% | -2.36% | - | +3.16% | +7.98% | +7.07% |
| cycles user | +2.61% | - | - | +0.84% to +6.94% | -2.22% | - | +3.14% | +9.20% | +8.16% |
| cycles kernel | +2.94% | - | - | -3.23% to +2.99% | -2.46% | - | +3.57% | +7.15% | +6.34% |
| instructions user | -0.52% | - | - | -0.54% to -0.51% | +0.52% | - | +0.02% | +0.51% | +0.45% |
| L1 icache misses user | +1.16% | - | - | +1.04% to +2.07% | -1.11% | - | +0.56% | +2.83% | +2.51% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 3 | 1 | base-p320 | head-p320 | 51555 | 53872 | +4.93% | -2.44% to +12.29% | -0.54% | +2.07% |
| 6 | 2 | base-p15120 | head-p15120 | 45733 | 45145 | -1.28% | -1.70% to -0.86% | -0.52% | +1.16% |
| 7 | 3 | base-p25824 | head-p25824 | 50567 | 51707 | +2.81% | -3.60% to +9.23% | -0.51% | +1.04% |

