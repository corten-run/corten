#!/usr/bin/env bash
# Runs on the check droplet: more card-market bodies (category pages, the home page it redirects to, JSON).
cd /root/corten-pr || exit 1
B=/root/bodies
docker rm -f -v corten-card-market >/dev/null 2>&1
docker run -d --name corten-card-market -p 18481:8080 -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:18481 -e EMBED_ORIGINS=http://127.0.0.1:18481 -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "$PWD/examples/card-market/fixtures:/fixtures:ro" corten-card-market >/dev/null
sleep 3
U=http://127.0.0.1:18481
grep -o 'href="/[^"]*"' "$B/item.html" | sort -u | head -30 | tr '\n' ' '; echo
i=0
for path in $(grep -o 'href="/[^"#]*"' "$B/item.html" "$B/home.html" | cut -d'"' -f2 | grep -vE '^/(corten|assets|static)|\.(css|js|png|svg|ico|webmanifest)' | sort -u | head -12); do
    i=$((i+1)); curl -sfL -H 'Accept: text/html' -o "$B/page-$i.html" "$U$path"; echo "page-$i $path $(wc -c < "$B/page-$i.html" 2>/dev/null)"
done
curl -sf -H 'Accept: application/json' -H 'Authorization: Bearer dev-key' -o "$B/api-items.json" "$U/api/items"; echo "api-items $(wc -c < "$B/api-items.json" 2>/dev/null)"
curl -sf -o "$B/item5.json" "$U/items/item_5.json"; echo "item5.json $(wc -c < "$B/item5.json" 2>/dev/null)"
docker rm -f -v corten-card-market >/dev/null 2>&1
