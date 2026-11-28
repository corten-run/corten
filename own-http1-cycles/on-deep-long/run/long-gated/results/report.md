# own-http1-on: `long` across placements, the gated run

Run b8c929fc-2533-4c26-897d-a705ba2aae43, plan sha256 3ec67c264a0150f9e83d263665d81bcce12b18882e413d8bae52f62984b240b3, inputs sha256 9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base 2f8984ddce025c92bade4a6fafd21f4863d25085, head 0bcb3138c69f69dab997486c9af87a3660eb0ed4; CPU Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 37 placements, R = 8 recorded pairs in each after one that is not, 3 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112714. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 24th smallest of the 37 placement medians and the lower bound the 14th. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /unstaged11?a=1&b=2 to the probe's configuration api started with HOSTS=* (an app that answers to any host), with a Host line whose name is 4,095 a and one _ and has no port: a route that says unstaged, with a head longer than the 2,560 bytes of the own connection's first read and shorter than the 8,192 of hyper's. Touched, and declared as expected to cost more with the switch on: bench/request-cost counts 8.0% more instructions on its case unstaged-any-long (design Choice 78), which this request is but for the port after the name. Read for the margin, +1% with no floor, so that the run shows what that cost is in cycles; a miss on it is a known cost of the opt-in and not a surprise. No reduction is declared.

K = 37 is the smallest at which the sizing check passes from run b8674708-1d5c-4d47-a95e-ff004518ca6a: normal 7042 failing draws of 200000, smoothed 6402 failing draws of 200000, against at most 10000.

## Reading

Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.

| comparison | placements | median of medians | bound | lower bound | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-long, as recorded | 37 of 37 | +0.01% | +0.21% | -0.30% | |
| aa-long, labels swapped | | -0.01% | +0.30% | -0.21% | A/A: **resolved** |
| change-long | 37 of 37 | -4.98% | -4.52% | -5.30% | **meets +1%** |

The A/A's lowest and highest placement median as recorded: -2.87% to +2.26% (standard deviation 1.11%); the change's: -6.42% to -2.16%.

- The margin, `long`: **pass** (meets +1%).
- A CPU-cost win: the plan declares no reduction for this workload, so none is read.
- The spread: the plan declares that this A/A records a placement spread for the workload. It is complete and resolved, so it gives -2.87% to +2.26%, which is recorded only by a pull request that changes the Choice.

