# The deadline's timer, part 2 (the gated run): cycles across placements, workload `beside`

Run aed6115d-b612-4fac-8c06-92e10f8c1d9e, kit cycles-deadline-2029-3, plan sha256 228ec99cbaa195396673e49f9d9b809845ac0c8c56f8fc3fe50b0ab60790ad7c; CPU Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 30 placements, R = 8 recorded pairs in each after one unrecorded pair, 3 s turns, every turn on a fresh start, order from seed 7416. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 8 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## Verdicts

The bound is the 20th of the 30 sorted placement medians (lower bound: the 11th). The A/A is resolved at +1% in both readings; the change's margin for `beside` is +5%, no floor; no reduction is declared or read.

The state in the counted turns: the head ran 291.1 more user instructions a request than the base at the median across the change's placements (the A/A's two base placements: -0.0). A set timer is declared to show as at least 95: shown. The floor turns no miss into anything else.

| comparison | placements | median of medians | bound | bound, labels swapped | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-beside | 30 of 30 | -0.07% | +0.37% | +0.40% | A/A: **resolved** |
| change-beside | 30 of 30 | +2.15% | +2.36% | | **meets +5%** |

## aa-beside: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | -0.07% | +0.37% | -0.39% | -2.45% to +3.09% | +0.07% | +0.40% | +1.14% | +1.79% | +0.79% |
| cycles user | -0.07% | +0.46% | -0.67% | -3.09% to +5.12% | +0.07% | +0.68% | +2.01% | +2.64% | +1.17% |
| cycles kernel | +0.14% | +0.32% | -0.27% | -1.77% to +1.78% | -0.14% | +0.27% | +0.83% | +1.46% | +0.65% |
| instructions user | -0.00% | +0.00% | -0.00% | -0.00% to +0.00% | +0.00% | +0.00% | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | +0.12% | +0.63% | -1.15% | -3.67% to +3.19% | -0.11% | +1.16% | +1.96% | +3.12% | +1.38% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 5 | base-p10304 | base-p12880 | 75419 | 75218 | +0.51% | -1.65% to +1.68% | +0.00% | +2.47% |
| 4 | 22 | base-p15888 | base-p11408 | 74942 | 75934 | +1.60% | -0.55% to +3.72% | +0.00% | +0.11% |
| 5 | 4 | base-p40624 | base-p27648 | 75323 | 75155 | +0.18% | -1.84% to +2.26% | +0.00% | -1.47% |
| 8 | 17 | base-p36160 | base-p32064 | 76212 | 76831 | +0.70% | -0.31% to +2.61% | +0.00% | +0.63% |
| 9 | 12 | base-p15536 | base-p11808 | 74603 | 76864 | +3.09% | +1.83% to +4.31% | -0.00% | -1.15% |
| 12 | 27 | base-p36576 | base-p31712 | 75622 | 74514 | -0.65% | -3.42% to +1.24% | -0.00% | -3.35% |
| 13 | 13 | base-p26176 | base-p38000 | 74934 | 74528 | -0.31% | -1.14% to +1.57% | +0.00% | -2.46% |
| 16 | 30 | base-p31760 | base-p36528 | 74686 | 74936 | +0.37% | -0.76% to +2.60% | +0.00% | +0.17% |
| 17 | 26 | base-p21776 | base-p1440 | 74325 | 75055 | +0.81% | -0.42% to +3.01% | +0.00% | +1.59% |
| 20 | 8 | base-p5552 | base-p17680 | 74642 | 74776 | -0.10% | -0.77% to +1.79% | +0.00% | -0.92% |
| 21 | 28 | base-p6320 | base-p16928 | 73598 | 75119 | +2.27% | -0.19% to +3.61% | +0.00% | +2.19% |
| 24 | 15 | base-p10720 | base-p12528 | 75203 | 74707 | -0.68% | -1.77% to -0.06% | -0.00% | -0.44% |
| 25 | 25 | base-p11072 | base-p16224 | 75085 | 75476 | +0.63% | -1.17% to +1.88% | +0.00% | -0.21% |
| 28 | 10 | base-p30992 | base-p33184 | 75199 | 75140 | -0.04% | -1.22% to +0.98% | +0.00% | +1.19% |
| 29 | 9 | base-p20288 | base-p7008 | 75651 | 75318 | -0.11% | -1.21% to +1.42% | -0.00% | +0.12% |
| 32 | 23 | base-p26592 | base-p37584 | 75209 | 74910 | -0.52% | -1.58% to +0.60% | -0.00% | -2.44% |
| 33 | 14 | base-p36880 | base-p27312 | 75064 | 74589 | -0.38% | -2.69% to +1.97% | -0.00% | +0.41% |
| 36 | 11 | base-p736 | base-p22496 | 74713 | 75536 | +0.78% | -1.22% to +3.43% | -0.00% | +0.17% |
| 37 | 7 | base-p35808 | base-p32464 | 75072 | 74546 | -0.79% | -1.80% to +1.40% | -0.00% | +3.19% |
| 40 | 20 | base-p31408 | base-p32768 | 74796 | 75279 | +0.46% | -0.82% to +2.10% | +0.00% | -1.55% |
| 41 | 16 | base-p21424 | base-p1840 | 74428 | 74711 | +0.37% | -1.65% to +1.32% | -0.00% | -1.23% |
| 44 | 3 | base-p25824 | base-p38336 | 75593 | 75089 | -0.39% | -3.65% to +1.28% | -0.00% | +1.74% |
| 45 | 21 | base-p1088 | base-p22096 | 75714 | 74668 | -1.65% | -21.20% to +0.44% | -0.00% | -1.64% |
| 48 | 18 | base-p5904 | base-p17280 | 76268 | 75669 | -0.99% | -2.30% to +1.31% | -0.00% | +2.53% |
| 49 | 2 | base-p15120 | base-p12160 | 76036 | 76736 | +0.77% | -3.14% to +3.88% | -0.00% | +2.64% |
| 52 | 1 | base-p320 | base-p22848 | 77057 | 75865 | -1.80% | -3.39% to +1.01% | -0.00% | -1.81% |
| 53 | 29 | base-p16960 | base-p6256 | 75677 | 75580 | -0.41% | -1.91% to +1.16% | -0.00% | +2.61% |
| 56 | 24 | base-p37296 | base-p26896 | 74839 | 74014 | -1.10% | -4.28% to +0.60% | -0.00% | -3.34% |
| 57 | 6 | base-p21008 | base-p2192 | 76215 | 74427 | -2.45% | -4.59% to -0.92% | -0.00% | -3.67% |
| 60 | 19 | base-p16608 | base-p6592 | 75482 | 75243 | +0.11% | -3.10% to +2.88% | +0.00% | +0.90% |

