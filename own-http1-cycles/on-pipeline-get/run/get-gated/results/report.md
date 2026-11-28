# own-http1-on: `get` across placements, the gated run

Run 453ebd2f-365f-4c0c-a590-f751e3db12ff, plan sha256 3ec67c264a0150f9e83d263665d81bcce12b18882e413d8bae52f62984b240b3, inputs sha256 9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base 2f8984ddce025c92bade4a6fafd21f4863d25085, head 0bcb3138c69f69dab997486c9af87a3660eb0ed4; CPU Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 30 placements, R = 8 recorded pairs in each after one that is not, 3 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112712. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 20th smallest of the 30 placement medians and the lower bound the 11th. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /baseline11?a=1&b=2 to the probe's configuration api, no request header of its own: a staged API route, typed query parameters in and a short answer out. Touched: with the switch on its connection is Corten's own. Read for a reduction of 3%, the smallest reduction worth having, not a forecast, and held to +1% with no floor.

K = 30 is the smallest at which the sizing check passes from run 60d44212-9b70-4bb6-b49f-99ae4d98d176: normal 6905 failing draws of 200000, smoothed 7995 failing draws of 200000, against at most 10000.

## Reading

Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.

| comparison | placements | median of medians | bound | lower bound | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-get, as recorded | 30 of 30 | +0.59% | +1.01% | -0.65% | |
| aa-get, labels swapped | | -0.58% | +0.66% | -0.99% | A/A: **not resolved** |
| change-get | 30 of 30 | -8.17% | -7.76% | -8.53% | **not resolved: does not pass** |

The A/A's lowest and highest placement median as recorded: -2.57% to +2.45% (standard deviation 1.38%); the change's: -9.53% to -5.34%.

- The margin, `get`: **not resolved** (not resolved: does not pass).
- A CPU-cost win, a smallest worthwhile reduction of 3.00%: the change's bound -7.76% against -3.00%, the A/A's lower bound -0.65% as recorded and -0.99% with the labels swapped: **not resolved: no win**.
- The spread: the plan declares that this A/A records a placement spread for the workload. It is not a complete, resolved A/A, so it records none.

