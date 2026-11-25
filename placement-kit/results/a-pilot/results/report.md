# placement-example: `plain` across placements, the pilot

**DRY RUN: a test of the scripts, read for nothing. No figure below is a measurement of anything.**

Run 2bd4a520-3d45-4e14-8f5c-c16ee958071c, plan sha256 92e3750eb702f886441586dc04df767c2d4e77d721d6b2719d32293827dc4a1c; base e2d0c464e7d7b56ea69b59c8fe7e8c9c2078d5bc; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 6 placements, R = 2 recorded pairs in each after one that is not, 1 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112401. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 6th smallest of the 6 placement medians and the lower bound the 1st. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /private to the probe's configuration plain, no request header of its own: the record page for one visitor, about 6 KB, not kept. An example: main against itself, so it reads no change.

## The spread

6 of 6 placements read. Placement medians: median -1.51%, standard deviation 3.06% (labels swapped 2.97%), lowest -3.34%, highest +5.32%. A pilot is read only for this spread: its bounds (+5.32% as recorded, +3.48% with the labels swapped) decide nothing.

## Sizing

- sizing from pilot-plain of run 2bd4a520-3d45-4e14-8f5c-c16ee958071c (plan 92e3750eb702f886441586dc04df767c2d4e77d721d6b2719d32293827dc4a1c): 6 of 6 placements read, R = 2
- a dry run sizes nothing

## pilot-plain: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -1.51% | +5.32% | -3.34% | -3.34% to +5.32% | +1.53% | +3.48% | -4.94% |
| cycles, user | -1.93% | +5.01% | -3.96% | -3.96% to +5.01% | +1.97% | +4.26% | -4.63% |
| cycles, kernel | -0.57% | +5.56% | -4.19% | -4.19% to +5.56% | +0.70% | +4.40% | -5.17% |
| instructions, user | -0.00% | +0.02% | -0.01% | -0.01% to +0.02% | +0.00% | +0.01% | -0.02% |
| L1 instruction-cache misses, user | -1.43% | +4.19% | -3.74% | -3.74% to +4.19% | +1.45% | +3.89% | -3.96% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 44837 | 44080 | -1.68% | -1.95% to -1.42% | -1.69% | -1.68% | -0.01% | -1.72% |
| 2 | 5 | base-p10304 | base-p12880 | 44081 | 44212 | +0.29% | -0.95% to +1.53% | +1.62% | -0.68% | +0.00% | -3.74% |
| 3 | 1 | base-p320 | base-p22848 | 45470 | 44557 | -1.94% | -6.01% to +2.13% | -3.96% | -0.47% | -0.01% | -2.61% |
| 4 | 2 | base-p15120 | base-p12160 | 44928 | 43426 | -3.34% | -4.65% to -2.04% | -2.17% | -4.19% | -0.00% | -1.13% |
| 5 | 4 | base-p40624 | base-p27648 | 44651 | 44056 | -1.33% | -2.01% to -0.66% | -3.10% | -0.01% | +0.00% | -0.94% |
| 6 | 6 | base-p21008 | base-p2192 | 44351 | 46715 | +5.32% | +1.71% to +8.94% | +5.01% | +5.56% | +0.02% | +4.19% |

## Code aligned beyond 16 bytes

`base`: 3210 input sections in `.text` (by alignment: 1: 160, 4: 42, 8: 23, 16: 2985), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

