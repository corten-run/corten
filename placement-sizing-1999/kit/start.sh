# start.sh [<sha256 of the tar>]: unpacks /root/cycles-1996-1999.tar into /m (after checking its
# sha256 when one is given) and starts setup.sh, then run.sh, detached. The collector waits for
# ALL-DONE as the last line of /m/1999/run.out; the line before it, "RUN-ENDED <outcome>: ...",
# says how the run ended. run.sh and setup.sh write that pair themselves however they stop; if
# either is killed before it can, this wrapper adds one, so run.out always ends with ALL-DONE.
set -eu
TAR=/root/cycles-1996-1999.tar
if [ $# -ge 1 ]; then
    got=$(sha256sum $TAR | cut -d' ' -f1)
    [ "$got" = "$1" ] || { echo "start.sh: $TAR has sha256 $got, not $1: not unpacked, nothing started"; exit 1; }
fi
mkdir -p /m && tar -xf $TAR -C /m
nohup sh -c '
    if sh /m/1999/setup.sh > /root/setup-1999.log 2>&1; then sh /m/1999/run.sh > /m/1999/run.out 2>&1; st=$?; who=run.sh; else st=$?; who=setup.sh; fi
    if [ "$(tail -n 1 /m/1999/run.out 2>/dev/null)" != ALL-DONE ]; then
        { echo "RUN-ENDED $who-stopped: $who exit $st without its own end (see /root/setup-1999.log and run.out)"; echo ALL-DONE; } >> /m/1999/run.out
    fi
    echo ALL-DONE-WRAPPER >> /root/setup-1999.log' >/dev/null 2>&1 &
echo started
