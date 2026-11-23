#!/bin/sh
# local only (1824f, not part of the kit): builds the probe against main's tree and the candidate's
# (/w/<name>/work) and counts instructions a request in process under callgrind:
# (count at 1,300 requests - count at 300) / 1,000, jemalloc preloaded as the image runs it, each
# configuration, ROUNDS rounds with the build order turned each round.
# Usage: cg.sh build <name> <tree>   |   cg.sh count
set -eu
export RUSTUP_TOOLCHAIN=1.100.0 ZSTD_SYS_USE_PKG_CONFIG=1
if [ "$1" = build ]; then
  name=$2; tree=$3; W=/w/probe-$name
  rm -rf $W; mkdir -p $W
  cp -a "$tree" $W/work; cp -a /cyc/1824f/probe $W/probe; cp $W/work/Cargo.lock $W/probe/Cargo.lock
  (cd $W/probe && CARGO_TARGET_DIR=/t/probe-$name cargo build --release -q 2>&1 | tail -5)
  mkdir -p /w/bin; cp /t/probe-$name/release/probe /w/bin/$name
  echo "$name $(sha256sum /w/bin/$name | cut -d' ' -f1)"
  exit 0
fi
J="env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc"
count() { # <bin> <config> <requests>
  $J valgrind --tool=callgrind --callgrind-out-file=/tmp/cg.out /w/bin/$1 cg $2 $3 >/tmp/cg.log 2>&1 || { cat /tmp/cg.log; exit 1; }
  grep -q "^CG config=$2 requests=$3 " /tmp/cg.log || { cat /tmp/cg.log; exit 1; }
  grep -E '^(summary|totals):' /tmp/cg.out | sed -n 1p | awk '{print $2}'
}
r=1
while [ $r -le ${ROUNDS:-3} ]; do
  if [ $((r % 2)) = 1 ]; then order="main head"; else order="head main"; fi
  for c in ${CONFIGS:-room jroom off hit plain}; do
    for b in $order; do
      a=$(count $b $c 1300); z=$(count $b $c 300)
      echo "$r $c $b $a $z" | awk '{printf "round=%s config=%s build=%s per_request=%.1f\n",$1,$2,$3,($4-$5)/1000}'
    done
  done
  r=$((r + 1))
done