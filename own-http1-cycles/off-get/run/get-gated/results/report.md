# own-http1-off: `get` across placements, the gated run

Run 5c12c6b1-6067-41f3-920a-baa28e6e792f, plan sha256 f0c299630cd32cea90a94e5f292b360a38b87c86fb446a3e9efd26f644aca225, inputs sha256 9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base e733f3d888450707c049a17cd6100c891966bc87, head 2f8984ddce025c92bade4a6fafd21f4863d25085; CPU Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 37 placements, R = 8 recorded pairs in each after one that is not, 3 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112702. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 24th smallest of the 37 placement medians and the lower bound the 14th. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /baseline11?a=1&b=2 to the probe's configuration api, no request header of its own: a staged API route, typed query parameters in and a short answer out. Touched: with the switch off a connection takes one more branch when it is accepted and a request takes the same path through hyper, but the compiled program is not the same (design Choice 78), so every request runs code this change compiles differently. Held to +1% with no floor; no reduction is declared. Named for the catalog's json target: both are a staged API route's short answer through the same connection, service and router future, which is the code this change compiles differently.

K = 37 is the smallest at which the sizing check passes from run bb9f3a45-a359-402d-9fa3-1100dfc6230f: smoothed 7866 failing draws of 200000, against at most 10000.

## Reading

Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.

| comparison | placements | median of medians | bound | lower bound | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-get, as recorded | 37 of 37 | -0.24% | +0.16% | -0.68% | |
| aa-get, labels swapped | | +0.24% | +0.69% | -0.16% | A/A: **resolved** |
| change-get | 37 of 37 | -0.45% | -0.13% | -0.87% | **meets +1%** |

The A/A's lowest and highest placement median as recorded: -7.39% to +2.35% (standard deviation 1.62%); the change's: -2.47% to +5.93%.

- The margin, `get`: **pass** (meets +1%).
- A CPU-cost win: the plan declares no reduction for this workload, so none is read.
- The spread: the plan declares that this A/A records a placement spread for the workload. It is complete and resolved, so it gives -7.39% to +2.35%, which is recorded only by a pull request that changes the Choice.

