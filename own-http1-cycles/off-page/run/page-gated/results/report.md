# own-http1-off: `page` across placements, the gated run

Run 6d92b172-19be-4d30-830a-0c99bd89b990, plan sha256 f0c299630cd32cea90a94e5f292b360a38b87c86fb446a3e9efd26f644aca225, inputs sha256 9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base e733f3d888450707c049a17cd6100c891966bc87, head 2f8984ddce025c92bade4a6fafd21f4863d25085; CPU Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz, kernel 6.12.117+deb13-amd64. K = 28 placements, R = 8 recorded pairs in each after one that is not, 3 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112703. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 19th smallest of the 28 placement medians and the lower bound the 10th. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /page to the probe's configuration pages, no request header of its own: a staged page of about 12 KB, not compressed. Touched: with the switch off a connection takes one more branch when it is accepted and a request takes the same path through hyper, but the compiled program is not the same (design Choice 78), so every request runs code this change compiles differently. Held to +1% with no floor; no reduction is declared. Named for the catalog's page target: both are a staged page through the same connection, service and router future, which is the code this change compiles differently.

K = 28 is the smallest at which the sizing check passes from run 4efc432c-218b-455c-90a6-58aeec5b548f: normal 5187 failing draws of 200000, smoothed 6741 failing draws of 200000, against at most 10000.

## Reading

Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.

| comparison | placements | median of medians | bound | lower bound | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-page, as recorded | 28 of 28 | +0.27% | +0.70% | -0.23% | |
| aa-page, labels swapped | | -0.27% | +0.23% | -0.69% | A/A: **resolved** |
| change-page | 28 of 28 | -0.60% | -0.41% | -0.95% | **meets +1%** |

The A/A's lowest and highest placement median as recorded: -1.85% to +3.31% (standard deviation 1.14%); the change's: -3.84% to +1.95%.

- The margin, `page`: **pass** (meets +1%).
- A CPU-cost win: the plan declares no reduction for this workload, so none is read.
- The spread: the plan declares that this A/A records a placement spread for the workload. It is complete and resolved, so it gives -1.85% to +3.31%, which is recorded only by a pull request that changes the Choice.

