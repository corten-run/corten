#!/usr/bin/env bash
# Runs on the check droplet: the CPU an app that has served no request takes in 60 s, and its
# threads, by jemalloc's thread cache limit (the cgroup's cpu.stat usage_usec, read 6 s after the
# start and 60 s later, as bench/fullstack/alloc-faults.mjs does with IDLE_SECONDS=60; the smoke
# fixture stands in for that script's bench fixture). Usage: idle.sh <image>
OUT=/root/idle.out; : > "$OUT"
usage() { docker exec idle-app awk '/^usage_usec/ {print $2}' /sys/fs/cgroup/cpu.stat; }
for round in 1 2 3; do
  for conf in 65536 1048576; do
    docker rm -f -v idle-app >/dev/null 2>&1
    docker run -d --name idle-app --cpus 1 --memory 1g -e "MALLOC_CONF=background_thread:true,tcache_max:$conf" \
        -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e PORT=8080 -e HOSTS=idle-app \
        -v /root/fixtures-sizes/n1:/fixtures:ro "$1" >/dev/null
    sleep 6
    u0=$(usage); sleep 60; u1=$(usage)
    threads=$(docker exec idle-app sh -c 'ls /proc/1/task | wc -l')
    echo "round $round | $conf | $(( (u1 - u0) / 1000 )) ms CPU in 60 s | threads $threads" >> "$OUT"
  done
done
docker rm -f -v idle-app >/dev/null 2>&1
echo "# idle done" >> "$OUT"
