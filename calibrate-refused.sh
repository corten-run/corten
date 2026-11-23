#!/bin/sh
# Finds the bound for #1846's `refused` workload on the built head: a store whose page and its
# zstd 1 are kept beside <fill> other pages, and whose room left is too little for the page's
# brotli 5, so the head gives zstd from then on as the base does. For each bound, from <from> down
# to <to> by <step>, the head is started with `refused <bound> <fill>` and its WARM line read
# (the probe's answer to the page after its warm-up): above the window the head gives br, in it
# zstd with an Age. The middle of the first run of zstd-and-kept bounds below a br one is
# taken, the base is checked there (zstd, kept), and <pr dir>/refused.env written.
# Usage: calibrate-refused.sh <pr dir> [fill from to step]   (defaults: 7 70000 58000 32)
# (1846r2's copy of D:\Temp\cycles\calibrate-refused.sh, unchanged in 1846r3 and 1846r4: the probe's WARM line now follows its
# fence, so a head start reports the page's coding after its brotli 5 job has run; port 18081, the
# 1923 kit's, so the kits do not need another port; everything else unchanged.)
# Measured on 04c209fca (no brotli 5; jemalloc; the page's zstd 1 is 1,817 bytes): the page is kept
# at 62,000 and not at 61,750, where it is more than an eighth of the bound (its counted size is
# 7,719 to 7,750 bytes). The head's window is
# estimated at about 63,700 to 65,300 (eight such pages, the zstd, and room under a brotli 5 of
# about 1,500 bytes); the default scan, 375 starts at about 0.35 s, takes about 2 minutes.
set -eu
P=$1; fill=${2:-7}; from=${3:-70000}; to=${4:-58000}; step=${5:-32}
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
port=18081; log=$P/results/calibrate.log; mkdir -p $P/results; : >"$log"
warm() { # <bin> <bound>: prints "<coding> <age>"
    out=$(mktemp)
    $J "$P/bin/$1" $port refused "$2" "$fill" >/dev/null 2>"$out" &
    pid=$!
    i=0
    until grep -q '^WARM' "$out"; do
        i=$((i + 1))
        if [ $i -gt 200 ] || ! kill -0 $pid 2>/dev/null; then
            kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
            echo "calibrate: $1 at $2: no WARM line: $(cat "$out")" >&2; rm -f "$out"; exit 1
        fi
        sleep 0.05
    done
    kill $pid; wait $pid 2>/dev/null || true
    sed -n 's/^WARM .*content-encoding \([^,]*\), age \([^,]*\),.*/\1 \2/p' "$out"
    rm -f "$out"
}
seen_br=; first=; last=
b=$from
while [ "$b" -ge "$to" ]; do
    set -- $(warm head $b)
    echo "$b $1 $2" >>"$log"
    if [ "$1" = br ] && [ "$2" != - ]; then
        [ -z "$first" ] || break
        seen_br=1
    elif [ -n "$seen_br" ] && [ "$1" = zstd ] && [ "$2" != - ]; then
        [ -n "$first" ] || first=$b
        last=$b
    elif [ -n "$first" ]; then
        break
    fi
    b=$((b - step))
done
[ -n "$seen_br" ] || { echo "calibrate: the head gave no kept br from $from down to $to (calibrate.log); raise <from>" >&2; exit 1; }
[ -n "$first" ] || { echo "calibrate: no zstd-and-kept bound below the br ones down to $to (calibrate.log)" >&2; exit 1; }
[ $((first - last)) -ge $((4 * step)) ] || { echo "calibrate: the window $last..$first is under 5 steps; use a smaller step" >&2; exit 1; }
mid=$(( (first + last) / 2 / step * step ))
set -- $(warm base $mid)
[ "$1" = zstd ] && [ "$2" != - ] || { echo "calibrate: the base at $mid gives $1, age $2" >&2; exit 1; }
set -- $(warm head $mid)
[ "$1" = zstd ] && [ "$2" != - ] || { echo "calibrate: the head at $mid gives $1, age $2" >&2; exit 1; }
printf 'REFUSED_BOUND=%s\nREFUSED_FILL=%s\n# head zstd and kept from %s to %s, br above; base zstd and kept at the bound (calibrate.log)\n' \
    "$mid" "$fill" "$last" "$first" >"$P/refused.env"
cat "$P/refused.env"