#!/usr/bin/env bash
# Runs on the check droplet: what the app holds after bursts of slow readers of uncompressed pages
# of 9,793 to 495,527 bytes (the mixed fixture of mix.py), by jemalloc's thread cache limit and on
# glibc. The app gets 8 CPUs; burst.py connects to the container's own address, so no proxy
# stands between; eight floods of 2,000 connections held 5 s each. Usage: burst.sh <image>
OUT=${OUT:-/root/burst.out}; : > "$OUT"
ulimit -n 65536
ITEMS=$(python3 /root/mix.py /root/corten-pr/examples/card-market/fixtures/smoke.json /root/fixtures-mix) || exit 1
for round in 1 2 3; do
  for conf in 65536 524288 glibc; do
    if [ "$conf" = glibc ]; then env=(-e LD_PRELOAD= -e MALLOC_CONF=); else env=(-e "MALLOC_CONF=background_thread:true,tcache_max:$conf"); fi
    docker rm -f -v mem-app >/dev/null 2>&1
    docker run -d --name mem-app --cpuset-cpus 0-7 --memory 4g --ulimit nofile=65536:65536 "${env[@]}" \
        -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json \
        -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v /root/fixtures-mix:/fixtures:ro "$1" >/dev/null
    sleep 2
    ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' mem-app)
    echo "round $round | $conf | $(taskset -c 10-15 python3 /root/burst.py "$ip" 8080 2000 8 5 $ITEMS)" >> "$OUT"
  done
done
docker rm -f -v mem-app >/dev/null 2>&1
echo "# burst done" >> "$OUT"
