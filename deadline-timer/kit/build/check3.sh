#!/usr/bin/env bash
# Runs on the build host: the branch's checks on the tree base + <patch>, in the tree <tree>.
# Usage: check3.sh <tree> <patch>
set -uo pipefail
cd /root/dl
bash b-test.sh "$1" "$2" fmt
bash b-test.sh "$1" "$2" clippy
bash b-test.sh "$1" "$2" lib
bash b-test.sh "$1" "$2" lib tests::server::
echo CHECK3-DONE
