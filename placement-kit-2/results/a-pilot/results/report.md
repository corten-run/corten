# placement-example: `plain` across placements, the pilot

**DRY RUN: a test of the scripts, read for nothing. No figure below is a measurement of anything.**

Run e63c1242-309b-4db2-8fd9-39f947c32fd3, plan sha256 92e3750eb702f886441586dc04df767c2d4e77d721d6b2719d32293827dc4a1c, inputs sha256 48bed34b7444dd0836ace5f3eb43f3626b02d1cc8462fd61b5e8e12763df8878 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base e2d0c464e7d7b56ea69b59c8fe7e8c9c2078d5bc; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 6 placements, R = 2 recorded pairs in each after one that is not, 1 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112401. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 6th smallest of the 6 placement medians and the lower bound the 1st. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /private to the probe's configuration plain, no request header of its own: the record page for one visitor, about 6 KB, not kept. An example: main against itself, so it reads no change.

## The spread

6 of 6 placements read. Placement medians: median +0.76%, standard deviation 2.03% (labels swapped 2.01%), lowest -1.95%, highest +3.17%. A pilot is read only for this spread: its bounds (+3.17% as recorded, +2.00% with the labels swapped) decide nothing.

## Sizing

- sizing from pilot-plain of run e63c1242-309b-4db2-8fd9-39f947c32fd3 (plan 92e3750eb702f886441586dc04df767c2d4e77d721d6b2719d32293827dc4a1c): 6 of 6 placements read, R = 2
- a dry run sizes nothing

## pilot-plain: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | +0.76% | +3.17% | -1.95% | -1.95% to +3.17% | -0.72% | +2.00% | -3.08% |
| cycles, user | +0.45% | +5.50% | -2.97% | -2.97% to +5.50% | -0.43% | +3.09% | -5.21% |
| cycles, kernel | +0.13% | +3.45% | -2.03% | -2.03% to +3.45% | -0.11% | +2.07% | -3.30% |
| instructions, user | +0.00% | +0.01% | -0.00% | -0.00% to +0.01% | -0.00% | +0.00% | -0.01% |
| L1 instruction-cache misses, user | +0.60% | +4.33% | -1.65% | -1.65% to +4.33% | -0.59% | +1.75% | -4.13% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 42146 | 42988 | +2.01% | +0.13% to +3.88% | +2.50% | +1.62% | +0.01% | +3.64% |
| 2 | 5 | base-p10304 | base-p12880 | 41560 | 42879 | +3.17% | +3.04% to +3.31% | +5.50% | +1.41% | +0.00% | +4.33% |
| 3 | 1 | base-p320 | base-p22848 | 42966 | 42301 | -1.55% | -1.77% to -1.32% | -0.91% | -2.03% | -0.00% | +0.40% |
| 4 | 2 | base-p15120 | base-p12160 | 41614 | 42189 | +1.38% | -0.18% to +2.94% | -1.20% | +3.45% | +0.01% | -1.65% |
| 5 | 4 | base-p40624 | base-p27648 | 42196 | 42239 | +0.13% | -1.77% to +2.03% | +1.82% | -1.17% | -0.00% | +0.80% |
| 6 | 6 | base-p21008 | base-p2192 | 43180 | 42334 | -1.95% | -2.89% to -1.02% | -2.97% | -1.16% | -0.00% | -0.84% |

## Code aligned beyond 16 bytes

`base`: 3210 input sections in `.text` (by alignment: 1: 160, 4: 42, 8: 23, 16: 2985), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

