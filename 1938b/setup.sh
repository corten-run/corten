#!/bin/sh
# setup.sh: prepares a fresh Debian 13 x64 host (c-8, root, nothing else running) for kit 1938b
# (#1938's supplement after round 2 of review) and builds it. The kit's sources (both
# commits' trees and the probes) travel in the tar; nothing is fetched with git. Upload
# cycles-1938b.tar as /root/cycles-1938b.tar and run /root/start.sh (README.md), which runs this,
# then run.sh. Everything lives under /m/1938b (and /m/target-1938b-{base,head}), so it can run
# after another kit on the same host; a toolchain or package already installed is kept.
set -eu
[ -f /m/1938b/commits.env ] || { echo "unpack cycles-1938b.tar into /m first"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
apt-get update -q
apt-get install -y -q build-essential linux-perf wrk curl libjemalloc2 libzstd-dev pkg-config nodejs ca-certificates iproute2 util-linux
# Root may count the kernel anyway; the watchdog holds a counter on some CPUs. A container cannot
# set either, so a failure here is reported, not fatal; run.sh records both values.
sysctl -w kernel.perf_event_paranoid=-1 || echo "setup: could not set kernel.perf_event_paranoid"
sysctl -w kernel.nmi_watchdog=0 || echo "setup: could not set kernel.nmi_watchdog"
if ! command -v rustup >/dev/null 2>&1 && [ ! -x /root/.cargo/bin/rustup ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.100.0
fi
[ -f /root/.cargo/env ] && . /root/.cargo/env
rustup toolchain list | grep -q '^1\.100\.0' || rustup toolchain install 1.100.0 --profile minimal
RUSTUP_TOOLCHAIN=1.100.0 rustc -V
perf stat -x, -e cycles:u,cycles:k,instructions:u true || echo "setup: perf cannot count cycles here (run.sh will stop)"
wrk --version 2>&1 | head -1 || true
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list
sh /m/1938b/build.sh
echo SETUP-DONE