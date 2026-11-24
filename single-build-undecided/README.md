# What one placement against one has read, in the A/As design Choice 72 records

This backs the figures design Choice 72 gives for why one build does not decide a touched
workload on a setup with no recorded placement spread. No cycle was counted for it: `shares.mjs`
reads the counts four earlier runs recorded, from their evidence tags, and recomputes each
placement's median.

1. `shares.mjs`: the script. From a clone of corten-run/corten that has the evidence tags,
   `node shares.mjs medians.csv > shares.txt`.
2. `shares.txt`: what it printed.
3. `medians.csv`: the 400 placement medians it computed, as recorded and with the lists' labels
   swapped, so the shares can be counted again without the tags.

## What it reads

The eight A/As across placements under the tags the Choice cites: the first run's `plain` and
`kept` (`evidence/ee7b0b41`, 30 placements each), the second's `young` and `old`
(`evidence/0c0c599c`, 30 each), the third's three (`evidence/stage-header-checks-2002`, 60 each)
and the fourth's `old` (`evidence/placement-sizing-1999`, 100). Each placement is one commit
linked with one pad against the same commit linked with another, 8 recorded pairs of turns, every
turn on a fresh start. Its median is the median of the 8 per-pair changes in user plus kernel
cycles a request, as the kits compute it. The ranges and standard deviations in `shares.txt`
match the ones the Choice prints for each A/A.

Left out: the main-against-main source pads under `evidence/cheaper-ask-1925` (one start a
placement and no pairs, so no placement median of this kind), the copies of the first two runs'
results kept under `evidence/c448780e` and inside the fourth run's kit, and the two A/As of
corten-run/corten#1971's placement run, which the Choice on `main` does not record.

## What the numbers are

Of the 400 placement medians, 96 (24.0%) are at or above +1% and 94 (23.5%) at or below -1%, and
each of the eight A/As has both. With every median raised by a cost of +1%, +2% or +3%, 192
(48.0%), 96 (24.0%) and 34 (8.5%) are still under +1%. With the labels swapped the counts are
96, 94, 208, 98 and 35.

Each is a statement about a median of 8 pairs, one placement of a commit against one other
placement of it, compared with the +1% line itself.

## What they are not

They are not the single-build gate's rate of false passes or false misses. That gate reads the
one-sided 95% upper bound on the median of 100 pairs, the 59th of the 100 sorted per-pair
changes, on the two unpadded builds. Three things separate the two:

1. Eight pairs give a noisier median than 100 do, so part of the spread of these medians is the
   pairs' own and not placement. The fourth run estimated about 1.69% of its medians' 2.05%
   standard deviation from the pairs alone, under a decomposition it did not test.
2. The gate's bound sits above its median, so a share of medians under +1% overstates the share
   of bounds under it, and a share of medians at or above +1% understates the share of bounds
   there.
3. The placements are padded builds from declared lists, not the unpadded builds a single-build
   run compares, and not independent across A/As: the fourth run's first 30 pad pairs are the
   second run's, on the same base commit and workload.

No run has read 100 pairs on each of many placements of one commit, which is what a measured
rate would need. The only 100-pair comparisons of a commit with itself moved by a pad that the
repository holds are the two in design Choice 71, whose bounds were +1.62% and +1.39%.

The pooled row counts every placement once, so the A/A of 100 placements weighs most; the row
under it gives the mean of the eight A/As' own shares.
