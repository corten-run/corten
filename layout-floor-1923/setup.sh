#!/bin/sh
# setup.sh: prepares a fresh Debian 13 x64 host (c-8, root, nothing else running) for #1923's
# A/A kit and builds it (build.sh). Main's tree, the probe, the layout patches and the scripts
# travel in the tar; nothing is fetched with git. Upload cycles-1923.tar as /root/cycles-1923.tar,
# then:
#   mkdir -p /m && tar -xf /root/cycles-1923.tar -C /m && sh /m/1923/setup.sh
#   nohup sh /m/1923/run.sh >/m/1923/run.out 2>&1 &
# Everything lives under /m/1923 and /m/target-1923, so another kit can be unpacked beside it
# under /m and run before or after it (not at the same time: both use CPUs 2, 4, 5, 7 and ports
# 18081-18082); a toolchain or package already installed is kept.
set -eu
[ -f /m/1923/commits.env ] || { echo "unpack cycles-1923.tar into /m first"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
apt-get update -q
apt-get install -y -q build-essential binutils patch linux-perf wrk curl libjemalloc2 libzstd-dev pkg-config nodejs ca-certificates util-linux
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
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list
sh /m/1923/build.sh
echo SETUP-DONE