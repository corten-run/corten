#!/bin/sh
# setup.sh: prepares a fresh Debian 13 x64 host (c-8, root, nothing else running) for #1983's
# placement kit and builds it (build.sh). The two trees, the probe and the scripts travel in the
# tar; nothing is fetched with git. Upload cycles-1983.tar as /root/cycles-1983.tar, then:
#   mkdir -p /m && tar -xf /root/cycles-1983.tar -C /m && sh /m/1983/setup.sh
#   nohup sh /m/1983/run.sh >/m/1983/run.out 2>&1 &
# Everything lives under /m/1983 and /m/target-1983-{base,head}. The linker is rustc's own (LLD,
# through cc -fuse-ld=lld), as kit 1965's; no system lld is installed or used.
set -eu
[ -f /m/1983/commits.env ] || { echo "unpack cycles-1983.tar into /m first"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
apt-get update -q
apt-get install -y -q build-essential binutils linux-perf wrk curl libjemalloc2 libzstd-dev pkg-config nodejs ca-certificates util-linux
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
node --version
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list || true
sh /m/1983/build.sh
echo SETUP-DONE
