#!/bin/bash
# Inside the count image: the five trees, each from its commit by git archive.
set -uo pipefail
git config --global --add safe.directory '*'
mkdir -p /w/bin /s/out
{ rustc -V; cargo -V; valgrind --version; uname -r; grep -m1 'model name' /proc/cpuinfo; nproc; dpkg -s libjemalloc2 | grep Version; } > /s/out/host.txt 2>&1
: > /s/out/trees.txt
for pair in main:26ab0e37f753ffc4f9418bc28ad7825a924d08e1 b:f8934bc998a7609728826c106cfc57fdd1aef3dd newbase:d15d3ac3aca25ecade5b36abdebe45e8409be0f1 merge:ffc686e392cc7df0eccdec992242a5bbdf6f43ef k1:9060dfb2ad6bf88037727f8ff6621fa133be49e7; do
    name=${pair%%:*}; commit=${pair##*:}
    rm -rf /w/src-$name && mkdir -p /w/src-$name
    git --git-dir=/repo.git archive "$commit" | tar -x -C /w/src-$name || { echo "PREP-FAILED $name"; exit 1; }
    [ -f /w/src-$name/crates/corten/src/app.rs ] || { echo "PREP-FAILED $name: no crate"; exit 1; }
    echo "$name $commit httparena-in-tree=$([ -d /w/src-$name/bench/httparena ] && echo yes || echo no) deadline.rs=$([ -f /w/src-$name/crates/corten/src/deadline.rs ] && echo yes || echo no)" | tee -a /s/out/trees.txt
done
echo PREP-DONE
