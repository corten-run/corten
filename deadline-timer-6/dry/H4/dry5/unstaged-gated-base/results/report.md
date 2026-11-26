# The deadline's timer, part 2 (the gated run): cycles across placements, workload `unstaged`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.** The gated part's scripts with the base as both sides: the "head" below is the base, and no cycle of the head was counted.

Run 7da11089-63cc-408b-b9d3-5235bcfefbca, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7404. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). The A/A is resolved at +1% in both readings; the change's margin for `unstaged` is +1%, no floor; no reduction is declared or read.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-unstaged | 3 of 3 | +0.98% | none | none | A/A: **not resolved (incomplete)** |
| change-unstaged | 3 of 3 | +0.55% | none | | **no bound (incomplete): does not pass** |

## aa-unstaged: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.98% | - | - | -0.61% to +1.95% | -0.97% | - | +1.29% | +1.51% | +1.34% |
| cycles user | +1.54% | - | - | -1.13% to +5.09% | -1.45% | - | +3.12% | +2.17% | +1.92% |
| cycles kernel | +0.59% | - | - | -1.53% to +1.94% | -0.57% | - | +1.75% | +1.40% | +1.24% |
| instructions user | +0.00% | - | - | +0.00% to +0.00% | -0.00% | - | +0.00% | +0.01% | +0.01% |
| L1 icache misses user | +2.18% | - | - | -8.24% to +4.52% | -2.00% | - | +6.79% | +3.16% | +2.80% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 1 | base-p320 | base-p22848 | 27851 | 28396 | +1.95% | +1.00% to +2.90% | +0.00% | +4.52% |
| 4 | 2 | base-p15120 | base-p12160 | 28665 | 28947 | +0.98% | +0.78% to +1.19% | +0.00% | +2.18% |
| 5 | 3 | base-p25824 | base-p38336 | 28821 | 28642 | -0.61% | -2.19% to +0.97% | +0.00% | -8.24% |

## change-unstaged: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.55% | - | - | -2.93% to +1.24% | -0.53% | - | +2.24% | +1.93% | +1.71% |
| cycles user | +0.61% | - | - | -3.19% to +3.77% | -0.57% | - | +3.49% | +3.00% | +2.66% |
| cycles kernel | +0.14% | - | - | -2.81% to +0.53% | -0.14% | - | +1.83% | +2.02% | +1.79% |
| instructions user | +0.00% | - | - | -0.00% to +0.00% | -0.00% | - | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | -2.34% | - | - | -4.27% to +1.09% | +2.41% | - | +2.72% | +5.02% | +4.45% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 2 | 1 | base-p320 | head-p320 | 28262 | 28414 | +0.55% | -1.03% to +2.14% | +0.00% | +1.09% |
| 3 | 2 | base-p15120 | head-p15120 | 29188 | 28334 | -2.93% | -4.61% to -1.25% | -0.00% | -4.27% |
| 6 | 3 | base-p25824 | head-p25824 | 28780 | 29140 | +1.24% | +0.72% to +1.77% | +0.00% | -2.34% |

