#!/bin/sh
# local only (1824e): builds the allocation map against a tree and runs it under jemalloc, as the
# template's image runs it. Usage: allocmap.sh <name> <tree dir> [runs...]
set -eu
name=$1; tree=$2
W=/w/$name
mkdir -p $W
rm -rf $W/tree $W/allocmap
cp -a "$tree" $W/tree
cp -a /cyc/1824e/allocmap $W/allocmap
cp $W/tree/Cargo.lock $W/allocmap/Cargo.lock
export RUSTUP_TOOLCHAIN=1.100.0 CARGO_TARGET_DIR=/t/allocmap-$name ZSTD_SYS_USE_PKG_CONFIG=1
(cd $W/allocmap && cargo build --release -q 2>&1 | tail -5)
echo "built $name"
J="env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536"
$J /t/allocmap-$name/release/allocmap page off 2000 8192 0
$J /t/allocmap-$name/release/allocmap page room 2000 8192 2
$J /t/allocmap-$name/release/allocmap json off 2000 8192 0
$J /t/allocmap-$name/release/allocmap json room 2000 8192 2
$J /t/allocmap-$name/release/allocmap page hit 100 8192 0
$J /t/allocmap-$name/release/allocmap json hit 100 8192 0