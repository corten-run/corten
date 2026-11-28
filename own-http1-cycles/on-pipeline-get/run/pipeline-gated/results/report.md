# own-http1-on: `pipeline` across placements, the gated run

Run 6b14817f-9a23-40a8-a0c4-df083896ead9, plan sha256 3ec67c264a0150f9e83d263665d81bcce12b18882e413d8bae52f62984b240b3, inputs sha256 9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base 2f8984ddce025c92bade4a6fafd21f4863d25085, head 0bcb3138c69f69dab997486c9af87a3660eb0ed4; CPU Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 37 placements, R = 8 recorded pairs in each after one that is not, 3 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112711. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 24th smallest of the 37 placement medians and the lower bound the 14th. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /pipeline to the probe's configuration api, no request header of its own: a route that says unstaged and answers 2 bytes, the shortest request the probe answers. Touched: with the switch on its connection is Corten's own from the first byte to the last. Read for a reduction of 3%, the smallest reduction worth having, not a forecast, and held to +1% with no floor.

K = 37 is the smallest at which the sizing check passes from run b133026c-cf8a-46de-9ba2-b48719b8089c: normal 5706 failing draws of 200000, smoothed 8862 failing draws of 200000, against at most 10000.

## Reading

Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.

| comparison | placements | median of medians | bound | lower bound | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-pipeline, as recorded | 37 of 37 | +0.28% | +0.73% | -0.41% | |
| aa-pipeline, labels swapped | | -0.28% | +0.41% | -0.72% | A/A: **resolved** |
| change-pipeline | 37 of 37 | -8.73% | -8.55% | -8.93% | **meets +1%** |

The A/A's lowest and highest placement median as recorded: -2.93% to +2.79% (standard deviation 1.28%); the change's: -10.34% to -6.33%.

- The margin, `pipeline`: **pass** (meets +1%).
- A CPU-cost win, a smallest worthwhile reduction of 3.00%: the change's bound -8.55% against -3.00%, the A/A's lower bound -0.41% as recorded and -0.72% with the labels swapped: **reduction established**.
- The spread: the plan declares that this A/A records a placement spread for the workload. It is complete and resolved, so it gives -2.93% to +2.79%, which is recorded only by a pull request that changes the Choice.

