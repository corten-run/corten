#!/usr/bin/env bash
# Runs on the check droplet: save card-market's home page, an item page and the item as JSON,
# uncompressed, for compbench. The image is the one the checks built.
cd /root/corten-pr || exit 1
B=/root/bodies; mkdir -p "$B"
docker rm -f -v corten-card-market >/dev/null 2>&1
docker run -d --name corten-card-market -p 18481:8080 -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:18481 -e EMBED_ORIGINS=http://127.0.0.1:18481 -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "$PWD/examples/card-market/fixtures:/fixtures:ro" corten-card-market >/dev/null
sleep 3
curl -sf -H 'Accept: text/html' -o "$B/home.html" http://127.0.0.1:18481/
item=$(grep -o 'href="/items/[^"]*"' "$B/home.html" | head -1 | cut -d'"' -f2)
echo "item: $item"
curl -sf -H 'Accept: text/html' -o "$B/item.html" "http://127.0.0.1:18481$item"
curl -sf -H 'Accept: application/json' -o "$B/item.json" "http://127.0.0.1:18481$item"
for enc in zstd br gzip; do printf '%s item.html: ' "$enc"; curl -s -o /dev/null -w '%{size_download} bytes, %{http_code}\n' -H 'Accept: text/html' -H "Accept-Encoding: $enc" "http://127.0.0.1:18481$item"; done
docker rm -f -v corten-card-market >/dev/null 2>&1
wc -c "$B"/*