## aa-get: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -0.24% | +0.16% | -0.68% | -7.39% to +2.35% | +0.24% | +0.69% | -0.16% |
| cycles, user | -0.41% | +0.22% | -1.03% | -13.89% to +4.09% | +0.42% | +1.04% | -0.12% |
| cycles, kernel | -0.17% | +0.17% | -0.47% | -4.25% to +1.31% | +0.17% | +0.47% | -0.17% |
| instructions, user | -0.00% | +0.00% | -0.00% | -0.00% to +0.00% | +0.00% | +0.00% | -0.00% |
| L1 instruction-cache misses, user | -1.85% | +1.24% | -2.25% | -8.01% to +6.74% | +1.89% | +2.30% | -1.22% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 12 | base-p15536 | base-p11808 | 41503 | 41460 | -0.24% | -6.77% to +28.97% | -1.03% | +0.19% | -0.00% | -1.98% |
| 4 | 6 | base-p21008 | base-p2192 | 40128 | 40372 | +0.80% | -3.10% to +4.19% | +0.33% | +1.06% | +0.00% | +1.24% |
| 5 | 27 | base-p36576 | base-p31712 | 40196 | 40612 | +0.33% | -7.69% to +2.73% | +0.07% | +0.20% | +0.00% | -1.99% |
| 8 | 23 | base-p26592 | base-p37584 | 40316 | 40723 | +0.26% | -23.76% to +4.52% | +0.22% | -0.03% | -0.00% | -1.85% |
| 9 | 22 | base-p15888 | base-p11408 | 40753 | 40733 | +0.43% | -1.25% to +2.50% | -0.32% | +0.71% | -0.00% | -2.88% |
| 12 | 2 | base-p15120 | base-p12160 | 40708 | 40764 | +0.16% | -5.39% to +4.83% | +0.71% | +0.32% | -0.00% | -3.64% |
| 13 | 21 | base-p1088 | base-p22096 | 41461 | 40490 | -1.58% | -7.02% to +1.80% | -2.88% | -1.05% | -0.00% | +2.06% |
| 16 | 25 | base-p11072 | base-p16224 | 44505 | 40956 | -7.39% | -35.18% to +52.12% | -13.89% | -4.25% | -0.00% | -5.26% |
| 17 | 19 | base-p16608 | base-p6592 | 41651 | 40823 | +0.02% | -5.94% to +8.39% | -0.41% | +0.19% | +0.00% | +0.29% |
| 20 | 3 | base-p25824 | base-p38336 | 40419 | 40535 | -0.40% | -5.05% to +4.91% | -1.22% | +0.06% | -0.00% | +1.34% |
| 21 | 28 | base-p6320 | base-p16928 | 41216 | 40208 | -1.98% | -6.11% to +3.33% | -2.17% | -1.77% | -0.00% | -8.01% |
| 24 | 34 | base-p37648 | base-p27008 | 40766 | 40578 | -0.16% | -6.78% to +2.28% | +0.55% | -0.72% | -0.00% | -4.63% |
| 25 | 13 | base-p26176 | base-p38000 | 40626 | 40395 | -0.27% | -2.69% to +9.08% | -1.22% | -0.26% | +0.00% | +3.50% |
| 28 | 30 | base-p31760 | base-p36528 | 40845 | 41071 | +2.00% | -1.11% to +25.52% | +4.05% | +0.95% | +0.00% | +2.98% |
| 29 | 26 | base-p21776 | base-p1440 | 40905 | 40615 | -0.68% | -1.60% to +4.16% | -0.56% | -0.17% | -0.00% | -0.38% |
| 32 | 16 | base-p21424 | base-p1840 | 40718 | 41318 | +1.99% | -5.55% to +5.89% | +2.76% | +1.31% | +0.00% | +2.72% |
| 33 | 18 | base-p5904 | base-p17280 | 41551 | 41047 | -1.64% | -3.09% to +1.66% | -3.06% | -0.65% | -0.00% | -4.65% |
| 36 | 32 | base-p16304 | base-p12080 | 40781 | 40831 | -1.18% | -5.87% to +3.42% | -0.91% | -1.05% | +0.00% | -2.25% |
| 37 | 11 | base-p736 | base-p22496 | 41088 | 41196 | +1.03% | -1.96% to +2.57% | +2.13% | +0.17% | +0.00% | +0.10% |
| 40 | 36 | base-p22192 | base-p832 | 40880 | 40635 | -0.98% | -3.04% to +2.52% | -1.12% | -0.91% | +0.00% | -3.27% |
| 41 | 14 | base-p36880 | base-p27312 | 41047 | 40561 | +0.10% | -5.50% to +2.33% | +1.75% | -0.97% | -0.00% | +3.13% |
| 44 | 9 | base-p20288 | base-p7008 | 40442 | 40124 | -0.95% | -6.38% to +1.62% | -1.42% | -1.30% | -0.00% | -1.99% |
| 45 | 33 | base-p26944 | base-p39424 | 40455 | 40433 | -0.85% | -3.11% to +2.02% | -0.91% | -0.12% | -0.00% | -2.03% |
| 48 | 5 | base-p10304 | base-p12880 | 40582 | 41040 | +2.01% | -2.96% to +7.50% | +4.09% | +0.99% | -0.00% | +6.74% |
| 49 | 1 | base-p320 | base-p22848 | 40549 | 40772 | +1.63% | -2.42% to +2.72% | +3.34% | +0.36% | +0.00% | +3.06% |
| 52 | 20 | base-p31408 | base-p32768 | 40326 | 40502 | -0.78% | -2.10% to +10.01% | -1.59% | -0.19% | +0.00% | -3.82% |
| 53 | 17 | base-p36160 | base-p32064 | 41264 | 41453 | -0.74% | -22.17% to +2.22% | -2.22% | -0.72% | +0.00% | -3.64% |
| 56 | 10 | base-p30992 | base-p33184 | 41028 | 40776 | -0.23% | -4.26% to +2.07% | +0.39% | -0.58% | -0.00% | -2.79% |
| 57 | 37 | base-p32832 | base-p29200 | 40445 | 40321 | -0.32% | -7.55% to +2.97% | -0.09% | -0.40% | -0.00% | +1.96% |
| 60 | 29 | base-p16960 | base-p6256 | 40499 | 40545 | +0.17% | -2.24% to +2.52% | -0.00% | +0.37% | -0.00% | +4.63% |
| 61 | 7 | base-p35808 | base-p32464 | 41457 | 40526 | -1.74% | -6.29% to +1.13% | -2.23% | -0.98% | -0.00% | +0.38% |
| 64 | 24 | base-p37296 | base-p26896 | 41046 | 42048 | +2.35% | -0.75% to +4.38% | +3.44% | +0.23% | +0.00% | +1.54% |
| 65 | 31 | base-p1504 | base-p20528 | 41145 | 40788 | +0.20% | -13.52% to +5.47% | +0.23% | +0.18% | -0.00% | +3.02% |
| 68 | 4 | base-p40624 | base-p27648 | 40268 | 39993 | -0.89% | -4.27% to +2.82% | -0.70% | -0.47% | -0.00% | -6.25% |
| 69 | 15 | base-p10720 | base-p12528 | 40297 | 40439 | -0.49% | -5.42% to +15.71% | -2.12% | +0.17% | +0.00% | +2.07% |
| 72 | 8 | base-p5552 | base-p17680 | 40567 | 40400 | +0.18% | -5.19% to +3.17% | +0.34% | -0.25% | -0.00% | -2.31% |
| 73 | 35 | base-p11488 | base-p14400 | 40406 | 39930 | -0.97% | -2.28% to +4.44% | -2.58% | -0.73% | -0.00% | -2.47% |

