#!/usr/bin/env bash
# Runs on the check droplet: what the app holds with many threads compressing long pages, by
# jemalloc's thread cache limit and on glibc. The app gets 8 CPUs; 64 connections ask for the
# 202,041-byte item page with brotli 20,000 times; the cgroup's memory is read as the load ends
# and 35 s after it. Usage: mem8.sh <image>
export PATH=/root/node/bin:$PATH
OUT=/root/mem8.out; : > "$OUT"
ROOT=/root/fixtures-sizes
mem() { docker exec mem-app sh -c 'cat /sys/fs/cgroup/memory.current; awk "/^anon / {print \$2}" /sys/fs/cgroup/memory.stat; ls /proc/1/task | wc -l' | tr '\n' ' '; }
for round in 1 2 3; do
  for conf in 65536 1048576 glibc; do
    if [ "$conf" = glibc ]; then env=(-e LD_PRELOAD= -e MALLOC_CONF=); else env=(-e "MALLOC_CONF=background_thread:true,tcache_max:$conf"); fi
    docker rm -f -v mem-app >/dev/null 2>&1
    docker run -d --name mem-app --cpuset-cpus 0-7 --memory 2g --ulimit nofile=65536:65536 -p 18482:8080 "${env[@]}" \
        -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:18482 -e EMBED_ORIGINS=http://127.0.0.1:18482 \
        -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "$ROOT/n160:/fixtures:ro" "$1" >/dev/null
    sleep 2
    read -r m0 a0 t0 <<< "$(mem)"
    failed=$(taskset -c 10-15 node /root/mem-load.mjs http://127.0.0.1:18482 "br" 20000 64)
    read -r m1 a1 t1 <<< "$(mem)"
    sleep 35
    read -r m2 a2 t2 <<< "$(mem)"
    awk -v r="$round" -v c="$conf" -v m0="$m0" -v a0="$a0" -v m1="$m1" -v a1="$a1" -v m2="$m2" -v a2="$a2" -v t="$t1" -v bad="$failed" \
        'BEGIN { printf "round %s | %s | threads %s | MiB memory.current (anon): before %.1f (%.1f) | as the load ended %.1f (%.1f) | 35 s after %.1f (%.1f) | failed %s\n", r, c, t, m0/1048576, a0/1048576, m1/1048576, a1/1048576, m2/1048576, a2/1048576, bad }' >> "$OUT"
  done
done
docker rm -f -v mem-app >/dev/null 2>&1
echo "# mem8 done" >> "$OUT"
