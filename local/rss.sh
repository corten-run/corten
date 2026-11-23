#!/bin/sh
# local only (1824e): resident memory a request in process (the probe's cg mode, no callgrind),
# jemalloc as the image runs it: rss_bytes_per_request over 40,000 requests, two rounds.
J="env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc"
for r in 1 2; do
  if [ $r = 1 ]; then order="main head"; else order="head main"; fi
  for b in $order; do
    for c in room jroom off; do
      $J /w/bin/$b cg $c 40000 2>/dev/null | sed "s/^/round=$r build=$b /"
    done
  done
done