## aa-page: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | +0.27% | +0.70% | -0.23% | -1.85% to +3.31% | -0.27% | +0.23% | -0.69% |
| cycles, user | +0.18% | +0.57% | -0.44% | -2.68% to +4.24% | -0.17% | +0.45% | -0.55% |
| cycles, kernel | +0.14% | +0.50% | -0.04% | -1.25% to +2.85% | -0.14% | +0.04% | -0.50% |
| instructions, user | +0.00% | +0.00% | -0.00% | -0.00% to +0.00% | -0.00% | +0.00% | -0.00% |
| L1 instruction-cache misses, user | +0.87% | +1.53% | -1.48% | -4.78% to +5.67% | -0.85% | +1.50% | -1.50% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 13 | base-p26176 | base-p38000 | 55417 | 57024 | +3.31% | -2.10% to +12.24% | +3.69% | +2.85% | +0.00% | +2.53% |
| 4 | 15 | base-p10720 | base-p12528 | 56899 | 56611 | -0.49% | -7.95% to +2.99% | +0.31% | -1.25% | -0.00% | -4.78% |
| 5 | 12 | base-p15536 | base-p11808 | 56505 | 55934 | -0.11% | -2.67% to +1.33% | -1.75% | +0.46% | +0.00% | +1.43% |
| 8 | 14 | base-p36880 | base-p27312 | 55449 | 56353 | +1.11% | -1.88% to +2.44% | -0.72% | +0.69% | +0.00% | -0.51% |
| 9 | 9 | base-p20288 | base-p7008 | 56127 | 56022 | -0.93% | -7.56% to +4.43% | -2.68% | +0.14% | -0.00% | +1.29% |
| 12 | 20 | base-p31408 | base-p32768 | 56527 | 56062 | +0.29% | -5.44% to +2.90% | +1.38% | -0.94% | -0.00% | +5.32% |
| 13 | 10 | base-p30992 | base-p33184 | 54980 | 56055 | +2.70% | -2.28% to +4.16% | +4.24% | +0.68% | +0.00% | +4.54% |
| 16 | 25 | base-p11072 | base-p16224 | 56526 | 56503 | -0.23% | -4.54% to +3.88% | -1.36% | +0.01% | -0.00% | -1.85% |
| 17 | 22 | base-p15888 | base-p11408 | 55652 | 56883 | +1.62% | -1.58% to +3.76% | +1.78% | +1.15% | -0.00% | +1.89% |
| 20 | 28 | base-p6320 | base-p16928 | 56369 | 56870 | +0.98% | -1.21% to +3.50% | +1.61% | +0.73% | +0.00% | +5.37% |
| 21 | 2 | base-p15120 | base-p12160 | 57011 | 56438 | -1.24% | -6.30% to +1.22% | -2.27% | -0.57% | -0.00% | +0.80% |
| 24 | 4 | base-p40624 | base-p27648 | 56094 | 56692 | +1.05% | -1.72% to +3.71% | +1.52% | +0.77% | +0.00% | +5.67% |
| 25 | 24 | base-p37296 | base-p26896 | 56074 | 56226 | +0.29% | -2.83% to +2.24% | -0.35% | +0.29% | +0.00% | -2.50% |
| 28 | 26 | base-p21776 | base-p1440 | 56602 | 56989 | +0.70% | -2.77% to +3.24% | +0.06% | +0.44% | +0.00% | -2.39% |
| 29 | 19 | base-p16608 | base-p6592 | 55787 | 55897 | +1.17% | -2.08% to +4.26% | +2.15% | +1.39% | +0.00% | -0.58% |
| 32 | 1 | base-p320 | base-p22848 | 55531 | 55495 | +0.54% | -5.79% to +1.44% | +0.47% | -0.04% | +0.00% | +3.87% |
| 33 | 23 | base-p26592 | base-p37584 | 56620 | 57029 | +0.78% | -2.01% to +3.60% | +1.47% | +0.14% | +0.00% | -2.85% |
| 36 | 6 | base-p21008 | base-p2192 | 57011 | 56500 | -0.58% | -2.98% to +1.78% | -0.16% | -0.00% | -0.00% | +1.53% |
| 37 | 3 | base-p25824 | base-p38336 | 56478 | 56386 | -0.20% | -2.32% to +3.23% | +0.29% | +0.12% | +0.00% | -1.48% |
| 40 | 27 | base-p36576 | base-p31712 | 56802 | 56766 | -0.15% | -3.08% to +3.68% | +0.57% | +0.50% | +0.00% | +2.05% |
| 41 | 11 | base-p736 | base-p22496 | 56689 | 56340 | -0.85% | -2.79% to +2.68% | -1.44% | -0.42% | -0.00% | +1.16% |
| 44 | 7 | base-p35808 | base-p32464 | 57152 | 56701 | -0.44% | -4.24% to +2.89% | -0.35% | -0.50% | -0.00% | -4.74% |
| 45 | 8 | base-p5552 | base-p17680 | 57128 | 56233 | -1.85% | -3.65% to +0.32% | -2.67% | -0.98% | -0.00% | +0.30% |
| 48 | 5 | base-p10304 | base-p12880 | 56108 | 56262 | +0.30% | -1.08% to +2.37% | -0.44% | +0.94% | +0.00% | -2.55% |
| 49 | 21 | base-p1088 | base-p22096 | 56189 | 56576 | +0.26% | -8.05% to +2.33% | +1.43% | -0.32% | +0.00% | -3.82% |
| 52 | 17 | base-p36160 | base-p32064 | 56882 | 56399 | -0.72% | -1.84% to +0.98% | -0.84% | -0.47% | -0.00% | +0.93% |
| 53 | 18 | base-p5904 | base-p17280 | 55856 | 56372 | +0.88% | -6.45% to +3.79% | +0.34% | +0.71% | +0.00% | +4.50% |
| 56 | 16 | base-p21424 | base-p1840 | 56140 | 55857 | -0.88% | -3.64% to +1.84% | -1.08% | -1.05% | +0.00% | -4.03% |

