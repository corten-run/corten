# The deadline's timer, part 2 (the gated run): cycles across placements, workload `besidemt`

Run 2f5414a8-49f0-4579-8580-10eee6d4b7dc, kit cycles-deadline-2029-3, plan sha256 228ec99cbaa195396673e49f9d9b809845ac0c8c56f8fc3fe50b0ab60790ad7c; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 30 placements, R = 8 recorded pairs in each after one unrecorded pair, 3 s turns, every turn on a fresh start, order from seed 7417. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 8 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the 20th of the 30 sorted placement medians (lower bound: the 11th). The A/A is resolved at +1% in both readings; the change's margin for `besidemt` is +5%, no floor; no reduction is declared or read.

The state in the counted turns: the head ran 299.4 more user instructions a request than the base at the median across the change's placements (the A/A's two base placements: -0.0). A set timer is declared to show as at least 95: shown. The floor turns no miss into anything else.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-besidemt | 30 of 30 | +0.21% | +0.32% | +0.10% | A/A: **resolved** |
| change-besidemt | 30 of 30 | +2.31% | +2.51% | | **meets +5%** |

## aa-besidemt: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +0.21% | +0.32% | -0.10% | -2.33% to +2.36% | -0.21% | +0.10% | +1.03% | +1.40% | +0.62% |
| cycles user | +0.12% | +0.62% | -0.22% | -3.10% to +4.17% | -0.12% | +0.22% | +1.67% | +1.82% | +0.81% |
| cycles kernel | -0.02% | +0.22% | -0.27% | -1.49% to +1.63% | +0.02% | +0.28% | +0.69% | +1.51% | +0.67% |
| instructions user | -0.00% | +0.00% | -0.00% | -0.01% to +0.01% | +0.00% | +0.00% | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | +1.00% | +1.24% | -0.13% | -6.91% to +5.85% | -0.99% | +0.14% | +2.42% | +2.81% | +1.25% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 21 | base-p1088 | base-p22096 | 72594 | 73025 | +1.08% | -2.04% to +5.69% | -0.00% | +2.43% |
| 4 | 28 | base-p6320 | base-p16928 | 72170 | 72701 | +0.73% | -0.72% to +2.79% | +0.00% | -2.28% |
| 5 | 19 | base-p16608 | base-p6592 | 72481 | 72921 | +0.36% | -1.31% to +2.31% | -0.00% | +0.98% |
| 8 | 5 | base-p10304 | base-p12880 | 72467 | 72401 | +0.16% | -3.19% to +1.93% | -0.00% | +1.42% |
| 9 | 17 | base-p36160 | base-p32064 | 72479 | 72525 | -0.39% | -1.48% to +1.85% | -0.00% | +2.21% |
| 12 | 14 | base-p36880 | base-p27312 | 73202 | 72912 | -0.38% | -1.74% to +1.60% | -0.00% | +1.04% |
| 13 | 26 | base-p21776 | base-p1440 | 72230 | 73032 | +0.47% | -0.88% to +2.32% | -0.00% | +2.43% |
| 16 | 9 | base-p20288 | base-p7008 | 73629 | 73718 | +0.27% | -1.88% to +2.77% | -0.00% | +1.24% |
| 17 | 6 | base-p21008 | base-p2192 | 72297 | 71802 | -0.06% | -1.89% to +0.99% | -0.00% | +1.03% |
| 20 | 3 | base-p25824 | base-p38336 | 75315 | 74948 | +0.21% | -2.60% to +2.89% | +0.00% | +2.76% |
| 21 | 22 | base-p15888 | base-p11408 | 72704 | 72580 | -0.78% | -1.16% to +1.29% | -0.00% | +0.74% |
| 24 | 2 | base-p15120 | base-p12160 | 74174 | 73738 | +0.32% | -2.49% to +2.63% | +0.01% | +1.13% |
| 25 | 1 | base-p320 | base-p22848 | 73492 | 73407 | -0.10% | -1.49% to +0.63% | +0.00% | +2.40% |
| 28 | 30 | base-p31760 | base-p36528 | 72243 | 72294 | +0.21% | -1.09% to +1.05% | +0.01% | +3.60% |
| 29 | 15 | base-p10720 | base-p12528 | 75100 | 75222 | +0.28% | -0.53% to +2.56% | +0.00% | -1.33% |
| 32 | 12 | base-p15536 | base-p11808 | 72642 | 73536 | +1.32% | -1.86% to +1.93% | +0.00% | -1.14% |
| 33 | 25 | base-p11072 | base-p16224 | 75945 | 73746 | -1.83% | -4.15% to -1.02% | +0.00% | +1.15% |
| 36 | 7 | base-p35808 | base-p32464 | 72513 | 72828 | +0.86% | -1.09% to +3.68% | -0.00% | +0.80% |
| 37 | 24 | base-p37296 | base-p26896 | 71682 | 72216 | +0.56% | -1.27% to +2.42% | -0.00% | -0.75% |
| 40 | 11 | base-p736 | base-p22496 | 71637 | 73139 | +2.06% | -1.91% to +2.74% | -0.00% | +5.85% |
| 41 | 20 | base-p31408 | base-p32768 | 72960 | 74448 | +2.36% | -0.48% to +4.60% | +0.01% | +2.34% |
| 44 | 29 | base-p16960 | base-p6256 | 72500 | 72231 | -0.28% | -1.69% to +2.19% | +0.00% | +0.45% |
| 45 | 10 | base-p30992 | base-p33184 | 72532 | 72113 | -0.27% | -1.28% to +0.48% | -0.00% | -0.13% |
| 48 | 8 | base-p5552 | base-p17680 | 72287 | 72542 | -0.02% | -0.79% to +1.67% | -0.00% | -2.18% |
| 49 | 18 | base-p5904 | base-p17280 | 71637 | 73082 | +2.16% | +0.84% to +3.70% | +0.00% | -0.88% |
| 52 | 13 | base-p26176 | base-p38000 | 74532 | 72676 | -2.33% | -4.43% to -0.93% | +0.00% | -2.73% |
| 53 | 16 | base-p21424 | base-p1840 | 72697 | 72364 | -0.71% | -3.79% to +2.37% | -0.00% | +2.07% |
| 56 | 23 | base-p26592 | base-p37584 | 75991 | 75449 | -0.88% | -2.70% to +2.01% | -0.00% | -6.91% |
| 57 | 4 | base-p40624 | base-p27648 | 74488 | 74368 | +0.31% | -2.93% to +3.27% | -0.01% | -2.36% |
| 60 | 27 | base-p36576 | base-p31712 | 73969 | 73797 | -0.80% | -2.75% to +2.15% | -0.00% | -1.85% |

