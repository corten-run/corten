# The deadline's timer, part 2 (the gated run): cycles across placements, workload `wait`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.** The gated part's scripts with the base as both sides: the "head" below is the base, and no cycle of the head was counted.

Run 189862e3-d7c9-49e5-a2f3-f628bbeadacf, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7402. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). The A/A is resolved at +1% in both readings; the change's margin for `wait` is +1%, no floor; no reduction is declared or read.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-wait | 3 of 3 | +2.19% | none | none | A/A: **not resolved (incomplete)** |
| change-wait | 3 of 3 | +0.23% | none | | **no bound (incomplete): does not pass** |

## aa-wait: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +2.19% | - | - | +0.24% to +7.81% | -1.56% | - | +3.93% | +8.35% | +7.40% |
| cycles user | +3.73% | - | - | -0.08% to +6.87% | -2.58% | - | +3.48% | +10.10% | +8.95% |
| cycles kernel | +0.75% | - | - | +0.55% to +8.71% | -0.52% | - | +4.66% | +7.00% | +6.20% |
| instructions user | +0.02% | - | - | -0.17% to +0.03% | -0.02% | - | +0.11% | +0.08% | +0.07% |
| L1 icache misses user | +0.07% | - | - | -0.70% to +2.19% | -0.06% | - | +1.50% | +1.73% | +1.53% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 1 | base-p320 | base-p22848 | 46008 | 49583 | +7.81% | +1.32% to +14.31% | -0.17% | +2.19% |
| 4 | 2 | base-p15120 | base-p12160 | 47277 | 47391 | +0.24% | -0.38% to +0.86% | +0.03% | -0.70% |
| 5 | 3 | base-p25824 | base-p38336 | 51128 | 51867 | +2.19% | -5.68% to +10.06% | +0.02% | +0.07% |

## change-wait: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.23% | - | - | -0.24% to +0.45% | -0.20% | - | +0.35% | +4.10% | +3.63% |
| cycles user | -0.00% | - | - | -0.38% to +1.00% | +0.00% | - | +0.71% | +1.89% | +1.68% |
| cycles kernel | -0.02% | - | - | -0.49% to +0.89% | +0.52% | - | +0.70% | +6.23% | +5.52% |
| instructions user | +0.00% | - | - | -0.02% to +0.22% | -0.00% | - | +0.13% | +0.27% | +0.24% |
| L1 icache misses user | +0.60% | - | - | +0.24% to +1.62% | -0.60% | - | +0.71% | +1.71% | +1.51% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 2 | 1 | base-p320 | head-p320 | 46921 | 47135 | +0.45% | -0.45% to +1.36% | +0.00% | +1.62% |
| 3 | 2 | base-p15120 | head-p15120 | 47180 | 47285 | +0.23% | -1.60% to +2.06% | +0.22% | +0.60% |
| 6 | 3 | base-p25824 | head-p25824 | 47004 | 46813 | -0.24% | -4.82% to +4.35% | -0.02% | +0.24% |

