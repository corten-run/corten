# The deadline's timer, part 2 (the gated run): cycles across placements, workload `besidemt`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.** The gated part's scripts with the base as both sides: the "head" below is the base, and no cycle of the head was counted.

Run 3a25ca48-a012-4e7c-856b-9b3a02524a25, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7407. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). The A/A is resolved at +1% in both readings; the change's margin for `besidemt` is +5%, no floor; no reduction is declared or read.

The state in the counted turns: the head ran 0.9 more user instructions a request than the base at the median across the change's placements (the A/A's two base placements: 1.8). A set timer is declared to show as at least 95: **not shown**, so a change within its margin is not read as declared, which does not pass. The floor turns no miss into anything else.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-besidemt | 3 of 3 | +0.87% | none | none | A/A: **not resolved (incomplete)** |
| change-besidemt | 3 of 3 | +1.09% | none | | **no bound (incomplete): does not pass** |

## aa-besidemt: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.87% | - | - | -0.27% to +8.95% | -0.86% | - | +5.02% | +6.41% | +5.68% |
| cycles user | +1.93% | - | - | +0.34% to +14.27% | -1.87% | - | +7.63% | +11.12% | +9.85% |
| cycles kernel | +0.05% | - | - | -0.75% to +4.60% | -0.05% | - | +2.88% | +2.61% | +2.31% |
| instructions user | +0.00% | - | - | -0.00% to +0.01% | -0.00% | - | +0.01% | +0.01% | +0.01% |
| L1 icache misses user | +1.47% | - | - | -1.21% to +2.89% | -1.45% | - | +2.08% | +2.24% | +1.99% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 1 | base-p320 | base-p22848 | 74896 | 81569 | +8.95% | +1.14% to +16.76% | +0.00% | -1.21% |
| 4 | 2 | base-p15120 | base-p12160 | 73237 | 73875 | +0.87% | +0.13% to +1.62% | +0.01% | +2.89% |
| 5 | 3 | base-p25824 | base-p38336 | 73846 | 73650 | -0.27% | -0.61% to +0.08% | -0.00% | +1.47% |

## change-besidemt: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +1.09% | - | - | -0.14% to +2.58% | -1.08% | - | +1.36% | +0.54% | +0.48% |
| cycles user | +1.73% | - | - | -0.94% to +3.22% | -1.67% | - | +2.11% | +1.43% | +1.27% |
| cycles kernel | +0.60% | - | - | +0.50% to +2.07% | -0.59% | - | +0.88% | +0.80% | +0.71% |
| instructions user | +0.00% | - | - | -0.00% to +0.00% | -0.00% | - | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | +1.68% | - | - | +1.40% to +5.06% | -1.65% | - | +2.04% | +1.26% | +1.12% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 2 | 1 | base-p320 | head-p320 | 72786 | 72679 | -0.14% | -0.71% to +0.43% | +0.00% | +1.68% |
| 3 | 2 | base-p15120 | head-p15120 | 72184 | 74047 | +2.58% | +2.48% to +2.68% | -0.00% | +5.06% |
| 6 | 3 | base-p25824 | head-p25824 | 73200 | 73998 | +1.09% | +0.77% to +1.41% | +0.00% | +1.40% |

