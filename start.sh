#!/bin/sh
# start.sh: 1846r4's entry point. Upload cycles-1846r4.tar and this file as /root/cycles-1846r4.tar
# and /root/start.sh on a fresh Debian 13 x64 c-8 (root, nothing else running), then:
#   sh /root/start.sh
# It unpacks the kit under /m and runs setup.sh and then run.sh detached, both into
# /m/1846r4/run.out, whose last two lines are "run.sh exit <n>" (or "setup.sh exit <n>:
# SETUP-FAILED") and ALL-DONE, however either ended. Exit 0 from run.sh is the only complete run
# with pass 1's gate met. Then collect /m/1846r4/results. Do not log in or run anything else
# meanwhile. The plan is fixed: PAIRS, TURN, WARMUP, MISS_PAIRS, MISS_TURN, EVENTS, NOPERF,
# WAIT_ROUNDS and WAIT_REPS are refused here and by run.sh. A dry run in a container (calibration
# and the checks, no pair recorded, not a result): DRYRUN=1 sh /root/start.sh
set -eu
for v in PAIRS TURN WARMUP MISS_PAIRS MISS_TURN EVENTS NOPERF WAIT_ROUNDS WAIT_REPS; do
    if eval "[ -n \"\${$v+x}\" ]"; then echo "start.sh: $v is set: the plan in results/margin.md is fixed"; exit 1; fi
done
case ${DRYRUN:-} in ''|1) ;; *) echo "start.sh: DRYRUN is 1 or unset"; exit 1 ;; esac
[ -f /root/cycles-1846r4.tar ] || { echo "no /root/cycles-1846r4.tar"; exit 1; }
[ ! -e /m/1846r4 ] || { echo "/m/1846r4 exists: a kit is unpacked and run once"; exit 1; }
mkdir -p /m && tar -xf /root/cycles-1846r4.tar -C /m
nohup sh -c 'sh /m/1846r4/setup.sh; s=$?; if [ $s = 0 ]; then sh /m/1846r4/run.sh; echo "run.sh exit $?"; else echo "setup.sh exit $s: SETUP-FAILED"; fi; echo ALL-DONE' >/m/1846r4/run.out 2>&1 &
echo "started: tail /m/1846r4/run.out until it ends with ALL-DONE"
