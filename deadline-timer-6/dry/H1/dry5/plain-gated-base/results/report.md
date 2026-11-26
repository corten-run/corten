# The deadline's timer, part 2 (the gated run): cycles across placements, workload `plain`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.** The gated part's scripts with the base as both sides: the "head" below is the base, and no cycle of the head was counted.

Run 94b133df-a3a6-4666-aae5-8dc8d64b6655, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7401. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). The A/A is resolved at +1% in both readings; the change's margin for `plain` is +1%, no floor; no reduction is declared or read.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-plain | 3 of 3 | +0.02% | none | none | A/A: **not resolved (incomplete)** |
| change-plain | 3 of 3 | -0.06% | none | | **no bound (incomplete): does not pass** |

## aa-plain: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.02% | - | - | -1.03% to +0.26% | -0.00% | - | +0.68% | +1.52% | +1.34% |
| cycles user | -0.25% | - | - | -0.92% to +0.83% | +0.28% | - | +0.88% | +2.38% | +2.11% |
| cycles kernel | -0.21% | - | - | -1.12% to +0.24% | +0.21% | - | +0.70% | +0.84% | +0.75% |
| instructions user | -0.00% | - | - | -0.00% to +0.00% | +0.00% | - | +0.00% | +0.01% | +0.01% |
| L1 icache misses user | +1.08% | - | - | -3.48% to +3.45% | -1.06% | - | +3.52% | +1.10% | +0.97% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | base-p15120 | base-p12160 | 52396 | 52530 | +0.26% | -0.84% to +1.35% | -0.00% | +3.45% |
| 4 | 3 | base-p25824 | base-p38336 | 53022 | 52473 | -1.03% | -1.97% to -0.09% | +0.00% | -3.48% |
| 5 | 1 | base-p320 | base-p22848 | 53691 | 53694 | +0.02% | -1.16% to +1.19% | -0.00% | +1.08% |

## change-plain: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -0.06% | - | - | -0.75% to +2.21% | +0.06% | - | +1.55% | +1.35% | +1.20% |
| cycles user | +0.23% | - | - | -0.26% to +3.24% | -0.22% | - | +1.89% | +2.42% | +2.14% |
| cycles kernel | -0.29% | - | - | -1.13% to +1.37% | +0.29% | - | +1.27% | +0.82% | +0.73% |
| instructions user | +0.00% | - | - | -0.01% to +0.01% | -0.00% | - | +0.01% | +0.00% | +0.00% |
| L1 icache misses user | +1.38% | - | - | +0.53% to +2.64% | -1.28% | - | +1.06% | +3.04% | +2.70% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 2 | 2 | base-p15120 | head-p15120 | 52853 | 52824 | -0.06% | -0.41% to +0.29% | +0.00% | +1.38% |
| 3 | 3 | base-p25824 | head-p25824 | 52990 | 52588 | -0.75% | -2.23% to +0.74% | -0.01% | +0.53% |
| 6 | 1 | base-p320 | head-p320 | 52538 | 53700 | +2.21% | +1.57% to +2.86% | +0.01% | +2.64% |

