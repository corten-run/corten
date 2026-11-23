#!/usr/bin/env bash
# Runs on the check droplet: page faults and CPU a request for item pages of several lengths sent
# with brotli, by jemalloc's thread cache limit, and on glibc. Usage: faults4.sh <image>
export PATH=/root/node/bin:$PATH
OUT=${OUT:-/root/faults-sizes.out}; : > "$OUT"
NS=${NS:-1 3 5 10 20 40 80 160}
CONFS=${CONFS:-65536 131072 262144 524288 1048576 4194304 glibc}
REQUESTS=${REQUESTS:-2000}
ROOT=/root/fixtures-sizes
python3 /root/sizes.py /root/corten-pr/examples/card-market/fixtures/smoke.json "$ROOT" $NS > /dev/null || exit 1
stat() { docker exec faults-app cat /proc/1/stat | awk '{print $10, $14 + $15}'; }
for round in 1 2 3; do
  for n in $NS; do
    for conf in $CONFS; do
      if [ "$conf" = glibc ]; then env=(-e LD_PRELOAD= -e MALLOC_CONF=); else env=(-e "MALLOC_CONF=background_thread:true,tcache_max:$conf"); fi
      docker rm -f -v faults-app >/dev/null 2>&1
      docker run -d --name faults-app --cpus 1 --memory 1g -p 18491:8080 "${env[@]}" \
          -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:18491 -e EMBED_ORIGINS=http://127.0.0.1:18491 \
          -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "$ROOT/n$n:/fixtures:ro" "$1" >/dev/null
      sleep 2
      failed=$(node /root/faults-load.mjs http://127.0.0.1:18491 "br" 300)
      read -r f0 t0 <<< "$(stat)"
      failed=$((failed + $(node /root/faults-load.mjs http://127.0.0.1:18491 "br" "$REQUESTS")))
      read -r f1 t1 <<< "$(stat)"
      plain=$(curl -s -o /dev/null -w '%{size_download}' http://127.0.0.1:18491/items/item_5)
      size=$(curl -s -o /dev/null -w '%{size_download}' -H "Accept-Encoding: br" http://127.0.0.1:18491/items/item_5)
      rss=$(docker exec faults-app awk '/VmRSS/ {print $2}' /proc/1/status)
      awk -v r="$round" -v a="$conf" -v x="$plain" -v s="$size" -v f=$((f1 - f0)) -v t=$((t1 - t0)) -v n="$REQUESTS" -v bad="$failed" -v rss="$rss" \
          'BEGIN { printf "round %s | %s | page %s bytes | br %s bytes | %.2f faults a request | %.0f us CPU a request | rss %s kB | failed %s\n", r, a, x, s, f / n, t * 10000 / n, rss, bad }' >> "$OUT"
    done
  done
done
docker rm -f -v faults-app >/dev/null 2>&1
echo "# faults4 done" >> "$OUT"
