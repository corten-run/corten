#!/bin/bash
# Count host: the sets of counts, several builds at a time, each in its own container with its
# server pinned to its own CPU. Usage: c3-run.sh <batch>
set -uo pipefail
cd /root/dl
cp sets.sh count7.py fnprof.py c3/
go() {
    set=$1; round=$2; cpu=$3; name=$4
    # The open-file limit is set because this host's Docker gives a container one of over 10^9,
    # which valgrind refuses to start under.
    docker run --rm --ulimit nofile=1048576:1048576 -v /root/dl/c3:/w c3img bash /w/sets.sh $set $round $cpu $name > c3/log/$set-$name-$round.log 2>&1 &
}
case $1 in
a)
    cpu=1; for name in base head out1 out8 far soon; do go main 1 $cpu $name; cpu=$((cpu + 1)); done
    go loop 1 8 base; go loop 1 9 head
    go prof 1 10 base; go prof 1 11 head
    wait ;;
b)
    cpu=1; for name in soon far out8 out1 head base; do go main 2 $cpu $name; cpu=$((cpu + 1)); done
    go loop 2 8 head; go loop 2 9 base
    go standing 1 10 base; go standing 1 11 head
    wait ;;
c)
    cpu=1; for name in base head out1 soon; do go extra 1 $cpu $name; cpu=$((cpu + 1)); done
    go standing 2 6 head; go standing 2 7 base
    go loop 1 8 soon; go loop 1 9 out1
    wait
    cpu=1; for name in soon out1 head base; do go extra 2 $cpu $name; cpu=$((cpu + 1)); done
    wait ;;
d)
    cpu=1; for name in req1 req8 soon2; do go main 1 $cpu $name; cpu=$((cpu + 1)); done
    go extra 1 4 soon2; go extra 1 5 req1; go loop 1 6 soon2
    go gap 1 7 base; go gap 1 8 head; go gap 1 9 soon2h; go gap 1 10 soon2
    wait
    cpu=1; for name in soon2 req8 req1; do go main 2 $cpu $name; cpu=$((cpu + 1)); done
    go extra 2 4 req1; go extra 2 5 soon2; go loop 2 6 soon2
    wait ;;
esac
echo "# BATCH-DONE $1 $(date -u +%T)" >> c3/log/batches.log
