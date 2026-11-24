#!/usr/bin/env bash
# count-miss.sh: after count.sh, in the same container image with /w mounted and both bench apps
# built: instructions a request costs when its Accept-Encoding line is not one of the three the
# head compares whole (add-miss.py's three cases), three runs a case, and each case's answer from
# both builds compared. Writes /w/out-miss/.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 python3 >/dev/null 2>&1 || { echo "MISS-FAILED packages"; exit 1; }
mkdir -p /w/out-miss
for side in base head; do
    echo "== $side $(cat /w/$side.commit) $(date -u +%T)"
    python3 /w/add-miss.py /w/$side || { echo "MISS-FAILED cases $side"; exit 1; }
    app=/w/target-$side-app/release/httparena-corten
    [ -x "$app" ] || { echo "MISS-FAILED no app for $side"; exit 1; }
    (cd /w/$side/bench/httparena/corten && python3 measure/count.py $app --dump /w/out-miss/answers-$side) || { echo "MISS-FAILED dump $side"; exit 1; }
    (cd /w/$side/bench/httparena/corten && python3 measure/count.py $app --reps 3 --cases get-other,text-other,page-other,get-browser) | tee /w/out-miss/socket-$side.txt || { echo "MISS-FAILED count $side"; exit 1; }
done
if diff -r /w/out-miss/answers-base /w/out-miss/answers-head >/w/out-miss/answers.diff; then echo "answers: the $(ls /w/out-miss/answers-base | wc -l) cases' answers are the same bytes in both builds (Date and ETag masked)" | tee /w/out-miss/answers.txt; else echo "answers: DIFFER" | tee /w/out-miss/answers.txt; head -40 /w/out-miss/answers.diff; fi
grep -il "content-encoding: zstd" /w/out-miss/answers-head/* | tee /w/out-miss/zstd.txt
echo MISS-DONE
