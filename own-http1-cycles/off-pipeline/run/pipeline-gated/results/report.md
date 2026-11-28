# own-http1-off: `pipeline` across placements, the gated run

Run c64e4983-d84e-4bb4-9bc9-d5c232101f39, plan sha256 f0c299630cd32cea90a94e5f292b360a38b87c86fb446a3e9efd26f644aca225, inputs sha256 9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base e733f3d888450707c049a17cd6100c891966bc87, head 2f8984ddce025c92bade4a6fafd21f4863d25085; CPU Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 30 placements, R = 8 recorded pairs in each after one that is not, 3 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112701. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 20th smallest of the 30 placement medians and the lower bound the 11th. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /pipeline to the probe's configuration api, no request header of its own: a route that says unstaged and answers 2 bytes, the shortest request the probe answers, so the connection's code is the largest share of it. Touched: with the switch off a connection takes one more branch when it is accepted and a request takes the same path through hyper, but the compiled program is not the same (design Choice 78), so every request runs code this change compiles differently. Held to +1% with no floor; no reduction is declared.

K = 30 is the smallest at which the sizing check passes from run e9c4450b-8d60-4058-b547-6d7d88ea6e44: normal 5548 failing draws of 200000, smoothed 6839 failing draws of 200000, against at most 10000.

## Reading

Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.

| comparison | placements | median of medians | bound | lower bound | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-pipeline, as recorded | 30 of 30 | -0.20% | +0.69% | -0.53% | |
| aa-pipeline, labels swapped | | +0.21% | +0.54% | -0.68% | A/A: **resolved** |
| change-pipeline | 30 of 30 | -0.44% | +0.06% | -0.75% | **meets +1%** |

The A/A's lowest and highest placement median as recorded: -2.32% to +3.59% (standard deviation 1.37%); the change's: -1.78% to +2.25%.

- The margin, `pipeline`: **pass** (meets +1%).
- A CPU-cost win: the plan declares no reduction for this workload, so none is read.
- The spread: the plan declares that this A/A records a placement spread for the workload. It is complete and resolved, so it gives -2.32% to +3.59%, which is recorded only by a pull request that changes the Choice.

