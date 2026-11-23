#!/bin/sh
# wait.sh: 1846w's pass, how long a held value waits behind a kept page's brotli 5 job on this
# host (results/margin.md declares it, its checks, statistic and bounds). run.sh runs it; alone:
#   sh /m/1846w/wait.sh
# bin/wait-base and bin/wait-head run the probe's one test, WAIT_ROUNDS (40) times each,
# alternated (base first in odd rounds, head first in even), each a fresh process of WAIT_REPS
# (21) repetitions, on CPUS (2,4,5,7) with jemalloc preloaded. A process that fails or prints a
# panic stops the pass. Writes results/wait/<build>-<round>.tsv (the round, then the probe's
# columns), the processes' output beside them, and the validator's summary (summary-wait.mjs, which
# checks every round, repetition and row and fails closed) to results/summary-wait.txt.
set -eu
P=/m/1846w; R=$P/results/wait
ROUNDS=${WAIT_ROUNDS:-40}; REPS=${WAIT_REPS:-21}; CPUS=${CPUS:-2,4,5,7}
for b in base head; do [ -x $P/bin/wait-$b ] || { echo "no $P/bin/wait-$b: run build.sh"; exit 1; }; done
mkdir -p $R
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536'
r=1
while [ $r -le "$ROUNDS" ]; do
    if [ $((r % 2)) = 1 ]; then order="base head"; else order="head base"; fi
    for b in $order; do
        out=$R/$b-$r
        started=$(date +%s)
        taskset -c $CPUS $J REPS=$REPS KEPT_SIZES=32768 HELD_SIZES=4096,79000 \
            $P/bin/wait-$b kept::probe_wait::wait_probe --ignored --exact --nocapture --test-threads 1 >$out.out 2>$out.err \
            || { tail -20 $out.err $out.out; echo "wait: $b round $r failed"; exit 1; }
        ! grep -q 'panicked at' $out.out $out.err || { grep -m5 'panicked at' $out.out $out.err; echo "wait: $b round $r panicked"; exit 1; }
        grep -q '^test result: ok\. 1 passed' $out.out || { tail -5 $out.out; echo "wait: $b round $r: the test did not pass"; exit 1; }
        grep "^$b	" $out.out | sed "s/^/$r	/" >$out.tsv
        echo "wait: $b round $r: $(wc -l <$out.tsv) lines in $(( $(date +%s) - started )) s"
    done
    r=$((r + 1))
done
node $P/summary-wait.mjs $R $ROUNDS $REPS >$P/results/summary-wait.txt
cat $P/results/summary-wait.txt
