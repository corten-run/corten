#!/usr/bin/env bash
# Runs on the build host: fmt, clippy and the lib tests on base + <patch>, in the tree <tree>,
# after the counts that are running have finished.
set -uo pipefail
cd /root/dl
until grep -q "DONE count3" count4.log 2>/dev/null; do sleep 10; done
bash b-test.sh "$1" "$2" fmt
bash b-test.sh "$1" "$2" clippy
bash b-test.sh "$1" "$2" lib
bash b-test.sh "$1" "$2" lib tests::server::
echo CHECK5-DONE
