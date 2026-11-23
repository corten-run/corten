#!/bin/sh
# /root/start.sh: the entry point of corten-run/corten#1824's kit (1824f). With the kit uploaded
# as /root/cycles-1824f.tar and this file as /root/start.sh (it is 1824f/start.sh in the tar:
# tar -xOf /root/cycles-1824f.tar 1824f/start.sh >/root/start.sh), as root on a fresh Debian 13
# c-8:
#   sh /root/start.sh
# It unpacks the kit into /m, then setup.sh (packages, rustc 1.100.0, the builds) and run.sh, detached,
# both logging to /m/1824f/run.out, whose last line is ALL-DONE whatever happened, after EXIT <status>
# (0 only when every comparison ran and was summarized; SETUP-FAILED before it when setup or a
# build failed). PAIRS, JROOM_PAIRS, TURN, WARMUP, COMPARISONS, PERF and DRY_RUN are refused: the
# run is fixed by results/margin.md. The results are in
# /m/1824f/results (summary.txt is the table and the verdicts). Do not log in or run anything else
# on the host while it runs.
set -eu
[ -f /root/cycles-1824f.tar ] || { echo "upload the kit as /root/cycles-1824f.tar first"; exit 1; }
[ ! -e /m/1824f/run.out ] || { echo "/m/1824f/run.out exists: the kit has run here (move /m/1824f away to run it again)"; exit 1; }
for v in PAIRS JROOM_PAIRS TURN WARMUP COMPARISONS PERF DRY_RUN RESULTS; do
    eval "set_=\${$v+x}"
    [ -z "$set_" ] || { echo "$v is set: the run is fixed by results/margin.md; unset it"; exit 1; }
done
mkdir -p /m && tar -xf /root/cycles-1824f.tar -C /m
# run.sh ends its output EXIT <status> and ALL-DONE; if it stops any other way, the lines are added.
nohup sh -c '{ sh /m/1824f/setup.sh || { echo SETUP-FAILED; echo "EXIT 1"; echo ALL-DONE; exit 1; }
  sh /m/1824f/run.sh; s=$?
  [ "$(tail -n 1 /m/1824f/run.out)" = ALL-DONE ] || { echo "run.sh stopped without ending its output"; echo "EXIT $s"; echo ALL-DONE; }
  exit $s; } >/m/1824f/run.out 2>&1' >/dev/null 2>&1 &
echo "started: tail -f /m/1824f/run.out"