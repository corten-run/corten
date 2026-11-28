# own-http1-on: `page` across placements, the gated run

Run 39867edd-6485-4e57-9608-c300760f348e, plan sha256 3ec67c264a0150f9e83d263665d81bcce12b18882e413d8bae52f62984b240b3, inputs sha256 9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base 2f8984ddce025c92bade4a6fafd21f4863d25085, head 0bcb3138c69f69dab997486c9af87a3660eb0ed4; CPU Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 28 placements, R = 8 recorded pairs in each after one that is not, 3 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112716. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 19th smallest of the 28 placement medians and the lower bound the 10th. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /page to the probe's configuration pages, no request header of its own: a staged page of about 12 KB, not compressed. Touched: with the switch on its connection is Corten's own, which is a small share of this request. Read for a reduction of 1%, the smallest reduction worth having, not a forecast, and held to +1% with no floor.

K = 28 is the smallest at which the sizing check passes from run a6871fd2-4ad8-4b4e-b957-c4349ff9159c: normal 5695 failing draws of 200000, smoothed 6114 failing draws of 200000, against at most 10000.

## Reading

Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.

| comparison | placements | median of medians | bound | lower bound | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-page, as recorded | 28 of 28 | +0.23% | +0.51% | -0.15% | |
| aa-page, labels swapped | | -0.23% | +0.16% | -0.51% | A/A: **resolved** |
| change-page | 28 of 28 | -3.17% | -2.62% | -3.70% | **meets +1%** |

The A/A's lowest and highest placement median as recorded: -2.05% to +2.16% (standard deviation 0.99%); the change's: -6.12% to -1.46%.

- The margin, `page`: **pass** (meets +1%).
- A CPU-cost win, a smallest worthwhile reduction of 1.00%: the change's bound -2.62% against -1.00%, the A/A's lower bound -0.15% as recorded and -0.51% with the labels swapped: **reduction established**.
- The spread: the plan declares that this A/A records a placement spread for the workload. It is complete and resolved, so it gives -2.05% to +2.16%, which is recorded only by a pull request that changes the Choice.

