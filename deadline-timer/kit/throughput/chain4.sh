#!/usr/bin/env bash
# Runs on the c-48: builds httparena-corten:<name> from base + <patch> and runs two alternating
# passes against base and the thread variant, the second in the reverse order.
# Usage: chain3.sh <name> <patch> <first pass> <second pass>
set -uo pipefail
name=$1; patch=$2; one=$3; two=$4
cd /root/dl
until grep -q ALL3-DONE chain3.log 2>/dev/null; do sleep 15; done
W=/root/work/arena
rm -rf src-$name && cp -r src-base src-$name && (cd src-$name && git apply --whitespace=nowarn "/root/dl/$patch") || { echo "FAIL patch"; exit 1; }
tar -czf $W/trees/$name.tgz -C src-$name Cargo.toml Cargo.lock crates
S=$W/stage-$name
rm -rf "$S" && mkdir -p "$S" && tar -xzf $W/trees/$name.tgz -C "$S" && tar -xzf $W/trees/entry-var.tgz -C "$S"
sed -i 's/app()\.per_core()/app()/' "$S/bench/httparena/corten/src/main.rs"
docker build -f "$S/bench/httparena/corten/Dockerfile" -t httparena-corten:$name "$S" > $W/build-corten-$name.log 2>&1 || { echo "FAIL build"; grep -E "error|-->" $W/build-corten-$name.log | head -40; exit 1; }
echo "built $name $(docker images -q httparena-corten:$name) $(md5sum src-$name/crates/corten/src/deadline.rs | cut -c1-12)"
sleep 20
PASS=$one bash alt2.sh 5 base:base $name:$name > pass-$one.log 2>&1
PASS=$two bash alt2.sh 5 $name:$name base:base > pass-$two.log 2>&1
echo ALL4-DONE
