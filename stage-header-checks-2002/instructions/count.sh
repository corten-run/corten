#!/usr/bin/env bash
# count.sh: instructions a request costs before and after the stage header checks, by callgrind,
# in a rust:1-trixie container with /w mounted: /w/base and /w/head are the two trees (crates,
# examples, Cargo.toml, Cargo.lock, .cargo at each commit) with the prototype's bench app and its
# measuring scripts (bench/httparena/corten, from the tag evidence/stage-cost-prototype) added to
# each. Writes /w/out/.
#   1. over a socket: measure/count.py on the bench app (one keep-alive connection, 1,240 less
#      240 requests over 1,000, jemalloc, three runs a case), and each case's answer as sent, with
#      its Date and ETag masked, compared between the two builds;
#   2. in process: crates/corten/tests/router_cost.rs (1,200 less 200 requests over 1,000, three
#      runs), the matched route and the 404 page, with glibc's allocator and with jemalloc.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1 CARGO_PROFILE_RELEASE_DEBUG=line-tables-only
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
mkdir -p /w/out
{ rustc -V; valgrind --version; dpkg -s libjemalloc2 | grep '^Version'; uname -r; grep -m1 'model name' /proc/cpuinfo; } >/w/out/host.txt 2>&1
for side in base head; do
    echo "== $side $(cat /w/$side.commit) $(date -u +%T)"
    (cd /w/$side/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$side-app cargo build --release >/w/out/build-app-$side.log 2>&1) || { tail -20 /w/out/build-app-$side.log; echo "COUNT-FAILED app build $side"; exit 1; }
    app=/w/target-$side-app/release/httparena-corten
    (cd /w/$side/bench/httparena/corten && python3 measure/count.py $app --dump /w/out/answers-$side) || { echo "COUNT-FAILED dump $side"; exit 1; }
    (cd /w/$side/bench/httparena/corten && python3 measure/count.py $app --reps 3) | tee /w/out/socket-$side.txt || { echo "COUNT-FAILED count $side"; exit 1; }
    (cd /w/$side && CARGO_TARGET_DIR=/w/target-$side cargo test --release -p corten-run --test router_cost --no-run >/w/out/build-test-$side.log 2>&1) || { tail -20 /w/out/build-test-$side.log; echo "COUNT-FAILED test build $side"; exit 1; }
    bin=$(sed -n 's/.*Executable tests\/router_cost.rs (\(.*\))$/\1/p' /w/out/build-test-$side.log | tail -1)
    [ -x "$bin" ] || { echo "COUNT-FAILED no router_cost binary for $side"; exit 1; }
    : >/w/out/process-$side.txt
    for alloc in glibc jemalloc; do
        for target in route missing; do
            runs=
            for rep in 1 2 3; do
                total() { # <requests>
                    env ROUTER_REQUESTS=$1 $([ $target = missing ] && echo ROUTER_TARGET=missing) $([ $alloc = jemalloc ] && echo LD_PRELOAD=libjemalloc.so.2) \
                        valgrind --tool=callgrind --callgrind-out-file=/tmp/cg.out $bin --ignored --exact request_cost 2>&1 | sed -n 's/.*Collected : \([0-9]*\).*/\1/p'
                }
                many=$(total 1200); few=$(total 200)
                case "$many$few" in ''|*[!0-9]*) echo "COUNT-FAILED router_cost $side $alloc $target"; exit 1 ;; esac
                runs="$runs $(( (many - few) ))"
            done
            echo "$alloc $target: per 1,000 requests$runs" | tee -a /w/out/process-$side.txt
        done
    done
done
if diff -r /w/out/answers-base /w/out/answers-head >/w/out/answers.diff; then echo "answers: the $(ls /w/out/answers-base | wc -l) cases' answers are the same bytes in both builds (Date and ETag masked)" | tee /w/out/answers.txt; else echo "answers: DIFFER" | tee /w/out/answers.txt; cat /w/out/answers.diff | head -40; fi
echo COUNT-DONE