## aa-long: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | +0.01% | +0.21% | -0.30% | -2.87% to +2.26% | -0.01% | +0.30% | -0.21% |
| cycles, user | +0.24% | +0.84% | -0.34% | -4.32% to +3.44% | -0.23% | +0.35% | -0.83% |
| cycles, kernel | -0.11% | +0.12% | -0.22% | -2.01% to +1.76% | +0.11% | +0.23% | -0.12% |
| instructions, user | -0.00% | +0.00% | -0.00% | -0.00% to +0.00% | +0.00% | +0.00% | -0.00% |
| L1 instruction-cache misses, user | +0.12% | +1.03% | -1.20% | -6.69% to +4.43% | -0.12% | +1.22% | -1.02% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 7 | base-p35808 | base-p32464 | 43523 | 43305 | -0.19% | -2.15% to +12.43% | +1.75% | -0.13% | -0.00% | -2.10% |
| 4 | 5 | base-p10304 | base-p12880 | 43726 | 43990 | +0.30% | -6.02% to +4.67% | +1.60% | -0.11% | +0.00% | -4.66% |
| 5 | 35 | base-p11488 | base-p14400 | 43259 | 43088 | -0.66% | -4.32% to +2.83% | +0.92% | -0.50% | -0.00% | +3.36% |
| 8 | 17 | base-p36160 | base-p32064 | 43822 | 43515 | -0.86% | -7.31% to +5.16% | -1.06% | -0.29% | -0.00% | +1.62% |
| 9 | 8 | base-p5552 | base-p17680 | 42520 | 42920 | -0.07% | -4.04% to +9.61% | +0.24% | -0.22% | -0.00% | +3.12% |
| 12 | 22 | base-p15888 | base-p11408 | 43477 | 43565 | +0.42% | -6.72% to +2.85% | +0.57% | +0.51% | +0.00% | +3.02% |
| 13 | 13 | base-p26176 | base-p38000 | 43509 | 42105 | -2.87% | -5.09% to -0.75% | -4.32% | -1.55% | -0.00% | -2.60% |
| 16 | 19 | base-p16608 | base-p6592 | 43453 | 44252 | +1.68% | -1.64% to +3.95% | +2.46% | +1.08% | +0.00% | +4.43% |
| 17 | 28 | base-p6320 | base-p16928 | 42772 | 43327 | +1.32% | -1.81% to +3.70% | +1.79% | +1.54% | +0.00% | +2.93% |
| 20 | 9 | base-p20288 | base-p7008 | 43867 | 44106 | -0.30% | -14.11% to +5.85% | -0.47% | -0.02% | +0.00% | +0.15% |
| 21 | 30 | base-p31760 | base-p36528 | 43186 | 43454 | -0.39% | -4.47% to +3.65% | -0.35% | +0.58% | -0.00% | -6.61% |
| 24 | 11 | base-p736 | base-p22496 | 42939 | 43590 | +2.26% | -9.00% to +6.02% | +3.44% | +1.52% | +0.00% | +0.99% |
| 25 | 37 | base-p32832 | base-p29200 | 42967 | 43262 | +0.71% | -4.03% to +11.78% | +1.74% | +0.55% | -0.00% | -1.06% |
| 28 | 34 | base-p37648 | base-p27008 | 42919 | 43155 | +0.13% | -1.15% to +3.91% | -1.39% | +0.77% | +0.00% | +3.55% |
| 29 | 1 | base-p320 | base-p22848 | 43465 | 43309 | -0.28% | -5.08% to +1.98% | -0.52% | -0.27% | -0.00% | -0.49% |
| 32 | 10 | base-p30992 | base-p33184 | 43698 | 43480 | -0.86% | -2.01% to +4.05% | -0.18% | -0.65% | -0.00% | +0.10% |
| 33 | 23 | base-p26592 | base-p37584 | 43908 | 43415 | -0.62% | -15.94% to +6.76% | +0.40% | -1.13% | +0.00% | -1.90% |
| 36 | 29 | base-p16960 | base-p6256 | 43740 | 43660 | +1.81% | -4.18% to +3.43% | +3.11% | +0.65% | +0.00% | -2.41% |
| 37 | 14 | base-p36880 | base-p27312 | 43290 | 43127 | +0.38% | -9.18% to +4.95% | +1.02% | -0.13% | -0.00% | -3.88% |
| 40 | 4 | base-p40624 | base-p27648 | 43453 | 42876 | -1.95% | -3.17% to +1.53% | -3.12% | -1.55% | -0.00% | +2.27% |
| 41 | 27 | base-p36576 | base-p31712 | 43516 | 42517 | -1.34% | -13.32% to +3.61% | -2.29% | -0.87% | -0.00% | -5.22% |
| 44 | 18 | base-p5904 | base-p17280 | 42687 | 42891 | +0.06% | -5.54% to +6.41% | -0.06% | +0.12% | -0.00% | +2.78% |
| 45 | 20 | base-p31408 | base-p32768 | 42736 | 43141 | +0.81% | -5.72% to +13.40% | +2.75% | -0.14% | +0.00% | +0.75% |
| 48 | 33 | base-p26944 | base-p39424 | 43145 | 42752 | -0.72% | -13.00% to +5.07% | -1.66% | +0.07% | -0.00% | -1.20% |
| 49 | 12 | base-p15536 | base-p11808 | 42764 | 42839 | +0.41% | -3.86% to +5.71% | +0.54% | +0.26% | -0.00% | -0.44% |
| 52 | 16 | base-p21424 | base-p1840 | 42236 | 43010 | +0.95% | -1.47% to +3.15% | +0.69% | +1.15% | +0.00% | +4.31% |
| 53 | 15 | base-p10720 | base-p12528 | 43556 | 43038 | -0.65% | -3.68% to +7.98% | -1.17% | -0.44% | -0.00% | -3.62% |
| 56 | 26 | base-p21776 | base-p1440 | 42963 | 41908 | -1.77% | -11.52% to +3.11% | -2.40% | -1.97% | -0.00% | -4.67% |
| 57 | 24 | base-p37296 | base-p26896 | 43087 | 43119 | +0.09% | -1.25% to +2.37% | -0.34% | +0.73% | +0.00% | +2.93% |
| 60 | 21 | base-p1088 | base-p22096 | 43023 | 42129 | -0.86% | -4.62% to +1.44% | -3.05% | -0.11% | +0.00% | -6.69% |
| 61 | 6 | base-p21008 | base-p2192 | 42975 | 43210 | +1.02% | -1.22% to +2.69% | +0.84% | +0.14% | -0.00% | +0.12% |
| 64 | 2 | base-p15120 | base-p12160 | 43928 | 43458 | -1.89% | -8.94% to +3.94% | -3.51% | -1.41% | +0.00% | +0.76% |
| 65 | 36 | base-p22192 | base-p832 | 43751 | 43773 | +0.21% | -5.29% to +15.34% | +1.31% | -2.01% | +0.00% | +1.03% |
| 68 | 25 | base-p11072 | base-p16224 | 43143 | 43042 | +0.09% | -2.52% to +1.02% | +0.06% | -0.66% | -0.00% | -3.41% |
| 69 | 3 | base-p25824 | base-p38336 | 42481 | 43210 | +1.69% | -6.54% to +6.10% | +1.43% | +1.76% | +0.00% | +3.08% |
| 72 | 31 | base-p1504 | base-p20528 | 43323 | 43139 | -0.16% | -6.64% to +5.49% | -0.26% | -0.10% | +0.00% | +3.17% |
| 73 | 32 | base-p16304 | base-p12080 | 42727 | 42821 | +0.01% | -1.00% to +2.45% | +0.96% | +0.03% | -0.00% | -1.40% |

