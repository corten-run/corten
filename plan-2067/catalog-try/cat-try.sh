#!/bin/bash
# cat-try.sh: on the build host, off every measuring host. A test of the catalog scripts as a plan
# carries them, on the base's image alone, read for nothing: verify.mjs and run.sh under DRYRUN=1
# and report.mjs, run in a Debian 13 container (the measuring hosts' system: its nodejs and its
# linux-perf) that drives the host's Docker. setup.sh and build.sh are not run here: the first is
# for a Debian 13 host with 8 CPUs, and the second empties the build cache, which this host shares.
set -u
L="--label agent.owner=author --label agent.task=stage-a"
P=/m/hc
mine() { [ "$(docker "$1" inspect "$2" --format "$3" 2>/dev/null)" = stage-a ]; }
docker ps -a --format '{{.Names}}' | grep -qx fsw-corten && { echo "REFUSED: a container named fsw-corten exists"; exit 3; }
for i in cb-corten cb-corten-head; do docker image inspect "$i" >/dev/null 2>&1 && { echo "REFUSED: an image named $i exists"; exit 3; }; done
if docker image inspect cb-corten-base >/dev/null 2>&1; then mine image cb-corten-base '{{index .Config.Labels "agent.task"}}' || { echo "REFUSED: an image named cb-corten-base exists and is not this try's"; exit 3; }; fi
if docker network inspect rustbench >/dev/null 2>&1; then mine network rustbench '{{index .Labels "agent.task"}}' || { echo "REFUSED: a network named rustbench exists and is not this try's"; exit 3; }
else docker network create $L rustbench >/dev/null; fi
s=$(date +%s)
(cd $P/tree-base && docker build $L -f examples/card-market/Dockerfile -t cb-corten-base . >$P/try-build-base.log 2>&1)
echo "build cb-corten-base exit $? in $(( $(date +%s) - s )) s"
mkdir -p $P/try-node
printf 'FROM debian:trixie-slim\nRUN apt-get update -q && apt-get install -y -q nodejs linux-perf procps ca-certificates && rm -rf /var/lib/apt/lists/*\n' >$P/try-node/Dockerfile
docker build $L -t sa-cat-node $P/try-node >$P/try-build-node.log 2>&1; echo "build sa-cat-node exit $?"
incon() { docker run --rm $L --privileged --network host --pid host --cgroupns host -v /sys/fs/cgroup:/sys/fs/cgroup -v /m:/m \
    -v /var/run/docker.sock:/var/run/docker.sock -v /usr/bin/docker:/usr/bin/docker:ro -e HOME=/root "$@"; }
incon sa-cat-node sh -c '. /etc/os-release; echo "$PRETTY_NAME"; node --version; perf --version; docker --version; nproc'
echo "--- verify.mjs, DRYRUN"
incon -e DRYRUN=1 sa-cat-node node $P/catalog/verify.mjs; echo "verify exit $?"
echo "--- run.sh, DRYRUN"
incon -e DRYRUN=1 sa-cat-node sh $P/catalog/run.sh; echo "run exit $?"
echo "--- records"
d=$(ls -d $P/catalog-state/dry-* | head -1)
cat $d/run.txt; cat $d/invocations.txt | cut -c1-200
echo "--- report.md (head)"; head -c 2600 $d/report.md
echo; echo "--- report again from the files"
incon sa-cat-node node $P/catalog/report.mjs $d $P/tree-head/bench/fullstack/results >$P/try-report-again.md; echo "report exit $?"
cmp $d/report.md $P/try-report-again.md && echo "the same page"
docker ps -a --format 'left: {{.Names}} {{.Image}}' | grep -E 'fsw-|cb-corten|k6' || echo "no container of the count left"
echo CAT-TRY-DONE
# end