## aa-get: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | +0.59% | +1.01% | -0.65% | -2.57% to +2.45% | -0.58% | +0.66% | -0.99% |
| cycles, user | +0.59% | +1.47% | -1.60% | -4.72% to +4.29% | -0.59% | +1.68% | -1.44% |
| cycles, kernel | +0.27% | +0.40% | -0.07% | -1.70% to +1.81% | -0.27% | +0.08% | -0.40% |
| instructions, user | +0.00% | +0.00% | -0.00% | -0.01% to +0.00% | -0.00% | +0.00% | -0.00% |
| L1 instruction-cache misses, user | -0.25% | +0.48% | -0.89% | -8.07% to +5.10% | +0.25% | +0.90% | -0.41% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 27 | base-p36576 | base-p31712 | 40071 | 40285 | +0.53% | -2.22% to +2.87% | +0.62% | +0.43% | +0.00% | -4.58% |
| 4 | 21 | base-p1088 | base-p22096 | 40567 | 41086 | +1.31% | -4.28% to +2.40% | +2.89% | +0.40% | +0.00% | -0.85% |
| 5 | 17 | base-p36160 | base-p32064 | 40150 | 40394 | +1.01% | -2.45% to +3.18% | +2.14% | -0.07% | +0.00% | -1.24% |
| 8 | 4 | base-p40624 | base-p27648 | 40844 | 40115 | -2.29% | -7.42% to +2.16% | -4.72% | -0.59% | +0.00% | -0.89% |
| 9 | 20 | base-p31408 | base-p32768 | 40108 | 40293 | -0.65% | -6.97% to +3.43% | -1.60% | +0.08% | +0.00% | +1.54% |
| 12 | 8 | base-p5552 | base-p17680 | 40499 | 40512 | -0.06% | -3.28% to +3.87% | -2.20% | +0.34% | -0.00% | -0.18% |
| 13 | 1 | base-p320 | base-p22848 | 40542 | 40197 | -1.01% | -5.25% to +2.93% | -3.17% | -0.15% | +0.00% | -1.20% |
| 16 | 16 | base-p21424 | base-p1840 | 40576 | 40962 | +0.86% | -10.87% to +2.83% | +0.72% | +0.68% | +0.00% | -3.09% |
| 17 | 22 | base-p15888 | base-p11408 | 40481 | 40562 | +0.09% | -6.00% to +4.44% | -0.55% | +0.28% | -0.00% | +0.80% |
| 20 | 14 | base-p36880 | base-p27312 | 41094 | 40736 | -0.95% | -4.28% to +5.23% | -2.89% | +0.08% | -0.00% | +0.26% |
| 21 | 7 | base-p35808 | base-p32464 | 40660 | 40878 | +2.45% | -5.59% to +5.01% | +3.37% | +1.81% | +0.00% | +3.19% |
| 24 | 2 | base-p15120 | base-p12160 | 40616 | 39995 | -0.85% | -4.59% to +2.89% | -4.44% | +0.50% | -0.00% | -1.34% |
| 25 | 15 | base-p10720 | base-p12528 | 41521 | 40116 | -2.57% | -6.78% to -0.43% | -4.43% | -1.70% | -0.00% | -8.07% |
| 28 | 23 | base-p26592 | base-p37584 | 39863 | 40562 | +0.72% | -1.43% to +6.27% | +3.24% | -0.19% | +0.00% | +0.55% |
| 29 | 12 | base-p15536 | base-p11808 | 40875 | 40291 | -1.44% | -4.00% to +1.21% | -1.59% | -1.21% | -0.00% | -0.30% |
| 32 | 19 | base-p16608 | base-p6592 | 41135 | 41435 | +0.73% | -6.02% to +8.01% | +4.16% | -1.04% | -0.00% | +1.55% |
| 33 | 29 | base-p16960 | base-p6256 | 40030 | 40873 | +1.58% | -1.51% to +5.40% | +3.29% | +0.40% | +0.00% | +5.10% |
| 36 | 18 | base-p5904 | base-p17280 | 40924 | 40629 | -1.87% | -3.21% to +2.78% | -2.62% | -0.45% | -0.00% | -0.31% |
| 37 | 6 | base-p21008 | base-p2192 | 39667 | 40400 | +1.85% | -7.53% to +4.36% | +3.38% | +0.26% | +0.00% | +1.83% |
| 40 | 10 | base-p30992 | base-p33184 | 40556 | 40956 | +1.22% | -2.61% to +3.27% | +2.04% | +0.46% | +0.00% | +3.10% |
| 41 | 5 | base-p10304 | base-p12880 | 40871 | 40987 | +1.09% | -7.76% to +6.61% | +1.47% | +0.90% | +0.00% | -2.33% |
| 44 | 11 | base-p736 | base-p22496 | 39811 | 40205 | +1.65% | -2.95% to +3.76% | +1.23% | +0.99% | +0.00% | +0.48% |
| 45 | 3 | base-p25824 | base-p38336 | 40064 | 40403 | +1.22% | -2.30% to +4.06% | +1.42% | +0.56% | +0.00% | +2.82% |
| 48 | 28 | base-p6320 | base-p16928 | 40133 | 40475 | +0.64% | -2.08% to +4.25% | +0.57% | +0.09% | -0.00% | -0.37% |
| 49 | 13 | base-p26176 | base-p38000 | 40668 | 40331 | -0.98% | -3.85% to +1.56% | -1.77% | -0.50% | -0.00% | +1.26% |
| 52 | 30 | base-p31760 | base-p36528 | 41152 | 39933 | -1.62% | -5.17% to -1.21% | -3.02% | -1.42% | -0.01% | -5.72% |
| 53 | 24 | base-p37296 | base-p26896 | 40559 | 40351 | -0.43% | -2.24% to +2.41% | -2.16% | +1.09% | +0.00% | +0.41% |
| 56 | 25 | base-p11072 | base-p16224 | 40151 | 39875 | -1.16% | -5.67% to +8.49% | -0.17% | -0.69% | -0.00% | -6.85% |
| 57 | 26 | base-p21776 | base-p1440 | 40679 | 40833 | +1.68% | -3.57% to +7.58% | +4.29% | +0.33% | +0.00% | -0.19% |
| 60 | 9 | base-p20288 | base-p7008 | 39835 | 40606 | +1.77% | +0.88% to +3.69% | +3.11% | +1.36% | -0.00% | -1.31% |

