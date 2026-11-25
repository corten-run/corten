#!/bin/bash
# look2.sh: inside a rust:1-trixie container, off any measuring host, after look.sh. Starts each
# side's unpadded binary with a workload's start line and asks the workload's request once, as
# turns.sh's answer() asks it: the base twice (two starts) and the head once. Prints whether two
# starts of the base differ in a header but Date (a mask would be needed) and whether base and
# head answer the same. No load is sent and no counter is read.
set -u
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null 2>&1
apt-get install -y -q libjemalloc2 libzstd1 curl >/dev/null 2>&1
JE='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc $BIN $PORT plain'
GL='env PROBE_ALLOCATOR=glibc $BIN $PORT plain'
ask() { # <binary> <start> <path> <out prefix>
    env -i PATH="$PATH" HOME="$HOME" PORT=18083 BIN="$1" sh -c "exec $2" >/dev/null 2>"$4.serve" &
    pid=$!
    i=0
    until curl -s -o /dev/null http://127.0.0.1:18083/ </dev/null; do
        i=$((i + 1)); [ $i -lt 100 ] || { echo "nothing answers: $1"; cat "$4.serve"; kill $pid; return 1; }; sleep 0.1
    done
    curl -sS --max-time 10 -D "$4.raw-headers" -o "$4.body" -H 'Accept:' -H 'User-Agent:' "http://127.0.0.1:18083$3" </dev/null
    tr -d '\r' <"$4.raw-headers" | grep -iv '^date:' >"$4.headers"
    kill $pid; wait $pid 2>/dev/null || true
}
one() { # <plan> <workload> <path> <start>
    d=/look/answers/$1-$2; mkdir -p "$d"
    ask /look/w-$1/bin/base "$4" "$3" "$d/base-1" || return
    ask /look/w-$1/bin/base "$4" "$3" "$d/base-2" || return
    ask /look/w-$1/bin/head "$4" "$3" "$d/head" || return
    two=same; cmp -s "$d/base-1.headers" "$d/base-2.headers" || two=DIFFER
    bh=same; cmp -s "$d/base-1.headers" "$d/head.headers" || bh=DIFFER
    bb=same; cmp -s "$d/base-1.body" "$d/head.body" || bb=DIFFER
    echo "$1 $2: $(head -1 "$d/base-1.headers"); allocator $(grep -h ALLOCATOR "$d/base-1.serve" | head -1); two starts of base: headers $two; base and head: headers $bh, body $bb ($(wc -c <"$d/base-1.body") bytes)"
    [ "$bh" = same ] || diff "$d/base-1.headers" "$d/head.headers"
    [ "$two" = same ] || diff "$d/base-1.headers" "$d/base-2.headers"
}
one 2066 plain /private "$JE"
one 2066 unstaged /unstaged "$JE"
one 2066 plainglibc /private "$GL"
one 2066 unstagedglibc /unstaged "$GL"
one 2067 text /text "$JE"
one 2067 api /api/value "$JE"
one 2067 plain /private "$JE"
echo "--- headers of each answer (base, first start)"
for d in /look/answers/*; do echo "== $(basename "$d")"; cat "$d/base-1.headers"; done
echo LOOK2-DONE
# end
