# trend-2026-11-26: `unstaged` across placements, the gated run

Run fb996431-964f-4429-8afe-056d8a47895e, plan sha256 f0bbf7474f7da005fa329efafc8a8d470522cc3da07ac545d652bf2e6030b8c8, inputs sha256 48bed34b7444dd0836ace5f3eb43f3626b02d1cc8462fd61b5e8e12763df8878 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base a833b4e3e55033c5fa179f50cb9291d190aeedfb, head 056aba61c56cce4b2672b8f299b4961e476654ef; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 28 placements, R = 8 recorded pairs in each after one that is not, 3 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112602. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 19th smallest of the 28 placement medians and the lower bound the 10th. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /unstaged to the probe's configuration plain, no request header of its own: a route that says unstaged, a short str out. In the trend because it is the least a request can be: the connection, the routing and the answer written, with no stage and no page, so a cost added around the handler is the largest share of this request that it is of any. Not read by it: a stage's cost, a page's rendering, and every path neither workload takes; two requests to one probe do not show every cost a change counts.

K = 28 is the smallest at which the sizing check passes from run a98fb839-0e01-4208-a65f-a45987900269: normal 5281 failing draws of 200000, smoothed 6126 failing draws of 200000, against at most 10000.

## Reading

Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.

| comparison | placements | median of medians | bound | lower bound | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-unstaged, as recorded | 28 of 28 | +0.08% | +0.47% | -0.61% | |
| aa-unstaged, labels swapped | | -0.08% | +0.61% | -0.46% | A/A: **resolved** |
| change-unstaged | 28 of 28 | -1.62% | -0.96% | -1.84% | **meets +1%** |

The A/A's lowest and highest placement median as recorded: -2.50% to +2.89% (standard deviation 1.37%); the change's: -3.51% to +0.74%.

- The margin, `unstaged`: **pass** (meets +1%).
- A CPU-cost win: the plan declares no reduction for this workload, so none is read.
- The spread: the plan declares that this A/A records no placement spread, so it records none whatever it read.

