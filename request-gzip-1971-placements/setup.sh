#!/bin/sh
# setup.sh: prepares a fresh Debian 13 x64 host (c-8, root, nothing else running) for kit 1971
# (kit 1965's setup, with this kit's paths): packages, rustc 1.100.0, then build.sh. The two trees,
# the probe and the scripts travel in the tar; nothing is fetched with git.
#   mkdir -p /m && tar -xf /root/cycles-1971.tar -C /m && sh /m/1971/setup.sh
# The linker is rustc's own (LLD, through cc -fuse-ld=lld); no system lld is installed or used.
set -eu
[ -f /m/1971/commits.env ] || { echo "unpack cycles-1971.tar into /m first"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
apt-get update -q
apt-get install -y -q build-essential binutils linux-perf wrk curl libjemalloc2 libzstd-dev pkg-config nodejs ca-certificates util-linux
# Root may count the kernel anyway; the watchdog holds a counter on some CPUs.
sysctl -w kernel.perf_event_paranoid=-1 || echo "setup: could not set kernel.perf_event_paranoid"
sysctl -w kernel.nmi_watchdog=0 || echo "setup: could not set kernel.nmi_watchdog"
if ! command -v rustup >/dev/null 2>&1 && [ ! -x /root/.cargo/bin/rustup ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.100.0
fi
[ -f /root/.cargo/env ] && . /root/.cargo/env
rustup toolchain list | grep -q '^1\.100\.0' || rustup toolchain install 1.100.0 --profile minimal
RUSTUP_TOOLCHAIN=1.100.0 rustc -V
node --version
perf stat -x, -e cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u true || echo "setup: perf cannot count the plan's events here (run.sh will stop)"
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list
sh /m/1971/build.sh
echo SETUP-DONE
