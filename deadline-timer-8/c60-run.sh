#!/bin/bash
# Inside the count image: design Choice 60's scratch server (c60/, c60.py) built against three
# trees, each at /src with the crate at /c60 as the session that Choice's Last checked records
# built them, then counted with glibc's allocator and with jemalloc preloaded.
# k1 is 9060dfb2a (the commit the Choice's line is given at, the control), base is main as merged
# (d15d3ac3a) and head the merge (ffc686e39).
set -uo pipefail
export CARGO_TERM_COLOR=never
O=/s/out/c60
mkdir -p $O /w/bin
for pair in k1:k1 base:newbase head:merge; do
    name=${pair%%:*}; tree=${pair##*:}
    rm -rf /src /c60
    git --git-dir=/repo.git archive "$(grep "^$tree " /s/out/trees.txt | cut -d' ' -f2)" | (mkdir /src && tar -x -C /src) || { echo "C60-BUILD-FAILED $name tree"; exit 1; }
    cp -a /s/c60h/c60 /c60 && cp /src/Cargo.lock /c60/Cargo.lock
    (cd /c60 && CARGO_TARGET_DIR=/w/target/c60-$name cargo build --release -j 5 > $O/build-$name.log 2>&1) \
        || { tail -n 30 $O/build-$name.log; echo "C60-BUILD-FAILED $name"; exit 1; }
    cp /w/target/c60-$name/release/c60 /w/bin/c60-$name
    cp /c60/Cargo.lock $O/Cargo.lock-$name
    echo "built c60-$name $(sha256sum /w/bin/c60-$name | cut -c1-12) tokio $(grep -A1 '^name = "tokio"$' /c60/Cargo.lock | tail -n 1) hyper $(grep -A1 '^name = "hyper"$' /c60/Cargo.lock | tail -n 1) $(date -u +%T)" | tee -a $O/built.txt
done
B="/w/bin/c60-k1 /w/bin/c60-base /w/bin/c60-head"
for session in 1 2; do
    echo "== glibc, session $session $(date -u +%T)"
    python3 /s/c60h/c60.py 2 3 $B > $O/glibc-$session.txt 2>&1; echo "rc=$?" >> $O/glibc-$session.txt
    cat $O/glibc-$session.txt
    echo "== jemalloc preloaded, session $session $(date -u +%T)"
    C60_JEMALLOC=1 python3 /s/c60h/c60.py 2 3 $B > $O/je-$session.txt 2>&1; echo "rc=$?" >> $O/je-$session.txt
    cat $O/je-$session.txt
done
echo "C60-ALL-DONE $(date -u +%T)"
