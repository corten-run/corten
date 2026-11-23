#!/usr/bin/env bash
# Runs on the check droplet, after the cycles run: the two limits' answers for each compressed
# workload of that run, compared but Date and ETag (the app's weak tag differs between any two
# starts). Usage: answers.sh <image>
OUT=/root/answers2.out; : > "$OUT"
run() { # name, port, limit, fixture
    docker rm -f -v "$1" >/dev/null 2>&1
    docker run -d --name "$1" --cpuset-cpus 9 --memory 1g -p "$2:8080" -e "MALLOC_CONF=background_thread:true,tcache_max:$3" \
        -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e "AGENT_ORIGINS=http://127.0.0.1:$2" -e "EMBED_ORIGINS=http://127.0.0.1:$2" \
        -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "$4:/fixtures:ro" "$IMAGE" >/dev/null
}
IMAGE=$1; cd "$(mktemp -d)" || exit 1
for w in "n20|br" "n160|br" "n1|br" "n1|gzip, deflate, br, zstd"; do
    fix=${w%%|*}; enc=${w##*|}
    run ans-a 18498 65536 "/root/fixtures-sizes/$fix"; run ans-b 18499 1048576 "/root/fixtures-sizes/$fix"; sleep 2
    for s in a:18498 b:18499; do
        n=${s%%:*}; p=${s##*:}
        curl -s -D "$n.h" -o "$n.body" -H "Accept-Encoding: $enc" "http://127.0.0.1:$p/items/item_5"
        curl -s --compressed -o "$n.dec" -H "Accept-Encoding: $enc" "http://127.0.0.1:$p/items/item_5"
    done
    h=differ; diff <(grep -aviE '^(date|etag):' a.h) <(grep -aviE '^(date|etag):' b.h) >/dev/null && h=same
    b=differ; cmp -s a.body b.body && b=same
    d=differ; cmp -s a.dec b.dec && d=same
    echo "$fix | $enc | headers but Date and ETag: $h ($(grep -acvE '^\s*$' a.h) lines, $(grep -ai '^content-encoding' a.h | tr -d '\r')) | body as sent: $b ($(wc -c < a.body) bytes) | body decoded: $d ($(wc -c < a.dec) bytes) | etags $(grep -ai '^etag' a.h | tr -d '\r') and $(grep -ai '^etag' b.h | tr -d '\r')" >> "$OUT"
done
docker rm -f -v ans-a ans-b >/dev/null 2>&1
echo "# answers done" >> "$OUT"