## aa-unstaged: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | +0.08% | +0.47% | -0.61% | -2.50% to +2.89% | -0.08% | +0.61% | -0.46% |
| cycles, user | +0.32% | +0.96% | -0.55% | -3.47% to +5.17% | -0.31% | +0.55% | -0.94% |
| cycles, kernel | +0.08% | +0.62% | -0.45% | -2.06% to +2.67% | -0.08% | +0.45% | -0.61% |
| instructions, user | -0.00% | +0.00% | -0.00% | -0.00% to +0.00% | +0.00% | +0.00% | -0.00% |
| L1 instruction-cache misses, user | +0.63% | +1.47% | -0.57% | -2.33% to +6.82% | -0.61% | +0.57% | -1.45% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 25 | base-p11072 | base-p16224 | 25133 | 24888 | -0.62% | -2.65% to +1.95% | -1.15% | -0.75% | +0.00% | +0.40% |
| 4 | 19 | base-p16608 | base-p6592 | 25255 | 25189 | +1.05% | -5.93% to +2.30% | +0.13% | +1.17% | +0.00% | +3.29% |
| 5 | 5 | base-p10304 | base-p12880 | 25018 | 25327 | +0.83% | -3.56% to +3.83% | +0.56% | +0.26% | +0.00% | -2.10% |
| 8 | 9 | base-p20288 | base-p7008 | 24842 | 25213 | +2.00% | -3.66% to +5.97% | +3.62% | +2.01% | +0.00% | -2.33% |
| 9 | 22 | base-p15888 | base-p11408 | 25409 | 25470 | +0.41% | -3.25% to +3.99% | +0.96% | -0.52% | +0.00% | +1.54% |
| 12 | 28 | base-p6320 | base-p16928 | 25419 | 25282 | -1.18% | -3.98% to +2.34% | -0.27% | -0.70% | -0.00% | -1.54% |
| 13 | 26 | base-p21776 | base-p1440 | 25204 | 24700 | -2.50% | -3.75% to +0.22% | -3.10% | -2.05% | -0.00% | +0.20% |
| 16 | 27 | base-p36576 | base-p31712 | 25108 | 24870 | -0.88% | -3.46% to +1.60% | -1.79% | -0.15% | -0.00% | -1.44% |
| 17 | 21 | base-p1088 | base-p22096 | 25274 | 25359 | -0.17% | -1.69% to +4.02% | +1.47% | -0.65% | -0.00% | -0.71% |
| 20 | 4 | base-p40624 | base-p27648 | 25345 | 24950 | -1.45% | -6.33% to +2.17% | -3.29% | +0.15% | -0.00% | -0.35% |
| 21 | 2 | base-p15120 | base-p12160 | 25573 | 25244 | -2.03% | -3.52% to +5.86% | -1.62% | -1.60% | -0.00% | +6.82% |
| 24 | 10 | base-p30992 | base-p33184 | 25330 | 25015 | -1.69% | -4.55% to +3.23% | -3.47% | -1.11% | -0.00% | -1.86% |
| 25 | 7 | base-p35808 | base-p32464 | 24766 | 25163 | +0.50% | -1.93% to +6.32% | +0.38% | +1.52% | +0.00% | +1.96% |
| 28 | 18 | base-p5904 | base-p17280 | 25156 | 25385 | +0.47% | -1.54% to +4.90% | +1.65% | +0.62% | +0.00% | +5.29% |
| 29 | 6 | base-p21008 | base-p2192 | 25567 | 25549 | -0.16% | -2.66% to +0.99% | +0.48% | -0.45% | -0.00% | -0.66% |
| 32 | 23 | base-p26592 | base-p37584 | 24906 | 25808 | +2.89% | -2.65% to +5.63% | +2.19% | +2.67% | +0.00% | +6.35% |
| 33 | 14 | base-p36880 | base-p27312 | 25254 | 25209 | -0.01% | -1.90% to +2.22% | +0.26% | -0.26% | -0.00% | +0.43% |
| 36 | 12 | base-p15536 | base-p11808 | 25533 | 25423 | -0.02% | -3.28% to +4.83% | -0.94% | +0.69% | -0.00% | +0.84% |
| 37 | 13 | base-p26176 | base-p38000 | 25016 | 25105 | +0.18% | -3.20% to +4.94% | +1.23% | -0.02% | -0.00% | +1.47% |
| 40 | 1 | base-p320 | base-p22848 | 25201 | 24812 | -1.87% | -3.68% to +0.80% | -0.55% | -2.06% | +0.00% | +1.11% |
| 41 | 3 | base-p25824 | base-p38336 | 24794 | 25278 | +2.80% | +0.45% to +8.44% | +3.87% | +2.31% | +0.00% | +3.46% |
| 44 | 15 | base-p10720 | base-p12528 | 24958 | 24947 | +0.38% | -1.83% to +8.21% | +0.97% | +0.74% | +0.00% | +0.96% |
| 45 | 24 | base-p37296 | base-p26896 | 24916 | 25027 | +0.58% | -1.98% to +2.23% | -0.03% | +0.44% | -0.00% | -0.57% |
| 48 | 20 | base-p31408 | base-p32768 | 24598 | 24499 | -0.92% | -3.52% to +3.10% | -1.81% | +0.01% | -0.00% | +4.99% |
| 49 | 17 | base-p36160 | base-p32064 | 25184 | 25075 | -0.61% | -3.74% to +6.66% | +0.48% | -1.41% | -0.00% | +1.12% |
| 52 | 8 | base-p5552 | base-p17680 | 24743 | 24935 | +1.17% | -2.05% to +1.72% | +1.59% | +0.76% | +0.00% | -1.65% |
| 53 | 11 | base-p736 | base-p22496 | 25077 | 25342 | +0.40% | -0.93% to +4.08% | -1.42% | +0.86% | +0.00% | -2.27% |
| 56 | 16 | base-p21424 | base-p1840 | 24802 | 25366 | +1.80% | -0.43% to +5.51% | +5.17% | +0.17% | +0.00% | +5.52% |

