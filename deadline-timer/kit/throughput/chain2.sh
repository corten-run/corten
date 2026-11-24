#!/usr/bin/env bash
# Runs on the c-48: once the first two passes are done, builds httparena-corten:final from
# base + v1c.patch and runs two alternating passes, the second in the reverse order.
set -uo pipefail
cd /root/dl
W=/root/work/arena
until grep -q ALL-DONE pass2.log 2>/dev/null; do sleep 20; done
rm -rf src-final && cp -r src-base src-final && (cd src-final && git apply --whitespace=nowarn /root/dl/v1c.patch) || { echo "FAIL patch"; exit 1; }
tar -czf $W/trees/final.tgz -C src-final Cargo.toml Cargo.lock crates
S=$W/stage-final
rm -rf "$S" && mkdir -p "$S" && tar -xzf $W/trees/final.tgz -C "$S" && tar -xzf $W/trees/entry-var.tgz -C "$S"
sed -i 's/app()\.per_core()/app()/' "$S/bench/httparena/corten/src/main.rs"
docker build -f "$S/bench/httparena/corten/Dockerfile" -t httparena-corten:final "$S" > $W/build-corten-final.log 2>&1 || { echo "FAIL build"; grep -E "error|-->" $W/build-corten-final.log | head -40; exit 1; }
echo "built final $(docker images -q httparena-corten:final) $(grep -oE 'Compiling (tokio|hyper) v[0-9.]+' $W/build-corten-final.log | sort -u | tr '\n' ' ')"
sleep 20
PASS=p3 bash alt.sh 5 base:base final:final thread:thread > pass3.log 2>&1
PASS=p4 bash alt.sh 5 thread:thread final:final base:base > pass4.log 2>&1
echo ALL2-DONE
