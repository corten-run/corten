#!/usr/bin/env bash
# Runs on the build host: checks, counts and the by-function comparison for base + <patch>.
# Usage: run6.sh <name> <patch>
set -uo pipefail
cd /root/dl
bash check3.sh t-v3 "$2" > check6.log 2>&1
bash count3.sh "$1" "$2" > count6.log 2>&1
bash diag5.sh base "$1" get pipeline sdelay1 > diag6.log 2>&1
EACH=1 bash diag5.sh base "$1" sdelay1 get >> diag6.log 2>&1
echo RUN6-DONE >> diag6.log
# How late a deadline's answer is, on a quiet machine: the change, then base.
bash b-test.sh t-v1 "$2" late > late6.log 2>&1
bash b-test.sh t-base tests-base.patch late >> late6.log 2>&1
echo LATE6-DONE >> late6.log
