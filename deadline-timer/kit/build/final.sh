#!/usr/bin/env bash
# Runs on the build host: the branch's checks on the committed trees.
set -uo pipefail
cd /root/dl
bash b-test.sh t-v1 v1b.patch fmt
echo "== same source as the measured build?"
for f in deadline.rs app.rs lib.rs page.rs; do
    cmp t-v1/crates/corten/src/$f cg/src-conn/crates/corten/src/$f && echo "same $f"
done
bash b-test.sh t-v1 v1b.patch clippy
bash b-test.sh t-v1 v1b.patch lib
bash b-test.sh t-v1 v1b.patch lib tests::server::
bash b-test.sh t-base tests-base.patch lib tests::server::
echo FINAL-DONE
