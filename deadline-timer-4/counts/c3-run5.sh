#!/bin/bash
# Count host: the slow set (quiet gaps and waits of over a second) for the base, the head and the
# two forms whose timer is set no later than 1 s ahead.
cd /root/dl
cp sets.sh count7.py c3/
go() {
    docker run --rm --ulimit nofile=1048576:1048576 -v /root/dl/c3:/w c3img bash /w/sets.sh $1 $2 $3 $4 > c3/log/$1-$4-$2.log 2>&1 &
}
go slow 1 11 base; go slow 1 12 head; go slow 1 13 soon; go slow 1 14 soon2
wait
echo "G-DONE $(date -u +%T)" >> c3/log/batches.log
