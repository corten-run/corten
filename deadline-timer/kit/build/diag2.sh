#!/usr/bin/env bash
# Runs on the build host: builds the benchmark app on a copy of the change's tree with the
# deadline.rs given, and says where a request's instructions differ from base's.
#   diag2.sh <name> <deadline.rs> [case...]
set -uo pipefail
name=$1; file=$2; shift 2
cd /root/dl/cg
rm -rf src-$name && cp -r src-conn src-$name && cp "$file" src-$name/crates/corten/src/deadline.rs
docker run --rm -e DIAG_CORE=5 -e ARENA_MODE=default -e NAME=$name -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash -c '
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux >/dev/null 2>&1
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
(cd /w/src-$NAME/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$NAME cargo build --release > /w/out/build-$NAME.log 2>&1) || { tail -30 /w/out/build-$NAME.log; echo "DIAG-FAILED build"; exit 1; }
for c in "$@"; do echo "== $c"; python3 /w/diag.py $c /w/target-base/release/httparena-corten /w/target-$NAME/release/httparena-corten; done
' _ "$@"
echo "DIAG2-DONE $name"