## change-unstaged: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -1.62% | -0.96% | -1.84% | -3.51% to +0.74% | +1.65% | +1.88% | +0.97% |
| cycles, user | -4.52% | -3.51% | -5.25% | -8.43% to -1.35% | +4.73% | +5.54% | +3.65% |
| cycles, kernel | +0.21% | +0.38% | -0.67% | -2.71% to +2.01% | -0.20% | +0.68% | -0.38% |
| instructions, user | -7.20% | -7.20% | -7.20% | -7.20% to -7.20% | +7.76% | +7.76% | +7.76% |
| L1 instruction-cache misses, user | -7.73% | -6.32% | -8.42% | -11.82% to -1.10% | +8.38% | +9.20% | +6.74% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 25 | base-p11072 | head-p11072 | 24880 | 25094 | +0.55% | -2.11% to +4.40% | -2.68% | +1.18% | -7.20% | -8.24% |
| 3 | 19 | base-p16608 | head-p16608 | 25110 | 24865 | -1.84% | -5.04% to +4.82% | -4.73% | -1.05% | -7.20% | -6.81% |
| 6 | 5 | base-p10304 | head-p10304 | 25414 | 24893 | -1.96% | -7.36% to +0.69% | -5.51% | -0.67% | -7.20% | -10.68% |
| 7 | 9 | base-p20288 | head-p20288 | 25036 | 25206 | +0.74% | -5.53% to +2.41% | -3.47% | +2.01% | -7.20% | -11.68% |
| 10 | 22 | base-p15888 | head-p15888 | 25392 | 24908 | -1.73% | -4.51% to +3.90% | -3.17% | -1.11% | -7.20% | -6.57% |
| 11 | 28 | base-p6320 | head-p6320 | 25038 | 24841 | -0.72% | -1.83% to +3.64% | -4.52% | +0.25% | -7.20% | -2.84% |
| 14 | 26 | base-p21776 | head-p21776 | 24849 | 24829 | +0.09% | -2.72% to +1.90% | -1.35% | +0.76% | -7.20% | -1.10% |
| 15 | 27 | base-p36576 | head-p36576 | 24890 | 24426 | -1.90% | -3.30% to -0.05% | -4.92% | -0.51% | -7.20% | -4.52% |
| 18 | 21 | base-p1088 | head-p1088 | 25239 | 24852 | -1.69% | -5.66% to +0.62% | -5.41% | -0.14% | -7.20% | -7.85% |
| 19 | 4 | base-p40624 | head-p40624 | 25055 | 24794 | -1.18% | -3.90% to +1.26% | -3.31% | -0.84% | -7.20% | -4.32% |
| 22 | 2 | base-p15120 | head-p15120 | 25434 | 24856 | -2.27% | -4.20% to +1.45% | -2.12% | -1.46% | -7.20% | -1.76% |
| 23 | 10 | base-p30992 | head-p30992 | 25154 | 24719 | -1.72% | -3.54% to +0.55% | -8.43% | +0.55% | -7.20% | -11.59% |
| 26 | 7 | base-p35808 | head-p35808 | 24732 | 24640 | -0.09% | -2.53% to +2.64% | -3.03% | +0.83% | -7.20% | -3.68% |
| 27 | 18 | base-p5904 | head-p5904 | 25229 | 25019 | -0.66% | -4.13% to +1.48% | -3.70% | +0.25% | -7.20% | -8.19% |
| 30 | 6 | base-p21008 | head-p21008 | 25445 | 24553 | -3.51% | -6.38% to +0.09% | -7.27% | -2.71% | -7.20% | -8.33% |
| 31 | 23 | base-p26592 | head-p26592 | 24810 | 24874 | +0.18% | -0.49% to +1.42% | -3.31% | +1.31% | -7.20% | -4.65% |
| 34 | 14 | base-p36880 | head-p36880 | 25036 | 24873 | -0.96% | -5.05% to +1.06% | -4.52% | +0.38% | -7.20% | -7.62% |
| 35 | 12 | base-p15536 | head-p15536 | 25231 | 25158 | -0.72% | -3.61% to +2.11% | -3.51% | +0.51% | -7.20% | -9.00% |
| 38 | 13 | base-p26176 | head-p26176 | 25159 | 24510 | -2.92% | -5.42% to +0.80% | -6.29% | -1.30% | -7.20% | -11.82% |
| 39 | 1 | base-p320 | head-p320 | 25098 | 24459 | -2.90% | -4.31% to -1.02% | -6.21% | -1.81% | -7.20% | -8.42% |
| 42 | 3 | base-p25824 | head-p25824 | 24907 | 24563 | -1.72% | -3.32% to -0.26% | -4.81% | +0.17% | -7.20% | -9.03% |
| 43 | 15 | base-p10720 | head-p10720 | 24864 | 24531 | -1.30% | -2.39% to -0.76% | -5.25% | +0.30% | -7.20% | -6.66% |
| 46 | 24 | base-p37296 | head-p37296 | 25125 | 24645 | -2.27% | -7.11% to +0.92% | -6.11% | -0.36% | -7.20% | -9.12% |
| 47 | 20 | base-p31408 | head-p31408 | 24818 | 24658 | -1.08% | -3.63% to +0.59% | -4.41% | +0.25% | -7.20% | -4.78% |
| 50 | 17 | base-p36160 | head-p36160 | 25063 | 24409 | -2.70% | -4.28% to +7.98% | -7.56% | -0.72% | -7.20% | -10.80% |
| 51 | 8 | base-p5552 | head-p5552 | 25203 | 24858 | -2.14% | -4.81% to +4.80% | -3.10% | -1.81% | -7.20% | -5.22% |
| 54 | 11 | base-p736 | head-p736 | 24980 | 24335 | -1.56% | -4.59% to +0.20% | -6.57% | +0.78% | -7.20% | -8.57% |
| 55 | 16 | base-p21424 | head-p21424 | 25085 | 25072 | -0.58% | -3.68% to +3.66% | -3.60% | +1.09% | -7.20% | -6.32% |

## Code aligned beyond 16 bytes

`base`: 2898 input sections in `.text` (by alignment: 1: 157, 4: 37, 8: 22, 16: 2682), 0 aligned beyond 16 bytes.

`head`: 3324 input sections in `.text` (by alignment: 1: 162, 4: 45, 8: 24, 16: 3093), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