## change-long: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -4.98% | -4.52% | -5.30% | -6.42% to -2.16% | +5.24% | +5.60% | +4.73% |
| cycles, user | -2.19% | -1.76% | -3.09% | -6.38% to +3.12% | +2.25% | +3.19% | +1.79% |
| cycles, kernel | -6.07% | -5.90% | -6.28% | -7.38% to -4.60% | +6.46% | +6.71% | +6.27% |
| instructions, user | +8.08% | +8.08% | +8.08% | +8.08% to +8.09% | -7.48% | -7.48% | -7.48% |
| L1 instruction-cache misses, user | -15.18% | -14.11% | -15.83% | -21.01% to -10.40% | +17.91% | +18.81% | +16.43% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 7 | base-p35808 | head-p35808 | 43194 | 41239 | -4.52% | -7.08% to +5.14% | -1.81% | -5.41% | +8.08% | -11.60% |
| 3 | 5 | base-p10304 | head-p10304 | 43420 | 41100 | -4.26% | -7.25% to +10.81% | -1.99% | -5.48% | +8.09% | -17.84% |
| 6 | 35 | base-p11488 | head-p11488 | 43355 | 41943 | -3.28% | -8.45% to +0.12% | +1.46% | -5.75% | +8.08% | -13.76% |
| 7 | 17 | base-p36160 | head-p36160 | 43225 | 42263 | -2.16% | -6.43% to +16.00% | +3.12% | -4.81% | +8.08% | -15.90% |
| 10 | 8 | base-p5552 | head-p5552 | 42819 | 41192 | -3.72% | -7.08% to -2.43% | -0.79% | -5.37% | +8.08% | -15.46% |
| 11 | 22 | base-p15888 | head-p15888 | 43480 | 41298 | -4.44% | -8.17% to -1.78% | -1.76% | -5.02% | +8.08% | -14.06% |
| 14 | 13 | base-p26176 | head-p26176 | 42736 | 40704 | -3.75% | -6.92% to +4.55% | +0.48% | -6.03% | +8.08% | -12.81% |
| 15 | 19 | base-p16608 | head-p16608 | 43407 | 41387 | -5.72% | -8.14% to -0.52% | -2.81% | -6.20% | +8.08% | -15.11% |
| 18 | 28 | base-p6320 | head-p6320 | 42871 | 40775 | -4.40% | -6.86% to -3.35% | -0.21% | -5.90% | +8.08% | -12.70% |
| 19 | 9 | base-p20288 | head-p20288 | 43778 | 41180 | -6.06% | -10.06% to -2.50% | -4.65% | -7.30% | +8.08% | -18.21% |
| 22 | 30 | base-p31760 | head-p31760 | 43642 | 41099 | -5.78% | -8.71% to +0.72% | -6.34% | -6.07% | +8.08% | -16.56% |
| 23 | 11 | base-p736 | head-p736 | 43082 | 41501 | -4.70% | -8.01% to -1.70% | -2.72% | -5.73% | +8.08% | -15.73% |
| 26 | 37 | base-p32832 | head-p32832 | 43347 | 40928 | -5.75% | -8.54% to -3.14% | -4.16% | -6.35% | +8.08% | -18.54% |
| 27 | 34 | base-p37648 | head-p37648 | 43652 | 41004 | -6.27% | -10.18% to -3.84% | -5.58% | -7.38% | +8.08% | -15.18% |
| 30 | 1 | base-p320 | head-p320 | 43240 | 41055 | -5.15% | -13.31% to -1.60% | -4.81% | -5.87% | +8.08% | -19.73% |
| 31 | 10 | base-p30992 | head-p30992 | 43511 | 41232 | -5.13% | -10.99% to -3.46% | -4.05% | -6.13% | +8.08% | -12.37% |
| 34 | 23 | base-p26592 | head-p26592 | 43642 | 42187 | -3.82% | -9.27% to +3.37% | -2.19% | -4.65% | +8.08% | -16.77% |
| 35 | 29 | base-p16960 | head-p16960 | 43197 | 40808 | -4.44% | -7.59% to +1.52% | -1.42% | -6.88% | +8.08% | -13.98% |
| 38 | 14 | base-p36880 | head-p36880 | 43786 | 41439 | -5.89% | -7.28% to -2.16% | -4.86% | -5.82% | +8.08% | -21.01% |
| 39 | 4 | base-p40624 | head-p40624 | 43342 | 40682 | -5.92% | -7.60% to +1.19% | -5.31% | -6.29% | +8.08% | -15.91% |
| 42 | 27 | base-p36576 | head-p36576 | 43197 | 40907 | -5.09% | -7.78% to +7.06% | -1.03% | -7.00% | +8.08% | -19.92% |
| 43 | 18 | base-p5904 | head-p5904 | 43646 | 40821 | -6.06% | -12.89% to -2.07% | -5.15% | -6.34% | +8.08% | -12.50% |
| 46 | 20 | base-p31408 | head-p31408 | 42845 | 40532 | -6.05% | -8.23% to -2.18% | -3.84% | -6.42% | +8.08% | -14.60% |
| 47 | 33 | base-p26944 | head-p26944 | 43070 | 41329 | -4.79% | -7.66% to -0.46% | -2.11% | -5.95% | +8.08% | -15.64% |
| 50 | 12 | base-p15536 | head-p15536 | 44418 | 42140 | -4.70% | -10.76% to -0.03% | -0.39% | -5.59% | +8.08% | -14.40% |
| 51 | 16 | base-p21424 | head-p21424 | 42872 | 40833 | -4.37% | -9.88% to -0.89% | -1.07% | -5.92% | +8.08% | -13.32% |
| 54 | 15 | base-p10720 | head-p10720 | 44097 | 41684 | -5.16% | -20.13% to -3.32% | -2.17% | -6.30% | +8.08% | -11.74% |
| 55 | 26 | base-p21776 | head-p21776 | 43035 | 40950 | -5.48% | -7.69% to -3.43% | -3.27% | -6.14% | +8.08% | -16.23% |
| 58 | 24 | base-p37296 | head-p37296 | 42993 | 41144 | -3.75% | -5.78% to -2.69% | -1.12% | -6.09% | +8.08% | -10.40% |
| 59 | 21 | base-p1088 | head-p1088 | 43118 | 40867 | -4.98% | -8.14% to -2.32% | -2.53% | -6.00% | +8.08% | -16.62% |
| 62 | 6 | base-p21008 | head-p21008 | 42499 | 41057 | -3.11% | -7.08% to -1.31% | -0.16% | -4.60% | +8.08% | -14.28% |
| 63 | 2 | base-p15120 | head-p15120 | 45814 | 41683 | -6.26% | -12.90% to -1.65% | -6.38% | -6.78% | +8.08% | -17.56% |
| 66 | 36 | base-p22192 | head-p22192 | 44126 | 40738 | -6.42% | -15.77% to -2.36% | -5.06% | -7.20% | +8.08% | -15.83% |
| 67 | 25 | base-p11072 | head-p11072 | 43105 | 40896 | -5.46% | -10.40% to -1.69% | -1.31% | -7.13% | +8.08% | -12.54% |
| 70 | 3 | base-p25824 | head-p25824 | 42599 | 40642 | -4.97% | -7.62% to -3.37% | -2.20% | -6.28% | +8.08% | -13.95% |
| 71 | 31 | base-p1504 | head-p1504 | 43133 | 41865 | -3.06% | -7.10% to +6.29% | +2.93% | -5.30% | +8.08% | -14.11% |
| 74 | 32 | base-p16304 | head-p16304 | 43112 | 40976 | -5.30% | -7.13% to -2.73% | -3.09% | -6.47% | +8.08% | -15.79% |

## Code aligned beyond 16 bytes

`base`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

`head`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