## aa-page: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | +0.23% | +0.51% | -0.15% | -2.05% to +2.16% | -0.23% | +0.16% | -0.51% |
| cycles, user | +0.13% | +0.39% | -0.55% | -3.32% to +5.28% | -0.08% | +0.57% | -0.37% |
| cycles, kernel | +0.19% | +0.34% | -0.02% | -1.12% to +1.75% | -0.19% | +0.02% | -0.33% |
| instructions, user | -0.00% | +0.00% | -0.00% | -0.00% to +0.00% | +0.00% | +0.00% | -0.00% |
| L1 instruction-cache misses, user | -0.38% | +0.78% | -1.05% | -4.71% to +5.14% | +0.38% | +1.06% | -0.77% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 23 | base-p26592 | base-p37584 | 58747 | 58403 | -0.63% | -3.57% to +4.36% | +0.44% | -0.95% | -0.00% | -0.61% |
| 4 | 13 | base-p26176 | base-p38000 | 57881 | 58128 | -0.02% | -3.53% to +2.05% | -0.67% | +0.34% | -0.00% | +1.49% |
| 5 | 8 | base-p5552 | base-p17680 | 58136 | 58333 | +0.61% | -3.51% to +3.84% | +0.39% | -0.06% | +0.00% | +0.06% |
| 8 | 11 | base-p736 | base-p22496 | 58163 | 58690 | +1.68% | -5.45% to +3.57% | +3.72% | +0.52% | -0.00% | +1.02% |
| 9 | 12 | base-p15536 | base-p11808 | 57573 | 58265 | +1.19% | -1.58% to +4.88% | +1.60% | +0.54% | +0.00% | -1.05% |
| 12 | 20 | base-p31408 | base-p32768 | 57288 | 58386 | +1.92% | -2.73% to +5.53% | +5.28% | +0.19% | +0.00% | +1.01% |
| 13 | 18 | base-p5904 | base-p17280 | 58447 | 57998 | -1.17% | -4.18% to +2.08% | -3.32% | +0.08% | -0.00% | -1.54% |
| 16 | 1 | base-p320 | base-p22848 | 57997 | 58040 | -0.60% | -8.50% to +4.10% | -0.55% | -0.63% | +0.00% | +1.21% |
| 17 | 3 | base-p25824 | base-p38336 | 57675 | 57078 | -0.93% | -3.77% to +2.11% | -2.46% | -0.02% | -0.00% | +1.70% |
| 20 | 26 | base-p21776 | base-p1440 | 57287 | 57954 | +0.19% | -4.58% to +3.86% | +0.37% | +0.55% | +0.00% | -2.82% |
| 21 | 10 | base-p30992 | base-p33184 | 57580 | 58345 | +0.27% | -4.54% to +2.49% | +0.84% | -0.07% | -0.00% | -2.71% |
| 24 | 15 | base-p10720 | base-p12528 | 57474 | 59103 | +2.16% | +0.40% to +4.58% | +4.01% | +1.75% | +0.00% | +5.14% |
| 25 | 2 | base-p15120 | base-p12160 | 58479 | 58266 | -0.87% | -5.00% to +2.60% | -1.93% | -1.04% | +0.00% | -3.04% |
| 28 | 22 | base-p15888 | base-p11408 | 58043 | 57188 | -2.05% | -4.42% to +4.31% | -2.63% | -1.04% | -0.00% | -1.57% |
| 29 | 25 | base-p11072 | base-p16224 | 58224 | 58332 | +0.30% | -1.58% to +3.19% | +0.24% | +0.54% | +0.00% | -3.18% |
| 32 | 6 | base-p21008 | base-p2192 | 58402 | 57772 | +0.61% | -4.83% to +7.97% | +0.19% | +0.82% | +0.00% | -0.33% |
| 33 | 27 | base-p36576 | base-p31712 | 58133 | 57675 | -0.15% | -2.75% to +4.37% | -0.43% | -0.34% | -0.00% | -0.06% |
| 36 | 24 | base-p37296 | base-p26896 | 58934 | 58237 | -0.92% | -2.80% to +8.07% | -0.45% | -1.12% | -0.00% | -0.43% |
| 37 | 21 | base-p1088 | base-p22096 | 57699 | 58189 | +0.30% | -3.39% to +4.56% | +0.31% | +0.23% | +0.00% | +4.44% |
| 40 | 5 | base-p10304 | base-p12880 | 57108 | 57159 | +0.51% | -6.08% to +4.88% | -0.09% | +0.05% | -0.00% | -0.76% |
| 41 | 9 | base-p20288 | base-p7008 | 57323 | 57282 | -0.02% | -2.04% to +3.22% | -1.00% | +0.53% | -0.00% | -0.72% |
| 44 | 17 | base-p36160 | base-p32064 | 57339 | 57721 | +0.56% | -9.43% to +4.52% | +1.66% | +0.20% | +0.00% | -4.12% |
| 45 | 7 | base-p35808 | base-p32464 | 57802 | 57133 | -1.06% | -7.15% to +4.32% | -2.04% | -0.87% | -0.00% | +1.88% |
| 48 | 19 | base-p16608 | base-p6592 | 57460 | 57899 | +0.69% | -6.14% to +2.60% | +0.07% | +0.31% | +0.00% | +1.63% |
| 49 | 16 | base-p21424 | base-p1840 | 58213 | 58775 | +0.27% | -2.07% to +2.67% | +0.69% | +0.04% | +0.00% | +0.12% |
| 52 | 14 | base-p36880 | base-p27312 | 57775 | 57724 | -0.12% | -4.79% to +10.91% | -0.73% | +0.45% | -0.00% | -1.13% |
| 53 | 28 | base-p6320 | base-p16928 | 58144 | 57755 | -0.51% | -4.09% to +4.68% | -1.18% | +0.32% | -0.00% | -4.71% |
| 56 | 4 | base-p40624 | base-p27648 | 57657 | 58275 | +1.50% | -2.96% to +3.11% | +2.58% | +0.56% | -0.00% | +0.78% |

