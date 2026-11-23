#!/usr/bin/env bash
# Runs on the measuring droplet: instructions (callgrind) and time a request for card-market's
# item page, in process (`route_loop`, LOOP_TARGET=document), before and after, per Accept-Encoding.
# Usage: gz-count.sh <bundle> <base commit> <candidate ref>
export PATH=/root/.cargo/bin:$PATH
BUNDLE=$1; BASE=$2; CAND=$3
OUT=/root/gz-count; mkdir -p "$OUT"; SUM=$OUT/${SUMMARY:-summary.txt}; : > "$SUM"
cd /root/corten-pr || exit 1
git fetch -q "$BUNDLE" "+refs/heads/$CAND:refs/heads/$CAND" || exit 1
python3 - <<'PY'
import json
d = json.load(open('/root/corten-pr/examples/card-market/fixtures/smoke.json'))
import os, copy
item = d['item_5']
if os.environ.get('LONG'):
    # The long page bodies3.sh renders: contents and field values repeated 20 times under varied names.
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
text = json.dumps(item)
out = {f'item_{n}': json.loads(text.replace('"item_5"', f'"item_{n}"')) for n in range(1, 501)}
json.dump(out, open('/root/items500.json', 'w'))
PY
declare -A BIN
for side in base cand; do
    commit=$BASE; [ "$side" = cand ] && commit=$CAND
    git worktree remove --force /root/gz-$side >/dev/null 2>&1
    git worktree add -q --detach /root/gz-$side "$commit" || exit 1
    ( cd /root/gz-$side && CARGO_TARGET_DIR=/root/target-gz-$side cargo test --release -p card-market --no-run --message-format=json 2>"$OUT/build-$side.log" \
        | python3 -c "
import sys, json
for line in sys.stdin:
    try: o = json.loads(line)
    except Exception: continue
    if o.get('reason') == 'compiler-artifact' and o.get('executable') and o['target']['name'] == 'card-market' and o['profile']['test']: print(o['executable'])
" | tail -1 > "$OUT/bin-$side" )
    BIN[$side]=$(cat "$OUT/bin-$side"); [ -x "${BIN[$side]}" ] || { echo "no test binary for $side"; tail -5 "$OUT/build-$side.log"; exit 1; }
    echo "# $side $(git -C /root/gz-$side log -1 --format=%h) ${BIN[$side]}" >> "$SUM"
done
export CORTEN_FIXTURE=/root/items500.json LOOP_TARGET=document
run() { # side encoding seconds callgrind?  -> "requests instructions us"
    local side=$1 enc=$2 secs=$3 cg=$4 log; log=$(mktemp)
    if [ "$cg" = 1 ]; then
        LOOP_ENCODING="$enc" LOOP_SECONDS=$secs taskset -c 3 valgrind --tool=callgrind --callgrind-out-file=/dev/null "${BIN[$side]}" --ignored route_loop --nocapture > "$log" 2>&1
    else
        LOOP_ENCODING="$enc" LOOP_SECONDS=$secs taskset -c 3 "${BIN[$side]}" --ignored route_loop --nocapture > "$log" 2>&1
    fi
    local n ir us ce
    n=$(grep -oP 'document: \K\d+(?= requests)' "$log"); us=$(grep -oP '[\d.]+(?= us per request)' "$log")
    ir=$(grep -oP 'Collected : \K\d+' "$log"); ce=$(grep -oP 'content-encoding \K\S+' "$log")
    rm -f "$log"; echo "${n:-0} ${ir:-0} ${us:-0} ${ce:-none}"
}
IFS="|" read -ra ENCS <<< "${ENCODINGS:-identity|gzip, deflate, br, zstd|gzip, deflate, br|gzip|br}"
for enc in "${ENCS[@]}"; do
    for side in base cand; do
        for pair in 1 2 3; do
            read -r n1 i1 _ ce <<< "$(run $side "$enc" 4 1)"; read -r n2 i2 _ _ <<< "$(run $side "$enc" 16 1)"
            per=$(( (i2 - i1) / (n2 - n1) ))
            echo "count | $enc | $side | $ce | pair $pair | $per instructions a request ($n1 and $n2 requests)" >> "$SUM"
        done
    done
    for turn in 1 2 3; do for side in base cand; do
        read -r n _ us ce <<< "$(run $side "$enc" 5 0)"
        echo "time  | $enc | $side | $ce | turn $turn | $us us a request ($n requests)" >> "$SUM"
    done; done
done
echo "# gz-count done" >> "$SUM"
