#!/bin/bash
# Inside the count image: every option of count7.py once, one count each, on one build.
B=/w/bin/$1
C="python3 /w/count7.py $B --cpu 14 --reps 1"
export ARENA_MODE=default
$C --cases get
$C --cases get --other-count 3
$C --cases get --first sdelay1 --first-count 3 --pause-ms 200
$C --cases get --alternate sdelay1
$C --cases get --first sdelay1 --first-count 3 --conns 8
$C --cases get --conns 64 --keep /w/prof --label smoke-
ARENA_STANDING_MS=30000 $C --cases get
ARENA_DEADLINE_MS=500 $C --cases get --other-count 3 --pause-ms 1000
ARENA_MODE=percore-by-hand $C --cases get --other-count 3
python3 /w/fnprof.py 1024 /w/prof/smoke-get.few /w/prof/smoke-get.many /w/prof/smoke-get.few /w/prof/smoke-get.many 300 | head -30
echo "# SMOKE-DONE"
