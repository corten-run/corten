#!/bin/sh
# local only (1824e): the allocation map's summary lines for main and head, already built.
J="env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536"
for b in ${BUILDS:-main head}; do
  for a in "page off 2000 8192 0" "page room 2000 8192 1" "json off 2000 8192 0" "json room 2000 8192 1" "page hit 100 8192 0" "json hit 100 8192 0"; do
    $J /t/allocmap-$b/release/allocmap $a | grep -E '^(LIVE|TRACE|  HELD)' | sed "s/^/$b /"
  done
done