## aa-pipeline: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -0.20% | +0.69% | -0.53% | -2.32% to +3.59% | +0.21% | +0.54% | -0.68% |
| cycles, user | +0.08% | +0.95% | -0.52% | -5.70% to +6.96% | -0.07% | +0.53% | -0.93% |
| cycles, kernel | +0.04% | +0.29% | -0.40% | -1.47% to +2.33% | -0.04% | +0.41% | -0.28% |
| instructions, user | -0.00% | +0.00% | -0.00% | -0.00% to +0.00% | +0.00% | +0.00% | -0.00% |
| L1 instruction-cache misses, user | +0.05% | +1.93% | -1.22% | -4.89% to +7.32% | -0.04% | +1.24% | -1.82% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 32873 | 34003 | +3.59% | -1.79% to +19.59% | +6.38% | +2.33% | +0.00% | +5.46% |
| 4 | 21 | base-p1088 | base-p22096 | 33799 | 33530 | -0.49% | -5.64% to +4.44% | -0.03% | -0.63% | -0.00% | +3.15% |
| 5 | 24 | base-p37296 | base-p26896 | 33346 | 34135 | +0.71% | -1.66% to +6.63% | +1.94% | +0.35% | +0.00% | +7.32% |
| 8 | 9 | base-p20288 | base-p7008 | 33376 | 33996 | +1.92% | +1.39% to +3.49% | +6.96% | +0.84% | +0.00% | +5.91% |
| 9 | 17 | base-p36160 | base-p32064 | 33956 | 33338 | -0.53% | -7.01% to +1.32% | -0.43% | -1.35% | +0.00% | +0.63% |
| 12 | 25 | base-p11072 | base-p16224 | 33826 | 33628 | -0.44% | -2.98% to +1.05% | -1.78% | +0.03% | -0.00% | +3.34% |
| 13 | 22 | base-p15888 | base-p11408 | 33823 | 33894 | +0.21% | -2.54% to +4.63% | -0.02% | +0.29% | +0.00% | +2.67% |
| 16 | 13 | base-p26176 | base-p38000 | 33382 | 33632 | +0.78% | -0.58% to +5.48% | +3.35% | -0.20% | +0.00% | +4.49% |
| 17 | 29 | base-p16960 | base-p6256 | 33409 | 33747 | +0.74% | -1.76% to +3.22% | +3.00% | +0.37% | +0.00% | +5.84% |
| 20 | 16 | base-p21424 | base-p1840 | 33686 | 32942 | -2.32% | -4.13% to +1.26% | -3.44% | -1.42% | -0.00% | +0.15% |
| 21 | 30 | base-p31760 | base-p36528 | 33282 | 33091 | -0.91% | -2.01% to +1.60% | -0.14% | -0.45% | +0.00% | -4.89% |
| 24 | 18 | base-p5904 | base-p17280 | 33161 | 33620 | +0.99% | -10.52% to +2.74% | +0.95% | +1.06% | +0.00% | -1.89% |
| 25 | 19 | base-p16608 | base-p6592 | 33276 | 33864 | +1.69% | -4.03% to +4.86% | +5.19% | +0.68% | +0.00% | +6.04% |
| 28 | 15 | base-p10720 | base-p12528 | 33205 | 32761 | -1.56% | -5.41% to +5.15% | -2.20% | -1.46% | -0.00% | -3.53% |
| 29 | 5 | base-p10304 | base-p12880 | 33175 | 33302 | +0.69% | -1.30% to +2.48% | +2.90% | +0.69% | -0.00% | -2.39% |
| 32 | 23 | base-p26592 | base-p37584 | 33650 | 33432 | -1.03% | -2.13% to +1.42% | -2.28% | -1.00% | -0.00% | -1.22% |
| 33 | 10 | base-p30992 | base-p33184 | 33395 | 33315 | +0.85% | -4.29% to +3.93% | +3.52% | +0.06% | +0.00% | -4.20% |
| 36 | 1 | base-p320 | base-p22848 | 33252 | 33337 | +0.29% | -2.79% to +1.31% | +0.67% | -0.20% | -0.00% | +1.93% |
| 37 | 8 | base-p5552 | base-p17680 | 33628 | 33259 | -1.08% | -1.88% to +0.94% | -0.52% | -0.69% | -0.00% | -0.49% |
| 40 | 4 | base-p40624 | base-p27648 | 33301 | 33500 | +0.87% | -2.27% to +2.57% | +0.79% | +0.54% | +0.00% | +2.60% |
| 41 | 12 | base-p15536 | base-p11808 | 33621 | 33585 | -0.43% | -2.79% to +2.62% | +0.19% | +0.14% | +0.00% | -2.26% |
| 44 | 27 | base-p36576 | base-p31712 | 33345 | 33425 | +0.49% | -2.47% to +2.05% | +0.35% | +0.17% | +0.00% | +0.38% |
| 45 | 14 | base-p36880 | base-p27312 | 33284 | 33233 | -0.47% | -1.89% to +2.78% | -3.62% | +0.28% | -0.00% | -1.99% |
| 48 | 11 | base-p736 | base-p22496 | 33617 | 33289 | +0.02% | -2.73% to +3.07% | +2.21% | -0.60% | -0.00% | +0.68% |
| 49 | 20 | base-p31408 | base-p32768 | 32910 | 33321 | +1.89% | -2.63% to +3.45% | +5.29% | +0.70% | +0.00% | -0.15% |
| 52 | 7 | base-p35808 | base-p32464 | 34122 | 33544 | -1.66% | -6.04% to +1.58% | -4.62% | -0.40% | -0.00% | -1.42% |
| 53 | 26 | base-p21776 | base-p1440 | 33970 | 33465 | -2.02% | -4.13% to +4.28% | -3.61% | -1.47% | -0.00% | -2.39% |
| 56 | 2 | base-p15120 | base-p12160 | 33717 | 33619 | -0.94% | -8.45% to +2.41% | -5.70% | +0.35% | -0.00% | -0.06% |
| 57 | 28 | base-p6320 | base-p16928 | 34096 | 33497 | -2.18% | -5.60% to -0.00% | -5.55% | -1.18% | -0.00% | -4.28% |
| 60 | 6 | base-p21008 | base-p2192 | 33770 | 33540 | -1.39% | -5.35% to +3.71% | -1.77% | -0.35% | -0.00% | -0.67% |

