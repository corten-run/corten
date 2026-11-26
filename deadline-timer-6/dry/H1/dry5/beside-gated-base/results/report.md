# The deadline's timer, part 2 (the gated run): cycles across placements, workload `beside`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.** The gated part's scripts with the base as both sides: the "head" below is the base, and no cycle of the head was counted.

Run 1ea71fa8-0a5c-45ed-81ee-0849929c9378, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7406. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the - of the 3 sorted placement medians (lower bound: the -). The A/A is resolved at +1% in both readings; the change's margin for `beside` is +5%, no floor; no reduction is declared or read.

The state in the counted turns: the head ran 1.1 more user instructions a request than the base at the median across the change's placements (the A/A's two base placements: 1.0). A set timer is declared to show as at least 95: **not shown**, so a change within its margin is not read as declared, which does not pass. The floor turns no miss into anything else.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-beside | 3 of 3 | -0.59% | none | none | A/A: **not resolved (incomplete)** |
| change-beside | 3 of 3 | -0.83% | none | | **no bound (incomplete): does not pass** |

## aa-beside: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -0.59% | - | - | -1.89% to +1.97% | +0.60% | - | +1.97% | +0.80% | +0.71% |
| cycles user | -0.98% | - | - | -2.18% to +1.32% | +1.00% | - | +1.78% | +1.67% | +1.48% |
| cycles kernel | -0.30% | - | - | -1.67% to +2.47% | +0.30% | - | +2.11% | +0.28% | +0.25% |
| instructions user | +0.00% | - | - | +0.00% to +0.00% | -0.00% | - | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | -1.33% | - | - | -1.89% to +5.15% | +1.37% | - | +3.91% | +2.28% | +2.02% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 75482 | 74055 | -1.89% | -1.98% to -1.80% | +0.00% | +5.15% |
| 4 | 1 | base-p320 | base-p22848 | 75080 | 74638 | -0.59% | -1.30% to +0.12% | +0.00% | -1.89% |
| 5 | 2 | base-p15120 | base-p12160 | 74613 | 76085 | +1.97% | +1.31% to +2.64% | +0.00% | -1.33% |

## change-beside: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -0.83% | - | - | -1.41% to +0.67% | +0.84% | - | +1.07% | +0.76% | +0.67% |
| cycles user | -1.07% | - | - | -1.41% to +0.27% | +1.08% | - | +0.89% | +1.21% | +1.07% |
| cycles kernel | -0.39% | - | - | -1.66% to +0.98% | +0.40% | - | +1.32% | +1.19% | +1.06% |
| instructions user | +0.00% | - | - | -0.00% to +0.00% | -0.00% | - | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | +1.74% | - | - | -1.57% to +3.28% | -1.70% | - | +2.48% | +1.09% | +0.97% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 2 | 3 | base-p25824 | head-p25824 | 75273 | 75777 | +0.67% | +0.59% to +0.74% | +0.00% | -1.57% |
| 3 | 1 | base-p320 | head-p320 | 75951 | 74877 | -1.41% | -2.26% to -0.55% | +0.00% | +3.28% |
| 6 | 2 | base-p15120 | head-p15120 | 75381 | 74752 | -0.83% | -1.18% to -0.49% | -0.00% | +1.74% |