## change-page: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -0.60% | -0.41% | -0.95% | -3.84% to +1.95% | +0.60% | +0.96% | +0.41% |
| cycles, user | -1.14% | -0.47% | -1.69% | -5.51% to +2.21% | +1.16% | +1.72% | +0.47% |
| cycles, kernel | -0.21% | +0.04% | -0.70% | -3.59% to +1.65% | +0.21% | +0.71% | -0.04% |
| instructions, user | +0.02% | +0.02% | +0.02% | +0.02% to +0.02% | -0.02% | -0.02% | -0.02% |
| L1 instruction-cache misses, user | -2.52% | -1.38% | -3.09% | -7.35% to +3.90% | +2.59% | +3.19% | +1.40% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 13 | base-p26176 | head-p26176 | 55180 | 56220 | +1.53% | -4.71% to +3.90% | +2.21% | +0.96% | +0.02% | +1.00% |
| 3 | 15 | base-p10720 | head-p10720 | 56261 | 55809 | -1.00% | -6.14% to +1.48% | -2.55% | -0.10% | +0.02% | -6.03% |
| 6 | 12 | base-p15536 | head-p15536 | 56182 | 55707 | +0.16% | -2.85% to +1.73% | +0.68% | -0.85% | +0.02% | -0.81% |
| 7 | 14 | base-p36880 | head-p36880 | 55979 | 55562 | -1.61% | -6.48% to +2.86% | -2.97% | -0.80% | +0.02% | -2.64% |
| 10 | 9 | base-p20288 | head-p20288 | 56172 | 56004 | -0.33% | -3.50% to +2.66% | -1.04% | +0.01% | +0.02% | -2.70% |
| 11 | 20 | base-p31408 | head-p31408 | 56901 | 56098 | -1.29% | -15.78% to +3.13% | -1.14% | -1.50% | +0.02% | -2.96% |
| 14 | 10 | base-p30992 | head-p30992 | 55610 | 56128 | +0.42% | -2.65% to +4.76% | +1.27% | +0.01% | +0.02% | +3.64% |
| 15 | 25 | base-p11072 | head-p11072 | 56631 | 55658 | -0.88% | -3.40% to +0.29% | -1.69% | -1.05% | +0.02% | -4.56% |
| 18 | 22 | base-p15888 | head-p15888 | 56453 | 55460 | -2.08% | -3.87% to +0.67% | -2.98% | -1.26% | +0.02% | -2.96% |
| 19 | 28 | base-p6320 | head-p6320 | 56396 | 56732 | +0.95% | -2.18% to +3.23% | +1.07% | +0.29% | +0.02% | +3.90% |
| 22 | 2 | base-p15120 | head-p15120 | 57299 | 56603 | -0.95% | -2.92% to +2.07% | -0.47% | -1.29% | +0.02% | -4.74% |
| 23 | 4 | base-p40624 | head-p40624 | 56508 | 55623 | -0.57% | -3.11% to +3.56% | -0.56% | -0.37% | +0.02% | +0.14% |
| 26 | 24 | base-p37296 | head-p37296 | 56335 | 55755 | -0.52% | -3.08% to +0.90% | -0.31% | -0.44% | +0.02% | +1.67% |
| 27 | 26 | base-p21776 | head-p21776 | 56422 | 55122 | -2.04% | -7.73% to +2.25% | -3.79% | +0.14% | +0.02% | -1.39% |
| 30 | 19 | base-p16608 | head-p16608 | 55048 | 55890 | -0.24% | -2.29% to +2.52% | -0.12% | -0.18% | +0.02% | -4.05% |
| 31 | 1 | base-p320 | head-p320 | 55196 | 56373 | +1.95% | -0.55% to +3.26% | +1.61% | +1.65% | +0.02% | -3.20% |
| 34 | 23 | base-p26592 | head-p26592 | 56320 | 56295 | -0.46% | -5.25% to +12.70% | -1.36% | +0.07% | +0.02% | -1.86% |
| 35 | 6 | base-p21008 | head-p21008 | 55790 | 55980 | +0.78% | -3.85% to +1.85% | -0.17% | +0.75% | +0.02% | +3.50% |
| 38 | 3 | base-p25824 | head-p25824 | 56898 | 55837 | -0.77% | -5.38% to +0.91% | -1.59% | +0.28% | +0.02% | -3.94% |
| 39 | 27 | base-p36576 | head-p36576 | 56213 | 55794 | -1.11% | -3.42% to +1.73% | -1.79% | -0.70% | +0.02% | -2.40% |
| 42 | 11 | base-p736 | head-p736 | 56507 | 56133 | -0.62% | -6.74% to +1.67% | -1.13% | +0.04% | +0.02% | -2.06% |
| 43 | 7 | base-p35808 | head-p35808 | 56086 | 56925 | +1.25% | -4.00% to +3.09% | +1.18% | +1.11% | +0.02% | -3.95% |
| 46 | 8 | base-p5552 | head-p5552 | 57027 | 55121 | -3.00% | -4.60% to -1.61% | -5.51% | -1.51% | +0.02% | -3.09% |
| 47 | 5 | base-p10304 | head-p10304 | 56017 | 55394 | -0.41% | -3.78% to +1.51% | -2.21% | +0.60% | +0.02% | -1.38% |
| 50 | 21 | base-p1088 | head-p1088 | 57242 | 55043 | -3.84% | -14.11% to -0.28% | -4.32% | -3.59% | +0.02% | -7.35% |
| 51 | 17 | base-p36160 | head-p36160 | 56436 | 55436 | -1.13% | -4.09% to +1.78% | -2.19% | -0.75% | +0.02% | -4.60% |
| 54 | 18 | base-p5904 | head-p5904 | 56390 | 56257 | -0.48% | -3.43% to +2.66% | -0.93% | -0.32% | +0.02% | -0.81% |
| 55 | 16 | base-p21424 | head-p21424 | 56511 | 55755 | -0.89% | -4.32% to +1.04% | -1.38% | -0.24% | +0.02% | +1.57% |

## Code aligned beyond 16 bytes

`base`: 3373 input sections in `.text` (by alignment: 1: 162, 4: 45, 8: 25, 16: 3141), 0 aligned beyond 16 bytes.

`head`: 3476 input sections in `.text` (by alignment: 1: 163, 4: 46, 8: 26, 16: 3241), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

