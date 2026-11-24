#!/bin/sh
# Count host: after the queue, the probe of the new base and state.sh on it.
until grep -q QUEUE-DONE /root/dl/queue.log 2>/dev/null; do sleep 10; done
exec > /root/trial.out 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -q wrk tcpdump nodejs libjemalloc2 curl util-linux >/root/trial-apt.log 2>&1 || { tail -5 /root/trial-apt.log; echo "TRIAL-FAILED packages"; exit 1; }
rm -rf /m && mkdir -p /m && tar -xzf /root/kit.tgz -C /m
mkdir -p /m/dl/work && tar -xzf /root/dl/newbase.tgz -C /m/dl/work
cp /m/dl/work/Cargo.lock /m/dl/probe/Cargo.lock
docker run --rm -v /m/dl:/m/dl -v corten-cargo:/usr/local/cargo/registry -e CARGO_TARGET_DIR=/m/dl/target -w /m/dl/probe rust:1-trixie cargo build --release > /root/trial-build.log 2>&1 || { tail -20 /root/trial-build.log; echo "TRIAL-FAILED build"; exit 1; }
mkdir -p /m/dl/bin && cp /m/dl/target/release/probe /m/dl/bin/base
wrk -v 2>&1 | head -1; tcpdump --version 2>&1 | head -1; node --version; nproc
node /m/dl/state.mjs --selftest | tail -1
sh /m/dl/state.sh /m/dl/trial-state; echo "state.sh exit $?"
echo "== the wrk output of the first turn"; cat /m/dl/trial-state/base-1/wrk.txt
echo "== tcpdump"; cat /m/dl/trial-state/base-1/tcpdump.txt
echo "# TRIAL-DONE"
