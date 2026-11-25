#!/bin/bash
# Count host: the main and extra sets for the two rq forms, both rounds.
cd /root/dl
cp sets.sh count7.py c3/
go() {
    docker run --rm --ulimit nofile=1048576:1048576 -v /root/dl/c3:/w c3img bash /w/sets.sh $1 $2 $3 $4 > c3/log/$1-$4-$2.log 2>&1 &
}
go main 1 11 rq1; go main 1 12 rq8; go extra 1 13 rq1; go main 2 14 rq8; go main 2 15 rq1
wait
echo "E-DONE $(date -u +%T)" >> c3/log/batches.log
