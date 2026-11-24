#!/usr/bin/env bash
# Runs on the c-48. Rounds over the variants in the order given, one run of each profile a
# variant a round, so the builds alternate run by run; default runtime.
# Usage: PASS=p3 alt.sh <rounds> <variant>...      variant = label:image-tag[:off]
set -uo pipefail
cd /root/dl
ROUNDS=$1; shift
P=${PASS:-p}
export OUT=/root/dl/results.tsv
D="-e ARENA_MODE=default"
env_of() { case "$1" in *:off) echo "$D -e ARENA_DEADLINE=off" ;; *) echo "$D" ;; esac; }
echo "# $P $(date -u +%H:%M:%S) load $(cut -d' ' -f1 /proc/loadavg) order: $*"
for round in $(seq 1 "$ROUNDS"); do
    for group in async-staged baseline,json-comp,async; do
        for v in "$@"; do
            IFS=: read -r label tag _ <<< "$v"
            PASS=$P.r$round LABEL=$label SERVER_ENV="$(env_of "$v")" bash run2.sh "httparena-corten:$tag" "$group" 1
        done
    done
    for v in "$@"; do
        IFS=: read -r label tag _ <<< "$v"
        PASS=$P.r$round ECHO=1 ECHO_CPUS=36-47 LOAD_CPUS=24-35 THREADS=12 LABEL=$label SERVER_ENV="$(env_of "$v") -e ARENA_POOL=4032" \
            bash run2.sh "httparena-corten:$tag" spool 1
    done
done
# Past the default deadline of 30 s, when the timers kept since the start come up in the wheel.
for v in "$@"; do
    IFS=: read -r label tag _ <<< "$v"
    PASS=$P.long LABEL=$label SERVER_ENV="$(env_of "$v")" bash run2.sh "httparena-corten:$tag" async-staged40 1
done
echo "# $P DONE $(date -u +%H:%M:%S)"
