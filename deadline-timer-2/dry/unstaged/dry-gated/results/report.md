# The deadline's timer, part 2 (the gated run): cycles across placements, workload `unstaged`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run e524b9e1-5a0a-4e7b-9d0a-263b14bf5e86, kit cycles-deadline-2029, plan sha256 10aad555178ba057320dad8bfa972aaff2eac9f78008818a0be181c6fbb0655d; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7314. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

Placements that failed a check or their time limit on a first attempt and were run again: change-unstaged 2 (seq 2, again as seq 7). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). Margin +1%, no floor; no reduction is declared or read.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-unstaged | 3 of 3 | +3.09% | none | none | A/A: **not resolved (incomplete)** |
| change-unstaged | 3 of 3 | +1.50% | none | | **no bound (incomplete): does not pass** |

## aa-unstaged: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +3.09% | - | - | +0.03% to +3.32% | -2.94% | - | +1.83% | +2.49% | +2.21% |
| cycles user | +1.89% | - | - | -0.28% to +5.22% | -1.83% | - | +2.77% | +2.62% | +2.32% |
| cycles kernel | +2.15% | - | - | +0.17% to +3.98% | -2.05% | - | +1.91% | +2.96% | +2.63% |
| instructions user | +0.00% | - | - | +0.00% to +0.00% | -0.00% | - | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | +1.18% | - | - | -2.97% to +2.47% | -1.09% | - | +2.84% | +3.35% | +2.97% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | base-p15120 | base-p12160 | 27996 | 27998 | +0.03% | -1.65% to +1.72% | +0.00% | +1.18% |
| 4 | 3 | base-p25824 | base-p38336 | 27971 | 28829 | +3.09% | +0.74% to +5.43% | +0.00% | +2.47% |
| 5 | 1 | base-p320 | base-p22848 | 27529 | 28442 | +3.32% | +2.35% to +4.29% | +0.00% | -2.97% |

## change-unstaged: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +1.50% | - | - | +0.82% to +1.93% | -1.41% | - | +0.56% | +2.52% | +2.23% |
| cycles user | +2.66% | - | - | +2.24% to +4.48% | -2.57% | - | +1.19% | +5.80% | +5.14% |
| cycles kernel | +0.26% | - | - | +0.21% to +1.62% | -0.24% | - | +0.80% | +1.48% | +1.31% |
| instructions user | +0.29% | - | - | +0.29% to +0.29% | -0.29% | - | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | -0.08% | - | - | -0.75% to +3.44% | +0.08% | - | +2.25% | +2.54% | +2.25% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 3 | 3 | base-p25824 | head-p25824 | 28292 | 28837 | +1.93% | +0.78% to +3.09% | +0.29% | -0.08% |
| 6 | 1 | base-p320 | head-p320 | 27853 | 28083 | +0.82% | -0.24% to +1.88% | +0.29% | -0.75% |
| 7 | 2 | base-p15120 | head-p15120 | 27932 | 28337 | +1.50% | -1.15% to +4.15% | +0.29% | +3.44% |

