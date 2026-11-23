#!/bin/sh
# lock.sh (workstation, in a Linux container with cargo and the registry; not on the measuring host):
# makes each probe's Cargo.lock from its tree's. It copies 1865/src-<side>/Cargo.lock into
# 1865/probe-<side>/, lets Cargo add the probe's own package and drop what the probe does not use
# (cargo metadata, which keeps every version the lock already selects), checks that Cargo then
# accepts the lock as it is (--locked), and runs lock-check.mjs: every registry package the probe
# selects must be the workspace lock's version and checksum, and the two probes' locks may differ
# only in the probe's own package. Writes 1865/locks.sha256, which build.sh checks on the host.
set -eu
K=${KIT:-/m}; P=$K/1865
for side in base head; do
    cp $P/src-$side/Cargo.lock $P/probe-$side/Cargo.lock
    (cd $P/probe-$side && cargo metadata --format-version 1 >/dev/null)
    (cd $P/probe-$side && cargo metadata --format-version 1 --locked --offline >/dev/null) || { echo "$side: Cargo would change the lock again"; exit 1; }
done
node $K/lock-check.mjs $P
(cd $P && sha256sum probe-base/Cargo.lock probe-head/Cargo.lock >locks.sha256)
cat $P/locks.sha256
echo LOCK-DONE
