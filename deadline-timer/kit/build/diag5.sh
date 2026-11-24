#!/usr/bin/env bash
# Runs on the build host: where the instructions of a request on a connection of its own
# differ between two builds already made. Usage: diag5.sh <a> <b> <case>...
set -uo pipefail
a=$1; b=$2; shift 2
docker run --rm -e DIAG_CORE=5 -e DIAG_EACH=${EACH:-} -e ARENA_MODE=default -e A=$a -e B=$b -v /root/dl/cg:/w rust:1-trixie bash -c '
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 python3 util-linux >/dev/null 2>&1
for c in "$@"; do echo "== $c, a connection for each request"; python3 /w/diag.py $c /w/target-$A/release/httparena-corten /w/target-$B/release/httparena-corten; done
' _ "$@"
echo "DIAG5-DONE"