## change-pipeline: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -0.44% | +0.06% | -0.75% | -1.78% to +2.25% | +0.45% | +0.76% | -0.06% |
| cycles, user | -0.60% | +0.50% | -2.17% | -3.85% to +3.65% | +0.61% | +2.22% | -0.49% |
| cycles, kernel | -0.29% | -0.08% | -0.56% | -1.27% to +1.77% | +0.29% | +0.57% | +0.08% |
| instructions, user | +0.02% | +0.02% | +0.02% | +0.02% to +0.02% | -0.02% | -0.02% | -0.02% |
| L1 instruction-cache misses, user | -1.72% | -0.74% | -2.97% | -7.80% to +4.10% | +1.78% | +3.06% | +0.75% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 3 | base-p25824 | head-p25824 | 33456 | 33652 | +0.54% | -4.78% to +4.22% | +1.50% | -0.08% | +0.02% | +3.84% |
| 3 | 21 | base-p1088 | head-p1088 | 34006 | 33269 | -1.36% | -5.40% to +3.10% | -2.91% | -1.22% | +0.02% | +3.87% |
| 6 | 24 | base-p37296 | head-p37296 | 33773 | 33440 | -0.96% | -2.22% to +2.18% | -3.13% | -0.35% | +0.02% | -2.97% |
| 7 | 9 | base-p20288 | head-p20288 | 33256 | 33199 | -0.28% | -2.87% to +1.97% | +2.12% | -0.49% | +0.02% | +0.70% |
| 10 | 17 | base-p36160 | head-p36160 | 33862 | 33243 | -1.78% | -3.94% to +5.75% | -3.85% | -0.88% | +0.02% | -2.37% |
| 11 | 25 | base-p11072 | head-p11072 | 33665 | 33336 | -0.86% | -5.03% to +0.43% | -1.12% | -0.73% | +0.02% | -4.15% |
| 14 | 22 | base-p15888 | head-p15888 | 34030 | 33679 | -0.36% | -4.89% to +2.84% | -2.98% | -0.76% | +0.02% | -5.13% |
| 15 | 13 | base-p26176 | head-p26176 | 33287 | 34308 | +2.25% | -0.22% to +5.36% | +3.65% | +1.77% | +0.02% | +3.48% |
| 18 | 29 | base-p16960 | head-p16960 | 33629 | 34055 | +0.64% | -0.07% to +20.39% | +3.52% | +0.04% | +0.02% | +3.83% |
| 19 | 16 | base-p21424 | head-p21424 | 33613 | 33600 | +0.28% | -3.76% to +6.08% | +0.61% | +0.25% | +0.02% | -1.93% |
| 22 | 30 | base-p31760 | head-p31760 | 33545 | 33082 | -1.27% | -3.12% to +0.51% | -2.46% | -1.02% | +0.02% | -7.79% |
| 23 | 18 | base-p5904 | head-p5904 | 33272 | 33015 | +0.25% | -5.21% to +1.60% | +0.29% | +0.34% | +0.02% | -5.47% |
| 26 | 19 | base-p16608 | head-p16608 | 33481 | 33598 | -0.42% | -1.69% to +2.20% | +0.70% | -0.67% | +0.02% | -1.14% |
| 27 | 15 | base-p10720 | head-p10720 | 33461 | 33607 | +0.06% | -2.41% to +5.54% | +1.08% | -0.62% | +0.02% | +0.34% |
| 30 | 5 | base-p10304 | head-p10304 | 33325 | 33327 | -0.75% | -1.29% to +2.63% | +0.50% | -0.14% | +0.02% | -4.54% |
| 31 | 23 | base-p26592 | head-p26592 | 33342 | 33600 | +0.76% | -2.74% to +3.11% | +2.99% | +0.40% | +0.02% | +0.64% |
| 34 | 10 | base-p30992 | head-p30992 | 33626 | 33106 | -1.70% | -6.89% to +1.45% | -3.14% | -1.27% | +0.02% | -4.10% |
| 35 | 1 | base-p320 | head-p320 | 33557 | 33376 | -0.83% | -7.46% to +7.97% | -1.93% | -0.50% | +0.02% | -0.74% |
| 38 | 8 | base-p5552 | head-p5552 | 33423 | 33192 | -1.06% | -4.34% to +0.66% | -1.02% | -1.07% | +0.02% | -6.20% |
| 39 | 4 | base-p40624 | head-p40624 | 33045 | 33284 | +0.83% | -2.80% to +3.04% | +0.26% | +0.80% | +0.02% | -0.59% |
| 42 | 12 | base-p15536 | head-p15536 | 33498 | 33367 | -0.47% | -1.73% to +2.47% | +0.44% | -0.23% | +0.02% | -6.23% |
| 43 | 27 | base-p36576 | head-p36576 | 33651 | 33416 | +0.12% | -3.25% to +5.41% | +1.13% | +0.17% | +0.02% | -1.52% |
| 46 | 14 | base-p36880 | head-p36880 | 33076 | 32933 | -0.23% | -23.06% to +3.59% | -3.64% | -0.05% | +0.02% | -0.84% |
| 47 | 11 | base-p736 | head-p736 | 33582 | 33388 | -0.59% | -3.21% to +1.31% | -0.18% | -1.04% | +0.02% | +4.10% |
| 50 | 20 | base-p31408 | head-p31408 | 32836 | 33199 | +0.75% | -1.32% to +2.05% | +1.40% | +0.66% | +0.02% | -2.54% |
| 51 | 7 | base-p35808 | head-p35808 | 34162 | 33623 | -1.37% | -8.06% to +4.06% | -3.19% | -0.51% | +0.02% | -1.44% |
| 54 | 26 | base-p21776 | head-p21776 | 33835 | 34079 | +0.81% | -3.73% to +4.35% | -3.69% | +0.49% | +0.02% | +2.15% |
| 55 | 2 | base-p15120 | head-p15120 | 34008 | 33695 | -0.52% | -4.07% to +3.96% | -2.17% | -0.20% | +0.02% | -5.81% |
| 58 | 28 | base-p6320 | head-p6320 | 33593 | 33067 | -0.57% | -3.64% to +3.35% | -2.06% | -0.11% | +0.02% | -7.80% |
| 59 | 6 | base-p21008 | head-p21008 | 33761 | 33489 | -1.21% | -17.92% to +1.69% | -3.12% | -0.56% | +0.02% | -2.52% |

## Code aligned beyond 16 bytes

`base`: 3373 input sections in `.text` (by alignment: 1: 162, 4: 45, 8: 25, 16: 3141), 0 aligned beyond 16 bytes.

`head`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

