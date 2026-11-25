#!/bin/bash
# Inside the count image: one set of counts for one build. Usage: sets.sh <set> <round> <cpu> <name>
# Every line of count7.py's output goes to /w/out/<set>-<name>-<round>.txt behind the row's label,
# the runtime (default: tokio's multi-threaded; percore-by-hand: one single-threaded a core), the
# build and the round.
set -uo pipefail
SET=$1; ROUND=$2; CPU=$3; NAME=$4
B=/w/bin/$NAME
O=/w/out/$SET-$NAME-$ROUND.txt
: > $O
ENVS=
one() {
    label=$1; mode=$2; shift 2
    echo "== $label $mode $NAME r$ROUND $(date -u +%T)"
    env ARENA_MODE=$mode $ENVS python3 /w/count7.py $B --cpu $CPU "$@" 2>&1 | sed "s/^/$label $mode $NAME r$ROUND | /" | tee -a $O
}
MODES="default percore-by-hand"
case $SET in
main)
    for mode in $MODES; do
        one row1 $mode --cases get
        one row2 $mode --cases sdelay1
        if [ $mode = default ]; then one row6 $mode --cases sdelay1 --each-its-own; else one row6 $mode --cases sdelay1 --each-its-own --settle-ms 10; fi
        one row9 $mode --cases get --first sdelay1 --first-count 3
        one other3 $mode --cases get --other-count 3
        one alt $mode --cases get --alternate sdelay1
    done ;;
extra)
    for mode in $MODES; do
        one other1 $mode --cases get --other-count 1
        one row9-pause $mode --cases get --first sdelay1 --first-count 3 --pause-ms 1500
        one other3-pause $mode --cases get --other-count 3 --pause-ms 1500
        ENVS="ARENA_DEADLINE_MS=2000"
        one row9-past $mode --cases get --first sdelay1 --first-count 3 --pause-ms 3000
        one other3-past $mode --cases get --other-count 3 --pause-ms 3000
        ENVS=
    done ;;
standing)
    for mode in $MODES; do
        for ms in 1000 30000 3600000 946080000000; do
            ENVS="ARENA_STANDING_MS=$ms"
            one row1-standing-$ms $mode --cases get
        done
        ENVS="ARENA_STANDING_MS=30000"
        one row2-standing-30000 $mode --cases sdelay1
        one row9-standing-30000 $mode --cases get --first sdelay1 --first-count 3
        one other3-standing-30000 $mode --cases get --other-count 3
        ENVS=
    done ;;
loop)
    for mode in $MODES; do
        for conns in 1 8 64; do
            one loop$conns $mode --cases get --first sdelay1 --first-count 3 --conns $conns
        done
        one quiet64 $mode --cases get --conns 64
        one quiet1 $mode --cases get --conns 1
    done ;;
gap)
    for mode in $MODES; do
        # One connection whose requests all wait 1 ms, 150 ms apart; and one whose requests each
        # wait 150 ms. 200 requests between the two runs of a count.
        one gapw $mode --cases sdelay1 --gap-ms 150 --few 40 --many 240
        one longw $mode --cases sdelay150 --few 40 --many 240
    done ;;
busy)
    for mode in $MODES; do
        # A deadline of 1 s, so that a kept timer's time comes inside a count. One connection whose
        # requests all wait 1 ms, 150 ms apart (each wait moves the timer later); and one that waits
        # three times and then sends requests that do not wait, 20 ms apart: the timer's time comes
        # between the 10th and the 210th of them, with the connection busy.
        ENVS="ARENA_DEADLINE_MS=1000"
        one busy-waits $mode --cases sdelay1 --gap-ms 150 --few 40 --many 240
        one busy-quiet $mode --cases get --first sdelay1 --first-count 3 --gap-ms 20 --few 10 --many 210
        ENVS=
    done ;;
slow)
    for mode in $MODES; do
        # One connection whose requests each wait 1 ms and are followed by 1.2 s of quiet (a timer set
        # no later than 1 s ahead fires in every gap); and one whose requests each wait 2.5 s (such a
        # timer fires twice while the request waits).
        one quietgap $mode --cases sdelay1 --gap-ms 1200 --few 5 --many 20
        one slowwait $mode --cases sdelay2500 --few 2 --many 10
    done ;;
prof)
    for mode in $MODES; do
        one prof-other3 $mode --reps 1 --cases get --other-count 3 --keep /w/prof --label $NAME-$mode-other3-
        one prof-row9 $mode --reps 1 --cases get --first sdelay1 --first-count 3 --keep /w/prof --label $NAME-$mode-row9-
        one prof-row1 $mode --reps 1 --cases get --keep /w/prof --label $NAME-$mode-row1-
    done ;;
*) echo "no such set: $SET"; exit 1 ;;
esac
echo "# SET-DONE $SET $NAME r$ROUND $(date -u +%T)"