## aa-pipeline: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | +0.28% | +0.73% | -0.41% | -2.93% to +2.79% | -0.28% | +0.41% | -0.72% |
| cycles, user | +0.93% | +2.21% | -1.11% | -7.51% to +6.38% | -0.92% | +1.20% | -2.16% |
| cycles, kernel | -0.04% | +0.33% | -0.32% | -1.54% to +1.88% | +0.04% | +0.32% | -0.33% |
| instructions, user | +0.00% | +0.00% | +0.00% | -0.00% to +0.00% | -0.00% | -0.00% | -0.00% |
| L1 instruction-cache misses, user | -0.67% | +1.32% | -1.41% | -4.78% to +6.82% | +0.67% | +1.43% | -1.29% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 11 | base-p736 | base-p22496 | 33809 | 33944 | +0.20% | -4.43% to +4.57% | +1.29% | -0.04% | -0.00% | +1.45% |
| 4 | 6 | base-p21008 | base-p2192 | 33396 | 33946 | +2.79% | -1.81% to +4.34% | +4.82% | +1.64% | +0.00% | +0.75% |
| 5 | 36 | base-p22192 | base-p832 | 33185 | 33182 | -0.41% | -2.32% to +1.16% | -0.68% | -0.83% | +0.00% | +4.43% |
| 8 | 13 | base-p26176 | base-p38000 | 33750 | 33173 | -0.21% | -3.94% to +3.36% | +2.21% | -0.64% | -0.00% | -3.78% |
| 9 | 37 | base-p32832 | base-p29200 | 33598 | 33076 | -1.02% | -4.97% to +0.53% | -5.18% | -0.23% | -0.00% | -4.59% |
| 12 | 26 | base-p21776 | base-p1440 | 33663 | 33936 | +1.38% | -2.73% to +9.12% | +6.38% | +1.13% | +0.00% | -2.11% |
| 13 | 17 | base-p36160 | base-p32064 | 33308 | 33542 | +1.23% | -0.92% to +3.07% | +1.89% | +0.78% | +0.00% | -0.67% |
| 16 | 10 | base-p30992 | base-p33184 | 33719 | 33375 | -0.49% | -8.81% to +3.65% | +0.29% | -0.76% | +0.00% | +1.32% |
| 17 | 12 | base-p15536 | base-p11808 | 33529 | 33856 | +0.95% | -2.20% to +3.67% | +0.30% | +0.92% | +0.00% | +5.20% |
| 20 | 28 | base-p6320 | base-p16928 | 33292 | 33807 | +1.62% | -1.08% to +7.20% | +5.89% | +0.41% | +0.00% | +6.82% |
| 21 | 5 | base-p10304 | base-p12880 | 33641 | 33737 | +0.23% | -1.59% to +5.98% | -1.55% | +0.49% | +0.00% | -1.12% |
| 24 | 20 | base-p31408 | base-p32768 | 33537 | 33852 | +0.06% | -2.03% to +3.90% | -1.81% | +0.55% | +0.00% | +6.71% |
| 25 | 30 | base-p31760 | base-p36528 | 33248 | 33261 | -0.80% | -2.40% to +2.26% | -1.30% | -0.54% | +0.00% | -3.67% |
| 28 | 35 | base-p11488 | base-p14400 | 33462 | 32967 | -0.77% | -3.09% to +2.10% | -1.11% | -0.65% | -0.00% | -1.55% |
| 29 | 34 | base-p37648 | base-p27008 | 33215 | 33240 | -0.52% | -4.80% to +1.65% | -1.68% | -0.88% | +0.00% | -2.17% |
| 32 | 33 | base-p26944 | base-p39424 | 33219 | 33674 | +0.28% | -0.66% to +4.49% | +0.93% | +0.22% | +0.00% | -1.81% |
| 33 | 25 | base-p11072 | base-p16224 | 33782 | 34085 | +0.91% | -3.49% to +1.90% | +2.29% | +0.02% | +0.00% | +2.87% |
| 36 | 19 | base-p16608 | base-p6592 | 33555 | 33651 | +0.95% | -2.20% to +4.60% | +2.83% | +0.33% | +0.00% | +2.55% |
| 37 | 31 | base-p1504 | base-p20528 | 33715 | 34076 | +1.19% | -2.75% to +4.11% | +3.77% | -0.11% | +0.00% | +1.76% |
| 40 | 21 | base-p1088 | base-p22096 | 34062 | 33804 | -0.72% | -11.17% to +2.37% | -4.77% | +0.23% | -0.00% | -4.78% |
| 41 | 29 | base-p16960 | base-p6256 | 33418 | 32541 | -2.93% | -5.48% to +3.15% | -7.51% | -1.54% | +0.00% | -3.06% |
| 44 | 4 | base-p40624 | base-p27648 | 33230 | 33834 | +1.43% | -2.88% to +3.50% | +3.03% | +0.89% | +0.00% | +2.97% |
| 45 | 23 | base-p26592 | base-p37584 | 33577 | 33242 | -0.46% | -2.47% to +3.32% | -2.07% | -0.14% | +0.00% | -2.75% |
| 48 | 7 | base-p35808 | base-p32464 | 33646 | 33239 | -2.09% | -4.83% to +2.05% | -6.20% | -0.92% | -0.00% | +0.24% |
| 49 | 22 | base-p15888 | base-p11408 | 33233 | 33710 | +1.35% | -2.17% to +7.16% | +2.76% | +0.96% | +0.00% | +1.62% |
| 52 | 1 | base-p320 | base-p22848 | 33482 | 33609 | +0.73% | -18.90% to +12.11% | +0.55% | +0.78% | +0.00% | -2.55% |
| 53 | 27 | base-p36576 | base-p31712 | 33684 | 33918 | +0.38% | -2.24% to +3.46% | +3.27% | -0.37% | -0.00% | -0.62% |
| 56 | 2 | base-p15120 | base-p12160 | 33385 | 33687 | +0.35% | -0.63% to +2.93% | +2.34% | -0.31% | +0.00% | +3.79% |
| 57 | 9 | base-p20288 | base-p7008 | 33470 | 32559 | -1.80% | -5.12% to +0.70% | -3.58% | -1.30% | -0.00% | -2.52% |
| 60 | 24 | base-p37296 | base-p26896 | 33100 | 33874 | +2.49% | -0.83% to +4.00% | +2.80% | +1.88% | +0.00% | +0.29% |
| 61 | 18 | base-p5904 | base-p17280 | 33700 | 33791 | +0.46% | -4.46% to +4.78% | +2.03% | +0.46% | +0.00% | +3.68% |
| 64 | 15 | base-p10720 | base-p12528 | 33696 | 33320 | -1.62% | -4.39% to +3.01% | -4.68% | -0.85% | -0.00% | -1.03% |
| 65 | 16 | base-p21424 | base-p1840 | 33523 | 33949 | +1.42% | -2.56% to +2.15% | +4.00% | +0.12% | +0.00% | -1.39% |
| 68 | 14 | base-p36880 | base-p27312 | 33955 | 34446 | +0.52% | -2.03% to +2.82% | +1.72% | -0.32% | +0.00% | -1.41% |
| 69 | 3 | base-p25824 | base-p38336 | 34581 | 33944 | -1.25% | -14.13% to +1.66% | -4.04% | -1.48% | -0.00% | -1.60% |
| 72 | 32 | base-p16304 | base-p12080 | 33387 | 33520 | +1.23% | -3.93% to +2.86% | +2.53% | +0.57% | +0.00% | -0.86% |
| 73 | 8 | base-p5552 | base-p17680 | 33561 | 33116 | -1.78% | -2.87% to +0.94% | -2.47% | -1.24% | -0.00% | +1.51% |

