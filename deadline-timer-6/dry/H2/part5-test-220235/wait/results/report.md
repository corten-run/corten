# The deadline's timer, part 1 (the pilot): cycles across placements, workload `wait`

**DRY RUN: a test of the scripts, not a measurement. No figure below is read.**

Run de3a2b38-4ceb-4ffc-9c33-13ca7088e5db, kit cycles-deadline-2029-3, plan sha256 29e60d68dc3e7a5c1cc92b9493f7a1cd103158e02944a6b120599e912588d874; CPU Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz, kernel 6.12.117+deb13-amd64. K = 3 placements, R = 2 recorded pairs in each after one unrecorded pair, 1 s turns, every turn on a fresh start, order from seed 7402. All figures are user+kernel cycles a request, B / A - 1 per pair; a placement's statistic is the median of its pairs.

No placement is run again, replaced or dropped: one that failed a check, was stopped at its time limit or has other than 2 pairs is left unread and its comparison has no bound (none here). Every recorded turn is one in which wrk reported no error of any kind (a turn with one fails its placement).

## The spread

3 of 3 placements read, 279643 requests in their recorded turns. Placement medians: median +4.41%, standard deviation +3.43% (labels swapped +3.16%), from +0.30% to +7.10%; 3 above zero. Within a placement the pooled standard deviation of the per-pair changes is +5.83%.

For the record, and deciding nothing (a pilot is not a gate's A/A): the - of the 3 sorted medians is - as recorded and - with the labels swapped.

## Eligibility

| condition | figure | holds |
| --- | --- | --- |
| every placement read with all 2 pairs | 3 of 3 | yes |
| lag-1 autocorrelation of the medians in run order, permutation p not under 0.05 | r1 -5.6e-1, p 0.660 | yes |
| Spearman's correlation of the medians with run order, permutation p not under 0.05 | rho 0.500, p 1.000 | yes |
| zero inside the interval from the - to the - sorted median | - to - | no interval |

**The pilot is not eligible.** Normality of the medians: Shapiro-Wilk p 0.772, Anderson-Darling p -; models kept: normal and smoothed.

## The K the plan's rule gives

Not worked out: a dry run sizes nothing.

## pilot-wait: every measure

| per request | median of medians | bound | lower bound | range of medians | swapped: median | swapped: bound | between sd | within sd | from within |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | +4.41% | - | - | +0.30% to +7.10% | -3.98% | - | +3.43% | +5.83% | +5.17% |
| cycles user | +4.99% | - | - | -0.61% to +8.69% | -4.46% | - | +4.69% | +9.36% | +8.29% |
| cycles kernel | +3.83% | - | - | +1.18% to +5.84% | -3.50% | - | +2.33% | +5.02% | +4.45% |
| instructions user | -0.17% | - | - | -0.22% to -0.09% | +0.17% | - | +0.07% | +0.16% | +0.14% |
| L1 icache misses user | +0.92% | - | - | +0.27% to +1.02% | -0.91% | - | +0.41% | +1.57% | +1.39% |

| seq | placement | A | B | A cycles/request | B cycles/request | median change | range | instructions:u | L1 icache misses:u |
| ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 1 | base-p320 | base-p22848 | 51211 | 53231 | +4.41% | -0.81% to +9.63% | -0.22% | +0.27% |
| 2 | 2 | base-p15120 | base-p12160 | 46342 | 46468 | +0.30% | -2.52% to +3.12% | -0.09% | +0.92% |
| 3 | 3 | base-p25824 | base-p38336 | 45763 | 49039 | +7.10% | +3.13% to +11.08% | -0.17% | +1.02% |

