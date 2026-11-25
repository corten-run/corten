# The deadline's timer, part 2 (the gated run): cycles across placements, workload `beside`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.** The gated part's scripts with the base as both sides: the "head" below is the base, and no cycle of the head was counted.

Run 8de0e6c7-d896-45db-b925-ddebf8a45131, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7406. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). The A/A is resolved at +1% in both readings; the change's margin for `beside` is +5%, no floor; no reduction is declared or read.

The state in the counted turns: the head ran -0.3 more user instructions a request than the base at the median across the change's placements (the A/A's two base placements: -0.2). A set timer is declared to show as at least 95: **not shown**, so a change within its margin is not read as declared, which does not pass. The floor turns no miss into anything else.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-beside | 3 of 3 | +0.66% | none | none | A/A: **not resolved (incomplete)** |
| change-beside | 3 of 3 | +2.96% | none | | **no bound (incomplete): does not pass** |

## aa-beside: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.66% | - | - | +0.31% to +4.51% | -0.50% | - | +2.33% | +3.67% | +3.25% |
| cycles user | +0.28% | - | - | +0.22% to +7.09% | -0.09% | - | +3.95% | +6.56% | +5.81% |
| cycles kernel | +0.93% | - | - | +0.39% to +2.75% | -0.89% | - | +1.24% | +1.75% | +1.55% |
| instructions user | -0.00% | - | - | -0.00% to +0.01% | +0.00% | - | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | -0.40% | - | - | -2.39% to -0.16% | +0.40% | - | +1.22% | +1.54% | +1.36% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 80343 | 83960 | +4.51% | +4.36% to +4.65% | -0.00% | -2.39% |
| 4 | 1 | base-p320 | base-p22848 | 79102 | 79604 | +0.66% | -3.33% to +4.64% | +0.01% | -0.16% |
| 5 | 2 | base-p15120 | base-p12160 | 77718 | 77946 | +0.31% | -1.77% to +2.39% | -0.00% | -0.40% |

## change-beside: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +2.96% | - | - | +0.76% to +6.07% | -2.86% | - | +2.67% | +5.50% | +4.87% |
| cycles user | +2.93% | - | - | +1.11% to +8.69% | -2.80% | - | +3.96% | +7.01% | +6.21% |
| cycles kernel | +2.99% | - | - | +0.53% to +4.34% | -2.90% | - | +1.93% | +4.51% | +4.00% |
| instructions user | -0.00% | - | - | -0.00% to +0.00% | +0.00% | - | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | -3.27% | - | - | -3.39% to -3.25% | +3.53% | - | +0.08% | +3.90% | +3.46% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 2 | 3 | base-p25824 | head-p25824 | 77188 | 81931 | +6.07% | -0.51% to +12.66% | -0.00% | -3.27% |
| 3 | 1 | base-p320 | head-p320 | 77136 | 77722 | +0.76% | +0.02% to +1.50% | +0.00% | -3.39% |
| 6 | 2 | base-p15120 | head-p15120 | 79141 | 81490 | +2.96% | +1.77% to +4.14% | -0.00% | -3.25% |