## change-besidemt: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +2.31% | +2.51% | +2.08% | +0.66% to +4.26% | -2.26% | -2.04% | +0.77% | +2.23% | +0.99% |
| cycles user | +0.69% | +1.07% | +0.36% | -2.97% to +4.19% | -0.68% | -0.36% | +1.26% | +3.45% | +1.53% |
| cycles kernel | +3.47% | +3.61% | +3.13% | +2.48% to +5.36% | -3.35% | -3.04% | +0.70% | +1.71% | +0.76% |
| instructions user | +0.74% | +0.74% | +0.74% | +0.73% to +0.75% | -0.73% | -0.73% | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | -0.93% | -0.33% | -1.47% | -5.20% to +2.93% | +0.94% | +1.50% | +2.20% | +2.85% | +1.26% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 2 | 21 | base-p1088 | head-p1088 | 74237 | 76862 | +2.94% | -3.91% to +5.01% | +0.74% | -0.98% |
| 3 | 28 | base-p6320 | head-p6320 | 72740 | 74292 | +1.88% | +0.75% to +2.73% | +0.74% | -2.41% |
| 6 | 19 | base-p16608 | head-p16608 | 75078 | 76437 | +1.71% | +0.88% to +4.13% | +0.74% | -1.47% |
| 7 | 5 | base-p10304 | head-p10304 | 72963 | 74968 | +2.37% | +0.82% to +3.56% | +0.74% | +0.88% |
| 10 | 17 | base-p36160 | head-p36160 | 74266 | 76112 | +2.49% | +0.40% to +3.95% | +0.74% | -3.40% |
| 11 | 14 | base-p36880 | head-p36880 | 75004 | 76351 | +2.63% | +1.25% to +4.49% | +0.73% | +2.93% |
| 14 | 26 | base-p21776 | head-p21776 | 73255 | 75043 | +2.71% | +0.35% to +3.00% | +0.74% | +2.48% |
| 15 | 9 | base-p20288 | head-p20288 | 75531 | 77203 | +3.22% | -6.85% to +24.85% | +0.74% | -0.55% |
| 18 | 6 | base-p21008 | head-p21008 | 72229 | 73803 | +2.51% | +1.51% to +3.61% | +0.74% | -0.51% |
| 19 | 3 | base-p25824 | head-p25824 | 73225 | 74391 | +1.63% | -1.90% to +2.78% | +0.74% | -1.44% |
| 22 | 22 | base-p15888 | head-p15888 | 72136 | 73636 | +2.15% | -0.14% to +3.20% | +0.74% | -2.52% |
| 23 | 2 | base-p15120 | head-p15120 | 72137 | 73470 | +2.08% | -0.10% to +3.07% | +0.75% | -3.93% |
| 26 | 1 | base-p320 | head-p320 | 72505 | 74321 | +2.34% | +1.27% to +4.52% | +0.74% | -2.73% |
| 27 | 30 | base-p31760 | head-p31760 | 72041 | 74784 | +3.77% | +1.59% to +6.43% | +0.74% | -1.07% |
| 30 | 15 | base-p10720 | head-p10720 | 72889 | 74031 | +2.28% | +0.84% to +3.15% | +0.74% | -3.18% |
| 31 | 12 | base-p15536 | head-p15536 | 72626 | 73634 | +1.23% | -1.08% to +3.20% | +0.75% | -5.20% |
| 34 | 25 | base-p11072 | head-p11072 | 74223 | 75226 | +0.66% | -1.77% to +2.59% | +0.75% | +1.63% |
| 35 | 7 | base-p35808 | head-p35808 | 72250 | 73851 | +2.22% | +0.84% to +4.29% | +0.74% | -2.68% |
| 38 | 24 | base-p37296 | head-p37296 | 75059 | 76541 | +2.20% | -0.21% to +4.18% | +0.73% | -0.33% |
| 39 | 11 | base-p736 | head-p736 | 71313 | 74490 | +4.26% | +2.64% to +5.91% | +0.74% | +1.78% |
| 42 | 20 | base-p31408 | head-p31408 | 74057 | 75067 | +1.20% | -0.25% to +3.29% | +0.74% | +0.74% |
| 43 | 29 | base-p16960 | head-p16960 | 74024 | 74895 | +1.98% | -0.42% to +2.48% | +0.74% | -0.54% |
| 46 | 10 | base-p30992 | head-p30992 | 72559 | 74515 | +2.35% | +1.07% to +5.14% | +0.74% | +2.73% |
| 47 | 8 | base-p5552 | head-p5552 | 74784 | 76473 | +2.70% | -0.01% to +4.11% | +0.74% | -1.21% |
| 50 | 18 | base-p5904 | head-p5904 | 71803 | 73780 | +2.69% | +0.81% to +4.08% | +0.74% | -0.88% |
| 51 | 13 | base-p26176 | head-p26176 | 73777 | 75795 | +1.87% | +0.05% to +4.34% | +0.74% | +1.39% |
| 54 | 16 | base-p21424 | head-p21424 | 72272 | 74243 | +2.54% | +1.72% to +3.38% | +0.74% | +2.64% |
| 55 | 23 | base-p26592 | head-p26592 | 73191 | 75309 | +2.82% | +2.01% to +3.76% | +0.74% | -0.32% |
| 58 | 4 | base-p40624 | head-p40624 | 73753 | 75008 | +1.38% | -2.00% to +4.67% | +0.74% | -2.59% |
| 59 | 27 | base-p36576 | head-p36576 | 73211 | 74171 | +1.03% | -0.02% to +13.30% | +0.74% | -3.85% |

