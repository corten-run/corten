#!/bin/sh
# /root/start.sh: the entry point of corten-run/corten#1824's kit (1824b). With the kit uploaded
# as /root/cycles-1824b.tar and this file as /root/start.sh (it is 1824b/start.sh in the tar:
# tar -xOf /root/cycles-1824b.tar 1824b/start.sh >/root/start.sh), as root on a fresh Debian 13
# c-8:
#   sh /root/start.sh
# It unpacks the kit into /m, then setup.sh (packages, rustc 1.100.0, the builds) and run.sh, detached,
# both logging to /m/1824b/run.out, which ends ALL-DONE (or SETUP-FAILED). The results are in
# /m/1824b/results (summary.txt is the table and the verdicts). Do not log in or run anything else
# on the host while it runs.
set -eu
[ -f /root/cycles-1824b.tar ] || { echo "upload the kit as /root/cycles-1824b.tar first"; exit 1; }
[ ! -e /m/1824b/run.out ] || { echo "/m/1824b/run.out exists: the kit has run here (move /m/1824b away to run it again)"; exit 1; }
mkdir -p /m && tar -xf /root/cycles-1824b.tar -C /m
nohup sh -c '{ sh /m/1824b/setup.sh || { echo SETUP-FAILED; exit 1; }; sh /m/1824b/run.sh; } >/m/1824b/run.out 2>&1' >/dev/null 2>&1 &
echo "started: tail -f /m/1824b/run.out"