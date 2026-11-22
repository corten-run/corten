#!/bin/sh
# /root/start.sh: the entry point of corten-run/corten#1824's kit (1824c). With the kit uploaded
# as /root/cycles-1824c.tar and this file as /root/start.sh (it is 1824c/start.sh in the tar:
# tar -xOf /root/cycles-1824c.tar 1824c/start.sh >/root/start.sh), as root on a fresh Debian 13
# c-8:
#   sh /root/start.sh
# It unpacks the kit into /m, then setup.sh (packages, rustc 1.100.0, the build) and run.sh,
# detached, both logging to /m/1824c/run.out, which ends ALL-DONE (or SETUP-FAILED). The results
# are in /m/1824c/results (summary.txt: the counters and the declared readings; profile.md: the
# sampled profile). Do not log in or run anything else on the host while it runs.
set -eu
[ -f /root/cycles-1824c.tar ] || { echo "upload the kit as /root/cycles-1824c.tar first"; exit 1; }
[ ! -e /m/1824c/run.out ] || { echo "/m/1824c/run.out exists: the kit has run here (move /m/1824c away to run it again)"; exit 1; }
mkdir -p /m && tar -xf /root/cycles-1824c.tar -C /m
nohup sh -c '{ sh /m/1824c/setup.sh || { echo SETUP-FAILED; exit 1; }; sh /m/1824c/run.sh; } >/m/1824c/run.out 2>&1' >/dev/null 2>&1 &
echo "started: tail -f /m/1824c/run.out"