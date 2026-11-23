#!/bin/sh
# /root/start.sh: the entry point of kit 1938c (corten-run/corten#1938's integrated pair after
# round 3 of review). With the kit uploaded as /root/cycles-1938c.tar and this file as /root/start.sh (it
# is 1938c/start.sh in the tar: tar -xOf /root/cycles-1938c.tar 1938c/start.sh >/root/start.sh),
# as root on a fresh Debian 13 x64 c-8, nothing else running:
#   sh /root/start.sh
# It unpacks the kit into /m, then runs setup.sh (packages, rustc 1.100.0, build.sh) and run.sh
# detached, both logging to /m/1938c/run.out, which ends with `EXIT <status>` and then ALL-DONE.
# Before them it says COMPLETE (every declared workload measured and summarised, EXIT 0) or
# INCOMPLETE with a FAILED line for each failure (EXIT nonzero; not a complete receipt). The
# results are in /m/1938c/results (summary-<workload>.txt, status.txt, exit.txt). Do not log in
# or run anything else on the host while it runs.
set -eu
[ -f /root/cycles-1938c.tar ] || { echo "upload the kit as /root/cycles-1938c.tar first"; exit 1; }
[ ! -e /m/1938c/run.out ] || { echo "/m/1938c/run.out exists: the kit has run here (move /m/1938c away to run it again)"; exit 1; }
mkdir -p /m && tar -xf /root/cycles-1938c.tar -C /m
nohup sh -c '
    rc=0
    if sh /m/1938c/setup.sh; then
        sh /m/1938c/run.sh || rc=$?
    else
        rc=$?
        echo "FAILED setup (exit $rc): nothing was built or measured"
        mkdir -p /m/1938c/results && echo INCOMPLETE >/m/1938c/results/status.txt
        echo "INCOMPLETE: setup failed"
    fi
    echo "$rc" >/m/1938c/results/exit.txt
    echo "EXIT $rc"
    echo ALL-DONE
    exit $rc
' >/m/1938c/run.out 2>&1 &
echo "started: tail -f /m/1938c/run.out until it ends with ALL-DONE"