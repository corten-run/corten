#!/bin/sh
# /root/start.sh: the entry point of kit 1938b (corten-run/corten#1938's supplement after round 2
# of review). With the kit uploaded as /root/cycles-1938b.tar and this file as /root/start.sh (it
# is 1938b/start.sh in the tar: tar -xOf /root/cycles-1938b.tar 1938b/start.sh >/root/start.sh),
# as root on a fresh Debian 13 x64 c-8 (or after kit 1938 on the same host, never during it):
#   sh /root/start.sh
# It unpacks the kit into /m, then runs setup.sh (packages, rustc 1.100.0, build.sh) and run.sh
# detached, both logging to /m/1938b/run.out, which ends with `EXIT <status>` and then ALL-DONE.
# Before them it says COMPLETE (every declared workload measured and summarised, EXIT 0) or
# INCOMPLETE with a FAILED line for each failure (EXIT nonzero; not a complete receipt). The
# results are in /m/1938b/results (summary-<workload>.txt, status.txt, exit.txt). Do not log in
# or run anything else on the host while it runs.
set -eu
[ -f /root/cycles-1938b.tar ] || { echo "upload the kit as /root/cycles-1938b.tar first"; exit 1; }
[ ! -e /m/1938b/run.out ] || { echo "/m/1938b/run.out exists: the kit has run here (move /m/1938b away to run it again)"; exit 1; }
mkdir -p /m && tar -xf /root/cycles-1938b.tar -C /m
nohup sh -c '
    rc=0
    if sh /m/1938b/setup.sh; then
        sh /m/1938b/run.sh || rc=$?
    else
        rc=$?
        echo "FAILED setup (exit $rc): nothing was built or measured"
        mkdir -p /m/1938b/results && echo INCOMPLETE >/m/1938b/results/status.txt
        echo "INCOMPLETE: setup failed"
    fi
    echo "$rc" >/m/1938b/results/exit.txt
    echo "EXIT $rc"
    echo ALL-DONE
    exit $rc
' >/m/1938b/run.out 2>&1 &
echo "started: tail -f /m/1938b/run.out until it ends with ALL-DONE"