## change-get: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -0.45% | -0.13% | -0.87% | -2.47% to +5.93% | +0.45% | +0.88% | +0.13% |
| cycles, user | -1.29% | -0.13% | -1.92% | -5.35% to +10.02% | +1.31% | +1.96% | +0.13% |
| cycles, kernel | -0.09% | +0.21% | -0.43% | -2.08% to +3.53% | +0.09% | +0.43% | -0.21% |
| instructions, user | +0.01% | +0.01% | +0.01% | +0.01% to +0.02% | -0.01% | -0.01% | -0.01% |
| L1 instruction-cache misses, user | -1.79% | -0.70% | -3.03% | -6.83% to +6.25% | +1.84% | +3.13% | +0.71% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 12 | base-p15536 | head-p15536 | 40663 | 40754 | -1.40% | -8.96% to +2.95% | -2.21% | -1.00% | +0.01% | -4.52% |
| 3 | 6 | base-p21008 | head-p21008 | 40511 | 40368 | -0.45% | -3.36% to +5.84% | -1.38% | -0.35% | +0.01% | +0.99% |
| 6 | 27 | base-p36576 | head-p36576 | 40988 | 41019 | +1.15% | -8.61% to +5.39% | +0.42% | +1.08% | +0.01% | -0.70% |
| 7 | 23 | base-p26592 | head-p26592 | 41288 | 41199 | -0.71% | -2.51% to +4.33% | -2.99% | -0.00% | +0.01% | -0.04% |
| 10 | 22 | base-p15888 | head-p15888 | 41504 | 41351 | -0.69% | -1.85% to +3.33% | +0.01% | -1.09% | +0.01% | -2.45% |
| 11 | 2 | base-p15120 | head-p15120 | 41675 | 42080 | +0.43% | -1.50% to +23.35% | +0.69% | +0.21% | +0.01% | -5.53% |
| 14 | 21 | base-p1088 | head-p1088 | 41116 | 40857 | -1.10% | -6.49% to +18.87% | -1.74% | -1.32% | +0.01% | +4.08% |
| 15 | 25 | base-p11072 | head-p11072 | 40835 | 41856 | +2.05% | -2.59% to +16.22% | +2.22% | +1.78% | +0.01% | +2.92% |
| 18 | 19 | base-p16608 | head-p16608 | 40615 | 40525 | -0.13% | -4.16% to +2.78% | -1.92% | +1.36% | +0.01% | -3.25% |
| 19 | 3 | base-p25824 | head-p25824 | 39825 | 39847 | +0.02% | -1.44% to +2.90% | -0.13% | +0.54% | +0.01% | +0.80% |
| 22 | 28 | base-p6320 | head-p6320 | 40976 | 40337 | -2.47% | -24.20% to +3.79% | -4.01% | -1.18% | +0.01% | -3.78% |
| 23 | 34 | base-p37648 | head-p37648 | 40828 | 40237 | -2.40% | -6.41% to -0.38% | -4.73% | -0.99% | +0.01% | -3.03% |
| 26 | 13 | base-p26176 | head-p26176 | 40844 | 40259 | -1.24% | -4.47% to +4.74% | -4.51% | +0.43% | +0.01% | -1.44% |
| 27 | 30 | base-p31760 | head-p31760 | 41867 | 40873 | -1.89% | -5.22% to +27.43% | -1.12% | -2.08% | +0.01% | -2.86% |
| 30 | 26 | base-p21776 | head-p21776 | 40766 | 40388 | -1.60% | -2.37% to +1.66% | -3.08% | -0.28% | +0.01% | +1.06% |
| 31 | 16 | base-p21424 | head-p21424 | 40608 | 40548 | +0.11% | -6.58% to +3.77% | -0.38% | +0.27% | +0.01% | -1.17% |
| 34 | 18 | base-p5904 | head-p5904 | 40280 | 40301 | -0.31% | -2.10% to +6.60% | -1.29% | +0.21% | +0.01% | -6.83% |
| 35 | 32 | base-p16304 | head-p16304 | 40614 | 40701 | -0.24% | -3.70% to +4.99% | +0.92% | -0.62% | +0.01% | -1.79% |
| 38 | 11 | base-p736 | head-p736 | 40966 | 40625 | -0.87% | -6.74% to +3.04% | -3.39% | +0.11% | +0.01% | -1.17% |
| 39 | 36 | base-p22192 | head-p22192 | 40740 | 40626 | +0.10% | -2.35% to +2.96% | -0.65% | +0.51% | +0.01% | -3.26% |
| 42 | 14 | base-p36880 | head-p36880 | 40047 | 40038 | -0.24% | -2.18% to +4.69% | +0.80% | -0.55% | +0.01% | -3.03% |
| 43 | 9 | base-p20288 | head-p20288 | 41321 | 40932 | -1.19% | -2.96% to +5.94% | -2.55% | -0.35% | +0.01% | -2.52% |
| 46 | 33 | base-p26944 | head-p26944 | 40646 | 40513 | +0.10% | -3.90% to +2.61% | -0.55% | +0.48% | +0.01% | -0.99% |
| 47 | 5 | base-p10304 | head-p10304 | 39992 | 40124 | +0.08% | -1.37% to +4.76% | -0.05% | +0.69% | +0.01% | +6.25% |
| 50 | 1 | base-p320 | head-p320 | 40395 | 39740 | -1.52% | -6.98% to +3.42% | -3.21% | -0.52% | +0.01% | +1.80% |
| 51 | 20 | base-p31408 | head-p31408 | 40648 | 39893 | -1.40% | -4.34% to +7.20% | -2.64% | -0.54% | +0.01% | -4.28% |
| 54 | 17 | base-p36160 | head-p36160 | 41354 | 40750 | -1.84% | -23.30% to +0.39% | -3.39% | -1.06% | +0.01% | +2.83% |
| 55 | 10 | base-p30992 | head-p30992 | 40619 | 40660 | +0.47% | -1.57% to +20.35% | +0.30% | +0.84% | +0.01% | -3.31% |
| 58 | 37 | base-p32832 | head-p32832 | 40376 | 40114 | -0.74% | -4.54% to +2.57% | -1.53% | -0.09% | +0.01% | -3.32% |
| 59 | 29 | base-p16960 | head-p16960 | 42939 | 46747 | +5.93% | -23.53% to +31.03% | +10.02% | +3.53% | +0.02% | +2.39% |
| 62 | 7 | base-p35808 | head-p35808 | 41411 | 40472 | -1.98% | -3.64% to -0.00% | -5.35% | -0.43% | +0.01% | -4.79% |
| 63 | 24 | base-p37296 | head-p37296 | 40493 | 40044 | -0.62% | -2.37% to +2.96% | -1.79% | -0.21% | +0.01% | -3.12% |
| 66 | 31 | base-p1504 | head-p1504 | 40319 | 39917 | -0.33% | -5.63% to +5.49% | -0.07% | -1.40% | +0.01% | +3.61% |
| 67 | 4 | base-p40624 | head-p40624 | 40879 | 39804 | -2.44% | -4.42% to +4.22% | -4.05% | -1.18% | +0.01% | -5.28% |
| 70 | 15 | base-p10720 | head-p10720 | 41324 | 41578 | +0.24% | -32.59% to +3.37% | +0.85% | -0.01% | +0.01% | +0.76% |
| 71 | 8 | base-p5552 | head-p5552 | 40509 | 40887 | -0.05% | -2.68% to +4.09% | +0.12% | +0.78% | +0.01% | -3.40% |
| 74 | 35 | base-p11488 | head-p11488 | 40329 | 40891 | +1.42% | -2.98% to +5.14% | +2.42% | +0.80% | +0.01% | +1.07% |

## Code aligned beyond 16 bytes

`base`: 3373 input sections in `.text` (by alignment: 1: 162, 4: 45, 8: 25, 16: 3141), 0 aligned beyond 16 bytes.

`head`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

