#!/bin/bash
# Inside the count image: the two tests of a deadline that waits on its connection's kept timer
# when shutdown begins, on the tree of commit $1 as it is and then with the timer's wake lost
# after shutdown has begun (lost.py). Each run's log ends with cargo's exit status.
set -uo pipefail
commit=$1
O=/s/out/lost
T='shutdown_holds_a_connection_whose_requests_waited_to_its_requests_deadline'
N='a_deadline_on_a_connections_timer_fires_at_its_own_time_once_shutdown_has_begun'
mkdir -p $O /w/lost
rm -rf /w/lost/src && mkdir -p /w/lost/src
git config --global --add safe.directory '*'
git --git-dir=/repo.git archive "$commit" | tar -x -C /w/lost/src || { echo "LOST-FAILED archive"; exit 1; }
echo "tree of $(git --git-dir=/repo.git rev-parse "$commit")" | tee $O/tree.txt
export CARGO_TERM_COLOR=never CARGO_TARGET_DIR=/w/lost/target
cd /w/lost/src
run() {
    cargo test -p corten-run --all-features --lib -j 5 -- "tests::server::$T" "tests::server::$N" > $O/$1.log 2>&1
    echo "exit $?" >> $O/$1.log
    grep -E '^test tests::|^test result|panicked|deadline, not when|^exit' $O/$1.log
}
echo "== as it is $(date -u +%T)"; run as-it-is
python3 /s/lost/lost.py /w/lost/src > $O/broken.txt 2>&1 || { cat $O/broken.txt; echo "LOST-FAILED break"; exit 1; }
cat $O/broken.txt
echo "== the wake lost $(date -u +%T)"; run wake-lost
echo "LOST-DONE $(date -u +%T)"