## change-beside: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +2.15% | +2.36% | +1.48% | +0.19% to +3.56% | -2.11% | -1.45% | +0.98% | +1.63% | +0.72% |
| cycles user | -0.02% | +0.84% | -0.89% | -3.58% to +3.41% | +0.02% | +0.89% | +1.82% | +2.35% | +1.04% |
| cycles kernel | +3.33% | +3.65% | +3.02% | +2.18% to +4.54% | -3.22% | -2.93% | +0.69% | +1.50% | +0.67% |
| instructions user | +0.73% | +0.73% | +0.73% | +0.73% to +0.73% | -0.73% | -0.73% | +0.00% | +0.00% | +0.00% |
| L1 icache misses user | -1.18% | -0.74% | -1.79% | -6.11% to +2.16% | +1.21% | +1.83% | +2.21% | +3.11% | +1.38% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 2 | 5 | base-p10304 | head-p10304 | 75201 | 77352 | +2.75% | +1.46% to +4.43% | +0.73% | +1.15% |
| 3 | 22 | base-p15888 | head-p15888 | 75084 | 76278 | +1.84% | -1.04% to +3.71% | +0.73% | -0.74% |
| 6 | 4 | base-p40624 | head-p40624 | 75555 | 75946 | +0.20% | -0.43% to +3.83% | +0.73% | -3.88% |
| 7 | 17 | base-p36160 | head-p36160 | 75686 | 76621 | +1.21% | -1.77% to +2.83% | +0.73% | -5.15% |
| 10 | 12 | base-p15536 | head-p15536 | 75612 | 76656 | +1.33% | +0.04% to +10.81% | +0.73% | -6.11% |
| 11 | 27 | base-p36576 | head-p36576 | 75545 | 76509 | +1.51% | +0.43% to +1.84% | +0.73% | -2.16% |
| 14 | 13 | base-p26176 | head-p26176 | 74599 | 76281 | +1.80% | -0.01% to +4.93% | +0.73% | +1.35% |
| 15 | 30 | base-p31760 | head-p31760 | 73637 | 75471 | +3.14% | +0.10% to +4.44% | +0.73% | +0.40% |
| 18 | 26 | base-p21776 | head-p21776 | 73751 | 75857 | +2.36% | +1.16% to +3.72% | +0.73% | -2.15% |
| 19 | 8 | base-p5552 | head-p5552 | 75154 | 76619 | +2.31% | -0.55% to +3.24% | +0.73% | -2.43% |
| 22 | 28 | base-p6320 | head-p6320 | 74381 | 76519 | +2.93% | +1.33% to +4.65% | +0.73% | -0.88% |
| 23 | 15 | base-p10720 | head-p10720 | 75294 | 77688 | +3.56% | +0.63% to +5.40% | +0.73% | +0.59% |
| 26 | 25 | base-p11072 | head-p11072 | 75576 | 77383 | +2.50% | +0.48% to +3.64% | +0.73% | +0.26% |
| 27 | 10 | base-p30992 | head-p30992 | 75249 | 76778 | +2.27% | +1.05% to +4.38% | +0.73% | +1.96% |
| 30 | 9 | base-p20288 | head-p20288 | 75843 | 76473 | +0.47% | -0.73% to +2.65% | +0.73% | +2.16% |
| 31 | 23 | base-p26592 | head-p26592 | 75318 | 77799 | +3.29% | +1.00% to +5.05% | +0.73% | -1.61% |
| 34 | 14 | base-p36880 | head-p36880 | 75328 | 75708 | +0.52% | -5.71% to +3.60% | +0.73% | -1.68% |
| 35 | 11 | base-p736 | head-p736 | 75062 | 76825 | +2.31% | +0.88% to +4.04% | +0.73% | +1.99% |
| 38 | 7 | base-p35808 | head-p35808 | 74946 | 76741 | +2.03% | -0.74% to +3.68% | +0.73% | -0.85% |
| 39 | 20 | base-p31408 | head-p31408 | 74898 | 76338 | +2.35% | -1.94% to +3.82% | +0.73% | -1.91% |
| 42 | 16 | base-p21424 | head-p21424 | 74890 | 77260 | +3.00% | +1.34% to +5.96% | +0.73% | +1.77% |
| 43 | 3 | base-p25824 | head-p25824 | 75326 | 76653 | +2.43% | -2.81% to +4.10% | +0.73% | +1.56% |
| 46 | 21 | base-p1088 | head-p1088 | 75683 | 76409 | +1.23% | -0.05% to +2.88% | +0.73% | -1.20% |
| 47 | 18 | base-p5904 | head-p5904 | 76206 | 76068 | +0.84% | -1.46% to +2.30% | +0.73% | -0.75% |
| 50 | 2 | base-p15120 | head-p15120 | 74902 | 75782 | +1.37% | +0.01% to +3.25% | +0.73% | -2.38% |
| 51 | 1 | base-p320 | head-p320 | 77012 | 77464 | +0.19% | -0.51% to +2.60% | +0.73% | -1.34% |
| 54 | 29 | base-p16960 | head-p16960 | 75073 | 76349 | +1.48% | -0.20% to +2.90% | +0.73% | -2.32% |
| 55 | 24 | base-p37296 | head-p37296 | 74839 | 77111 | +3.00% | -2.41% to +3.78% | +0.73% | -1.16% |
| 58 | 6 | base-p21008 | head-p21008 | 75396 | 76376 | +1.08% | -0.56% to +3.07% | +0.73% | -5.64% |
| 59 | 19 | base-p16608 | head-p16608 | 75092 | 77762 | +3.53% | +1.30% to +5.36% | +0.73% | -1.79% |

