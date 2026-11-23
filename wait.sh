#!/bin/sh
# wait.sh: 1846r2's pass 3, how long a held value waits behind a kept page's brotli 5 job on this
# host (results/margin.md declares it and its bounds). run.sh runs it after passes 1 and 2; alone:
#   sh /m/1846r2/wait.sh
# bin/wait-base and bin/wait-head (build.sh: each tree's corten unit tests, release profile, with
# wait/probe_wait.rs as a child module of kept.rs) run the probe's one test, WAIT_ROUNDS (20)
# times each, alternated (base first in odd rounds, head first in even), each a fresh process of
# WAIT_REPS (21) repetitions, on CPUs 2, 4, 5 and 7 with jemalloc preloaded as the app's probe is.
# A process that fails, prints a panic, or gives a different number of samples than its pair stops
# the pass. Writes results/wait/<build>-<round>.tsv (round, then the probe's columns) and the
# summary (summary-wait.mjs) to results/summary-wait.txt.
set -eu
P=/m/1846r2; R=$P/results/wait
ROUNDS=${WAIT_ROUNDS:-20}; REPS=${WAIT_REPS:-21}
for b in base head; do [ -x $P/bin/wait-$b ] || { echo "no $P/bin/wait-$b: run build.sh"; exit 1; }; done
mkdir -p $R
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536'
r=1
while [ $r -le "$ROUNDS" ]; do
    if [ $((r % 2)) = 1 ]; then order="base head"; else order="head base"; fi
    for b in $order; do
        out=$R/$b-$r
        taskset -c 2,4,5,7 $J REPS=$REPS KEPT_SIZES=32768 HELD_SIZES=4096,79000 \
            $P/bin/wait-$b probe_wait::wait_probe --ignored --nocapture --test-threads 1 >$out.out 2>$out.err \
            || { tail -20 $out.err $out.out; echo "wait: $b round $r failed"; exit 1; }
        ! grep -q 'panicked at' $out.out $out.err || { grep -m5 'panicked at' $out.out $out.err; echo "wait: $b round $r panicked"; exit 1; }
        grep "^$b	" $out.out | sed "s/^/$r	/" >$out.tsv
        echo "wait: $b round $r: $(wc -l <$out.tsv) lines"
    done
    [ "$(cut -f3-5 $R/base-$r.tsv | grep -cv -e '^enc' -e '^heldown')" = "$(cut -f3-5 $R/head-$r.tsv | grep -cv -e '^enc' -e '^heldown')" ] \
        || { echo "wait: round $r: base and head gave different numbers of samples"; exit 1; }
    r=$((r + 1))
done
node $P/summary-wait.mjs $R >$P/results/summary-wait.txt
cat $P/results/summary-wait.txt
