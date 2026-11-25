#!/bin/bash
# Count host: four more candidate forms built from the head's tree, as c3-build.sh built the first.
set -uo pipefail
cd /root/dl
prep() {
    name=$1; from=$2; variant=$3
    rm -rf c3/src-$name && mkdir -p c3/src-$name
    tar -xzf $from.tgz -C c3/src-$name && tar -xzf entry.tgz -C c3/src-$name || return 1
    sed -i 's/app()\.per_core()/app()/' c3/src-$name/bench/httparena/corten/src/main.rs
    python3 variants.py c3/src-$name entry || return 1
    python3 variants.py c3/src-$name "$variant" || return 1
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
        echo "# BUILD-FAILED $name"; grep -E "^(error|warning)" -A 14 c3/log/build-$name.log | head -80
    fi
}
for v in "$@"; do prep $v head $v || { echo "# PREP-FAILED $v"; exit 1; }; done
for v in "$@"; do build $v & done
wait
grep -E "^warning" -A 6 c3/log/build-*.log | head -40
echo "# BUILD2-DONE $(date -u +%T)"
