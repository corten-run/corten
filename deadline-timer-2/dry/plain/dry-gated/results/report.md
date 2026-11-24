# The deadline's timer, part 2 (the gated run): cycles across placements, workload `plain`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run 3612218b-804f-40e2-8025-9369fc727498, kit cycles-deadline-2029, plan sha256 10aad555178ba057320dad8bfa972aaff2eac9f78008818a0be181c6fbb0655d; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7311. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

Placements that failed a check or their time limit on a first attempt and were run again: change-plain 2 (seq 2, again as seq 7). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). Margin +1%, no floor; no reduction is declared or read.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-plain | 3 of 3 | -0.26% | none | none | A/A: **not resolved (incomplete)** |
| change-plain | 3 of 3 | +4.69% | none | | **no bound (incomplete): does not pass** |

## aa-plain: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -0.26% | - | - | -5.51% to +1.62% | +0.26% | - | +3.69% | +6.35% | +5.63% |
| cycles user | +1.19% | - | - | -6.84% to +1.41% | -1.17% | - | +4.70% | +7.95% | +7.04% |
| cycles kernel | -1.44% | - | - | -4.32% to +1.80% | +1.46% | - | +3.06% | +4.97% | +4.41% |
| instructions user | -0.00% | - | - | -0.00% to -0.00% | +0.00% | - | +0.00% | +0.01% | +0.01% |
| L1 icache misses user | -0.36% | - | - | -0.44% to +0.67% | +0.40% | - | +0.62% | +8.52% | +7.55% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | base-p15120 | base-p12160 | 55996 | 52561 | -5.51% | -13.28% to +2.27% | -0.00% | -0.44% |
| 4 | 3 | base-p25824 | base-p38336 | 53575 | 53435 | -0.26% | -0.44% to -0.08% | -0.00% | +0.67% |
| 5 | 1 | base-p320 | base-p22848 | 52977 | 53836 | +1.62% | +1.45% to +1.80% | -0.00% | -0.36% |

## change-plain: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +4.69% | - | - | +1.17% to +15.16% | -4.42% | - | +7.28% | +12.32% | +10.92% |
| cycles user | +4.52% | - | - | +1.03% to +21.30% | -4.25% | - | +10.83% | +17.26% | +15.30% |
| cycles kernel | +4.83% | - | - | +1.28% to +10.29% | -4.56% | - | +4.54% | +8.41% | +7.45% |
| instructions user | +0.07% | - | - | +0.06% to +0.08% | -0.07% | - | +0.01% | +0.02% | +0.02% |
| L1 icache misses user | +3.97% | - | - | +1.16% to +6.24% | -3.80% | - | +2.54% | +4.31% | +3.82% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 3 | 3 | base-p25824 | head-p25824 | 53370 | 53992 | +1.17% | +1.06% to +1.28% | +0.06% | +1.16% |
| 6 | 1 | base-p320 | head-p320 | 52724 | 55186 | +4.69% | +2.04% to +7.34% | +0.07% | +3.97% |
| 7 | 2 | base-p15120 | head-p15120 | 53410 | 61525 | +15.16% | +0.31% to +30.01% | +0.08% | +6.24% |

