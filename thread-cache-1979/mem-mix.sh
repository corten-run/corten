#!/usr/bin/env bash
# Runs on the check droplet: what the app holds with many threads compressing pages of several
# lengths, by jemalloc's thread cache limit and on glibc. The app gets 8 CPUs; 64 connections ask
# for the pages of a fixture whose items differ in length, in turn, with brotli, 20,000 times; the
# cgroup's memory is read as the load ends and 35 s after it. Then the one-length run of mem8.sh
# for the 512 KiB limit, which that script left out. Usage: mem-mix.sh <image>
export PATH=/root/node/bin:$PATH
OUT=/root/mem-mix.out; : > "$OUT"
ITEMS=$(python3 /root/mix.py /root/corten-pr/examples/card-market/fixtures/smoke.json /root/fixtures-mix) || exit 1
mem() { docker exec mem-app sh -c 'cat /sys/fs/cgroup/memory.current; awk "/^anon / {print \$2}" /sys/fs/cgroup/memory.stat; ls /proc/1/task | wc -l' | tr '\n' ' '; }
start() { # limit, fixture dir
    if [ "$1" = glibc ]; then env=(-e LD_PRELOAD= -e MALLOC_CONF=); else env=(-e "MALLOC_CONF=background_thread:true,tcache_max:$1"); fi
    docker rm -f -v mem-app >/dev/null 2>&1
    docker run -d --name mem-app --cpuset-cpus 0-7 --memory 2g --ulimit nofile=65536:65536 -p 18482:8080 "${env[@]}" \
        -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:18482 -e EMBED_ORIGINS=http://127.0.0.1:18482 \
        -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "$2:/fixtures:ro" "$IMAGE" >/dev/null
    sleep 2
}
row() { # label, round, limit, failed
    awk -v l="$1" -v r="$2" -v c="$3" -v m0="$m0" -v a0="$a0" -v m1="$m1" -v a1="$a1" -v m2="$m2" -v a2="$a2" -v t="$t1" -v bad="$4" \
        'BEGIN { printf "%s | round %s | %s | threads %s | MiB memory.current (anon): before %.1f (%.1f) | as the load ended %.1f (%.1f) | 35 s after %.1f (%.1f) | failed %s\n", l, r, c, t, m0/1048576, a0/1048576, m1/1048576, a1/1048576, m2/1048576, a2/1048576, bad }' >> "$OUT"
}
IMAGE=$1
start 65536 /root/fixtures-mix
echo "# items and their pages' bytes: $(for i in $ITEMS; do printf '%s %s; ' "$i" "$(curl -s -o /dev/null -w '%{size_download}' http://127.0.0.1:18482/items/$i)"; done)" >> "$OUT"
for round in 1 2 3; do
  for conf in 65536 524288 1048576 glibc; do
    start "$conf" /root/fixtures-mix
    read -r m0 a0 t0 <<< "$(mem)"
    failed=$(taskset -c 10-15 node /root/mem-load-mix.mjs http://127.0.0.1:18482 "br" 20000 64 $ITEMS)
    read -r m1 a1 t1 <<< "$(mem)"
    sleep 35
    read -r m2 a2 t2 <<< "$(mem)"
    row mixed "$round" "$conf" "$failed"
  done
  start 524288 /root/fixtures-sizes/n160
  read -r m0 a0 t0 <<< "$(mem)"
  failed=$(taskset -c 10-15 node /root/mem-load.mjs http://127.0.0.1:18482 "br" 20000 64)
  read -r m1 a1 t1 <<< "$(mem)"
  sleep 35
  read -r m2 a2 t2 <<< "$(mem)"
  row "202,041 bytes" "$round" 524288 "$failed"
done
docker rm -f -v mem-app >/dev/null 2>&1
echo "# mem-mix done" >> "$OUT"
