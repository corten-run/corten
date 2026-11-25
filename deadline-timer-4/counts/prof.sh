#!/bin/bash
# Count host: instructions a request by function, head less base, for the kept profiles.
cd /root/dl/c3/prof
for row in other3 row9 row1; do
    for m in default percore-by-hand; do
        echo "== $row $m: a = base, b = head"
        python3 ../fnprof.py 1000 base-$m-$row-get.few base-$m-$row-get.many head-$m-$row-get.few head-$m-$row-get.many 3
    done
done
