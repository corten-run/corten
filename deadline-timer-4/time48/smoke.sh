#!/usr/bin/env bash
# Runs on the 48-CPU host: one round of three workloads into a scratch file, to see that the harness
# works here. Not read.
cd /root/t48
export OUT=/root/t48/smoke.tsv
: > $OUT
for w in a10 d64 es; do bash run48.sh $w 1; done
echo "# SMOKE-DONE $(date -u +%T)"
