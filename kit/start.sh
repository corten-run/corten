#!/bin/sh
# start.sh: 1846w's entry point. Upload cycles-1846w.tar and this file as /root/cycles-1846w.tar
# and /root/start.sh on a fresh Debian 13 x64 c-8 (root, nothing else running), then:
#   sh /root/start.sh
# It unpacks the kit under /m and runs setup.sh and run.sh detached, both into /m/1846w/run.out,
# which ends with ALL-DONE (after SETUP-OR-RUN-FAILED if either stopped first). Then collect
# /m/1846w/results. Do not log in or run anything else meanwhile.
set -eu
[ -f /root/cycles-1846w.tar ] || { echo "no /root/cycles-1846w.tar"; exit 1; }
[ ! -e /m/1846w ] || { echo "/m/1846w exists: a kit is unpacked once"; exit 1; }
mkdir -p /m && tar -xf /root/cycles-1846w.tar -C /m
nohup sh -c '{ sh /m/1846w/setup.sh && sh /m/1846w/run.sh; } >/m/1846w/run.out 2>&1 || { echo SETUP-OR-RUN-FAILED; echo ALL-DONE; } >>/m/1846w/run.out' >/dev/null 2>&1 &
echo "started: tail /m/1846w/run.out until it ends with ALL-DONE"
