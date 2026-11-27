#!/bin/sh
# selftest.sh <work dir> [answers] [failed] [limit] [map] [inputs] [refusals] [zero]: after
# build.sh, shows on the host that what must stop a placement, a build or a run does (every case
# when none is named). It measures nothing and writes under <work dir>/selftest only.
#   answers   a wrong answer: side B is a stand-in that answers 200 with another body
#             (wrong.mjs). turns.sh must fail before any turn and leave no counts file.
#             Then, with the difference that wrong answer made as the expected one, a stand-in
#             that answers with a third body of the wrong one's length (wrong.mjs other) must
#             fail the same way: the expected difference holds the bodies, not their lengths.
#             And a stand-in that answers with the probe's own body under its own headers
#             (wrong.mjs same) must fail as a wrong answer does, its diff.txt ending with the
#             line "bodies same: <N> bytes, sha256 <the probe's>": a difference in the headers
#             alone holds the body too. plan.mjs must take each diff.txt as an expected one.
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
#   inputs    files the plan names by path that are no longer what plan.mjs listed. build.sh, on
#             a copy of the plan, must build nothing for a probe with a file edited, for one with
#             a symbolic link added, for one with a listed file made a link to a file of the same
#             bytes, and for a list edited; run.sh must refuse a list edited after
#             the build before it makes a results directory, and a probe's copy edited after the
#             build before any server is started (that last one counts with perf, as every run
#             does first). Nothing is built, started or turned.
#   refusals  run.sh, on a copy of the plan, must refuse a work directory that already holds
#             results, binaries built for another part, and a host whose CPU model is not that of
#             the A/A the K was checked from. Nothing is started.
#   zero      a counter that read zero, with a stand-in for perf that reports 0 for every event:
#             run.sh must end perf-preflight-failed before any server is started, and turns.sh
#             must fail its first turn and record no row. The turn's load is real; no counter is
#             read.
# A copy of the plan is <work dir>/plan with its WORK changed, so the script under test writes
# under <work dir>/selftest and leaves the work directory's own build and results alone.
# Prints one line a case and SELFTEST-OK, or stops at the first that does not hold.
set -u
[ $# -ge 1 ] && [ -f "$1/plan/resolved.sh" ] || { echo "usage: selftest.sh <work dir> [answers] [failed] [limit] [map] [inputs] [refusals] [zero]" >&2; exit 2; }
. "$1/plan/resolved.sh"; shift
[ $# -gt 0 ] || set -- answers failed limit map inputs refusals zero
B=$WORK/bin; PL=$WORK/plan; out=$WORK/selftest
rm -rf "${out:?}"; mkdir -p "$out"
export KIT START EVENTS CPU_SERVER CPU_LOAD WRK_T WRK_C PORT_A PORT_B
export HEADERS="$PL/headers.txt" SCRIPT="$PL/request.lua" MASK="$PL/mask.sed" MASK_JSON="$PL/mask.json" WARMUP=1 TURN=1 EXPECT=
first=$(echo "$PADS_P" | cut -d' ' -f1)
bad() { echo "SELFTEST FAILED: $*"; exit 1; }
run() { # <dir> <path> <status> <binary B> [<time limit>]
    REQ_PATH=$2 STATUS=$3 timeout -k 30 "${5:-120}" taskset -c "$CPU_DRIVER" sh "$KIT/turns.sh" "$1" "$W" 1 "$B/base-p$first" "$4" >"$1.log" 2>&1 </dev/null
}
rows() { if [ -f "$1/counts-$W.csv" ]; then echo $(( $(wc -l <"$1/counts-$W.csv") - 1 )); else echo none; fi; }
taken() { # <diff.txt>: plan.mjs takes it as a workload's expected difference, or says why not
    node --input-type=module -e 'const { pathToFileURL } = await import("node:url"); const { readFileSync } = await import("node:fs"); const { expectProblem } = await import(pathToFileURL(process.argv[1] + "/plan.mjs")); const why = expectProblem(readFileSync(process.argv[2], "utf8")); if (why) { console.error(why); process.exit(1); }' "$KIT" "$1"
}
copy() { # <dir> [<sed expression>]: a work directory of its own that holds this one's plan
    rm -rf "$1"; mkdir -p "$1"; cp -R "$PL" "$1/plan"
    sed -e "s|^WORK=.*|WORK='$1'|" ${2:+-e "$2"} "$PL/resolved.sh" >"$1/plan/resolved.sh"
}
built() { ln -s "$B" "$1/bin"; }  # <dir>: the copy reads this work directory's binaries
refuses() { # <case> <dir> <outcome> <words>: run.sh on the copy must end with that outcome and those words
    sh "$KIT/run.sh" "$2" >"$2.log" 2>&1 </dev/null; rc=$?
    [ $rc = 1 ] && grep "^RUN-ENDED $3: " "$2.log" | grep -qF "$4" && [ ! -e "$2/results/verify.log" ] \
        || { tail -3 "$2.log"; bad "$1: run.sh did not end '$3: ... $4' (exit $rc)"; }
}
for case in "$@"; do
    case $case in
    answers)
        printf '#!/bin/sh\nunset LD_PRELOAD\nexec node %s/selftest/wrong.mjs "$1"\n' "$KIT" >"$out/wrong-bin"; chmod +x "$out/wrong-bin"
        printf '#!/bin/sh\nunset LD_PRELOAD\nexec node %s/selftest/wrong.mjs "$1" other\n' "$KIT" >"$out/other-bin"; chmod +x "$out/other-bin"
        printf '#!/bin/sh\nunset LD_PRELOAD\nexec node %s/selftest/wrong.mjs "$1" same %s/wrong/answers/A.body\n' "$KIT" "$out" >"$out/same-bin"; chmod +x "$out/same-bin"
        run "$out/wrong" "$REQ_PATH" "$STATUS" "$out/wrong-bin"; rc=$?
        [ $rc != 0 ] && grep -q "A and B answer differently" "$out/wrong.log" && [ "$(rows "$out/wrong")" = none ] \
            || { tail -5 "$out/wrong.log"; bad "a wrong answer did not stop the placement (exit $rc, rows $(rows "$out/wrong"))"; }
        echo "answers: a wrong answer stopped the placement before any turn (exit $rc, no counts file): $(grep -m1 'answer differently' "$out/wrong.log")"
        tail -n 1 "$out/wrong/answers/diff.txt" | grep -q '^bodies differ: .*, sha256 ' && taken "$out/wrong/answers/diff.txt" && cp "$out/wrong/answers/diff.txt" "$out/wrong-expect.txt" \
            || bad "the wrong answer's diff.txt does not end with a bodies line of the two digests that plan.mjs takes"
        (EXPECT=$out/wrong-expect.txt; export EXPECT; run "$out/other" "$REQ_PATH" "$STATUS" "$out/other-bin"); rc=$?
        [ $rc != 0 ] && grep -q "differ other than as the plan's expected difference says" "$out/other.log" && [ "$(rows "$out/other")" = none ] \
            || { tail -5 "$out/other.log"; bad "a third body of the wrong one's length passed the wrong one's difference (exit $rc, rows $(rows "$out/other"))"; }
        echo "answers: under that difference as the expected one, a third body of the same length stopped the placement before any turn (exit $rc, no counts file)"
        run "$out/same" "$REQ_PATH" "$STATUS" "$out/same-bin"; rc=$?
        body=$out/wrong/answers/A.body; digest=$(sha256sum <"$body"); digest=${digest%% *}
        [ $rc != 0 ] && grep -q "A and B answer differently" "$out/same.log" && [ "$(rows "$out/same")" = none ] \
            && tail -n 1 "$out/same/answers/diff.txt" | grep -qxF "bodies same: $(wc -c <"$body") bytes, sha256 $digest" && taken "$out/same/answers/diff.txt" \
            || { tail -5 "$out/same.log"; bad "the probe's body under other headers did not stop the placement with a diff.txt ending in its bodies same line (exit $rc, rows $(rows "$out/same"))"; }
        echo "answers: the probe's body under other headers stopped the placement before any turn (exit $rc, no counts file), its difference ending: $(tail -n 1 "$out/same/answers/diff.txt")" ;;
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
        # A refused connection is curl's 7; anything else (an answer, or 28 for one taken and never
        # answered within the second) is something still there.
        for port in $PORT_A $PORT_B; do
            cst=0; curl --disable --noproxy '*' -s --max-time 1 -o /dev/null "http://127.0.0.1:$port/" </dev/null || cst=$?
            [ $cst = 7 ] || bad "a server was left running after the time limit: something accepts on $port (curl status $cst)"
        done
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
    inputs)
        i=$out/inputs; mkdir -p "$i"
        probe() { rm -rf "$i/probe"; cp -R "$WORK/probe" "$i/probe"; rm -f "$i/probe/Cargo.lock"; }
        builds() { # <name> <words>: build.sh on the copy must stop with the words and build nothing
            sh "$KIT/build.sh" "$i/$1" >"$i/$1.log" 2>&1 </dev/null; rc=$?
            [ $rc = 1 ] && tail -1 "$i/$1.log" | grep -qF "$2" && [ ! -e "$i/$1/target-base" ] && [ ! -e "$i/$1/bin/base" ] \
                || { tail -3 "$i/$1.log"; bad "inputs: build.sh did not stop at '$2' for a probe $1 (exit $rc)"; }
        }
        one=$(sed -n 's/^[0-9a-f]*  probe\/\(.*\)$/\1/p' "$PL/inputs.sha256" | head -1)
        [ -n "$one" ] || bad "inputs: the plan's list names no file of the probe"
        probe; echo "edited after plan.mjs" >>"$i/probe/$one"
        copy "$i/edited" "s|^PROBE=.*|PROBE='$i/probe'|"; builds edited "is not what plan.mjs resolved"
        probe; ln -s "$PL" "$i/probe/selftest-link"
        copy "$i/linked" "s|^PROBE=.*|PROBE='$i/probe'|"; builds linked "holds a file or a symbolic link plan.mjs did not list"
        probe; cp "$i/probe/$one" "$i/same-bytes"; rm "$i/probe/$one"; ln -s "$i/same-bytes" "$i/probe/$one"
        copy "$i/swapped" "s|^PROBE=.*|PROBE='$i/probe'|"; builds swapped "holds a symbolic link where plan.mjs listed a file"
        probe
        copy "$i/relisted" "s|^PROBE=.*|PROBE='$i/probe'|"; echo "0  probe/selftest-none" >>"$i/relisted/plan/inputs.sha256"; builds relisted "plan/inputs.sha256 is not the list plan.mjs wrote"
        copy "$i/run-list"; built "$i/run-list"; echo "0  probe/selftest-none" >>"$i/run-list/plan/inputs.sha256"
        refuses inputs "$i/run-list" refused "plan/inputs.sha256 is not the list plan.mjs wrote"
        [ ! -e "$i/run-list/results" ] || bad "inputs: run.sh made a results directory for a list that was edited"
        copy "$i/run-probe"; built "$i/run-probe"; ln -s "$WORK/maps" "$i/run-probe/maps"; ln -s "$WORK/capture" "$i/run-probe/capture"
        for s in $SIDES; do ln -s "$WORK/build-$s.env" "$i/run-probe/build-$s.env"; done
        cp -R "$WORK/probe" "$i/run-probe/probe"; echo "edited after build.sh" >>"$i/run-probe/probe/$one"
        refuses inputs "$i/run-probe" refused "the probe as built, the request script or the expected answer is not what plan.mjs resolved"
        echo "inputs: build.sh built nothing for a probe with $one edited, with a symbolic link added, with $one made a link to a file of the same bytes, and with the list edited; run.sh refused a list edited after the build with no results directory made, and a probe's copy edited after the build before any server was started" ;;
    refusals)
        r=$out/refusals; mkdir -p "$r"
        copy "$r/again"; built "$r/again"; mkdir "$r/again/results"; echo kept >"$r/again/results/run-id"
        refuses refusals "$r/again" refused "already holds a run's results, and a part is run once"
        [ "$(ls -A "$r/again/results")" = run-id ] || bad "refusals: run.sh wrote into results it refused"
        copy "$r/other" "s|^PART=.*|PART='selftest'|"; built "$r/other"
        refuses refusals "$r/other" refused "not this plan's part selftest"
        copy "$r/model" "s|^SIZED_MODEL=.*|SIZED_MODEL='a CPU model no host has'|"; built "$r/model"
        refuses refusals "$r/model" refused "K was checked from an A/A read on 'a CPU model no host has'"
        [ ! -e "$r/other/results" ] && [ ! -e "$r/model/results" ] || bad "refusals: run.sh made a results directory for a run it refused"
        echo "refusals: run.sh refused a work directory that holds results, binaries built for another part, and a host of another CPU model than the A/A's, each before it made a results directory" ;;
    zero)
        z=$out/zero; mkdir -p "$z/bin"
        printf '%s\n' '#!/bin/sh' '# A stand-in for perf: runs the command it is given and reports 0 for every event, at 100%.' \
            '[ "${1:-}" = stat ] || exit 0' 'shift; ev=; to=/dev/stdout' 'while [ $# -gt 0 ]; do' \
            '    case $1 in -e) ev=$2; shift 2 ;; -o) to=$2; shift 2 ;; -p) shift 2 ;; --) shift; break ;; *) shift ;; esac' 'done' '"$@"' \
            'for e in $(echo "$ev" | tr "," " "); do echo "0,,$e,1000000000,100.00,,"; done >"$to"' >"$z/bin/perf"
        chmod +x "$z/bin/perf"
        copy "$z/work"; built "$z/work"
        (PATH="$z/bin:$PATH"; refuses zero "$z/work" perf-preflight-failed "each above zero and at 100%") || exit 1
        (PATH="$z/bin:$PATH"; run "$z/turn" "$REQ_PATH" "$STATUS" "$B/base-p$first"); rc=$?
        [ $rc != 0 ] && grep -q "unusable counter .* (not a count above zero)" "$z/turn.log" && [ "$(rows "$z/turn")" = 0 ] \
            || { tail -5 "$z/turn.log"; bad "zero: a counter that read zero did not fail the turn (exit $rc, rows $(rows "$z/turn"))"; }
        echo "zero: with every counter reported as 0, run.sh ended perf-preflight-failed before any server was started, and a turn failed with no row recorded (exit $rc): $(grep -o -m1 'unusable counter .* (not a count above zero)' "$z/turn.log")" ;;
    *) bad "no case $case" ;;
    esac
done
echo SELFTEST-OK
