#!/bin/sh
# selftest.sh <work dir> [answers] [failed] [limit] [map]: after build.sh, shows on the host that
# what must stop a placement does (every case when none is named). It measures nothing and writes
# under <work dir>/selftest only.
#   answers   a wrong answer: side B is a stand-in that answers 200 with another body
#             (wrong.mjs). turns.sh must fail before any turn and leave no counts file.
#   failed    a failed request: the request is one the probe answers 404, which both binaries
#             answer alike, so the answers pass (the status asked of them is 404 here) and the
#             load's requests all fail. wrk reports them, the turn must fail, and no row may be
#             recorded for it.
#   limit     a placement past its time limit: the same placement under `timeout 1` must be
#             stopped, leave no recorded pair and no server running.
#   map       a second pad of a wrong size: each side's first placement is linked with a second
#             pad of 8 bytes, which is none of the four sizes, and with each of the four; map.mjs's
#             check must refuse the 8, pass each size that puts .data where the rule says and
#             refuse each that does not, at least one. Nothing is started.
# Prints one line a case and SELFTEST-OK, or stops at the first that does not hold.
set -u
[ $# -ge 1 ] && [ -f "$1/plan/resolved.sh" ] || { echo "usage: selftest.sh <work dir> [answers] [failed] [limit] [map]" >&2; exit 2; }
. "$1/plan/resolved.sh"; shift
[ $# -gt 0 ] || set -- answers failed limit map
B=$WORK/bin; PL=$WORK/plan; out=$WORK/selftest
rm -rf "${out:?}"; mkdir -p "$out"
export KIT START EVENTS CPU_SERVER CPU_LOAD WRK_T WRK_C
export HEADERS="$PL/headers.txt" SCRIPT="$PL/request.lua" MASK="$PL/mask.sed" MASK_JSON="$PL/mask.json" WARMUP=1 TURN=1 EXPECT=
first=$(echo "$PADS_P" | cut -d' ' -f1)
bad() { echo "SELFTEST FAILED: $*"; exit 1; }
run() { # <dir> <path> <status> <binary B> [<time limit>]
    REQ_PATH=$2 STATUS=$3 timeout -k 30 "${5:-120}" taskset -c "$CPU_DRIVER" sh "$KIT/turns.sh" "$1" "$W" 1 "$B/base-p$first" "$4" >"$1.log" 2>&1 </dev/null
}
rows() { if [ -f "$1/counts-$W.csv" ]; then echo $(( $(wc -l <"$1/counts-$W.csv") - 1 )); else echo none; fi; }
for case in "$@"; do
    case $case in
    answers)
        printf '#!/bin/sh\nunset LD_PRELOAD\nexec node %s/selftest/wrong.mjs "$1"\n' "$KIT" >"$out/wrong-bin"; chmod +x "$out/wrong-bin"
        run "$out/wrong" "$REQ_PATH" "$STATUS" "$out/wrong-bin"; rc=$?
        [ $rc != 0 ] && grep -q "A and B answer differently" "$out/wrong.log" && [ "$(rows "$out/wrong")" = none ] \
            || { tail -5 "$out/wrong.log"; bad "a wrong answer did not stop the placement (exit $rc, rows $(rows "$out/wrong"))"; }
        echo "answers: a wrong answer stopped the placement before any turn (exit $rc, no counts file): $(grep -m1 'answer differently' "$out/wrong.log")" ;;
    failed)
        run "$out/failed" /no-such-path 404 "$B/base-p$first"; rc=$?
        [ $rc != 0 ] && grep -q "errors in pair" "$out/failed.log" && [ "$(rows "$out/failed")" = 0 ] \
            || { tail -5 "$out/failed.log"; bad "failed requests did not stop the turn (exit $rc, rows $(rows "$out/failed"))"; }
        echo "failed: a turn with failed requests recorded nothing (exit $rc, 0 rows): $(grep -m1 'errors in pair' "$out/failed.log")" ;;
    limit)
        run "$out/slow" "$REQ_PATH" "$STATUS" "$B/base-p$first" 1; rc=$?
        { [ $rc = 124 ] || [ $rc = 137 ]; } && { [ "$(rows "$out/slow")" = none ] || [ "$(rows "$out/slow")" = 0 ]; } \
            || bad "the time limit did not stop the placement (exit $rc, rows $(rows "$out/slow"))"
        sleep 2
        ! curl -s -o /dev/null http://127.0.0.1:18081/ </dev/null && ! curl -s -o /dev/null http://127.0.0.1:18082/ </dev/null \
            || bad "a server was left running after the time limit"
        echo "limit: a placement past its time limit was stopped (exit $rc), with no recorded pair and no server left" ;;
    map)
        m=$out/map; mkdir -p "$m"
        printf '\t.section .text.corten_layout_pad2,"axR",@progbits\n\t.p2align 4\n\t.type corten_layout_pad2,@function\ncorten_layout_pad2:\n\t.skip 8, 0xcc\n\t.size corten_layout_pad2, 8\n' >"$m/pad2-8.s"
        cc -c "$m/pad2-8.s" -o "$m/pad2-8.o" || bad "the 8-byte pad did not assemble"
        cp "$WORK"/pads/pad2-*.o "$m/"
        for s in $SIDES; do
            fit=; unfit=
            for n in 8 16 32 48 64; do
                node "$KIT/relink.mjs" "$WORK/capture/$s" "$m/$s-p$first-l$n" --map "$m/$s-l$n.map" --pad "$WORK/pads/pad-$first.o" --order "$WORK/pads/order.txt" --second "$m/pad2-$n.o" || bad "relink failed: $s with a second pad of $n"
                node "$KIT/map.mjs" check "$WORK/maps/$s.map" "$m/$s-l$n.map" "$first" "$n" >"$m/$s-l$n.txt" 2>&1; rc=$?
                if [ $n = 8 ]; then
                    [ $rc != 0 ] && grep -q "a second pad of 8 bytes is not one of" "$m/$s-l$n.txt" || { cat "$m/$s-l$n.txt"; bad "$s: a second pad of 8 bytes passed the map check"; }
                elif node "$KIT/map.mjs" data "$WORK/maps/$s.map" "$m/$s-l$n.map" "$first" >/dev/null; then
                    [ $rc = 0 ] || { cat "$m/$s-l$n.txt"; bad "$s: a second pad of $n puts .data where the rule says and failed the map check"; }
                    fit="$fit $n"
                else
                    [ $rc != 0 ] && grep -q "\.data begins" "$m/$s-l$n.txt" || { cat "$m/$s-l$n.txt"; bad "$s: a second pad of $n puts .data elsewhere and passed the map check"; }
                    unfit="$unfit $n"
                fi
            done
            [ -n "$unfit" ] || bad "$s: every size put .data where the rule says, so none was refused"
            echo "map: $s-p$first: a second pad of 8 bytes refused ($(grep -o 'a second pad of 8 bytes is not one of[^"]*' "$m/$s-l8.txt" | head -1)); of the four sizes,${fit:- none} put .data where the rule says and passed the map check;$unfit did not and were refused (with ${unfit##* }: $(grep -o '\.data begins[^"]*' "$m/$s-l${unfit##* }.txt" | head -1))"
            rm -f "$m/$s-p$first"-l* "$m/$s"-l*.map
        done ;;
    *) bad "no case $case" ;;
    esac
done
echo SELFTEST-OK
