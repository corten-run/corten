# placement-example: `plain` across placements, the gated run

**DRY RUN: a test of the scripts, read for nothing. No figure below is a measurement of anything.**

Run 731e86aa-2f69-4606-a10f-35c1da63e533, plan sha256 92e3750eb702f886441586dc04df767c2d4e77d721d6b2719d32293827dc4a1c; base e2d0c464e7d7b56ea69b59c8fe7e8c9c2078d5bc, head e2d0c464e7d7b56ea69b59c8fe7e8c9c2078d5bc; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 6 placements, R = 2 recorded pairs in each after one that is not, 1 s turns of `wrk -t2 -c64`, every turn on a freshly started binary, the order drawn from seed 2026112401. Figures are per request, B / A - 1 per pair; a placement's statistic is the median of its pairs; the bound is the 6th smallest of the 6 placement medians and the lower bound the 1st. Every recorded turn is one in which wrk reported no failed request and every counter ran 100% of the turn.

The workload as the plan declares it: GET /private to the probe's configuration plain, no request header of its own: the record page for one visitor, about 6 KB, not kept. An example: main against itself, so it reads no change.

K = 6 is the dry run's, not one the plan declares or the sizing check passed.

## Reading

Each threshold the plan declares for the workload is stated on its own. The margin is +1% with no floor.

| comparison | placements | median of medians | bound | lower bound | reading |
| --- | ---: | ---: | ---: | ---: | --- |
| aa-plain, as recorded | 6 of 6 | -1.27% | +1.81% | -3.25% | |
| aa-plain, labels swapped | | +1.29% | +3.39% | -1.77% | A/A: **not resolved** |
| change-plain | 6 of 6 | -0.04% | +1.23% | -1.39% | **not resolved: does not pass** |

The A/A's lowest and highest placement median as recorded: -3.25% to +1.81% (standard deviation 1.72%); the change's: -1.39% to +1.23%.

- The margin, `plain`: **not resolved** (not resolved: does not pass).
- A CPU-cost win: the plan declares no reduction for this workload, so none is read.
- The spread: the plan declares that this A/A records no placement spread, so it records none whatever it read.

## aa-plain: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -1.27% | +1.81% | -3.25% | -3.25% to +1.81% | +1.29% | +3.39% | -1.77% |
| cycles, user | -2.25% | +2.69% | -5.36% | -5.36% to +2.69% | +2.31% | +5.76% | -2.62% |
| cycles, kernel | -0.93% | +1.17% | -2.13% | -2.13% to +1.17% | +0.94% | +2.20% | -1.13% |
| instructions, user | -0.00% | +0.01% | -0.00% | -0.00% to +0.01% | +0.00% | +0.00% | -0.01% |
| L1 instruction-cache misses, user | -1.82% | +2.00% | -3.92% | -3.92% to +2.00% | +1.88% | +4.08% | -1.93% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 3 | base-p25824 | base-p38336 | 45872 | 44361 | -3.25% | -4.90% to -1.60% | -5.36% | -1.59% | -0.00% | -1.99% |
| 4 | 5 | base-p10304 | base-p12880 | 43613 | 44407 | +1.81% | +0.81% to +2.81% | +2.69% | +1.17% | +0.01% | +2.00% |
| 5 | 1 | base-p320 | base-p22848 | 44192 | 43116 | -2.43% | -3.36% to -1.50% | -2.83% | -2.13% | -0.00% | -1.96% |
| 8 | 2 | base-p15120 | base-p12160 | 44966 | 44396 | -1.26% | -2.18% to -0.35% | -1.53% | -1.07% | +0.01% | -1.69% |
| 9 | 4 | base-p40624 | base-p27648 | 44520 | 44107 | -0.93% | -2.09% to +0.23% | -2.55% | +0.29% | -0.00% | -3.92% |
| 12 | 6 | base-p21008 | base-p2192 | 44617 | 44047 | -1.28% | -1.81% to -0.75% | -1.95% | -0.78% | -0.00% | +0.19% |

## change-plain: every measure

| per request | median of medians | bound | lower bound | lowest and highest median | swapped: median | swapped: bound | swapped: lower bound |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| cycles, user and kernel | -0.04% | +1.23% | -1.39% | -1.39% to +1.23% | +0.07% | +1.41% | -1.22% |
| cycles, user | -0.52% | +0.64% | -1.26% | -1.26% to +0.64% | +0.52% | +1.28% | -0.51% |
| cycles, kernel | -0.06% | +1.79% | -1.54% | -1.54% to +1.79% | +0.07% | +1.56% | -1.76% |
| instructions, user | -0.00% | +0.01% | -0.00% | -0.00% to +0.01% | +0.00% | +0.00% | -0.01% |
| L1 instruction-cache misses, user | -0.44% | +2.12% | -3.59% | -3.59% to +2.12% | +0.44% | +3.76% | -1.66% |

| seq | placement | A | B | A cycles a request | B cycles a request | median change | lowest and highest pair | user | kernel | instructions | L1 icache misses |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2 | 3 | base-p25824 | head-p25824 | 44328 | 43859 | -1.06% | -1.16% to -0.95% | -0.41% | -1.54% | -0.00% | -1.52% |
| 3 | 5 | base-p10304 | head-p10304 | 44368 | 44915 | +1.23% | +0.98% to +1.49% | +0.46% | +1.79% | +0.01% | -0.06% |
| 6 | 1 | base-p320 | head-p320 | 44374 | 44350 | -0.05% | -0.90% to +0.80% | -0.63% | +0.39% | -0.00% | -3.59% |
| 7 | 2 | base-p15120 | head-p15120 | 43176 | 43159 | -0.04% | -1.38% to +1.30% | +0.64% | -0.51% | +0.00% | +2.12% |
| 10 | 4 | base-p40624 | head-p40624 | 43933 | 43926 | +0.05% | -3.61% to +3.72% | -0.96% | +0.82% | +0.01% | +0.53% |
| 11 | 6 | base-p21008 | head-p21008 | 44562 | 43941 | -1.39% | -1.87% to -0.92% | -1.26% | -1.49% | -0.00% | -0.82% |

## Code aligned beyond 16 bytes

`base`: 3210 input sections in `.text` (by alignment: 1: 160, 4: 42, 8: 23, 16: 2985), 0 aligned beyond 16 bytes.

`head`: 3210 input sections in `.text` (by alignment: 1: 160, 4: 42, 8: 23, 16: 2985), 0 aligned beyond 16 bytes.

Neither side has such a section: no second pad, and every placement passed the first point's check that every function moved by exactly its pad.

