#!/bin/sh
# In the container, after build.sh: each side's unpadded binary started as the kit starts a server
# (plan.sh's J), in each of the probe's two configurations the plan reads, asked 50 requests, and
# its threads listed by name. No counter read.
W=beside
. /m/dl/plan.sh
port=18083
for conf in plain plain-mt; do
    for side in base head; do
        PORT=$port taskset -c 2 sh -c "exec $J $P/bin/$side \$PORT $conf" >/dev/null 2>&1 &
        pid=$!
        i=0
        until curl -s -o /dev/null "http://127.0.0.1:$port/" </dev/null; do i=$((i + 1)); [ $i -lt 100 ] || { echo "nothing answers"; kill $pid; exit 1; }; sleep 0.1; done
        n=0; while [ $n -lt 50 ]; do curl -s -o /dev/null "http://127.0.0.1:$port/private" </dev/null; n=$((n + 1)); done
        echo "$side as $conf: $(ls /proc/$pid/task | wc -l) threads: $(for t in /proc/$pid/task/*; do cat $t/comm; done | sort | uniq -c | sed 's/^ *//' | paste -sd';' -)"
        kill $pid; wait $pid 2>/dev/null
    done
done
