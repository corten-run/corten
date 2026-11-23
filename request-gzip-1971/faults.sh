#!/usr/bin/env bash
# Runs on the check droplet: minor page faults and CPU time a request for card-market's item
# page, by image, allocator setting and Accept-Encoding, as bench/fullstack/alloc-faults.mjs
# counts them (the server's /proc/1/stat before and after the requests).
# Usage: faults.sh <base image> <candidate image>
export PATH=/root/node/bin:$PATH
OUT=${OUT:-/root/faults.out}; : > "$OUT"
FIXTURES=${FIXTURES:-/root/corten-pr/examples/card-market/fixtures}
IFS="|" read -ra ENCS <<< "${ENCODINGS:-gzip, br|gzip|br|gzip, deflate, br, zstd}"
cd /root/corten-pr || exit 1
REQUESTS=${REQUESTS:-3000}
stat() { docker exec faults-app cat /proc/1/stat | awk '{print $10, $14 + $15}'; }
for round in 1 2 3; do
  for image in "$1" "$2"; do
    for alloc in tuned jemalloc-defaults glibc; do
      case $alloc in tuned) env=() ;; jemalloc-defaults) env=(-e MALLOC_CONF=) ;; glibc) env=(-e LD_PRELOAD= -e MALLOC_CONF=) ;; esac
      for enc in "${ENCS[@]}"; do
        docker rm -f -v faults-app >/dev/null 2>&1
        docker run -d --name faults-app --cpus 1 --memory 1g -p 18481:8080 "${env[@]}" \
            -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:18481 -e EMBED_ORIGINS=http://127.0.0.1:18481 \
            -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "$FIXTURES:/fixtures:ro" "$image" >/dev/null
        sleep 2
        failed=$(node /root/faults-load.mjs http://127.0.0.1:18481 "$enc" 500)
        read -r f0 t0 <<< "$(stat)"
        failed=$((failed + $(node /root/faults-load.mjs http://127.0.0.1:18481 "$enc" "$REQUESTS")))
        read -r f1 t1 <<< "$(stat)"
        coded=$(curl -s -o /dev/null -D - -H "Accept-Encoding: $enc" http://127.0.0.1:18481/items/item_5 | grep -i '^content-encoding' | tr -d '\r' | cut -d' ' -f2)
        size=$(curl -s -o /dev/null -w '%{size_download}' -H "Accept-Encoding: $enc" http://127.0.0.1:18481/items/item_5)
        awk -v r="$round" -v i="$image" -v a="$alloc" -v e="$enc" -v c="$coded" -v s="$size" -v f=$((f1 - f0)) -v t=$((t1 - t0)) -v n="$REQUESTS" -v bad="$failed" \
            'BEGIN { printf "round %s | %s | %s | %s | sent %s, %s bytes | %.2f faults a request | %.0f us CPU a request | failed %s\n", r, i, a, e, c, s, f / n, t * 10000 / n, bad }' >> "$OUT"
      done
    done
  done
done
docker rm -f -v faults-app >/dev/null 2>&1
echo "# faults done" >> "$OUT"
