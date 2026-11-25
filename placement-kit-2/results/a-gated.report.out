# placement-example: `plain` across placements, the gated run

**DRY RUN: a test of the scripts, read for nothing. No figure below is a measurement of anything.**

Run d03f131a-2dcd-4088-902b-166555650bad, plan sha256 92e3750eb702f886441586dc04df767c2d4e77d721d6b2719d32293827dc4a1c, inputs sha256 48bed34b7444dd0836ace5f3eb43f3626b02d1cc8462fd61b5e8e12763df8878 (the 3 files the plan names by path: the probe's, the request script and any expected answer, kept with these results); base e2d0c464e7d7b56ea69b59c8fe7e8c9c2078d5bc, head e2d0c464e7d7b56ea69b59c8fe7e8c9c2078d5bc; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 6 placements, R = 2 recorded pairs in each after one that is not, 1 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112401. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 6th smallest of the 6 placement medians and the lower bound the 1st. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /private to the probe's configuration plain, no request header of its own: the record page for one visitor, about 6 KB, not kept. An example: main against itself, so it reads no change.

K = 6 is the dry run's, not one the plan declares or the sizing check passed.

## Reading

Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.

| comparison | placements | median of medians | bound | lower bound | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-plain, as recorded | 6 of 6 | -1.20% | +3.52% | -2.76% | |
| aa-plain, labels swapped | | +1.24% | +2.84% | -3.37% | A/A: **not resolved** |
| change-plain | 6 of 6 | +1.36% | +2.80% | -1.54% | **not resolved: does not pass; K not checked by the kit** |

The A/A's lowest and highest placement median as recorded: -2.76% to +3.52% (standard deviation 2.23%); the change's: -1.54% to +2.80%.

- The margin, `plain`: **not resolved; K not checked by the kit** (not resolved: does not pass).
- A CPU-cost win: the plan declares no reduction for this workload, so none is read.
- The spread: the plan declares that this A/A records no placement spread, so it records none whatever it read.

## aa-plain: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -1.20% | +3.52% | -2.76% | -2.76% to +3.52% | +1.24% | +2.84% | -3.37% |
| cycles, user | -0.12% | +4.91% | -3.74% | -3.74% to +4.91% | +0.14% | +3.89% | -4.67% |
| cycles, kernel | -1.79% | +2.44% | -2.52% | -2.52% to +2.44% | +1.84% | +2.72% | -2.33% |
| instructions, user | -0.01% | +0.00% | -0.01% | -0.01% to +0.00% | +0.01% | +0.01% | -0.00% |
| L1 instruction-cache misses, user | -1.51% | +3.90% | -4.31% | -4.31% to +3.90% | +1.56% | +4.62% | -3.75% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 41679 | 41010 | -1.61% | -2.82% to -0.39% | -0.35% | -2.52% | -0.01% | -3.21% |
| 4 | 5 | base-p10304 | base-p12880 | 41049 | 42494 | +3.52% | +1.75% to +5.28% | +4.91% | +2.44% | +0.00% | +3.90% |
| 5 | 1 | base-p320 | base-p22848 | 42544 | 41368 | -2.76% | -2.97% to -2.56% | -3.74% | -1.98% | -0.01% | -0.94% |
| 8 | 2 | base-p15120 | base-p12160 | 41827 | 41489 | -0.80% | -2.08% to +0.48% | +0.23% | -1.59% | -0.01% | -1.70% |
| 9 | 4 | base-p40624 | base-p27648 | 41792 | 41588 | -0.48% | -1.56% to +0.60% | +0.12% | -0.93% | -0.00% | -1.32% |
| 12 | 6 | base-p21008 | base-p2192 | 42328 | 41444 | -2.08% | -4.78% to +0.62% | -1.86% | -2.24% | -0.00% | -4.31% |

## change-plain: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | +1.36% | +2.80% | -1.54% | -1.54% to +2.80% | -1.31% | +1.66% | -2.61% |
| cycles, user | +1.06% | +2.19% | -1.76% | -1.76% to +2.19% | -1.01% | +1.82% | -1.73% |
| cycles, kernel | +1.81% | +3.72% | -1.34% | -1.34% to +3.72% | -1.75% | +1.55% | -3.52% |
| instructions, user | +0.00% | +0.01% | -0.01% | -0.01% to +0.01% | -0.00% | +0.01% | -0.01% |
| L1 instruction-cache misses, user | +0.03% | +3.17% | -2.25% | -2.25% to +3.17% | -0.02% | +2.30% | -3.00% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 3 | base-p25824 | head-p25824 | 41439 | 42554 | +2.80% | -0.73% to +6.33% | +1.66% | +3.72% | +0.00% | +1.03% |
| 3 | 5 | base-p10304 | head-p10304 | 41565 | 40896 | -1.54% | -4.59% to +1.51% | -1.76% | -1.34% | -0.01% | -2.25% |
| 6 | 1 | base-p320 | head-p320 | 42191 | 42603 | +0.97% | +0.71% to +1.24% | +0.76% | +1.15% | -0.01% | -0.08% |
| 7 | 2 | base-p15120 | head-p15120 | 41670 | 41795 | +0.30% | -0.26% to +0.86% | -1.33% | +1.59% | +0.00% | -0.26% |
| 10 | 4 | base-p40624 | head-p40624 | 41531 | 42247 | +1.74% | -0.61% to +4.09% | +1.36% | +2.03% | -0.00% | +3.17% |
| 11 | 6 | base-p21008 | head-p21008 | 42713 | 43799 | +2.65% | -2.51% to +7.81% | +2.19% | +3.02% | +0.01% | +0.14% |

## Code aligned beyond 16 bytes

`base`: 3210 input sections in `.text` (by alignment: 1: 160, 4: 42, 8: 23, 16: 2985), 0 aligned beyond 16 bytes.

`head`: 3210 input sections in `.text` (by alignment: 1: 160, 4: 42, 8: 23, 16: 2985), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

