#!/bin/sh
# part5.sh <pilot|gated> <tar> <tar's sha256> <plan.md's sha256> <workload> [<workload>]
# On a measuring host, started detached; the start is the last login until the part is over. Runs
# the host's workloads of one part as the plan orders them: the kit's tar unpacked afresh (the
# directory of what ran before is moved aside, not removed), the plan as posted beside it, then for
# each workload the kit's own two commands, setup.sh and run.sh, and the workload's results moved
# to /m/<part>5/<workload>/ before the next one's build. It is outside the kit, the tag and the
# tar and changes no file of them.
# Every way it ends, it then starts the done signal: a listener on port 47029, pinned to the
# driver's CPU (7), that accepts a connection and closes it, sending nothing. Nothing listens on
# that port while a workload builds or turns.
set -u
PART=${1:-}; TAR=${2:-}; WANT=${3:-}; PLANSHA=${4:-}
PORT=47029; PIDFILE=/root/done-listener.pid
OUT=/m/${PART}5
# PART5_TEST=1: a dry run of this wrapper (DRYRUN=1 for the kit's scripts: 3 placements, 2 pairs,
# 1 s turns, results marked DRYRUN, not a measurement), kept apart from a part's own directory.
if [ "${PART5_TEST:-0}" = 1 ]; then OUT=/m/part5-test-$(date -u +%H%M%S); export DRYRUN=1; echo "PART5_TEST: a dry run of the wrapper, not a measurement"; fi
signal() {
    trap - EXIT INT TERM
    echo "PART5-ENDED $PART $(date -u +%FT%TZ): $1"
    (taskset -c 7 nohup node -e 'require("net").createServer((s) => s.destroy()).listen(Number(process.argv[1]), "0.0.0.0")' $PORT >/dev/null 2>&1 </dev/null &
     echo $! >$PIDFILE)
}
trap 'signal "stopped with status $? before its end"' EXIT
trap 'signal "got INT"; exit 130' INT
trap 'signal "got TERM"; exit 143' TERM
stop() { signal "refused: $*"; exit 1; }
# A listener left from the part before is stopped before anything of this part starts.
if [ -f $PIDFILE ]; then
    p=$(cat $PIDFILE)
    case "$(cat /proc/$p/comm 2>/dev/null)" in node) kill "$p" 2>/dev/null; sleep 1 ;; esac
    rm -f $PIDFILE
fi
! ss -Hltn "sport = :$PORT" | grep -q . || stop "something still listens on port $PORT"
case "$PART" in pilot|gated) ;; *) stop "usage: part5.sh pilot|gated <tar> <sha256> <plan sha256> <workload> [<workload>]" ;; esac
shift 4
[ $# -ge 1 ] && [ $# -le 2 ] || stop "one or two workloads"
got=$(sha256sum "$TAR" | cut -d' ' -f1)
[ "$got" = "$WANT" ] || stop "the tar is $got, not $WANT"
got=$(sha256sum /root/plan-posted.md | cut -d' ' -f1)
[ "$got" = "$PLANSHA" ] || stop "/root/plan-posted.md is $got, not the plan as posted, $PLANSHA"
[ ! -e $OUT ] || stop "$OUT exists: this part was already started here, and nothing is run again"
left=$(pgrep -a 'wrk|perf|cargo|rustc|strace|tcpdump' | paste -sd';' -)
[ -z "$left" ] || stop "left running from before: $left"
echo "host $(hostname | sha256sum | cut -c1-8) $(. /etc/os-release; echo "$PRETTY_NAME") $(uname -r) $(nproc) CPUs; load $(cut -d' ' -f1-3 /proc/loadavg); $(date -u +%FT%TZ)"
mkdir -p $OUT
if [ -e /m/dl ]; then mkdir -p $OUT/before && mv /m/dl $OUT/before/ || stop "could not move the earlier /m/dl aside"; fi
tar -xf "$TAR" -C /m || stop "the tar did not unpack"
cp /root/plan-posted.md /m/dl/plan.md
grep -qx "PART=$PART" /m/dl/plan.env || stop "the tar's plan.env is not the $PART part's: $(grep '^PART=' /m/dl/plan.env)"
echo "tar $WANT; plan.md $PLANSHA; $(grep -E '^KIT=' /m/dl/plan.env /m/dl/commits.env 2>/dev/null | head -1)"
for W in "$@"; do
    mkdir -p $OUT/$W
    echo "== $W: setup and build $(date -u +%T)"
    if sh /m/dl/setup.sh "$W" >$OUT/$W/setup.log 2>&1; then
        echo "== $W: run $(date -u +%T)"
        sh /m/dl/run.sh "$W" >/m/dl/run.out 2>&1; rc=$?
        echo "$W: run.sh exit $rc: $(tail -2 /m/dl/run.out | head -1 | cut -c1-300) $(date -u +%T)"
        cp /m/dl/run.out $OUT/$W/
    else
        echo "$W: stopped before any turn (setup.sh or the build): $(tail -3 $OUT/$W/setup.log | paste -sd'|' - | cut -c1-400)"
    fi
    [ ! -e /m/dl/results ] || mv /m/dl/results $OUT/$W/
    mkdir -p $OUT/$W/build && cp /m/dl/build-*.log /m/dl/bin/*.txt $OUT/$W/build/ 2>/dev/null
done
echo "left over after: $(pgrep -a 'wrk|perf|cargo|rustc|strace|tcpdump' | paste -sd';' -)"
signal "every workload of the host has ended"
