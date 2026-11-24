#!/usr/bin/env bash
# Runs on the build host, once the counts and comparisons are done: fmt, clippy and the lib
# tests on base + <patch> in its own tree. Usage: fmt7.sh <patch>
set -uo pipefail
cd /root/dl
until grep -q "RUN6-DONE" diag6.log 2>/dev/null; do sleep 10; done
bash b-test.sh t-v4 "$1" fmt
bash b-test.sh t-v4 "$1" clippy
bash b-test.sh t-v4 "$1" lib
bash b-test.sh t-v4 "$1" lib tests::server::
echo FMT7-DONE
