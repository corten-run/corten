# The deadline's timer, part 2 (the gated run): cycles across placements, workload `after`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.** The gated part's scripts with the base as both sides: the "head" below is the base, and no cycle of the head was counted.

Run 1905f5a8-f637-4f85-b024-0f2e8ce0f7cb, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7405. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). The A/A is resolved at +1% in both readings; the change's margin for `after` is +1%, no floor; no reduction is declared or read.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-after | 3 of 3 | -0.84% | none | none | A/A: **not resolved (incomplete)** |
| change-after | 3 of 3 | -0.47% | none | | **no bound (incomplete): does not pass** |

## aa-after: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -0.84% | - | - | -4.11% to +2.66% | +0.86% | - | +3.39% | +10.22% | +9.05% |
| cycles user | -0.35% | - | - | -5.03% to +3.87% | +0.35% | - | +4.45% | +12.72% | +11.27% |
| cycles kernel | -1.24% | - | - | -3.09% to +1.71% | +1.27% | - | +2.42% | +8.12% | +7.20% |
| instructions user | -0.00% | - | - | -0.01% to +0.00% | +0.00% | - | +0.01% | +0.06% | +0.05% |
| L1 icache misses user | -1.93% | - | - | -3.66% to +3.14% | +2.23% | - | +3.53% | +5.63% | +4.99% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | base-p15120 | base-p12160 | 47632 | 44962 | -4.11% | -15.83% to +7.60% | +0.00% | -3.66% |
| 4 | 1 | base-p320 | base-p22848 | 41602 | 41248 | -0.84% | -1.68% to -0.01% | -0.01% | +3.14% |
| 5 | 3 | base-p25824 | base-p38336 | 40955 | 42016 | +2.66% | -1.66% to +6.98% | -0.00% | -1.93% |

## change-after: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -0.47% | - | - | -0.71% to +0.26% | +0.53% | - | +0.50% | +2.48% | +2.20% |
| cycles user | +1.02% | - | - | +0.34% to +2.00% | -1.01% | - | +0.84% | +1.88% | +1.67% |
| cycles kernel | -1.56% | - | - | -2.43% to -0.34% | +1.60% | - | +1.05% | +3.28% | +2.91% |
| instructions user | -0.01% | - | - | -0.02% to -0.01% | +0.01% | - | +0.01% | +0.03% | +0.02% |
| L1 icache misses user | +1.60% | - | - | -2.27% to +3.55% | -1.52% | - | +2.96% | +2.75% | +2.44% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 2 | 2 | base-p15120 | head-p15120 | 41712 | 41409 | -0.71% | -2.19% to +0.77% | -0.02% | +1.60% |
| 3 | 1 | base-p320 | head-p320 | 41656 | 41764 | +0.26% | -0.85% to +1.36% | -0.01% | -2.27% |
| 6 | 3 | base-p25824 | head-p25824 | 40530 | 40338 | -0.47% | -2.88% to +1.94% | -0.01% | +3.55% |

