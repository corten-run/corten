#!/bin/sh
# Count host: the trial of state.sh again, with the check as corrected (it waits for tcpdump to
# read its last packets, and requires the capture to hold every answered request). The same
# binary of the base as the first trial.
exec > /root/trial2.out 2>&1
sha256sum /m/dl/bin/base | cut -c1-16
node /m/dl/state.mjs --selftest | tail -1
sh /m/dl/state.sh /m/dl/trial-state-2; echo "state.sh exit $?"
echo "== the wrk output of the first turn"; cat /m/dl/trial-state-2/base-1/wrk.txt
echo "== tcpdump"; cat /m/dl/trial-state-2/base-1/tcpdump.txt
echo "# TRIAL2-DONE"