## change-page: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -3.17% | -2.62% | -3.70% | -6.12% to -1.46% | +3.28% | +3.84% | +2.69% |
| cycles, user | -5.83% | -5.25% | -6.55% | -9.36% to -2.33% | +6.19% | +7.04% | +5.57% |
| cycles, kernel | -1.58% | -1.06% | -1.81% | -3.15% to +0.43% | +1.61% | +1.84% | +1.08% |
| instructions, user | -3.17% | -3.17% | -3.17% | -3.17% to -3.17% | +3.27% | +3.27% | +3.27% |
| L1 instruction-cache misses, user | -7.34% | -6.88% | -7.95% | -10.84% to -4.78% | +7.92% | +8.63% | +7.39% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 23 | base-p26592 | head-p26592 | 57827 | 56218 | -3.22% | -4.89% to +1.20% | -4.05% | -1.55% | -3.17% | -8.29% |
| 3 | 13 | base-p26176 | head-p26176 | 58921 | 56791 | -4.18% | -8.01% to +3.80% | -6.53% | -1.90% | -3.17% | -9.80% |
| 6 | 8 | base-p5552 | head-p5552 | 57889 | 56099 | -4.68% | -5.79% to +1.53% | -8.03% | -2.28% | -3.17% | -7.40% |
| 7 | 11 | base-p736 | head-p736 | 58671 | 55807 | -6.12% | -9.49% to +1.74% | -9.36% | -2.73% | -3.17% | -8.60% |
| 10 | 12 | base-p15536 | head-p15536 | 57373 | 56213 | -1.62% | -5.47% to +0.39% | -2.98% | -0.87% | -3.17% | -7.53% |
| 11 | 20 | base-p31408 | head-p31408 | 58080 | 56331 | -2.66% | -8.28% to -1.41% | -5.03% | -2.00% | -3.17% | -9.02% |
| 14 | 18 | base-p5904 | head-p5904 | 57498 | 55928 | -3.46% | -7.17% to -0.61% | -7.11% | -0.96% | -3.17% | -7.59% |
| 15 | 1 | base-p320 | head-p320 | 57935 | 56295 | -1.46% | -3.94% to +0.23% | -2.33% | -1.36% | -3.17% | -6.32% |
| 18 | 3 | base-p25824 | head-p25824 | 56937 | 55562 | -2.38% | -5.15% to +1.38% | -4.66% | -1.06% | -3.17% | -7.27% |
| 19 | 26 | base-p21776 | head-p21776 | 58052 | 56858 | -2.08% | -4.30% to -0.14% | -5.19% | +0.43% | -3.17% | -7.00% |
| 22 | 10 | base-p30992 | head-p30992 | 58613 | 56634 | -3.22% | -8.31% to -2.55% | -6.75% | -1.82% | -3.17% | -9.40% |
| 23 | 15 | base-p10720 | head-p10720 | 58222 | 55686 | -3.70% | -7.26% to -0.15% | -6.55% | -1.80% | -3.17% | -6.17% |
| 26 | 2 | base-p15120 | head-p15120 | 58004 | 57363 | -2.25% | -5.39% to -0.30% | -4.07% | -0.87% | -3.17% | -10.84% |
| 27 | 22 | base-p15888 | head-p15888 | 57914 | 56850 | -2.22% | -4.15% to +1.66% | -5.20% | -0.61% | -3.17% | -8.48% |
| 30 | 25 | base-p11072 | head-p11072 | 59599 | 57233 | -4.09% | -8.52% to +0.31% | -6.34% | -1.97% | -3.17% | -6.83% |
| 31 | 6 | base-p21008 | head-p21008 | 58419 | 56116 | -3.89% | -10.36% to +0.95% | -7.81% | -1.35% | -3.17% | -8.88% |
| 34 | 27 | base-p36576 | head-p36576 | 58551 | 56404 | -3.00% | -5.71% to -0.93% | -5.25% | -1.60% | -3.17% | -6.51% |
| 35 | 24 | base-p37296 | head-p37296 | 58557 | 56258 | -3.92% | -7.77% to -2.31% | -7.28% | -1.44% | -3.17% | -7.57% |
| 38 | 21 | base-p1088 | head-p1088 | 57576 | 56208 | -3.20% | -6.36% to +2.47% | -5.72% | -1.62% | -3.17% | -4.78% |
| 39 | 5 | base-p10304 | head-p10304 | 57672 | 55865 | -2.62% | -6.08% to -0.24% | -5.58% | -1.81% | -3.17% | -6.96% |
| 42 | 9 | base-p20288 | head-p20288 | 58053 | 56554 | -1.93% | -9.18% to +1.79% | -4.04% | -1.06% | -3.17% | -9.58% |
| 43 | 17 | base-p36160 | head-p36160 | 58595 | 56784 | -2.89% | -4.74% to -0.89% | -5.31% | -1.84% | -3.17% | -6.88% |
| 46 | 7 | base-p35808 | head-p35808 | 57865 | 56622 | -1.87% | -4.67% to +1.62% | -5.43% | -0.06% | -3.17% | -6.71% |
| 47 | 19 | base-p16608 | head-p16608 | 58374 | 55986 | -3.97% | -6.56% to -2.15% | -7.07% | -2.23% | -3.17% | -6.62% |
| 50 | 16 | base-p21424 | head-p21424 | 59368 | 56586 | -5.47% | -8.25% to -1.19% | -8.94% | -3.15% | -3.17% | -7.23% |
| 51 | 14 | base-p36880 | head-p36880 | 58776 | 55908 | -4.57% | -10.64% to -1.22% | -8.03% | -1.79% | -3.17% | -7.95% |
| 54 | 28 | base-p6320 | head-p6320 | 58259 | 56540 | -3.14% | -7.44% to -1.02% | -5.93% | -1.01% | -3.17% | -6.21% |
| 55 | 4 | base-p40624 | head-p40624 | 57864 | 56098 | -2.41% | -8.82% to +0.15% | -6.03% | +0.13% | -3.17% | -6.20% |

## Code aligned beyond 16 bytes

`base`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

`head`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