## change-pipeline: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -8.73% | -8.55% | -8.93% | -10.34% to -6.33% | +9.57% | +9.80% | +9.36% |
| cycles, user | -17.48% | -16.88% | -18.13% | -21.22% to -12.04% | +21.19% | +22.15% | +20.31% |
| cycles, kernel | -6.29% | -5.92% | -6.38% | -7.14% to -4.28% | +6.72% | +6.81% | +6.30% |
| instructions, user | -11.74% | -11.74% | -11.74% | -11.74% to -11.73% | +13.30% | +13.30% | +13.30% |
| L1 instruction-cache misses, user | -18.92% | -18.23% | -19.43% | -22.77% to -13.12% | +23.34% | +24.12% | +22.30% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 11 | base-p736 | head-p736 | 33747 | 30719 | -7.71% | -12.11% to -5.86% | -15.92% | -5.60% | -11.74% | -18.82% |
| 3 | 6 | base-p21008 | head-p21008 | 33704 | 30676 | -9.12% | -11.33% to -7.19% | -19.04% | -6.75% | -11.74% | -19.89% |
| 6 | 36 | base-p22192 | head-p22192 | 33341 | 30585 | -8.73% | -10.76% to -6.05% | -17.50% | -6.33% | -11.74% | -17.07% |
| 7 | 13 | base-p26176 | head-p26176 | 33882 | 30689 | -8.71% | -13.48% to +2.35% | -18.06% | -5.85% | -11.74% | -16.46% |
| 10 | 37 | base-p32832 | head-p32832 | 33394 | 30458 | -9.65% | -10.80% to -6.85% | -19.04% | -6.41% | -11.74% | -21.27% |
| 11 | 26 | base-p21776 | head-p21776 | 33475 | 30398 | -8.88% | -14.36% to -6.25% | -16.88% | -6.76% | -11.74% | -18.67% |
| 14 | 17 | base-p36160 | head-p36160 | 33784 | 30889 | -8.00% | -11.67% to -4.09% | -16.02% | -5.71% | -11.74% | -15.41% |
| 15 | 10 | base-p30992 | head-p30992 | 33704 | 30839 | -9.01% | -11.20% to -6.45% | -17.22% | -7.03% | -11.74% | -20.82% |
| 18 | 12 | base-p15536 | head-p15536 | 33593 | 31266 | -7.24% | -13.26% to +0.52% | -13.45% | -5.45% | -11.74% | -16.03% |
| 19 | 28 | base-p6320 | head-p6320 | 33320 | 30663 | -7.94% | -11.81% to -4.03% | -15.52% | -6.38% | -11.74% | -14.03% |
| 22 | 5 | base-p10304 | head-p10304 | 34118 | 31132 | -9.79% | -11.97% to -6.72% | -18.61% | -6.22% | -11.74% | -20.18% |
| 23 | 20 | base-p31408 | head-p31408 | 33846 | 30985 | -8.24% | -10.95% to -7.09% | -17.47% | -5.36% | -11.74% | -13.12% |
| 26 | 30 | base-p31760 | head-p31760 | 33653 | 30540 | -8.93% | -11.08% to -6.46% | -17.84% | -6.38% | -11.74% | -20.47% |
| 27 | 35 | base-p11488 | head-p11488 | 33998 | 30826 | -8.59% | -12.71% to -6.72% | -16.28% | -6.28% | -11.74% | -16.63% |
| 30 | 34 | base-p37648 | head-p37648 | 33968 | 30628 | -9.02% | -13.07% to -4.84% | -17.49% | -6.69% | -11.74% | -20.13% |
| 31 | 33 | base-p26944 | head-p26944 | 33859 | 30669 | -9.56% | -15.84% to +0.37% | -18.91% | -6.15% | -11.74% | -22.22% |
| 34 | 25 | base-p11072 | head-p11072 | 33348 | 30768 | -7.32% | -13.05% to -4.55% | -14.35% | -5.29% | -11.74% | -20.26% |
| 35 | 19 | base-p16608 | head-p16608 | 34133 | 31025 | -8.59% | -14.93% to -3.29% | -18.13% | -5.35% | -11.74% | -14.54% |
| 38 | 31 | base-p1504 | head-p1504 | 33657 | 30725 | -8.51% | -12.68% to -4.46% | -15.35% | -6.35% | -11.74% | -16.07% |
| 39 | 21 | base-p1088 | head-p1088 | 33628 | 30471 | -8.76% | -11.12% to -5.62% | -15.30% | -6.27% | -11.74% | -22.77% |
| 42 | 29 | base-p16960 | head-p16960 | 33345 | 30714 | -8.35% | -9.26% to -4.92% | -15.85% | -5.27% | -11.74% | -18.33% |
| 43 | 4 | base-p40624 | head-p40624 | 33658 | 30542 | -9.02% | -11.72% to -6.56% | -17.48% | -7.01% | -11.74% | -19.68% |
| 46 | 23 | base-p26592 | head-p26592 | 33408 | 30845 | -8.39% | -15.52% to -1.87% | -15.98% | -6.75% | -11.74% | -18.06% |
| 47 | 7 | base-p35808 | head-p35808 | 33772 | 30335 | -9.14% | -13.30% to -7.10% | -18.59% | -6.31% | -11.74% | -19.33% |
| 50 | 22 | base-p15888 | head-p15888 | 34689 | 30998 | -9.93% | -19.62% to +27.80% | -18.68% | -7.10% | -11.74% | -16.18% |
| 51 | 1 | base-p320 | head-p320 | 34066 | 30879 | -8.71% | -11.11% to -6.07% | -18.41% | -5.66% | -11.74% | -21.98% |
| 54 | 27 | base-p36576 | head-p36576 | 33454 | 30500 | -8.45% | -14.28% to -6.66% | -17.14% | -5.92% | -11.74% | -19.14% |
| 55 | 2 | base-p15120 | head-p15120 | 33032 | 30420 | -8.88% | -11.80% to -6.72% | -15.34% | -6.63% | -11.74% | -19.43% |
| 58 | 9 | base-p20288 | head-p20288 | 33073 | 30867 | -6.33% | -7.54% to -3.44% | -12.04% | -4.28% | -11.73% | -18.23% |
| 59 | 24 | base-p37296 | head-p37296 | 33129 | 30798 | -7.33% | -11.31% to -3.19% | -16.02% | -4.79% | -11.74% | -18.92% |
| 62 | 18 | base-p5904 | head-p5904 | 33038 | 30156 | -8.47% | -12.02% to -4.67% | -18.33% | -5.82% | -11.74% | -19.38% |
| 63 | 15 | base-p10720 | head-p10720 | 33479 | 30261 | -9.90% | -12.74% to -7.66% | -19.18% | -7.14% | -11.74% | -13.56% |
| 66 | 16 | base-p21424 | head-p21424 | 33506 | 30822 | -8.55% | -9.33% to -6.69% | -19.11% | -4.92% | -11.74% | -18.94% |
| 67 | 14 | base-p36880 | head-p36880 | 33842 | 30750 | -8.79% | -12.33% to -6.68% | -17.26% | -6.29% | -11.74% | -21.49% |
| 70 | 3 | base-p25824 | head-p25824 | 33901 | 30342 | -10.34% | -12.49% to -8.57% | -21.22% | -6.95% | -11.74% | -20.39% |
| 71 | 32 | base-p16304 | head-p16304 | 33451 | 30345 | -9.19% | -12.39% to -4.01% | -18.68% | -6.34% | -11.74% | -18.84% |
| 74 | 8 | base-p5552 | head-p5552 | 33671 | 30546 | -9.23% | -11.66% to -3.80% | -19.26% | -6.54% | -11.74% | -17.27% |

## Code aligned beyond 16 bytes

`base`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

`head`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

