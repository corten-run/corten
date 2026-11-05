# Profiles card-market's release build under callgrind serving the item page and its JSON over one
# keep-alive connection, uncompressed, as N1 and then N2 requests in two runs, so the difference
# divided by N2 - N1 is one request's cost with startup and shutdown cancelled out; then split it
# by crate with cost-by-crate.mjs. Run from the repository root in rust:1-bookworm, as the
# README's "Instructions per request, by crate" says. Dumps go to /out.
# TARGETS (page json), SOURCE (fixture, or api with API_BASE for the item API), each passed to
# docker run with -e. Every request must answer 200 over one connection, or it stops.
set -eo pipefail
if [ "${SOURCE:-fixture}" = api ] && [ -z "${API_BASE:-}" ]; then echo "SOURCE=api needs API_BASE" >&2; exit 1; fi
apt-get update -qq >/dev/null && apt-get install -y -qq valgrind curl >/dev/null 2>&1
cd /src
# Line tables only: the same code, with each instruction's source file for the split.
CARGO_PROFILE_RELEASE_DEBUG=line-tables-only cargo build -q --release -p card-market
bin=$CARGO_TARGET_DIR/release/card-market
for target in ${TARGETS:-page json}; do
  p=/items/item_; [ $target = json ] && p=/api/items/item_
  for n in 300 1300; do
    : > /tmp/run.txt
    for i in $(seq $n); do printf 'url = "http://localhost:8080%s%s"\noutput = /dev/null\n' "$p" "$(( (i % 500) + 1 ))" >> /tmp/run.txt; done
    out=/out/cg-$target-${SOURCE:-fixture}-$n.out
    HOST=127.0.0.1 PORT=8080 ITEM_SOURCE=${SOURCE:-fixture} FIXTURE_PATH=/fixtures/items.json API_BASE=${API_BASE:-} \
      valgrind --tool=callgrind --callgrind-out-file=$out $bin >/tmp/server-$target-$n.log 2>&1 &
    vg=$!
    until curl -s -o /dev/null http://127.0.0.1:8080/health/live; do sleep 1; done
    # One keep-alive connection, uncompressed, as the benchmark asks: each answer's status and
    # whether it opened a connection (only the first may).
    curl -s -H 'accept-encoding: identity' -w '%{http_code} %{num_connects}\n' -K /tmp/run.txt > /tmp/codes.txt
    sort /tmp/codes.txt | uniq -c
    if grep -qv '^200 ' /tmp/codes.txt || [ "$(grep -c ' 1$' /tmp/codes.txt)" != 1 ]; then
      echo "not every request answered 200 over one connection" >&2; kill -TERM $vg; exit 1
    fi
    kill -TERM $vg; wait $vg || true
    grep -E "Collected" /tmp/server-$target-$n.log | sed "s/^/$target n=$n /"
  done
done
echo EXIT=0
