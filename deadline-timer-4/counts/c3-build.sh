#!/bin/bash
# Count host: the image the counts run in, then the six trees and their builds of the benchmark
# entry: base (main as merged), head, and four candidate forms made from the head by variants.py.
# Expects in /root/dl: base.tgz head.tgz entry.tgz variants.py count7.py fnprof.py sets.sh
set -uo pipefail
cd /root/dl
mkdir -p c3/bin c3/out c3/log c3/prof
cp count7.py fnprof.py sets.sh c3/
cat > c3/Dockerfile <<'EOF'
FROM rust:1-trixie
RUN apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux && rm -rf /var/lib/apt/lists/*
EOF
docker build -q -t c3img -f c3/Dockerfile c3/log > c3/log/image.log 2>&1 || { tail -5 c3/log/image.log; echo "# IMAGE-FAILED"; exit 1; }
docker run --rm c3img sh -c 'rustc -V; cargo -V; valgrind --version; dpkg -s libjemalloc2 | grep Version' > c3/out/host.txt 2>&1
{ uname -r; grep -m1 'model name' /proc/cpuinfo; nproc; } >> c3/out/host.txt
prep() {
    name=$1; from=$2; variant=$3
    rm -rf c3/src-$name && mkdir -p c3/src-$name
    tar -xzf $from.tgz -C c3/src-$name && tar -xzf entry.tgz -C c3/src-$name || return 1
    # `App::per_core` is the prototype branch's, not main's.
    sed -i 's/app()\.per_core()/app()/' c3/src-$name/bench/httparena/corten/src/main.rs
    python3 variants.py c3/src-$name entry || return 1
    [ "$variant" = none ] || python3 variants.py c3/src-$name "$variant" || return 1
}
build() {
    name=$1
    docker run --rm -v /root/dl/c3:/w -v corten-cargo:/usr/local/cargo/registry -e ZSTD_SYS_USE_PKG_CONFIG=1 \
        -e RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes" -e CARGO_TARGET_DIR=/w/target-$name -e CARGO_TERM_COLOR=never \
        -w /w/src-$name/bench/httparena/corten c3img cargo build --release > c3/log/build-$name.log 2>&1
    if [ $? -eq 0 ] && cp c3/target-$name/release/httparena-corten c3/bin/$name; then
        cp c3/src-$name/bench/httparena/corten/Cargo.lock c3/log/Cargo.lock-$name
        echo "built $name: $(grep -E '^name = "(tokio|hyper)"$' -A 1 c3/log/Cargo.lock-$name | grep version | tr '\n' ' ') $(sha256sum < c3/bin/$name | cut -c1-16) $(date -u +%T)"
    else
        echo "# BUILD-FAILED $name"; grep -E "^(error|warning: unused)" -A 12 c3/log/build-$name.log | head -60
    fi
}
prep base base none || { echo "# PREP-FAILED base"; exit 1; }
prep head head none || { echo "# PREP-FAILED head"; exit 1; }
for v in out1 out8 far soon; do prep $v head $v || { echo "# PREP-FAILED $v"; exit 1; }; done
build base
build head &
build out1 &
build out8 &
wait
build far &
build soon &
wait
grep -E "^warning" -A 6 c3/log/build-*.log | head -40
echo "# BUILD-DONE $(date -u +%T)"
