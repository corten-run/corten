#!/usr/bin/env bash
# Runs on the build host: the branch's checks on the tree base + <patch>, then how late a
# deadline's answer is on base and on that tree. Usage: final2.sh <patch>
set -uo pipefail
patch=$1
cd /root/dl
bash b-test.sh t-v1 "$patch" fmt
bash b-test.sh t-v1 "$patch" clippy
bash b-test.sh t-v1 "$patch" lib
bash b-test.sh t-v1 "$patch" lib tests::server::
for round in 1 2 3; do
    bash b-test.sh t-base tests-base.patch late
    bash b-test.sh t-v1 "$patch" late
done
echo FINAL-DONE