## change-get: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -8.17% | -7.76% | -8.53% | -9.53% to -5.34% | +8.89% | +9.34% | +8.41% |
| cycles, user | -13.32% | -12.75% | -13.53% | -15.56% to -7.25% | +15.36% | +15.68% | +14.62% |
| cycles, kernel | -5.52% | -5.37% | -5.82% | -7.45% to -3.30% | +5.84% | +6.18% | +5.67% |
| instructions, user | -7.27% | -7.27% | -7.27% | -7.27% to -7.27% | +7.84% | +7.84% | +7.84% |
| L1 instruction-cache misses, user | -14.70% | -14.19% | -15.41% | -18.00% to -11.57% | +17.24% | +18.22% | +16.54% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 27 | base-p36576 | head-p36576 | 40309 | 37125 | -7.66% | -16.12% to -6.99% | -12.87% | -5.39% | -7.27% | -15.41% |
| 3 | 21 | base-p1088 | head-p1088 | 39912 | 37406 | -6.91% | -12.40% to -2.77% | -11.01% | -3.30% | -7.27% | -15.51% |
| 6 | 17 | base-p36160 | head-p36160 | 40169 | 37220 | -7.65% | -9.41% to -1.35% | -13.46% | -4.47% | -7.27% | -14.36% |
| 7 | 4 | base-p40624 | head-p40624 | 40162 | 36656 | -8.61% | -10.87% to +11.17% | -13.85% | -5.59% | -7.27% | -14.73% |
| 10 | 20 | base-p31408 | head-p31408 | 40731 | 37255 | -8.03% | -10.83% to -7.31% | -12.97% | -6.16% | -7.27% | -13.47% |
| 11 | 8 | base-p5552 | head-p5552 | 39963 | 37234 | -7.40% | -9.54% to -5.35% | -11.73% | -5.29% | -7.27% | -15.62% |
| 14 | 1 | base-p320 | head-p320 | 40997 | 37022 | -9.27% | -11.57% to -6.19% | -14.08% | -6.06% | -7.27% | -18.00% |
| 15 | 16 | base-p21424 | head-p21424 | 39855 | 37002 | -8.08% | -12.18% to -5.14% | -12.30% | -6.26% | -7.27% | -15.97% |
| 18 | 22 | base-p15888 | head-p15888 | 40545 | 38566 | -5.34% | -10.75% to +0.52% | -7.25% | -4.82% | -7.27% | -13.22% |
| 19 | 14 | base-p36880 | head-p36880 | 40866 | 37053 | -8.15% | -12.95% to -1.87% | -14.78% | -5.45% | -7.27% | -16.23% |
| 22 | 7 | base-p35808 | head-p35808 | 40655 | 37194 | -8.40% | -14.23% to -5.18% | -13.44% | -5.76% | -7.27% | -13.31% |
| 23 | 2 | base-p15120 | head-p15120 | 40861 | 37217 | -9.53% | -11.26% to -7.22% | -15.56% | -6.14% | -7.27% | -14.67% |
| 26 | 15 | base-p10720 | head-p10720 | 41408 | 37636 | -8.82% | -10.53% to -5.00% | -15.51% | -5.42% | -7.27% | -17.19% |
| 27 | 23 | base-p26592 | head-p26592 | 40461 | 36925 | -8.18% | -12.12% to -3.22% | -11.58% | -6.18% | -7.27% | -14.19% |
| 30 | 12 | base-p15536 | head-p15536 | 40497 | 37562 | -7.50% | -11.82% to -2.14% | -12.75% | -5.30% | -7.27% | -11.57% |
| 31 | 19 | base-p16608 | head-p16608 | 40791 | 37183 | -8.85% | -12.09% to -5.81% | -15.12% | -4.80% | -7.27% | -13.08% |
| 34 | 29 | base-p16960 | head-p16960 | 40818 | 37113 | -9.33% | -12.28% to -4.59% | -14.95% | -6.18% | -7.27% | -15.57% |
| 35 | 18 | base-p5904 | head-p5904 | 40780 | 37299 | -7.89% | -11.68% to -4.33% | -12.66% | -5.73% | -7.27% | -12.76% |
| 38 | 6 | base-p21008 | head-p21008 | 40225 | 37198 | -8.47% | -9.40% to -3.90% | -13.97% | -5.14% | -7.27% | -13.59% |
| 39 | 10 | base-p30992 | head-p30992 | 40406 | 37548 | -7.57% | -9.52% to -1.96% | -12.38% | -5.15% | -7.27% | -15.53% |
| 42 | 5 | base-p10304 | head-p10304 | 40579 | 37079 | -8.50% | -11.08% to -6.50% | -13.46% | -5.42% | -7.27% | -16.29% |
| 43 | 11 | base-p736 | head-p736 | 40079 | 37408 | -7.42% | -9.52% to -5.44% | -11.49% | -5.37% | -7.27% | -12.48% |
| 46 | 3 | base-p25824 | head-p25824 | 40450 | 36852 | -8.71% | -12.68% to -6.42% | -13.41% | -6.78% | -7.27% | -15.33% |
| 47 | 28 | base-p6320 | head-p6320 | 40792 | 36908 | -8.60% | -12.06% to -7.69% | -12.90% | -6.92% | -7.27% | -14.33% |
| 50 | 13 | base-p26176 | head-p26176 | 40601 | 36801 | -9.31% | -11.91% to -6.22% | -13.23% | -7.45% | -7.27% | -13.47% |
| 51 | 30 | base-p31760 | head-p31760 | 40789 | 37132 | -8.87% | -11.32% to -5.92% | -15.12% | -5.82% | -7.27% | -13.43% |
| 54 | 24 | base-p37296 | head-p37296 | 40163 | 37573 | -6.65% | -10.71% to -2.88% | -10.43% | -4.39% | -7.27% | -14.73% |
| 55 | 25 | base-p11072 | head-p11072 | 40655 | 37090 | -8.53% | -12.48% to -3.17% | -13.53% | -5.99% | -7.27% | -14.29% |
| 58 | 26 | base-p21776 | head-p21776 | 40474 | 37568 | -7.76% | -15.49% to -5.75% | -11.98% | -5.59% | -7.27% | -15.26% |
| 59 | 9 | base-p20288 | head-p20288 | 39771 | 36986 | -7.70% | -10.20% to -3.79% | -13.86% | -4.58% | -7.27% | -15.48% |

## Code aligned beyond 16 bytes

`base`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

`head`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

