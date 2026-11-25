#!/bin/bash
# Count host: the busy set (a 1 s deadline) for the base and the head, two rounds.
cd /root/dl
cp sets.sh count7.py c3/
go() {
    docker run --rm --ulimit nofile=1048576:1048576 -v /root/dl/c3:/w c3img bash /w/sets.sh $1 $2 $3 $4 > c3/log/$1-$4-$2.log 2>&1 &
}
go busy 1 11 base; go busy 1 12 head; go busy 2 13 head; go busy 2 14 base
wait
echo "F-DONE $(date -u +%T)" >> c3/log/batches.log
