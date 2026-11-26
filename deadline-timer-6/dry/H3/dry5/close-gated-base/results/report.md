# The deadline's timer, part 2 (the gated run): cycles across placements, workload `close`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.** The gated part's scripts with the base as both sides: the "head" below is the base, and no cycle of the head was counted.

Run bd637dc9-13fa-4d99-875d-2967d2d4b818, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7403. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). The A/A is resolved at +1% in both readings; the change's margin for `close` is +1%, no floor; no reduction is declared or read.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-close | 3 of 3 | +0.86% | none | none | A/A: **not resolved (incomplete)** |
| change-close | 3 of 3 | +0.35% | none | | **no bound (incomplete): does not pass** |

## aa-close: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.86% | - | - | -3.68% to +1.12% | -0.83% | - | +2.70% | +1.60% | +1.42% |
| cycles user | +0.24% | - | - | -3.69% to +1.88% | -0.22% | - | +2.86% | +1.56% | +1.38% |
| cycles kernel | +0.67% | - | - | -3.67% to +1.23% | -0.66% | - | +2.68% | +1.65% | +1.46% |
| instructions user | +0.00% | - | - | +0.00% to +0.07% | -0.00% | - | +0.04% | +0.33% | +0.29% |
| L1 icache misses user | -1.62% | - | - | -2.47% to +2.11% | +1.65% | - | +2.43% | +1.06% | +0.94% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2 | base-p15120 | base-p12160 | 89425 | 90427 | +1.12% | +0.87% to +1.38% | +0.00% | +2.11% |
| 4 | 3 | base-p25824 | base-p38336 | 89483 | 90250 | +0.86% | -0.55% to +2.26% | +0.00% | -1.62% |
| 5 | 1 | base-p320 | base-p22848 | 92676 | 89238 | -3.68% | -5.02% to -2.33% | +0.07% | -2.47% |

## change-close: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.35% | - | - | -8.71% to +4.54% | +1.43% | - | +6.78% | +21.79% | +19.31% |
| cycles user | +0.93% | - | - | -8.70% to +5.00% | +1.06% | - | +7.04% | +22.07% | +19.56% |
| cycles kernel | -0.00% | - | - | -8.72% to +4.26% | +1.66% | - | +6.62% | +21.62% | +19.16% |
| instructions user | -0.06% | - | - | -0.43% to +0.15% | +0.06% | - | +0.29% | +0.71% | +0.63% |
| L1 icache misses user | +2.06% | - | - | -2.46% to +2.47% | -1.18% | - | +2.74% | +8.53% | +7.56% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 2 | 2 | base-p15120 | head-p15120 | 108887 | 110955 | +4.54% | -20.40% to +29.49% | -0.43% | +2.06% |
| 3 | 3 | base-p25824 | head-p25824 | 102058 | 91991 | -8.71% | -18.19% to +0.76% | -0.06% | -2.46% |
| 6 | 1 | base-p320 | head-p320 | 90027 | 90336 | +0.35% | -0.20% to +0.90% | +0.15% | +2.47% |

