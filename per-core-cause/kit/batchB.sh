cd /root/pcc
V=httparena-corten:var
D="-e ARENA_MODE=default"; P="-e ARENA_MODE=percore-builtin"
r() { LABEL=$1 SERVER_ENV="$2" bash run2.sh $V "$3" "${4:-3}"; }
r b-default        "$D" baseline,async
r b-alt            "$D -e ARENA_TIMER=alt" baseline,async
r b-thread         "$D -e ARENA_DELAY=thread" baseline,async
r b-percore        "$P" baseline,async
r b-percore-thread "$P -e ARENA_DELAY=thread" async
r b-percore-thr4   "$P -e ARENA_DELAY=thread -e ARENA_TIMER_THREADS=4" async
r b-lifo-off       "$D -e ARENA_LIFO=off" baseline,async
r b-gqi7           "$D -e ARENA_GQI=7" baseline,async
r b-gqi31          "$D -e ARENA_GQI=31" baseline,async
r b-gqi255         "$D -e ARENA_GQI=255" baseline,async
r b-evi7           "$D -e ARENA_EVI=7" baseline,async
r b-evi31          "$D -e ARENA_EVI=31" baseline,async
r b-evi255         "$D -e ARENA_EVI=255" baseline,async
r b-workers8       "$D -e ARENA_WORKERS=8" baseline,async
r b-workers12      "$D -e ARENA_WORKERS=12" baseline,async
r b-workers16      "$D -e ARENA_WORKERS=16" baseline,async
r b-workers20      "$D -e ARENA_WORKERS=20" baseline,async
r b-workers48      "$D -e ARENA_WORKERS=48" baseline,async
r b-ioev4096       "$D -e ARENA_IO_EVENTS=4096" baseline,async
r b-default        "$D" async0,async-staged,baseline@32000
r b-percore        "$P" async0,async-staged,baseline@32000
r b-alt            "$D -e ARENA_TIMER=alt" async0,async-staged
r b-alt-lifo-off   "$D -e ARENA_TIMER=alt -e ARENA_LIFO=off" baseline,async
echo PASS1-DONE
r c-percore        "$P" baseline,async
r c-thread         "$D -e ARENA_DELAY=thread" baseline,async
r c-alt            "$D -e ARENA_TIMER=alt" baseline,async
r c-default        "$D" baseline,async
echo BATCH-DONE
