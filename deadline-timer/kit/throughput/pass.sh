#!/usr/bin/env bash
# Runs on the c-48. One pass over the variants in the order given, default runtime.
# Usage: PASS=p1 pass.sh <runs> <variant>...      variant = label:image-tag[:off]
set -uo pipefail
cd /root/dl
RUNS=$1; shift
export OUT=/root/dl/results.tsv PASS=${PASS:-p}
D="-e ARENA_MODE=default"
env_of() { case "$1" in *:off) echo "$D -e ARENA_DEADLINE=off" ;; *) echo "$D" ;; esac; }
echo "# $PASS $(date -u +%H:%M:%S) load $(cut -d' ' -f1 /proc/loadavg) order: $*"
# The staged handler that sleeps, each variant in turn; then the workloads that must not slow.
for group in async-staged baseline,json-comp,async; do
    for v in "$@"; do
        IFS=: read -r label tag _ <<< "$v"
        LABEL=$label SERVER_ENV="$(env_of "$v")" bash run.sh "httparena-corten:$tag" "$group" "$RUNS"
    done
done
# The staged handler that waits on pooled I/O: the service on its own cores, fewer load threads.
for v in "$@"; do
    IFS=: read -r label tag _ <<< "$v"
    ECHO=1 ECHO_CPUS=36-47 LOAD_CPUS=24-35 THREADS=12 LABEL=$label SERVER_ENV="$(env_of "$v") -e ARENA_POOL=4032" \
        bash run.sh "httparena-corten:$tag" spool "$RUNS"
done
echo "# $PASS DONE $(date -u +%H:%M:%S)"
