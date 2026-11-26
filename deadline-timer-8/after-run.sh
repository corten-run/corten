#!/bin/bash
# Inside the count image, after rows-run.sh has built /w/bin/{main,b,newbase,merge}:
# 1. an idle connection's bytes and blocks in five states, by idle5.py over extra.py and count2.py
#    of the tag evidence/deadline-timer-4 (deadline-timer-4/after-review/first/), two runs each;
# 2. instructions a request by function for the staged request that does not wait (row 1), by
#    count7.py --keep and fnprof.py of that tag (deadline-timer-4/counts/), and the calls a request
#    to the function that polls a connection;
# 3. which functions of the wrapper each binary holds.
set -uo pipefail
O=/s/out/after
mkdir -p $O /w/dhat /w/prof
cp /s/ev/extra.py /s/ev/count2.py /s/ev/idle5.py /w/dhat/
cd /w/dhat
for name in main b newbase merge; do
    ARENA_MODE=default python3 /w/dhat/idle5.py /w/bin/$name 2 > $O/idle-$name.txt 2>&1
    echo "== idle $name rc=$? $(date -u +%T)"; cat $O/idle-$name.txt
done
for name in main b newbase merge; do
    for mode in default percore-by-hand; do
        ARENA_MODE=$mode python3 /s/ev/count7.py /w/bin/$name --reps 1 --cases get --keep /w/prof --label $name-$mode-row1- > $O/prof-count-$name-$mode.txt 2>&1
        echo "== prof count $name $mode rc=$? $(date -u +%T)"; cat $O/prof-count-$name-$mode.txt
    done
done
P='deadline::Keeps<|UpgradeableConnection<.*as core::future::future::Future>::poll'
for pair in "main b" "newbase merge"; do
    set -- $pair
    for mode in default percore-by-hand; do
        echo "== row1 $mode: a = $1, b = $2"
        python3 /s/ev/fnprof.py 1000 /w/prof/$1-$mode-row1-get.few /w/prof/$1-$mode-row1-get.many /w/prof/$2-$mode-row1-get.few /w/prof/$2-$mode-row1-get.many 3
        for name in $1 $2; do
            echo "-- $name $mode: the functions that poll a connection"
            python3 /s/callsof.py 1000 /w/prof/$name-$mode-row1-get.few /w/prof/$name-$mode-row1-get.many "$P"
        done
    done
done > $O/prof.txt 2>&1
echo "== prof rc=$?"
for name in main b newbase merge; do
    echo "== $name: symbols naming the wrapper or the connection's poll"
    nm -C /w/bin/$name | grep -E 'deadline::Keeps|deadline::asked|deadline::Polling|UpgradeableConnection<.*Future>::poll' | cut -c1-260
done > $O/symbols.txt 2>&1
mkdir -p $O/callgrind && cp /w/prof/*row1-get.few /w/prof/*row1-get.many $O/callgrind/ 2>/dev/null
echo "AFTER-DONE $(date -u +%T)"
