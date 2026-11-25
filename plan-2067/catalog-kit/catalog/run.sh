#!/bin/sh
# catalog/run.sh: the catalog's pairs, as the plan declares them. For each of `page` and `json`,
# pair 0 (not recorded) and pairs 1 to 100; a pair is one invocation of the repository's
# bench/fullstack/count.mjs for each side, exactly the two lines the plan gives:
#   docker tag cb-corten-<side> cb-corten
#   BENCH_APP_CPUS=1 BENCH_LOAD_CPUS=4-7 node bench/fullstack/count.mjs p2067-<target>-<pair>-<side> 1 corten <target>
# run from the head's tree (bench/ is the same bytes on both sides). `page`'s pair i and `json`'s
# pair i run one after the other; in the odd pairs the base goes first, in the even pairs the
# head. The round name is new for every invocation. For each invocation the image `cb-corten`
# names is recorded before and after it, with the side's own image, the script's exit status and
# the seconds it took (catalog-state/run/invocations.txt).
# No invocation is run again: one that was started is never started a second time, whatever
# became of it. If the host restarts, the unit setup.sh installed starts this script again and it
# goes on from the first invocation not yet started; the interrupted one stays as it was left.
# It refuses to start unless verify.mjs ended VERIFY-OK for the two images as they are now.
#   nohup sh /m/hc/catalog/run.sh >/m/hc/catalog.out 2>&1 &
# is over when the output ends with ALL-DONE; the line before says how it ended.
# DRYRUN=1 (a test of the scripts, read for nothing): the base's image stands under both sides'
# names, 3 pairs a target (12 invocations), round names that begin `dry-`; ends DRYRUN-DONE.
set -u
P=/m/hc; C=$P/catalog; T=$P/tree-head; S=$P/catalog-state; F=$T/bench/fullstack
say() { echo "$(date -u +%T) $*"; [ -z "${R:-}" ] || echo "$(date -u +%T) $*" >>$R/progress.log; }
if [ -f $S/armed ]; then
    # Going on after a restart: the mode and the names are the interrupted run's.
    . $S/armed
    resumed=1
else
    resumed=0
    if [ "${DRYRUN:-0}" = 1 ]; then MODE=dry; PREFIX=dry-$(date -u +%m%d%H%M%S); LAST=2; else MODE=run; PREFIX=p2067; LAST=100; fi
fi
if [ "$MODE" = dry ]; then R=$S/dry-$PREFIX; END=DRYRUN-DONE; else R=$S/run; END=ALL-DONE; fi
finish() { say "RUN-ENDED $2"; rm -f $S/armed; echo "$END"; exit "$1"; }
img() { if [ "$MODE" = dry ]; then echo cb-corten-base; else echo cb-corten-$1; fi; }
idof() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }
if [ $resumed = 0 ]; then
    [ ! -e "$R" ] || { R=; say "refused: $S/run already holds a run: no pair is run again"; echo "$END"; exit 1; }
    base=$(idof "$(img base)"); head=$(idof "$(img head)")
    [ -n "$base" ] && [ -n "$head" ] || { R=; say "refused: no image for a side: build.sh first"; echo "$END"; exit 1; }
    if [ "$MODE" = run ]; then
        [ "$base" != "$head" ] || { R=; say "refused: the two sides are one image"; echo "$END"; exit 1; }
        [ "$(tail -1 $S/verify/verify.txt 2>/dev/null)" = VERIFY-OK ] && [ "$(cat $S/verify/images.txt 2>/dev/null)" = "base $base
head $head" ] || { R=; say "refused: verify.mjs has not ended VERIFY-OK for these two images"; echo "$END"; exit 1; }
        [ -z "$(ls -d $F/results/p2067-* 2>/dev/null)" ] || { R=; say "refused: results/p2067-* exist already"; echo "$END"; exit 1; }
    fi
    mkdir -p $R/inv
    printf 'MODE=%s\nPREFIX=%s\nLAST=%s\n' "$MODE" "$PREFIX" "$LAST" >$S/armed
    : >$R/invocations.txt
    { echo "mode $MODE prefix $PREFIX pairs 0..$LAST (0 not recorded)"; echo "base $(img base) $base"; echo "head $(img head) $head"
      echo "kernel $(uname -r)"; echo "started $(date -u +%FT%TZ)"; } >$R/run.txt
    say "== catalog $MODE: pairs 0..$LAST for page and json, $(( (LAST + 1) * 4 )) invocations; base $base head $head"
else
    say "== going on after a restart (uptime $(cut -d. -f1 /proc/uptime) s, kernel $(uname -r)); nothing already started is started again"
    echo "restart noticed $(date -u +%FT%TZ), kernel $(uname -r)" >>$R/run.txt
fi
base=$(sed -n 's/^base [^ ]* //p' $R/run.txt); head=$(sed -n 's/^head [^ ]* //p' $R/run.txt)
i=0
while [ $i -le $LAST ]; do
    if [ $((i % 2)) = 1 ]; then order="base head"; else order="head base"; fi
    for target in page json; do
        for side in $order; do
            name=$(printf '%s-%s-%03d-%s' "$PREFIX" "$target" "$i" "$side")
            if [ -e $R/inv/$name.started ]; then
                [ -e $R/inv/$name.ended ] || { grep -q "^$name interrupted" $R/invocations.txt || { echo "$name interrupted: started $(cat $R/inv/$name.started), never ended; not run again" >>$R/invocations.txt; say "$name was interrupted; not run again"; }; }
                continue
            fi
            eval "want=\$$side"
            date -u +%FT%TZ >$R/inv/$name.started
            docker tag "$(img $side)" cb-corten
            before=$(idof cb-corten)
            t0=$(date +%s.%N)
            (cd $T && BENCH_APP_CPUS=1 BENCH_LOAD_CPUS=4-7 node bench/fullstack/count.mjs "$name" 1 corten "$target") >$R/inv/$name.log 2>&1 </dev/null
            rc=$?
            t1=$(date +%s.%N)
            after=$(idof cb-corten)
            secs=$(awk -v a=$t0 -v b=$t1 'BEGIN { printf "%.1f", b - a }')
            echo "$name target $target pair $i side $side want $want before $before after $after rc $rc seconds $secs" >>$R/invocations.txt
            date -u +%FT%TZ >$R/inv/$name.ended
            say "$name rc $rc ${secs}s $(tail -2 $R/inv/$name.log | head -1 | cut -c1-230)"
        done
    done
    i=$((i + 1))
done
node $C/report.mjs $R $F/results >$R/report.md 2>$R/report.err
rc=$?
case $rc in
    0) finish 0 "complete: every pair valid; $R/report.md" ;;
    1) finish 1 "incomplete: one or more pairs not valid, so a workload without its bound; $R/report.md" ;;
    *) finish 1 "report-crashed: report.mjs exit $rc: $(head -c 300 $R/report.err | tr '\n' ' ')" ;;
esac
