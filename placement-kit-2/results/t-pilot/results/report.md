# placement-kit-sizing-test: `plain` across placements, the pilot

Run 010ff976-c449-4c2c-b4d4-f048a8d8e243, plan sha256 af43b9a13aafbe4157984ac08b271eacab0b7e113a900027279317ff73619d40, inputs sha256 48bed34b7444dd0836ace5f3eb43f3626b02d1cc8462fd61b5e8e12763df8878 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base e2d0c464e7d7b56ea69b59c8fe7e8c9c2078d5bc; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 30 placements, R = 4 recorded pairs in each after one that is not, 2 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112401. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 20th smallest of the 30 placement medians and the lower bound the 11th. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: A TEST OF THE KIT, NOT A READING. GET /private to the example probe, main against itself: a pilot-shaped A/A run only so that pilot.mjs and plan.mjs --sized-from run on a host on real counts. No figure it gives is a measurement of anything, and no K it gives is a K of any plan.

## The spread

30 of 30 placements read. Placement medians: median +0.07%, standard deviation 2.09% (labels swapped 2.08%), lowest -3.85%, highest +4.16%. A pilot is read only for this spread: its bounds (+0.69% as recorded, +0.60% with the labels swapped) decide nothing.

## Sizing

- sizing from pilot-plain of run 010ff976-c449-4c2c-b4d4-f048a8d8e243 (plan af43b9a13aafbe4157984ac08b271eacab0b7e113a900027279317ff73619d40): 30 of 30 placements read, R = 4
- eligible: yes (every placement read with all its pairs: yes; lag-1 autocorrelation r1 -4.1e-2, p 0.967; Spearman's correlation with run order rho 0.096, p 0.612; zero inside -0.59% to +0.69%, the 11th to the 20th sorted median: yes)
- placement medians: standard deviation 2.09%; Shapiro-Wilk p 0.506, Anderson-Darling p 0.495; models kept: normal and smoothed
- K = 93, the smallest from 5 to 254 at which every kept model's count of failing draws is at most 10000 of 200000 (seed 1983): normal 9324 (the 55th), smoothed 4240 (the 55th); at the K's before it: 90: normal 14466 (the 54th), smoothed 7029 (the 54th); 91: normal 10742 (the 54th), smoothed 5036 (the 54th); 92: normal 12778 (the 55th), smoothed 6039 (the 55th)

## pilot-plain: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | +0.07% | +0.69% | -0.59% | -3.85% to +4.16% | -0.07% | +0.60% | -0.68% |
| cycles, user | -0.30% | +1.05% | -0.81% | -5.10% to +4.87% | +0.32% | +0.83% | -1.04% |
| cycles, kernel | +0.34% | +0.74% | -0.75% | -3.11% to +3.76% | -0.33% | +0.75% | -0.71% |
| instructions, user | +0.00% | +0.00% | -0.00% | -0.00% to +0.01% | -0.00% | +0.00% | -0.00% |
| L1 instruction-cache misses, user | +0.04% | +1.06% | -0.72% | -6.05% to +6.06% | -0.02% | +0.74% | -1.05% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 30 | base-p31760 | base-p36528 | 41794 | 42378 | +0.97% | -0.72% to +5.15% | +2.09% | +0.48% | +0.00% | +2.35% |
| 2 | 9 | base-p20288 | base-p7008 | 42209 | 41254 | -3.41% | -7.09% to -0.94% | -3.34% | -2.54% | -0.00% | -0.21% |
| 3 | 29 | base-p16960 | base-p6256 | 43281 | 42519 | -0.72% | -4.02% to +1.93% | -0.32% | -1.30% | -0.00% | -0.04% |
| 4 | 18 | base-p5904 | base-p17280 | 42206 | 43758 | +3.74% | -1.93% to +10.55% | +4.87% | +2.88% | +0.00% | +0.19% |
| 5 | 15 | base-p10720 | base-p12528 | 41748 | 42073 | +0.77% | -2.37% to +7.13% | +1.06% | +0.55% | +0.00% | -0.72% |
| 6 | 7 | base-p35808 | base-p32464 | 41186 | 42894 | +2.31% | +1.03% to +6.23% | +3.03% | +2.77% | +0.00% | +1.11% |
| 7 | 11 | base-p736 | base-p22496 | 41711 | 41651 | +0.40% | -6.10% to +2.23% | -0.30% | +0.74% | -0.00% | +1.39% |
| 8 | 26 | base-p21776 | base-p1440 | 42058 | 42906 | +2.40% | -0.15% to +6.02% | +0.90% | +3.57% | -0.00% | +5.13% |
| 9 | 25 | base-p11072 | base-p16224 | 42593 | 41912 | -1.89% | -3.52% to +2.00% | -1.44% | -1.14% | -0.00% | -0.74% |
| 10 | 19 | base-p16608 | base-p6592 | 42200 | 42188 | -0.03% | -2.57% to +3.37% | -0.98% | +0.72% | +0.00% | -4.15% |
| 11 | 12 | base-p15536 | base-p11808 | 43322 | 41783 | -3.85% | -4.96% to -1.22% | -5.10% | -3.11% | -0.00% | -6.05% |
| 12 | 21 | base-p1088 | base-p22096 | 42569 | 42282 | -0.67% | -3.64% to +1.43% | -0.58% | -0.75% | -0.00% | -1.22% |
| 13 | 27 | base-p36576 | base-p31712 | 41617 | 41371 | -0.59% | -2.25% to +1.89% | -0.83% | +0.54% | -0.00% | +0.13% |
| 14 | 22 | base-p15888 | base-p11408 | 42590 | 42337 | -0.59% | -1.44% to +1.02% | +0.36% | -1.40% | +0.00% | -0.21% |
| 15 | 14 | base-p36880 | base-p27312 | 43069 | 42082 | -2.28% | -3.06% to +1.28% | -1.79% | -2.66% | +0.00% | -3.35% |
| 16 | 20 | base-p31408 | base-p32768 | 42034 | 42087 | +0.31% | -3.44% to +1.77% | +1.05% | -0.82% | +0.00% | +1.92% |
| 17 | 6 | base-p21008 | base-p2192 | 42849 | 42519 | -0.17% | -4.82% to +0.94% | -0.34% | -0.55% | +0.00% | -0.72% |
| 18 | 1 | base-p320 | base-p22848 | 42769 | 42097 | -2.16% | -4.77% to -0.22% | -2.76% | -1.64% | -0.00% | -2.46% |
| 19 | 13 | base-p26176 | base-p38000 | 41880 | 43128 | +4.16% | -5.31% to +5.03% | +3.96% | +3.76% | +0.00% | +2.09% |
| 20 | 2 | base-p15120 | base-p12160 | 41899 | 42240 | +0.67% | +0.19% to +2.77% | +1.61% | +0.17% | +0.00% | +1.75% |
| 21 | 10 | base-p30992 | base-p33184 | 42056 | 42883 | +3.78% | +0.88% to +8.38% | +3.41% | +2.79% | +0.01% | +6.06% |
| 22 | 17 | base-p36160 | base-p32064 | 41737 | 41804 | +0.16% | -3.60% to +2.50% | -0.81% | +0.93% | -0.00% | +0.46% |
| 23 | 24 | base-p37296 | base-p26896 | 43234 | 42240 | -2.20% | -3.71% to -1.37% | -3.26% | -1.47% | +0.00% | -5.76% |
| 24 | 3 | base-p25824 | base-p38336 | 42522 | 41978 | -1.35% | -2.01% to +0.26% | -1.00% | -0.99% | -0.00% | -1.62% |
| 25 | 5 | base-p10304 | base-p12880 | 41296 | 42999 | +3.57% | +2.93% to +5.25% | +3.91% | +3.31% | +0.00% | +2.76% |
| 26 | 16 | base-p21424 | base-p1840 | 42459 | 42747 | -1.19% | -1.53% to +4.91% | -0.29% | -0.56% | -0.00% | +1.05% |
| 27 | 4 | base-p40624 | base-p27648 | 41343 | 41445 | -0.03% | -4.09% to +2.47% | -1.74% | +1.32% | +0.00% | -4.39% |
| 28 | 8 | base-p5552 | base-p17680 | 42236 | 43306 | +2.36% | -0.41% to +6.70% | +1.89% | +2.75% | +0.00% | +1.92% |
| 29 | 23 | base-p26592 | base-p37584 | 42104 | 42394 | +0.69% | -1.24% to +4.12% | +1.32% | +0.20% | +0.00% | -2.93% |
| 30 | 28 | base-p6320 | base-p16928 | 42199 | 42449 | +1.01% | -1.84% to +1.46% | +0.23% | +1.61% | +0.00% | +1.06% |

## Code aligned beyond 16 bytes

`base`: 3210 input sections in `.text` (by alignment: 1: 160, 4: 42, 8: 23, 16: 2985), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

