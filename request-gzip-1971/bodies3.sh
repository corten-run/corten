#!/usr/bin/env bash
# Runs on the check droplet: a long item page (the fixture's item with its contents and field
# values repeated 20 times under varied names) rendered by card-market, saved for compbench.
cd /root/corten-pr || exit 1
B=/root/bodies; F=/root/fixtures-long; mkdir -p "$B" "$F"
python3 - <<'PY'
import json, copy
d = json.load(open('/root/corten-pr/examples/card-market/fixtures/smoke.json'))
item = d['item_5']
words = ['Amber', 'Basalt', 'Cinder', 'Dune', 'Ember', 'Fjord', 'Garnet', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lumen', 'Marrow', 'Nimbus', 'Onyx', 'Pewter', 'Quartz', 'Russet', 'Sable', 'Tundra']
def vary(value, n):
    if isinstance(value, dict):
        return {k: vary(v, n) for k, v in value.items()}
    if isinstance(value, list):
        return [vary(v, n) for v in value]
    if isinstance(value, str) and value and not value.startswith('http'):
        return f'{value} {words[n % 20]} {n * 7919 % 1000}' if ' ' in value or value[:1].isupper() else f'{value}_{n}'
    return value
for key in ('contents', 'field_values'):
    rows = item[key]
    item[key] = rows + [vary(copy.deepcopy(row), n) for n in range(1, 20) for row in rows]
json.dump(d, open('/root/fixtures-long/smoke.json', 'w'))
PY
docker rm -f -v bodies-app >/dev/null 2>&1
docker run -d --name bodies-app -p 18482:8080 -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:18482 -e EMBED_ORIGINS=http://127.0.0.1:18482 -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "$F:/fixtures:ro" corten-card-market-gz >/dev/null
sleep 3
curl -s -o "$B/item-long.html" -w 'item-long.html: %{http_code}\n' -H 'Accept: text/html' http://127.0.0.1:18482/items/item_5
for enc in zstd br gzip; do printf '%s: ' "$enc"; curl -s -o /dev/null -w '%{size_download} bytes, %{http_code}\n' -H 'Accept: text/html' -H "Accept-Encoding: $enc" http://127.0.0.1:18482/items/item_5; done
docker logs bodies-app 2>&1 | tail -3
docker rm -f -v bodies-app >/dev/null 2>&1
wc -c "$B"/item-long.html
